/** Runtime boundary policy: CLI target resolution, /export naming, quit sequencing. */

import { describe, expect, it } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  exportSessionIdSuffix,
  resolveTarget,
  runQuitSequence,
  type QuitCleanupStep,
} from '../src/index.ts'

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id, createdAt, ...extra } as SessionHeader
}

function persistenceWith(headers: readonly SessionHeader[]): SessionPersistence {
  return { list: async (): Promise<SessionHeader[]> => [...headers] } as unknown as SessionPersistence
}

const CWD = 'C:/repo'

describe('resolveTarget (CLI session policy)', () => {
  it('resumes a persisted root session by exact id or unique prefix', async () => {
    const persistence = persistenceWith([header('abc123', 1, { cwd: CWD })])
    await expect(resolveTarget({ kind: 'resume', sessionId: 'abc123' }, persistence, CWD))
      .resolves.toMatchObject({ sessionId: 'abc123', resume: true })
    await expect(resolveTarget({ kind: 'resume', sessionId: 'abc' }, persistence, CWD))
      .resolves.toMatchObject({ sessionId: 'abc123', resume: true })
  })

  it('rejects resuming a subagent conversation by id or prefix', async () => {
    const persistence = persistenceWith([
      header('root1', 1, { cwd: CWD }),
      header('child1', 2, { cwd: CWD, parentSession: 'root1', origin: 'subagent' }),
    ])
    await expect(resolveTarget({ kind: 'resume', sessionId: 'child1' }, persistence, CWD))
      .rejects.toThrow(/subagent conversations are read-only/)
    await expect(resolveTarget({ kind: 'resume', sessionId: 'child' }, persistence, CWD))
      .rejects.toThrow(/subagent conversations are read-only/)
  })

  it('rejects an ambiguous prefix', async () => {
    const persistence = persistenceWith([header('abc1', 1), header('abc2', 2)])
    await expect(resolveTarget({ kind: 'resume', sessionId: 'abc' }, persistence, CWD))
      .rejects.toThrow(/ambiguous/)
  })

  it('--continue picks the newest root session for the cwd, skipping subagents', async () => {
    const persistence = persistenceWith([
      header('old', 1, { cwd: CWD }),
      header('child', 5, { cwd: CWD, parentSession: 'old' }),
      header('newer', 3, { cwd: CWD }),
      header('other', 9, { cwd: 'C:/elsewhere' }),
    ])
    await expect(resolveTarget({ kind: 'latest' }, persistence, CWD))
      .resolves.toMatchObject({ sessionId: 'newer', resume: true })
  })

  it('--continue fails when no root session pins the cwd (subagent-only directory included)', async () => {
    const subagentOnly = persistenceWith([
      header('child', 1, { cwd: CWD, parentSession: 'root' }),
    ])
    await expect(resolveTarget({ kind: 'latest' }, subagentOnly, CWD))
      .rejects.toThrow(/no persisted session for this directory/)
    const absent = persistenceWith([header('elsewhere', 1, { cwd: 'C:/other' })])
    await expect(resolveTarget({ kind: 'latest' }, absent, CWD))
      .rejects.toThrow(/no persisted session for this directory/)
  })

  it('--session rejects an id that already exists', async () => {
    const persistence = persistenceWith([header('taken', 1)])
    await expect(resolveTarget({ kind: 'named', sessionId: 'taken' }, persistence, CWD))
      .rejects.toThrow(/already exists/)
    await expect(resolveTarget({ kind: 'named', sessionId: 'fresh' }, persistence, CWD))
      .resolves.toMatchObject({ sessionId: 'fresh', resume: false })
  })

  it('--session passes through when persistence is unavailable (the backend still guards)', async () => {
    await expect(resolveTarget({ kind: 'named', sessionId: 'anything' }, undefined, CWD))
      .resolves.toMatchObject({ sessionId: 'anything', resume: false })
  })
})

describe('exportSessionIdSuffix', () => {
  it('keeps only filename-safe characters and bounds the suffix to 8', () => {
    expect(exportSessionIdSuffix('session-12345678')).toBe('12345678')
    expect(exportSessionIdSuffix('session-1234567890')).toBe('34567890')
    expect(exportSessionIdSuffix('C:\\evil path')).toBe('vil_path')
    expect(exportSessionIdSuffix('a\\b/c')).toBe('a_b_c')
    expect(exportSessionIdSuffix('')).toBe('')
  })

  it('removes path separators so the default /export target cannot escape the cwd', () => {
    // A malicious --session id must never leak a separator into the filename.
    expect(exportSessionIdSuffix('../..')).toBe('.._..')
    expect(exportSessionIdSuffix('..\\..\\pwn')).not.toMatch(/[\\/]/)
    expect(`dsh-session-${exportSessionIdSuffix('..\\..\\pwn')}.md`).toBe('dsh-session-._.._pwn.md')
  })
})

describe('runQuitSequence (quit cleanup ordering)', () => {
  /** One step recording its name into `order`; a rejected step also records its failure. */
  function step(name: string, order: string[], failWith?: string): QuitCleanupStep {
    return {
      name,
      run: async (): Promise<void> => {
        order.push(name)
        if (failWith !== undefined) throw new Error(failWith)
      },
    }
  }

  it('settles the active session, then awaits composing and history, then exits once with 0', async () => {
    const order: string[] = []
    const exitCodes: number[] = []
    const ran = await runQuitSequence([
      step('flush', order),
      step('dispose', order),
      step('composing', order),
      step('history', order),
    ], code => { exitCodes.push(code) })
    expect(ran).toEqual(['flush', 'dispose', 'composing', 'history'])
    expect(order).toEqual(['flush', 'dispose', 'composing', 'history'])
    expect(exitCodes).toEqual([0])
  })

  it('bare case: no active steps, still waits for the in-flight composing before history and exit', async () => {
    const order: string[] = []
    let releaseComposing!: () => void
    const pending = runQuitSequence([
      { name: 'composing', run: () => new Promise<void>(resolve => {
        order.push('composing')
        releaseComposing = resolve
      }) },
      step('history', order),
    ], code => { order.push(`exit:${code}`) })
    await new Promise(resolve => setImmediate(resolve))
    // The composition is still preparing: no history write and no exit yet.
    expect(order).toEqual(['composing'])
    releaseComposing()
    await pending
    expect(order).toEqual(['composing', 'history', 'exit:0'])
  })

  it('a rejecting flush/dispose never skips the remaining cleanup and still exits', async () => {
    const order: string[] = []
    const failures: Array<[string, unknown]> = []
    const ran = await runQuitSequence([
      step('flush', order, 'flush broke'),
      step('dispose', order, 'dispose broke'),
      step('composing', order),
      step('history', order),
    ], code => { order.push(`exit:${code}`) }, (name, error) => { failures.push([name, error]) })
    expect(ran).toEqual(['flush', 'dispose', 'composing', 'history'])
    expect(order).toEqual(['flush', 'dispose', 'composing', 'history', 'exit:0'])
    expect(failures.map(([name]) => name)).toEqual(['flush', 'dispose'])
    expect((failures[0]?.[1] as Error).message).toBe('flush broke')
  })

  it('a rejecting composing/history step still reaches exit', async () => {
    const order: string[] = []
    const failures: Array<[string, unknown]> = []
    await runQuitSequence([
      step('composing', order, 'composing broke'),
      step('history', order, 'history broke'),
    ], code => { order.push(`exit:${code}`) }, (name, error) => { failures.push([name, error]) })
    expect(order).toEqual(['composing', 'history', 'exit:0'])
    expect(failures.map(([name]) => name)).toEqual(['composing', 'history'])
  })

  it('a throwing failure sink cannot abort the remaining cleanup or the exit', async () => {
    const order: string[] = []
    const ran = await runQuitSequence([
      step('flush', order, 'flush broke'),
      step('history', order),
    ], code => { order.push(`exit:${code}`) }, () => { throw new Error('sink broke') })
    expect(ran).toEqual(['flush', 'history'])
    expect(order).toEqual(['flush', 'history', 'exit:0'])
  })
})
