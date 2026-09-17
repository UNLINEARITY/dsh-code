/** Bounded slash-command and mention completion menu. */

import { createElement, type ReactElement } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { CompletionCandidate } from './completion.ts'
import { selectionWindow } from './render/inspector.ts'
import { visibleColumns } from './render/markdown.ts'
import { displayText, padColumns, singleLineText, truncateColumns } from './render/text.ts'
import { dim, getPalette, inkColor } from './theme.ts'

/** Shared geometry used by both the menu view and the App dynamic-row budget. */
function completionMenuMetrics(terminalRows: number): { limit: number; showFooter: boolean; verticalPadding: number } {
  const showFooter = terminalRows >= 12
  const verticalPadding = terminalRows >= 14 ? 1 : 0
  const limit = Math.max(1, Math.min(6, terminalRows - (showFooter ? 11 : 10) - verticalPadding * 2))
  return { limit, showFooter, verticalPadding }
}

/** Total physical rows occupied by the completion menu at this terminal height. */
export function completionMenuRowCount(terminalRows: number, rowCount: number): number {
  const { limit, showFooter, verticalPadding } = completionMenuMetrics(terminalRows)
  const visible = rowCount === 0 ? 1 : Math.min(rowCount, limit)
  const hidden = rowCount === 0 ? 0 : rowCount - visible
  return visible + (hidden > 0 ? 1 : 0) + (showFooter ? 1 : 0) + verticalPadding * 2
}

/** Completion view anchored directly above the composer band. */
export function CompletionMenu({ active, mention, index, rows, error }: {
  active: boolean
  mention: boolean
  index: number
  rows: readonly CompletionCandidate[]
  error?: string
}): ReactElement | undefined {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const terminalRows = stdout?.rows ?? 30
  if (!active) return undefined
  const contentColumns = Math.max(1, columns - 4)
  const nameWidth = mention
    ? Math.max(1, contentColumns - 2)
    : Math.min(18, Math.max(1, contentColumns - 2), Math.max(0, ...rows.map(row => visibleColumns(row.label))) + 2)
  const descBudget = Math.max(0, contentColumns - nameWidth - 2)
  const { limit, showFooter, verticalPadding } = completionMenuMetrics(terminalRows)
  const selected = rows.length === 0 ? 0 : index % rows.length
  const first = selectionWindow(selected, rows.length, limit)
  const visible = rows.slice(first, first + limit)
  const hidden = rows.length - visible.length
  return createElement(
    Box,
    { flexDirection: 'column', marginLeft: 2, paddingY: verticalPadding },
    ...(rows.length === 0
      ? [error === undefined
        ? createElement(Text, { key: 'loading', dimColor: true }, 'searching…')
        : createElement(
          Text,
          { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
          truncateColumns(`workspace search unavailable: ${singleLineText(error)} · keep typing to retry`, contentColumns),
        )]
      : visible.map((candidate, at) => {
        const absolute = first + at
        return createElement(
          Text,
          {
            key: candidate.label,
            color: absolute === selected ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
            wrap: 'truncate-end',
          },
          `${absolute === selected ? '❯ ' : '  '}${padColumns(candidate.label, nameWidth)}${dim(truncateColumns(displayText(candidate.description), descBudget))}`,
        )
      })),
    hidden > 0
      ? createElement(Text, { key: 'more', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, `  … +${hidden} more`)
      : undefined,
    showFooter
      ? createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, dim(mention ? `↑↓ choose · ${rows.length} items · tab insert` : `↑↓ choose · ${rows.length} items · tab complete`))
      : undefined,
  )
}
