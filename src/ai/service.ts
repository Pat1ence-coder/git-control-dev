import * as vscode from 'vscode';
import type { AiConfig, AiContext, AiEffort, AiMode, AiProposal } from '../shared/ai';
import { DeepSeekError, requestProposal, type DeepSeekOptions } from './deepseek';
import { AiPolicyError, buildAiContext, validateProposal } from './policy';
import { UserFacingError } from '../git/errors';
import type { Snapshot } from '../shared/protocol';

export const DEEPSEEK_KEY = 'generativeGit.deepseekApiKey';

export class AiService {
    constructor(private readonly secrets: vscode.SecretStorage, private readonly output: vscode.OutputChannel, private readonly options: DeepSeekOptions = {}) { }
    private settings(): { model: string; effort: AiEffort; thinking: boolean } {
        const c = vscode.workspace.getConfiguration('generativeGit.ai');
        const effort = c.get<AiEffort>('reasoningEffort', 'high');
        return { model: c.get<string>('model', 'deepseek-v4-pro'), effort: ['auto', 'low', 'high', 'max'].includes(effort) ? effort : 'high', thinking: c.get<boolean>('thinking', true) };
    }
    async config(): Promise<AiConfig> {
        const key = await this.secrets.get(DEEPSEEK_KEY);
        const s = this.settings();
        return { configured: !!key, model: s.model, effort: s.effort, thinking: s.thinking };
    }
    async setKey(key: string): Promise<void> { await this.secrets.store(DEEPSEEK_KEY, key); }
    async clearKey(): Promise<void> { await this.secrets.delete(DEEPSEEK_KEY); }
    async propose(input: { prompt: string; mode: AiMode; snapshot: Snapshot; signal?: AbortSignal; onThinking?: (text: string) => void; onContent?: (text: string) => void }): Promise<AiProposal> {
        const key = await this.secrets.get(DEEPSEEK_KEY);
        if (!key) throw new UserFacingError('尚未配置 DeepSeek API Key，请先运行“设置 DeepSeek API Key”。');
        const s = this.settings();
        const context: AiContext = buildAiContext(input.snapshot);
        const effort: Exclude<AiEffort, 'auto'> = s.effort === 'auto' ? 'high' : s.effort;
        try {
            const proposal = await requestProposal({ ...input, context, apiKey: key, model: s.model, effort, thinking: s.thinking }, this.options);
            return validateProposal(proposal, input.snapshot, context);
        } catch (error) {
            if (error instanceof DeepSeekError || error instanceof AiPolicyError) throw new UserFacingError(error.message);
            throw error;
        }
    }
}
