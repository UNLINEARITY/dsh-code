/**
 * Runner boundary contract: the plugin entry's gate, startup wiring, the
 * missing-appExit refusal, and the fail-fast error boundary around `run`.
 *
 * These exercise `apply` with an inert context, so the runner's service
 * preconditions and its failure reporting are pinned without composing a
 * real Agent.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'
import { internals } from '../src/internals.ts'

/** An inert context answering `get` from one table. */
function contextWith(services: Record<string, unknown>): Context {
  // The stub deliberately implements only `get`, so the double cast keeps
  // the 50+-member Context contract out of the fixture.
  return { get: (name: string) => services[name] } as unknown as Context
}

const config = (kind = 'fresh'): Config => ({ startup: { kind } })

/** Capture the runner's stderr and exit path through the injectable seam. */
function captureRunnerEffects(): { stderr: string[]; exits: number[]; restore(): void } {
  const stderr: string[] = []
  const exits: number[] = []
  const original = internals.stderr
  internals.stderr = { write: chunk => stderr.push(String(chunk)) }
  return {
    stderr,
    exits,
    restore: () => {
      internals.stderr = original
    },
  }
}

describe('apply', () => {
  it('refuses to mount when the launcher provides no ctx.appExit', () => {
    // The harness gate passes first (vitest's own binary is not a host
    // package, so the probe stays silent), then the exit precondition fires.
    const ctx = contextWith({
      loader: { await: async () => {} },
      agents: undefined,
    })
    expect(() => apply(ctx, config())).toThrow(/launcher must provide ctx\.appExit/u)
  })

  it('returns quietly when the core services are absent', async () => {
    const effects = captureRunnerEffects()
    const ctx = contextWith({
      loader: { await: async () => {} },
      appExit: (code: number) => effects.exits.push(code),
      // agents/defaultModel/sessions undefined: run returns before composing.
    })
    try {
      expect(() => apply(ctx, config())).not.toThrow()
      // The runner runs detached; let its early return settle.
      await new Promise(resolve => setImmediate(resolve))
      expect(effects.stderr).toEqual([])
      expect(effects.exits).toEqual([])
    } finally {
      effects.restore()
    }
  })

  it('reports a missing preset service through stderr and requests exit 1', async () => {
    const effects = captureRunnerEffects()
    const ctx = contextWith({
      loader: { await: async () => {} },
      agents: {},
      agentDefaultModel: {},
      sessions: {},
      // agentPresets absent: the runner must refuse to compose.
      appExit: (code: number) => effects.exits.push(code),
    })
    try {
      expect(() => apply(ctx, config())).not.toThrow()
      await vi.waitFor(() => {
        expect(effects.exits).toEqual([1])
      })
      expect(effects.stderr).toHaveLength(1)
      expect(effects.stderr[0]).toMatch(/^dsh: agent preset service is unavailable/u)
      expect(effects.stderr[0]).toMatch(/\n$/u)
    } finally {
      effects.restore()
    }
  })

  it('maps the config row onto the startup before the service preconditions', async () => {
    // A resume row reaches the preset precondition (the earliest observable
    // service refusal), proving the narrowing ran inside apply.
    const effects = captureRunnerEffects()
    const ctx = contextWith({
      loader: { await: async () => {} },
      agents: {},
      agentDefaultModel: {},
      sessions: {},
      appExit: (code: number) => effects.exits.push(code),
    })
    try {
      expect(() => apply(ctx, config('resume'))).not.toThrow()
      await vi.waitFor(() => {
        expect(effects.exits).toEqual([1])
      })
    } finally {
      effects.restore()
    }
  })
})
