import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findRuntimeRoot, inspectRuntimeDependencies, repairRuntimeDependencies, securityOverridePlan } from '../bin/runtime-deps.mjs'

const roots: string[] = []
function fixture(safe = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-deps-test-')))
  roots.push(root)
  const put = (name: string, version: string, base = root): void => {
    const dir = join(base, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.4' }))
  for (const owner of ['dsh-llm', 'dsh-web-fetch-http', 'dsh-http-proxy', 'dsh-mcp-client']) put('@deepseek-ai/' + owner, '0.2.1-rc.4')
  const upgrade = (): void => {
    put('zod', '4.6.6')
    put('undici', '8.12.2')
    put('@modelcontextprotocol/client', '2.3.0')
  }
  if (safe) upgrade()
  else {
    put('zod', '4.4.3')
    put('undici', '8.11.2')
    put('@modelcontextprotocol/client', '2.2.0')
  }
  return { root, put, upgrade }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('installed host dependency repair', () => {
  it('preserves the host identity and custom overrides, refusing conflicting rules', () => {
    const host = { name: '@deepseek-ai/dsh', version: '0.2.1-rc.4', overrides: { other: '1.0.0' } }
    expect(securityOverridePlan(host)).toMatchObject({ ...host, overrides: { other: '1.0.0', 'zod@4.4.3': '4.6.6' } })
    expect(host.overrides).toEqual({ other: '1.0.0' })
    expect(securityOverridePlan({ ...host, allowScripts: { koffi: false } })).toMatchObject({ allowScripts: { koffi: false, 'node-pty': true } })
    expect(() => securityOverridePlan({ name: 'unrelated' })).toThrow('requires an @deepseek-ai/dsh')
    expect(() => securityOverridePlan({ ...host, overrides: { 'zod@4.4.3': 'file:custom' } })).toThrow('conflicting')
  })

  it('identifies the host owning the first executable on PATH', () => {
    const { root } = fixture()
    const bin = join(root, 'lib')
    mkdirSync(bin)
    writeFileSync(join(bin, 'dsh'), '')
    expect(findRuntimeRoot('dsh', bin)).toBe(root)
  })

  it('detects a vulnerable nested copy even when the top-level copy is patched', () => {
    const { root, put } = fixture(true)
    put('zod', '4.4.3', join(root, 'node_modules', '@deepseek-ai/dsh-llm'))
    const rows = inspectRuntimeDependencies(root)
    expect(rows.find(row => row.dependency === 'zod')).toMatchObject({ version: '4.4.3', safe: false })
    expect(rows.filter(row => row.dependency === 'undici').every(row => row.safe)).toBe(true)
  })

  it('backs up metadata before installation and verifies active copies before auditing', () => {
    const { root, upgrade, put } = fixture()
    const nested = join(root, 'node_modules', '@deepseek-ai/dsh-llm', 'node_modules', 'zod')
    put('zod', '4.4.3', join(root, 'node_modules', '@deepseek-ai/dsh-llm'))
    const original = readFileSync(join(root, 'package.json'), 'utf8')
    writeFileSync(join(root, 'package-lock.json'), 'original lock')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: string[][] = []
    const result = repairRuntimeDependencies({ root, npm: { command: 'node', args: ['npm-cli.js'] }, backupBase: join(root, 'backups'), run: (_command, args) => {
      calls.push(args)
      if (args.includes('install')) {
        rmSync(nested, { recursive: true })
        upgrade()
      }
      return { status: 0 }
    } })
    expect(readFileSync(join(result.backup!, 'package.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(result.backup!, 'package-lock.json'), 'utf8')).toBe('original lock')
    expect(result.rows.every(row => row.safe)).toBe(true)
    expect(calls.map(args => args[1])).toEqual(['install', 'audit'])
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('0.2.1-rc.4')
  })

  it('makes check mode read-only and skips installation on a repaired host', () => {
    const { root } = fixture(true)
    const path = join(root, 'package.json')
    writeFileSync(path, JSON.stringify(securityOverridePlan(JSON.parse(readFileSync(path, 'utf8')))))
    const original = readFileSync(path, 'utf8')
    const run = vi.fn((_command: string, _args: string[]) => ({ status: 0 }))
    repairRuntimeDependencies({ root, npm: { command: 'npm', args: [] }, run, check: true })
    expect(run).not.toHaveBeenCalled()
    repairRuntimeDependencies({ root, npm: { command: 'npm', args: [] }, run })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toContain('audit')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('does not report success after failed installation or an incomplete replacement', () => {
    const { root } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const options = { root, npm: { command: 'npm', args: [] }, backupBase: join(root, 'backups') }
    expect(() => repairRuntimeDependencies({ ...options, run: () => ({ status: 1 }) })).toThrow('install failed')
    expect(() => repairRuntimeDependencies({ ...options, run: () => ({ status: 0 }) })).toThrow('did not replace')
  })
})
