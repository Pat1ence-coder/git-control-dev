import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeGitLauncher } from '../webview/launcher';
import { EventEmitter, Uri } from './vscode';

function viewDouble() {
    const receive = new EventEmitter<unknown>();
    const visibility = new EventEmitter<void>();
    const view = {
        visible: true,
        onDidChangeVisibility: visibility.event,
        webview: {
            options: {}, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri: Uri) => uri,
            onDidReceiveMessage: receive.event,
            postMessage: async () => true
        }
    };
    return { view, receive, visibility };
}

test('activity-bar entry opens the workbench and never embeds the wide application', () => {
    let opens = 0;
    const launcher = new GenerativeGitLauncher(Uri.file('/extension') as any, () => { opens++; });
    const { view, receive, visibility } = viewDouble();
    try {
        launcher.resolveWebviewView(view as any);
        assert.equal(opens, 1);
        assert.ok(!view.webview.html.includes('dist/webview.js'));
        assert.ok(!view.webview.html.includes('commit-tree'));
        assert.ok(!view.webview.html.includes('运行演示'));
        assert.ok(!view.webview.html.includes('data-action="demo"'));
        assert.ok(!view.webview.html.includes('entry-error'));
        assert.match(view.webview.html, /default-src 'none'/);
        assert.match(view.webview.html, /script-src 'nonce-[^']+'/);
        view.visible = false; visibility.fire(); assert.equal(opens, 1);
        view.visible = true; visibility.fire(); assert.equal(opens, 2);
        receive.fire({ type: 'open' }); assert.equal(opens, 3);
        receive.fire({ type: 'merge', ref: 'main' });
        receive.fire({ type: 'commit-staged', message: 'not allowed' });
        assert.equal(opens, 3);
    } finally { launcher.dispose(); }
});
