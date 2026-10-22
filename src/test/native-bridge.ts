import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNativeGit } from '../git/nativeGitBridge';
import { nativeGitActions, asHostMessage } from '../shared/protocol';
import type { WriteGuard } from '../git/types';
import * as host from './vscode';

test('SCM bridge preserves action, exact repository and honest completion semantics', async t => {
    const execute = host.commands.executeCommand, registry = host.commands.getCommands, warning = host.window.showWarningMessage;
    const rootUri = host.Uri.file('/second-repository');
    let calls: unknown[][] = [], refreshes = 0, checks = 0, failCheck = 0, failRefresh = false;
    const guard: WriteGuard = {
        assertCurrent() {},
        repo: { rootUri, state: { HEAD: { type: 0, name: 'feature', commit: 'a'.repeat(40) } },
            status: async () => { refreshes++; if (failRefresh) throw new Error('status failed'); } } as any,
        check: async () => { if (++checks === failCheck) throw new Error('stale repository'); }
    };
    const reset = () => {
        calls = []; checks = 0; refreshes = 0; failCheck = 0; failRefresh = false;
        host.commands.getCommands = async () => nativeGitActions.map(a => `git.${a}`);
        host.commands.executeCommand = async (...args) => { calls.push(args); };
        host.window.showWarningMessage = async (_m, _o, first) => first;
    };
    try {
        for (const action of nativeGitActions) await t.test(`${action} dispatches only its native command with root URI`, async () => {
            reset();
            const result = await runNativeGit(action, guard);
            assert.deepEqual(calls, [[`git.${action}`, rootUri]]);
            assert.equal(result.kind, 'returned');
            assert.doesNotMatch(result.text, /成功|已推送|已同步/);
            assert.equal(refreshes, 1);
        });
        await t.test('confirmation cancellation performs no native operation', async () => {
            reset(); host.window.showWarningMessage = async () => undefined;
            assert.equal((await runNativeGit('push', guard)).kind, 'cancelled');
            assert.deepEqual(calls, []);
        });
        await t.test('missing command offers SCM without a different Git command or prompt', async () => {
            reset(); host.commands.getCommands = async () => ['git.sync'];
            host.window.showWarningMessage = async () => { throw new Error('must not confirm unavailable command'); };
            assert.equal((await runNativeGit('push', guard)).kind, 'unavailable');
            assert.deepEqual(calls, []);
        });
        await t.test('repository changes during registry lookup or confirmation stop dispatch', async () => {
            for (const check of [2, 3]) {
                reset(); failCheck = check;
                await assert.rejects(() => runNativeGit('push', guard), /stale repository/);
                assert.deepEqual(calls, []);
            }
        });
        await t.test('throwing native command may have partially executed; external text stays hidden', async () => {
            reset(); host.commands.executeCommand = async () => { throw new Error('https://user:secret@example.invalid/private'); };
            const result = await runNativeGit('push', guard);
            assert.equal(result.kind, 'error');
            assert.match(result.text, /部分变化/);
            assert.doesNotMatch(result.text, /secret|example.invalid/);
            assert.equal(refreshes, 1);
        });
        await t.test('refresh failure is not presented as a failed or cancelled transport', async () => {
            reset(); failRefresh = true;
            const result = await runNativeGit('pull', guard);
            assert.equal(result.kind, 'returned');
            assert.match(result.text, /刷新失败/);
            assert.equal(calls.length, 1);
        });
        await t.test('pending native command remains pending with no automatic retry', async () => {
            reset(); let release!: () => void, finished = false;
            host.commands.executeCommand = async (...args) => { calls.push(args); await new Promise<void>(r => { release = r; }); };
            const pending = runNativeGit('fetch', guard).then(() => { finished = true; });
            for (let n = 0; n < 10; n++) await Promise.resolve();
            assert.equal(finished, false); assert.equal(calls.length, 1);
            release(); await pending;
        });
        await t.test('no arbitrary command or force action is accepted', async () => {
            reset();
            await assert.rejects(() => runNativeGit('pushForce' as any, guard));
            assert.deepEqual(calls, []);
        });
    } finally { host.commands.executeCommand = execute; host.commands.getCommands = registry; host.window.showWarningMessage = warning; }
});

test('write protocol requires bounded host context and token, strips execution arguments', () => {
    const ticket = { context: { repoId: '/repo', headName: 'main', headHash: 'a'.repeat(40) }, writeToken: 'b'.repeat(48) };
    for (const type of ['merge', 'stage', 'resolve', 'abort-merge', 'native-stage-conflicts', 'stage-working-change', 'commit-staged', 'native-git'])
        assert.equal(asHostMessage({ type, ref: 'main', path: 'f', action: 'push' }), undefined);
    assert.equal(asHostMessage({ type: 'native-git', action: 'pushForce', ...ticket }), undefined);
    assert.equal(asHostMessage({ type: 'native-git', action: '__proto__', ...ticket }), undefined);
    assert.equal(asHostMessage({ type: 'native-git', action: 'push', ...ticket, writeToken: 'x'.repeat(49) }), undefined);
    assert.deepEqual(asHostMessage({ type: 'native-git', action: 'push', ...ticket, command: 'git.pushForce', remote: 'evil', force: true }),
        { type: 'native-git', action: 'push', ...ticket });
    assert.equal(asHostMessage({ type: 'commit-staged', repoId: '/other', token: 'a'.repeat(64), message: 'x', ...ticket }), undefined);
});
