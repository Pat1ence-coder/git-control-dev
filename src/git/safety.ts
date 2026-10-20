import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Read-only previews and durable originals. Never restore over a working file automatically. */
export class ResolutionSafety implements vscode.Disposable {
    private readonly previews = new Map<string, string>();
    private readonly registration: vscode.Disposable;
    constructor(private readonly storage: vscode.Uri) {
        this.registration = vscode.workspace.registerTextDocumentContentProvider('generative-git-preview', {
            provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? ''
        });
    }
    private preview(text: string, name: string): vscode.Uri {
        const uri = vscode.Uri.parse(`generative-git-preview:/${randomUUID()}/${encodeURIComponent(name)}`);
        this.previews.set(uri.toString(), text);
        return uri;
    }
    async confirm(original: string, proposed: string, relative: string): Promise<boolean> {
        const before = this.preview(original, `原内容-${path.basename(relative)}`);
        const after = this.preview(proposed, path.basename(relative));
        await vscode.commands.executeCommand('vscode.diff', before, after, `${relative} · 冲突解决预览`, { preview: true });
        // Non-modal so the user can inspect the diff before choosing.
        const apply = '应用并暂存';
        return await vscode.window.showInformationMessage(
            `请检查 ${relative} 的完整差异。应用前会在本机保存完整原文备份，可能含敏感信息；可用“清理冲突修改备份”命令删除。AI 草拟只是本地启发式结果。`,
            apply, '取消'
        ) === apply;
    }
    async backup(uri: vscode.Uri, original: string): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.storage);
        const name = `${Date.now()}-${randomUUID()}.json`;
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.storage, name),
            new TextEncoder().encode(JSON.stringify({ file: uri.fsPath, created: new Date().toISOString(), original })));
    }
    async openBackup(): Promise<void> {
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(this.storage); }
        catch (error) {
            if (!['ENOENT', 'FileNotFound'].includes((error as { code?: string }).code || '')) throw error;
            await vscode.window.showInformationMessage('还没有冲突修改备份。');
            return;
        }
        const items: { label: string; description: string; file: string; original: string }[] = [];
        for (const [name] of entries.filter(([name]) => /^\d+-[\da-f-]+\.json$/.test(name)).sort().reverse()) {
            const data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.storage, name))).toString('utf8'));
            if (typeof data.file === 'string' && typeof data.original === 'string' && typeof data.created === 'string')
                items.push({ label: data.file, description: data.created, file: data.file, original: data.original });
        }
        const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择写入前备份；可复制原内容恢复，不会自动覆盖当前文件' });
        if (picked) await vscode.window.showTextDocument(this.preview(picked.original, path.basename(picked.file)));
    }
    async clearBackups(): Promise<void> {
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(this.storage); }
        catch (error) {
            if (!['ENOENT', 'FileNotFound'].includes((error as { code?: string }).code || '')) throw error;
            await vscode.window.showInformationMessage('没有需要清理的冲突备份。');
            return;
        }
        const files = entries.filter(([name, type]) => /^\d+-[\da-f-]+\.json$/.test(name) && type === vscode.FileType.File);
        if (!files.length) {
            await vscode.window.showInformationMessage('没有需要清理的冲突备份。');
            return;
        }
        const remove = '删除这些备份';
        if (await vscode.window.showWarningMessage(`将永久删除本扩展保存的 ${files.length} 份冲突原文备份，删除后无法通过本扩展找回。不会修改仓库文件。`, { modal: true }, remove) !== remove) return;
        let removed = 0;
        for (const [name] of files) {
            const uri = vscode.Uri.joinPath(this.storage, name);
            if ((await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File) {
                await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
                removed++;
            }
        }
        this.previews.clear();
        await vscode.window.showInformationMessage(`已删除 ${removed} 份所选冲突备份。已打开的原文预览标签页请自行关闭；其他位置的副本不受影响。`);
    }
    dispose(): void { this.registration.dispose(); this.previews.clear(); }
}
