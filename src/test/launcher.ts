import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeGitLauncher } from '../webview/launcher';
import { EventEmitter, Uri } from './vscode';
import * as host from './vscode';
import type { GitService } from '../git/gitService';
import type { Snapshot } from '../shared/protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function makeSnapshot(selected = '/repo/aurora'): Snapshot {
    return {
        repoId: selected, repoName: selected === '/repo/beacon' ? 'beacon' : 'aurora',
        repositories: [{ id: '/repo/aurora', name: 'aurora' }, { id: '/repo/beacon', name: 'beacon' }],
        headName: 'main', headHash: 'a1f3c09', branches: ['main', 'feature/checkout-flow'],
        conflicts: [{ path: 'src/checkout.ts', status: '双方修改', hunks: [] }],
        workingTreeCount: 6, stagedCount: 1,
        workingTreeFiles: [
            { path: 'src/webview/render.ts', status: '已修改', untracked: false },
            { path: 'src/webview/launcher.ts', status: '已修改', untracked: false },
            { path: 'media/main.css', status: '已修改', untracked: false },
            { path: 'media/tokens.css', status: '未跟踪', untracked: true },
            { path: 'legacy/graph.ts', status: '删除', untracked: false },
            { path: 'src/extra.ts', status: '已修改', untracked: false }
        ],
        mergeHead: false, rebasing: false, canMerge: true, canAbort: true,
        branchList: [
            { name: 'main', ref: 'refs/heads/main', local: true, current: true, ahead: 2, behind: 1 },
            { name: 'feature/checkout-flow', ref: 'refs/heads/feature/checkout-flow', local: true, current: false },
            { name: 'origin/main', ref: 'refs/remotes/origin/main', local: false, current: false }
        ],
        graph: {
            laneCount: 2,
            nodes: [
                { id: 'a1f3c09', hash: 'a1f3c09', title: 'fix: 补上结算税率', lane: 0, row: 0, badges: ['main'], role: 'commit', tip: true },
                { id: '9c0d4e2', hash: '9c0d4e2', title: 'feat: 支持结算折扣', lane: 1, row: 1, badges: ['feature/checkout-flow'], role: 'commit' }
            ],
            edges: [{ id: 'e1', from: 'a1f3c09', to: '9c0d4e2', style: 'solid' }]
        }
    };
}

function viewDouble() {
    const receive = new EventEmitter<unknown>();
    const visibility = new EventEmitter<void>();
    const disposed = new EventEmitter<void>();
    const messages: any[] = [];
    const view = {
        visible: true,
        onDidChangeVisibility: visibility.event,
        onDidDispose: disposed.event,
        webview: {
            options: {}, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri: Uri) => uri,
            onDidReceiveMessage: receive.event,
            postMessage: async (message: unknown) => { messages.push(message); return true; }
        }
    };
    return { view, receive, visibility, disposed, messages };
}

function harness() {
    let selected = '/repo/aurora';
    const calls: string[] = [];
    const changes = new EventEmitter<void>();
    const { view, receive, visibility, disposed, messages } = viewDouble();
    const git = {
        onDidChange: changes.event,
        whenReady: async () => { },
        startupProblem: undefined,
        snapshot: async (previewRef?: string) => {
            calls.push(previewRef ? `snapshot:${previewRef}` : 'snapshot');
            const base = makeSnapshot(selected);
            return previewRef ? { ...base, preview: { ref: previewRef, name: previewRef.includes('feature') ? 'feature/checkout-flow' : 'origin/main', graph: base.graph } } : base;
        },
        select: async (id: string) => { calls.push(`select:${id}`); selected = id; changes.fire(); },
        refresh: async () => { calls.push('refresh'); changes.fire(); }
    } as unknown as GitService;
    const launcher = new GenerativeGitLauncher(Uri.file('/extension') as any, git, { busy: false }, () => { calls.push('open'); });
    launcher.resolveWebviewView(view as any);
    return { launcher, view, receive, visibility, disposed, messages, calls };
}

test('sidebar overview renders a compact graph and repository selector without opening the workbench', async () => {
    const h = harness();
    try {
        await tick(); await tick();
        assert.equal(h.calls.filter(c => c === 'open').length, 0);
        assert.ok(!h.view.webview.html.includes('dist/webview.js'));
        assert.match(h.view.webview.html, /default-src 'none'/);
        assert.match(h.view.webview.html, /script-src 'nonce-[^']+'/);
        assert.match(h.view.webview.html, /style-src [^;]*'unsafe-inline'/);
        const state = h.messages.find(m => m.type === 'state') as any;
        assert.ok(state);
        assert.match(state.html, /class="side-graph"/);
        assert.match(state.html, /class="side-rail"/);
        assert.match(state.html, /fix: 补上结算税率/);
        assert.match(state.html, /feat: 支持结算折扣/);
        assert.match(state.html, /data-action="select-repo"/);
        assert.match(state.html, /data-action="preview-branch"/);
        assert.match(state.html, /side-branch-row/);
        assert.match(state.html, /origin\/main/);
        assert.match(state.html, /class="side-alert"/);
        assert.match(state.html, /class="side-files"/);
        assert.match(state.html, /render.ts/);
        assert.match(state.html, /side-file-mark/);
        assert.match(state.html, /\+1 个文件/);
        assert.match(state.html, /1 个文件存在冲突/);
        assert.match(state.html, /未暂存/);
        assert.match(state.html, /打开工作台/);
        h.visibility.fire(); await tick();
        assert.equal(h.calls.filter(c => c === 'open').length, 0, 'visibility must not open the workbench');
        h.receive.fire({ type: 'open' }); await tick();
        assert.ok(h.calls.includes('open'));
    } finally { h.launcher.dispose(); }
});

test('repository switch and branch preview update the sidebar in place', async () => {
    const h = harness();
    try {
        await tick(); await tick();
        h.receive.fire({ type: 'select-repo', repoId: '/repo/beacon' });
        await tick(); await tick();
        assert.ok(h.calls.includes('select:/repo/beacon'));
        const states = h.messages.filter(m => m.type === 'state') as any[];
        const last = states.at(-1);
        assert.ok(last);
        assert.match(last.html, /class="side-repo-select"/);
        assert.match(last.html, /<option value="\/repo\/beacon" selected>/);
        h.receive.fire({ type: 'refresh' }); await tick(); await tick();
        assert.ok(h.calls.includes('refresh'));
        h.receive.fire({ type: 'preview-branch', ref: 'refs/heads/feature/checkout-flow' }); await tick(); await tick();
        assert.ok(h.calls.includes('snapshot:refs/heads/feature/checkout-flow'));
        const previewState = h.messages.filter(m => m.type === 'state').at(-1) as any;
        assert.match(previewState.html, /side-preview/);
        assert.match(previewState.html, /返回当前/);
        h.receive.fire({ type: 'preview-current' }); await tick(); await tick();
        const currentState = h.messages.filter(m => m.type === 'state').at(-1) as any;
        assert.ok(!/side-preview/.test(currentState.html));
        assert.equal(h.calls.filter(c => c === 'open').length, 0);
        const original = host.commands.executeCommand;
        let command = '';
        host.commands.executeCommand = async (name: string) => { command = name; };
        try {
            h.receive.fire({ type: 'source-control' }); await tick();
            assert.equal(command, 'workbench.view.scm');
        } finally {
            host.commands.executeCommand = original;
        }
    } finally { h.launcher.dispose(); }
});
