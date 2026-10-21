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
export function taskTitle(view: TaskView): string {
    if (!view.snapshot) return view.phase === 'loading' ? '正在连接 Git' : '打开一个 Git 仓库';
    const head = view.snapshot.headName;
    const incoming = view.live.kind === 'confirm' || view.live.kind === 'merging' ? view.live.ref : view.snapshot?.mergingRef;
    return incoming ? `将 ${incoming} 合入 ${head}` : `${head} 的仓库改动`;
}
export function taskStatus(phase: string): { label: string; tone: string } {
    if (phase === 'empty') return { label: '未打开仓库', tone: 'neutral' };
    if (phase === 'committed') return { label: '已提交', tone: 'success' };
    if (phase === 'conflict') return { label: '存在冲突', tone: 'warning' };
    if (['reviewing', 'ready'].includes(phase)) return { label: '等待审查', tone: 'ready' };
    if (phase === 'error') return { label: '需要处理', tone: 'warning' };
    if (['merging', 'resolving', 'committing', 'loading'].includes(phase)) return { label: '进行中', tone: 'running' };
    return { label: '准备就绪', tone: 'neutral' };
}
function excerpt(file: ConflictFile): string {
    if (!file.hunks.length) return `<div class="peek-file"><strong>${esc(file.path)}</strong><p>${esc(file.note || file.status)}</p></div>`;
    return file.hunks.slice(0, 3).map(h => {
        const a = h.current.split('\n'), b = h.incoming.split('\n');
        const firstDifference = Math.max(0, a.findIndex((line, i) => line !== b[i]));
        return `<div class="peek-file"><div><strong>${esc(file.path)}</strong><span>冲突块起始行 ${h.start + 1}</span></div><div class="peek-line current"><span>当前</span><code>${esc(clipChars(a[firstDifference] || '（空）', 150))}</code></div><div class="peek-line incoming"><span>传入</span><code>${esc(clipChars(b[firstDifference] || '（空）', 150))}</code></div></div>`;
    }).join('');
}
function conflictControl(view: TaskView, files: ConflictFile[]): string {
    const count = files.reduce((n, f) => n + Math.max(1, f.hunks.length), 0);
    return `<div class="conflict-peek">${button('peek-conflicts', `${icon('warning')}<span>${count} 处冲突</span><span class="subtle">· ${files.length} 个文件</span>`, 'conflict-trigger', `aria-expanded="${view.peekOpen}" aria-controls="conflict-popover"`)}${view.peekOpen ? `<section id="conflict-popover" class="conflict-popover" aria-label="冲突摘要"><div class="popover-heading"><strong>双方修改了相同的代码</strong>${button('close-peek', icon('close'), 'icon-button', 'aria-label="关闭冲突摘要"')}</div>${files.slice(0, 3).map(excerpt).join('')}<div class="popover-footer"><span>这里只展示冲突片段</span>${button('show-conflicts', '查看完整冲突', 'text-button')}</div></section>` : ''}</div>`;
}
export function renderTaskControls(view: TaskView): string {
    const { phase, snapshot: s } = view;
    const disabled = view.busy ? 'disabled' : '';
    if (view.detailOpen) return `<span class="task-status-line">${icon('commit')}正在查看提交详情</span>${button('close-detail', '返回任务', 'text-button')}`;
    if (view.reviewOpen) return `<span class="task-status-line">${icon('commit')}${phase === 'committing' ? '正在提交已审查的改动' : '审查暂存内容，再确认提交'}</span>${button('collapse-task', '收起审查', 'text-button', disabled)}`;
    if (phase === 'conflict') return conflictControl(view, taskConflicts(view)) + (view.conflictsOpen
        ? button('collapse-task', '收起详情', 'text-button')
        : button('show-conflicts', '解决冲突', 'conflict-primary'));
    const running: Record<string, string> = { loading: '正在连接 Git', merging: '正在比较分支变更', resolving: '请完成编辑器中的冲突确认', committing: '正在创建提交' };
    if (running[phase]) return `<span class="task-status-line"><i class="spinner"></i>${running[phase]}</span>`;
    if (phase === 'committed') return `<span class="task-status-line success">${icon('check')}改动已提交到本地</span><div class="footer-actions">${button('live-back', '返回工作区', 'text-button')}${button('inspect-commit', '查看提交', 'primary', `data-hash="${esc(view.live.kind === 'committed' ? view.live.hash || s?.headHash || '' : '')}"`)}</div>`;
    if (phase === 'error') return `<span class="task-status-line warning">${icon('warning')}操作没有完成</span>${button('live-back', '返回任务', 'secondary')}`;
    if (phase === 'confirm') return `<span class="task-status-line">${icon('branch')}请确认下面的操作</span>${button('live-back', '取消', 'text-button')}`;
    if (phase === 'empty') return `<span class="task-status-line">尚未打开本地仓库</span>${button('open-scm', '打开 Source Control', 'primary')}`;
    if (['ready', 'reviewing'].includes(phase) || !!s?.stagedCount) return `<span class="task-status-line">${icon('commit')}${s?.stagedCount || 0} 个文件等待审查</span><div class="footer-actions">${button('review-staged', '审查并提交', 'primary')}</div>`;
    return `<span class="task-status-line">${icon('check')}${s?.workingTreeCount ? `${s.workingTreeCount} 项未暂存改动` : '工作区干净'}</span><div class="footer-actions">${button('review-staged', '查看暂存区', 'text-button')}</div>`;
}
export function taskExplanation(view: TaskView): string {
    if (view.phase === 'conflict') {
        const paths = taskConflicts(view).slice(0, 3).map(f => `<code>${esc(f.path)}</code>`).join('、');
        return `两条分支在 ${paths} 中存在冲突。点击冲突数量查看摘要，再展开代码选择解决方式。`;
    }
    if (['reviewing', 'ready'].includes(view.phase)) return '改动已经暂存。可以逐个文件检查 diff、编辑提交说明，然后在这里确认提交。';
    if (view.phase === 'committed') return '本地提交已完成。可以点击提交查看详情，本次操作没有执行推送。';
    if (!view.snapshot) return '打开一个本地 Git 仓库后，这里会显示提交历史、未暂存更改和合并操作。';
    if (!view.snapshot.canMerge)
        return '点击提交查看历史；分支仍可只读预览。当前宿主缺少合并 API，请在终端执行 git merge 后回到这里处理冲突。';
    return '点击提交查看历史，或打开分支预览提交图、发起合并。真实操作前会要求确认。';
}
