/** Schedule/context folds: durable reminders, hidden snapshots, panel rows. */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { render } from 'ink'
import { createElement } from 'react'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyScheduleChange,
  createReplayAccumulator,
  createTranscriptView,
  finishReplay,
  nextEveryTarget,
  projectEvent,
  replayProjectEvent,
  type ScheduleRow,
} from '../src/render/projection.ts'
import { SchedulePanel, scheduleDisplayRows, scheduleFrequency, scheduleRelative } from '../src/kernel-panels.ts'

function scheduleEvent(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq, time: 0, data } as SessionEvent
}

function pluginMessageEvent(plugin: string, form: 'snapshot' | undefined, text: string, seq: number): SessionEvent {
  const source = form === undefined
    ? { kind: 'plugin', plugin } as const
    : { kind: 'plugin', plugin, form, sections: [{ name: `${plugin}-context`, text }] } as const
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: createUserMessage({ content: [{ type: 'text', text }], source }),
  } as SessionEvent
}

const EVERY_CREATE = { operation: 'create', schedule: { id: 'schedule-1', kind: 'every', prompt: 'build check', everySeconds: 3600, scheduledAt: '2026-09-11T08:00:00Z' } }
const AT_CREATE = { operation: 'create', schedule: { id: 'schedule-2', kind: 'at', prompt: 'ship note', scheduledAt: '2026-09-12T08:00:00Z' } }
const EVERY_DISPATCH = { operation: 'dispatch', id: 'schedule-1', acceptedAt: '2026-09-11T09:00:00Z' }

describe('applyScheduleChange', () => {
  it('reads the target straight from scheduledAt — upstream records already carry the due instant', () => {
    // AfterScheduleRecord.scheduledAt IS the RFC 3339 target (delay included):
    // adding afterSeconds again would double the delay.
    const created = applyScheduleChange([], { operation: 'create', schedule: { id: 'schedule-1', kind: 'after', prompt: 'ping', afterSeconds: 60, scheduledAt: '2026-09-11T08:00:00Z' } })
    expect(created[0].targetAt).toBe(Date.parse('2026-09-11T08:00:00Z'))
    const at = applyScheduleChange([], { operation: 'create', schedule: { id: 'schedule-2', kind: 'at', prompt: 'ping', scheduledAt: '2026-09-11T09:00:00Z' } })
    expect(at[0].targetAt).toBe(Date.parse('2026-09-11T09:00:00Z'))
    // EveryScheduleRecord.scheduledAt is the earliest anchor-aligned
    // occurrence NOT YET dispatched — no interval added on create either.
    const every = applyScheduleChange([], { operation: 'create', schedule: { id: 'schedule-3', kind: 'every', prompt: 'ping', everySeconds: 300, scheduledAt: '2026-09-11T08:00:00Z' } })
    expect(every[0].everySeconds).toBe(300)
    expect(every[0].targetAt).toBe(Date.parse('2026-09-11T08:00:00Z'))
  })

  it('finishes a dispatched one-shot and advances a recurrence past missed occurrences', () => {
    const anchor = Date.parse('2026-09-11T08:00:00Z')
    const rows = [
      { id: 'schedule-1', kind: 'at', prompt: 'once', targetAt: anchor },
      { id: 'schedule-2', kind: 'every', prompt: 'loop', targetAt: anchor, everySeconds: 300 },
    ] as const satisfies readonly ScheduleRow[]
    const finished = applyScheduleChange(rows, { operation: 'dispatch', id: 'schedule-1' })
    expect(finished.map(row => row.id)).toEqual(['schedule-2'])
    // acceptedAt 10:00:30 against an 08:00 anchor with a 5m interval: the
    // next target is the first anchor-aligned instant AFTER acceptance
    // (10:05), never anchor+one interval (08:05) and never accepted+interval
    // (10:05:30) — missed occurrences are skipped in one step.
    const rolled = applyScheduleChange(rows, { operation: 'dispatch', id: 'schedule-2', acceptedAt: '2026-09-11T10:00:30Z' })
    expect(rolled.find(row => row.id === 'schedule-2')!.targetAt).toBe(Date.parse('2026-09-11T10:05:00Z'))
  })

  it('nextEveryTarget keeps anchor alignment across gaps and clock skew', () => {
    const anchor = Date.parse('2026-09-11T08:00:00Z')
    const interval = 300_000
    // Exactly on an occurrence boundary counts as missed (strictly after).
    expect(nextEveryTarget(anchor, anchor + interval, 300)).toBe(anchor + 2 * interval)
    // A 2.03-interval gap skips both missed occurrences.
    expect(nextEveryTarget(anchor, anchor + 610_000, 300)).toBe(anchor + 3 * interval)
    // Acceptance BEFORE the previous target (clock skew) steps one interval.
    expect(nextEveryTarget(anchor, anchor - 1_000, 300)).toBe(anchor + interval)
  })

  it('removes deleted ids and ignores unknown ones', () => {
    const rows = [{ id: 'schedule-1', kind: 'at', prompt: 'x', targetAt: 0 }] as const satisfies readonly ScheduleRow[]
    expect(applyScheduleChange(rows, { operation: 'delete', id: 'schedule-1' })).toEqual([])
    expect(applyScheduleChange(rows, { operation: 'delete', id: 'nope' })).toHaveLength(1)
  })
})

describe('schedule projection folds', () => {
  it('maintains the active list live and replays to the same state', () => {
    let view = createTranscriptView()
    view = projectEvent(view, scheduleEvent(EVERY_CREATE, 1))
    view = projectEvent(view, scheduleEvent(AT_CREATE, 2))
    view = projectEvent(view, scheduleEvent(EVERY_DISPATCH, 3))
    expect(view.schedules.map(row => row.id)).toEqual(['schedule-1', 'schedule-2'])
    expect(view.schedules[0].targetAt).toBe(Date.parse('2026-09-11T09:00:00Z') + 3_600_000)
    const acc = createReplayAccumulator()
    replayProjectEvent(acc, scheduleEvent(EVERY_CREATE, 1))
    replayProjectEvent(acc, scheduleEvent(AT_CREATE, 2))
    replayProjectEvent(acc, scheduleEvent(EVERY_DISPATCH, 3))
    expect(finishReplay(acc).schedules).toEqual(view.schedules)
  })

  it('hides time-context snapshots but still spends system tokens', () => {
    let view = createTranscriptView()
    view = projectEvent(view, pluginMessageEvent('time-context', 'snapshot', 'Time sampled while preparing turn 1, step 1: 2026-09-11T09:00:00Z', 1))
    expect(view.entries).toEqual([])
    expect(view.stats.contextSegments.system).toBeGreaterThan(0)
    const acc = createReplayAccumulator()
    replayProjectEvent(acc, pluginMessageEvent('time-context', 'snapshot', 'Time sampled while preparing turn 1, step 1: 2026-09-11T09:00:00Z', 1))
    expect(finishReplay(acc).entries).toEqual([])
  })

  it('renders schedule reminders as full prompts and collapses other plugin context by name', () => {
    let view = createTranscriptView()
    view = projectEvent(view, pluginMessageEvent('schedule', undefined, '[SCHEDULE REMINDER] ship it', 1))
    view = projectEvent(view, pluginMessageEvent('hooks-claude-code', undefined, 'hook context payload', 2))
    expect(view.entries[0]).toMatchObject({ kind: 'user', notice: false, text: '[SCHEDULE REMINDER] ship it' })
    expect(view.entries[1]).toMatchObject({ kind: 'user', notice: true, text: 'hooks-claude-code' })
  })
})

describe('schedule panel rows', () => {
  it('labels frequencies and relatives', () => {
    expect(scheduleFrequency({ id: 'a', kind: 'at', prompt: '', targetAt: 0 })).toBe('Once')
    expect(scheduleFrequency({ id: 'a', kind: 'every', prompt: '', targetAt: 0, everySeconds: 1800 })).toBe('Every 30m')
    expect(scheduleRelative(0, 90_000)).toBe('1m overdue')
    expect(scheduleRelative(120_000, 0)).toBe('in 2m')
    expect(scheduleRelative(30_000, 0)).toBe('in <1m')
    expect(scheduleRelative(0, 30_000)).toBe('<1m overdue')
  })

  it('orders overdue rows first with the error tone', () => {
    const rows = [
      { id: 'later', kind: 'at', prompt: 'later', targetAt: 10_000_000 },
      { id: 'overdue', kind: 'at', prompt: 'overdue', targetAt: 0 },
    ] as const satisfies readonly ScheduleRow[]
    const display = scheduleDisplayRows(rows, 5_000)
    expect(display.map(row => row.key)).toEqual(['overdue', 'later'])
    expect(display[0].tone).toBe('error')
  })
})

describe('SchedulePanel layout', () => {
  const wait = async (ms = 120): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  function tty(columns: number, rows: number): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; text: () => string; reset: () => void } {
    let buffer = ''
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns,
      rows,
      write(chunk: string) {
        buffer += chunk
        return true
      },
    }) as unknown as NodeJS.WriteStream
    return { stdin, stdout, text: () => buffer, reset: () => { buffer = '' } }
  }

  const overdue: ScheduleRow = { id: 'schedule-1', kind: 'at', prompt: 'check the build', targetAt: Date.now() - 120_000 }
  const upcoming: ScheduleRow = { id: 'schedule-2', kind: 'every', prompt: 'status round', targetAt: Date.now() + 3_600_000, everySeconds: 3_600 }

  it("lists overdue first, stays inside the height budget, and closes on esc or q", async () => {
    const harness = tty(100, 24)
    let closed = false
    const instance = render(createElement(SchedulePanel, {
      rows: () => [upcoming, overdue],
      close: () => { closed = true },
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    const text = harness.text()
    expect(text).toContain('2 active reminders')
    expect(text).toContain('check the build')
    expect(text).toContain('Every 1h')
    expect(text).toContain('overdue')
    // Overdue row renders first; one fresh frame stays below terminal rows.
    expect(text.indexOf('check the build')).toBeLessThan(text.indexOf('status round'))
    harness.reset()
    harness.stdin.write('q')
    await wait()
    expect(closed).toBe(true)
    instance.unmount()
  })

  it("degrades to one bounded line on compact terminals", async () => {
    const harness = tty(72, 6)
    const instance = render(createElement(SchedulePanel, {
      rows: () => [overdue, upcoming],
      close: () => {},
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    const text = harness.text()
    expect(text).toContain('/schedule')
    expect(text).toContain('overdue')
    expect(text.split('\n').length).toBeLessThan(6)
    instance.unmount()
  })

  it("shows the empty state when no reminder is active", async () => {
    const harness = tty(100, 24)
    const instance = render(createElement(SchedulePanel, {
      rows: () => [],
      close: () => {},
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    expect(harness.text()).toContain('no active reminders')
    instance.unmount()
  })
})
