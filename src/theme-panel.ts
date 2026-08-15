/**
 * The `/theme` picker (the Codex `/theme` contract): one bounded list over
 * the three color themes — dark, light, and auto (terminal-sensed; auto
 * falls back to dark until OSC-11 detection lands). Enter applies the row
 * and the runner persists it; Esc closes without changing the theme.
 *
 * @module @deepseek-ai/dsh-tui/theme-panel
 */

import { createElement, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { panelViewport } from './render/inspector.ts'
import { truncateColumns } from './render/text.ts'
import { getPalette, inkColor, type ThemeName } from './theme.ts'

/** The three theme rows in canonical order (the /theme selection surface). */
const THEME_ROWS: readonly { id: ThemeName; label: string; description: string }[] = [
  { id: 'dark', label: 'dark', description: 'DeepSeek dark palette (default)' },
  { id: 'light', label: 'light', description: 'light palette for bright terminals' },
  { id: 'auto', label: 'auto', description: 'follow the terminal; dark until detection lands' },
]

/**
 * The /theme list: one row per theme, the current one marked with ●, the
 * focused one with ›. Enter applies the focused theme (the runner persists
 * it), Esc/q closes without changing anything. Colors read the ACTIVE
 * palette, so the panel itself adapts to a light theme once applied.
 */
export function ThemePanel({ current, select, close }: {
  /** Theme name in force (the requested name; 'auto' included). */
  current: ThemeName
  /** Accept one theme name: applied immediately and persisted by the runner. */
  select(name: ThemeName): void
  /** Close without changing the theme. */
  close(): void
}): ReactElement {
  const [cursor, setCursor] = useState(() => {
    const index = THEME_ROWS.findIndex(theme => theme.id === current)
    return index < 0 ? 0 : index
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (key.upArrow) return setCursor(value => (value + THEME_ROWS.length - 1) % THEME_ROWS.length)
    if (key.downArrow) return setCursor(value => (value + 1) % THEME_ROWS.length)
    if (key.return) return select(THEME_ROWS[cursor]!.id)
  })
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/theme · esc close', viewport.contentColumns))
  }
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(getPalette().dim), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns('/theme — color palette', viewport.contentColumns)),
    ...THEME_ROWS.map((theme, index) => {
      const selected = index === cursor
      const active = theme.id === current
      return createElement(
        Text,
        {
          key: theme.id,
          color: selected ? inkColor(getPalette().brandBright) : undefined,
          wrap: 'truncate-end',
        },
        truncateColumns(`${selected ? '› ' : '  '}${active ? '● ' : '○ '}${theme.label}${active ? ' · current' : ''} · ${theme.description}`, viewport.contentColumns),
      )
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns('↑↓ choose · enter apply · esc/q close', viewport.contentColumns)),
  )
}
