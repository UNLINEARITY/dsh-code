/** Exclusive Ctrl+O inspector viewport and live-history cursor behavior. */

import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../src/render/projection.ts'
import {
  clampScroll,
  followInspectorCursor,
  inspectorViewport,
  inspectableTranscriptEntries,
  moveScroll,
  revealRow,
  selectionWindow,
  layoutGutterRows,
  liveRegionBudget,
} from '../src/render/inspector.ts'

describe('inspectableTranscriptEntries', () => {
  const assistant = (text: string, reasoning: string): TranscriptEntry => ({ kind: 'assistant', text, reasoning })

  it('filters reasoning-only assistant settlements without touching the source list', () => {
    const entries: readonly TranscriptEntry[] = [
      { kind: 'user', text: 'commit the changes', files: [], images: [], notice: false },
      assistant('Committed successfully.', ''),
      assistant('', '**Committing changes to repository**'),
    ]
    const visible = inspectableTranscriptEntries(entries)
    expect(visible).toEqual(entries.slice(0, 2))
    expect(entries).toHaveLength(3)
  })

  it('keeps final replies that also carry reasoning and empty non-reasoning replies', () => {
    const withAnswer = assistant('Final answer', 'private reasoning')
    const empty = assistant('', '')
    expect(inspectableTranscriptEntries([withAnswer, empty])).toEqual([withAnswer, empty])
  })
})

describe('inspectorViewport', () => {
  it('keeps the dynamic screen strictly shorter than ordinary terminals', () => {
    for (const rows of [1, 2, 6, 12, 24, 40, 100]) {
      const viewport = inspectorViewport(100, rows)
      expect(viewport.maxHeight).toBeLessThan(rows)
    }
  })

  it('reserves the border, title, and footer outside the entry body', () => {
    expect(inspectorViewport(100, 24)).toEqual({
      maxHeight: 12,
      bodyRows: 6,
      gapRows: 2,
      contentColumns: 95,
      outerColumns: 99,
      compact: false,
    })
  })

  it('collapses decorative spacing before short terminals run out of rows', () => {
    expect(layoutGutterRows(24)).toBe(1)
    expect(layoutGutterRows(13)).toBe(0)
    expect(inspectorViewport(80, 14).gapRows).toBe(0)
  })

  it('falls back to a one-line view before borders become invalid', () => {
    expect(inspectorViewport(7, 24).compact).toBe(true)
    expect(inspectorViewport(80, 5).compact).toBe(true)
  })
})

describe('liveRegionBudget', () => {
  const resting = {
    terminalRows: 24,
    composerRows: 1,
    statusBarRows: 1 as const,
    menuRows: 0,
    gutterRows: 1 as const,
    notice: false,
    todo: false,
    agents: false,
  }

  it('pins composer and status by covering live rows with extra chrome', () => {
    const restingBudget = liveRegionBudget(resting)
    expect(restingBudget).toBe(24 - (1 + 2) - 1 - 0 - 1 - 0 - 0 - 0 - 2)
    expect(liveRegionBudget({ ...resting, menuRows: 6 })).toBe(restingBudget - 6)
    expect(liveRegionBudget({ ...resting, menuRows: 6 }) + 6).toBe(restingBudget)
    expect(liveRegionBudget({ ...resting, notice: true, todo: true })).toBe(restingBudget - 2)
    expect(liveRegionBudget({ ...resting, statusBarRows: 2, composerRows: 3 })).toBe(restingBudget - 3)
  })

  it('keeps the painted tree strictly shorter than the terminal', () => {
    for (const rows of [8, 14, 24, 40]) {
      const budget = liveRegionBudget({ ...resting, terminalRows: rows })
      const painted = budget + 3 + 1 + 1
      expect(painted).toBe(rows - 2)
    }
  })
})

describe('followInspectorCursor', () => {
  it('follows appended entries while browsing the newest entry', () => {
    expect(followInspectorCursor(4, 5, 6)).toBe(5)
  })

  it('does not pull an older selection back to the tail', () => {
    expect(followInspectorCursor(2, 5, 6)).toBe(2)
  })

  it('clamps the selection if history becomes shorter', () => {
    expect(followInspectorCursor(3, 5, 2)).toBe(1)
  })
})

describe('bounded panel scrolling', () => {
  it('clamps row and page movement without changing the viewport height', () => {
    expect(clampScroll(500, 100, 15)).toBe(85)
    expect(moveScroll(10, -50, 100, 15)).toBe(0)
    expect(moveScroll(10, 50, 100, 15)).toBe(60)
  })

  it('reveals a focused row only when it leaves the current window', () => {
    expect(revealRow(10, 12, 100, 15)).toBe(10)
    expect(revealRow(10, 30, 100, 15)).toBe(16)
    expect(revealRow(10, 3, 100, 15)).toBe(3)
  })

  it('centers list selections while respecting both ends', () => {
    expect(selectionWindow(0, 100, 9)).toBe(0)
    expect(selectionWindow(50, 100, 9)).toBe(46)
    expect(selectionWindow(99, 100, 9)).toBe(91)
  })
})
