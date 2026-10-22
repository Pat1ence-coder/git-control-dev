// Dev-only static server for the thread UI preview (dist/preview.js + media/thread.css).
// Usage: npm run compile && node scripts/preview.mjs   (PORT defaults to 43127)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 43127;
const page = `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none';"><title>Generative Git · thread preview</title>
<link rel="stylesheet" href="/media/thread.css"><style>
body{margin:0;background:#fff;font:12px system-ui,sans-serif}
#bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:6px;align-items:center;padding:8px 12px;background:#fafafa;border-top:1px solid #eee;z-index:20}
#bar select{max-width:280px} body.is-static #bar{display:none}
#stage{padding:24px 16px 80px}
</style></head><body><div id="stage"></div><div id="bar"></div><script src="/dist/preview.js"></script></body></html>`;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
    const allowed = ['/dist/preview.js', '/media/thread.css'];
    if (!allowed.includes(url.pathname)) { res.writeHead(404); res.end(); return; }
    try {
        const file = path.join(root, url.pathname);
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1', () => console.log(`thread preview: http://127.0.0.1:${port}/`));
