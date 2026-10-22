import * as vscode from 'vscode';

export interface GitHubRemote {
    owner: string;
    repo: string;
}

export interface GitHubAuth {
    accessToken: string;
}

export interface GitHubCheck {
    name: string;
    status: string;
    conclusion?: string;
}

export interface GitHubPullRequest {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    url: string;
    headSha: string;
    headRef: string;
    baseRef: string;
    checks: GitHubCheck[];
    checksUnavailable?: boolean;
}

export type GitHubReadResult =
    | { kind: 'ok'; pullRequest: GitHubPullRequest }
    | { kind: 'unavailable'; reason: 'no-auth' | 'not-github' | 'no-pr' | 'rate-limited' | 'error' };

export interface GitHubDependencies {
    getSession?: () => Promise<GitHubAuth | undefined>;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Parse only github.com remotes. Credentials embedded in a URL are ignored and
 * never reused; the API token comes from vscode.authentication.
 */
export function parseGitHubRemote(remote: string): GitHubRemote | undefined {
    const value = remote.trim();
    if (!value) return undefined;
    let host: string;
    let pathname: string;
    try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
            const url = new URL(value);
            host = url.hostname.toLowerCase();
            pathname = url.pathname;
        }
        else {
            const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(value);
            if (!scp) return undefined;
            host = scp[1].toLowerCase();
            pathname = scp[2];
        }
    }
    catch { return undefined; }
    if (host !== 'github.com') return undefined;
    const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2) return undefined;
    const [owner, repo] = parts;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined;
    return { owner, repo };
}

async function defaultSession(): Promise<GitHubAuth | undefined> {
    // Never prompt while refreshing the workbench. A "Connect GitHub" action can
    // later call createIfNone: true explicitly.
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    return session ? { accessToken: session.accessToken } : undefined;
}

function headers(token: string): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'generative-git-readonly'
    };
}

function apiBase(remote: GitHubRemote): string {
    return `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`;
}

async function getJson(
    fetcher: (url: string, init?: RequestInit) => Promise<Response>,
    url: string,
    token: string
): Promise<{ status: number; body: any; headers: Headers }> {
    const response = await fetcher(url, {
        method: 'GET',
        headers: headers(token),
        signal: AbortSignal.timeout(10_000)
    });
    let body: any;
    try { body = await response.json(); }
    catch { body = undefined; }
    return { status: response.status, body, headers: response.headers };
}

/**
 * Read the latest PR associated with a branch and its check-runs.
 *
 * This module is intentionally read-only: every request is GET, the token is
 * never returned/logged/persisted, and failures collapse to an unavailable
 * result rather than exposing response bodies.
 */
export async function readPullRequest(
    remoteUrl: string,
    branch: string,
    deps: GitHubDependencies = {}
): Promise<GitHubReadResult> {
    const remote = parseGitHubRemote(remoteUrl);
    if (!remote) return { kind: 'unavailable', reason: 'not-github' };
    if (!branch.trim()) return { kind: 'unavailable', reason: 'no-pr' };

    let session: GitHubAuth | undefined;
    try { session = await (deps.getSession ? deps.getSession() : defaultSession()); }
    catch { return { kind: 'unavailable', reason: 'no-auth' }; }
    if (!session?.accessToken) return { kind: 'unavailable', reason: 'no-auth' };

    const fetcher = deps.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!fetcher) return { kind: 'unavailable', reason: 'error' };

    const head = `${remote.owner}:${branch}`;
    const pullsUrl = `${apiBase(remote)}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=1&sort=updated&direction=desc`;
    try {
        const pulls = await getJson(fetcher, pullsUrl, session.accessToken);
        if (pulls.status === 403 && pulls.headers.get('x-ratelimit-remaining') === '0')
            return { kind: 'unavailable', reason: 'rate-limited' };
        if (pulls.status === 401 || pulls.status === 403 || pulls.status >= 500)
            return { kind: 'unavailable', reason: 'error' };
        if (pulls.status === 404 || !Array.isArray(pulls.body) || !pulls.body.length)
            return { kind: 'unavailable', reason: 'no-pr' };

        const item = pulls.body[0];
        const headSha = String(item?.head?.sha || '');
        if (!headSha) return { kind: 'unavailable', reason: 'error' };
        const state: GitHubPullRequest['state'] = item?.merged_at ? 'merged' : item?.state === 'closed' ? 'closed' : 'open';

        let checks: GitHubCheck[] = [];
        let checksUnavailable = false;
        try {
            const checksResponse = await getJson(fetcher, `${apiBase(remote)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`, session.accessToken);
            if (checksResponse.status === 200 && Array.isArray(checksResponse.body?.check_runs)) {
                checks = checksResponse.body.check_runs.map((run: any) => ({
                    name: String(run?.name || 'check'),
                    status: String(run?.status || 'unknown'),
                    conclusion: run?.conclusion ? String(run.conclusion) : undefined
                }));
            }
            else checksUnavailable = true;
        }
        catch { checksUnavailable = true; }

        return {
            kind: 'ok',
            pullRequest: {
                number: Number(item.number),
                title: String(item.title || ''),
                state,
                url: String(item.html_url || ''),
                headSha,
                headRef: String(item?.head?.ref || branch),
                baseRef: String(item?.base?.ref || ''),
                checks,
                checksUnavailable: checksUnavailable || undefined
            }
        };
    }
    catch {
        return { kind: 'unavailable', reason: 'error' };
    }
}
