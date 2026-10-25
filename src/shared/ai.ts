/** Types shared by the host and the webview. No secret or transport detail belongs here. */
export type AiMode = 'manual' | 'takeover';
export type AiAction = 'commit' | 'fetch' | 'push' | 'merge' | 'none';
export type AiEffort = 'auto' | 'low' | 'high' | 'max';

export interface AiConfig {
    configured: boolean;
    model: string;
    effort: AiEffort;
    thinking: boolean;
}

export interface AiContext {
    repoName: string;
    headName: string;
    headHash?: string;
    ahead?: number;
    behind?: number;
    stagedCount: number;
    workingTreeCount: number;
    conflicts: number;
    mergeHead: boolean;
    rebasing: boolean;
    hasUpstream: boolean;
    branches: string[];
}

/** The model may propose fields; the host derives the actual command and never executes model text. */
export interface AiProposal {
    action: AiAction;
    analysis: string[];
    reason: string;
    command?: string;
    commit?: { message: string };
    fetch?: { remote: string };
    push?: { remote: string; branch: string };
    merge?: { source: string };
}

export type AiEventPhase = 'thinking' | 'content' | 'done' | 'error' | 'cancelled';

export interface AiEvent {
    type: 'ai-event';
    requestId: number;
    phase: AiEventPhase;
    thinking?: string;
    content?: string;
    proposal?: AiProposal;
    error?: string;
}
