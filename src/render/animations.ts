/**
 * Terminal animation frame tables derived from the web design language:
 * the StateDot "ongoing" pixel chase (3×3 ring, 125ms flat-hold brightness
 * steps, 1s cycle) becomes the single-cell stepped pulse below and the
 * full-ring clockwise braille chase in {@link BUSY_CHASE_FRAMES}, and the
 * streaming caret blink is the Claude-Code convention. The DeepSeek
 * model-switch easter egg adds a one-shot blue gradient wave over the model
 * name (pure phase table plus the official-route predicate below). Pure
 * functions only — the Ink layer owns timers and colors.
 *
 * @module @deepseek-ai/dsh-code/render/animations
 */

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
 * label switches to an official DeepSeek route, the model name plays a short
 * blue gradient wave and then returns to static. Pure table and predicate
 * only — the Ink layer owns the timer, the shade palette, and the restore.
 */

/** Total frames of the one-shot composer wave (12 × 125ms = 1.5s). */
export const DEEPSEEK_WAVE_FRAMES = 12

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
