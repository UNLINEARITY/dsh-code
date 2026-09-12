#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRequire = createRequire(import.meta.url)
/** This launcher's release version (exported for probes and tests). */
export const packageVersion = packageRequire('../package.json').version

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

/** The dsh-code dependency the cli profile declares (e.g. '1.0.5' or 'link:C:/repo'). */
export function profileDependencySpec(profileDir = cliProfileDir(), fileExists = existsSync, readFile = readFileSync) {
  const manifest = join(profileDir, 'package.json')
  if (!fileExists(manifest)) return undefined
  try {
    const raw = JSON.parse(readFile(manifest, 'utf8'))
    const spec = raw?.dependencies?.['dsh-code']
    return typeof spec === 'string' ? spec : undefined
  } catch {
    return undefined
  }
}

/** The dsh-code version the cli profile actually resolves and boots. */
export function profileMountedVersion(profileDir = cliProfileDir(), fileExists = existsSync, readFile = readFileSync) {
  const manifest = join(profileDir, 'node_modules', 'dsh-code', 'package.json')
  if (!fileExists(manifest)) return undefined
  try {
    return JSON.parse(readFile(manifest, 'utf8'))?.version ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Profile-installed harness plugins that a line upgrade must carry along:
 * every `@deepseek-ai/dsh-*` dependency except the dsh-code target itself
 * and local checkouts (`link:`/`file:` stay untouched). Users install these
 * through `dsh plugin add` once; without this pass `update --apply` would
 * move the host and dsh-code forward and silently leave every other plugin
 * pinned to the old line.
 * @param profileDir - the cli profile root.
 * @returns dependency entries as `{ name, spec }` in manifest order.
 */
export function profilePluginDependencies(profileDir = cliProfileDir(), fileExists = existsSync, readFile = readFileSync) {
  const manifest = join(profileDir, 'package.json')
  if (!fileExists(manifest)) return []
  let dependencies
  try {
    dependencies = JSON.parse(readFile(manifest, 'utf8'))?.dependencies
  } catch {
    return []
  }
  if (typeof dependencies !== 'object' || dependencies === null) return []
  const plugins = []
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (name === 'dsh-code' || name === '@deepseek-ai/dsh-base') continue
    if (/^(link|file):/iu.test(spec)) continue
    plugins.push({ name, spec })
  }
  return plugins
}

/** The harness release line a dsh-code release expects, read from its peers. */
export function harnessLineFromPeers(peers) {
  if (typeof peers !== 'object' || peers === null) return undefined
  const anchor = peers['@deepseek-ai/dsh-session']
  if (typeof anchor === 'string' && anchor !== '') return anchor
  for (const [name, spec] of Object.entries(peers)) {
    if (name.startsWith('@deepseek-ai/dsh-') && typeof spec === 'string' && spec !== '') return spec
  }
  return undefined
}

/**
 * The exact global install that pairs with this launcher: the harness line
 * its own package declares in peers, and its own release. The guidance a
 * missing host prints must not send the user to an unpinned `dsh-code`,
 * which could mount a newer bundle beside this older wrapper.
 */
export function selfInstallHint(options = {}) {
  const version = options.version ?? packageVersion
  // An explicitly passed peers value — including undefined, the "no peers
  // were readable" case — must win over this launcher's own manifest, which
  // a destructuring default would conflate with the argument being absent.
  const peers = 'peers' in options ? options.peers : packageRequire('../package.json').peerDependencies
  const line = harnessLineFromPeers(peers)
  return `npm install -g @deepseek-ai/dsh${line === undefined ? '' : `@${line}`} dsh-code@${version}`
}

/**
 * Refusal reason when a local-checkout profile would pair an older local
 * build with the newer global host this upgrade installs, or undefined when
 * the upgrade may proceed (no checkout mounted, or the checkout already
 * matches the release). The caller prints the lines verbatim.
 */
export function localCheckoutRefusal(mounted, latestCode, codeSpec) {
  if (mounted === undefined || mounted === latestCode) return undefined
  return [
    `dsh-code: the cli profile mounts a local checkout of dsh-code ${mounted}, while this upgrade would install ${latestCode} globally`,
    'dsh-code: upgrading the host beside an older local checkout pairs incompatible code; refusing to install',
    'dsh-code: update the checkout first (git pull, pnpm install, pnpm build), or switch the profile to the published package:',
    `dsh-code:   dsh plugin --profile cli remove dsh-code && dsh plugin --profile cli add ${codeSpec}`,
  ]
}

/**
 * Decide what `update --apply` installs. The global DSH launcher is pinned
 * to the harness line the target dsh-code release declares in its peers,
 * so the launcher can never move ahead of the plugin it must boot. A
 * profile that mounts a local checkout (link:/file:) keeps its mount.
 */
export function updatePlan({ latestCode, peers, profileSpec, profilePlugins = [] }) {
  const line = harnessLineFromPeers(peers)
  const profileStep = !(typeof profileSpec === 'string' && /^(link|file):/iu.test(profileSpec))
  return {
    dshSpec: line === undefined ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${line}`,
    line: line === undefined ? undefined : line,
    lineLocked: line !== undefined,
    codeSpec: `dsh-code@${latestCode}`,
    profileStep,
    // Companion plugins the profile installed through `dsh plugin add`:
    // carried to the same line so one command moves the whole profile.
    pluginSpecs: line === undefined || !profileStep ? [] : profilePlugins
      .filter(plugin => plugin.spec !== line)
      .map(plugin => `${plugin.name}@${line}`),
  }
}

/**
 * The concrete steps `update --apply` runs. The host install and the
 * dsh-code mount are fatal: a failure there strands the global host and the
 * profile bundle on different release lines, so the sequence stops. The
 * companion plugin carries are best-effort — one plugin without a build on
 * the target line must not strand the rest of the upgrade, so each reports
 * its manual retry command and lets the sequence finish. Unresolvable dsh
 * commands come back as blockers: they are enforced before any step runs,
 * because starting the host install without a working profile step is
 * exactly the half-updated state the fatal marking exists to prevent.
 */
export function updateSteps({ plan, npm = npmInvocation(), resolveCommand = rawDshCommand }) {
  const steps = [{
    command: npm.command,
    args: [...npm.args, 'install', '-g', plan.dshSpec, plan.codeSpec],
    label: 'npm install',
    fatal: true,
    remedy: `npm install -g ${plan.dshSpec} ${plan.codeSpec}`,
  }]
  if (!plan.profileStep) return { steps, blockers: [] }
  const blockers = []
  const codeCommand = resolveCommand(['plugin', '--profile', 'cli', 'add', plan.codeSpec])
  if (codeCommand === undefined) {
    blockers.push('dsh-code: could not resolve the dsh command for the profile update')
  } else {
    steps.push({
      command: codeCommand.command,
      args: codeCommand.args,
      label: 'dsh plugin add',
      fatal: true,
      remedy: `dsh plugin --profile cli add ${plan.codeSpec}`,
    })
  }
  for (const pluginSpec of plan.pluginSpecs) {
    const pluginCommand = resolveCommand(['plugin', '--profile', 'cli', 'add', pluginSpec])
    if (pluginCommand === undefined) {
      blockers.push(`dsh-code: could not resolve the dsh command for ${pluginSpec}`)
      continue
    }
    steps.push({
      command: pluginCommand.command,
      args: pluginCommand.args,
      label: `dsh plugin add ${pluginSpec}`,
      fatal: false,
      remedy: `dsh plugin --profile cli add ${pluginSpec}`,
    })
  }
  return { steps, blockers }
}

/**
 * Compare two @deepseek-ai/dsh release-line versions (`0.1.x`, `0.1.x-rc.N`,
 * `0.1.x-alpha.N`). Positive when `left` is newer, negative when older, and 0
 * on equality or an unparseable value (an unreadable version never blocks an
 * update — release semantics follow semver prerelease ordering: final > rc >
 * beta > alpha).
 */
export function compareHarnessLines(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(String(value))
    if (match === null) return undefined
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      tag: match[4] === undefined ? 3 : { alpha: 0, beta: 1, rc: 2 }[match[4]],
      num: match[5] === undefined ? 0 : Number(match[5]),
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  if (a.tag !== b.tag) return a.tag - b.tag
  return a.num - b.num
}

/**
 * The globally installed @deepseek-ai/dsh version, when one exists across the
 * npm global roots this launcher may boot from. An update whose plan targets a
 * line OLDER than this would silently downgrade the booted host.
 */
export function installedGlobalDshVersion(roots = globalDshRoots(), fileExists = existsSync, readFile = readFileSync) {
  for (const root of roots) {
    const manifest = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (!fileExists(manifest)) continue
    try {
      const version = JSON.parse(readFile(manifest, 'utf8'))?.version
      if (typeof version === 'string' && version !== '') return version
    } catch {
      // Unreadable manifest: try the next root.
    }
  }
  return undefined
}

/**
 * Run wrapper-owned child steps in order. A step marked fatal stops the
 * sequence at its failure (the default: the next step depends on this one);
 * a `fatal: false` step is best-effort — its failure is reported with the
 * step's manual retry command, the sequence continues, and the resolved
 * code stays non-zero so the caller still sees the incomplete pass.
 */
export function runSequence(steps, spawnProcess = spawn) {
  return new Promise(resolve => {
    const failures = []
    const run = index => {
      const step = steps[index]
      if (step === undefined) {
        resolve(failures.length === 0 ? 0 : failures[failures.length - 1])
        return
      }
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(step.command)
      const child = spawnProcess(step.command, step.args, { stdio: 'inherit', ...(needsShell ? { shell: true } : {}) })
      const report = code => {
        if (step.remedy !== undefined) console.error(`dsh-code: to retry ${step.label} manually: ${step.remedy}`)
        failures.push(code ?? 1)
        run(index + 1)
      }
      child.once('error', error => {
        console.error(`dsh-code: ${step.label} failed: ${error.message}`)
        if (step.fatal === false) report(undefined)
        else resolve(1)
      })
      child.once('exit', (code, signal) => {
        if (code === 0) run(index + 1)
        else if (step.fatal === false) report(code)
        else resolve(code ?? 1)
      })
    }
    run(0)
  })
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
  // Windows .cmd/.bat shims (npm.cmd) need a shell since Node's
  // CVE-2024-27980 fix rejects spawning them directly with EINVAL. Every
  // launch through here uses fixed, wrapper-owned arguments, so the shell
  // surface adds no injection risk.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command)
  const child = spawn(command, args, { stdio: 'inherit', ...(needsShell ? { shell: true } : {}) })
  child.once('error', error => {
    console.error(`dsh-code: command failed: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === null ? 0 : 1) })
  return child
}

/**
 * How to invoke npm. The JavaScript entrypoint is preferred: running it
 * with this process's node avoids the Windows .cmd shim, whose shell
 * workaround draws a Node deprecation warning on every call.
 */
export function npmInvocation({
  fileExists = existsSync,
  roots = globalDshRoots(),
  resolvePackage = packageRequire.resolve,
} = {}) {
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fileExists(besideNode)) return { command: process.execPath, args: [besideNode] }
  for (const root of roots) {
    try {
      const cli = resolvePackage('npm/bin/npm-cli.js', { paths: [root] })
      return { command: process.execPath, args: [cli] }
    } catch {
      // The next configured global prefix may own npm instead.
    }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
}

/**
 * Read one `npm view` field as JSON, or undefined when the query fails.
 * The subject arrives as argument parts: without a shell, a space inside
 * one argument would reach npm as a single selector and fail.
 */
function viewJson(subjectParts, spawnCommand = spawnSync, invocation = npmInvocation()) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(invocation.command)
  const result = spawnCommand(invocation.command, [...invocation.args, 'view', ...subjectParts, '--json'], { encoding: 'utf8', windowsHide: true, ...(needsShell ? { shell: true } : {}) })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

/**
 * The version of @deepseek-ai/dsh this launcher would boot, when present.
 * Probes the same surfaces rawDshCommand resolves: the adjacent global
 * install first, then every configured npm global prefix.
 */
function installedDshVersion({
  platform = process.platform,
  moduleUrl = import.meta.url,
  fileExists = existsSync,
  roots = globalDshRoots(),
  resolvePackage = packageRequire.resolve,
} = {}) {
  const readVersion = path => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')).version
    } catch {
      return undefined
    }
  }
  if (platform === 'win32') {
    const adjacent = fileUrlToWindowsPath(new URL('../../@deepseek-ai/dsh/package.json', moduleUrl))
    if (fileExists(adjacent)) return readVersion(adjacent)
  } else {
    try {
      const adjacent = fileURLToPath(new URL('../../@deepseek-ai/dsh/package.json', moduleUrl))
      if (fileExists(adjacent)) return readVersion(adjacent)
    } catch {
      // A non-file URL or an unreadable sibling falls through to the roots.
    }
  }
  for (const root of roots) {
    try {
      return readVersion(resolvePackage('@deepseek-ai/dsh/package.json', { paths: [root] }))
    } catch {
      // The next configured global prefix may own DSH instead.
    }
  }
  return undefined
}

/** Show what is installed, what is latest, and what the cli profile boots. */
function printUpdateStatus() {
  const codeLatest = viewJson(['dsh-code', 'version'])
  const dshLatest = viewJson(['@deepseek-ai/dsh', 'version'])
  const dshInstalled = installedDshVersion()
  const spec = profileDependencySpec()
  const mounted = profileMountedVersion()
  console.log(`dsh-code: ${packageVersion} (this launcher), latest ${codeLatest ?? 'unknown'}`)
  console.log(`@deepseek-ai/dsh: ${dshInstalled ?? 'not found'} (global), latest ${dshLatest ?? 'unknown'}`)
  console.log(`cli profile: ${mounted !== undefined ? `dsh-code ${mounted}` : spec ?? 'not mounted'}`)
  console.log('Run `deepseek update --apply` to upgrade the global packages and the cli profile together.')
}

/**
 * The structured form of the update status for machine consumers
 * (`update --json`, consumed by the TUI /update panel): what is running,
 * what npm serves, the exact steps `update --apply` would run, and every
 * refusal that would stop it. One JSON object on stdout; `null` marks an
 * unreadable value so the payload shape stays constant.
 */
export function buildUpdateStatus({
  view = viewJson,
  installedDsh = installedDshVersion,
  readSpec = profileDependencySpec,
  readMounted = profileMountedVersion,
  readPlugins = profilePluginDependencies,
} = {}) {
  const codeLatest = view(['dsh-code', 'version'])
  const installed = installedDsh()
  const spec = readSpec()
  const mounted = readMounted()
  const peers = codeLatest === undefined ? undefined : view([`dsh-code@${codeLatest}`, 'peerDependencies'])
  const plan = updatePlan({
    latestCode: codeLatest ?? 'unknown',
    peers,
    profileSpec: spec,
    profilePlugins: readPlugins(),
  })
  const registry = codeLatest === undefined ? 'could not read the latest dsh-code version from npm' : undefined
  // The same refusals applyUpdate enforces, precomputed so a caller can
  // show them BEFORE any confirmation instead of failing mid-flight.
  const downgrade = plan.line !== undefined && installed !== undefined && compareHarnessLines(plan.line, installed) < 0
  const localCheckout = plan.profileStep ? undefined : localCheckoutRefusal(mounted, codeLatest, plan.codeSpec)
  const hostOnLine = installed !== undefined && (plan.line === undefined || compareHarnessLines(installed, plan.line) === 0)
  const upToDate = registry === undefined
    && codeLatest === packageVersion
    && !downgrade
    && localCheckout === undefined
    && hostOnLine
    && plan.pluginSpecs.length === 0
    && (mounted === undefined || mounted === codeLatest)
  return {
    code: { running: packageVersion, latest: codeLatest ?? null },
    host: { installed: installed ?? null, targetLine: plan.line ?? null },
    profile: { spec: spec ?? null, mounted: mounted ?? null, localCheckout: !plan.profileStep },
    plan: { dshSpec: plan.dshSpec, codeSpec: plan.codeSpec, pluginSpecs: plan.pluginSpecs },
    // JSON.stringify drops undefined members; every unreadable value must
    // serialize as an explicit null so machine consumers never see a missing
    // key drift into a truthy comparison.
    blockers: { registry: registry ?? null, downgrade, localCheckout: localCheckout ?? null },
    upToDate,
  }
}

/**
 * Upgrade the global launcher and the cli profile plugin together. The
 * global install is pinned to the harness line the new dsh-code release
 * declares, the profile follows through `dsh plugin add` with the same
 * pinned spec, and the mounted version is verified at the end.
 */
async function applyUpdate({
  view = viewJson,
  resolveCommand = rawDshCommand,
  spawnProcess = spawn,
} = {}) {
  const npm = npmInvocation()
  const latestCode = view(['dsh-code', 'version'], undefined, npm)
  if (latestCode === undefined) {
    console.error('dsh-code: could not read the latest dsh-code version from npm')
    process.exitCode = 1
    return
  }
  const peers = view([`dsh-code@${latestCode}`, 'peerDependencies'], undefined, npm)
  const plan = updatePlan({
    latestCode,
    peers,
    profileSpec: profileDependencySpec(),
    profilePlugins: profilePluginDependencies(),
  })
  if (!plan.lineLocked) {
    console.log('dsh-code: could not read the compatible harness line; installing @deepseek-ai/dsh@latest')
  }
  // Downgrade guard: the latest published dsh-code may still pin an older
  // harness line than the host already installed globally (a release-ordering
  // window). Installing would silently downgrade every existing session's
  // booted host, and a link-mounted profile would end up on a mismatched pair
  // with no warning — refuse instead and name the manual command.
  const installed = installedGlobalDshVersion()
  if (plan.line !== undefined && installed !== undefined && compareHarnessLines(plan.line, installed) < 0) {
    console.error(`dsh-code: dsh-code@${latestCode} needs @deepseek-ai/dsh@${plan.line}, but ${installed} is already installed globally`)
    console.error(`dsh-code: refusing to downgrade the host; to proceed anyway run: npm install -g @deepseek-ai/dsh@${plan.line} dsh-code@${latestCode}`)
    process.exitCode = 1
    return
  }
  // Local-checkout guard: a link/file-mounted profile runs the checkout's
  // own build, and this command would upgrade the global host beside it.
  // When the checkout is older than the release being installed, upgrading
  // pairs a new host with old local code — the terminal breaks on the next
  // launch. Refuse until the checkout is updated or unmounted.
  if (!plan.profileStep) {
    const refusal = localCheckoutRefusal(profileMountedVersion(), latestCode, plan.codeSpec)
    if (refusal !== undefined) {
      for (const line of refusal) console.error(line)
      process.exitCode = 1
      return
    }
  }
  const { steps, blockers } = updateSteps({ plan, npm, resolveCommand })
  if (blockers.length > 0) {
    for (const line of blockers) console.error(line)
    process.exitCode = 1
    return
  }
  if (plan.profileStep) {
    if (plan.pluginSpecs.length > 0) {
      console.log(`carrying ${plan.pluginSpecs.length} profile plugin${plan.pluginSpecs.length === 1 ? '' : 's'} to the same line: ${plan.pluginSpecs.join(', ')}`)
    }
  } else {
    console.log('cli profile mounts a local checkout; leaving the profile untouched')
  }
  const code = await runSequence(steps, spawnProcess)
  const mounted = profileMountedVersion()
  if (mounted !== undefined) console.log(`cli profile now mounts dsh-code ${mounted}`)
  if (code === 0 && plan.profileStep && mounted !== latestCode) {
    console.error(`dsh-code: the cli profile still mounts ${mounted ?? 'nothing'}; run: dsh plugin --profile cli add ${plan.codeSpec}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code
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
      console.error(`dsh-code: @deepseek-ai/dsh is not installed; run: ${selfInstallHint()}`)
      process.exitCode = 1
      return true
    }
    return launchChild(command.command, command.args)
  }
  if (operation === 'update') {
    if (args.includes('--json')) {
      console.log(JSON.stringify(buildUpdateStatus()))
      return true
    }
    if (args.includes('--apply')) {
      void applyUpdate()
      return true
    }
    printUpdateStatus()
    return true
  }
}

/** Launch the installed DSH CLI while preserving its exit status and stdio. */
export function launchDsh(
  args = process.argv.slice(2),
  spawnProcess = spawn,
  resolveCommand = dshCommand,
  isProfileReady = profileHasDshCode,
  isInteractiveStdin = () => process.stdin.isTTY === true,
) {
  if (!isProfileReady()) {
    console.error('dsh-code: the cli profile does not mount dsh-code yet. Run: dsh plugin --profile cli add dsh-code')
    process.exitCode = 1
    return undefined
  }
  // The interactive TUI is a raw-mode terminal application: with piped or
  // otherwise non-TTY stdin it would die deep inside Ink's raw-mode gate
  // with a cryptic stack. Fail here with one actionable line instead.
  if (!isInteractiveStdin()) {
    console.error('dsh-code: this terminal UI requires an interactive TTY on stdin; run it in a real terminal instead of a pipe')
    process.exitCode = 1
    return undefined
  }
  const command = resolveCommand(args)
  if (command === undefined) {
    console.error(`dsh-code: @deepseek-ai/dsh must be installed globally beside dsh-code; run: ${selfInstallHint()}`)
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
