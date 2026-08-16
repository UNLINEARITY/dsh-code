/** Verbose tool-card expansion: presentation-meta narrowing and diff rows. */

import { describe, expect, it } from 'vitest'
import { diffRows, toolResultDetail } from '../src/render/tool-detail.ts'

describe('diffRows', () => {
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
    expect(lines[0]!.mark).toBe('-')
    expect(lines[1]!.mark).toBe('+')
    expect(lines[0]!.text.endsWith('…')).toBe(true)
  })

  it('caps a single giant added text before line splitting', () => {
    const { lines, truncated } = diffRows(null, 'y'.repeat(30_000), 8)
    expect(truncated).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text.endsWith('…')).toBe(true)
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
