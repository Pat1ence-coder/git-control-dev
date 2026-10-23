// Run with scripts/test-host.mjs in an actual VS Code/Cursor Extension Host.
// This file intentionally imports the real vscode module, never test/vscode.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { GitService } from '../git/gitService';
import { ResolutionSafety } from '../git/safety';
import type { GitExtension } from '../git/types';
import { runNativeGit } from '../git/nativeGitBridge';
import { repositoryContext, type NativeGitAction } from '../shared/protocol';

export async function run(): Promise<void> {
    const root = process.env.GENERATIVE_GIT_HOST_FIXTURE;
    const resultFile = process.env.GENERATIVE_GIT_HOST_RESULT;
    if (!root || !resultFile) throw new Error('Use scripts/test-host.mjs to create an isolated test workspace.');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trimEnd();
    const output = vscode.window.createOutputChannel('Generative Git host acceptance');
    const safety = new ResolutionSafety(vscode.Uri.file(path.join(path.dirname(root), 'backups')));
    const values = new Map<string, unknown>();
    const state: vscode.Memento = {
        keys: () => [...values.keys()],
        get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
        update: async (key, value) => { values.set(key, value); }
    };
    const service = new GitService(state, output, safety);
    const checks: string[] = [];
    try {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        assert.ok(extension, 'built-in Git extension must be present');
        const api = (await extension.activate()).getAPI(1);
        assert.ok(api.openRepository, 'host API must support explicit repository discovery');
        await api.openRepository(vscode.Uri.file(root));
        await service.init(); await service.select(root); await service.refresh();
        const snapshot = await service.snapshot();
        assert.ok(snapshot?.branches.includes('main'));
        assert.ok(snapshot?.branches.includes('feature'));
        checks.push('real getRefs supplies local branches');

        const config = vscode.workspace.getConfiguration('git', vscode.Uri.file(root));
        assert.equal(config.get('enableCommitSigning'), true);
        assert.equal(config.get('alwaysSignOff'), true);
        assert.equal(config.get('postCommitCommand'), 'push');
        const remote = git('ls-remote', 'origin', 'refs/heads/main'); // local filesystem remote only
        await fs.writeFile(path.join(root, 'file.txt'), 'reviewed staged content\n');
        git('add', '--', 'file.txt');
        await fs.writeFile(path.join(root, 'file.txt'), 'unstaged work stays here\n');
        const review = await service.reviewStaged();
        const hash = await service.commitStaged(root, review.token, 'Native command acceptance');
        assert.equal(hash, git('rev-parse', 'HEAD'));
        assert.equal(git('show', 'HEAD:file.txt'), 'reviewed staged content');
        assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'unstaged work stays here\n');
        checks.push('native command commits the staged version and preserves unstaged work');
        assert.match(git('cat-file', '-p', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/);
        assert.match(git('log', '-1', '--format=%B'), /Signed-off-by: Host Test <host@example.invalid>/);
        checks.push('native signing and sign-off honor editor settings');
        assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), remote);
        checks.push('explicit null suppresses configured post-commit push');

        const second = process.env.GENERATIVE_GIT_HOST_SECOND;
        assert.ok(second, 'second isolated repository required');
        const secondGit = (...args: string[]) => execFileSync('git', ['-C', second, ...args], { encoding: 'utf8' }).trimEnd();
        const secondRepo = await api.openRepository(vscode.Uri.file(second));
        assert.ok(secondRepo);
        await service.select(second); await service.refresh();
        const native = async (action: NativeGitAction) => {
            const snapshot = await service.snapshot(); assert.ok(snapshot);
            const guard = await service.prepareWrite(repositoryContext(snapshot));
            return runNativeGit(action, guard);
        };
        secondGit('checkout', '-b', 'cancel-check'); await secondRepo.status();
        const cancelled = await native('push');
        assert.equal(cancelled.kind, 'cancelled');
        assert.equal(secondGit('ls-remote', 'origin', 'refs/heads/cancel-check'), '');
        checks.push('real custom confirmation cancellation starts no push');
        secondGit('checkout', 'main');
        secondGit('commit', '--allow-empty', '-m', 'second push'); await secondRepo.status();
        const pushed = secondGit('rev-parse', 'HEAD');
        assert.equal((await native('push')).kind, 'returned');
        assert.ok(secondGit('ls-remote', 'origin', 'refs/heads/main').startsWith(pushed));
        assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), remote);
        checks.push('real bridge Push targets second repository only; return is not labeled success');

        const peer = path.join(path.dirname(root), 'peer');
        execFileSync('git', ['clone', secondGit('remote', 'get-url', 'origin'), peer]);
        const peerGit = (...args: string[]) => execFileSync('git', ['-C', peer, ...args], { encoding: 'utf8' }).trimEnd();
        peerGit('config', 'user.name', 'Host Test'); peerGit('config', 'user.email', 'host@example.invalid');
        await fs.writeFile(path.join(peer, 'remote.txt'), 'remote change\n'); peerGit('add', '.');
        peerGit('commit', '-m', 'remote update'); peerGit('push');
        const fetched = peerGit('rev-parse', 'HEAD');
        assert.equal((await native('fetch')).kind, 'returned');
        assert.equal(secondGit('rev-parse', 'origin/main'), fetched);
        assert.equal(secondGit('rev-parse', 'HEAD'), pushed);
        checks.push('real bridge Fetch updates tracking ref without merging working HEAD');
        assert.equal((await native('pull')).kind, 'returned');
        assert.equal(secondGit('rev-parse', 'HEAD'), fetched);
        checks.push('real bridge Pull fast-forwards the selected repository');
        secondGit('commit', '--allow-empty', '-m', 'sync local'); await secondRepo.status();
        const synced = secondGit('rev-parse', 'HEAD');
        assert.equal((await native('sync')).kind, 'returned');
        assert.ok(secondGit('ls-remote', 'origin', 'refs/heads/main').startsWith(synced));
        checks.push('real bridge Sync uses SCM pull/push flow');
        secondGit('checkout', '-b', 'publish-check'); await secondRepo.status();
        assert.equal((await native('publish')).kind, 'returned');
        assert.equal(secondGit('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/publish-check');
        assert.ok(secondGit('ls-remote', 'origin', 'refs/heads/publish-check').startsWith(synced));
        assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), remote);
        checks.push('real bridge Publish creates upstream through SCM and leaves first remote unchanged');

        const closing = await service.snapshot(); assert.ok(closing);
        const closedGuard = await service.prepareWrite(repositoryContext(closing));
        await vscode.commands.executeCommand('git.close', secondRepo.rootUri);
        await assert.rejects(() => closedGuard.check());
        await assert.rejects(() => service.prepareWrite(repositoryContext(closing)));
        assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), remote);
        checks.push('closed selected repository is rejected without falling back to first repository');
        await fs.writeFile(resultFile, JSON.stringify({ ok: true, checks }, null, 2));
    } catch (error) {
        await fs.writeFile(resultFile, JSON.stringify({ ok: false, checks, error: String(error) }, null, 2));
        throw error;
    } finally {
        service.dispose(); safety.dispose(); output.dispose();
    }
}
