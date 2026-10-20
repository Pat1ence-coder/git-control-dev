import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { demoGraph } from '../demo/scenario';
import type { ToHost, ToWebview, Snapshot } from '../shared/protocol';
import { demoReview } from '../demo/scenario';
// Executes the actual browser bundle with a minimal DOM/message/timer adapter.
// Verifies controller behavior; visual layout still needs a real browser/host.
export function harness(live = false, onPost?: (message: ToHost) => void) {
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
    let now = 0, timerId = 0;
    const timers = new Map<number, {
        at: number;
        fn: () => void;
    }>();
    const get = (id: string) => { if (!nodes.has(id))
        nodes.set(id, new Element()); return nodes.get(id)!; };
    const context = { window: Object.assign(win, { matchMedia: () => ({ matches: false }) }), document: { getElementById: get, activeElement: null }, navigator: { clipboard: { writeText: async () => { } } }, HTMLSelectElement: Select, console,
        setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: (id: number) => timers.delete(id),
        ...(live ? { acquireVsCodeApi: () => ({ postMessage: (message: ToHost) => { posted.push(message); onPost?.(message); } }) } : {}) };
    vm.runInNewContext(readFileSync('dist/webview.js', 'utf8'), context);
    return {
        get, posted,
        phase: () => get('app').dataset.phase,
        click(action: string, data: Record<string, string> = {}) { const el = new Element(); el.dataset = { action, ...data }; get('app').listeners.get('click')!({ target: el }); },
        input(value: string) { const el = Object.assign(new Element(), { value, tagName: 'TEXTAREA' }); el.dataset.action = 'commit-message'; get('app').listeners.get('input')!({ target: el }); },
        key(key: string) { win.listeners.get('keydown')!({ key, target: new Element(), preventDefault() { } }); },
        message(message: ToWebview) { win.listeners.get('message')!({ data: message }); },
        advance(ms: number) { const target = now + ms; for (;;) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > target)
                break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
        } now = target; }
    };
}
test('webview: all four strategies run in one surface, including failing demo checks', () => {
    for (const strategy of ['current', 'incoming', 'both', 'ai']) {
        const ui = harness();
        const stage = ui.get('stage');
        assert.equal(ui.phase(), 'idle');
        ui.click('demo-start');
        assert.equal(ui.phase(), 'merging');
        ui.advance(1600);
        assert.equal(ui.phase(), 'conflict');
        assert.equal(stage.innerHTML, '');
        ui.click('show-conflicts');
        assert.match(stage.innerHTML, /src\/checkout.ts/);
        ui.click('demo-resolve', { strategy });
        assert.equal(ui.phase(), 'resolving');
        ui.advance(720);
        assert.equal(ui.phase(), 'checking');
        ui.advance(1300);
        assert.equal(ui.phase(), 'reviewing');
        assert.equal(stage.innerHTML.includes('class="failed"'), strategy !== 'ai');
        ui.advance(10000);
        assert.equal(ui.phase(), 'reviewing', 'demo must wait for an explicit commit');
        ui.click('commit-staged');
        assert.equal(ui.phase(), 'committing');
        ui.advance(850);
        assert.equal(ui.phase(), 'merged');
        assert.equal(ui.get('stage'), stage);
        ui.click('review-staged'); // completed demos keep the task compact
        assert.equal(ui.phase(), 'merged');
        ui.click('inspect-commit', { hash: 'e7b21aa' });
        assert.match(stage.innerHTML, /COMMIT \/ e7b21aa/);
        ui.click('close-detail');
        assert.match(ui.get('task-controls').innerHTML, /演示提交已完成/);
    }
});
test('webview: review drafts survive refresh and failed commit; submit is explicit and single-flight', () => {
    const ui = harness(true);
    const snapshot: Snapshot = { repoId: '/repo', repoName: 'repo', repositories: [{ id: '/repo', name: 'repo' }], headName: 'main', headHash: 'a1f3c09', branches: ['main'], conflicts: [], workingTreeCount: 1, stagedCount: 1, mergeHead: true, rebasing: false, canMerge: true, canAbort: true, graph: demoGraph('idle') };
    ui.message({ type: 'hydrate', mode: 'live', snapshot, hasRepo: true });
    ui.click('review-staged');
    const review = { ...demoReview('ai'), repoId: '/repo', token: 'a'.repeat(64), unstagedCount: 1 };
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
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, stagedCount: 0, mergeHead: false, headHash: 'e7b21aa' }, hasRepo: true });
    ui.message({ type: 'commit-result', ok: true, hash: 'e7b21aa' });
    assert.equal(ui.phase(), 'committed'); assert.match(ui.get('task-controls').innerHTML, /改动已提交到本地/);
});
test('webview: changed index invalidates review and stale review responses are ignored', () => {
    const ui = harness(true);
    const snapshot: Snapshot = { repoId: '/repo', repoName: 'repo', repositories: [], headName: 'main', branches: [], conflicts: [], workingTreeCount: 0, stagedCount: 1, mergeHead: false, rebasing: false, canMerge: true, canAbort: true, graph: demoGraph('idle') };
    ui.message({ type: 'hydrate', mode: 'live', snapshot, hasRepo: true });
    ui.click('review-staged'); const requestId = ui.posted.at(-1).requestId;
    ui.message({ type: 'staged-review', requestId, review: { ...demoReview(), repoId: '/repo' } });
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, stagedCount: 2 }, hasRepo: true });
    ui.click('commit-staged');
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 0);
    assert.match(ui.get('stage').innerHTML, /重新加载审查/);
    ui.key('Escape'); ui.message({ type: 'staged-review', requestId, error: 'stale response' });
    assert.ok(!ui.get('stage').innerHTML.includes('stale response'));
});
test('unstaged file list is visible with staged changes and refreshes after single-file staging', () => {
    const ui = harness(true);
    const snapshot: Snapshot = {
        repoId: '/repo', repoName: 'repo', repositories: [], headName: 'main', branches: ['main'],
        conflicts: [], workingTreeCount: 2, stagedCount: 1, mergeHead: false,
        rebasing: false, canMerge: true, canAbort: true, graph: demoGraph('idle'),
        workingTreeFiles: [
            { path: 'src/edit.ts', status: '已修改', untracked: false },
            { path: 'new <&>.txt', status: '未跟踪', untracked: true }
        ]
    };
    ui.message({ type: 'hydrate', mode: 'live', snapshot, hasRepo: true });
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
    ui.message({ type: 'snapshot', hasRepo: true, snapshot: { ...snapshot, workingTreeCount: 1, stagedCount: 2, workingTreeFiles: snapshot.workingTreeFiles!.slice(0, 1) } });
    ui.message({ type: 'live-result', kind: 'staged', text: '已暂存' });
    assert.match(ui.get('working-changes').innerHTML, /src\/edit.ts/);
    assert.ok(!ui.get('working-changes').innerHTML.includes('new &lt;'));
    assert.equal(ui.posted.filter(m => m.type === 'commit-staged').length, 0);
    ui.click('mode-demo');
    assert.equal(ui.get('working-changes').innerHTML, '', 'demo must not leak real file paths');
});
test('webview: Escape cancels demo timers and shortcuts respect commit inspection', () => {
    const ui = harness();
    ui.click('demo-start');
    ui.advance(1600);
    ui.click('show-conflicts');
    ui.click('inspect-commit', { hash: 'a1f3c09' });
    ui.key('4');
    assert.equal(ui.phase(), 'conflict');
    ui.key('Escape');
    ui.key('4');
    assert.equal(ui.phase(), 'resolving');
    ui.key('Escape');
    ui.advance(10000);
    assert.equal(ui.phase(), 'idle');
});
test('webview: live actions, busy mode guard and stale detail responses', () => {
    const ui = harness(true);
    assert.equal(ui.posted[0].type, 'ready');
    const snapshot: Snapshot = { repoId: '/repo', repoName: 'repo', repositories: [{ id: '/repo', name: 'repo' }], headName: 'main', branches: ['main', 'feature'], conflicts: [], workingTreeCount: 0, stagedCount: 0, mergeHead: false, rebasing: false, canMerge: true, canAbort: true, graph: demoGraph('idle') };
    ui.message({ type: 'hydrate', mode: 'live', snapshot, hasRepo: true });
    ui.click('merge-ask', { ref: 'feature' });
    assert.equal(ui.phase(), 'confirm');
    ui.click('merge-go');
    assert.equal(ui.phase(), 'merging');
    assert.equal(ui.posted.at(-1).type, 'merge');
    ui.click('mode-demo');
    assert.equal(ui.phase(), 'merging');
    ui.message({ type: 'live-result', kind: 'error', text: 'merge failed' });
    assert.equal(ui.phase(), 'error');
    ui.key('Escape');
    assert.equal(ui.phase(), 'idle');
    ui.click('inspect-commit', { hash: 'a1f3c09' });
    const old = ui.posted.at(-1).requestId;
    ui.click('close-detail');
    ui.message({ type: 'commit-detail', requestId: old, error: 'stale error' });
    assert.ok(!ui.get('stage').innerHTML.includes('stale error'));
    ui.message({ type: 'snapshot', snapshot: { ...snapshot, mergeHead: true }, hasRepo: true });
    assert.equal(ui.phase(), 'ready');
    ui.click('abort-ask');
    assert.equal(ui.phase(), 'confirm');
    ui.key('Escape');
    assert.equal(ui.phase(), 'ready');
    assert.ok(!ui.posted.some(m => m.type === 'abort-merge'));
});

test('task card: conflict peek and Escape preserve the workflow until an explicit resolution', () => {
    const ui = harness(true);
    ui.message({ type: 'hydrate', mode: 'demo', hasRepo: true, snapshot: null });
    ui.click('demo-start'); ui.advance(1600);
    assert.equal(ui.get('stage').innerHTML, '');
    ui.click('peek-conflicts');
    assert.match(ui.get('task-controls').innerHTML, /id="conflict-popover"/);
    assert.match(ui.get('task-controls').innerHTML, /src\/checkout.ts/);
    assert.match(ui.get('task-controls').innerHTML, /双方修改了相同的代码/);
    ui.key('Escape');
    assert.equal(ui.phase(), 'conflict');
    assert.ok(!ui.get('task-controls').innerHTML.includes('id="conflict-popover"'));
    ui.click('show-conflicts');
    assert.equal(ui.get('app').dataset.expanded, 'true');
    ui.key('Escape');
    assert.equal(ui.phase(), 'conflict');
    assert.equal(ui.get('stage').innerHTML, '');
    ui.key('4'); // Hidden resolution actions must not run from a collapsed overview.
    assert.equal(ui.phase(), 'conflict');
    ui.click('show-conflicts'); ui.key('4');
    assert.equal(ui.phase(), 'resolving');
    assert.equal(ui.posted.filter(m => ['merge', 'resolve', 'commit-staged'].includes(m.type)).length, 0);
});

test('task card: collapsing review preserves the draft and never commits implicitly', () => {
    const ui = harness();
    ui.click('demo-start'); ui.advance(1600); ui.click('show-conflicts');
    ui.click('demo-resolve', { strategy: 'ai' }); ui.advance(2020);
    ui.input('Keep this review message');
    ui.click('collapse-task');
    assert.equal(ui.phase(), 'reviewing');
    assert.equal(ui.get('stage').innerHTML, '');
    ui.click('review-staged');
    assert.match(ui.get('stage').innerHTML, /Keep this review message/);
    assert.equal(ui.phase(), 'reviewing');
});
