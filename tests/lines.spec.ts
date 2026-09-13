/** Physical-row virtualization inputs for scrolling terminal panels. */

import { describe, expect, it } from 'vitest'
import { visibleColumns } from '../src/render/markdown.ts'
import { stringWidth } from '../src/render/width.ts'
import { clampLiveAllocation, diffLineStyle, fillDiffLineBars, markdownLines, settledEntryLines, styledLines, lineSegment, reasoningLines, transcriptEntryLines, userPromptSegments } from '../src/render/lines.ts'
import type { TranscriptEntry } from '../src/render/projection.ts'
import type { StyledLine } from '../src/render/lines.ts'

const textOf = (lines: ReturnType<typeof styledLines>): string => lines
  .map(line => line.segments.map(segment => segment.text).join(''))
  .join('\n')

describe('styled terminal lines', () => {
  it('keeps ZWJ emoji families and flags whole inside the column budget', () => {
    const family = '👨‍👩‍👧'
    const flag = '🇨🇳'
    const lines = styledLines([lineSegment('a' + family + flag + 'bcd')], 5)
    // Every physical row stays within the budget measured in terminal cells…
    for (const line of lines) {
      expect(stringWidth(line.segments.map(segment => segment.text).join(''))).toBeLessThanOrEqual(5)
    }
    // …and no multi-codepoint cluster is ever split across rows.
    expect(textOf(lines)).toContain(family)
    expect(textOf(lines)).toContain(flag)
  })

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
    const lines = transcriptEntryLines({ kind: 'assistant', reasoning, text: answer } satisfies TranscriptEntry, 40)
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

  it('does not advertise a live Ctrl/Alt+R action on immutable settled scrollback', () => {
    const lines = settledEntryLines({ kind: 'assistant', reasoning: 'trace', text: 'answer' }, 40, false)
    const text = textOf(lines)
    expect(text).toContain('Thinking (5 chars)')
    expect(text).not.toContain('Ctrl/Alt+R to expand')
  })

  it('gives reasoning a Codex-style hanging indent aligned with reply text', () => {
    const lines = transcriptEntryLines({
      kind: 'assistant',
      reasoning: 'first thought\nsecond thought',
      text: 'answer',
    } satisfies TranscriptEntry, 40)
    expect(lines.map(line => textOf([line]))).toEqual([
      '✻ first thought',
      '  second thought',
      '  answer',
    ])
  })

  it('repeats the reasoning indent on every wrapped physical row', () => {
    const lines = reasoningLines('one two three four five', 12)
    expect(lines.length).toBeGreaterThan(1)
    expect(textOf(lines).split('\n')[0]).toMatch(/^✻ /u)
    for (const line of textOf(lines).split('\n').slice(1)) expect(line).toMatch(/^  /u)
    for (const line of lines) {
      expect(visibleColumns(line.segments.map(segment => segment.text).join(''))).toBeLessThanOrEqual(12)
    }
  })

  it('keeps the tool gutter on every wrapped detail row, aligned with the summary hanging indent', () => {
    const raw = '甲'.repeat(300)
    const entry: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      ordinal: 1,
      name: 'shell_command',
      arguments: '{}',
      preview: '',
      prompt: '',
      state: 'done',
      summary: 'done',
      detail: { kind: 'raw', text: raw, truncated: false },
      subs: [],
      subsDropped: 0,
    }
    const lines = transcriptEntryLines(entry, 40)
    expect(lines.length).toBeGreaterThan(10)
    for (const line of lines.slice(2)) {
      // Detail rows share the ⎿/└ four-column hanging gutter — never the
      // shallower two-column prefix that made cards read as unindented.
      expect(line.segments.map(segment => segment.text).join('')).toMatch(/^    /u)
      expect(visibleColumns(line.segments.map(segment => segment.text).join(''))).toBeLessThanOrEqual(40)
    }
  })

  it('fills only pure diff rows, leaving mixed and wrapped rows exact', () => {
    const columns = 20
    const built = styledLines([lineSegment('    +short', 'diffAdd')], columns)
    expect(built).toHaveLength(1)
    const filled = fillDiffLineBars(built, columns)
    expect(filled[0]!.segments.every(segment => segment.style === 'diffAdd')).toBe(true)
    expect(visibleColumns(filled[0]!.segments.map(segment => segment.text).join(''))).toBe(columns)
    // Mixed-style rows and non-diff rows pass through untouched.
    const mixed: StyledLine[] = [{ segments: [lineSegment('+x', 'diffAdd'), lineSegment('note', 'dim')] }]
    expect(fillDiffLineBars(mixed, columns)).toBe(mixed)
    const plain: StyledLine[] = [{ segments: [lineSegment('plain', 'plain')] }]
    expect(fillDiffLineBars(plain, columns)).toBe(plain)
  })

  it('paints full-row bars for diff fences in user prompts and markdown', () => {
    const entry: TranscriptEntry = {
      kind: 'user', text: '```diff\n+added line\n```', notice: false,
    }
    const lines = transcriptEntryLines(entry, 40)
    const bar = lines.find(line => line.segments.some(segment => segment.text.includes('added line')))
    // The whole row (❯ gutter included) carries one tint and fills 40 columns.
    expect(bar?.segments.every(segment => segment.style === 'diffAdd')).toBe(true)
    expect(visibleColumns(bar?.segments.map(segment => segment.text).join('') ?? '')).toBe(40)
    // Markdown fences fill too (label and fence rows stay dim/plain).
    const md = markdownLines('```diff\n-removed\n```', 40)
    const mdBar = md.find(line => line.segments.some(segment => segment.text.includes('removed')))
    expect(mdBar?.segments.every(segment => segment.style === 'diffDel')).toBe(true)
    expect(visibleColumns(mdBar?.segments.map(segment => segment.text).join('') ?? '')).toBe(40)
  })

  it('tints diff fences inside user prompts while keeping plain text verbatim', () => {
    const text = 'review this:\n```diff\n+++ b/a.ts\n+added\n-removed\n ctx\n```\nthanks'
    const segments = userPromptSegments(text)
    // Rows keep their newlines for the row splitter; styles ride per line.
    const byText = new Map(segments.map(segment => [segment.text.replace(/\n$/u, ''), segment.style]))
    expect(byText.get('review this:')).toBe('plain')
    expect(byText.get('```diff')).toBe('plain')
    expect(byText.get('+++ b/a.ts')).toBe('plain')
    expect(byText.get('+added')).toBe('diffAdd')
    expect(byText.get('-removed')).toBe('diffDel')
    expect(byText.get(' ctx')).toBe('plain')
    expect(byText.get('thanks')).toBe('plain')
    // No fences at all: one plain segment, byte-identical.
    expect(userPromptSegments('just a normal prompt')).toEqual([{ text: 'just a normal prompt', style: 'plain' }])
  })

  it('classifies unified-diff rows for the /diff panel', () => {
    expect(diffLineStyle('+new text')).toBe('diffAdd')
    expect(diffLineStyle('-old text')).toBe('diffDel')
    // File headers count as context markers, not additions/removals.
    expect(diffLineStyle('+++ b/file.ts')).toBe('dim')
    expect(diffLineStyle('--- a/file.ts')).toBe('dim')
    expect(diffLineStyle('@@ -1,3 +1,4 @@')).toBe('brand')
    expect(diffLineStyle('diff --git a/x b/x')).toBe('brand')
    expect(diffLineStyle('index 123..456 100644')).toBe('brand')
    expect(diffLineStyle(' unchanged')).toBe('dim')
  })

  it('styles diff detail rows as added/removed bars spanning the gutter', () => {
    const entry: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      ordinal: 1,
      name: 'edit',
      arguments: '{}',
      preview: 'a.ts',
      prompt: '',
      state: 'done',
      summary: 'done',
      detail: {
        kind: 'diff',
        diffs: [{
          path: 'src/a.ts',
          truncated: false,
          lines: [
            { mark: '-', text: 'old line' },
            { mark: '+', text: 'new line' },
            { mark: ' ', text: 'context' },
          ],
        }],
      },
      subs: [],
      subsDropped: 0,
    }
    const lines = transcriptEntryLines(entry, 80, true)
    // The path header stays dim; +/- rows carry the diff style on the
    // four-column gutter, the body, AND same-styled padding to the full
    // width, so the tint reads as one unbroken full-row bar.
    const pathRow = lines.find(line => line.segments.some(segment => segment.text.includes('src/a.ts')))
    expect(pathRow?.segments.every(segment => segment.style === 'dim')).toBe(true)
    const delRow = lines.find(line => line.segments.some(segment => segment.text.includes('old line')))
    expect(delRow?.segments.every(segment => segment.style === 'diffDel')).toBe(true)
    expect(visibleColumns(delRow?.segments.map(segment => segment.text).join('') ?? '')).toBe(80)
    const addRow = lines.find(line => line.segments.some(segment => segment.text.includes('new line')))
    expect(addRow?.segments.every(segment => segment.style === 'diffAdd')).toBe(true)
    expect(visibleColumns(addRow?.segments.map(segment => segment.text).join('') ?? '')).toBe(80)
    // Context rows keep the plain dim gutter and stay unpadded.
    const contextRow = lines.find(line => line.segments.some(segment => segment.text.includes('context')))
    expect(contextRow?.segments.every(segment => segment.style === 'dim')).toBe(true)
    expect(visibleColumns(contextRow?.segments.map(segment => segment.text).join('') ?? '')).toBeLessThan(80)
  })

  it('folds raw tool output to three rows by default and expands with Ctrl/Alt+R state', () => {
    const raw = Array.from({ length: 60 }, (_, index) => `tool-${index}`).join('\n')
    const entry: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      ordinal: 1,
      name: 'shell_command',
      arguments: '{}',
      preview: '',
      prompt: '',
      state: 'done',
      summary: 'done',
      detail: { kind: 'raw', text: raw, truncated: false },
      subs: [],
      subsDropped: 0,
    }
    const collapsed = transcriptEntryLines(entry, 40, false)
    expect(collapsed).toHaveLength(3)
    expect(textOf(collapsed)).toContain('Ctrl/Alt+R')

    const expanded = transcriptEntryLines(entry, 40, true)
    expect(expanded.length).toBeGreaterThan(60)
    expect(textOf(expanded)).toContain('tool-59')
  })

  it('renders the global call ordinal in the badge and the error line alike', () => {
    const entry: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      ordinal: 7,
      name: 'bash',
      arguments: '{}',
      preview: '',
      prompt: '',
      state: 'error',
      summary: 'command failed',
      detail: undefined,
      subs: [],
      subsDropped: 0,
    }
    const text = textOf(transcriptEntryLines(entry, 80))
    // The badge and the nested error line share one index: an error named
    // "call 7" always points at the card that shows [7].
    expect(text).toContain('[7] bash')
    expect(text).toContain('⎿ call 7: command failed')
  })

  it('renders PTC sub-dispatch rows with state marks, durations, and the eviction count', () => {
    const entry: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      ordinal: 1,
      name: 'run_code',
      arguments: '{}',
      preview: 'main.ts',
      prompt: '',
      state: 'running',
      summary: '',
      detail: undefined,
      subs: [
        { subCallId: 'run:ptc:1', name: 'read_file', preview: 'a.ts', state: 'running', summary: '', durationMs: 0 },
        { subCallId: 'run:ptc:2', name: 'bash', preview: 'ls', state: 'done', summary: '', durationMs: 1_230 },
        { subCallId: 'run:ptc:3', name: 'edit', preview: 'b.ts', state: 'error', summary: 'boom', durationMs: 40 },
      ],
      subsDropped: 2,
    }
    const text = textOf(transcriptEntryLines(entry, 80, true))
    expect(text).toContain('┆ ● read_file a.ts')
    expect(text).toContain('┆ ⏺ bash ls · 1.2s')
    expect(text).toContain('┆ ⨯ edit b.ts · boom')
    expect(text).toContain('┆ … 2 earlier dispatches')
    // Collapsed (Ctrl+R fold closed) keeps the bounded three-row window.
    const collapsed = transcriptEntryLines(entry, 80, false)
    expect(collapsed).toHaveLength(3)
    expect(textOf(collapsed)).toContain('Ctrl/Alt+R')
  })

  it('sanitizes live tool and command names before physical-row rendering', () => {
    const tool: TranscriptEntry = {
      kind: 'tool',
      callId: 'call',
      ordinal: 1,
      name: 'evil\x1b]0;pwned\x07fetch',
      arguments: '{}',
      preview: '',
      prompt: '',
      state: 'running',
      summary: '',
      detail: undefined,
      subs: [],
      subsDropped: 0,
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

describe('live allocation clamp', () => {
  it('passes allocations that fit the dynamic budget through unchanged', () => {
    const audit = clampLiveAllocation({ live: 4, reasoning: 2, answer: 3 }, 10)
    expect(audit.allocation).toEqual({ live: 4, reasoning: 2, answer: 3 })
    expect(audit.warning).toBeUndefined()
  })

  it('reduces the answer first, then reasoning, then settled live rows', () => {
    const audit = clampLiveAllocation({ live: 5, reasoning: 2, answer: 3 }, 7)
    expect(audit.allocation).toEqual({ live: 5, reasoning: 2, answer: 0 })
    expect(audit.warning).toBeDefined()

    const deeper = clampLiveAllocation({ live: 5, reasoning: 2, answer: 3 }, 6)
    expect(deeper.allocation).toEqual({ live: 5, reasoning: 1, answer: 0 })

    const deepest = clampLiveAllocation({ live: 5, reasoning: 2, answer: 3 }, 3)
    expect(deepest.allocation).toEqual({ live: 3, reasoning: 0, answer: 0 })
  })

  it('never returns negative rows and floors fractional inputs', () => {
    const audit = clampLiveAllocation({ live: 2, reasoning: 1.5, answer: 0.5 }, 0)
    expect(audit.allocation).toEqual({ live: 0, reasoning: 0, answer: 0 })
    expect(audit.warning).toBeDefined()
  })
})
