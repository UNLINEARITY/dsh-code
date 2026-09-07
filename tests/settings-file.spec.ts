/**
 * User-level settings persistence: submission-order serialization, the
 * temp-file + rename write, and chain survival across a failed save.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserSettingsPersistence, writeFileAtomically } from '../src/settings-file.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createUserSettingsPersistence', () => {
  it('lands overlapping saves in submission order: the last snapshot wins', async () => {
    const path = join(dir, 'statusline.json')
    const persistence = createUserSettingsPersistence()
    // A large first snapshot versus a tiny second one: unserialized writes
    // would let the slow first rename land last and win with stale content.
    void persistence.save(path, JSON.stringify({ items: ['x'.repeat(1_000_000)] }))
    await persistence.save(path, '{"items":["b"]}')
    await persistence.flush()
    expect(await readFile(path, 'utf8')).toBe('{"items":["b"]}')
  })

  it('keeps concurrent saves from independent instances off one temp file', async () => {
    const path = join(dir, 'race.json')
    const a = createUserSettingsPersistence()
    const b = createUserSettingsPersistence()
    const snapshotA = JSON.stringify({ who: 'a', pad: 'a'.repeat(64) })
    const snapshotB = JSON.stringify({ who: 'b', pad: 'b'.repeat(64) })
    const saves = await Promise.allSettled([
      a.save(path, snapshotA),
      b.save(path, snapshotB),
    ])
    // Two terminals writing one user file: both saves must settle, and
    // the file must hold one of the two complete snapshots — never a
    // consumed temp file (ENOENT) or a mixed document.
    // Statuses carry rejection reasons so a rare transient failure
    // reports its errno instead of a bare fulfilled/rejected diff.
    const statuses = saves.map(result => result.status === 'fulfilled'
      ? 'fulfilled'
      : `rejected: ${result.reason instanceof Error ? String(result.reason.code ?? result.reason.message) : String(result.reason)}`)
    expect(statuses).toEqual(['fulfilled', 'fulfilled'])
    const content = await readFile(path, 'utf8')
    expect([snapshotA, snapshotB]).toContain(content)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('creates missing parent directories and leaves no temp file behind', async () => {
    const path = join(dir, 'nested', 'deeper', 'theme.json')
    const persistence = createUserSettingsPersistence()
    await persistence.save(path, '{"theme":"light"}\n')
    await persistence.flush()
    expect(await readFile(path, 'utf8')).toBe('{"theme":"light"}\n')
    expect((await readdir(join(dir, 'nested', 'deeper'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('reports the failed save to its caller and keeps the chain usable', async () => {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'regular file', 'utf8')
    // mkdir under a regular file fails (ENOTDIR/ENOTDIR-equivalent).
    const impossible = join(blocker, 'child', 'settings.json')
    const good = join(dir, 'good.json')
    const persistence = createUserSettingsPersistence()
    await expect(persistence.save(impossible, '{}')).rejects.toThrow()
    await persistence.save(good, '{"ok":true}')
    await persistence.flush()
    expect(await readFile(good, 'utf8')).toBe('{"ok":true}')
  })

  it('flush waits for a write that was queued a moment earlier', async () => {
    const path = join(dir, 'immediate.json')
    const persistence = createUserSettingsPersistence()
    const queued = persistence.save(path, 'x')
    await persistence.flush()
    await queued
    expect(await readFile(path, 'utf8')).toBe('x')
  })

  it('writes a file atomically through its own export, leaving no temp behind', async () => {
    const path = join(dir, 'solo', 'atomic.json')
    await writeFileAtomically(path, '{"ok":true}\n')
    expect(await readFile(path, 'utf8')).toBe('{"ok":true}\n')
    expect((await readdir(join(dir, 'solo'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
