/** Pure viewport and cursor rules for the exclusive Ctrl+O history inspector. */

/** Terminal-space allocation for the inspector's one dynamic screen. */
export interface InspectorViewport {
  /** Maximum dynamic rows, kept strictly below the terminal height. */
  maxHeight: number
  /** Rows available to the selected entry after border, title, and footer. */
  bodyRows: number
  /** Columns available inside the horizontal border and padding. */
  contentColumns: number
  /** Tiny terminals use a borderless one-line close hint. */
  compact: boolean
}

/** One compact status row plus the three-row read-only composer frame. */
const INSPECTOR_CHROME_ROWS = 4

/**
 * Keep the inspector plus its persistent status/composer chrome below
 * `stdout.rows`: at equality Ink clears the terminal and rewrites all
 * accumulated `<Static>` output on every frame.
 */
export function inspectorViewport(columns: number, rows: number): InspectorViewport {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  const maxHeight = Math.max(0, safeRows - 1 - INSPECTOR_CHROME_ROWS)
  const compact = maxHeight < 5 || safeColumns < 8
  return {
    maxHeight,
    bodyRows: compact ? 0 : maxHeight - 4,
    contentColumns: compact ? Math.max(1, safeColumns - 1) : Math.max(1, safeColumns - 4),
    compact,
  }
}

/** Follow appended history only while the inspector cursor was at the tail. */
export function followInspectorCursor(cursor: number, previousLength: number, nextLength: number): number {
  const nextLast = Math.max(0, nextLength - 1)
  if (cursor >= Math.max(0, previousLength - 1)) return nextLast
  return Math.min(cursor, nextLast)
}
