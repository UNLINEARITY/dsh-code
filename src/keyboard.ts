/**
 * Keyboard enhancement protocol (Codex `keyboard_modes` parity) and the
 * kitty CSI-u normalization layer.
 *
 * The TUI pushes the kitty keyboard protocol with DISAMBIGUATE_ESCAPE_CODES
 * and REPORT_ALTERNATE_KEYS (flags 1|4 = `\x1b[>5u`). Event types are
 * deliberately NOT requested: Ink 5's parser cannot decode the
 * `:event-type` suffix, and repeat/release reporting buys this surface
 * nothing.
 *
 * Ink 5 also cannot parse most CSI-u forms at all — they fall through its
 * regex as unnamed sequences and get INSERTED AS DRAFT TEXT. The composer's
 * stdin read patch therefore rewrites every CSI-u form it can decode back
 * to the legacy byte or canonical sequence the existing key handling
 * already understands, before Ink ever parses the chunk.
 * @module @deepseek-ai/dsh-code/keyboard
 */

/** Push keyboard enhancement (modifyOtherKeys off, kitty flags 1|4). */
export const KEYBOARD_ENHANCE_ENABLE = '\x1b[>4;0m\x1b[>5u'

/** Pop the enhancement stack and reset modifyOtherKeys (exit path). */
export const KEYBOARD_ENHANCE_DISABLE = '\x1b[<u\x1b[>4;0m'

/** Enable bracketed paste reporting. */
export const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'

/** Disable bracketed paste reporting. */
export const BRACKETED_PASTE_DISABLE = '\x1b[?2004l'

/** Bracketed paste markers as Ink delivers them (it strips the leading ESC). */
export const PASTE_START_MARKER = '[200~'
export const PASTE_END_MARKER = '[201~'

/**
 * Remove bracketed paste markers from one input chunk. Panel drafts accept raw
 * `input` text, where an unhandled paste would otherwise persist the literal
 * "[200~"/"[201~" markers Ink leaves after stripping the ESC byte.
 */
export function stripPasteMarkers(text: string): string {
  return text
    .replaceAll(`\x1b${PASTE_START_MARKER}`, '')
    .replaceAll(`\x1b${PASTE_END_MARKER}`, '')
    .replaceAll(PASTE_START_MARKER, '')
    .replaceAll(PASTE_END_MARKER, '')
}

/** One decoded CSI-u keypress: key code, 1-based modifier param, alternate code. */
interface CsiUKey {
  code: number
  modifiers: number
  alternate?: number
}

/** Match one CSI-u sequence (code, optional ;modifiers, then :event or ;alternate). */
const CSI_U_SOURCE = '\x1b\\[(\\d+)(?:;(\\d+))?(?:[:;](\\d+))?u'

/** Legacy equivalent for one decoded CSI-u key, or undefined to pass through. */
function legacyForKey(key: CsiUKey): string | undefined {
  const bits = Math.max(0, key.modifiers - 1)
  const shift = (bits & 1) !== 0
  const alt = (bits & 2) !== 0
  const ctrl = (bits & 4) !== 0
  if (key.code === 13) {
    // Modified Enter has no dedicated composer behavior. Preserve the legacy
    // Ctrl/Alt bytes and collapse every other form to ordinary Enter.
    if (ctrl) return '\n'
    if (alt) return '\x1b\r'
    return '\r'
  }
  if (key.code === 27) return '\x1b'
  if (key.code === 9) return shift ? '\x1b[Z' : '\t'
  if (key.code === 127) return alt || ctrl ? '\x1b\x7f' : '\x7f'
  // Kitty disambiguate mode reports the six legacy functional keys as CSI u
  // codes 1-6 (Home, Insert, Delete, End, PageUp, PageDown). Ink 5 cannot
  // parse these forms and would insert literal "[3u" text into the draft, so
  // rewrite them to the legacy sequences the input layer already annotates.
  // The modifier parameter passes through: kitty and xterm share the same
  // 1+bit-field encoding (shift 2, alt 3, ctrl 5, ...). Lock-key bits are
  // dropped because the legacy sequences cannot express them.
  if (key.code >= 1 && key.code <= 6) {
    const mask = (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
    const mods = mask === 0 ? '' : `;${mask + 1}`
    if (key.code === 1) return mods === '' ? '\x1b[H' : `\x1b[1${mods}H`
    if (key.code === 4) return mods === '' ? '\x1b[F' : `\x1b[1${mods}F`
    return `\x1b[${key.code}${mods}~`
  }
  if (key.code >= 97 && key.code <= 122) {
    const letter = String.fromCodePoint(key.code)
    if (ctrl) return String.fromCodePoint(key.code - 96)
    if (alt) return '\x1b' + letter
    if (shift) return String.fromCodePoint(key.alternate ?? key.code - 32)
    return letter
  }
  if (key.code >= 65 && key.code <= 90) {
    if (ctrl) return String.fromCodePoint(key.code + 32 - 96)
    if (alt) return '\x1b' + String.fromCodePoint(key.code + 32)
    return String.fromCodePoint(key.code)
  }
  if (key.code >= 32 && key.code <= 126 && key.alternate !== undefined) {
    const base = key.alternate >= 97 && key.alternate <= 122 ? key.alternate : key.code
    if (ctrl && base - 96 >= 1 && base - 96 <= 26) return String.fromCodePoint(base - 96)
    if (alt) return '\x1b' + String.fromCodePoint(key.alternate)
    return String.fromCodePoint(key.alternate)
  }
  return undefined
}

/**
 * Rewrite every decodable kitty CSI-u sequence in one stdin chunk to the
 * legacy form the input layer already handles. Undecodable or non-key
 * sequences pass through untouched, so terminals without the protocol are
 * unaffected.
 */
export function normalizeKeyboardChunk(chunk: string): string {
  if (!chunk.includes('\x1b[') || !chunk.includes('u')) return chunk
  const pattern = new RegExp(CSI_U_SOURCE, 'g')
  return chunk.replace(pattern, (whole, code: string, mods?: string, third?: string) => {
    const legacy = legacyForKey({
      code: Number.parseInt(code, 10),
      modifiers: mods === undefined || mods === '' ? 1 : Math.max(1, Number.parseInt(mods, 10)),
      alternate: third !== undefined && third !== '' ? Number.parseInt(third, 10) : undefined,
    })
    return legacy ?? whole
  })
}
