import type { Snapshot } from '../shared/protocol';
import type { LiveState } from './render';

export type PresentationTone = 'neutral' | 'ready' | 'warning' | 'success' | 'running';
export type ChipTone = 'pending' | 'staged' | 'conflict' | 'neutral';

export interface TaskChip {
    label: string;
    tone: ChipTone;
}

export interface TaskPresentation {
    title: string;
    status: { label: string; tone: PresentationTone };
    chips: TaskChip[];
    narrative: string;
    /** Short, status-bar-style sentence used by the card footer. */
    footText: string;
}

export interface PresentationInput {
    phase: string;
    snapshot: Snapshot | null;
    live: LiveState;
}

function runningStatus(phase: string): TaskPresentation['status'] | undefined {
    if (phase === 'merging') return { label: '合并中', tone: 'running' };
    if (phase === 'resolving') return { label: '处理中', tone: 'running' };
    if (phase === 'committing') return { label: '提交中', tone: 'running' };
    if (phase === 'loading') return { label: '连接中', tone: 'running' };
    return undefined;
}

function statusFor(input: PresentationInput): TaskPresentation['status'] {
    const { phase, snapshot: s, live } = input;
    if (!s) return { label: phase === 'loading' ? '连接中' : '未打开仓库', tone: phase === 'loading' ? 'running' : 'neutral' };
    if (live.kind === 'error') return { label: '需要处理', tone: 'warning' };
    if (live.kind === 'abort-confirm') return { label: '等待确认', tone: 'warning' };
    if (phase === 'error') return { label: '需要处理', tone: 'warning' };
    if (phase === 'committed') return { label: '已提交', tone: 'success' };
    if (phase === 'conflict' || s.conflicts.length) return { label: '存在冲突', tone: 'warning' };
    const running = runningStatus(phase);
    if (running) return running;
    if (s.preview) return { label: '只读预览', tone: 'ready' };
    if (phase === 'confirm') return { label: '等待确认', tone: 'ready' };
    if (s.stagedCount || s.mergeHead || phase === 'reviewing' || phase === 'ready') return { label: '等待审查', tone: 'ready' };
    if (s.workingTreeCount) return { label: '有未暂存改动', tone: 'neutral' };
    return { label: '工作区干净', tone: 'success' };
}

function latestCommitTitle(s: Snapshot): string | undefined {
    return s.graph.nodes.find(n => n.tip)?.title || s.graph.nodes[0]?.title;
}

function titleFor(input: PresentationInput): string {
    const { phase, snapshot: s, live } = input;
    if (!s) return phase === 'loading' ? '正在连接 Git' : '打开一个 Git 仓库';
    if (live.kind === 'error' || phase === 'error') return '操作未完成';
    if (phase === 'committed') return '提交完成';
    if (live.kind === 'abort-confirm') return '确认中止合并';
    if (live.kind === 'merging') return 'Git 正在合并';
    if (live.kind === 'resolving') return '处理冲突';
    if (live.kind === 'confirm') return `将 ${live.ref} 合入 ${s.headName}`;
    if (s.preview) return `预览 ${s.preview.name}`;
    if (s.conflicts.length) return `解决 ${s.conflicts.length} 个文件的冲突`;
    if (s.mergeHead) return '冲突已解决，准备提交';
    if (phase === 'reviewing') return `审查 ${s.stagedCount} 个已暂存文件`;
    if (s.stagedCount) return `提交 ${s.stagedCount} 个已暂存文件`;
    if (s.workingTreeCount) return `${s.workingTreeCount} 项改动等待处理`;
    return latestCommitTitle(s) || `${s.headName} 工作区干净`;
}

function pathsFor(s: Snapshot): string {
    const paths = s.conflicts.slice(0, 3).map(f => f.path);
    return `${paths.join('、')}${s.conflicts.length > 3 ? ' 等' : ''}`;
}

function narrativeFor(input: PresentationInput): string {
    const { phase, snapshot: s, live } = input;
    if (!s) {
        return phase === 'loading'
            ? '正在读取本地仓库状态。'
            : '打开一个本地 Git 仓库后，这里会显示提交历史、未暂存更改和合并操作。';
    }
    if (live.kind === 'error') return '操作没有完成；返回工作流后可以重试。';
    if (live.kind === 'merging') return 'Git 正在合并，完成后会刷新提交图和暂存状态。';
    if (live.kind === 'resolving') return `正在处理 ${live.path}；保存后暂存。`;
    if (live.kind === 'committed') return '本地提交已完成；本次操作没有执行推送。';
    if (live.kind === 'confirm') return `将 ${live.ref} 合入 ${s.headName}；无冲突时可能直接快进。确认后继续。`;
    if (live.kind === 'abort-confirm') return '中止合并会丢弃本次冲突解决结果，确认后才会执行。';
    if (s.preview) return `只读预览 ${s.preview.name} 的提交图；不会切换 HEAD，也不会修改工作区。`;
    if (s.conflicts.length) {
        const base = s.mergingRef || '当前分支';
        return `${pathsFor(s)} 与 ${base} 存在冲突；先查看摘要，再展开代码选择解决方式。`;
    }
    if (s.mergeHead) return `冲突已解决，${s.stagedCount} 个文件已暂存。提交会走编辑器原生检查、签名和保存提示；不会自动推送。`;
    if (phase === 'reviewing' || s.stagedCount) {
        return `${s.stagedCount} 个文件已暂存。提交前会走编辑器的原生检查、签名和保存提示；本次提交不会自动推送。`;
    }
    if (s.workingTreeCount) return `${s.workingTreeCount} 个文件未暂存；打开 diff 或暂存后进入审查。工作区改动不会自动提交。`;
    return `${s.headName} 工作区干净；可以查看提交历史或打开分支预览。不会自动拉取或推送。`;
}

function chipsFor(s: Snapshot | null): TaskChip[] {
    if (!s) return [];
    const chips: TaskChip[] = [];
    if (s.conflicts.length) chips.push({ label: `${s.conflicts.length} 冲突`, tone: 'conflict' });
    if (s.workingTreeCount) chips.push({ label: `${s.workingTreeCount} 未暂存`, tone: 'pending' });
    if (s.stagedCount) chips.push({ label: `${s.stagedCount} 已暂存`, tone: 'staged' });
    const current = s.branchList?.find(branch => branch.current);
    if (current?.ahead) chips.push({ label: `↑${current.ahead}`, tone: 'neutral' });
    if (current?.behind) chips.push({ label: `↓${current.behind}`, tone: 'neutral' });
    if (s.preview) chips.push({ label: '只读', tone: 'neutral' });
    return chips;
}

function footFor(input: PresentationInput): string {
    const { phase, snapshot: s, live } = input;
    if (!s) return phase === 'loading' ? '正在连接 Git' : '尚未打开本地仓库';
    if (live.kind === 'error') return '操作没有完成';
    if (phase === 'committed') return '改动已提交到本地';
    if (live.kind === 'abort-confirm') return '请确认下面的操作';
    if (live.kind === 'merging') return 'Git 正在合并';
    if (live.kind === 'resolving') return '正在处理冲突';
    if (live.kind === 'confirm') return '请确认下面的操作';
    if (s.preview) return '只读预览，不会切换 HEAD';
    if (s.conflicts.length) return `${s.conflicts.length} 个文件存在冲突`;
    if (s.mergeHead || s.stagedCount || phase === 'reviewing' || phase === 'ready') return `${s.stagedCount} 个文件等待审查`;
    if (s.workingTreeCount) return `${s.workingTreeCount} 项未暂存改动`;
    return '工作区干净';
}

export function presentTask(input: PresentationInput): TaskPresentation {
    return {
        title: titleFor(input),
        status: statusFor(input),
        chips: chipsFor(input.snapshot),
        narrative: narrativeFor(input),
        footText: footFor(input)
    };
}
