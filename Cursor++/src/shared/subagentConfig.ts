export const subagentTypes = ['explore', 'generalPurpose', 'shell'] as const
export type SubagentType = typeof subagentTypes[number]
export const reasoningEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

export interface SubagentSelection {
  modelId: string
  reasoningEffort?: ReasoningEffort
  fast?: boolean
  contextTokenLimit?: number
}

export interface SubagentConfig {
  schemaVersion: 1
  default?: SubagentSelection
  overrides?: Partial<Record<SubagentType, SubagentSelection>>
}

function requireRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  for (const field of Object.keys(value)) {
    if (!fields.includes(field))
      throw new Error(`${label}: unknown field ${field}`)
  }
  return value as Record<string, unknown>
}

export function parseSubagentSelection(value: unknown): SubagentSelection {
  const record = requireRecord(value, ['modelId', 'reasoningEffort', 'fast', 'contextTokenLimit'], 'selection')
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  if (!modelId)
    throw new Error('Select a model')
  const selection: SubagentSelection = { modelId }
  if (record.reasoningEffort !== undefined) {
    if (!reasoningEfforts.includes(record.reasoningEffort as ReasoningEffort))
      throw new Error('Unsupported reasoning effort')
    selection.reasoningEffort = record.reasoningEffort as ReasoningEffort
  }
  if (record.fast !== undefined) {
    if (typeof record.fast !== 'boolean')
      throw new Error('Fast must be a boolean')
    selection.fast = record.fast
  }
  if (record.contextTokenLimit !== undefined) {
    if (typeof record.contextTokenLimit !== 'number'
      || !Number.isSafeInteger(record.contextTokenLimit) || record.contextTokenLimit <= 0) {
      throw new Error('Context must be a positive safe integer')
    }
    selection.contextTokenLimit = record.contextTokenLimit
  }
  return selection
}

export function parseSubagentConfig(value: unknown): SubagentConfig {
  const record = requireRecord(value, ['schemaVersion', 'default', 'overrides'], 'config')
  if (record.schemaVersion !== 1)
    throw new Error('Unsupported subagent config version')
  const config: SubagentConfig = { schemaVersion: 1 }
  if (record.default !== undefined)
    config.default = parseSubagentSelection(record.default)
  if (record.overrides !== undefined) {
    const rawOverrides = requireRecord(record.overrides, subagentTypes, 'overrides')
    const overrides: Partial<Record<SubagentType, SubagentSelection>> = {}
    for (const subagentType of subagentTypes) {
      if (rawOverrides[subagentType] !== undefined)
        overrides[subagentType] = parseSubagentSelection(rawOverrides[subagentType])
    }
    if (Object.keys(overrides).length > 0)
      config.overrides = overrides
  }
  return config
}
