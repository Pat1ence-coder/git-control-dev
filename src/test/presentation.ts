import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentTask } from '../webview/presentation';
import { renderTaskControls } from '../webview/task';
import { renderPullRequest } from '../webview/remote';
import type { Snapshot, PullRequestInfo } from '../shared/protocol';

const snapshot: Snapshot = { repoId: '/repo', repoName: 'repo', repositories: [], headName: 'main', headHash: 'a'.repeat(40),
    branches: [], conflicts: [], workingTreeCount: 0, stagedCount: 0, mergeHead: false, rebasing: false, canMerge: true, canAbort: true,
    graph: { nodes: [], edges: [], laneCount: 1 } };
const pr: PullRequestInfo = { number: 1, title: 'PR title', state: 'merged', url: 'https://github.com/acme/app/pull/1',
    headSha: 'a'.repeat(40), headRef: 'main', baseRef: 'base', checks: [] };
const overview = { kind: 'overview' as const };

test('presentation keeps real local operation failures and previews ahead of remote PR success', () => {
    const input = { phase: 'idle', snapshot, live: overview, pullRequest: pr };
    assert.equal(presentTask(input).status.label, 'Merged');
    assert.match(presentTask(input).narrative, /PR #1 已合并/);
    assert.equal(presentTask({ ...input, phase: 'committing' }).status.label, '提交中');
    assert.equal(presentTask({ ...input, phase: 'error', live: { kind: 'error', text: 'fail' } }).status.label, '需要处理');
    const preview = presentTask({ ...input, snapshot: { ...snapshot, preview: { name: 'other', ref: 'refs/heads/other', graph: snapshot.graph } } });
    assert.equal(preview.status.label, '只读预览');
    assert.ok(!preview.chips.some(c => c.label === '#1'));
    const clean = presentTask({ ...input, pullRequest: undefined });
    assert.equal(clean.status.label, '工作区干净');
    assert.deepEqual(clean.chips, []);
});

test('conflict author text is escaped and explicitly described as file history, not blame', () => {
    const html = renderTaskControls({ phase: 'conflict', snapshot: { ...snapshot, conflicts: [{ path: '<file>', status: '双方修改', hunks: [
        { start: 1, end: 4, current: '<script>current</script>', incoming: '<img onerror=evil>',
            currentLabel: 'HEAD', incomingLabel: 'main', currentAuthor: '<img src=x>', incomingAuthor: '" onclick=evil' }
    ] }] }, live: overview, detailOpen: false, reviewOpen: false, conflictsOpen: false, peekOpen: true, branchPickerOpen: false, busy: false });
    assert.match(html, /文件最近提交作者/); assert.match(html, /非逐行归因/);
    assert.match(html, /&lt;img src=x&gt;/); assert.match(html, /&quot; onclick=evil/);
    assert.ok(!html.includes('<script>'));
});

test('unknown, partial and unavailable checks never claim a complete successful CI result', () => {
    const partial = renderPullRequest({ kind: 'ok', pullRequest: { ...pr, checksPartial: true, checks: [{ name: 'New status', status: 'unknown' }] } });
    assert.match(partial, /仅显示前 100 项/); assert.ok(!partial.includes('pr-check success'));
    const unavailable = renderPullRequest({ kind: 'ok', pullRequest: { ...pr, checksUnavailable: true } });
    assert.match(unavailable, /检查暂不可用/);
    assert.equal(renderPullRequest({ kind: 'unavailable', reason: 'not-github' }), '');
});
