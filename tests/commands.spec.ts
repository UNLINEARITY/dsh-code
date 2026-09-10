/** Slash-command bridge and model directory assembly. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { isSlashLine, submissionPayload, watchCommands } from '../src/commands.ts'
import { loadModelDirectory } from '../src/models.ts'

describe('isSlashLine', () => {
  it('accepts lowercase command names with optional input', () => {
    expect(isSlashLine('/help')).toBe(true)
    expect(isSlashLine('/compact now')).toBe(true)
    expect(isSlashLine('/goal')).toBe(true)
  })

  it('rejects non-commands', () => {
    expect(isSlashLine('hello')).toBe(false)
    expect(isSlashLine('/Hello')).toBe(false)
    expect(isSlashLine('/')).toBe(false)
    expect(isSlashLine('a /help')).toBe(false)
  })
})

describe('submissionPayload', () => {
  it('keeps an ordinary prompt byte-exact, including indentation and trailing space', () => {
    expect(submissionPayload('  if cond:\n    run()')).toBe('  if cond:\n    run()')
    expect(submissionPayload('hello ')).toBe('hello ')
    expect(submissionPayload('\t indent')).toBe('\t indent')
  })

  it('strips only trailing line terminators (the open-paste Enter artifact)', () => {
    expect(submissionPayload('hi\n')).toBe('hi')
    expect(submissionPayload('code\n\n')).toBe('code')
    // Interior blank lines and the leading indent are content and survive.
    expect(submissionPayload('  a\n\n  b\n')).toBe('  a\n\n  b')
  })

  it('normalizes a syntactic slash line so completion trailing spaces still route', () => {
    expect(submissionPayload('/quit ')).toBe('/quit')
    expect(submissionPayload('  /mode fast  ')).toBe('/mode fast')
  })

  it('keeps slash-looking prose raw when it is not a syntactic command', () => {
    // Multiline drafts never parse as slash lines, and a leading '/(' is not
    // a command name — both must reach the model exactly as typed.
    expect(submissionPayload('/* block\ncomment */')).toBe('/* block\ncomment */')
    expect(submissionPayload('/path/to/file tail')).toBe('/path/to/file tail')
  })
})

/** Registry double plus context double feeding {@link watchCommands}. */
function harness(descriptors: readonly CommandDescriptor[]): {
  ctx: Context
  fireChange(): void
} {
  const listeners = new Set<() => void>()
  const registry = {
    // The real registry allocates a fresh array per call (mirrored here): the
    // watcher's identity gate is what keeps React out of update loops.
    list: (_agent: Agent): readonly CommandDescriptor[] => [...descriptors],
  }
  const ctx = {
    get: (name: string): unknown => (name === 'commands' ? registry : undefined),
    on: (event: string, listener: () => void): (() => void) => {
      if (event === 'commands/change') listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as unknown as Context
  return {
    ctx,
    fireChange: () => {
      for (const listener of listeners) listener()
    },
  }
}

describe('watchCommands', () => {
  it('serves the live descriptor list for the owning agent', () => {
    const descriptors: readonly CommandDescriptor[] = [
      { name: 'compact', description: 'shrink history' },
      { name: 'goal', description: 'manage the goal' },
    ]
    const { ctx } = harness(descriptors)
    const view = watchCommands(ctx)
    view.setAgent({ id: 'a' } as unknown as Agent)
    expect(view.descriptors).toEqual(descriptors)
  })

  it('refreshes the list on registry change', async () => {
    const descriptors: CommandDescriptor[] = [{ name: 'compact', description: 'shrink history' }]
    const { ctx, fireChange } = harness(descriptors)
    const view = watchCommands(ctx)
    view.setAgent({ id: 'a' } as unknown as Agent)
    const seen: number[] = []
    view.subscribe(() => seen.push(view.descriptors.length))
    descriptors.push({ name: 'goal', description: 'manage the goal' })
    fireChange()
    // Notification is frame-coalesced (setImmediate): same-tick event storms
    // collapse into one repaint.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(view.descriptors).toHaveLength(2)
    expect(seen).toEqual([2])
  })

  it('keeps the array identity and stays silent when the catalog is unchanged', async () => {
    // The host registry returns a FRESH array per list() call and 0.1.5 emits
    // commands/change per scoped register AND dispose; an identity churn per
    // event chained nested React updates past its depth limit. An unchanged
    // catalog must notify nobody.
    const descriptors: CommandDescriptor[] = [{ name: 'compact', description: 'shrink history' }]
    const { ctx, fireChange } = harness(descriptors)
    const view = watchCommands(ctx)
    view.setAgent({ id: 'a' } as unknown as Agent)
    await new Promise<void>(resolve => setImmediate(resolve))
    const before = view.descriptors
    let notified = 0
    view.subscribe(() => { notified += 1 })
    fireChange()
    fireChange()
    fireChange()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(notified).toBe(0)
    expect(view.descriptors).toBe(before)
    // A real content change still swaps the identity and notifies once.
    descriptors.push({ name: 'goal', description: 'manage the goal' })
    fireChange()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(notified).toBe(1)
    expect(view.descriptors).not.toBe(before)
  })

  it('stays empty without a registry service', () => {
    const ctx = { get: (): undefined => undefined, on: (): (() => void) => () => {} } as unknown as Context
    const view = watchCommands(ctx)
    expect(view.descriptors).toEqual([])
  })

  it('keeps the last catalog and reports a synchronous registry failure', () => {
    const descriptors: readonly CommandDescriptor[] = [{ name: 'compact', description: 'shrink history' }]
    const { ctx, fireChange } = harness(descriptors)
    const registry = (ctx as unknown as { get(name: string): unknown }).get('commands') as {
      list(agent: Agent): readonly CommandDescriptor[]
    }
    const view = watchCommands(ctx)
    view.setAgent({ id: 'a' } as unknown as Agent)
    registry.list = () => { throw new Error('registry offline') }
    fireChange()
    expect(view.descriptors).toEqual(descriptors)
    expect(view.error).toBe('registry offline')
  })
})

describe('loadModelDirectory', () => {
  it('flattens providers into rows and records per-provider failures', async () => {
    const llm = {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('endpoint down')
        return [
          { id: 'deepseek-v4-flash', name: 'V4 Flash' },
          { id: 'deepseek-v4', name: 'V4' },
        ]
      },
    }
    const ctx = { get: (name: string): unknown => (name === 'llm' ? llm : undefined) } as unknown as Context
    const directory = await loadModelDirectory(ctx)
    expect(directory.rows).toEqual([
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-flash', modelName: 'V4 Flash' },
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4', modelName: 'V4' },
    ])
    expect(directory.failures).toEqual(['broken'])
  })

  it('returns an empty directory without an llm service', async () => {
    const ctx = { get: (): undefined => undefined } as unknown as Context
    await expect(loadModelDirectory(ctx)).resolves.toEqual({ rows: [], failures: [], reasoningFailures: [] })
  })
})
