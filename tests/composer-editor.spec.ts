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
  insertText,
  killToLineEnd,
  killToLineStart,
  lineBounds,
  moveCursorBy,
  moveCursorVertically,
  moveWordLeft,
  moveWordRight,
  sanitizeDraftText,
  shouldRecallNavigate,
} from '../src/render/editor.ts'

describe('sanitizeDraftText', () => {
  it('normalizes line endings and tabs', () => {
    expect(sanitizeDraftText('a\r\nb\rc\td')).toBe('a\nb\nc  d')
  })
  it('escapes injectable control characters visibly', () => {
    expect(sanitizeDraftText('x\x07y\x1b[31m')).toBe('x\\x07y\\x1b[31m')
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
  it('treats a CJK run as one piece', () => {
    expect(moveWordLeft('中文测试', 4)).toBe(0)
    expect(moveWordRight('中文测试', 0)).toBe(4)
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
  it('recalls from an empty draft', () => {
    expect(shouldRecallNavigate('', 0, null)).toBe(true)
  })
  it('recalls only at a boundary of the unchanged last recalled entry', () => {
    expect(shouldRecallNavigate('old', 3, 'old')).toBe(true)
    expect(shouldRecallNavigate('old', 0, 'old')).toBe(true)
    expect(shouldRecallNavigate('old', 1, 'old')).toBe(false)
    expect(shouldRecallNavigate('new', 3, 'old')).toBe(false)
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
