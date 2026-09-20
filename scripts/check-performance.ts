/**
 * Coarse, cross-platform performance guard for the CLI's hottest pure paths.
 * Budgets are intentionally much wider than a developer-machine baseline:
 * they catch algorithmic regressions without turning scheduler noise into a
 * release failure. Real TTY behavior remains covered by the Ink regressions.
 */

import { performance } from 'node:perf_hooks'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { computeSettledRows } from '../src/app.ts'
import { settledEntryCount } from '../src/render/projection.ts'
import { createTranscriptStore } from '../src/session/store.ts'

interface Measurement {
  readonly name: string
  readonly valueMs: number
  readonly budgetMs: number
}

function sessionEvents(entryCount: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < entryCount; index += 1) {
    const seq = index + 1
    if (index % 2 === 0) {
      events.push({
        type: 'user/message',
        seq,
        time: seq,
        data: {
          id: `user-${index}`,
          content: [{ type: 'text', text: `prompt ${index}` }],
          source: { kind: 'user' },
        },
      } as unknown as SessionEvent)
    } else {
      events.push({
        type: 'assistant/message',
        seq,
        time: seq,
        data: {
          turn: Math.ceil(index / 2),
          step: 1,
          message: {
            id: `assistant-${index}`,
            content: [{ type: 'text', text: `answer ${index} with **markdown** and 中文` }],
            source: { provider: 'benchmark', model: 'benchmark' },
          },
        },
      } as unknown as SessionEvent)
    }
  }
  return events
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.floor(ordered.length / 2)] ?? 0
}

function percentile(samples: readonly number[], ratio: number): number {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? 0
}

function measure(name: string, budgetMs: number, runs: number, operation: () => void): Measurement {
  const samples: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now()
    operation()
    samples.push(performance.now() - started)
  }
  return { name, valueMs: median(samples), budgetMs }
}

const longLog = sessionEvents(100_000)
let longStore = createTranscriptStore()
const replay = measure('100k event replay', 3_000, 3, () => {
  longStore = createTranscriptStore(longLog)
})

const settledView = createTranscriptStore(sessionEvents(3_000)).getView()
let epoch = 0
const reflow = measure('3k entry settled reflow', 750, 5, () => {
  computeSettledRows(undefined, settledView.entries, settledView.entries.length, false, true, epoch, 120, 3_000)
  epoch += 1
})

let seq = longLog.length + 1
longStore.apply({ type: 'turn/start', seq: seq++, time: seq, data: { turn: 50_001 } } as SessionEvent)
longStore.apply({ type: 'step/start', seq: seq++, time: seq, data: { turn: 50_001, step: 1 } } as SessionEvent)
const attemptId = 'performance-check' as never
longStore.applyStreamFrame({ type: 'start', attemptId, revision: 1, turn: 50_001, step: 1 })
const frameSamples: number[] = []
for (let index = 0; index < 200; index += 1) {
  longStore.applyStreamFrame({
    type: 'chunk',
    attemptId,
    revision: 1,
    index,
    time: seq + index,
    chunk: { type: 'text-delta', index: 0, text: 'x' },
  } as never)
  const started = performance.now()
  settledEntryCount(longStore.getView().entries)
  frameSamples.push(performance.now() - started)
}
const liveFrame: Measurement = {
  name: '100k-history live snapshot p95',
  valueMs: percentile(frameSamples, 0.95),
  budgetMs: 25,
}

const measurements = [replay, reflow, liveFrame]
for (const result of measurements) {
  const state = result.valueMs <= result.budgetMs ? 'PASS' : 'FAIL'
  console.log(`${state} ${result.name}: ${result.valueMs.toFixed(2)}ms / ${result.budgetMs}ms`)
}
const failures = measurements.filter(result => result.valueMs > result.budgetMs)
if (failures.length > 0) {
  throw new Error(`CLI performance budget exceeded: ${failures.map(result => result.name).join(', ')}`)
}
