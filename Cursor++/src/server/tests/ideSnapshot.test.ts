import type { LLMMessage } from '../handlers/llm/types'
import { fromBinary } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { UserMessageSchema } from '../gen/agent_v1_pb'
import { encodeBlob } from '../handlers/agent/blob'
import { cacheBlob } from '../handlers/agent/blobStore'
import { rebuildConversationHistory } from '../handlers/agent/historyManager'
import { buildMessages } from '../handlers/agent/protocol/messageBuilder'
import { parseRunRequest } from '../handlers/agent/protocol/parseRunRequest'
import { emptyParsed } from '../handlers/agent/protocol/shared'
import { ActiveTurnTracker, createCurrentTurnUserMessageBlob, readTurnBaseline } from '../handlers/agent/turnTracker'

vi.mock('../database/blobs', () => ({ persistBlob: vi.fn(async () => {}), loadPersistedBlob: vi.fn(async () => undefined) }))
vi.mock('../config/knowledgeBaseStore', () => ({ listKnowledgeItems: () => [] }))

function createParsed(path = '/original.ts') {
  return { ...emptyParsed(), modelId: 'gpt-5.4-medium', mode: 'AGENT_MODE_PLAN', userText: 'Question', ideState: { visibleFiles: [{ path, totalLines: 5, cursorLine: 2, cursorText: '<selected>' }], recentlyViewedFiles: [] } }
}

function rebuild(history: LLMMessage[], options: { isResume?: boolean, resumeUserText?: string, userText?: string, prepend?: string } = {}) {
  const [system, preamble, current] = buildMessages({ ...createParsed('/new.ts'), userText: options.userText ?? 'Question' })
  const historyBlobIds = history.map((message) => {
    const blob = encodeBlob(message)
    cacheBlob(blob.blobId, blob.blobData)
    return blob.blobId
  })
  const iterator = rebuildConversationHistory({
    historyBlobIds,
    isResume: options.isResume,
    resumeUserText: options.resumeUserText,
    prependUserMessages: options.prepend ? [{ text: options.prepend }] : [],
    systemMessage: system,
    preambleUserMessage: preamble,
    currentUserMessage: current,
    systemContent: String(system.content),
    preambleUserContent: String(preamble.content),
    * sendSystemScaffoldBlob() {},
    * sendOrderedBlob() {},
  })
  for (;;) {
    const result = iterator.next()
    if (result.done)
      return result.value
  }
}

describe('iDE snapshots and resume', () => {
  it('changes only the new user and preserves images and old snapshots', () => {
    const original = buildMessages(createParsed())
    const updated = buildMessages({ ...createParsed('/new.ts'), selectedImages: [{ mimeType: 'image/png', data: 'AA==' }] })
    expect(updated.slice(0, 2)).toEqual(original.slice(0, 2))
    expect(original[1].content).not.toContain('<ide_state')
    expect(original[2].content).toContain('&lt;selected&gt;')
    expect(updated[2].content[0]).toMatchObject({ type: 'image', data: 'AA==' })
    const result = rebuild(original)
    expect(result.messages[2]).toEqual(original[2])
    expect(result.currentUserAppended).toBe(true)
  })

  it('resumes a verified query without counting prepend or tool-result users', () => {
    const original = buildMessages(createParsed())
    const resumed = rebuild(original, { isResume: true, resumeUserText: 'Question', prepend: 'Background' })
    expect(resumed.currentUserAppended).toBe(false)
    expect(resumed.messages.filter(message => message.role === 'user' && String(message.content).includes('<user_query>'))).toHaveLength(1)
    expect(() => rebuild(original.slice(0, 2), { isResume: true, prepend: 'Not a query' })).toThrow('resume_user_missing')
    expect(() => rebuild(original, { isResume: true, resumeUserText: 'Different' })).toThrow('resume_turn_mismatch')
    expect(() => rebuild([], { isResume: true, userText: '', prepend: 'Not a query' })).toThrow('resume_user_missing')
    expect(rebuild([], { isResume: true }).currentUserAppended).toBe(true)
  })

  it('keeps one legacy snapshot across repeated scaffold refresh', () => {
    const snapshot = '<ide_state><visible_files>old</visible_files></ide_state>'
    const messages: LLMMessage[] = [{ role: 'system', content: 'old-system' }, { role: 'user', content: `<user_info>old</user_info>\n\n${snapshot}\n\n<rules>old</rules>` }]
    const first = rebuild(messages)
    const second = rebuild(first.messages)
    expect(second.messages[1].content).toBe(first.messages[1].content)
    expect(String(second.messages[1].content).match(/<ide_state>/g)).toHaveLength(1)
    expect(second.messages[1].content).not.toContain('<rules>old</rules>')
  })

  it('uses the real IDE schema and stable UTF-8 turn references', () => {
    const user = createCurrentTurnUserMessageBlob({ parsed: createParsed(), fallbackMessageId: 'user-id' })
    const decoded = fromBinary(UserMessageSchema, Buffer.from(user.blob.blobData, 'base64'))
    const invocation = decoded.selectedContext?.invocationContext?.data
    expect(invocation?.case).toBe('ideState')
    if (invocation?.case !== 'ideState')
      throw new Error('Missing IDE state')
    expect(invocation.value.visibleFiles[0]).toMatchObject({ path: '/original.ts', cursorPosition: { line: 2, text: '<selected>' } })
    const turn = new ActiveTurnTracker(user.blob.blobId, [], user.messageId).materializeTurnBlob()
    cacheBlob(turn.blobId, turn.blobData)
    expect(readTurnBaseline(turn.blobId)?.userMessageBlobId).toBe(user.blob.blobId)
  })

  it('restores resume mode from the client checkpoint, not the absent user action', () => {
    const parsed = parseRunRequest({ runRequest: { action: { resumeAction: {} }, conversationState: { mode: 'AGENT_MODE_PLAN' } } })
    expect(parsed.isResume).toBe(true)
    expect(parsed.mode).toBe('AGENT_MODE_PLAN')
  })
})
