import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRemote, readPullRequest } from '../git/github';

const remote = 'https://github.com/acme/webapp.git';

const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const openPr = {
    number: 128,
    title: 'Refresh sessions in the auth middleware',
    state: 'open',
    merged_at: null,
    html_url: 'https://github.com/acme/webapp/pull/128',
    head: { sha: 'abc123', ref: 'feat/session-refresh' },
    base: { ref: 'main' }
};

const auth = async () => ({ accessToken: 'fixture-token' });

test('github: parses common GitHub remotes without retaining credentials', () => {
    assert.deepEqual(parseGitHubRemote('https://github.com/acme/webapp.git'), { owner: 'acme', repo: 'webapp' });
    assert.deepEqual(parseGitHubRemote('git@github.com:acme/webapp.git'), { owner: 'acme', repo: 'webapp' });
    assert.deepEqual(parseGitHubRemote('ssh://git@github.com/acme/webapp'), { owner: 'acme', repo: 'webapp' });
    assert.deepEqual(parseGitHubRemote('https://user:pass@github.com/acme/webapp.git'), { owner: 'acme', repo: 'webapp' });
    assert.equal(parseGitHubRemote('https://gitlab.com/acme/webapp.git'), undefined);
    assert.equal(parseGitHubRemote('https://github.com/acme/webapp/tree/main'), undefined);
    assert.equal(parseGitHubRemote('../webapp'), undefined);
});

test('github: no session is an explicit unavailable result and makes no request', async () => {
    let called = false;
    const result = await readPullRequest(remote, 'feat/session-refresh', {
        getSession: async () => undefined,
        fetch: async () => { called = true; return response(200, []); }
    });
    assert.deepEqual(result, { kind: 'unavailable', reason: 'no-auth' });
    assert.equal(called, false);
});

test('github: non-GitHub remote is rejected before auth or network', async () => {
    let called = false;
    const result = await readPullRequest('https://gitlab.com/acme/webapp.git', 'main', {
        getSession: async () => { called = true; return { accessToken: 'fixture-token' }; },
        fetch: async () => { called = true; return response(200, []); }
    });
    assert.deepEqual(result, { kind: 'unavailable', reason: 'not-github' });
    assert.equal(called, false);
});

test('github: reads the current PR and its check runs with GET only', async () => {
    const calls: { url: string; method?: string; auth?: string }[] = [];
    const result = await readPullRequest(remote, 'feat/session-refresh', {
        getSession: auth,
        fetch: async (url, init) => {
            calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization });
            if (url.includes('/pulls?')) return response(200, [openPr]);
            if (url.includes('/check-runs?')) return response(200, {
                check_runs: [
                    { name: 'Tests', status: 'completed', conclusion: 'success' },
                    { name: 'Preview', status: 'in_progress', conclusion: null }
                ]
            });
            return response(404, {});
        }
    });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.pullRequest.number, 128);
    assert.equal(result.pullRequest.state, 'open');
    assert.equal(result.pullRequest.headSha, 'abc123');
    assert.equal(result.pullRequest.checks.length, 2);
    assert.deepEqual(result.pullRequest.checks[0], { name: 'Tests', status: 'completed', conclusion: 'success' });
    assert.equal(result.pullRequest.checksUnavailable, undefined);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.ok(calls.every(call => call.auth === 'Bearer fixture-token'));
    assert.match(calls[0].url, /pulls\?head=acme%3Afeat%2Fsession-refresh/);
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
});

test('github: merged PR is represented, and failed checks degrade without hiding the PR', async () => {
    const result = await readPullRequest(remote, 'feat/session-refresh', {
        getSession: auth,
        fetch: async (url) => {
            if (url.includes('/pulls?')) return response(200, [{ ...openPr, state: 'closed', merged_at: '2026-10-22T06:00:00Z' }]);
            return response(503, {});
        }
    });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.pullRequest.state, 'merged');
    assert.equal(result.pullRequest.checksUnavailable, true);
    assert.deepEqual(result.pullRequest.checks, []);
});

test('github: no PR, rate limit and server errors stay unavailable without leaking bodies', async () => {
    const noPr = await readPullRequest(remote, 'main', {
        getSession: auth,
        fetch: async () => response(200, [])
    });
    assert.deepEqual(noPr, { kind: 'unavailable', reason: 'no-pr' });

    const limited = await readPullRequest(remote, 'main', {
        getSession: auth,
        fetch: async () => response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })
    });
    assert.deepEqual(limited, { kind: 'unavailable', reason: 'rate-limited' });

    const failed = await readPullRequest(remote, 'main', {
        getSession: auth,
        fetch: async () => { throw new Error('network down'); }
    });
    assert.deepEqual(failed, { kind: 'unavailable', reason: 'error' });
});
