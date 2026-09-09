import { arr, str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * CreatePlan — 稳定注册、仅 Plan Mode 允许执行
 *
 * Proto: createPlanToolCall (field 17)
 * Args: CreatePlanArgs { plan, todos[], overview, name, is_project?, phases[] }
 * Result: CreatePlanResult { plan_uri, oneof { success: {}, error: { error } } }
 *
 * 流程: 交互握手 (CreatePlanRequestQuery → CreatePlanRequestResponse)
 * 客户端创建 .plan.md 文件并返回 planUri。
 *
 * 所有模式使用相同定义，非 Plan 调用由运行时权限检查拒绝。
 */
const CREATE_PLAN_TOOL = {
    name: 'CreatePlan',
    description: `Use this tool to create a concise plan for accomplishing the user's request. This tool should be called at the end of the planning phase to finalize and store the plan. The definition is always visible, but execution requires Plan mode; other modes return mode_mismatch.

The plan you create should be properly formatted in markdown, using appropriate sections and headers. The plan should be very concise and actionable, providing the minimum amount of detail for the user to understand and action the plan.`,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'A short 3-4 word name for the plan. IMPORTANT: This should only be provided on the FIRST CreatePlan call. On subsequent updates, this field will be ignored to keep the plan file name stable.' },
            overview: { type: 'string', description: 'A 1-2 sentence high-level description of the plan that summarizes what will be accomplished' },
            plan: { type: 'string', description: 'A detailed, concrete plan for accomplishing the user\'s request' },
            todos: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['id', 'content'],
                    properties: {
                        id: { type: 'string', description: 'Unique identifier for the todo' },
                        content: { type: 'string', description: 'Description of the todo task' },
                    },
                },
                description: 'Array of implementation todos',
            },
        },
    },
};

const GEMINI_CREATE_PLAN = {
    ...CREATE_PLAN_TOOL,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            name: { type: 'STRING', description: CREATE_PLAN_TOOL.inputSchema.properties.name.description },
            overview: { type: 'STRING', description: CREATE_PLAN_TOOL.inputSchema.properties.overview.description },
            plan: { type: 'STRING', description: CREATE_PLAN_TOOL.inputSchema.properties.plan.description },
            todos: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT',
                    required: ['id', 'content'],
                    properties: {
                        id: { type: 'STRING', description: 'Unique identifier for the todo' },
                        content: { type: 'STRING', description: 'Description of the todo task' },
                    },
                },
                description: 'Array of implementation todos',
            },
        },
    },
};

export const CreatePlanTool: ToolRegistryEntry = {
    canonicalName: 'CreatePlan',
    aliases: ['CreatePlan'],
    cursorToolType: 'createPlanToolCall',
    execArgsType: null,
    llmToolByProvider: {
        anthropic: CREATE_PLAN_TOOL,
        openai: CREATE_PLAN_TOOL,
        gemini: GEMINI_CREATE_PLAN,
    },
    buildStartedArgs: (input) => ({
        plan: str(input.plan),
        todos: arr<Record<string, unknown>>(input.todos),
        overview: str(input.overview),
        name: str(input.name),
        ...(typeof input.is_project === 'boolean' ? { isProject: input.is_project } : {}),
        ...(Array.isArray(input.phases) ? { phases: input.phases } : {}),
    }),
};
