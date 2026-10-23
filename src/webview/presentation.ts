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
function remoteNarrative(s: Snapshot, pr: PullRequestInfo): string {
    const state = { open: '已打开', closed: '已关闭', merged: '已合并' }[pr.state];
    const head = `PR #${pr.number} ${state}（${pr.headRef} → ${pr.baseRef}）。`;
    if (s.conflicts.length) {
        const names = s.conflicts.slice(0, 2).map(f => f.path).join('、');
        return `${head}当前有 ${s.conflicts.length} 个文件存在冲突${names ? `：${names}` : ''}；先处理冲突，再继续提交或推送。`;
    }
    if (pr.state === 'merged') return `${head}本地分支可以继续整理或删除，不会自动操作。`;
    if (pr.state === 'closed') return `${head}如需继续，请先回到对应分支或重新打开 PR。`;
    if (pr.checksUnavailable) return `${head}检查状态暂不可用；请到 GitHub 查看后再决定下一步。`;
    if (pr.checksPartial) return `${head}只读取到 ${pr.checks.length} 项检查，结果可能不完整。`;
    if (!pr.checks.length) return `${head}暂无可用的检查结果${s.workingTreeCount ? `；本地还有 ${s.workingTreeCount} 个未暂存文件。` : '。'}`;
    const passed = pr.checks.filter(c => c.status === 'completed' && c.conclusion === 'success').length;
    const failed = pr.checks.filter(c => c.status === 'completed' && c.conclusion && c.conclusion !== 'success' && !['neutral', 'skipped'].includes(c.conclusion)).length;
    const running = pr.checks.filter(c => c.status !== 'completed').length;
    const checks = `检查：${passed} 通过${failed ? `、${failed} 失败` : ''}${running ? `、${running} 进行中` : ''}。`;
    const local = pr.headSha !== s.headHash ? `PR HEAD ${pr.headSha.slice(0, 7)} 与本地 HEAD 不同。` : '';
    const work = s.workingTreeCount ? `本地还有 ${s.workingTreeCount} 个未暂存文件。` : '';
    return `${head}${checks}${local}${work}`;
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
            p.narrative = remoteNarrative(s, pr);
        }
    }
    if (s.conflicts.length) p.chips.push({ label: `${s.conflicts.length} 冲突文件`, tone: 'conflict' });
    const changes = [
        s.workingTreeCount ? `${s.workingTreeCount} 未暂存` : '',
        s.stagedCount ? `${s.stagedCount} 已暂存` : ''
    ].filter(Boolean).join(' · ');
    if (changes) p.chips.push({ label: changes, tone: s.workingTreeCount ? 'pending' : 'staged' });
    if (s.preview) p.chips.push({ label: '只读', tone: 'neutral' });
    return p;
}
