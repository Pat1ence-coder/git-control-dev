import { emptyGraph, type GraphModel } from '../shared/model';
export interface LayoutCommit {
    hash: string;
    parents: string[];
    message: string;
    badges?: string[];
    authorName?: string;
    authorDate?: Date;
}
export function layoutCommits(input: LayoutCommit[], head?: string): GraphModel {
    const seen = new Set<string>();
    const commits = input.map(c => ({ ...c, hash: c.hash.toLowerCase(), parents: c.parents.map(p => p.toLowerCase()) })).filter(c => !seen.has(c.hash) && !!seen.add(c.hash));
    const graph = emptyGraph();
    const rows = new Map(commits.map((c, i) => [c.hash, i]));
    const lanes: (string | null)[] = [];
    const alloc = (hash: string): number => { const old = lanes.indexOf(hash); if (old >= 0)
        return old; const free = lanes.indexOf(null); const n = free < 0 ? lanes.length : free; lanes[n] = hash; return n; };
    commits.forEach((c, row) => {
        const lane = alloc(c.hash);
        lanes[lane] = null;
        graph.nodes.push({ id: c.hash, hash: c.hash.slice(0, 7), title: c.message.split('\n')[0], lane, row, badges: (c.badges || []).slice(0, 2), role: c.parents.length > 1 ? 'merge' : 'commit', tip: c.hash === head?.toLowerCase(), author: c.authorName, authorDate: c.authorDate?.toISOString() });
        c.parents.forEach((p, index) => {
            if ((rows.get(p) ?? -1) <= row)
                return;
            if (index === 0 && !lanes.includes(p))
                lanes[lane] = p;
            else
                alloc(p);
            graph.edges.push({ id: `${c.hash}-${p}`, from: c.hash, to: p, style: 'solid' });
        });
    });
    graph.laneCount = Math.max(1, ...graph.nodes.map(n => n.lane + 1));
    return graph;
}
export function withPendingMerge(graph: GraphModel, head: string, incoming?: string): GraphModel {
    const tip = graph.nodes.find(n => n.id === head);
    if (!tip)
        return graph;
    const nodes = graph.nodes.map(n => ({ ...n, row: n.row + 1, tip: false }));
    nodes.unshift({ id: 'pending-merge', hash: '待提交', title: '冲突已解决 · 等待提交', lane: tip.lane, row: 0, role: 'ghost', tip: true, badges: ['待提交'] });
    const edges = [...graph.edges, { id: 'pending-head', from: 'pending-merge', to: head, style: 'join' as const }];
    if (incoming && incoming !== head && nodes.some(n => n.id === incoming))
        edges.push({ id: 'pending-incoming', from: 'pending-merge', to: incoming, style: 'join' });
    return { ...graph, nodes, edges };
}
