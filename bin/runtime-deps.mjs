/** Repair the installed host's dependency tree without changing its Harness release. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export const SECURITY_OVERRIDES = Object.freeze({
  'zod@4.4.3': '4.6.6',
  'undici@8.11.2': '8.12.2',
  '@modelcontextprotocol/client@2.2.0': '2.3.0',
  'fflate@0.8.2': '0.8.3',
})

const ROUTES = [
  ['@deepseek-ai/dsh-llm', 'zod', '4.6.6'],
  ['@deepseek-ai/dsh-web-fetch-http', 'undici', '8.12.2'],
  ['@deepseek-ai/dsh-http-proxy', 'undici', '8.12.2'],
  ['@deepseek-ai/dsh-mcp-client', '@modelcontextprotocol/client', '2.3.0'],
  ['@deepseek-ai/libreoffice-kit', 'fflate', '0.8.3'],
]

function manifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageManifest(requireFrom, name) {
  try { return requireFrom.resolve(`${name}/package.json`) } catch {
    let directory = dirname(requireFrom.resolve(name))
    for (;;) {
      const path = join(directory, 'package.json')
      if (existsSync(path) && manifest(path).name === name) return path
      const parent = dirname(directory)
      if (parent === directory) throw new Error(`cannot locate ${name} package metadata`)
      directory = parent
    }
  }
}

/** Resolve the host behind the actual dsh command, including POSIX symlinks and npm Windows shims. */
export function findRuntimeRoot(command = 'dsh', searchPath = process.env.PATH ?? '') {
  for (const directory of searchPath.split(delimiter)) {
    const executable = join(directory, command)
    if (!existsSync(executable)) continue
    let current = dirname(realpathSync(executable))
    for (;;) {
      const path = join(current, 'package.json')
      if (existsSync(path) && manifest(path).name === '@deepseek-ai/dsh') return current
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    // npm's Windows shim sits beside node_modules rather than inside dsh.
    if (process.platform === 'win32') {
      return dirname(packageManifest(createRequire(join(directory, 'package.json')), '@deepseek-ai/dsh'))
    }
    throw new Error(`cannot identify the dsh installation behind ${executable}`)
  }
  throw new Error('dsh is not installed on PATH')
}

/** Preserve unrelated overrides and refuse to replace a user's conflicting rule. */
export function securityOverridePlan(value) {
  if (value.name !== '@deepseek-ai/dsh') throw new Error('dependency repair requires an @deepseek-ai/dsh installation')
  const overrides = { ...value.overrides }
  for (const [selector, version] of Object.entries(SECURITY_OVERRIDES)) {
    const name = selector.slice(0, selector.lastIndexOf('@'))
    if (overrides[name] !== undefined) {
      if (typeof overrides[name] === 'string' && atLeast(overrides[name], version)) continue
      throw new Error(`conflicting dependency override for ${name}; preserve or resolve it before repair`)
    }
    if (overrides[selector] !== undefined && overrides[selector] !== version) {
      throw new Error(`conflicting dependency override for ${selector}; preserve or resolve it before repair`)
    }
    overrides[selector] = version
  }
  const allowScripts = { ...value.allowScripts }
  for (const name of ['@deepseek-ai/dsh-subprocess-local', 'koffi', 'node-pty', '@google/genai', 'protobufjs']) {
    if (allowScripts[name] === undefined) allowScripts[name] = true
  }
  return { ...value, overrides, allowScripts }
}

function atLeast(version, minimum) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) return false
  const actual = version.split('.').map(Number)
  const expected = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== expected[i]) return actual[i] > expected[i]
  }
  return true
}

/** Check what each host service resolves, not a spare top-level dependency copy. */
export function inspectRuntimeDependencies(root) {
  const host = createRequire(join(root, 'package.json'))
  return ROUTES.flatMap(([owner, dependency, minimum]) => {
    let ownerManifest
    try { ownerManifest = packageManifest(host, owner) } catch (error) {
      if (owner === '@deepseek-ai/libreoffice-kit') return []
      throw error
    }
    const path = packageManifest(createRequire(ownerManifest), dependency)
    const version = manifest(path).version
    return [{ owner, dependency, version, minimum, path, safe: atLeast(version, minimum) }]
  })
}

function freshInspection(root) {
  // npm may hoist a formerly nested copy. Node caches require.resolve paths,
  // so the process that inspected the old tree must not verify the new one.
  const source = `import { inspectRuntimeDependencies } from ${JSON.stringify(import.meta.url)}; process.stdout.write(JSON.stringify(inspectRuntimeDependencies(process.argv[1])))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || 'cannot inspect repaired host dependencies')
  return JSON.parse(result.stdout)
}

/** Back up the host metadata, install scoped fixes in place, then verify resolution and audit. */
export function repairRuntimeDependencies({
  root, npm, run = spawnSync, check = false,
  backupBase = join(homedir(), '.dsh', 'backups', 'runtime-deps'),
}) {
  root = realpathSync(root)
  const path = join(root, 'package.json')
  const original = manifest(path)
  const planned = securityOverridePlan(original)
  if (check) {
    const rows = inspectRuntimeDependencies(root)
    if (rows.some(row => !row.safe)) throw new Error('host dependencies need repair; run deepseek repair-deps after closing all dsh sessions')
    return { rows }
  }
  let backup
  const rows = inspectRuntimeDependencies(root)
  if (JSON.stringify(planned) !== JSON.stringify(original) || rows.some(row => !row.safe)) {
    mkdirSync(backupBase, { recursive: true, mode: 0o700 })
    backup = mkdtempSync(join(backupBase, 'host-'))
    for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
      if (existsSync(join(root, name))) copyFileSync(join(root, name), join(backup, name))
    }
    console.log(`dsh-code: dependency metadata backup: ${backup}`)
    writeFileSync(path, JSON.stringify(planned, null, 2) + '\n')
    const result = run(npm.command, [...npm.args, 'install', '--prefix', root, '--omit=dev', '--package-lock=true', '--no-audit', '--no-fund'], { stdio: 'inherit', windowsHide: true })
    if (result.status !== 0) throw new Error(`dependency install failed; metadata backup: ${backup}; rerun deepseek repair-deps before starting dsh`)
  }
  const verified = freshInspection(root)
  if (verified.some(row => !row.safe)) throw new Error('dependency repair did not replace every active host dependency')
  const audit = run(npm.command, [...npm.args, 'audit', '--prefix', root, '--omit=dev', '--audit-level=low'], { stdio: 'inherit', windowsHide: true })
  if (audit.status !== 0) throw new Error('host dependency audit did not pass; inspect the audit output above')
  return { rows: verified, backup }
}
