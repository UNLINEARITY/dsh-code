/** Palette tokens match the design platform; paint wraps survive color level. */

import chalk from 'chalk'
import { describe, expect, it } from 'vitest'
import { rainbowRoll } from '../src/rainbow.ts'
import {
  brand, brandBright, brandDeep, dim, error, success, warn,
  ACCENT_RING, DARK_PALETTE, FLOW_ANCHORS, LIGHT_PALETTE, PALETTES, PRISMATIC_PALETTE,
  THEMES, THEME_NAMES, diffBackground, getPalette, getTheme, inkColor, isPrismatic, isRainbow,
  parseThemeName, promptRowTokens, resolveTheme, rowBackground, setTheme, surfaceAccent, themeFlow, type RgbTriple,
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

  it('pins the prismatic synthwave palette', () => {
    expect(PRISMATIC_PALETTE.brand).toEqual([139, 92, 246])
    expect(PRISMATIC_PALETTE.brandBright).toEqual([240, 171, 252])
    expect(PRISMATIC_PALETTE.brandMid).toEqual([167, 139, 250])
    expect(PRISMATIC_PALETTE.brandDeep).toEqual([124, 58, 237])
    expect(PRISMATIC_PALETTE.dim).toEqual([166, 163, 184])
    expect(PRISMATIC_PALETTE.text).toEqual([240, 238, 249])
    expect(PRISMATIC_PALETTE.code).toEqual([103, 232, 249])
    // Semantic colors ride the dark values verbatim: green still means added.
    expect(PRISMATIC_PALETTE.success).toEqual(DARK_PALETTE.success)
    expect(PRISMATIC_PALETTE.error).toEqual(DARK_PALETTE.error)
    expect(PRISMATIC_PALETTE.warn).toEqual(DARK_PALETTE.warn)
    expect(PRISMATIC_PALETTE.diffAdd).toEqual(DARK_PALETTE.diffAdd)
    expect(PRISMATIC_PALETTE.diffDel).toEqual(DARK_PALETTE.diffDel)
    expect(PRISMATIC_PALETTE.diffAddFg).toEqual(DARK_PALETTE.diffAddFg)
    expect(PRISMATIC_PALETTE.diffDelFg).toEqual(DARK_PALETTE.diffDelFg)
    // The band stays hue-free under the neon skin too.
    expect(PRISMATIC_PALETTE.composerBand).toEqual([46, 46, 52])
    expect(Math.max(...PRISMATIC_PALETTE.composerBand) - Math.min(...PRISMATIC_PALETTE.composerBand)).toBeLessThanOrEqual(6)
  })

  it('activates prismatic through setTheme and reports it via isPrismatic', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      setTheme('prismatic')
      expect(getTheme()).toBe('prismatic')
      expect(getPalette()).toBe(PRISMATIC_PALETTE)
      expect(resolveTheme('prismatic')).toBe('prismatic')
      expect(isPrismatic()).toBe(true)
      expect(brandBright('x')).toContain('240')
      setTheme('dark')
      expect(isPrismatic()).toBe(false)
      expect(getPalette()).toBe(DARK_PALETTE)
    } finally {
      chalk.level = level
      setTheme('dark')
    }
  })

  it('rotates the surface ring only under prismatic', () => {
    try {
      setTheme('dark')
      expect(surfaceAccent(0, DARK_PALETTE.brand)).toBe(DARK_PALETTE.brand)
      expect(surfaceAccent(7, LIGHT_PALETTE.dim)).toBe(LIGHT_PALETTE.dim)
      setTheme('prismatic')
      for (const [index, ring] of [0, 1, 2, 3, 4, 5, 6, 7].map(i => [i, ACCENT_RING[i % ACCENT_RING.length]] as const)) {
        expect(surfaceAccent(index, DARK_PALETTE.brand)).toBe(ring)
      }
      // Negative indices wrap like a modulo should.
      expect(surfaceAccent(-1, DARK_PALETTE.brand)).toBe(ACCENT_RING[3])
    } finally {
      setTheme('dark')
    }
  })

  it('activates rainbow through setTheme with the per-launch roll', () => {
    try {
      setTheme('rainbow')
      expect(getTheme()).toBe('rainbow')
      expect(isRainbow()).toBe(true)
      expect(getPalette()).toBe(rainbowRoll().palette)
      // The flow walk comes from the roll with its phase; dark has none.
      const flow = themeFlow()
      expect(flow?.anchors).toBe(rainbowRoll().flowAnchors)
      expect(flow?.phaseMs).toBe(rainbowRoll().flowPhaseMs)
      expect(surfaceAccent(5, DARK_PALETTE.brand)).toBe(rainbowRoll().ring[1])
      setTheme('dark')
      expect(themeFlow()).toBeUndefined()
      expect(isRainbow()).toBe(false)
    } finally {
      setTheme('dark')
    }
  })

  it('keeps both palettes on the same token keys and the canonical names', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(['dark', 'light', 'prismatic'])
    expect(Object.keys(LIGHT_PALETTE).sort()).toEqual(Object.keys(DARK_PALETTE).sort())
    expect(Object.keys(PRISMATIC_PALETTE).sort()).toEqual(Object.keys(DARK_PALETTE).sort())
    expect(THEME_NAMES).toEqual(['dark', 'light', 'prismatic', 'rainbow', 'auto'])
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
      expect(resolveTheme('prismatic')).toBe('prismatic')
      expect(resolveTheme('rainbow')).toBe('rainbow')
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
    expect(parseThemeName('prismatic')).toBe('prismatic')
    expect(parseThemeName('rainbow')).toBe('rainbow')
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
      // Prismatic paints on a black terminal like dark.
      expect(ratio(PRISMATIC_PALETTE[token], BLACK)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps accent and status tokens at the 3:1 UI-component threshold', () => {
    for (const token of ['brand', 'brandMid', 'brandDeep', 'success', 'error', 'warn'] as const) {
      expect(ratio(DARK_PALETTE[token], BLACK)).toBeGreaterThanOrEqual(3)
      expect(ratio(LIGHT_PALETTE[token], WHITE)).toBeGreaterThanOrEqual(3)
      expect(ratio(PRISMATIC_PALETTE[token], BLACK)).toBeGreaterThanOrEqual(3)
    }
  })

  it('derives each prompt-row bar from the palette and keeps it AA-legible', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      const parse = (ink: string): RgbTriple => {
        const [r, g, b] = ink.replace(/[^0-9,]/gu, '').split(',').map(Number)
        return [r ?? 0, g ?? 0, b ?? 0]
      }
      for (const [name, palette, surface] of [
        ['dark', DARK_PALETTE, BLACK],
        ['light', LIGHT_PALETTE, WHITE],
        ['prismatic', PRISMATIC_PALETTE, BLACK],
      ] as const) {
        setTheme(name === 'light' ? 'light' : name)
        const colors = ['prompt', 'queued', 'steered'] as const
        for (const color of colors) {
          const background = rowBackground(color)
          expect(background).toBeDefined()
          const tint = parse(background!)
          // The bar is the palette's own color laid over the surface, and the
          // color stays AA both on the bar and alone on the terminal (16-color
          // terminals drop the background).
          expect(ratio(palette[color], tint)).toBeGreaterThanOrEqual(4.5)
          expect(ratio(palette[color], surface)).toBeGreaterThanOrEqual(4.5)
          // Derived, never hardcoded: the tint differs from both endpoints.
          expect(tint).not.toEqual(palette[color])
          expect(tint).not.toEqual(surface)
        }
        // The three kinds must stay distinguishable from one another.
        const tints = colors.map(color => String(rowBackground(color)))
        expect(new Set(tints).size).toBe(3)
        expect(promptRowTokens(undefined).fg).toBe('prompt')
        expect(promptRowTokens('queued').fg).toBe('queued')
        expect(promptRowTokens('steered').fg).toBe('steered')
      }
      // A rolled rainbow carries its own three colors, not a fixed triple.
      const rainbow = rainbowRoll().palette
      // The roll supplies the three row colors, so a reroll repaints them.
      expect(rainbow.prompt).toEqual(rainbow.brandBright)
      expect(rainbow.queued).toEqual(rainbow.warn)
      expect(new Set([String(rainbow.prompt), String(rainbow.queued), String(rainbow.steered)]).size).toBe(3)

      // 16-color terminals keep the foreground-only look.
      chalk.level = 1
      setTheme('dark')
      expect(rowBackground('prompt')).toBeUndefined()
      expect(rowBackground('steered')).toBeUndefined()
    } finally {
      chalk.level = level
      setTheme('dark')
    }
  })

  it('keeps the prismatic ring and flow anchors legible on black', () => {
    // Panel borders/titles cycle the ring — accent threshold.
    for (const accent of ACCENT_RING) {
      expect(ratio(accent, BLACK)).toBeGreaterThanOrEqual(3)
    }
    // Flow anchors paint streaming/busy foregrounds while oscillating, so
    // every anchor must clear the body threshold on its own.
    for (const anchor of FLOW_ANCHORS) {
      expect(ratio(anchor, BLACK)).toBeGreaterThanOrEqual(4.5)
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
