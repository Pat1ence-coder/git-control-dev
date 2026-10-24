import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { describeGitError } from '../git/errors';
import type { GitService } from '../git/gitService';
import type { GraphEdge, GraphModel, GraphNode } from '../shared/model';
import type { Snapshot, BranchInfo, BranchPreview } from '../shared/protocol';
import { clipChars, esc } from '../shared/html';

interface SidebarState {
    repositories: { id: string; name: string }[];
    repoId?: string;
    repoName?: string;
    headName?: string;
    working: number;
    workingFiles: { path: string; status: string; untracked: boolean }[];
    staged: number;
    conflicts: number;
    mergeHead: boolean;
    rebasing: boolean;
    graph: GraphModel | null;
    branchList: BranchInfo[];
    preview?: BranchPreview;
    problem?: string;
}

const branchIcon = '<svg class="side-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="6" cy="19" r="2.5"/><path d="M6 7.5v9M18 10.5c0 5-12 1-12 6"/></svg>';
const refreshIcon = '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4"/></svg>';
const arrowIcon = '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg>';

function sidebarState(snapshot: Snapshot | null, problem?: string): SidebarState {
    return {
        repositories: snapshot?.repositories ?? [],
        repoId: snapshot?.repoId,
        repoName: snapshot?.repoName,
        headName: snapshot?.headName,
        working: snapshot?.workingTreeCount ?? 0,
        workingFiles: snapshot?.workingTreeFiles ?? [],
        staged: snapshot?.stagedCount ?? 0,
        conflicts: snapshot?.conflicts.length ?? 0,
        mergeHead: snapshot?.mergeHead ?? false,
        rebasing: snapshot?.rebasing ?? false,
        graph: snapshot?.graph ?? null,
        branchList: snapshot?.branchList ?? [],
        preview: snapshot?.preview,
        problem: problem || undefined
    };
}

const SIDEBAR_ROWS = 6;
function renderGraph(graph: GraphModel | null, pending: number): string {
    if (!graph || !graph.nodes.length) return '<p class="side-empty">还没有提交。</p>';
    const tip = graph.nodes.find(n => n.tip);
    const ghost: GraphNode | undefined = pending > 0 && tip ? {
        id: 'working-tree', hash: `${pending} 项`, title: '未提交的改动', lane: tip.lane, row: 0, badges: ['工作区'], role: 'ghost'
    } : undefined;
    const nodes: GraphNode[] = [...(ghost ? [ghost] : []), ...graph.nodes.map(n => ({ ...n, row: n.row + (ghost ? 1 : 0) }))];
    const visible = nodes.filter(n => n.row < SIDEBAR_ROWS);
    if (!visible.length) return '<p class="side-empty">还没有提交。</p>';
    const ids = new Set(visible.map(n => n.id));
    const edges: GraphEdge[] = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    if (ghost && tip && ids.has(tip.id)) edges.unshift({ id: 'working-tree-edge', from: ghost.id, to: tip.id, style: 'pending' });
    const rowH = 26, laneW = 12, left = 8;
    const railWidth = left + Math.max(1, graph.laneCount) * laneW + 6;
    const height = (Math.max(...visible.map(n => n.row)) + 1) * rowH;
    const x = (lane: number) => left + lane * laneW;
    const y = (row: number) => row * rowH + rowH / 2;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const paths = edges.map(edge => {
        const a = byId.get(edge.from), b = byId.get(edge.to);
        if (!a || !b) return '';
        const start = edge.style === 'solid' ? a : b;
        const end = edge.style === 'solid' ? b : a;
        const mid = (y(start.row) + y(end.row)) / 2;
        const d = start.lane === end.lane ? `M${x(start.lane)} ${y(start.row)}L${x(end.lane)} ${y(end.row)}`
            : `M${x(start.lane)} ${y(start.row)}C${x(start.lane)} ${mid},${x(end.lane)} ${mid},${x(end.lane)} ${y(end.row)}`;
        const lane = a.lane === b.lane ? a.lane : b.lane;
        return `<path class="edge lane-${lane % 6} ${edge.style}" d="${d}"/>`;
    }).join('');
    const dots = visible.map(n => `<g class="lane-${n.lane % 6} ${n.role}"><circle class="dot" cx="${x(n.lane)}" cy="${y(n.row)}" r="${n.tip ? 4 : 3}"/>${n.role === 'merge' ? `<circle class="merge-ring" cx="${x(n.lane)}" cy="${y(n.row)}" r="6"/>` : ''}</g>`).join('');
    const rows = visible.map(n => `<div class="side-graph-row lane-${n.lane % 6} ${n.role}" style="grid-row:${n.row + 1}"><span class="side-graph-subject" title="${esc(n.title)}">${esc(n.title)}</span>${n.badges.map(b => { const label = b.includes('/') ? b.slice(b.lastIndexOf('/') + 1) : b; return `<span class="side-graph-tag" title="${esc(b)}">${esc(clipChars(label, 18))}</span>`; }).join('')}<span class="side-graph-hash">${esc(n.hash)}</span></div>`).join('');
    return `<div class="side-graph" style="--rail-width:${railWidth}px;--graph-height:${height}px"><svg class="side-rail" width="${railWidth}" height="${height}" viewBox="0 0 ${railWidth} ${height}" aria-hidden="true">${paths}${dots}</svg><div class="side-graph-list">${rows}</div></div>`;
}

function header(): string {
    return `<header class="side-head">${branchIcon}<div><strong>Generative Git</strong></div><button class="icon-button" type="button" data-action="refresh" aria-label="刷新" title="刷新">${refreshIcon}</button></header>`;
}

function fileRow(file: { path: string; status: string; untracked: boolean }): string {
    const cut = file.path.lastIndexOf('/');
    const dir = cut >= 0 ? file.path.slice(0, cut + 1) : '';
    const name = cut >= 0 ? file.path.slice(cut + 1) : file.path;
    const [mark, tone] = file.untracked ? ['A', 'added']
        : file.status.includes('删除') ? ['D', 'deleted']
        : file.status.includes('新增') ? ['A', 'added']
        : file.status.includes('重命名') ? ['R', 'renamed']
        : ['M', 'modified'];
    return `<div class="side-file"><span class="side-file-mark ${tone}" title="${esc(file.status)}">${mark}</span><span class="side-file-path" title="${esc(file.path)}"><span class="side-file-dir">${esc(dir)}</span><span class="side-file-name">${esc(name)}</span></span></div>`;
}

function renderSidebar(state: SidebarState): string {
    const head = header();
    if (!state.repoId) {
        return head + `<div class="side-empty"><strong>未打开 Git 仓库</strong><p>打开一个 Git 仓库后，这里会显示提交图和改动。</p></div>${state.problem ? `<p class="side-alert">${esc(state.problem)}</p>` : ''}<div class="side-actions"><button class="primary side-open" type="button" data-action="open">打开工作台</button></div><div class="side-links"><button class="text-button" type="button" data-action="source-control">Source Control</button></div>`;
    }
    const repo = state.repositories.length > 1
        ? `<div class="side-repo"><label class="side-repo-select"><span>仓库</span><select data-action="select-repo" aria-label="切换仓库">${state.repositories.map(r => `<option value="${esc(r.id)}"${r.id === state.repoId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label></div>`
        : `<div class="side-repo"><code>${esc(state.repoName || '')}</code></div>`;
    const currentBranch = state.branchList.find(b => b.current);
    const selectedRef = state.preview?.ref ?? currentBranch?.ref ?? '';
    const option = (b: BranchInfo): string => {
        const marks = [b.current ? '当前' : '', b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
        return `<option value="${esc(b.ref)}"${b.ref === selectedRef ? ' selected' : ''}>${esc(b.name)}${marks ? ` · ${esc(marks)}` : ''}</option>`;
    };
    const localBranches = state.branchList.filter(b => b.local);
    const remoteBranches = state.branchList.filter(b => !b.local);
    const branch = state.branchList.length > 1
        ? `<div class="side-branch-row"><label><span>分支</span><select data-action="preview-branch" aria-label="预览分支">${localBranches.length ? `<optgroup label="本地">${localBranches.map(option).join('')}</optgroup>` : ''}${remoteBranches.length ? `<optgroup label="远端">${remoteBranches.map(option).join('')}</optgroup>` : ''}</select></label></div>`
        : `<div class="side-branch-row"><span>分支</span><span class="side-branch" title="${esc(state.headName || 'HEAD')}">${esc(state.headName || 'HEAD')}</span></div>`;
    const stats = `<div class="side-counts"><span${state.working ? '' : ' class="zero"'}><strong>${state.working}</strong>未暂存</span><span${state.staged ? '' : ' class="zero"'}><strong>${state.staged}</strong>已暂存</span><span${state.conflicts ? ' class="conflict"' : ' class="zero"'}><strong>${state.conflicts}</strong>冲突</span></div>`;
    const alerts = `${state.conflicts ? `<div class="side-alert"><i></i>${state.conflicts} 个文件存在冲突</div>` : ''}${state.mergeHead ? '<p class="side-note">合并进行中</p>' : ''}${state.rebasing ? '<p class="side-note">rebase 进行中</p>' : ''}${state.problem ? `<p class="side-alert">${esc(state.problem)}</p>` : ''}`;
    const files = state.workingFiles.length
        ? `<div class="side-files" aria-label="未暂存文件">${state.workingFiles.slice(0, 5).map(fileRow).join('')}${state.workingFiles.length > 5 ? `<div class="side-files-more">+${state.workingFiles.length - 5} 个文件</div>` : ''}</div>`
        : '';
    const preview = state.preview;
    const graph = `${preview ? `<div class="side-preview" title="只读预览，不会切换 HEAD"><span>只读预览 · <span class="side-preview-name">${esc(preview.name)}</span></span><button class="text-button" type="button" data-action="preview-current">返回当前</button></div>` : ''}${renderGraph(preview?.graph ?? state.graph, preview ? 0 : state.working + state.staged)}`;
    return head + repo + branch + stats + alerts + files + graph + `<div class="side-actions"><button class="primary side-open" type="button" data-action="open">打开工作台 ${arrowIcon}</button></div><div class="side-links"><button class="text-button" type="button" data-action="source-control">Source Control</button></div><p class="side-foot">本地操作，不自动推送</p>`;
}

function renderError(text: string): string {
    return header() + `<div class="side-empty"><strong>无法读取仓库</strong><p>${esc(text)}</p></div><div class="side-actions"><button class="primary side-open" type="button" data-action="open">打开工作台</button></div><div class="side-links"><button class="text-button" type="button" data-action="source-control">Source Control</button></div>`;
}

/** The activity bar is a compact repository overview; the workbench is opened explicitly. */
export class GenerativeGitLauncher implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private previewRef?: string;
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly git: GitService,
        private readonly operation: { busy: boolean },
        private readonly open: () => void
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const nonce = randomBytes(18).toString('base64');
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        const css = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
        view.webview.html = this.html(css, nonce, view.webview.cspSource);
        this.subscriptions.push(
            view.webview.onDidReceiveMessage(message => {
                void this.onMessage(message).catch(error => this.post(renderError(describeGitError(error))));
            }),
            view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); }),
            view.onDidDispose(() => { if (this.view === view) this.view = undefined; }),
            this.git.onDidChange(change => void this.refresh(!!change?.shallow))
        );
        void this.refresh();
    }

    private html(css: vscode.Uri, nonce: string, cspSource: string): string {
        return `<!DOCTYPE html><html lang="zh-Hans"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Generative Git</title></head><body><main class="side-panel"><div id="side-body"><p class="side-empty">正在读取仓库…</p></div></main><script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button)api.postMessage({type:button.dataset.action});});document.addEventListener('change',event=>{const select=event.target.closest('select[data-action]');if(!select)return;if(select.dataset.action==='select-repo')api.postMessage({type:'select-repo',repoId:select.value});else if(select.dataset.action==='preview-branch')api.postMessage({type:'preview-branch',ref:select.value});});window.addEventListener('message',event=>{if(event.data&&event.data.type==='state')document.getElementById('side-body').innerHTML=event.data.html;});</script></body></html>`;
    }

    private post(html: string): void {
        if (this.view) void this.view.webview.postMessage({ type: 'state', html });
    }

    private async refresh(shallow = false): Promise<void> {
        if (!this.view) return;
        try {
            await this.git.whenReady();
            const snapshot = (shallow ? this.git.shallowSnapshot(this.previewRef) : undefined) ?? await this.git.snapshot(this.previewRef);
            this.post(renderSidebar(sidebarState(snapshot, this.git.startupProblem)));
        } catch (error) {
            this.post(renderError(describeGitError(error)));
        }
    }

    private async onMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') return;
        const type = (message as { type?: unknown }).type;
        if (type === 'open') { this.open(); return; }
        if (type === 'refresh') {
            try { await this.git.refresh(); } catch (error) { this.post(renderError(describeGitError(error))); return; }
            await this.refresh();
            return;
        }
        if (type === 'source-control') {
            await vscode.commands.executeCommand('workbench.view.scm');
            return;
        }
        if (type === 'preview-branch') {
            const ref = (message as { ref?: unknown }).ref;
            if (typeof ref !== 'string' || !ref || ref.length > 300) return;
            this.previewRef = ref;
            await this.refresh();
            return;
        }
        if (type === 'preview-current') {
            this.previewRef = undefined;
            await this.refresh();
            return;
        }
        if (type === 'select-repo') {
            const repoId = (message as { repoId?: unknown }).repoId;
            if (typeof repoId !== 'string' || !repoId) return;
            if (this.operation.busy) { await this.refresh(); return; }
            this.previewRef = undefined;
            try {
                await this.git.select(repoId);
                await this.refresh();
            } catch (error) {
                this.post(renderError(describeGitError(error)));
            }
        }
    }

    dispose(): void { this.subscriptions.forEach(d => d.dispose()); }
}
