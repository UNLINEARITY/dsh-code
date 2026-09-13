/** Runtime boundary policy: CLI target resolution, /export naming, quit sequencing. */

import { describe, expect, it } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  exportSessionIdSuffix,
  resolveTarget,
  runQuitSequence,
  searchHitToRow,
  StartupInputGate,
  submissionBelongsToSession,
  type QueuedSubmission,
  type QuitCleanupStep,
} from '../src/index.ts'

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id, createdAt, ...extra } as SessionHeader
}

function persistenceWith(headers: readonly SessionHeader[]): SessionPersistence {
  // 0.1.5 `list()` resolves persistence snapshots; the TUI reads `.header`.
  return { list: async () => [...headers.map(h => ({ header: h }))] } as unknown as SessionPersistence
}

const CWD = 'C:/repo'

describe('submissionBelongsToSession (stale-delivery guard)', () => {
  it('drops deliveries composed for a session the app has since left', () => {
    // A queued switch remounts the app asynchronously while an attachment
    // prepare resolves on the microtask timeline: the tag names the composing
    // session and the runner compares it against the live one.
    expect(submissionBelongsToSession('session-old', 'session-new')).toBe(false)
    expect(submissionBelongsToSession('session-old', undefined)).toBe(false)
    // The composing session is still on screen.
    expect(submissionBelongsToSession('session-same', 'session-same')).toBe(true)
    // Untagged synchronous submissions and the pending first session pass.
    expect(submissionBelongsToSession(undefined, 'session-same')).toBe(true)
    expect(submissionBelongsToSession('', 'session-same')).toBe(true)
  })
})

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
      header('child', 5, { cwd: CWD, parentSession: 'old', origin: 'subagent' }),
      header('newer', 3, { cwd: CWD }),
      header('other', 9, { cwd: 'C:/elsewhere' }),
    ])
    await expect(resolveTarget({ kind: 'latest' }, persistence, CWD))
      .resolves.toMatchObject({ sessionId: 'newer', resume: true })
  })

  it('--continue fails when no root session pins the cwd (subagent-only directory included)', async () => {
    const subagentOnly = persistenceWith([
      header('child', 1, { cwd: CWD, parentSession: 'root', origin: 'subagent' }),
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

describe('StartupInputGate (startup input ordering)', () => {
  const sub = (text: string): QueuedSubmission => ({ text, mode: 'followup', images: [] })

  it('delivers immediately while idle', () => {
    const delivered: string[] = []
    const gate = new StartupInputGate(({ text }) => {
      delivered.push(text)
    })
    gate.submit(sub('hello'))
    expect(delivered).toEqual(['hello'])
  })

  it('queues user input behind the startup delivery and flushes it in order', async () => {
    const delivered: string[] = []
    const gate = new StartupInputGate(({ text }) => {
      delivered.push(text)
    })
    await gate.run(async deliver => {
      gate.submit(sub('user-1'))
      gate.submit(sub('user-2'))
      expect(delivered).toEqual([])
      deliver(sub('startup prompt'))
      expect(delivered).toEqual(['startup prompt'])
    })
    expect(delivered).toEqual(['startup prompt', 'user-1', 'user-2'])
  })

  it('flushes queued input even when the startup delivery fails', async () => {
    const delivered: string[] = []
    const gate = new StartupInputGate(({ text }) => {
      delivered.push(text)
    })
    await expect(gate.run(async () => {
      gate.submit(sub('first'))
      gate.submit(sub('second'))
      throw new Error('image preparation failed')
    })).rejects.toThrow('image preparation failed')
    expect(delivered).toEqual(['first', 'second'])
  })
})

describe('searchHitToRow (/search panel mapping)', () => {
  it('maps a root hit with workspace and preset detail', () => {
    const row = searchHitToRow({
      header: { version: 0, id: 'session-abcdef123456', createdAt: 1, cwd: 'C:/repo/dsh-cli', agentPreset: 'standard' } as SessionHeader,
      bestMatch: { snippet: 'fix the\n  login bug', time: 1_000 },
    })
    expect(row.id).toBe('session-abcdef123456')
    expect(row.label).toBe('abcdef123456'.slice(-12))
    expect(row.detail).toBe('dsh-cli · standard')
    expect(row.snippet).toBe('fix the login bug')
    expect(row.subagent).toBe(false)
    expect(row.resumable).toBe(true)
    expect(row.updatedAt).toBe(1_000)
  })

  it('marks subagent conversations read-only and bounds long snippets', () => {
    const row = searchHitToRow({
      header: { version: 0, id: 'child1', createdAt: 1, cwd: 'C:/repo', origin: 'subagent', parentSession: 'root1' } as SessionHeader,
      bestMatch: { snippet: 'x'.repeat(300), time: 5 },
    })
    expect(row.subagent).toBe(true)
    expect(row.resumable).toBe(false)
    expect(row.snippet.length).toBeLessThanOrEqual(158)
    expect(row.snippet.endsWith('…')).toBe(true)
  })
})
