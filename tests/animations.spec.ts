/** Terminal animation frames (web StateDot pulse + chase) and caret blink. */

import { describe, expect, it } from 'vitest'
import { DARK_PALETTE, type RgbTriple } from '../src/theme.ts'
import {
  BUSY_CHASE_FRAMES,
  busyChaseFrame,
  caretVisible,
  DEEPSEEK_WAVE_FRAMES,
  DEEPSEEK_WAVE_INTERVAL_MS,
  deepseekWaveColor,
  deepseekWavePromptColor,
  isOfficialDeepSeekLabel,
  pulseFrame,
  type DeepseekWaveColors,
} from '../src/render/animations.ts'

/** Dark-theme anchors the wave interpolates in production by default. */
const waveColors: DeepseekWaveColors = {
  calm: DARK_PALETTE.dim,
  deep: DARK_PALETTE.brandDeep,
  brand: DARK_PALETTE.brand,
  mid: DARK_PALETTE.brandMid,
  bright: DARK_PALETTE.brandBright,
}

/** Max per-channel distance between two triples. */
function channelDelta(a: RgbTriple, b: RgbTriple): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

/** Perceived brightness proxy (sum of channels). */
function brightness(c: RgbTriple): number {
  return c[0] + c[1] + c[2]
}

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

describe('deepseekWaveColor', () => {
  const frames = (): readonly RgbTriple[] =>
    Array.from({ length: DEEPSEEK_WAVE_FRAMES }, (_, tick) => deepseekWaveColor(tick, waveColors))

  it('runs 32 eased frames at 60ms (≈1.9s) so the gradient stays fluid', () => {
    expect(DEEPSEEK_WAVE_FRAMES).toBe(32)
    expect(DEEPSEEK_WAVE_INTERVAL_MS).toBe(60)
  })

  it('starts and ends exactly at the static border tone', () => {
    expect(deepseekWaveColor(0, waveColors)).toEqual(DARK_PALETTE.dim)
    expect(deepseekWaveColor(DEEPSEEK_WAVE_FRAMES - 1, waveColors)).toEqual(DARK_PALETTE.dim)
  })

  it('crests at the middle frames and returns symmetrically (round trip)', () => {
    const all = frames()
    const peak = Math.max(...all.map(brightness))
    // The eased crest holds across the two middle frames (both ~95% of bright).
    const middle = Math.floor(DEEPSEEK_WAVE_FRAMES / 2)
    expect(brightness(all[middle]!)).toBe(peak)
    expect(brightness(all[middle - 1]!)).toBe(peak)
    expect(channelDelta(all[middle]!, DARK_PALETTE.brandBright)).toBeLessThanOrEqual(5)
    for (let tick = 0; tick < middle; tick += 1) {
      expect(channelDelta(all[tick]!, all[DEEPSEEK_WAVE_FRAMES - 1 - tick]!)).toBe(0)
    }
  })

  it('interpolates many distinct shades instead of cycling a few tokens', () => {
    const distinct = new Set(frames().map(c => c.join(','))).size
    expect(distinct).toBeGreaterThanOrEqual(12) // ≫ the 4 stepped shades of the old wave
  })

  it('steps smoothly between consecutive frames (no discrete jumps)', () => {
    for (let tick = 1; tick < DEEPSEEK_WAVE_FRAMES; tick += 1) {
      expect(channelDelta(deepseekWaveColor(tick - 1, waveColors), deepseekWaveColor(tick, waveColors)))
        .toBeLessThanOrEqual(20)
    }
  })

  it('stays inside the brand-blue family', () => {
    for (const [r, g, b] of frames()) {
      expect(b).toBeGreaterThanOrEqual(g)
      expect(b).toBeGreaterThanOrEqual(r)
    }
  })
})

describe('deepseekWavePromptColor', () => {
  it('starts exactly at the static brand prompt tone', () => {
    expect(deepseekWavePromptColor(0, waveColors)).toEqual(DARK_PALETTE.brand)
  })

  it('returns to the static brand tone at the last frame (no end-of-wave snap)', () => {
    expect(channelDelta(deepseekWavePromptColor(DEEPSEEK_WAVE_FRAMES - 1, waveColors), DARK_PALETTE.brand))
      .toBeLessThanOrEqual(8)
  })

  it('glows to the bright crest a few frames AFTER the border crest', () => {
    let peakTick = -1
    let peak = 0
    for (let tick = 0; tick < DEEPSEEK_WAVE_FRAMES; tick += 1) {
      const sum = brightness(deepseekWavePromptColor(tick, waveColors))
      if (sum > peak) {
        peak = sum
        peakTick = tick
      }
    }
    // Trails the border crest (middle frames) so the brightness flows inward.
    expect(peakTick).toBeGreaterThan(Math.floor(DEEPSEEK_WAVE_FRAMES / 2))
    expect(channelDelta(deepseekWavePromptColor(peakTick, waveColors), DARK_PALETTE.brandBright)).toBeLessThanOrEqual(10)
  })
})
