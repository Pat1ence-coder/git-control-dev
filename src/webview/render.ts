import { esc, clipChars } from '../shared/html';
import type { GraphModel } from '../shared/model';
import type { ConflictFile, CommitDetail, Snapshot, Strategy, StagedReview } from '../shared/protocol';
import { DEMO_CONFLICT, demoResolved, demoCheck, type DemoState } from '../demo/scenario';
import { parseConflict } from '../git/conflicts';
export type LiveState = {
    kind: 'overview';
} | {
    kind: 'confirm' | 'merging';
    ref: string;
} | {
    kind: 'abort-confirm';
} | {
    kind: 'resolving';
    path: string;
} | {
    kind: 'committed';
    hash?: string;
} | {
    kind: 'error';
    text: string;
};
export const strategyNames: Record<Strategy, string> = { current: '保留当前', incoming: '保留传入', both: '两者都保留', ai: 'AI 草拟' };
export const button = (action: string, label: string, cls = '', attrs = '') => `<button type="button" data-action="${action}" class="${cls}" ${attrs}>${label}</button>`;
function relativeTime(value?: string): string {
    if (!value) return '';
    const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
    if (!Number.isFinite(elapsed)) return '';
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
}
export function renderGraph(graph: GraphModel, reduced: boolean, particle = false, selected?: string): string {
    if (!graph.nodes.length) return '<div class="graph-empty">打开仓库后，这里会显示提交历史。</div>';
    const rowH = 44, laneW = 22, left = 17;
    const railWidth = left + Math.max(1, graph.laneCount) * laneW + 10;
    const height = (Math.max(...graph.nodes.map(n => n.row)) + 1) * rowH;
    const x = (lane: number) => left + lane * laneW;
    const y = (row: number) => row * rowH + rowH / 2;
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    const paths = graph.edges.map(edge => {
        const a = nodes.get(edge.from), b = nodes.get(edge.to);
        if (!a || !b) return '';
        // Graph edges describe child -> parent history. Workflow animation travels
        // in the opposite direction: from the parent branches into the new result.
        const start = edge.style === 'solid' ? a : b;
        const end = edge.style === 'solid' ? b : a;
        const mid = (y(start.row) + y(end.row)) / 2;
        const d = start.lane === end.lane ? `M${x(start.lane)} ${y(start.row)}L${x(end.lane)} ${y(end.row)}`
            : `M${x(start.lane)} ${y(start.row)}C${x(start.lane)} ${mid},${x(end.lane)} ${mid},${x(end.lane)} ${y(end.row)}`;
        const lane = a.lane === b.lane ? a.lane : b.lane;
        const style = reduced && edge.style === 'join' ? 'solid' : edge.style;
        return `<path class="edge lane-${lane % 6} ${style}" d="${d}"/>${particle && !reduced && edge.style === 'pending' && a.lane !== b.lane ? `<circle r="2.5" class="spark"><animateMotion dur="1.4s" repeatCount="indefinite" path="${d}"/></circle>` : ''}`;
    }).join('');
    const dots = graph.nodes.map(n => `<g class="lane-${n.lane % 6} ${n.role}">${n.tip && !reduced ? `<circle class="pulse" cx="${x(n.lane)}" cy="${y(n.row)}" r="5"/>` : ''}<circle class="dot" cx="${x(n.lane)}" cy="${y(n.row)}" r="${n.tip ? 4.5 : 3.5}"/>${n.role === 'merge' ? `<circle class="merge-ring" cx="${x(n.lane)}" cy="${y(n.row)}" r="7"/>` : ''}</g>`).join('');
    const rows = graph.nodes.map(n => {
        const clickable = n.role === 'commit' || n.role === 'merge';
        const content = `<span class="commit-subject" title="${esc(n.title)}">${esc(n.title)}</span>${n.badges.map(b => `<span class="branch-tag" title="${esc(b)}">${esc(clipChars(b, 32))}</span>`).join('')}<span class="commit-meta"><code>${esc(n.hash)}</code>${n.author ? `<span>${esc(clipChars(n.author, 18))}</span>` : ''}${n.authorDate ? `<time datetime="${esc(n.authorDate)}" title="${esc(n.authorDate)}">${relativeTime(n.authorDate)}</time>` : ''}</span>`;
        const attrs = `class="commit-row lane-${n.lane % 6} ${n.role} ${selected === n.id ? 'selected' : ''}" style="grid-row:${n.row + 1}"`;
        return clickable ? `<button type="button" ${attrs} data-action="inspect-commit" data-hash="${esc(n.id)}" aria-label="查看提交 ${esc(n.hash)} ${esc(n.title)}">${content}</button>` : `<div ${attrs}>${content}</div>`;
    }).join('');
    return `<div class="commit-tree" style="--rail-width:${railWidth}px;--tree-height:${height}px" role="group" aria-label="提交与分支图，点击提交查看变更"><svg class="tree-rail" width="${railWidth}" height="${height}" viewBox="0 0 ${railWidth} ${height}" aria-hidden="true">${paths}${dots}</svg><div class="commit-list">${rows}</div></div>`;
}
export function icon(name: 'branch' | 'file' | 'arrow' | 'check' | 'expand' | 'refresh' | 'commit' | 'warning' | 'close' | 'chevron'): string {
    const paths = {
        warning: '<path d="m10 3 8 14H2zM10 8v4m0 2v.1"/>',
        close: '<path d="m5 5 10 10M15 5 5 15"/>',
        chevron: '<path d="m6 8 4 4 4-4"/>',
        branch: '<circle cx="5" cy="4" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="5" cy="16" r="2"/><path d="M5 6v8m10-6c0 6-10 2-10 6"/>',
        file: '<path d="M11 2H4v16h12V7zM11 2v5h5M7 11h6m-6 3h4"/>',
        arrow: '<path d="M4 10h12m-5-5 5 5-5 5"/>',
        check: '<path d="m4 10 4 4 8-8"/>',
        expand: '<path d="M12 3h5v5m0-5-7 7M8 17H3v-5m0 5 7-7"/>',
        refresh: '<path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4"/>',
        commit: '<circle cx="10" cy="10" r="4"/><path d="M2 10h4m8 0h4"/>'
    };
    return `<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
function title(label: string, heading: string, body = ''): string {
    return `<div class="section-heading"><div><div class="eyebrow">${label}</div><h2>${heading}</h2>${body ? `<p class="description">${body}</p>` : ''}</div></div>`;
}
function progress(label: string): string { return `<div class="progress" role="progressbar" aria-label="${label}"><span></span></div>`; }
function codeLines(text: string, start = 1): string {
    return `<div class="code-lines">${text.split('\n').map((line, i) => `<div class="code-row"><span class="line-number">${start + i}</span><code>${esc(line) || ' '}</code></div>`).join('')}</div>`;
}
function strategies(demo: boolean): string {
    return `<div class="resolution-bar"><span>解决方式</span><div class="strategies">${Object.entries(strategyNames).map(([key, name], i) => button(demo ? 'demo-resolve' : 'resolve', `${name}<kbd>${i + 1}</kbd>`, key === 'ai' ? 'primary strategy' : 'secondary strategy', `data-strategy="${key}"`)).join('')}</div></div><p class="micro">${demo ? '演示：AI 草拟使用预设结果。' : '先打开完整差异预览；确认后备份、写回并暂存。AI 草拟使用本地规则，请检查结果。'}</p>`;
}
export function renderConflict(file: ConflictFile, demo: boolean): string {
    return `<div class="code-surface"><div class="file-heading">${icon('file')}<code>${esc(file.path)}</code><span class="badge warning">${esc(file.status)}</span></div>${file.note ? `<p class="notice">${esc(file.note)}</p>` : ''}${file.truncated ? '<p class="notice">每侧显示前 80 行，解决操作会处理完整文件。</p>' : ''}${file.hunks.map((h, i) => `<div class="hunk"><div class="hunk-label">冲突块 ${i + 1}<span>从第 ${h.start + 1} 行开始</span></div><div class="diff-pair"><section class="diff-side current"><div class="diff-label"><span class="dot-key"></span>当前分支 <code>${esc(h.currentLabel)}</code></div>${codeLines(h.current)}</section><section class="diff-side incoming"><div class="diff-label"><span class="dot-key"></span>传入分支 <code>${esc(h.incomingLabel)}</code></div>${codeLines(h.incoming)}</section></div></div>`).join('')}</div>${file.hunks.length ? strategies(demo) : ''}`;
}
export function renderWorkingTree(snapshot: Snapshot, disabled: boolean): string {
    const files = snapshot.workingTreeFiles;
    if (!files) return snapshot.workingTreeCount
        ? `<div class="notice">未暂存更改列表尚未加载。${button('refresh', '刷新', 'text-button')}</div>` : '';
    const untracked = files.filter(file => file.untracked).length;
    return `<div class="working-changes"><header><h3>未暂存更改 <span class="badge">${files.length}</span></h3><span class="micro">${untracked ? `${untracked} 个新文件` : '相对暂存区'}</span></header>${files.length
        ? `<ul class="working-list">${files.map(file => `<li>${button('open-working-change', `${icon('file')}<code>${esc(file.path)}</code>`, 'working-file text-button', `data-path="${esc(file.path)}" title="${file.untracked ? '打开新文件' : '查看未暂存差异'}" ${disabled ? 'disabled' : ''}`)}<span class="badge">${esc(file.status)}</span>${button('stage-working-change', '暂存', 'secondary small', `data-path="${esc(file.path)}" title="暂存该文件的完整工作区版本" ${disabled ? 'disabled' : ''}`)}</li>`).join('')}</ul>`
        : '<p class="micro">没有未暂存更改。</p>'}</div>`;
}
export function checks(strategy?: Strategy): string {
    return `<div class="checks">${demoCheck(strategy).map(c => `<div class="${c.ok ? 'ok' : 'failed'}"><span>${c.ok ? icon('check') : '!'}</span>${esc(c.label)}</div>`).join('')}</div>`;
}
export function renderDemoStage(state: DemoState): string {
    switch (state.phase) {
        case 'idle': return title('合并分支', '将结算功能合入 main', '两个分支修改了同一段结算逻辑。开始合并，查看冲突并审查结果。')
            + `<div class="merge-comparison"><div><span class="micro">传入分支</span><strong>${icon('branch')}feature/checkout-flow</strong><p>新增可选折扣</p></div><span class="route-arrow">${icon('arrow')}</span><div><span class="micro">当前分支</span><strong>${icon('branch')}main</strong><p>修复 8% 税率</p></div></div><div class="action-row">${button('demo-start', `开始合并 ${icon('arrow')}`, 'primary')}<span class="micro">演示环境 · 不修改本地文件</span></div><div class="context-note"><span>这个工作台可以做什么</span><p>选择分支 → 查看冲突 → 解决并暂存 → 审查 diff → 确认提交</p></div>`;
        case 'merging': return title('合并分支', '正在比较两条分支', 'feature/checkout-flow → main') + progress('正在合并') + '<p class="activity">检查 src/checkout.ts 的合并结果…</p>';
        case 'conflict': return title('需要解决', '1 个文件存在冲突', '保留税率、折扣，或组合两边的修改。') + renderConflict({ path: 'src/checkout.ts', status: '双方修改', hunks: parseConflict(DEMO_CONFLICT) }, true) + button('copy', '复制冲突到聊天', 'text-button');
        case 'resolving': return title('解决冲突', '正在生成合并结果', `已选择「${strategyNames[state.strategy!]}」`) + progress('正在解决') + `<div class="code-surface">${codeLines(demoResolved(state.strategy))}</div>`;
        case 'checking': return title('检查结果', '检查两边的修改是否保留', '以下是演示检查，并未运行项目测试。') + progress('正在检查') + checks(state.strategy);
        case 'reviewing': return title('审查与提交', '合并结果已暂存') + button('review-staged', '审查暂存改动', 'primary');
        case 'committing': return title('提交中', '正在创建演示提交') + progress('创建提交');
        case 'merged': return `<div class="success-heading">${icon('check')}</div>` + title('合并完成', '提交已创建', 'feature/checkout-flow 已合入 main。') + `<div class="commit-receipt">${icon('commit')}<code>e7b21aa</code><span>Merge feature/checkout-flow</span><span class="badge">演示</span></div>` + checks(state.strategy) + `<div class="actions">${button('demo-replay', '重新演示', 'secondary')}${button('inspect-commit', '查看提交 diff', 'primary', 'data-hash="e7b21aa"')}${button('create-pr', '创建 PR', 'text-button')}</div>`;
    }
}
export function livePhase(snapshot: Snapshot | null, state: LiveState): string {
    if (!snapshot) return 'empty';
    if (['error', 'merging', 'resolving', 'committed'].includes(state.kind)) return state.kind;
    if (state.kind === 'abort-confirm') return 'confirm';
    if (snapshot.conflicts.length) return 'conflict';
    if (state.kind === 'confirm') return 'confirm';
    return snapshot.mergeHead ? 'ready' : 'idle';
}
export function renderLiveStage(snapshot: Snapshot | null, state: LiveState, selectedPath?: string): string {
    if (!snapshot) return title('仓库', '打开一个 Git 仓库', '在编辑器中打开本地仓库，或先通过演示体验工作流。') + button('run-demo', '运行演示', 'primary');
    const s = snapshot;
    if (state.kind === 'error') return title('操作未完成', '需要处理一个问题', esc(state.text)) + `<div class="actions">${button('live-back', '返回工作流', 'primary')}${button('open-scm', '打开 Source Control', 'secondary')}</div>`;
    if (state.kind === 'committed') return `<div class="success-heading">${icon('check')}</div>` + title('提交完成', '改动已提交到本地', '可以继续查看提交，或返回工作区。') + `<div class="commit-receipt">${icon('commit')}<code>${esc(state.hash?.slice(0, 7) || 'HEAD')}</code><span>${esc(s.headName)}</span><span class="badge">本地提交</span></div><div class="actions">${state.hash ? button('inspect-commit', '查看提交 diff', 'primary', `data-hash="${esc(state.hash)}"`) : ''}${button('live-back', '返回工作流', 'secondary')}</div>`;
    if (state.kind === 'merging') return title('处理中', 'Git 正在合并', `${esc(state.ref)} → ${esc(s.headName)}`) + progress('正在合并');
    if (state.kind === 'resolving') return title('解决冲突', '处理冲突', esc(state.path)) + progress('等待编辑器处理或确认');
    if (state.kind === 'abort-confirm') return title('中止合并', '确认中止这次合并？', 'Git 将尝试恢复合并前的状态，本次冲突解决结果可能被丢弃。') + `<div class="actions">${button('abort-go', '确认中止', 'danger')}${button('live-back', '返回', 'secondary')}</div>`;
    const rebaseNote = s.rebasing ? '<p class="notice">当前在 rebase 中。继续或中止变基请使用 Source Control。</p>' : '';
    if (s.conflicts.length) {
        const file = s.conflicts.find(f => f.path === selectedPath) || s.conflicts[0];
        return rebaseNote + title('需要解决', `${s.conflicts.length} 个文件存在冲突`, '解决后可以在本工作台审查暂存改动并提交。')
            + `<div class="file-tabs">${s.conflicts.map(f => button('select-conflict', `${icon('file')}${esc(f.path)}`, f.path === file.path ? 'active' : '', `data-path="${esc(f.path)}"`)).join('')}</div>`
            + renderConflict(file, false) + `<div class="actions">${button('open-conflict-diff', '查看官方差异', 'secondary')}${!file.nativeOnly ? button('open-merge-editor', '打开官方合并编辑器', 'secondary') + button('stage', '暂存当前文件', 'secondary') : ''}${button('native-stage-conflicts', '官方暂存冲突（全部）', 'secondary')}${button('copy', '复制冲突到聊天', 'text-button')}${s.mergeHead && !s.rebasing ? button('abort-ask', '中止合并', 'text-button danger-text', s.canAbort ? '' : 'disabled title="请运行 git merge --abort"') : ''}</div>`;
    }
    if (state.kind === 'confirm') return title('合并分支', '确认合并到当前分支', `<code>${esc(state.ref)}</code> → <code>${esc(s.headName)}</code>。无冲突时 Git 可能直接快进或创建合并提交。`)
        + (s.workingTreeCount || s.stagedCount ? '<p class="notice">仓库中有未提交改动，请确认后继续。</p>' : '') + `<div class="actions">${button('merge-go', '确认合并', 'primary')}${button('live-back', '返回', 'secondary')}</div>`;
    if (s.mergeHead) return title('准备提交', '冲突已解决', '审查暂存区中的完整变更，编辑提交说明并确认提交。') + `<div class="staged-summary">${icon('check')}<strong>${s.stagedCount} 个已暂存文件</strong><span>${esc(s.headName)}</span></div><div class="actions">${button('review-staged', `审查并提交 ${icon('arrow')}`, 'primary')}${button('open-scm', '在 Source Control 查看', 'secondary')}${button('abort-ask', '中止合并', 'text-button danger-text', s.canAbort ? '' : 'disabled')}</div>`;
    const branches = s.branches.filter(b => b !== s.headName);
    return rebaseNote + title('工作区', '选择下一步操作', `<code>${esc(s.headName)}</code> · ${s.workingTreeCount} 项未暂存 · ${s.stagedCount} 项已暂存`)
        + (s.stagedCount ? `<div class="staged-summary">${icon('commit')}<strong>${s.stagedCount} 个文件等待提交</strong>${button('review-staged', '审查并提交', 'primary')}</div>` : '')
        + `<h3>本地分支</h3>${!s.canMerge ? '<p class="notice">当前 Git API 不支持发起合并，请在终端执行 git merge &lt;分支&gt;。</p>' : ''}<div class="branch-list">${branches.map(ref => `<div class="branch-row"><span>${icon('branch')}<code>${esc(ref)}</code></span>${button('merge-ask', `合并 ${icon('arrow')}`, 'secondary small', `data-ref="${esc(ref)}" ${!s.canMerge || s.rebasing ? 'disabled' : ''}`)}</div>`).join('') || '<p class="micro">当前没有其他本地分支。</p>'}</div><div class="actions">${button('review-staged', '查看暂存区', 'secondary')}${button('open-scm', '打开 Source Control', 'text-button')}</div>`;
}
export function renderPatch(patch: string): string {
    let oldLine = 0, newLine = 0, inHunk = false;
    if (!patch) return '<div class="diff-empty">没有可显示的文本差异</div>';
    return `<div class="patch" role="region" aria-label="代码差异" tabindex="0">${patch.split('\n').map(line => {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; return `<div class="patch-line range"><span></span><span></span><code>${esc(line)}</code></div>`; }
        if (!inHunk || line.startsWith('diff --git') || line.startsWith('\\')) {
            if (line.startsWith('diff --git')) inHunk = false;
            return `<div class="patch-line metadata"><span></span><span></span><code>${esc(line) || ' '}</code></div>`;
        }
        let left: number | string = '', right: number | string = '', cls = '';
        if (line.startsWith('+')) { right = newLine++; cls = 'addition'; }
        else if (line.startsWith('-')) { left = oldLine++; cls = 'deletion'; }
        else if (line.startsWith(' ')) { left = oldLine++; right = newLine++; }
        return `<div class="patch-line ${cls}"><span class="line-number">${left}</span><span class="line-number">${right}</span><code>${esc(line) || ' '}</code></div>`;
    }).join('')}</div>`;
}
function diffStats(patch: string): string {
    const lines = patch.split('\n');
    return `<span class="diff-stats"><b>+${lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length}</b><em>−${lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length}</em></span>`;
}
function fileList(files: { path: string; status: string }[], selected: string | undefined, action: string, disabled = false): string {
    return `<aside class="file-list" aria-label="变更文件"><div class="file-list-title">文件 <span>${files.length}</span></div>${files.map(f => button(action, `${icon('file')}<span class="file-name">${esc(f.path)}</span><span class="file-status">${esc(f.status)}</span>`, `file-item ${selected === f.path ? 'active' : ''}`, `data-path="${esc(f.path)}" aria-pressed="${selected === f.path}" ${disabled ? 'disabled' : ''}`)).join('') || '<p class="micro">没有已暂存文件</p>'}</aside>`;
}
export function renderCommitDetail(detail?: CommitDetail, loading = false, error?: string): string {
    const back = button('close-detail', '← 返回工作流', 'text-button');
    if (error) return back + title('提交详情', '无法读取提交', esc(error));
    if (!detail) return back + title('提交详情', '读取提交…') + progress('读取提交');
    return back + title(`COMMIT / ${esc(detail.hash.slice(0, 7))}`, esc(detail.message.split('\n')[0]), `${esc(detail.author || '')}${detail.date ? ' · ' + esc(new Date(detail.date).toLocaleString()) : ''}`)
        + (detail.note ? `<p class="micro">${esc(detail.note)}</p>` : '')
        + `<div class="review-grid">${fileList(detail.files, detail.path, 'history-file', loading)}<section class="diff-view"><div class="file-heading">${icon('file')}<code>${esc(detail.path || '提交内容')}</code>${diffStats(detail.patch || '')}</div>${loading ? progress('读取 diff') : ''}${detail.truncated ? '<p class="notice">文件差异已截断。</p>' : ''}${renderPatch(detail.patch || '')}</section></div>`;
}
export interface ReviewState {
    data?: StagedReview;
    loading: boolean;
    error?: string;
    draft: string;
    dirty: boolean;
    committing: boolean;
}
export function renderReview(state: ReviewState, demo: boolean, strategy?: Strategy): string {
    const r = state.data;
    if (!r) return title('审查与提交', state.error ? '无法读取暂存区' : '读取暂存改动…', esc(state.error || '')) + (state.error ? button('review-staged', '重新加载', 'secondary') : progress('读取暂存区'));
    const disabled = state.loading || state.committing;
    const canCommit = !disabled && !state.error && !r.blocked && !!state.draft.trim();
    return title('审查与提交', `${r.merge ? '审查合并结果' : '审查暂存改动'}`, `${r.files.length} 个文件将提交到 <code>${esc(r.headName)}</code>${demo ? ' · 演示环境' : ''}`)
        + (demo ? `<div class="demo-checks">${checks(strategy)}<p class="micro">预设检查 · 非真实测试${demoCheck(strategy).some(c => !c.ok) ? ' · 当前策略有问题，请检查后决定是否继续演示。' : ''}</p></div>` : '')
        + (state.error ? `<div class="notice error" role="alert">${esc(state.error)} ${button('review-staged', '重新加载审查', 'secondary small')}</div>` : '')
        + (r.blocked ? `<p class="notice">${esc(r.blocked)}</p>` : '')
        + `<div class="review-grid">${fileList(r.files, r.path, 'review-file', disabled)}<section class="diff-view"><div class="file-heading">${icon('file')}<code>${esc(r.path || (r.merge ? '无文件差异的合并提交' : '暂存区为空'))}</code>${diffStats(r.patch)}${button('review-staged', icon('refresh'), 'icon-button', `aria-label="重新加载审查" ${disabled ? 'disabled' : ''}`)}</div>${state.loading ? progress('读取 diff') : ''}${r.truncated ? '<p class="notice">超过显示上限，diff 已截断。提交仍包含完整暂存内容。</p>' : ''}${renderPatch(r.patch)}</section></div>`
        + (demo ? '' : '<p class="notice">提交会遵循编辑器的分支保护、诊断、签名和保存设置。若在官方提示中选择保存并提交，将按你的选择更新暂存内容；取消后请重新加载审查。不会执行提交后的推送或同步。</p>')
        + `<section class="commit-composer" aria-label="提交说明"><div class="composer-heading"><label for="commit-message">提交说明</label><span>${demo ? '模拟提交' : '本地提交'}</span></div><textarea id="commit-message" data-action="commit-message" rows="3" maxlength="20000" placeholder="简要说明这次改动的目的…" ${state.committing ? 'disabled' : ''}>${esc(state.draft)}</textarea><div class="commit-bottom"><div><strong>${r.files.length} 个文件 · ${esc(r.headName)}</strong><p>${r.unstagedCount ? `${r.unstagedCount} 项未暂存改动不会包含在此次提交中。` : '仅提交当前暂存区。'}${demo ? ' 不修改本地仓库。' : ''}</p></div>${button('commit-staged', `${state.committing ? '正在提交…' : demo ? '确认演示提交' : '确认提交'} ${icon('commit')}`, 'primary commit-button', canCommit ? '' : 'disabled')}</div></section>`;
}
