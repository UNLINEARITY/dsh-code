/** Display-boundary sanitization: control characters become visible escapes. */

import { describe, expect, it } from 'vitest'
import { displayTail, displayText } from '../src/render/text.ts'

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
