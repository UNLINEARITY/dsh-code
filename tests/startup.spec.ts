import { describe, expect, it } from 'vitest'
import { resolveTuiStartup } from '../src/startup.ts'

describe('TUI startup modes', () => {
  it('allows --mode only for fresh or explicitly named sessions', () => {
    expect(resolveTuiStartup({ mode: 'minimal' })).toEqual({ kind: 'fresh', mode: 'minimal' })
    expect(resolveTuiStartup({ session: 'named', mode: 'code' })).toEqual({ kind: 'named', sessionId: 'named', mode: 'code' })
    expect(() => resolveTuiStartup({ resume: 'abc', mode: 'code' })).toThrow('only to a new session')
    expect(() => resolveTuiStartup({ continue: true, mode: 'code' })).toThrow('only to a new session')
  })

  it('preserves resume exclusivity', () => {
    expect(resolveTuiStartup({ resume: 'abc' })).toEqual({ kind: 'resume', sessionId: 'abc' })
    expect(resolveTuiStartup({ continue: true })).toEqual({ kind: 'latest' })
    expect(() => resolveTuiStartup({ resume: 'abc', session: 'other' })).toThrow('mutually exclusive')
  })
})
