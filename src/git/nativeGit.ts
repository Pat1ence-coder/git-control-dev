import { UserFacingError } from './errors';
import * as vscode from 'vscode';
import type { Repository } from './types';

/** Use the installed Git command layer, including contributed branch protection.
 * API v1's repository.commit bypasses smartCommit's diagnostics, save prompt and
 * signing/sign-off settings. git.commit(rootUri, null) runs those checks while
 * explicitly suppressing post-commit commands. See THIRD_PARTY_NOTICES.md.
 */
export async function nativeCommit(repo: Repository, message: string, beforeExecute?: () => Promise<void>): Promise<string> {
    await requireNativeCommand('git.commit');
    if (typeof repo.onDidCommit !== 'function')
        throw new UserFacingError('当前宿主缺少 Git 提交事件，无法确认提交结果。请升级编辑器。');
    await beforeExecute?.();
    const before = repo.state.HEAD?.commit;
    const previousMessage = repo.inputBox.value;
    let commitEvent = false;
    const subscription = repo.onDidCommit(() => { commitEvent = true; });
    repo.inputBox.value = message;
    try {
        await vscode.commands.executeCommand('git.commit', repo.rootUri, null);
        await repo.status();
        const after = repo.state.HEAD?.commit;
        // Official commands can swallow errors after displaying their own dialog.
        // Their promise resolving alone does not establish a successful commit.
        if (!commitEvent || !after || after === before)
            throw new UserFacingError('官方提交流程未产生可确认的新提交，可能已取消或被检查阻止。请查看编辑器提示，重新加载审查后重试。');
        const commit = await repo.getCommit(after);
        if (before && !commit.parents.includes(before))
            throw new UserFacingError('提交期间 HEAD 发生了其他变化，请检查提交历史；未将本次操作标记为成功。');
        return after;
    } finally {
        subscription.dispose();
        if (repo.inputBox.value === message) repo.inputBox.value = previousMessage;
    }
}

export async function requireNativeCommand(command: string): Promise<void> {
    if (!(await vscode.commands.getCommands(true)).includes(command))
        throw new UserFacingError(`当前宿主未提供 ${command}，请升级编辑器后重试。`);
}
