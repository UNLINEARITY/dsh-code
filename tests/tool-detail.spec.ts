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
