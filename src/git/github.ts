import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { PullRequestCheck, PullRequestInfo, PullRequestState } from '../shared/protocol';

interface Remote { owner: string; repo: string }
interface Session { accessToken: string }
export interface GitHubDependencies {
    getSession?: () => Promise<Session | undefined>;
    fetch?: typeof fetch;
    now?: () => number;
}
const unavailable = (reason: Extract<PullRequestState, { kind: 'unavailable' }>['reason']): PullRequestState => ({ kind: 'unavailable', reason });
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(v);

/** Remote URLs select a repository, never a network origin or credential. */
export function parseGitHubRemote(value: string): Remote | undefined {
    if (value.length > 4096 || /[\s\\?#%]/.test(value)) return;
    let pathname: string;
    if (value.includes('://')) {
        try {
            const u = new URL(value);
            if (!['https:', 'ssh:', 'git:'].includes(u.protocol) || u.hostname !== 'github.com' ||
                (u.port && !(u.protocol === 'ssh:' && u.port === '22')) || /\/(?:\.|\.\.)(?:\/|$)/.test(value)) return;
            pathname = u.pathname;
        } catch { return; }
    } else {
        const match = /^(?:git@)?github\.com:([^\s]+)$/.exec(value);
        if (!match) return;
        pathname = match[1];
    }
    const parts = pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '').split('/');
    if (parts.length !== 2) return;
    const [owner, repo] = parts;
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) ||
        !/^[a-z\d_.-]{1,100}$/i.test(repo) || ['.', '..'].includes(repo)) return;
    return { owner, repo };
}

export function safePullRequestUrl(value: string): boolean {
    // Only URLs constructed from validated API identities may leave the host.
    const match = /^https:\/\/github\.com\/([A-Za-z\d-]+)\/([A-Za-z\d_.-]+)\/pull\/([1-9]\d*)$/.exec(value);
    return !!match && !!parseGitHubRemote(`https://github.com/${match[1]}/${match[2]}`) && Number.isSafeInteger(Number(match[3]));
}

export async function connectGitHub(): Promise<boolean> {
    try { return !!(await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }))?.accessToken; }
    catch { return false; }
}

async function boundedJson(response: Response): Promise<unknown> {
    const limit = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new Error('Response limit');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0, content = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('Response limit');
            content += decoder.decode(value, { stream: true });
        }
        return JSON.parse(content + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** GET-only client with bounded responses, account-scoped caching and cancellation. */
export class GitHubReader {
    private generation = 0;
    private cache?: { key: string; expires: number; value: PullRequestState };
    private pending?: { key: string; result: Promise<PullRequestState>; controller: AbortController };
    private blockedUntil = 0;
    private disposed = false;
    constructor(private readonly deps: GitHubDependencies = {}) {}
    clear(): void {
        this.generation++;
        this.cache = undefined;
        this.pending?.controller.abort();
        this.pending = undefined;
    }
    dispose(): void { this.disposed = true; this.clear(); }
    async read(remoteUrl: string, branch: string): Promise<PullRequestState> {
        const remote = parseGitHubRemote(remoteUrl);
        if (!remote) return unavailable('not-github');
        if (!text(branch, 1024) || branch === 'HEAD') return unavailable('no-pr');
        if (this.disposed) return unavailable('error');
        const generation = this.generation;
        let session: Session | undefined;
        try {
            session = await (this.deps.getSession?.() ?? vscode.authentication.getSession('github', ['repo'], { silent: true }));
        } catch { return unavailable('no-auth'); }
        if (generation !== this.generation || this.disposed) return unavailable('error');
        if (!session?.accessToken) { this.clear(); return unavailable('no-auth'); }
        const key = JSON.stringify([remote.owner, remote.repo, branch, createHash('sha256').update(session.accessToken).digest('hex')]);
        const now = this.deps.now?.() ?? Date.now();
        if (now < this.blockedUntil) return unavailable('rate-limited');
        if (this.cache?.key === key && now < this.cache.expires) return this.cache.value;
        if (this.pending?.key === key) return this.pending.result;
        this.pending?.controller.abort();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const result = this.request(remote, branch, session.accessToken, controller.signal)
            .catch(() => unavailable('error'))
            .then(value => {
                if (this.pending?.result !== result || generation !== this.generation || controller.signal.aborted) return unavailable('error');
                this.cache = { key, value, expires: (this.deps.now?.() ?? Date.now()) + 30_000 };
                return value;
            }).finally(() => {
                clearTimeout(timer);
                if (this.pending?.result === result) this.pending = undefined;
            });
        this.pending = { key, result, controller };
        return result;
    }
    private async request(remote: Remote, branch: string, token: string, signal: AbortSignal): Promise<PullRequestState> {
        const base = `https://api.github.com/repos/${remote.owner}/${remote.repo}`;
        const get = async (url: string): Promise<unknown> => {
            signal.throwIfAborted();
            const response = await (this.deps.fetch ?? fetch)(url, {
                method: 'GET', redirect: 'error', signal,
                headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'generative-git' }
            });
            if (response.status === 429 || (response.status === 403 &&
                (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
                const delay = Number(response.headers.get('retry-after')) || 60;
                this.blockedUntil = (this.deps.now?.() ?? Date.now()) + Math.min(300, Math.max(30, delay)) * 1000;
            }
            if (response.status !== 200 || response.redirected) {
                await response.body?.cancel();
                throw new Error('GitHub unavailable');
            }
            return boundedJson(response);
        };
        let data: unknown;
        try {
            data = await get(`${base}/pulls?state=all&head=${encodeURIComponent(`${remote.owner}:${branch}`)}&sort=updated&direction=desc&per_page=1`);
        } catch { return unavailable((this.deps.now?.() ?? Date.now()) < this.blockedUntil ? 'rate-limited' : 'error'); }
        if (!Array.isArray(data)) return unavailable('error');
        if (!data.length) return unavailable('no-pr');
        const pr = object(data[0]), head = object(pr.head), target = object(pr.base);
        const fullName = `${remote.owner}/${remote.repo}`.toLowerCase();
        if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0 || !text(pr.title, 1024) ||
            !['open', 'closed'].includes(String(pr.state)) || !sha(head.sha) || head.ref !== branch ||
            !text(target.ref, 1024) || String(object(head.repo).full_name).toLowerCase() !== fullName ||
            String(object(target.repo).full_name).toLowerCase() !== fullName ||
            (pr.merged_at !== null && (typeof pr.merged_at !== 'string' || !Number.isFinite(Date.parse(pr.merged_at))))) return unavailable('error');
        const info: PullRequestInfo = {
            number: Number(pr.number), title: pr.title,
            state: pr.merged_at ? 'merged' : pr.state as 'open' | 'closed',
            url: `https://github.com/${remote.owner}/${remote.repo}/pull/${pr.number}`,
            headSha: head.sha, headRef: branch, baseRef: target.ref, checks: []
        };
        try {
            const checks = object(await get(`${base}/commits/${head.sha}/check-runs?per_page=100&filter=latest`));
            if (!Array.isArray(checks.check_runs) || checks.check_runs.length > 100 ||
                !Number.isSafeInteger(checks.total_count) || Number(checks.total_count) < checks.check_runs.length) throw new Error('Invalid checks');
            const parsed: PullRequestCheck[] = checks.check_runs.map(value => {
                const run = object(value);
                if (!text(run.name, 512) || !text(run.status, 64) ||
                    (run.conclusion !== null && !text(run.conclusion, 64))) throw new Error('Invalid check');
                return { name: run.name, status: ['queued', 'in_progress', 'completed'].includes(run.status) ? run.status as PullRequestCheck['status'] : 'unknown',
                    conclusion: typeof run.conclusion === 'string' ? run.conclusion : undefined };
            });
            info.checks = parsed;
            if (Number(checks.total_count) > parsed.length) info.checksPartial = true;
        } catch { info.checksUnavailable = true; }
        return { kind: 'ok', pullRequest: info };
    }
}
