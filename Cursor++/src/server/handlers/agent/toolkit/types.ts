import type { LLMTool } from '../../llm/types';
import type { ProviderType } from '../../../data/defaults';
import type { EditPlan } from './editPlans';

export interface ToolExecBuildOptions {
    conversationId?: string;
    currentModelId?: string;
}

/**
 * Provider 族 — 将 4 种 ProviderType 归约为 3 种工具目录。
 * openai-chat 与 openai-responses 共享同一套工具定义。
 */
export type ProviderFamily = 'anthropic' | 'openai' | 'gemini';

export function toProviderFamily(pt: ProviderType): ProviderFamily {
    switch (pt) {
        case 'anthropic': return 'anthropic';
        case 'openai-chat':
        case 'openai-responses': return 'openai';
        case 'gemini': return 'gemini';
        default: return 'anthropic';
    }
}

/**
 * Cursor Agent 交互模式 — 决定运行时执行权限，不改变工具定义。
 * 客户端通过 AGENT_MODE_* 枚举传入，这里归约为小写。
 */
export type CursorAgentMode = 'agent' | 'ask' | 'plan' | 'debug';

const ASK_MODE_RESTRICTED_TOOL_TYPES = new Set([
    'editToolCall', 'deleteToolCall', 'taskToolCall',
    'generateImageToolCall', 'switchModeToolCall', 'createPlanToolCall',
]);

// updateCurrentStep 只在子代理中可用 — 主代理/Plan/Debug 不需要向 parent 汇报进度
const SUBAGENT_ONLY_TOOLS = new Set([
    'updateCurrentStep',
]);

export function filterToolsForMode(tools: LLMTool[], _mode: string, isSubagent = false): LLMTool[] {
    return isSubagent ? tools : tools.filter(tool => !SUBAGENT_ONLY_TOOLS.has(tool.name));
}

export function getToolModeRestriction(mode: string, cursorToolType: string): string | undefined {
    const normalized = mode.replace('AGENT_MODE_', '').toLowerCase();
    if (cursorToolType === 'createPlanToolCall' && normalized !== 'plan')
        return 'mode_mismatch: CreatePlan requires Plan mode';
    if (normalized === 'ask' && ASK_MODE_RESTRICTED_TOOL_TYPES.has(cursorToolType))
        return `mode_mismatch: ${cursorToolType} is unavailable in Ask mode`;
    if (normalized === 'debug' && cursorToolType === 'switchModeToolCall')
        return 'mode_mismatch: SwitchMode is unavailable in Debug mode';
    return undefined;
}

export interface ToolRegistryEntry {
    canonicalName: string;
    /** 所有 provider 可能使用的工具名。LLM 回调时用 findToolByAlias() 匹配。 */
    aliases: string[];
    cursorToolType: string;
    execArgsType: string | null;
    /**
     * 按 provider 族分化的 LLM 工具定义。
     * 包含该工具面向 LLM 的 name / description / inputSchema。
     * 未列出的 provider 族不会暴露此工具。
     */
    llmToolByProvider: Partial<Record<ProviderFamily, LLMTool>>;
    buildStartedArgs?: (
        input: Record<string, unknown>,
        callId: string,
        options?: ToolExecBuildOptions,
    ) => Record<string, unknown>;
    buildExecArgs?: (
        input: Record<string, unknown>,
        callId: string,
        options?: ToolExecBuildOptions,
    ) => Record<string, unknown>;
    buildEditPlan?: (
        input: Record<string, unknown>,
        callId: string,
        options?: ToolExecBuildOptions,
    ) => EditPlan;
}
