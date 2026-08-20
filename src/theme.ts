/**
 * Terminal color tokens for the dsh TUI, mapped from the product design
 * platform's DeepSeek palette
 * (`packages/client/ui-theme/src/styles/design-platform.css`). Truecolor RGB
 * rides chalk, which degrades automatically on terminals without truecolor.
 *
 * Two palettes — `dark` (the default) and `light` — share the same token keys
 * with different values. Painters and the palette accessor read the ACTIVE
 * palette selected through {@link setTheme}, so a theme switch recolors every
 * painted surface on the next render without touching call sites. Raw token
 * consumers keep reading {@link TUI_RGB} (the dark values) until the
 * theme-aware integration replaces those call sites with
 * `inkColor(getPalette().token)`.
 *
 * @module @deepseek-ai/dsh-tui/theme
 */

import chalk from 'chalk'

/** One RGB triple for a palette token. */
export type RgbTriple = readonly [number, number, number]

/** Palette token keys shared by every theme. */
export type ThemeToken =
  | 'brand'
  | 'brandBright'
  | 'brandMid'
  | 'brandDeep'
  | 'dim'
  | 'success'
  | 'error'
  | 'warn'
  | 'text'
  | 'code'
  | 'composerBand'

/** One full color palette: every token key mapped to an RGB triple. */
export type ThemePalette = Readonly<Record<ThemeToken, RgbTriple>>

/** Selectable theme names: dark, light, or auto (terminal-sensed). */
export type ThemeName = 'dark' | 'light' | 'auto'

/** Valid theme names in canonical picker order. */
export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'auto']

/**
 * DeepSeek dark palette: the original TUI colors, one entry per
 * design-platform token in use. Keep names and values in sync with the CSS
 * custom properties cited inline.
 */
export const DARK_PALETTE = {
  /** Primary brand blue — `--dsw-static-deepseek-500`. */
  brand: [65, 118, 230],
  /** Brighter brand blue for live/streaming emphasis — `--dsw-static-deepseek-400`. */
  brandBright: [103, 158, 254],
  /** Intermediate brand blue between brand and brandBright — `--dsw-static-deepseek-450`. */
  brandMid: [86, 134, 254],
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
  /** Composer three-row band base — neutral light gray, hue-free so wave tints read on it. */
  composerBand: [46, 48, 52],
} as const satisfies ThemePalette

/**
 * Light palette tuned for white terminals: the same token keys as dark with
 * contrast-driven values (AA on a white background). Brand keeps its dark
 * value (≈4.9:1); the bright/mid/deep blues, muted grays, and status colors
 * deepen so they stay legible on bright backgrounds.
 */
export const LIGHT_PALETTE = {
  /** Primary brand blue — unchanged, ≈4.9:1 AA on white. */
  brand: [65, 118, 230],
  /** Brighter brand blue deepened for white backgrounds (was 2.7:1). */
  brandBright: [72, 104, 178],
  /** Intermediate brand blue — Tailwind blue-500. */
  brandMid: [59, 130, 246],
  /** Deep brand blue for secondary chrome — `--dsw-static-deepseek-700`. */
  brandDeep: [47, 76, 143],
  /** Muted caption gray deepened for white backgrounds. */
  dim: [101, 103, 107],
  /** Success green — Tailwind green-700. */
  success: [21, 128, 61],
  /** Error red — Tailwind red-600. */
  error: [236, 19, 19],
  /** Warning amber — Tailwind amber-700. */
  warn: [180, 83, 9],
  /** Default foreground text — near-black. */
  text: [21, 21, 23],
  /** Inline/fenced code — Tailwind cyan-700, distinct from brand accents. */
  code: [14, 116, 144],
  /** Composer three-row band base — neutral light gray, hue-free so wave tints read on it. */
  composerBand: [229, 231, 235],
} as const satisfies ThemePalette

/** Every palette by theme name; auto resolves through {@link resolveTheme}. */
export const PALETTES = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
} as const satisfies Record<Exclude<ThemeName, 'auto'>, ThemePalette>

/**
 * The dark palette under its original name: call sites that predate the
 * two-palette switch keep compiling and painting identically (the default
 * theme IS dark). New code should read the active palette through
 * {@link getPalette} so a theme switch reaches it.
 *
 * @deprecated Read the active palette through {@link getPalette}; this
 * compatibility alias is removed in the next minor release.
 */
export const TUI_RGB = DARK_PALETTE

/** The theme name in force (the requested name; 'auto' included). */
let activeName: ThemeName = 'dark'

/** The palette painters and {@link getPalette} read for the active theme. */
let activePalette: ThemePalette = DARK_PALETTE

/**
 * Resolve a theme name to the palette actually in use. `auto` detection
 * (OSC 11 terminal background query) is a later enhancement; until it lands,
 * auto falls back to the dark palette.
 * @param name - the requested theme name.
 * @returns 'dark' or 'light' — the palette key to paint with.
 */
export function resolveTheme(name: ThemeName): 'dark' | 'light' {
  return name === 'light' ? 'light' : 'dark'
}

/**
 * Switch the active theme: painters and {@link getPalette} reflect the new
 * palette from the next render onward. The default is dark, so a process
 * that never calls this paints exactly as before.
 * @param name - the theme to activate ('auto' resolves to dark for now).
 */
export function setTheme(name: ThemeName): void {
  activeName = name
  activePalette = PALETTES[resolveTheme(name)]
}

/**
 * The theme name in force. Returns the requested name ('auto' included) so
 * the /theme picker and persistence can round-trip the user's choice; the
 * palette actually used is {@link getPalette}.
 */
export function getTheme(): ThemeName {
  return activeName
}

/** The palette in force; theme-aware call sites read colors through it. */
export function getPalette(): ThemePalette {
  return activePalette
}

/**
 * Parse a persisted theme name: only 'light' and 'auto' survive; anything
 * else (missing, corrupt, or unknown) falls back to the dark default.
 * @param value - the raw parsed JSON value (expected string).
 * @returns a valid theme name.
 */
export function parseThemeName(value: unknown): ThemeName {
  return value === 'light' || value === 'auto' ? value : 'dark'
}

/** Ink `color` string for one RGB triple. */
export function inkColor(triple: RgbTriple): string {
  return `rgb(${triple[0]}, ${triple[1]}, ${triple[2]})`
}

/** Paint with the primary brand blue: whale, wordmark, tool names, accents. */
export function brand(text: string): string {
  return chalk.rgb(...activePalette.brand)(text)
}

/** Paint with the bright brand blue: streaming output and active spinners. */
export function brandBright(text: string): string {
  return chalk.rgb(...activePalette.brandBright)(text)
}

/** Paint with the deep brand blue: borders and secondary chrome. */
export function brandDeep(text: string): string {
  return chalk.rgb(...activePalette.brandDeep)(text)
}

/** Paint muted captions, hints, and meta lines. */
export function dim(text: string): string {
  return chalk.rgb(...activePalette.dim)(text)
}

/** Paint completed tool results and confirmations. */
export function success(text: string): string {
  return chalk.rgb(...activePalette.success)(text)
}

/** Paint failures and error entries. */
export function error(text: string): string {
  return chalk.rgb(...activePalette.error)(text)
}

/** Paint warnings. */
export function warn(text: string): string {
  return chalk.rgb(...activePalette.warn)(text)
}
