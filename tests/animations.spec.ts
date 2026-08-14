/** Terminal animation frames (web StateDot pulse) and caret blink. */

import { describe, expect, it } from 'vitest'
import { caretVisible, pulseFrame } from '../src/render/animations.ts'

describe('pulseFrame', () => {
  it('steps brightness with flat holds over an 8-frame 1s cycle', () => {
    expect(pulseFrame(0)).toBe('█')
    expect(pulseFrame(1)).toBe('█')
    expect(pulseFrame(2)).toBe('▆')
    expect(pulseFrame(4)).toBe('▁')
    expect(pulseFrame(8)).toBe('█')
  })
})

describe('caretVisible', () => {
  it('blinks half on, half off', () => {
    expect(caretVisible(0)).toBe(true)
    expect(caretVisible(1)).toBe(false)
    expect(caretVisible(2)).toBe(true)
  })
})
