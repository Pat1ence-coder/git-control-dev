import { UserFacingError } from '../git/errors';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { GitService, describeGitError } from '../git/gitService';
import { asHostMessage, type ToHost, type ToWebview } from '../shared/protocol';
export class GenerativeGitViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView | vscode.WebviewPanel;
    private panel?: vscode.WebviewPanel;
    private ready = false;
    private queue: Promise<void> = Promise.resolve();
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(private readonly context: vscode.ExtensionContext, private readonly git: GitService, private readonly operation = { busy: false }) {
        this.subscriptions.push(git.onDidChange(() => this.enqueue(() => this.pushSnapshot(false))));
    }
    resolveWebviewView(view: vscode.WebviewView): void {
        this.attach(view);
    }
    openWorkbench(): void {
        if (this.panel) { this.panel.reveal(vscode.ViewColumn.One); return; }
        this.panel = vscode.window.createWebviewPanel('generativeGit.workbench', 'Generative Git', vscode.ViewColumn.One, {
            enableScripts: true, retainContextWhenHidden: true
        });
        this.attach(this.panel);
        this.subscriptions.push(this.panel.onDidDispose(() => { this.panel = undefined; }));
    }
    private attach(view: vscode.WebviewView | vscode.WebviewPanel): void {
        this.view = view;
        this.ready = false;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        view.webview.html = this.html(view.webview);
        this.subscriptions.push(view.webview.onDidReceiveMessage(value => { const message = asHostMessage(value); if (message)
            void this.onMessage(message).catch(e => this.notify(describeGitError(e), 'error')); }), view.onDidDispose(() => { if (this.view === view) {
            this.view = undefined;
            this.ready = false;
        } }));
    }
    private post(message: ToWebview): void { if (this.ready)
        void this.view?.webview.postMessage(message); }
    private notify(text: string, level: 'info' | 'error' = 'info'): void { this.post({ type: 'notice', level, text }); }
    private enqueue(action: () => Promise<void>): Promise<void> { return this.queue = this.queue.then(action).catch(e => { this.notify(describeGitError(e), 'error'); }); }
    private async hydrate(): Promise<void> {
        await this.git.whenReady();
        const snapshot = await this.git.snapshot();
        this.ready = true;
        this.post({ type: 'hydrate', snapshot, notice: this.git.startupProblem });
    }
    private async pushSnapshot(_force: boolean): Promise<void> {
        if (!this.ready) return;
        const snapshot = await this.git.snapshot();
        this.post({ type: 'snapshot', snapshot });
    }
    async refresh(): Promise<void> {
        await this.git.refresh();
        await this.enqueue(() => this.pushSnapshot(true));
    }
    private async withLock(action: () => Promise<void>): Promise<void> {
        if (this.operation.busy) {
            this.post({ type: 'live-result', kind: 'error', text: '上一个 Git 操作还没结束，请稍后重试。' });
            return;
        }
        this.operation.busy = true;
        try {
            await action();
        }
        catch (e) {
            await this.enqueue(() => this.pushSnapshot(true));
            this.post({ type: 'live-result', kind: 'error', text: describeGitError(e) });
        }
        finally {
            this.operation.busy = false;
        }
    }
    private async onMessage(message: ToHost): Promise<void> {
        if (message.type === 'ready') {
            await this.enqueue(() => this.hydrate());
            return;
        }
        if (message.type === 'copy') {
            await vscode.env.clipboard.writeText(message.text);
            this.notify('已复制，可以粘贴到聊天。');
            return;
        }
        if (message.type === 'open-scm') {
            await vscode.commands.executeCommand('workbench.view.scm');
            return;
        }
        if (message.type === 'open-workbench') {
            await vscode.commands.executeCommand('generativeGit.open');
            return;
        }
        if (message.type === 'refresh') {
            await this.refresh();
            return;
        }
        switch (message.type) {
            case 'select-repo':
                if (this.operation.busy)
                    throw new UserFacingError('Git 操作进行中，请稍候再切换仓库。');
                await this.git.select(message.repoId);
                await this.enqueue(() => this.pushSnapshot(true));
                break;
            case 'open-file':
                await this.git.open(message.path);
                break;
            case 'open-working-change':
                await this.git.openWorkingChange(message.path, message.repoId);
                break;
            case 'stage-working-change':
                await this.withLock(async () => {
                    await this.git.stageWorkingChange(message.path, message.repoId);
                    await this.enqueue(() => this.pushSnapshot(true));
                    this.post({ type: 'live-result', kind: 'staged', text: `${message.path} 已暂存。` });
                });
                break;
            case 'open-conflict-diff':
            case 'open-merge-editor':
                await this.git.openConflict(message.path, message.type === 'open-merge-editor');
                break;
            case 'native-stage-conflicts':
                await this.withLock(async () => {
                    const { remaining } = await this.git.stageConflictsNative();
                    await this.enqueue(() => this.pushSnapshot(true));
                    this.post({ type: 'live-result', kind: remaining ? 'conflict' : 'resolved',
                        text: remaining ? `官方流程已返回，仍有 ${remaining} 个冲突；已完成的暂存会保留。` : '官方冲突暂存流程已完成，请审查实际暂存结果。' });
                });
                break;
            case 'suggest-commit':
                await this.git.suggestCommitMessage();
                break;
            case 'inspect-commit': {
                try {
                    const detail = await this.git.inspectCommit(message.hash, message.path);
                    this.post({ type: 'commit-detail', requestId: message.requestId, detail });
                }
                catch (e) {
                    this.post({ type: 'commit-detail', requestId: message.requestId, error: describeGitError(e) });
                }
                break;
            }
            case 'review-staged':
                try {
                    const review = await this.git.reviewStaged(message.path);
                    this.post({ type: 'staged-review', requestId: message.requestId, review });
                } catch (e) {
                    this.post({ type: 'staged-review', requestId: message.requestId, error: describeGitError(e) });
                }
                break;
            case 'commit-staged':
                if (this.operation.busy) {
                    this.post({ type: 'commit-result', ok: false, error: '另一个 Git 操作正在进行，请稍后重新加载审查。' });
                    break;
                }
                this.operation.busy = true;
                try {
                    const hash = await this.git.commitStaged(message.repoId, message.token, message.message);
                    await this.enqueue(() => this.pushSnapshot(true));
                    this.post({ type: 'commit-result', ok: true, hash });
                } catch (e) {
                    await this.enqueue(() => this.pushSnapshot(true));
                    this.post({ type: 'commit-result', ok: false, error: describeGitError(e) });
                } finally { this.operation.busy = false; }
                break;
            case 'merge':
                await this.withLock(async () => { const result = await this.git.merge(message.ref); await this.enqueue(() => this.pushSnapshot(true)); this.post({ type: 'live-result', kind: result.conflict ? 'conflict' : 'clean', text: result.conflict ? 'Git 停在冲突上。请选择一种方式解决。' : '合并完成，没有冲突。' }); });
                break;
            case 'abort-merge':
                await this.withLock(async () => { await this.git.abortMerge(); await this.enqueue(() => this.pushSnapshot(true)); this.post({ type: 'live-result', kind: 'aborted', text: '合并已中止。' }); });
                break;
            case 'resolve':
                await this.withLock(async () => { const text = await this.git.resolve(message.path, message.strategy); await this.enqueue(() => this.pushSnapshot(true)); this.post({ type: 'live-result', kind: 'resolved', text }); });
                break;
            case 'stage':
                await this.withLock(async () => { await this.git.stage(message.path); await this.enqueue(() => this.pushSnapshot(true)); this.post({ type: 'live-result', kind: 'resolved', text: '当前文件已暂存。' }); });
                break;
        }
    }
    private html(webview: vscode.Webview): string {
        const nonce = randomBytes(18).toString('base64');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        return `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Generative Git</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    }
    dispose(): void { this.subscriptions.forEach(d => d.dispose()); }
}
