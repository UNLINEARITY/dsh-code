/** @mention candidates over the fileReferences service, the pre-session official-search fallback, and the detached-callback contract. */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionReferenceCandidate } from '@deepseek-ai/dsh-session-reference'
import { createMentions } from '../src/mentions.ts'

/** One temporary workspace tree; auto-removed. */
function fixture(entries: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-mentions-'))
  for (const entry of entries) {
    if (entry.endsWith('/')) {
      mkdirSync(join(root, entry.slice(0, -1)), { recursive: true })
    } else {
      const slash = entry.lastIndexOf('/')
      if (slash >= 0) mkdirSync(join(root, entry.slice(0, slash)), { recursive: true })
      writeFileSync(join(root, entry), '')
    }
  }
  return root
}

/** One path candidate shape the service returns. */
interface ServiceRow {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** Context double exposing a canned `fileReferences.list` (and optionally sessions). */
function serviceContext(
  rows: readonly ServiceRow[] | Error,
  options: { queries?: string[]; sessions?: readonly SessionReferenceCandidate[] } = {},
): Context {
  return {
    get: (name: string): unknown => {
      if (name === 'fileReferences') {
        return {
          list: async (_agent: Agent, query: string): Promise<readonly ServiceRow[]> => {
            options.queries?.push(query)
            if (rows instanceof Error) throw rows
            return rows
          },
        }
      }
      if (name === 'sessionReferenceResolver') {
        return {
          listCandidates: async (): Promise<readonly SessionReferenceCandidate[]> => options.sessions ?? [],
          prepare: async (_agent: unknown, content: unknown) => ({ content, additionalContext: undefined }),
        }
      }
      return undefined
    },
  } as unknown as Context
}

/** Context double without any service. */
function bareContext(): Context {
  return { get: (): undefined => undefined } as unknown as Context
}

const agent = { id: 'a' } as unknown as Agent
const nowhere = join(tmpdir(), 'dsh-code-mentions-no-cwd')

describe('createMentions.candidates (fileReferences service)', () => {
  it('works when the callback is detached from the API object', async () => {
    // The runner hands `mentions.candidates` to the input editor as a bare
    // function; a `this`-bound implementation threw on every @ keystroke and
    // the menu sat at "searching…" forever.
    const api = createMentions(serviceContext([
      { path: 'alpha.ts', kind: 'file' },
      { path: 'src', kind: 'directory' },
    ]), agent, nowhere)
    const detached = api.candidates
    await expect(detached('')).resolves.toEqual([
      { label: 'alpha.ts', description: 'File', kind: 'file', path: join(nowhere, 'alpha.ts') },
      { label: 'src', description: 'Folder', kind: 'directory' },
    ])
  })

  it('passes the trimmed query through and caps the menu at twenty file rows', async () => {
    const queries: string[] = []
    const rows: ServiceRow[] = Array.from({ length: 25 }, (_, index) => ({ path: `f${index}.ts`, kind: 'file' as const }))
    const api = createMentions(serviceContext(rows, { queries }), agent, nowhere)
    const menu = await api.candidates('  app  ')
    expect(queries).toEqual(['app'])
    expect(menu).toHaveLength(20)
    expect(menu[0]).toEqual({ label: 'f0.ts', description: 'File', kind: 'file', path: join(nowhere, 'f0.ts') })
  })

  it('returns empty file rows without the service (agent present) or on service failure', async () => {
    await expect(createMentions(bareContext(), agent, nowhere).candidates('app')).resolves.toEqual([])
    await expect(createMentions(serviceContext(new Error('index unavailable')), agent, nowhere).candidates('app')).resolves.toEqual([])
  })

  it('falls back to the official search over the launch cwd before any session exists', async () => {
    // The service is agent-scoped, but @ file completion is session-
    // independent: with no agent yet the SAME official WorkspaceFileSearch
    // runs against the launch cwd — even when the service is mounted (its
    // list() never runs without an agent) and when it is absent.
    const root = fixture(['alpha.ts', 'nested/beta.md'])
    try {
      for (const ctx of [serviceContext([{ path: 'decoy.ts', kind: 'file' }]), bareContext()]) {
        const rows = await createMentions(ctx, undefined, root).candidates('alpha')
        expect(rows.map(row => row.label)).toContain('alpha.ts')
        expect(rows.map(row => row.label)).not.toContain('decoy.ts')
        for (const row of rows) {
          expect(['file', 'directory']).toContain(row.kind)
        }
      }
      // A bare @ lists default rows too — the menu is live before typing.
      const bare = await createMentions(bareContext(), undefined, root).candidates('')
      expect(bare.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('places session rows after file rows once a needle is typed', async () => {
    const sessions: readonly SessionReferenceCandidate[] = [{
      sessionId: 'session-1234' as never,
      label: 'prior work',
      cwd: '/repo',
    } as unknown as SessionReferenceCandidate]
    const api = createMentions(serviceContext(
      [{ path: 'app.ts', kind: 'file' }],
      { sessions },
    ), agent, nowhere)
    const rows = await api.candidates('app')
    expect(rows.map(row => row.kind)).toEqual(['file', 'session'])
    expect(rows[1]!.description).toBe('Session · /repo')
    // A bare `@` never queries sessions.
    await expect(createMentions(serviceContext([], { sessions }), agent, nowhere).candidates('')).resolves.toEqual([])
  })
})
