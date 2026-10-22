import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refFixtures, refConflicts, refResolving, refMerged, REF_NOW } from './fixtures/refFig';
import type { RefFixture } from './fixtures/refFig';
import { renderGraph } from '../webview/render';

const remainingMarks = (fx: RefFixture) =>
    Object.values(fx.thread.rowMarks ?? {}).reduce((sum, m) => sum + (m.kind === 'count' ? m.n : 0), 0);

for (const fx of refFixtures) {
    test(`ref fixture ${fx.name}: graph is well-formed`, () => {
        const { nodes, edges, laneCount } = fx.snapshot.graph;
        const ids = new Set(nodes.map(n => n.id));
        assert.equal(ids.size, nodes.length, 'node ids unique');
        assert.deepEqual(nodes.map(n => n.row), nodes.map((_, i) => i), 'rows contiguous from 0');
        for (const n of nodes) {
            assert.ok(n.lane < laneCount);
            if (n.role === 'commit') assert.ok(n.id.startsWith(n.hash) && n.hash.length === 6);
        }
        for (const e of edges) {
            const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
            assert.ok(a && b, `edge ${e.id} endpoints exist`);
            assert.ok(b!.row > a!.row, `edge ${e.id} points down (child -> parent)`);
        }
        const names = new Set(fx.snapshot.branchList!.map(b => b.name));
        for (const badge of nodes.flatMap(n => n.badges)) assert.ok(names.has(badge), `badge ${badge} is a known branch`);
        assert.equal(fx.snapshot.workingTreeCount, fx.snapshot.workingTreeFiles?.length ?? 0);
        const t = fx.thread;
        for (const id of [...Object.keys(t.rowMeta ?? {}), ...Object.keys(t.rowMarks ?? {}), ...(t.warn ?? []), ...(t.rowProgress ? [t.rowProgress.id] : [])])
            assert.ok(ids.has(id), `thread decoration targets a graph row: ${id}`);
    });
    test(`ref fixture ${fx.name}: conflict counts agree across row, marks and snapshot`, () => {
        const top = Object.values(fx.thread.rowMeta ?? {}).map(m => /^(\d+) conflicts?$/.exec(m.text)).find(Boolean);
        const marks = remainingMarks(fx);
        assert.equal(top ? Number(top[1]) : 0, marks);
        if (fx.snapshot.mergeHead)
            assert.equal(fx.snapshot.conflicts.reduce((sum, f) => sum + f.hunks.length, 0), marks, 'local conflicts match the marks');
        else assert.equal(fx.snapshot.conflicts.length, 0, 'predicted conflicts are not local conflicts');
    });
    test(`ref fixture ${fx.name}: renders with the current graph renderer`, () => {
        const realNow = Date.now;
        Date.now = () => REF_NOW;
        try {
            const html = renderGraph(fx.snapshot.graph, false);
            for (const n of fx.snapshot.graph.nodes.filter(n => n.role === 'commit')) assert.ok(html.includes(n.hash));
        } finally { Date.now = realNow; }
    });
}

test('ref fixture pr-open-conflicts: chip and popover match the 3 conflicts', () => {
    assert.equal(refConflicts.prediction!.hunks.length, 3);
    assert.match(refConflicts.thread.foot.text, /^3 conflicts/);
    const chip = refConflicts.thread.chips.find(c => c.kind === 'pr');
    assert.ok(chip && chip.kind === 'pr' && chip.conflicts === 3);
});

test('ref fixtures: resolving keeps the pending merge uncommitted until pushed', () => {
    assert.ok(refResolving.snapshot.graph.nodes.some(n => n.id === 'pending-merge' && n.role === 'ghost' && !n.hash));
    assert.equal(refResolving.snapshot.headHash?.slice(0, 6), 'd29f50');
    assert.equal(refMerged.snapshot.headHash?.slice(0, 6), '7e0c3b');
});

test('ref fixture merged: status, chips and lanes switch to merged', () => {
    assert.equal(refMerged.thread.status?.tone, 'merged');
    assert.equal(refMerged.pr?.state, 'merged');
    assert.ok(!refMerged.thread.chips.some(c => c.kind === 'diff'), 'diff chip collapses after merge');
    assert.ok(refMerged.snapshot.graph.edges.filter(e => e.from === 'merge-into-main').every(e => e.style === 'join'));
});

test('ref fixtures never ship in extension or webview bundles', () => {
    for (const bundle of ['dist/extension.js', 'dist/webview.js']) {
        const text = readFileSync(bundle, 'utf8');
        assert.ok(!text.includes('acme-webapp') && !text.includes('Lena'), `${bundle} contains fixture data`);
    }
});
