/** Physical-row virtualization inputs for scrolling terminal panels. */

import { describe, expect, it } from 'vitest'
import { visibleColumns } from '../src/render/markdown.ts'
import { styledLines, lineSegment, transcriptEntryLines } from '../src/render/lines.ts'
import type { TranscriptEntry } from '../src/render/projection.ts'

const textOf = (lines: ReturnType<typeof styledLines>): string => lines
  .map(line => line.segments.map(segment => segment.text).join(''))
  .join('\n')

describe('styled terminal lines', () => {
  it('hard-wraps CJK, long words, tabs, and controls within the column budget', () => {
    const lines = styledLines([lineSegment('甲乙 verylongword\t\x1b[31m')], 6)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) {
      expect(visibleColumns(line.segments.map(segment => segment.text).join(''))).toBeLessThanOrEqual(6)
    }
    expect(textOf(lines)).toContain('\\x1b')
    expect(textOf(lines)).not.toContain('\x1b')
  })

  it('keeps every retained assistant line available to the scrolling caller', () => {
    const reasoning = Array.from({ length: 80 }, (_, index) => `reason-${index}`).join('\n')
    const answer = Array.from({ length: 80 }, (_, index) => `answer-${index}`).join('\n')
    const entry: TranscriptEntry = { kind: 'assistant', reasoning, text: answer }
    const lines = transcriptEntryLines(entry, 40)
    const text = textOf(lines)
    expect(lines.length).toBeGreaterThanOrEqual(100)
    expect(text).toContain('reason-0')
    expect(text).toContain('reason-79')
    expect(text).toContain('answer-0')
    expect(text).toContain('answer-79')
  })

  it('keeps markdown paragraph separators as one physical scroll row', () => {
    const entry: TranscriptEntry = { kind: 'assistant', reasoning: '', text: 'first\n\nsecond' }
    const lines = transcriptEntryLines(entry, 40)
    expect(lines).toHaveLength(3)
    // The blank separator row keeps only the two-column reply gutter.
    expect(lines[1]?.segments).toEqual([{ text: '  ', style: 'plain' }])
  })

  it('aligns every assistant reply row with the two-column composer gutter', () => {
    const entry: TranscriptEntry = { kind: 'assistant', reasoning: '', text: 'first\nsecond' }
    const lines = transcriptEntryLines(entry, 40)
    for (const line of lines) {
      expect(line.segments[0]).toEqual({ text: '  ', style: 'plain' })
    }
  })

  it('does not impose the old forty-row display cap on retained raw tool output', () => {
    const raw = Array.from({ length: 60 }, (_, index) => `tool-${index}`).join('\n')
    const entry: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      name: 'shell_command',
      arguments: '{}',
      preview: '',
      state: 'done',
      summary: 'done',
      detail: { kind: 'raw', text: raw, truncated: false },
    }
    const text = textOf(transcriptEntryLines(entry, 40))
    expect(text).toContain('tool-0')
    expect(text).toContain('tool-59')
  })

  it('sanitizes live tool and command names before physical-row rendering', () => {
    const tool: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      name: 'evil\x1b]0;pwned\x07fetch',
      arguments: '{}',
      preview: '',
      state: 'running',
      summary: '',
      detail: undefined,
    }
    const command: TranscriptEntry = {
      kind: 'command',
      commandId: 'command',
      name: 'wipe\x1b[2J',
      args: '',
      state: 'running',
      summary: '',
    }
    const rendered = `${textOf(transcriptEntryLines(tool, 80))}\n${textOf(transcriptEntryLines(command, 80))}`
    expect(rendered).toContain('evil\\x1b]0;pwned\\x07fetch')
    expect(rendered).toContain('/wipe\\x1b[2J')
    expect(rendered).not.toContain('\x1b]0;')
    expect(rendered).not.toContain('\x1b[2J')
  })
})
