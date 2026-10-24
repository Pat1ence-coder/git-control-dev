import { UserFacingError } from '../git/errors';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { GitService, describeGitError } from '../git/gitService';
import { asHostMessage, type ToHost, type ToWebview, type WriteMessage, type WriteTicket } from '../shared/protocol';
import { repositoryContext, sameContext, type RepositoryContext, type Snapshot, type PullRequestState } from '../shared/protocol';
import { safePullRequestUrl } from '../git/github';
import { runNativeGit } from '../git/nativeGitBridge';
export class GenerativeGitViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView | vscode.WebviewPanel;
    private panel?: vscode.WebviewPanel;
    private ready = false;
    private previewRef?: string;
    private current?: RepositoryContext;
    private remoteVersion = 0;
    private writeTicket?: WriteTicket & { issuedAt: number };
    private remoteLink?: { context: RepositoryContext; url: string };
    private connecting = false;
    private queue: Promise<void> = Promise.resolve();
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(private readonly context: vscode.ExtensionContext, private readonly git: GitService, private readonly operation = { busy: false }) {
        this.subscriptions.push(git.onDidChange(change => {
            if (change?.shallow) { void this.enqueue(() => this.pushShallowSnapshot()); return; }
            this.invalidateRemote();
            void this.enqueue(() => this.pushSnapshot(false));
        }));
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
        this.writeTicket = undefined;
        this.current = undefined;
        this.invalidateRemote();
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        view.webview.html = this.html(view.webview);
        this.subscriptions.push(view.webview.onDidReceiveMessage(value => { if (this.view !== view) return; const message = asHostMessage(value); if (message)
            void this.onMessage(message).catch(e => this.notify(describeGitError(e), 'error')); }), view.onDidDispose(() => { if (this.view === view) {
            this.view = undefined;
            this.ready = false;
            this.current = undefined;
            this.invalidateRemote();
        } }));
    }
    private post(message: ToWebview): void { if (this.ready)
        void this.view?.webview.postMessage(message); }
    private notify(text: string, level: 'info' | 'error' = 'info'): void { this.post({ type: 'notice', level, text }); }
    private enqueue(action: () => Promise<void>): Promise<void> { return this.queue = this.queue.then(action).catch(e => { this.notify(describeGitError(e), 'error'); }); }
    private async hydrate(): Promise<void> {
        const view = this.view;
        await this.git.whenReady();
        const snapshot = await this.git.snapshot(this.previewRef);
        if (!view || view !== this.view) return;
        this.ready = true;
        this.post({ type: 'hydrate', snapshot: this.withWriteTicket(snapshot), notice: this.git.startupProblem });
        this.refreshRemote(snapshot);
    }
    private async pushSnapshot(_force: boolean): Promise<void> {
        if (!this.ready) return;
        const view = this.view;
        const snapshot = await this.git.snapshot(this.previewRef);
        if (!this.ready || view !== this.view) return;
        this.post({ type: 'snapshot', snapshot: this.withWriteTicket(snapshot) });
        this.refreshRemote(snapshot);
    }
    /** Working-tree-only change: same HEAD and refs, so PR state stays and GitHub is not re-read. */
    private async pushShallowSnapshot(): Promise<void> {
        if (!this.ready) return;
        const snapshot = this.git.shallowSnapshot(this.previewRef);
        if (!snapshot) { this.invalidateRemote(); return this.pushSnapshot(false); }
        this.post({ type: 'snapshot', snapshot: this.withWriteTicket(snapshot) });
    }
    private invalidateRemote(): void {
        this.remoteVersion++;
        this.remoteLink = undefined;
        if (this.current) this.post({ type: 'pull-request', context: this.current });
    }
    private refreshRemote(snapshot: Snapshot | null): void {
        this.invalidateRemote();
        this.current = snapshot ? repositoryContext(snapshot) : undefined;
        if (snapshot && !snapshot.preview && !this.previewRef) void this.loadRemote();
    }
    private async loadRemote(): Promise<void> {
        const context = this.current;
        const version = ++this.remoteVersion;
        if (!context || !this.ready || this.previewRef) return;
        this.remoteLink = undefined;
        this.post({ type: 'pull-request', context });
        let state: PullRequestState;
        try { state = await this.git.pullRequest(context); }
        catch { state = { kind: 'unavailable', reason: 'error' }; }
        if (!state || version !== this.remoteVersion || !this.ready || !sameContext(this.current, context) ||
            !this.git.matchesContext(context)) return;
        if (state.kind === 'ok' && safePullRequestUrl(state.pullRequest.url))
            this.remoteLink = { context, url: state.pullRequest.url };
        this.post({ type: 'pull-request', context, state });
    }
    async refresh(): Promise<void> {
        await this.git.refresh();
        await this.enqueue(() => this.pushSnapshot(true));
    }
    private withWriteTicket(snapshot: Snapshot | null): Snapshot | null {
        this.writeTicket = undefined;
        if (!snapshot) return null;
        if (snapshot.preview || this.previewRef) return { ...snapshot, writeToken: undefined };
        const writeToken = randomBytes(24).toString('hex');
        this.writeTicket = { writeToken, context: repositoryContext(snapshot), issuedAt: Date.now() };
        return { ...snapshot, writeToken };
    }
    private async handleWrite(message: WriteMessage): Promise<void> {
        const view = this.view;
        const reportError = (error: unknown) => {
            const text = describeGitError(error);
            if (message.type === 'commit-staged') this.post({ type: 'commit-result', ok: false, error: text });
            else if (message.type === 'native-git') this.post({ type: 'native-git-result', requestToken: message.writeToken, context: message.context, action: message.action, kind: 'error', text });
            else this.post({ type: 'live-result', kind: 'error', text });
        };
        if (this.operation.busy) { reportError(new UserFacingError('上一个 Git 操作还没结束，请稍后重试。')); return; }
        const ticket = this.writeTicket;
        const assertHost = () => {
            if (!view || this.view !== view || !this.ready || this.previewRef || !vscode.workspace.isTrusted ||
                !sameContext(this.current, message.context))
                throw new UserFacingError('页面、仓库或分支状态已变化，请刷新后重新确认。');
        };
        try {
            assertHost();
            if (!ticket || ticket.writeToken !== message.writeToken || !sameContext(ticket.context, message.context) ||
                Date.now() - ticket.issuedAt > 5 * 60_000)
                throw new UserFacingError('操作请求已过期或已使用，请刷新后重新确认。');
        } catch (e) {
            reportError(e);
            await this.enqueue(() => this.pushSnapshot(true));
            return;
        }
        // Consume synchronously, before any await; replays cannot start another operation.
        this.writeTicket = undefined;
        this.operation.busy = true;
        let result: ToWebview | undefined;
        try {
            const guard = await this.git.prepareWrite(message.context, assertHost);
            switch (message.type) {
                case 'native-git': {
                    const native = await runNativeGit(message.action, guard);
                    result = { type: 'native-git-result', requestToken: message.writeToken, context: message.context, action: message.action, ...native };
                    break;
                }
                case 'merge': {
                    const merged = await this.git.merge(message.ref, guard, message.refHash);
                    result = { type: 'live-result', kind: merged.conflict ? 'conflict' : 'clean', text: merged.conflict ? 'Git 停在冲突上。请选择一种方式解决。' : '合并完成，没有冲突。' };
                    break;
                }
                case 'abort-merge':
                    await this.git.abortMerge(guard);
                    result = { type: 'live-result', kind: 'aborted', text: '合并已中止。' }; break;
                case 'resolve':
                    result = { type: 'live-result', kind: 'resolved', text: await this.git.resolve(message.path, message.strategy, guard) }; break;
                case 'stage':
                    await this.git.stage(message.path, guard);
                    result = { type: 'live-result', kind: 'resolved', text: '当前文件已暂存。' }; break;
                case 'stage-working-change':
                    await this.git.stageWorkingChange(message.path, message.repoId, guard);
                    result = { type: 'live-result', kind: 'staged', text: `${message.path} 已暂存。` }; break;
                case 'stage-all': {
                    const count = await this.git.stageAll(guard);
                    result = { type: 'live-result', kind: 'staged', text: `已暂存 ${count} 个未暂存文件。` }; break;
                }
                case 'native-stage-conflicts': {
                    const { remaining } = await this.git.stageConflictsNative(guard);
                    result = { type: 'live-result', kind: remaining ? 'conflict' : 'resolved', text: remaining ? `官方流程已返回，仍有 ${remaining} 个冲突；已完成的暂存会保留。` : '官方冲突暂存流程已完成，请审查实际暂存结果。' }; break;
                }
                case 'suggest-commit': await this.git.suggestCommitMessage(guard); break;
                case 'commit-staged': {
                    const hash = await this.git.commitStaged(message.repoId, message.token, message.message, guard);
                    result = { type: 'commit-result', ok: true, hash }; break;
                }
            }
        } catch (e) {
            if (this.view === view) reportError(e);
        } finally {
            // Snapshot failures are reported separately, never converted into a failed write.
            await this.enqueue(() => this.pushSnapshot(true));
            this.operation.busy = false;
        }
        if (result && this.view === view) this.post(result);
    }
    private async onMessage(message: ToHost): Promise<void> {
        if ('writeToken' in message) { await this.handleWrite(message); return; }
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
            this.git.clearPullRequestCache();
            this.invalidateRemote();
            await this.refresh();
            return;
        }
        if (message.type === 'preview-branch') {
            if (this.operation.busy) throw new UserFacingError('Git 操作进行中，请稍后切换预览。');
            this.writeTicket = undefined;
            this.invalidateRemote();
            this.previewRef = message.ref;
            await this.enqueue(() => this.pushSnapshot(true));
            return;
        }
        if (message.type === 'preview-current') {
            if (this.operation.busy) throw new UserFacingError('Git 操作进行中，请稍后切换预览。');
            this.writeTicket = undefined;
            this.invalidateRemote();
            this.previewRef = undefined;
            await this.enqueue(() => this.pushSnapshot(true));
            return;
        }
        switch (message.type) {
            case 'connect-github':
            case 'refresh-github':
            case 'open-pull-request': {
                if (!this.ready || this.previewRef || !sameContext(this.current, message.context) ||
                    !this.git.matchesContext(message.context)) return;
                if (message.type === 'open-pull-request') {
                    const link = this.remoteLink;
                    if (link && sameContext(link.context, message.context) && safePullRequestUrl(link.url))
                        await vscode.env.openExternal(vscode.Uri.parse(link.url));
                } else if (message.type === 'connect-github') {
                    if (this.connecting) return;
                    this.connecting = true;
                    try {
                        const connected = await this.git.connectGitHub(message.context);
                        if (!sameContext(this.current, message.context) || !this.ready) return;
                        if (!connected) this.notify('GitHub 连接未完成，可稍后重试。');
                        await this.loadRemote();
                    } finally { this.connecting = false; }
                } else {
                    this.git.clearPullRequestCache();
                    await this.loadRemote();
                }
                return;
            }
            case 'select-repo':
                this.writeTicket = undefined;
                if (this.operation.busy)
                    throw new UserFacingError('Git 操作进行中，请稍候再切换仓库。');
                this.previewRef = undefined;
                this.invalidateRemote();
                this.current = undefined;
                await this.git.select(message.repoId);
                break;
            case 'open-file':
                await this.git.open(message.path);
                break;
            case 'open-working-change':
                await this.git.openWorkingChange(message.path, message.repoId);
                break;
            case 'open-conflict-diff':
            case 'open-merge-editor':
                await this.git.openConflict(message.path, message.type === 'open-merge-editor');
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
        }
    }
    private html(webview: vscode.Webview): string {
        const nonce = randomBytes(18).toString('base64');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        return `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Generative Git</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    }
    dispose(): void { this.writeTicket = undefined; this.ready = false; this.view = undefined; this.invalidateRemote(); this.current = undefined; this.subscriptions.forEach(d => d.dispose()); }
}
