import type { AgentServerMessage } from '../gen/agent_v1_pb'
import { describe, expect, it, vi } from 'vitest'
import { contextualizeDynamicMetaTools, partitionCursorBuiltinTools } from '../handlers/agent/dynamicTools'
import { buildMessages } from '../handlers/agent/protocol/messageBuilder'
import { emptyParsed } from '../handlers/agent/protocol/shared'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import { runToolBatch } from '../handlers/agent/toolBatch'
import { getToolModeRestriction } from '../handlers/agent/toolkit/types'
import { runToolCall } from '../handlers/agent/toolRuntime'
import { AgentRunAbortedError } from '../handlers/agent/wait'
import { resolveProviderRuntime } from '../handlers/llm/providerRuntime'

vi.mock('../config/subagentModelStore', () => ({
  getSubagentConfig: () => ({ schemaVersion: 1, overrides: { shell: { modelId: 'deleted' } } }),
  validateSubagentSelection: () => { throw new Error('Unknown subagent model: deleted') },
}))

const modes = ['AGENT_MODE_AGENT', 'AGENT_MODE_PLAN', 'AGENT_MODE_ASK', 'AGENT_MODE_DEBUG']

function createRuntimeParameters(mode = 'AGENT_MODE_AGENT') {
  let execId = 0
  let interactionId = 0
  return {
    mode,
    availableMcpTools: [],
    conversationId: 'mode-test',
    currentModelId: 'gpt-5.4-medium',
    round: 0,
    session: createEphemeralSession('mode-test'),
    roundContext: resolveProviderRuntime('gpt-5.4-medium').createRoundContext(),
    messages: [],
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => ++interactionId,
  }
}

function frameKind(frame: AgentServerMessage): string {
  return frame.message.case === 'interactionUpdate'
    ? frame.message.value.message.case ?? ''
    : frame.message.case ?? ''
}

describe('mode cache and runtime permissions', () => {
  it.each(['gpt-5.4-medium', 'claude-sonnet-4', 'gemini-3.1-pro-preview'])('keeps static and dynamic profiles stable for %s', (modelId) => {
    const runtime = resolveProviderRuntime(modelId)
    for (const dynamic of [false, true]) {
      const requests = modes.map((mode) => {
        const builtins = runtime.listRuntimeTools([], mode)
        const partition = partitionCursorBuiltinTools(builtins, dynamic)
        const parsed = { ...emptyParsed(), modelId, mode, userText: 'Question', cursorDynamicTools: partition.dynamicTools }
        const messages = buildMessages(parsed)
        const tools = runtime.listRuntimeTools([], mode, false, new Set(partition.dynamicTools.map(tool => tool.tool)), contextualizeDynamicMetaTools(builtins, partition.dynamicTools))
        expect(tools.map(tool => tool.name)).toContain('CreatePlan')
        if (dynamic) {
          expect(tools.map(tool => tool.name)).not.toContain('SwitchMode')
          expect(partition.dynamicTools.map(tool => tool.tool)).toContain('SwitchMode')
        }
        return { system: messages[0], tools, dynamic: partition.dynamicTools }
      })
      expect(new Set(requests.map(request => JSON.stringify(request))).size).toBe(1)
    }
  })

  it.each(['', 'unknown', 'AGENT_MODE_TRIAGE', ...modes.filter(mode => mode !== 'AGENT_MODE_PLAN')])('denies CreatePlan outside Plan: %s', (mode) => {
    expect(getToolModeRestriction(mode, 'createPlanToolCall')).toContain('mode_mismatch')
  })

  it.each(['ApplyPatch', 'Edit', 'Write', 'EditNotebook', 'Delete', 'Task', 'Subagent', 'GenerateImage', 'SwitchMode', 'CreatePlan'])('denies Ask %s without exec or interaction side effects', async (name) => {
    const parameters = createRuntimeParameters('AGENT_MODE_ASK')
    const frames: AgentServerMessage[] = []
    for await (const frame of runToolCall({ ...parameters, toolCall: { name, callId: 'denied', input: {} } }))
      frames.push(frame)
    expect(frames.map(frameKind)).toEqual(['toolCallStarted', 'toolCallCompleted'])
    expect(parameters.roundContext.pendingToolResults[0]).toMatchObject({ isError: true, content: expect.stringContaining('mode_mismatch') })
  })

  it('isolates a broken Task and drains its valid sibling before approving a mode switch', async () => {
    const parameters = createRuntimeParameters()
    let mode = parameters.mode
    const events: string[] = []
    const iterator = runToolBatch({
      ...parameters,
      cursorDynamicTools: [{ tool: 'SwitchMode', description: '', inputSchema: {} }],
      toolCalls: [
        { name: 'Task', callId: 'valid-task', input: { subagent_type: 'explore', prompt: 'Inspect' } },
        { name: 'Task', callId: 'invalid-task', input: { subagent_type: 'shell', prompt: 'Inspect' } },
        { name: 'CallDynamicTool', callId: 'switch', input: { namespace: 'cursor', toolName: 'SwitchMode', arguments: { target_mode_id: 'plan' } } },
        { name: 'CreatePlan', callId: 'plan', input: { name: 'Plan', plan: '# Plan' } },
      ],
      onModeChanged: (nextMode) => {
        mode = nextMode
        events.push('approved')
      },
    })
    for await (const frame of iterator) {
      if (frame.message.case === 'execServerMessage') {
        const identifier = frame.message.value.id
        events.push('task-exec')
        pushSessionMessage(parameters.session, { execClientMessage: { id: identifier, subagentResult: { success: { agentId: 'child', finalMessage: 'Done' } } } })
        pushSessionMessage(parameters.session, { execClientControlMessage: { streamClose: { id: identifier } } })
      }
      if (frame.message.case === 'interactionQuery') {
        const query = frame.message.value
        events.push('interaction')
        const responseName = query.query.case === 'switchModeRequestQuery' ? 'switchModeRequestResponse' : 'createPlanRequestResponse'
        pushSessionMessage(parameters.session, { interactionResponse: { id: query.id, [responseName]: responseName === 'switchModeRequestResponse' ? { approved: {} } : { planUri: 'file:///plan.md' } } })
      }
      if (frameKind(frame) === 'toolCallCompleted')
        events.push('completed')
    }
    expect(mode).toBe('AGENT_MODE_PLAN')
    expect(events.slice(0, 4)).toEqual(['task-exec', 'completed', 'completed', 'interaction'])
    expect(parameters.roundContext.pendingToolResults).toHaveLength(4)
    expect(parameters.roundContext.pendingToolResults.find(result => result.toolUseId === 'invalid-task')?.isError).toBe(true)
    expect(parameters.roundContext.pendingToolResults.find(result => result.toolUseId === 'plan')?.content).not.toContain('mode_mismatch')
  })

  it('does not execute remaining calls after a rejected switch', async () => {
    const parameters = createRuntimeParameters()
    const onModeChanged = vi.fn()
    const kinds: string[] = []
    for await (const frame of runToolBatch({
      ...parameters,
      onModeChanged,
      toolCalls: [
        { name: 'SwitchMode', callId: 'switch', input: { target_mode_id: 'plan' } },
        { name: 'Task', callId: 'task', input: { prompt: 'Do not run' } },
      ],
    })) {
      kinds.push(frameKind(frame))
      if (frame.message.case === 'interactionQuery')
        pushSessionMessage(parameters.session, { interactionResponse: { id: frame.message.value.id, switchModeRequestResponse: { rejected: {} } } })
    }
    expect(onModeChanged).not.toHaveBeenCalled()
    expect(kinds).not.toContain('execServerMessage')
    expect(parameters.roundContext.pendingToolResults.at(-1)?.content).toContain('not_executed')
  })

  it('applies the new mode to CreatePlan in the same batch after leaving Plan', async () => {
    const parameters = createRuntimeParameters('AGENT_MODE_PLAN')
    let interactions = 0
    for await (const frame of runToolBatch({
      ...parameters,
      onModeChanged: () => {},
      toolCalls: [
        { name: 'SwitchMode', callId: 'switch', input: { target_mode_id: 'agent' } },
        { name: 'CreatePlan', callId: 'plan', input: { name: 'Plan', plan: '# Plan' } },
      ],
    })) {
      if (frame.message.case === 'interactionQuery') {
        interactions++
        pushSessionMessage(parameters.session, { interactionResponse: { id: frame.message.value.id, switchModeRequestResponse: { approved: {} } } })
      }
    }
    expect(interactions).toBe(1)
    expect(parameters.roundContext.pendingToolResults.at(-1)).toMatchObject({ isError: true, content: expect.stringContaining('mode_mismatch') })
  })

  it.each([
    ['AGENT_MODE_ASK', 'Task'],
    ['AGENT_MODE_ASK', 'EditNotebook'],
    ['AGENT_MODE_DEBUG', 'SwitchMode'],
    ['AGENT_MODE_DEBUG', 'CreatePlan'],
  ])('enforces %s permissions through cursor namespace %s', async (mode, toolName) => {
    const parameters = createRuntimeParameters(mode)
    const frames: AgentServerMessage[] = []
    for await (const frame of runToolCall({
      ...parameters,
      cursorDynamicTools: [{ tool: toolName, description: '', inputSchema: {} }],
      toolCall: { name: 'CallDynamicTool', callId: 'denied-dynamic', input: { namespace: 'cursor', toolName, arguments: {} } },
    }))
      frames.push(frame)
    expect(frames.map(frameKind)).toEqual(['toolCallStarted', 'toolCallCompleted'])
    expect(parameters.roundContext.pendingToolResults.at(-1)?.isError).toBe(true)
  })

  it('propagates cancellation instead of treating it as a failed Task', async () => {
    const parameters = createRuntimeParameters()
    const iterator = runToolBatch({ ...parameters, onModeChanged: () => {}, toolCalls: [
      { name: 'Task', callId: 'task', input: { prompt: 'Inspect' } },
      { name: 'SwitchMode', callId: 'switch', input: { target_mode_id: 'plan' } },
    ] })
    await expect((async () => {
      for await (const frame of iterator) {
        if (frame.message.case === 'execServerMessage')
          pushSessionMessage(parameters.session, { execClientControlMessage: { throw: { id: frame.message.value.id, error: 'signal is aborted without reason' } } })
      }
    })()).rejects.toBeInstanceOf(AgentRunAbortedError)
  })
})
