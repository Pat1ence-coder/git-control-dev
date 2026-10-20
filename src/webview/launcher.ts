import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** The activity bar is an entry point, not a narrow copy of the workbench. */
export class GenerativeGitLauncher implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly open: () => void
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        const nonce = randomBytes(18).toString('base64');
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        const css = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
        view.webview.html = `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Generative Git</title></head><body><main class="sidebar-entry"><svg class="entry-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="6" cy="19" r="2.5"/><path d="M6 7.5v9M18 10.5c0 5-12 1-12 6"/></svg><h1>Git 任务工作台</h1><p>在完整页面中查看提交、处理冲突并审查改动。</p><button class="primary" data-action="open">打开工作台 <span aria-hidden="true">↗</span></button></main><script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button)api.postMessage({type:button.dataset.action});});</script></body></html>`;
        this.subscriptions.push(
            view.webview.onDidReceiveMessage(message => {
                if (message && typeof message === 'object' && message.type === 'open') this.open();
            }),
            view.onDidChangeVisibility(() => { if (view.visible) this.open(); })
        );
        if (view.visible) this.open();
    }

    dispose(): void { this.subscriptions.forEach(d => d.dispose()); }
}
