export interface GraphNode {
    id: string;
    hash: string;
    title: string;
    lane: number;
    row: number;
    badges: string[];
    role: 'commit' | 'merge' | 'ghost' | 'conflict';
    tip?: boolean;
    author?: string;
    authorDate?: string;
}
export interface GraphEdge {
    id: string;
    from: string;
    to: string;
    style: 'solid' | 'pending' | 'join';
}
export interface GraphModel {
    nodes: GraphNode[];
    edges: GraphEdge[];
    laneCount: number;
}
export const emptyGraph = (): GraphModel => ({ nodes: [], edges: [], laneCount: 1 });
