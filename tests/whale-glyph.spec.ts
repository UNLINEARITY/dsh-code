/** Glyph geometry: fixed grid, non-empty coverage, and honest regeneration marker. */

import { describe, expect, it } from 'vitest'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS, WHALE_GLYPH_ROWS } from '../src/whale-glyph.ts'
import { blockFillTerminal, whaleRowSegments } from '../src/app.ts'

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

describe('whale row segments', () => {
  it('detects macOS Terminal only', () => {
    expect(blockFillTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(true)
    expect(blockFillTerminal({ TERM_PROGRAM: 'vscode' })).toBe(false)
    expect(blockFillTerminal({})).toBe(false)
  })

  it('keeps every cell in place in both modes', () => {
    for (const row of WHALE_GLYPH) {
      for (const fill of [false, true]) {
        const segments = whaleRowSegments(row, fill)
        expect(segments.map(segment => segment.text).join('')).toHaveLength(WHALE_GLYPH_COLUMNS)
        for (const segment of segments) {
          const source = row.slice(segment.start, segment.start + segment.text.length)
          expect(segment.text).toBe(segment.kind === 'fill' ? ' '.repeat(source.length) : source)
        }
      }
    }
  })

  it('paints full blocks as background fills only when asked', () => {
    const row = ' ▄██▀ '
    expect(whaleRowSegments(row, false)).toEqual([
      { start: 0, kind: 'blank', text: ' ' },
      { start: 1, kind: 'glyph', text: '▄██▀' },
      { start: 5, kind: 'blank', text: ' ' },
    ])
    expect(whaleRowSegments(row, true)).toEqual([
      { start: 0, kind: 'blank', text: ' ' },
      { start: 1, kind: 'glyph', text: '▄' },
      { start: 2, kind: 'fill', text: '  ' },
      { start: 4, kind: 'glyph', text: '▀' },
      { start: 5, kind: 'blank', text: ' ' },
    ])
    expect(whaleRowSegments('██', true, () => true).map(segment => segment.start)).toEqual([0, 1])
  })
})
