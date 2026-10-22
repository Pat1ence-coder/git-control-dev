// Minimal host double: production code still calls the real vscode API.
import path from 'node:path';
import * as fs from 'node:fs/promises';
export class Uri {
    constructor(readonly fsPath: string) { }
    get scheme(): string { return this.fsPath.startsWith('generative-git-preview:') ? 'generative-git-preview' : 'file'; }
    toString(): string { return this.fsPath; }
    static parse(p: string): Uri { return new Uri(p); }
    static file(p: string): Uri { return new Uri(path.resolve(p)); }
    static joinPath(uri: Uri, ...parts: string[]): Uri { return Uri.file(path.join(uri.fsPath, ...parts)); }
}
export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
export enum ViewColumn { One = 1 }
export class EventEmitter<T> {
    private callbacks = new Set<(event: T) => unknown>();
    event = (callback: (event: T) => unknown) => { this.callbacks.add(callback); return { dispose: () => this.callbacks.delete(callback) }; };
    fire(event: T): void { this.callbacks.forEach(cb => cb(event)); }
    dispose(): void { this.callbacks.clear(); }
}
export const workspace = {
    isTrusted: true,
    getConfiguration: (_section?: string) => ({ get: <T>(_key: string, fallback: T): T => fallback }),
    workspaceFolders: undefined as {
        uri: Uri;
    }[] | undefined,
    textDocuments: [] as any[],
    registerTextDocumentContentProvider: (_scheme: string, _provider: unknown) => ({ dispose() {} }),
    async openTextDocument(uri: Uri): Promise<any> {
        const existing = this.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (existing) return existing;
        const doc = {
            uri, text: await fs.readFile(uri.fsPath, 'utf8'), isDirty: false,
            getText() { return this.text; },
            positionAt(n: number) { return n; },
            async save() { await fs.writeFile(uri.fsPath, this.text); this.isDirty = false; return true; }
        };
        this.textDocuments.push(doc);
        return doc;
    },
    fs: {
        createDirectory: async (uri: Uri) => { await fs.mkdir(uri.fsPath, { recursive: true }); },
        readDirectory: async (uri: Uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(e => [e.name, e.isDirectory() ? 2 : 1] as [string, number]),
        async stat(uri: Uri) { const st = await fs.lstat(uri.fsPath); return { type: st.isSymbolicLink() ? 64 : st.isDirectory() ? 2 : 1, size: st.size }; },
        readFile: (uri: Uri) => fs.readFile(uri.fsPath),
        writeFile: (uri: Uri, bytes: Uint8Array) => fs.writeFile(uri.fsPath, bytes),
        delete: async (uri: Uri, _options?: unknown) => { await fs.unlink(uri.fsPath); }
    },
    async applyEdit(edit: WorkspaceEdit) {
        for (const change of edit.changes) {
            const doc = this.textDocuments.find(d => d.uri.fsPath === change.uri.fsPath);
            if (!doc) return false;
            doc.text = change.text; doc.isDirty = true;
        }
        return true;
    }
};
export const extensions = { getExtension: (_id: string): any => undefined };
export const window = {
    showTextDocument: async (_uri: Uri) => { },
    showInformationMessage: async (_message: string, ...items: string[]): Promise<string | undefined> => items[0],
    showWarningMessage: async (_message: string, _options: unknown, ...items: string[]): Promise<string | undefined> => items[0],
    showQuickPick: async <T>(items: T[], _options?: unknown): Promise<T | undefined> => items[0]
};
export const commands = {
    getCommands: async (_filterInternal?: boolean) => ['git.commit', 'git.stageAllMerge', 'git.openChange', 'git.openMergeEditor'],
    executeCommand: async (_command: string, ..._args: unknown[]) => { }
};
export const env = { clipboard: { writeText: async (_text: string) => {} }, openExternal: async (_uri: Uri) => true };
export const authentication = {
    getSession: async (_provider: string, _scopes: string[], _options: unknown): Promise<{ accessToken: string } | undefined> => undefined,
    onDidChangeSessions: new EventEmitter<{ provider: { id: string } }>().event
};
export class Range {
    constructor(readonly start: unknown, readonly end: unknown) { }
}
export class WorkspaceEdit {
    readonly changes: { uri: Uri; text: string }[] = [];
    replace(uri: Uri, _range: Range, text: string): void { this.changes.push({ uri, text }); }
}
