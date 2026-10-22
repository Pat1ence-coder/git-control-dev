import type { GraphModel } from './model';
export type Strategy = 'current' | 'incoming' | 'both' | 'ai';
export interface Hunk {
    start: number;
    end: number;
    current: string;
    incoming: string;
    currentLabel: string;
    incomingLabel: string;
    /** Latest file commit author on each side; this is not line-level blame. */
    currentAuthor?: string;
    incomingAuthor?: string;
    currentStart?: number;
    incomingStart?: number;
    before?: string[];
    after?: string[];
    beforeStart?: number;
    afterStart?: number;
}
export interface ConflictFile {
    path: string;
    status: string;
    hunks: Hunk[];
    note?: string;
    truncated?: boolean;
    nativeOnly?: boolean;
}
export interface BranchInfo {
    name: string;
    ref: string;
    local: boolean;
    current: boolean;
    commit?: string;
    ahead?: number;
    behind?: number;
}
export interface BranchPreview {
    ref: string;
    name: string;
    graph: GraphModel;
}
export interface Snapshot {
    repoId: string;
    repoName: string;
    repositories: {
        id: string;
        name: string;
    }[];
    headName: string;
    headHash?: string;
    branches: string[];
    conflicts: ConflictFile[];
    workingTreeCount: number;
    workingTreeFiles?: { path: string; status: string; untracked: boolean }[];
    stagedCount: number;
    mergeHead: boolean;
    mergingRef?: string;
    rebasing: boolean;
    canMerge: boolean;
    canAbort: boolean;
    graph: GraphModel;
    branchList?: BranchInfo[];
    preview?: BranchPreview;
}
export interface PullRequestCheck {
    name: string;
    status: 'queued' | 'in_progress' | 'completed' | 'unknown';
    conclusion?: string;
}
export interface PullRequestInfo {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    url: string;
    headSha: string;
    headRef: string;
    baseRef: string;
    checks: PullRequestCheck[];
    checksUnavailable?: boolean;
    checksPartial?: boolean;
}
export type PullRequestState =
    | { kind: 'ok'; pullRequest: PullRequestInfo }
    | { kind: 'unavailable'; reason: 'no-auth' | 'not-github' | 'no-pr' | 'rate-limited' | 'error' };
/** Binds delayed remote results/actions to the exact local view. */
export interface RepositoryContext {
    repoId: string;
    headName: string;
    headHash?: string;
}
export interface CommitDetail {
    hash: string;
    message: string;
    author?: string;
    date?: string;
    parent?: string;
    files: {
        path: string;
        status: string;
    }[];
    path?: string;
    patch?: string;
    truncated?: boolean;
    note?: string;
}
export interface StagedReview {
    repoId: string;
    headName: string;
    token: string;
    merge: boolean;
    files: { path: string; status: string }[];
    path?: string;
    patch: string;
    truncated: boolean;
    suggestedMessage: string;
    unstagedCount: number;
    blocked?: string;
}
export type ToHost = {
    type: 'ready' | 'refresh' | 'abort-merge' | 'suggest-commit' | 'open-scm' | 'open-workbench' | 'native-stage-conflicts' | 'preview-current';
} | {
    type: 'connect-github' | 'refresh-github' | 'open-pull-request';
    context: RepositoryContext;
} | {
    type: 'select-repo';
    repoId: string;
} | {
    type: 'preview-branch';
    ref: string;
} | {
    type: 'merge';
    ref: string;
} | {
    type: 'resolve';
    path: string;
    strategy: Strategy;
} | {
    type: 'stage' | 'open-file' | 'open-conflict-diff' | 'open-merge-editor';
    path: string;
} | {
    type: 'open-working-change' | 'stage-working-change';
    repoId: string;
    path: string;
} | {
    type: 'copy';
    text: string;
} | {
    type: 'inspect-commit';
    hash: string;
    path?: string;
    requestId: number;
} | {
    type: 'review-staged';
    path?: string;
    requestId: number;
} | {
    type: 'commit-staged';
    repoId: string;
    token: string;
    message: string;
};
export type ToWebview = PullRequestMessage | {
    type: 'hydrate';
    snapshot: Snapshot | null;
    notice?: string;
} | {
    type: 'snapshot';
    snapshot: Snapshot | null;
} | {
    type: 'notice';
    level: 'info' | 'error';
    text: string;
} | {
    type: 'live-result';
    kind: 'conflict' | 'clean' | 'aborted' | 'resolved' | 'staged' | 'error';
    text?: string;
} | {
    type: 'commit-detail';
    requestId: number;
    detail?: CommitDetail;
    error?: string;
} | {
    type: 'staged-review';
    requestId: number;
    review?: StagedReview;
    error?: string;
} | {
    type: 'commit-result';
    ok: boolean;
    hash?: string;
    error?: string;
};
export type PullRequestMessage = {
    type: 'pull-request';
    context: RepositoryContext;
    state?: PullRequestState;
};
export function repositoryContext(s: RepositoryContext): RepositoryContext {
    return { repoId: s.repoId, headName: s.headName, headHash: s.headHash };
}
export function sameContext(a?: RepositoryContext | null, b?: RepositoryContext | null): boolean {
    return !!a && !!b && a.repoId === b.repoId && a.headName === b.headName && a.headHash === b.headHash;
}
function parseContext(value: unknown): RepositoryContext | undefined {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (typeof v.repoId !== 'string' || !v.repoId || v.repoId.length > 4096 || v.repoId.includes('\0') ||
        typeof v.headName !== 'string' || !v.headName || v.headName.length > 1024 ||
        (v.headHash !== undefined && (typeof v.headHash !== 'string' || !/^[a-f0-9]{7,64}$/i.test(v.headHash)))) return;
    return { repoId: v.repoId, headName: v.headName, headHash: v.headHash as string | undefined };
}
export function asHostMessage(value: unknown): ToHost | undefined {
    if (!value || typeof value !== 'object')
        return;
    const m = value as Record<string, unknown>;
    const str = (key: string, max = 4096) => typeof m[key] === 'string' && (m[key] as string).length > 0 && (m[key] as string).length <= max;
    switch (m.type) {
        case 'connect-github':
        case 'refresh-github':
        case 'open-pull-request': {
            const context = parseContext(m.context);
            return context ? { type: m.type, context } : undefined;
        }
        case 'ready':
        case 'refresh':
        case 'abort-merge':
        case 'suggest-commit':
        case 'open-scm':
        case 'native-stage-conflicts':
        case 'open-workbench':
        case 'preview-current': return { type: m.type };
        case 'select-repo':
            if (str('repoId'))
                return m as unknown as ToHost;
            break;
        case 'preview-branch':
            if (str('ref', 300))
                return m as unknown as ToHost;
            break;
        case 'merge':
            if (str('ref', 200))
                return m as unknown as ToHost;
            break;
        case 'resolve':
            if (str('path') && typeof m.strategy === 'string' && ['current', 'incoming', 'both', 'ai'].includes(m.strategy))
                return m as unknown as ToHost;
            break;
        case 'stage':
        case 'open-file':
        case 'open-conflict-diff':
        case 'open-merge-editor':
            if (str('path'))
                return m as unknown as ToHost;
            break;
        case 'open-working-change':
        case 'stage-working-change':
            if (str('repoId') && str('path')) return m as unknown as ToHost;
            break;
        case 'copy':
            if (typeof m.text === 'string')
                return { type: m.type, text: m.text.slice(0, 20000) };
            break;
        case 'inspect-commit': if (typeof m.hash === 'string' && /^[a-f0-9]{7,64}$/i.test(m.hash) && Number.isSafeInteger(m.requestId) && (m.path === undefined || str('path')))
            return m as unknown as ToHost;
            break;
        case 'review-staged':
            if (Number.isSafeInteger(m.requestId) && (m.path === undefined || str('path')))
                return m as unknown as ToHost;
            break;
        case 'commit-staged':
            if (str('repoId') && str('message', 20000) && typeof m.token === 'string' && /^[a-f0-9]{64}$/.test(m.token))
                return m as unknown as ToHost;
    }
}
