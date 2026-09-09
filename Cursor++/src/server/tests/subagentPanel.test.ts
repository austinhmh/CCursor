import { describe, expect, it } from 'vitest'
import { createSubagentEditor } from '../../ui/webview/subagents'

function createEditor() {
  const sent: Array<any> = []
  const editor = createSubagentEditor(message => sent.push(message))
  editor.load()
  editor.receive({ requestId: sent.at(-1).requestId, ok: true, config: { schemaVersion: 1 } })
  return { editor, sent }
}

describe('subagent panel', () => {
  it('shows effective inherited parameters without copying defaults', () => {
    const { editor } = createEditor()
    editor.providers = ['first', 'second'].map(identifier => ({
      id: identifier,
      name: identifier,
      type: 'openai-responses',
      baseUrl: '',
      auth: { kind: 'apiKey', value: '' },
      models: [{ id: `${identifier}-internal`, apiModel: 'same-api', displayName: 'Model', thinking: false }],
    }))
    expect(editor.models().map(option => option.label)).toEqual(['first / Model', 'second / Model'])
    editor.setModel('default', 'first-internal')
    editor.setParameter('default', 'reasoningEffort', 'high')
    editor.setParameter('default', 'fast', 'false')
    editor.setParameter('default', 'contextTokenLimit', '256000')
    expect(editor.own('shell')).toBeUndefined()
    expect(editor.summary('shell')).toBe('first / Model / Reasoning: high / Fast: Off / Context: 256000')
    editor.setModel('shell', 'second-internal')
    expect(editor.own('shell')).toEqual({ modelId: 'second-internal' })
    editor.setModel('shell', '')
    expect(editor.summary('shell')).toContain('Fast: Off')
    editor.setModel('default', 'deleted')
    expect(editor.summary('shell')).toContain('Missing model: deleted')
    expect(editor.own('default')).toEqual({ modelId: 'deleted' })
  })

  it('requires a matching save ACK and preserves the failed draft', () => {
    const { editor, sent } = createEditor()
    editor.setModel('default', 'model')
    for (const value of ['true', 'false', '']) {
      editor.setParameter('default', 'fast', value)
      expect(editor.own('default')?.fast).toBe(value ? value === 'true' : undefined)
    }
    editor.save()
    editor.setModel('default', 'blocked')
    expect(editor.own('default')?.modelId).toBe('model')
    editor.receive({ requestId: 'wrong', ok: true, config: { schemaVersion: 1 } })
    expect(editor.busy).toBe(true)
    editor.receive({ requestId: sent.at(-1).requestId, ok: false, error: 'Write failed' })
    expect(editor.committed).toEqual({ schemaVersion: 1 })
    expect(editor.dirty()).toBe(true)
    editor.save()
    editor.receive({ requestId: sent.at(-1).requestId, ok: true, config: sent.at(-1).config })
    expect(editor.saved).toBe(true)
    expect(editor.dirty()).toBe(false)
    editor.setModel('default', 'other')
    editor.cancel()
    expect(editor.own('default')?.modelId).toBe('model')
  })

  it('does not manufacture saved settings from a corrupt load', () => {
    const editor = createSubagentEditor(() => {})
    editor.load()
    editor.receive({ requestId: editor.pendingRequestId, ok: false, error: 'Invalid JSON' })
    expect(editor.committed).toBeNull()
    expect(editor.busy).toBe(false)
    editor.setModel('default', 'blocked')
    expect(editor.own('default')).toBeUndefined()
  })
})
