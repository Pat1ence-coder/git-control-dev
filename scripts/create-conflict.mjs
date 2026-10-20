import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'generative-git-conflict-'));
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-b', 'main'); git('config', 'user.name', 'Generative Git Fixture'); git('config', 'user.email', 'fixture@example.invalid');
await mkdir(join(dir, 'src'));
await writeFile(join(dir, 'src/checkout.ts'), 'export function total(price: number) {\n  return price;\n}\n'); git('add', '.'); git('commit', '-m', 'feat: add checkout');
git('checkout', '-b', 'feature/discount');
await writeFile(join(dir, 'src/checkout.ts'), 'export function total(price: number, discount = 0) {\n  return price - discount;\n}\n'); git('commit', '-am', 'feat: add discount');
git('checkout', 'main');
await writeFile(join(dir, 'src/checkout.ts'), 'export function total(price: number) {\n  return Math.round(price * 1.08);\n}\n'); git('commit', '-am', 'fix: include tax');
try { git('merge', 'feature/discount'); } catch (error) { if (!git('diff', '--name-only', '--diff-filter=U').trim()) throw error; }
console.log(`已创建独立的冲突测试仓库。请在 Extension Development Host 中打开：\n${dir}`);
