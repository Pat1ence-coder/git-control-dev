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
        await fs.writeFile(resultFile, JSON.stringify({ ok: true, checks }, null, 2));
    } catch (error) {
        await fs.writeFile(resultFile, JSON.stringify({ ok: false, checks, error: String(error) }, null, 2));
        throw error;
    } finally {
        service.dispose(); safety.dispose(); output.dispose();
    }
}
