/** Shared one-line query editor for keyboard-owned filtering panels. */

import { stripPasteMarkers } from './keyboard.ts'
import { deleteLastGrapheme } from './render/editor.ts'

/**
 * Apply one keystroke to a panel search query. IME commits arrive as one
 * multi-character chunk, so the whole printable run is appended; paste
 * markers are stripped and control-laden chunks are ignored.
 */
export function editQuery(query: string, input: string, key: { backspace?: boolean; delete?: boolean }): string | undefined {
  if (key.backspace || key.delete) return deleteLastGrapheme(query)
  const text = stripPasteMarkers(input)
  if (text !== '' && !/[\u0000-\u001f\u007f]/u.test(text)) return query + text
  return undefined
}
