import type { ToHost, ToWebview, Snapshot, Strategy, CommitDetail, PullRequestState } from '../shared/protocol';
import { esc } from '../shared/html';
import { button, icon, renderGraph, renderLoadingGraph, renderPullRequestState, renderLiveStage, renderBranchPopover, livePhase, renderCommitDetail, renderReview, renderWorkingTree, type ReviewState, type LiveState } from './render';
import { version } from '../../package.json';
import { renderTaskControls, type TaskView } from './task';
import { presentTask } from './presentation';

declare function acquireVsCodeApi(): { postMessage(message: ToHost): void };
let api: ReturnType<typeof acquireVsCodeApi> | undefined;
try { api = acquireVsCodeApi(); } catch { /* No host: the page stays inert. */ }
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const freshReview = (): ReviewState => ({ loading: false, draft: '', dirty: false, committing: false });
const drafts = new Map<string, string>();
const app: {
    booted: boolean; snapshot: Snapshot | null; live: LiveState; pullRequestState?: PullRequestState;
    nativeAction?: { kind: 'push' | 'pull'; ahead: number; behind: number };
    selectedPath?: string; notice?: { text: string; level: string };
    detailOpen: boolean; detail?: CommitDetail; detailHash?: string; detailLoading: boolean; detailError?: string;
    reviewOpen: boolean; review: ReviewState; requestId: number; conflictsOpen: boolean; peekOpen: boolean; branchPickerOpen: boolean;
} = {
    booted: false, snapshot: null, live: { kind: 'overview' },
    detailOpen: false, detailLoading: false, reviewOpen: false, review: freshReview(), requestId: 0, conflictsOpen: false, peekOpen: false, branchPickerOpen: false
};
const root = document.getElementById('app')!;
root.innerHTML = `<header id="toolbar"></header><main class="task-workspace"><div id="task-context"></div><article id="task-card" class="task-card" aria-label="Git 任务"><header id="task-heading"></header><div id="branch-popover"></div><div id="graph"></div><div id="pr-checks"></div><div id="task-notice"></div><section id="stage" aria-label="任务详情"></section><div id="task-controls" class="task-controls"></div></article><p id="task-explanation"></p><div id="task-meta"></div><section id="native-confirm" aria-label="原生远端操作确认"></section><section id="working-changes" aria-label="未暂存更改"></section><section id="quick-composer" class="quick-composer" aria-label="快速提交"><label class="sr-only" for="quick-message">提交说明</label><textarea id="quick-message" rows="1" maxlength="20000" placeholder="写提交说明，或直接审查暂存区…"></textarea><div class="quick-tools"><div id="quick-context" class="quick-context"></div><span class="quick-hint">本地操作，不自动推送</span>${button('quick-review', '审查并提交', 'primary')}</div></section></main><footer id="status-bar"></footer><div id="announcer" class="sr-only" aria-live="polite"></div>`;
const htmlCache = new Map<string, string>();
let lastPhase = '';
const post = (message: ToHost) => { api?.postMessage(message); };

function update(id: string, html: string): void {
    if (htmlCache.get(id) === html) return;
    const el = document.getElementById(id)!;
    const focus = el.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const action = focus?.dataset.action;
    const key = focus?.dataset.hash || focus?.dataset.path || focus?.dataset.strategy;
    const selection = focus?.tagName === 'TEXTAREA'
        ? [(focus as HTMLTextAreaElement).selectionStart, (focus as HTMLTextAreaElement).selectionEnd] : undefined;
    const scroll = el.querySelector<HTMLElement>('.patch')?.scrollTop;
    el.innerHTML = html;
    htmlCache.set(id, html);
    if (action) {
        const replacement = Array.from(el.querySelectorAll<HTMLElement>('[data-action]')).find(e => e.dataset.action === action && (!key || e.dataset.hash === key || e.dataset.path === key || e.dataset.strategy === key));
        replacement?.focus({ preventScroll: true });
        if (selection && replacement?.tagName === 'TEXTAREA') (replacement as HTMLTextAreaElement).setSelectionRange(selection[0], selection[1]);
    }
    const patch = el.querySelector<HTMLElement>('.patch');
    if (patch && scroll !== undefined) patch.scrollTop = scroll;
}
function busy(): boolean { return app.live.kind === 'merging' || app.live.kind === 'resolving' || app.review.committing; }
function phase(): string {
    if (!app.booted) return 'loading';
    if (app.review.committing) return 'committing';
    if (app.reviewOpen && !app.detailOpen) return 'reviewing';
    return livePhase(app.snapshot, app.live);
}
function render(): void {
    const current = phase(); root.dataset.phase = current;
    const disabled = busy() ? 'disabled' : '';
    const repoName = app.snapshot?.repoName || '未打开仓库';
    const head = app.snapshot?.headName || '—';
    const task: TaskView = { ...app, phase: current, busy: busy() };
    const presentation = presentTask({ phase: current, snapshot: app.snapshot, live: app.live, pullRequest: app.pullRequestState?.kind === 'ok' ? app.pullRequestState.pullRequest : undefined });
    update('toolbar', `<div class="brand">${icon('branch')}<strong>Generative Git</strong></div><div class="toolbar-controls">${button('refresh', icon('refresh'), 'icon-button', 'aria-label="刷新" title="刷新"')}${api ? button('open-workbench', icon('expand'), 'icon-button', 'aria-label="在编辑器中展开" title="在编辑器中展开"') : ''}</div>`);
    const branchTrigger = app.snapshot
        ? `<button class="branch-trigger${app.branchPickerOpen ? ' active' : ''}" type="button" data-action="choose-branch" aria-haspopup="dialog" aria-expanded="${app.branchPickerOpen}" title="浏览分支">${esc(head)}${icon('chevron')}</button>`
        : `<code>${esc(head)}</code>`;
    update('task-context', `<div class="breadcrumb">${icon('branch')}<span>${esc(repoName)}</span><span class="context-divider">/</span>${branchTrigger}${(app.snapshot?.repositories.length || 0) > 1 ? `<select data-action="select-repo" aria-label="切换仓库" ${disabled}>${app.snapshot!.repositories.map(r => `<option value="${esc(r.id)}" ${r.id === app.snapshot!.repoId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : ''}</div>`);
    const quickVisible = !!app.snapshot && !app.reviewOpen && !app.detailOpen && !['confirm', 'abort-confirm', 'error'].includes(app.live.kind);
    root.dataset.quick = quickVisible ? 'true' : 'false';
    update('quick-context', app.snapshot ? `<span class="quick-chip">${icon('file')}${esc(repoName)}</span><span class="quick-chip">${icon('branch')}${esc(head)}</span>` : '');
    update('task-heading', `<h1>${esc(presentation.title)}</h1><span class="task-state ${presentation.status.tone}"><i></i>${esc(presentation.status.label)}</span>`);
    update('branch-popover', app.branchPickerOpen && app.snapshot ? renderBranchPopover(app.snapshot) : '');
    const preview = app.snapshot?.preview;
    let graph = preview?.graph ?? app.snapshot?.graph;
    if (graph && !preview && app.live.kind === 'committed') {
        const hash = app.live.hash;
        graph = { ...graph, edges: graph.edges.map(edge => edge.from === hash ? { ...edge, style: 'join' } : edge) };
    }
    if (graph && !preview && app.snapshot && !app.snapshot.mergeHead && (app.snapshot.workingTreeCount || app.snapshot.stagedCount)) {
        const tip = graph.nodes.find(n => n.tip);
        graph = { ...graph, nodes: [{ id: 'working-tree', hash: `${app.snapshot.workingTreeCount + app.snapshot.stagedCount} 项`, title: '未提交的改动', lane: tip?.lane || 0, row: 0, badges: ['工作区'], role: 'ghost' }, ...graph.nodes.map(n => ({ ...n, row: n.row + 1 }))], edges: tip ? [{ id: 'working-tree-edge', from: 'working-tree', to: tip.id, style: 'pending' }, ...graph.edges] : graph.edges };
    }
    const graphBanner = preview ? `<div class="branch-preview" role="status"><span>${icon('branch')}只读预览 <strong>${esc(preview.name)}</strong><span>不会切换 HEAD</span></span>${button('preview-current', '返回当前分支', 'text-button')}</div>` : '';
    update('graph', graphBanner + (graph ? renderGraph(graph, reduced, app.detailOpen ? app.detailHash : undefined) : app.booted ? '<div class="graph-empty">打开本地仓库后，这里会显示提交历史。</div>' : renderLoadingGraph()));
    update('pr-checks', renderPullRequestState(app.pullRequestState));
    update('task-controls', renderTaskControls(task, presentation.footText));
    const hasWorking = !!app.snapshot && ((app.snapshot.workingTreeFiles?.length ?? 0) > 0 || app.snapshot.workingTreeCount > 0);
    update('working-changes', hasWorking ? renderWorkingTree(app.snapshot!, busy()) : '');
    const expanded = app.detailOpen || app.reviewOpen || app.conflictsOpen || ['confirm', 'abort-confirm', 'error'].includes(app.live.kind);
    root.dataset.expanded = expanded ? 'true' : 'false';
    const body = !expanded ? ''
        : app.detailOpen ? renderCommitDetail(app.detail, app.detailLoading, app.detailError)
        : app.reviewOpen ? renderReview(app.review)
        : renderLiveStage(app.snapshot, app.live, app.selectedPath);
    update('stage', body);
    update('task-notice', app.notice ? `<div class="notice ${app.notice.level}" role="status">${esc(app.notice.text)}</div>` : '');
    update('task-explanation', esc(presentation.narrative));
    const chips = presentation.chips.map(chip => `<span class="meta-pill ${chip.tone}"><span class="meta-dot ${chip.tone}"></span>${esc(chip.label)}</span>`).join('');
    const currentBranch = app.snapshot?.preview ? undefined : app.snapshot?.branchList?.find(branch => branch.current);
    const ahead = currentBranch?.ahead ?? 0;
    const behind = currentBranch?.behind ?? 0;
    const remoteActions = ahead || behind
        ? `<span class="remote-actions">${ahead ? button('native-push', `↑${ahead} Push`, 'remote-action') : ''}${behind ? button('native-pull', `↓${behind} Pull`, 'remote-action') : ''}</span>` : '';
    const patch = app.review.data?.patch;
    const stats = patch === undefined ? '' : `<span class="meta-pill" title="当前审查文件的增删行数"><span class="addition-text">+${patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length}</span><span class="deletion-text">−${patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length}</span><span>当前文件</span></span>`;
    update('task-meta', chips + remoteActions + stats);
    update('native-confirm', app.nativeAction ? `<div class="native-confirm"><div><strong>${app.nativeAction.kind === 'push' ? 'Push' : 'Pull'} 由 VS Code 原生 Git 完成</strong><p>${app.nativeAction.kind === 'push' ? `当前分支领先上游 ${app.nativeAction.ahead} 个提交。` : `当前分支落后上游 ${app.nativeAction.behind} 个提交。`} 打开 Source Control 后由原生 Git 处理凭据、确认和传输。</p></div><div class="actions">${button('native-go', '打开 Source Control', 'primary')}${button('native-cancel', '取消', 'text-button')}</div></div>` : '');
    update('status-bar', `<span>Generative Git ${esc(version)}</span><span>本地操作，不自动推送</span>`);
    if (current !== lastPhase) {
        const card = document.getElementById('task-card')!;
        card.classList.remove('is-entering'); void card.offsetWidth; card.classList.add('is-entering');
        const graphEl = document.getElementById('graph')!;
        graphEl.classList.remove('is-entering'); void graphEl.offsetWidth; graphEl.classList.add('is-entering');
        const stage = document.getElementById('stage')!;
        stage.classList.remove('is-entering'); void stage.offsetWidth; stage.classList.add('is-entering');
        document.getElementById('announcer')!.textContent = presentation.status.label;
        lastPhase = current;
    }
}
function closeDetail(): void { app.detailOpen = false; app.detail = undefined; app.detailHash = undefined; app.detailError = undefined; app.requestId++; }
function resetReview(): void { app.reviewOpen = false; app.review = freshReview(); app.requestId++; }
function closePeek(): void {
    app.peekOpen = false;
    render();
    root.querySelector<HTMLButtonElement>('[data-action="peek-conflicts"]')?.focus?.({ preventScroll: true });
}
function selectedFile() { return app.snapshot?.conflicts.find(f => f.path === app.selectedPath) || app.snapshot?.conflicts[0]; }
function resolveLive(strategy: Strategy): void {
    const file = selectedFile(); if (busy() || !file?.hunks.length || !app.conflictsOpen) return;
    app.peekOpen = false; app.conflictsOpen = false; app.live = { kind: 'resolving', path: file.path }; app.notice = undefined;
    post({ type: 'resolve', path: file.path, strategy }); render();
}
function quickReview(): void {
    if (busy()) return;
    const input = document.getElementById('quick-message') as HTMLTextAreaElement | null;
    const text = (input?.value || '').trim();
    if (text && app.snapshot) drafts.set(app.snapshot.repoId, text);
    beginReview();
}
function beginReview(path?: string): void {
    if (busy()) return;
    closeDetail(); app.peekOpen = false; app.conflictsOpen = false; app.branchPickerOpen = false; app.reviewOpen = true; app.notice = undefined; app.review.error = undefined;
    app.review.loading = true;
    post({ type: 'review-staged', path, requestId: ++app.requestId });
    render();
}
function commitStaged(): void {
    const r = app.review;
    if (busy() || r.loading || r.error || !r.data || r.data.blocked || !r.draft.trim()) return;
    r.committing = true; app.notice = undefined;
    post({ type: 'commit-staged', repoId: r.data.repoId, token: r.data.token, message: r.draft }); render();
}
async function copyPrompt(): Promise<void> {
    const file = selectedFile();
    const content = file?.hunks.map(h => `<<<<<<< ${h.currentLabel}\n${h.current}\n=======\n${h.incoming}\n>>>>>>> ${h.incomingLabel}`).join('\n\n') || '';
    const text = `请分析 ${file?.path || '当前文件'} 的合并冲突，保留两边意图并解释结果。${file?.truncated ? '片段已截断，请勿作为完整文件写回。' : ''}\n\n${content}`;
    if (api) post({ type: 'copy', text });
    else {
        try { await navigator.clipboard.writeText(text); app.notice = { text: '已复制，可以粘贴到聊天。', level: 'info' }; }
        catch { app.notice = { text: '浏览器未允许复制。', level: 'error' }; }
        render();
    }
}
function inspect(hash: string, path?: string): void {
    if (busy() || app.review.loading) return;
    app.peekOpen = false; app.detailOpen = true; app.detailHash = hash; app.detailError = undefined; app.notice = undefined;
    if (app.detail?.hash !== hash && !path) app.detail = undefined;
    app.detailLoading = true; post({ type: 'inspect-commit', hash, path, requestId: ++app.requestId });
    render();
}
function action(name: string, element: HTMLElement): void {
    if (busy() && !['refresh', 'open-workbench', 'connect-github', 'refresh-github', 'open-pull-request'].includes(name)) return;
    switch (name) {
        case 'resolve': resolveLive(element.dataset.strategy as Strategy); break;
        case 'peek-conflicts': app.peekOpen = !app.peekOpen; render(); break;
        case 'close-peek': closePeek(); break;
        case 'show-conflicts': closeDetail(); app.reviewOpen = false; app.peekOpen = false; app.conflictsOpen = true; app.branchPickerOpen = false; render(); break;
        case 'choose-branch': app.branchPickerOpen = !app.branchPickerOpen; render(); break;
        case 'close-branch': app.branchPickerOpen = false; render(); break;
        case 'preview-branch': {
            const ref = element.dataset.ref;
            if (!ref) return;
            app.pullRequestState = undefined;
            app.nativeAction = undefined;
            post({ type: 'preview-branch', ref });
            break;
        }
        case 'preview-current':
            app.pullRequestState = undefined;
            app.nativeAction = undefined;
            post({ type: 'preview-current' });
            break;
        case 'collapse-task': closeDetail(); app.reviewOpen = false; app.review.loading = false; app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; render(); break;
        case 'review-staged': beginReview(); break;
        case 'quick-review': quickReview(); break;
        case 'review-file': beginReview(element.dataset.path); break;
        case 'commit-staged': commitStaged(); break;
        case 'workflow-tab': closeDetail(); app.reviewOpen = false; app.live = { kind: 'overview' }; render(); break;
        case 'refresh': post({ type: 'refresh' }); break;
        case 'merge-ask': app.branchPickerOpen = false; app.live = { kind: 'confirm', ref: element.dataset.ref! }; app.notice = undefined; render(); break;
        case 'merge-go': if (app.live.kind === 'confirm') { const ref = app.live.ref; app.live = { kind: 'merging', ref }; post({ type: 'merge', ref }); render(); } break;
        case 'abort-ask': app.live = { kind: 'abort-confirm' }; render(); break;
        case 'abort-go': if (app.live.kind === 'abort-confirm') { app.live = { kind: 'merging', ref: '中止当前合并' }; post({ type: 'abort-merge' }); render(); } break;
        case 'live-back': app.branchPickerOpen = false; app.live = { kind: 'overview' }; app.notice = undefined; render(); break;
        case 'select-conflict': app.selectedPath = element.dataset.path; app.notice = undefined; render(); break;
        case 'open-file': { const f = selectedFile(); if (f) post({ type: 'open-file', path: f.path }); break; }
        case 'open-working-change':
            if (element.dataset.path && app.snapshot) post({ type: 'open-working-change', path: element.dataset.path, repoId: app.snapshot.repoId });
            break;
        case 'stage-working-change':
            if (element.dataset.path && app.snapshot) {
                closeDetail(); resetReview(); app.live = { kind: 'resolving', path: element.dataset.path };
                post({ type: 'stage-working-change', path: element.dataset.path, repoId: app.snapshot.repoId }); render();
            }
            break;
        case 'open-conflict-diff': case 'open-merge-editor': {
            const f = selectedFile(); if (f) post({ type: name, path: f.path }); break;
        }
        case 'native-stage-conflicts':
            app.live = { kind: 'resolving', path: '官方冲突处理' };
            post({ type: 'native-stage-conflicts' }); render(); break;
        case 'stage': { const f = selectedFile(); if (f) { app.live = { kind: 'resolving', path: f.path }; post({ type: 'stage', path: f.path }); render(); } break; }
        case 'native-push': {
            const branch = app.snapshot?.branchList?.find(b => b.current);
            if (!branch?.ahead) return;
            app.nativeAction = { kind: 'push', ahead: branch.ahead, behind: branch.behind ?? 0 };
            render();
            break;
        }
        case 'native-pull': {
            const branch = app.snapshot?.branchList?.find(b => b.current);
            if (!branch?.behind) return;
            app.nativeAction = { kind: 'pull', ahead: branch.ahead ?? 0, behind: branch.behind };
            render();
            break;
        }
        case 'native-go':
            if (!app.nativeAction) return;
            app.nativeAction = undefined;
            app.notice = { level: 'info', text: '已打开 Source Control；请在原生面板完成 Push/Pull。' };
            post({ type: 'open-scm' });
            render();
            break;
        case 'native-cancel':
            app.nativeAction = undefined;
            render();
            break;
        case 'open-scm': case 'suggest-commit': case 'open-workbench': case 'connect-github': case 'refresh-github': case 'open-pull-request': post({ type: name }); break;
        case 'copy': void copyPrompt(); break;
        case 'inspect-commit': inspect(element.dataset.hash!); break;
        case 'history-file': if (app.detailHash) inspect(app.detailHash, element.dataset.path); break;
        case 'close-detail': closeDetail(); render(); break;
    }
}
root.addEventListener('click', event => {
    const target = event.target as Element;
    const el = target.closest<HTMLElement>('[data-action]');
    if (app.peekOpen && !target.closest('.conflict-peek')) { app.peekOpen = false; if (!el) render(); }
    if (app.branchPickerOpen && !target.closest('.branch-popover') && !target.closest('[data-action="choose-branch"]')) {
        app.branchPickerOpen = false;
        render();
    }
    if (el && !(el instanceof HTMLSelectElement) && !el.hasAttribute('disabled')) action(el.dataset.action!, el);
});
root.addEventListener('input', event => {
    const el = event.target as HTMLTextAreaElement;
    if (el.dataset.action !== 'commit-message') return;
    app.review.draft = el.value; app.review.dirty = true;
    const key = app.review.data?.repoId;
    if (key) drafts.set(key, el.value);
    const submit = root.querySelector<HTMLButtonElement>('[data-action="commit-staged"]');
    if (submit) submit.disabled = busy() || app.review.loading || !!app.review.error || !!app.review.data?.blocked || !el.value.trim();
});
root.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.action === 'select-repo' && !busy()) {
        const quick = document.getElementById('quick-message') as HTMLTextAreaElement | null;
        if (quick) quick.value = '';
        app.pullRequestState = undefined;
        app.nativeAction = undefined;
        closeDetail(); resetReview(); app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; app.selectedPath = undefined; app.notice = undefined; app.live = { kind: 'overview' };
        post({ type: 'select-repo', repoId: select.value }); render();
    }
});
root.addEventListener('keydown', event => {
    const target = event.target as HTMLTextAreaElement;
    if (target.id === 'quick-message' && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        quickReview();
    }
});
window.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if ((event.key === 'Enter' || event.key === ' ') && target.getAttribute('role') === 'button' && target.dataset.action) { event.preventDefault(); action(target.dataset.action, target); return; }
    if (event.key === 'Escape') {
        if (app.peekOpen) { closePeek(); return; }
        else if (app.detailOpen) closeDetail();
        else if (!busy() && (app.conflictsOpen || app.branchPickerOpen)) { app.conflictsOpen = false; app.branchPickerOpen = false; }
        else if (!busy() && app.reviewOpen) { app.reviewOpen = false; app.review.loading = false; app.requestId++; }
        else if (['confirm', 'abort-confirm', 'error'].includes(app.live.kind)) app.live = { kind: 'overview' };
        render(); return;
    }
    if (app.conflictsOpen && !app.detailOpen && !app.reviewOpen && phase() === 'conflict' && /^[1-4]$/.test(event.key)) {
        event.preventDefault(); const strategy = (['current', 'incoming', 'both', 'ai'] as Strategy[])[Number(event.key) - 1];
        resolveLive(strategy);
    }
});
window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
    const m = event.data;
    switch (m.type) {
        case 'hydrate': app.booted = true; app.snapshot = m.snapshot; app.pullRequestState = undefined; app.nativeAction = undefined; if (m.notice) app.notice = { text: m.notice, level: 'info' }; break;
        case 'snapshot': {
            const previous = app.snapshot; app.snapshot = m.snapshot;
            if (previous?.repoId !== m.snapshot?.repoId || previous?.headName !== m.snapshot?.headName || previous?.headHash !== m.snapshot?.headHash || m.snapshot?.preview) { app.pullRequestState = undefined; app.nativeAction = undefined; }
            if (previous?.repoId !== m.snapshot?.repoId) { closeDetail(); resetReview(); app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; app.selectedPath = undefined; }
            if (app.reviewOpen && !app.review.committing && previous && (previous.headHash !== m.snapshot?.headHash || previous.stagedCount !== m.snapshot?.stagedCount)) app.review.error = '仓库状态已变化，请重新加载审查。';
            break;
        }
        case 'notice': app.notice = m; break;
        case 'pull-request': app.pullRequestState = m.state; break;
        case 'live-result':
            app.live = m.kind === 'error' ? { kind: 'error', text: m.text || '操作未完成。' } : { kind: 'overview' };
            if (m.kind !== 'error' && m.text) app.notice = { level: 'info', text: m.text };
            if (m.kind === 'resolved' && app.snapshot && !app.snapshot.conflicts.length) { beginReview(); return; }
            break;
        case 'commit-detail':
            if (m.requestId !== app.requestId || !app.detailOpen) return;
            app.detail = m.detail; app.detailLoading = false; app.detailError = m.error; break;
        case 'staged-review':
            if (m.requestId !== app.requestId || !app.reviewOpen) return;
            app.review.loading = false; app.review.error = m.error;
            if (m.review) {
                app.review.data = m.review;
                app.review.draft = drafts.get(m.review.repoId) ?? (app.review.dirty ? app.review.draft : m.review.suggestedMessage);
            }
            break;
        case 'commit-result':
            app.review.committing = false;
            if (m.ok) {
                if (app.review.data) drafts.delete(app.review.data.repoId);
                const quick = document.getElementById('quick-message') as HTMLTextAreaElement | null;
                if (quick) quick.value = '';
                resetReview(); app.notice = undefined; app.live = { kind: 'committed', hash: m.hash };
            } else app.review.error = m.error || '提交失败，请重新加载审查后重试。';
            break;
        default: return;
    }
    render();
});
render();
if (api) post({ type: 'ready' });
