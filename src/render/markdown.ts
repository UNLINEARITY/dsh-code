/**
 * Terminal markdown renderer for assistant replies: a pure GFM-subset
 * block/inline parser producing styled line segments the Ink renderer maps
 * to colored text. No ANSI here — the app owns color mapping, tests own the
 * structure. The subset mirrors what agent replies actually emit: headings,
 * emphasis, inline/fenced code, flat lists, blockquotes, links, rules, and
 * wrapped paragraphs. Unknown syntax degrades to plain text (never throws).
 *
 * @module @deepseek-ai/dsh-code/render/markdown
 */

/** Style classes the renderer emits; the app maps them to colors/props. */
export type MdStyle = 'plain' | 'bold' | 'italic' | 'boldItalic' | 'code' | 'accent' | 'dim' | 'strike'

/** One styled run of text. */
export interface MdSegment {
  /** Visible text (no ANSI). */
  text: string
  /** Presentation class for the app's color map. */
  style: MdStyle
}

/** One rendered line: a sequence of styled runs. */
export interface MdLine {
  segments: readonly MdSegment[]
}

/** Plain segment helper. */
function seg(text: string, style: MdStyle = 'plain'): MdSegment {
  return { text, style }
}

/** Visible width of a run in columns (CJK counts double). */
export function visibleColumns(text: string): number {
  let columns = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    columns += code > 0x2e7f ? 2 : 1
  }
  return columns
}

/** Walk a segment list, breaking it into lines that fit `width` columns. */
function wrapSegments(segments: readonly MdSegment[], width: number): readonly MdSegment[][] {
  const lines: MdSegment[][] = []
  let current: MdSegment[] = []
  let used = 0
  for (const segment of segments) {
    // Break the segment at spaces into words so long runs wrap mid-text.
    const words = segment.text.split(/( )/u)
    for (const word of words) {
      if (word === '') continue
      const columns = visibleColumns(word)
      if (used + columns > width && used > 0) {
        lines.push(current)
        current = []
        used = 0
      }
      // A single word wider than the line still goes on its own line.
      current.push({ text: word, style: segment.style })
      used += columns
    }
  }
  if (current.length > 0) lines.push(current)
  // Drop the trailing space a wrapped line picked up before the break.
  return lines.map(line => {
    const last = line[line.length - 1]
    if (last !== undefined && last.text === ' ' && line.length > 1) return line.slice(0, -1)
    return line
  })
}

/** Join adjacent same-style runs so the app renders fewer elements. */
function merge(segments: readonly MdSegment[]): readonly MdSegment[] {
  const merged: MdSegment[] = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.style === segment.style) {
      merged[merged.length - 1] = { text: last.text + segment.text, style: last.style }
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

/** One parsed inline run before wrapping. */
interface InlineRun {
  text: string
  style: MdStyle
}

/**
 * Parse inline markdown in one line of text. Link destinations render as a
 * dim `(url)` suffix — the visible text keeps the accent.
 */
function parseInline(text: string): readonly InlineRun[] {
  const runs: InlineRun[] = []
  let rest = text
  while (rest !== '') {
    const code = /^`([^`]+)`/u.exec(rest)
    if (code !== null) {
      runs.push({ text: code[1] ?? '', style: 'code' })
      rest = rest.slice(code[0].length)
      continue
    }
    const boldItalic = /^\*\*\*([^*]+)\*\*\*/u.exec(rest)
    if (boldItalic !== null) {
      runs.push({ text: boldItalic[1] ?? '', style: 'boldItalic' })
      rest = rest.slice(boldItalic[0].length)
      continue
    }
    const bold = /^\*\*([^*]+)\*\*/u.exec(rest)
    if (bold !== null) {
      runs.push({ text: bold[1] ?? '', style: 'bold' })
      rest = rest.slice(bold[0].length)
      continue
    }
    const italic = /^\*([^*]+)\*/u.exec(rest) ?? /^_([^_]+)_/u.exec(rest)
    if (italic !== null) {
      runs.push({ text: italic[1] ?? '', style: 'italic' })
      rest = rest.slice(italic[0].length)
      continue
    }
    const strike = /^~~([^~]+)~~/u.exec(rest)
    if (strike !== null) {
      runs.push({ text: strike[1] ?? '', style: 'strike' })
      rest = rest.slice(strike[0].length)
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/u.exec(rest)
    if (link !== null) {
      const label = link[1] ?? ''
      const url = link[2] ?? ''
      runs.push({ text: label, style: 'accent' })
      runs.push({ text: ` (${url})`, style: 'dim' })
      rest = rest.slice(link[0].length)
      continue
    }
    // Plain run up to the next special opener.
    const next = rest.search(/[*_`~[]/u)
    if (next === -1) {
      runs.push({ text: rest, style: 'plain' })
      break
    }
    if (next > 0) {
      runs.push({ text: rest.slice(0, next), style: 'plain' })
      rest = rest.slice(next)
      continue
    }
    // A special opener at position 0 that no pattern consumed: emit it
    // literally and advance, so unbalanced syntax never loops.
    runs.push({ text: rest.slice(0, 1), style: 'plain' })
    rest = rest.slice(1)
  }
  return runs
}

const HEADING = /^(#{1,6})\s+(.*)$/u
const FENCE = /^```([^\s`]*)\s*$/u
const RULE = /^(?:---|\*\*\*|___)\s*$/u
const QUOTE = /^>\s?(.*)$/u
const UNORDERED = /^\s*[-*+]\s+(.*)$/u
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/u

/** Render markdown text into styled lines of at most `width` columns. */
export function renderMarkdown(text: string, width: number): readonly MdLine[] {
  const lines: MdLine[] = []
  let separatorPending = false
  const push = (segments: readonly MdSegment[]): void => {
    for (const wrapped of wrapSegments(segments, Math.max(10, width))) {
      lines.push({ segments: merge(wrapped) })
    }
  }
  const startBlock = (): void => {
    if (separatorPending && lines.length > 0 && lines.at(-1)?.segments.length !== 0) {
      lines.push({ segments: [] })
    }
    separatorPending = false
  }
  const raw = text.replaceAll('\r', '')
  const source = raw.split('\n')
  let index = 0
  while (index < source.length) {
    const line = source[index] ?? ''
    index += 1

    // Preserve one deliberate row between source blocks. Repeated blank
    // lines collapse, and leading/trailing whitespace never grows output.
    if (line.trim() === '') {
      separatorPending = lines.length > 0
      continue
    }
    startBlock()

    // Fenced code block: verbatim lines in code style, language label first.
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const language = fence[1] ?? ''
      if (language !== '') push([seg(`  ${language}`, 'dim')])
      while (index < source.length && !FENCE.test(source[index] ?? '')) {
        push([seg(`  ${source[index] ?? ''}`, 'code')])
        index += 1
      }
      index += 1 // closing fence
      continue
    }

    if (RULE.test(line.trim())) {
      push([seg(`  ${'─'.repeat(Math.max(1, Math.floor(width / 4)))}`, 'dim')])
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      push([seg(heading[2] ?? '', 'accent')])
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      push([seg('  │ ', 'accent'), ...parseInline(quote[1] ?? '').map(run => seg(run.text, run.style === 'plain' ? 'dim' : run.style))])
      continue
    }
    const ordered = ORDERED.exec(line)
    if (ordered !== null) {
      push([seg(`  ${ordered[1] ?? ''}. `, 'accent'), ...parseInline(ordered[2] ?? '').map(run => seg(run.text, run.style))])
      continue
    }
    const unordered = UNORDERED.exec(line)
    if (unordered !== null) {
      push([seg('  • ', 'accent'), ...parseInline(unordered[1] ?? '').map(run => seg(run.text, run.style))])
      continue
    }

    // Paragraph: gather until a blank line, then wrap as one flow. Line
    // breaks inside a paragraph join as a single space (GFM soft breaks).
    const paragraph = [line]
    while (index < source.length && (source[index] ?? '').trim() !== '') {
      paragraph.push(source[index] ?? '')
      index += 1
    }
    const runs: InlineRun[] = []
    for (let at = 0; at < paragraph.length; at += 1) {
      if (at > 0) runs.push({ text: ' ', style: 'plain' })
      runs.push(...parseInline(paragraph[at] ?? ''))
    }
    push(runs.map(run => seg(run.text, run.style)))
  }
  return lines
}
