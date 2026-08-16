/** Tool-arguments preview: key extraction, bounded raw fallback, parse cap. */

import { describe, expect, it, vi } from 'vitest'
import { toolArgumentsPreview } from '../src/render/tool-preview.ts'

describe('toolArgumentsPreview', () => {
  it('falls back to the tool name for empty arguments', () => {
    expect(toolArgumentsPreview('', 'read')).toBe('read')
  })

  it('extracts the first well-known string key in declaration order', () => {
    expect(toolArgumentsPreview('{"command":"ls -la"}', 'tool')).toBe('ls -la')
    expect(toolArgumentsPreview('{"path":"a.ts","command":"run"}', 'tool')).toBe('run')
    expect(toolArgumentsPreview('{"query":"term"}', 'tool')).toBe('term')
  })

  it('skips non-string values and keeps scanning', () => {
    expect(toolArgumentsPreview('{"command":42,"path":"b.ts"}', 'tool')).toBe('b.ts')
    expect(toolArgumentsPreview('{"command":"","path":"c.ts"}', 'tool')).toBe('c.ts')
  })

  it('degrades malformed JSON to the bounded raw arguments', () => {
    expect(toolArgumentsPreview('not json', 'tool')).toBe('not json')
    const long = 'x'.repeat(200)
    expect(toolArgumentsPreview(long, 'tool')).toBe('x'.repeat(77) + '...')
  })

  it('skips JSON.parse entirely for arguments over the cap and returns a short preview', () => {
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const args = `{"command":"${'x'.repeat(5000)}"}`
      expect(args.length).toBeGreaterThan(4096)
      const preview = toolArgumentsPreview(args, 'tool')
      expect(preview).toBe(`${args.slice(0, 77)}...`)
      expect(preview.length).toBe(80)
      expect(preview).not.toContain('x'.repeat(5000))
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('still parses and extracts from arguments at or under the cap', () => {
    const args = `{"command":"x","pad":"${'a'.repeat(4070)}"}`
    expect(args.length).toBeLessThanOrEqual(4096)
    expect(toolArgumentsPreview(args, 'tool')).toBe('x')
  })
})
