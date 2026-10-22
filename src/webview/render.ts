import { esc, clipChars } from '../shared/html';
import type { GraphModel } from '../shared/model';
import type { ConflictFile, CommitDetail, Snapshot, Strategy, StagedReview, BranchInfo } from '../shared/protocol';
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
export function renderGraph(graph: GraphModel, reduced: boolean, selected?: string): string {
    if (!graph.nodes.length) return '<div class="graph-empty">打开仓库后，这里会显示提交历史。</div>';
    const rowH = 30, laneW = 18, left = 14;
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
        return `<path class="edge lane-${lane % 6} ${style}" d="${d}"/>`;
    }).join('');
    const dots = graph.nodes.map(n => `<g class="lane-${n.lane % 6} ${n.role}">${n.tip && !reduced ? `<circle class="pulse" cx="${x(n.lane)}" cy="${y(n.row)}" r="5"/>` : ''}<circle class="dot" cx="${x(n.lane)}" cy="${y(n.row)}" r="${n.tip ? 4.5 : 3.5}"/>${n.role === 'merge' ? `<circle class="merge-ring" cx="${x(n.lane)}" cy="${y(n.row)}" r="7"/>` : ''}</g>`).join('');
    const rows = graph.nodes.map(n => {
        const clickable = n.role === 'commit' || n.role === 'merge';
        const content = `<span class="commit-subject" title="${esc(n.title)}">${esc(n.title)}</span>${n.badges.map(b => `<span class="branch-tag" title="${esc(b)}">${esc(clipChars(b, 32))}</span>`).join('')}<span class="commit-meta"><code>${esc(n.hash)}</code>${n.author ? `<span>${esc(clipChars(n.author, 18))}</span>` : ''}${n.authorDate ? `<time datetime="${esc(n.authorDate)}" title="${esc(n.authorDate)}">${relativeTime(n.authorDate)}</time>` : ''}</span>`;
        const attrs = `class="commit-row lane-${n.lane % 6} ${n.role} ${selected === n.id ? 'selected' : ''}" style="grid-row:${n.row + 1};--row:${n.row}"`;
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
export function renderLoadingGraph(): string {
    const row = (width: string) => `<div class="skeleton-row"><i></i><span class="skeleton-line ${width}"></span><em></em></div>`;
    return `<div class="graph-skeleton" role="status" aria-label="正在读取仓库">${row('w58')}${row('w44')}${row('w66')}${row('w38')}<div class="skeleton-status">正在读取本地仓库…</div></div>`;
}
function title(label: string, heading: string, body = ''): string {
    return `<div class="section-heading"><div><div class="eyebrow">${label}</div><h2>${heading}</h2>${body ? `<p class="description">${body}</p>` : ''}</div></div>`;
}
function progress(label: string): string { return `<div class="progress" role="progressbar" aria-label="${label}"><span></span></div>`; }
function codeLines(text: string, start = 1, cls = ''): string {
    return `<div class="code-lines${cls ? ' ' + cls : ''}">${text.split('\n').map((line, i) => `<div class="code-row"><span class="line-number">${start + i}</span><code>${esc(line) || ' '}</code></div>`).join('')}</div>`;
}
function contextLines(lines: string[] | undefined, start: number | undefined, cls: string): string {
    return lines?.length ? codeLines(lines.join('\n'), start ?? 1, `hunk-context ${cls}`) : '';
}
function strategies(): string {
    return `<div class="resolution-bar"><span>解决方式</span><div class="strategies">${Object.entries(strategyNames).map(([key, name], i) => button('resolve', `${name}<kbd>${i + 1}</kbd>`, key === 'ai' ? 'primary strategy' : 'secondary strategy', `data-strategy="${key}"`)).join('')}</div></div><p class="micro">解决方式作用于整个文件。先打开完整差异预览；确认后备份、写回并暂存。AI 草拟使用本地规则，请检查结果。</p>`;
}
function conflictLines(text: string, start: number, tone: 'remove' | 'add'): string {
    return `<div class="conflict-lines ${tone}">${text.split('\n').map((line, i) => `<div class="conflict-row"><span class="conflict-mark" aria-hidden="true">${tone === 'remove' ? '−' : '+'}</span><span class="line-number">${start + i}</span><code>${esc(line) || ' '}</code></div>`).join('')}</div>`;
}
export function renderConflict(file: ConflictFile): string {
    return `<div class="code-surface"><div class="file-heading">${icon('file')}<code>${esc(file.path)}</code><span class="badge warning">${esc(file.status)}</span></div>${file.note ? `<p class="notice">${esc(file.note)}</p>` : ''}${file.truncated ? '<p class="notice">每侧显示前 80 行，解决操作会处理完整文件。</p>' : ''}${file.hunks.map((h, i) => `<div class="hunk"><div class="hunk-label">冲突块 ${i + 1}<span>从第 ${h.start + 1} 行开始</span></div>${contextLines(h.before, h.beforeStart, 'before')}<div class="conflict-block"><section class="conflict-side current"><div class="conflict-label"><span class="dot-key"></span>当前分支 <code>${esc(h.currentLabel)}</code></div>${conflictLines(h.current, h.currentStart ?? h.start + 2, 'remove')}</section><section class="conflict-side incoming"><div class="conflict-label"><span class="dot-key"></span>传入分支 <code>${esc(h.incomingLabel)}</code></div>${conflictLines(h.incoming, h.incomingStart ?? h.start + 2, 'add')}</section></div>${contextLines(h.after, h.afterStart, 'after')}</div>`).join('')}</div>${file.hunks.length ? strategies() : ''}`;
}
function splitWorkingPath(value: string): [string, string] {
    const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    return index < 0 ? ['', value] : [value.slice(0, index + 1), value.slice(index + 1)];
}
function workingMark(status: string): [string, string] {
    if (/新增|未跟踪|添加/.test(status)) return ['A', 'added'];
    if (/删除/.test(status)) return ['D', 'deleted'];
    if (/重命名/.test(status)) return ['R', 'renamed'];
    if (/复制/.test(status)) return ['C', 'copied'];
    if (/修改|类型/.test(status)) return ['M', 'modified'];
    return ['·', 'unknown'];
}
export function renderWorkingTree(snapshot: Snapshot, disabled: boolean): string {
    const files = snapshot.workingTreeFiles;
    if (!files) return snapshot.workingTreeCount
        ? `<div class="notice">未暂存更改列表尚未加载。${button('refresh', '刷新', 'text-button')}</div>` : '';
    return `<div class="working-changes"><header><h3>未暂存更改<span class="working-count">${files.length}</span></h3></header>${files.length
        ? `<ul class="working-list">${files.map(file => {
            const [directory, name] = splitWorkingPath(file.path);
            const [mark, tone] = workingMark(file.status);
            const openLabel = file.untracked ? `打开 ${esc(file.path)} 的新文件` : `查看 ${esc(file.path)} 的未暂存差异`;
            return `<li><span class="file-mark ${tone}" aria-hidden="true" title="${esc(file.status)}">${mark}</span>${button('open-working-change', `<span class="working-path"><span class="path-dir">${esc(directory)}</span><span class="path-base">${esc(name)}</span></span>`, 'working-file', `data-path="${esc(file.path)}" title="${esc(file.path)}" aria-label="${openLabel}，状态：${esc(file.status)}" ${disabled ? 'disabled' : ''}`)}${button('stage-working-change', '暂存', 'working-stage', `data-path="${esc(file.path)}" title="暂存该文件" aria-label="暂存 ${esc(file.path)}" ${disabled ? 'disabled' : ''}`)}</li>`;
        }).join('')}</ul>`
        : `<p class="working-empty">${icon('check')}工作区干净</p>`}</div>`;
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
    if (!snapshot) return title('仓库', '打开一个 Git 仓库', '在编辑器中打开本地仓库后，这里会显示提交历史。') + `<div class="actions">${button('open-scm', '打开 Source Control', 'primary')}${button('refresh', '刷新', 'secondary')}</div>`;
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
            + renderConflict(file) + `<div class="actions">${button('open-conflict-diff', '查看官方差异', 'secondary')}${!file.nativeOnly ? button('open-merge-editor', '打开官方合并编辑器', 'secondary') + button('stage', '暂存当前文件', 'secondary') : ''}${button('native-stage-conflicts', '官方暂存冲突（全部）', 'secondary')}${button('copy', '复制冲突到聊天', 'text-button')}${s.mergeHead && !s.rebasing ? button('abort-ask', '中止合并', 'text-button danger-text', s.canAbort ? '' : 'disabled title="请运行 git merge --abort"') : ''}</div>`;
    }
    if (state.kind === 'confirm') return title('合并分支', '确认合并到当前分支', `<code>${esc(state.ref)}</code> → <code>${esc(s.headName)}</code>。无冲突时 Git 可能直接快进或创建合并提交。`)
        + (s.workingTreeCount || s.stagedCount ? '<p class="notice">仓库中有未提交改动，请确认后继续。</p>' : '') + `<div class="actions">${button('merge-go', '确认合并', 'primary')}${button('live-back', '返回', 'secondary')}</div>`;
    if (s.mergeHead) return title('准备提交', '冲突已解决', '审查暂存区中的完整变更，编辑提交说明并确认提交。') + `<div class="staged-summary">${icon('check')}<strong>${s.stagedCount} 个已暂存文件</strong><span>${esc(s.headName)}</span></div><div class="actions">${button('review-staged', `审查并提交 ${icon('arrow')}`, 'primary')}${button('open-scm', '在 Source Control 查看', 'secondary')}${button('abort-ask', '中止合并', 'text-button danger-text', s.canAbort ? '' : 'disabled')}</div>`;
    return rebaseNote + title('工作区', '选择下一步操作', `<code>${esc(s.headName)}</code> · ${s.workingTreeCount} 项未暂存 · ${s.stagedCount} 项已暂存`)
        + (s.stagedCount ? `<div class="staged-summary">${icon('commit')}<strong>${s.stagedCount} 个文件等待提交</strong>${button('review-staged', '审查并提交', 'primary')}</div>` : '')
        + `<div class="actions">${button('review-staged', '查看暂存区', 'secondary')}${button('open-scm', '打开 Source Control', 'text-button')}</div>`;
}
export function renderBranchPopover(s: Snapshot): string {
    const fallbackBranches: BranchInfo[] = s.branches.map(name => ({ name, ref: `refs/heads/${name}`, local: true, current: name === s.headName }));
    const branchList: BranchInfo[] = s.branchList?.length
        ? s.branchList
        : [{ name: s.headName, ref: `refs/heads/${s.headName}`, local: true, current: true }, ...fallbackBranches.filter(branch => !branch.current)];
    const preview = s.preview;
    const branchRow = (branch: BranchInfo): string => {
        const indicators = `${branch.current ? '<span class="branch-current">当前</span>' : ''}${branch.ahead ? `<span class="branch-ab" title="领先上游 ${branch.ahead}">↑${branch.ahead}</span>` : ''}${branch.behind ? `<span class="branch-ab" title="落后上游 ${branch.behind}">↓${branch.behind}</span>` : ''}`;
        const previewing = preview?.ref === branch.ref;
        const previewButton = branch.current
            ? button('preview-current', preview ? '返回当前' : '查看', 'text-button')
            : button('preview-branch', previewing ? '预览中' : '预览', 'text-button', `data-ref="${esc(branch.ref)}"${previewing ? ' aria-current="true"' : ''}`);
        const mergeButton = !branch.current && branch.local && s.canMerge && !s.rebasing
            ? button('merge-ask', '合并', 'secondary small', `data-ref="${esc(branch.name)}"`)
            : '';
        return `<div class="branch-row${branch.current ? ' current' : ''}${previewing ? ' previewing' : ''}"><span class="branch-name">${icon('branch')}<code>${esc(branch.name)}</code>${indicators}</span><span class="branch-actions">${previewButton}${mergeButton}</span></div>`;
    };
    const localBranches = branchList.filter(branch => branch.local);
    const remoteBranches = branchList.filter(branch => !branch.local);
    return `<div class="branch-popover" role="dialog" aria-label="分支浏览"><div class="branch-popover-head"><div><h3>分支</h3><p class="micro">只读预览，不会切换 HEAD</p></div><button class="icon-button" type="button" data-action="close-branch" aria-label="关闭" title="关闭">${icon('close')}</button></div>${!s.canMerge ? '<p class="notice">当前 Git API 不支持发起合并；仍可预览分支。</p>' : ''}<div class="branch-popover-body">${localBranches.length ? `<span class="branch-group">本地</span><div class="branch-list">${localBranches.map(branchRow).join('')}</div>` : ''}${remoteBranches.length ? `<span class="branch-group">远端</span><div class="branch-list">${remoteBranches.map(branchRow).join('')}</div>` : ''}${!branchList.length ? '<p class="micro">还没有分支。</p>' : ''}</div><p class="micro branch-popover-foot">本地分支的合并沿用原有确认流程。</p></div>`;
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
export function renderReview(state: ReviewState): string {
    const r = state.data;
    if (!r) return title('审查与提交', state.error ? '无法读取暂存区' : '读取暂存改动…', esc(state.error || '')) + (state.error ? button('review-staged', '重新加载', 'secondary') : progress('读取暂存区'));
    const disabled = state.loading || state.committing;
    const canCommit = !disabled && !state.error && !r.blocked && !!state.draft.trim();
    return title('审查与提交', `${r.merge ? '审查合并结果' : '审查暂存改动'}`, `${r.files.length} 个文件将提交到 <code>${esc(r.headName)}</code>`)
        + (state.error ? `<div class="notice error" role="alert">${esc(state.error)} ${button('review-staged', '重新加载审查', 'secondary small')}</div>` : '')
        + (r.blocked ? `<p class="notice">${esc(r.blocked)}</p>` : '')
        + `<div class="review-grid">${fileList(r.files, r.path, 'review-file', disabled)}<section class="diff-view"><div class="file-heading">${icon('file')}<code>${esc(r.path || (r.merge ? '无文件差异的合并提交' : '暂存区为空'))}</code>${diffStats(r.patch)}${button('review-staged', icon('refresh'), 'icon-button', `aria-label="重新加载审查" ${disabled ? 'disabled' : ''}`)}</div>${state.loading ? progress('读取 diff') : ''}${r.truncated ? '<p class="notice">超过显示上限，diff 已截断。提交仍包含完整暂存内容。</p>' : ''}${renderPatch(r.patch)}</section></div>`
        + '<p class="notice">提交会遵循编辑器的分支保护、诊断、签名和保存设置。若在官方提示中选择保存并提交，将按你的选择更新暂存内容；取消后请重新加载审查。不会执行提交后的推送或同步。</p>'
        + `<section class="commit-composer" aria-label="提交说明"><div class="composer-heading"><label for="commit-message">提交说明</label><span>本地提交</span></div><textarea id="commit-message" data-action="commit-message" rows="3" maxlength="20000" placeholder="简要说明这次改动的目的…" ${state.committing ? 'disabled' : ''}>${esc(state.draft)}</textarea><div class="commit-bottom"><div><strong>${r.files.length} 个文件 · ${esc(r.headName)}</strong><p>${r.unstagedCount ? `${r.unstagedCount} 项未暂存改动不会包含在此次提交中。` : '仅提交当前暂存区。'}</p></div>${button('commit-staged', `${state.committing ? '正在提交…' : '确认提交'} ${icon('commit')}`, 'primary commit-button', canCommit ? '' : 'disabled')}</div></section>`;
}
