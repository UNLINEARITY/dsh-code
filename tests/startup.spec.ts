import { describe, expect, it } from 'vitest'
import { apply as applyStartup, resolveTuiStartup } from '../src/startup.ts'
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
    expect(() => resolveTuiStartup({ theme: 'sepia' as ThemeName })).toThrow('--theme must be one of: dark, light, prismatic, rainbow, auto')
    expect(() => resolveTuiStartup({ theme: '' as ThemeName })).toThrow('--theme must be one of: dark, light, prismatic, rainbow, auto')
  })

  it('carries an initial prompt and repeated image paths into every mode', () => {
    expect(resolveTuiStartup({ prompt: '  inspect this  ', images: ['a.png', 'b.jpg'] })).toEqual({
      kind: 'fresh', prompt: 'inspect this', images: ['a.png', 'b.jpg'],
    })
    expect(resolveTuiStartup({ resume: 'abc', prompt: 'continue', images: ['a.png'] })).toEqual({
      kind: 'resume', sessionId: 'abc', prompt: 'continue', images: ['a.png'],
    })
  })
})

describe('startup provider wiring', () => {
  /** A context double carrying the inner command line parseCmdline reads. */
  const startupCtx = (args: readonly string[], provided: Array<[string, unknown]>): never => ({
    provide: (name: string, value: unknown): void => { provided.push([name, value]) },
    get: (name: string): unknown => name === 'cmdlineArgs' ? { get: () => args } : name === 'appExit' ? () => {} : undefined,
  }) as never

  it('apply parses the invocation and publishes the startup service', () => {
    const provided: Array<[string, unknown]> = []
    applyStartup(startupCtx(['--resume', 'abc123', '--theme', 'light', 'fix', 'the', 'build'], provided))
    expect(provided).toHaveLength(1)
    const [name, value] = provided[0]
    expect(name).toBe('tuiStartup')
    expect(value).toEqual({ startup: { kind: 'resume', sessionId: 'abc123', theme: 'light', prompt: 'fix the build' } })
  })

  it('apply publishes only the prompt-less startup for a bare invocation', () => {
    const provided: Array<[string, unknown]> = []
    applyStartup(startupCtx([], provided))
    expect(provided).toHaveLength(1)
    expect(provided[0][1]).toEqual({ startup: { kind: 'fresh' } })
  })
})
