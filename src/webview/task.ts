import type { ConflictFile, Snapshot } from '../shared/protocol';
import { esc, clipChars } from '../shared/html';
import { button, icon, type LiveState } from './render';

export interface TaskView {
    phase: string;
    snapshot: Snapshot | null;
    live: LiveState;
    detailOpen: boolean;
    reviewOpen: boolean;
    conflictsOpen: boolean;
    peekOpen: boolean;
    branchPickerOpen: boolean;
    busy: boolean;
}
export function taskConflicts(view: Pick<TaskView, 'snapshot'>): ConflictFile[] {
    return view.snapshot?.conflicts || [];
}
function excerpt(file: ConflictFile): string {
    if (!file.hunks.length) return `<div class="peek-file"><strong>${esc(file.path)}</strong><p>${esc(file.note || file.status)}</p></div>`;
    return file.hunks.slice(0, 3).map(h => {
        const a = h.current.split('\n'), b = h.incoming.split('\n');
        const firstDifference = Math.max(0, a.findIndex((line, i) => line !== b[i]));
        const author = (name: string | undefined, label: string, fallback: string) =>
            `<span title="${esc(name ? `${label} · 文件最近提交作者：${name}（非逐行归因）` : label)}">${esc(clipChars(name || label || fallback, 18))}</span>`;
        return `<div class="peek-file"><div><strong>${esc(file.path)}</strong><span>冲突块起始行 ${h.start + 1}</span></div><div class="peek-line current">${author(h.currentAuthor, h.currentLabel, '当前')}<code>${esc(clipChars(a[firstDifference] || '（空）', 150))}</code></div><div class="peek-line incoming">${author(h.incomingAuthor, h.incomingLabel, '传入')}<code>${esc(clipChars(b[firstDifference] || '（空）', 150))}</code></div></div>`;
    }).join('');
}
function conflictControl(view: TaskView, files: ConflictFile[]): string {
    const count = files.reduce((n, f) => n + Math.max(1, f.hunks.length), 0);
    return `<div class="conflict-peek">${button('peek-conflicts', `${icon('warning')}<span>${count} 处冲突</span><span class="subtle">· ${files.length} 个文件</span>`, 'conflict-trigger', `aria-expanded="${view.peekOpen}" aria-controls="conflict-popover"`)}${view.peekOpen ? `<section id="conflict-popover" class="conflict-popover" aria-label="冲突摘要"><div class="popover-heading"><strong>双方修改了相同的代码</strong>${button('close-peek', icon('close'), 'icon-button', 'aria-label="关闭冲突摘要"')}</div>${files.slice(0, 3).map(excerpt).join('')}<div class="popover-footer"><span>这里只展示冲突片段</span>${button('show-conflicts', '查看完整冲突', 'text-button')}</div></section>` : ''}</div>`;
}
/** Footer = status + one actions group. The main button keeps data-key="main-action" in
 *  every phase so morph turns it busy in place instead of swapping it out. */
function foot(status: string, actions: string): string {
    return `${status}<div class="footer-actions">${actions}</div>`;
}
const main = (action: string, label: string, cls: string, attrs = '') => button(action, label, cls, `data-key="main-action" ${attrs}`);
const running: Record<string, [string, string]> = {
    loading: ['正在连接 Git', '连接中'], merging: ['正在比较分支变更', '合并中'],
    resolving: ['请完成编辑器中的确认', '处理中'], committing: ['正在创建提交', '提交中']
};
export function renderTaskControls(view: TaskView, footText?: string): string {
    const { phase, snapshot: s } = view;
    const disabled = view.busy ? 'disabled' : '';
    const line = (text: string, lead = '', tone = '') => `<span class="task-status-line${tone ? ' ' + tone : ''}">${lead}${text}</span>`;
    if (view.detailOpen) return foot(line('正在查看提交详情', icon('commit')), button('close-detail', '返回任务', 'text-button'));
    if (view.reviewOpen) {
        if (phase === 'committing') return foot(line('正在提交已审查的改动', '<i class="spinner"></i>'), main('busy', '<i class="spinner"></i>提交中', 'primary is-busy', 'disabled aria-busy="true"'));
        return foot(line('审查暂存内容，再确认提交', icon('commit')), button('collapse-task', '收起审查', 'text-button', disabled));
    }
    if (phase === 'conflict') return conflictControl(view, taskConflicts(view)) + `<div class="footer-actions">${view.conflictsOpen
        ? button('collapse-task', '收起详情', 'text-button')
        : main('show-conflicts', '解决冲突', 'conflict-primary')}</div>`;
    const busyLabel = running[phase];
    if (busyLabel) return foot(line(esc(view.live.kind === 'resolving' ? `正在处理 ${view.live.path}` : busyLabel[0]), '<i class="spinner"></i>'),
        main('busy', `<i class="spinner"></i>${busyLabel[1]}`, 'primary is-busy', 'disabled aria-busy="true"'));
    if (phase === 'committed') return foot(line('改动已提交到本地', icon('check'), 'success'), button('live-back', '返回工作区', 'text-button') + main('inspect-commit', '查看提交', 'primary', `data-hash="${esc(view.live.kind === 'committed' ? view.live.hash || s?.headHash || '' : '')}"`));
    if (phase === 'error') return foot(line('操作没有完成', icon('warning'), 'warning'), button('live-back', '返回任务', 'secondary'));
    if (phase === 'confirm') return foot(line('请确认下面的操作', icon('branch')), button('live-back', '取消', 'text-button'));
    if (phase === 'empty') return foot(line('尚未打开本地仓库'), main('open-scm', '打开 Source Control', 'primary'));
    if (['ready', 'reviewing'].includes(phase) || !!s?.stagedCount) return foot(line(`${s?.stagedCount || 0} 个文件等待审查`, icon('commit')), main('review-staged', '审查并提交', 'primary'));
    return foot(line(esc(footText || (s?.workingTreeCount ? `${s.workingTreeCount} 项未暂存改动` : '工作区干净')), icon('check')), main('review-staged', '查看暂存区', 'text-button'));
}
