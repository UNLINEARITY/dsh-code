/**
 * Terminal input arrives as byte chunks, and one chunk can carry several
 * keypresses: a fast space-then-enter, a bridged stdin that batches reads, a
 * middle-click paste. Ink parses each chunk as exactly one keypress —
 * `parseKeypress(' \r')` matches neither member, so both keys silently
 * vanish (a multi-select question answered with an empty set). The splitter
 * below cuts every chunk into the individual keypress units Ink's parser
 * expects, keeping escape sequences and bracketed-paste blocks intact, and
 * the stdin proxy feeds the split stream to the Ink mount.
 *
 * @module @deepseek-ai/dsh-tui/input-split
 */

import { PassThrough } from 'node:stream'

/** Bracketed-paste wrapper bytes; the whole block travels as one unit. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** One keypress cut from the input stream. */
export interface KeypressSplitter {
  /** Feed one chunk; returns every keypress unit this chunk completed. */
  push(chunk: string): string[]
}

/** Final byte of a CSI sequence (\x40-\x7e per ECMA-48). */
const isCsiFinal = (char: string): boolean => char >= '@' && char <= '~'

/**
 * Build a stateful chunk splitter. A partial unit at the end of one chunk
 * (a cut CSI sequence, an open paste block) waits in the buffer for the
 * rest. A chunk-trailing lone ESC emits as the Escape key right away:
 * terminals send Escape as its own chunk, and holding it hostage for a
 * sequence that may never continue would break every Esc cancel.
 */
export function createKeypressSplitter(): KeypressSplitter {
  let buffer = ''
  return {
    push(chunk: string): string[] {
      buffer += chunk
      const units: string[] = []
      while (buffer !== '') {
        // A bracketed paste block is display text, not keypresses: keep the
        // whole wrapper plus its payload as the single unit the composer
        // expects, even when the payload contains ESC-looking bytes.
        if (buffer.startsWith(PASTE_START)) {
          const end = buffer.indexOf(PASTE_END, PASTE_START.length)
          if (end < 0) break
          const stop = end + PASTE_END.length
          units.push(buffer.slice(0, stop))
          buffer = buffer.slice(stop)
          continue
        }
        const head = buffer[0]!
        if (head !== '\x1b') {
          // Plain bytes key one at a time; a surrogate pair is one grapheme
          // and must not split into two lone surrogates.
          const pair = head >= '\uD800' && head <= '\uDBFF' && buffer[1] !== undefined
          const take = pair ? 2 : 1
          units.push(buffer.slice(0, take))
          buffer = buffer.slice(take)
          continue
        }
        // CSI (\x1b[…final) and SS3 (\x1bO<char): hold until complete.
        if (buffer[1] === '[') {
          let end = -1
          for (let at = 2; at < buffer.length; at += 1) {
            if (isCsiFinal(buffer[at]!)) {
              end = at
              break
            }
          }
          if (end < 0) break
          units.push(buffer.slice(0, end + 1))
          buffer = buffer.slice(end + 1)
          continue
        }
        if (buffer[1] === 'O') {
          if (buffer[2] === undefined) break
          units.push(buffer.slice(0, 3))
          buffer = buffer.slice(3)
          continue
        }
        if (buffer[1] === undefined) {
          // Lone ESC: Escape key (see the tradeoff above).
          units.push(buffer)
          buffer = ''
          continue
        }
        // Alt+key: ESC glued to one more byte travels as one unit.
        units.push(buffer.slice(0, 2))
        buffer = buffer.slice(2)
      }
      return units
    },
  }
}

/** The stdin-shaped stream the Ink mount renders through. */
export interface TuiStdin extends PassThrough {
  /** Mirrors the real stdin so Ink's raw-mode gate passes. */
  isTTY: boolean
  /** Forwarded to the real stdin; Ink toggles it around focus. */
  setRawMode(value: boolean): unknown
  ref(): void
  unref(): void
}

/**
 * Wrap one real stdin in the splitting proxy: keypress units flow into a
 * PassThrough Ink reads, while raw-mode/ref calls forward to the source.
 * @param source - the process (or harness) input stream in raw mode.
 * @returns the proxy stream plus a dispose that detaches the tap.
 */
export function createSplitStdin(source: NodeJS.ReadStream): { stdin: TuiStdin; dispose(): void } {
  // Object mode matters: a plain stream's read() without a size drains the
  // whole buffer as one chunk, which would re-coalesce the units this module
  // exists to separate. In object mode every pushed unit reads back alone.
  const stream = new PassThrough({ objectMode: true }) as TuiStdin
  const splitter = createKeypressSplitter()
  const onChunk = (chunk: string): void => {
    for (const unit of splitter.push(String(chunk))) stream.write(unit)
  }
  const proxy = Object.assign(stream, {
    isTTY: source.isTTY === true,
    setRawMode(value: boolean): TuiStdin {
      source.setRawMode?.(value)
      return stream
    },
    ref(): void {
      source.ref?.()
    },
    unref(): void {
      source.unref?.()
    },
  })
  source.setEncoding('utf8')
  source.on('data', onChunk)
  return {
    stdin: proxy,
    dispose(): void {
      source.removeListener('data', onChunk)
      source.pause()
    },
  }
}
