// Only launched by test-host.mjs against its isolated editor debug port.
// Node 22+ is required for the optional built-in WebSocket automation.
import { setTimeout as delay } from 'node:timers/promises';
const port = process.env.GENERATIVE_GIT_HOST_CDP_PORT;
if (!process.env.GENERATIVE_GIT_HOST_FIXTURE || !port || typeof WebSocket !== 'function')
    throw new Error('Isolated fixture and Node 22+ required for dialog automation');
const deadline = Date.now() + 175_000;
let socket, sequence = 0;
const pending = new Map();
const expression = `(() => {
    const dialog = document.querySelector('.monaco-dialog-box');
    if (!dialog || !dialog.getClientRects().length) return '';
    const text = dialog.innerText;
    if (!text.includes('在仓库 second（')) return 'unhandled: ' + text.slice(0, 180);
    const cancel = text.includes('cancel-check');
    const buttons = [...dialog.querySelectorAll('.monaco-button, button')];
    const button = buttons.find(b => (cancel ? /^(Cancel|取消)$/ : /^继续 (Push|Pull|Fetch|Sync|Publish)$/).test(b.textContent.trim()));
    if (!button) return 'unhandled buttons: ' + buttons.map(b => b.textContent).join(',');
    button.click(); return cancel ? 'cancelled' : 'accepted';
})()`;
while (Date.now() < deadline && !socket) {
    try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
        if (!target) { await delay(300); continue; }
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        socket = ws;
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
        };
        socket.onclose = () => { for (const resolve of pending.values()) resolve({}); pending.clear(); };
    } catch { await delay(300); }
}
if (!socket) throw new Error('Isolated editor did not expose a workbench target');
let previous = '';
while (Date.now() < deadline && socket.readyState === WebSocket.OPEN) {
    const id = ++sequence;
    const response = new Promise(resolve => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const message = await response;
    const result = message.result?.result?.value || '';
    if (result && (result !== previous || result === 'accepted')) console.log('Fixture dialog:', result);
    previous = result;
    await delay(150);
}
socket.close();
