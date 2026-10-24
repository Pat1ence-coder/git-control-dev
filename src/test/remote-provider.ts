import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeGitViewProvider } from '../webview/provider';
import type { GitService } from '../git/gitService';
import { EventEmitter, Uri, env } from './vscode';
import { asHostMessage, repositoryContext, sameContext, type Snapshot, type ToWebview, type PullRequestState } from '../shared/protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const state: PullRequestState = { kind: 'ok', pullRequest: { number: 1, title: 'PR', state: 'open',
    headSha: 'a'.repeat(40), headRef: 'main', baseRef: 'base', url: 'https://github.com/acme/app/pull/1', checks: [] } };
function harness() {
    let snapshot: Snapshot = { repoId: '/repo', repoName: 'repo', repositories: [], headName: 'main', headHash: 'a'.repeat(40),
        branches: [], conflicts: [], workingTreeCount: 0, stagedCount: 0, mergeHead: false, rebasing: false,
        canMerge: true, canAbort: true, graph: { nodes: [], edges: [], laneCount: 1 } };
    const changed = new EventEmitter<{ shallow: boolean } | void>(), incoming = new EventEmitter<unknown>(), disposed = new EventEmitter<void>();
    const messages: ToWebview[] = [], pending: ((result: PullRequestState) => void)[] = [];
    let shallow: Snapshot | undefined;
    const service = { onDidChange: changed.event, whenReady: async () => {},
        snapshot: async (previewRef?: string) => previewRef ? { ...snapshot, preview: { ref: previewRef, name: previewRef, graph: snapshot.graph } } : snapshot, shallowSnapshot: () => shallow, matchesContext: (context: Snapshot) => sameContext(context, snapshot),
        pullRequest: async () => new Promise<PullRequestState>(resolve => pending.push(resolve)),
        clearPullRequestCache() {} } as unknown as GitService;
    const provider = new GenerativeGitViewProvider({ extensionUri: Uri.file('/extension') } as any, service);
    provider.resolveWebviewView({ webview: { options: {}, html: '', cspSource: 'vscode-webview:',
        asWebviewUri: (uri: Uri) => uri, onDidReceiveMessage: incoming.event,
        postMessage: (m: ToWebview) => { messages.push(m); return Promise.resolve(true); } }, onDidDispose: disposed.event } as any);
    return { provider, messages, pending, send: (value: unknown) => incoming.fire(value),
        context: () => repositoryContext(snapshot), close: () => disposed.fire(),
        change: () => { snapshot = { ...snapshot, repoId: '/other', headName: 'feature' }; changed.fire(); },
        save: (reusable: boolean) => { shallow = reusable ? { ...snapshot, workingTreeCount: snapshot.workingTreeCount + 1 } : undefined; changed.fire({ shallow: true }); } };
}

test('remote protocol rejects missing context and discards caller-supplied URLs', () => {
    assert.equal(asHostMessage({ type: 'open-pull-request', url: 'command:evil' }), undefined);
    assert.equal(asHostMessage({ type: 'connect-github', context: { repoId: '/repo', headName: 'main', headHash: '--evil' } }), undefined);
    const message = asHostMessage({ type: 'open-pull-request', context: { repoId: '/repo', headName: 'main' }, url: 'https://evil.invalid' });
    assert.equal(message?.type, 'open-pull-request'); assert.ok(message && !('url' in message));
});

test('provider drops delayed PR responses after repository changes and immediately revokes old links', async () => {
    const h = harness();
    const open = env.openExternal;
    const opened: string[] = [];
    env.openExternal = async uri => { opened.push(uri.toString()); return true; };
    try {
        h.send({ type: 'ready' }); await tick();
        const oldContext = h.context();
        h.change(); await tick();
        h.pending[0](state); await tick();
        assert.ok(!h.messages.some(m => m.type === 'pull-request' && m.state?.kind === 'ok'));
        h.pending[1](state); await tick();
        assert.ok(h.messages.some(m => m.type === 'pull-request' && m.state?.kind === 'ok' && m.context.repoId === '/other'));
        h.send({ type: 'open-pull-request', context: oldContext }); await tick(); assert.equal(opened.length, 0);
        h.send({ type: 'open-pull-request', context: h.context() }); await tick(); assert.equal(opened.length, 1);
        h.send({ type: 'preview-branch', ref: 'refs/heads/other' });
        h.send({ type: 'open-pull-request', context: h.context() }); await tick(); assert.equal(opened.length, 1);
    } finally { h.provider.dispose(); env.openExternal = open; }
});

test('disposed webviews and noncanonical URLs cannot open a PR', async () => {
    for (const close of [false, true]) {
        const h = harness(); const open = env.openExternal; let opened = false;
        env.openExternal = async () => { opened = true; return true; };
        try {
            h.send({ type: 'ready' }); await tick();
            if (close) h.close();
            h.pending[0]({ kind: 'ok', pullRequest: { ...(state as Extract<PullRequestState, { kind: 'ok' }>).pullRequest, url: 'https://github.com/acme/app/pull/1/../../evil' } });
            await tick();
            h.send({ type: 'open-pull-request', context: h.context() }); await tick();
            assert.equal(opened, false);
            if (close) assert.ok(!h.messages.some(m => m.type === 'pull-request' && m.state?.kind === 'ok'));
        } finally { h.provider.dispose(); env.openExternal = open; }
    }
});

test('working-tree-only changes keep PR state and skip GitHub; unprovable ones fall back to a full read', async () => {
    const h = harness();
    try {
        h.send({ type: 'ready' }); await tick();
        h.pending[0](state); await tick();
        const before = h.messages.length;
        h.save(true); await tick();
        const after = h.messages.slice(before);
        assert.deepEqual(after.map(m => m.type), ['snapshot'], 'no pull-request reset on a file save');
        assert.equal(after[0].type === 'snapshot' && after[0].snapshot?.workingTreeCount, 1);
        assert.equal(h.pending.length, 1, 'GitHub is not re-read');
        h.save(false); await tick();
        assert.equal(h.pending.length, 2, 'without a reusable snapshot the full path reloads remote state');
    } finally { h.provider.dispose(); }
});
