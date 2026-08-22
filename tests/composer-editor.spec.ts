/** Pure composer editor-model regressions: wrapping, caret mapping, word
 * motion, kill/yank, sanitization, and the shell-recall boundary gate. */

import { describe, expect, it } from 'vitest'
import {
  caretSite,
  clampCursor,
  composerMaxRows,
  deleteBackward,
  deleteForward,
  deleteLastGrapheme,
  deleteWordBackward,
  deleteWordForward,
  editorModel,
  editorRowParts,
  insertText,
  killToLineEnd,
  killToLineStart,
  lineBounds,
  moveCursorBy,
  moveCursorVertically,
  moveToLineEnd,
  moveToLineStart,
  moveWordLeft,
  moveWordRight,
  remapStableRange,
  replaceRangePreservingCursor,
  sanitizeDraftText,
  shouldRecallNavigate,
} from '../src/render/editor.ts'

describe('sanitizeDraftText', () => {
  it('normalizes line endings and tabs', () => {
    expect(sanitizeDraftText('a\r\nb\rc\td')).toBe('a\nb\nc  d')
  })
  it('strips injectable control characters instead of escaping them', () => {
    expect(sanitizeDraftText('x\x07y\x1b[31m')).toBe('xy[31m')
  })
  it('strips the stray ESC that rides Windows Terminal file drops instead of escaping it', () => {
    expect(sanitizeDraftText('C:\\pics\\pre2.gif\x1b')).toBe('C:\\pics\\pre2.gif')
  })
  it('keeps newlines and widens tabs while removing other control bytes', () => {
    expect(sanitizeDraftText('a\rb')).toBe('a\nb')
    expect(sanitizeDraftText('q\u0000w\u007fx')).toBe('qwx')
  })
})

describe('clampCursor', () => {
  it('never splits a surrogate pair', () => {
    expect(clampCursor('a\u{1F600}b', 2)).toBe(1)
    expect(clampCursor('a\u{1F600}b', 3)).toBe(3)
  })
  it('keeps ZWJ emoji families whole', () => {
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F466}'
    expect(clampCursor(family, 2)).toBe(0)
    expect(clampCursor(family, family.length)).toBe(family.length)
  })
})

describe('editorModel wrapping', () => {
  it('hard-wraps wide CJK graphemes without splitting cells', () => {
    const model = editorModel('一二三四五', 4)
    expect(model.rows.map(row => row.text)).toEqual(['一二', '三四', '五'])
  })
  it('maps boundaries and columns on each row', () => {
    const model = editorModel('ab cd', 10)
    expect(model.rows).toHaveLength(1)
    const row = model.rows[0]!
    expect(row.offsets).toEqual([0, 1, 2, 3, 4, 5])
    expect(row.columns).toEqual([0, 1, 2, 3, 4, 5])
    expect(row.cuts).toEqual([0, 1, 2, 3, 4, 5])
  })
  it('keeps explicit newlines as row breaks with a trailing empty row', () => {
    const model = editorModel('one\ntwo\n', 20)
    expect(model.rows.map(row => row.text)).toEqual(['one', 'two', ''])
  })
  it('seeds the continuation row with its own start boundary', () => {
    const model = editorModel('abcdef', 3)
    expect(model.rows.map(row => row.text)).toEqual(['abc', 'def'])
    expect(model.rows[1]!.offsets[0]).toBe(3)
    expect(model.rows[1]!.columns[0]).toBe(0)
  })
})

describe('caretSite', () => {
  it('maps offsets across wrapped rows and row ends', () => {
    const model = editorModel('abcd\n ef', 4)
    expect(caretSite(model, 0)).toEqual({ row: 0, column: 0 })
    expect(caretSite(model, 4)).toEqual({ row: 0, column: 4 })
    expect(caretSite(model, 5)).toEqual({ row: 1, column: 0 })
    expect(caretSite(model, 8)).toEqual({ row: 1, column: 3 })
  })
  it('accounts wide graphemes as two columns', () => {
    const model = editorModel('中文字', 10)
    expect(caretSite(model, 1)).toEqual({ row: 0, column: 2 })
    expect(caretSite(model, 2)).toEqual({ row: 0, column: 4 })
  })
})

describe('editorRowParts', () => {
  it('assigns the caret to exactly one visible row without shifting the others', () => {
    const model = editorModel('first line\nsecond line', 6)
    const site = caretSite(model, model.length)
    const rows = model.rows.map((row, index) => editorRowParts(row, index, site.row, model.length))
    expect(rows.filter(row => row.hasCaret)).toHaveLength(1)
    expect(rows.filter(row => !row.hasCaret).map(row => row.after)).toEqual(
      model.rows.filter((_, index) => index !== site.row).map(row => row.text),
    )
  })
  it('hides the caret without changing row text while input is locked', () => {
    const model = editorModel('hello', 20)
    expect(editorRowParts(model.rows[0]!, 0, 0, 2, false)).toEqual({
      before: '', caret: '', after: 'hello', hasCaret: false,
    })
  })
})

describe('vertical movement', () => {
  it('moves across logical lines clamping to each line end', () => {
    const model = editorModel('short\na longer line\nend', 40)
    expect(moveCursorVertically(model, 5, 0, 1)).toBe(6)
    expect(moveCursorVertically(model, 12, 0, -1)).toBe(0)
  })
  it('preserves the preferred column across moves', () => {
    const model = editorModel('abcdef\nxy\n12345678', 40)
    const mid = moveCursorVertically(model, 3, 3, 1)
    expect(mid).toBe(9)
    expect(moveCursorVertically(model, mid, 3, 1)).toBe(13)
  })
  it('lands on the text boundary when moving beyond the first or last visual row', () => {
    const model = editorModel('abcdef\nxy', 4)
    expect(moveCursorVertically(model, 2, 2, -1)).toBe(0)
    expect(moveCursorVertically(model, model.length - 1, 1, 1)).toBe(model.length)
  })
})

describe('lineBounds', () => {
  it('finds the containing logical line', () => {
    expect(lineBounds('ab\ncdef\ngh', 4)).toEqual({ start: 3, end: 7 })
    expect(lineBounds('ab\ncdef\ngh', 2)).toEqual({ start: 0, end: 2 })
  })
})

describe('word motion (Codex pieces)', () => {
  it('moves left across whitespace and punctuation runs', () => {
    expect(moveWordLeft('foo bar', 7)).toBe(4)
    expect(moveWordLeft('foo  -  bar', 11)).toBe(8)
    expect(moveWordLeft('hello, world', 7)).toBe(5)
  })
  it('moves right to the end of the leading piece', () => {
    expect(moveWordRight('foo bar', 0)).toBe(3)
    expect(moveWordRight('foo  -  bar', 3)).toBe(6)
    expect(moveWordRight('hello, world', 5)).toBe(6)
  })
  it('keeps the current word when moving from its interior', () => {
    expect(moveWordLeft('foo bar baz', 6)).toBe(4)
    expect(moveWordRight('foo bar baz', 5)).toBe(7)
  })
  it('treats each Han grapheme as one word boundary', () => {
    expect(moveWordLeft('中文测试', 4)).toBe(3)
    expect(moveWordRight('中文测试', 0)).toBe(1)
    expect(moveWordRight('hello中文', 5)).toBe(6)
    expect(moveWordRight('中文，测试', 2)).toBe(3)
  })
  it('crosses newlines as whitespace', () => {
    expect(moveWordLeft('one\ntwo', 7)).toBe(4)
    expect(moveWordRight('one\ntwo', 3)).toBe(7)
  })
})

describe('delete helpers', () => {
  it('deleteBackward removes the whole grapheme cluster', () => {
    expect(deleteBackward('a\u{1F600}b', 3)).toEqual({ value: 'ab', cursor: 1, killed: undefined })
  })
  it('deleteForward removes the cluster at the cursor', () => {
    expect(deleteForward('a\u{1F600}b', 1).value).toBe('ab')
  })
  it('deleteWordBackward kills into the kill buffer', () => {
    expect(deleteWordBackward('foo bar', 7)).toEqual({ value: 'foo ', cursor: 4, killed: 'bar' })
  })
  it('deleteWordForward kills through following whitespace', () => {
    expect(deleteWordForward('foo bar baz', 3)).toEqual({ value: 'foo baz', cursor: 3, killed: ' bar' })
  })
  it('word deletion from inside a word never consumes its neighbours', () => {
    expect(deleteWordBackward('foo bar baz', 6)).toEqual({ value: 'foo r baz', cursor: 4, killed: 'ba' })
    expect(deleteWordForward('foo bar baz', 5)).toEqual({ value: 'foo b baz', cursor: 5, killed: 'ar' })
  })
})

describe('line boundary movement', () => {
  it('keeps Home/End on one logical line and lets repeated Ctrl+A/E cross lines', () => {
    const value = 'one\ntwo\nthree'
    expect(moveToLineStart(value, 6, false)).toBe(4)
    expect(moveToLineStart(value, 4, true)).toBe(0)
    expect(moveToLineEnd(value, 5, false)).toBe(7)
    expect(moveToLineEnd(value, 7, true)).toBe(value.length)
  })
})

describe('asynchronous draft anchors', () => {
  it('remaps ranges across edits wholly before or after the anchor', () => {
    expect(remapStableRange('say @pic now', 'please say @pic now', { start: 4, end: 8 })).toEqual({ start: 11, end: 15 })
    expect(remapStableRange('say @pic now', 'say @pic now please', { start: 4, end: 8 })).toEqual({ start: 4, end: 8 })
  })
  it('rejects an edit overlapping the captured range', () => {
    expect(remapStableRange('say @pic now', 'say @photo now', { start: 4, end: 8 })).toBeUndefined()
  })
  it('replaces an anchor without stealing a cursor moved elsewhere', () => {
    expect(replaceRangePreservingCursor('say @pic now', 12, { start: 4, end: 8 }, '@pic.png')).toEqual({
      value: 'say @pic.png now',
      cursor: 16,
      killed: undefined,
    })
    expect(replaceRangePreservingCursor('say @pic now', 0, { start: 4, end: 8 }, '@pic.png').cursor).toBe(0)
  })
})

describe('kill and yank', () => {
  it('killToLineStart removes to BOL and the newline at BOL', () => {
    expect(killToLineStart('one\ntwo', 7)).toEqual({ value: 'one\n', cursor: 4, killed: 'two' })
    expect(killToLineStart('one\ntwo', 5)).toEqual({ value: 'one\nwo', cursor: 4, killed: 't' })
  })
  it('killToLineEnd removes to EOL and the newline at EOL', () => {
    expect(killToLineEnd('one\ntwo', 3)).toEqual({ value: 'onetwo', cursor: 3, killed: '\n' })
    expect(killToLineEnd('one\ntwo', 1)).toEqual({ value: 'o\ntwo', cursor: 1, killed: 'ne' })
  })
  it('insertText sanitizes and yank round-trips a kill', () => {
    const killed = killToLineEnd('hello world', 5).killed
    expect(insertText('hello ', 6, killed!)).toEqual({
      value: 'hello  world',
      cursor: 12,
      killed: undefined,
    })
  })
})

describe('moveCursorBy', () => {
  it('steps by graphemes in both directions', () => {
    expect(moveCursorBy('a\u{1F600}b', 1, 1)).toBe(3)
    expect(moveCursorBy('a\u{1F600}b', 3, -1)).toBe(1)
  })
})

describe('composerMaxRows', () => {
  it('caps at six rows on tall terminals and collapses on short ones', () => {
    expect(composerMaxRows(40)).toBe(6)
    expect(composerMaxRows(24)).toBe(4)
    expect(composerMaxRows(12)).toBe(1)
  })
})

describe('shouldRecallNavigate (boundary gate)', () => {
  it('recalls older from an empty draft but never newer', () => {
    expect(shouldRecallNavigate('', 0, null, -1)).toBe(true)
    expect(shouldRecallNavigate('', 0, null, 1)).toBe(false)
  })
  it('recalls only past the directional boundary of the unchanged recalled entry', () => {
    expect(shouldRecallNavigate('old', 0, 'old', -1)).toBe(true)
    expect(shouldRecallNavigate('old', 3, 'old', -1)).toBe(false)
    expect(shouldRecallNavigate('old', 3, 'old', 1)).toBe(true)
    expect(shouldRecallNavigate('old', 0, 'old', 1)).toBe(false)
    expect(shouldRecallNavigate('new', 3, 'old', 1)).toBe(false)
  })
})

describe('deleteLastGrapheme', () => {
  it('deletes whole graphemes including surrogate pairs and ZWJ families', () => {
    expect(deleteLastGrapheme('a👨‍👩‍👦')).toBe('a')
    expect(deleteLastGrapheme('你好')).toBe('你')
    expect(deleteLastGrapheme('ab')).toBe('a')
  })
  it('returns empty for empty drafts', () => {
    expect(deleteLastGrapheme('')).toBe('')
  })
})
