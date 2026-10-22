// View model for the single-card task thread (ref-fig video replica).
// Types only: the UI is driven by fixtures today and by real Git/PR data later
// (see NEXT_PHASE_DESIGN.md §6, §8).
import type { GraphModel } from './model';

export type DiffBlock = 'add' | 'del' | 'none';
export type PrChipState = 'creating' | 'conflicts' | 'resolving' | 'ready' | 'merging' | 'merged';
export type ThreadChip =
    | { kind: 'suggestion'; label: string }
    | { kind: 'pr'; state: PrChipState; number?: number; conflicts?: number }
    | { kind: 'diff'; add: number; del: number; blocks: DiffBlock[] };
export type RowMark = { kind: 'count'; n: number } | { kind: 'check' };
export type LaneTone = 'base' | 'ours' | 'other';
export type NodeIcon = 'spinner' | 'warning' | 'check' | 'merged' | 'ring';
export type MetaTone = 'muted' | 'warning' | 'success' | 'merged';
export interface ThreadCheck { name: string; result: string; detail: string; duration: string }
export interface ConflictPrediction {
    base: string;
    authors: string[];
    hunks: { path: string; line: number; theirs: { author: string; text: string }; ours: { author: string; text: string } }[];
}
export interface ThreadFoot {
    icon: 'spinner' | 'warning' | 'check' | 'merged';
    text: string;
    /** Part of `text` with a dotted underline that opens the conflict popover. */
    trigger?: string;
    action?: { label: string; busy?: boolean; icon?: 'merge' | 'github' };
}
export interface ThreadView {
    intent: string;
    /** Intent sent but nothing back yet: only the bubble is shown (video 1.7–2.5s). */
    intentOnly?: boolean;
    /** Keep the conflict popover open (hover in the video at 11s; used by preview and screenshots). */
    popoverOpen?: boolean;
    activity: { label: 'thinking' | 'worked'; seconds: number };
    title: string;
    prNumber?: number;
    status?: { label: string; tone: 'open' | 'merged' };
    /** Colour role of each lane; defaults to base, ours, other, other… */
    lanes?: LaneTone[];
    /** Right-hand text replacing hash/author/time, e.g. "4 files", "checking", "2/3". */
    rowMeta?: Record<string, { text: string; tone?: MetaTone }>;
    /** Small pill after a commit title: remaining conflicts from that commit, or a resolved check. */
    rowMarks?: Record<string, RowMark>;
    /** Commits drawn in the warning colour (title and dot) as conflict sources. */
    warn?: string[];
    /** Thin green progress line under a row (local test run). */
    rowProgress?: { id: string; value: number; total: number };
    /** Lanes recoloured to the merged purple after the PR lands. */
    mergedLanes?: number[];
    /** Node glyph overrides; otherwise derived from the node role. */
    nodeIcons?: Record<string, NodeIcon>;
    /** New row id -> old row id it morphs from in place (ghost -> commit). */
    replaces?: Record<string, string>;
    checks?: ThreadCheck[];
    foot: ThreadFoot;
    narration?: string;
    chips: ThreadChip[];
    composer: { placeholder: string; repo: string; location: string };
}
/** Everything the thread renderer needs for one frame. */
export interface ThreadFrame {
    graph: GraphModel;
    /** Absent before the first intent: only chips and composer are shown. */
    thread?: ThreadView;
    /** Shown when no thread exists yet. */
    idleChips?: ThreadChip[];
    composer: ThreadView['composer'];
    prediction?: ConflictPrediction;
    /** Clock for relative times; fixtures pin it. */
    now: number;
}
