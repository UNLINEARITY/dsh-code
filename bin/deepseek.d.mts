/**
 * Hand-authored types for the `deepseek`/`dsh-code` launcher.
 *
 * `bin/deepseek.mjs` is plain JavaScript with no declaration, so this sibling
 * `.d.mts` describes the surface the test suite imports. Every member mirrors
 * an export that actually exists in the launcher; keep the two in step.
 */

/** This launcher's release version (exported for probes and tests). */
export const packageVersion: string

/** Arguments required to boot DSH-Code's conventional profile. */
export function profileArgs(args?: readonly string[]): string[]

/** Wrapper-owned operations the launcher handles instead of booting the TUI. */
export const OPERATION_COMMANDS: readonly string[]

/** Exact first-day package spec used by setup (pnpm delays an unpinned release). */
export function setupBundle(args?: readonly string[]): string

/** Wrapper-owned operation, or undefined when arguments belong to the TUI. */
export function operationName(args?: readonly string[]): string | undefined

/** The conventional cli profile directory under the DSH home. */
export function cliProfileDir(home?: string): string

/** The injectable manifest reader seam: one UTF-8 file read as text. */
export type ReadManifest = (path: string, encoding: 'utf8') => string

/**
 * Whether the cli profile already mounts dsh-code. A bare profile composes
 * dsh-base alone and keeps the process alive with no TUI runner — the alias
 * must fail loudly with the missing step instead of hanging.
 */
export function profileHasDshCode(
  profileDir?: string,
  fileExists?: (path: string) => boolean,
  readFile?: ReadManifest,
): boolean

/** The dsh-code dependency the cli profile declares (e.g. '1.0.5' or 'link:C:/repo'). */
export function profileDependencySpec(
  profileDir?: string,
  fileExists?: (path: string) => boolean,
  readFile?: ReadManifest,
): string | undefined

/** The dsh-code version the cli profile actually resolves and boots. */
export function profileMountedVersion(
  profileDir?: string,
  fileExists?: (path: string) => boolean,
  readFile?: ReadManifest,
): string | undefined

/** One `@deepseek-ai/dsh-*` dependency the profile installed through `dsh plugin add`. */
export interface ProfilePluginDependency {
  name: string
  spec: string
}

/** Profile-installed harness plugins that a line upgrade must carry along. */
export function profilePluginDependencies(
  profileDir?: string,
  fileExists?: (path: string) => boolean,
  readFile?: ReadManifest,
): ProfilePluginDependency[]

/** A manifest's `peerDependencies` map, as read from a release or the registry. */
export type PackagePeers = Record<string, unknown>

/** The harness release line a dsh-code release expects, read from its peers. */
export function harnessLineFromPeers(peers: PackagePeers | null | undefined): string | undefined

export interface SelfInstallHintOptions {
  /** The dsh-code release to install; defaults to this launcher's version. */
  version?: string
  /** The target release's peers; absent means this launcher's own manifest. */
  peers?: PackagePeers | undefined
}

/**
 * The exact global install that pairs with this launcher: the harness line
 * its own package declares in peers, and its own release.
 */
export function selfInstallHint(options?: SelfInstallHintOptions): string

/**
 * Refusal line when npm's latest dsh-code is older than this running
 * launcher, or undefined when the upgrade may proceed.
 */
export function bundleDowngradeRefusal(latest: string | undefined, running?: string): string | undefined

/**
 * Refusal lines when a local-checkout profile would pair an older local build
 * with the newer global host this upgrade installs, or undefined when the
 * upgrade may proceed.
 */
export function localCheckoutRefusal(
  mounted: string | undefined,
  latestCode: string,
  codeSpec: string,
): string[] | undefined

/** Version after the last @ in an npm spec (`dsh-code@1.0.8`). */
export function specVersion(spec: string): string | undefined

/** Exact install plan `update --apply` was given on the command line. */
export interface PinnedPlan {
  dshSpec: string
  codeSpec: string
  pluginSpecs: string[]
}

/** Exact install plan passed to `update --apply` after a probe. */
export function parsePinnedPlan(args: readonly string[]): PinnedPlan | undefined

export interface UpdatePlanInput {
  /** The dsh-code release npm serves. */
  latestCode: string
  /** The target release's peers; absent when they could not be read. */
  peers?: PackagePeers | null | undefined
  /** The cli profile's dsh-code dependency spec. */
  profileSpec?: string | undefined
  /** Companion plugins the profile installed through `dsh plugin add`. */
  profilePlugins?: readonly ProfilePluginDependency[]
}

export interface UpdatePlan {
  dshSpec: string
  line: string | undefined
  lineLocked: boolean
  codeSpec: string
  profileStep: boolean
  pluginSpecs: string[]
}

/**
 * Decide what `update --apply` installs: the global DSH launcher is pinned to
 * the harness line the target dsh-code release declares in its peers, and a
 * profile that mounts a local checkout (link:/file:) keeps its mount.
 */
export function updatePlan(input: UpdatePlanInput): UpdatePlan

/** One wrapper-owned child step run by `runSequence`. */
export interface SequenceStep {
  command: string
  args: readonly string[]
  label: string
  /** A failure stops the sequence (the default) unless explicitly false. */
  fatal?: boolean
  /** The manual command that recovers this step. */
  remedy?: string
}

/** A step `updateSteps` builds: it always carries its fatal marking and remedy. */
export interface UpdateStep extends SequenceStep {
  fatal: boolean
  remedy: string
}

export interface UpdateStepsInput {
  plan: UpdatePlan
  npm?: ResolvedCommand
  resolveCommand?: (args: readonly string[]) => ResolvedCommand | undefined
}

export interface UpdateStepsResult {
  steps: UpdateStep[]
  blockers: string[]
}

/**
 * The concrete steps `update --apply` runs, plus the unresolvable dsh
 * commands that block the sequence before the first step starts.
 */
export function updateSteps(input: UpdateStepsInput): UpdateStepsResult

/**
 * Compare two @deepseek-ai/dsh release-line versions: positive when `left` is
 * newer, negative when older, and 0 on equality or an unparseable value.
 */
export function compareHarnessLines(left: string, right: string): number

/** The globally installed @deepseek-ai/dsh version, when one exists. */
export function installedGlobalDshVersion(
  roots?: readonly string[],
  fileExists?: (path: string) => boolean,
  readFile?: ReadManifest,
): string | undefined

/**
 * Run wrapper-owned child steps in order. A step marked fatal stops the
 * sequence at its failure; a `fatal: false` step is best-effort and lets the
 * sequence continue while the resolved code stays non-zero.
 */
export function runSequence(steps: readonly SequenceStep[], spawnProcess?: SpawnProcess): Promise<number>

/** Npm global-prefix roots that may contain DSH when this launcher is linked to a checkout. */
export function globalDshRoots(): string[]

/** A resolved child-process invocation: the executable and its argument vector. */
export interface ResolvedCommand {
  command: string
  args: readonly string[]
}

export interface DshCommandOptions {
  platform?: NodeJS.Platform
  moduleUrl?: string
  fileExists?: (path: string) => boolean
  roots?: readonly string[]
  resolvePackage?: (id: string, options: { paths: readonly string[] }) => string
}

/** Resolve the DSH entrypoint without passing user arguments through a Windows shell. */
export function rawDshCommand(
  args: readonly string[],
  options?: DshCommandOptions,
): ResolvedCommand | undefined

/** Resolve the normal TUI boot command. */
export function dshCommand(
  args: readonly string[],
  options?: DshCommandOptions,
): ResolvedCommand | undefined

/** Static shell completion for wrapper commands and the TUI's local flags. */
export function completionScript(shell: string): string

export interface NpmInvocationOptions {
  fileExists?: (path: string) => boolean
  roots?: readonly string[]
  resolvePackage?: (id: string, options: { paths: readonly string[] }) => string
}

/**
 * How to invoke npm. The JavaScript entrypoint is preferred: running it with
 * this process's node avoids the Windows .cmd shim, whose shell workaround
 * draws a Node deprecation warning on every call.
 */
export function npmInvocation(options?: NpmInvocationOptions): ResolvedCommand

/** One `npm view --json` field: a version string, a peers map, or an unreadable value. */
export type NpmViewField = string | PackagePeers | undefined

/** What `buildUpdateStatus` asks npm: `[subject, field]`. */
export type NpmViewSubject = readonly string[]

export interface UpdateStatusInput {
  view?: (subjectParts: NpmViewSubject) => NpmViewField
  installedDsh?: () => string | undefined
  readSpec?: () => string | undefined
  readMounted?: () => string | undefined
  readPlugins?: () => readonly ProfilePluginDependency[]
}

export interface UpdateStatus {
  code: { running: string, latest: string | null }
  host: { installed: string | null, targetLine: string | null }
  profile: { spec: string | null, mounted: string | null, localCheckout: boolean }
  plan: { dshSpec: string, codeSpec: string, pluginSpecs: string[] }
  blockers: { registry: string | null, downgrade: boolean, localCheckout: string[] | null }
  upToDate: boolean
  aheadOfRegistry: boolean
}

/**
 * The structured form of the update status for machine consumers
 * (`update --json`): what is running, what npm serves, the exact steps
 * `update --apply` would run, and every refusal that would stop it.
 */
export function buildUpdateStatus(input?: UpdateStatusInput): UpdateStatus

/** Run one wrapper-owned operational command, or undefined for a TUI launch. */
export function launchOperation(args?: readonly string[]): boolean | SpawnedChild | undefined

/** Options shared by every spawn seam the launcher injects. */
export interface SpawnOptions {
  stdio: 'inherit'
  shell?: boolean
}

/** The completion source a spawn seam must return: the child's error/exit events. */
export interface SpawnedChild {
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** The injectable child-process spawn seam. */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedChild

/** Launch the installed DSH CLI while preserving its exit status and stdio. */
export function launchDsh(
  args?: readonly string[],
  spawnProcess?: SpawnProcess,
  resolveCommand?: (args: readonly string[]) => ResolvedCommand | undefined,
  isProfileReady?: () => boolean,
  isInteractiveStdin?: () => boolean,
): SpawnedChild | undefined
