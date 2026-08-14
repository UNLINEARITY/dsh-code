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
