/**
 * Generate the TUI whale glyph from the exact DeepSeek fish-logo SVG path.
 *
 * Reads the vendored path data out of `scripts/fish-logo.ts`, flattens its
 * cubic béziers into polygons, rasterizes them with the SVG nonzero winding
 * rule at half-block resolution (26 columns × 16 pixel rows → 8 half-block
 * rows), and writes the committed static glyph `src/whale-glyph.ts`.
 *
 * Run after changing the logo path: `pnpm run gen:whale`.
 * @module gen-whale-glyph
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FISH_LOGO_HEIGHT, FISH_LOGO_PATH, FISH_LOGO_WIDTH } from './fish-logo.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const targetPath = join(repoRoot, 'src/whale-glyph.ts')

/** Half-block columns: slightly over the logo's native width 23.16 — a small banner mark. */
const COLUMNS = 26
/** Pixel rows: 16 pixel rows over the native height 17.04 → 8 half-block rows (flat, compact). */
const PIXEL_ROWS = 16
/** Bézier samples per curve; plenty at this glyph size. */
const CURVE_SAMPLES = 64
/** Supersampling factor per pixel axis for the coverage threshold. */
const SUPERSAMPLE = 3

interface Point { x: number; y: number }

/** One SVG path token: a command letter or a number. */
type Token = { kind: 'command'; letter: string } | { kind: 'number'; value: number }

/** Tokenize path data into commands and numbers, tolerating glued separators. */
function tokenize(path: string): Token[] {
  const tokens: Token[] = []
  for (const match of path.matchAll(/[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)) {
    const text = match[0]
    if (/[MmZzLlHhVvCcSsQqTtAa]/.test(text)) {
      tokens.push({ kind: 'command', letter: text })
    } else {
      tokens.push({ kind: 'number', value: Number(text) })
    }
  }
  return tokens
}

/** Absolute path commands the fish logo uses, as parsed steps. */
type Step =
  | { op: 'M'; to: Point }
  | { op: 'L'; to: Point }
  | { op: 'C'; c1: Point; c2: Point; to: Point }
  | { op: 'Z' }

/** Parse tokenized path data into absolute steps (the logo is absolute-only). */
function parseSteps(tokens: readonly Token[]): Step[] {
  const steps: Step[] = []
  let cursor: Point = { x: 0, y: 0 }
  let index = 0
  /**
   * Consume the `count` numbers that follow the current command token. The
   * length check makes the returned array index-safe for tuple destructuring.
   */
  const readNumbers = (count: number): number[] => {
    const values: number[] = []
    while (values.length < count && index < tokens.length) {
      const token = tokens[index]
      if (token === undefined || token.kind !== 'number') break
      values.push(token.value)
      index++
    }
    if (values.length < count) {
      throw new Error(`path command ran out of numbers: got ${values.length} of ${count}`)
    }
    return values
  }
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    index++
    if (token.kind === 'number') throw new Error(`path number ${token.value} outside a command`)
    switch (token.letter) {
      case 'M': {
        const [x, y] = readNumbers(2) as [number, number]
        cursor = { x, y }
        steps.push({ op: 'M', to: cursor })
        break
      }
      case 'L': {
        const [x, y] = readNumbers(2) as [number, number]
        cursor = { x, y }
        steps.push({ op: 'L', to: cursor })
        break
      }
      case 'C': {
        const [c1x, c1y, c2x, c2y, x, y] = readNumbers(6) as [number, number, number, number, number, number]
        const step: Step = { op: 'C', c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y }, to: { x, y } }
        cursor = step.to
        steps.push(step)
        break
      }
      case 'Z': {
        steps.push({ op: 'Z' })
        break
      }
      default:
        throw new Error(`unsupported path command in fish logo: ${token.letter}`)
    }
  }
  return steps
}

/** Split parsed steps into closed subpath polygons with béziers flattened. */
function subpathPolygons(steps: readonly Step[]): Point[][] {
  const polygons: Point[][] = []
  let current: Point[] = []
  let start: Point | undefined
  let cursor: Point = { x: 0, y: 0 }
  const closeCurrent = (): void => {
    if (current.length >= 3) polygons.push(current)
    current = []
  }
  for (const step of steps) {
    switch (step.op) {
      case 'M':
        closeCurrent()
        cursor = step.to
        start = step.to
        current = [cursor]
        break
      case 'L':
        cursor = step.to
        current.push(cursor)
        break
      case 'C': {
        const from = cursor
        for (let i = 1; i <= CURVE_SAMPLES; i++) {
          const t = i / CURVE_SAMPLES
          const u = 1 - t
          current.push({
            x: u * u * u * from.x + 3 * u * u * t * step.c1.x + 3 * u * t * t * step.c2.x + t * t * t * step.to.x,
            y: u * u * u * from.y + 3 * u * u * t * step.c1.y + 3 * u * t * t * step.c2.y + t * t * t * step.to.y,
          })
        }
        cursor = step.to
        break
      }
      case 'Z': {
        if (start !== undefined) current.push(start)
        closeCurrent()
        break
      }
    }
  }
  closeCurrent()
  return polygons
}

/**
 * Nonzero winding containment for one point against all polygons.
 * @returns the accumulated winding number at `point`.
 */
function windingNumber(polygons: readonly Point[][], point: Point): number {
  let winding = 0
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]
      const b = polygon[(i + 1) % polygon.length]
      // Polygons enter with at least three vertices, so this is unreachable;
      // the guard only satisfies strict indexed access.
      if (a === undefined || b === undefined) continue
      if (a.y <= point.y) {
        if (b.y > point.y && (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y) > 0) winding++
      } else if (b.y <= point.y && (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y) < 0) {
        winding--
      }
    }
  }
  return winding
}

/**
 * Rasterize the polygons onto the pixel grid with supersampled coverage.
 * @param polygons - flattened, closed subpath polygons in path coordinates.
 * @param width - native path width; pixels map `COLUMNS` cells across it.
 * @param height - native path height; pixels map `PIXEL_ROWS` cells down it.
 * @returns one string per half-block row using ▀ ▄ █ and blanks.
 */
function rasterize(polygons: readonly Point[][], width: number, height: number): string[] {
  const filled: boolean[][] = Array.from({ length: PIXEL_ROWS }, () => Array.from({ length: COLUMNS }, () => false))
  for (let row = 0; row < PIXEL_ROWS; row++) {
    const cells = filled[row]
    if (cells === undefined) continue
    for (let column = 0; column < COLUMNS; column++) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const point: Point = {
            x: ((column + (sx + 0.5) / SUPERSAMPLE) / COLUMNS) * width,
            y: ((row + (sy + 0.5) / SUPERSAMPLE) / PIXEL_ROWS) * height,
          }
          if (windingNumber(polygons, point) !== 0) hits++
        }
      }
      cells[column] = hits * 2 > SUPERSAMPLE * SUPERSAMPLE
    }
  }
  const rows: string[] = []
  for (let half = 0; half < PIXEL_ROWS / 2; half++) {
    const upperCells = filled[half * 2]
    const lowerCells = filled[half * 2 + 1]
    if (upperCells === undefined || lowerCells === undefined) continue
    let line = ''
    for (let column = 0; column < COLUMNS; column++) {
      const upper = upperCells[column] ?? false
      const lower = lowerCells[column] ?? false
      line += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' '
    }
    rows.push(line)
  }
  return rows
}

const polygons = subpathPolygons(parseSteps(tokenize(FISH_LOGO_PATH)))
const rows = rasterize(polygons, FISH_LOGO_WIDTH, FISH_LOGO_HEIGHT)

// Glyph rows contain no quotes; single-quote literals satisfy the repo's
// stylistic quotes rule at the source instead of relying on a lint autofix.
const rowsLiteral = `${rows.map(row => `'${row}'`).join(',\n  ')},`

const output = `// GENERATED by scripts/gen-whale-glyph.ts — do not edit by hand. Rerun the
// generator after changing the FishLogo path. Half-block rendering of the
// DeepSeek fish logo (figma I39:24057;88:8943 fillGeometry, exact extract;
// native 23.16x17.04 → ${COLUMNS} columns × ${PIXEL_ROWS / 2} half-block rows).
// Blank cells are part of the glyph's fixed ${COLUMNS}-column grid: pad, never trim.

/** Half-block whale glyph rows; render with the brand color. */
export const WHALE_GLYPH: readonly string[] = [
  ${rowsLiteral}
]

/** Fixed glyph width in terminal columns. */
export const WHALE_GLYPH_COLUMNS = ${COLUMNS}

/** Fixed glyph height in half-block rows. */
export const WHALE_GLYPH_ROWS = ${rows.length}
`
writeFileSync(targetPath, output)
console.log(`wrote ${targetPath} (${rows.length} half-block rows, ${COLUMNS} columns)`)
