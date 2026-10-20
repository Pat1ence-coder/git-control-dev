import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeGitLauncher } from '../webview/launcher';
import { EventEmitter, Uri } from './vscode';
import { UserFacingError } from '../git/errors';

function viewDouble() {
    const receive = new EventEmitter<unknown>();
    const visibility = new EventEmitter<void>();
    const sent: any[] = [];
    const view = {
        visible: true,
        onDidChangeVisibility: visibility.event,
        webview: {
            options: {}, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri: Uri) => uri,
            onDidReceiveMessage: receive.event,
            postMessage: async (message: unknown) => { sent.push(message); return true; }
        }
    };
    return { view, receive, visibility, sent };
}

test('activity-bar entry opens the workbench and never embeds the wide application', async () => {
    let opens = 0, demos = 0;
    const launcher = new GenerativeGitLauncher(Uri.file('/extension') as any, () => { opens++; }, async () => { demos++; });
    const { view, receive, visibility } = viewDouble();
    try {
        launcher.resolveWebviewView(view as any);
        assert.equal(opens, 1);
        assert.ok(!view.webview.html.includes('dist/webview.js'));
        assert.ok(!view.webview.html.includes('commit-tree'));
        view.visible = false; visibility.fire(); assert.equal(opens, 1);
        view.visible = true; visibility.fire(); assert.equal(opens, 2);
        receive.fire({ type: 'open' }); assert.equal(opens, 3);
        receive.fire({ type: 'demo' }); assert.equal(demos, 1);
        receive.fire({ type: 'merge', ref: 'main' });
        receive.fire({ type: 'commit-staged', message: 'not allowed' });
        assert.equal(opens, 3); assert.equal(demos, 1);
    } finally { launcher.dispose(); }
});

test('activity-bar entry reports a refused demo switch without changing the operation', async () => {
    const launcher = new GenerativeGitLauncher(Uri.file('/extension') as any, () => {}, async () => { throw new UserFacingError('Git 操作进行中'); });
    const { view, receive, sent } = viewDouble();
    try {
        launcher.resolveWebviewView(view as any);
        receive.fire({ type: 'demo' });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(sent, [{ type: 'error', text: 'Git 操作进行中' }]);
    } finally { launcher.dispose(); }
});
test('activity-bar errors do not forward external messages containing credentials', async () => {
    const launcher = new GenerativeGitLauncher(Uri.file('/extension') as any, () => {}, async () => {
        throw new Error('https://person:fixture-secret@example.invalid/private /home/private/person');
    });
    const { view, receive, sent } = viewDouble();
    try {
        launcher.resolveWebviewView(view as any);
        receive.fire({ type: 'demo' });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(sent.length, 1);
        assert.match(sent[0].text, /外部错误详情已隐藏/);
        assert.ok(!sent[0].text.includes('fixture-secret'));
        assert.ok(!sent[0].text.includes('/home/private'));
    } finally { launcher.dispose(); }
});
