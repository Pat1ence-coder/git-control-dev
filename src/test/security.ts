import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { GitMetadata } from '../git/metadata';
import { describeGitError, UserFacingError } from '../git/errors';
import { ResolutionSafety } from '../git/safety';
import type { Repository } from '../git/types';
import * as host from './vscode';

test('external Git and filesystem errors never expose stderr, credentials, URLs or local paths', () => {
    const secret = 'fixture-secret-do-not-display';
    const text = `fatal: https://user:${secret}@example.invalid/repo?access_token=${secret}\nAuthorization: Bearer ${secret}\n/home/private/person/repo\nC:\\Users\\Person\\repo`;
    for (const error of [
        { gitErrorCode: 'AuthenticationFailed', stderr: text },
        { gitErrorCode: `unknown-${secret}`, stderr: text, message: text },
        { code: 'ENOENT', message: text },
        new Error(text), text, { toString: () => text }
    ]) {
        const result = describeGitError(error);
        for (const value of [secret, 'example.invalid', '/home/private', 'C:\\Users', 'Authorization'])
            assert.ok(!result.includes(value), value);
        assert.ok(result.length < 200);
    }
    assert.match(describeGitError({ gitErrorCode: 'AuthenticationFailed', stderr: text }), /认证失败/);
    assert.equal(describeGitError(new UserFacingError('请重新加载审查。')), '请重新加载审查。');
});

test('metadata validation rejects unrelated gitdirs, links and replaced identities', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-metadata-'));
    const root = path.join(temp, 'work'), common = path.join(temp, 'common');
    const marker = path.join(root, '.git');
    const repo = {
        rootUri: host.Uri.file(root), getConfig: async () => { throw new Error('unset'); }
    } as unknown as Repository;
    await fs.mkdir(root); await fs.mkdir(common);
    try {
        await t.test('arbitrary external directory is not accepted as this repository', async () => {
            await fs.writeFile(marker, `gitdir: ${common}\n`);
            await assert.rejects(() => new GitMetadata().identity(repo), /无法确认外部 Git 元数据/);
        });
        await t.test('proper worktree association is accepted; changing its pointer is rejected', async () => {
            const first = path.join(common, 'worktrees', 'one'), second = path.join(common, 'worktrees', 'two');
            for (const dir of [first, second]) {
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, 'gitdir'), marker + '\n');
                await fs.writeFile(path.join(dir, 'commondir'), '../..\n');
            }
            await fs.writeFile(marker, `gitdir: ${first}\n`);
            const metadata = new GitMetadata();
            assert.equal((await metadata.identity(repo)).directory, first);
            await fs.writeFile(marker, `gitdir: ${second}\n`);
            await assert.rejects(() => metadata.identity(repo), /目录已变化/);
        });
        await t.test('a submodule-style core.worktree association must resolve to the same root', async () => {
            await fs.writeFile(marker, `gitdir: ${common}\n`);
            const previous = repo.getConfig;
            repo.getConfig = async () => '../work';
            try {
                assert.equal((await new GitMetadata().identity(repo)).directory, common);
                repo.getConfig = async () => '../other';
                await fs.mkdir(path.join(temp, 'other'));
                await assert.rejects(() => new GitMetadata().identity(repo), /无法确认外部/);
            } finally { repo.getConfig = previous; }
        });
        await t.test('directory replacement at the same path invalidates the pinned identity', async () => {
            await fs.unlink(marker); await fs.mkdir(marker);
            const metadata = new GitMetadata();
            await metadata.identity(repo);
            await fs.rename(marker, path.join(root, 'old-metadata'));
            await fs.mkdir(marker);
            await assert.rejects(() => metadata.identity(repo), /目录已变化/);
        });
        await t.test('metadata symlinks cannot read unrelated files', async () => {
            const secretFile = path.join(temp, 'sensitive.txt');
            await fs.writeFile(secretFile, 'private metadata fixture');
            await fs.symlink(secretFile, path.join(marker, 'MERGE_MSG'));
            await assert.rejects(() => new GitMetadata().read(repo, 'MERGE_MSG'), /元数据文件不安全/);
            await fs.rm(marker, { recursive: true });
            await fs.symlink(path.join(root, 'old-metadata'), marker);
            await assert.rejects(() => new GitMetadata().identity(repo), /符号链接替换/);
        });
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('backup cleanup requires confirmation and only deletes this extension backup records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-cleanup-'));
    const safety = new ResolutionSafety(host.Uri.file(root) as any);
    const warn = host.window.showWarningMessage;
    try {
        await safety.backup(host.Uri.file('/repo/file.ts') as any, 'private original\n');
        await fs.writeFile(path.join(root, 'unrelated.txt'), 'keep');
        host.window.showWarningMessage = async () => undefined;
        await safety.clearBackups();
        assert.equal((await fs.readdir(root)).length, 2);
        host.window.showWarningMessage = async (_message, _options, ...items) => items[0];
        await safety.clearBackups();
        assert.deepEqual(await fs.readdir(root), ['unrelated.txt']);
        assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'keep');
    } finally { host.window.showWarningMessage = warn; safety.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
