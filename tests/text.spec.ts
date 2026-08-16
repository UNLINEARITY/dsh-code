/** Display-boundary sanitization: control characters become visible escapes. */

import { describe, expect, it } from 'vitest'
import { displayTail, displayText, singleLineText, truncateColumns } from '../src/render/text.ts'

describe('displayText', () => {
  it('keeps ordinary text, newlines, and tabs intact', () => {
    expect(displayText('hello 世界\nsecond line\ttabbed')).toBe('hello 世界\nsecond line\ttabbed')
  })

  it('escapes an embedded ANSI CSI sequence', () => {
    expect(displayText('ok\x1b[31mRED\x1b[0m')).toBe('ok\\x1b[31mRED\\x1b[0m')
  })

  it('escapes C0 controls except tab and newline', () => {
    expect(displayText('a\rb\bc\x07d\x00e')).toBe('a\\x0db\\x08c\\x07d\\x00e')
  })

  it('escapes DEL and C1 controls', () => {
    expect(displayText('x\x7fy\u0085z\u009b')).toBe('x\\x7fy\\x85z\\x9b')
  })

  it('uses two hex digits with lowercase', () => {
    expect(displayText('\x1b')).toBe('\\x1b')
    expect(displayText('\x00')).toBe('\\x00')
  })
})

describe('single-line terminal text', () => {
  it('collapses line breaks and tabs without allowing terminal controls through', () => {
    expect(singleLineText('first\nsecond\t\x1b[31m')).toBe('first ↵ second  \\x1b[31m')
  })

  it('keeps the ellipsis inside the physical-column budget', () => {
    expect(truncateColumns('abcdef', 5)).toBe('abcd…')
    expect(truncateColumns('甲乙丙', 5)).toBe('甲乙…')
    expect(truncateColumns('甲', 1)).toBe('…')
    expect(truncateColumns('anything', 0)).toBe('')
  })
})

describe('displayTail', () => {
  it('keeps only the newest explicit lines within the row budget', () => {
    expect(displayTail('one\ntwo\nthree', 20, 2)).toEqual({ text: 'two\nthree', truncated: true })
  })

  it('counts wrapped CJK text by terminal columns', () => {
    expect(displayTail('甲乙丙丁', 4, 1)).toEqual({ text: '丙丁', truncated: true })
    expect(displayTail('甲乙丙丁', 4, 2)).toEqual({ text: '甲乙\n丙丁', truncated: false })
  })

  it('budgets the visible control-character escape instead of the raw byte', () => {
    expect(displayTail('ab\x1bcd', 4, 1)).toEqual({ text: 'cd', truncated: true })
    expect(displayTail('\x1bcd', 6, 1)).toEqual({ text: '\\x1bcd', truncated: false })
  })

  it('does not split surrogate pairs while walking backward', () => {
    expect(displayTail('ab😀', 2, 1)).toEqual({ text: '😀', truncated: true })
  })
})

describe('displayText invisible and bidi controls', () => {
  it('escapes bidi overrides as visible \\uXXXX escapes', () => {
    expect(displayText('A\u202EB\u202C')).toBe('A\\u202eB\\u202c')
    expect(displayText('\u202a\u202b\u202d')).toBe('\\u202a\\u202b\\u202d')
  })

  it('escapes isolates, directional marks, and zero-width format characters', () => {
    expect(displayText('\u2066x\u2069')).toBe('\\u2066x\\u2069')
    expect(displayText('\u200e\u200f\u200b\ufeff')).toBe('\\u200e\\u200f\\u200b\\ufeff')
  })

  it('escapes the Arabic Letter Mark bidi control', () => {
    expect(displayText('a\u061cb')).toBe('a\\u061cb')
    expect(displayText('\u061c\u202e')).toBe('\\u061c\\u202e')
  })

  it('escapes Unicode line and paragraph separators', () => {
    expect(displayText('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c')
  })

  it('keeps C0/C1 escaping in the existing \\xNN form', () => {
    expect(displayText('\x1b[31m\x07')).toBe('\\x1b[31m\\x07')
  })

  it('singleLineText also renders bidi controls visible', () => {
    expect(singleLineText('ok\u202eNO')).toBe('ok\\u202eNO')
  })
})

describe('displayTail tab normalization', () => {
  it('converts tabs to two spaces inside the column budget', () => {
    expect(displayTail('a\tb', 4, 1)).toEqual({ text: 'a  b', truncated: false })
  })

  it('budgets the tab-expanded width instead of the raw tab cell', () => {
    const tail = displayTail('\t\t', 3, 1)
    expect(tail.text).toBe('  ')
    expect(tail.truncated).toBe(true)
  })

  it('never emits a raw tab byte', () => {
    expect(displayTail('\t'.repeat(50), 20, 2).text).not.toContain('\t')
  })

  it('counts tab-expanded rows like wrapped text', () => {
    expect(displayTail('x\t\ty', 5, 2).text).toBe('x\n    y')
  })
})
