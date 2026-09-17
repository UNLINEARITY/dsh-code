/**
 * Preference files under the DSH home: the shared missing-file-silent versus
 * corrupt-file-warns policy, and the save path that reports a failure instead
 * of rejecting.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { preferencePath, readPreference, savePreference } from '../src/runner/preferences.ts'
import { createUserSettingsPersistence } from '../src/settings-file.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-prefs-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const identity = (raw: unknown): unknown => raw

describe('preferencePath', () => {
  it('resolves every preference file under the DSH home', () => {
    expect(preferencePath('theme.json')).toBe(join(preferencePath(''), 'theme.json'))
    expect(preferencePath('theme.json').endsWith(join('.dsh', 'dsh-code', 'theme.json'))).toBe(true)
  })
})

describe('readPreference', () => {
  it('stays silent for a missing file so the default stands', () => {
    expect(readPreference(join(dir, 'absent.json'), 'theme', identity)).toEqual({})
  })

  it('warns and keeps the default for a non-object document', () => {
    const path = join(dir, 'null.json')
    return writeFile(path, 'null', 'utf8').then(() => {
      const read = readPreference(path, 'theme', identity)
      expect(read.value).toBeUndefined()
      expect(read.warning).toMatch(/must contain a JSON object/u)
    })
  })

  it('warns and keeps the default for unparseable JSON', async () => {
    const path = join(dir, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    const read = readPreference(path, 'theme', identity)
    expect(read.value).toBeUndefined()
    expect(read.warning).toBeTypeOf('string')
  })

  it('parses the named field only, leaving a sibling field invisible', async () => {
    const path = join(dir, 'theme.json')
    await writeFile(path, JSON.stringify({ theme: 'light', stale: true }), 'utf8')
    expect(readPreference(path, 'theme', identity)).toEqual({ value: 'light' })
  })

  it('hands an absent field to the parser so it can supply its own default', async () => {
    const path = join(dir, 'partial.json')
    await writeFile(path, JSON.stringify({ other: 1 }), 'utf8')
    const read = readPreference(path, 'items', raw => raw ?? ['fallback'])
    expect(read.value).toEqual(['fallback'])
    expect(read.warning).toBeUndefined()
  })
})

describe('savePreference', () => {
  it('writes the field as a pretty JSON object with a trailing newline', async () => {
    const path = join(dir, 'theme.json')
    const persistence = createUserSettingsPersistence()
    savePreference(persistence, path, 'theme', 'light', () => {})
    await persistence.flush()
    expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify({ theme: 'light' }, null, 2)}\n`)
  })

  it('routes a failed write to onFailure instead of rejecting', async () => {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'regular file', 'utf8')
    const persistence = createUserSettingsPersistence()
    const messages: string[] = []
    // mkdir under a regular file cannot succeed, so the save must report.
    savePreference(persistence, join(blocker, 'child', 'theme.json'), 'theme', 'light', message => {
      messages.push(message)
    })
    await persistence.flush().catch(() => {})
    expect(messages).toHaveLength(1)
    expect(messages[0]).not.toBe('')
  })
})
