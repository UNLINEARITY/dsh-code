/** Ink renderer for width-safe styled terminal rows. */

import { createElement, type ReactElement } from 'react'
import { Box, Text } from 'ink'
import type { MdSegment } from './render/markdown.ts'
import type { LineStyle, StyledLine } from './render/lines.ts'
import {
  diffBackground,
  getPalette,
  inkColor,
  promptRowTokens,
  rowBackground,
} from './theme.ts'

function segmentProps(style: MdSegment['style']): {
  color: string | undefined
  bold: boolean | undefined
  italic: boolean | undefined
  strikethrough: boolean | undefined
} {
  switch (style) {
    case 'accent':
      return { color: inkColor(getPalette().brandBright), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'accentBold':
      return { color: inkColor(getPalette().brandBright), bold: true, italic: undefined, strikethrough: undefined }
    case 'code':
      return { color: inkColor(getPalette().code), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'dim':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'bold':
      return { color: undefined, bold: true, italic: undefined, strikethrough: undefined }
    case 'italic':
      return { color: undefined, bold: undefined, italic: true, strikethrough: undefined }
    case 'boldItalic':
      return { color: undefined, bold: true, italic: true, strikethrough: undefined }
    case 'strike':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: undefined, strikethrough: true }
    case 'diffAdd':
    case 'diffDel':
      // Inline-markdown twin of lineStyleProps' diff cases: tinted rows for
      // ```diff fences rendered through the markdown span path. The diff
      // foreground tokens stay AA-legible both on the row tints (when the
      // background rides along) and on the plain terminal background.
      return {
        color: inkColor(style === 'diffAdd' ? getPalette().diffAddFg : getPalette().diffDelFg),
        bold: undefined,
        italic: undefined,
        strikethrough: undefined,
      }
    default:
      return { color: undefined, bold: undefined, italic: undefined, strikethrough: undefined }
  }
}

/** Ink props for the richer line model used by bounded scrolling panels. */
function lineStyleProps(style: LineStyle): {
  color: string | undefined
  bold: boolean | undefined
  italic: boolean | undefined
  strikethrough: boolean | undefined
  dimColor: boolean | undefined
  backgroundColor: string | undefined
} {
  switch (style) {
    case 'brand':
      return { color: inkColor(getPalette().brandBright), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'success':
      return { color: inkColor(getPalette().success), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'error':
      return { color: inkColor(getPalette().error), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'warn':
      return { color: inkColor(getPalette().warn), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'dimItalic':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: true, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    // Codex diff rendering: added/removed lines carry a theme tint behind
    // the sign and text, with the AA-tuned diff foreground tokens on top; the
    // depth gate turns this into plain foreground styling on 16-color
    // terminals.
    case 'diffAdd':
      return { color: inkColor(getPalette().diffAddFg), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: diffBackground('diffAdd') }
    case 'diffDel':
      return { color: inkColor(getPalette().diffDelFg), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: diffBackground('diffDel') }
    // Prompt rows: one full-width bar per delivery kind. The tint comes from
    // the row token and the foreground from its AA-tuned twin; the depth gate
    // inside rowBackground degrades this to foreground-only on 16-color
    // terminals, matching the diff rows.
    case 'promptRow':
    case 'promptQueuedRow':
    case 'promptSteeredRow': {
      const tokens = promptRowTokens(style === 'promptQueuedRow' ? 'queued' : style === 'promptSteeredRow' ? 'steered' : undefined)
      return {
        color: inkColor(getPalette()[tokens.fg]),
        bold: undefined,
        italic: undefined,
        strikethrough: undefined,
        dimColor: undefined,
        backgroundColor: rowBackground(tokens.fg),
      }
    }
    default:
      return { ...segmentProps(style), dimColor: undefined, backgroundColor: undefined }
  }
}

/** Render width-safe rows; every child is exactly one terminal row. */
export function StyledRows({ lines }: { lines: readonly StyledLine[] }): ReactElement {
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => createElement(
      Text,
      { key: index, wrap: 'truncate-end' },
      line.segments.length === 0
        ? ' '
        : line.segments.map((segment, at) => createElement(
          Text,
          { key: at, ...lineStyleProps(segment.style) },
          segment.text,
        )),
    )),
  )
}

/** File-oriented, color-coded unified diff viewport. */
