// Optional real-browser regression. Uses a local Playwright installation; no downloads.
// GENERATIVE_GIT_PLAYWRIGHT may point to its index.mjs; PLAYWRIGHT_BROWSERS_PATH selects local browsers.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.GENERATIVE_GIT_PLAYWRIGHT || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = path.resolve(process.env.GENERATIVE_GIT_UI_ARTIFACTS || path.join(root, '../.tmp/thread-ui-rewrite'));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.GENERATIVE_GIT_CHROMIUM });
const errors = [], requests = [];
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
const hash = 'a'.repeat(40), other = 'b'.repeat(40);
const snapshot = {
    writeToken: 'e'.repeat(48), nativeGit: { hasHead: true, hasUpstream: true },
    repoId: '/fixture', repoName: 'acme-webapp', repositories: [{ id: '/fixture', name: 'acme-webapp' }],
    headName: 'feat/session-refresh', headHash: hash, branches: ['main', 'feat/session-refresh'],
    conflicts: [], workingTreeCount: 3, stagedCount: 1, mergeHead: false, rebasing: false, canMerge: true, canAbort: true,
    workingTreeFiles: ['src/auth/middleware.ts', 'src/session/refresh.ts', 'tests/session.test.ts'].map((p, i) => ({ path: p, status: i === 2 ? '未跟踪' : '已修改', untracked: i === 2 })),
    branchList: [{ name: 'feat/session-refresh', ref: 'refs/heads/feat/session-refresh', local: true, current: true, ahead: 2, behind: 1 }],
    graph: { laneCount: 2,
        nodes: ['Refresh sessions in the auth middleware', 'Add session refresh tests', 'Read sessions with the current key', 'Rotate session keys', 'Refresh sessions near expiry', 'Read session expiry from the token'].map((title, i) => ({
            id: i === 0 ? hash : `${i}`.repeat(40), hash: i === 0 ? hash.slice(0, 7) : `${i}`.repeat(7), title, lane: i === 2 || i === 3 ? 1 : 0,
            row: i, badges: i === 0 ? ['feat/session-refresh'] : i === 2 ? ['main'] : [], role: 'commit', tip: i === 0,
            author: i % 2 ? 'Lena' : 'You', authorDate: new Date(Date.now() - (i + 1) * 60_000).toISOString()
        })),
        edges: Array.from({ length: 5 }, (_, i) => ({ id: `edge-${i}`, from: i === 0 ? hash : `${i}`.repeat(40), to: `${i + 1}`.repeat(40), style: 'solid' }))
    }
};
const context = { repoId: snapshot.repoId, headName: snapshot.headName, headHash: hash };
const pr = { kind: 'ok', pullRequest: { number: 128, title: 'Refresh sessions in the auth middleware', state: 'open',
    url: 'https://github.com/acme/webapp/pull/128', headSha: hash, headRef: snapshot.headName, baseRef: 'main',
    checks: [{ name: 'Tests', status: 'completed', conclusion: 'success' }, { name: 'Preview', status: 'in_progress' }] } };
const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
try {
    await page.setContent('<html lang="zh-Hans"><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>');
    await page.addStyleTag({ path: path.join(root, 'media/main.css') });
    if (process.env.GENERATIVE_GIT_UI_FONT) {
        const font = (await readFile(process.env.GENERATIVE_GIT_UI_FONT)).toString('base64');
        await page.addStyleTag({ content: `@font-face{font-family:"Noto Sans SC";src:url(data:font/ttf;base64,${font})} :root{--vscode-font-family:"Noto Sans SC",sans-serif}` });
        await page.evaluate(() => document.fonts.load('13px "Noto Sans SC"'));
    }
    await page.evaluate(() => {
        window.sent = [];
        window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message) });
    });
    await page.addScriptTag({ path: path.join(root, 'dist/webview.js') });
    assert.equal(await page.locator('.graph-skeleton').count(), 1);
    await send({ type: 'hydrate', snapshot });
    await send({ type: 'pull-request', context, state: pr });
    await page.locator('#quick-message').fill('Keep the session fresh');
    await page.screenshot({ path: path.join(artifacts, 'thread-pr.png'), fullPage: true, animations: 'disabled' });
    const rowHeight = await page.locator('.commit-row').first().evaluate(el => el.getBoundingClientRect().height);
    assert.equal(rowHeight, 30);
    assert.equal(await page.locator('.commit-row').nth(1).evaluate(el => getComputedStyle(el).animationDelay), '0.016s');
    await page.locator('[data-action="native-push"]').click();
    assert.match(await page.locator('#native-confirm').innerText(), /原生 Git/);
    await page.screenshot({ path: path.join(artifacts, 'thread-handoff.png'), animations: 'disabled' });
    await page.locator('[data-action="native-go"]').click();
    assert.equal(await page.evaluate(() => window.sent.at(-1).type), 'native-git');
    assert.equal(await page.evaluate(() => window.sent.at(-1).action), 'push');
    await send({ type: 'native-git-result', action: 'push', context, requestToken: snapshot.writeToken, kind: 'returned', text: '原生 Push 流程已返回，请核对状态。' });
    await page.locator('#quick-message').press('Enter');
    assert.equal(await page.evaluate(() => window.sent.at(-1).type), 'review-staged');
    const requestId = await page.evaluate(() => window.sent.at(-1).requestId);
    await send({ type: 'staged-review', requestId, review: { repoId: snapshot.repoId, headName: snapshot.headName,
        token: 'd'.repeat(64), merge: false, files: [{ path: 'src/session/refresh.ts', status: '已修改' }],
        patch: '--- a/refresh.ts\n+++ b/refresh.ts\n@@ -1 +1 @@\n-old\n+new', truncated: false, suggestedMessage: 'wrong draft', unstagedCount: 3 } });
    assert.equal(await page.locator('[data-action="commit-message"]').inputValue(), 'Keep the session fresh');
    assert.equal(await page.evaluate(() => window.sent.some(m => m.type === 'commit-staged')), false);
    await page.locator('[data-action="collapse-task"]').click();
    const conflict = { ...snapshot, mergeHead: true, conflicts: [{ path: 'src/auth/middleware.ts', status: '双方修改',
        hunks: [{ start: 14, end: 22, current: 'return refresh(session);', incoming: 'return verify(session, keys.current);',
            currentLabel: 'HEAD', incomingLabel: 'main', currentAuthor: 'You <&>', incomingAuthor: 'Lena "Park"' }] }] };
    await send({ type: 'snapshot', snapshot: conflict });
    await page.locator('.conflict-trigger').hover();
    await page.locator('#conflict-popover').waitFor({ state: 'visible' });
    await page.locator('#conflict-popover').hover();
    assert.equal(await page.locator('#conflict-popover').isVisible(), true);
    assert.match(await page.locator('#conflict-popover').innerText(), /You <&>/);
    await page.screenshot({ path: path.join(artifacts, 'thread-conflict.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.conflict-trigger').click();
    await page.mouse.move(10, 10);
    assert.equal(await page.locator('#conflict-popover').isVisible(), true, 'click pins the hovered summary');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#conflict-popover').count(), 0);
    await page.locator('#quick-message').focus();
    await page.locator('.conflict-trigger').focus();
    await page.locator('#conflict-popover').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#conflict-popover').count(), 0);
    await page.locator('[data-action="show-conflicts"]').click();
    await page.locator('.conflict-block').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 380, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'narrow viewport must not overflow');
    await page.screenshot({ path: path.join(artifacts, 'thread-narrow.png'), fullPage: true, animations: 'disabled' });
    const animations = await page.locator('#task-card').evaluate(el => getComputedStyle(el).animationName);
    assert.equal(animations, 'none');
    await send({ type: 'snapshot', snapshot: { ...snapshot, headHash: other, headName: 'main' } });
    await send({ type: 'pull-request', context, state: pr });
    assert.equal(await page.locator('#pr-checks').innerText(), '');
    assert.equal(await page.locator('#quick-message').inputValue(), '');
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, [], 'the webview must not make external requests');
    console.log(`Browser regression passed. Screenshots: ${artifacts}`);
} finally { await browser.close(); }
