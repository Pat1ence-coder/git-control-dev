import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { GenerativeGitViewProvider } from './webview/provider';
import { GenerativeGitLauncher } from './webview/launcher';
import { ResolutionSafety } from './git/safety';
import { describeGitError, UserFacingError } from './git/errors';
import { AiService } from './ai/service';
export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Generative Git');
    const safety = new ResolutionSafety(vscode.Uri.joinPath(context.globalStorageUri, 'conflict-backups'));
    const git = new GitService(context.workspaceState, output, safety);
    const operation = { busy: false };
    const ai = new AiService(context.secrets, output);
    const workbench = new GenerativeGitViewProvider(context, git, operation, ai);
    const sidebar = new GenerativeGitLauncher(context.extensionUri, git, operation, () => workbench.openWorkbench());
    const safeCommand = (action: () => Promise<void>) => async () => {
        try { await action(); }
        catch (error) { await vscode.window.showErrorMessage(describeGitError(error)); }
    };
    context.subscriptions.push(output, safety, git, sidebar, workbench,
        vscode.commands.registerCommand('generativeGit.openBackup', safeCommand(() => safety.openBackup())),
        vscode.commands.registerCommand('generativeGit.clearBackups', safeCommand(async () => {
            if (operation.busy) throw new UserFacingError('请先完成当前 Git 操作，再清理冲突备份。');
            operation.busy = true;
            try { await safety.clearBackups(); } finally { operation.busy = false; }
        })),
        vscode.window.registerWebviewViewProvider('generativeGit.main', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('generativeGit.open', () => workbench.openWorkbench()),
        vscode.commands.registerCommand('generativeGit.refresh', safeCommand(() => workbench.refresh())),
        vscode.commands.registerCommand('generativeGit.setDeepSeekKey', safeCommand(async () => {
            const value = await vscode.window.showInputBox({
                title: 'DeepSeek API Key',
                prompt: '只保存在 VS Code SecretStorage，不会写入设置或 webview。',
                password: true,
                ignoreFocusOut: true
            });
            if (!value?.trim()) return;
            await ai.setKey(value.trim());
            await workbench.refreshAiConfig();
            await vscode.window.showInformationMessage('DeepSeek API Key 已保存。');
        })),
        vscode.commands.registerCommand('generativeGit.clearDeepSeekKey', safeCommand(async () => {
            const choice = await vscode.window.showWarningMessage('清除 DeepSeek API Key？', { modal: true }, '清除');
            if (choice !== '清除') return;
            await ai.clearKey();
            await workbench.refreshAiConfig();
            await vscode.window.showInformationMessage('DeepSeek API Key 已清除。');
        })));
    void git.init();
}
