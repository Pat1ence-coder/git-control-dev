import * as vscode from 'vscode';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { GitAPI, GitExtension, Repository, Commit, Ref, Change } from './types';
import type { Snapshot, ConflictFile, Strategy, CommitDetail, StagedReview } from '../shared/protocol';
import { applyResolution, hasConflictMarkers, parseConflict } from './conflicts';
import { layoutCommits, withPendingMerge } from './layout';
import { resolveInside, samePath } from './paths';
import { isSafeRef } from './safeRef';
import { statusLabel } from './status';
import { ResolutionSafety } from './safety';
import { nativeCommit, requireNativeCommand } from './nativeGit';
import { GitMetadata } from './metadata';
import { describeGitError, UserFacingError } from './errors';
export { describeGitError } from './errors';
export const MAX_FILE_BYTES = 180000;
export class GitService implements vscode.Disposable {
    private api?: GitAPI;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly repositories = new Map<Repository, vscode.Disposable>();
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private timer?: ReturnType<typeof setTimeout>;
    private selected?: string;
    private ready: Promise<void> = Promise.resolve();
    private readonly reviewTokens = new Map<string, string>();
    private readonly metadata = new GitMetadata();
    startupProblem?: string;
    constructor(private readonly state: vscode.Memento, private readonly output: vscode.OutputChannel,
        private readonly safety: ResolutionSafety) { this.selected = state.get<string>('repo'); }
    private assertSaved(repo: Repository, file?: vscode.Uri): void {
        const dirty = vscode.workspace.textDocuments.find(doc => doc.isDirty && (file
            ? samePath(doc.uri.fsPath, file.fsPath)
            : doc.uri.scheme === 'file' && (() => {
                const relative = path.relative(repo.rootUri.fsPath, doc.uri.fsPath);
                return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
            })()));
        if (dirty) throw new UserFacingError(`请先保存或撤销未保存的编辑：${path.basename(dirty.uri.fsPath)}。`);
    }
    init(): Promise<void> { return this.ready = this.doInit().catch(e => { this.startupProblem = describeGitError(e); this.output.appendLine(this.startupProblem); }); }
    whenReady(): Promise<void> { return this.ready; }
    private async doInit(): Promise<void> {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            this.startupProblem = '没有找到内置 Git 扩展 vscode.git。';
            return;
        }
        const git: GitExtension = extension.isActive ? extension.exports : await extension.activate();
        const attach = () => {
            if (!git.enabled || this.api)
                return;
            this.startupProblem = undefined;
            const api = this.api = git.getAPI(1);
            const sync = () => { this.syncRepositories(); this.schedule(); };
            this.subscriptions.push(api.onDidChangeState(sync), api.onDidOpenRepository(sync), api.onDidCloseRepository(sync));
            sync();
        };
        this.subscriptions.push(git.onDidChangeEnablement(enabled => {
            if (enabled)
                attach();
            else {
                this.api = undefined;
                this.startupProblem = '内置 Git 扩展已禁用。';
                for (const d of this.repositories.values())
                    d.dispose();
                this.repositories.clear();
                this.schedule();
            }
        }));
        if (!git.enabled)
            this.startupProblem = '内置 Git 扩展已禁用。';
        else
            attach();
        const api = this.api;
        if (api && api.state !== 'initialized') {
            await new Promise<void>(resolve => {
                const subscription = api.onDidChangeState(() => {
                    if (api.state === 'initialized') {
                        subscription.dispose();
                        resolve();
                    }
                });
                this.subscriptions.push(subscription, { dispose: resolve });
            });
        }
    }
    private syncRepositories(): void {
        for (const [repo, sub] of this.repositories)
            if (!this.api?.repositories.includes(repo)) {
                sub.dispose();
                this.repositories.delete(repo);
            }
        for (const repo of this.api?.repositories || [])
            if (!this.repositories.has(repo))
                this.repositories.set(repo, repo.state.onDidChange(() => this.schedule()));
    }
    private schedule(): void { clearTimeout(this.timer); this.timer = setTimeout(() => this.changed.fire(), 180); }
    get repository(): Repository | undefined {
        return this.api?.repositories.find(r => this.selected && samePath(r.rootUri.fsPath, this.selected)) || (vscode.workspace.workspaceFolders?.[0] ? this.api?.getRepository(vscode.workspace.workspaceFolders[0].uri) : undefined) || this.api?.repositories[0];
    }
    async select(id: string): Promise<void> { if (!this.api?.repositories.some(r => samePath(r.rootUri.fsPath, id)))
        throw new UserFacingError('仓库已关闭，请刷新。'); this.selected = id; await this.state.update('repo', id); }
    private requireRepo(): Repository { const repo = this.repository; if (!repo)
        throw new UserFacingError('请先打开一个本地 Git 仓库。'); return repo; }
    async refresh(): Promise<void> { await this.repository?.status(); }
    private async localBranches(repo: Repository): Promise<Ref[]> {
        // state.refs is deprecated and returns [] in recent hosts.
        const refs = repo.getRefs ? await repo.getRefs({ pattern: 'refs/heads/', sort: 'alphabetically' })
            : repo.getBranches ? await repo.getBranches({ remote: false }) : repo.state.refs;
        return refs.filter(ref => ref.type === 0 && ref.name);
    }
    private workingChanges(repo: Repository): Change[] {
        const changes: Change[] = [];
        const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        const seen = new Set(repo.state.mergeChanges.map(change => key(change.uri.fsPath)));
        for (const change of [...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges || [])]) {
            const id = key(change.uri.fsPath);
            if (change.status === 8 || seen.has(id)) continue;
            seen.add(id);
            changes.push(change);
        }
        return changes;
    }
    private async workingChange(relative: string, repoId: string): Promise<{ repo: Repository; change: Change }> {
        const repo = this.requireRepo();
        if (!samePath(repo.rootUri.fsPath, repoId)) throw new UserFacingError('当前仓库已切换，请刷新未暂存更改。');
        await this.metadata.identity(repo);
        await repo.status();
        const absolute = resolveInside(repo.rootUri.fsPath, relative);
        const change = this.workingChanges(repo).find(c => samePath(c.uri.fsPath, absolute));
        if (!change) throw new UserFacingError('该文件已不在未暂存列表，请刷新。');
        return { repo, change };
    }
    async openWorkingChange(relative: string, repoId: string): Promise<void> {
        const { repo, change } = await this.workingChange(relative, repoId);
        if (change.status === 7) {
            // Separate untracked groups are not resolved by git.openChange in
            // all hosts; a new file has no index version to compare against.
            await vscode.window.showTextDocument(await this.confined(repo, relative));
        } else {
            await requireNativeCommand('git.openChange');
            await vscode.commands.executeCommand('git.openChange', change.uri);
        }
    }
    async stageWorkingChange(relative: string, repoId: string): Promise<void> {
        const { repo, change } = await this.workingChange(relative, repoId);
        this.assertSaved(repo, change.uri);
        // Use the exact current Git resource. Deleted files need no file read;
        // git add records their deletion without deleting other working files.
        await repo.add([change.uri.fsPath]);
        this.reviewTokens.delete(repo.rootUri.fsPath);
        await repo.status();
    }
    private async gitFile(repo: Repository, name: 'HEAD' | 'MERGE_HEAD' | 'MERGE_MSG' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD'): Promise<string> {
        return this.metadata.read(repo, name);
    }
    private async readDocument(uri: vscode.Uri): Promise<string> {
        const doc = vscode.workspace.textDocuments.find(d => samePath(d.uri.fsPath, uri.fsPath));
        if (doc) {
            const text = doc.getText();
            if (Buffer.byteLength(text) > MAX_FILE_BYTES)
                throw new UserFacingError('文件超过 180 KB，请在编辑器中处理。');
            if (text.includes('\0'))
                throw new UserFacingError('二进制文件请在源代码管理中处理。');
            return text;
        }
        if ((await vscode.workspace.fs.stat(uri)).size > MAX_FILE_BYTES)
            throw new UserFacingError('文件超过 180 KB，请在编辑器中处理。');
        const data = await vscode.workspace.fs.readFile(uri);
        if (data.length > MAX_FILE_BYTES)
            throw new UserFacingError('文件超过 180 KB，请在编辑器中处理。');
        if (data.subarray(0, 8000).includes(0))
            throw new UserFacingError('二进制文件请在源代码管理中处理。');
        try {
            return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        }
        catch {
            throw new UserFacingError('文件不是 UTF-8，请在编辑器中处理并保存。');
        }
    }
    private async confined(repo: Repository, relative: string): Promise<vscode.Uri> {
        const absolute = resolveInside(repo.rootUri.fsPath, relative);
        const [root, target] = await Promise.all([realpath(repo.rootUri.fsPath), realpath(absolute)]);
        const rel = path.relative(root, target);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
            throw new UserFacingError('文件链接指向仓库外，无法操作。');
        const uri = vscode.Uri.file(absolute);
        if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.SymbolicLink)
            throw new UserFacingError('符号链接请在源代码管理中处理。');
        return uri;
    }
    async snapshot(): Promise<Snapshot | null> {
        const repo = this.repository;
        if (!repo)
            return null;
        const branches = await this.localBranches(repo);
        const workingTreeFiles = this.workingChanges(repo).map(change => ({
            path: path.relative(repo.rootUri.fsPath, change.uri.fsPath),
            status: statusLabel(change.status), untracked: change.status === 7
        }));
        let commits: Commit[] = [];
        try {
            commits = await repo.log({ maxEntries: 36, refNames: [...new Set(['HEAD', ...branches.map(r => r.name!)])].slice(0, 24) });
        }
        catch { /* old API fallback below */ }
        if (!commits.length)
            try {
                commits = await repo.log({ maxEntries: 36 });
            }
            catch { /* unborn repository */ }
        const conflicts: ConflictFile[] = await Promise.all(repo.state.mergeChanges.map(async (change) => {
            const relative = path.relative(repo.rootUri.fsPath, change.uri.fsPath);
            const file: ConflictFile = { path: relative, status: statusLabel(change.status), hunks: [] };
            if (![16, 18].includes(change.status)) {
                file.nativeOnly = true;
                file.note = '此类冲突涉及文件增删或路径选择。请查看官方差异，再使用“官方暂存冲突”处理；官方会提示保留或删除。';
                return file;
            }
            try {
                const uri = await this.confined(repo, relative);
                const text = await this.readDocument(uri);
                file.hunks = parseConflict(text).map(h => { const truncate = (s: string) => { const lines = s.split('\n'); if (lines.length > 80)
                    file.truncated = true; return lines.slice(0, 80).join('\n'); }; return { ...h, current: truncate(h.current), incoming: truncate(h.incoming) }; });
                if (!file.hunks.length)
                    file.note = '没有标准冲突块。请在编辑器检查内容，再暂存当前文件。';
            }
            catch (e) {
                file.nativeOnly = true;
                file.note = describeGitError(e);
            }
            return file;
        }));
        const [mergeHash, mergeMessage] = await Promise.all([this.gitFile(repo, 'MERGE_HEAD'), this.gitFile(repo, 'MERGE_MSG')]);
        let graph = layoutCommits(commits.map(c => ({ ...c, badges: branches.filter(r => r.commit === c.hash).map(r => r.name!) })), repo.state.HEAD?.commit);
        if (mergeHash && !conflicts.length && repo.state.HEAD?.commit)
            graph = withPendingMerge(graph, repo.state.HEAD.commit, mergeHash.split('\n')[0]);
        return { repoId: repo.rootUri.fsPath, repoName: path.basename(repo.rootUri.fsPath), repositories: (this.api?.repositories || []).map(r => ({ id: r.rootUri.fsPath, name: path.basename(r.rootUri.fsPath) })), headName: repo.state.HEAD?.name || 'HEAD', headHash: repo.state.HEAD?.commit, branches: branches.map(r => r.name!), conflicts, workingTreeCount: workingTreeFiles.length, workingTreeFiles, stagedCount: repo.state.indexChanges.length, mergeHead: !!mergeHash, mergingRef: /Merge (?:remote-tracking )?branch '([^']+)'/.exec(mergeMessage)?.[1], rebasing: !!repo.state.rebaseCommit, canMerge: typeof repo.merge === 'function', canAbort: typeof repo.mergeAbort === 'function', graph };
    }
    async merge(ref: string): Promise<{
        conflict: boolean;
    }> {
        const repo = this.requireRepo();
        await repo.status();
        this.assertSaved(repo);
        if (repo.state.indexChanges.length || repo.state.workingTreeChanges.length || repo.state.untrackedChanges?.length)
            throw new UserFacingError('合并前请先提交或 stash 本地改动，以便失败时安全中止。');
        if (!isSafeRef(ref) || !(await this.localBranches(repo)).some(r => r.name === ref))
            throw new UserFacingError('请选择当前仓库内有效的本地分支。');
        if (repo.state.mergeChanges.length || repo.state.rebaseCommit || await this.gitFile(repo, 'MERGE_HEAD'))
            throw new UserFacingError('请先完成当前合并或变基。');
        if (!repo.merge)
            throw new UserFacingError('当前 Git API 不支持发起合并。请在终端执行 git merge，冲突会自动显示在这里。');
        try {
            await repo.merge(ref);
            await repo.status();
            return { conflict: repo.state.mergeChanges.length > 0 };
        }
        catch (e) {
            await repo.status().catch(() => { });
            if (repo.state.mergeChanges.length || (e as {
                gitErrorCode?: string;
            })?.gitErrorCode === 'Conflict')
                return { conflict: true };
            throw e;
        }
    }
    async abortMerge(): Promise<void> {
        const repo = this.requireRepo();
        if (!await this.gitFile(repo, 'MERGE_HEAD') || repo.state.rebaseCommit)
            throw new UserFacingError('当前没有可中止的 merge。');
        if (!repo.mergeAbort)
            throw new UserFacingError('当前 Git API 不支持中止。请在终端运行 git merge --abort。');
        this.assertSaved(repo);
        const fingerprint = await this.reviewFingerprint(repo);
        if (await vscode.window.showWarningMessage('中止合并会丢弃本次冲突解决的工作区改动。已保存的冲突备份仍可从命令面板打开。', { modal: true }, '中止合并') !== '中止合并')
            throw new UserFacingError('已取消中止合并。');
        this.assertSaved(repo);
        if (fingerprint !== await this.reviewFingerprint(repo))
            throw new UserFacingError('确认期间仓库发生变化，未中止合并。请刷新后再操作。');
        await repo.mergeAbort();
        await repo.status();
    }
    private async conflictPath(repo: Repository, relative: string): Promise<vscode.Uri> {
        const absolute = resolveInside(repo.rootUri.fsPath, relative);
        if (!repo.state.mergeChanges.some(c => samePath(c.uri.fsPath, absolute)))
            throw new UserFacingError('该文件已不在冲突列表，请刷新。');
        const change = repo.state.mergeChanges.find(c => samePath(c.uri.fsPath, absolute))!;
        if (![16, 18].includes(change.status))
            throw new UserFacingError('此类冲突涉及增删或路径选择，请使用官方暂存冲突流程。');
        return this.confined(repo, relative);
    }
    async openConflict(relative: string, mergeEditor: boolean): Promise<void> {
        const repo = this.requireRepo();
        await repo.status();
        const absolute = resolveInside(repo.rootUri.fsPath, relative);
        const change = repo.state.mergeChanges.find(c => samePath(c.uri.fsPath, absolute));
        if (!change) throw new UserFacingError('该文件已不在冲突列表，请刷新。');
        // Missing/deleted paths are valid here: the official Git URI provider
        // displays the index stages without requiring a working-tree file.
        const command = mergeEditor ? 'git.openMergeEditor' : 'git.openChange';
        if (mergeEditor) {
            if (![16, 18].includes(change.status))
                throw new UserFacingError('增删或路径冲突请先查看官方差异，再使用官方暂存冲突流程。');
            await this.confined(repo, relative);
        }
        await requireNativeCommand(command);
        await vscode.commands.executeCommand(command, change.uri);
    }
    async stageConflictsNative(): Promise<{ remaining: number }> {
        const repo = this.requireRepo();
        await repo.status();
        if (!repo.state.mergeChanges.length) throw new UserFacingError('当前没有未解决冲突。');
        this.assertSaved(repo);
        await requireNativeCommand('git.stageAllMerge');
        const fingerprint = await this.reviewFingerprint(repo);
        const confirm = '继续官方暂存';
        if (await vscode.window.showWarningMessage(
            `将处理 ${path.basename(repo.rootUri.fsPath)} 的全部 ${repo.state.mergeChanges.length} 个冲突文件。官方会询问保留或删除，以及是否暂存未解决的冲突。取消后可能已有部分文件完成暂存。`,
            { modal: true }, confirm) !== confirm)
            throw new UserFacingError('已取消官方暂存。');
        this.assertSaved(repo);
        if (fingerprint !== await this.reviewFingerprint(repo))
            throw new UserFacingError('确认期间仓库发生变化，请刷新后重新处理冲突。');
        await vscode.commands.executeCommand('git.stageAllMerge', repo.rootUri);
        await repo.status();
        return { remaining: repo.state.mergeChanges.length };
    }
    async resolve(relative: string, strategy: Strategy): Promise<string> {
        const repo = this.requireRepo();
        await repo.status();
        const uri = await this.conflictPath(repo, relative);
        this.assertSaved(repo, uri);
        const fingerprint = await this.reviewFingerprint(repo);
        const original = await this.readDocument(uri), result = applyResolution(original, strategy);
        if (hasConflictMarkers(result.text))
            throw new UserFacingError('文件仍含未闭合或嵌套冲突标记，请在编辑器检查后再暂存。');
        if (result.applied) {
            if (!await this.safety.confirm(original, result.text, relative))
                throw new UserFacingError('已取消应用，文件和暂存区未修改。');
            await repo.status();
            await this.conflictPath(repo, relative);
            this.assertSaved(repo, uri);
            const doc = await vscode.workspace.openTextDocument(uri);
            if (doc.getText() !== original || await this.readDisk(uri) !== original || fingerprint !== await this.reviewFingerprint(repo))
                throw new UserFacingError('预览期间文件或仓库发生变化，请重新选择策略并审查。');
            await this.safety.backup(uri, original);
            this.assertSaved(repo, uri);
            await this.confined(repo, relative);
            if (doc.getText() !== original || await this.readDisk(uri) !== original || fingerprint !== await this.reviewFingerprint(repo))
                throw new UserFacingError('备份期间文件或仓库发生变化，请重新审查。');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), result.text);
            if (!await vscode.workspace.applyEdit(edit) || !await doc.save())
                throw new UserFacingError('文件未成功保存，未暂存。原内容可从冲突备份恢复。');
            if (doc.isDirty || doc.getText() !== result.text || await this.readDisk(uri) !== result.text)
                throw new UserFacingError('保存时文件发生变化，未暂存；请检查编辑器与冲突备份。');
        }
        if (fingerprint !== await this.reviewFingerprint(repo))
            throw new UserFacingError('暂存区或 HEAD 已变化，未暂存；请重新审查当前文件。');
        await repo.add([uri.fsPath]);
        await repo.status().catch(() => { });
        return result.applied ? '已写回并暂存。现在可以审查暂存改动并提交。' : '没有冲突标记，已暂存当前内容。';
    }
    async stage(relative: string): Promise<void> {
        const repo = this.requireRepo();
        await repo.status();
        const uri = await this.conflictPath(repo, relative);
        this.assertSaved(repo, uri);
        if (hasConflictMarkers(await this.readDisk(uri)))
            throw new UserFacingError('仍有冲突标记，请先完成编辑。');
        await repo.add([uri.fsPath]);
        await repo.status().catch(() => { });
    }
    private async readDisk(uri: vscode.Uri): Promise<string> {
        if ((await vscode.workspace.fs.stat(uri)).size > MAX_FILE_BYTES) throw new UserFacingError('文件超过 180 KB，请在编辑器中处理。');
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new UserFacingError('文件过大或为二进制，请在 Source Control 中处理。');
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    async open(relative: string): Promise<void> { await vscode.window.showTextDocument(await this.confined(this.requireRepo(), relative)); }
    async suggestCommitMessage(): Promise<void> {
        const repo = this.requireRepo(), message = await this.gitFile(repo, 'MERGE_MSG');
        repo.inputBox.value = message || `Merge branch into ${repo.state.HEAD?.name || 'HEAD'}\n\n冲突已在 Generative Git 里解决。`;
        await vscode.commands.executeCommand('workbench.view.scm');
    }
    private async reviewFingerprint(repo: Repository): Promise<string> {
        const metadata = await this.metadata.identity(repo);
        if (typeof repo.getObjectDetails !== 'function')
            throw new UserFacingError('当前 Git API 无法核对暂存对象，无法安全审查提交。');
        // Enumerate and hash the index through the same Git API used for
        // review/commit. A copied or redirected on-disk index is not evidence
        // of what this Git repository will actually commit.
        const changes = await repo.diffIndexWithHEAD();
        const entries: unknown[][] = [];
        for (const change of changes) {
            const relative = path.relative(repo.rootUri.fsPath, change.uri.fsPath);
            resolveInside(repo.rootUri.fsPath, relative);
            const objects: unknown[] = [];
            if (change.status !== 2) {
                const conflict = repo.state.mergeChanges.some(c => samePath(c.uri.fsPath, change.uri.fsPath));
                for (const ref of conflict ? [':1', ':2', ':3'] : ['']) {
                    const object = await repo.getObjectDetails(ref, change.uri.fsPath);
                    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(object.object) || !/^[0-7]{6}$/.test(object.mode))
                        throw new UserFacingError('Git 返回的暂存对象信息无效，操作已停止。');
                    objects.push([ref, object.mode, object.object]);
                }
            }
            entries.push([relative, path.relative(repo.rootUri.fsPath, change.originalUri.fsPath), change.status, objects]);
        }
        entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const refs = ['HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;
        const metadataRefs = await Promise.all(refs.map(name => this.gitFile(repo, name)));
        let hash = '';
        try { hash = (await repo.getCommit('HEAD')).hash; }
        catch (error) { if (repo.state.HEAD?.commit) throw error; } // Unborn HEAD.
        if ((await this.metadata.identity(repo)).identity !== metadata.identity)
            throw new UserFacingError('读取期间 Git 元数据目录已变化，操作已停止。');
        return createHash('sha256')
            .update(JSON.stringify([repo.rootUri.fsPath, metadata.identity, repo.state.HEAD?.name, hash, metadataRefs, entries]))
            .digest('hex');
    }
    private async commitBlocker(repo: Repository, merge: boolean): Promise<string | undefined> {
        if (repo.state.mergeChanges.length) return '仍有未解决的冲突，请先完成解决。';
        if (repo.state.rebaseCommit || await this.gitFile(repo, 'CHERRY_PICK_HEAD') || await this.gitFile(repo, 'REVERT_HEAD'))
            return '当前正在变基、拣选或撤销提交，请在 Source Control 中完成该流程。';
        if (!repo.state.indexChanges.length && !merge) return '没有已暂存的改动。请先在 Source Control 中暂存文件。';
        // The native smart-commit flow may stage everything if the index is
        // empty. Only allow an empty-index merge when there is nothing to stage.
        if (!repo.state.indexChanges.length && merge) {
            try { this.assertSaved(repo); } catch (error) { return describeGitError(error); }
            if (repo.state.workingTreeChanges.length || repo.state.untrackedChanges?.length)
                return '无暂存差异的合并仍有本地改动。请先处理这些改动，避免官方智能提交将其一并暂存。';
        }
        for (const change of repo.state.indexChanges) {
            if (change.status === 2) continue; // INDEX_DELETED: no stage-0 blob.
            const relative = path.relative(repo.rootUri.fsPath, change.uri.fsPath);
            // A gitlink records a submodule commit, not a text blob to scan.
            if (repo.getObjectDetails && (await repo.getObjectDetails('', change.uri.fsPath)).mode === '160000') continue;
            const staged = await repo.show(':0', change.uri.fsPath);
            if (!staged.includes('\0') && hasConflictMarkers(staged))
                return `暂存内容仍含冲突标记：${relative}。请修复并重新暂存。`;
        }
    }
    async reviewStaged(requestedPath?: string): Promise<StagedReview> {
        const repo = this.requireRepo();
        await repo.status();
        const token = await this.reviewFingerprint(repo);
        const files = (await repo.diffIndexWithHEAD()).map(c => ({
            path: path.relative(repo.rootUri.fsPath, c.uri.fsPath), status: statusLabel(c.status)
        }));
        const selected = requestedPath && files.some(f => f.path === requestedPath) ? requestedPath : files[0]?.path;
        let patch = '';
        if (selected) {
            resolveInside(repo.rootUri.fsPath, selected);
            patch = await repo.diffIndexWithHEAD(resolveInside(repo.rootUri.fsPath, selected));
        }
        const merge = !!await this.gitFile(repo, 'MERGE_HEAD');
        const blocked = await this.commitBlocker(repo, merge);
        const suggestedMessage = repo.inputBox.value || (merge ? await this.gitFile(repo, 'MERGE_MSG') : '');
        if (token !== await this.reviewFingerprint(repo))
            throw new UserFacingError('读取期间仓库发生变化，请重新加载审查。');
        this.reviewTokens.set(repo.rootUri.fsPath, token);
        return {
            repoId: repo.rootUri.fsPath, headName: repo.state.HEAD?.name || 'HEAD', token, merge, files,
            path: selected, patch: patch.slice(0, MAX_FILE_BYTES), truncated: patch.length > MAX_FILE_BYTES,
            suggestedMessage, unstagedCount: this.workingChanges(repo).length,
            blocked
        };
    }
    async commitStaged(repoId: string, token: string, message: string): Promise<string | undefined> {
        const repo = this.requireRepo();
        if (!samePath(repo.rootUri.fsPath, repoId)) throw new UserFacingError('当前仓库已切换，请重新审查。');
        if (!message.trim() || message.length > 20000 || message.includes('\0'))
            throw new UserFacingError('请输入有效的提交说明（不超过 20,000 字符）。');
        if (this.reviewTokens.get(repoId) !== token) throw new UserFacingError('请先加载暂存改动并审查。');
        await repo.status();
        const merge = !!await this.gitFile(repo, 'MERGE_HEAD');
        const blocked = await this.commitBlocker(repo, merge);
        if (blocked) throw new UserFacingError(blocked);
        if (token !== await this.reviewFingerprint(repo)) {
            this.reviewTokens.delete(repoId);
            throw new UserFacingError('HEAD 或暂存区已变化，请重新加载并审查后再提交。');
        }
        // Native command supplies branch protection (including providers),
        // diagnostics, signing, sign-off and save-before-commit preferences.
        this.reviewTokens.delete(repoId);
        const hash = await nativeCommit(repo, message.trim(), async () => {
            if (token !== await this.reviewFingerprint(repo))
                throw new UserFacingError('进入官方提交前暂存区或仓库已变化，请重新加载审查。');
        });
        await repo.status().catch(() => {});
        this.schedule();
        return hash;
    }
    async inspectCommit(hash: string, requestedPath?: string): Promise<CommitDetail> {
        const repo = this.requireRepo();
        if (!/^[0-9a-f]{7,64}$/i.test(hash))
            throw new UserFacingError('无效的提交。');
        const commit = await repo.getCommit(hash);
        const parent = commit.parents[0];
        // API v1 uses a three-dot merge-base comparison, which cannot accept an
        // empty tree as a root commit's parent. Do not claim a fabricated diff.
        if (!parent) return {
            hash: commit.hash, message: commit.message, author: commit.authorName,
            date: commit.authorDate?.toISOString(), files: [],
            note: '根提交没有父提交，内置 Git API 的 diffBetween 不支持空树比较。请在编辑器内置提交历史中查看文件差异。'
        };
        const changes = await repo.diffBetween(parent, commit.hash);
        const files = changes.map(c => ({ path: path.relative(repo.rootUri.fsPath, c.uri.fsPath), status: statusLabel(c.status) }));
        const selected = requestedPath || files[0]?.path;
        if (selected && !files.some(f => f.path === selected))
            throw new UserFacingError('该文件不在所选提交中。');
        let patch: string | undefined;
        if (selected) {
            resolveInside(repo.rootUri.fsPath, selected);
            patch = await repo.diffBetween(parent, commit.hash, resolveInside(repo.rootUri.fsPath, selected));
        }
        return { hash: commit.hash, message: commit.message, parent, author: commit.authorName, date: commit.authorDate?.toISOString(), files, path: selected, patch: patch?.slice(0, MAX_FILE_BYTES), truncated: (patch?.length || 0) > MAX_FILE_BYTES, note: commit.parents.length > 1 ? '合并提交：显示相对第一父提交的变更。' : undefined };
    }
    dispose(): void { clearTimeout(this.timer); for (const d of [...this.subscriptions, ...this.repositories.values()])
        d.dispose(); this.changed.dispose(); }
}
