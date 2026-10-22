import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git/gitService';
import type { Repository } from '../git/types';
import * as host from './vscode';

test('write guard pins repository, metadata, HEAD and originating host across awaits', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-write-guard-'));
    const events = new host.EventEmitter<void>();
    const hash = 'a'.repeat(40), source = 'b'.repeat(40);
    const merged: string[] = [];
    const makeRepo = async (name: string): Promise<Repository> => {
        const root = path.join(dir, name);
        await fs.mkdir(path.join(root, '.git'), { recursive: true });
        await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        return {
            rootUri: host.Uri.file(root), state: { HEAD: { name: 'main', type: 0, commit: hash }, refs: [],
                mergeChanges: [], indexChanges: [], workingTreeChanges: [], onDidChange: events.event },
            status: async () => {}, getCommit: async (ref: string) => ({ hash: ref === 'HEAD' ? hash : source, parents: [], message: '' }),
            getBranches: async () => [{ type: 0, name: 'topic', commit: source }],
            merge: async (ref: string) => { merged.push(`${name}:${ref}`); }
        } as unknown as Repository;
    };
    const a = await makeRepo('A'), b = await makeRepo('B');
    const ctx = { repoId: a.rootUri.fsPath, headName: 'main', headHash: hash };
    const api = { repositories: [a, b], getRepository: (uri: host.Uri) => api.repositories.find(r => r.rootUri.fsPath === uri.fsPath) ?? null };
    const service = new GitService({ get: () => a.rootUri.fsPath, update: async () => {} } as any, {} as any, {} as any);
    (service as any).api = api;
    const trusted = host.workspace.isTrusted;
    try {
        await t.test('fresh context is accepted', async () => { await (await service.prepareWrite(ctx)).check(); });
        await t.test('selected A closing never writes to fallback B', async () => {
            const guard = await service.prepareWrite(ctx);
            api.repositories = [b];
            try {
                await assert.rejects(() => guard.check(), /上下文/);
                await assert.rejects(() => service.prepareWrite(ctx), /原仓库/);
                await assert.rejects(() => service.merge('topic'), /原仓库/);
                assert.deepEqual(merged, []);
            } finally { api.repositories = [a, b]; }
        });
        await t.test('a lookup resolving to another root cannot reach a native command', async () => {
            const lookup = api.getRepository;
            api.getRepository = () => b;
            try { await assert.rejects(() => service.prepareWrite(ctx), /上下文/); }
            finally { api.getRepository = lookup; }
        });
        await t.test('switch away and back invalidates an in-flight guard', async () => {
            const guard = await service.prepareWrite(ctx);
            await service.select(b.rootUri.fsPath); await service.select(a.rootUri.fsPath);
            await assert.rejects(() => guard.check(), /上下文/);
        });
        await t.test('changed commit is caught even with stale model HEAD', async () => {
            const guard = await service.prepareWrite(ctx), get = a.getCommit;
            a.getCommit = async () => ({ hash: 'c'.repeat(40), parents: [], message: '' });
            try { await assert.rejects(() => guard.check(), /HEAD/); }
            finally { a.getCommit = get; }
        });
        await t.test('same-commit branch switch is caught from actual HEAD metadata', async () => {
            const guard = await service.prepareWrite(ctx), head = path.join(a.rootUri.fsPath, '.git', 'HEAD');
            await fs.writeFile(head, 'ref: refs/heads/other\n');
            try { await assert.rejects(() => guard.check(), /HEAD/); }
            finally { await fs.writeFile(head, 'ref: refs/heads/main\n'); }
        });
        await t.test('workspace trust and originating view are rechecked', async () => {
            let active = true;
            const guard = await service.prepareWrite(ctx, () => { if (!active) throw new Error('view closed'); });
            active = false;
            await assert.rejects(() => guard.check(), /view closed/);
            active = true; host.workspace.isTrusted = false;
            try {
                await assert.rejects(() => guard.check(), /上下文/);
                await assert.rejects(() => service.prepareWrite(ctx), /信任/);
            } finally { host.workspace.isTrusted = trusted; }
        });
        await t.test('source revision changes reject merge; accepted source is passed as OID', async () => {
            const guard = await service.prepareWrite(ctx);
            await assert.rejects(() => service.merge('topic', guard, 'd'.repeat(40)), /待合并分支已变化/);
            assert.deepEqual(merged, []);
            await service.merge('topic', guard, source);
            assert.deepEqual(merged, [`A:${source}`]);
        });
        await t.test('replacing the Git directory invalidates an existing guard', async () => {
            const guard = await service.prepareWrite(ctx), meta = path.join(a.rootUri.fsPath, '.git');
            await fs.rename(meta, meta + '.old'); await fs.mkdir(meta);
            await fs.writeFile(path.join(meta, 'HEAD'), 'ref: refs/heads/main\n');
            await assert.rejects(() => guard.check(), /元数据目录已变化/);
        });
    } finally { host.workspace.isTrusted = trusted; service.dispose(); events.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});
