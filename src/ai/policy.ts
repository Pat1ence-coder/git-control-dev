import type { Snapshot } from '../shared/protocol';
import type { AiContext, AiProposal } from '../shared/ai';
import { isSafeRef } from '../git/safeRef';

export class AiPolicyError extends Error { constructor(message: string) { super(message); this.name = 'AiPolicyError'; } }

export function buildAiContext(snapshot: Snapshot): AiContext {
    const current = snapshot.branchList?.find(b => b.local && b.current);
    return {
        repoName: snapshot.repoName,
        headName: snapshot.headName,
        headHash: snapshot.headHash,
        ahead: current?.ahead,
        behind: current?.behind,
        stagedCount: snapshot.stagedCount,
        workingTreeCount: snapshot.workingTreeCount,
        conflicts: snapshot.conflicts.length,
        mergeHead: snapshot.mergeHead,
        rebasing: snapshot.rebasing,
        hasUpstream: !!snapshot.nativeGit?.hasUpstream,
        branches: (snapshot.branchList || []).filter(b => b.local).map(b => b.name).slice(0, 40)
    };
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Validate model output against the current snapshot and derive the command ourselves. */
export function validateProposal(proposal: AiProposal, snapshot: Snapshot, context: AiContext): AiProposal {
    if (snapshot.preview) throw new AiPolicyError('预览模式下不能生成写操作。');
    if (proposal.action === 'none') return { ...proposal, command: undefined };
    if (snapshot.rebasing) throw new AiPolicyError('变基进行中，AI 不会生成提交或合并提案。');
    if (proposal.action === 'commit') {
        if (!snapshot.stagedCount) throw new AiPolicyError('暂存区为空，不能生成提交提案。');
        if (snapshot.conflicts.length || snapshot.mergeHead) throw new AiPolicyError('存在未完成的合并或冲突，不能直接生成提交提案。');
        const message = proposal.commit?.message?.trim();
        if (!message) throw new AiPolicyError('提交提案缺少提交说明。');
        return { ...proposal, commit: { message }, command: `git commit -m ${quote(message)}` };
    }
    if (proposal.action === 'fetch') return { ...proposal, fetch: { remote: 'origin' }, command: 'git fetch origin' };
    if (proposal.action === 'push') {
        if (snapshot.conflicts.length || snapshot.mergeHead) throw new AiPolicyError('存在未完成的合并或冲突，不能生成 Push 提案。');
        if (!snapshot.nativeGit?.hasUpstream || !isSafeRef(context.headName)) throw new AiPolicyError('当前分支没有可用的 upstream，不能用 Push 提案。');
        if (proposal.push?.branch && proposal.push.branch !== context.headName)
            throw new AiPolicyError('Push 目标必须是当前分支。');
        return { ...proposal, push: { remote: 'origin', branch: context.headName }, command: `git push origin HEAD:refs/heads/${context.headName}` };
    }
    if (proposal.action === 'merge') {
        const source = proposal.merge?.source;
        if (!source || !isSafeRef(source) || source === context.headName || !context.branches.includes(source))
            throw new AiPolicyError('合并来源必须是当前仓库的另一个本地分支。');
        if (snapshot.conflicts.length || snapshot.mergeHead) throw new AiPolicyError('已有未完成的合并或冲突，不能生成新的合并提案。');
        return { ...proposal, merge: { source }, command: `git merge --no-ff ${source}` };
    }
    throw new AiPolicyError('DeepSeek 返回了不支持的操作。');
}
