import type { ToHost, ToWebview, Mode, Snapshot, Strategy, CommitDetail } from '../shared/protocol';
import { esc } from '../shared/html';
import { initialDemo, demoReducer, demoGraph, demoCommit, demoReview, DEMO_CONFLICT, type DemoState } from '../demo/scenario';
import { button, icon, renderGraph, renderDemoStage, renderLiveStage, livePhase, renderCommitDetail, renderReview, renderWorkingTree, type ReviewState, type LiveState } from './render';
import { version } from '../../package.json';
import { renderTaskControls, taskTitle, taskStatus, taskExplanation, type TaskView } from './task';

declare function acquireVsCodeApi(): { postMessage(message: ToHost): void };
let api: ReturnType<typeof acquireVsCodeApi> | undefined;
try { api = acquireVsCodeApi(); } catch { /* Browser preview. */ }
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const BEATS = { merge: 1600, resolve: 720, check: 1300, commit: 850 };
const beat = (ms: number) => reduced ? 180 : ms;
const freshReview = (): ReviewState => ({ loading: false, draft: '', dirty: false, committing: false });
const drafts = new Map<string, string>();
const app: {
    booted: boolean; mode: Mode; snapshot: Snapshot | null; demo: DemoState; live: LiveState;
    selectedPath?: string; notice?: { text: string; level: string }; prNote: boolean;
    detailOpen: boolean; detail?: CommitDetail; detailHash?: string; detailLoading: boolean; detailError?: string;
    reviewOpen: boolean; review: ReviewState; requestId: number; conflictsOpen: boolean; peekOpen: boolean; branchPickerOpen: boolean;
} = {
    booted: !api, mode: 'demo', snapshot: null, demo: initialDemo(), live: { kind: 'overview' },
    prNote: false, detailOpen: false, detailLoading: false, reviewOpen: false, review: freshReview(), requestId: 0, conflictsOpen: false, peekOpen: false, branchPickerOpen: false
};
const root = document.getElementById('app')!;
root.innerHTML = `<header id="toolbar"></header><main class="task-workspace"><div id="task-context"></div><article id="task-card" class="task-card" aria-label="Git 任务"><header id="task-heading"></header><div id="graph"></div><div id="task-controls" class="task-controls"></div><section id="working-changes" aria-label="未暂存更改"></section><div id="task-notice"></div><section id="stage" aria-label="任务详情"></section></article><p id="task-explanation"></p><div id="task-meta"></div></main><footer id="status-bar"></footer><div id="announcer" class="sr-only" aria-live="polite"></div>`;
const htmlCache = new Map<string, string>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let lastPhase = '';
const demoHostMessages = new Set<ToHost['type']>(['ready', 'set-mode', 'copy', 'open-workbench', 'open-scm', 'refresh']);
const post = (message: ToHost) => {
    // Defense in depth: demo cannot emit repository actions, even if a future UI
    // action accidentally takes the live path. The host checks its mode as well.
    if (app.mode === 'demo' && !demoHostMessages.has(message.type)) return;
    api?.postMessage(message);
};

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
    if (app.mode === 'demo') return app.demo.phase;
    if (app.reviewOpen && !app.detailOpen) return 'reviewing';
    return livePhase(app.snapshot, app.live);
}
function render(): void {
    const current = phase(); root.dataset.phase = current;
    const disabled = busy() ? 'disabled' : '';
    const repoName = app.mode === 'demo' ? 'aurora' : app.snapshot?.repoName || '未打开仓库';
    const head = app.mode === 'demo' ? 'main' : app.snapshot?.headName || '—';
    const task: TaskView = { ...app, phase: current, busy: busy() };
    const status = taskStatus(current);
    update('toolbar', `<div class="brand">${icon('branch')}<strong>Generative Git</strong></div><div class="toolbar-controls"><div class="mode-switch" role="group" aria-label="工作模式">${button('mode-live', '实时', app.mode === 'live' ? 'active' : '', `aria-pressed="${app.mode === 'live'}" ${disabled}`)}${button('mode-demo', '演示', app.mode === 'demo' ? 'active' : '', `aria-pressed="${app.mode === 'demo'}" ${disabled}`)}</div>${button('refresh', icon('refresh'), 'icon-button', 'aria-label="刷新" title="刷新"')}${api ? button('open-workbench', icon('expand'), 'icon-button', 'aria-label="在编辑器中展开" title="在编辑器中展开"') : ''}</div>`);
    update('task-context', `<div class="breadcrumb">${icon('branch')}<span>${esc(repoName)}</span><span class="context-divider">/</span><code>${esc(head)}</code>${app.mode === 'live' && (app.snapshot?.repositories.length || 0) > 1 ? `<select data-action="select-repo" aria-label="切换仓库" ${disabled}>${app.snapshot!.repositories.map(r => `<option value="${esc(r.id)}" ${r.id === app.snapshot!.repoId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : ''}</div><span class="activity-caption">${status.tone === 'running' ? '<i class="spinner"></i>' : ''}${app.mode === 'demo' ? '模拟任务' : '本地任务'}</span>`);
    update('task-heading', `<h1>${esc(taskTitle(task))}</h1><span class="task-state ${status.tone}"><i></i>${status.label}</span>`);
    let graph = app.mode === 'demo' ? demoGraph(app.demo.phase) : app.snapshot?.graph;
    if (graph && app.mode === 'live' && app.live.kind === 'committed') {
        const hash = app.live.hash;
        graph = { ...graph, edges: graph.edges.map(edge => edge.from === hash ? { ...edge, style: 'join' } : edge) };
    }
    if (graph && app.mode === 'live' && app.snapshot && !app.snapshot.mergeHead && (app.snapshot.workingTreeCount || app.snapshot.stagedCount)) {
        const tip = graph.nodes.find(n => n.tip);
        graph = { ...graph, nodes: [{ id: 'working-tree', hash: `${app.snapshot.workingTreeCount + app.snapshot.stagedCount} 项`, title: '未提交的改动', lane: tip?.lane || 0, row: 0, badges: ['工作区'], role: 'ghost' }, ...graph.nodes.map(n => ({ ...n, row: n.row + 1 }))], edges: tip ? [{ id: 'working-tree-edge', from: 'working-tree', to: tip.id, style: 'pending' }, ...graph.edges] : graph.edges };
    }
    update('graph', graph ? renderGraph(graph, reduced, app.mode === 'demo' && app.demo.phase === 'merging', app.detailOpen ? app.detailHash : undefined) : '<div class="graph-empty">打开本地仓库，或运行一次演示。</div>');
    update('task-controls', renderTaskControls(task));
    update('working-changes', app.mode === 'live' && app.snapshot ? renderWorkingTree(app.snapshot, busy()) : '');
    const expanded = app.detailOpen || app.reviewOpen || app.conflictsOpen || app.branchPickerOpen || (app.mode === 'live' && ['confirm', 'abort-confirm', 'error'].includes(app.live.kind));
    root.dataset.expanded = expanded ? 'true' : 'false';
    const body = !expanded ? ''
        : app.detailOpen ? renderCommitDetail(app.detail, app.detailLoading, app.detailError)
        : app.reviewOpen ? renderReview(app.review, app.mode === 'demo', app.demo.strategy)
        : app.mode === 'demo' ? renderDemoStage(app.demo) : renderLiveStage(app.snapshot, app.live, app.selectedPath);
    update('stage', body);
    update('task-notice', (app.notice ? `<div class="notice ${app.notice.level}" role="status">${esc(app.notice.text)}</div>` : '') + (app.prNote ? '<p class="notice">创建 PR 尚未接入，本次没有创建或发布 PR。</p>' : ''));
    update('task-explanation', taskExplanation(task));
    const patch = app.review.data?.patch;
    const stats = patch === undefined ? '' : `<span class="meta-pill" title="当前审查文件的增删行数"><span class="addition-text">+${patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length}</span><span class="deletion-text">−${patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length}</span><span>当前文件</span></span>`;
    update('task-meta', `<span class="meta-pill">${icon('branch')}${esc(repoName)}</span><span class="meta-pill"><i class="connection-dot"></i>${app.mode === 'demo' ? '演示 · 不读写仓库' : '本地 Git'}</span>${stats}`);
    update('status-bar', `<span>Generative Git ${esc(version)}</span><span>${app.mode === 'demo' ? '纯模拟，无真实 Git 操作' : '本地操作，不自动推送'}</span>`);
    root.style.setProperty('--beat', `${beat(BEATS.merge) / 1000}s`);
    if (current !== lastPhase) {
        const stage = document.getElementById('stage')!;
        stage.classList.remove('is-entering'); void stage.offsetWidth; stage.classList.add('is-entering');
        document.getElementById('announcer')!.textContent = status.label;
        lastPhase = current;
    }
}
function later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, beat(ms)); timers.add(timer);
}
function clearTimers(): void { timers.forEach(clearTimeout); timers.clear(); }
function closeDetail(): void { app.detailOpen = false; app.detail = undefined; app.detailHash = undefined; app.detailError = undefined; app.requestId++; }
function resetReview(): void { app.reviewOpen = false; app.review = freshReview(); app.requestId++; }
function closePeek(): void {
    app.peekOpen = false;
    render();
    root.querySelector<HTMLButtonElement>('[data-action="peek-conflicts"]')?.focus?.({ preventScroll: true });
}
function setMode(mode: Mode): void {
    if (busy()) return;
    clearTimers(); closeDetail(); resetReview(); app.mode = mode; app.demo = initialDemo(); app.live = { kind: 'overview' };
    app.notice = undefined; app.prNote = false; app.selectedPath = undefined; app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; post({ type: 'set-mode', mode }); render();
}
function startDemo(): void {
    if (busy()) return;
    clearTimers(); closeDetail(); resetReview(); drafts.delete('demo'); app.notice = undefined; app.prNote = false;
    app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false;
    app.demo = demoReducer(initialDemo(), { type: 'start' }); render();
    later(BEATS.merge, () => { closeDetail(); app.demo = demoReducer(app.demo, { type: 'merge-animated' }); render(); });
}
function runDemo(): void { setMode('demo'); startDemo(); }
function resolveDemo(strategy: Strategy): void {
    if (app.demo.phase !== 'conflict' || !app.conflictsOpen) return;
    app.peekOpen = false; app.conflictsOpen = false;
    app.demo = demoReducer(app.demo, { type: 'resolve', strategy }); app.notice = undefined; render();
    later(BEATS.resolve, () => {
        closeDetail(); app.demo = demoReducer(app.demo, { type: 'checked' }); render();
        later(BEATS.check, () => { closeDetail(); app.demo = demoReducer(app.demo, { type: 'finish' }); beginReview(); });
    });
}
function selectedFile() { return app.snapshot?.conflicts.find(f => f.path === app.selectedPath) || app.snapshot?.conflicts[0]; }
function resolveLive(strategy: Strategy): void {
    const file = selectedFile(); if (busy() || !file?.hunks.length || !app.conflictsOpen) return;
    app.peekOpen = false; app.conflictsOpen = false; app.live = { kind: 'resolving', path: file.path }; app.notice = undefined;
    post({ type: 'resolve', path: file.path, strategy }); render();
}
function beginReview(path?: string): void {
    if (busy()) return;
    if (app.mode === 'demo' && app.demo.phase !== 'reviewing') return;
    closeDetail(); app.peekOpen = false; app.conflictsOpen = false; app.branchPickerOpen = false; app.reviewOpen = true; app.notice = undefined; app.review.error = undefined;
    if (app.mode === 'demo') {
        const data = demoReview(app.demo.strategy);
        app.review = { ...app.review, data, loading: false, draft: drafts.get('demo') ?? data.suggestedMessage };
    } else {
        app.review.loading = true;
        post({ type: 'review-staged', path, requestId: ++app.requestId });
    }
    render();
}
function commitStaged(): void {
    const r = app.review;
    if (busy() || r.loading || r.error || !r.data || r.data.blocked || !r.draft.trim()) return;
    r.committing = true; app.notice = undefined;
    if (app.mode === 'demo') {
        app.demo = demoReducer(app.demo, { type: 'commit' }); render();
        later(BEATS.commit, () => { app.demo = demoReducer(app.demo, { type: 'committed' }); resetReview(); drafts.delete('demo'); render(); });
    } else {
        post({ type: 'commit-staged', repoId: r.data.repoId, token: r.data.token, message: r.draft }); render();
    }
}
async function copyPrompt(): Promise<void> {
    const file = selectedFile();
    const content = app.mode === 'demo' ? DEMO_CONFLICT : file?.hunks.map(h => `<<<<<<< ${h.currentLabel}\n${h.current}\n=======\n${h.incoming}\n>>>>>>> ${h.incomingLabel}`).join('\n\n') || '';
    const text = `请分析 ${app.mode === 'demo' ? 'src/checkout.ts' : file?.path || '当前文件'} 的合并冲突，保留两边意图并解释结果。${file?.truncated ? '片段已截断，请勿作为完整文件写回。' : ''}\n\n${content}`;
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
    if (app.mode === 'demo') {
        app.detail = demoCommit(hash);
        if (hash === 'e7b21aa') app.detail.patch = demoReview(app.demo.strategy).patch;
        app.detailLoading = false;
    } else {
        if (app.detail?.hash !== hash && !path) app.detail = undefined;
        app.detailLoading = true; post({ type: 'inspect-commit', hash, path, requestId: ++app.requestId });
    }
    render();
}
function action(name: string, element: HTMLElement): void {
    if (busy() && !['refresh', 'open-workbench'].includes(name)) return;
    switch (name) {
        case 'mode-live': setMode('live'); break;
        case 'mode-demo': setMode('demo'); break;
        case 'run-demo': case 'demo-replay': runDemo(); break;
        case 'demo-start': startDemo(); break;
        case 'demo-resolve': resolveDemo(element.dataset.strategy as Strategy); break;
        case 'resolve': resolveLive(element.dataset.strategy as Strategy); break;
        case 'peek-conflicts': app.peekOpen = !app.peekOpen; render(); break;
        case 'close-peek': closePeek(); break;
        case 'show-conflicts': closeDetail(); app.reviewOpen = false; app.peekOpen = false; app.conflictsOpen = true; app.branchPickerOpen = false; render(); break;
        case 'choose-branch': app.branchPickerOpen = true; render(); break;
        case 'collapse-task': closeDetail(); app.reviewOpen = false; app.review.loading = false; app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; render(); break;
        case 'review-staged': beginReview(); break;
        case 'review-file': beginReview(element.dataset.path); break;
        case 'commit-staged': commitStaged(); break;
        case 'workflow-tab': closeDetail(); app.reviewOpen = false; app.live = { kind: 'overview' }; render(); break;
        case 'refresh': if (api) post({ type: 'refresh' }); else { app.notice = { level: 'info', text: '当前使用演示数据。实时 Git 功能请在扩展中打开。' }; render(); } break;
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
        case 'open-scm': case 'suggest-commit': case 'open-workbench': post({ type: name }); break;
        case 'create-pr': app.prNote = true; render(); break;
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
    if (el && !(el instanceof HTMLSelectElement) && !el.hasAttribute('disabled')) action(el.dataset.action!, el);
});
root.addEventListener('input', event => {
    const el = event.target as HTMLTextAreaElement;
    if (el.dataset.action !== 'commit-message') return;
    app.review.draft = el.value; app.review.dirty = true;
    const key = app.mode === 'demo' ? 'demo' : app.review.data?.repoId;
    if (key) drafts.set(key, el.value);
    const submit = root.querySelector<HTMLButtonElement>('[data-action="commit-staged"]');
    if (submit) submit.disabled = busy() || app.review.loading || !!app.review.error || !!app.review.data?.blocked || !el.value.trim();
});
root.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.action === 'select-repo' && !busy()) {
        closeDetail(); resetReview(); app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; app.selectedPath = undefined; app.notice = undefined; app.live = { kind: 'overview' };
        post({ type: 'select-repo', repoId: select.value }); render();
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
        else if (app.mode === 'demo') { clearTimers(); app.demo = initialDemo(); resetReview(); app.notice = undefined; app.prNote = false; }
        else if (!busy() && app.reviewOpen) { app.reviewOpen = false; app.review.loading = false; app.requestId++; }
        else if (['confirm', 'abort-confirm', 'error'].includes(app.live.kind)) app.live = { kind: 'overview' };
        render(); return;
    }
    if (app.conflictsOpen && !app.detailOpen && !app.reviewOpen && phase() === 'conflict' && /^[1-4]$/.test(event.key)) {
        event.preventDefault(); const strategy = (['current', 'incoming', 'both', 'ai'] as Strategy[])[Number(event.key) - 1];
        if (app.mode === 'demo') resolveDemo(strategy); else resolveLive(strategy);
    }
});
window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
    const m = event.data;
    switch (m.type) {
        case 'hydrate': app.booted = true; app.mode = m.mode; app.snapshot = m.snapshot; if (m.notice) app.notice = { text: m.notice, level: 'info' }; break;
        case 'snapshot': {
            const previous = app.snapshot; app.snapshot = m.snapshot;
            if (previous?.repoId !== m.snapshot?.repoId) { closeDetail(); resetReview(); app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; app.selectedPath = undefined; }
            if (app.reviewOpen && !app.review.committing && previous && (previous.headHash !== m.snapshot?.headHash || previous.stagedCount !== m.snapshot?.stagedCount)) app.review.error = '仓库状态已变化，请重新加载审查。';
            break;
        }
        case 'run-demo': runDemo(); return;
        case 'notice': app.notice = m; break;
        case 'live-result':
            app.live = m.kind === 'error' ? { kind: 'error', text: m.text || '操作未完成。' } : { kind: 'overview' };
            if (m.kind !== 'error' && m.text) app.notice = { level: 'info', text: m.text };
            if (m.kind === 'resolved' && app.snapshot && !app.snapshot.conflicts.length) { beginReview(); return; }
            break;
        case 'commit-detail':
            if (m.requestId !== app.requestId || !app.detailOpen || app.mode !== 'live') return;
            app.detail = m.detail; app.detailLoading = false; app.detailError = m.error; break;
        case 'staged-review':
            if (m.requestId !== app.requestId || !app.reviewOpen || app.mode !== 'live') return;
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
                resetReview(); app.notice = undefined; app.live = { kind: 'committed', hash: m.hash };
            } else app.review.error = m.error || '提交失败，请重新加载审查后重试。';
            break;
        default: return;
    }
    render();
});
render();
if (api) post({ type: 'ready' });
