#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRequire = createRequire(import.meta.url)

/** Arguments required to boot DSH-Code's conventional profile. */
export const profileArgs = (args = []) => ['--profile', 'cli', ...args]

/** The conventional cli profile directory under the DSH home. */
export function cliProfileDir(home = homedir()) {
  return join(home, '.dsh', 'profiles', 'cli')
}

/**
 * Whether the cli profile already mounts dsh-code. A bare profile composes
 * dsh-base alone and keeps the process alive with no TUI runner — the alias
 * must fail loudly with the missing step instead of hanging.
 */
export function profileHasDshCode(profileDir = cliProfileDir(), fileExists = existsSync, readFile = readFileSync) {
  const manifest = join(profileDir, 'package.json')
  if (!fileExists(manifest)) return false
  try {
    const raw = JSON.parse(readFile(manifest, 'utf8'))
    const bundles = raw?.dsh?.profile?.bundles
    const dependencies = raw?.dependencies
    return (Array.isArray(bundles) && bundles.includes('dsh-code'))
      || (typeof dependencies === 'object' && dependencies !== null && 'dsh-code' in dependencies)
  } catch {
    return false
  }
}

/** Npm global-prefix roots that may contain DSH when this launcher is globally linked to a checkout. */
export function globalDshRoots() {
  return [...new Set([
    process.env.npm_config_prefix,
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm'),
    process.env.PREFIX,
  ].filter(Boolean))]
}

/** Resolve the DSH entrypoint without passing user arguments through a Windows shell. */
export function dshCommand(args, {
  platform = process.platform,
  moduleUrl = import.meta.url,
  fileExists = existsSync,
  roots = globalDshRoots(),
  resolvePackage = packageRequire.resolve,
} = {}) {
  if (platform !== 'win32') return { command: 'dsh', args: profileArgs(args) }
  const adjacentEntrypoint = fileURLToPath(new URL('../../@deepseek-ai/dsh/lib/bin.js', moduleUrl))
  if (fileExists(adjacentEntrypoint)) return { command: process.execPath, args: [adjacentEntrypoint, ...profileArgs(args)] }
  for (const root of roots) {
    try {
      const entrypoint = resolvePackage('@deepseek-ai/dsh/lib/bin.js', { paths: [root] })
      return { command: process.execPath, args: [entrypoint, ...profileArgs(args)] }
    } catch {
      // The next configured global prefix may own DSH instead.
    }
  }
  return undefined
}

/** Launch the installed DSH CLI while preserving its exit status and stdio. */
export function launchDsh(
  args = process.argv.slice(2),
  spawnProcess = spawn,
  resolveCommand = dshCommand,
  isProfileReady = profileHasDshCode,
) {
  if (!isProfileReady()) {
    console.error('dsh-code: the cli profile does not mount dsh-code yet. Run: dsh plugin --profile cli add dsh-code')
    process.exitCode = 1
    return undefined
  }
  const command = resolveCommand(args)
  if (command === undefined) {
    console.error('dsh-code: @deepseek-ai/dsh must be installed globally beside dsh-code; run: npm install -g @deepseek-ai/dsh dsh-code')
    process.exitCode = 1
    return undefined
  }
  const child = spawnProcess(command.command, command.args, {
    stdio: 'inherit',
  })

  child.once('error', error => {
    console.error(`dsh-code: could not start dsh: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 0 : 1)
  })
  return child
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && pathToFileURL(realpathSync(resolve(entrypoint))).href === import.meta.url) {
  launchDsh()
}
