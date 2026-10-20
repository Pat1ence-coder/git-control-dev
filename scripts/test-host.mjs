// No downloads, external remotes or edits to the user's editor profile.
// Use a desktop VS Code/Cursor executable, not a remote CLI attached to an
// existing window. --prepare-only validates the fixture without launching it.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const prepareOnly = process.argv.includes('--prepare-only');
const executable = process.env.VSCODE_EXECUTABLE;
if (!prepareOnly && !executable) {
    throw new Error('Set VSCODE_EXECUTABLE to a desktop VS Code/Cursor executable. No host tests were run.');
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'generative-git-host-'));
const root = path.join(temp, 'workspace'), resultFile = path.join(temp, 'result.json');
const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'gitconfig'),
    GENERATIVE_GIT_HOST_FIXTURE: root, GENERATIVE_GIT_HOST_RESULT: resultFile
};
function run(command, args, options = {}) {
    const stdout = path.join(temp, 'command.stdout'), stderr = path.join(temp, 'command.stderr');
    const out = openSync(stdout, 'w'), err = openSync(stderr, 'w');
    try {
        const result = spawnSync(command, args, { env, ...options, stdio: ['ignore', out, err] });
        if (result.error || result.status !== 0)
            throw new Error(`${command} failed: ${result.error || readFileSync(stderr, 'utf8') || result.status}`);
        return readFileSync(stdout, 'utf8');
    } finally { closeSync(out); closeSync(err); }
}
try {
    await mkdir(root); await writeFile(env.GIT_CONFIG_GLOBAL, '');
    const git = (...args) => run('git', ['-C', root, ...args]);
    git('init', '-b', 'main'); git('config', 'user.name', 'Host Test'); git('config', 'user.email', 'host@example.invalid');
    await writeFile(path.join(root, 'file.txt'), 'base\n');
    git('add', '.'); git('commit', '-m', 'base'); git('branch', 'feature');
    const remote = path.join(temp, 'remote.git');
    run('git', ['init', '--bare', remote]); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
    const key = path.join(temp, 'signing-key');
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    git('config', 'gpg.format', 'ssh'); git('config', 'user.signingkey', key);
    git('config', 'commit.gpgSign', 'false'); // Editor setting must be the source of -S.
    await mkdir(path.join(root, '.vscode'));
    await writeFile(path.join(root, '.vscode/settings.json'), JSON.stringify({
        'git.enableCommitSigning': true, 'git.alwaysSignOff': true,
        'git.postCommitCommand': 'push', 'git.promptToSaveFilesBeforeCommit': 'never',
        'git.enableSmartCommit': true, 'git.useEditorAsCommitInput': false,
        'git.branchProtection': [], 'git.diagnosticsCommitHook.enabled': false,
        'git.autofetch': false
    }, null, 2));
    if (prepareOnly) {
        console.log('Isolated repository, local remote and SSH signing fixture prepared successfully. Extension Host was NOT run.');
    } else {
        run(executable, [
            '--new-window', '--wait', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            `--user-data-dir=${path.join(temp, 'profile')}`,
            `--extensions-dir=${path.join(temp, 'extensions')}`,
            `--extensionDevelopmentPath=${project}`,
            `--extensionTestsPath=${path.join(project, 'dist/host-test.js')}`,
            root
        ], { timeout: 180000 });
        const result = JSON.parse(await readFile(resultFile, 'utf8'));
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    }
} finally {
    await rm(temp, { recursive: true, force: true });
}
