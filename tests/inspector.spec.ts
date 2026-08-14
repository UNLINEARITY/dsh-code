/** Exclusive Ctrl+O inspector viewport and live-history cursor behavior. */

import { describe, expect, it } from 'vitest'
import { followInspectorCursor, inspectorViewport } from '../src/render/inspector.ts'

describe('inspectorViewport', () => {
  it('keeps the dynamic screen strictly shorter than ordinary terminals', () => {
    for (const rows of [1, 2, 6, 12, 24, 40, 100]) {
      const viewport = inspectorViewport(100, rows)
      expect(viewport.maxHeight).toBeLessThan(rows)
    }
  })

  it('reserves the border, title, and footer outside the entry body', () => {
    expect(inspectorViewport(100, 24)).toEqual({
      maxHeight: 19,
      bodyRows: 15,
      contentColumns: 96,
      compact: false,
    })
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
