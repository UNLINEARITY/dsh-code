/** Profile patch reads and atomic writes for the /hooks and /lsp wizards. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProfilePatchShapeError,
  readProfilePatch,
  upsertLspServers,
  upsertProfileRow,
  writeProfilePatch,
  type ProfilePatchRow,
} from '../src/runner/profile-patch.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function patchFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'profile-patch-'))
  dirs.push(dir)
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, text)
  return path
}

describe('readProfilePatch', () => {
  it('treats a missing or empty file as an empty layer', () => {
    expect(readProfilePatch(join(tmpdir(), 'definitely-missing.yml'))).toEqual([])
    expect(readProfilePatch(patchFile(''))).toEqual([])
  })

  it('refuses a non-array or unparsable file instead of rewriting it', () => {
    expect(() => readProfilePatch(patchFile('id: not-an-array'))).toThrow(ProfilePatchShapeError)
    expect(() => readProfilePatch(patchFile('- [broken'))).toThrow(ProfilePatchShapeError)
  })
})

describe('upsertProfileRow', () => {
  it('appends a new row and replaces an existing id in place', () => {
    const rows: ProfilePatchRow[] = [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }]
    expect(upsertProfileRow(rows, { id: 'c', name: 'z' })).toHaveLength(3)
    const next = upsertProfileRow(rows, { id: 'b', name: 'y2', config: { configPath: './hooks.json' } })
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ id: 'b', name: 'y2', config: { configPath: './hooks.json' } })
  })
})

describe('upsertLspServers', () => {
  it('creates the three rows with the server map, then merges by extension', () => {
    const first = upsertLspServers([], [{ extension: '.ts', language: 'typescript', command: 'tsserver' }])
    expect(first.map(row => row.id)).toEqual(['lsp-stdio', 'lsp', 'tool-lsp'])
    const servers = (first[0]?.config?.servers ?? {}) as Record<string, { command: string; extensionToLanguage: Record<string, string> }>
    expect(servers['.ts']).toMatchObject({ command: 'tsserver', extensionToLanguage: { '.ts': 'typescript' } })
    const merged = upsertLspServers(first, [{ extension: '.ts', language: 'typescript', command: 'tsserver2' }, { extension: '.py', language: 'python', command: 'pylsp' }])
    const nextServers = (merged[0]?.config?.servers ?? {}) as Record<string, { command: string }>
    expect(nextServers['.ts']).toMatchObject({ command: 'tsserver2' })
    expect(nextServers['.py']).toMatchObject({ command: 'pylsp' })
    expect(merged).toHaveLength(3)
  })
})

describe('writeProfilePatch', () => {
  it('round-trips rows, leaves a timestamped backup, and never keeps the tmp file', () => {
    const path = patchFile('- id: a\n  name: x\n')
    const next = upsertProfileRow(readProfilePatch(path), { id: 'hooks-claude-code', name: '@deepseek-ai/dsh-hooks-claude-code', config: { configPath: './hooks.json' } })
    writeProfilePatch(path, [...next])
    const reread = readProfilePatch(path)
    expect(reread).toHaveLength(2)
    expect(reread[1]).toMatchObject({ id: 'hooks-claude-code', config: { configPath: './hooks.json' } })
    const siblings = readdirSync(join(path, '..'))
    expect(siblings.some(name => name.startsWith('cordis.patch.yml.bak-'))).toBe(true)
    expect(siblings.includes('cordis.patch.yml.tmp')).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('- id: a')
  })
})

describe('removeLspServers', () => {
  it('keeps the rows enabled with the remaining map, and disables them when the last server leaves', async () => {
    const { removeLspServers } = await import('../src/runner/profile-patch.ts')
    const configured = upsertLspServers([], [
      { extension: '.ts', language: 'typescript', command: 'tsserver' },
      { extension: '.py', language: 'python', command: 'pylsp' },
    ])
    const kept = removeLspServers(configured, ['.ts'])
    const servers = kept[0]?.config?.servers ?? {}
    expect(Object.keys(servers)).toEqual(['.py'])
    expect(kept.map(row => row.disabled)).toEqual([undefined, undefined, undefined])
    const emptied = removeLspServers(kept, ['.py'])
    expect(emptied.every(row => row.disabled === true)).toBe(true)
    expect(emptied[0]?.config?.servers ?? {}).toEqual({})
  })
})
