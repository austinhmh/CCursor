import type { PersistedConversationCheckpoint } from '../database/checkpoints'
import type { ParsedRunRequest } from '../handlers/agent/protocol/types'
import type { LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { fromBinary } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserMessageSchema } from '../gen/agent_v1_pb'
import { resetBlobCacheForTests, warmupBlobsAsync } from '../handlers/agent/blobStore'
import { handleConversationRun } from '../handlers/agent/conversationRuntime'
import { extractHumanQuery, hydrateHistoryEntries } from '../handlers/agent/historyManager'
import { emptyParsed } from '../handlers/agent/protocol/shared'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import { readTurnBaseline } from '../handlers/agent/turnTracker'
import { resolveProviderRuntime } from '../handlers/llm/providerRuntime'

// Mock persistence and transport boundaries, not history, scheduling or protobuf.
const storage = vi.hoisted(() => ({ blobs: new Map<string, string>(), checkpoints: new Map<string, PersistedConversationCheckpoint>() }))
vi.mock('../database/blobs', () => ({
  persistBlob: async (identifier: string, data: string) => { storage.blobs.set(identifier, data) },
  loadPersistedBlob: async (identifier: string) => storage.blobs.get(identifier),
}))
vi.mock('../database/checkpoints', () => ({
  persistConversationCheckpoint: async (checkpoint: PersistedConversationCheckpoint) => { storage.checkpoints.set(checkpoint.kind, structuredClone(checkpoint)) },
  clearDraftCheckpoint: async () => {},
}))
vi.mock('../config/subagentModelStore', () => ({ getSubagentConfig: () => ({ schemaVersion: 1 }) }))

beforeEach(() => {
  storage.blobs.clear()
  storage.checkpoints.clear()
  resetBlobCacheForTests()
})
afterEach(() => vi.restoreAllMocks())

function makeParsed(): ParsedRunRequest {
  return {
    ...emptyParsed(),
    modelId: 'gpt-5.4-medium',
    conversationId: 'contract-test',
    userText: 'Inspect',
    mode: 'AGENT_MODE_AGENT',
    rawUserMessage: { text: 'Inspect', messageId: 'human-original', mode: 'AGENT_MODE_AGENT' },
    ideState: { visibleFiles: [{ path: '/original.ts', totalLines: 3 }], recentlyViewedFiles: [] },
  }
}

function toolEvents(name: string, identifier: string, input: Record<string, unknown>): LLMStreamEvent[] {
  return [
    { type: 'tool_use_start', name, id: identifier },
    { type: 'tool_use_delta', id: identifier, input: JSON.stringify(input) },
    { type: 'tool_use_done', id: identifier },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 5 } },
  ]
}

function captureRequests(rounds: LLMStreamEvent[][]): LLMStreamRequest[] {
  const requests: LLMStreamRequest[] = []
  const provider = resolveProviderRuntime('gpt-5.4-medium').provider
  vi.spyOn(provider, 'stream').mockImplementation(async function* (request) {
    requests.push(structuredClone(request))
    for (const event of rounds.shift() ?? [{ type: 'text_delta', text: 'Done' }, { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 5 } }] as LLMStreamEvent[])
      yield event
  })
  return requests
}

async function run(parsed: ParsedRunRequest) {
  const session = createEphemeralSession(parsed.conversationId)
  for await (const frame of handleConversationRun(parsed, session)) {
    if (frame.message.case === 'interactionQuery') {
      expect(frame.message.value.query.case).toBe('switchModeRequestQuery')
      pushSessionMessage(session, { interactionResponse: { id: frame.message.value.id, switchModeRequestResponse: { approved: {} } } })
    }
  }
}

describe('conversation runtime contracts', () => {
  it('appends mode reminders after tool results, retains snapshots and resumes binary turns after cache reload', async () => {
    const requests = captureRequests([
      toolEvents('SwitchMode', 'switch-plan', { target_mode_id: 'plan' }),
      toolEvents('SwitchMode', 'switch-agent', { target_mode_id: 'agent' }),
    ])
    await run(makeParsed())
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map(request => JSON.stringify(request.tools))).size).toBe(1)
    expect(requests[1].messages.at(-1)?.content).toContain('Plan mode is active')
    expect(requests[2].messages.at(-1)?.content).toContain('Mode changed to AGENT')
    for (const request of requests) {
      expect(request.messages.filter(message => extractHumanQuery(message) !== undefined)).toHaveLength(1)
      expect(request.messages[0]).toEqual(requests[0].messages[0])
    }
    const checkpoint = storage.checkpoints.get('committed')!
    expect(checkpoint.mode).toBe('AGENT_MODE_AGENT')
    const originalTurn = readTurnBaseline(checkpoint.turnBlobIds[0])!
    const originalUser = fromBinary(UserMessageSchema, Buffer.from(storage.blobs.get(originalTurn.userMessageBlobId)!, 'base64'))
    expect(originalUser.messageId).toBe('human-original')
    resetBlobCacheForTests()
    await warmupBlobsAsync([...checkpoint.rootBlobIds, ...checkpoint.turnBlobIds])
    const resumed = { ...makeParsed(), isResume: true, userText: '', rawUserMessage: undefined, historyBlobIds: checkpoint.rootBlobIds, historyTurnBlobIds: checkpoint.turnBlobIds }
    await run(resumed)
    const nextCheckpoint = storage.checkpoints.get('committed')!
    expect(nextCheckpoint.turnBlobIds).toHaveLength(1)
    expect(readTurnBaseline(nextCheckpoint.turnBlobIds[0])?.userMessageBlobId).toBe(originalTurn.userMessageBlobId)
    const finalHistory = hydrateHistoryEntries(nextCheckpoint.rootBlobIds)
    expect(finalHistory.filter(entry => extractHumanQuery(entry.message) !== undefined)).toHaveLength(1)
  })

  it('creates ordinary and binary users together for an empty resume with a real query', async () => {
    captureRequests([])
    await run({ ...makeParsed(), isResume: true })
    const checkpoint = storage.checkpoints.get('committed')!
    expect(checkpoint.turnBlobIds).toHaveLength(1)
    expect(hydrateHistoryEntries(checkpoint.rootBlobIds).filter(entry => extractHumanQuery(entry.message) !== undefined)).toHaveLength(1)
    expect(readTurnBaseline(checkpoint.turnBlobIds[0])?.userMessageBlobId).toBeTruthy()
  })

  it('rejects empty resume queries and damaged referenced turns before any provider call', async () => {
    const requests = captureRequests([])
    await expect(run({ ...makeParsed(), isResume: true, userText: '', rawUserMessage: undefined })).rejects.toThrow('resume_user_missing')
    await expect(run({ ...makeParsed(), isResume: true, historyTurnBlobIds: ['missing-turn'] })).rejects.toThrow('resume_turn_invalid')
    expect(requests).toHaveLength(0)
  })

  it('continues a legacy query without inventing a binary turn or rewriting its snapshot', async () => {
    const requests = captureRequests([])
    await run(makeParsed())
    const checkpoint = storage.checkpoints.get('committed')!
    await run({ ...makeParsed(), isResume: true, userText: '', rawUserMessage: undefined, historyBlobIds: checkpoint.rootBlobIds, historyTurnBlobIds: [], ideState: undefined })
    expect(storage.checkpoints.get('committed')?.turnBlobIds).toEqual([])
    const originalUser = requests[0].messages.find(message => extractHumanQuery(message) !== undefined)
    expect(requests.at(-1)?.messages.find(message => extractHumanQuery(message) !== undefined)).toEqual(originalUser)
  })
})
