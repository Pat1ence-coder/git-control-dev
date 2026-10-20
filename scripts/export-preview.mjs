import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = await readFile(path.join(root, 'media/main.css'), 'utf8');
const js = (await readFile(path.join(root, 'dist/webview.js'), 'utf8')).replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Generative Git · 工作台预览</title><style>${css}\nbody{color-scheme:light}</style></head><body><div id="app"></div><script>${js}</script></body></html>`;
await writeFile(path.join(root, 'preview.html'), html);
console.log('Exported preview.html — open locally in a browser.');
