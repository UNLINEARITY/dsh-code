/** Precise terminal-cell width engine regressions (dsh-TUI absorption batch 1). */

import { describe, expect, it } from 'vitest'
import { codePointWidth, graphemeWidth, splitGraphemes, stringWidth } from '../src/render/width.ts'

describe('stringWidth', () => {
  it('fast-paths pure ASCII and drops control cells', () => {
    expect(stringWidth('')).toBe(0)
    expect(stringWidth('hello')).toBe(5)
    expect(stringWidth('a\tb')).toBe(2)
    expect(stringWidth('\u0007ring')).toBe(4)
  })

  it('measures CJK and Hangul double while narrow high code points stay one cell', () => {
    expect(stringWidth('中文')).toBe(4)
    expect(stringWidth('한글')).toBe(4)
    // Hangul Jamo leading consonant: East Asian Wide, previously miscounted as 1.
    expect(stringWidth('\u1100')).toBe(2)
    // U+A700 modifier letter sits above the old 0x2e7f cutoff and was miscounted as 2.
    expect(stringWidth('\uA700')).toBe(1)
  })

  it('keeps text-default emoji at one cell and honors VS16 presentation at two', () => {
    // The dsh-TUI regression class: ✳ ⚠ ❤ default to text presentation.
    expect(stringWidth('✳')).toBe(1)
    expect(stringWidth('⚠')).toBe(1)
    expect(stringWidth('❤')).toBe(1)
    expect(stringWidth('❤\uFE0F')).toBe(2)
    expect(stringWidth('✳\uFE0F')).toBe(2)
  })

  it('counts emoji presentation, flags, and ZWJ families per cluster', () => {
    expect(stringWidth('⏺')).toBe(2)
    expect(stringWidth('😀')).toBe(2)
    expect(stringWidth('🇨🇳')).toBe(2)
    expect(stringWidth('👨\u200D👩\u200D👧')).toBe(2)
    // A partial family sequence renders per glyph; the count may only shrink
    // the rendered line, never overflow it.
    expect(stringWidth('👨\u200D👩')).toBeGreaterThanOrEqual(2)
  })

  it('combining marks join their base cluster without adding cells', () => {
    expect(stringWidth('e\u0301')).toBe(1)
    expect(graphemeWidth('e\u0301')).toBe(1)
    expect(splitGraphemes('e\u0301')).toEqual(['e\u0301'])
  })

  it('classifies single code points for the backward walks', () => {
    expect(codePointWidth('中')).toBe(2)
    expect(codePointWidth('a')).toBe(1)
    expect(codePointWidth('\u0301')).toBe(0)
    expect(codePointWidth('\uFE0F')).toBe(0)
    expect(codePointWidth('\u200D')).toBe(0)
  })
})
