/** IME cursor anchor regressions: the caret-to-anchor row math, the escape
 * sequences, and the write-wrapper ledger around Ink's relative erases. */

import { describe, expect, it } from 'vitest'
import {
  imeCursorMove,
  imeCursorRestore,
  imeCursorRowsUp,
  installImeCursorAnchor,
  type ImeCursorAnchor,
} from '../src/render/ime-cursor.ts'

interface FakeStream {
  isTTY: boolean
  writes: string[]
  write(chunk: unknown, ...rest: unknown[]): boolean
}

function createFakeStream(isTTY = true): FakeStream & NodeJS.WriteStream {
  const stream: FakeStream = {
    isTTY,
    writes: [],
    write(chunk: unknown, ...rest: unknown[]): boolean {
      stream.writes.push(typeof chunk === 'string' ? chunk : String(chunk))
      const last = rest[rest.length - 1]
      if (typeof last === 'function') (last as () => void)()
      return true
    },
  }
  return stream as FakeStream & NodeJS.WriteStream
}

describe('imeCursorRowsUp', () => {
  it('counts the band bottom, the caret-following rows, the footer block, and Ink\'s parked row', () => {
    // One editor row, caret on it, three rows below the composer (two status
    // rows plus Ink's own below-frame row).
    expect(imeCursorRowsUp({ editorWindowRows: 1, caretRowInWindow: 0, rowsBelowComposer: 3 })).toBe(4)
  })
  it('counts only the rows below the caret in a multiline window', () => {
    expect(imeCursorRowsUp({ editorWindowRows: 4, caretRowInWindow: 1, rowsBelowComposer: 3 })).toBe(6)
  })
  it('never returns zero', () => {
    expect(imeCursorRowsUp({ editorWindowRows: 1, caretRowInWindow: 0, rowsBelowComposer: 0 })).toBe(1)
  })
})

describe('escape sequences', () => {
  it('moves up to the caret cell with a 1-based column', () => {
    expect(imeCursorMove(4, 7)).toBe('\x1b[4A\x1b[8G')
    expect(imeCursorMove(1, 0)).toBe('\x1b[1A\x1b[1G')
  })
  it('cancels by moving down and returning to column 1', () => {
    expect(imeCursorRestore(4)).toBe('\x1b[4B\r')
    expect(imeCursorRestore(0)).toBe('')
  })
})

describe('installImeCursorAnchor', () => {
  it('is a no-op on non-TTY streams', () => {
    const stream = createFakeStream(false)
    expect(installImeCursorAnchor(stream)).toBeUndefined()
    stream.write('hello')
    expect(stream.writes).toEqual(['hello'])
  })

  it('anchors once and brackets frame rewrites with the cancel and re-anchor sequences', () => {
    const stream = createFakeStream()
    const anchor = installImeCursorAnchor(stream) as ImeCursorAnchor
    anchor.anchor(4, 7)
    expect(stream.writes).toEqual(['\x1b[4A\x1b[8G'])
    stream.writes.length = 0
    stream.write('\x1b[2Kframe rows\n')
    expect(stream.writes).toEqual(['\x1b[4B\r\x1b[2Kframe rows\n\x1b[4A\x1b[8G'])
    // The frame chunk maintained the anchor, so the same target writes nothing.
    anchor.anchor(4, 7)
    expect(stream.writes).toHaveLength(1)
    anchor.release()
  })

  it('drops the anchor across writes that are not frame rewrites', () => {
    const stream = createFakeStream()
    const anchor = installImeCursorAnchor(stream) as ImeCursorAnchor
    anchor.anchor(4, 7)
    stream.writes.length = 0
    stream.write('plain')
    expect(stream.writes).toEqual(['\x1b[4B\rplain'])
    // The next commit re-anchors from Ink's parked position.
    anchor.anchor(4, 7)
    expect(stream.writes[1]).toBe('\x1b[4A\x1b[8G')
    anchor.release()
  })

  it('moves the anchor by cancelling the previous displacement first', () => {
    const stream = createFakeStream()
    const anchor = installImeCursorAnchor(stream) as ImeCursorAnchor
    anchor.anchor(4, 7)
    stream.writes.length = 0
    anchor.anchor(2, 3)
    expect(stream.writes).toEqual(['\x1b[4B\r\x1b[2A\x1b[4G'])
    anchor.release()
  })

  it('releases the displacement and the original write path', () => {
    const stream = createFakeStream()
    const anchor = installImeCursorAnchor(stream) as ImeCursorAnchor
    anchor.anchor(3, 0)
    stream.writes.length = 0
    anchor.release()
    expect(stream.writes).toEqual(['\x1b[3B\r'])
    stream.write('raw')
    expect(stream.writes).toEqual(['\x1b[3B\r', 'raw'])
    anchor.anchor(3, 0)
    expect(stream.writes).toHaveLength(2)
  })

  it('cancels the anchor before non-string chunks without re-anchoring', () => {
    const stream = createFakeStream()
    const anchor = installImeCursorAnchor(stream) as ImeCursorAnchor
    anchor.anchor(3, 0)
    stream.writes.length = 0
    stream.write(Buffer.from('bytes'))
    expect(stream.writes).toEqual(['\x1b[3B\r', 'bytes'])
    stream.write('plain')
    expect(stream.writes[2]).toBe('plain')
    anchor.release()
  })

  it('is idempotent per stream', () => {
    const stream = createFakeStream()
    const first = installImeCursorAnchor(stream) as ImeCursorAnchor
    expect(installImeCursorAnchor(stream)).toBe(first)
    first.release()
    // A released handle detaches: a fresh install is a new object.
    const second = installImeCursorAnchor(stream) as ImeCursorAnchor
    expect(second).not.toBe(first)
    second.release()
  })
})
