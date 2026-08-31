/**
 * User-level settings persistence: submission-order serialization, the
 * temp-file + rename write, and chain survival across a failed save.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserSettingsPersistence } from '../src/settings-file.ts'

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
})
