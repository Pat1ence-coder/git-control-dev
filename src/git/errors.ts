/** Only messages authored by this extension may be displayed verbatim.
 * Never wrap external stderr/message text in this class.
 */
export class UserFacingError extends Error {}

const gitMessages: Record<string, string> = {
    AuthenticationFailed: 'Git 认证失败，请检查编辑器的登录或凭据设置。',
    NoUserNameConfigured: 'Git 未配置提交用户名。',
    NoUserEmailConfigured: 'Git 未配置提交邮箱。',
    DirtyWorkTree: '工作区有未处理的改动，请先提交或 stash。',
    Conflict: 'Git 检测到合并冲突，请先解决冲突。',
    UnmergedChanges: '仍有未解决的冲突，无法提交。',
    RepositoryIsLocked: 'Git 仓库正被其他操作占用，请稍后重试。',
    BadConfigFile: 'Git 配置文件无效，请检查仓库配置。',
    EmptyCommitMessage: '提交说明为空，操作已取消。',
    NotAGitRepository: '当前目录不是可用的 Git 仓库。',
    GitNotFound: '未找到 Git，请检查编辑器的 Git 配置。'
};
const fileMessages: Record<string, string> = {
    ENOENT: '所需文件不存在，请刷新仓库。',
    FileNotFound: '所需文件不存在，请刷新仓库。',
    EACCES: '文件访问权限不足，操作未完成。',
    EPERM: '系统拒绝了文件操作，操作未完成。',
    ELOOP: '检测到不安全的文件链接，操作已停止。'
};
export function describeGitError(error: unknown): string {
    if (error instanceof UserFacingError) return error.message;
    const value = error as { gitErrorCode?: unknown; code?: unknown } | undefined;
    const gitCode = value?.gitErrorCode, fileCode = value?.code;
    if (typeof gitCode === 'string' && Object.prototype.hasOwnProperty.call(gitMessages, gitCode))
        return gitMessages[gitCode];
    if (typeof fileCode === 'string' && Object.prototype.hasOwnProperty.call(fileMessages, fileCode))
        return fileMessages[fileCode];
    return '操作未完成。外部错误详情已隐藏，以免泄露凭据或本机路径。请检查 Git 状态、配置及仓库 hooks。';
}
