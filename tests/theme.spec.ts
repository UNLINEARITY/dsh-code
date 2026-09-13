/** Palette tokens match the design platform; paint wraps survive color level. */

import chalk from 'chalk'
import { describe, expect, it } from 'vitest'
import {
  brand, brandBright, brandDeep, dim, error, success, warn,
  DARK_PALETTE, LIGHT_PALETTE, PALETTES, THEMES, THEME_NAMES, diffBackground, getPalette, getTheme,
  inkColor, parseThemeName, resolveTheme, setTheme, type RgbTriple,
} from '../src/theme.ts'

describe('tui theme', () => {
  it('pins the DeepSeek brand blues from the design platform', () => {
    expect(DARK_PALETTE.brand).toEqual([65, 118, 230])
    expect(DARK_PALETTE.brandBright).toEqual([103, 158, 254])
    expect(DARK_PALETTE.brandDeep).toEqual([72, 104, 178])
    expect(PALETTES.dark).toEqual(DARK_PALETTE)
    expect(DARK_PALETTE.brandMid).toEqual([86, 134, 254])
  })

  it('keeps every token an RGB triple', () => {
    for (const value of Object.values(DARK_PALETTE)) {
      expect(value).toHaveLength(3)
      for (const channel of value) {
        expect(Number.isInteger(channel)).toBe(true)
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(255)
      }
    }
  })

  it('wraps the input text in every painter regardless of color level', () => {
    for (const paint of [brand, brandBright, brandDeep, dim, success, error, warn]) {
      const painted = paint('deepseek')
      expect(painted).toContain('deepseek')
      expect(typeof painted).toBe('string')
    }
  })

  it('returns the bare text when colors are disabled', () => {
    const level = chalk.level
    chalk.level = 0
    try {
      expect(brand('#4176E6')).toBe('#4176E6')
      expect(error('boom')).toBe('boom')
    } finally {
      chalk.level = level
    }
  })

  it('pins the light palette to the white-background contrast values', () => {
    expect(LIGHT_PALETTE.brand).toEqual([65, 118, 230])
    expect(LIGHT_PALETTE.brandBright).toEqual([72, 104, 178])
    expect(LIGHT_PALETTE.brandMid).toEqual([59, 130, 246])
    expect(LIGHT_PALETTE.brandDeep).toEqual([47, 76, 143])
    expect(LIGHT_PALETTE.dim).toEqual([101, 103, 107])
    expect(LIGHT_PALETTE.text).toEqual([21, 21, 23])
    expect(LIGHT_PALETTE.code).toEqual([14, 116, 144])
    expect(LIGHT_PALETTE.success).toEqual([21, 128, 61])
    expect(LIGHT_PALETTE.error).toEqual([236, 19, 19])
    expect(LIGHT_PALETTE.warn).toEqual([180, 83, 9])
  })

  it('pins the composer band base in both palettes', () => {
    expect(DARK_PALETTE.composerBand).toEqual([46, 48, 52])
    expect(LIGHT_PALETTE.composerBand).toEqual([229, 231, 235])
    // The band stays hue-free (neutral gray): the wave's blue tints must not
    // blend into a same-hue background.
    expect(Math.max(...DARK_PALETTE.composerBand) - Math.min(...DARK_PALETTE.composerBand)).toBeLessThanOrEqual(6)
    expect(Math.max(...LIGHT_PALETTE.composerBand) - Math.min(...LIGHT_PALETTE.composerBand)).toBeLessThanOrEqual(6)
    expect(LIGHT_PALETTE.composerBand[0]).toBeGreaterThan(200)
  })

  it('keeps both palettes on the same token keys and the canonical names', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(['dark', 'light'])
    expect(Object.keys(LIGHT_PALETTE).sort()).toEqual(Object.keys(DARK_PALETTE).sort())
    expect(THEME_NAMES).toEqual(['dark', 'light', 'auto'])
  })

  it('exposes one picker registry matching the canonical names', () => {
    expect(THEMES.map(theme => theme.id)).toEqual(THEME_NAMES)
    for (const theme of THEMES) {
      expect(theme.label).toBe(theme.id)
      expect(theme.description.length).toBeGreaterThan(0)
    }
  })

  it('defaults to dark and switches palettes through setTheme', () => {
    try {
      setTheme('dark')
      expect(getTheme()).toBe('dark')
      expect(getPalette()).toBe(DARK_PALETTE)
      setTheme('light')
      expect(getTheme()).toBe('light')
      expect(getPalette()).toBe(LIGHT_PALETTE)
      expect(getPalette().brandBright).toEqual([72, 104, 178])
    } finally {
      setTheme('dark')
    }
  })

  it('paints with the active palette after a theme switch', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      setTheme('dark')
      const darkBright = brandBright('x')
      setTheme('light')
      const lightBright = brandBright('x')
      expect(darkBright).toContain('103')
      expect(lightBright).toContain('72')
      expect(darkBright).not.toBe(lightBright)
      expect(success('ok')).toContain('21')
    } finally {
      chalk.level = level
      setTheme('dark')
    }
  })

  it('formats Ink color strings from a triple', () => {
    expect(inkColor([65, 118, 230])).toBe('rgb(65, 118, 230)')
    expect(inkColor(LIGHT_PALETTE.code)).toBe('rgb(14, 116, 144)')
    expect(inkColor(DARK_PALETTE.brandDeep)).toBe('rgb(72, 104, 178)')
  })

  it('resolves auto to dark until terminal detection lands', () => {
    try {
      expect(resolveTheme('dark')).toBe('dark')
      expect(resolveTheme('light')).toBe('light')
      expect(resolveTheme('auto')).toBe('dark')
      setTheme('auto')
      expect(getTheme()).toBe('auto')
      expect(getPalette()).toBe(DARK_PALETTE)
    } finally {
      setTheme('dark')
    }
  })

  it('pins the Codex diff tints and gates them on color depth', () => {
    // Codex diff renderer palettes: muted dark tints, GitHub light pastels.
    expect(DARK_PALETTE.diffAdd).toEqual([33, 58, 43])
    expect(DARK_PALETTE.diffDel).toEqual([74, 34, 29])
    expect(LIGHT_PALETTE.diffAdd).toEqual([218, 251, 225])
    expect(LIGHT_PALETTE.diffDel).toEqual([255, 235, 233])
    // AA-tuned diff foregrounds: the status greens/reds sink below 4.5:1 on
    // their own tints (dark error-on-diffDel was 3.6:1), so diff rows carry
    // dedicated foreground tokens instead of borrowing success/error.
    expect(DARK_PALETTE.diffAddFg).toEqual([34, 197, 94])
    expect(DARK_PALETTE.diffDelFg).toEqual([248, 113, 113])
    expect(LIGHT_PALETTE.diffAddFg).toEqual([22, 101, 52])
    expect(LIGHT_PALETTE.diffDelFg).toEqual([185, 28, 28])

    // Rich terminals get the active theme's tint as an Ink background.
    const level = chalk.level
    chalk.level = 3
    try {
      expect(diffBackground('diffAdd')).toBe('rgb(33, 58, 43)')
      expect(diffBackground('diffDel')).toBe('rgb(74, 34, 29)')
      setTheme('light')
      expect(diffBackground('diffAdd')).toBe('rgb(218, 251, 225)')
      expect(diffBackground('diffDel')).toBe('rgb(255, 235, 233)')
      // 16-color terminals keep the foreground-only look (no background).
      chalk.level = 1
      expect(diffBackground('diffAdd')).toBeUndefined()
      expect(diffBackground('diffDel')).toBeUndefined()
    } finally {
      chalk.level = level
      setTheme('dark')
    }
  })

  it('parses persisted theme names with a dark fallback', () => {
    expect(parseThemeName('light')).toBe('light')
    expect(parseThemeName('auto')).toBe('auto')
    expect(parseThemeName('dark')).toBe('dark')
    expect(parseThemeName(undefined)).toBe('dark')
    expect(parseThemeName('sepia')).toBe('dark')
    expect(parseThemeName(42)).toBe('dark')
  })
})

describe('tui theme contrast (WCAG 2.x)', () => {
  // Terminal background assumptions: the dark palette paints on a black
  // terminal, the light palette on a white one. Body-size tokens must clear
  // AA 4.5:1; accent/status tokens (bold labels, borders, dots) clear the
  // 3:1 UI-component threshold — the light brand blue deliberately keeps the
  // design-platform value at ≈4.2:1 for bold/accent spans only.
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const luminance = (rgb: RgbTriple): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  const ratio = (fg: RgbTriple, bg: RgbTriple): number => {
    const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
    return (light + 0.05) / (dark + 0.05)
  }
  const BLACK: RgbTriple = [0, 0, 0]
  const WHITE: RgbTriple = [255, 255, 255]

  it('keeps body-text tokens at AA on their terminal backgrounds', () => {
    for (const token of ['text', 'dim', 'brandBright', 'code'] as const) {
      expect(ratio(DARK_PALETTE[token], BLACK)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(LIGHT_PALETTE[token], WHITE)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps accent and status tokens at the 3:1 UI-component threshold', () => {
    for (const token of ['brand', 'brandMid', 'brandDeep', 'success', 'error', 'warn'] as const) {
      expect(ratio(DARK_PALETTE[token], BLACK)).toBeGreaterThanOrEqual(3)
      expect(ratio(LIGHT_PALETTE[token], WHITE)).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps diff foregrounds AA-legible on their row tints and on plain backgrounds', () => {
    // Row path: the tint rides along as a background.
    expect(ratio(DARK_PALETTE.diffAddFg, DARK_PALETTE.diffAdd)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(DARK_PALETTE.diffDelFg, DARK_PALETTE.diffDel)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(LIGHT_PALETTE.diffAddFg, LIGHT_PALETTE.diffAdd)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(LIGHT_PALETTE.diffDelFg, LIGHT_PALETTE.diffDel)).toBeGreaterThanOrEqual(4.5)
    // Markdown span path: the same tokens paint with no background at all.
    expect(ratio(DARK_PALETTE.diffAddFg, BLACK)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(DARK_PALETTE.diffDelFg, BLACK)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(LIGHT_PALETTE.diffAddFg, WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(LIGHT_PALETTE.diffDelFg, WHITE)).toBeGreaterThanOrEqual(4.5)
  })
})
