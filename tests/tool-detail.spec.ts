/** Verbose tool-card expansion: presentation-meta narrowing and diff rows. */

import { describe, expect, it } from 'vitest'
import { visibleColumns } from '../src/render/markdown.ts'
import { diffRows, toolResultDetail } from '../src/render/tool-detail.ts'
import { transcriptEntryLines } from '../src/render/lines.ts'
import type { StyledLine } from '../src/render/lines.ts'
import type { TranscriptEntry } from '../src/render/projection.ts'

describe('diffRows', () => {
  it('clips long CJK lines by terminal columns and keeps the ellipsis in budget', () => {
    const result = diffRows(null, '甲'.repeat(200), 1)
    expect(result.lines).toHaveLength(1)
    expect(visibleColumns(result.lines[0].text)).toBeLessThanOrEqual(240)
    expect(result.lines[0].text.endsWith('…')).toBe(true)
  })

  it('renders a create as pure additions', () => {
    expect(diffRows(null, 'a\nb', 200)).toEqual({
      lines: [{ mark: '+', text: 'a' }, { mark: '+', text: 'b' }],
      truncated: false,
    })
  })

  it('hunks by common prefix and suffix, removed before added', () => {
    expect(diffRows('keep\nold1\nold2\ntail', 'keep\nnew1\ntail', 200)).toEqual({
      lines: [
        { mark: '-', text: 'old1' },
        { mark: '-', text: 'old2' },
        { mark: '+', text: 'new1' },
      ],
      truncated: false,
    })
  })

  it('reports an unchanged file as an empty hunk', () => {
    expect(diffRows('same', 'same', 200)).toEqual({ lines: [], truncated: false })
  })

  it('cuts at the row budget and flags the truncation', () => {
    const { lines, truncated } = diffRows(null, Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'), 4)
    expect(lines).toHaveLength(4)
    expect(truncated).toBe(true)
  })
})

describe('toolResultDetail', () => {
  it('narrows diff meta into rendered hunks', () => {
    const detail = toolResultDetail({ diffs: [{ path: 'a.ts', oldText: null, newText: 'hi' }] }, 'Created file')
    expect(detail).toEqual({
      kind: 'diff',
      diffs: [{ path: 'a.ts', lines: [{ mark: '+', text: 'hi' }], truncated: false }],
    })
  })

  it('narrows a read window, keeping file line numbers', () => {
    const detail = toolResultDetail(
      { path: 'a.ts', offset: 5, totalLines: 40, lines: [{ number: 5, text: 'x' }] },
      'read',
    )
    expect(detail).toEqual({
      kind: 'read',
      path: 'a.ts',
      offset: 5,
      totalLines: 40,
      truncated: false,
      lines: [{ number: 5, text: 'x' }],
    })
  })

  it('narrows web-search meta into bounded sources', () => {
    const detail = toolResultDetail(
      { sources: [{ url: 'https://a', title: 'A' }, { url: 'https://b' }], truncated: false },
      'searched',
    )
    expect(detail).toEqual({
      kind: 'web-search',
      truncated: false,
      sources: [
        { url: 'https://a', title: 'A', snippet: '' },
        { url: 'https://b', title: undefined, snippet: '' },
      ],
    })
  })

  it('narrows web-fetch meta into a summary row', () => {
    expect(toolResultDetail({ url: 'https://a', statusCode: 200, truncated: false }, 'fetched'))
      .toEqual({ kind: 'web-fetch', url: 'https://a', statusCode: 200 })
  })

  it('degrades malformed meta to the bounded raw text', () => {
    expect(toolResultDetail({ diffs: 'nope' }, 'plain output')).toEqual({
      kind: 'raw',
      text: 'plain output',
      truncated: false,
    })
  })

  it('bounds the raw fallback and flags the cut', () => {
    const long = 'x'.repeat(7_000)
    expect(toolResultDetail(undefined, long)).toEqual({ kind: 'raw', text: 'x'.repeat(6_000), truncated: true })
  })

  it('returns undefined only when nothing renderable exists', () => {
    expect(toolResultDetail(undefined, '')).toBeUndefined()
  })
})

describe('diffRows hard caps', () => {
  it('caps combined old/new input characters and flags the cut', () => {
    const { lines, truncated } = diffRows('a'.repeat(20_000), 'b'.repeat(20_000), 8)
    expect(truncated).toBe(true)
    expect(lines).toHaveLength(2)
    expect(lines[0].mark).toBe('-')
    expect(lines[1].mark).toBe('+')
    expect(lines[0].text.endsWith('…')).toBe(true)
  })

  it('caps a single giant added text before line splitting', () => {
    const { lines, truncated } = diffRows(null, 'y'.repeat(30_000), 8)
    expect(truncated).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0].text.endsWith('…')).toBe(true)
  })

  it('still emits at most the row budget incrementally', () => {
    const { lines, truncated } = diffRows(null, Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'), 4)
    expect(lines).toHaveLength(4)
    expect(truncated).toBe(true)
  })
})

describe('toolResultDetail hard caps', () => {
  it('caps the number of diffs rendered from one meta payload', () => {
    const diffs = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, oldText: null, newText: `v${i}` }))
    const detail = toolResultDetail({ diffs }, '')
    expect(detail?.kind).toBe('diff')
    if (detail?.kind === 'diff') {
      expect(detail.diffs).toHaveLength(8)
      expect(detail.diffs[0]?.path).toBe('f0.ts')
    }
  })

  it('flags the last kept diff when diffs beyond the cap were dropped', () => {
    const diffs = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, oldText: null, newText: `v${i}` }))
    const detail = toolResultDetail({ diffs }, '')
    expect(detail?.kind).toBe('diff')
    if (detail?.kind === 'diff') {
      expect(detail.diffs[6]?.truncated).toBe(false)
      expect(detail.diffs[7]?.truncated).toBe(true)
      expect(detail.diffs[7]?.path).toBe('f7.ts')
    }
  })

  it('leaves every diff untruncated when the count fits the cap', () => {
    const diffs = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, oldText: null, newText: `v${i}` }))
    const detail = toolResultDetail({ diffs }, '')
    expect(detail?.kind).toBe('diff')
    if (detail?.kind === 'diff') {
      expect(detail.diffs[7]?.truncated).toBe(false)
    }
  })

  it('validates and slices a huge read window on the capped window', () => {
    const lines = Array.from({ length: 500 }, (_, i) => ({ number: i + 1, text: `line ${i}` }))
    const detail = toolResultDetail({ path: 'a.ts', offset: 1, totalLines: 500, lines }, 'read')
    expect(detail?.kind).toBe('read')
    if (detail?.kind === 'read') {
      expect(detail.truncated).toBe(true)
      expect(detail.lines).toHaveLength(120)
    }
  })

  it('drops malformed read lines beyond the display window without rejecting the meta', () => {
    const lines = [
      ...Array.from({ length: 120 }, (_, i) => ({ number: i + 1, text: 'ok' })),
      { number: -1, text: 'bad' },
    ]
    const detail = toolResultDetail({ path: 'a.ts', offset: 1, totalLines: 121, lines }, 'read')
    expect(detail?.kind).toBe('read')
  })

  it('still rejects malformed read lines inside the display window', () => {
    const detail = toolResultDetail(
      { path: 'a.ts', offset: 1, totalLines: 1, lines: [{ number: -1, text: 'bad' }] },
      'raw output',
    )
    expect(detail?.kind).toBe('raw')
  })

  it('caps web-search sources to the bounded window', () => {
    const sources = Array.from({ length: 50 }, (_, i) => ({ url: `https://x/${i}` }))
    const detail = toolResultDetail({ sources }, 'searched')
    expect(detail?.kind).toBe('web-search')
    if (detail?.kind === 'web-search') {
      expect(detail.truncated).toBe(true)
      expect(detail.sources).toHaveLength(10)
    }
  })
})

/** One searchable string from rendered rows. */
const render = (lines: readonly StyledLine[]): string => lines.flatMap(line => line.segments).map(segment => segment.text).join('')

describe('tool detail card rows (verbose transcript rendering)', () => {
  const columns = 80
  const rowsOf = (entry: TranscriptEntry): readonly StyledLine[] =>
    transcriptEntryLines(entry, columns, true, true, true)

  it('renders diff cards with per-file headers and tinted marks', () => {
    const entry = { kind: 'tool', name: 'edit', state: 'done', ordinal: 1, preview: '', prompt: '', summary: '', subs: [], detail: { kind: 'diff', diffs: [
      { path: 'src/a.ts', truncated: false, lines: [
        { mark: '-', text: 'old' }, { mark: '+', text: 'new' }, { mark: ' ', text: 'ctx' },
      ] },
    ] } } as unknown as TranscriptEntry
    const rows = rowsOf(entry)
    const flat = render(rows)
    expect(flat).toContain('src/a.ts')
    expect(flat).toContain('-old')
    expect(flat).toContain('+new')
    expect(flat).toContain(' ctx')
    expect(flat).not.toContain('(diff truncated)')
    const styles = rows.flatMap(line => line.segments).map(seg => seg.style)
    expect(styles).toContain('diffAdd')
    expect(styles).toContain('diffDel')
  })

  it('renders a read window with the line range and numbered rows', () => {
    const entry = { kind: 'tool', name: 'read', state: 'done', ordinal: 2, preview: '', prompt: '', summary: '', subs: [], detail: { kind: 'read', path: 'b.ts', offset: 10, totalLines: 100, truncated: true, lines: [
      { number: 10, text: 'first' }, { number: 11, text: 'second' },
    ] } } as unknown as TranscriptEntry
    const flat = render(rowsOf(entry))
    expect(flat).toContain('b.ts · lines 10-11 of 100')
    expect(flat).toContain('10 | first')
    expect(flat).toContain('11 | second')
    expect(flat).toContain('(window truncated)')
  })

  it('renders web-search sources with titles, urls, snippets and the count', () => {
    const entry = { kind: 'tool', name: 'web_search', state: 'done', ordinal: 3, preview: '', prompt: '', summary: '', subs: [], detail: { kind: 'web-search', truncated: false, sources: [
      { title: 'Docs', url: 'https://docs.example', snippet: 'the answer' },
      { title: undefined, url: 'https://bare', snippet: '' },
    ] } } as unknown as TranscriptEntry
    const flat = render(rowsOf(entry))
    expect(flat).toContain('Docs')
    expect(flat).toContain('https://docs.example')
    expect(flat).toContain('the answer')
    expect(flat).toContain('https://bare')
    expect(flat).toContain('2 sources')
    // A title row carries the brand style.
    const styles = rowsOf(entry).flatMap(line => line.segments).map(seg => seg.style)
    expect(styles).toContain('brand')
  })

  it('renders web-fetch and raw cards with their summaries and end markers', () => {
    const fetch = { kind: 'tool', name: 'fetch', state: 'done', ordinal: 4, preview: '', prompt: '', summary: '', subs: [], detail: { kind: 'web-fetch', url: 'https://x', statusCode: 404 } } as unknown as TranscriptEntry
    const flatFetch = render(rowsOf(fetch))
    expect(flatFetch).toContain('https://x · HTTP 404')

    const raw = { kind: 'tool', name: 'bash', state: 'done', ordinal: 5, preview: '', prompt: '', summary: '', subs: [], detail: { kind: 'raw', text: 'done', truncated: true } } as unknown as TranscriptEntry
    const flatRaw = render(rowsOf(raw))
    expect(flatRaw).toContain('done')
    expect(flatRaw).toContain('… (output truncated)')
  })

  it('keeps verbose detail rows within the terminal column budget', () => {
    const width = 18
    const entry = { kind: 'tool', name: 'read', state: 'done', ordinal: 6, preview: '', prompt: '', summary: '', subs: [], detail: { kind: 'read', path: '很长的文件名.ts', offset: 5, totalLines: 100, truncated: true, lines: [
      { number: 5, text: '一段很长的内容 used to verify wrapping' },
    ] } } as unknown as TranscriptEntry
    const rows = transcriptEntryLines(entry, width, true, true, true)
    expect(rows).not.toHaveLength(0)
    for (const row of rows) expect(visibleColumns(render([row]))).toBeLessThanOrEqual(width)
  })
})
