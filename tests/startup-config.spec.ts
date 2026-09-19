/** Startup narrowing from the loose plugin config row. */

import { describe, expect, it } from 'vitest'
import { resolveStartupConfig, type StartupConfigRow } from '../src/runner/startup-config.ts'

const row = (overrides: Partial<StartupConfigRow> = {}): { startup: StartupConfigRow } => ({
  startup: { kind: 'fresh', ...overrides },
})

describe('resolveStartupConfig', () => {
  it('maps each well-formed kind onto its startup', () => {
    expect(resolveStartupConfig(row({ kind: 'fresh' }))).toEqual({ kind: 'fresh' })
    expect(resolveStartupConfig(row({ kind: 'fresh', mode: 'ptc' }))).toEqual({ kind: 'fresh', mode: 'ptc' })
    expect(resolveStartupConfig(row({ kind: 'latest' }))).toEqual({ kind: 'latest' })
    expect(resolveStartupConfig(row({ kind: 'resume', sessionId: 'abc123' }))).toEqual({
      kind: 'resume',
      sessionId: 'abc123',
    })
    expect(resolveStartupConfig(row({ kind: 'named', sessionId: 'abc123', mode: 'minimal' }))).toEqual({
      kind: 'named',
      sessionId: 'abc123',
      mode: 'minimal',
    })
  })

  it('degrades resume and named to a fresh launch without a session id', () => {
    expect(resolveStartupConfig(row({ kind: 'resume' }))).toEqual({ kind: 'fresh' })
    expect(resolveStartupConfig(row({ kind: 'named', mode: 'ptc' }))).toEqual({ kind: 'fresh', mode: 'ptc' })
  })

  it('narrows an invalid theme string to the dark default instead of dropping it', () => {
    expect(resolveStartupConfig(row({ theme: 'nonsense' }))).toEqual({ kind: 'fresh', theme: 'dark' })
    expect(resolveStartupConfig(row({ theme: 'light' }))).toEqual({ kind: 'fresh', theme: 'light' })
    expect(resolveStartupConfig(row({}))).not.toHaveProperty('theme')
  })

  it('carries the startup prompt and images through onto every kind', () => {
    expect(resolveStartupConfig(row({ kind: 'latest', prompt: 'hi', images: ['a.png', 'b.png'] }))).toEqual({
      kind: 'latest',
      prompt: 'hi',
      images: ['a.png', 'b.png'],
    })
  })

  it('drops mode on the kinds that cannot pre-compose a session', () => {
    // resume resolves an existing session; latest picks the newest one: a
    // mode request cannot apply to either, so it must not survive.
    expect(resolveStartupConfig(row({ kind: 'resume', sessionId: 'abc123', mode: 'ptc' }))).toEqual({
      kind: 'resume',
      sessionId: 'abc123',
    })
    expect(resolveStartupConfig(row({ kind: 'latest', mode: 'ptc' }))).toEqual({ kind: 'latest' })
  })

  it('treats an unknown kind as a fresh launch', () => {
    expect(resolveStartupConfig(row({ kind: 'surprise', mode: 'ptc' }))).toEqual({ kind: 'fresh', mode: 'ptc' })
  })
})
