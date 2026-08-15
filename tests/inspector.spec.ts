/** Exclusive Ctrl+O inspector viewport and live-history cursor behavior. */

import { describe, expect, it } from 'vitest'
import {
  clampScroll,
  followInspectorCursor,
  inspectorViewport,
  moveScroll,
  revealRow,
  selectionWindow,
  layoutGutterRows,
} from '../src/render/inspector.ts'

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
      contentColumns: 96,
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
