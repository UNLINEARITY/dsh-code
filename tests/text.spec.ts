/** Display-boundary sanitization: control characters become visible escapes. */

import { describe, expect, it } from 'vitest'
import { displayText } from '../src/render/text.ts'

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
