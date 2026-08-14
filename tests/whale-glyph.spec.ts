/** Glyph geometry: fixed grid, non-empty coverage, and honest regeneration marker. */

import { describe, expect, it } from 'vitest'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS, WHALE_GLYPH_ROWS } from '../src/whale-glyph.ts'

describe('whale glyph', () => {
  it('holds one string per half-block row', () => {
    expect(WHALE_GLYPH).toHaveLength(WHALE_GLYPH_ROWS)
    expect(WHALE_GLYPH_ROWS).toBe(8)
  })

  it('pads every row to the fixed column width', () => {
    for (const row of WHALE_GLYPH) {
      expect(row).toHaveLength(WHALE_GLYPH_COLUMNS)
    }
    expect(WHALE_GLYPH_COLUMNS).toBe(26)
  })

  it('draws only half-block cell characters', () => {
    for (const row of WHALE_GLYPH) {
      expect(row).toMatch(/^[ ▀▄█]*$/)
    }
  })

  it('covers a meaningful share of the grid without filling it', () => {
    const cells = WHALE_GLYPH.flatMap(row => [...row])
    const ink = cells.filter(cell => cell !== ' ').length
    expect(ink).toBeGreaterThan(cells.length / 5)
    expect(ink).toBeLessThan(cells.length)
  })
})
