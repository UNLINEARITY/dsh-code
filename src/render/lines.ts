/** Width-safe styled physical rows for bounded terminal panels. */

import { promptDisplayText, type TranscriptEntry } from './projection.ts'
import type { ToolDetail } from './tool-detail.ts'
import { renderMarkdown, visibleColumns, type MdStyle } from './markdown.ts'
import { formatTokens } from './status.ts'
import { displayText, truncateColumns } from './text.ts'

/** Presentation classes mapped to Ink colors by the app boundary. */
export type LineStyle = MdStyle | 'brand' | 'success' | 'error' | 'warn' | 'dimItalic'

/** One styled run within a physical terminal row. */
export interface StyledSegment {
  text: string
  style: LineStyle
}

/** One row guaranteed not to exceed the requested terminal width. */
export interface StyledLine {
  segments: readonly StyledSegment[]
}

/** Construct one segment without leaking mutable objects into cached rows. */
export function lineSegment(text: string, style: LineStyle = 'plain'): StyledSegment {
  return { text, style }
}

/** Append a character while merging adjacent runs with the same style. */
function appendSegment(target: StyledSegment[], text: string, style: LineStyle): void {
  const previous = target[target.length - 1]
  if (previous?.style === style) {
    target[target.length - 1] = { text: previous.text + text, style }
    return
  }
  target.push({ text, style })
}

/**
 * Sanitize and hard-wrap styled content into exact physical rows.
 * Tabs become two visible spaces because terminal tab stops are contextual
 * and therefore cannot participate in a deterministic row budget.
 */
export function styledLines(segments: readonly StyledSegment[], columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  const lines: StyledLine[] = []
  let current: StyledSegment[] = []
  let used = 0
  const flush = (): void => {
    lines.push({ segments: current })
    current = []
    used = 0
  }

  for (const segment of segments) {
    const safe = displayText(segment.text).replaceAll('\t', '  ').replaceAll('\r', '')
    for (const char of safe) {
      if (char === '\n') {
        flush()
        continue
      }
      const cells = visibleColumns(char)
      if (used > 0 && used + cells > width) flush()
      appendSegment(current, char, segment.style)
      used += cells
    }
  }
  if (current.length > 0 || lines.length === 0) flush()
  return lines
}

/** Plain/dim text convenience over {@link styledLines}. */
export function textLines(text: string, columns: number, style: LineStyle = 'plain'): readonly StyledLine[] {
  return styledLines([lineSegment(text, style)], columns)
}

/** Prefix every wrapped physical row without exceeding the column budget. */
function prefixedStyledLines(segments: readonly StyledSegment[], columns: number, prefix: string, prefixStyle: LineStyle = 'plain'): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  const prefixWidth = Math.min(width, visibleColumns(prefix))
  const bodyWidth = Math.max(1, width - prefixWidth)
  return styledLines(segments, bodyWidth).map(line => ({
    segments: [lineSegment(prefix, prefixStyle), ...line.segments],
  }))
}

/** Text convenience for a tool row whose continuation must keep its gutter. */
function prefixedTextLines(text: string, columns: number, prefix: string, style: LineStyle = 'plain'): readonly StyledLine[] {
  return prefixedStyledLines([lineSegment(text, style)], columns, prefix, style)
}

/**
 * Wrap styled segments with a hanging indent: the first physical row carries
 * `firstPrefix` (often a marker plus gutter) and every wrapped continuation
 * carries the narrower `contPrefix`, so long tool summaries and prompts
 * align under their card instead of falling back to column zero. The first
 * row may hold one prefix-width more than the continuations.
 */
export function hangingStyledLines(
  segments: readonly StyledSegment[],
  columns: number,
  firstPrefix: string,
  firstStyle: LineStyle,
  contPrefix: string,
  contStyle: LineStyle = firstStyle,
): readonly StyledLine[] {
  const width = Math.max(2, Math.floor(columns))
  const firstPrefixText = truncateColumns(firstPrefix, Math.max(1, width - 1))
  const contPrefixText = truncateColumns(contPrefix, Math.max(1, width - 1))
  const firstBudget = Math.max(1, width - visibleColumns(firstPrefixText))
  const contBudget = Math.max(1, width - visibleColumns(contPrefixText))
  const lines: StyledLine[] = []
  let current: StyledSegment[] = []
  let used = 0
  let budget = firstBudget
  const flush = (): void => {
    lines.push({ segments: current })
    current = []
    used = 0
    budget = contBudget
  }
  for (const segment of segments) {
    const safe = displayText(segment.text).replaceAll('\t', '  ').replaceAll('\r', '')
    for (const char of safe) {
      if (char === '\n') {
        flush()
        continue
      }
      const cells = visibleColumns(char)
      if (used > 0 && used + cells > budget) flush()
      appendSegment(current, char, segment.style)
      used += cells
    }
  }
  if (current.length > 0 || lines.length === 0) flush()
  return lines.map((line, index) => ({
    segments: [
      lineSegment(index === 0 ? firstPrefixText : contPrefixText, index === 0 ? firstStyle : contStyle),
      ...line.segments,
    ],
  }))
}

/** Plain-text convenience over {@link hangingStyledLines}. */
export function hangingTextLines(
  text: string,
  columns: number,
  firstPrefix: string,
  firstStyle: LineStyle = 'plain',
  contPrefix = '  ',
  contStyle: LineStyle = firstStyle,
): readonly StyledLine[] {
  return hangingStyledLines([lineSegment(text, firstStyle)], columns, firstPrefix, firstStyle, contPrefix, contStyle)
}

/** Markdown rows re-hardened so a single long word cannot escape the budget. */
export function markdownLines(text: string, columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  const parsed = renderMarkdown(displayText(text), Math.max(10, width))
  return parsed.flatMap(line => styledLines(
    line.segments.map(segment => lineSegment(segment.text, segment.style)),
    width,
  ))
}

/**
 * Codex-style reasoning rows: the marker occupies the reply gutter and every
 * wrapped or explicit continuation starts with the same two-column indent, so
 * reasoning content and assistant Markdown share one left edge.
 */
export function reasoningLines(text: string, columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  if (width < 3) return textLines(text, width, 'dimItalic')
  const contentWidth = width - 2
  const content = displayText(text).replaceAll('\t', '  ').replaceAll('\r', '')
    .split('\n')
    .flatMap(line => styledLines([lineSegment(line, 'dimItalic')], contentWidth))
  return content.map((line, index) => ({
    segments: [
      lineSegment(index === 0 ? '✻ ' : '  ', 'dimItalic'),
      ...line.segments,
    ],
  }))
}

/** Expanded structured tool detail as scrollable, width-safe rows. */
function toolDetailLines(detail: ToolDetail, columns: number): readonly StyledLine[] {
  switch (detail.kind) {
    case 'diff':
      return detail.diffs.flatMap(diff => [
        ...prefixedTextLines(`${diff.path}${diff.truncated ? ' (diff truncated)' : ''}`, columns, '  ── ', 'dim'),
        ...diff.lines.flatMap(line => prefixedTextLines(
          `${line.mark}${line.text}`,
          columns,
          '  ',
          line.mark === '+' ? 'success' : line.mark === '-' ? 'error' : 'dim',
        )),
      ])
    case 'read':
      return [
        ...prefixedTextLines(
          `${detail.path} · lines ${detail.offset}-${detail.lines.length > 0 ? detail.lines[detail.lines.length - 1]!.number : detail.offset - 1} of ${detail.totalLines}${detail.truncated ? ' (window truncated)' : ''}`,
          columns,
          '  ── ',
          'dim',
        ),
        ...detail.lines.flatMap(line => prefixedTextLines(`${String(line.number).padStart(5, ' ')} | ${line.text}`, columns, '  ', 'dim')),
      ]
    case 'web-search':
      return [
        ...detail.sources.flatMap(source => [
          ...prefixedStyledLines([
            lineSegment(source.title ?? source.url, 'brand'),
            lineSegment(` - ${source.url}`, 'dim'),
          ], columns, '  ? '),
          ...(source.snippet === '' ? [] : prefixedTextLines(source.snippet, columns, '    ', 'dim')),
        ]),
        ...prefixedTextLines(`${detail.sources.length} sources${detail.truncated ? ' (capped)' : ''}`, columns, '  ', 'dim'),
      ]
    case 'web-fetch':
      return prefixedTextLines(`${detail.url} · HTTP ${detail.statusCode}`, columns, '  ', 'dim')
    case 'raw':
      return [
        ...prefixedTextLines(detail.text, columns, '  ', 'dim'),
        ...prefixedTextLines(detail.truncated ? '… (output truncated)' : '(end of output)', columns, '  ', 'dim'),
      ]
    default: {
      const exhaustive: never = detail
      return exhaustive
    }
  }
}

/**
 * Convert one durable transcript entry to its complete scrollable row model.
 * The source entry stays intact; only the caller's visible slice is rendered.
 * Wrapped continuations keep a hanging indent aligned under each row's
 * content (Codex history-cell alignment) instead of resetting to column 0.
 */
export function transcriptEntryLines(
  entry: TranscriptEntry,
  columns: number,
  showReasoning = true,
  reasoningToggleHint = true,
): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  switch (entry.kind) {
    case 'user':
      return entry.notice
        ? hangingStyledLines([lineSegment(promptDisplayText(entry), 'dim')], width, '⤷ ', 'dim', '  ', 'dim')
        : hangingStyledLines([lineSegment(promptDisplayText(entry), 'plain')], width, '❯ ', 'brand', '  ', 'plain')
    case 'pending':
      // Codex PendingSteer: a queued prompt renders exactly like an ordinary
      // user row, so the durable user/message retires it without any flicker.
      return hangingStyledLines([lineSegment(promptDisplayText(entry), 'plain')], width, '❯ ', 'brand', '  ', 'plain')
    case 'assistant': {
      const reasoning = entry.reasoning === ''
        ? []
        : showReasoning
          ? reasoningLines(entry.reasoning, width)
          : textLines(`✻ Thinking (${entry.reasoning.length} chars${reasoningToggleHint ? ', Ctrl+R to expand' : ''})`, width, 'dim')
      // Every reply row carries the composer's two-column gutter, so reply
      // text aligns with the input cursor (Codex LIVE_PREFIX alignment); the
      // wrap budget shrinks by the same amount so no line double-wraps.
      const body = markdownLines(entry.text, Math.max(10, width - 2))
        .map(line => ({ segments: [{ text: '  ', style: 'plain' as const }, ...line.segments] }))
      return [...reasoning, ...body]
    }
    case 'tool': {
      const mark = entry.state === 'running' ? '●' : entry.state === 'error' ? '⨯' : '⏺'
      const markStyle: LineStyle = entry.state === 'running' ? 'brand' : entry.state === 'error' ? 'error' : 'success'
      const summaryStyle: LineStyle = entry.state === 'error' ? 'error' : 'dim'
      return [
        // The invocation row hangs wrapped previews under the call badge.
        ...hangingStyledLines([
          // Global call ordinal — the same number an error line references.
          lineSegment(`[${entry.ordinal}] `, 'dim'),
          lineSegment(entry.name, 'brand'),
          lineSegment(entry.preview === '' ? '' : ` ${entry.preview}`, 'dim'),
        ], width, `${mark} `, markStyle, '  ', 'plain'),
        // A delegation card carries what the child was asked (Codex's
        // SpawnAgent prompt preview) while it runs, before any result.
        ...(entry.prompt === '' ? [] : hangingTextLines(entry.prompt, width, '  └ ', 'dim', '    ')),
        ...(entry.summary === '' ? [] : hangingTextLines(
          entry.state === 'error' ? `call ${entry.ordinal}: ${entry.summary}` : entry.summary,
          width, '  ⎿ ', summaryStyle, '    ', summaryStyle,
        )),
        ...(entry.detail === undefined ? [] : toolDetailLines(entry.detail, width)),
      ]
    }
    case 'command': {
      const mark = entry.state === 'running' ? '●' : entry.state === 'error' ? '⨯' : '⏺'
      const markStyle: LineStyle = entry.state === 'running' ? 'brand' : entry.state === 'error' ? 'error' : 'success'
      const summaryStyle: LineStyle = entry.state === 'error' ? 'error' : 'dim'
      return [
        ...hangingStyledLines([
          lineSegment(`/${entry.name}`, 'brand'),
          lineSegment(entry.args === '' ? '' : ` ${entry.args}`, 'dim'),
        ], width, `${mark} `, markStyle, '  ', 'plain'),
        ...(entry.summary === '' ? [] : hangingTextLines(entry.summary, width, '  ⎿ ', summaryStyle, '    ', summaryStyle)),
      ]
    }
    case 'turn-marker':
      return textLines(`  ⏹ ${entry.text}`, width, 'dim')
    case 'compaction':
      return textLines(entry.ok
        ? `  ⧉ compacted ~${formatTokens(entry.tokens)} tokens`
        : `  ⧉ compaction failed: ${entry.error}`, width, 'dim')
    case 'retry':
      return textLines(
        `  ↻ retry ${entry.attempt}/${entry.max} · ${entry.code} · ${Math.round(entry.delayMs / 100) / 10}s`,
        width,
        entry.state === 'running' ? 'warn' : 'dim',
      )
    case 'files':
      return entry.paths.length === 0
        ? textLines('  ⎄ no changed files', width, 'dim')
        : [
          ...textLines(`  ⎄ ${entry.paths.length} changed file${entry.paths.length === 1 ? '' : 's'}`, width, 'dim'),
          ...entry.paths.flatMap(path => hangingTextLines(path, width, '    ', 'dim', '    ')),
        ]
    case 'error':
      return textLines(entry.text, width, 'error')
    default: {
      const exhaustive: never = entry
      return exhaustive
    }
  }
}

/** Settled-history variant carrying the Ctrl+R reasoning fold. */
export function settledEntryLines(entry: TranscriptEntry, columns: number, showReasoning: boolean): readonly StyledLine[] {
  return transcriptEntryLines(entry, columns, showReasoning, false)
}
