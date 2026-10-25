import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekError, requestProposal } from '../ai/deepseek';
import { buildAiContext, AiPolicyError, validateProposal } from '../ai/policy';
import { asHostMessage } from '../shared/protocol';
import type { Snapshot } from '../shared/protocol';
import type { AiContext, AiProposal } from '../shared/ai';

const hash = 'a'.repeat(40);
const snapshot: Snapshot = {
    repoId: '/repo', repoName: 'acme', repositories: [], headName: 'feat/session', headHash: hash,
    branches: ['main', 'feat/session'], conflicts: [], workingTreeCount: 2, stagedCount: 1,
    mergeHead: false, rebasing: false, canMerge: true, canAbort: true,
    nativeGit: { hasHead: true, hasUpstream: true },
    branchList: [
        { name: 'feat/session', ref: 'refs/heads/feat/session', local: true, current: true, ahead: 2, behind: 0 },
        { name: 'main', ref: 'refs/heads/main', local: true, current: false }
    ],
    workingTreeFiles: [{ path: 'src/auth.ts', status: 'M', untracked: false }],
    graph: { laneCount: 1, nodes: [], edges: [] }
};

function sse(content: string, thinking = ''): string {
    const events = [
        thinking ? { choices: [{ delta: { reasoning_content: thinking } }] } : undefined,
        { choices: [{ delta: { content } }] },
        '[DONE]'
    ].filter(Boolean);
    return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

const context = buildAiContext(snapshot);
const input = {
    prompt: '提交暂存区', mode: 'manual' as const, context, apiKey: 'test-key',
    model: 'deepseek-v4-pro', effort: 'high' as const, thinking: true
};

test('DeepSeek client streams reasoning and final JSON with thinking settings', async () => {
    let body: any, headers: any, thinking = '', content = '';
    const proposal = '{"action":"commit","analysis":["检查暂存区"],"reason":"仅提交暂存文件","commit":{"message":"fix: refresh session"}}';
    const result = await requestProposal({ ...input, onThinking: text => { thinking = text; }, onContent: text => { content = text; } }, {
        fetchImpl: (async (_url: string, init: RequestInit) => {
            body = JSON.parse(String(init.body)); headers = init.headers;
            return new Response(sse(proposal, '先检查暂存区。'), { status: 200 });
        }) as typeof fetch
    });
    assert.equal(result.action, 'commit');
    assert.equal(result.commit?.message, 'fix: refresh session');
    assert.equal(thinking, '先检查暂存区。');
    assert.equal(content, proposal);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.stream, true);
    assert.equal((headers as Record<string, string>).authorization, 'Bearer test-key');
    assert.match(body.messages[0].content, /Action background and safety boundaries/);
    assert.match(body.messages[0].content, /Return exactly one JSON object/);
    const user = JSON.parse(body.messages[1].content);
    assert.deepEqual(user.availableActions.map((x: any) => x.action), ['commit', 'fetch', 'push', 'merge', 'none']);
    assert.equal(user.outputSchema.push.remote, 'origin');
    assert.equal('command' in user.outputSchema, false);
});

test('DeepSeek client reports auth and malformed JSON with controlled text', async () => {
    await assert.rejects(
        requestProposal(input, { fetchImpl: (async () => new Response('bad key', { status: 401 })) as typeof fetch }),
        (e: unknown) => e instanceof DeepSeekError && e.code === 'unauthorized'
    );
    await assert.rejects(
        requestProposal(input, { fetchImpl: (async () => new Response(sse('not-json'), { status: 200 })) as typeof fetch }),
        (e: unknown) => e instanceof DeepSeekError && e.code === 'format'
    );
});

test('AI policy derives commands and rejects unsafe or stale proposals', () => {
    const commit = validateProposal({ action: 'commit', analysis: [], reason: 'x', commit: { message: 'fix: quote\'s' } }, snapshot, context);
    assert.equal(commit.command, "git commit -m 'fix: quote'\\''s'");
    assert.equal(validateProposal({ action: 'fetch', analysis: [], reason: 'x' }, snapshot, context).command, 'git fetch origin');
    assert.equal(validateProposal({ action: 'push', analysis: [], reason: 'x', push: { remote: 'upstream', branch: 'feat/session' } }, snapshot, context).command,
        'git push origin HEAD:refs/heads/feat/session');
    assert.equal(validateProposal({ action: 'merge', analysis: [], reason: 'x', merge: { source: 'main' } }, snapshot, context).command, 'git merge --no-ff main');
    assert.throws(() => validateProposal({ action: 'push', analysis: [], reason: 'x', push: { remote: 'evil', branch: 'other' } }, snapshot, context), AiPolicyError);
    assert.throws(() => validateProposal({ action: 'merge', analysis: [], reason: 'x', merge: { source: 'unknown' } }, snapshot, context), AiPolicyError);
    assert.throws(() => validateProposal({ action: 'commit', analysis: [], reason: 'x' }, { ...snapshot, stagedCount: 0 }, context), AiPolicyError);
    assert.throws(() => validateProposal({ action: 'push', analysis: [], reason: 'x', push: { remote: 'origin', branch: 'feat/session' } }, { ...snapshot, conflicts: [{ path: 'a', status: '冲突', hunks: [] }] }, context), AiPolicyError);
});

test('AI host messages reject bad prompts and ids', () => {
    assert.deepEqual(asHostMessage({ type: 'ai-set-key' }), { type: 'ai-set-key' });
    assert.deepEqual(asHostMessage({ type: 'ai-ask', requestId: 7, prompt: 'hello', mode: 'manual' }), { type: 'ai-ask', requestId: 7, prompt: 'hello', mode: 'manual' });
    assert.equal(asHostMessage({ type: 'ai-ask', requestId: 7, prompt: '', mode: 'manual' }), undefined);
    assert.equal(asHostMessage({ type: 'ai-ask', requestId: 7, prompt: 'x', mode: 'live' }), undefined);
    assert.equal(asHostMessage({ type: 'ai-ask', requestId: 1.5, prompt: 'x', mode: 'manual' }), undefined);
    assert.equal(asHostMessage({ type: 'ai-cancel', requestId: 'x' }), undefined);
});
