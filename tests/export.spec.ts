/** Markdown export of the transcript view. */

import { describe, expect, it } from 'vitest'
import { createTranscriptView } from '../src/render/projection.ts'
import { buildExportMarkdown } from '../src/render/export.ts'

describe('buildExportMarkdown', () => {
  it('renders an empty session with a header and a footer', () => {
    const markdown = buildExportMarkdown(createTranscriptView(), 'session-x')
    expect(markdown).toContain('# dsh session session-x')
    expect(markdown).toContain('> session session-x')
    expect(markdown).toContain('- turns: 0 · steps: 0')
  })

  it('renders user, assistant, tool, and marker entries in order', () => {
    const view = createTranscriptView()
    const composed = {
      ...view,
      model: 'p/m',
      entries: [
        { kind: 'user', text: 'fix it', notice: false },
        { kind: 'assistant', text: 'doing it', reasoning: 'hmm' },
        { kind: 'tool', callId: 'c1', ordinal: 1, name: 'edit', arguments: '{}', preview: 'a.ts', prompt: '', state: 'done', summary: 'Updated file', detail: undefined },
        { kind: 'turn-marker', text: 'turn cancelled by the user' },
        { kind: 'error', text: 'X: boom' },
      ] as const,
    }
    const markdown = buildExportMarkdown(composed, 'session-x')
    expect(markdown.indexOf('## user')).toBeLessThan(markdown.indexOf('## assistant'))
    expect(markdown).toContain('doing it')
    expect(markdown).toContain('<details><summary>thinking</summary>')
    expect(markdown).toContain('### tool \`edit\`')
    expect(markdown).toContain('- result: Updated file')
    expect(markdown).toContain('> turn cancelled by the user')
    expect(markdown).toContain('> ⨯ X: boom')
    expect(markdown).toContain('- model: p/m')
  })

  it('collapses injected context rows to quoted notices', () => {
    const view = { ...createTranscriptView(), entries: [{ kind: 'user', text: 'files changed', notice: true }] } as const
    expect(buildExportMarkdown(view, 's')).toContain('> ⤷ context: files changed')
  })
})
