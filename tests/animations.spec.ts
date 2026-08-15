/** Terminal animation frames (web StateDot pulse + chase) and caret blink. */

import { describe, expect, it } from 'vitest'
import {
  BUSY_CHASE_FRAMES,
  busyChaseFrame,
  caretVisible,
  DEEPSEEK_WAVE_FRAMES,
  isOfficialDeepSeekLabel,
  pulseFrame,
} from '../src/render/animations.ts'

describe('pulseFrame', () => {
  it('steps brightness with flat holds over an 8-frame 1s cycle', () => {
    expect(pulseFrame(0)).toBe('█')
    expect(pulseFrame(1)).toBe('█')
    expect(pulseFrame(2)).toBe('▆')
    expect(pulseFrame(4)).toBe('▁')
    expect(pulseFrame(8)).toBe('█')
  })
})

describe('busyChaseFrame', () => {
  it('rotates the web StateDot ongoing chase clockwise over 8 distinct frames', () => {
    expect(BUSY_CHASE_FRAMES).toHaveLength(8)
    expect(new Set(BUSY_CHASE_FRAMES).size).toBe(8)
    expect(busyChaseFrame(0)).toBe(BUSY_CHASE_FRAMES[0])
    expect(busyChaseFrame(7)).toBe(BUSY_CHASE_FRAMES[7])
    expect(busyChaseFrame(8)).toBe(BUSY_CHASE_FRAMES[0])
    for (let tick = 0; tick < 16; tick += 1) {
      expect(BUSY_CHASE_FRAMES).toContain(busyChaseFrame(tick))
    }
  })
})

describe('caretVisible', () => {
  it('blinks half on, half off', () => {
    expect(caretVisible(0)).toBe(true)
    expect(caretVisible(1)).toBe(false)
    expect(caretVisible(2)).toBe(true)
  })
})

describe('isOfficialDeepSeekLabel', () => {
  it('accepts the official deepseek-official route and deepseek-* models', () => {
    expect(isOfficialDeepSeekLabel('deepseek-official/deepseek-v4-flash')).toBe(true)
    expect(isOfficialDeepSeekLabel('deepseek-official/deepseek-reasoner')).toBe(true)
    expect(isOfficialDeepSeekLabel('deepseek/deepseek-chat')).toBe(true)
  })

  it('accepts a deepseek model id under any provider route', () => {
    expect(isOfficialDeepSeekLabel('acme/deepseek-v4-flash')).toBe(true)
  })

  it('rejects non-DeepSeek labels, empty labels, and case differences only in the provider name', () => {
    expect(isOfficialDeepSeekLabel('anthropic/claude')).toBe(false)
    expect(isOfficialDeepSeekLabel('acme/model-01')).toBe(false)
    expect(isOfficialDeepSeekLabel('')).toBe(false)
  })

  it('matches case-insensitively', () => {
    expect(isOfficialDeepSeekLabel('DeepSeek-Official/DeepSeek-V4-Flash')).toBe(true)
    expect(isOfficialDeepSeekLabel('DEEPSEEK/deepseek-chat')).toBe(true)
  })
})
