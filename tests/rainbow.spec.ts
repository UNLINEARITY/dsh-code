/** The rainbow roll: determinism, adjacency, and AA over the bright pool. */

import { describe, expect, it } from 'vitest'
import { RAINBOW_POOL, parseRainbowArgument, parseRainbowSeed, rainbowRoll, rainbowSeedLabel, rerollRainbow, rollRainbow } from '../src/rainbow.ts'
import type { StatusTone } from '../src/render/status.ts'
import type { RgbTriple } from '../src/theme.ts'

const channel = (value: number): number => {
  const s = value / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (rgb: RgbTriple): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
const ratio = (fg: RgbTriple, bg: RgbTriple): number => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}
const BLACK: RgbTriple = [0, 0, 0]
const hueOf = ([r, g, b]: RgbTriple): number => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const span = max - min
  if (max === r) return (60 * (g - b) / span + 360) % 360
  if (max === g) return (60 * (b - r) / span + 120) % 360
  return (60 * (r - g) / span + 240) % 360
}

/** Canonical on-screen tone order (mirrors rainbow.ts TONE_ORDER). */
const TONE_ORDER: readonly StatusTone[] = [
  'live', 'model', 'path', 'branch', 'accent',
  'value', 'label', 'meta', 'ctxFill', 'success', 'plan', 'warn', 'error',
]

describe('rainbow roll', () => {
  it('is deterministic for a fixed seed and differs across seeds', () => {
    expect(rollRainbow(12345)).toEqual(rollRainbow(12345))
    expect(rollRainbow(12345).palette).not.toEqual(rollRainbow(12346).palette)
  })

  it('keeps every palette token a valid RGB triple', () => {
    for (const value of Object.values(rollRainbow(777).palette)) {
      expect(value).toHaveLength(3)
      for (const sample of value) {
        expect(Number.isInteger(sample)).toBe(true)
        expect(sample).toBeGreaterThanOrEqual(0)
        expect(sample).toBeLessThanOrEqual(255)
      }
    }
  })

  it('keeps the whole pool AA-legible on black', () => {
    for (const hue of RAINBOW_POOL) {
      expect(ratio(hue, BLACK)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps diff foregrounds AA on their rolled tints across seeds', () => {
    for (let seed = 0; seed < 24; seed += 1) {
      const { palette } = rollRainbow(seed)
      expect(ratio(palette.diffAddFg, palette.diffAdd)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(palette.diffDelFg, palette.diffDel)).toBeGreaterThanOrEqual(4.5)
      // The tint stays dark enough that body text survives on it too.
      expect(ratio(palette.text, palette.diffAdd)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(palette.text, palette.diffDel)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('never maps adjacent status tones to the same color (row boundary included)', () => {
    for (let seed = 0; seed < 24; seed += 1) {
      const { toneColors } = rollRainbow(seed)
      for (let i = 1; i < TONE_ORDER.length; i += 1) {
        expect(toneColors[TONE_ORDER[i]]).not.toEqual(toneColors[TONE_ORDER[i - 1]])
      }
    }
  })

  it('never paints live and error the same color', () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const { toneColors } = rollRainbow(seed)
      expect(toneColors.live).not.toEqual(toneColors.error)
      expect(toneColors.error).not.toEqual(toneColors.warn)
    }
  })

  it('rolls a four-color ring of distinct pool hues', () => {
    const { ring } = rollRainbow(4242)
    expect(ring).toHaveLength(4)
    expect(new Set(ring.map(color => color.join(','))).size).toBe(4)
    for (const hue of ring) expect(RAINBOW_POOL).toContainEqual(hue)
  })

  it('walks the flow anchors in spectral order with an in-lap phase', () => {
    const { flowAnchors, flowPhaseMs } = rollRainbow(99)
    expect(flowAnchors).toHaveLength(RAINBOW_POOL.length)
    const hues = flowAnchors.map(hueOf)
    for (let i = 1; i < hues.length; i += 1) {
      expect(hues[i]).toBeGreaterThanOrEqual(hues[i - 1])
    }
    expect(flowPhaseMs).toBeGreaterThanOrEqual(0)
    expect(flowPhaseMs).toBeLessThan(2400)
  })

  it('parses RAINBOW_SEED values with a strict fallback', () => {
    expect(parseRainbowSeed('12345')).toBe(12345)
    expect(parseRainbowSeed(' 42 ')).toBe(42)
    expect(parseRainbowSeed('0')).toBe(0)
    expect(parseRainbowSeed('abc')).toBeUndefined()
    expect(parseRainbowSeed('-1')).toBeUndefined()
    expect(parseRainbowSeed('12345678901')).toBeUndefined()
    expect(parseRainbowSeed(undefined)).toBeUndefined()
  })

  it('parses /rainbow arguments: empty is random, a uint32 pins, else usage', () => {
    expect(parseRainbowArgument('')).toBe('random')
    expect(parseRainbowArgument('  ')).toBe('random')
    expect(parseRainbowArgument('42')).toEqual({ seed: 42 })
    expect(parseRainbowArgument(' 0 ')).toEqual({ seed: 0 })
    expect(parseRainbowArgument('banana')).toBe('usage')
    expect(parseRainbowArgument('-1')).toBe('usage')
    expect(parseRainbowArgument('12 34')).toBe('usage')
  })

  it('replaces the memoized roll when rerollRainbow pins a seed', () => {
    const pinned = rerollRainbow(4242)
    expect(pinned).toEqual(rollRainbow(4242))
    expect(rainbowRoll()).toBe(pinned)
    const again = rerollRainbow(4242)
    expect(again).toEqual(pinned)
    expect(rainbowRoll()).toBe(again)
    const other = rerollRainbow(7)
    expect(other.palette).not.toEqual(pinned.palette)
    expect(rainbowRoll()).toBe(other)
  })
})

describe('rainbowSeedLabel', () => {
  it('renders the pinned current roll seed and updates after a reroll', () => {
    rerollRainbow(4242)
    expect(rainbowSeedLabel()).toBe('4242')
    rerollRainbow(7)
    expect(rainbowSeedLabel()).toBe('7')
  })
})
