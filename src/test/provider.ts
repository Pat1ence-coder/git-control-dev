import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeGitViewProvider } from '../webview/provider';
import { EventEmitter, Uri } from './vscode';
import type { GitService } from '../git/gitService';
import type { Snapshot, ToWebview } from '../shared/protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

const snapshot: Snapshot = {
    repoId: '/repo', repoName: 'repo', repositories: [], headName: 'main', branches: [],
    conflicts: [], workingTreeCount: 0, stagedCount: 0, mergeHead: false, rebasing: false,
    canMerge: true, canAbort: true, graph: { laneCount: 1, nodes: [], edges: [] }
};

function hostHarness(options: { busy?: boolean; mergeError?: Error } = {}) {
    const messages: ToWebview[] = [];
    const calls: string[] = [];
    const changes = new EventEmitter<void>();
    const incoming = new EventEmitter<unknown>();
    const disposed = new EventEmitter<void>();
    const service = new Proxy({
        onDidChange: changes.event,
        whenReady: async () => { },
        startupProblem: undefined,
        snapshot: async (previewRef?: string) => { calls.push(previewRef ? `snapshot:${previewRef}` : 'snapshot'); return snapshot; },
        select: async (id: string) => { calls.push(`select:${id}`); changes.fire(); }
    }, {
        get(target, key) {
            if (key in target) return (target as Record<string | symbol, unknown>)[key];
            return async () => {
                calls.push(String(key));
                if (key === 'merge') {
                    if (options.mergeError) throw options.mergeError;
                    return { conflict: false };
                }
                if (key === 'commitStaged') return 'a'.repeat(40);
                return undefined;
            };
        }
    }) as unknown as GitService;
    const provider = new GenerativeGitViewProvider({ extensionUri: Uri.file('/extension') } as any, service, { busy: !!options.busy });
    const view = {
        webview: {
            options: {}, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri: Uri) => uri,
            onDidReceiveMessage: incoming.event,
            postMessage: (message: ToWebview) => { messages.push(message); return Promise.resolve(true); }
        },
        onDidDispose: disposed.event
    };
    provider.resolveWebviewView(view as any);
    return { messages, calls, provider, view, send: (message: unknown) => incoming.fire(message) };
}

test('live host hydrates a real snapshot with no mode or demo fields', async () => {
    const host = hostHarness();
    try {
        await host.send({ type: 'ready' }); await tick(); await tick();
        const hydrate = host.messages.find(m => m.type === 'hydrate');
        assert.equal(hydrate?.type, 'hydrate');
        if (!hydrate || hydrate.type !== 'hydrate') return;
        assert.equal(hydrate.snapshot, snapshot);
        assert.ok(!('mode' in hydrate));
        assert.ok(!('hasRepo' in hydrate));
        assert.match(host.view.webview.html, /default-src 'none'/);
        assert.match(host.view.webview.html, /script-src 'nonce-[^']+'/);
    } finally { host.provider.dispose(); }
});

test('live host refuses operations while another operation is busy', async () => {
    const host = hostHarness({ busy: true });
    try {
        await host.send({ type: 'ready' }); await tick(); await tick();
        host.calls.length = 0; host.messages.length = 0;
        await host.send({ type: 'commit-staged', repoId: '/repo', token: 'a'.repeat(64), message: 'must not run' }); await tick();
        assert.ok(host.messages.some(m => m.type === 'commit-result' && !m.ok));
        assert.ok(!host.calls.includes('commitStaged'));
        await host.send({ type: 'merge', ref: 'feature' }); await tick();
        assert.ok(host.messages.some(m => m.type === 'live-result' && m.kind === 'error'));
        assert.ok(!host.calls.includes('merge'));
    } finally { host.provider.dispose(); }
});

test('live host redacts external error text', async () => {
    const host = hostHarness({ mergeError: new Error('https://person:fixture-secret@example.invalid/private /home/private/person') });
    try {
        await host.send({ type: 'ready' }); await tick(); await tick();
        host.messages.length = 0;
        await host.send({ type: 'merge', ref: 'feature' }); await tick(); await tick();
        const error = host.messages.find(m => m.type === 'live-result' && m.kind === 'error');
        if (!error || error.type !== 'live-result') throw new Error('missing redacted error');
        assert.match(error.text || '', /外部错误详情已隐藏/);
        assert.ok(!(error.text || '').includes('fixture-secret'));
        assert.ok(!(error.text || '').includes('/home/private'));
    } finally { host.provider.dispose(); }
});

test('removed demo messages are not addressable at the host bridge', async () => {
    const host = hostHarness();
    try {
        await host.send({ type: 'ready' }); await tick(); await tick();
        host.calls.length = 0; host.messages.length = 0;
        host.send({ type: 'set-mode', mode: 'live' });
        host.send({ type: 'set-mode', mode: 'demo' });
        host.send({ type: 'run-demo' });
        await tick();
        assert.deepEqual(host.calls, []);
        assert.deepEqual(host.messages, []);
    } finally { host.provider.dispose(); }
});

test('repository selection notifies the workbench through the shared change event', async () => {
    const host = hostHarness();
    try {
        await host.send({ type: 'ready' }); await tick(); await tick();
        host.messages.length = 0;
        await host.send({ type: 'select-repo', repoId: '/repo2' }); await tick(); await tick();
        assert.ok(host.calls.includes('select:/repo2'));
        assert.ok(host.messages.some(m => m.type === 'snapshot'));
    } finally { host.provider.dispose(); }
});

test('branch preview is read-only and refreshes without changing the repository', async () => {
    const host = hostHarness();
    try {
        await host.send({ type: 'ready' }); await tick(); await tick();
        host.messages.length = 0;
        await host.send({ type: 'preview-branch', ref: 'refs/heads/feature' }); await tick(); await tick();
        assert.ok(host.calls.includes('snapshot:refs/heads/feature'));
        assert.ok(host.messages.some(message => message.type === 'snapshot'));
        assert.ok(!host.calls.some(call => call.startsWith('select:')));
        await host.send({ type: 'preview-current' }); await tick(); await tick();
        assert.ok(host.calls.includes('snapshot'));
    } finally { host.provider.dispose(); }
});
