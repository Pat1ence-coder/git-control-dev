import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Repository } from './types';
import { samePath } from './paths';
import { UserFacingError } from './errors';

type MetadataFile = 'HEAD' | 'MERGE_HEAD' | 'MERGE_MSG' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD';
const missing = (error: unknown) => (error as { code?: string })?.code === 'ENOENT';

/** Read bounded, regular metadata files without following a final symlink. */
async function readMetadata(file: string, optional = false): Promise<string> {
    try {
        const before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.size > 512 * 1024)
            throw new UserFacingError('Git 元数据文件不安全或过大，操作已停止。');
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 512 * 1024)
                throw new UserFacingError('读取期间 Git 元数据文件被替换，操作已停止。');
            const buffer = new Uint8Array(opened.size + 1);
            let length = 0;
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
                if (!bytesRead) break;
                length += bytesRead;
            }
            if (length > opened.size) throw new UserFacingError('读取期间 Git 元数据文件发生变化，操作已停止。');
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).trim();
        } finally { await handle.close(); }
    } catch (error) {
        if (optional && missing(error)) return '';
        throw error;
    }
}

/** Validate gitfile ownership and pin the directory identity for this session.
 * External linked-worktree and submodule metadata is legitimate; an arbitrary
 * outside directory with an index file is not sufficient proof of ownership.
 */
export class GitMetadata {
    private readonly identities = new Map<string, string>();

    async identity(repo: Repository): Promise<{ directory: string; identity: string }> {
        const root = await realpath(repo.rootUri.fsPath);
        const marker = path.join(root, '.git');
        const markerStat = await lstat(marker);
        if (markerStat.isSymbolicLink()) throw new UserFacingError('不支持通过符号链接替换 .git，操作已停止。');
        let directory: string;
        let association = '';
        if (markerStat.isDirectory()) {
            directory = await realpath(marker);
        } else {
            const pointer = await readMetadata(marker);
            const match = /^gitdir: ([^\r\n\0]+)$/.exec(pointer);
            if (!match) throw new UserFacingError('无法确认 .git 指针格式，操作已停止。');
            directory = await realpath(path.resolve(root, match[1]));
            const backlink = await readMetadata(path.join(directory, 'gitdir'), true);
            if (backlink) {
                if (!samePath(await realpath(path.resolve(directory, backlink)), marker))
                    throw new UserFacingError('Git worktree 元数据不属于当前工作区，操作已停止。');
                const common = await readMetadata(path.join(directory, 'commondir'));
                const commonDirectory = await realpath(path.resolve(directory, common));
                if (!common || !samePath(path.dirname(path.dirname(directory)), commonDirectory)
                    || path.basename(path.dirname(directory)) !== 'worktrees')
                    throw new UserFacingError('Git worktree 的公共元数据关联无效，操作已停止。');
                association = `worktree:${backlink}:${commonDirectory}`;
            } else {
                // Submodules normally record core.worktree relative to their
                // external metadata directory. Ask the same installed Git API
                // that performs operations, rather than parsing config ourselves.
                let worktree = '';
                try { worktree = await repo.getConfig('core.worktree'); } catch { /* fail closed below */ }
                if (!worktree || !samePath(await realpath(path.resolve(directory, worktree)), root))
                    throw new UserFacingError('无法确认外部 Git 元数据与当前工作区的关联，操作已停止。');
                association = `core.worktree:${worktree}`;
            }
        }
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UserFacingError('Git 元数据目录无效，操作已停止。');
        const identity = JSON.stringify([root, directory, stat.dev, stat.ino, markerStat.isDirectory() ? 'directory' : 'gitfile', association]);
        const previous = this.identities.get(root);
        if (previous && previous !== identity)
            throw new UserFacingError('Git 元数据目录已变化，操作已停止。请确认仓库位置并重新打开工作区后再审查。');
        this.identities.set(root, identity);
        return { directory, identity };
    }

    async read(repo: Repository, name: MetadataFile): Promise<string> {
        const before = await this.identity(repo);
        const value = await readMetadata(path.join(before.directory, name), true);
        if ((await this.identity(repo)).identity !== before.identity)
            throw new UserFacingError('读取期间 Git 元数据目录已变化，操作已停止。');
        return value;
    }
}
