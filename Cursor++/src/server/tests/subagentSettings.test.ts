import type { ProviderType } from '../data/defaults'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { getSubagentConfig, saveSubagentConfig } from '../config/subagentModelStore'
import { SubagentArgsSchema } from '../gen/agent_v1_pb'
import { parseRunRequest } from '../handlers/agent/protocol/parseRunRequest'
import { resolveConfiguredSubagent } from '../handlers/agent/subagentModelSelection'
import { buildExecArgs } from '../handlers/agent/tools'
import { resetProviderInstanceCache, resolveProviderRuntime } from '../handlers/llm/providerRuntime'

const configuration = vi.hoisted(() => ({ path: '' }))
const sdkRequests = vi.hoisted(() => ({ requests: [] as Array<Record<string, any>> }))
vi.mock('openai', () => ({
  default: class {
    responses = {
      async create(parameters: Record<string, unknown>) {
        sdkRequests.requests.push(parameters)
        return (async function* () {})()
      },
    }
  },
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream(parameters: Record<string, unknown>) {
        sdkRequests.requests.push(parameters)
        return Object.assign((async function* () {})(), {
          finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'end_turn' }),
        })
      },
    }

    beta = { messages: this.messages }
  },
}))
vi.mock('@google/genai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/genai')>()
  return {
    ...original,
    GoogleGenAI: class {
      models = {
        async generateContentStream(parameters: Record<string, unknown>) {
          sdkRequests.requests.push(parameters)
          return (async function* () {})()
        },
      }
    },
  }
})
vi.mock('../config/knowledgeBaseStore', () => ({ listKnowledgeItems: () => [] }))
vi.mock('../config/paths', async importOriginal => ({
  ...await importOriginal<typeof import('../config/paths')>(),
  getSubagentConfigFilePath: () => configuration.path,
}))

let temporaryDirectory: string
beforeEach(() => {
  sdkRequests.requests = []
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'subagent-settings-'))
  configuration.path = join(temporaryDirectory, 'subagents.json')
  resetProviderInstanceCache()
  setProvidersForTests({
    $schemaVersion: 1,
    providers: (['openai-responses', 'anthropic', 'gemini'] as ProviderType[]).map(providerType => ({
      id: providerType,
      name: providerType,
      type: providerType,
      baseUrl: 'https://example.invalid',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [{
        id: providerType,
        apiModel: `api-${providerType}`,
        displayName: providerType,
        thinking: false,
        thinkingLevel: 'medium',
        fastMode: true,
        contextTokenLimit: 128000,
        parameters: { ...(providerType.startsWith('openai') ? { reasoning: ['medium', 'high'] as const } : { effort: ['medium', 'high'] as const }), fast: true, context: [128000, 256000] },
      }],
    })),
  })
})
afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true })
  resetProviderInstanceCache()
})

describe('subagent selection contracts', () => {
  it('distinguishes missing, deleted-model and damaged configuration', async () => {
    expect(getSubagentConfig()).toEqual({ schemaVersion: 1 })
    writeFileSync(configuration.path, JSON.stringify({ schemaVersion: 1, default: { modelId: 'deleted' } }))
    expect(getSubagentConfig().default?.modelId).toBe('deleted')
    expect(() => resolveConfiguredSubagent('explore', undefined)).toThrow('Unknown subagent model')
    await expect(saveSubagentConfig(getSubagentConfig())).rejects.toThrow('Unknown subagent model')
    writeFileSync(configuration.path, '{')
    expect(() => getSubagentConfig()).toThrow('Invalid subagent settings')
    expect(resolveConfiguredSubagent('custom', undefined)).toBeUndefined()
    expect(resolveConfiguredSubagent('explore', 'existing')).toBeUndefined()
  })

  it.each([
    { modelId: '' },
    { modelId: 'missing' },
    { modelId: 'openai-responses', fast: 'false' },
    { modelId: 'openai-responses', reasoningEffort: 'max' },
    { modelId: 'openai-responses', contextTokenLimit: 123 },
    { modelId: 'openai-responses', unknown: true },
  ])('does not overwrite valid settings on invalid input: %j', async (selection) => {
    await saveSubagentConfig({ schemaVersion: 1 })
    await expect(saveSubagentConfig({ schemaVersion: 1, default: selection })).rejects.toThrow()
    expect(getSubagentConfig()).toEqual({ schemaVersion: 1 })
  })

  it('uses whole selections and leaves normal resume, custom types and native defaults unchanged', async () => {
    expect(buildExecArgs('Task', { prompt: 'Inspect' }, 'call', { currentModelId: 'native' }).modelId).toBe('native')
    await saveSubagentConfig({ schemaVersion: 1, default: { modelId: 'openai-responses', reasoningEffort: 'high', fast: false }, overrides: { shell: { modelId: 'anthropic' } } })
    expect(resolveConfiguredSubagent('shell', undefined)).toEqual({ modelId: 'anthropic', modelParameters: [] })
    expect(resolveConfiguredSubagent('shell', 'self')?.modelId).toBe('anthropic')
    expect(resolveConfiguredSubagent('shell', 'existing')).toBeUndefined()
    expect(resolveConfiguredSubagent('custom', undefined)).toBeUndefined()
  })

  it.each(['openai-responses', 'anthropic', 'gemini'])('passes %s parameters through binary schema, child parsing and provider preparation', async (modelId) => {
    await saveSubagentConfig({ schemaVersion: 1, default: { modelId, reasoningEffort: 'high', fast: false, contextTokenLimit: 256000 } })
    const args = buildExecArgs('Task', { prompt: 'Inspect', model: 'untrusted', modelId: 'untrusted', modelParameters: [] }, 'call', { currentModelId: 'native' })
    const decoded = fromBinary(SubagentArgsSchema, toBinary(SubagentArgsSchema, create(SubagentArgsSchema, args as never)))
    const serialized = toJson(SubagentArgsSchema, decoded) as Record<string, any>
    const child = parseRunRequest({ runRequest: {
      requestedModel: { modelId: serialized.modelId, parameters: serialized.modelParameters },
      subagentTypeName: 'explore',
      action: { userMessageAction: { userMessage: { text: 'Inspect' } } },
    } })
    expect(child.clientThinking).toBe(true)
    expect(child.clientThinkingLevel).toBe('high')
    expect(child.clientFast).toBe(false)
    expect(child.contextTokenLimit).toBe(256000)
    const runtime = resolveProviderRuntime(child.modelId)
    const prepared = runtime.prepareStreamRequest([{ role: 'user', content: 'Inspect' }], [], undefined, 'agent', { thinking: child.clientThinking, level: child.clientThinkingLevel }, 'child', true, child.clientFast, undefined, child.contextTokenLimit)
    expect(prepared.request.model).toBe(`api-${modelId}`)
    expect(prepared.request.thinkingLevel).toBe('high')
    expect(prepared.request.serviceTier).toBeUndefined()
    expect(prepared.request.anthropicBetas?.some(beta => beta.startsWith('fast-mode')) ?? false).toBe(false)
    expect(runtime.prepareStreamRequest([], []).request.thinkingLevel).toBe('medium')
    for await (const event of runtime.provider.stream(prepared.request))
      void event
    const payload = sdkRequests.requests[0]
    expect(payload.model).toBe(`api-${modelId}`)
    if (modelId === 'openai-responses') {
      expect(payload.reasoning.effort).toBe('high')
      expect(payload).not.toHaveProperty('service_tier')
      expect(payload.prompt_cache_key).toBe('child')
    }
    else if (modelId === 'anthropic') {
      expect(payload.output_config.effort).toBe('high')
      expect(payload.thinking.type).toBe('adaptive')
      expect(payload.betas.some((beta: string) => beta.startsWith('fast-mode'))).toBe(false)
    }
    else {
      expect(payload.config.thinkingConfig.thinkingLevel).toBe('HIGH')
    }
  })

  it('serializes concurrent saves without partial files', async () => {
    await Promise.all(['openai-responses', 'anthropic'].map(modelId => saveSubagentConfig({ schemaVersion: 1, default: { modelId } })))
    expect(getSubagentConfig()).toEqual({ schemaVersion: 1, default: { modelId: 'anthropic' } })
  })
})
