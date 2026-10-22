import type { GraphModel } from './model';
export type Strategy = 'current' | 'incoming' | 'both' | 'ai';
export interface Hunk {
    start: number;
    end: number;
    current: string;
    incoming: string;
    currentLabel: string;
    incomingLabel: string;
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
export interface PullRequestCheck {
    name: string;
    status: string;
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
export type ToWebview = {
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
} | {
    type: 'pull-request';
    pullRequest: PullRequestInfo | null;
};
export function asHostMessage(value: unknown): ToHost | undefined {
    if (!value || typeof value !== 'object')
        return;
    const m = value as Record<string, unknown>;
    const str = (key: string, max = 4096) => typeof m[key] === 'string' && (m[key] as string).length > 0 && (m[key] as string).length <= max;
    switch (m.type) {
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
            if (str('path') && ['current', 'incoming', 'both', 'ai'].includes(String(m.strategy)))
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
