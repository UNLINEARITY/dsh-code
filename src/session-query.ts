/**
 * Skip-tolerant session-query engine for this terminal.
 *
 * The upstream SqliteSessionQueryEngine reconciliation observes EVERY
 * persisted session before each search, and ONE unreadable source (for
 * example a pre-release session artifact the frozen format codecs reject)
 * fails the whole pass with SESSION_QUERY_PERSISTENCE_FAILED — every
 * cross-session search dies because of a single old file nobody opened
 * otherwise. This subclass overrides only the observation loop so an
 * unreadable source is skipped with a warning and the rest of the corpus
 * indexes normally; skipped sessions are retried on later reconciliations
 * and rejoin automatically once a host that can read them is installed.
 *
 * Vendored surface note: `_observeStable` and its module-local helpers are
 * private upstream; this file re-declares the observation loop against the
 * pinned @deepseek-ai line (see package.json peers) and must be re-checked
 * whenever that line moves. The engine class and the tool boundary also
 * share ONE physical parent-package instance through this bundle, which
 * restores instanceof-based typed error messages on the search path.
 */

import { createHash } from 'node:crypto'
import SqliteSessionQueryEngine, { type Config } from '@deepseek-ai/dsh-session-query-sqlite'
import {
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
  SessionQueryError,
} from '@deepseek-ai/dsh-session-query'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

/** One observed session: detached header plus its derived search documents. */
interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: readonly ReturnType<typeof buildSessionEventSearchDocuments>[number][]
  fingerprint: string
}

/** One persisted snapshot as the reconciliation sees it (loaded once readable). */
interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: ObservedSession
  /** Diagnosis for a cold read that failed; the session stays unindexed. */
  unreadable?: string
}

/** The engine-internal state the observation loop touches. */
export interface EngineSurface {
  readonly ctx: {
    sessions: {
      list(): readonly { header: SessionHeader; inheritedEventCount: SessionLogOffset; snapshotEvents(): readonly SessionEvent[]; id: SessionId }[]
      get(id: SessionId): unknown
    }
    logger?: { warn(format: string, ...args: readonly unknown[]): void }
  }
  readonly _persistenceBinding: {
    readonly identity: symbol
    readonly service?: {
      list(options?: { readonly signal?: AbortSignal }): Promise<readonly SessionPersistenceSnapshot[]>
    }
  }
  _lastPersistenceIdentity: symbol | undefined
}

type ColdRead = (persistence: NonNullable<EngineSurface['_persistenceBinding']['service']>, id: SessionId, signal: AbortSignal | undefined) => Promise<{ header: SessionHeader; inheritedEventCount: SessionLogOffset; events: readonly SessionEvent[] }>

const STABLE_OBSERVATION_ATTEMPTS = 2

/**
 * Ceiling for one persisted session's cold read. A truncated multi-frame
 * zstd log leaves the streaming frame decoder waiting for input that never
 * comes — no error, no return — and one such log wedged every search on the
 * whole corpus (the skip below only ever saw THROWN errors). The ceiling
 * turns any wedged read into one skipped source; a real log of this size
 * decodes in a fraction of the budget.
 */
const COLD_READ_CEILING_MS = 30_000

/**
 * Race one cold read against a ceiling, aborting the read's own signal on
 * timeout so the underlying handle can release. Aborts propagate as-is.
 * @param read - the cold-read promise to bound.
 * @param ceilingMs - milliseconds before the read is declared wedged.
 * @param signal - caller cancellation, forwarded to the race.
 */
export async function withColdReadCeiling<T>(read: (signal: AbortSignal | undefined) => Promise<T>, ceilingMs: number, signal: AbortSignal | undefined): Promise<T> {
  const controller = new AbortController()
  const forward = (): void => { controller.abort() }
  signal?.addEventListener('abort', forward, { once: true })
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cold read exceeded ${ceilingMs}ms (wedged decoder or unreadable source)`)), ceilingMs)
      const settle = (outcome: PromiseSettledResult<T>): void => {
        clearTimeout(timer)
        if (outcome.status === 'fulfilled') resolve(outcome.value)
        else reject(outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)))
      }
      read(controller.signal).then(
        (value: T) => settle({ status: 'fulfilled', value }),
        (error: unknown) => settle({ status: 'rejected', reason: error instanceof Error ? error : new Error(String(error)) }),
      )
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('cold read aborted'))
      }, { once: true })
    })
  } finally {
    signal?.removeEventListener('abort', forward)
    if (!controller.signal.aborted) controller.abort()
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function observeSession(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, inheritedEventCount, events: detachedEvents }))
      .digest('base64url'),
  }
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.isSeeded === b.isSeeded
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

function materializePersistenceSnapshots(snapshots: readonly SessionPersistenceSnapshot[]): Map<SessionId, ObservedPersistedSession> {
  // `Array.isArray` narrows a declared array type to `any[]`, which would let
  // every later access escape the type system. Step through `unknown` so the
  // guard stays a runtime assertion and the element type stays declared.
  const candidate: unknown = snapshots
  if (!Array.isArray(candidate)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of candidate as readonly SessionPersistenceSnapshot[]) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function samePersistenceSnapshots(before: ReadonlyMap<SessionId, ObservedPersistedSession>, after: ReadonlyMap<SessionId, ObservedPersistedSession>): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (second === undefined || first.revision !== second.revision || !sameHeader(first.header, second.header)) return false
  }
  return true
}

/**
 * The skip-tolerant observation pass: structurally the upstream loop, with
 * the per-source cold read wrapped so one unreadable session degrades to a
 * warning instead of failing every search. Exported for unit tests with an
 * injectable cold reader.
 */
export async function observeStableWithSkip(
  engine: EngineSurface,
  indexed: ReadonlyMap<SessionId, { revision: SessionPersistenceRevision }>,
  signal: AbortSignal | undefined,
  readCold: ColdRead = readColdSessionLog as unknown as ColdRead,
): Promise<{ persistenceBinding: EngineSurface['_persistenceBinding']; persisted: Map<SessionId, ObservedPersistedSession>; live: Map<SessionId, ObservedSession> }> {
  for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
    assertNotAborted(signal)
    const persistenceBinding = engine._persistenceBinding
    const persistence = persistenceBinding.service
    const initiallyLive = new Set(engine.ctx.sessions.list().map(session => session.id))
    let persisted = new Map<SessionId, ObservedPersistedSession>()
    if (persistence !== undefined) {
      try {
        const canReuseIndexed = engine._lastPersistenceIdentity === undefined
          || engine._lastPersistenceIdentity === persistenceBinding.identity
        const listOptions = signal === undefined ? undefined : { signal }
        const before = await persistence.list(listOptions)
        assertNotAborted(signal)
        persisted = materializePersistenceSnapshots(before)
        for (const entry of persisted.values()) {
          if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue
          if (initiallyLive.has(entry.header.id) || engine.ctx.sessions.get(entry.header.id) !== undefined) continue
          assertNotAborted(signal)
          // The skip: a session whose cold log fails to migrate or decode
          // stays OUT of the index with one warning; the remaining corpus
          // indexes normally. `loaded` stays undefined exactly like a
          // not-yet-read entry, so the stable-snapshot comparison and the
          // live-preferred merge below are unaffected.
          try {
            const loaded = await withColdReadCeiling(innerSignal => readCold(persistence, entry.header.id, innerSignal), COLD_READ_CEILING_MS, signal)
            assertNotAborted(signal)
            assertSessionHeadersCompatible(entry.header, loaded.header)
            entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events)
          } catch (error: unknown) {
            if (isAbort(error) || signal?.aborted) throw error
            if (engine._persistenceBinding !== persistenceBinding) break
            entry.unreadable = errorMessage(error)
            engine.ctx.logger?.warn(
              'session-search skipped unreadable session %s: %s',
              entry.header.id,
              entry.unreadable,
            )
          }
        }
        assertNotAborted(signal)
        const afterSnapshots = await persistence.list(listOptions)
        assertNotAborted(signal)
        const after = materializePersistenceSnapshots(afterSnapshots)
        if (!samePersistenceSnapshots(persisted, after)) continue
        if (engine._persistenceBinding !== persistenceBinding) continue
      } catch (error: unknown) {
        if (isAbort(error) || signal?.aborted) {
          throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', { cause: error })
        }
        if (engine._persistenceBinding !== persistenceBinding) continue
        if (error instanceof SessionQueryError) throw error
        throw new SessionQueryError(
          `session-search persistence observation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_PERSISTENCE_FAILED',
          { cause: error },
        )
      }
    }
    const live = new Map<SessionId, ObservedSession>()
    for (const session of engine.ctx.sessions.list()) {
      const observed = observeSession(session.header, session.inheritedEventCount, session.snapshotEvents())
      const durable = persisted.get(session.id)
      if (durable !== undefined && durable.loaded === undefined) {
        // A live owner always wins over a skipped durable copy.
        live.set(session.id, observed)
        continue
      }
      if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
      live.set(session.id, observed)
    }
    const sameLive = initiallyLive.size === live.size && [...initiallyLive].every(id => live.has(id))
    if (!sameLive) continue
    return { persistenceBinding, persisted, live }
  }
  throw new SessionQueryError('session-search persistence observation did not stabilize after one retry', 'SESSION_QUERY_PERSISTENCE_FAILED')
}

/**
 * Assert the private override seam this compatibility engine relies on.
 * Harness keeps `_observeStable` private, so TypeScript cannot protect this
 * subclass when upstream renames the method or changes its call signature.
 * The exact-version launcher gate prevents unsupported hosts; this import-time
 * check additionally prevents a newly built bundle from silently mounting an
 * override the installed base will never call.
 *
 * @internal Exported for the compatibility regression.
 */
export function assertSessionQueryOverrideContract(candidate: unknown): void {
  if (typeof candidate !== 'function') throw new TypeError('session-query sqlite engine must be a constructor')
  const prototype = (candidate as { prototype?: object }).prototype
  const descriptor = prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, '_observeStable')
  const method: unknown = descriptor?.value
  if (typeof method !== 'function' || method.length !== 2) {
    throw new Error('incompatible @deepseek-ai/dsh-session-query-sqlite: expected _observeStable(indexed, signal)')
  }
}

assertSessionQueryOverrideContract(SqliteSessionQueryEngine)

// The opaque-base cast keeps the private `_observeStable` override legal in
// TypeScript while inheriting every runtime static (inject, Config, Service
// metadata) from the real engine class.
const EngineBase = SqliteSessionQueryEngine as unknown as abstract new (ctx: never, config: Config) => EngineSurface & object

/** The engine this bundle mounts in place of the base `session-query-sqlite` row. */
export class SkipTolerantSessionQueryEngine extends EngineBase {
  async _observeStable(indexed: ReadonlyMap<SessionId, { revision: SessionPersistenceRevision }>, signal: AbortSignal | undefined): Promise<unknown> {
    return await observeStableWithSkip(this, indexed, signal)
  }
}

export default SkipTolerantSessionQueryEngine as unknown as typeof SqliteSessionQueryEngine
