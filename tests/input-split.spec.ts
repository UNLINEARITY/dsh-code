/** The keypress splitter: coalesced chunks must become individual keys. */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createKeypressSplitter, createSplitStdin } from '../src/input-split.ts'

describe('keypress splitter', () => {
  it('splits a coalesced space-then-enter into two units', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push(' \r')).toEqual([' ', '\r'])
  })

  it('keeps each escape sequence whole and splits consecutive ones', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('\x1b[B\x1b[A')).toEqual(['\x1b[B', '\x1b[A'])
    expect(splitter.push('\x1b[13;2u\x1bOax')).toEqual(['\x1b[13;2u', '\x1bOa', 'x'])
  })

  it('holds a cut sequence until the rest of it arrives', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('\x1b[')).toEqual([])
    expect(splitter.push('B')).toEqual(['\x1b[B'])
  })

  it('travels a bracketed paste block as one unit, even across chunks', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('\x1b[200~first')).toEqual([])
    expect(splitter.push(' line\x1b[201~x')).toEqual(['\x1b[200~first line\x1b[201~', 'x'])
  })

  it('emits a chunk-trailing lone ESC as the Escape key', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('\x1b')).toEqual(['\x1b'])
  })

  it('keeps an alt chord and a surrogate pair as single units', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('\x1bb😀')).toEqual(['\x1bb', '😀'])
  })

  it('keeps a printable run as one insert so a file drag is not tens of keypresses', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('abc')).toEqual(['abc'])
    const path = "'/Users/nonlinear/Desktop/截屏2026-09-15 18.41.07.png'"
    expect(splitter.push(path)).toEqual([path])
    expect(splitter.push(' \r')).toEqual([' ', '\r'])
  })
})

describe('split stdin proxy', () => {
  it('feeds each keypress unit to the reader separately and detaches on dispose', () => {
    const source = new PassThrough() as unknown as NodeJS.ReadStream
    source.isTTY = true
    const { stdin, dispose } = createSplitStdin(source)
    const seen: string[] = []
    stdin.on('data', chunk => seen.push(String(chunk)))
    source.write(' \r')
    expect(seen).toEqual([' ', '\r'])
    dispose()
    source.write('x')
    expect(seen).toEqual([' ', '\r'])
  })

  it('keeps the shared source flowing for a successor tap after a swap dispose', () => {
    // The runner swaps Ink instances per session switch: the OLD tap's
    // dispose must not pause the shared stdin under the NEW tap's listener,
    // or the new session's keyboard is dead.
    const source = new PassThrough() as unknown as NodeJS.ReadStream
    source.isTTY = true
    const first = createSplitStdin(source)
    const second = createSplitStdin(source)
    const seen: string[] = []
    second.stdin.on('data', chunk => seen.push(String(chunk)))
    first.dispose()
    source.write('a')
    expect(seen).toEqual(['a'])
    second.dispose()
    source.write('b')
    expect(seen).toEqual(['a'])
  })

  it('never forwards raw-mode or ref calls from a disposed tap', () => {
    // The old Ink tree's deferred useInput cleanup runs after the successor
    // mount restored raw mode; a disposed tap forwarding it would flip the
    // real stdin back to cooked mode and swallow every key.
    const source = new PassThrough() as unknown as NodeJS.ReadStream
    source.isTTY = true
    const calls: boolean[] = []
    source.setRawMode = (value: boolean): NodeJS.ReadStream => {
      calls.push(value)
      return source
    }
    const { stdin, dispose } = createSplitStdin(source)
    stdin.setRawMode(true)
    expect(calls).toEqual([true])
    dispose()
    stdin.setRawMode(false)
    expect(calls).toEqual([true])
  })
})
