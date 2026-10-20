import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeCommit } from '../git/nativeGit';
import type { Repository } from '../git/types';
import * as host from './vscode';

test('native commit routes through official checks and verifies the outcome', async t => {
    const execute = host.commands.executeCommand, getCommands = host.commands.getCommands;
    const committed = new host.EventEmitter<void>();
    const before = 'a'.repeat(40), after = 'b'.repeat(40);
    const repo = {
        rootUri: host.Uri.file('/repo'), onDidCommit: committed.event,
        inputBox: { value: 'existing SCM draft' }, state: { HEAD: { commit: before } },
        status: async () => {},
        getCommit: async () => ({ hash: after, parents: [before] }),
        commit: async () => { throw new Error('must never fall back to the lower-level commit API'); }
    } as unknown as Repository;
    const reset = () => { repo.state.HEAD!.commit = before; repo.inputBox.value = 'existing SCM draft'; };
    try {
        await t.test('passes exact repository and null post-command, with SCM input set before execution', async () => {
            reset();
            host.commands.executeCommand = async (command, ...args) => {
                assert.equal(command, 'git.commit');
                assert.equal(args[0], repo.rootUri);
                assert.equal(args[1], null);
                assert.equal(repo.inputBox.value, 'reviewed message');
                repo.state.HEAD!.commit = after; committed.fire();
                repo.inputBox.value = '';
            };
            assert.equal(await nativeCommit(repo, 'reviewed message'), after);
            assert.equal(repo.inputBox.value, '');
        });
        await t.test('cancelled native flow does not report success or erase the previous SCM draft', async () => {
            reset(); host.commands.executeCommand = async () => {};
            await assert.rejects(() => nativeCommit(repo, 'reviewed message'), /未产生可确认/);
            assert.equal(repo.inputBox.value, 'existing SCM draft');
        });
        await t.test('a failed Git operation can emit onDidCommit without creating a commit', async () => {
            reset(); host.commands.executeCommand = async () => { committed.fire(); };
            await assert.rejects(() => nativeCommit(repo, 'reviewed message'), /未产生可确认/);
        });
        await t.test('external HEAD changes without a native commit event are not reported as our success', async () => {
            reset(); host.commands.executeCommand = async () => { repo.state.HEAD!.commit = after; };
            await assert.rejects(() => nativeCommit(repo, 'reviewed message'), /未产生可确认/);
        });
        await t.test('user edits to SCM input during the official flow are preserved on cancellation', async () => {
            reset(); host.commands.executeCommand = async () => { repo.inputBox.value = 'new user draft'; };
            await assert.rejects(() => nativeCommit(repo, 'reviewed message'), /未产生可确认/);
            assert.equal(repo.inputBox.value, 'new user draft');
        });
        await t.test('missing official command refuses the operation without an API fallback', async () => {
            reset(); host.commands.getCommands = async () => [];
            await assert.rejects(() => nativeCommit(repo, 'reviewed message'), /未提供 git.commit/);
            assert.equal(repo.inputBox.value, 'existing SCM draft');
        });
    } finally {
        host.commands.executeCommand = execute; host.commands.getCommands = getCommands; committed.dispose();
    }
});
