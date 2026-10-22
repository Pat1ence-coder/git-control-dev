// Reference fixtures reproducing ref-fig/1.png, ref-fig/2.png and the key states of
// ref-fig/pitus-generative-ui-merge-conflicts.mp4 (30s, 60fps) as data.
// Development and tests only. Never import from src/extension.ts or src/webview/*;
// fixtures.ts asserts the shipped bundles do not contain this data.
// Every title, hash, author and label below was read from the video frames;
// only the four uncommitted file paths are invented (the video only says "4 files").
import type { Snapshot, BranchInfo } from '../../shared/protocol';
import type { GraphModel, GraphNode, GraphEdge } from '../../shared/model';
import type { ThreadView, ThreadChip, ThreadCheck, ConflictPrediction } from '../../shared/thread';

/** Fixed clock so relative times render exactly as in the video. */
export const REF_NOW = Date.parse('2026-10-22T10:00:00Z');
const ago = (minutes: number) => new Date(REF_NOW - minutes * 60000).toISOString();
/** Deterministic 40-char hash whose first 6 chars match the video. */
export const full = (short: string) => (short + '0123456789abcdef0123456789abcdef01234567').slice(0, 40);

const REPO = '/fixtures/acme-webapp';
const OURS = 'feat/session-refresh';
const OTHER = 'feat/checkout-analytics';
const BASE = 'main';
const TITLE = 'Refresh sessions in the auth middleware';
const NARRATION = 'PR **#128** is open, but `main` moved on while we worked: Lena\'s session key rotation changed the same lines in `auth.ts` and `middleware.ts`. I can merge `main` in and resolve them.';

export interface RefFixture {
    name: string;
    /** Where the state was read from: an image path or "video@<seconds>". */
    source: string;
    snapshot: Snapshot;
    thread: ThreadView;
    pr?: { number: number; state: 'open' | 'merged'; title: string; head: string; base: string; url: string };
    prediction?: ConflictPrediction;
}

function commit(short: string, title: string, lane: number, row: number, author: string, minutes: number, extra: Partial<GraphNode> = {}): GraphNode {
    return { id: full(short), hash: short, title, lane, row, badges: [], role: 'commit', author, authorDate: ago(minutes), ...extra };
}
const edge = (from: string, to: string, style: GraphEdge['style'] = 'solid'): GraphEdge =>
    ({ id: `${from.slice(0, 10)}-${to.slice(0, 10)}`, from, to, style });
const H = full;

function branchList(head: string, baseTip: string): BranchInfo[] {
    return [
        { name: OURS, ref: `refs/heads/${OURS}`, local: true, current: true, commit: H(head), ahead: 0, behind: 0 },
        { name: BASE, ref: `refs/heads/${BASE}`, local: true, current: false, commit: H(baseTip) },
        { name: OTHER, ref: `refs/heads/${OTHER}`, local: true, current: false, commit: H('e83c51') }
    ];
}
function snapshot(head: string, baseTip: string, graph: GraphModel, working: Snapshot['workingTreeFiles'] = []): Snapshot {
    return {
        repoId: REPO, repoName: 'acme-webapp', repositories: [{ id: REPO, name: 'acme-webapp' }],
        headName: OURS, headHash: H(head), branches: [BASE, OURS, OTHER],
        conflicts: [], workingTreeCount: working?.length ?? 0, workingTreeFiles: working, stagedCount: 0,
        mergeHead: false, rebasing: false, canMerge: true, canAbort: true, graph, branchList: branchList(head, baseTip)
    };
}

// Lanes: 0 = main (grey, leftmost), 1 = ours (blue), 2 = other branch (teal).
const DIFF: ThreadChip = { kind: 'diff', add: 482, del: 37, blocks: ['add', 'add', 'add', 'del', 'none'] };
const COMPOSER = { placeholder: 'Ask anything, or type / for skills', repo: 'acme-webapp', location: 'Local' as const };
const PR = { number: 128, title: TITLE, head: OURS, base: BASE, url: 'https://github.com/acme/acme-webapp/pull/128' };

/** History shared by every state: the five commits visible before the PR. */
function history(offset: number): GraphNode[] {
    return [
        commit('c70a92', 'Refresh sessions near expiry', 1, offset, 'You', 25),
        commit('e83c51', 'Add analytics consent banner', 2, offset + 1, 'Sam', 32, { badges: [OTHER] }),
        commit('1f8e3b', 'Read session expiry from the token', 1, offset + 2, 'You', 40),
        commit('62b0e4', 'Track checkout funnel events', 2, offset + 3, 'Sam', 120),
        commit('9c2d4a', 'Bump next to 16.3', 0, offset + 4, 'Sam', 180)
    ];
}
const historyEdges = [
    edge(H('c70a92'), H('1f8e3b')), edge(H('1f8e3b'), H('9c2d4a')),
    edge(H('e83c51'), H('62b0e4')), edge(H('62b0e4'), H('9c2d4a'))
];

// ── ref-fig/1.png · video 3.4s: "Create PR" sent, committing the last changes ──
const creatingGraph: GraphModel = {
    laneCount: 3,
    nodes: [
        { id: 'working-tree', hash: '', title: 'Uncommitted changes', lane: 1, row: 0, badges: [OURS], role: 'ghost', tip: true },
        ...history(1).map(n => n.hash === '9c2d4a' ? { ...n, badges: [BASE] } : n)
    ],
    edges: [edge('working-tree', H('c70a92'), 'pending'), ...historyEdges]
};
export const refCreatingPr: RefFixture = {
    name: 'creating-pr',
    source: 'ref-fig/1.png',
    snapshot: snapshot('c70a92', '9c2d4a', creatingGraph, [
        // invented: the video only shows "4 files"
        { path: 'src/auth.ts', status: 'M', untracked: false },
        { path: 'src/middleware.ts', status: 'M', untracked: false },
        { path: 'src/session/refresh.ts', status: 'A', untracked: true },
        { path: 'test/session.test.ts', status: 'M', untracked: false }
    ]),
    thread: {
        intent: 'Create PR',
        activity: { label: 'thinking', seconds: 0 },
        title: TITLE,
        rowMeta: { 'working-tree': { text: '4 files' } },
        foot: { icon: 'spinner', text: 'Committing the last changes' },
        chips: [{ kind: 'pr', state: 'creating' }, DIFF],
        composer: COMPOSER
    }
};

// Graph after the PR is open and main has been fetched: a "Merge into main" row on
// the main lane, our new commit d29f50, and Lena's two commits on main.
// The local merge commit is a ghost while conflicts are being resolved (video 14.8s,
// no hash) and becomes 7e0c3b once committed and pushed (video 18.3s).
export const MERGE_ROW = 'merge-into-main';
export const PENDING = 'pending-merge';
function prGraph(merge: 'none' | 'pending' | 'committed'): GraphModel {
    const off = merge === 'none' ? 0 : 1;
    const mergeNode: GraphNode[] = merge === 'none' ? []
        : merge === 'pending'
            ? [{ id: PENDING, hash: '', title: 'Merge main into feat/session-refresh', lane: 1, row: 1, badges: [OURS], role: 'ghost' }]
            : [commit('7e0c3b', 'Merge main into feat/session-refresh', 1, 1, 'You', 0, { badges: [OURS], role: 'merge' })];
    const nodes: GraphNode[] = [
        { id: MERGE_ROW, hash: '', title: 'Merge into main', lane: 0, row: 0, badges: [], role: 'conflict', tip: true },
        ...mergeNode,
        commit('d29f50', 'Add session refresh tests', 1, 1 + off, 'You', 0, merge === 'none' ? { badges: [OURS] } : {}),
        commit('5be27d', 'Read sessions with the current key', 0, 2 + off, 'Lena', 6, { badges: [BASE] }),
        commit('a3f9c1', 'Rotate session keys', 0, 3 + off, 'Lena', 18),
        ...history(4 + off)
    ];
    const head = merge === 'none' ? H('d29f50') : mergeNode[0].id;
    const edges = [
        edge(MERGE_ROW, head, 'pending'),
        edge(MERGE_ROW, H('5be27d'), 'pending'),
        ...(merge === 'none' ? [] : [edge(head, H('d29f50'), merge === 'pending' ? 'pending' : 'solid'), edge(head, H('5be27d'), merge === 'pending' ? 'pending' : 'solid')]),
        edge(H('d29f50'), H('c70a92')),
        edge(H('5be27d'), H('a3f9c1')),
        edge(H('a3f9c1'), H('9c2d4a')),
        ...historyEdges
    ];
    return { laneCount: 3, nodes, edges };
}
const PREDICTION: ConflictPrediction = {
    base: BASE,
    authors: ['Lena Park'],
    hunks: [
        { path: 'src/middleware.ts', line: 18,
            theirs: { author: 'Lena', text: 'const session = await readSession(req, keys)' },
            ours: { author: 'You', text: 'if (nearExpiry(session)) await refresh(session)' } },
        { path: 'src/auth.ts', line: 42,
            theirs: { author: 'Lena', text: 'return verify(token, keys.current)' },
            ours: { author: 'You', text: 'return refreshIfNear(token, 5 * MINUTE)' } },
        { path: 'src/auth.ts', line: 57,
            theirs: { author: 'Lena', text: 'const ttl = keys.current.ttl' },
            ours: { author: 'You', text: 'const ttl = session.expiresAt - Date.now()' } }
    ]
};

// ── ref-fig/2.png · video 8.0–11.0s: PR open, 3 conflicts with main ──
export const refConflicts: RefFixture = {
    name: 'pr-open-conflicts',
    source: 'ref-fig/2.png',
    snapshot: snapshot('d29f50', '5be27d', prGraph('none')),
    thread: {
        intent: 'Create PR',
        activity: { label: 'worked', seconds: 5 },
        title: TITLE, prNumber: 128,
        status: { label: 'Open', tone: 'open' },
        rowMeta: { [MERGE_ROW]: { text: '3 conflicts', tone: 'warning' } },
        rowMarks: { [H('5be27d')]: { kind: 'count', n: 1 }, [H('a3f9c1')]: { kind: 'count', n: 2 } },
        warn: [H('5be27d'), H('a3f9c1')],
        foot: { icon: 'warning', text: '3 conflicts with main', trigger: '3 conflicts', action: { label: 'Resolve conflicts' } },
        narration: NARRATION,
        chips: [{ kind: 'pr', state: 'conflicts', number: 128, conflicts: 3 }, DIFF],
        composer: COMPOSER
    },
    pr: { ...PR, state: 'open' },
    prediction: PREDICTION
};

// While merging, the real snapshot carries MERGE_HEAD and the conflicts still left.
// Lena's 5be27d touched middleware.ts (1 hunk), a3f9c1 touched auth.ts (2 hunks).
function merging(conflicts: Snapshot['conflicts']): Snapshot {
    return { ...snapshot('d29f50', '5be27d', prGraph('pending')), mergeHead: true, mergingRef: BASE, conflicts };
}
const authHunk = (i: 1 | 2) => {
    const h = PREDICTION.hunks[i];
    return { start: h.line - 1, end: h.line + 3, current: h.ours.text, incoming: h.theirs.text,
        currentLabel: 'HEAD', incomingLabel: BASE, currentStart: h.line, incomingStart: h.line };
};

// ── video 15.3s: merging main in, resolving conflict 2 of 3 ──
export const refResolving: RefFixture = {
    name: 'resolving',
    source: 'video@15.3',
    snapshot: merging([{ path: 'src/auth.ts', status: '双方修改', hunks: [authHunk(1), authHunk(2)] }]),
    thread: {
        ...refConflicts.thread,
        rowMeta: { [MERGE_ROW]: { text: '2 conflicts', tone: 'warning' }, [PENDING]: { text: '2/3' } },
        nodeIcons: { [PENDING]: 'spinner' },
        rowMarks: { [H('5be27d')]: { kind: 'check' }, [H('a3f9c1')]: { kind: 'count', n: 2 } },
        warn: [H('a3f9c1')],
        foot: { icon: 'spinner', text: 'Resolving conflict 2 of 3', action: { label: 'Resolving', busy: true } },
        chips: [{ kind: 'pr', state: 'resolving', number: 128 }, DIFF]
    },
    pr: { ...PR, state: 'open' },
    prediction: PREDICTION
};

// ── video 17.3s: conflicts resolved, running the local test suite ──
export const refTesting: RefFixture = {
    name: 'running-tests',
    source: 'video@17.3',
    snapshot: merging([]),
    thread: {
        ...refResolving.thread,
        rowMeta: { [MERGE_ROW]: { text: 'resolved', tone: 'warning' }, [PENDING]: { text: '28/42' } },
        rowMarks: { [H('5be27d')]: { kind: 'check' }, [H('a3f9c1')]: { kind: 'check' } },
        warn: [],
        rowProgress: { id: PENDING, value: 28, total: 42 },
        foot: { icon: 'spinner', text: 'Running 28 of 42 tests', action: { label: 'Resolving', busy: true } }
    },
    pr: { ...PR, state: 'open' }
};

const CHECKS: ThreadCheck[] = [
    { name: 'Tests', result: '42 passed', detail: 'vitest · 42 passed, 0 failed', duration: '38s' },
    { name: 'Lint', result: 'passed', detail: 'eslint · no problems', duration: '9s' },
    { name: 'Types', result: 'passed', detail: 'tsc --noEmit · no errors', duration: '21s' },
    { name: 'Preview', result: 'ready', detail: 'Deployed to session-refresh.preview.acme.dev', duration: '1m 4s' }
];
function readyGraph(): GraphModel {
    const g = prGraph('committed');
    return { ...g, nodes: g.nodes.map(n => n.id === MERGE_ROW ? { ...n, role: 'ghost' as const } : n) };
}

// ── video 20.0s: merge pushed, checks green, ready to merge ──
export const refReady: RefFixture = {
    name: 'ready-to-merge',
    source: 'video@20.0',
    snapshot: snapshot('7e0c3b', '5be27d', readyGraph()),
    thread: {
        ...refConflicts.thread,
        rowMeta: { [MERGE_ROW]: { text: 'ready', tone: 'success' } },
        nodeIcons: { [MERGE_ROW]: 'check' },
        rowMarks: {},
        warn: [],
        checks: CHECKS,
        foot: { icon: 'check', text: 'Ready to merge', action: { label: 'Merge', icon: 'merge' } },
        chips: [{ kind: 'pr', state: 'ready', number: 128 }, DIFF]
    },
    pr: { ...PR, state: 'open' }
};

// ── video 28.0s: PR merged ──
function mergedGraph(): GraphModel {
    const g = readyGraph();
    const nodes = g.nodes.map(n => n.id === MERGE_ROW
        ? { ...n, title: 'Merged into main', badges: [BASE], role: 'merge' as const }
        : n.hash === '5be27d' ? { ...n, badges: [] } : n);
    const edges = g.edges.map(e => e.from === MERGE_ROW ? { ...e, style: 'join' as const } : e);
    return { ...g, nodes, edges };
}
export const refMerged: RefFixture = {
    name: 'merged',
    source: 'video@28.0',
    snapshot: snapshot('7e0c3b', '5be27d', mergedGraph()),
    thread: {
        ...refReady.thread,
        status: { label: 'Merged', tone: 'merged' },
        rowMeta: { [MERGE_ROW]: { text: 'merged', tone: 'merged' } },
        nodeIcons: { [MERGE_ROW]: 'merged' },
        mergedLanes: [1],
        checks: undefined,
        foot: { icon: 'merged', text: 'Merged into main', action: { label: 'GitHub', icon: 'github' } },
        chips: [{ kind: 'pr', state: 'merged', number: 128 }]
    },
    pr: { ...PR, state: 'merged' }
};

export const refFixtures: RefFixture[] = [refCreatingPr, refConflicts, refResolving, refTesting, refReady, refMerged];
