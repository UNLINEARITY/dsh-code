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

  it('heads the export with the effective system prompt in a collapsed block', () => {
    const view = {
      ...createTranscriptView(),
      systemPrompt: 'You are a coding agent.',
      entries: [{ kind: 'user', text: 'fix it', notice: false }] as const,
    }
    const markdown = buildExportMarkdown(view, 'session-x')
    // The block sits between the session header and the first entry.
    expect(markdown.indexOf('> session session-x')).toBeLessThan(markdown.indexOf('<details><summary>system prompt</summary>'))
    expect(markdown.indexOf('<details><summary>system prompt</summary>')).toBeLessThan(markdown.indexOf('## user'))
    expect(markdown).toContain('You are a coding agent.')
    // An empty prompt never grows the block.
    expect(buildExportMarkdown(createTranscriptView(), 'session-x')).not.toContain('system prompt</summary>')
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

  it('exports bounded image metadata without attachment ids', () => {
    const view = {
      ...createTranscriptView(),
      entries: [{
        kind: 'user', text: 'inspect', notice: false,
        images: [{ attachmentId: 'secret-ref', mediaType: 'image/png', bytes: 42, width: 2, height: 3, name: 'plot.png', originalDimensions: { width: 8, height: 12 } }],
      }],
    } as unknown as ReturnType<typeof createTranscriptView>
    const markdown = buildExportMarkdown(view, 's')
    expect(markdown).toContain('[image: plot.png · 2×3 · original 8×12 · 42 B]')
    expect(markdown).not.toContain('secret-ref')
  })
})
