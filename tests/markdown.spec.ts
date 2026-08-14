/** Pure terminal markdown renderer: blocks, inline styles, wrapping. */

import { describe, expect, it } from 'vitest'
import { renderMarkdown, visibleColumns } from '../src/render/markdown.ts'

const text = (lines: ReturnType<typeof renderMarkdown>): string[] =>
  lines.map(line => line.segments.map(segment => segment.text).join(''))

describe('visibleColumns', () => {
  it('counts CJK glyphs double', () => {
    expect(visibleColumns('ab')).toBe(2)
    expect(visibleColumns('中文')).toBe(4)
    expect(visibleColumns('a中')).toBe(3)
  })
})

describe('renderMarkdown', () => {
  it('renders plain paragraphs and soft-wraps at the width', () => {
    const lines = renderMarkdown('one two three four five', 12)
    expect(text(lines)).toEqual(['one two', 'three four', 'five'])
  })

  it('joins soft line breaks inside a paragraph as spaces', () => {
    expect(text(renderMarkdown('first\nsecond', 80))).toEqual(['first second'])
  })

  it('styles headings as accent', () => {
    const [line] = renderMarkdown('## Release notes', 80)
    expect(text([line!])).toEqual(['Release notes'])
    expect(line!.segments[0]?.style).toBe('accent')
  })

  it('renders fenced code verbatim with a dim language label', () => {
    const lines = renderMarkdown('```ts\nconst a = 1\n```', 80)
    expect(text(lines)).toEqual(['  ts', '  const a = 1'])
    expect(lines[0]?.segments[0]?.style).toBe('dim')
    expect(lines[1]?.segments[0]?.style).toBe('code')
  })

  it('parses inline code, bold, italic, strike, and links', () => {
    const lines = renderMarkdown('run `npm i`, **bold**, *italic*, ~~gone~~ and [dsh](https://x.dev)', 120)
    const segments = lines[0]!.segments
    expect(segments.map(segment => [segment.text, segment.style])).toEqual([
      ['run ', 'plain'],
      ['npm i', 'code'],
      [', ', 'plain'],
      ['bold', 'bold'],
      [', ', 'plain'],
      ['italic', 'italic'],
      [', ', 'plain'],
      ['gone', 'strike'],
      [' and ', 'plain'],
      ['dsh', 'accent'],
      [' (https://x.dev)', 'dim'],
    ])
  })

  it('renders unordered and ordered lists with accent bullets', () => {
    const lines = renderMarkdown('- one\n- two\n\n1. first\n2. second', 80)
    expect(text(lines)).toEqual(['  • one', '  • two', '  1. first', '  2. second'])
    expect(lines[0]?.segments[0]?.style).toBe('accent')
  })

  it('renders blockquotes dim with an accent border', () => {
    const [line] = renderMarkdown('> quoted wisdom', 80)
    expect(line!.segments).toEqual([
      { text: '  │ ', style: 'accent' },
      { text: 'quoted wisdom', style: 'dim' },
    ])
  })

  it('renders thematic breaks as a dim rule', () => {
    const [line] = renderMarkdown('---', 40)
    expect(line!.segments[0]?.style).toBe('dim')
    expect(line!.segments[0]?.text).toBe('  ──────────')
  })

  it('merges adjacent same-style runs after wrapping', () => {
    const lines = renderMarkdown('**bold** **bold**', 80)
    expect(lines[0]!.segments).toEqual([
      { text: 'bold', style: 'bold' },
      { text: ' ', style: 'plain' },
      { text: 'bold', style: 'bold' },
    ])
  })

  it('never throws on unbalanced syntax', () => {
    expect(() => renderMarkdown('**open and `code', 40)).not.toThrow()
  })
})
