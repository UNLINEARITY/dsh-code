/**
 * Subagent activity feed: pure event folding, the row cap, the FIFO reset,
 * and the coalesced identity-stable store (the getSnapshot contract that
 * keeps useSyncExternalStore out of render loops).
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createSubagentFeed, foldSubagentRow, MAX_SUBAGENT_ROWS } from '../src/subagents.ts'

function event(type: string, data: Record<string, unknown>, time = 1): SessionEvent {
  return { type, seq: time, time, data } as unknown as SessionEvent
}

describe('foldSubagentRow', () => {
  it('seeds a fresh row from the first child event', () => {
    const row = foldSubagentRow(undefined, 'session-child', event('request/header', {}, 5))
    expect(row.id).toBe('session-child')
    expect(row.label).toBe('agent -child')
    expect(row.state).toBe('running')
    expect(row.activity).toBe('working…')
  })

  it('adopts the durable catalog label and mode as an idle row', () => {
    // 0.1.5 parent-owned discovery fact: a continuable child carries an
    // authored label; a one-shot child may carry none.
    const continuable = foldSubagentRow(undefined, 's1', event('subagent/catalog', {
      version: 0, childId: 's1', childCreatedAt: 1, mode: 'continuable', label: 'research helper',
    }, 2))
    expect(continuable.label).toBe('research helper')
    expect(continuable.state).toBe('idle')
    expect(continuable.activity).toBe('catalog · continuable · research helper')
    const oneShot = foldSubagentRow(undefined, 's2', event('subagent/catalog', {
      version: 0, childId: 's2', childCreatedAt: 1, mode: 'one-shot',
    }, 3))
    expect(oneShot.label).toBe('agent s2')
    expect(oneShot.activity).toBe('catalog · one-shot')
    // A later observed title still wins the label; the row stays idle.
    const titled = foldSubagentRow(continuable, 's1', event('session/title', { title: 'explorer' }, 4))
    expect(titled.label).toBe('explorer')
  })

  it('folds tool calls and assistant messages into bounded activity text', () => {
    let row = foldSubagentRow(undefined, 's1', event('tool/call', { name: 'read_file' }, 2))
    expect(row.activity).toBe('tool read_file')
    expect(row.state).toBe('running')
    row = foldSubagentRow(row, 's1', event('assistant/message', {
      message: { content: [{ type: 'text', text: 'analyzed  the\n parser' }] },
    }, 3))
    expect(row.state).toBe('idle')
    expect(row.activity).toBe('analyzed the parser')
  })

  it('bounds long activity text with an ellipsis', () => {
    const row = foldSubagentRow(undefined, 's1', event('assistant/message', {
      message: { content: [{ type: 'text', text: 'x'.repeat(200) }] },
    }, 2))
    expect(row.activity.length).toBeLessThanOrEqual(80)
    expect(row.activity.endsWith('…')).toBe(true)
  })

  it('marks the child done on turn/end and adopts observed titles', () => {
    let row = foldSubagentRow(undefined, 's1', event('session/title', { title: 'explorer' }, 1))
    expect(row.label).toBe('explorer')
    row = foldSubagentRow(row, 's1', event('turn/end', {}, 2))
    expect(row.state).toBe('done')
    expect(row.activity).toBe('finished')
  })

  it('leaves the row untouched for unknown event kinds', () => {
    const seeded = foldSubagentRow(undefined, 's1', event('request/header', {}, 1))
    const next = foldSubagentRow(seeded, 's1', event('compaction/summary', {}, 9))
    expect(next.activity).toBe(seeded.activity)
    expect(next.state).toBe(seeded.state)
  })
})

describe('createSubagentFeed', () => {
  it('folds multiple children into one row each and resets cleanly', async () => {
    const feed = createSubagentFeed()
    feed.apply('a', event('request/header', {}, 1))
    feed.apply('b', event('tool/call', { name: 'grep' }, 2))
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    expect(feed.getSnapshot().map(row => row.id)).toEqual(['a', 'b'])
    expect(feed.getSnapshot()[1]!.activity).toBe('tool grep')
    feed.reset()
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    expect(feed.getSnapshot()).toEqual([])
  })

  it('coalesces one notification per synchronous burst', async () => {
    const feed = createSubagentFeed()
    let notified = 0
    feed.subscribe(() => {
      notified += 1
    })
    feed.apply('a', event('request/header', {}, 1))
    // Durable logs are settlement-only since session-log v2; a child's
    // in-flight generation surfaces through its settled attempt records.
    feed.apply('a', event('assistant/attempt', { stream: [] }, 2))
    feed.apply('a', event('assistant/attempt', { stream: [] }, 3))
    expect(notified).toBe(0)
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    expect(notified).toBe(1)
    // The snapshot itself folded every event (view reads stay synchronous).
    expect(feed.getSnapshot()[0]!.activity).toBe('thinking…')
  })

  it('evicts the oldest done row for a new running child and keeps the honest total', async () => {
    const feed = createSubagentFeed()
    for (let index = 0; index < MAX_SUBAGENT_ROWS; index += 1) {
      feed.apply(`child-${index}`, event('request/header', {}, index + 1))
    }
    feed.apply('child-0', event('turn/end', {}, 50))
    feed.apply('child-new', event('request/header', {}, 51))
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    const rows = feed.getSnapshot()
    expect(rows.length).toBe(MAX_SUBAGENT_ROWS)
    expect(rows.map(row => row.id)).not.toContain('child-0')
    expect(rows.map(row => row.id)).toContain('child-new')
    expect(feed.getTotalSeen()).toBe(MAX_SUBAGENT_ROWS + 1)
  })

  it('drops a new row while every row is busy but still counts and notifies the total', async () => {
    const feed = createSubagentFeed()
    let notified = 0
    feed.subscribe(() => {
      notified += 1
    })
    for (let index = 0; index < MAX_SUBAGENT_ROWS; index += 1) {
      feed.apply(`busy-${index}`, event('request/header', {}, index + 1))
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    const notifiedBefore = notified
    feed.apply('overflow', event('request/header', {}, 99))
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    expect(feed.getSnapshot().map(row => row.id)).not.toContain('overflow')
    expect(feed.getTotalSeen()).toBe(MAX_SUBAGENT_ROWS + 1)
    expect(notified).toBe(notifiedBefore + 1)
  })

  it('resets the observed total with the rows', async () => {
    const feed = createSubagentFeed()
    feed.apply('a', event('request/header', {}, 1))
    feed.reset()
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    expect(feed.getTotalSeen()).toBe(0)
  })

  it('caps the row count and keeps the identity-stable snapshot contract', () => {
    const feed = createSubagentFeed()
    for (let index = 0; index < MAX_SUBAGENT_ROWS + 3; index += 1) {
      feed.apply(`child-${index}`, event('request/header', {}, index + 1))
    }
    const rows = feed.getSnapshot()
    expect(rows.length).toBe(MAX_SUBAGENT_ROWS)
    expect(rows).toBe(feed.getSnapshot())
    // A no-op fold (same state) keeps array identity.
    const before = feed.getSnapshot()
    feed.apply('child-0', event('compaction/prune', {}, 99))
    expect(feed.getSnapshot()).toBe(before)
  })
})
