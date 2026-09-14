/** Terminal animation helpers (Codex shimmer + braille StateDot chase), caret blink, and
 * the Codex effort-ignition "Wave" port for the DeepSeek model-switch easter
 * egg: tier mapping, crest/ease/envelope shapes, per-column band sampling,
 * the sparkle frame window, the 0.55 skirt / 0.85 core tint caps, and the
 * Wave/Pulse deviations (mirror-symmetric water surface, true 2-D rings with echoes). */

import { describe, expect, it } from 'vitest'
import { DARK_PALETTE, PALETTES, type RgbTriple } from '../src/theme.ts'
import {
  BUSY_CHASE_FRAMES,
  busyChaseFrame,
  caretVisible,
  crest,
  DEEPSEEK_WAVE_BANDS,
  DEEPSEEK_WAVE_TICK_MS,
  deepseekWaveColumnBg,
  deepseekWaveDuration,
  deepseekWaveSpark,
  deepseekWaveStyleRandom,
  deepseekWaveTier,
  deepseekWaveWordHue,
  deepseekWaveWordVisible,
  DEEP_DIVING_SHIMMER_DURATION_MS,
  DEEP_DIVING_SHIMMER_HALF_WIDTH,
  DEEP_DIVING_SHIMMER_PADDING,
  DEEP_DIVING_SPARK_BREATH_DURATION_MS,
  deepDivingGradientColor,
  deepDivingShimmerIntensity,
  deepDivingSparkIntensity,
  easeInOut,
  effortAboveHigh,
  envelope,
  flowColor,
  FLOW_PERIOD_MS,
  isOfficialDeepSeekLabel,
  parseAnimationsArgument,
  PULSE_ALPHA_CAP,
  RAINBOW_BURST_DURATION_MS,
  RAINBOW_BURST_HUES,
  RAINBOW_BURST_TICK_MS,
  rainbowBurstColumnBg,
  rainbowSpectrumHue,
  parseAnimationsPref,
  SPARK_GLYPHS,
  WAVE_SURFACE_ALPHA_CAP,
  WAVE_SURFACE_AMPLITUDE,
  WAVE_SURFACE_OMEGA,
  WAVE_SURFACE_WAVELENGTH,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from '../src/render/animations.ts'

/** The wave's tint base in production is the composer band — pin fixtures to it. */
const WAVE_BASE_DARK = PALETTES.dark.composerBand
const WAVE_BASE_LIGHT = PALETTES.light.composerBand

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

describe('busyChaseFrame', () => {
  it('rotates the original braille chase clockwise over 8 distinct frames', () => {
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

describe('deepDivingGradientColor', () => {
  const base: RgbTriple = [20, 40, 80]
  const highlight: RgbTriple = [100, 180, 255]

  it('matches Codex timing: two-second sweep, padded edges, and cosine highlight', () => {
    expect(DEEP_DIVING_SHIMMER_DURATION_MS).toBe(2_000)
    expect(DEEP_DIVING_SHIMMER_PADDING).toBe(10)
    expect(DEEP_DIVING_SHIMMER_HALF_WIDTH).toBe(5)
    expect(deepDivingShimmerIntensity(0, 0, 12)).toBe(0)
    expect(deepDivingShimmerIntensity(0, 19, 12)).toBeGreaterThan(0.99)
    expect(deepDivingShimmerIntensity(0, 120, 12)).toBe(0)
    expect(deepDivingShimmerIntensity(0, 0, 12)).toBe(deepDivingShimmerIntensity(0, 120, 12))
    expect(deepDivingShimmerIntensity(0, 19, 12)).toBeGreaterThan(deepDivingShimmerIntensity(0, 10, 12))
    expect(deepDivingShimmerIntensity(0, 19, 12)).toBeGreaterThan(deepDivingShimmerIntensity(0, 30, 12))
  })

  it('blends only between the supplied blue base and highlight', () => {
    for (let tick = 0; tick < 120; tick += 1) {
      const color = deepDivingGradientColor(0, tick, 12, base, highlight)
      for (let channel = 0; channel < 3; channel += 1) {
        expect(color[channel]!).toBeGreaterThanOrEqual(base[channel]!)
        expect(color[channel]!).toBeLessThanOrEqual(highlight[channel]!)
      }
    }
  })

  it('breathes the leading sparkle continuously without turning it off', () => {
    expect(DEEP_DIVING_SPARK_BREATH_DURATION_MS).toBe(2_000)
    expect(deepDivingSparkIntensity(0)).toBeCloseTo(1)
    expect(deepDivingSparkIntensity(10)).toBeLessThan(deepDivingSparkIntensity(0))
    expect(deepDivingSparkIntensity(20)).toBeLessThan(deepDivingSparkIntensity(10))
    expect(deepDivingSparkIntensity(30)).toBeGreaterThanOrEqual(0.2)
    expect(deepDivingSparkIntensity(60)).toBeGreaterThan(0.2)
    expect(deepDivingSparkIntensity(0)).toBeGreaterThanOrEqual(0.2)
    for (let tick = 0; tick < 120; tick += 1) {
      expect(deepDivingSparkIntensity(tick)).toBeGreaterThanOrEqual(0.2)
      expect(deepDivingSparkIntensity(tick)).toBeLessThanOrEqual(1)
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

describe('parseAnimationsPref', () => {
  it('disables animations only on an explicit false', () => {
    expect(parseAnimationsPref(false)).toBe(false)
    expect(parseAnimationsPref(true)).toBe(true)
    expect(parseAnimationsPref(undefined)).toBe(true)
    expect(parseAnimationsPref(null)).toBe(true)
    expect(parseAnimationsPref('off')).toBe(true)
    expect(parseAnimationsPref(0)).toBe(true)
  })
})

describe('parseAnimationsArgument', () => {
  it('toggles on a bare argument and accepts explicit on/off synonyms', () => {
    expect(parseAnimationsArgument('')).toBe('toggle')
    expect(parseAnimationsArgument('  ')).toBe('toggle')
    expect(parseAnimationsArgument('on')).toEqual({ enabled: true })
    expect(parseAnimationsArgument('ON')).toEqual({ enabled: true })
    expect(parseAnimationsArgument(' True ')).toEqual({ enabled: true })
    expect(parseAnimationsArgument('1')).toEqual({ enabled: true })
    expect(parseAnimationsArgument('off')).toEqual({ enabled: false })
    expect(parseAnimationsArgument('OFF')).toEqual({ enabled: false })
    expect(parseAnimationsArgument('false')).toEqual({ enabled: false })
    expect(parseAnimationsArgument('0')).toEqual({ enabled: false })
  })

  it('reports usage for anything else', () => {
    expect(parseAnimationsArgument('banana')).toBe('usage')
    expect(parseAnimationsArgument('2')).toBe('usage')
    expect(parseAnimationsArgument('yes please')).toBe('usage')
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

describe('effortAboveHigh', () => {
  it('accepts only efforts strictly above high', () => {
    expect(effortAboveHigh('xhigh')).toBe(true)
    expect(effortAboveHigh('max')).toBe(true)
    expect(effortAboveHigh('ultra')).toBe(true)
    expect(effortAboveHigh('maximum')).toBe(true)
    expect(effortAboveHigh('very-high')).toBe(true)
  })

  it('rejects high and everything below, plus absent and unknown ids', () => {
    expect(effortAboveHigh('high')).toBe(false)
    expect(effortAboveHigh('medium')).toBe(false)
    expect(effortAboveHigh('med')).toBe(false)
    expect(effortAboveHigh('low')).toBe(false)
    expect(effortAboveHigh('off')).toBe(false)
    expect(effortAboveHigh('')).toBe(false)
    expect(effortAboveHigh(undefined)).toBe(false)
    expect(effortAboveHigh('super-duper')).toBe(false)
  })

  it('matches case-insensitively and trims whitespace', () => {
    expect(effortAboveHigh('MAX')).toBe(true)
    expect(effortAboveHigh('  max  ')).toBe(true)
  })
})

describe('unknown tier (Into the Unknown)', () => {
  it('reuses the deepseek tier bands verbatim for every style', () => {
    expect(DEEPSEEK_WAVE_BANDS.wave.unknown).toEqual(DEEPSEEK_WAVE_BANDS.wave.deepseek)
    expect(DEEPSEEK_WAVE_BANDS.aurora.unknown).toEqual(DEEPSEEK_WAVE_BANDS.aurora.deepseek)
    expect(DEEPSEEK_WAVE_BANDS.pulse.unknown).toEqual(DEEPSEEK_WAVE_BANDS.pulse.deepseek)
  })

  it('runs the deepseek (pro) durations', () => {
    expect(deepseekWaveDuration('unknown', 'wave')).toBe(1500)
    expect(deepseekWaveDuration('unknown', 'aurora')).toBe(1800)
    expect(deepseekWaveDuration('unknown', 'pulse')).toBe(1450)
  })

  it('samples the same per-column wave as the deepseek tier', () => {
    for (const style of ['wave', 'aurora', 'pulse'] as const) {
      for (let tick = 0; tick < 45; tick += 1) {
        for (let column = 0; column < 40; column += 1) {
          expect(deepseekWaveColumnBg(tick, column, 40, 'unknown', style, deepseekHues, WAVE_BASE_DARK))
            .toEqual(deepseekWaveColumnBg(tick, column, 40, 'deepseek', style, deepseekHues, WAVE_BASE_DARK))
        }
      }
    }
  })

  it('shows the wordmark through the same mid-wave window', () => {
    const frames = Math.floor(deepseekWaveDuration('unknown') / DEEPSEEK_WAVE_TICK_MS)
    expect(deepseekWaveWordVisible(0, 'unknown')).toBe(false)
    expect(deepseekWaveWordVisible(frames - 1, 'unknown')).toBe(false)
    expect(deepseekWaveWordVisible(Math.floor(frames / 2), 'unknown')).toBe(true)
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

  it('matches flash only in the model segment, never the provider name', () => {
    expect(deepseekWaveTier('flashai/deepseek-chat')).toBe('deepseek')
    expect(deepseekWaveTier('flashcorp/gpt-x')).toBe('deepseek')
    expect(deepseekWaveTier('FlashCorp/deepseek-v4')).toBe('deepseek')
    expect(deepseekWaveTier('deepseek-official/deepseek-v4-flash')).toBe('flash')
    expect(deepseekWaveTier('deepseek-flash')).toBe('flash')
  })

  it('splits at the FIRST slash, so aggregator ids keep their model tail', () => {
    expect(deepseekWaveTier('openrouter/google/gemini-flash-1.5')).toBe('flash')
    expect(deepseekWaveTier('openrouter/google/gemini-2.5-pro')).toBe('deepseek')
    expect(deepseekWaveTier('openrouter/deepseek/deepseek-chat')).toBe('deepseek')
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

  it('uses the water-surface geometry: full-band wavelength, outward phase speed', () => {
    expect(WAVE_SURFACE_WAVELENGTH).toBe(40)
    expect(WAVE_SURFACE_OMEGA).toBe(9)
    expect(WAVE_SURFACE_AMPLITUDE).toBe(0.8)
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

  it('returns null outside the symmetric fade envelope (start and end transparent)', () => {
    // tick 0: the envelope is closed.
    expect(deepseekWaveColumnBg(0, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(0, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).toBeNull()
    // Late in the fade the surface is still alive (flash sampled 0.853s of
    // 1.0s, deepseek 0.915s of 1.3s)…
    expect(deepseekWaveColumnBg(31, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    expect(deepseekWaveColumnBg(32, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).not.toBeNull()
    // …and null only past each base duration (flash ≥ tick 37, deepseek ≥ 46).
    expect(deepseekWaveColumnBg(37, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(46, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(50, 10, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(50, 10, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)).toBeNull()
  })

  it('spans the full band width from the first plateau frame', () => {
    // tick 14 (0.462s rendered, 0.385s sampled): the fade envelope is at its
    // plateau and the surface line runs edge to edge — every column paints.
    for (const column of [0, 5, 20, 35, 39]) {
      expect(deepseekWaveColumnBg(14, column, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    }
  })

  it('weaves the second deepseek band against the first: it covers cells the single flash band does not', () => {
    // The second DeepSeek band sweeps RIGHT-TO-LEFT while the flash band
    // eases left-to-right, so mid-flight the counter-sweeping band lights
    // cells the flash timeline cannot reach yet — the weave's crossing.
    let woven = false
    for (let tick = 0; tick < 40 && !woven; tick += 1) {
      for (let column = 0; column < width; column += 1) {
        const flash = deepseekWaveColumnBg(tick, column, width, 'flash', 'wave', flashHues, WAVE_BASE_DARK)
        const deepseek = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK)
        if (deepseek !== null && flash === null) woven = true
      }
    }
    expect(woven).toBe(true)
  })

  it('blends the mixed hues toward the blank-cell base inside the soft alpha cap', () => {
    const base = WAVE_BASE_DARK
    for (const tier of ['flash', 'deepseek'] as const) {
      const hues = tier === 'flash' ? flashHues : deepseekHues
      for (let tick = 0; tick < 45; tick += 1) {
        for (let column = 0; column < width; column += 1) {
          for (const row of [0, 1, 2]) {
            const bg = deepseekWaveColumnBg(tick, column, width, tier, 'wave', hues, base, row, 3)
            if (bg === null) continue
            for (let channel = 0; channel < 3; channel += 1) {
              const spread = Math.abs(bg[channel]! - base[channel]!)
              const widestHue = Math.max(...hues.map(hue => Math.abs(hue[channel]! - base[channel]!)))
              expect(spread).toBeLessThanOrEqual(Math.ceil(WAVE_SURFACE_ALPHA_CAP * widestHue) + 1)
            }
          }
        }
      }
    }
  })

  it('keeps the wave color distribution smooth: adjacent columns shift gently', () => {
    // The anti-fragmentation contract: with the hard core line gone and
    // Aurora-wide thickness, neighboring columns (and rows) may only drift
    // a little per step — no sharp brightness cliffs anywhere on the surface.
    for (let tick = 2; tick < 36; tick += 3) {
      for (const row of [0, 1, 2]) {
        let previous = deepseekWaveColumnBg(tick, 0, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, row, 3)
        for (let column = 1; column < width; column += 1) {
          const bg = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, row, 3)
          if (previous !== null && bg !== null) {
            for (let channel = 0; channel < 3; channel += 1) {
              expect(Math.abs(bg[channel]! - previous[channel]!)).toBeLessThanOrEqual(18)
            }
          }
          previous = bg
        }
      }
    }
  })

  it('is mirror-symmetric about the center column on every row', () => {
    // d = |x − 19.5| drives the phase, so columns 19−j and 20+j sample the
    // exact same surface point — the center symmetry the design promises.
    for (let tick = 2; tick < 40; tick += 3) {
      for (let j = 0; j < 20; j += 1) {
        for (const row of [0, 1, 2]) {
          const left = deepseekWaveColumnBg(tick, 19 - j, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, row, 3)
          const right = deepseekWaveColumnBg(tick, 20 + j, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, row, 3)
          expect(left).toEqual(right)
        }
      }
    }
  })

  it('undulates the wave: band rows diverge as the snake weaves across them', () => {
    let rowsDiverge = false
    let topLights = false
    let bottomLights = false
    for (let tick = 0; tick < 45; tick += 1) {
      for (let column = 0; column < width; column += 1) {
        const top = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, 0, 3)
        const middle = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, 1, 3)
        const bottom = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'wave', deepseekHues, WAVE_BASE_DARK, 2, 3)
        if (top !== null && middle === null) rowsDiverge = true
        if (middle !== null && top === null) rowsDiverge = true
        if (bottom !== null && middle === null) rowsDiverge = true
        if (top !== null) topLights = true
        if (bottom !== null) bottomLights = true
      }
    }
    expect(rowsDiverge).toBe(true)
    expect(topLights).toBe(true)
    expect(bottomLights).toBe(true)
  })

  it('keeps the pulse inside the soft alpha cap like the swell and aurora', () => {
    // The detonation is a notch punchier than the swell but stays in the
    // same Aurora-grade family: every painted cell within the mixed-hue
    // spread at the pulse cap — no brightness spikes beyond the palette.
    const base = WAVE_BASE_DARK
    for (const tier of ['flash', 'deepseek'] as const) {
      const hues = tier === 'flash' ? flashHues : deepseekHues
      for (let tick = 0; tick < 46; tick += 1) {
        for (let column = 0; column < width; column += 1) {
          const bg = deepseekWaveColumnBg(tick, column, width, tier, 'pulse', hues, base, 2, 5)
          if (bg === null) continue
          for (let channel = 0; channel < 3; channel += 1) {
            const spread = Math.abs(bg[channel]! - base[channel]!)
            const widestHue = Math.max(...hues.map(hue => Math.abs(hue[channel]! - base[channel]!)))
            expect(spread).toBeLessThanOrEqual(Math.ceil(PULSE_ALPHA_CAP * widestHue) + 1)
          }
        }
      }
    }
  })

  it('draws the pulse ring symmetric around the band center', () => {
    for (let tick = 4; tick < 30; tick += 2) {
      for (let offset = 1; offset <= 10; offset += 1) {
        const left = deepseekWaveColumnBg(tick, 20 - offset, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK, 2, 5)
        const right = deepseekWaveColumnBg(tick, 20 + offset, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK, 2, 5)
        expect(left).toEqual(right)
      }
    }
  })

  it('curves the pulse ring: the hole opens at the center row first', () => {
    // On a 5-row band (rows=5), the ring around the band's center cell leaves
    // the exact center column unpainted while the outer rows — whose distance
    // from the ring's origin includes the row offset — still paint it. That
    // curvature is what makes the ring read as a circle instead of bars.
    let holeFirstAtCenter = false
    for (let tick = 3; tick < 32; tick += 1) {
      const atCenterRow = deepseekWaveColumnBg(tick, 20, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK, 2, 5)
      const atOuterRow = deepseekWaveColumnBg(tick, 20, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK, 0, 5)
      if (atCenterRow === null && atOuterRow !== null) holeFirstAtCenter = true
    }
    expect(holeFirstAtCenter).toBe(true)
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

describe('deepseekWaveColumnBg three-row band geometry', () => {
  const width = 40

  it('keeps the middle row of three on the shared timeline (aurora)', () => {
    for (const column of [0, 5, 12, 20, 30, 39]) {
      expect(deepseekWaveColumnBg(20, column, width, 'deepseek', 'aurora', deepseekHues, WAVE_BASE_DARK, 1, 3))
        .toEqual(deepseekWaveColumnBg(20, column, width, 'deepseek', 'aurora', deepseekHues, WAVE_BASE_DARK))
    }
  })

  it('scales the pulse span with the band diagonal, so taller bands ring farther', () => {
    let spanDiffers = false
    for (let tick = 0; tick < 30 && !spanDiffers; tick += 1) {
      for (const column of [4, 10, 20, 30, 36]) {
        const singleRow = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'pulse', deepseekHues, WAVE_BASE_DARK)
        const centerOfThree = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'pulse', deepseekHues, WAVE_BASE_DARK, 1, 3)
        if (singleRow !== centerOfThree) spanDiffers = true
      }
    }
    expect(spanDiffers).toBe(true)
  })

  it('aurora alone cascades down the band', () => {
    let auroraDiffers = false
    for (let tick = 0; tick < 40 && !auroraDiffers; tick += 1) {
      for (let column = 0; column < width; column += 1) {
        const top = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'aurora', deepseekHues, WAVE_BASE_DARK, 0, 3)
        const bottom = deepseekWaveColumnBg(tick, column, width, 'deepseek', 'aurora', deepseekHues, WAVE_BASE_DARK, 2, 3)
        if (top !== bottom) auroraDiffers = true
      }
    }
    expect(auroraDiffers).toBe(true)
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

  it('Pulse expands a 2-D ring that dissolves through its fade envelope', () => {
    const center = Math.floor(width / 2)
    // Early pulse (tick 4 ≈ 0.108s sampled, flash launch 0.10 travel 0.60):
    // the radius is ≈1 column, so the cells right beside the center paint…
    expect(deepseekWaveColumnBg(4, center - 2, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    expect(deepseekWaveColumnBg(4, center + 2, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    // …tick 9 (≈0.244s, radius ≈8): the ring and its inner edge have both
    // cleared the exact center — it sits in the hole while the band paints
    // farther out.
    expect(deepseekWaveColumnBg(9, center, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).toBeNull()
    expect(deepseekWaveColumnBg(6, center + 5, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    // The envelope keeps the ring alive (still expanding, fading) well past
    // the old travel end…
    expect(deepseekWaveColumnBg(25, center + 12, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).not.toBeNull()
    // …and null only once the base duration closes (flash 0.9s ≈ tick 34).
    expect(deepseekWaveColumnBg(34, center, width, 'flash', 'pulse', flashHues, WAVE_BASE_DARK)).toBeNull()
  })
})

describe('prismatic flow', () => {
  const [violet, fuchsia, cyan]: readonly RgbTriple[] = [[139, 92, 246], [232, 121, 249], [34, 211, 238]]
  const anchors: readonly RgbTriple[] = [violet, fuchsia, cyan]

  it('hits each anchor exactly at its segment boundary', () => {
    expect(flowColor(0, anchors)).toEqual(violet)
    expect(flowColor(FLOW_PERIOD_MS / 3, anchors)).toEqual(fuchsia)
    expect(flowColor(2 * FLOW_PERIOD_MS / 3, anchors)).toEqual(cyan)
  })

  it('wraps continuously at the period and across negative elapsed time', () => {
    expect(flowColor(FLOW_PERIOD_MS, anchors)).toEqual(violet)
    expect(flowColor(FLOW_PERIOD_MS + 1, anchors)).toEqual(flowColor(1, anchors))
    expect(flowColor(-2 * FLOW_PERIOD_MS / 3, anchors)).toEqual(fuchsia)
  })

  it('interpolates with the smoothstep curve between anchors', () => {
    // Segment midpoint: eased 0.5 → the plain average of the two anchors.
    expect(flowColor(FLOW_PERIOD_MS / 6, anchors)).toEqual([186, 107, 248])
    const early = flowColor(200, anchors)
    const mid = flowColor(FLOW_PERIOD_MS / 6, anchors)
    const late = flowColor(600, anchors)
    // The red channel rises monotonically from violet toward fuchsia…
    expect(early[0]).toBeGreaterThan(violet[0])
    expect(mid[0]).toBeGreaterThan(early[0])
    expect(late[0]).toBeGreaterThan(mid[0])
    // …and the eased step at the quarter point stays under linear.
    expect(early[0]).toBeLessThan(violet[0] + (fuchsia[0] - violet[0]) * 0.25)
  })

  it('passes a single anchor through and rejects an empty triangle', () => {
    expect(flowColor(123, [violet])).toEqual(violet)
    expect(() => flowColor(0, [])).toThrow()
  })
})

describe('rainbow composer burst', () => {
  const base: RgbTriple = [46, 46, 52]
  const midTick = Math.floor(RAINBOW_BURST_DURATION_MS / 2 / RAINBOW_BURST_TICK_MS)

  it('pins seven fixed spectrum hues, independent of the rolled palette', () => {
    expect(RAINBOW_BURST_HUES).toHaveLength(7)
    expect(rainbowSpectrumHue(0)).toEqual(RAINBOW_BURST_HUES[0])
    // A position just below 1 sits on the last→first blend, not past the wrap.
    expect(rainbowSpectrumHue(0.99)[0]).toBeGreaterThan(200)
  })

  it('returns null before and after the burst window', () => {
    expect(rainbowBurstColumnBg(-1, 0, 80, base, 1, 3)).toBeNull()
    const last = Math.ceil(RAINBOW_BURST_DURATION_MS / RAINBOW_BURST_TICK_MS)
    expect(rainbowBurstColumnBg(last, 0, 80, base, 1, 3)).toBeNull()
  })

  it('paints a sliding ribbon: the same column changes hue as the burst advances', () => {
    const early = rainbowBurstColumnBg(8, 10, 80, base, 1, 3)
    const later = rainbowBurstColumnBg(midTick, 10, 80, base, 1, 3)
    expect(early).not.toBeNull()
    expect(later).not.toBeNull()
    expect(early).not.toEqual(later)
  })

  it('keeps a column the same hue across the three band rows (solid ribbon)', () => {
    const top = rainbowBurstColumnBg(midTick, 20, 80, base, 0, 3)
    const mid = rainbowBurstColumnBg(midTick, 20, 80, base, 1, 3)
    const bot = rainbowBurstColumnBg(midTick, 20, 80, base, 2, 3)
    expect(top).not.toBeNull()
    expect(mid).not.toBeNull()
    expect(bot).not.toBeNull()
    // Edge rows are dimmer (more of the band base) but stay the same hue family:
    // red channel of the middle crest is the highest.
    expect(mid![0]).toBeGreaterThanOrEqual(top![0])
    expect(mid![0]).toBeGreaterThanOrEqual(bot![0])
  })
})
