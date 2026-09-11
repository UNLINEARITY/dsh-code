/** Skip-tolerant observation: unreadable sources degrade, not fail. */

import { describe, expect, it, vi } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { observeStableWithSkip, type EngineSurface } from '../src/session-query.ts'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

const header = (id: string): SessionHeader => ({ version: 3, id: id as never, createdAt: 1, isSeeded: false })

function makeEngine(sessions: readonly { id: string }[] = []): EngineSurface {
  return {
    ctx: {
      sessions: {
        list: () => sessions.map(s => ({ header: header(s.id), inheritedEventCount: 0, snapshotEvents: () => [], id: s.id })),
        get: () => undefined,
      },
      logger: { warn: () => {} },
    },
    _persistenceBinding: {
      identity: Symbol('test'),
      service: {
        list: async () => [
          { header: header('good-1'), revision: 'r1' },
          { header: header('good-2'), revision: 'r1' },
          { header: header('bad'), revision: 'r1' },
        ],
      },
    },
    _lastPersistenceIdentity: undefined,
  }
}

const goodRead = async (_p: unknown, id: string) => ({ header: header(id), inheritedEventCount: 0, events: [] })

describe('observeStableWithSkip', () => {
  it('skips an unreadable source with a warning and indexes the rest', async () => {
    const warn = vi.fn()
    const engine = makeEngine()
    engine.ctx.logger = { warn }
    const readCold = async (p: unknown, id: string) => {
      if (id === 'bad') throw new Error('subagent/descriptor 9 uses unsupported descriptor version 2')
      return await goodRead(p, id)
    }
    const observed = await observeStableWithSkip(engine, new Map(), undefined, readCold as never)
    const good1 = observed.persisted.get('good-1' as never)
    const good2 = observed.persisted.get('good-2' as never)
    const bad = observed.persisted.get('bad' as never)
    expect(good1?.loaded).toBeDefined()
    expect(good2?.loaded).toBeDefined()
    expect(bad?.loaded).toBeUndefined()
    expect(bad?.unreadable).toContain('unsupported descriptor version')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]).toBe('bad')
  })

  it('propagates aborts untouched', async () => {
    const engine = makeEngine()
    const readCold = async () => { throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED') }
    await expect(observeStableWithSkip(engine, new Map(), undefined, readCold as never))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_ABORTED' })
  })

  it('still fails the pass when persistence itself misbehaves', async () => {
    const engine = makeEngine()
    engine._persistenceBinding.service = { list: async () => { throw new Error('disk gone') } }
    await expect(observeStableWithSkip(engine, new Map(), undefined, goodRead as never))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
  })

  it('reuses indexed revisions and retries until snapshots stabilize', async () => {
    const engine = makeEngine()
    let unstable = true
    const base = engine._persistenceBinding.service!
    engine._persistenceBinding.service = {
      list: async () => {
        if (unstable) {
          unstable = false
          return [{ header: header('flip'), revision: 'r0' }]
        }
        return await base.list()
      },
    }
    const observed = await observeStableWithSkip(engine, new Map([['good-1' as never, { revision: 'r1' }]]), undefined, goodRead as never)
    expect(observed.persisted.get('good-1' as never)?.loaded).toBeUndefined() // reused, not re-read
    expect(observed.persisted.get('good-2' as never)?.loaded).toBeDefined()
  })

  it('live owners shadow their durable copy without any cold read', async () => {
    const engine = makeEngine([{ id: 'bad' }])
    const readCold = vi.fn(async () => { throw new Error('unreadable') })
    const observed = await observeStableWithSkip(engine, new Map(), undefined, readCold as never)
    expect(observed.live.get('bad' as never)).toBeDefined()
    // Live sessions skip the cold read entirely: the reader never ran FOR
    // THEM (only for the two persisted non-live ones), and no unreadable
    // marking appears.
    expect(readCold.mock.calls.every(call => call[1] !== 'bad')).toBe(true)
    expect(observed.persisted.get('bad' as never)?.unreadable).toBeUndefined()
  })
})
