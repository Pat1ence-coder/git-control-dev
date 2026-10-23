import type { ToHost, ToWebview, Snapshot, Strategy, CommitDetail, PullRequestState, RepositoryContext, NativeGitAction, WriteAction, WriteTicket } from '../shared/protocol';
import { esc } from '../shared/html';
import { button, icon, renderGraph, renderLiveStage, renderBranchPopover, livePhase, renderCommitDetail, renderReview, renderWorkingTree, type ReviewState, type LiveState } from './render';
import { version } from '../../package.json';
import { renderTaskControls, type TaskView } from './task';
import { presentTask } from './presentation';
import { renderPullRequest, renderLoadingGraph } from './remote';
import { repositoryContext, sameContext, nativeGitLabels } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: ToHost): void };
let api: ReturnType<typeof acquireVsCodeApi> | undefined;
try { api = acquireVsCodeApi(); } catch { /* No host: the page stays inert. */ }
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const freshReview = (): ReviewState => ({ loading: false, draft: '', dirty: false, committing: false });
const drafts = new Map<string, string>();
const app: {
    booted: boolean; snapshot: Snapshot | null; live: LiveState;
    pullRequest?: PullRequestState; switching?: boolean; peekSuppressed?: boolean; peekPinned?: boolean;
    handoff?: { kind: NativeGitAction; ticket: WriteTicket };
    confirmation?: { ticket: WriteTicket; refHash?: string };
    nativePending?: { action: NativeGitAction; context: RepositoryContext; requestToken: string };
    nativeFallback?: boolean;
    selectedPath?: string; notice?: { text: string; level: string };
    detailOpen: boolean; detail?: CommitDetail; detailHash?: string; detailLoading: boolean; detailError?: string;
    reviewOpen: boolean; review: ReviewState; requestId: number; conflictsOpen: boolean; peekOpen: boolean; branchPickerOpen: boolean;
} = {
    booted: false, snapshot: null, live: { kind: 'overview' },
    detailOpen: false, detailLoading: false, reviewOpen: false, review: freshReview(), requestId: 0, conflictsOpen: false, peekOpen: false, branchPickerOpen: false
};
const root = document.getElementById('app')!;
root.innerHTML = `<header id="toolbar"></header><main class="task-workspace"><div id="task-context"></div><article id="task-card" class="task-card" aria-label="Git 任务"><header id="task-heading"></header><div id="branch-popover"></div><div id="graph"></div><div id="pr-checks"></div><div id="task-notice"></div><section id="stage" aria-label="任务详情"></section><div id="task-controls" class="task-controls"></div><section id="working-changes" aria-label="未暂存更改"></section></article><p id="task-explanation"></p><div id="task-meta"></div><section id="native-confirm" aria-label="原生远端操作确认"></section><section id="quick-composer" class="quick-composer" aria-label="快速提交"><label for="quick-message" class="sr-only">提交说明</label><textarea id="quick-message" rows="1" maxlength="20000" placeholder="写提交说明，或直接审查暂存区…"></textarea><div class="quick-tools"><div id="quick-context"></div><span class="quick-hint">本地操作，不自动推送</span>${button('quick-review', '审查并提交', 'primary')}</div></section></main><footer id="status-bar"></footer><div id="announcer" class="sr-only" aria-live="polite"></div>`;
const htmlCache = new Map<string, string>();
let lastPhase = '';
const post = (message: ToHost) => { api?.postMessage(message); };
function writeTicket(): WriteTicket | undefined {
    const s = app.snapshot;
    return s && !s.preview && s.writeToken ? { context: repositoryContext(s), writeToken: s.writeToken } : undefined;
}
function postWrite(message: WriteAction, ticket = writeTicket()): boolean {
    if (!ticket || !sameContext(ticket.context, app.snapshot) || app.snapshot?.preview ||
        (message.type === 'merge' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(message.refHash))) {
        app.live = { kind: 'error', text: '页面状态已变化，请刷新后重新确认。' };
        app.review.committing = false; app.nativePending = undefined;
        return false;
    }
    post({ ...message, ...ticket });
    return true;
}

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
function busy(): boolean { return !!app.switching || !!app.nativePending || app.live.kind === 'merging' || app.live.kind === 'resolving' || app.review.committing; }
function phase(): string {
    if (!app.booted) return 'loading';
    if (app.review.committing) return 'committing';
    if (app.reviewOpen && !app.detailOpen) return 'reviewing';
    return livePhase(app.snapshot, app.live);
}
function draftKey(s = app.snapshot): string { return JSON.stringify([s?.repoId, s?.headName]); }
function clearRemote(): void { app.pullRequest = undefined; app.handoff = undefined; app.nativeFallback = false; }
function render(): void {
    if (!app.peekOpen) app.peekPinned = false;
    const current = phase(); root.dataset.phase = current;
    const disabled = busy() ? 'disabled' : '';
    const repoName = app.snapshot?.repoName || '未打开仓库';
    const head = app.snapshot?.headName || '—';
    const task: TaskView = { ...app, phase: current, busy: busy() };
    const presentation = presentTask({ phase: current, snapshot: app.snapshot, live: app.live, pullRequest: app.pullRequest?.kind === 'ok' ? app.pullRequest.pullRequest : undefined });
    update('toolbar', `<div class="brand">${icon('branch')}<strong>Generative Git</strong></div><div class="toolbar-controls">${button('refresh', icon('refresh'), 'icon-button', 'aria-label="刷新" title="刷新"')}${api ? button('open-workbench', icon('expand'), 'icon-button', 'aria-label="在编辑器中展开" title="在编辑器中展开"') : ''}</div>`);
    const branchTrigger = app.snapshot
        ? `<button class="branch-trigger${app.branchPickerOpen ? ' active' : ''}" type="button" data-action="choose-branch" aria-haspopup="dialog" aria-expanded="${app.branchPickerOpen}" title="浏览分支">${esc(head)}${icon('chevron')}</button>`
        : `<code>${esc(head)}</code>`;
    update('task-context', `<div class="breadcrumb">${icon('branch')}<span>${esc(repoName)}</span><span class="context-divider">/</span>${branchTrigger}${(app.snapshot?.repositories.length || 0) > 1 ? `<select data-action="select-repo" aria-label="切换仓库" ${disabled}>${app.snapshot!.repositories.map(r => `<option value="${esc(r.id)}" ${r.id === app.snapshot!.repoId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : ''}</div>`);
    update('task-heading', `<h1>${esc(presentation.title)}</h1><span class="task-state ${presentation.status.tone}"><i aria-hidden="true"></i>${esc(presentation.status.label)}</span>`);
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
    update('graph', graphBanner + (graph ? renderGraph(graph, reduced, app.detailOpen ? app.detailHash : undefined) : !app.booted ? renderLoadingGraph() : '<div class="graph-empty">打开本地仓库后，这里会显示提交历史。</div>'));
    update('pr-checks', preview ? '' : renderPullRequest(app.pullRequest, app.snapshot?.headHash));
    update('task-controls', renderTaskControls(task, presentation.footText));
    update('working-changes', app.snapshot?.workingTreeCount ? renderWorkingTree(app.snapshot, busy()) : '');
    const expanded = app.detailOpen || app.reviewOpen || app.conflictsOpen || ['confirm', 'abort-confirm', 'error'].includes(app.live.kind);
    root.dataset.expanded = expanded ? 'true' : 'false';
    const body = !expanded ? ''
        : app.detailOpen ? renderCommitDetail(app.detail, app.detailLoading, app.detailError)
        : app.reviewOpen ? renderReview(app.review)
        : renderLiveStage(app.snapshot, app.live, app.selectedPath);
    update('stage', body);
    update('task-notice', app.notice ? `<div class="notice ${app.notice.level}" role="status">${esc(app.notice.text)}</div>` : '');
    update('task-explanation', esc(presentation.narrative));
    const patch = app.reviewOpen && !app.review.error ? app.review.data?.patch : undefined;
    const stats = patch === undefined ? '' : `<span class="meta-pill" title="当前审查文件的增删行数"><span class="addition-text">+${patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length}</span><span class="deletion-text">−${patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length}</span><span>当前文件</span></span>`;
    const chips = presentation.chips.map(c => `<span class="meta-pill ${c.tone}"><i class="meta-dot" aria-hidden="true"></i>${esc(c.label)}</span>`).join('');
    const branch = preview ? undefined : app.snapshot?.branchList?.find(b => b.current);
    const native = preview ? undefined : app.snapshot?.nativeGit;
    const remoteKinds: NativeGitAction[] = [];
    if (native) {
        if (native.hasHead) {
            remoteKinds.push(native.hasUpstream ? 'push' : 'publish', 'pull');
            if (native.hasUpstream) remoteKinds.push('sync');
        }
        remoteKinds.push('fetch');
    }
    const primaryRemote: NativeGitAction | undefined = !native || !native.hasHead ? undefined
        : !native.hasUpstream ? 'publish'
        : branch?.ahead ? 'push'
        : branch?.behind ? 'pull'
        : undefined;
    const remoteLabel = (kind: NativeGitAction) =>
        `${kind === 'push' && branch?.ahead ? `↑${branch.ahead} ` : kind === 'pull' && branch?.behind ? `↓${branch.behind} ` : ''}${nativeGitLabels[kind]}`;
    const remoteButton = (kind: NativeGitAction) => button(`native-${kind}`, remoteLabel(kind), 'remote-action', disabled);
    const moreRemote = remoteKinds.filter(kind => kind !== primaryRemote);
    const remoteActions = primaryRemote ? remoteButton(primaryRemote) : '';
    const remoteMore = moreRemote.length
        ? `<details class="remote-more"><summary>更多</summary><div class="remote-menu">${moreRemote.map(remoteButton).join('')}</div></details>`
        : '';
    update('task-meta', chips + remoteActions + remoteMore + stats);
    const handoff = app.handoff;
    update('native-confirm', app.nativePending ? `<div class="native-confirm" role="status"><p>正在运行原生 ${nativeGitLabels[app.nativePending.action]} 流程，请查看编辑器提示…</p></div>` : handoff ? `<div class="native-confirm"><div><strong>${nativeGitLabels[handoff.kind]} 由编辑器原生 Git 完成</strong><p>将在当前仓库运行对应操作，遵循原生 Git 配置与确认流程。${handoff.kind === 'sync' ? 'Sync 会拉取并推送。' : ''}</p></div><div class="actions">${button('native-go', `继续 ${nativeGitLabels[handoff.kind]}`, 'primary', disabled)}${button('native-cancel', '取消', 'text-button')}</div></div>` : app.nativeFallback ? `<div class="native-confirm">${button('open-scm', '在 Source Control 中核对', 'text-button')}</div>` : '');
    root.dataset.quick = app.snapshot && !preview && !app.reviewOpen && !app.detailOpen && !['confirm', 'abort-confirm', 'error'].includes(app.live.kind) ? 'true' : 'false';
    update('quick-context', `<span class="quick-chip">${icon('file')}${esc(repoName)}</span><span class="quick-chip">${icon('branch')}${esc(head)}</span>`);
    const quick = document.getElementById('quick-message') as HTMLTextAreaElement;
    const draft = drafts.get(draftKey()) || '';
    if (quick.value !== draft) quick.value = draft;
    quick.disabled = busy() || !app.snapshot || !!preview;
    const quickButton = root.querySelector<HTMLButtonElement>('[data-action="quick-review"]');
    if (quickButton) quickButton.disabled = busy() || app.review.loading || !app.snapshot || !!preview;
    update('status-bar', `<span>Generative Git ${esc(version)}</span><span>本地操作，不自动推送</span>`);
    if (current !== lastPhase) {
        const stage = document.getElementById('stage')!;
        stage.classList.remove('is-entering'); void stage.offsetWidth; stage.classList.add('is-entering');
        document.getElementById('announcer')!.textContent = presentation.status.label;
        if (!reduced) {
            const card = document.getElementById('task-card')!;
            card.classList.remove('is-entering'); void card.offsetWidth; card.classList.add('is-entering');
            const graph = document.getElementById('graph')!;
            graph.classList.remove('is-entering'); void graph.offsetWidth; graph.classList.add('is-entering');
        }
        lastPhase = current;
    }
}
function closeDetail(): void { app.detailOpen = false; app.detail = undefined; app.detailHash = undefined; app.detailError = undefined; app.requestId++; }
function resetReview(): void { app.reviewOpen = false; app.review = freshReview(); app.requestId++; }
function closePeek(): void {
    app.peekOpen = false; app.peekPinned = false; app.peekSuppressed = true;
    render();
    root.querySelector<HTMLButtonElement>('[data-action="peek-conflicts"]')?.focus?.({ preventScroll: true });
}
function selectedFile() { return app.snapshot?.conflicts.find(f => f.path === app.selectedPath) || app.snapshot?.conflicts[0]; }
function resolveLive(strategy: Strategy): void {
    const file = selectedFile(); if (busy() || !file?.hunks.length || !app.conflictsOpen) return;
    app.peekOpen = false; app.conflictsOpen = false; app.live = { kind: 'resolving', path: file.path }; app.notice = undefined;
    postWrite({ type: 'resolve', path: file.path, strategy }); render();
}
function quickReview(): void {
    if (!app.snapshot || app.snapshot.preview || busy() || app.review.loading) return;
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
    postWrite({ type: 'commit-staged', repoId: r.data.repoId, token: r.data.token, message: r.draft }); render();
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
    if (busy() && !['refresh', 'open-workbench'].includes(name)) return;
    switch (name) {
        case 'resolve': resolveLive(element.dataset.strategy as Strategy); break;
        case 'peek-conflicts':
            app.peekPinned = !app.peekPinned; app.peekOpen = app.peekPinned; app.peekSuppressed = !app.peekPinned;
            render(); break;
        case 'close-peek': closePeek(); break;
        case 'show-conflicts': closeDetail(); app.reviewOpen = false; app.peekOpen = false; app.conflictsOpen = true; app.branchPickerOpen = false; render(); break;
        case 'choose-branch': app.branchPickerOpen = !app.branchPickerOpen; render(); break;
        case 'close-branch': app.branchPickerOpen = false; render(); break;
        case 'preview-branch': {
            clearRemote();
            const ref = element.dataset.ref;
            if (!ref) return;
            post({ type: 'preview-branch', ref });
            break;
        }
        case 'preview-current':
            clearRemote();
            post({ type: 'preview-current' });
            break;
        case 'collapse-task': closeDetail(); app.reviewOpen = false; app.review.loading = false; app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; render(); break;
        case 'review-staged': beginReview(); break;
        case 'quick-review': quickReview(); break;
        case 'review-file': beginReview(element.dataset.path); break;
        case 'commit-staged': commitStaged(); break;
        case 'workflow-tab': closeDetail(); app.reviewOpen = false; app.live = { kind: 'overview' }; render(); break;
        case 'refresh': post({ type: 'refresh' }); break;
        case 'merge-ask': app.confirmation = writeTicket() ? { ticket: writeTicket()!, refHash: app.snapshot?.branchList?.find(b => b.local && b.name === element.dataset.ref)?.commit } : undefined; app.branchPickerOpen = false; app.live = { kind: 'confirm', ref: element.dataset.ref! }; app.notice = undefined; render(); break;
        case 'merge-go': if (app.live.kind === 'confirm') { const ref = app.live.ref; app.live = { kind: 'merging', ref }; postWrite({ type: 'merge', ref, refHash: app.confirmation?.refHash || '' }, app.confirmation?.ticket); app.confirmation = undefined; render(); } break;
        case 'abort-ask': app.confirmation = writeTicket() ? { ticket: writeTicket()! } : undefined; app.live = { kind: 'abort-confirm' }; render(); break;
        case 'abort-go': if (app.live.kind === 'abort-confirm') { app.live = { kind: 'merging', ref: '中止当前合并' }; postWrite({ type: 'abort-merge' }, app.confirmation?.ticket); app.confirmation = undefined; render(); } break;
        case 'live-back': app.branchPickerOpen = false; app.live = { kind: 'overview' }; app.notice = undefined; render(); break;
        case 'select-conflict': app.selectedPath = element.dataset.path; app.notice = undefined; render(); break;
        case 'open-file': { const f = selectedFile(); if (f) post({ type: 'open-file', path: f.path }); break; }
        case 'open-working-change':
            if (element.dataset.path && app.snapshot) post({ type: 'open-working-change', path: element.dataset.path, repoId: app.snapshot.repoId });
            break;
        case 'stage-working-change':
            if (element.dataset.path && app.snapshot) {
                closeDetail(); resetReview(); app.live = { kind: 'resolving', path: element.dataset.path };
                postWrite({ type: 'stage-working-change', path: element.dataset.path, repoId: app.snapshot.repoId }); render();
            }
            break;
        case 'stage-all':
            if (app.snapshot?.workingTreeCount) {
                closeDetail(); resetReview(); app.live = { kind: 'resolving', path: '全部未暂存更改' };
                postWrite({ type: 'stage-all' }); render();
            }
            break;
        case 'open-conflict-diff': case 'open-merge-editor': {
            const f = selectedFile(); if (f) post({ type: name, path: f.path }); break;
        }
        case 'native-stage-conflicts':
            app.live = { kind: 'resolving', path: '官方冲突处理' };
            postWrite({ type: 'native-stage-conflicts' }); render(); break;
        case 'stage': { const f = selectedFile(); if (f) { app.live = { kind: 'resolving', path: f.path }; postWrite({ type: 'stage', path: f.path }); render(); } break; }
        case 'native-push': case 'native-pull': case 'native-fetch': case 'native-sync': case 'native-publish': {
            const ticket = writeTicket();
            if (!ticket) return;
            app.handoff = { kind: name.slice('native-'.length) as NativeGitAction, ticket };
            app.nativeFallback = false;
            render(); break;
        }
        case 'native-cancel': app.handoff = undefined; render(); break;
        case 'native-go': {
            const handoff = app.handoff;
            if (handoff) {
                app.nativePending = { action: handoff.kind, context: handoff.ticket.context, requestToken: handoff.ticket.writeToken };
                postWrite({ type: 'native-git', action: handoff.kind }, handoff.ticket);
                app.handoff = undefined; app.notice = undefined;
                render();
            }
            break;
        }
        case 'connect-github': case 'refresh-github': case 'open-pull-request':
            if (app.snapshot && !app.snapshot.preview) post({ type: name, context: repositoryContext(app.snapshot) });
            break;
        case 'suggest-commit': postWrite({ type: name }); break;
        case 'open-scm': case 'open-workbench': post({ type: name }); break;
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
root.addEventListener('pointerover', event => {
    if ((event.target as Element).closest('.conflict-trigger') && !app.peekOpen && !app.peekSuppressed && !busy()) {
        app.peekOpen = true; render();
    }
});
root.addEventListener('pointerout', event => {
    const container = (event.target as Element).closest('.conflict-peek');
    if (container && event.relatedTarget && !container.contains(event.relatedTarget as Node)) {
        app.peekSuppressed = false;
        if (app.peekOpen && !app.peekPinned) { app.peekOpen = false; render(); }
    }
});
root.addEventListener('focusin', event => {
    if ((event.target as Element).closest('.conflict-trigger') && !app.peekOpen && !app.peekSuppressed && !busy()) {
        app.peekOpen = true; render();
    }
});
root.addEventListener('focusout', event => {
    const container = (event.target as Element).closest('.conflict-peek');
    if (container && event.relatedTarget && !container.contains(event.relatedTarget as Node)) {
        app.peekSuppressed = false;
        if (app.peekOpen && !app.peekPinned && !container.matches(':hover')) { app.peekOpen = false; render(); }
    }
});
root.addEventListener('input', event => {
    const el = event.target as HTMLTextAreaElement;
    if (el.id === 'quick-message') {
        if (app.snapshot && !busy()) drafts.set(draftKey(), el.value.slice(0, 20000));
        return;
    }
    if (el.dataset.action !== 'commit-message') return;
    app.review.draft = el.value; app.review.dirty = true;
    const key = app.review.data?.repoId;
    if (key) drafts.set(draftKey(), el.value);
    const submit = root.querySelector<HTMLButtonElement>('[data-action="commit-staged"]');
    if (submit) submit.disabled = busy() || app.review.loading || !!app.review.error || !!app.review.data?.blocked || !el.value.trim();
});
root.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.action === 'select-repo' && !busy()) {
        clearRemote(); app.switching = true;
        closeDetail(); resetReview(); app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; app.selectedPath = undefined; app.notice = undefined; app.live = { kind: 'overview' };
        post({ type: 'select-repo', repoId: select.value }); render();
    }
});
root.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (target.id === 'quick-message' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); quickReview();
    }
});
window.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if ((event.key === 'Enter' || event.key === ' ') && target.getAttribute('role') === 'button' && target.dataset.action) { event.preventDefault(); action(target.dataset.action, target); return; }
    if (event.key === 'Escape') {
        if (app.handoff) { app.handoff = undefined; render(); return; }
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
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
        case 'hydrate': clearRemote(); app.switching = false; app.booted = true; app.snapshot = m.snapshot; if (m.notice) app.notice = { text: m.notice, level: 'info' }; break;
        case 'snapshot': {
            const previous = app.snapshot; app.snapshot = m.snapshot; app.switching = false;
            if (!sameContext(previous, m.snapshot) || previous?.preview?.ref !== m.snapshot?.preview?.ref) {
                clearRemote(); app.confirmation = undefined;
                if (['confirm', 'abort-confirm'].includes(app.live.kind)) app.live = { kind: 'overview' };
            }
            if (previous?.repoId !== m.snapshot?.repoId || previous?.headName !== m.snapshot?.headName) { closeDetail(); resetReview(); app.live = { kind: 'overview' }; app.conflictsOpen = false; app.peekOpen = false; app.branchPickerOpen = false; app.selectedPath = undefined; }
            if (app.reviewOpen && !app.review.committing && previous && (previous.headHash !== m.snapshot?.headHash || previous.stagedCount !== m.snapshot?.stagedCount)) app.review.error = '仓库状态已变化，请重新加载审查。';
            break;
        }
        case 'notice': app.notice = m; if (m.level === 'error') app.switching = false; break;
        case 'pull-request':
            if (app.switching || app.snapshot?.preview || !sameContext(app.snapshot, m.context)) return;
            app.pullRequest = m.state; break;
        case 'native-git-result':
            if (!app.nativePending || app.nativePending.requestToken !== m.requestToken || app.nativePending.action !== m.action || !sameContext(app.nativePending.context, m.context)) return;
            app.nativePending = undefined;
            app.nativeFallback = m.kind !== 'cancelled';
            if (app.snapshot?.repoId === m.context.repoId) app.notice = { level: m.kind === 'error' ? 'error' : 'info', text: m.text };
            break;
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
                if (app.switching || m.review.repoId !== app.snapshot?.repoId || m.review.headName !== app.snapshot?.headName) {
                    app.review.data = undefined;
                    app.review.error = '仓库或分支已变化，请刷新后重新审查。';
                    break;
                }
                app.review.data = m.review;
                app.review.draft = drafts.get(draftKey()) ?? (app.review.dirty ? app.review.draft : m.review.suggestedMessage);
            }
            break;
        case 'commit-result':
            app.review.committing = false;
            if (m.ok) {
                if (app.review.data) drafts.delete(draftKey());
                resetReview(); app.notice = undefined; app.live = { kind: 'committed', hash: m.hash };
            } else app.review.error = m.error || '提交失败，请重新加载审查后重试。';
            break;
        default: return;
    }
    render();
});
render();
if (api) post({ type: 'ready' });
