import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubReader, connectGitHub, parseGitHubRemote, safePullRequestUrl } from '../git/github';
import { authentication } from './vscode';

const remote = 'https://github.com/acme/app.git';
const branch = 'feat/thread';
const token = 'private-fixture-token';
const auth = async () => ({ accessToken: token });
const pr = () => ({ number: 12, title: 'Thread UI', state: 'open', merged_at: null,
    html_url: 'https://attacker.invalid/ignored',
    head: { sha: 'a'.repeat(40), ref: branch, repo: { full_name: 'acme/app' } },
    base: { ref: 'main', repo: { full_name: 'acme/app' } } });
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const checks = { total_count: 1, check_runs: [{ name: 'Tests', status: 'completed', conclusion: 'success' }] };

test('GitHub remotes and browser URLs cannot select arbitrary hosts, protocols or paths', () => {
    for (const value of [remote, 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app', 'https://user:password@github.com/acme/app'])
        assert.deepEqual(parseGitHubRemote(value), { owner: 'acme', repo: 'app' });
    for (const value of ['file://github.com/acme/app', 'https://github.com.evil/acme/app', 'https://github.com:123/acme/app',
        'https://github.com/acme/../app', 'https://github.com/acme/%2e%2e', 'https://github.com/acme/app?token=secret',
        'https://github.com/acme/app/tree/main', '../app', 'git@other.invalid:acme/app', 'https://github.com/acme/app#x'])
        assert.equal(parseGitHubRemote(value), undefined, value);
    assert.equal(safePullRequestUrl('https://github.com/acme/app/pull/12'), true);
    for (const value of ['https://user:pass@github.com/acme/app/pull/12', 'https://github.com/acme/app/pull/12/evil',
        'https://github.com/acme/app/pull/12?redirect=evil', 'https://github.com/acme/app/pull/0', 'command:run', 'javascript:alert(1)'])
        assert.equal(safePullRequestUrl(value), false, value);
});

test('passive authentication is silent; unsupported remotes and absent sessions make no requests', async () => {
    const previous = authentication.getSession;
    let calls = 0;
    authentication.getSession = async (_provider, _scopes, options) => {
        calls++; assert.deepEqual(options, { silent: true }); return undefined;
    };
    const reader = new GitHubReader({ fetch: async () => { throw new Error('Must not request'); } });
    try {
        assert.deepEqual(await reader.read('https://gitlab.com/acme/app', branch), { kind: 'unavailable', reason: 'not-github' });
        assert.equal(calls, 0);
        assert.deepEqual(await reader.read(remote, branch), { kind: 'unavailable', reason: 'no-auth' });
        assert.equal(calls, 1);
        authentication.getSession = async (_p, _s, options) => { assert.deepEqual(options, { createIfNone: true }); return { accessToken: token }; };
        assert.equal(await connectGitHub(), true);
    } finally { reader.dispose(); authentication.getSession = previous; }
});

test('PR reads are bounded GETs without redirects and return canonical links, never tokens', async () => {
    const calls: string[] = [];
    const reader = new GitHubReader({ getSession: auth, fetch: async (input, init) => {
        const url = String(input); calls.push(url);
        assert.equal(new URL(url).origin, 'https://api.github.com');
        assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
        assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
        return url.includes('/pulls?') ? json([pr()]) : json(checks);
    } });
    try {
        const result = await reader.read(remote, branch);
        assert.equal(result.kind, 'ok');
        if (result.kind !== 'ok') return;
        assert.equal(result.pullRequest.url, 'https://github.com/acme/app/pull/12');
        assert.equal(result.pullRequest.checks[0].conclusion, 'success');
        assert.equal(JSON.stringify(result).includes(token), false);
        assert.equal(new URL(calls[0]).searchParams.get('head'), 'acme:feat/thread');
        await reader.read(remote, branch);
        assert.equal(calls.length, 2, 'cache avoids repeat network requests');
    } finally { reader.dispose(); }
});

test('malformed or unrelated PR identities cannot become UI state or browser links', async () => {
    for (const item of [ { ...pr(), number: -1 }, { ...pr(), number: '12' }, { ...pr(), title: {} },
        { ...pr(), head: { ...pr().head, ref: 'other' } }, { ...pr(), head: { ...pr().head, sha: '../x' } },
        { ...pr(), base: { ...pr().base, repo: { full_name: 'someone/private' } } }, { ...pr(), merged_at: {} } ]) {
        let calls = 0;
        const reader = new GitHubReader({ getSession: auth, fetch: async () => { calls++; return json([item]); } });
        assert.deepEqual(await reader.read(remote, branch), { kind: 'unavailable', reason: 'error' });
        assert.equal(calls, 1); reader.dispose();
    }
});

test('status errors, redirects, oversized bodies and rate limits fail closed', async () => {
    for (const response of [() => json({ secret: token }, 404), () => json([], 302),
        () => json([pr()], 200, { 'content-length': '9999999' }), () => new Response(' '.repeat(2 * 1024 * 1024 + 1))]) {
        const reader = new GitHubReader({ getSession: auth, fetch: async () => response() });
        assert.deepEqual(await reader.read(remote, branch), { kind: 'unavailable', reason: 'error' }); reader.dispose();
    }
    let calls = 0;
    const limited = new GitHubReader({ getSession: auth, fetch: async () => { calls++; return json({}, 429, { 'retry-after': '120' }); } });
    assert.deepEqual(await limited.read(remote, branch), { kind: 'unavailable', reason: 'rate-limited' });
    limited.clear();
    await limited.read(remote, branch);
    assert.equal(calls, 1, 'manual refresh respects rate-limit backoff'); limited.dispose();
});

test('checks failures and pagination are explicit; account changes never reuse another account cache', async () => {
    let accountToken = token, calls = 0;
    const reader = new GitHubReader({ getSession: async () => ({ accessToken: accountToken }), fetch: async input => {
        calls++;
        return String(input).includes('/pulls?') ? json([{ ...pr(), state: 'closed', merged_at: '2026-01-01T00:00:00Z' }])
            : json({ ...checks, total_count: 101 });
    } });
    const first = await reader.read(remote, branch);
    assert.equal(first.kind === 'ok' && first.pullRequest.state, 'merged');
    assert.equal(first.kind === 'ok' && first.pullRequest.checksPartial, true);
    accountToken = 'second-account'; await reader.read(remote, branch); assert.equal(calls, 4); reader.dispose();
    const failed = new GitHubReader({ getSession: auth, fetch: async input => String(input).includes('/pulls?') ? json([pr()]) : json({}, 503) });
    const result = await failed.read(remote, branch);
    assert.equal(result.kind === 'ok' && result.pullRequest.checksUnavailable, true); failed.dispose();
});

test('in-flight cancellation prevents obsolete requests from populating the cache', async () => {
    let finish!: (value: Response) => void;
    const reader = new GitHubReader({ getSession: auth, fetch: async input => String(input).includes('/pulls?')
        ? await new Promise(resolve => { finish = resolve; }) : json(checks) });
    const pending = reader.read(remote, branch);
    await new Promise(resolve => setImmediate(resolve));
    const joined = reader.read(remote, branch);
    await new Promise(resolve => setImmediate(resolve));
    reader.clear(); finish(json([pr()]));
    assert.deepEqual(await pending, { kind: 'unavailable', reason: 'error' });
    assert.deepEqual(await joined, { kind: 'unavailable', reason: 'error' }); reader.dispose();
});
