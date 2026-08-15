/** Pure viewport, selection, and scrolling rules for exclusive TUI panels. */

/** Terminal-space allocation for the inspector's one dynamic screen. */
export interface InspectorViewport {
  /** Maximum dynamic rows, kept strictly below the terminal height. */
  maxHeight: number
  /** Rows available to the selected entry after border, title, and footer. */
  bodyRows: number
  /** Optional blank rows separating title/body/footer on roomy terminals. */
  gapRows: 0 | 2
  /** Columns available inside the horizontal border and padding. */
  contentColumns: number
  /** Tiny terminals use a borderless one-line close hint. */
  compact: boolean
}

/** Composer/status chrome plus one optional, fixed-height local notice row. */
const INSPECTOR_CHROME_ROWS = 5

/** One transcript-to-composer gutter, collapsed on short terminals. */
export function layoutGutterRows(rows: number): 0 | 1 {
  return Math.max(1, Math.floor(rows)) >= 14 ? 1 : 0
}

/**
 * Keep the inspector plus its persistent status/composer chrome below
 * `stdout.rows`: at equality Ink clears the terminal and rewrites all
 * accumulated `<Static>` output on every frame.
 */
export function panelViewport(columns: number, rows: number): InspectorViewport {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  // Two spare rows cover Ink's first-frame transition from existing Static
  // scrollback into a tall dynamic panel. A one-row margin is insufficient:
  // the transition can still take the full-terminal rewrite path at rows - 1.
  const maxHeight = Math.max(0, Math.min(
    safeRows - 2 - INSPECTOR_CHROME_ROWS - layoutGutterRows(safeRows),
    Math.floor(safeRows / 2),
  ))
  const compact = maxHeight < 5 || safeColumns < 8
  const gapRows = !compact && maxHeight >= 7 ? 2 : 0
  return {
    maxHeight,
    bodyRows: compact ? 0 : maxHeight - 4 - gapRows,
    gapRows,
    contentColumns: compact ? Math.max(1, safeColumns - 1) : Math.max(1, safeColumns - 4),
    compact,
  }
}

/** Backward-compatible name for the Ctrl+O-specific caller and tests. */
export function inspectorViewport(columns: number, rows: number): InspectorViewport {
  return panelViewport(columns, rows)
}

/** Clamp a first-visible row to the range representable by one viewport. */
export function clampScroll(offset: number, totalRows: number, visibleRows: number): number {
  const total = Math.max(0, Math.floor(totalRows))
  const size = Math.max(0, Math.floor(visibleRows))
  const last = Math.max(0, total - size)
  return Math.max(0, Math.min(Math.floor(offset), last))
}

/** Move a viewport by a signed row delta without escaping its content. */
export function moveScroll(offset: number, delta: number, totalRows: number, visibleRows: number): number {
  return clampScroll(offset + delta, totalRows, visibleRows)
}

/** Keep one focused row visible while preserving the current window when possible. */
export function revealRow(offset: number, row: number, totalRows: number, visibleRows: number): number {
  const size = Math.max(1, Math.floor(visibleRows))
  const target = Math.max(0, Math.min(Math.floor(row), Math.max(0, totalRows - 1)))
  if (target < offset) return clampScroll(target, totalRows, size)
  if (target >= offset + size) return clampScroll(target - size + 1, totalRows, size)
  return clampScroll(offset, totalRows, size)
}

/** Center a selected list row where possible, clamped at both ends. */
export function selectionWindow(cursor: number, totalRows: number, visibleRows: number): number {
  return clampScroll(cursor - Math.floor(Math.max(1, visibleRows) / 2), totalRows, visibleRows)
}

/** Follow appended history only while the inspector cursor was at the tail. */
export function followInspectorCursor(cursor: number, previousLength: number, nextLength: number): number {
  const nextLast = Math.max(0, nextLength - 1)
  if (cursor >= Math.max(0, previousLength - 1)) return nextLast
  return Math.min(cursor, nextLast)
}
