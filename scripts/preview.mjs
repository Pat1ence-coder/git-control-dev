import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 43127);
const html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generative Git · Preview</title><link rel="stylesheet" href="/media/main.css"><style>.preview-nav{display:flex;justify-content:center;align-items:center;gap:16px;padding:12px;color:var(--muted);font-size:11px;background:var(--soft)}#shell{width:1240px;max-width:100%;margin:0 auto}#shell.wide{width:400px;border:1px solid var(--border)}</style></head><body><nav class="preview-nav"><span>浏览器预览 · 仅模拟数据</span><button id="width">切换窄栏</button><button id="theme">切换深色</button></nav><div id="shell"><div id="app"></div></div><script>document.getElementById('width').onclick=()=>document.getElementById('shell').classList.toggle('wide');document.getElementById('theme').onclick=()=>document.body.classList.toggle('preview-dark')</script><script src="/dist/webview.js"></script></body></html>`;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
  const allowed = new Map([['/dist/webview.js','text/javascript'],['/dist/webview.js.map','application/json'],['/media/main.css','text/css']]);
  if (!allowed.has(url.pathname)) { res.writeHead(404); res.end('Not found'); return; }
  try { const data = await readFile(path.join(root, url.pathname)); res.writeHead(200, { 'Content-Type': allowed.get(url.pathname) + '; charset=utf-8' }); res.end(data); } catch { res.writeHead(404); res.end('Run npm run compile first.'); }
}).listen(port, '127.0.0.1', () => console.log(`Generative Git preview: http://localhost:${port}`));
