/**
 * Audit-fix regressions: every case here pins one defect from the six-area
 * logic audit (stale-paste hostage, orphan retry/command pinning the settled
 * boundary, inbox splice order, always-mode retry display, cross-agent skill
 * catalogs, lost skill change notifications, trailing-newline tail budget).
 */

import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { createKeypressSplitter, createSplitStdin } from '../src/input-split.ts'
import { PASTE_BRACKET_TIMEOUT_MS } from '../src/keyboard.ts'
import { createTranscriptView, projectEvent, projectEvents, settledEntryCount } from '../src/render/projection.ts'
import { transcriptEntryLines } from '../src/render/lines.ts'
import { displayTail } from '../src/render/text.ts'
import { watchSkills } from '../src/skills.ts'
import type { Context } from '@deepseek-ai/cordis'

const seq = { current: 0 }
const next = (): number => (seq.current += 1)
const ev = (type: string, data: Record<string, unknown>): SessionEvent =>
  ({ type, seq: next(), time: 0, data }) as SessionEvent

const TURN_START = (): SessionEvent => ev('turn/start', { turn: 1 })
const TURN_END = (): SessionEvent => ev('turn/end', { turn: 1, reason: { kind: 'ok' } })
const RETRY = (mode: 'normal' | 'always'): SessionEvent => ev('llm/retry', {
  retryId: 'r1', turn: 1, step: 1, mode, retry: 2,
  ...(mode === 'normal' ? { maxRetries: 3 } : {}),
  delayMs: 500, failure: { code: 'RATE_LIMIT', message: 'slow down' },
})
const RETRY_STARTED = (): SessionEvent => ev('llm/retry-started', { retryId: 'r1' })
const COMMAND_RUN = (): SessionEvent => ev('command/run', { commandId: 'cmd1', name: 'model', args: '' })
const COMMAND_DONE = (): SessionEvent => ev('command/done', { commandId: 'cmd1', kind: 'success', text: 'switched' })

describe('audit fix: stale bracketed paste', () => {
  it('reports the open paste and releases held bytes without the start marker', () => {
    const splitter = createKeypressSplitter()
    expect(splitter.push('\x1b[200~ab')).toEqual([])
    expect(splitter.openPaste()).toBe(true)
    const released = splitter.releaseStalePaste()
    expect(released).toEqual(['a', 'b'])
    expect(released.every(unit => !unit.includes('\x1b[200~'))).toBe(true)
    expect(splitter.openPaste()).toBe(false)
    expect(splitter.releaseStalePaste()).toEqual([])
  })

  it('the split-stdin proxy releases a hostage paste after the shared window', async () => {
    vi.useFakeTimers()
    try {
      const source = new PassThrough() as unknown as NodeJS.ReadStream
      source.isTTY = true
      const { stdin, dispose } = createSplitStdin(source)
      const seen: string[] = []
      stdin.on('data', chunk => seen.push(String(chunk)))
      source.write('\x1b[200~y')
      expect(seen).toEqual([])
      await vi.advanceTimersByTimeAsync(PASTE_BRACKET_TIMEOUT_MS)
      expect(seen).toEqual(['y'])
      // A later real end marker is just a removable stray, never a lock.
      source.write('\x1b[201~q')
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toEqual(['y', '\x1b[201~', 'q'])
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a paste that terminates in time is never released piecemeal', async () => {
    vi.useFakeTimers()
    try {
      const source = new PassThrough() as unknown as NodeJS.ReadStream
      source.isTTY = true
      const { stdin, dispose } = createSplitStdin(source)
      const seen: string[] = []
      stdin.on('data', chunk => seen.push(String(chunk)))
      source.write('\x1b[200~whole block\x1b[201~')
      await vi.advanceTimersByTimeAsync(PASTE_BRACKET_TIMEOUT_MS)
      expect(seen).toEqual(['\x1b[200~whole block\x1b[201~'])
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('audit fix: orphan retry/command finalization on turn/end', () => {
  it('finalizes running retry and command rows so the settled boundary advances', () => {
    const events = [TURN_START(), RETRY('normal'), COMMAND_RUN(), TURN_END()]
    let view = createTranscriptView()
    for (const event of events) view = projectEvent(view, event)
    const retry = view.entries.find(entry => entry.kind === 'retry')
    const command = view.entries.find(entry => entry.kind === 'command')
    expect(retry && retry.state).toBe('done')
    expect(command && command.state).toBe('error')
    expect(settledEntryCount(view.entries)).toBe(view.entries.length)
  })

  it('a normally closed retry keeps its done state and summary', () => {
    const events = [TURN_START(), RETRY('normal'), RETRY_STARTED(), COMMAND_RUN(), COMMAND_DONE(), TURN_END()]
    let view = createTranscriptView()
    for (const event of events) view = projectEvent(view, event)
    const retry = view.entries.find(entry => entry.kind === 'retry')
    const command = view.entries.find(entry => entry.kind === 'command')
    expect(retry && retry.state).toBe('done')
    expect(command && command.state).toBe('done')
    expect(command && command.summary).toBe('switched')
  })

  it('replay produces the identical finalized view', () => {
    const events = [TURN_START(), RETRY('always'), COMMAND_RUN(), TURN_END()]
    let folded = createTranscriptView()
    for (const event of events) folded = projectEvent(folded, event)
    const replayed = projectEvents(events)
    expect(replayed.entries).toEqual(folded.entries)
    expect(settledEntryCount(replayed.entries)).toBe(replayed.entries.length)
  })
})

describe('audit fix: inbox splice keeps upstream order', () => {
  const message = (id: string): ReturnType<typeof createUserMessage> =>
    createUserMessage({ content: [{ type: 'text', text: id }], source: { kind: 'user' } }) as unknown as ReturnType<typeof createUserMessage>

  it('a prepend lands at the splice position, never at the tail (reducer and replay)', () => {
    const m1 = message('m1')
    const m0 = message('m0')
    const events = [
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [m1] }),
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [m0] }),
    ]
    let folded = createTranscriptView()
    for (const event of events) folded = projectEvent(folded, event)
    expect(folded.pending['next-turn']).toEqual([m0.id, m1.id])
    expect(projectEvents(events).pending['next-turn']).toEqual([m0.id, m1.id])
  })

  it('a mid-queue replace swaps in place', () => {
    const a = message('a')
    const b = message('b')
    const c = message('c')
    const events = [
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [a, b] }),
      ev('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1, inserted: [c] }),
    ]
    let folded = createTranscriptView()
    for (const event of events) folded = projectEvent(folded, event)
    expect(folded.pending['next-turn']).toEqual([a.id, c.id])
    expect(projectEvents(events).pending['next-turn']).toEqual([a.id, c.id])
  })
})

describe('audit fix: always-mode retry display', () => {
  const base = { kind: 'retry' as const, retryId: 'r1', attempt: 5, max: 5, code: 'RATE_LIMIT', delayMs: 500, state: 'done' as const }
  it('never fabricates an attempt cap for the uncapped policy', () => {
    const always = transcriptEntryLines({ ...base, mode: 'always' }, 80, false)
    const normal = transcriptEntryLines({ ...base, mode: 'normal' }, 80, false)
    expect(always.some(line => line.segments.some(s => s.text.includes('retry 5 ·')))).toBe(true)
    expect(always.some(line => line.segments.some(s => s.text.includes('5/5')))).toBe(false)
    expect(normal.some(line => line.segments.some(s => s.text.includes('5/5')))).toBe(true)
  })
})

describe('audit fix: displayTail trailing newline', () => {
  it('a trailing blank row never evicts real content', () => {
    const tail = displayTail('l1\nl2\nl3\n', 80, 2)
    expect(tail.text).toBe('l2\nl3')
    expect(tail.truncated).toBe(true)
  })

  it('the deliberate caret row survives when it fits', () => {
    const tail = displayTail('a\n', 80, 5)
    expect(tail.text).toBe('a\n')
    expect(tail.truncated).toBe(false)
  })
})

describe('audit fix: skill catalog agent ownership', () => {
  const summary = (name: string): SkillSummary => ({
    name,
    description: name + ' does things',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'filesystem',
  } as SkillSummary)

  function harness() {
    let catalog: readonly SkillSummary[] = []
    let rejectNext = false
    const listeners = new Set<() => void>()
    const registry = {
      list: async (): Promise<readonly SkillSummary[]> => {
        if (rejectNext) {
          rejectNext = false
          throw new Error('discovery failed')
        }
        return catalog
      },
    }
    const ctx = {
      get: (name: string): unknown => (name === 'skills' ? registry : undefined),
      on: (event: string, listener: () => void): (() => void) => {
        if (event === 'skills/change') listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as Context
    return {
      ctx,
      setCatalog: (rows: readonly SkillSummary[]): void => { catalog = rows },
      failNext: (): void => { rejectNext = true },
      fireChange: (): void => { for (const listener of listeners) listener() },
    }
  }

  const agentOf = (id: string): Agent => ({ id, session: { header: { cwd: 'C:/' + id } } }) as unknown as Agent

  it('a first-load failure for a new agent clears the previous workspace rows', async () => {
    const { ctx, setCatalog, failNext } = harness()
    const view = watchSkills(ctx)
    setCatalog([summary('a-skill')])
    view.setAgent(agentOf('a'))
    await vi.waitFor(() => expect(view.rows.map(row => row.name)).toEqual(['a-skill']))
    failNext()
    view.setAgent(agentOf('b'))
    await vi.waitFor(() => expect(view.error).toBeDefined())
    expect(view.rows).toEqual([])
  })

  it('a same-agent reload failure keeps the last good rows', async () => {
    const { ctx, setCatalog, failNext, fireChange } = harness()
    const view = watchSkills(ctx)
    setCatalog([summary('a-skill')])
    view.setAgent(agentOf('a'))
    await vi.waitFor(() => expect(view.rows).toHaveLength(1))
    failNext()
    fireChange()
    await vi.waitFor(() => expect(view.error).toBeDefined())
    expect(view.rows.map(row => row.name)).toEqual(['a-skill'])
  })

  it('a description-only edit still notifies subscribers', async () => {
    const { ctx, setCatalog, fireChange } = harness()
    const view = watchSkills(ctx)
    setCatalog([summary('a-skill')])
    view.setAgent(agentOf('a'))
    await vi.waitFor(() => expect(view.rows).toHaveLength(1))
    const seen: number[] = []
    view.subscribe(() => seen.push(1))
    setCatalog([{ ...summary('a-skill'), description: 'changed' }])
    fireChange()
    await vi.waitFor(() => expect(view.rows[0]?.description).toBe('changed'))
    expect(seen.length).toBeGreaterThan(0)
  })
})
