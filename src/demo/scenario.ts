import type { GraphModel } from '../shared/model';
import type { Strategy, CommitDetail, StagedReview } from '../shared/protocol';
import { applyResolution } from '../git/conflicts';
const DEMO_STARTED = Date.now();
export type DemoPhase = 'idle' | 'merging' | 'conflict' | 'resolving' | 'checking' | 'reviewing' | 'committing' | 'merged';
export interface DemoState {
    phase: DemoPhase;
    strategy?: Strategy;
}
export type DemoAction = {
    type: 'start' | 'merge-animated' | 'checked' | 'finish' | 'commit' | 'committed' | 'reset';
} | {
    type: 'resolve';
    strategy: Strategy;
};
export const initialDemo = (): DemoState => ({ phase: 'idle' });
export function demoReducer(state: DemoState, action: DemoAction): DemoState {
    if (action.type === 'reset')
        return initialDemo();
    if (action.type === 'start' && ['idle', 'merged'].includes(state.phase))
        return { phase: 'merging' };
    if (action.type === 'merge-animated' && state.phase === 'merging')
        return { phase: 'conflict' };
    if (action.type === 'resolve' && state.phase === 'conflict')
        return { phase: 'resolving', strategy: action.strategy };
    if (action.type === 'checked' && state.phase === 'resolving')
        return { ...state, phase: 'checking' };
    if (action.type === 'finish' && state.phase === 'checking')
        return { ...state, phase: 'reviewing' };
    if (action.type === 'commit' && state.phase === 'reviewing')
        return { ...state, phase: 'committing' };
    if (action.type === 'committed' && state.phase === 'committing')
        return { ...state, phase: 'merged' };
    return state;
}
const CURRENT = `type Cart = { price: number; quantity: number };

export function total(cart: Cart) {
  const sub = cart.price * cart.quantity;
  return Math.round(sub * 1.08);
}`;
const INCOMING = `type Cart = { price: number; quantity: number; discount?: number };

export function total(cart: Cart) {
  const sub = cart.price * cart.quantity - (cart.discount ?? 0);
  return sub;
}`;
export const DEMO_CONFLICT = `<<<<<<< HEAD\n${CURRENT}\n=======\n${INCOMING}\n>>>>>>> feature/checkout-flow\n`;
export const DEMO_AI = `type Cart = { price: number; quantity: number; discount?: number };

export function total(cart: Cart) {
  // 保留折扣与税率：先减折扣，再计算税费。
  const sub = cart.price * cart.quantity - (cart.discount ?? 0);
  return Math.round(sub * 1.08);
}
`;
export function demoResolved(strategy: Strategy = 'ai'): string { return strategy === 'ai' ? DEMO_AI : applyResolution(DEMO_CONFLICT, strategy).text; }
export function demoCheck(strategy: Strategy = 'ai'): {
    label: string;
    ok: boolean;
}[] {
    return [{ label: '保留 8% 税率，且只定义一个 total', ok: strategy === 'ai' || strategy === 'current' }, { label: '保留可选折扣，且只定义一个 Cart', ok: strategy === 'ai' || strategy === 'incoming' }];
}
export function demoGraph(phase: DemoPhase): GraphModel {
    const active = phase !== 'idle';
    const offset = active ? 1 : 0;
    const graph: GraphModel = { laneCount: 2, nodes: [
            { id: 'a1f3c09', hash: 'a1f3c09', title: 'fix: 补上结算税率', lane: 0, row: offset, badges: phase === 'merged' ? [] : ['main'], role: 'commit', tip: !active },
            { id: 'b77e221', hash: 'b77e221', title: 'docs: 更新产品目录', lane: 0, row: 1 + offset, badges: [], role: 'commit' },
            { id: '9c0d4e2', hash: '9c0d4e2', title: 'feat: 支持结算折扣', lane: 1, row: 2 + offset, badges: ['feature/checkout-flow'], role: 'commit' },
            { id: '44aa018', hash: '44aa018', title: 'feat: 添加定价模块', lane: 0, row: 3 + offset, badges: [], role: 'commit' },
            { id: '0e11aa0', hash: '0e11aa0', title: 'chore: 初始化 aurora', lane: 0, row: 4 + offset, badges: [], role: 'commit' }
        ], edges: [
            { id: 'e1', from: 'a1f3c09', to: 'b77e221', style: 'solid' }, { id: 'e2', from: 'b77e221', to: '44aa018', style: 'solid' },
            { id: 'e3', from: '9c0d4e2', to: '44aa018', style: 'solid' }, { id: 'e4', from: '44aa018', to: '0e11aa0', style: 'solid' }
        ] };
    if (active) {
        graph.nodes.unshift({ id: phase === 'merged' ? 'e7b21aa' : 'demo-pending', hash: phase === 'merged' ? 'e7b21aa' : phase === 'merging' ? '···' : '冲突', title: phase === 'merged' ? 'Merge feature/checkout-flow' : phase === 'merging' ? '正在合并两条分支…' : '解决 src/checkout.ts', lane: 0, row: 0, badges: phase === 'merged' ? ['main'] : [], role: phase === 'merged' ? 'merge' : phase === 'merging' ? 'ghost' : 'conflict', tip: true });
        for (const to of ['a1f3c09', '9c0d4e2'])
            graph.edges.push({ id: `merge-${to}`, from: graph.nodes[0].id, to, style: phase === 'merged' ? 'join' : 'pending' });
        if (phase === 'reviewing' || phase === 'committing') {
            Object.assign(graph.nodes[0], { hash: '待提交', title: '审查合并结果', role: 'ghost' });
        }
    }
    const ages: Record<string, number> = { a1f3c09: 25, b77e221: 40, '9c0d4e2': 32, '44aa018': 120, '0e11aa0': 180, e7b21aa: 0 };
    for (const node of graph.nodes) {
        if (node.id in ages) {
            node.author = ['9c0d4e2', '44aa018', '0e11aa0'].includes(node.id) ? 'Sam' : 'You';
            node.authorDate = new Date(DEMO_STARTED - ages[node.id] * 60000).toISOString();
        }
    }
    return graph;
}
export function demoReview(strategy?: Strategy): StagedReview {
    const before = demoResolved('current').trimEnd().split('\n');
    const after = demoResolved(strategy).trimEnd().split('\n');
    return {
        repoId: 'demo', headName: 'main', token: 'demo', merge: true,
        files: [{ path: 'src/checkout.ts', status: '已修改' }], path: 'src/checkout.ts',
        patch: `--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,${before.length} +1,${after.length} @@\n`
            + before.map(line => '-' + line).concat(after.map(line => '+' + line)).join('\n'),
        truncated: false, suggestedMessage: 'Merge feature/checkout-flow into main', unstagedCount: 0
    };
}
const BASE = `type Cart = { price: number; quantity: number };\n\nexport function total(cart: Cart) {\n  return cart.price * cart.quantity;\n}\n`;
export function demoCommit(hash: string): CommitDetail {
    const data: Record<string, {
        message: string;
        path: string;
        before: string;
        after: string;
    }> = {
        a1f3c09: { message: 'fix: 补上结算税率', path: 'src/checkout.ts', before: BASE, after: CURRENT + '\n' },
        b77e221: { message: 'docs: 更新产品目录', path: 'README.md', before: '# Aurora\n', after: '# Aurora\n\nA thoughtful checkout experience.\n' },
        '9c0d4e2': { message: 'feat: 支持结算折扣', path: 'src/checkout.ts', before: BASE, after: INCOMING + '\n' },
        '44aa018': { message: 'feat: 添加定价模块', path: 'src/checkout.ts', before: '', after: BASE },
        '0e11aa0': { message: 'chore: 初始化 aurora', path: 'README.md', before: '', after: '# Aurora\n' },
        e7b21aa: { message: 'Merge feature/checkout-flow', path: 'src/checkout.ts', before: CURRENT + '\n', after: DEMO_AI }
    };
    const c = data[hash] || data.a1f3c09;
    const oldLines = c.before.trimEnd().split('\n').filter((_, i) => c.before || i > 0), newLines = c.after.trimEnd().split('\n');
    return { hash, message: c.message, author: 'Aurora team', date: '2026-10-20T08:30:00.000Z', files: [{ path: c.path, status: c.before ? '已修改' : '新增' }], path: c.path, patch: `--- ${c.before ? 'a/' + c.path : '/dev/null'}\n+++ b/${c.path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +1,${newLines.length} @@\n` + oldLines.map(l => '-' + l).concat(newLines.map(l => '+' + l)).join('\n'), note: '演示提交 · 示例 diff' };
}
