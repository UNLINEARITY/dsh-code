/** Workspace file scan and mention candidate ranking. */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanWorkspaceFiles } from '../src/mentions.ts'

/** One temporary workspace tree; auto-removed. */
function fixture(entries: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-mentions-'))
  for (const entry of entries) {
    if (entry.endsWith('/')) {
      mkdirSync(join(root, entry.slice(0, -1)), { recursive: true })
    } else {
      mkdirSync(join(root, entry.slice(0, entry.lastIndexOf('/'))), { recursive: true })
      writeFileSync(join(root, entry), '')
    }
  }
  return root
}

describe('scanWorkspaceFiles', () => {
  it('lists files as forward-slash relative paths, sorted', async () => {
    const root = fixture(['src/a.ts', 'src/deep/b.ts', 'README.md'])
    try {
      const files = await scanWorkspaceFiles(root)
      expect(files).toEqual([
        { path: 'README.md', kind: 'file' },
        { path: 'src/a.ts', kind: 'file' },
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
