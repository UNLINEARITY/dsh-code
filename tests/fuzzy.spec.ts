/** Behavior locks for the vendored fuzzy ranking (the web menu's algorithm). */

import { describe, expect, it } from 'vitest'
import { rankByName } from '../src/render/fuzzy.ts'

const named = (...names: string[]): { name: string }[] => names.map(name => ({ name }))

describe('rankByName', () => {
  it('returns the input list itself for an empty query', () => {
    const items = named('mode', 'model', 'export')
    expect(rankByName(items, '')).toBe(items)
  })

  it('requires the query to be an ordered subsequence, case-insensitively', () => {
    // `me` matches `mode` (m → e) but `dmo` matches neither: no m after d.
    expect(rankByName(named('mode', 'model'), 'me').map(item => item.name)).toEqual(['mode', 'model'])
    expect(rankByName(named('mode', 'model'), 'dmo')).toEqual([])
    expect(rankByName(named('Session-Title'), 'st').map(item => item.name)).toEqual(['Session-Title'])
  })

  it('ranks prefix hits before gapped matches', () => {
    // `mo` prefixes `mode`; `x-mode` only contains the subsequence — the
    // prefix hit leads regardless of source order.
    expect(rankByName(named('x-mode', 'mode'), 'mo').map(item => item.name)).toEqual(['mode', 'x-mode'])
  })

  it('keeps source order for equal-ranking matches', () => {
    // Both `model` and `mode` prefix `mo` with identical adjacency; the
    // source order decides.
    expect(rankByName(named('model', 'mode'), 'mo').map(item => item.name)).toEqual(['model', 'mode'])
    expect(rankByName(named('review', 'recent'), 're').map(item => item.name)).toEqual(['review', 'recent'])
  })

  it('rewards word-boundary hits over mid-word gaps with the same letters', () => {
    // Both contain the subsequence `sc`; the boundary-starting name scores
    // its first match at index 0 with the bonus, the other pays the skip.
    const ranked = rankByName(named('session-context', 'second-scene'), 'sc')
      .map(item => item.name)
    expect(ranked[0]).toBe('session-context')
  })
})
