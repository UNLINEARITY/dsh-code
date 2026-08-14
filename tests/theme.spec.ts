/** Palette tokens match the design platform; paint wraps survive color level. */

import chalk from 'chalk'
import { describe, expect, it } from 'vitest'
import {
  TUI_RGB, brand, brandBright, brandDeep, dim, error, success, warn,
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
})
