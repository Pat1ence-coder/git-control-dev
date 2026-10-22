// Single-card task thread (replica of ref-fig/pitus-generative-ui-merge-conflicts.mp4).
// Pure HTML from a ThreadFrame. Every element that should persist across frames
// carries a stable data-key so morph.ts can update it in place and animate.
import { esc } from '../../shared/html';
import type { GraphModel, GraphNode, GraphEdge } from '../../shared/model';
import type { ThreadFrame, ThreadView, ThreadChip, ThreadCheck, ConflictPrediction, LaneTone, NodeIcon } from '../../shared/thread';

export const ROW_H = 30;
const LANE_X0 = 10, LANE_W = 17, TEXT_X = 61;

const ICONS = {
    chevron: '<path d="M6 4l4 4-4 4"/>',
    warning: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.8v2.9M8 11.4v.1"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    merge: '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="8" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.5c0 2.5 2 2.5 5.4 2.5"/>',
    github: '<path fill="currentColor" stroke="none" d="M8 1.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.44-.14.44-.31v-1.1c-1.8.39-2.18-.87-2.18-.87-.3-.75-.72-.95-.72-.95-.59-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.52.71 1.89.54.06-.42.23-.71.41-.87-1.44-.16-2.95-.72-2.95-3.2 0-.71.25-1.29.67-1.74-.07-.17-.29-.83.06-1.72 0 0 .54-.18 1.78.66a6.2 6.2 0 0 1 3.24 0c1.24-.84 1.78-.66 1.78-.66.35.89.13 1.55.06 1.72.42.45.67 1.03.67 1.74 0 2.49-1.52 3.04-2.96 3.2.23.2.44.6.44 1.2v1.79c0 .17.11.38.45.31A6.5 6.5 0 0 0 8 1.5z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    folder: '<path d="M2 4.5h4l1.4 1.5H14v6.5H2z"/>',
    laptop: '<path d="M3.5 4h9v6h-9zM1.5 12h13"/>',
    cloud: '<path d="M4.8 12.5h6.6a2.6 2.6 0 0 0 .3-5.2 3.7 3.7 0 0 0-7.1.9 2.2 2.2 0 0 0 .2 4.3z"/>',
    mic: '<path d="M8 2.5a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-3.6 0V4.3A1.8 1.8 0 0 1 8 2.5zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5"/>',
    arrowUp: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
    chevronDown: '<path d="M4.5 6.5L8 10l3.5-3.5"/>'
} as const;
type IconName = keyof typeof ICONS;
export const icon = (name: IconName, cls = '') =>
    `<svg class="gg-icon ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
const spinner = (cls = '') => `<span class="gg-spinner ${cls}" aria-hidden="true"></span>`;
const k = (key: string) => `data-key="${esc(key)}"`;

export function relTime(iso: string | undefined, now: number): string {
    if (!iso) return '';
    const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
}

const DEFAULT_LANES: LaneTone[] = ['base', 'ours', 'other'];
function laneTone(t: ThreadView, lane: number): string {
    if (t.mergedLanes?.includes(lane)) return 'merged';
    return (t.lanes ?? DEFAULT_LANES)[lane] ?? 'other';
}
const x = (lane: number) => LANE_X0 + lane * LANE_W;
const y = (row: number) => row * ROW_H + ROW_H / 2;

function nodeIcon(t: ThreadView, n: GraphNode): NodeIcon | 'dot' {
    const forced = t.nodeIcons?.[n.id];
    if (forced) return forced;
    if (n.role === 'conflict') return 'warning';
    if (n.role === 'ghost') return n.tip ? 'spinner' : 'ring';
    if (n.role === 'merge') return t.mergedLanes?.includes(n.lane) ? 'dot' : 'ring';
    return 'dot';
}
function glyph(kind: NodeIcon | 'dot'): string {
    switch (kind) {
        case 'spinner': return '<circle class="gg-n-orbit" r="5.5"/><circle class="gg-n-core" r="2.2"/>';
        case 'ring': return '<circle class="gg-n-ring" r="4"/>';
        case 'warning': return '<circle class="gg-n-badge" r="6.5"/><path class="gg-n-mark" d="M0 -3.2V0.6M0 3V3.1"/>';
        case 'check': return '<circle class="gg-n-badge" r="6.5"/><path class="gg-n-mark" d="M-2.8 0.2l1.9 1.9 3.8-4"/>';
        case 'merged': return '<circle class="gg-n-badge" r="6.5"/>';
        default: return '<circle class="gg-n-dot" r="3.5"/>';
    }
}
/** One path shape for every edge (M, L, C) so CSS can interpolate `d` when rows move. */
function edgePath(a: GraphNode, b: GraphNode): string {
    const x1 = x(a.lane), y1 = y(a.row), x2 = x(b.lane), y2 = y(b.row);
    const bend = Math.max(y1, y2 - ROW_H);
    const mid = (bend + y2) / 2;
    return `M${x1} ${y1}L${x1} ${bend}C${x1} ${mid},${x2} ${mid},${x2} ${y2}`;
}

function renderRail(graph: GraphModel, t: ThreadView): string {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const replaced = (id: string) => t.replaces?.[id] ?? id;
    const height = graph.nodes.length * ROW_H;
    const width = LANE_X0 * 2 + Math.max(1, graph.laneCount) * LANE_W;
    const edges = graph.edges.map((e: GraphEdge) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) return '';
        const fromIcon = nodeIcon(t, a);
        const tone = fromIcon === 'warning' ? 'warn' : fromIcon === 'check' ? 'ok' : fromIcon === 'merged' ? 'merged'
            : laneTone(t, a.lane === 0 ? b.lane : a.lane);
        const key = `e:${replaced(e.from)}>${replaced(e.to)}`;
        return `<path ${k(key)} class="gg-edge t-${tone} s-${e.style}" pathLength="1" style="d:path('${edgePath(a, b)}')"/>`;
    }).join('');
    const nodes = graph.nodes.map(n => {
        const kind = nodeIcon(t, n);
        const tone = t.warn?.includes(n.id) ? 'warn' : kind === 'check' ? 'ok' : kind === 'warning' ? 'warn' : kind === 'merged' ? 'merged' : laneTone(t, n.lane);
        return `<g ${k(`n:${replaced(n.id)}`)} class="gg-node t-${tone} g-${kind}" style="transform:translate(${x(n.lane)}px,${y(n.row)}px);--rev:${graph.nodes.length - 1 - n.row}"><g class="gg-glyph" ${k(`g:${kind}`)}>${glyph(kind)}</g></g>`;
    }).join('');
    return `<svg class="gg-rail" width="${width}" style="height:${height}px" aria-hidden="true"><g class="gg-edges">${edges}</g><g class="gg-nodes">${nodes}</g></svg>`;
}

function renderRow(n: GraphNode, t: ThreadView, rowCount: number, now: number): string {
    const tone = laneTone(t, n.lane);
    const warn = t.warn?.includes(n.id);
    const strong = tone === 'ours' || tone === 'merged';
    const mark = t.rowMarks?.[n.id];
    const meta = t.rowMeta?.[n.id];
    const badges = n.badges.map(b => `<span class="gg-tag t-${n.lane === 0 ? 'base' : tone}">${esc(b)}</span>`).join('');
    const markHtml = !mark ? '' : mark.kind === 'check'
        ? `<span class="gg-mark is-check" ${k('mark')}>${icon('check')}</span>`
        : `<span class="gg-mark" ${k('mark')} data-num>${mark.n}</span>`;
    const right = meta
        ? `<span class="gg-meta t-${meta.tone ?? 'muted'}" ${k('meta-text')} data-num>${esc(meta.text)}</span>`
        : `<span class="gg-meta" ${k('meta-commit')}><code data-scramble>${esc(n.hash)}</code><span>${esc(n.author ?? '')}</span><span class="gg-dot-sep">·</span><time>${relTime(n.authorDate, now)}</time></span>`;
    const progress = t.rowProgress?.id === n.id
        ? `<span class="gg-progress" ${k('progress')}><span style="width:${(100 * t.rowProgress.value / Math.max(1, t.rowProgress.total)).toFixed(1)}%"></span></span>` : '';
    const cls = ['gg-row', `t-${tone}`, strong ? 'is-strong' : '', warn ? 'is-warn' : '', n.role === 'ghost' ? 'is-ghost' : ''].filter(Boolean).join(' ');
    const key = t.replaces?.[n.id] ?? n.id;
    return `<div ${k(`r:${key}`)} class="${cls}" style="transform:translateY(${n.row * ROW_H}px);--rev:${rowCount - 1 - n.row};--row:${n.row}">`
        + `<span class="gg-title" ${k('title')} data-scramble title="${esc(n.title)}">${esc(n.title)}</span>${badges}${markHtml}${right}${progress}</div>`;
}

function renderChecks(checks: ThreadCheck[]): string {
    return `<div class="gg-checks" ${k('checks')}>${checks.map((c, i) =>
        `<span class="gg-check" ${k(`c:${c.name}`)} style="--i:${i}" tabindex="0">${icon('check')}<b>${esc(c.name)}</b><span>${esc(c.result)}</span>`
        + `<span class="gg-tip" role="tooltip">${esc(c.detail)}<em>${esc(c.duration)}</em></span></span>`).join('')}</div>`;
}

function renderPopover(p: ConflictPrediction): string {
    const who = p.authors.length === 1 ? p.authors[0] : p.authors.length === 2 ? p.authors.join(' and ') : `${p.authors[0]} and ${p.authors.length - 1} others`;
    const groups = p.hunks.map(h => {
        const name = h.path.split('/').pop() ?? h.path;
        return `<div class="gg-pop-group"><div class="gg-pop-file"><b>${esc(name)}</b> line ${h.line}</div>`
            + `<div class="gg-pop-line is-theirs"><span>${esc(h.theirs.author)}</span><code>${esc(h.theirs.text)}</code></div>`
            + `<div class="gg-pop-line is-ours"><span>${esc(h.ours.author)}</span><code>${esc(h.ours.text)}</code></div></div>`;
    }).join('');
    return `<div class="gg-popover" role="dialog" aria-label="Conflicts"><div class="gg-pop-head"><b>${esc(who)}</b> changed the same lines on ${esc(p.base)}</div>${groups}</div>`;
}

function renderFoot(t: ThreadView, prediction?: ConflictPrediction): string {
    const f = t.foot;
    const lead = f.icon === 'spinner' ? spinner() : f.icon === 'warning' ? icon('warning', 'is-warn')
        : f.icon === 'check' ? icon('check', 'is-ok') : icon('merge', 'is-merged');
    let text = esc(f.text);
    if (f.trigger && f.text.startsWith(f.trigger)) {
        const pop = prediction ? renderPopover(prediction) : '';
        text = `<span class="gg-trigger ${t.popoverOpen ? 'is-open' : ''}" tabindex="0">${esc(f.trigger)}${pop}</span>${esc(f.text.slice(f.trigger.length))}`;
    }
    const a = f.action;
    const action = !a ? '' : `<button type="button" ${k('action')} class="gg-action ${a.busy ? 'is-busy' : ''} ${a.icon === 'github' ? 'is-neutral' : ''}" ${a.busy ? 'disabled' : ''}>`
        + `${a.busy ? spinner() : a.icon ? icon(a.icon) : ''}<span ${k('action-label')}>${esc(a.label)}</span></button>`;
    return `<div class="gg-foot" ${k('foot')}><span class="gg-foot-lead" ${k(`lead:${f.icon}`)}>${lead}</span>`
        + `<span class="gg-foot-text ${f.icon === 'spinner' ? 'is-working' : ''}" ${k(`ft:${f.text}`)}>${text}</span>${action}</div>`;
}

function renderCard(frame: ThreadFrame, t: ThreadView): string {
    const { graph } = frame;
    const rows = [...graph.nodes].sort((a, b) => a.row - b.row).map(n => renderRow(n, t, graph.nodes.length, frame.now)).join('');
    const status = t.status
        ? `<span class="gg-status t-${t.status.tone}" ${k(`status:${t.status.tone}`)}><i></i>${esc(t.status.label)}</span>` : '';
    return `<section class="gg-card" ${k('card')}>`
        + `<header class="gg-head" ${k('head')}><h2 ${k('h')}>${esc(t.title)}${t.prNumber ? ` <span class="gg-pr" ${k('pr')}>#${t.prNumber}</span>` : ''}</h2>${status}</header>`
        + `<div class="gg-graph" ${k('graph')} style="height:${graph.nodes.length * ROW_H}px">${renderRail(graph, t)}<div class="gg-rows" ${k('rows')}>${rows}</div></div>`
        + (t.checks?.length ? renderChecks(t.checks) : '')
        + renderFoot(t, frame.prediction)
        + '</section>';
}

function renderChip(c: ThreadChip): string {
    if (c.kind === 'suggestion')
        return `<button type="button" class="gg-chip is-suggestion" ${k(`chip:s:${c.label}`)} data-wmorph data-action="suggest">${esc(c.label)}</button>`;
    if (c.kind === 'diff') {
        const blocks = c.blocks.map(b => `<i class="b-${b}"></i>`).join('');
        return `<span class="gg-chip is-diff" ${k('chip:diff')} data-wmorph data-exit><span class="add">+${c.add}</span><span class="del">−${c.del}</span><span class="gg-blocks">${blocks}</span>${icon('chevronDown')}</span>`;
    }
    const lead = ['creating', 'resolving', 'merging'].includes(c.state) ? spinner()
        : c.state === 'merged' ? icon('merge', 'is-merged') : `<i class="gg-chip-dot s-${c.state}"></i>`;
    const label: Record<string, string> = { creating: 'Creating PR', resolving: 'Resolving', ready: 'Ready to merge', merging: 'Merging', merged: 'Merged',
        conflicts: `${c.conflicts ?? 0} conflict${c.conflicts === 1 ? '' : 's'}` };
    const num = c.number ? `<b>#${c.number}</b>` : '';
    return `<span class="gg-chip is-pr s-${c.state}" ${k('chip:pr')} data-wmorph><span class="gg-chip-lead" ${k(`lead:${c.state}`)}>${lead}</span>${num}<span class="gg-chip-state" ${k(`st:${c.state}`)}>${label[c.state]}</span></span>`;
}

function renderNarration(text: string): string {
    let i = 0;
    const html = text.replace(/`([^`]+)`|\*\*([^*]+)\*\*|(\S+)/g, (_m, code: string, bold: string, word: string) => {
        const style = `style="--i:${i++}"`;
        if (code !== undefined) return `<code class="w" ${style}>${esc(code)}</code>`;
        if (bold !== undefined) return `<b class="w" ${style}>${esc(bold)}</b>`;
        return `<span class="w" ${style}>${esc(word)}</span>`;
    });
    return `<p class="gg-narration" ${k('narration')}>${html}</p>`;
}

function renderComposer(c: ThreadFrame['composer']): string {
    return `<div class="gg-composer" ${k('composer')}><div class="gg-input">${esc(c.placeholder)}</div><div class="gg-tools">`
        + `<span class="gg-round">${icon('plus')}</span><span class="gg-pill">${icon('folder')}${esc(c.repo)}</span>`
        + `<span class="gg-seg"><span class="gg-seg-on">${icon('laptop')}${esc(c.location)}</span><span class="gg-seg-off">${icon('cloud')}</span></span>`
        + `<span class="gg-spacer"></span><span class="gg-effort"><i></i><i></i><i></i><i></i>Medium</span><span class="gg-mic">${icon('mic')}</span>`
        + `<span class="gg-send">${icon('arrowUp')}</span></div></div>`;
}

export function renderThread(frame: ThreadFrame): string {
    const t = frame.thread;
    const chips = t ? t.chips : frame.idleChips ?? [];
    const activity = !t ? '' : t.activity.label === 'thinking'
        ? `<div class="gg-activity is-thinking" ${k('activity')}>${icon('chevron')}<span class="gg-shimmer">Thinking</span><span class="gg-secs" ${k('secs')} data-num>${t.activity.seconds}s</span></div>`
        : `<div class="gg-activity" ${k('activity')}>${icon('chevron')}<span ${k('worked')}>Worked for ${t.activity.seconds}s</span></div>`;
    return `<div class="gg-thread ${t ? '' : 'is-idle'}" ${k('thread')}>`
        + (t ? `<div class="gg-intent" ${k('intent')}>${esc(t.intent)}</div>${t.intentOnly ? '' : activity + renderCard(frame, t)}` : '')
        + (t?.narration ? renderNarration(t.narration) : '')
        + `<div class="gg-chips" ${k('chips')}>${chips.map(renderChip).join('')}</div>`
        + renderComposer(frame.composer)
        + '</div>';
}
