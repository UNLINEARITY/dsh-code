/** Palette tokens match the design platform; paint wraps survive color level. */

import chalk from 'chalk'
import { describe, expect, it } from 'vitest'
import {
  TUI_RGB, brand, brandBright, brandDeep, dim, error, success, warn,
  DARK_PALETTE, LIGHT_PALETTE, PALETTES, THEME_NAMES, getPalette, getTheme,
  inkColor, parseThemeName, resolveTheme, setTheme,
} from '../src/theme.ts'

describe('tui theme', () => {
  it('pins the DeepSeek brand blues from the design platform', () => {
    expect(TUI_RGB.brand).toEqual([65, 118, 230])
    expect(TUI_RGB.brandBright).toEqual([103, 158, 254])
    expect(TUI_RGB.brandDeep).toEqual([72, 104, 178])
  })

  it('keeps every token an RGB triple', () => {
    for (const value of Object.values(TUI_RGB)) {
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

  it('keeps TUI_RGB as the dark palette under its original export name', () => {
    expect(TUI_RGB).toEqual(DARK_PALETTE)
    expect(PALETTES.dark).toEqual(DARK_PALETTE)
    expect(TUI_RGB.brandMid).toEqual([86, 134, 254])
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
    expect(inkColor(TUI_RGB.brandDeep)).toBe('rgb(72, 104, 178)')
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

  it('parses persisted theme names with a dark fallback', () => {
    expect(parseThemeName('light')).toBe('light')
    expect(parseThemeName('auto')).toBe('auto')
    expect(parseThemeName('dark')).toBe('dark')
    expect(parseThemeName(undefined)).toBe('dark')
    expect(parseThemeName('sepia')).toBe('dark')
    expect(parseThemeName(42)).toBe('dark')
  })
})
