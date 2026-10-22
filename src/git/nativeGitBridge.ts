import * as vscode from 'vscode';
import path from 'node:path';
import type { NativeGitAction } from '../shared/protocol';
import { nativeGitLabels } from '../shared/protocol';
import type { WriteGuard } from './types';
import { describeGitError, UserFacingError } from './errors';

// SCM CommandCenter.createCommand resolves its first argument as a repository URI.
// Keep these separate: Push must never silently become Sync or force push.
// See README and THIRD_PARTY_NOTICES for the pinned upstream reference.
const commands: Record<NativeGitAction, string> = {
    push: 'git.push', pull: 'git.pull', fetch: 'git.fetch', sync: 'git.sync', publish: 'git.publish'
};
export interface NativeGitResult {
    kind: 'returned' | 'cancelled' | 'unavailable' | 'error';
    text: string;
}

export async function runNativeGit(action: NativeGitAction, guard: WriteGuard): Promise<NativeGitResult> {
    if (!Object.prototype.hasOwnProperty.call(commands, action)) throw new UserFacingError('不支持此 Git 操作。');
    await guard.check();
    const command = commands[action], label = nativeGitLabels[action];
    if (!(await vscode.commands.getCommands(true)).includes(command))
        return { kind: 'unavailable', text: `当前编辑器未提供 ${label}，请打开 Source Control 完成操作。` };
    await guard.check();
    const { repo } = guard;
    const head = repo.state.HEAD;
    if (action !== 'fetch' && (!head?.name || !head.commit || head.type !== 0))
        throw new UserFacingError('请先检出已有提交的本地分支，再执行此操作。');
    const cleanLabel = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
    const branch = cleanLabel(head?.name || 'HEAD');
    const next = `继续 ${label}`;
    // This confirmation binds our custom UI to one repository. Subsequent SCM
    // prompts (publish, rebase, authentication, etc.) remain owned by the host.
    const choice = await vscode.window.showWarningMessage(
        `在仓库 ${cleanLabel(path.basename(repo.rootUri.fsPath))}（${branch}）执行 ${label}？将使用编辑器原生 Git 流程和当前 Git 配置。${action === 'sync' ? 'Sync 会拉取并推送。' : ''}`,
        { modal: true, detail: repo.rootUri.fsPath.replace(/\r/g, '\\r').replace(/\n/g, '\\n') }, next);
    if (choice !== next) return { kind: 'cancelled', text: `已取消 ${label}，尚未启动原生操作。` };
    // Registry lookup and confirmation are asynchronous. The repository must
    // still exist exactly: do not allow the native command to guess another one.
    await guard.check();
    guard.assertCurrent();
    let failure: unknown;
    let failed = false;
    try { await vscode.commands.executeCommand(command, repo.rootUri); }
    catch (error) { failed = true; failure = error; }
    let refreshed = true;
    try { await repo.status(); } catch { refreshed = false; }
    if (failed) return {
        kind: 'error', text: `${label} 未能确认完成，可能已有部分变化。${describeGitError(failure)} 请核对 Source Control。`
    };
    // Native commands can resolve after cancellation or handling a Git error.
    // There is no public, authoritative per-command success result to infer here.
    return { kind: 'returned', text: refreshed
        ? `原生 ${label} 流程已返回，请核对最新仓库状态及编辑器提示。`
        : `原生 ${label} 流程已返回，但仓库状态刷新失败。请在 Source Control 核对结果后再操作。` };
}
