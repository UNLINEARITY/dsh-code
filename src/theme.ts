/**
 * Terminal color tokens for the dsh TUI, mapped from the product design
 * platform's DeepSeek palette
 * (`packages/client/ui-theme/src/styles/design-platform.css`). Truecolor RGB
 * rides chalk, which degrades automatically on terminals without truecolor.
 *
 * @module @deepseek-ai/dsh-tui/theme
 */

import chalk from 'chalk'

/**
 * RGB triples for the TUI, one entry per design-platform token in use.
 * Keep names and values in sync with the CSS custom properties cited inline.
 */
export const TUI_RGB = {
  /** Primary brand blue — `--dsw-static-deepseek-500`. */
  brand: [65, 118, 230],
  /** Brighter brand blue for live/streaming emphasis — `--dsw-static-deepseek-400`. */
  brandBright: [103, 158, 254],
  /** Deep brand blue for secondary chrome — `--dsw-static-deepseek-600`. */
  brandDeep: [72, 104, 178],
  /** Muted caption gray — `--dsw-static-neutral-bluish-600`. */
  dim: [129, 133, 140],
  /** Success green — `--dsw-static-green-500`. */
  success: [34, 197, 94],
  /** Error red — `--dsw-static-red-500`. */
  error: [239, 68, 68],
  /** Warning amber — `--dsw-static-amber-500`. */
  warn: [245, 158, 11],
  /** Default foreground text — `--dsw-static-neutral-50`. */
  text: [236, 240, 246],
  /** Inline/fenced code — soft sky blue, distinct from brand accents. */
  code: [125, 211, 252],
} as const satisfies Record<string, readonly [number, number, number]>

/** Paint with the primary brand blue: whale, wordmark, tool names, accents. */
export function brand(text: string): string {
  return chalk.rgb(...TUI_RGB.brand)(text)
}

/** Paint with the bright brand blue: streaming output and active spinners. */
export function brandBright(text: string): string {
  return chalk.rgb(...TUI_RGB.brandBright)(text)
}

/** Paint with the deep brand blue: borders and secondary chrome. */
export function brandDeep(text: string): string {
  return chalk.rgb(...TUI_RGB.brandDeep)(text)
}

/** Paint muted captions, hints, and meta lines. */
export function dim(text: string): string {
  return chalk.rgb(...TUI_RGB.dim)(text)
}

/** Paint completed tool results and confirmations. */
export function success(text: string): string {
  return chalk.rgb(...TUI_RGB.success)(text)
}

/** Paint failures and error entries. */
export function error(text: string): string {
  return chalk.rgb(...TUI_RGB.error)(text)
}

/** Paint warnings. */
export function warn(text: string): string {
  return chalk.rgb(...TUI_RGB.warn)(text)
}
