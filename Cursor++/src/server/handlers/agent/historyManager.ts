import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { LLMContentBlock, LLMMessage } from '../llm/types'
import { logger } from '../../logger'
import { decodeBlob, encodeBlob } from './blob'
import { cacheBlob, getCachedBlob } from './blobStore'
import { normalizeBlobMessage, restoreBlobMessageToLLMMessage } from './transcript'
import { createRepairDiagnostics, hasRepairMutations, repairConversationHistory, type RepairDiagnostics } from '../llm/transformMessages'

export interface HistoryEntry {
  blobId: string
  raw: Record<string, unknown>
  message: LLMMessage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

export function* sendAndCacheBlob(
  buildKvMessage: (id: number, blobId: string, blobData: string) => AgentServerMessage,
  id: number,
  data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean, providerOptions?: Record<string, unknown> },
  blobIds: string[],
): Generator<AgentServerMessage, void, void> {
  const normalized = normalizeBlobMessage(data)
  const blob = encodeBlob(normalized)
  blobIds.push(blob.blobId)
  cacheBlob(blob.blobId, blob.blobData)
  yield buildKvMessage(id, blob.blobId, blob.blobData)
}

export function* flushMessageBlobs(
  buildKvMessage: (id: number, blobId: string, blobData: string) => AgentServerMessage,
  messages: LLMMessage[],
  startIndex: number,
  blobCounter: number,
  blobIds: string[],
): Generator<AgentServerMessage, { nextIndex: number, blobCounter: number }, void> {
  let nextIndex = startIndex
  let nextBlobCounter = blobCounter

  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]
    yield* sendAndCacheBlob(buildKvMessage, ++nextBlobCounter, {
      role: msg.role,
      content: msg.content,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      isError: msg.isError,
    }, blobIds)
    nextIndex = i + 1
  }

  return { nextIndex, blobCounter: nextBlobCounter }
}

export function extractPlainTextContent(message: LLMMessage): string {
  if (typeof message.content === 'string')
    return message.content
  return message.content
    .filter((block): block is Extract<LLMContentBlock, { type: 'text' | 'thinking' }> => block.type === 'text' || block.type === 'thinking')
    .map(block => block.text)
    .join('')
}

export function extractComparableUserTexts(message: LLMMessage): string[] {
  const text = extractPlainTextContent(message).trim()
  if (!text)
    return []

  const values = new Set<string>([text])
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const userQueryMatches = text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)
  for (const match of userQueryMatches) {
    const inner = match[1]?.trim()
    if (inner)
      values.add(inner)
  }

  return [...values]
}

export function hasSystemMessage(messages: LLMMessage[]): boolean {
  return messages.some(message => message.role === 'system')
}

export function isPreambleUserMessage(message: LLMMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string')
    return false
  return message.content.includes('<user_info>')
    && !message.content.includes('<user_query>')
}

export function hasPreambleUserMessage(messages: LLMMessage[]): boolean {
  return messages.some(isPreambleUserMessage)
}

function preserveLegacyIdeState(previous: string, current: string): string {
  const snapshot = previous.match(/<ide_state(?:\s[^>]*)?>[\s\S]*?<\/ide_state>/)
  if (!snapshot || current.includes('<ide_state'))
    return current
  for (const anchor of ['</agent_transcripts>', '</user_info>']) {
    const position = current.indexOf(anchor)
    if (position >= 0 && previous.slice(0, snapshot.index).includes(anchor)) {
      const offset = position + anchor.length
      return `${current.slice(0, offset)}\n\n${snapshot[0]}${current.slice(offset)}`
    }
  }
  return `${current}\n\n${snapshot[0]}`
}

export function extractHumanQuery(message: LLMMessage): string | undefined {
  if (message.role !== 'user')
    return undefined
  if (Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))
    return undefined
  const content = extractPlainTextContent(message)
  const opening = '<user_query>\n'
  const closing = '\n</user_query>'
  const start = content.indexOf(opening)
  if (start < 0 || !content.endsWith(closing) || content.indexOf(opening, start + opening.length) >= 0)
    return undefined
  return content.slice(start + opening.length, -closing.length)
}

function syncConversationScaffold(messages: LLMMessage[], systemMessage: LLMMessage, preambleUserMessage: LLMMessage): { messages: LLMMessage[], systemReplaced: boolean, preambleReplaced: boolean } {
  const next = [...messages]
  let systemReplaced = false
  let preambleReplaced = false

  const systemIndex = next.findIndex(message => message.role === 'system')
  if (systemIndex >= 0 && next[systemIndex]?.content !== systemMessage.content) {
    next[systemIndex] = systemMessage
    systemReplaced = true
  }

  const preambleIndex = next.findIndex(isPreambleUserMessage)
  if (preambleIndex >= 0) {
    const previous = next[preambleIndex]!
    const content = typeof previous.content === 'string' && typeof preambleUserMessage.content === 'string'
      ? preserveLegacyIdeState(previous.content, preambleUserMessage.content)
      : preambleUserMessage.content
    if (previous.content !== content) {
      next[preambleIndex] = { ...preambleUserMessage, content }
      preambleReplaced = true
    }
  }

  return { messages: next, systemReplaced, preambleReplaced }
}

export function mergePrependUserMessages(
  messages: LLMMessage[],
  prependUserMessages: Array<{ text: string, messageId?: string }>,
): { messages: LLMMessage[], insertedTexts: string[] } {
  if (prependUserMessages.length === 0)
    return { messages, insertedTexts: [] }

  const existingUserTexts = new Set(
    messages
      .filter(message => message.role === 'user')
      .flatMap(extractComparableUserTexts)
      .filter(text => text.length > 0),
  )

  const missing = prependUserMessages
    .map(entry => entry.text)
    .filter(text => text.length > 0 && !existingUserTexts.has(text))

  if (missing.length === 0) {
    logger.info({ prependCount: prependUserMessages.length }, '[SESSION] prepend user messages already satisfied by history')
    return { messages, insertedTexts: [] }
  }

  const insertAt = messages.findIndex(message => message.role !== 'system' && !isPreambleUserMessage(message))
  const prefix = missing.map(text => ({ role: 'user' as const, content: text }))

  logger.info({
    prependCount: prependUserMessages.length,
    missingCount: missing.length,
    firstMissing: missing[0],
  }, '[SESSION] merging prepend user messages into history')

  if (insertAt === -1)
    return { messages: [...messages, ...prefix], insertedTexts: missing }
  return {
    messages: [...messages.slice(0, insertAt), ...prefix, ...messages.slice(insertAt)],
    insertedTexts: missing,
  }
}

export function isSummaryBlobMessage(raw: Record<string, unknown>): boolean {
  const providerOptions = raw.providerOptions
  if (!isRecord(providerOptions))
    return false
  const cursor = providerOptions.cursor
  return isRecord(cursor) && cursor.isSummary === true
}

export function hydrateHistoryEntries(blobIds: string[]): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const blobId of blobIds) {
    const blobData = getCachedBlob(blobId)
    if (!blobData)
      continue
    try {
      const decoded = decodeBlob(blobData)
      if (!isRecord(decoded))
        continue
      const restored = restoreBlobMessageToLLMMessage(decoded)
      if (!restored)
        continue
      entries.push({ blobId, raw: decoded, message: restored })
    }
    catch (error) {
      logger.warn({ blobId, error: (error as Error).message }, '[SESSION] failed to hydrate history entry')
    }
  }
  return entries
}

export function materializeHistoryEntries(messages: LLMMessage[]): HistoryEntry[] {
  return messages.map((message) => {
    const normalized = normalizeBlobMessage({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    })
    const blob = encodeBlob(normalized)
    cacheBlob(blob.blobId, blob.blobData)
    return {
      blobId: blob.blobId,
      raw: normalized as unknown as Record<string, unknown>,
      message,
    }
  })
}

function logHistoryRepair(stage: string, diagnostics: RepairDiagnostics, extra: Record<string, unknown> = {}): void {
  if (!hasRepairMutations(diagnostics))
    return
  logger.debug({
    stage,
    ...extra,
    ...diagnostics,
  }, '[HISTORY_REPAIR] canonicalized conversation history')
}

export function repairHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const diagnostics = createRepairDiagnostics(entries.length)
  const repaired = repairConversationHistory(entries.map(entry => entry.message), diagnostics)
  logHistoryRepair('repairHistoryEntries', diagnostics, {
    entryCount: entries.length,
    inputBlobIds: entries.length,
  })
  return materializeHistoryEntries(repaired)
}

export function* rebuildConversationHistory(params: {
  historyBlobIds: string[]
  prependUserMessages: Array<{ text: string, messageId?: string }>
  systemMessage: LLMMessage
  preambleUserMessage: LLMMessage
  currentUserMessage: LLMMessage
  isResume?: boolean
  resumeUserText?: string
  systemContent: string
  preambleUserContent: string
  sendSystemScaffoldBlob: (data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean }) => Generator<AgentServerMessage, void, void>
  sendOrderedBlob: (data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean }) => Generator<AgentServerMessage, void, void>
}): Generator<AgentServerMessage, { messages: LLMMessage[], insertedPrependUserTexts: string[], currentUserAppended: boolean }, void> {
  let messages: LLMMessage[] = []
  let insertedPrependUserTexts: string[] = []
  let currentUserAppended = true

  if (params.historyBlobIds.length > 0) {
    const historyEntries = hydrateHistoryEntries(params.historyBlobIds)
    if (params.isResume) {
      if (historyEntries.length !== params.historyBlobIds.length)
        throw new Error('resume_history_missing: history contains missing or invalid blobs')
      const humanMessages = historyEntries.map(entry => entry.message)
        .filter(message => extractHumanQuery(message) !== undefined)
      const lastHuman = humanMessages.at(-1)
      if (!lastHuman)
        throw new Error('resume_user_missing: cannot identify the original human query')
      if (params.resumeUserText !== undefined && extractHumanQuery(lastHuman) !== params.resumeUserText)
        throw new Error('resume_turn_mismatch: binary turn does not match the last human query')
      if (humanMessages.filter(message => extractHumanQuery(message) === extractHumanQuery(lastHuman)).length > 1)
        throw new Error('resume_turn_ambiguous: repeated query cannot be matched to a unique turn')
      currentUserAppended = false
    }
    logger.info({
      requestedBlobs: params.historyBlobIds.length,
      resolvedBlobs: historyEntries.length,
      prependUserMessages: params.prependUserMessages.length,
    }, '[SESSION] history blobs from cache')

    messages = historyEntries.map(entry => entry.message)

    const scaffoldSynced = syncConversationScaffold(messages, params.systemMessage, params.preambleUserMessage)
    messages = scaffoldSynced.messages
    if (scaffoldSynced.systemReplaced || scaffoldSynced.preambleReplaced) {
      logger.debug({
        systemReplaced: scaffoldSynced.systemReplaced,
        preambleReplaced: scaffoldSynced.preambleReplaced,
      }, '[HISTORY_REPAIR] replaced provider-specific scaffold in restored history')
    }

    if (!hasSystemMessage(messages)) {
      messages.unshift(params.systemMessage)
      yield* params.sendSystemScaffoldBlob({ role: 'system', content: params.systemContent })
    }

    if (!hasPreambleUserMessage(messages)) {
      const insertAt = messages.findIndex(message => message.role !== 'system')
      if (insertAt === -1)
        messages.push(params.preambleUserMessage)
      else messages.splice(insertAt, 0, params.preambleUserMessage)
      yield* params.sendOrderedBlob({ role: 'user', content: params.preambleUserContent })
    }

    ({ messages, insertedTexts: insertedPrependUserTexts } = mergePrependUserMessages(messages, params.prependUserMessages))
  }
  else {
    messages.push(params.systemMessage)
    yield* params.sendSystemScaffoldBlob({ role: 'system', content: params.systemContent })

    messages.push(params.preambleUserMessage)
    yield* params.sendOrderedBlob({ role: 'user', content: params.preambleUserContent });

    ({ messages, insertedTexts: insertedPrependUserTexts } = mergePrependUserMessages(messages, params.prependUserMessages))
  }

  if (currentUserAppended) {
    if (params.isResume && !extractHumanQuery(params.currentUserMessage)?.trim())
      throw new Error('resume_user_missing: resubmit the original question to start a new turn')
    messages.push(params.currentUserMessage)
  }

  const diagnostics = createRepairDiagnostics(messages.length)
  const repaired = repairConversationHistory(messages, diagnostics)
  logHistoryRepair('rebuildConversationHistory', diagnostics, {
    historyBlobIds: params.historyBlobIds.length,
    insertedPrependUserTexts: insertedPrependUserTexts.length,
  })

  return {
    messages: repaired,
    insertedPrependUserTexts,
    currentUserAppended,
  }
}
