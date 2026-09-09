import type { SubagentConfig, SubagentSelection } from '../../shared/subagentConfig'
import { readFileSync } from 'node:fs'
import { parseSubagentConfig, parseSubagentSelection } from '../../shared/subagentConfig'
import { withSerial, writeJsonAtomic } from './atomic'
import { getSubagentConfigFilePath } from './paths'
import { lookupModel } from './providersStore'

export function getSubagentConfig(): SubagentConfig {
  let content: string
  try {
    content = readFileSync(getSubagentConfigFilePath(), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1 }
    throw new Error(`Cannot read subagent settings: ${(error as Error).message}`)
  }
  try {
    return parseSubagentConfig(JSON.parse(content))
  }
  catch (error) {
    throw new Error(`Invalid subagent settings: ${(error as Error).message}`)
  }
}

export function validateSubagentSelection(value: unknown): SubagentSelection {
  const selection = parseSubagentSelection(value)
  const resolved = lookupModel(selection.modelId)
  if (!resolved)
    throw new Error(`Unknown subagent model: ${selection.modelId}`)
  const parameters = resolved.model.parameters
  const effortOptions = resolved.provider.type.startsWith('openai')
    ? parameters?.reasoning
    : parameters?.effort
  if (selection.reasoningEffort !== undefined && !effortOptions?.includes(selection.reasoningEffort))
    throw new Error(`Model ${selection.modelId} does not offer effort ${selection.reasoningEffort}`)
  if (selection.fast !== undefined && parameters?.fast !== true)
    throw new Error(`Model ${selection.modelId} does not offer Fast`)
  if (selection.contextTokenLimit !== undefined && !parameters?.context?.includes(selection.contextTokenLimit))
    throw new Error(`Model ${selection.modelId} does not offer context ${selection.contextTokenLimit}`)
  return selection
}

export async function saveSubagentConfig(value: unknown): Promise<SubagentConfig> {
  const config = parseSubagentConfig(value)
  const configurationPath = getSubagentConfigFilePath()
  return withSerial(configurationPath, () => {
    if (config.default)
      validateSubagentSelection(config.default)
    for (const selection of Object.values(config.overrides ?? {}))
      validateSubagentSelection(selection)
    writeJsonAtomic(configurationPath, config)
    return config
  })
}
