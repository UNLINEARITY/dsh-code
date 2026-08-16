/**
 * Display-boundary sanitization for externally sourced text (model output,
 * tool payloads, skill descriptions). Control characters — including ANSI
 * CSI/OSC escape sequences — would otherwise pass through Ink into the
 * terminal, letting output rewrite the screen or inject prompts. Newlines
 * survive; everything else in C0/C1 plus DEL becomes a visible `\xNN`
 * escape, and bidi overrides / invisible format controls / Unicode line and
 * paragraph separators become a visible `\uXXXX` escape (terminal emulators
 * that render bidirectional text would otherwise reorder the displayed
 * glyphs and let a command read as something it is not).
 *
 * @module @deepseek-ai/dsh-code/render/text
 */

/** C0 controls except tab (0x09) and newline (0x0a), plus DEL and C1. */
const CONTROL_ESCAPE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

/**
 * Bidi overrides and isolates (U+202A-202E, U+2066-2069), the Arabic Letter
 * Mark (U+061C), directional and zero-width format characters (U+200B,
 * U+200E/200F, U+2060-2064, U+FEFF), and Unicode line/paragraph separators
 * (U+2028/2029). Terminal emulators with bidi support (Windows Terminal,
 * iTerm2, kitty, WezTerm) reorder or hide these, so they must never reach
 * the terminal raw.
 */
const INVISIBLE_ESCAPE = /[\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu

/**
 * Escape control and deceptive characters so externally sourced text cannot
 * drive the terminal. C0/C1/DEL render as a literal `\xNN` escape; bidi,
 * invisible-format, and separator controls render as a literal `\uXXXX`
 * escape. Newlines and tabs survive (budgeted callers normalize tabs).
 * @param text - raw text from a session event, tool payload, or catalog.
 * @returns display-safe text with every injectable character made visible.
 */
export function displayText(text: string): string {
  return text
    .replace(CONTROL_ESCAPE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(INVISIBLE_ESCAPE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Collapse external text to one terminal-safe logical row. */
export function singleLineText(text: string): string {
  return displayText(text).replace(/\r?\n/gu, ' ↵ ').replace(/\t/gu, '  ')
}

/** Terminal-cell width matching the TUI's existing CJK-aware wrapping rule. */
function cellWidth(text: string): number {
  let columns = 0
  for (const char of text) {
    columns += (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1
  }
  return columns
}

/**
 * Truncate one display-safe row without ever exceeding its physical-column
 * budget. The ellipsis is included inside the budget, matching Codex's popup
 * truncation contract; the previous app-local helper appended it after the
 * row was already full and could force an extra terminal wrap.
 */
export function truncateColumns(text: string, columns: number): string {
  const limit = Math.max(0, Math.floor(columns))
  if (limit === 0) return ''
  if (cellWidth(text) <= limit) return text

  const contentLimit = limit - 1
  let used = 0
  let result = ''
  for (const char of text) {
    const width = cellWidth(char)
    if (used + width > contentLimit) break
    result += char
    used += width
  }
  return `${result}…`
}

/** A display-safe suffix bounded by terminal rows and columns. */
export interface DisplayTail {
  /** Sanitized suffix suitable for direct terminal rendering. */
  text: string
  /** Whether content before the returned suffix was omitted. */
  truncated: boolean
}

/** Read one Unicode character immediately before `end`. */
function previousCharacter(text: string, end: number): { char: string; start: number } {
  const last = text.charCodeAt(end - 1)
  if (last >= 0xdc00 && last <= 0xdfff && end >= 2) {
    const first = text.charCodeAt(end - 2)
    if (first >= 0xd800 && first <= 0xdbff) {
      return { char: text.slice(end - 2, end), start: end - 2 }
    }
  }
  return { char: text.slice(end - 1, end), start: end - 1 }
}

/**
 * Keep only the newest display-safe text that fits a terminal rectangle.
 * The scan walks backward and stops as soon as the suffix is full, so a long
 * reasoning stream does not rescan its entire accumulated prefix per chunk.
 * Explicit newlines and terminal wrapping both consume rows; tabs expand to
 * two spaces so terminal tab stops (which render at contextual column 8
 * boundaries, not at the budgeted cell count) cannot inflate the physical
 * row count of the live region.
 * @param text - raw externally sourced text.
 * @param columns - available terminal columns.
 * @param rows - available terminal rows.
 * @returns a sanitized bounded suffix and whether an earlier prefix was cut.
 */
export function displayTail(text: string, columns: number, rows: number): DisplayTail {
  const columnLimit = Math.max(1, Math.floor(columns))
  const rowLimit = Math.max(1, Math.floor(rows))
  const reversed: string[] = []
  let row = 1
  let used = 0
  let end = text.length

  while (end > 0) {
    const previous = previousCharacter(text, end)
    if (previous.char === '\n') {
      if (row >= rowLimit) break
      reversed.push('\n')
      row += 1
      used = 0
      end = previous.start
      continue
    }

    const safe = previous.char === '\t' ? '  ' : displayText(previous.char)
    const width = cellWidth(safe)
    if (used > 0 && used + width > columnLimit) {
      if (row >= rowLimit) break
      // Materialize the soft wrap. Ink otherwise reflows at word boundaries
      // and can turn a cell-counted two-row suffix into three rendered rows.
      reversed.push('\n')
      row += 1
      used = 0
    }
    const extraRows = Math.floor(Math.max(0, width - 1) / columnLimit)
    if (row + extraRows > rowLimit) break
    row += extraRows
    reversed.push(safe)
    used = extraRows === 0 ? used + width : width - extraRows * columnLimit
    end = previous.start
  }

  return { text: reversed.reverse().join(''), truncated: end > 0 }
}
