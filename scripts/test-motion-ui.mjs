// Optional real-browser motion regression for the morph-based thread (see test-thread-ui.mjs for setup).
// Drives a commit -> conflict -> resolving sequence and checks that rows are reused and move by
// transition instead of being rebuilt. Waits on conditions, not fixed sleeps; frames are only artifacts.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.GENERATIVE_GIT_PLAYWRIGHT || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = path.resolve(process.env.GENERATIVE_GIT_UI_ARTIFACTS || path.join(root, '../.tmp/thread-ui-rewrite'), 'motion');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.GENERATIVE_GIT_CHROMIUM });

const h = c => c.repeat(40);
const ago = m => new Date(Date.now() - m * 60_000).toISOString();
const commit = (id, title, lane, author, min, badges = []) => ({ id: h(id), hash: id.repeat(7), title, lane, badges, role: 'commit', author, authorDate: ago(min) });
const base = [
    commit('2', 'Refresh sessions near expiry', 0, 'You', 25, ['feat/session-refresh']),
    commit('3', 'Add analytics consent banner', 1, 'Sam', 32, ['feat/checkout-analytics']),
    commit('4', 'Read session expiry from the token', 0, 'You', 40),
    commit('5', 'Bump next to 16.3', 0, 'Sam', 180, ['main'])
];
// Each node links to the next node in its lane (or the root), which keeps the fixture a coherent DAG.
const graphOf = (list, tip) => ({
    laneCount: 2,
    nodes: list.map((n, row) => ({ ...n, row, tip: n.id === tip })),
    edges: list.slice(0, -1).map((n, i) => {
        const next = list.slice(i + 1).find(m => m.lane === n.lane) || list.at(-1);
        return { id: `${n.id}-${next.id}`, from: n.id, to: next.id, style: 'solid' };
    })
});
const snap = (over = {}) => ({
    writeToken: 'e'.repeat(48), nativeGit: { hasHead: true, hasUpstream: true },
    repoId: '/fixture', repoName: 'acme-webapp', repositories: [{ id: '/fixture', name: 'acme-webapp' }],
    headName: 'feat/session-refresh', headHash: h('2'), branches: ['main', 'feat/session-refresh'],
    conflicts: [], workingTreeCount: 0, stagedCount: 0, mergeHead: false, rebasing: false, canMerge: true, canAbort: true,
    workingTreeFiles: [], branchList: [], graph: graphOf(base, h('2')), ...over
});
const files = ['src/auth/middleware.ts', 'src/session/refresh.ts'].map(p => ({ path: p, status: '已修改', untracked: false }));
const working = snap({ workingTreeCount: 2, stagedCount: 2, workingTreeFiles: files });
const committed = [commit('1', 'Add session refresh tests', 0, 'You', 0, ['feat/session-refresh']), ...base.map(n => ({ ...n, badges: n.id === h('2') ? [] : n.badges }))];
const afterCommit = snap({ headHash: h('1'), graph: graphOf(committed, h('1')) });
const lena = [commit('6', 'Read sessions with the current key', 1, 'Lena', 6, ['main']), commit('7', 'Rotate session keys', 1, 'Lena', 18)];
const conflictGraph = graphOf([committed[0], ...lena, ...committed.slice(1)], h('1'));
conflictGraph.nodes = conflictGraph.nodes.map(n => lena.some(l => l.id === n.id) ? { ...n, role: 'conflict' } : n);
const hunk = { start: 14, end: 22, current: 'return refresh(session);', incoming: 'return verify(session, keys.current);', currentLabel: 'HEAD', incomingLabel: 'main' };
const conflicted = snap({ headHash: h('1'), mergeHead: true, graph: conflictGraph,
    conflicts: ['src/auth.ts', 'src/middleware.ts'].map(p => ({ path: p, status: '双方修改', hunks: [hunk] })) });

async function open(reducedMotion) {
    const page = await browser.newPage({ viewport: { width: 900, height: 760 }, reducedMotion });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent('<html lang="zh-Hans"><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>');
    await page.addStyleTag({ path: path.join(root, 'media/main.css') });
    if (process.env.GENERATIVE_GIT_UI_FONT) {
        const font = (await readFile(process.env.GENERATIVE_GIT_UI_FONT)).toString('base64');
        await page.addStyleTag({ content: `@font-face{font-family:"Noto Sans SC";src:url(data:font/ttf;base64,${font})} :root{--vscode-font-family:"Noto Sans SC",sans-serif}` });
    }
    await page.evaluate(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.sent.push(m) }); });
    await page.addScriptTag({ path: path.join(root, 'dist/webview.js') });
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 3000 });
    const frame = name => page.screenshot({ path: path.join(artifacts, `${name}.png`), clip: { x: 80, y: 60, width: 740, height: 600 } });
    return { page, errors, send, until, frame };
}

try {
    const { page, errors, send, until, frame } = await open('no-preference');
    const settled = () => until(() => !document.querySelector('#app .m-enter, #app .m-exit, #app [data-exiting], #graph.is-entering'));
    await send({ type: 'hydrate', snapshot: working });
    await frame('1-working');
    const kept = await page.locator(`.commit-row[data-key="r:${h('2')}"]`).elementHandle();

    // Commit lands while the first-appearance cascade is still running: the ghost row leaves,
    // one new row enters with its own motion, existing rows are the same elements.
    await send({ type: 'commit-result', ok: true, hash: h('1') });
    await send({ type: 'snapshot', snapshot: afterCommit });
    assert.equal(await page.locator('#graph.is-entering').count(), 1, 'fixture inserts during the cascade');
    assert.equal(await kept.evaluate(el => el.isConnected), true, 'existing row element is reused, not rebuilt');
    assert.equal(await page.locator('.commit-row.m-enter').count(), 1, 'only the new commit row enters');
    // Regression: #graph.is-entering .commit-row outranked .commit-row.m-enter and hid the insert motion.
    assert.match(await page.locator('.commit-row.m-enter').evaluate(el => getComputedStyle(el).animationName), /row-insert.*row-glow/);
    assert.equal(await page.locator('.commit-row[data-exiting]').count(), 1, 'ghost row fades out');
    await until(() => document.querySelector('.commit-row.m-sweep'));
    await frame('2-commit');
    await settled();
    assert.equal(await page.locator('[data-exiting]').count(), 0, 'exited rows are removed');

    // main moved: two rows inserted mid-graph push older rows, nodes and edges down by transition.
    await send({ type: 'live-result', kind: 'ok' });
    await send({ type: 'snapshot', snapshot: conflicted });
    assert.equal(await page.locator('.commit-row.m-enter').count(), 2, 'incoming commits enter');
    assert.equal(await kept.evaluate(el => el.isConnected), true, 'row survives the conflict snapshot');
    const running = selector => page.locator(selector).evaluateAll(els => els.flatMap(el => el.getAnimations().map(a => a.transitionProperty || a.animationName)));
    assert.ok((await kept.evaluate(el => el.getAnimations().map(a => a.transitionProperty))).includes('transform'), 'older rows slide via transform');
    assert.ok((await running(`.node[data-key="n:${h('2')}"]`)).includes('transform'), 'graph node slides with its row');
    assert.ok((await running('.edge')).includes('d'), 'edges interpolate their path');
    await frame('3-conflict');
    await settled();
    // Regression: a lingering #graph.is-entering replayed the cascade once m-enter was removed.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.locator('.commit-row').evaluateAll(els => els.filter(el => getComputedStyle(el).opacity !== '1').length), 0,
        'rows stay visible after their motion class is removed');

    // The footer main action is one keyed slot that turns busy in place.
    assert.equal(await page.locator('[data-key="main-action"]').getAttribute('data-action'), 'show-conflicts');
    await page.locator('[data-action="show-conflicts"]').click();
    await page.locator('[data-action="resolve"][data-strategy="both"]').click();
    const busy = page.locator('[data-key="main-action"]');
    assert.equal(await busy.evaluate(el => el.classList.contains('is-busy') && el.disabled), true);
    await frame('4-resolving');

    // Narrative streams by word and is not replayed when its text is unchanged.
    assert.ok(await page.locator('#task-explanation .narrative-word').count() > 3, 'narrative is split into words');
    const narrative = await page.locator('#task-explanation .narrative').elementHandle();
    await send({ type: 'notice', level: 'info', text: 'unrelated' });
    assert.equal(await narrative.evaluate(el => el.isConnected), true, 'unchanged narrative is not replayed');
    assert.deepEqual(errors, []);
    await page.close();

    // Reduced motion (read at load): no motion classes, exits are immediate, narrative is plain text.
    const reduced = await open('reduce');
    await reduced.send({ type: 'hydrate', snapshot: working });
    await reduced.send({ type: 'commit-result', ok: true, hash: h('1') });
    await reduced.send({ type: 'snapshot', snapshot: afterCommit });
    assert.equal(await reduced.page.locator('.m-enter, .m-exit, .m-sweep, [data-exiting]').count(), 0);
    assert.equal(await reduced.page.locator('#task-explanation .narrative-word').count(), 0);
    assert.equal(await reduced.page.locator('.commit-row').count(), committed.length, 'ghost row removed at once');
    assert.deepEqual(reduced.errors, []);
    console.log(`Motion regression passed. Frames: ${artifacts}`);
} finally { await browser.close(); }
