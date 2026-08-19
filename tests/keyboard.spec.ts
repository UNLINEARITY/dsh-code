/** Kitty CSI-u keyboard normalization regressions. */

import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  KEYBOARD_ENHANCE_DISABLE,
  KEYBOARD_ENHANCE_ENABLE,
  normalizeKeyboardChunk,
  stripPasteMarkers,
} from '../src/keyboard.ts'

describe('protocol constants', () => {
  it('pushes kitty flags 1|4 with modifyOtherKeys off', () => {
    expect(KEYBOARD_ENHANCE_ENABLE).toBe('\x1b[>4;0m\x1b[>5u')
  })
  it('pops the stack and resets modifyOtherKeys on exit', () => {
    expect(KEYBOARD_ENHANCE_DISABLE).toBe('\x1b[<u\x1b[>4;0m')
  })
  it('enables and disables bracketed paste', () => {
    expect(BRACKETED_PASTE_ENABLE).toBe('\x1b[?2004h')
    expect(BRACKETED_PASTE_DISABLE).toBe('\x1b[?2004l')
  })
})

describe('normalizeKeyboardChunk', () => {
  it('passes plain text and legacy sequences through untouched', () => {
    expect(normalizeKeyboardChunk('hello')).toBe('hello')
    expect(normalizeKeyboardChunk('\x1b[A')).toBe('\x1b[A')
    expect(normalizeKeyboardChunk('\r')).toBe('\r')
    expect(normalizeKeyboardChunk('\x7f')).toBe('\x7f')
  })
  it('maps Enter family to canonical forms', () => {
    expect(normalizeKeyboardChunk('\x1b[13u')).toBe('\r')
    expect(normalizeKeyboardChunk('\x1b[13;2u')).toBe('\x1b[13;2u')
    expect(normalizeKeyboardChunk('\x1b[13;5u')).toBe('\n')
    expect(normalizeKeyboardChunk('\x1b[13;3u')).toBe('\x1b\r')
  })
  it('maps Esc, Tab, and Backspace CSI forms', () => {
    expect(normalizeKeyboardChunk('\x1b[27u')).toBe('\x1b')
    expect(normalizeKeyboardChunk('\x1b[27;1u')).toBe('\x1b')
    expect(normalizeKeyboardChunk('\x1b[9u')).toBe('\t')
    expect(normalizeKeyboardChunk('\x1b[9;2u')).toBe('\x1b[Z')
    expect(normalizeKeyboardChunk('\x1b[127u')).toBe('\x7f')
    expect(normalizeKeyboardChunk('\x1b[127;5u')).toBe('\x1b\x7f')
  })
  it('maps ctrl and alt letters to their legacy bytes', () => {
    expect(normalizeKeyboardChunk('\x1b[99;5u')).toBe('\x03')
    expect(normalizeKeyboardChunk('\x1b[114;5u')).toBe('\x12')
    expect(normalizeKeyboardChunk('\x1b[107;5u')).toBe('\x0b')
    expect(normalizeKeyboardChunk('\x1b[98;3u')).toBe('\x1bb')
    expect(normalizeKeyboardChunk('\x1b[97;2;65u')).toBe('A')
  })
  it('normalizes repeated enhanced Ctrl+C sequences without leaking CSI text', () => {
    expect(normalizeKeyboardChunk('\x1b[99;5u\x1b[99;5u')).toBe('\x03\x03')
  })
  it('decodes sequences embedded in larger chunks and leaves the rest intact', () => {
    expect(normalizeKeyboardChunk('a\x1b[99;5u b'.replace('\x1b[99;5u', '\x1b[99;5u'))).toBe('a\x03 b')
  })
  it('maps kitty disambiguate functional keys to legacy forms Ink annotates', () => {
    expect(normalizeKeyboardChunk('\x1b[1u')).toBe('\x1b[H')
    expect(normalizeKeyboardChunk('\x1b[2u')).toBe('\x1b[2~')
    expect(normalizeKeyboardChunk('\x1b[3u')).toBe('\x1b[3~')
    expect(normalizeKeyboardChunk('\x1b[4u')).toBe('\x1b[F')
    expect(normalizeKeyboardChunk('\x1b[5u')).toBe('\x1b[5~')
    expect(normalizeKeyboardChunk('\x1b[6u')).toBe('\x1b[6~')
  })
  it('preserves shift/alt/ctrl modifiers on kitty functional keys', () => {
    expect(normalizeKeyboardChunk('\x1b[3;2u')).toBe('\x1b[3;2~')
    expect(normalizeKeyboardChunk('\x1b[3;3u')).toBe('\x1b[3;3~')
    expect(normalizeKeyboardChunk('\x1b[3;5u')).toBe('\x1b[3;5~')
    expect(normalizeKeyboardChunk('\x1b[1;5u')).toBe('\x1b[1;5H')
    expect(normalizeKeyboardChunk('\x1b[4;3u')).toBe('\x1b[1;3F')
    expect(normalizeKeyboardChunk('\x1b[6;2u')).toBe('\x1b[6;2~')
  })
  it('passes undecodable CSI-u codes through unchanged', () => {
    expect(normalizeKeyboardChunk('\x1b[57441u')).toBe('\x1b[57441u')
  })
})

describe('stripPasteMarkers', () => {
  it('removes start and end markers from pasted chunks', () => {
    expect(stripPasteMarkers('[200~hello[201~')).toBe('hello')
    expect(stripPasteMarkers('[200~')).toBe('')
    expect(stripPasteMarkers('[201~')).toBe('')
  })
  it('leaves clean text untouched', () => {
    expect(stripPasteMarkers('plain [200 text')).toBe('plain [200 text')
    expect(stripPasteMarkers('')).toBe('')
  })
})
