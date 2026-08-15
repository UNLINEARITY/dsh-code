import { describe, expect, it } from 'vitest'
import { resolveTuiStartup } from '../src/startup.ts'
import type { ThemeName } from '../src/theme.ts'

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

  it('carries --theme into every startup mode', () => {
    expect(resolveTuiStartup({ theme: 'light' })).toEqual({ kind: 'fresh', theme: 'light' })
    expect(resolveTuiStartup({ session: 'named', mode: 'code', theme: 'auto' })).toEqual({
      kind: 'named', sessionId: 'named', mode: 'code', theme: 'auto',
    })
    expect(resolveTuiStartup({ resume: 'abc', theme: 'light' })).toEqual({ kind: 'resume', sessionId: 'abc', theme: 'light' })
    expect(resolveTuiStartup({ continue: true, theme: 'dark' })).toEqual({ kind: 'latest', theme: 'dark' })
  })

  it('rejects unknown --theme values', () => {
    expect(() => resolveTuiStartup({ theme: 'sepia' as ThemeName })).toThrow('--theme must be dark, light, or auto')
    expect(() => resolveTuiStartup({ theme: '' as ThemeName })).toThrow('--theme must be dark, light, or auto')
  })
})
