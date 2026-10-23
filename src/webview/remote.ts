import type { PullRequestCheck, PullRequestState } from '../shared/protocol';
import { esc } from '../shared/html';
import { button, icon } from './render';

function checkTone(check: PullRequestCheck): string {
    if (check.status === 'queued' || check.status === 'in_progress') return 'running';
    if (check.status !== 'completed') return 'neutral';
    if (check.conclusion === 'success') return 'success';
    if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(check.conclusion || '')) return 'failure';
    return 'neutral';
}
export function renderPullRequest(state?: PullRequestState, localHash?: string): string {
    if (!state) return '';
    const retry = button('refresh-github', '刷新', 'text-button');
    if (state.kind === 'unavailable') {
        if (state.reason === 'not-github') return '';
        const labels = { 'no-auth': 'GitHub 未连接', 'no-pr': '当前分支没有 PR', 'error': 'GitHub 暂不可用', 'rate-limited': 'GitHub 请求受限，请稍后重试' };
        return `<div class="pr-state">${esc(labels[state.reason])}${state.reason === 'no-auth' ? button('connect-github', '连接 GitHub', 'primary') : ''}${retry}</div>`;
    }
    const pr = state.pullRequest;
    const checks = pr.checks.map(c => `<span class="pr-check ${checkTone(c)}"><i aria-hidden="true"></i>${esc(c.name)}<span>${esc(c.status === 'completed' ? c.conclusion || '结果未知' : c.status)}</span></span>`).join('');
    const actions = `<span class="pr-actions">${button('open-pull-request', icon('external'), 'icon-button', `aria-label="在 GitHub 打开 PR #${pr.number}" title="在 GitHub 打开 PR"`)}${button('refresh-github', icon('refresh'), 'icon-button', 'aria-label="刷新 PR 和检查" title="刷新 PR 和检查"')}</span>`;
    return `<div class="pr-checks" aria-label="远端提交检查">${checks}${pr.checksUnavailable ? '<span class="pr-check">检查暂不可用</span>' : ''}${pr.checksPartial ? '<span class="pr-check">仅显示前 100 项，请在 GitHub 查看全部检查</span>' : ''}${actions}</div>${localHash !== pr.headSha ? `<p class="pr-note">检查对应远端提交 <code>${esc(pr.headSha.slice(0, 7))}</code>，与本地 HEAD 不同。</p>` : ''}`;
}
export function renderLoadingGraph(): string {
    return `<div class="graph-skeleton" role="status" aria-label="正在读取仓库">${[58, 44, 66, 38].map(width => `<div class="skeleton-row"><i></i><span style="width:${width}%"></span><em></em></div>`).join('')}<p>正在读取本地仓库…</p></div>`;
}
