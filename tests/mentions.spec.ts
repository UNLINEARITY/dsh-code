/** Workspace file scan, mention candidate ranking, and the detached-callback contract. */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMentions, scanWorkspaceFiles } from '../src/mentions.ts'

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

describe('scanWorkspaceFiles', () => {
  it('lists files and directories as forward-slash relative paths, sorted', async () => {
    const root = fixture(['src/a.ts', 'src/deep/b.ts', 'README.md'])
    try {
      const files = await scanWorkspaceFiles(root)
      expect(files).toEqual([
        { path: 'README.md', kind: 'file' },
        { path: 'src', kind: 'directory' },
        { path: 'src/a.ts', kind: 'file' },
        { path: 'src/deep', kind: 'directory' },
        { path: 'src/deep/b.ts', kind: 'file' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips git, node_modules, build output, and dotfiles', async () => {
    const root = fixture(['.git/config', 'node_modules/x/y.js', 'lib/out.mjs', '.secret', 'keep.ts'])
    try {
      const files = await scanWorkspaceFiles(root)
      expect(files.map(file => file.path)).toEqual(['keep.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('honours abort during the scan', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => `dir/a${index}.ts`)
    const root = fixture(entries)
    try {
      const controller = new AbortController()
      const pending = scanWorkspaceFiles(root, controller.signal)
      controller.abort()
      await expect(pending).resolves.toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never throws on unreadable entries', async () => {
    await expect(scanWorkspaceFiles(join(tmpdir(), 'dsh-code-no-such-dir-9f8e'))).resolves.toEqual([])
  })
})

/** Context double without any optional service: file mentions only. */
function bareContext(): Context {
  return { get: (): undefined => undefined } as unknown as Context
}

const agent = { id: 'a' } as unknown as Agent

describe('createMentions.candidates', () => {
  it('works when the callback is detached from the API object', async () => {
    // The runner hands `mentions.candidates` to the input editor as a bare
    // function; a `this`-bound implementation threw on every @ keystroke and
    // the menu sat at "searching…" forever.
    const root = fixture(['alpha.ts', 'beta.md'])
    try {
      const api = createMentions(bareContext(), agent, root)
      const detached = api.candidates
      await expect(detached('')).resolves.toEqual([
        { label: 'alpha.ts', description: 'File', kind: 'file' },
        { label: 'beta.md', description: 'File', kind: 'file' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists the first path-sorted entries for a bare @ (empty query)', async () => {
    const root = fixture(['zeta.txt', 'alpha.txt', 'mid/beta.txt'])
    try {
      const api = createMentions(bareContext(), agent, root)
      const rows = await api.candidates('')
      expect(rows.map(row => row.label)).toEqual(['alpha.txt', 'mid', 'mid/beta.txt', 'zeta.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ranks by name-exact, then prefix, then path, then subsequence', async () => {
    const root = fixture(['app.ts', 'apps/web.ts', 'src/app/util.ts', 'wrap.ts'])
    try {
      const api = createMentions(bareContext(), agent, root)
      const rows = await api.candidates('app')
      // `src/app` matches the name exactly, `app.ts`/`apps` by name prefix,
      // then paths containing the query; `wrap.ts` matches nothing.
      expect(rows.map(row => row.label)).toEqual([
        'src/app',
        'app.ts',
        'apps',
        'apps/web.ts',
        'src/app/util.ts',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns no file rows when nothing matches', async () => {
    const root = fixture(['alpha.ts'])
    try {
      const api = createMentions(bareContext(), agent, root)
      await expect(api.candidates('zzz')).resolves.toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
