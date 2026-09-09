import type { SubagentType } from '../../../shared/subagentConfig'
import { subagentTypes } from '../../../shared/subagentConfig'
import { getSubagentConfig, validateSubagentSelection } from '../../config/subagentModelStore'
import { lookupModel } from '../../config/providersStore'

export interface ConfiguredSubagentLaunch {
  modelId: string
  modelParameters: Array<{ id: string, value: string }>
}

export function resolveConfiguredSubagent(subagentType: string, resume: unknown): ConfiguredSubagentLaunch | undefined {
  if (!subagentTypes.includes(subagentType as SubagentType))
    return undefined
  if (typeof resume === 'string' && resume.trim() && resume.trim().toLowerCase() !== 'self')
    return undefined
  const config = getSubagentConfig()
  const configured = config.overrides?.[subagentType as SubagentType] ?? config.default
  if (!configured)
    return undefined
  const selection = validateSubagentSelection(configured)
  const resolved = lookupModel(selection.modelId)!
  const modelParameters: ConfiguredSubagentLaunch['modelParameters'] = []
  if (selection.reasoningEffort !== undefined) {
    modelParameters.push({
      id: resolved.provider.type.startsWith('openai') ? 'reasoning' : 'effort',
      value: selection.reasoningEffort,
    })
  }
  if (selection.fast !== undefined)
    modelParameters.push({ id: 'fast', value: String(selection.fast) })
  if (selection.contextTokenLimit !== undefined)
    modelParameters.push({ id: 'context', value: String(selection.contextTokenLimit) })
  return { modelId: selection.modelId, modelParameters }
}
