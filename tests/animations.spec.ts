/** Terminal animation frames (web StateDot pulse + chase), caret blink, and
 * the Codex effort-ignition "Wave" port for the DeepSeek model-switch easter
 * egg: tier mapping, crest/ease/envelope shapes, per-column band sampling,
 * the sparkle frame window, and the ≤0.55 background tint cap. */

import { describe, expect, it } from 'vitest'
import { DARK_PALETTE, type RgbTriple } from '../src/theme.ts'
import {
  BUSY_CHASE_FRAMES,
  busyChaseFrame,
  caretVisible,
  crest,
  DEEPSEEK_WAVE_BANDS,
  DEEPSEEK_WAVE_TICK_MS,
  deepseekWaveBorderColor,
  deepseekWaveColumnBg,
  deepseekWaveDuration,
  deepseekWaveSpark,
  deepseekWaveStyleRandom,
  deepseekWaveTier,
  deepseekWaveWordHue,
  deepseekWaveWordVisible,
  easeInOut,
  envelope,
  isOfficialDeepSeekLabel,
  pulseFrame,
  SPARK_GLYPHS,
  WAVE_BASE_DARK,
  WAVE_BASE_LIGHT,
  WAVE_HALF_WIDTH,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from '../src/render/animations.ts'

/** Dark-theme tier hues the wave interpolates in production by default. The
 * Wave style samples hues[0] only (Codex Wave bands carry no hue index). */
const flashHues: [RgbTriple, RgbTriple, RgbTriple] = [
  DARK_PALETTE.brandBright,
  DARK_PALETTE.brand,
  DARK_PALETTE.brandMid,
]
const deepseekHues: [RgbTriple, RgbTriple, RgbTriple] = [
  DARK_PALETTE.brandBright,
  DARK_PALETTE.code,
  DARK_PALETTE.brandMid,
]

/** Max per-channel distance between two triples. */
function channelDelta(a: RgbTriple, b: RgbTriple): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
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

describe('deepseekWaveTier', () => {
  it('maps flash model ids to the flash tier (Wave-Max) and everything else to deepseek (Wave-Ultra)', () => {
    expect(deepseekWaveTier('deepseek-official/deepseek-v4-flash')).toBe('flash')
    expect(deepseekWaveTier('acme/deepseek-v4-flash')).toBe('flash')
    expect(deepseekWaveTier('DeepSeek-Official/DeepSeek-V4-Flash')).toBe('flash')
  })

  it('routes pro/reasoner/chat models to the deepseek tier', () => {
    expect(deepseekWaveTier('deepseek-official/deepseek-reasoner')).toBe('deepseek')
    expect(deepseekWaveTier('deepseek-official/deepseek-chat')).toBe('deepseek')
    expect(deepseekWaveTier('deepseek/deepseek-chat')).toBe('deepseek')
    expect(deepseekWaveTier('deepseek-official/deepseek-v4')).toBe('deepseek')
  })
})

describe('deepseekWaveDuration', () => {
  it('extends the Codex Wave duration by 200ms for readability', () => {
    expect(deepseekWaveDuration('flash')).toBe(1200)
    expect(deepseekWaveDuration('deepseek')).toBe(1500)
  })

  it('runs at the Codex IGNITION_FRAME_TICK of 33ms (~30fps)', () => {
    expect(DEEPSEEK_WAVE_TICK_MS).toBe(33)
  })

  it('carries the Codex Wave band tables: one band for flash, two offset bands for deepseek', () => {
    expect(DEEPSEEK_WAVE_BANDS.wave.flash).toEqual([[0.10, 0.75, 1.0]])
    expect(DEEPSEEK_WAVE_BANDS.wave.deepseek).toEqual([[0.10, 0.70, 1.0], [0.35, 0.55, 1.0]])
  })

  it('uses the Codex WAVE_HALF_WIDTH of 9 columns', () => {
    expect(WAVE_HALF_WIDTH).toBe(9)
  })
})

describe('crest', () => {
  it('is a cosine window peaking at 1 under the center and reaching 0 at one half-width', () => {
    expect(crest(0)).toBeCloseTo(1)
    expect(crest(0.5)).toBeCloseTo(0.5)
    expect(crest(1)).toBe(0)
    expect(crest(1.5)).toBe(0)
    expect(crest(-0.5)).toBeCloseTo(0.5)
    expect(crest(-1)).toBe(0)
  })
})

describe('easeInOut', () => {
  it('is a cubic ease-in-out: flat at both ends, steepest at the middle, symmetric', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(0.25)).toBeCloseTo(1 - easeInOut(0.75))
    // Below the inflection the cubic is steeper than linear, above it flatter.
    expect(easeInOut(0.25)).toBeLessThan(0.25)
    expect(easeInOut(0.75)).toBeGreaterThan(0.75)
  })

  it('clamps out-of-range progress', () => {
    expect(easeInOut(-1)).toBe(0)
    expect(easeInOut(2)).toBe(1)
  })
})

describe('envelope', () => {
  it('ramps in over fadeIn, plateaus, then ramps out over fadeOut', () => {
    expect(envelope(0, 1, 0.2, 0.3)).toBe(0)
    expect(envelope(1, 1, 0.2, 0.3)).toBe(0)
    expect(envelope(0.1, 1, 0.2, 0.3)).toBeCloseTo(0.5)
    expect(envelope(0.5, 1, 0.2, 0.3)).toBe(1)
    expect(envelope(0.85, 1, 0.2, 0.3)).toBeCloseTo(0.5)
  })
})

describe('deepseekWaveColumnBg', () => {
  const width = 40

  it('returns null before the launch and after the travel (start and end transparent)', () => {
    // tick 0: before the first band launches.
    expect(deepseekWaveColumnBg(0, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(0, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).toBeNull()
    // The original 0.85s/0.90s travel ends at about 1.02s/1.04s after stretching.
    expect(deepseekWaveColumnBg(31, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(32, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).toBeNull()
    // Well past both extended durations the row stays transparent too.
    expect(deepseekWaveColumnBg(50, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(50, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).toBeNull()
  })

  it('sweeps one eased crest across the row: paints near the center, not the far edge', () => {
    // tick 14 (0.462s rendered, 0.385s sampled): the flash crest sits near the left.
    expect(deepseekWaveColumnBg(14, 5, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    expect(deepseekWaveColumnBg(14, 0, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    expect(deepseekWaveColumnBg(14, 39, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
  })

  it('deepseek stacks the offset second band: it paints the row tail flash already left', () => {
    // tick 20 (0.660s rendered): flash samples 0.550s while deepseek samples
    // 0.572s. The offset second DeepSeek band still holds a far-left crest.
    expect(deepseekWaveColumnBg(20, 2, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(20, 2, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).not.toBeNull()
    // The first DeepSeek band overlaps the right half at the same frame.
    expect(deepseekWaveColumnBg(20, 40, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).not.toBeNull()
  })

  it('blends hue 0 (the tier accent) toward the blank-cell base, never above the 55% cap', () => {
    const hue = flashHues[0]!
    const base = WAVE_BASE_DARK
    for (const tier of ['flash', 'deepseek'] as const) {
      const hues = tier === 'flash' ? flashHues : deepseekHues
      for (let tick = 0; tick < 45; tick += 1) {
        for (let column = 0; column < width; column += 1) {
          const bg = deepseekWaveColumnBg(tick, column, width, tier, 'wave', hues, base)
          if (bg === null) continue
          for (let channel = 0; channel < 3; channel += 1) {
            const spread = Math.abs(bg[channel]! - base[channel]!)
            const hueSpread = Math.abs(hue[channel]! - base[channel]!)
            // alpha = weight * 0.55 ≤ 0.55; +1 covers the rounding of blendRgb.
            expect(spread).toBeLessThanOrEqual(Math.ceil(hueSpread * 0.55) + 1)
          }
        }
      }
    }
  })

  it('mixes hue 0 only (Codex Wave bands carry no hue index)', () => {
    // tick 20 column 2 on the stretched deepseek timeline samples the original
    // motion at 0.572s. The color must still use hues[0] only.
    const tick = 20
    const sampledElapsed = tick * DEEPSEEK_WAVE_TICK_MS * 1300 / 1500 / 1000
    const strength = crest(Math.abs(2 - (easeInOut((sampledElapsed - 0.35) / 0.55) * (width + 2 * WAVE_HALF_WIDTH) - WAVE_HALF_WIDTH)) / WAVE_HALF_WIDTH)
    const alpha = strength * 0.55
    expect(strength).toBeGreaterThan(0.5)
    const bg = deepseekWaveColumnBg(tick, 2, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)
    expect(bg).not.toBeNull()
    const expected: RgbTriple = [
      Math.round(flashHues[0]![0] * alpha + WAVE_BASE_DARK[0] * (1 - alpha)),
      Math.round(flashHues[0]![1] * alpha + WAVE_BASE_DARK[1] * (1 - alpha)),
      Math.round(flashHues[0]![2] * alpha + WAVE_BASE_DARK[2] * (1 - alpha)),
    ]
    expect(channelDelta(bg!, expected)).toBe(0)
  })

  it('keeps the light-theme base near-white', () => {
    const bg = deepseekWaveColumnBg(12, 5, width, 'flash', 'wave', flashHues, WAVE_BASE_LIGHT)
    expect(bg).not.toBeNull()
    for (let channel = 0; channel < 3; channel += 1) {
      expect(bg![channel]!).toBeGreaterThan(WAVE_BASE_LIGHT[channel]! - 160)
    }
  })
})

describe('deepseekWaveSpark', () => {
  it('stretches the sparkle window with the longer DeepSeek Wave timeline', () => {
    expect(deepseekWaveSpark(31)).toBeNull() // 1023ms rendered, 887ms sampled
    expect(deepseekWaveSpark(42)).toBeNull() // 1386ms rendered, 1201ms sampled
  })

  it('steps · ✦ ✧ across the proportionally slowed tail', () => {
    expect(SPARK_GLYPHS).toEqual(['·', '✦', '✧'])
    expect(deepseekWaveSpark(32)).toBe('·') // 1056ms rendered
    expect(deepseekWaveSpark(34)).toBe('·') // 1122ms rendered
    expect(deepseekWaveSpark(35)).toBe('✦') // 1155ms rendered
    expect(deepseekWaveSpark(38)).toBe('✦') // 1254ms rendered
    expect(deepseekWaveSpark(39)).toBe('✧') // 1287ms rendered
    expect(deepseekWaveSpark(41)).toBe('✧') // 1353ms rendered
  })
})

describe('deepseekWaveBorderColor', () => {
  it('glows with the tier accent from the first frame (a 0.25 floor) and peaks mid-wave', () => {
    const dim = DARK_PALETTE.dim
    // tick 0: the border is already 25% toward the accent (visible, not dim).
    const start = deepseekWaveBorderColor(0, 'deepseek', 'wave', flashHues, dim)
    expect(channelDelta(start, dim)).toBeGreaterThan(8)
    // Mid-wave the glow is at its brightest (0.25 + 0.6 = 0.85 toward accent).
    const accent = flashHues[0]
    const mid = Math.floor(deepseekWaveDuration('deepseek', 'wave') / DEEPSEEK_WAVE_TICK_MS / 2)
    const color = deepseekWaveBorderColor(mid, 'deepseek', 'wave', flashHues, dim)
    expect(channelDelta(color, accent)).toBeLessThan(channelDelta(start, accent))
    // Every channel stays inside the dim→accent span.
    for (let channel = 0; channel < 3; channel += 1) {
      const low = Math.min(dim[channel], accent[channel])
      const high = Math.max(dim[channel], accent[channel])
      expect(color[channel]).toBeGreaterThanOrEqual(low)
      expect(color[channel]).toBeLessThanOrEqual(high)
    }
  })
})

describe('deepseekWaveWordVisible', () => {
  it('is hidden at both ends and surfaces through the middle of the wave', () => {
    expect(deepseekWaveWordVisible(0, 'deepseek')).toBe(false)
    const frames = Math.floor(deepseekWaveDuration('deepseek') / DEEPSEEK_WAVE_TICK_MS)
    expect(deepseekWaveWordVisible(frames - 1, 'deepseek')).toBe(false)
    const mid = Math.floor(frames / 2)
    expect(deepseekWaveWordVisible(mid, 'deepseek')).toBe(true)
    const flashFrames = Math.floor(deepseekWaveDuration('flash') / DEEPSEEK_WAVE_TICK_MS)
    expect(deepseekWaveWordVisible(Math.floor(flashFrames / 2), 'flash')).toBe(true)
  })
})

describe('deepseekWaveWordHue', () => {
  it('cycles the tier hues per character', () => {
    expect(deepseekWaveWordHue(0, flashHues)).toBe(flashHues[0])
    expect(deepseekWaveWordHue(1, flashHues)).toBe(flashHues[1])
    expect(deepseekWaveWordHue(2, flashHues)).toBe(flashHues[2])
    expect(deepseekWaveWordHue(3, flashHues)).toBe(flashHues[0])
  })
})

describe('deepseekWaveStyleRandom', () => {
  it('never repeats the previous style', () => {
    const previous = 'wave'
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const style = deepseekWaveStyleRandom(previous)
      expect(style).not.toBe(previous)
      expect(['wave', 'aurora', 'pulse']).toContain(style)
    }
  })
})

describe('three ignition styles', () => {
  const width = 40

  it('carries the Codex band tables for Aurora and Pulse with their own shapes', () => {
    expect(DEEPSEEK_WAVE_BANDS.aurora.flash).toHaveLength(2)
    expect(DEEPSEEK_WAVE_BANDS.aurora.deepseek).toHaveLength(3)
    expect(DEEPSEEK_WAVE_BANDS.pulse.flash).toHaveLength(1)
    expect(DEEPSEEK_WAVE_BANDS.pulse.deepseek).toHaveLength(2)
  })

  it('adds 200ms to every Codex per-style duration', () => {
    expect(deepseekWaveDuration('flash', 'wave')).toBe(1200)
    expect(deepseekWaveDuration('deepseek', 'wave')).toBe(1500)
    expect(deepseekWaveDuration('flash', 'aurora')).toBe(1500)
    expect(deepseekWaveDuration('deepseek', 'aurora')).toBe(1800)
    expect(deepseekWaveDuration('flash', 'pulse')).toBe(1100)
    expect(deepseekWaveDuration('deepseek', 'pulse')).toBe(1450)
  })

  it('Aurora paints a drifting band that blends multiple hues (weights sum, not max)', () => {
    // Mid-flight Aurora: some column should carry a mixed hue that is NOT a
    // pure hue-0 blend — the sum-weighted mix makes weights[1] visible.
    let mixedSeen = false
    for (let tick = 5; tick < 30; tick += 1) {
      for (let column = 0; column < width; column += 1) {
        const bg = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'aurora', deepseekHues, WAVE_BASE_DARK)
        if (bg === null) continue
        // With only hue 0 weighted, the mix equals a hue0→base blend; any
        // deviation proves hue 1 participated.
        const expected: RgbTriple = [
          Math.round(deepseekHues[0]![0] * 0.5 + WAVE_BASE_DARK[0] * 0.5),
          Math.round(deepseekHues[0]![1] * 0.5 + WAVE_BASE_DARK[1] * 0.5),
          Math.round(deepseekHues[0]![2] * 0.5 + WAVE_BASE_DARK[2] * 0.5),
        ]
        if (channelDelta(bg, expected) > 0) { mixedSeen = true; break }
      }
      if (mixedSeen) break
    }
    expect(mixedSeen).toBe(true)
  })

  it('Pulse expands a ring from the row center with decaying strength', () => {
    // Early pulse (tick 4 = 0.132s, flash launch 0.10 travel 0.60): the ring
    // radius ≈ 4.4 columns, so the cells around center ± radius paint while
    // the exact center (distance 0) stays inside the ring's hole.
    const center = Math.floor(width / 2)
    expect(deepseekWaveColumnBg(4, center - 4, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    expect(deepseekWaveColumnBg(4, center + 4, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    // After the pulse travel (flash 0.10..0.70 → 0.70s ≈ tick 22) nothing paints.
    expect(deepseekWaveColumnBg(25, center, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).toBeNull()
  })
})
