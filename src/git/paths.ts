import { UserFacingError } from './errors';
import path from 'node:path';
export function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b); }
export function resolveInside(root: string, relative: string): string {
    if (!relative || relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).includes('..') || relative.startsWith('\\'))
        throw new UserFacingError('文件路径必须在当前仓库内。');
    const result = path.resolve(root, relative), rel = path.relative(root, result);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        throw new UserFacingError('文件路径必须在当前仓库内。');
    return result;
}
