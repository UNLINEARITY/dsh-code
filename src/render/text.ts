/**
 * Display-boundary sanitization for externally sourced text (model output,
 * tool payloads, skill descriptions). Control characters — including ANSI
 * CSI/OSC escape sequences — would otherwise pass through Ink into the
 * terminal, letting output rewrite the screen or inject prompts. Newlines
 * and tabs survive; everything else in C0/C1 plus DEL becomes a visible
 * `\xNN` escape.
 *
 * @module @deepseek-ai/dsh-code/render/text
 */

/** C0 controls except tab (0x09) and newline (0x0a), plus DEL and C1. */
const CONTROL_ESCAPE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

/**
 * Escape control characters so externally sourced text cannot drive the
 * terminal.
 * @param text - raw text from a session event, tool payload, or catalog.
 * @returns text with every control character (except `\n`, `\t`) rendered
 * as a literal `\xNN` escape.
 */
export function displayText(text: string): string {
  return text.replace(CONTROL_ESCAPE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** A display-safe suffix bounded by terminal rows and columns. */
export interface DisplayTail {
  /** Sanitized suffix suitable for direct terminal rendering. */
  text: string
  /** Whether content before the returned suffix was omitted. */
  truncated: boolean
}

/** Terminal-cell width matching the TUI's existing CJK-aware wrapping rule. */
function cellWidth(text: string): number {
  let columns = 0
  for (const char of text) {
    columns += (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1
  }
  return columns
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
 * Explicit newlines and terminal wrapping both consume rows.
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

    const safe = displayText(previous.char)
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
