/**
 * Terminal animation frame tables derived from the web design language:
 * the StateDot "ongoing" pixel chase (3×3 ring, 125ms flat-hold brightness
 * steps, 1s cycle) becomes the single-cell stepped pulse below and the
 * full-ring clockwise braille chase in {@link BUSY_CHASE_FRAMES}, and the
 * streaming caret blink is the Claude-Code convention. Pure functions only —
 * the Ink layer owns timers and colors.
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
