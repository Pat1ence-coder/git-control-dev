import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot, ConflictFile } from '../shared/protocol';
import { presentTask } from '../webview/presentation';

const graph = (): Snapshot['graph'] => ({
    laneCount: 1,
    nodes: [{ id: 'a1f3c09', hash: 'a1f3c09', title: 'fix: 补上结算税率', lane: 0, row: 0, badges: ['main'], role: 'commit', tip: true }],
    edges: []
});

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    repoId: '/repo', repoName: 'repo', repositories: [{ id: '/repo', name: 'repo' }], headName: 'main', headHash: 'a1f3c09',
    branches: ['main'], conflicts: [], workingTreeCount: 0, workingTreeFiles: [], stagedCount: 0,
    mergeHead: false, rebasing: false, canMerge: true, canAbort: true, graph: graph(), ...overrides
});

const conflict = (path: string): ConflictFile => ({
    path, status: '双方修改',
    hunks: [{ start: 1, end: 2, current: 'old', incoming: 'new', currentLabel: 'HEAD', incomingLabel: 'feature' }]
});

const overview = { kind: 'overview' as const };

test('presentation: clean worktree uses the latest commit title and a real success state', () => {
    const p = presentTask({ phase: 'idle', snapshot: snapshot(), live: overview });
    assert.equal(p.title, 'fix: 补上结算税率');
    assert.deepEqual(p.status, { label: '工作区干净', tone: 'success' });
    assert.deepEqual(p.chips, []);
    assert.match(p.narrative, /工作区干净/);
    assert.match(p.narrative, /不会自动拉取或推送/);
});

test('presentation: unstaged and staged changes produce real counts and review language', () => {
    const working = presentTask({ phase: 'idle', snapshot: snapshot({ workingTreeCount: 3 }), live: overview });
    assert.equal(working.title, '3 项改动等待处理');
    assert.deepEqual(working.status, { label: '有未暂存改动', tone: 'neutral' });
    assert.deepEqual(working.chips, [{ label: '3 未暂存', tone: 'pending' }]);
    assert.match(working.narrative, /3 个文件未暂存/);

    const staged = presentTask({ phase: 'idle', snapshot: snapshot({ workingTreeCount: 1, stagedCount: 2 }), live: overview });
    assert.equal(staged.title, '提交 2 个已暂存文件');
    assert.deepEqual(staged.status, { label: '等待审查', tone: 'ready' });
    assert.deepEqual(staged.chips, [
        { label: '1 未暂存', tone: 'pending' },
        { label: '2 已暂存', tone: 'staged' }
    ]);
    assert.match(staged.narrative, /2 个文件已暂存/);
    assert.match(staged.narrative, /不会自动推送/);
});

test('presentation: conflicts lead the title, state, chips and narrative', () => {
    const p = presentTask({
        phase: 'conflict',
        snapshot: snapshot({ conflicts: [conflict('src/auth.ts'), conflict('src/middleware.ts')], mergingRef: 'main' }),
        live: overview
    });
    assert.equal(p.title, '解决 2 个文件的冲突');
    assert.deepEqual(p.status, { label: '存在冲突', tone: 'warning' });
    assert.deepEqual(p.chips, [{ label: '2 冲突', tone: 'conflict' }]);
    assert.match(p.narrative, /src\/auth\.ts、src\/middleware\.ts/);
    assert.match(p.narrative, /main/);
});

test('presentation: resolved merge is ready to review, and committed is explicitly local', () => {
    const ready = presentTask({ phase: 'ready', snapshot: snapshot({ mergeHead: true, stagedCount: 2 }), live: overview });
    assert.equal(ready.title, '冲突已解决，准备提交');
    assert.deepEqual(ready.status, { label: '等待审查', tone: 'ready' });
    assert.match(ready.narrative, /2 个文件已暂存/);

    const committed = presentTask({ phase: 'committed', snapshot: snapshot(), live: { kind: 'committed', hash: 'a1f3c09' } });
    assert.equal(committed.title, '提交完成');
    assert.deepEqual(committed.status, { label: '已提交', tone: 'success' });
    assert.match(committed.narrative, /没有执行推送/);
});

test('presentation: preview is read-only and carries no PR/CI fiction', () => {
    const p = presentTask({
        phase: 'idle',
        snapshot: snapshot({ preview: { ref: 'refs/heads/feature', name: 'feature', graph: graph() } }),
        live: overview
    });
    assert.equal(p.title, '预览 feature');
    assert.deepEqual(p.status, { label: '只读预览', tone: 'ready' });
    assert.deepEqual(p.chips, [{ label: '只读', tone: 'neutral' }]);
    assert.match(p.narrative, /不会切换 HEAD/);
    assert.ok(!/PR|CI|Merged/.test(p.title + p.narrative));
});

test('presentation: ahead/behind chips come from the current branch data', () => {
    const p = presentTask({
        phase: 'idle',
        snapshot: snapshot({
            branchList: [{ name: 'main', ref: 'refs/heads/main', local: true, current: true, ahead: 2, behind: 1 }]
        }),
        live: overview
    });
    assert.deepEqual(p.chips, [
        { label: '↑2', tone: 'neutral' },
        { label: '↓1', tone: 'neutral' }
    ]);
});

test('presentation: empty, loading and error states stay honest', () => {
    const empty = presentTask({ phase: 'empty', snapshot: null, live: overview });
    assert.equal(empty.title, '打开一个 Git 仓库');
    assert.deepEqual(empty.status, { label: '未打开仓库', tone: 'neutral' });

    const loading = presentTask({ phase: 'loading', snapshot: null, live: overview });
    assert.equal(loading.title, '正在连接 Git');
    assert.deepEqual(loading.status, { label: '连接中', tone: 'running' });

    const error = presentTask({ phase: 'error', snapshot: snapshot({ workingTreeCount: 1 }), live: { kind: 'error', text: 'boom' } });
    assert.equal(error.title, '操作未完成');
    assert.deepEqual(error.status, { label: '需要处理', tone: 'warning' });
    assert.match(error.narrative, /返回工作流/);
});

test('presentation: real PR state and checks take over the card surface', () => {
    const pr = {
        number: 128,
        title: 'Refresh sessions in the auth middleware',
        state: 'open' as const,
        url: 'https://github.com/acme/webapp/pull/128',
        headSha: 'abc123',
        headRef: 'feat/session-refresh',
        baseRef: 'main',
        checks: [{ name: 'Tests', status: 'completed', conclusion: 'success' }]
    };
    const p = presentTask({
        phase: 'conflict',
        snapshot: snapshot({ conflicts: [conflict('src/auth.ts')] }),
        live: overview,
        pullRequest: pr
    });
    assert.equal(p.title, 'Refresh sessions in the auth middleware #128');
    assert.deepEqual(p.status, { label: 'Open', tone: 'open' });
    assert.deepEqual(p.chips, [
        { label: '#128', tone: 'neutral' },
        { label: '1 冲突', tone: 'conflict' }
    ]);
});
