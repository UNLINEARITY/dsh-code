#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRequire = createRequire(import.meta.url)
const packageVersion = packageRequire('../package.json').version

/** Arguments required to boot DSH-Code's conventional profile. */
export const profileArgs = (args = []) => ['--profile', 'cli', ...args]

export const OPERATION_COMMANDS = ['setup', 'doctor', 'completion', 'update']

/** Exact first-day package spec used by setup (pnpm delays an unpinned release). */
export const setupBundle = (args = []) => args.includes('--local')
  ? fileURLToPath(new URL('..', import.meta.url))
  : `dsh-code@${packageVersion}`

/** Wrapper-owned operation, or undefined when arguments belong to the TUI. */
export function operationName(args = process.argv.slice(2)) {
  return OPERATION_COMMANDS.includes(args[0]) ? args[0] : undefined
}

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

/** Convert a file URL to a windows-style path even when resolved on a non-windows host. */
function fileUrlToWindowsPath(url) {
  const pathname = decodeURIComponent(new URL(url).pathname)
  return pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')
}

/** Resolve the DSH entrypoint without passing user arguments through a Windows shell. */
export function rawDshCommand(args, {
  platform = process.platform,
  moduleUrl = import.meta.url,
  fileExists = existsSync,
  roots = globalDshRoots(),
  resolvePackage = packageRequire.resolve,
} = {}) {
  if (platform !== 'win32') return { command: 'dsh', args }
  // fileURLToPath follows the HOST separator; the win32 target needs a
  // windows-style path regardless of where this resolver itself runs.
  const adjacentEntrypoint = fileUrlToWindowsPath(new URL('../../@deepseek-ai/dsh/lib/bin.js', moduleUrl))
  if (fileExists(adjacentEntrypoint)) return { command: process.execPath, args: [adjacentEntrypoint, ...args] }
  for (const root of roots) {
    try {
      const entrypoint = resolvePackage('@deepseek-ai/dsh/lib/bin.js', { paths: [root] })
      return { command: process.execPath, args: [entrypoint, ...args] }
    } catch {
      // The next configured global prefix may own DSH instead.
    }
  }
  return undefined
}

/** Resolve the normal TUI boot command. */
export function dshCommand(args, options = {}) {
  return rawDshCommand(profileArgs(args), options)
}

/** Static shell completion for wrapper commands and the TUI's local flags. */
export function completionScript(shell) {
  const words = 'setup doctor completion update --help --version --resume --continue --session --mode --theme --image'
  if (shell === 'bash') return `_deepseek_complete() { COMPREPLY=( $(compgen -W "${words}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _deepseek_complete deepseek dsh-code`
  if (shell === 'zsh') return `#compdef deepseek dsh-code\n_arguments '1:command:(${words})'`
  if (shell === 'powershell' || shell === 'pwsh') return `Register-ArgumentCompleter -Native -CommandName deepseek,dsh-code -ScriptBlock { param($wordToComplete) '${words}'.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }`
  throw new Error('completion needs one shell: bash, zsh, or powershell')
}

function printDoctor(resolveCommand = rawDshCommand, spawnCommand = spawnSync) {
  const checks = []
  const [major, minor] = process.versions.node.split('.').map(Number)
  checks.push({ ok: major > 22 || (major === 22 && minor >= 19), label: `Node ${process.versions.node}`, detail: 'requires ^22.19 or >=24' })
  const command = resolveCommand(['--profile', 'cli', '--dump-config'])
  checks.push({ ok: command !== undefined, label: '@deepseek-ai/dsh', detail: command === undefined ? 'not found beside dsh-code' : 'entrypoint resolved' })
  checks.push({ ok: profileHasDshCode(), label: 'cli profile', detail: cliProfileDir() })
  if (command !== undefined && profileHasDshCode()) {
    const probe = spawnCommand(command.command, command.args, { encoding: 'utf8', windowsHide: true })
    const output = String(probe.stdout ?? '')
    checks.push({ ok: probe.status === 0 && output.includes('dsh-code'), label: 'composition', detail: probe.status === 0 ? 'dump-config contains dsh-code' : String(probe.stderr ?? '').trim() })
  }
  for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'fail'} ${check.label} - ${check.detail}`)
  process.exitCode = checks.every(check => check.ok) ? 0 : 1
}

function launchChild(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' })
  child.once('error', error => {
    console.error(`dsh-code: command failed: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === null ? 0 : 1) })
  return child
}

/** Run one wrapper-owned operational command. */
export function launchOperation(args = process.argv.slice(2)) {
  const operation = operationName(args)
  if (operation === undefined) return undefined
  if (operation === 'completion') {
    try {
      console.log(completionScript(args[1]))
    } catch (error) {
      console.error(`dsh-code: ${error.message}`)
      process.exitCode = 1
    }
    return true
  }
  if (operation === 'doctor') {
    printDoctor()
    return true
  }
  if (operation === 'setup') {
    // pnpm deliberately delays unpinned packages during their first 24 hours.
    // Setup must mount the exact globally installed release on launch day.
    const command = rawDshCommand(['plugin', '--profile', 'cli', 'add', setupBundle(args)])
    if (command === undefined) {
      console.error('dsh-code: @deepseek-ai/dsh is not installed; run: npm install -g @deepseek-ai/dsh dsh-code')
      process.exitCode = 1
      return true
    }
    return launchChild(command.command, command.args)
  }
  if (args.includes('--apply')) {
    return launchChild(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', '@deepseek-ai/dsh', 'dsh-code'])
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const name of ['@deepseek-ai/dsh', 'dsh-code']) {
    const result = spawnSync(npm, ['view', name, 'version'], { encoding: 'utf8', windowsHide: true })
    console.log(`${name}: ${result.status === 0 ? String(result.stdout).trim() : 'version check failed'}`)
  }
  console.log('Run `deepseek update --apply` to install the latest versions.')
  return true
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
  if (operationName() === undefined) launchDsh()
  else launchOperation()
}
