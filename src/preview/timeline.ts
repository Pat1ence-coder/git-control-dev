// Dev-only: the ref video's 30s flow as a list of frames built from the reference
// fixtures. Times are milliseconds from clicking "Create PR" (video t ≈ 1.4s).
import type { GraphModel } from '../shared/model';
import type { ThreadFrame, ThreadView } from '../shared/thread';
import {
    REF_NOW, full, MERGE_ROW, PENDING,
    refCreatingPr, refConflicts, refResolving, refTesting, refReady, refMerged
} from '../test/fixtures/refFig';

export interface Step { at: number; label: string; frame: ThreadFrame }

const COMPOSER = refCreatingPr.thread.composer;
const DIFF = refCreatingPr.thread.chips[1];

/** Remove rows (and their edges) from a graph and close the gaps. */
function dropRows(graph: GraphModel, ids: string[]): GraphModel {
    const nodes = graph.nodes.filter(n => !ids.includes(n.id)).sort((a, b) => a.row - b.row).map((n, row) => ({ ...n, row }));
    const keep = new Set(nodes.map(n => n.id));
    return { ...graph, nodes, edges: graph.edges.filter(e => keep.has(e.from) && keep.has(e.to)) };
}
/** Before main is fetched its tip is still 9c2d4a, so the `main` tag stays there (video 4.0s). */
function mainAtOldTip(graph: GraphModel): GraphModel {
    return { ...graph, nodes: graph.nodes.map(n => n.hash === '9c2d4a' ? { ...n, badges: ['main'] } : n) };
}
const frame = (graph: GraphModel, thread: ThreadView | undefined, extra: Partial<ThreadFrame> = {}): ThreadFrame =>
    ({ graph, thread, composer: COMPOSER, now: REF_NOW, prediction: refConflicts.prediction, ...extra });

export function buildTimeline(): Step[] {
    const steps: Step[] = [];
    // Ghost rows that become commits keep their DOM row so the title decodes in place.
    let replaces: Record<string, string> = {};
    const add = (at: number, label: string, graph: GraphModel, thread?: ThreadView, extra?: Partial<ThreadFrame>) =>
        steps.push({ at, label, frame: frame(graph, thread && { ...thread, replaces: { ...replaces } }, extra) });

    const creating = refCreatingPr.thread;
    add(0, 'Idle · suggestion chip', refCreatingPr.snapshot.graph, undefined, { idleChips: [{ kind: 'suggestion', label: 'Create PR' }, DIFF] });
    add(300, 'Intent sent', refCreatingPr.snapshot.graph, { ...creating, intentOnly: true });
    add(1100, 'Committing the last changes', refCreatingPr.snapshot.graph, creating);
    add(2000, 'Thinking 1s', refCreatingPr.snapshot.graph, { ...creating, activity: { label: 'thinking', seconds: 1 } });

    replaces = { [full('d29f50')]: 'working-tree' };
    const committed = mainAtOldTip(dropRows(refConflicts.snapshot.graph, [MERGE_ROW, full('5be27d'), full('a3f9c1')]));
    const prOpen = mainAtOldTip(dropRows(refConflicts.snapshot.graph, [full('5be27d'), full('a3f9c1')]));
    const pushing: ThreadView = { ...creating, rowMeta: {}, activity: { label: 'thinking', seconds: 1 }, foot: { icon: 'spinner', text: 'Pushing 3 commits to origin' } };
    add(2600, 'Commit created · pushing', committed, pushing);
    add(3100, 'Thinking 2s', committed, { ...pushing, activity: { label: 'thinking', seconds: 2 } });
    add(3600, 'Opening the pull request', committed, { ...pushing, activity: { label: 'thinking', seconds: 2 }, foot: { icon: 'spinner', text: 'Opening the pull request' } });

    const open: ThreadView = { ...pushing, prNumber: 128, status: { label: 'Open', tone: 'open' }, activity: { label: 'thinking', seconds: 3 },
        nodeIcons: { [MERGE_ROW]: 'spinner' }, foot: { icon: 'spinner', text: 'Opening the pull request' } };
    add(4100, 'PR #128 open · merge row', prOpen, open);
    const fetching: ThreadView = { ...open, foot: { icon: 'spinner', text: 'Fetching main' } };
    add(4400, 'Fetching main', prOpen, fetching);
    add(4700, 'Lena · 5be27d', dropRows(refConflicts.snapshot.graph, [full('a3f9c1')]), fetching);
    add(5000, 'Lena · a3f9c1', refConflicts.snapshot.graph, fetching);
    const checking: ThreadView = { ...fetching, activity: { label: 'thinking', seconds: 4 }, rowMeta: { [MERGE_ROW]: { text: 'checking' } }, foot: { icon: 'spinner', text: 'Checking it merges cleanly' } };
    add(5300, 'Checking it merges cleanly', refConflicts.snapshot.graph, checking);
    add(6200, 'Thinking 5s', refConflicts.snapshot.graph, { ...checking, activity: { label: 'thinking', seconds: 5 } });

    const conflicts = { ...refConflicts.thread, narration: undefined };
    add(6400, '3 conflicts with main', refConflicts.snapshot.graph, conflicts);
    add(6800, 'Narration', refConflicts.snapshot.graph, refConflicts.thread);
    add(9300, 'Hover · conflict popover', refConflicts.snapshot.graph, { ...refConflicts.thread, popoverOpen: true });
    add(11300, 'Popover closed', refConflicts.snapshot.graph, refConflicts.thread);

    const resolvingBase: ThreadView = { ...refConflicts.thread, foot: { icon: 'spinner', text: 'Merging main into the branch', action: { label: 'Resolving', busy: true } },
        chips: [{ kind: 'pr', state: 'resolving', number: 128 }, DIFF] };
    add(12000, 'Resolve clicked · merging main in', refConflicts.snapshot.graph, resolvingBase);
    const g = refResolving.snapshot.graph;
    const conflict = (n: number) => ({ icon: 'spinner' as const, text: `Resolving conflict ${n} of 3`, action: { label: 'Resolving', busy: true } });
    add(13400, 'Resolving conflict 1 of 3', g, { ...resolvingBase, nodeIcons: { [PENDING]: 'spinner' }, rowMeta: { [MERGE_ROW]: { text: '3 conflicts', tone: 'warning' }, [PENDING]: { text: '1/3' } }, foot: conflict(1) });
    add(13900, 'Resolving conflict 2 of 3', g, refResolving.thread);
    add(14400, 'Resolving conflict 3 of 3', g, { ...refResolving.thread,
        rowMeta: { [MERGE_ROW]: { text: '1 conflict', tone: 'warning' }, [PENDING]: { text: '3/3' } },
        rowMarks: { [full('5be27d')]: { kind: 'check' }, [full('a3f9c1')]: { kind: 'count', n: 1 } }, foot: conflict(3) });
    add(14900, 'Conflicts resolved', g, { ...refTesting.thread, rowProgress: undefined,
        rowMeta: { [MERGE_ROW]: { text: 'resolved', tone: 'warning' }, [PENDING]: { text: '3/3' } }, foot: conflict(3) });
    [2, 9, 17, 28, 36, 42].forEach((n, i) => add(15200 + i * 220, `Running ${n} of 42 tests`, refTesting.snapshot.graph, { ...refTesting.thread,
        rowMeta: { [MERGE_ROW]: { text: 'resolved', tone: 'warning' }, [PENDING]: { text: `${n}/42` } },
        rowProgress: { id: PENDING, value: n, total: 42 }, foot: { icon: 'spinner', text: `Running ${n} of 42 tests`, action: { label: 'Resolving', busy: true } } }));

    replaces = { ...replaces, [full('7e0c3b')]: PENDING };
    const readyGraph = refReady.snapshot.graph;
    add(16900, 'Pushing the merge', readyGraph, { ...refTesting.thread, rowProgress: undefined, nodeIcons: { [MERGE_ROW]: 'warning' },
        rowMeta: { [MERGE_ROW]: { text: 'resolved', tone: 'warning' } }, foot: { icon: 'spinner', text: 'Pushing the merge', action: { label: 'Resolving', busy: true } } });
    add(17400, 'Checks green · ready to merge', readyGraph, refReady.thread);
    add(24900, 'Merge clicked', readyGraph, { ...refReady.thread, foot: { icon: 'spinner', text: 'Merging into main', action: { label: 'Merging', busy: true } },
        chips: [{ kind: 'pr', state: 'merging', number: 128 }, DIFF] });
    add(25600, 'Merged into main', refMerged.snapshot.graph, refMerged.thread);
    add(28600, 'End', refMerged.snapshot.graph, refMerged.thread);
    return steps;
}
