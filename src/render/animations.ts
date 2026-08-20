/**
 * Terminal animation frame tables derived from the web design language:
 * the StateDot "ongoing" pixel chase (3×3 ring, 125ms flat-hold brightness
 * steps, 1s cycle) becomes the full-ring clockwise braille chase in
 * {@link BUSY_CHASE_FRAMES}, and the streaming caret blink is the
 * Claude-Code convention.
 *
 * The DeepSeek model-switch easter egg ports Codex's effort-ignition "Wave"
 * style (`codex-rs/tui/src/bottom_pane/effort_ignition_styles.rs`): switching
 * INTO an official DeepSeek route sweeps a blue wave across the composer's
 * input row — one column per cell, `backgroundColor` = the sampled wave
 * color — then, on the deepseek (Ultra-equivalent) tier, drops the `· ✦ ✧`
 * sparkle sequence into the rightmost blank cell before fading. The prompt
 * marker keeps the tier accent afterwards (persistent, like Codex's prompt
 * charge). Pure functions only — the Ink layer owns timers and colors.
 *
 * @module @deepseek-ai/dsh-code/render/animations
 */

import type { RgbTriple } from '../theme.ts'

/**
 * The web StateDot "ongoing" chase in terminal form: three cells of the 3×3
 * ring trail clockwise around the eight outer positions, one braille glyph
 * per step — 8 frames × 125ms = the web's 1s cycle.
 */
export const BUSY_CHASE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const

/** Chase frame for a monotonic tick (the busy composer/Deep-diving marker). */
export function busyChaseFrame(tick: number): string {
  return BUSY_CHASE_FRAMES[tick % BUSY_CHASE_FRAMES.length] ?? BUSY_CHASE_FRAMES[0]
}

/** Caret visibility: half the ticks on, half off (530ms blink). */
export function caretVisible(tick: number): boolean {
  return tick % 2 === 0
}

/**
 * The one-shot DeepSeek model-switch easter egg: when the status bar model
 * label switches to an official DeepSeek route, the composer's input row
 * plays Codex's effort-ignition "Wave" — a blue crest sweeping the content
 * row column by column (background tint ≤ 0.55 under the draft), plus the
 * Ultra-style `· ✦ ✧` sparkles on the deepseek tier — and the prompt marker
 * keeps the tier accent afterwards. The Ink layer owns the timer and reads
 * the ACTIVE palette anchors (`getPalette`); everything below is pure
 * interpolation over the colors it is given.
 */

/** Frame cadence of the DeepSeek wave: Codex's IGNITION_FRAME_TICK (33ms ≈ 30fps). */
export const DEEPSEEK_WAVE_TICK_MS = 33

/**
 * The DeepSeek wave tiers. The concept maps Codex's reasoning tiers to
 * model ids: `flash` runs the Max parameters, `deepseek` (pro models) runs
 * the Ultra parameters (dual band + tail sparkles on the Wave style).
 * `unknown` is the "Into the Unknown" variant: it reuses the deepseek tier's
 * exact parameters (dual band, durations, sparkles) for NON-DeepSeek models
 * running a reasoning effort above high — the wordmark renders differently
 * but the motion is identical.
 */
export type DeepseekWaveTier = 'flash' | 'deepseek' | 'unknown'

/**
 * The three ignition styles — Codex `IgnitionStyle`: a traveling crest
 * (Wave), a drifting multi-hue band (Aurora), and an expanding ring (Pulse).
 * One style is picked at random per trigger and never repeats the previous.
 */
export type DeepseekWaveStyle = 'wave' | 'aurora' | 'pulse'

/** All styles in canonical order, for random selection. */
const DEEPSEEK_WAVE_STYLES: readonly DeepseekWaveStyle[] = ['wave', 'aurora', 'pulse']

/** Wave half-width in columns — Codex WAVE_HALF_WIDTH (9). */
export const WAVE_HALF_WIDTH = 9

/** Pulse ring half-width in columns — Codex PULSE_HALF_WIDTH (4.5). */
const PULSE_HALF_WIDTH = 4.5

/** Sparkle start and frame cadence — Codex SPARK_START / SPARK_FRAME. */
const SPARK_START_MS = 900
const SPARK_FRAME_MS = 100

/** Sparkle glyphs in frame order — Codex SPARK_GLYPHS (`· ✦ ✧`). */
export const SPARK_GLYPHS = ['·', '✦', '✧'] as const

/**
 * Band tables — Codex `bands(style, tier)`. Each entry is a triple whose
 * meaning depends on the style: Wave/Pulse use `(launch, travel, strength)`;
 * Aurora uses `(speed, phase, hueIndex)`.
 */
export type DeepseekWaveBand = readonly [number, number, number]
export const DEEPSEEK_WAVE_BANDS: Readonly<Record<DeepseekWaveStyle, Readonly<Record<DeepseekWaveTier, readonly DeepseekWaveBand[]>>>> = {
  wave: {
    // Wave-Max: one band sweeping 0.10s..0.85s.
    flash: [[0.10, 0.75, 1.0]],
    // Wave-Ultra: two offset bands for a richer crest.
    deepseek: [[0.10, 0.70, 1.0], [0.35, 0.55, 1.0]],
    // Into the Unknown reuses the Ultra parameters verbatim.
    unknown: [[0.10, 0.70, 1.0], [0.35, 0.55, 1.0]],
  },
  aurora: {
    // Aurora-Max: two drifting bands (hues 0 and 1).
    flash: [[0.35, 0.15, 0.0], [-0.50, 0.60, 1.0]],
    // Aurora-Ultra: a third band adds hue 2.
    deepseek: [[0.35, 0.15, 0.0], [-0.50, 0.60, 1.0], [0.75, 0.35, 2.0]],
    unknown: [[0.35, 0.15, 0.0], [-0.50, 0.60, 1.0], [0.75, 0.35, 2.0]],
  },
  pulse: {
    // Pulse-Max: one expanding ring.
    flash: [[0.10, 0.60, 1.0]],
    // Pulse-Ultra: two rings (inner weaker, outer stronger).
    deepseek: [[0.10, 0.55, 0.8], [0.45, 0.55, 1.1]],
    unknown: [[0.10, 0.55, 0.8], [0.45, 0.55, 1.1]],
  },
}

/** Extra display time applied to every Codex ignition style. */
const DEEPSEEK_WAVE_DURATION_EXTENSION_MS = 200

/** Original Codex duration used as the animation's sampling timeline. */
function deepseekWaveBaseDuration(tier: DeepseekWaveTier, style: DeepseekWaveStyle): number {
  // The unknown tier reuses the deepseek (pro) durations exactly.
  const pro = tier === 'deepseek' || tier === 'unknown'
  switch (style) {
    case 'aurora': return pro ? 1600 : 1300
    case 'pulse': return pro ? 1250 : 900
    case 'wave': return pro ? 1300 : 1000
  }
}

/**
 * Total visible duration: the Codex ignition duration plus 200ms so its motion
 * remains readable in a busy terminal.
 * @param tier - the active wave tier.
 * @param style - the active ignition style.
 * @returns the duration in milliseconds.
 */
export function deepseekWaveDuration(tier: DeepseekWaveTier, style: DeepseekWaveStyle = 'wave'): number {
  return deepseekWaveBaseDuration(tier, style) + DEEPSEEK_WAVE_DURATION_EXTENSION_MS
}

/** Map the extended display timeline back onto the original Codex samples. */
function deepseekWaveSampleElapsedMs(tick: number, tier: DeepseekWaveTier, style: DeepseekWaveStyle): number {
  const base = deepseekWaveBaseDuration(tier, style)
  return tick * DEEPSEEK_WAVE_TICK_MS * base / deepseekWaveDuration(tier, style)
}

/**
 * Pick one ignition style at random, never repeating the previous one —
 * Codex `IgnitionStyle::random`. Falls back to the remaining styles.
 * @param previous - the style of the last trigger, if any.
 * @returns a style different from `previous`.
 */
export function deepseekWaveStyleRandom(previous: DeepseekWaveStyle | undefined): DeepseekWaveStyle {
  const candidates = DEEPSEEK_WAVE_STYLES.filter(style => style !== previous)
  return candidates[Math.floor(Math.random() * candidates.length)] ?? 'wave'
}

/**
 * Tier for a `provider/model` label: a model id containing `flash` runs the
 * single-band flash tier; everything else (pro/reasoner/chat) runs the
 * dual-band deepseek tier. Mirrors Codex's Max→Ultra mapping.
 * @param model - the `provider/model` label of the applied model.
 * @returns the wave tier for that model.
 */
export function deepseekWaveTier(model: string): DeepseekWaveTier {
  return model.toLowerCase().includes('flash') ? 'flash' : 'deepseek'
}

/**
 * Cosine window — Codex `crest`: 1 exactly under the wave center, 0 from
 * one half-width away.
 * @param distance - distance from the crest center in half-widths.
 * @returns the crest strength in 0..1.
 */
export function crest(distance: number): number {
  if (distance >= 1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * distance))
}

/**
 * Cubic ease-in-out — Codex `ease_in_out`: flat at both ends, steepest in
 * the middle, so the crest accelerates and eases instead of sliding linearly.
 * @param progress - raw progress (clamped to 0..1).
 * @returns the eased progress in 0..1.
 */
export function easeInOut(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  if (p < 0.5) return 4 * p * p * p
  const inverse = -2 * p + 2
  return 1 - (inverse * inverse * inverse) / 2
}

/**
 * Fade-in/fade-out envelope — Codex `envelope`: linear ramp over `fadeIn`
 * at the start and `fadeOut` at the end, plateau at 1 between, 0 outside the
 * total. The Wave style keeps the envelope at 1 (Codex paints Wave without
 * an envelope); exported for the Aurora-style fades and for tests.
 * @param elapsed - seconds since the animation started.
 * @param total - total duration in seconds.
 * @param fadeIn - seconds of fade-in.
 * @param fadeOut - seconds of fade-out.
 * @returns the envelope value in 0..1.
 */
export function envelope(elapsed: number, total: number, fadeIn: number, fadeOut: number): number {
  if (elapsed <= 0 || elapsed >= total) return 0
  const rise = elapsed / Math.max(fadeIn, Number.EPSILON)
  const fall = (total - elapsed) / Math.max(fadeOut, Number.EPSILON)
  return Math.min(Math.max(Math.min(rise, fall), 0), 1)
}

/**
 * One band's contribution at a column — Codex `band_sample`, all three
 * branches: Wave sweeps an eased crest across the row; Aurora drifts a
 * sinusoidal center carrying a hue index; Pulse expands a ring from the row
 * center with cubic ease and decaying strength.
 * @param style - the ignition style.
 * @param band - the band triple (meaning depends on the style).
 * @param elapsed - seconds since the animation started.
 * @param column - column index in the content row (0..width-1).
 * @param width - content-row width in columns.
 * @returns `[hueIndex, strength]`.
 */
function bandSample(
  style: DeepseekWaveStyle,
  band: DeepseekWaveBand,
  elapsed: number,
  column: number,
  width: number,
): [number, number] {
  const [first, second, third] = band
  switch (style) {
    case 'wave': {
      const progress = (elapsed - first) / second
      if (progress < 0 || progress > 1) return [0, 0]
      const center = easeInOut(progress) * (width + 2 * WAVE_HALF_WIDTH) - WAVE_HALF_WIDTH
      return [0, crest(Math.abs(column - center) / WAVE_HALF_WIDTH)]
    }
    case 'aurora': {
      const center = (0.5 + 0.38 * Math.sin(Math.PI * 2 * (first * elapsed + second))) * width
      const halfWidth = Math.max(width * 0.22, 4)
      return [Math.trunc(third), crest(Math.abs(column - center) / halfWidth)]
    }
    case 'pulse': {
      const progress = (elapsed - first) / second
      if (progress < 0 || progress > 1) return [0, 0]
      const inverse = 1 - progress
      const radius = (1 - inverse * inverse * inverse) * (width / 2 + 2 * PULSE_HALF_WIDTH)
      const distance = Math.abs(column - width / 2)
      return [0, crest(Math.abs(distance - radius) / PULSE_HALF_WIDTH) * third * (1 - 0.6 * progress)]
    }
  }
}

/** Linear RGB blend — Codex `blend`: `fg * alpha + bg * (1 - alpha)`. */
function blendRgb(fg: RgbTriple, bg: RgbTriple, alpha: number): RgbTriple {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ]
}

/**
 * Per-row phase share of the duration: the crest reaches the top row first
 * and the bottom row last, sweeping down the band. 0.12 keeps the bottom
 * row's lag inside the 200ms duration extension.
 */
const DEEPSEEK_WAVE_ROW_PHASE = 0.12

/**
 * The background color for one composer-band column at a tick — Codex
 * `paint_bands` + `Canvas::tint` for all three styles. Bands overlap with a
 * max for Wave/Pulse and a SUM for Aurora (Codex differs by style), the
 * weighted hues mix per column (Wave/Pulse always end on hue 0), the tint
 * blends the mixed hue toward the blank-cell base at the style's alpha cap,
 * and Aurora applies its own fade envelope. Returns `null` when the column
 * should stay transparent, so the row returns to no `backgroundColor` on
 * both ends. With `rows > 1` each row samples the same timeline shifted by a
 * per-row phase offset, so the crest cascades down the band instead of
 * painting every row identically.
 * @param tick - wave frame (0, 1, … at DEEPSEEK_WAVE_TICK_MS).
 * @param column - column index in the content row (0..width-1).
 * @param width - content-row width in columns.
 * @param tier - the wave tier (flash = Max, deepseek = Ultra parameters).
 * @param style - the ignition style.
 * @param hues - the tier's three hues.
 * @param base - the blank-cell base color the tint blends toward.
 * @param row - row index in the band (0..rows-1; default 0 = old single-row).
 * @param rows - band height in rows (default 1).
 * @returns the blended RGB background, or null for transparent.
 */
export function deepseekWaveColumnBg(
  tick: number,
  column: number,
  width: number,
  tier: DeepseekWaveTier,
  style: DeepseekWaveStyle,
  hues: readonly [RgbTriple, RgbTriple, RgbTriple],
  base: RgbTriple,
  row = 0,
  rows = 1,
): RgbTriple | null {
  const total = deepseekWaveBaseDuration(tier, style) / 1000
  const elapsed = deepseekWaveSampleElapsedMs(tick, tier, style) / 1000
    - (row - (rows - 1) / 2) * total * DEEPSEEK_WAVE_ROW_PHASE
  const fade = style === 'aurora' ? envelope(elapsed, total, 0.25, 0.40) : 1
  const weights = [0, 0, 0]
  for (const band of DEEPSEEK_WAVE_BANDS[style][tier]) {
    const [hue, strength] = bandSample(style, band, elapsed, column, width)
    weights[hue] = style === 'aurora' ? weights[hue]! + strength : Math.max(weights[hue]!, strength)
  }
  const weight = weights[0]! + weights[1]! + weights[2]!
  if (weight <= 0.01) return null
  let red = 0
  let green = 0
  let blue = 0
  for (let index = 0; index < 3; index += 1) {
    red += weights[index]! * hues[index]![0]
    green += weights[index]! * hues[index]![1]
    blue += weights[index]! * hues[index]![2]
  }
  const mixed: RgbTriple = [
    Math.round(red / weight),
    Math.round(green / weight),
    Math.round(blue / weight),
  ]
  const alpha = style === 'aurora' ? Math.min(weight * 0.40, 0.50) * fade : weight * 0.55
  if (alpha < 0.02) return null
  return blendRgb(mixed, base, alpha)
}

/**
 * The sparkle glyph for a tick — Codex `spark_frame`, sampled on the same
 * proportionally slowed DeepSeek Wave timeline as the composer background.
 * The Ink layer still must skip occupied cells.
 * @param tick - wave frame at DEEPSEEK_WAVE_TICK_MS.
 * @returns the sparkle glyph, or null outside the stretched tail window.
 */
export function deepseekWaveSpark(tick: number): string | null {
  const elapsed = deepseekWaveSampleElapsedMs(tick, 'deepseek', 'wave')
  if (elapsed < SPARK_START_MS) return null
  const frame = Math.floor((elapsed - SPARK_START_MS) / SPARK_FRAME_MS)
  return SPARK_GLYPHS[frame] ?? null
}

/**
 * Whether the `deepseek` wordmark rides the wave at this tick: it fades in
 * shortly after the first crest launches and out before the wave settles,
 * so the brand name surfaces through the sweep's middle. The Ink layer
 * places it in the row's blank mid-section (never over real draft text).
 * @param tick - wave frame at DEEPSEEK_WAVE_TICK_MS.
 * @param tier - the wave tier.
 * @returns true while the wordmark should be visible.
 */
export function deepseekWaveWordVisible(tick: number, tier: DeepseekWaveTier, style: DeepseekWaveStyle = 'wave'): boolean {
  const total = deepseekWaveBaseDuration(tier, style) / 1000
  const elapsed = deepseekWaveSampleElapsedMs(tick, tier, style) / 1000
  return envelope(elapsed, total, total * 0.2, total * 0.35) > 0.25
}

/**
 * The per-character color for the `deepseek` wordmark: the tier's hues
 * cycled per character (d→hue0, e→hue1, e→hue2, …), a brand-gradient text.
 * @param index - character index in the wordmark.
 * @param hues - the tier's three hues.
 * @returns the hue for that character.
 */
export function deepseekWaveWordHue(index: number, hues: readonly [RgbTriple, RgbTriple, RgbTriple]): RgbTriple {
  return hues[index % hues.length]!
}

/**
 * True when a `provider/model` status label addresses the official DeepSeek
 * route: either segment contains `deepseek` (case-insensitive), covering the
 * `deepseek-official` provider route and its `deepseek-*` model ids.
 * @param label - the status bar model label (`provider/model`).
 * @returns whether the label names an official DeepSeek model.
 */
export function isOfficialDeepSeekLabel(label: string): boolean {
  const slash = label.indexOf('/')
  const provider = slash < 0 ? label : label.slice(0, slash)
  const model = slash < 0 ? '' : label.slice(slash + 1)
  return provider.toLowerCase().includes('deepseek') || model.toLowerCase().includes('deepseek')
}

/**
 * Known reasoning-effort ranks in ascending order. Effort ids are opaque
 * adapter-owned strings, so the rank table covers the conventional names
 * (off → low → medium → high → xhigh → max/ultra); an unrecognized id
 * ranks as unknown (0), which never triggers the high-effort wave.
 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  low: 1,
  medium: 2,
  med: 2,
  high: 3,
  xhigh: 4,
  'x-high': 4,
  'very-high': 4,
  max: 5,
  maximum: 5,
  ultra: 5,
}

/**
 * True when an effective reasoning effort is STRICTLY above `high` — the
 * trigger gate for the "Into the Unknown" wave on non-DeepSeek routes.
 * Absent efforts and unrecognized ids never qualify.
 * @param effort - the effective reasoning-effort id ('' or undefined when none).
 * @returns whether the effort ranks above high.
 */
export function effortAboveHigh(effort: string | undefined): boolean {
  if (effort === undefined || effort === '') return false
  const rank = EFFORT_RANK[effort.trim().toLowerCase()]
  return rank !== undefined && rank > 3
}
