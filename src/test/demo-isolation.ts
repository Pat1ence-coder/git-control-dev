import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeGitViewProvider } from '../webview/provider';
import { EventEmitter, Uri } from './vscode';
import type { GitService } from '../git/gitService';
import type { Mode, ToHost, ToWebview } from '../shared/protocol';
import { harness } from './webview';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function hostHarness(mode: Mode) {
    const messages: ToWebview[] = [];
    const calls: string[] = [];
    const changes = new EventEmitter<void>();
    const incoming = new EventEmitter<unknown>();
    const disposed = new EventEmitter<void>();
    let deliver: ((message: ToWebview) => void) | undefined;
    const service = new Proxy({
        onDidChange: changes.event,
        whenReady: async () => {},
        hasRepository: () => true,
        startupProblem: undefined
    }, {
        get(target, key) {
            if (key in target) return (target as Record<string | symbol, unknown>)[key];
            return async () => {
                calls.push(String(key));
                if (key === 'snapshot') return null;
                if (key === 'merge') return { conflict: false };
                if (key === 'commitStaged') return 'a'.repeat(40);
            };
        }
    }) as unknown as GitService;
    const saved = new Map<string, unknown>([['mode', mode]]);
    const provider = new GenerativeGitViewProvider({
        extensionUri: Uri.file('/extension'),
        workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => { saved.set(key, value); } }
    } as any, service);
    provider.resolveWebviewView({
        webview: {
            options: {}, html: '', cspSource: 'vscode-webview:', asWebviewUri: (uri: Uri) => uri,
            onDidReceiveMessage: incoming.event,
            postMessage: (message: ToWebview) => { messages.push(message); deliver?.(message); return Promise.resolve(true); }
        }, onDidDispose: disposed.event
    } as any);
    return {
        calls, messages, provider,
        emit: (message: ToHost) => incoming.fire(message),
        async send(message: ToHost) { incoming.fire(message); await tick(); },
        async changed() { changes.fire(); await tick(); },
        connect(callback: (message: ToWebview) => void) { deliver = callback; }
    };
}

test('demo host rejects every repository message, including forged real commit tokens', async () => {
    const host = hostHarness('demo');
    try {
        await host.send({ type: 'ready' });
        const first = host.messages.find(m => m.type === 'hydrate');
        assert.equal(first?.type === 'hydrate' && first.snapshot, null);
        const repositoryMessages: ToHost[] = [
            { type: 'merge', ref: 'main' },
            { type: 'abort-merge' },
            { type: 'resolve', path: 'a.ts', strategy: 'ai' },
            { type: 'stage', path: 'a.ts' },
            { type: 'native-stage-conflicts' },
            { type: 'open-conflict-diff', path: 'a.ts' },
            { type: 'open-merge-editor', path: 'a.ts' },
            { type: 'open-working-change', path: 'a.ts', repoId: '/repo' },
            { type: 'stage-working-change', path: 'a.ts', repoId: '/repo' },
            { type: 'commit-staged', repoId: '/repo', token: 'a'.repeat(64), message: 'must not commit' },
            { type: 'select-repo', repoId: '/repo' },
            { type: 'open-file', path: 'a.ts' },
            { type: 'suggest-commit' },
            { type: 'inspect-commit', hash: 'a'.repeat(40), requestId: 1 },
            { type: 'review-staged', requestId: 2 }
        ];
        for (const message of repositoryMessages) await host.send(message);
        await host.send({ type: 'refresh' });
        await host.provider.refresh(); // Command-palette refresh must also be isolated.
        await host.changed();
        assert.deepEqual(host.calls, [], 'Demo must not reach any repository service method');
        assert.equal(host.messages.filter(m => m.type === 'snapshot').length, 0);
    } finally { host.provider.dispose(); }
});

test('switching to demo closes the host repository boundary; explicitly returning live reopens it', async () => {
    const host = hostHarness('live');
    try {
        await host.send({ type: 'ready' });
        assert.ok(host.calls.includes('snapshot'));
        await host.send({ type: 'set-mode', mode: 'demo' });
        host.calls.length = 0;
        await host.send({ type: 'refresh' });
        await host.send({ type: 'merge', ref: 'feature' });
        await host.changed();
        assert.deepEqual(host.calls, []);
        await host.send({ type: 'set-mode', mode: 'live' });
        await host.send({ type: 'merge', ref: 'feature' });
        assert.equal(host.calls.filter(name => name === 'merge').length, 1);
    } finally { host.provider.dispose(); }
});

test('complete demo runs through the real message bridge with zero repository calls', async () => {
    for (const strategy of ['current', 'incoming', 'both', 'ai']) {
        const host = hostHarness('demo');
        try {
            const ui = harness(true, message => host.emit(message));
            host.connect(message => ui.message(message));
            await tick();
            ui.click('mode-demo'); await tick();
            ui.click('demo-start'); ui.advance(1600); ui.click('show-conflicts');
            ui.click('demo-resolve', { strategy }); ui.advance(2020);
            assert.equal(ui.phase(), 'reviewing');
            ui.input('This is a simulated commit');
            ui.click('commit-staged'); ui.advance(850);
            assert.equal(ui.phase(), 'merged');
            ui.click('inspect-commit', { hash: 'e7b21aa' });
            ui.click('close-detail'); ui.click('create-pr'); ui.click('refresh');
            await tick(); await host.changed();
            assert.deepEqual(host.calls, [], strategy);
            const sent = ui.posted.map(m => m.type);
            assert.ok(sent.every(type => ['ready', 'set-mode', 'refresh'].includes(type)), sent.join(', '));
        } finally { host.provider.dispose(); }
    }
});
