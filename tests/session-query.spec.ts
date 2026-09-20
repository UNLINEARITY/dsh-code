/** Skip-tolerant observation: unreadable sources degrade, not fail. */

import { describe, expect, it, vi } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import {
  assertSessionQueryOverrideContract,
  observeStableWithSkip,
  type EngineSurface,
} from '../src/session-query.ts'

const header = (id: string): SessionHeader => ({ version: 3, id: SessionId(id), createdAt: 1, isSeeded: false })

type PersistenceService = NonNullable<EngineSurface['_persistenceBinding']['service']>

/** The two-good-one-bad listing the observation tests reconcile against. */
function listing(): PersistenceService {
  return {
    list: async () => [
      { header: header('good-1'), revision: SessionPersistenceRevision('r1') },
      { header: header('good-2'), revision: SessionPersistenceRevision('r1') },
      { header: header('bad'), revision: SessionPersistenceRevision('r1') },
    ],
  }
}

function makeEngine(sessions: readonly { id: string }[] = [], persistence: PersistenceService = listing()): EngineSurface {
  return {
    ctx: {
      sessions: {
        list: () => sessions.map(s => ({ header: header(s.id), inheritedEventCount: SessionLogOffset(0), snapshotEvents: () => [], id: SessionId(s.id) })),
        get: () => undefined,
      },
      logger: { warn: () => {} },
    },
    _persistenceBinding: {
      identity: Symbol('test'),
      service: persistence,
    },
    _lastPersistenceIdentity: undefined,
  }
}

const goodRead = async (_persistence: unknown, id: SessionId) => ({ header: header(id), inheritedEventCount: SessionLogOffset(0), events: [] })

describe('session-query private override contract', () => {
  it('matches the pinned sqlite engine seam', () => {
    expect(() => assertSessionQueryOverrideContract(SqliteSessionQueryEngine)).not.toThrow()
  })

  it('rejects a renamed or signature-changed seam before the bundle mounts', () => {
    class Renamed {}
    class Changed {
      _observeStable(_indexed: unknown): void {}
    }
    expect(() => assertSessionQueryOverrideContract(Renamed)).toThrow(/expected _observeStable/u)
    expect(() => assertSessionQueryOverrideContract(Changed)).toThrow(/expected _observeStable/u)
    expect(() => assertSessionQueryOverrideContract({})).toThrow(TypeError)
  })
})

describe('observeStableWithSkip', () => {
  it('skips an unreadable source with a warning and indexes the rest', async () => {
    const warn = vi.fn()
    const engine = makeEngine()
    engine.ctx.logger = { warn }
    const readCold = async (p: unknown, id: SessionId) => {
      if (id === 'bad') throw new Error('subagent/descriptor 9 uses unsupported descriptor version 2')
      return await goodRead(p, id)
    }
    const observed = await observeStableWithSkip(engine, new Map(), undefined, readCold)
    const good1 = observed.persisted.get(SessionId('good-1'))
    const good2 = observed.persisted.get(SessionId('good-2'))
    const bad = observed.persisted.get(SessionId('bad'))
    expect(good1?.loaded).toBeDefined()
    expect(good2?.loaded).toBeDefined()
    expect(bad?.loaded).toBeUndefined()
    expect(bad?.unreadable).toContain('unsupported descriptor version')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toBe('bad')
  })

  it('propagates aborts untouched', async () => {
    const engine = makeEngine()
    const readCold = async () => { throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED') }
    await expect(observeStableWithSkip(engine, new Map(), undefined, readCold))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_ABORTED' })
  })

  it('still fails the pass when persistence itself misbehaves', async () => {
    const engine = makeEngine([], { list: async () => { throw new Error('disk gone') } })
    await expect(observeStableWithSkip(engine, new Map(), undefined, goodRead))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
  })

  it('reuses indexed revisions and retries until snapshots stabilize', async () => {
    let unstable = true
    const base = makeEngine()._persistenceBinding.service!
    const engine = makeEngine([], {
      list: async () => {
        if (unstable) {
          unstable = false
          return [{ header: header('flip'), revision: SessionPersistenceRevision('r0') }]
        }
        return await base.list()
      },
    })
    const observed = await observeStableWithSkip(engine, new Map([[SessionId('good-1'), { revision: SessionPersistenceRevision('r1') }]]), undefined, goodRead)
    expect(observed.persisted.get(SessionId('good-1'))?.loaded).toBeUndefined() // reused, not re-read
    expect(observed.persisted.get(SessionId('good-2'))?.loaded).toBeDefined()
  })

  it('live owners shadow their durable copy without any cold read', async () => {
    const engine = makeEngine([{ id: 'bad' }])
    const readCold = vi.fn(async (_persistence: unknown, _id: SessionId) => { throw new Error('unreadable') })
    const observed = await observeStableWithSkip(engine, new Map(), undefined, readCold)
    expect(observed.live.get(SessionId('bad'))).toBeDefined()
    // Live sessions skip the cold read entirely: the reader never ran FOR
    // THEM (only for the two persisted non-live ones), and no unreadable
    // marking appears.
    expect(readCold.mock.calls.every(call => call[1] !== 'bad')).toBe(true)
    expect(observed.persisted.get(SessionId('bad'))?.unreadable).toBeUndefined()
  })
})
