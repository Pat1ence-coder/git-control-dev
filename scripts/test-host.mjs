// No downloads, external remotes or edits to the user's editor profile.
// Use a desktop VS Code/Cursor executable, not a remote CLI attached to an
// existing window. --prepare-only validates the fixture without launching it.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const prepareOnly = process.argv.includes('--prepare-only');
const executable = process.env.VSCODE_EXECUTABLE;
if (!prepareOnly && !executable) {
    throw new Error('Set VSCODE_EXECUTABLE to a desktop VS Code/Cursor executable. No host tests were run.');
}
if (executable?.includes('remote-cli')) throw new Error('Use an isolated desktop executable, not a running remote editor CLI.');
const temp = await mkdtemp(path.join(os.tmpdir(), 'generative-git-host-'));
const root = path.join(temp, 'workspace'), resultFile = path.join(temp, 'result.json');
const second = path.join(temp, 'second');
const workspaceFile = path.join(temp, 'acceptance.code-workspace');
const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'gitconfig'),
    GIT_ALLOW_PROTOCOL: 'file',
    GENERATIVE_GIT_HOST_FIXTURE: root, GENERATIVE_GIT_HOST_SECOND: second, GENERATIVE_GIT_HOST_RESULT: resultFile
};
delete env.VSCODE_IPC_HOOK_CLI;
delete env.ELECTRON_RUN_AS_NODE;
let dialogs;
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
    run('git', ['init', '-b', 'main', second]);
    const gitSecond = (...args) => run('git', ['-C', second, ...args]);
    gitSecond('config', 'user.name', 'Host Test'); gitSecond('config', 'user.email', 'host@example.invalid');
    await writeFile(path.join(second, 'file.txt'), 'second repo\n');
    gitSecond('add', '.'); gitSecond('commit', '-m', 'second base');
    const secondRemote = path.join(temp, 'second-remote.git');
    run('git', ['init', '--bare', '-b', 'main', secondRemote]);
    gitSecond('remote', 'add', 'origin', secondRemote); gitSecond('push', '-u', 'origin', 'main');
    await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: root }, { path: second }] }));
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
        const profile = path.join(temp, 'profile');
        await mkdir(path.join(profile, 'User'), { recursive: true });
        await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
            'git.autofetch': false, 'git.confirmSync': false, 'git.openRepositoryInParentFolders': 'never',
            'window.dialogStyle': 'custom',
            'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
            'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false
        }));
        // --extensionTestsPath intentionally disables DialogService in VS Code.
        // A temporary startup extension exercises actual confirmation UI instead.
        const testExtension = path.join(temp, 'extensions', 'generative-git.host-acceptance-0.0.0');
        await mkdir(testExtension, { recursive: true });
        await writeFile(path.join(testExtension, 'package.json'), JSON.stringify({
            name: 'host-acceptance', publisher: 'generative-git', version: '0.0.0',
            engines: { vscode: '^1.85.0' }, main: './index.js',
            activationEvents: ['onStartupFinished'], extensionDependencies: ['vscode.git']
        }));
        await writeFile(path.join(testExtension, 'index.js'), `exports.activate = function () {
            void (async function () {
                try { await require(${JSON.stringify(path.join(project, 'dist/host-test.js'))}).run(); }
                catch (error) { console.error('Isolated host acceptance failed:', error); }
                finally { await require('vscode').commands.executeCommand('workbench.action.quit'); }
            })();
        };`);
        const debugPort = process.env.GENERATIVE_GIT_HOST_CDP_PORT;
        if (debugPort) {
            if (!/^\d{4,5}$/.test(debugPort)) throw new Error('Invalid isolated host CDP port');
            dialogs = spawn(process.execPath, [path.join(project, 'scripts/host-dialogs.mjs')], { env, stdio: 'inherit' });
        }
        run(executable, [
            '--new-window', '--wait', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            '--disable-gpu', ...(process.env.GENERATIVE_GIT_HOST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
            ...(debugPort ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
            `--user-data-dir=${profile}`,
            `--extensions-dir=${path.join(temp, 'extensions')}`,
            `--extensionDevelopmentPath=${project}`,
            workspaceFile
        ], { timeout: 180000 });
        const result = JSON.parse(await readFile(resultFile, 'utf8'));
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    }
} finally {
    dialogs?.kill();
    if (process.env.GENERATIVE_GIT_HOST_ARTIFACTS) {
        const { cp } = await import('node:fs/promises');
        await mkdir(process.env.GENERATIVE_GIT_HOST_ARTIFACTS, { recursive: true });
        for (const name of ['result.json', 'command.stdout', 'command.stderr', 'profile/logs'])
            await cp(path.join(temp, name), path.join(process.env.GENERATIVE_GIT_HOST_ARTIFACTS, name), { recursive: true }).catch(() => {});
    }
    await rm(temp, { recursive: true, force: true });
}
