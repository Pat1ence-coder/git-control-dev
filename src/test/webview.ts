import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { ToHost, ToWebview, Snapshot, StagedReview, ConflictFile } from '../shared/protocol';

// Executes the actual browser bundle with a minimal DOM/message adapter.
// Verifies controller behavior; visual layout still needs a real browser/host.
export function harness() {
    class Element {
        innerHTML = '';
        textContent = '';
        dataset: Record<string, string> = {};
        tagName = 'DIV';
        isContentEditable = false;
        style = { setProperty: () => { } };
        classList = { remove: () => { }, add: () => { } };
        offsetWidth = 400;
        listeners = new Map<string, (event: any) => void>();
        addEventListener(type: string, cb: (event: any) => void) { this.listeners.set(type, cb); }
        contains() { return false; }
        closest() { return this; }
        hasAttribute() { return false; }
        getAttribute() { return null; }
        querySelector() { return { textContent: /<h2>(.*?)<\/h2>/.exec(this.innerHTML)?.[1] || '' }; }
        querySelectorAll() { return []; }
        focus() { }
    }
    class Select extends Element {
    }
    const nodes = new Map<string, Element>();
    const win = new Element();
    const posted: any[] = [];
    const get = (id: string) => { if (!nodes.has(id))
        nodes.set(id, new Element()); return nodes.get(id)!; };
    const context = { window: Object.assign(win, { matchMedia: () => ({ matches: false }) }), document: { getElementById: get, activeElement: null }, navigator: { clipboard: { writeText: async () => { } } }, HTMLSelectElement: Select, console,
        acquireVsCodeApi: () => ({ postMessage: (message: ToHost) => { posted.push(message); } }) };
    vm.runInNewContext(readFileSync('dist/webview.js', 'utf8'), context);
    return {
        get, posted,
        phase: () => get('app').dataset.phase,
        click(action: string, data: Record<string, string> = {}) { const el = new Element(); el.dataset = { action, ...data }; get('app').listeners.get('click')!({ target: el }); },
        input(value: string) { const el = Object.assign(new Element(), { value, tagName: 'TEXTAREA' }); el.dataset.action = 'commit-message'; get('app').listeners.get('input')!({ target: el }); },
        key(key: string) { win.listeners.get('keydown')!({ key, target: new Element(), preventDefault() { } }); },
        message(message: ToWebview) { win.listeners.get('message')!({ data: message }); }
    };
}

const fixtureGraph = (): Snapshot['graph'] => ({
    laneCount: 1,
    nodes: [{ id: 'a1f3c09', hash: 'a1f3c09', title: 'fix: 补上结算税率', lane: 0, row: 0, badges: ['main'], role: 'commit', tip: true }],
    edges: []
});
const makeSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    repoId: '/repo', repoName: 'repo', repositories: [{ id: '/repo', name: 'repo' }], headName: 'main', headHash: 'a1f3c09',
    branches: ['main'], conflicts: [], workingTreeCount: 0, workingTreeFiles: [], stagedCount: 0,
    mergeHead: false, rebasing: false, canMerge: true, canAbort: true, graph: fixtureGraph(), ...overrides
});
const makeReview = (overrides: Partial<StagedReview> = {}): StagedReview => ({
    repoId: '/repo', headName: 'main', token: 'a'.repeat(64), merge: false,
    files: [{ path: 'src/edit.ts', status: '已修改' }], path: 'src/edit.ts',
    patch: '--- a/src/edit.ts\n+++ b/src/edit.ts\n@@ -1 +1 @@\n-old\n+new',
    truncated: false, suggestedMessage: 'chore: update', unstagedCount: 0, ...overrides
});
const makeConflict = (): ConflictFile => ({
    path: 'src/checkout.ts', status: '双方修改',
    hunks: [{
        start: 9, end: 15, current: 'const total = 1;', incoming: 'const total = 2;',
        currentLabel: 'HEAD', incomingLabel: 'feature', currentStart: 12, incomingStart: 14,
        before: ['export function total() {', '  // shared context'], beforeStart: 10,
        after: ['}'], afterStart: 16
    }]
});

test('webview: review drafts survive refresh and failed commit; submit is explicit and single-flight', () => {
    const ui = harness();
    const snapshot = makeSnapshot({ workingTreeCount: 1, stagedCount: 1, mergeHead: true });
    ui.message({ type: 'hydrate', snapshot });
    ui.click('review-staged');
    const review = makeReview({ unstagedCount: 1 });
    ui.message({ type: 'staged-review', requestId: ui.posted.at(-1).requestId, review });
    assert.equal(ui.phase(), 'reviewing');
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 0);
    ui.input('fix: reviewed tax & discount');
    ui.message({ type: 'notice', level: 'info', text: 'refreshed' });
    assert.match(ui.get('stage').innerHTML, /fix: reviewed tax &amp; discount/);
    ui.click('review-file', { path: review.path! });
    ui.message({ type: 'staged-review', requestId: ui.posted.at(-1).requestId, review: { ...review, suggestedMessage: 'must not replace draft' } });
    assert.match(ui.get('stage').innerHTML, /fix: reviewed tax &amp; discount/);
    ui.click('commit-staged'); ui.click('commit-staged');
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 1);
    assert.equal(ui.posted.at(-1).message, 'fix: reviewed tax & discount');
    assert.equal(ui.phase(), 'committing'); ui.key('Escape'); assert.equal(ui.phase(), 'committing');
    ui.message({ type: 'commit-result', ok: false, error: 'hook rejected commit' });
    assert.match(ui.get('stage').innerHTML, /hook rejected/);
    assert.match(ui.get('stage').innerHTML, /fix: reviewed tax &amp; discount/);
    ui.click('review-staged');
    ui.message({ type: 'staged-review', requestId: ui.posted.at(-1).requestId, review });
    ui.click('commit-staged');
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, stagedCount: 0, mergeHead: false, headHash: 'e7b21aa' } });
    ui.message({ type: 'commit-result', ok: true, hash: 'e7b21aa' });
    assert.equal(ui.phase(), 'committed'); assert.match(ui.get('task-controls').innerHTML, /改动已提交到本地/);
});
test('webview: changed index invalidates review and stale review responses are ignored', () => {
    const ui = harness();
    const snapshot = makeSnapshot({ stagedCount: 1 });
    ui.message({ type: 'hydrate', snapshot });
    ui.click('review-staged'); const requestId = ui.posted.at(-1).requestId;
    ui.message({ type: 'staged-review', requestId, review: makeReview() });
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, stagedCount: 2 } });
    ui.click('commit-staged');
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 0);
    assert.match(ui.get('stage').innerHTML, /重新加载审查/);
    ui.key('Escape'); ui.message({ type: 'staged-review', requestId, error: 'stale response' });
    assert.ok(!ui.get('stage').innerHTML.includes('stale response'));
});
test('unstaged file list is visible with staged changes and refreshes after single-file staging', () => {
    const ui = harness();
    const snapshot = makeSnapshot({
        workingTreeCount: 2, stagedCount: 1,
        workingTreeFiles: [
            { path: 'src/edit.ts', status: '已修改', untracked: false },
            { path: 'new <&>.txt', status: '未跟踪', untracked: true }
        ]
    });
    ui.message({ type: 'hydrate', snapshot });
    assert.match(ui.get('working-changes').innerHTML, /未暂存更改/);
    assert.match(ui.get('working-changes').innerHTML, /src\/edit.ts/);
    assert.match(ui.get('working-changes').innerHTML, /new &lt;&amp;&gt;\.txt/);
    assert.match(ui.get('task-controls').innerHTML, /审查并提交/);
    assert.equal(ui.get('stage').innerHTML, '', 'file list must not depend on expanding another view');
    ui.click('open-working-change', { path: 'src/edit.ts' });
    assert.equal(ui.posted.at(-1).type, 'open-working-change');
    ui.click('stage-working-change', { path: 'new <&>.txt' });
    assert.equal(ui.posted.at(-1).type, 'stage-working-change');
    assert.equal(ui.posted.at(-1).path, 'new <&>.txt');
    assert.equal(ui.posted.at(-1).repoId, '/repo');
    ui.click('stage-working-change', { path: 'new <&>.txt' });
    assert.equal(ui.posted.filter(m => m.type === 'stage-working-change').length, 1, 'double-click blocked');
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, workingTreeCount: 1, stagedCount: 2, workingTreeFiles: snapshot.workingTreeFiles!.slice(0, 1) } });
    ui.message({ type: 'live-result', kind: 'staged', text: '已暂存' });
    assert.match(ui.get('working-changes').innerHTML, /src\/edit.ts/);
    assert.ok(!ui.get('working-changes').innerHTML.includes('new &lt;'));
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 0);
});
test('webview: live actions, busy guard and stale detail responses', () => {
    const ui = harness();
    assert.equal(ui.posted[0].type, 'ready');
    const snapshot = makeSnapshot({ branches: ['main', 'feature'], workingTreeCount: 0, workingTreeFiles: [] });
    ui.message({ type: 'hydrate', snapshot });
    ui.click('merge-ask', { ref: 'feature' });
    assert.equal(ui.phase(), 'confirm');
    ui.click('merge-go');
    assert.equal(ui.phase(), 'merging');
    assert.equal(ui.posted.at(-1).type, 'merge');
    ui.click('review-staged');
    assert.equal(ui.phase(), 'merging');
    assert.equal(ui.posted.filter(m => m.type === 'review-staged').length, 0);
    ui.message({ type: 'live-result', kind: 'error', text: 'merge failed' });
    assert.equal(ui.phase(), 'error');
    ui.key('Escape');
    assert.equal(ui.phase(), 'idle');
    ui.click('inspect-commit', { hash: 'a1f3c09' });
    const old = ui.posted.at(-1).requestId;
    ui.click('close-detail');
    ui.message({ type: 'commit-detail', requestId: old, error: 'stale error' });
    assert.ok(!ui.get('stage').innerHTML.includes('stale error'));
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, mergeHead: true } });
    assert.equal(ui.phase(), 'ready');
    ui.click('abort-ask');
    assert.equal(ui.phase(), 'confirm');
    ui.key('Escape');
    assert.equal(ui.phase(), 'ready');
    assert.ok(!ui.posted.some(m => m.type === 'abort-merge'));
});
test('branch browser previews local and remote branches without checkout', () => {
    const ui = harness();
    const branchList: NonNullable<Snapshot['branchList']> = [
        { name: 'main', ref: 'refs/heads/main', local: true, current: true, ahead: 2, behind: 1 },
        { name: 'feature/checkout-flow', ref: 'refs/heads/feature/checkout-flow', local: true, current: false },
        { name: 'origin/main', ref: 'refs/remotes/origin/main', local: false, current: false }
    ];
    const snapshot = makeSnapshot({ branches: ['main', 'feature/checkout-flow'], branchList, workingTreeCount: 1 });
    ui.message({ type: 'hydrate', snapshot });
    ui.click('choose-branch');
    const popover = ui.get('branch-popover').innerHTML;
    assert.match(popover, /只读预览/);
    assert.match(popover, /feature\/checkout-flow/);
    assert.match(popover, /origin\/main/);
    assert.match(popover, /↑2/);
    assert.match(popover, /↓1/);
    assert.match(popover, /预览/);
    ui.click('preview-branch', { ref: 'refs/heads/feature/checkout-flow' });
    const posted = ui.posted.at(-1) as any;
    assert.equal(posted.type, 'preview-branch');
    assert.equal(posted.ref, 'refs/heads/feature/checkout-flow');
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, preview: { ref: 'refs/heads/feature/checkout-flow', name: 'feature/checkout-flow', graph: fixtureGraph() } } });
    assert.match(ui.get('graph').innerHTML, /branch-preview/);
    assert.match(ui.get('graph').innerHTML, /不会切换 HEAD/);
    assert.match(ui.get('graph').innerHTML, /feature\/checkout-flow/);
    ui.click('preview-current');
    assert.equal(ui.posted.at(-1).type, 'preview-current');
    assert.ok(!ui.posted.some((message: any) => /checkout/.test(message.type)));
});
test('task card: conflict peek and Escape preserve the workflow until an explicit resolution', () => {
    const ui = harness();
    const snapshot = makeSnapshot({ conflicts: [makeConflict()], mergeHead: true, canAbort: true });
    ui.message({ type: 'hydrate', snapshot });
    assert.equal(ui.phase(), 'conflict');
    assert.equal(ui.get('stage').innerHTML, '');
    ui.click('peek-conflicts');
    assert.match(ui.get('task-controls').innerHTML, /id="conflict-popover"/);
    assert.match(ui.get('task-controls').innerHTML, /conflict-popover is-open/);
    assert.match(ui.get('task-controls').innerHTML, /src\/checkout.ts/);
    assert.match(ui.get('task-controls').innerHTML, /HEAD 与 feature 修改了相同的代码/);
    ui.key('Escape');
    assert.equal(ui.phase(), 'conflict');
    assert.ok(!ui.get('task-controls').innerHTML.includes('is-open'));
    ui.click('show-conflicts');
    assert.equal(ui.get('app').dataset.expanded, 'true');
    assert.match(ui.get('stage').innerHTML, /hunk-context/);
    assert.match(ui.get('stage').innerHTML, /shared context/);
    ui.key('Escape');
    assert.equal(ui.phase(), 'conflict');
    assert.equal(ui.get('stage').innerHTML, '');
    ui.key('4');
    assert.equal(ui.phase(), 'conflict');
    assert.equal(ui.posted.filter(m => m.type === 'resolve').length, 0);
    ui.click('show-conflicts'); ui.key('4');
    assert.equal(ui.phase(), 'resolving');
    assert.equal(ui.posted.filter(m => m.type === 'resolve').length, 1);
    assert.equal(ui.posted.at(-1).path, 'src/checkout.ts');
    assert.equal(ui.posted.at(-1).strategy, 'ai');
});
test('task card: collapsing review preserves the draft and never commits implicitly', () => {
    const ui = harness();
    const snapshot = makeSnapshot({ stagedCount: 1 });
    ui.message({ type: 'hydrate', snapshot });
    ui.click('review-staged');
    ui.message({ type: 'staged-review', requestId: ui.posted.at(-1).requestId, review: makeReview() });
    ui.input('Keep this review message');
    ui.click('collapse-task');
    assert.equal(ui.phase(), 'idle');
    assert.equal(ui.get('stage').innerHTML, '');
    ui.click('review-staged');
    ui.message({ type: 'staged-review', requestId: ui.posted.at(-1).requestId, review: makeReview({ suggestedMessage: 'must not replace draft' }) });
    assert.match(ui.get('stage').innerHTML, /Keep this review message/);
    assert.equal(ui.phase(), 'reviewing');
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 0);
});
test('empty repository offers Source Control instead of a demo entry', () => {
    const ui = harness();
    ui.message({ type: 'hydrate', snapshot: null });
    assert.equal(ui.phase(), 'empty');
    assert.match(ui.get('task-controls').innerHTML, /打开 Source Control/);
    assert.ok(!ui.get('task-controls').innerHTML.includes('运行演示'));
});
test('quick composer hands its message to the real review flow', () => {
    const ui = harness();
    ui.message({ type: 'hydrate', snapshot: makeSnapshot({ stagedCount: 1 }) });
    (ui.get('quick-message') as any).value = 'fix: quick composer';
    ui.click('quick-review');
    assert.equal(ui.posted.at(-1).type, 'review-staged');
    assert.equal(ui.phase(), 'reviewing');
    ui.message({ type: 'staged-review', requestId: ui.posted.at(-1).requestId, review: makeReview() });
    assert.match(ui.get('stage').innerHTML, /fix: quick composer/);
});
