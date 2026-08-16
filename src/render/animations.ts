/**
 * Terminal animation frame tables derived from the web design language:
 * the StateDot "ongoing" pixel chase (3×3 ring, 125ms flat-hold brightness
 * steps, 1s cycle) becomes the single-cell stepped pulse below and the
 * full-ring clockwise braille chase in {@link BUSY_CHASE_FRAMES}, and the
 * streaming caret blink is the Claude-Code convention. The DeepSeek
 * model-switch easter egg adds a one-shot eased blue swell over the composer
 * frame (pure interpolation path plus the official-route predicate below).
 * Pure functions only — the Ink layer owns timers and colors.
 *
 * @module @deepseek-ai/dsh-code/render/animations
 */

import type { RgbTriple } from '../theme.ts'

/** Single-cell stepped pulse: flat holds mirroring the web's 125ms keyframes. */
export const PULSE_FRAMES = ['█', '█', '▆', '▃', '▁', '▃', '▆', '█'] as const

/** Pulse frame for a monotonic tick. */
export function pulseFrame(tick: number): string {
  return PULSE_FRAMES[tick % PULSE_FRAMES.length] ?? PULSE_FRAMES[0]
}

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
 * label switches to an official DeepSeek route, the composer frame plays a
 * short eased blue swell and then returns to static. The Ink layer owns the
 * timer and reads the ACTIVE palette anchors (getPalette); everything below
 * is pure interpolation over the colors it is given, so the same path stays
 * coordinated in both themes without the module touching the palette state.
 */

/** Total frames of the one-shot composer wave (32 × 60ms ≈ 1.9s of smooth
 * swell: one eased rise through the brand blues and a symmetric fall back to
 * the static border tone). */
export const DEEPSEEK_WAVE_FRAMES = 32

/** Frame cadence of the DeepSeek wave: 60ms interpolates the gradient so the
 * border and prompt read as flowing color rather than discrete shade steps. */
export const DEEPSEEK_WAVE_INTERVAL_MS = 60

/** The five color anchors the wave travels through, filled by the Ink layer
 * from the ACTIVE palette (`getPalette`) so the swell stays theme-coordinated.
 * `calm` is the static border tone the wave rises from and settles back to;
 * the four brand tokens order the path deep → brand → mid → bright so the hue
 * flows continuously. */
export interface DeepseekWaveColors {
  /** Static composer border tone — the wave's calm start and end. */
  calm: RgbTriple
  /** Deep brand blue — first brand stop of the path. */
  deep: RgbTriple
  /** Primary brand blue — second stop. */
  brand: RgbTriple
  /** Intermediate brand blue — third stop. */
  mid: RgbTriple
  /** Bright brand blue — the wave crest at the middle frames. */
  bright: RgbTriple
}

/** Ease-in-out (smoothstep) envelope: the swell accelerates through the
 * middle and eases into the calm ends instead of stepping shade to shade. */
function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** Linear interpolation between two RGB triples, rounded to integer channels. */
function lerpRgb(a: RgbTriple, b: RgbTriple, t: number): RgbTriple {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/** Progress of a wave frame along the full swell (0..1, clamped so the prompt
 * lag can overshoot the ends harmlessly). */
function waveProgress(tick: number): number {
  const last = DEEPSEEK_WAVE_FRAMES - 1
  if (tick <= 0) return 0
  if (tick >= last) return 1
  return tick / last
}

/** Round-trip position of the wave for a progress value: 0 at both ends, 1 at
 * the exact middle — the eased crest of the swell. */
function wavePosition(progress: number): number {
  return 1 - Math.abs(2 * smoothstep(progress) - 1)
}

/**
 * Color of the wave path at a round-trip position (0 = calm, 1 = bright
 * crest, back to 0): piecewise RGB interpolation through the five anchors —
 * calm → deep → brand → mid → bright — so the hue flows continuously.
 */
function wavePathColor(position: number, colors: DeepseekWaveColors): RgbTriple {
  const { calm, deep, brand, mid, bright } = colors
  if (position < 0.12) return lerpRgb(calm, deep, position / 0.12)
  if (position < 0.38) return lerpRgb(deep, brand, (position - 0.12) / 0.26)
  if (position < 0.68) return lerpRgb(brand, mid, (position - 0.38) / 0.3)
  return lerpRgb(mid, bright, (position - 0.68) / 0.32)
}

/**
 * The composer border color at frame `tick` of the one-shot DeepSeek wave:
 * starts exactly at the static border tone (`calm`), swells through the brand
 * path to the bright crest at the middle frames, and eases back to calm —
 * seamless with the static frame at both ends.
 * @param tick - wave frame (0..DEEPSEEK_WAVE_FRAMES-1).
 * @param colors - theme anchors from the active palette.
 * @returns the RGB triple for the border at that frame.
 */
export function deepseekWaveColor(tick: number, colors: DeepseekWaveColors): RgbTriple {
  return wavePathColor(wavePosition(waveProgress(tick)), colors)
}

/** Frames by which the ❯ prompt marker trails the border: the brightness
 * visibly travels from the frame ring into the prompt before both fade. */
export const DEEPSEEK_WAVE_PROMPT_LAG = 4

/**
 * The ❯ prompt marker color at frame `tick`: the border wave sampled
 * {@link DEEPSEEK_WAVE_PROMPT_LAG} frames late and blended toward the static
 * brand prompt tone, so the marker starts and ends exactly at its static
 * brand color — a glowing echo of the border wave with no end-of-wave snap.
 * @param tick - wave frame (0..DEEPSEEK_WAVE_FRAMES-1).
 * @param colors - theme anchors from the active palette.
 * @returns the RGB triple for the prompt marker at that frame.
 */
export function deepseekWavePromptColor(tick: number, colors: DeepseekWaveColors): RgbTriple {
  const position = wavePosition(waveProgress(tick - DEEPSEEK_WAVE_PROMPT_LAG))
  return lerpRgb(colors.brand, wavePathColor(position, colors), position)
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
