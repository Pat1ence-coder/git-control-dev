import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderThread, relTime } from '../webview/thread/render';
import { buildTimeline } from '../preview/timeline';
import { refFixtures, refConflicts, refMerged, refCreatingPr, REF_NOW } from './fixtures/refFig';
import type { ThreadFrame } from '../shared/thread';
import type { RefFixture } from './fixtures/refFig';

const frameOf = (fx: RefFixture, patch: Partial<ThreadFrame['thread']> = {}): ThreadFrame =>
    ({ graph: fx.snapshot.graph, thread: { ...fx.thread, ...patch }, composer: fx.thread.composer, prediction: fx.prediction, now: REF_NOW });
const rowKeys = (html: string) => [...html.matchAll(/data-key="(r:[^"]+)"/g)].map(m => m[1]);

test('thread: every reference fixture renders one row per graph node with unique keys', () => {
    for (const fx of refFixtures) {
        const keys = rowKeys(renderThread(frameOf(fx)));
        assert.equal(keys.length, fx.snapshot.graph.nodes.length, fx.name);
        assert.equal(new Set(keys).size, keys.length, fx.name);
    }
});

test('thread: relative times match the video labels', () => {
    assert.equal(relTime(new Date(REF_NOW).toISOString(), REF_NOW), 'now');
    assert.equal(relTime(new Date(REF_NOW - 25 * 60000).toISOString(), REF_NOW), '25m');
    assert.equal(relTime(new Date(REF_NOW - 180 * 60000).toISOString(), REF_NOW), '3h');
    const html = renderThread(frameOf(refCreatingPr));
    assert.match(html, /c70a92<\/code><span>You<\/span><span class="gg-dot-sep">·<\/span><time>25m<\/time>/);
});

test('thread: conflict popover lists each hunk and opens only on request', () => {
    const closed = renderThread(frameOf(refConflicts));
    assert.equal((closed.match(/gg-pop-group/g) ?? []).length, 3);
    assert.match(closed, /<b>Lena Park<\/b> changed the same lines on main/);
    assert.doesNotMatch(closed, /gg-trigger is-open/);
    assert.match(renderThread(frameOf(refConflicts, { popoverOpen: true })), /gg-trigger is-open/);
    assert.doesNotMatch(renderThread(frameOf(refMerged)), /gg-popover/);
});

test('thread: merged state recolours our lane, status and chip', () => {
    const html = renderThread(frameOf(refMerged));
    assert.match(html, /gg-status t-merged/);
    assert.match(html, /gg-tag t-merged">feat\/session-refresh/);
    assert.match(html, /gg-chip is-pr s-merged/);
    assert.doesNotMatch(html, /chip:diff/);
});

test('thread: intent-only frame shows the bubble but no card yet', () => {
    const html = renderThread(frameOf(refCreatingPr, { intentOnly: true }));
    assert.match(html, /gg-intent/);
    assert.doesNotMatch(html, /gg-card|gg-activity/);
});

test('thread: untrusted text is escaped everywhere it is rendered', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const fx = { ...refConflicts, snapshot: { ...refConflicts.snapshot, graph: { ...refConflicts.snapshot.graph,
        nodes: refConflicts.snapshot.graph.nodes.map(n => ({ ...n, title: evil, author: evil, badges: n.badges.length ? [evil] : [] })) } } };
    const html = renderThread(frameOf(fx, { title: evil, intent: evil, narration: `\`${evil}\` **${evil}** ${evil}`,
        foot: { ...refConflicts.thread.foot, text: `3 conflicts ${evil}` } }));
    assert.doesNotMatch(html, /<img/);
});

test('preview timeline: steps are ordered and keep ghost rows keyed through the commit', () => {
    const steps = buildTimeline();
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i].at > steps[i - 1].at, steps[i].label);
    const after = steps.filter(s => s.at >= 2600 && s.frame.thread);
    for (const s of after) assert.ok(rowKeys(renderThread(s.frame)).includes('r:working-tree'), s.label);
});
