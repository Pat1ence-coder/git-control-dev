import { UserFacingError } from './errors';
import * as vscode from 'vscode';
import type { Repository } from './types';

const COMMIT_VERIFY_TIMEOUT = 2000;
const COMMIT_VERIFY_INTERVAL = 100;

async function waitForNewHead(repo: Repository, before: string | undefined): Promise<string | undefined> {
    const deadline = Date.now() + COMMIT_VERIFY_TIMEOUT;
    do {
        await repo.status().catch(() => { });
        const after = repo.state.HEAD?.commit;
        if (after && after !== before) return after;
        if (Date.now() >= deadline) return undefined;
        await new Promise<void>(resolve => setTimeout(resolve, COMMIT_VERIFY_INTERVAL));
    } while (true);
}

/** Use the installed Git command layer, including contributed branch protection.
 * API v1's repository.commit bypasses smartCommit's diagnostics, save prompt and
 * signing/sign-off settings. git.commit(rootUri, null) runs those checks while
 * explicitly suppressing post-commit commands. See THIRD_PARTY_NOTICES.md.
 */
export async function nativeCommit(repo: Repository, message: string, beforeExecute?: () => Promise<void>): Promise<string> {
    await requireNativeCommand('git.commit');
    await beforeExecute?.();
    const before = repo.state.HEAD?.commit;
    const previousMessage = repo.inputBox.value;
    repo.inputBox.value = message;
    try {
        await vscode.commands.executeCommand('git.commit', repo.rootUri, null);
        // Do not rely on onDidCommit: some supported hosts (notably VS Code 1.85)
        // do not expose it. Wait for the actual HEAD to move instead.
        const after = await waitForNewHead(repo, before);
        if (!after)
            throw new UserFacingError('提交未完成：编辑器没有产生新提交，可能已取消或被检查阻止。审查内容已保留，可以直接重试。');
        const commit = await repo.getCommit(after);
        if (before && !commit.parents.includes(before))
            throw new UserFacingError('提交期间 HEAD 发生了其他变化，请检查提交历史；未将本次操作标记为成功。');
        return after;
    } finally {
        if (repo.inputBox.value === message) repo.inputBox.value = previousMessage;
    }
}

export async function requireNativeCommand(command: string): Promise<void> {
    if (!(await vscode.commands.getCommands(true)).includes(command))
        throw new UserFacingError(`当前宿主未提供 ${command}，请升级编辑器后重试。`);
}
