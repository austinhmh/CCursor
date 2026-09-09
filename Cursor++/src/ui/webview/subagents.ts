import type { ProviderEntry } from '../../server/data/defaults'
import type { ReasoningEffort, SubagentConfig, SubagentSelection, SubagentType } from '../../shared/subagentConfig'
import { parseSubagentConfig, subagentTypes } from '../../shared/subagentConfig'

export type SubagentRow = 'default' | SubagentType

export function createSubagentEditor(postMessage: (message: unknown) => void) {
  return {
    rows: ['default', ...subagentTypes] as SubagentRow[],
    providers: [] as ProviderEntry[],
    committed: null as SubagentConfig | null,
    draft: { schemaVersion: 1 } as SubagentConfig,
    busy: false,
    saved: false,
    error: '',
    pendingRequestId: '',
    operation: '' as '' | 'load' | 'save',

    load() {
      if (!this.busy && !this.dirty())
        this.send('load')
    },
    send(operation: 'load' | 'save') {
      this.pendingRequestId = crypto.randomUUID()
      this.operation = operation
      this.busy = true
      this.saved = false
      this.error = ''
      postMessage({
        type: operation === 'load' ? 'getSubagentConfig' : 'saveSubagentConfig',
        requestId: this.pendingRequestId,
        ...(operation === 'save' ? { config: parseSubagentConfig(this.draft) } : {}),
      })
    },
    receive(message: { requestId?: string, ok: boolean, config?: unknown, error?: string }) {
      if (!this.pendingRequestId || message.requestId !== this.pendingRequestId)
        return
      const operation = this.operation
      this.pendingRequestId = ''
      this.operation = ''
      this.busy = false
      if (!message.ok) {
        this.error = message.error || 'Subagent settings request failed'
        return
      }
      try {
        this.committed = parseSubagentConfig(message.config)
        this.draft = parseSubagentConfig(this.committed)
        this.saved = operation === 'save'
      }
      catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },
    own(row: SubagentRow): SubagentSelection | undefined {
      return row === 'default' ? this.draft.default : this.draft.overrides?.[row]
    },
    effective(row: SubagentRow): SubagentSelection | undefined {
      return this.own(row) ?? (row === 'default' ? undefined : this.draft.default)
    },
    models() {
      return this.providers.flatMap(provider => provider.models.map(model => ({
        id: model.id,
        label: `${provider.name} / ${model.displayName || model.apiModel}`,
        providerType: provider.type,
        model,
      })))
    },
    selected(row: SubagentRow) {
      return this.models().find(option => option.id === this.effective(row)?.modelId)
    },
    efforts(row: SubagentRow) {
      const selected = this.selected(row)
      return selected?.providerType.startsWith('openai')
        ? selected.model.parameters?.reasoning ?? []
        : selected?.model.parameters?.effort ?? []
    },
    contexts(row: SubagentRow) {
      return this.selected(row)?.model.parameters?.context ?? []
    },
    summary(row: SubagentRow): string {
      const selection = this.effective(row)
      if (!selection)
        return 'Existing Cursor behavior'
      const selected = this.selected(row)
      const model = selected?.model
      const fast = selection.fast ?? model?.fastMode
      return [
        selected?.label ?? `Missing model: ${selection.modelId}`,
        `Reasoning: ${selection.reasoningEffort ?? model?.thinkingLevel ?? 'model default'}`,
        `Fast: ${fast === undefined ? 'model default' : fast ? 'On' : 'Off'}`,
        `Context: ${selection.contextTokenLimit ?? model?.contextTokenLimit ?? 'model default'}`,
      ].join(' / ')
    },
    setModel(row: SubagentRow, modelId: string) {
      if (this.busy || !this.committed)
        return
      const selection = modelId ? { modelId } : undefined
      if (row === 'default') {
        if (selection)
          this.draft.default = selection
        else
          delete this.draft.default
      }
      else {
        this.draft.overrides ??= {}
        if (selection)
          this.draft.overrides[row] = selection
        else
          delete this.draft.overrides[row]
        if (Object.keys(this.draft.overrides).length === 0)
          delete this.draft.overrides
      }
      this.saved = false
      this.error = ''
    },
    setParameter(row: SubagentRow, field: 'reasoningEffort' | 'fast' | 'contextTokenLimit', value: string) {
      if (this.busy || !this.committed)
        return
      const selection = this.own(row)
      if (!selection)
        return
      if (!value)
        delete selection[field]
      else if (field === 'fast')
        selection.fast = value === 'true'
      else if (field === 'contextTokenLimit')
        selection.contextTokenLimit = Number(value)
      else
        selection.reasoningEffort = value as ReasoningEffort
      this.saved = false
      this.error = ''
    },
    dirty(): boolean {
      return this.committed !== null && JSON.stringify(this.draft) !== JSON.stringify(this.committed)
    },
    save() {
      if (this.busy || !this.dirty())
        return
      try {
        parseSubagentConfig(this.draft)
        this.send('save')
      }
      catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },
    cancel() {
      if (this.busy || !this.committed)
        return
      this.draft = parseSubagentConfig(this.committed)
      this.saved = false
      this.error = ''
    },
  }
}
