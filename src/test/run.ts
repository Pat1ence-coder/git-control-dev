import './launcher';
import './webview';
import './provider';
import './native-git';
import './security';
import './presentation';
import './fixtures';
import './thread';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyResolution, parseConflict, hasConflictMarkers, heuristicMerge } from '../git/conflicts';
import { layoutCommits, withPendingMerge } from '../git/layout';
import { resolveInside } from '../git/paths';
import { isSafeRef } from '../git/safeRef';
import { esc, clipChars } from '../shared/html';
import { asHostMessage } from '../shared/protocol';
import { renderGraph, renderCommitDetail, livePhase } from '../webview/render';
import { GitService } from '../git/gitService';
import { ResolutionSafety } from '../git/safety';
import * as host from './vscode';
import type { Repository, Commit, Change } from '../git/types';

test('conflict backups survive service recreation and reopen as read-only content', async () => {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-recovery-'));
    const register = host.workspace.registerTextDocumentContentProvider;
    const show = host.window.showTextDocument;
    let provider: { provideTextDocumentContent(uri: host.Uri): string } | undefined;
    let recovered: string | undefined;
    host.workspace.registerTextDocumentContentProvider = (_scheme, value) => {
        provider = value as typeof provider; return { dispose() {} };
    };
    host.window.showTextDocument = async uri => { recovered = provider?.provideTextDocumentContent(uri); };
    try {
        const first = new ResolutionSafety(host.Uri.file(storage) as any);
        await first.backup(host.Uri.file('/repo/file.ts') as any, 'original conflict\n');
        first.dispose();
        const reopened = new ResolutionSafety(host.Uri.file(storage) as any);
        await reopened.openBackup();
        assert.equal(recovered, 'original conflict\n');
        reopened.dispose();
    } finally {
        host.workspace.registerTextDocumentContentProvider = register;
        host.window.showTextDocument = show;
        await fs.rm(storage, { recursive: true, force: true });
    }
});
test('all resolution strategies remove complete markers and preserve surrounding text', () => {
    const input = 'before\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\nafter\n';
    assert.equal(applyResolution(input, 'current').text, 'before\nleft\nafter\n');
    assert.equal(applyResolution(input, 'incoming').text, 'before\nright\nafter\n');
    assert.equal(applyResolution(input, 'both').text, 'before\nleft\nright\nafter\n');
    assert.equal(applyResolution(input, 'ai').text, 'before\nleft\nright\nafter\n');
});
test('diff3 base is excluded; CRLF and final newline preserved across multiple hunks', () => {
    const hunk = '<<<<<<< ours\r\na\r\n||||||| base\r\nbase\r\n=======\r\nb\r\n>>>>>>> theirs\r\n';
    assert.equal(parseConflict(hunk).length, 1);
    assert.equal(applyResolution('prefix\r\n' + hunk + 'middle\r\n' + hunk, 'both').text, 'prefix\r\na\r\nb\r\nmiddle\r\na\r\nb\r\n');
    assert.equal(applyResolution(hunk.trimEnd(), 'incoming').text, 'b');
});
test('conflict parser exposes bounded context and real side line numbers', () => {
    const text = ['one', 'two', 'three', '<<<<<<< ours', 'old-a', 'old-b', '=======', 'new-a', 'new-b', '>>>>>>> theirs', 'after-a', 'after-b', 'after-c', 'after-d'].join('\n');
    const [h] = parseConflict(text);
    assert.ok(h);
    assert.deepEqual(h.before, ['one', 'two', 'three']);
    assert.equal(h.beforeStart, 1);
    assert.equal(h.currentStart, 5);
    assert.equal(h.incomingStart, 8);
    assert.deepEqual(h.after, ['after-a', 'after-b', 'after-c']);
    assert.equal(h.afterStart, 11);
});
test('malformed conflict remains detectable; empty side can delete a block', () => {
    const malformed = '<<<<<<< HEAD\nx\n=======\ny';
    assert.equal(applyResolution(malformed, 'ai').applied, false);
    assert.ok(hasConflictMarkers(malformed));
    assert.equal(applyResolution('before\n<<<<<<< HEAD\n=======\nx\n>>>>>>> b\nafter\n', 'current').text, 'before\nafter\n');
});
test('heuristic keeps shared lines once and includes each divergent side', () => {
    assert.equal(heuristicMerge('start\na\nend', 'start\nb\nend'), 'start\na\nb\nend');
});
test('graph handles merges, deduplication and missing parents; pending merge links both tips', () => {
    const graph = layoutCommits([{ hash: 'A', parents: ['B', 'C'], message: 'merge' }, { hash: 'B', parents: ['D'], message: 'main' }, { hash: 'C', parents: ['D'], message: 'feature' }, { hash: 'D', parents: ['outside'], message: 'base' }, { hash: 'a', parents: [], message: 'duplicate' }], 'A');
    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.edges.length, 4);
    assert.equal(graph.nodes[0].role, 'merge');
    assert.ok(graph.nodes[0].tip);
    assert.notEqual(graph.nodes[1].lane, graph.nodes[2].lane);
    const pending = withPendingMerge(graph, 'b', 'c');
    assert.equal(pending.edges.filter(e => e.from === 'pending-merge').length, 2);
    assert.equal(graph.nodes[0].row, 0);
});
test('untrusted paths, refs and messages are rejected', () => {
    for (const p of ['../secret', '/etc/passwd', 'C:\\secret', 'a/../../x', 'a\\..\\x', '\0'])
        assert.throws(() => resolveInside('/repo', p));
    for (const ref of ['--abort', 'a..b', 'a b', 'a; x', 'x\0', 'a@{0}'])
        assert.equal(isSafeRef(ref), false);
    assert.ok(isSafeRef('功能/结算'));
    assert.equal(asHostMessage({ type: 'resolve', path: 'a', strategy: 'execute' }), undefined);
    assert.equal(asHostMessage({ type: 'set-mode', mode: 'live' }), undefined);
    assert.equal(asHostMessage({ type: 'run-demo' }), undefined);
    assert.equal(asHostMessage({ type: 'hydrate', snapshot: null }), undefined);
    assert.equal(asHostMessage({ type: 'inspect-commit', hash: '--help', requestId: 1 }), undefined);
    assert.equal(asHostMessage({ type: 'copy', text: 'a'.repeat(30000) })?.type, 'copy');
    assert.equal(asHostMessage({ type: 'commit-staged', repoId: '/repo', token: 'invalid', message: 'commit' }), undefined);
    assert.equal(asHostMessage({ type: 'commit-staged', repoId: '/repo', token: 'a'.repeat(64), message: 'm'.repeat(20001) }), undefined);
    assert.equal(asHostMessage({ type: 'commit-staged', repoId: '/repo', token: 'a'.repeat(64), message: 'reviewed commit' })?.type, 'commit-staged');
});
test('rendered Git strings are escaped and unicode clipping preserves codepoints', () => {
    assert.equal(esc('<script>"&'), '&lt;script&gt;&quot;&amp;');
    assert.equal(clipChars('😀中文', 1), '😀…');
    const graph = layoutCommits([{ hash: 'abcdef0', message: '<script>alert(1)</script>', parents: [], badges: ['" onload="bad'] }]);
    assert.ok(!renderGraph(graph, true).includes('<script>'));
    assert.ok(!renderCommitDetail({ hash: 'abc', message: '<img>', files: [], patch: '+<script>evil</script>' }).includes('<script>'));
});
test('live phase prioritizes operation state and pending merge', () => {
    const s = { conflicts: [{}], mergeHead: true } as any;
    assert.equal(livePhase(s, { kind: 'confirm', ref: 'feature' }), 'conflict');
    assert.equal(livePhase(s, { kind: 'resolving', path: 'a' }), 'resolving');
    assert.equal(livePhase({ ...s, conflicts: [] }, { kind: 'overview' }), 'ready');
});
// Real temporary Git repository behind the small vscode.git interface double.
// This exercises filesystem/index behavior without claiming Extension Host coverage.
test('GitService: real conflicts, resolution/staging, history diff, abort and worktree', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-test-'));
    let commandDir = dir;
    let indexOverride: string | undefined;
    // File descriptors also work in sandboxes that disallow child-process pipes.
    const git = (...args: string[]) => {
        const stdout = openSync(dir + '.stdout', 'w'), stderr = openSync(dir + '.stderr', 'w');
        try {
            execFileSync('git', ['-C', commandDir, ...args], {
                stdio: ['ignore', stdout, stderr],
                env: indexOverride ? { ...process.env, GIT_INDEX_FILE: indexOverride } : process.env
            });
            return readFileSync(dir + '.stdout', 'utf8').trimEnd();
        }
        catch (error) {
            (error as {
                stderr?: string;
            }).stderr = readFileSync(dir + '.stderr', 'utf8');
            throw error;
        }
        finally {
            closeSync(stdout);
            closeSync(stderr);
        }
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(dir, 'file.ts'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const rootHash = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature');
    await fs.writeFile(path.join(dir, 'file.ts'), 'incoming\n');
    git('commit', '-am', 'feature');
    git('checkout', 'main');
    await fs.writeFile(path.join(dir, 'file.ts'), 'current\n');
    git('commit', '-am', 'main');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const changed = new host.EventEmitter<void>();
    const committed = new host.EventEmitter<void>();
    const uri = (p: string) => host.Uri.file(p) as any;
    const changes = (a: string, b: string): Change[] => git('diff', '--name-only', '-z', `${a}...${b}`).split('\0').filter(Boolean).map(p => ({ uri: uri(path.join(commandDir, p)), originalUri: uri(path.join(commandDir, p)), status: 0 }));
    const commit = (hash: string): Commit => { const parts = git('show', '-s', '--format=%H%x00%P%x00%s', hash).split('\0'); return { hash: parts[0], parents: parts[1] ? parts[1].split(' ') : [], message: parts[2] }; };
    const repo: Repository = {
        rootUri: uri(dir), onDidCommit: committed.event, inputBox: { value: '' }, state: { refs: [], mergeChanges: [], workingTreeChanges: [], indexChanges: [], onDidChange: changed.event },
        async getConfig(key) { return git('config', '--get', key); },
        async getRefs(query?: { pattern?: string | string[] }) {
            const pattern = Array.isArray(query?.pattern) ? query.pattern[0] : query?.pattern;
            const prefix = pattern === 'refs/remotes/' ? 'refs/remotes' : 'refs/heads';
            return git('for-each-ref', '--format=%(refname:short) %(objectname)', prefix).split('\n').filter(Boolean).map(line => {
                const [name, commit] = line.split(' '); return { type: prefix === 'refs/remotes' ? 1 : 0, name, commit };
            });
        },
        async status() {
            // Model editor file-watcher reloads for saved documents.
            for (const doc of host.workspace.textDocuments) {
                if (!doc.isDirty) {
                    try { doc.text = await fs.readFile(doc.uri.fsPath, 'utf8'); } catch {}
                }
            }
            let head: string | undefined;
            try { head = git('rev-parse', '--verify', 'HEAD'); } catch { /* unborn */ }
            this.state.HEAD = { name: git('branch', '--show-current'), commit: head, type: 0 };
            this.state.refs = []; // Actual modern API behavior; never fill the deprecated field.
            const file = (p: string, status: number): Change => ({ uri: uri(path.join(commandDir, p)), originalUri: uri(path.join(commandDir, p)), status });
            this.state.mergeChanges = git('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean).map(p => {
                const stages = git('ls-files', '-u', '-z', '--', p).split('\0').filter(Boolean).map(line => line.split('\t')[0].split(' ')[2]).sort().join('');
                const statuses: Record<string, number> = { '123': 18, '23': 16, '12': 15, '13': 14, '1': 17, '2': 12, '3': 13 };
                return file(p, statuses[stages]);
            });
            const deleted = git('diff', '--cached', '--name-only', '-z', '--diff-filter=D').split('\0');
            this.state.indexChanges = git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACDMRT').split('\0').filter(Boolean).map(p => file(p, deleted.includes(p) ? 2 : 0));
            const workingDeleted = git('diff', '--name-only', '-z', '--diff-filter=D').split('\0');
            this.state.workingTreeChanges = git('diff', '--name-only', '-z').split('\0').filter(Boolean).map(p => file(p, workingDeleted.includes(p) ? 6 : 5));
            this.state.untrackedChanges = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).map(p => file(p, 7));
            changed.fire();
        },
        async log() { return git('log', '--all', '--topo-order', '--format=%H', '-36').split('\n').map(commit); },
        async add(paths) { git('add', '--', ...paths); }, async merge(ref) { git('merge', ref); }, async mergeAbort() { git('merge', '--abort'); },
        async getCommit(hash) { return commit(hash); }, async show(ref, p) { return git('show', `${ref}:${path.isAbsolute(p) ? path.relative(commandDir, p) : p}`); },
        async getObjectDetails(ref, p) {
            const entries = git('ls-files', '--stage', '-z', '--', p).split('\0').filter(Boolean).map(line => line.split('\t')[0].split(' '));
            const [mode, object] = entries.find(entry => entry[2] === ref.substring(1)) || entries[0];
            return { mode, object, size: Number(git('cat-file', '-s', object)) };
        },
        diffIndexWithHEAD: (async (p?: string) => {
            if (p) return git('diff', '--cached', '--', p);
            const records = git('diff', '--cached', '--name-status', '-z', '--no-renames').split('\0');
            const result: Change[] = [];
            for (let i = 0; i + 1 < records.length; i += 2) {
                const file = uri(path.join(commandDir, records[i + 1]));
                result.push({ uri: file, originalUri: file, status: ({ A: 1, D: 2, U: 18 } as Record<string, number>)[records[i]] ?? 0 });
            }
            return result;
        }) as Repository['diffIndexWithHEAD'],
        async commit(message, options) {
            assert.equal(options?.all, false);
            assert.equal(options?.postCommitCommand, null);
            git('commit', '-m', message);
            committed.fire();
        },
        diffBetween: (async (a: string, b: string, p?: string) => p ? git('diff', `${a}...${b}`, '--', p) : changes(a, b)) as Repository['diffBetween']
    };
    await repo.status();
    const noEvent = new host.EventEmitter<any>();
    host.extensions.getExtension = () => ({ isActive: true, exports: { enabled: true, onDidChangeEnablement: noEvent.event, getAPI: () => ({ state: 'initialized', repositories: [repo], onDidChangeState: noEvent.event, onDidOpenRepository: noEvent.event, onDidCloseRepository: noEvent.event }) } });
    const backups = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-backups-'));
    const safety = new ResolutionSafety(uri(backups));
    const service = new GitService({ get: () => undefined, update: async () => { }, keys: () => [] } as any, { appendLine: () => { } } as any, safety);
    await service.init();
    const execute = host.commands.executeCommand;
    host.commands.executeCommand = async (command, ...args) => {
        if (command !== 'git.commit') return;
        assert.equal((args[0] as host.Uri).fsPath, repo.rootUri.fsPath);
        assert.equal(args[1], null, 'must explicitly disable native post-commit commands');
        await repo.commit(repo.inputBox.value, { all: false, postCommitCommand: null });
    };
    try {
        await t.test('modern refs API supplies graph branches and branch validation with empty state.refs', async () => {
            assert.deepEqual(repo.state.refs, []);
            assert.deepEqual((await service.snapshot())?.branches, ['feature', 'main']);
            const getRefs = repo.getRefs!;
            repo.getRefs = async () => { throw new Error('refs unavailable'); };
            try { await assert.rejects(() => service.snapshot(), /refs unavailable/); }
            finally { repo.getRefs = getRefs; }
            const refs = await getRefs.call(repo, {});
            repo.getRefs = undefined;
            repo.getBranches = async () => refs;
            try { assert.deepEqual((await service.snapshot())?.branches, ['feature', 'main']); }
            finally { repo.getRefs = getRefs; repo.getBranches = undefined; }
        });
        await t.test('branch list and read-only preview keep HEAD unchanged', async () => {
            const current = (await service.snapshot())!;
            assert.equal(current.headName, 'main');
            const local = current.branchList?.filter(branch => branch.local) ?? [];
            assert.ok(local.some(branch => branch.current && branch.name === 'main'));
            assert.ok(local.some(branch => branch.name === 'feature'));
            assert.ok(current.branchList?.some(branch => !branch.local && branch.name === 'origin/main'));
            const remotePreview = (await service.snapshot('refs/remotes/origin/main'))!;
            assert.equal(remotePreview.preview?.name, 'origin/main');
            assert.equal(remotePreview.headName, 'main');
            const preview = (await service.snapshot('refs/heads/feature'))!;
            assert.equal(preview.headName, 'main');
            assert.equal(preview.preview?.ref, 'refs/heads/feature');
            assert.ok((preview.preview?.graph.nodes.length ?? 0) > 0);
            const same = (await service.snapshot('refs/heads/main'))!;
            assert.equal(same.preview, undefined);
        });
        await t.test('root and regular commit diff', async () => {
            const root = await service.inspectCommit(rootHash);
            assert.match(root.note!, /不支持空树比较/);
            assert.equal(root.patch, undefined);
            assert.match((await service.inspectCommit(git('rev-parse', 'feature'))).patch!, /\+incoming/);
            await assert.rejects(() => service.inspectCommit(git('rev-parse', 'feature'), '../outside'));
        });
        await t.test('unstaged files stay visible beside staged files; new and deleted files can be staged individually', async () => {
            const extra = 'new <&>.txt';
            const execute = host.commands.executeCommand, show = host.window.showTextDocument;
            const calls: string[] = [];
            const head = git('rev-parse', 'HEAD');
            try {
                await fs.writeFile(path.join(dir, 'file.ts'), 'staged baseline\n'); git('add', 'file.ts');
                await fs.writeFile(path.join(dir, 'file.ts'), 'unstaged newer content\n');
                await fs.writeFile(path.join(dir, extra), 'new content\n');
                await repo.status();
                const snapshot = (await service.snapshot())!;
                assert.equal(snapshot.stagedCount, 1);
                assert.equal(snapshot.workingTreeCount, 2);
                assert.deepEqual(snapshot.workingTreeFiles?.map(f => [f.path, f.status, f.untracked]), [
                    ['file.ts', '已修改', false], [extra, '未跟踪', true]
                ]);
                repo.state.workingTreeChanges.push(...repo.state.untrackedChanges!);
                assert.equal((await service.snapshot())?.workingTreeCount, 2, 'mixed/separate groups must not duplicate files');
                await repo.status();
                host.commands.executeCommand = async (name, ...args) => {
                    assert.equal(name, 'git.openChange');
                    calls.push((args[0] as host.Uri).fsPath);
                };
                host.window.showTextDocument = async resource => { calls.push(resource.fsPath); };
                await service.openWorkingChange('file.ts', dir);
                await service.openWorkingChange(extra, dir);
                assert.deepEqual(calls, [path.join(dir, 'file.ts'), path.join(dir, extra)]);
                const review = await service.reviewStaged();
                const doc = await host.workspace.openTextDocument(uri(path.join(dir, 'file.ts')));
                doc.isDirty = true;
                await assert.rejects(() => service.stageWorkingChange('file.ts', dir), /未保存/);
                assert.equal(git('show', ':file.ts'), 'staged baseline');
                doc.isDirty = false;
                await service.stageWorkingChange('file.ts', dir);
                assert.equal(git('show', ':file.ts'), 'unstaged newer content');
                await assert.rejects(() => service.commitStaged(dir, review.token, 'stale review'), /先加载/);
                assert.equal((await service.snapshot())?.workingTreeCount, 1);
                await service.stageWorkingChange(extra, dir);
                assert.equal(git('show', `:${extra}`), 'new content');
                await fs.unlink(path.join(dir, 'file.ts'));
                await repo.status();
                assert.equal((await service.snapshot())?.workingTreeFiles?.[0].status, '删除');
                await service.openWorkingChange('file.ts', dir); // No disk file needed for deletion diff.
                await service.stageWorkingChange('file.ts', dir);
                assert.equal(git('diff', '--cached', '--name-only', '--diff-filter=D'), 'file.ts');
                assert.equal((await service.snapshot())?.workingTreeCount, 0);
                assert.equal(git('rev-parse', 'HEAD'), head, 'staging must not create a commit');
                await assert.rejects(() => service.stageWorkingChange(extra, dir), /不在未暂存列表/);
                await assert.rejects(() => service.openWorkingChange('../outside', dir), /仓库内/);
                await assert.rejects(() => service.stageWorkingChange('file.ts', '/another-repo'), /仓库已切换/);
            } finally {
                host.commands.executeCommand = execute; host.window.showTextDocument = show;
                host.workspace.textDocuments.length = 0;
                git('reset', '--hard', 'HEAD');
                await fs.rm(path.join(dir, extra), { force: true });
                await repo.status();
            }
        });
        await t.test('conflict detection and incoming writes to the actual Git index', async () => {
            assert.equal((await service.merge('feature')).conflict, true);
            const snapshot = await service.snapshot();
            assert.equal(snapshot?.conflicts.length, 1);
            assert.equal(snapshot?.workingTreeCount, 0, 'conflicts have their own list');
            assert.ok(snapshot?.mergeHead);
            await assert.rejects(() => service.stage('file.ts'), /冲突标记/);
            await assert.rejects(() => service.resolve('../outside', 'ai'));
            await service.resolve('file.ts', 'incoming');
            assert.equal(git('show', ':file.ts'), 'incoming');
            const resolved = await service.snapshot();
            assert.equal(resolved?.conflicts.length, 0);
            assert.equal(resolved?.graph.nodes[0].id, 'pending-merge');
            await service.suggestCommitMessage();
            assert.match(repo.inputBox.value, /Merge/);
            await service.abortMerge();
            assert.equal(git('show', ':file.ts'), 'current');
        });
        await t.test('malformed, binary, oversized and external symlink files are never staged', async () => {
            await service.merge('feature');
            await fs.writeFile(path.join(dir, 'file.ts'), '<<<<<<< HEAD\npartial');
            await assert.rejects(() => service.resolve('file.ts', 'ai'), /标记/);
            await fs.writeFile(path.join(dir, 'file.ts'), new Uint8Array([0, 1, 2]));
            await assert.rejects(() => service.resolve('file.ts', 'ai'), /二进制/);
            await fs.writeFile(path.join(dir, 'file.ts'), 'a'.repeat(180001));
            await assert.rejects(() => service.resolve('file.ts', 'ai'), /180 KB/);
            await fs.unlink(path.join(dir, 'file.ts'));
            await fs.symlink('/etc/hosts', path.join(dir, 'file.ts'));
            await assert.rejects(() => service.resolve('file.ts', 'current'), /仓库外/);
            assert.ok(git('ls-files', '-u').length > 0);
            await fs.unlink(path.join(dir, 'file.ts'));
            await service.abortMerge();
        });
        await t.test('dirty editor blocks resolution and staging without saving it', async () => {
            await service.merge('feature');
            host.workspace.textDocuments.length = 0;
            host.workspace.textDocuments.push({ uri: uri(path.join(dir, 'file.ts')), getText: () => '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n', positionAt: (n: number) => n, save: async () => false, isDirty: true });
            await assert.rejects(() => service.resolve('file.ts', 'current'), /未保存/);
            await assert.rejects(() => service.stage('file.ts'), /未保存/);
            assert.ok(git('ls-files', '-u').length > 0);
            host.workspace.textDocuments.length = 0;
            await service.abortMerge();
        });
        await t.test('preview cancellation does not modify file, index or create a backup', async () => {
            await service.merge('feature');
            const original = await fs.readFile(path.join(dir, 'file.ts'), 'utf8');
            const index = git('ls-files', '--stage');
            const count = (await fs.readdir(backups)).length;
            const confirm = host.window.showInformationMessage;
            host.window.showInformationMessage = async () => undefined;
            try { await assert.rejects(() => service.resolve('file.ts', 'ai'), /已取消/); }
            finally { host.window.showInformationMessage = confirm; }
            assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), original);
            assert.equal(git('ls-files', '--stage'), index);
            assert.equal((await fs.readdir(backups)).length, count);
            await service.abortMerge();
        });
        await t.test('file and index changes while preview is open reject application', async () => {
            for (const changeIndex of [false, true]) {
                await service.merge('feature');
                const confirm = host.window.showInformationMessage;
                host.window.showInformationMessage = async () => {
                    await fs.writeFile(path.join(dir, 'file.ts'), 'external change\n');
                    if (changeIndex) git('add', 'file.ts');
                    return '应用并暂存';
                };
                try { await assert.rejects(() => service.resolve('file.ts', 'current'), /发生变化|不在冲突列表/); }
                finally { host.window.showInformationMessage = confirm; }
                assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), 'external change\n');
                if (!changeIndex) assert.ok(git('ls-files', '-u'));
                await service.abortMerge();
            }
        });
        await t.test('backup failure prevents editing and staging', async () => {
            await service.merge('feature');
            const original = await fs.readFile(path.join(dir, 'file.ts'), 'utf8');
            const write = host.workspace.fs.writeFile;
            host.workspace.fs.writeFile = async () => { throw new Error('backup unavailable'); };
            try { await assert.rejects(() => service.resolve('file.ts', 'current'), /backup unavailable/); }
            finally { host.workspace.fs.writeFile = write; }
            assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), original);
            assert.ok(git('ls-files', '-u'));
            await service.abortMerge();
        });
        await t.test('save failure preserves original backup and leaves the index unresolved', async () => {
            await service.merge('feature');
            const original = await fs.readFile(path.join(dir, 'file.ts'), 'utf8');
            const doc = await host.workspace.openTextDocument(uri(path.join(dir, 'file.ts')));
            const save = doc.save;
            doc.save = async () => false;
            try { await assert.rejects(() => service.resolve('file.ts', 'incoming'), /未成功保存/); }
            finally { doc.save = save; }
            assert.ok(git('ls-files', '-u'));
            assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), original);
            const records = await Promise.all((await fs.readdir(backups)).map(async name => JSON.parse(await fs.readFile(path.join(backups, name), 'utf8'))));
            assert.ok(records.some(record => record.file === path.join(dir, 'file.ts') && record.original === original));
            host.workspace.textDocuments.length = 0; // User discards the failed edit.
            await service.abortMerge();
        });
        await t.test('save-time edits are retained and never staged automatically', async () => {
            await service.merge('feature');
            const doc = await host.workspace.openTextDocument(uri(path.join(dir, 'file.ts')));
            const save = doc.save;
            doc.save = async () => { doc.text = 'formatter changed the result\n'; return save.call(doc); };
            try { await assert.rejects(() => service.resolve('file.ts', 'incoming'), /保存时文件发生变化/); }
            finally { doc.save = save; }
            assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), 'formatter changed the result\n');
            assert.ok(git('ls-files', '-u'));
            await service.abortMerge();
        });
        await t.test('uncommitted local changes block merge and cancelled abort preserves conflicts', async () => {
            await fs.writeFile(path.join(dir, 'file.ts'), 'local change\n');
            await assert.rejects(() => service.merge('feature'), /stash/);
            assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), 'local change\n');
            git('restore', 'file.ts');
            await service.merge('feature');
            const warning = host.window.showWarningMessage;
            host.window.showWarningMessage = async () => undefined;
            try { await assert.rejects(() => service.abortMerge(), /已取消/); }
            finally { host.window.showWarningMessage = warning; }
            assert.ok(git('ls-files', '-u'));
            await service.abortMerge();
        });
        await t.test('staged conflict markers block commits; dirty buffers reach the official save prompt', async () => {
            await fs.writeFile(path.join(dir, 'file.ts'), '<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> feature\n');
            git('add', 'file.ts');
            let review = await service.reviewStaged();
            assert.match(review.blocked!, /暂存内容仍含冲突标记/);
            await assert.rejects(() => service.commitStaged(dir, review.token, 'bad'), /冲突标记/);
            await fs.writeFile(path.join(dir, 'file.ts'), 'clean\n'); git('add', 'file.ts');
            review = await service.reviewStaged();
            const doc = await host.workspace.openTextDocument(uri(path.join(dir, 'file.ts')));
            doc.isDirty = true;
            const command = host.commands.executeCommand;
            let reachedNative = false;
            host.commands.executeCommand = async name => { if (name === 'git.commit') reachedNative = true; };
            try { await assert.rejects(() => service.commitStaged(dir, review.token, 'dirty'), /未产生可确认/); }
            finally { host.commands.executeCommand = command; }
            assert.ok(reachedNative, 'native command owns the configured save/cancel decision');
            doc.isDirty = false;
            git('reset', '--hard', 'HEAD');
        });
        await t.test('review and commit only include the staged version, preserving unstaged edits', async () => {
            await fs.writeFile(path.join(dir, 'file.ts'), 'staged change\n');
            git('add', 'file.ts');
            await fs.writeFile(path.join(dir, 'file.ts'), 'unstaged change\n');
            const review = await service.reviewStaged();
            assert.equal(review.files.length, 1);
            assert.equal(review.unstagedCount, 1);
            assert.match(review.patch, /\+staged change/);
            assert.ok(!review.patch.includes('unstaged change'));
            await assert.rejects(() => service.commitStaged(dir, review.token, '  '), /提交说明/);
            const hash = await service.commitStaged(dir, review.token, 'reviewed change');
            assert.equal(hash, git('rev-parse', 'HEAD'));
            assert.equal(git('show', 'HEAD:file.ts'), 'staged change');
            assert.equal(await fs.readFile(path.join(dir, 'file.ts'), 'utf8'), 'unstaged change\n');
            assert.equal(git('log', '-1', '--format=%s'), 'reviewed change');
            await assert.rejects(() => service.commitStaged(dir, review.token, 'duplicate'), /先加载/);
            git('restore', 'file.ts'); await repo.status();
            assert.match((await service.reviewStaged()).blocked!, /没有已暂存/);
        });
        await t.test('changed staged content, binary content and HEAD invalidate review', async () => {
            await fs.writeFile(path.join(dir, 'file.ts'), 'first\n'); git('add', 'file.ts');
            let review = await service.reviewStaged();
            await fs.writeFile(path.join(dir, 'file.ts'), 'second\n'); git('add', 'file.ts');
            await assert.rejects(() => service.commitStaged(dir, review.token, 'stale'), /已变化/);
            git('reset', '--hard', 'HEAD');
            await fs.writeFile(path.join(dir, 'binary.bin'), new Uint8Array([0, 1, 2])); git('add', 'binary.bin');
            review = await service.reviewStaged('binary.bin');
            await fs.writeFile(path.join(dir, 'binary.bin'), new Uint8Array([0, 3, 4])); git('add', 'binary.bin');
            await assert.rejects(() => service.commitStaged(dir, review.token, 'stale binary'), /已变化/);
            review = await service.reviewStaged();
            git('commit', '--allow-empty', '-m', 'external commit');
            await assert.rejects(() => service.commitStaged(dir, review.token, 'stale head'), /已暂存|已变化/);
        });
        await t.test('review follows the actual Git index even when the default on-disk index stays unchanged', async () => {
            const alternate = dir + '.alternate-index';
            const original = await fs.readFile(path.join(dir, '.git/index'));
            const head = git('rev-parse', 'HEAD');
            await fs.writeFile(alternate, new Uint8Array(original));
            indexOverride = alternate;
            try {
                await fs.writeFile(path.join(dir, 'file.ts'), 'reviewed alternate-index content\n');
                git('add', 'file.ts');
                const review = await service.reviewStaged();
                await fs.writeFile(path.join(dir, 'file.ts'), 'changed actual staged content\n');
                git('add', 'file.ts');
                assert.deepEqual(await fs.readFile(path.join(dir, '.git/index')), original);
                await assert.rejects(() => service.commitStaged(dir, review.token, 'must not commit'), /已变化/);
                assert.equal(git('rev-parse', 'HEAD'), head);
            } finally {
                indexOverride = undefined;
                git('restore', 'file.ts'); await fs.rm(alternate, { force: true }); await repo.status();
            }
        });
        await t.test('index changes during native command lookup are checked again before execution', async () => {
            await fs.writeFile(path.join(dir, 'file.ts'), 'before handoff\n'); git('add', 'file.ts');
            const review = await service.reviewStaged();
            const head = git('rev-parse', 'HEAD');
            const getCommands = host.commands.getCommands;
            host.commands.getCommands = async () => {
                await fs.writeFile(path.join(dir, 'file.ts'), 'during handoff\n'); git('add', 'file.ts');
                return ['git.commit'];
            };
            try {
                await assert.rejects(() => service.commitStaged(dir, review.token, 'must not commit'), /进入官方提交前/);
                assert.equal(git('rev-parse', 'HEAD'), head);
            } finally {
                host.commands.getCommands = getCommands;
                git('reset', '--hard', 'HEAD'); await repo.status();
            }
        });
        await t.test('commit failure preserves index and permits retry after a fresh review', async () => {
            await fs.writeFile(path.join(dir, 'file.ts'), 'hook test\n'); git('add', 'file.ts');
            const review = await service.reviewStaged();
            const head = git('rev-parse', 'HEAD');
            const hook = path.join(dir, '.git/hooks/pre-commit');
            await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
            try {
                await assert.rejects(() => service.commitStaged(dir, review.token, 'blocked by hook'));
                assert.equal(git('rev-parse', 'HEAD'), head);
                assert.equal(git('show', ':file.ts'), 'hook test');
            } finally { await fs.unlink(hook); }
            const refreshed = await service.reviewStaged();
            await service.commitStaged(dir, refreshed.token, 'retry after review');
            assert.equal(git('show', 'HEAD:file.ts'), 'hook test');
        });
        await t.test('reviewed merge creates two-parent commit and clears pending merge', async () => {
            await service.merge('feature');
            assert.ok((await service.reviewStaged()).blocked?.includes('冲突'));
            await service.resolve('file.ts', 'incoming');
            const review = await service.reviewStaged();
            assert.ok(review.merge);
            const hash = await service.commitStaged(dir, review.token, 'Merge feature after review');
            assert.equal(git('show', '-s', '--format=%P', hash!).split(' ').length, 2);
            const snapshot = await service.snapshot();
            assert.equal(snapshot?.mergeHead, false);
            assert.ok(!snapshot?.graph.nodes.some(n => n.id === 'pending-merge'));
        });
        await t.test('native conflict workflow supports deletion, rename and binary conflict states', async () => {
            const nativeCommand = host.commands.executeCommand;
            for (const kind of ['delete-us', 'delete-them', 'rename', 'binary']) {
                const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-complex-'));
                commandDir = fixture; repo.rootUri = uri(fixture);
                const source = path.join(fixture, 'old.txt');
                try {
                    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
                    await fs.writeFile(source, kind === 'binary' ? '\0base\n' : 'base\n'.repeat(10));
                    git('add', '.'); git('commit', '-m', 'base');
                    git('checkout', '-b', 'feature');
                    if (kind === 'delete-them') git('rm', 'old.txt');
                    else if (kind === 'rename') git('mv', 'old.txt', 'incoming.txt');
                    else await fs.writeFile(source, kind === 'binary' ? '\0incoming\n' : 'incoming\n');
                    git('commit', '-am', 'feature'); git('checkout', 'main');
                    if (kind === 'delete-us') git('rm', 'old.txt');
                    else if (kind === 'rename') git('mv', 'old.txt', 'current.txt');
                    else await fs.writeFile(source, kind === 'binary' ? '\0current\n' : 'current\n');
                    git('commit', '-am', 'main');
                    await repo.status();
                    assert.equal((await service.merge('feature')).conflict, true, kind);
                    const snapshot = (await service.snapshot())!;
                    assert.ok(snapshot.conflicts.length);
                    assert.ok(snapshot.conflicts.every(f => f.nativeOnly), kind);
                    const file = snapshot.conflicts[0];
                    const calls: { name: string; args: unknown[] }[] = [];
                    host.commands.executeCommand = async (name, ...args) => {
                        calls.push({ name, args });
                        if (name === 'git.stageAllMerge') {
                            assert.equal((args[0] as host.Uri).fsPath, fixture);
                            // Test adapter models the user's official keep/delete decision.
                            // This adapter does not verify the actual native dialogs.
                            if (kind === 'delete-them') git('rm', '--', 'old.txt');
                            git('add', '-A');
                        }
                    };
                    await service.openConflict(file.path, false);
                    assert.equal(calls[0].name, 'git.openChange');
                    assert.equal((calls[0].args[0] as host.Uri).fsPath, path.join(fixture, file.path));
                    if (kind !== 'binary') {
                        await assert.rejects(() => service.resolve(file.path, 'current'), /官方暂存冲突/);
                        await assert.rejects(() => service.stage(file.path), /官方暂存冲突/);
                    }
                    const warning = host.window.showWarningMessage;
                    host.window.showWarningMessage = async () => undefined;
                    try { await assert.rejects(() => service.stageConflictsNative(), /已取消/); }
                    finally { host.window.showWarningMessage = warning; }
                    assert.equal(calls.filter(c => c.name === 'git.stageAllMerge').length, 0);
                    assert.equal((await service.stageConflictsNative()).remaining, 0);
                    assert.equal(git('ls-files', '-u'), '');
                    if (kind === 'delete-them') assert.ok(!git('ls-files').includes('old.txt'));
                    if (kind === 'rename') {
                        assert.ok(git('ls-files').includes('incoming.txt'));
                        assert.ok(git('ls-files').includes('current.txt'));
                    }
                } finally {
                    host.commands.executeCommand = nativeCommand;
                    commandDir = dir; repo.rootUri = uri(dir);
                    await fs.rm(fixture, { recursive: true, force: true });
                    await repo.status();
                }
            }
        });
        await t.test('worktree .git file locates merge metadata', async () => {
            const wt = path.join(dir, 'linked');
            git('worktree', 'add', '-b', 'linked', wt);
            repo.rootUri = uri(wt); commandDir = wt;
            try {
                await repo.status();
                const metadata = (await fs.readFile(path.join(wt, '.git'), 'utf8')).trim().slice(8);
                await fs.writeFile(path.join(metadata, 'MERGE_HEAD'), git('rev-parse', 'feature') + '\n');
                assert.ok((await service.snapshot())?.mergeHead);
                await fs.unlink(path.join(metadata, 'MERGE_HEAD'));
                await fs.writeFile(path.join(wt, 'file.ts'), 'linked worktree change\n');
                git('add', 'file.ts');
                const review = await service.reviewStaged();
                await service.commitStaged(wt, review.token, 'Commit in linked worktree');
                assert.equal(git('show', 'HEAD:file.ts'), 'linked worktree change');
            } finally {
                repo.rootUri = uri(dir); commandDir = dir;
                git('worktree', 'remove', '--force', wt); await repo.status();
            }
        });
        await t.test('initial commit and staged deletion can be reviewed and committed', async () => {
            const initial = await fs.mkdtemp(path.join(os.tmpdir(), 'generative-git-initial-'));
            commandDir = initial; repo.rootUri = uri(initial);
            try {
                git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
                await fs.writeFile(path.join(initial, 'first.txt'), 'initial content\n'); git('add', 'first.txt');
                let review = await service.reviewStaged();
                assert.match(review.patch, /\+initial content/);
                await service.commitStaged(initial, review.token, 'Initial commit');
                assert.equal(git('log', '-1', '--format=%s'), 'Initial commit');
                git('rm', 'first.txt');
                review = await service.reviewStaged('first.txt');
                assert.match(review.patch, /-initial content/);
                await service.commitStaged(initial, review.token, 'Remove file');
                assert.equal(git('ls-tree', '--name-only', 'HEAD'), '');
                git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},module`);
                const show = repo.show;
                repo.show = async () => { throw new Error('a gitlink must not be read as a text blob'); };
                try {
                    review = await service.reviewStaged('module');
                    assert.equal(review.blocked, undefined);
                    await service.commitStaged(initial, review.token, 'Record submodule commit');
                } finally { repo.show = show; }
                assert.match(git('ls-tree', 'HEAD', 'module'), /^160000 commit/);
            } finally {
                commandDir = dir; repo.rootUri = uri(dir);
                await fs.rm(initial, { recursive: true, force: true });
            }
        });
    }
    finally {
        host.commands.executeCommand = execute;
        service.dispose();
        safety.dispose();
        host.workspace.textDocuments.length = 0;
        await fs.rm(backups, { recursive: true, force: true });
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rm(dir + '.stdout', { force: true });
        await fs.rm(dir + '.stderr', { force: true });
    }
});

test('merge graph draws pending and join edges from parent tips toward the result', () => {
    const graph = {
        laneCount: 2,
        nodes: [
            { id: 'merge', hash: 'merge', title: 'Result', lane: 0, row: 0, role: 'merge' as const, badges: [] },
            { id: 'branch', hash: 'branch', title: 'Incoming', lane: 1, row: 1, role: 'commit' as const, badges: [] },
            { id: 'main', hash: 'main', title: 'Main', lane: 0, row: 2, role: 'commit' as const, badges: [] }
        ],
        edges: [
            { id: 'incoming', from: 'merge', to: 'branch', style: 'pending' as const },
            { id: 'current', from: 'merge', to: 'main', style: 'join' as const }
        ]
    };
    const html = renderGraph(graph, false);
    assert.match(html, /class="edge lane-1 pending" d="M32 45C32 30,14 30,14 15"/);
    assert.match(html, /class="edge lane-0 join" d="M14 75L14 15"/);
    assert.equal(graph.edges[0].from, 'merge');
    assert.equal(graph.nodes[0].row, 0);
    const reduced = renderGraph(graph, true);
    assert.ok(reduced.includes('class="edge lane-0 solid"'));
    assert.ok(!reduced.includes('edge lane-0 join'));
});
