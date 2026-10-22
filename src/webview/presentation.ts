import type { PullRequestInfo, Snapshot } from '../shared/protocol';
import type { LiveState } from './render';

type Tone = 'neutral' | 'ready' | 'warning' | 'success' | 'running' | 'open' | 'closed' | 'merged';
export interface TaskPresentation {
    title: string;
    status: { label: string; tone: Tone };
    narrative: string;
    footText: string;
    chips: { label: string; tone: 'pending' | 'staged' | 'conflict' | 'neutral' }[];
}
export function presentTask(input: { phase: string; snapshot: Snapshot | null; live: LiveState; pullRequest?: PullRequestInfo }): TaskPresentation {
    const { snapshot: s, live, phase } = input;
    const view = (title: string, label: string, tone: Tone, narrative: string, footText = label): TaskPresentation =>
        ({ title, status: { label, tone }, narrative, footText, chips: [] });
    if (!s) return phase === 'loading'
        ? view('正在连接 Git', '连接中', 'running', '正在读取本地仓库状态。')
        : view('打开一个 Git 仓库', '未打开仓库', 'neutral', '打开本地仓库后，可在这里查看历史、处理改动和审查提交。');
    let p: TaskPresentation;
    if (live.kind === 'error' || phase === 'error')
        p = view('操作未完成', '需要处理', 'warning', '操作没有完成。查看提示，返回工作流后可以重试。');
    else if (phase === 'committing')
        p = view('正在创建提交', '提交中', 'running', '请完成编辑器的原生检查、签名和保存提示。');
    else if (live.kind === 'merging')
        p = view('Git 正在合并', '合并中', 'running', '合并完成后会刷新提交图和文件状态。');
    else if (live.kind === 'resolving')
        p = view('正在处理文件', '处理中', 'running', `正在处理 ${live.path}，请完成编辑器中的确认。`);
    else if (live.kind === 'confirm')
        p = view(`将 ${live.ref} 合入 ${s.headName}`, '等待确认', 'ready', '确认后开始合并；无冲突时可能直接快进。', '请确认下面的操作');
    else if (live.kind === 'abort-confirm')
        p = view('确认中止合并', '等待确认', 'warning', '中止会丢弃本次冲突解决结果。检查后再确认。');
    else if (phase === 'committed')
        p = view('提交完成', '已提交', 'success', '本地提交已完成；本次操作没有执行推送。', '改动已提交到本地');
    else if (s.preview)
        p = view(`预览 ${s.preview.name}`, '只读预览', 'ready', `只读预览 ${s.preview.name} 的历史，不会切换 HEAD 或修改工作区。`);
    else if (phase === 'reviewing')
        p = view(`审查 ${s.stagedCount} 个已暂存文件`, '等待审查', 'ready', '逐文件检查实际暂存差异，再确认提交。不会自动推送。');
    else if (s.conflicts.length)
        p = view(`解决 ${s.conflicts.length} 个文件的冲突`, '存在冲突', 'warning',
            `${s.conflicts.slice(0, 3).map(f => f.path).join('、')}${s.conflicts.length > 3 ? ' 等文件' : ''} 存在冲突。先查看摘要，再展开完整代码选择解决方式。`, `${s.conflicts.length} 个文件存在冲突`);
    else if (s.mergeHead || s.stagedCount)
        p = view(s.mergeHead ? '冲突已解决，准备提交' : `提交 ${s.stagedCount} 个已暂存文件`, '等待审查', 'ready',
            `${s.stagedCount} 个文件已暂存。提交前会走编辑器的原生检查、签名和保存提示；不会自动推送。`, `${s.stagedCount} 个文件等待审查`);
    else if (s.workingTreeCount)
        p = view(`${s.workingTreeCount} 项改动等待处理`, '有未暂存改动', 'neutral',
            `${s.workingTreeCount} 个文件未暂存。打开差异检查，暂存后再进入提交审查。`, `${s.workingTreeCount} 项未暂存改动`);
    else p = view(s.graph.nodes.find(n => n.tip)?.title || s.graph.nodes[0]?.title || `${s.headName} 工作区干净`,
        '工作区干净', 'success', `${s.headName} 工作区干净；可以查看提交历史或预览分支。不会自动拉取或推送。`);

    const pr = s.preview ? undefined : input.pullRequest;
    if (pr) {
        p.chips.push({ label: `#${pr.number}`, tone: 'neutral' });
        if (live.kind === 'overview' && !['reviewing', 'committing', 'error'].includes(phase)) {
            p.title = `${pr.title} #${pr.number}`;
            p.status = { label: { open: 'Open', closed: 'Closed', merged: 'Merged' }[pr.state], tone: pr.state };
        }
    }
    if (s.conflicts.length) p.chips.push({ label: `${s.conflicts.length} 冲突文件`, tone: 'conflict' });
    if (s.workingTreeCount) p.chips.push({ label: `${s.workingTreeCount} 未暂存`, tone: 'pending' });
    if (s.stagedCount) p.chips.push({ label: `${s.stagedCount} 已暂存`, tone: 'staged' });
    if (s.preview) p.chips.push({ label: '只读', tone: 'neutral' });
    return p;
}
