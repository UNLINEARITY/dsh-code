/**
 * @deepseek-ai/dsh-code — the interactive terminal driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates or resumes preset-composed Agents through the core registry, keeps
 * one Ink owner while the active session changes, folds submitted prompts
 * into the selected durable session, answers approval asks with a y/n bar,
 * dispatches slash commands, and on quit flushes and requests process exit.
 *
 * @module @deepseek-ai/dsh-code
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { mkdir, rm, stat, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage, MessageId, type ContentBlock, type ImageBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// Type-only: carries the ctx.sessionTitle service merge for /title.
import type {} from '@deepseek-ai/dsh-session-title'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { App, type NoticeTone } from './app.ts'
import { mountApprovalAnswerer, type ApprovalStore } from './approval.ts'
import { isSlashLine, watchCommands, type CommandsView } from './commands.ts'
import { internals, type TuiMount } from './internals.ts'
import { buildModelSelection, applyModelSelectionToConfig, loadModelDirectory, modelSelectionLabel, resolveEffectiveSelection, type ModelRow } from './models.ts'
import {
  loadProviderSettings,
  removeProviderSettings,
  saveProviderCredential,
  saveProviderConfiguration,
  subscribeProviderSettings,
  unsetProviderCredential,
} from './provider-settings.ts'
import { createMentions, type MentionsApi } from './mentions.ts'
import { mountQuestionProvider, type QuestionStore } from './questions.ts'
import { createTranscriptStore, type TranscriptStore } from './store.ts'
import { createSubagentFeed, type SubagentFeedView } from './subagents.ts'
import { parseStatuslineItems } from './render/status.ts'
import { HISTORY_MAX_ENTRIES, parseHistoryFile, serializeHistoryList } from './history.ts'
import { watchSkills, type SkillsView } from './skills.ts'
import { toolArgumentsPreview } from './render/tool-preview.ts'
import { buildExportMarkdown } from './render/export.ts'
import { saveImagePaths } from './attachments.ts'
import { copyText, latestAssistantText } from './editor.ts'
import { selectForkSeed } from './fork.ts'
import { buildReviewPrompt, loadGitDiff } from './git-workflow.ts'
import type { TuiStartup } from './startup.ts'
import { SessionSwitchQueue } from './session-switch.ts'
import { agentPresetsFrom, resolvePreset, selectPreset } from './presets.ts'
import {
  applyPendingPermission,
  cyclePermission as cyclePermissionPreset,
  effectivePermission,
  listPermissionRows,
  permissionPresetsFrom,
  selectPermission,
} from './permissions.ts'
import { listPluginRows } from './plugin-inventory.ts'
import { parseThemeName, setTheme, type ThemeName } from './theme.ts'
import {
  collectDeletionSubtree,
  isSubagentSession,
  matchSessionId,
  mergeSessionTitles,
  newestRootForCwd,
  projectSessionRows,
  SESSION_ARTIFACT_NAMES,
  sessionArtifactDirectory,
  type SessionDirectoryOptions,
  type SessionQueryService,
  type SessionRow,
} from './session-directory.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the startup resolved from this app's injected provider service. */
export interface Config {
  /** How this invocation obtains its session identity (validated loosely; narrowed in {@link apply}). */
  startup: { kind: string; sessionId?: string; mode?: string; theme?: string; prompt?: string; images?: string[] }
}

export const Config: z<Config> = z.object({
  startup: z.object({
    kind: z.string().required(),
    sessionId: z.string(),
    mode: z.string(),
    theme: z.string(),
    prompt: z.string(),
    images: z.array(z.string()),
  }),
})

/** Process-facing effects of the runner: the Ink mount plus the launcher's exit request. */
interface TuiIo {
  mount: typeof internals.mount
  exit(code: number): void
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/** The `ctx.jobs` registry face (dsh-jobs-local behind the base patch row). */
interface JobsServiceLike {
  list(caller?: Agent): ReadonlyArray<{
    id: string
    kind: string
    label: string
    status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
    detail?: string
    startedAt: number
    finishedAt?: number
  }>
}

/**
 * Snapshot caller-visible background jobs for the /jobs panel. Jobs the agent
 * started through run_in_background are fenced by their owner, so the CURRENT
 * agent is the caller. A missing registry is a harmless absence (the base
 * composition may not mount one) and collapses to the empty panel state —
 * the documented degradation for harmless probes, not an error.
 * @param ctx - context carrying the optional `jobs` registry.
 * @param caller - the active agent (undefined sees only unowned jobs).
 * @returns job rows in registration order; never throws.
 */
function listJobs(ctx: Context, caller: Agent | undefined): readonly import('./kernel-panels.ts').JobRow[] {
  const jobs = (ctx as unknown as { get(name: string): unknown }).get('jobs') as JobsServiceLike | undefined
  if (jobs === undefined) return []
  try {
    return jobs.list(caller).map(job => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      detail: job.detail,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }))
  } catch {
    return []
  }
}

/**
 * Resolve the working directory's git branch for the status line.
 * @param cwd - the session's working directory.
 * @returns the branch name, or '' outside a repository or on a detached HEAD.
 */
function gitBranch(cwd: string): string {
  try {
    const ref = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim().match(/^ref: refs\/heads\/(.+)$/)
    return ref?.[1] ?? ''
  } catch {
    // Only the single HEAD read is attempted, so the sole reachable failure is
    // a missing repository (or unreadable HEAD file): the branch group drops out.
    return ''
  }
}

/** The session identity this invocation will run, plus whether it is resumed. */
interface Target {
  sessionId: string
  resume: boolean
  mode?: string
  cwd?: string
  seed?: readonly SessionEvent[]
  parentSession?: SessionId
  seedLength?: number
}

/**
 * Reduce a session id to a filename-safe /export default-name suffix. Session
 * ids are normally minted `session-<uuid>`, but `--session` accepts arbitrary
 * user text: path separators must never leak into the default export filename
 * (which would escape the session cwd).
 * @param id - the session id.
 * @returns at most the last 8 filename-safe characters.
 */
export function exportSessionIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(-8)
}

/** One ordered step of the terminal quit cleanup. */
export interface QuitCleanupStep {
  /** Step label used in diagnostics and tests. */
  readonly name: string
  /** The step's async work; a rejection is contained by the sequence. */
  readonly run: () => Promise<void>
}

/**
 * Run the ordered quit cleanup, then request exit. Every step rejection is
 * contained (reported through `onError`) so a failed flush or dispose never
 * skips the remaining cleanup; the exit request is always reached exactly
 * once.
 * @param steps - the cleanup steps in dependency order (settle the visible
 * session, await the final in-flight composition, await durable recall).
 * @param exit - the terminal exit request (code 0).
 * @param onError - optional failure sink; called once per failing step and
 * itself contained, so a throwing sink cannot abort the sequence.
 * @returns the names of the steps that started, in order (for tests).
 */
export async function runQuitSequence(
  steps: readonly QuitCleanupStep[],
  exit: (code: number) => void,
  onError?: (name: string, error: unknown) => void,
): Promise<readonly string[]> {
  const started: string[] = []
  for (const step of steps) {
    started.push(step.name)
    try {
      await step.run()
    } catch (error) {
      try {
        onError?.(step.name, error)
      } catch {
        // The failure sink must never abort the cleanup sequence.
      }
    }
  }
  try {
    exit(0)
  } catch {
    // The exit request itself must not become an unhandled rejection.
  }
  return started
}

/**
 * Resolve the invocation's target session against the persisted headers.
 * @param startup - the parsed startup flags.
 * @param persistence - the persistence service; required for resume/latest.
 * @param cwd - the working directory `--continue` filters by.
 * @returns the target identity.
 * @throws with a user-facing message when the flags name nothing resolvable.
 */
export async function resolveTarget(startup: TuiStartup, persistence: SessionPersistence | undefined, cwd: string): Promise<Target> {
  if (startup.kind === 'fresh') return { sessionId: `session-${randomUUID()}`, resume: false, mode: startup.mode }
  if (startup.kind === 'named') {
    // The id must not exist yet: reject before any Agent composition when the
    // backend can tell us (a live collision is still caught by the session
    // store at create time).
    if (persistence !== undefined) {
      const headers: readonly SessionHeader[] = await persistence.list()
      if (headers.some(header => header.id === startup.sessionId)) {
        throw new Error(`session "${startup.sessionId}" already exists; use --resume to continue it`)
      }
    }
    return { sessionId: startup.sessionId, resume: false, mode: startup.mode }
  }
  if (persistence === undefined) {
    throw new Error('cannot resolve the requested session: session persistence is not configured')
  }
  const headers: readonly SessionHeader[] = await persistence.list()
  if (startup.kind === 'resume') {
    const matched = matchSessionId(headers, startup.sessionId)
    // Subagent conversations are read-only everywhere else; the CLI must not
    // be a back door into appending root turns to a child's durable log.
    if (isSubagentSession(matched)) {
      throw new Error('subagent conversations are read-only; resume a root session')
    }
    return { sessionId: matched.id, resume: true }
  }
  // --continue: the newest persisted ROOT session whose header pins this cwd.
  const newest = newestRootForCwd(headers, cwd)
  if (newest === undefined) throw new Error(`no persisted session for this directory (${cwd}); start one without --continue`)
  return { sessionId: newest.id, resume: true }
}

/**
 * Resolve a bounded command preview for one pending approval: the request
 * contract carries no arguments, so the bar self-serves from the transcript
 * projection via `callId` (mirrors the web ApprovalPanel's argsRaw lookup).
 * @param events - the transcript entries to search.
 * @param callId - the tool call the question is about, when the asker had one.
 * @param toolName - the tool the question is about.
 * @returns a bounded preview line, '' when nothing useful resolves.
 */
function approvalCommandPreview(events: readonly { kind: string }[], callId: string | undefined, toolName: string): string {
  if (callId === undefined) return ''
  const entry = events.find(candidate =>
    candidate.kind === 'tool' && (candidate as { callId?: string }).callId === callId)
  if (entry === undefined) return ''
  const args = (entry as { arguments?: string }).arguments ?? ''
  return toolArgumentsPreview(args, toolName)
}

/** The runner's connection between the React app and the process side. */
interface AppBridge {
  /** Post one local notice line (feedback the transcript does not carry). */
  notify(text: string, tone?: NoticeTone): void
}

/**
 * Run the interactive terminal session: resolve the target session, create or
 * resume one Agent, mount the app, and keep the process alive until the user
 * quits.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param startup - the parsed invocation flags.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, startup: TuiStartup, io: TuiIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const sessionQuery = (ctx as unknown as { get(name: string): unknown }).get('sessionQuery') as SessionQueryService | undefined
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const cwd = process.cwd()
  // Live deployment default (web selectModel parity): read on every use, not
  // snapshotted at launch, so a /model pick this process saves becomes the
  // default for sessions composed afterwards without a restart.
  const currentDefaults = (): ModelSelection => defaultModel.currentSelection()
  const presets = agentPresetsFrom(ctx)
  if (presets === undefined) throw new Error('agent preset service is unavailable; check the dsh-code bundle patch')
  const permissionPresets = permissionPresetsFrom(ctx)

  // A bare fresh launch stays transient: no Agent or session is composed, and
  // nothing is persisted, until the user's first real input. Explicit flags
  // (--resume/--continue/--session/--mode) keep the eager create/resume path.
  const lazy = startup.kind === 'fresh' && startup.mode === undefined

  interface ActiveSession {
    handle: AgentHandle
    agent: Agent
    session: Session
    store: ReturnType<typeof createTranscriptStore>
    mentions: MentionsApi
    mode: string
    selection: { picked?: ModelSelection }
    resumed: boolean
  }

  /** Prepare a complete next session before disturbing the currently visible one. */
  const prepare = async (next: Target): Promise<ActiveSession> => {
    const nextCwd = next.cwd ?? cwd
    // A bare launch can pick a model before any session exists: the process
    // keeps that explicit choice and every prepared session starts from it
    // (the documented precedence: explicit pick > session header > default).
    const selectionState: { picked?: ModelSelection } = pendingSelection === undefined
      ? {}
      : { picked: pendingSelection }
    let mode = next.resume ? next.mode : next.mode ?? pendingMode
    if (!next.resume) mode = (await presets.resolve(mode)).id
    const setup = async (agentCtx: Context): Promise<void> => {
      const sessionPreset = next.resume
        ? resolvePreset(agentCtx.agent!.session)
        : mode
      const mounted = await presets.mount(agentCtx, sessionPreset)
      mode = mounted.id
      const selection: ModelSelectionRef = {
        get current(): ModelSelection | undefined {
          return resolveEffectiveSelection(selectionState.picked, agentCtx.agent?.session.requestHeader()?.config, currentDefaults())
        },
        set current(value: ModelSelection | undefined) { selectionState.picked = value },
        assembled: undefined,
      }
      installModelSelection(agentCtx, selection)
    }
    // AgentOptions seed the loop's fallback route; effort rides the selection
    // ref (installModelSelection), so only the provider/model pair is seeded.
    const seedOptions = pendingSelection === undefined
      ? { provider: currentDefaults().provider, model: currentDefaults().model }
      : { provider: pendingSelection.provider, model: pendingSelection.model }
    const handle = next.resume
      ? await agents.resume({
        resumeSessionId: SessionId(next.sessionId),
        agentOptions: seedOptions,
        // Quit aborts an in-flight composition so the exit wait never hangs
        // on a prepare that cannot settle; upstream rolls the creation back.
        signal: quitAbort.signal,
        setup,
      })
      : await agents.create({
        sessionId: SessionId(next.sessionId),
        meta: {
          cwd: nextCwd,
          agentPreset: mode,
          ...(next.parentSession === undefined ? {} : { parentSession: next.parentSession }),
          ...(next.seedLength === undefined ? {} : { seedLength: next.seedLength }),
        },
        ...(next.seed === undefined ? {} : { seed: next.seed }),
        agentOptions: seedOptions,
        signal: quitAbort.signal,
        setup,
      })
    const session = handle.agent.session
    if (!next.resume && permissionPresets !== undefined) {
      applyPendingPermission(permissionPresets, session, pendingPermission)
    }
    return {
      handle,
      agent: handle.agent,
      session,
      store: createTranscriptStore(session.events),
      mentions: createMentions(ctx, handle.agent, session.header.cwd ?? nextCwd),
      mode: mode ?? 'standard',
      selection: selectionState,
      resumed: next.resume,
    }
  }

  let active: ActiveSession | undefined
  let agent: Agent | undefined
  let session: Session | undefined
  let store: TranscriptStore = createTranscriptStore()
  // Live subagent activity (child sessions of the current root): one bounded
  // row per child, folded from the same event bus the transcript feeds on.
  const subagents: SubagentFeedView & { apply(sessionId: string, event: SessionEvent): void; reset(): void } = createSubagentFeed()
  // Pre-session @file completion runs the official search over the launch
  // cwd (model- and session-independent); the prepare/activate paths replace
  // this with the agent-scoped instance once a session exists.
  let mentions: MentionsApi = createMentions(ctx, undefined, cwd)
  /** Explicit model pick made before any session exists (a bare launch). */
  let pendingSelection: ModelSelection | undefined
  /** Agent preset selected before the first session exists. */
  let pendingMode: string | undefined
  /** Ordered pre-session preset resolutions; first composition awaits them. */
  let pendingModeWork: Promise<void> = Promise.resolve()
  /** Permission preset selected before the first session exists. */
  let pendingPermission: string | undefined
  /**
   * Monotonic session epoch: bumped on every successful activation, on every
   * first-session creation, and on quit. Async callbacks (mention prepares,
   * command executions) capture it at call time and drop their result when it
   * changed, so a stale callback can never deliver to an agent that is no
   * longer on screen.
   */
  let epoch = 0
  /** Aborted on quit: an in-flight agent composition (create/resume) races this signal. */
  const quitAbort = new AbortController()
  /** In-flight mention-prepare / command-execute controllers, aborted on any session transition. */
  const pendingControllers = new Set<AbortController>()
  const abortPendingControllers = (): void => {
    for (const controller of [...pendingControllers]) {
      pendingControllers.delete(controller)
      controller.abort()
    }
  }
  /** The in-flight session-composition turn (create/resume/activate), if any. */
  let composing: Promise<void> | undefined
  /**
   * Run one session composition exclusively: concurrent compositions wait
   * their turn, so a bare-launch first-session creation and a /resume
   * activation can never compose agents in parallel (the loser would leak its
   * agent or mis-deliver). Errors propagate to the caller; the shared slot
   * always continues.
   */
  const compose = (work: () => Promise<void>): Promise<void> => {
    const turn = (composing ?? Promise.resolve()).catch(() => {}).then(work)
    composing = turn.catch(() => {})
    return turn
  }

  if (!lazy) {
    const target = await resolveTarget(startup, persistence, cwd)
    const prepared = await prepare(target)
    active = prepared
    agent = prepared.agent
    session = prepared.session
    store = prepared.store
    mentions = prepared.mentions
  }

  // Seed the transcript from the full session log: constructor seeds never
  // fire on `session/event`, so a resumed session paints its history once
  // before the first render. The handler reads the current session/store, so
  // the deferred first session of a bare launch is covered by the same feed.
  const off = ctx.on('session/event', (subject: Session, event: SessionEvent) => {
    if (session === undefined) return
    if (subject.id === session.id) {
      store.apply(event)
      return
    }
    // Child sessions (subagent conversations this root spawned) fold into
    // the bounded live-activity feed, never the transcript: the root stays
    // the only durable transcript truth while a running subagent remains
    // visible. Lineage comes from the child header, same field the session
    // directory uses to tag `↳` rows.
    if (subject.header.parentSession === session.id && subject.header.origin === 'subagent') subagents.apply(subject.id, event)
  })

  const commands: CommandsView = watchCommands(ctx)
  if (agent !== undefined) commands.setAgent(agent)

  const skills: SkillsView = watchSkills(ctx)
  if (agent !== undefined) skills.setAgent(agent)

  // Approval answerer: renders the ask as a y/n bar; only this TUI's agent is
  // claimed, every other ask falls through to the fail-closed waterfall. The
  // owner predicate is empty until the first session exists.
  const approval: ApprovalStore = mountApprovalAnswerer(
    ctx,
    candidate => agent !== undefined && candidate.id === agent.id,
    request => approvalCommandPreview(store.getView().entries, request.callId, request.toolName),
  )

  // Subagent model routing. The kernel seeds child agents from the parent's
  // CREATE-TIME AgentOptions (resolveChildAgentOptions), which a mid-session
  // /model switch never touches — delegated work would keep running on the
  // launch-time route. This plugin-level listener mirrors installModelSelection
  // for subagent-origin requests (scope filtering delivers the agent subject
  // inside the payload): the explicit /subagent override wins, else the root's
  // effective selection (explicit pick > session header > deployment default).
  // Effort rides the selection exactly like the kernel listener applies it.
  let subagentOverride: ModelSelection | undefined
  ctx.on('agent/request', (payload, next) => {
    const subject = payload.agent
    const header = subject.session.header
    if (header.parentSession === undefined && header.origin !== 'subagent') return next()
    const picked = subagentOverride
      ?? resolveEffectiveSelection(
        active?.selection.picked ?? pendingSelection,
        subject.session.requestHeader()?.config,
        currentDefaults(),
      )
    return next().then(resolved => applyModelSelectionToConfig(resolved, picked))
  })

  // ask_user_question provider: the single UI provider on the shared service,
  // one request on screen at a time. Plan reviews (exit_plan_mode) arrive
  // through this same pipe.
  const questions: QuestionStore = mountQuestionProvider(ctx)

  // The bridge the React app registers on mount: local notices from the
  // process side (unknown commands, switch confirmations, cancels).
  const bridge: AppBridge = { notify: () => {} }

  // /statusline persistence: one user-level JSON file under the DSH home.
  // Missing file means defaults; a corrupt file degrades to defaults with a
  // surfaced warning (the customization is user-authored, never silent).
  const statuslinePath = join(homedir(), '.dsh', 'dsh-code', 'statusline.json')
  let statuslineWarning: string | undefined
  let statuslineItems: readonly string[] = []
  try {
    statuslineItems = parseStatuslineItems(JSON.parse(readFileSync(statuslinePath, 'utf8')).items)
  } catch (error) {
    statuslineItems = parseStatuslineItems(undefined)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      statuslineWarning = error instanceof Error ? error.message : String(error)
    }
  }
  const saveStatusline = (items: readonly string[]): void => {
    statuslineItems = [...items]
    // The config directory may not exist on a first save; create it before
    // the write so a fresh install persists customizations.
    void mkdir(dirname(statuslinePath), { recursive: true })
      .then(() => writeFileAsync(statuslinePath, JSON.stringify({ items }, null, 2) + '\n', 'utf8'))
      .catch((writeError: unknown) => {
        bridge.notify('statusline save failed: ' + (writeError instanceof Error ? writeError.message : String(writeError)), 'error')
      })
  }

  // /theme persistence: one user-level JSON file under the DSH home, mirroring
  // the statusline file. A missing file means the dark default; a corrupt file
  // degrades to dark with a surfaced warning. Precedence: CLI --theme > file >
  // auto detection > dark (auto detection itself is a later enhancement and
  // currently falls back to dark inside theme.ts).
  const themePath = join(homedir(), '.dsh', 'dsh-code', 'theme.json')
  let themeWarning: string | undefined
  if (startup.theme === undefined) {
    try {
      setTheme(parseThemeName(JSON.parse(readFileSync(themePath, 'utf8')).theme))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        themeWarning = error instanceof Error ? error.message : String(error)
      }
    }
  } else {
    setTheme(startup.theme)
  }
  const saveTheme = (name: ThemeName): void => {
    setTheme(name)
    void mkdir(dirname(themePath), { recursive: true })
      .then(() => writeFileAsync(themePath, JSON.stringify({ theme: name }, null, 2) + '\n', 'utf8'))
      .catch((writeError: unknown) => {
        bridge.notify('theme save failed: ' + (writeError instanceof Error ? writeError.message : String(writeError)), 'error')
      })
  }

  // Global input recall (Codex composer-history contract): one JSONL file
  // under the DSH home. A missing file means an empty history; unreadable or
  // corrupt content degrades to the valid lines it could parse, silently —
  // recall is a convenience surface, never a gate.
  const historyPath = join(homedir(), '.dsh', 'dsh-code', 'history.jsonl')
  let inputHistory: readonly string[] = []
  try {
    inputHistory = parseHistoryFile(readFileSync(historyPath, 'utf8'))
  } catch {
    inputHistory = []
  }
  /** Serialized history writes: each submission rewrites the latest in-memory snapshot. */
  let historyWriteChain: Promise<void> = Promise.resolve()
  const recordHistory = (text: string): void => {
    if (text === '') return
    inputHistory = [...inputHistory, text].slice(-HISTORY_MAX_ENTRIES)
    // Write the whole current list, serialized per submission: the file is
    // never read back on the submit path, so rapid same-process submissions
    // cannot lose entries to a read-modify-write race.
    historyWriteChain = historyWriteChain
      .then(() => mkdir(dirname(historyPath), { recursive: true }))
      .then(() => writeFileAsync(historyPath, serializeHistoryList(inputHistory), 'utf8'))
      .catch((writeError: unknown) => {
        bridge.notify('history save failed: ' + (writeError instanceof Error ? writeError.message : String(writeError)), 'error')
      })
  }

  /** Cancel one queued inbox message (Delete on the empty composer); the durable splice retires its pending row. */
  const cancelQueued = (messageId: string): void => {
    if (agent === undefined) return
    try {
      if (agent.inbox.remove(MessageId(messageId))) {
        bridge.notify('queued message cancelled')
      }
    } catch (error: unknown) {
      bridge.notify('queue cancel failed: ' + (error instanceof Error ? error.message : String(error)), 'error')
    }
  }

  // The mount handle lives in a box: quit closes over it, while the mount
  // itself is created after quit (the App element needs quit as a prop).
  const mountRef: { current?: TuiMount } = {}
  let quitting = false
  const quit = (): void => {
    if (quitting) return
    quitting = true
    switchQueue.cancel()
    // Stale prepares/commands die with the session they were for. Aborting
    // the composition signal lets a never-settling prepare reject, so the
    // exit wait below cannot hang (upstream rolls the creation back).
    abortPendingControllers()
    quitAbort.abort()
    epoch += 1
    off()
    mountRef.current?.unmount()
    const currentSession = session
    const currentActive = active
    const report = (name: string, error: unknown): void => {
      internals.stderr.write(`dsh: quit ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    // One ordered cleanup: settle the visible session (if any — a bare launch
    // that never composed one resolves immediately), then wait for the final
    // in-flight composition (its work swallows errors and the quitting guard
    // disposes any half-prepared agent), then flush the durable recall, then
    // request exit. `composing` and `historyWriteChain` are read at step run
    // time, so a turn that was still being queued when quit ran is included.
    // A failing step must never skip the remaining cleanup.
    const steps: QuitCleanupStep[] = [
      ...(currentSession === undefined || currentActive === undefined
        ? []
        : [
          { name: 'flush', run: async () => { await sessions.flush(currentSession) } },
          { name: 'dispose', run: () => currentActive.handle.dispose() },
        ]),
      { name: 'composing', run: () => composing ?? Promise.resolve() },
      { name: 'history', run: () => historyWriteChain },
    ]
    void runQuitSequence(steps, io.exit, report)
  }

  /** Run one slash line through the command registry (closed namespace). */
  const runSlash = (line: string): void => {
    const currentAgent = agent
    if (currentAgent === undefined) return
    if (line.startsWith('/resume ')) {
      requestResume(line.slice(8).trim())
      return
    }
    const registry = ctx.get('commands')
    if (registry === undefined) {
      bridge.notify('no command registry is mounted in this composition', 'error')
      return
    }
    const controller = new AbortController()
    const atEpoch = epoch
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // rc.8 registry.execute gained an `images` admission parameter; the TUI
    // composer never attaches images to a slash line, so every invocation is
    // the empty batch (commands declaring input.images still run image-free).
    void Promise.resolve().then(() => registry.execute(currentAgent, line, [], controller.signal)).then((execution) => {
      finish()
      // A switch/quit landed while the command ran: its fall-through must not
      // reach an agent that is no longer on screen.
      if (epoch !== atEpoch || agent !== currentAgent) return
      if (execution === undefined) {
        // No command owns this line: send it verbatim so a user-invocable
        // skill gesture (`/skill-name`) reaches the host's tool-skill
        // pre-step injection — the web composer's same fall-through.
        try {
          currentAgent.followup(createUserMessage({
            content: [{ type: 'text', text: line }],
            source: { kind: 'user' },
          }))
        } catch (error: unknown) {
          bridge.notify(`command fallback failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      }
    }, (error: unknown) => {
      finish()
      if (epoch !== atEpoch || agent !== currentAgent) return
      bridge.notify(`command failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /** Deliver one trimmed line to the live session, expanding mentions first. */
  const deliverLine = (line: string, mode: 'followup' | 'steer', images: readonly ImageBlock[] = []): void => {
    const currentAgent = agent!
    const currentMentions = mentions!
    // The command registry is a closed namespace: slash lines run out of
    // band and never reach the model through this path (steering keeps the
    // registry out of the inbox, so slash lines steer as literal text).
    if (images.length === 0 && isSlashLine(line) && mode === 'followup') {
      runSlash(line)
      return
    }
    let parsed: ReturnType<MentionsApi['parse']>
    try {
      parsed = currentMentions.parse(line)
    } catch (error: unknown) {
      bridge.notify(`invalid session reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    const atEpoch = epoch
    const deliver = (readable: string, context?: UserMessage): void => {
      // A switch/quit landed while the snapshot was being prepared: never
      // deliver to an agent that is no longer on screen.
      if (epoch !== atEpoch || agent !== currentAgent) return
      // Session snapshots ride the inbox as model-facing context ahead of
      // the readable message (upstream README wiring: inject before the
      // followup/steer that wakes the driver).
      try {
        if (context !== undefined) currentAgent.inject(context)
        const content: ContentBlock[] = [
          ...(readable === '' ? [] : [{ type: 'text' as const, text: readable }]),
          ...images,
        ]
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        if (mode === 'steer') {
          // The queued message is visible as a pending transcript row (the
          // web queue-mirror contract); no notice noise on the happy path.
          currentAgent.steer(message)
        } else {
          currentAgent.followup(message)
        }
      } catch (error: unknown) {
        bridge.notify(`${mode === 'steer' ? 'steering' : 'message'} failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    if (parsed.references.length === 0) {
      deliver(parsed.text)
      return
    }
    const controller = new AbortController()
    pendingControllers.add(controller)
    void currentMentions.prepare(parsed, controller.signal).then((prepared) => {
      pendingControllers.delete(controller)
      deliver(prepared.text, prepared.additionalContext)
    }, (error: unknown) => {
      pendingControllers.delete(controller)
      if (controller.signal.aborted || epoch !== atEpoch) return
      bridge.notify(`session reference failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  // Deferred first-session creation for a bare launch: the session is composed
  // only when the user submits real input (or /new), and every line that
  // arrives during creation is delivered in order afterwards. A creation
  // failure reports and clears the queue, leaving the transient state ready
  // for the next attempt.
  const pendingInputs: Array<{ text: string; mode: 'followup' | 'steer'; images: readonly ImageBlock[] }> = []
  // A creation is queued/running: further submissions must not mint more
  // fresh sessions (their lines queue into pendingInputs instead).
  let creating = false
  const ensureSession = (mode?: string): void => {
    if (creating) return
    creating = true
    void compose(async () => {
      try {
        // A direct `/mode <preset>` resolves asynchronously. Preserve submit
        // order so the first composition cannot race ahead with the old mode.
        await pendingModeWork
        // Another composition (e.g. a /resume activated while this creation
        // waited its turn) may have published a session already: deliver the
        // queued lines there instead of minting a competing fresh session
        // (which would orphan the live one without a dispose).
        if (session !== undefined) {
          const queued = pendingInputs.splice(0)
          for (const item of queued) deliverLine(item.text, item.mode, item.images)
          return
        }
        const next = await prepare({
          sessionId: `session-${randomUUID()}`,
          resume: false,
          ...(mode === undefined ? {} : { mode }),
        })
        if (quitting) {
          void next.handle.dispose().catch(() => {})
          return
        }
        active = next
        agent = next.agent
        session = next.session
        store = next.store
        mentions = next.mentions
        subagents.reset()
        pendingMode = undefined
        pendingPermission = undefined
        commands.setAgent(agent)
        skills.setAgent(agent)
        // The App mounts with a placeholder key until the first input; the
        // key-change remount below must start from a clean screen or the ghost
        // static header stays visible above the new one (same source-backed
        // clear the session-switch path performs).
        process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
        renderCurrent()
        abortPendingControllers()
        epoch += 1
        const queued = pendingInputs.splice(0)
        for (const item of queued) deliverLine(item.text, item.mode, item.images)
      } finally {
        creating = false
      }
    }).catch((error: unknown) => {
      pendingInputs.length = 0
      bridge.notify(`session creation failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /** Deliver one readable line to the agent, expanding session mentions first. */
  const send = (text: string, mode: 'followup' | 'steer', images: readonly ImageBlock[] = []): void => {
    const line = text.trim()
    if (line === '' && images.length === 0) return
    if (images.length === 0 && line.startsWith('/mode ')) {
      void switchModeAction(line.slice(6).trim()).then(
        selected => bridge.notify(`mode → ${selected}`),
        error => bridge.notify(`mode switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
      )
      return
    }
    if (images.length === 0 && line.startsWith('/permission ')) {
      try {
        const selected = setPermissionAction(line.slice(12).trim())
        bridge.notify(`permission → ${selected}`)
      } catch (error: unknown) {
        bridge.notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      return
    }
    if (session === undefined) {
      pendingInputs.push({ text: line, mode, images })
      ensureSession()
      return
    }
    deliverLine(line, mode, images)
  }

  /** Dispatch one submitted line: slash commands to the registry, other text to the agent. */
  const dispatch = (text: string): void => {
    send(text, 'followup')
  }

  /**
   * Submit steering: a running driver consumes the text at its next step
   * boundary (the inbox delivers between steps); an idle driver just starts
   * a turn, so this doubles as the busy-state submit path.
   */
  const steer = (text: string): void => {
    send(text, 'steer')
  }

  /** Interrupt the running turn (Esc); true when a turn was actually cancelled. */
  const interrupt = (): boolean => {
    if (agent === undefined || agent.status !== 'running') return false
    try {
      agent.cancel({ kind: 'user' })
      bridge.notify('turn cancelled — Ctrl+C or /quit to exit')
      return true
    } catch (error: unknown) {
      bridge.notify(`cancel failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    }
  }

  /** Select one permission preset before the first session or on the active one. */
  const setPermissionAction = (id: string): string => {
    if (permissionPresets === undefined || permissionPresets.names.length === 0) {
      throw new Error('permission presets are not mounted in this composition')
    }
    if (id === '') throw new Error('usage: /permission <preset>')
    const selected = selectPermission(permissionPresets, session, id)
    if (session === undefined) {
      pendingPermission = selected
      renderCurrent()
    }
    return selected
  }

  /**
   * Cycle to the next permission preset (Shift+Tab). Before the first session,
   * the choice remains process-local and is materialized when Harness creates
   * that session; afterwards the canonical service writes durable events.
   */
  const cyclePermission = (): string => {
    if (permissionPresets === undefined || permissionPresets.names.length === 0) {
      bridge.notify('permission presets are not mounted in this composition', 'warning')
      return ''
    }
    try {
      const next = cyclePermissionPreset(permissionPresets, session, pendingPermission)
      if (session === undefined && next !== '') {
        pendingPermission = next
        renderCurrent()
      }
      return next
    } catch (error: unknown) {
      bridge.notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return ''
    }
  }

  /**
   * Apply one /model selection: takes effect from the next assembled step.
   * The optional reasoning effort must be one the row advertises (the picker
   * only offers those), so an unsupported value cannot reach the request
   * pipeline; an absent effort restores the model's own default.
   */
  const selectModel = (row: ModelRow, effortId?: string): string => {
    const selection = buildModelSelection(row, effortId)
    if (active === undefined) {
      // A bare launch has no session yet: keep the pick process-wide so the
      // first composed session starts from it.
      pendingSelection = selection
    } else {
      active.selection.picked = selection
    }
    // Global default (web selectModel parity): every pick is persisted as the
    // deployment default through the same agentDefaultModel service the web
    // host writes, so the choice survives restarts and other surfaces read
    // it. Save failures degrade to a notice — the in-session switch already
    // took effect and must not roll back (the web contract).
    void defaultModel.saveSelection(selection).catch((error: unknown) => {
      bridge.notify(`model switch applies to this session but was not saved as the default: ${error instanceof Error ? error.message : String(error)}`, 'warning')
    })
    // Advisory immediate validation (web selectModel parity): run the same
    // local resolveCallConfig check the request pipeline would, so a stale
    // directory — an effort the adapter withdrew since /model loaded —
    // surfaces as a pick-time notice instead of failing the next assembled
    // step. Best-effort: an llm service without the resolver keeps the
    // existing request-boundary rejection. Called as a method (`this`-bound)
    // like resolveModelInfo in models.ts.
    const llm = ctx.get('llm')
    const resolveCallConfig = (llm as {
      resolveCallConfig?: (this: unknown, config: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>
    } | undefined)?.resolveCallConfig
    if (llm !== undefined && typeof resolveCallConfig === 'function') {
      void Promise.resolve(resolveCallConfig.call(llm, {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })).catch((error: unknown) => {
        bridge.notify(`model selection rejected: ${error instanceof Error ? error.message : String(error)} — reopen /model to pick again`, 'error')
      })
    }
    return `${row.provider}/${row.model}`
  }

  /** The /subagent override label, '' when delegated agents follow the current model. */
  const subagentModelLabel = (): string => subagentOverride === undefined ? '' : modelSelectionLabel(subagentOverride)

  /** Apply one /subagent model pick; returns the override label. */
  const setSubagentModel = (row: ModelRow, effortId?: string): string => {
    subagentOverride = buildModelSelection(row, effortId)
    renderCurrent()
    return modelSelectionLabel(subagentOverride)
  }

  /** Drop the /subagent override: delegated agents follow the current model again. */
  const clearSubagentModel = (): void => {
    subagentOverride = undefined
    renderCurrent()
  }

  /**
   * Export the folded transcript to a markdown file (/export). The default
   * target sits beside the session's cwd so the file lands in the user's
   * workspace; an absolute or cwd-relative argument overrides it.
   */
  const exportTranscript = async (argument: string): Promise<void> => {
    if (session === undefined) {
      bridge.notify('no session yet — submit a message to start', 'warning')
      return
    }
    const wanted = argument.trim()
    const sessionCwd = session.header.cwd ?? cwd
    // The default name derives from the session id, which `--session` lets the
    // user spell freely: reduce it to filename-safe characters first so the
    // default target can never escape the session cwd.
    const defaultName = `dsh-session-${exportSessionIdSuffix(session.id)}.md`
    const target = wanted === ''
      ? join(sessionCwd, defaultName)
      : /^[a-zA-Z]:[\\/]/u.test(wanted) || wanted.startsWith('/')
        ? wanted
        : join(sessionCwd, wanted)
    const markdown = buildExportMarkdown(store.getView(), session.id)
    try {
      await writeFileAsync(target, `${markdown}\n`, 'utf8')
      bridge.notify(`exported to ${target}`)
    } catch (error: unknown) {
      bridge.notify(`export failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  /**
   * Rename the session (/title): a user title pins the session and stops
   * automatic generation (the service's own contract). The appended
   * `session/title` event flows back through the store into the status line.
   */
  const renameTitle = (argument: string): string => {
    const title = argument.trim()
    if (title === '') return 'usage: /title <text>'
    if (session === undefined) return 'no session yet — submit a message to start'
    const service = ctx.get('sessionTitle')
    if (service === undefined) return 'session titles are unavailable in this profile'
    try {
      service.rename(session, title)
      return `title → ${title}`
    } catch (error: unknown) {
      return `rename failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const loadSessions = async (options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const records = await sessionQuery.listSessions(signal)
    // Last-activity timestamps for sorting (codex UpdatedAt default): the
    // JSONL artifact's mtime via locate()+stat — the upstream api-proxy's own
    // cold-probe pattern. O(1) per session; backends without a location (or
    // vanished files) fall back to createdAt inside the projection.
    const updated = new Map<string, number>()
    for (const record of records) {
      const location = persistence?.locate(record.header)
      if (location === undefined) continue
      try {
        updated.set(record.header.id, (await stat(location.path)).mtimeMs)
      } catch {
        // Artifact gone or unreadable: the projection falls back to createdAt.
      }
    }
    const projected = projectSessionRows(records, options, updated)
    // Titles are the expensive fold. Fetch only the first bounded picker page;
    // navigation/filter changes trigger a fresh, cancellable observation.
    const page = projected.slice(0, 32)
    if (page.length === 0) return projected
    const observations = await sessionQuery.readTitleSnapshots(page.map(row => row.id), signal)
    return mergeSessionTitles(projected, observations)
  }

  /**
   * Delete one session subtree (/delete, codex semantics: subagent threads go
   * with their root). The kernel persistence seam has NO deletion API by
   * design — logs accumulate "until removed externally" — so this is the
   * controlled external removal: guards (live/current refusal, subtree
   * collection, and the JSONL layout check `encodeSegment(id)/session.jsonl`)
   * run before any filesystem touch, and only the backend-located artifacts
   * are removed. Backends without a locatable artifact (SQLite) are refused.
   * @param id - the root session id to delete.
   * @returns the outcome line for the panel/notice.
   */
  const deleteSession = async (id: string): Promise<string> => {
    if (sessionQuery === undefined) return 'session query is unavailable in this profile'
    if (session !== undefined && session.id === id) return 'cannot delete the session you are using — switch or /new first'
    const records = await sessionQuery.listSessions()
    const target = records.find(record => record.header.id === id)
    if (target === undefined) return `no persisted session matches "${id}"`
    if (target.live) return 'cannot delete a live session — it is open in this or another process'
    const doomed = collectDeletionSubtree(records, id)
    const byId = new Map<string, (typeof records)[number]>(records.map(record => [record.header.id, record]))
    let removed = 0
    for (const candidate of doomed) {
      const record = byId.get(candidate)
      if (record === undefined || record.live) continue
      const location = persistence?.locate(record.header)
      if (location === undefined) {
        return `session backend exposes no deletable artifact for ${candidate.slice(-12)} (deletion is unsupported on this backend)`
      }
      const dir = sessionArtifactDirectory(location.path, candidate)
      if (dir === undefined) {
        return `refusing to delete: unexpected artifact layout at ${location.path}`
      }
      try {
        for (const name of SESSION_ARTIFACT_NAMES) {
          await rm(join(dir, name), { force: true })
        }
        // Remove the now-empty session directory; a non-empty one stays (an
        // unexpected sibling file is never ours to delete).
        await rm(dir, { force: true, recursive: false }).catch(() => {})
        removed += 1
      } catch (error: unknown) {
        return `delete failed for ${candidate.slice(-12)}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return `deleted ${removed} session${removed === 1 ? '' : 's'}`
  }

  const loadSessionTranscript = async (id: string, signal?: AbortSignal): Promise<string> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const snapshot = await sessionQuery.readSession(id, signal)
    return buildExportMarkdown(createTranscriptStore(snapshot.events).getView(), snapshot.session.id)
  }

  const switchModeAction = async (id: string): Promise<string> => {
    if (id === '') throw new Error('usage: /mode <preset>')
    const currentAgent = agent
    if (currentAgent === undefined) {
      const choice = pendingModeWork.then(async () => {
        const preset = await selectPreset(presets, undefined, id)
        // A resume may have won while this roster read was in flight; never
        // leak the old pending choice into a later /new session.
        if (agent === undefined) {
          pendingMode = preset.id
          renderCurrent()
        }
        return preset.id
      })
      pendingModeWork = choice.then(() => {}, () => {})
      return choice
    }

    const preset = await selectPreset(presets, currentAgent, id)
    if (active === undefined) throw new Error('active Agent has no session state')
    active.mode = preset.id
    commands.setAgent(currentAgent)
    skills.setAgent(currentAgent)
    renderCurrent()
    return preset.id
  }

  interface PendingSwitch { readonly target: Target; readonly label: string }

  const activate = (nextTarget: Target): Promise<void> => {
    if (quitting) return Promise.resolve()
    // Serialized with every other composition (bare-launch creation, queued
    // switches): at most one agent is composed at a time.
    return compose(async () => {
      const previous = active
      const next = await prepare(nextTarget)
      // Quit landed while the next session was being composed: dispose the
      // half-ready agent and leave the current session untouched.
      if (quitting) {
        await next.handle.dispose().catch(() => {})
        return
      }
      active = next
      agent = next.agent
      session = next.session
      store = next.store
      mentions = next.mentions
      subagents.reset()
      pendingMode = undefined
      pendingPermission = undefined
      commands.setAgent(agent)
      skills.setAgent(agent)
      try {
        process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
        renderCurrent()
      } catch (error: unknown) {
        active = previous
        agent = previous?.agent
        session = previous?.session
        store = previous === undefined ? createTranscriptStore() : previous.store
        mentions = previous === undefined ? createMentions(ctx, undefined, cwd) : previous.mentions
        if (agent !== undefined) commands.setAgent(agent)
        if (agent !== undefined) skills.setAgent(agent)
        await next.handle.dispose()
        if (!quitting) renderCurrent()
        throw error
      }
      // From here the new session is live: in-flight prepares/commands for
      // the previous agent are stale and must be aborted and ignored.
      abortPendingControllers()
      epoch += 1
      // No previous session (a bare launch switched straight into a resume):
      // nothing to flush or dispose, so just confirm the activation.
      if (previous === undefined) {
        bridge.notify(`${next.resumed ? 'resumed' : 'created'} ${next.session.id.slice(-12)} · mode ${next.mode}`)
        return
      }
      let cleanupWarning: string | undefined
      try {
        await sessions.flush(previous.session)
      } catch (error: unknown) {
        cleanupWarning = `previous session flush failed: ${error instanceof Error ? error.message : String(error)}`
      }
      try {
        await previous.handle.dispose()
      } catch (error: unknown) {
        cleanupWarning = `${cleanupWarning === undefined ? '' : `${cleanupWarning}; `}previous agent release failed: ${error instanceof Error ? error.message : String(error)}`
      }
      bridge.notify(cleanupWarning === undefined
        ? `${next.resumed ? 'resumed' : 'created'} ${next.session.id.slice(-12)} · mode ${next.mode}`
        : `switched to ${next.session.id.slice(-12)}, but ${cleanupWarning}`,
      cleanupWarning === undefined ? 'info' : 'warning')
    })
  }

  const switchQueue = new SessionSwitchQueue<PendingSwitch>(
    async request => { if (!quitting) await activate(request.target) },
    error => bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
  )

  const requestSwitch = (request: PendingSwitch): void => {
    if (session === undefined) {
      // No session yet (a bare launch using /resume before any input): activate
      // the target directly — there is no running turn to wait on and nothing
      // to flush.
      void activate(request.target).catch((error: unknown) => {
        bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      return
    }
    if (request.target.sessionId === session.id) {
      bridge.notify('that session is already active', 'warning')
      return
    }
    const outcome = switchQueue.request(agent!, request)
    if (outcome === 'queued') {
      bridge.notify(`will switch to ${request.label} when the current turn finishes · /resume cancel to abort`)
    }
  }

  const resolveResumeId = async (wanted: string): Promise<string> => {
    if (wanted === '') throw new Error('usage: /resume <id|prefix>')
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const records = await sessionQuery.listSessions()
    const exact = records.filter(record => record.header.id === wanted)
    const matches = exact.length > 0 ? exact : records.filter(record => record.header.id.startsWith(wanted))
    if (matches.length === 0) throw new Error(`no session matches "${wanted}"`)
    if (matches.length > 1) throw new Error(`session prefix "${wanted}" is ambiguous (${matches.length} matches)`)
    const matched = matches[0]!
    // Same lineage gate as the CLI --resume path and the picker.
    if (isSubagentSession(matched.header)) {
      throw new Error('subagent conversations are read-only; resume a root session')
    }
    if (session !== undefined && agents.get(SessionId(matched.header.id)) !== undefined && matched.header.id !== session.id) {
      throw new Error('that session is already live in another owner')
    }
    return matched.header.id
  }

  const requestResume = (wanted: string): void => {
    void resolveResumeId(wanted).then(id => {
      requestSwitch({ target: { sessionId: id, resume: true }, label: id.slice(-12) })
    }, (error: unknown) => bridge.notify(`resume failed: ${error instanceof Error ? error.message : String(error)}`, 'error'))
  }

  const createSession = (mode?: string): void => {
    // /new before any input is the first-session creation itself, not a switch.
    if (session === undefined) {
      ensureSession(mode)
      return
    }
    const nextCwd = session.header.cwd ?? cwd
    const id = `session-${randomUUID()}`
    requestSwitch({ target: { sessionId: id, resume: false, mode, cwd: nextCwd }, label: id.slice(-12) })
  }

  const reviewChanges = (argument: string): void => {
    void loadGitDiff(session?.header.cwd ?? cwd, argument).then(({ title, files }) => {
      try {
        setPermissionAction('read-only')
      } catch (error: unknown) {
        bridge.notify(`review unavailable: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return
      }
      send(buildReviewPrompt(files.flatMap(file => file.lines).join('\n'), title), 'followup')
      bridge.notify('review started under read-only permissions')
    }, (error: unknown) => {
      bridge.notify(`review failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  const forkSession = (argument: string): void => {
    if (session === undefined || active === undefined) {
      bridge.notify('no session yet - submit a message to start', 'warning')
      return
    }
    try {
      const text = argument.trim()
      const atSeq = text === '' ? undefined : Number(text)
      if (text !== '' && (!Number.isSafeInteger(atSeq) || (atSeq ?? -1) < 0)) {
        throw new Error('usage: /fork [event-seq]')
      }
      const seed = selectForkSeed(session.events, atSeq)
      const id = `session-${randomUUID()}`
      requestSwitch({
        target: {
          sessionId: id,
          resume: false,
          mode: active.mode,
          cwd: session.header.cwd ?? cwd,
          seed: seed.events,
          parentSession: session.id,
          seedLength: seed.events.length,
        },
        label: id.slice(-12),
      })
    } catch (error: unknown) {
      bridge.notify(`fork failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const switchSession = (row: SessionRow): void => {
    if (!row.resumable) {
      bridge.notify('subagent conversations are read-only', 'warning')
      return
    }
    requestSwitch({ target: { sessionId: row.id, resume: true }, label: row.title ?? row.id.slice(-12) })
  }

  const cancelSessionSwitch = (): boolean => {
    return switchQueue.cancel()
  }

  const appElement = (): ReturnType<typeof createElement> => {
    // A bare launch mounts with pending/default model, mode, and permission
    // facts until the first input composes the real session. These choices stay
    // process-local and create no durable state before that composition.
    const sessionCwd = session?.header.cwd ?? cwd
    const currentView = store.getView()
    const defaults = currentDefaults()
    const model = currentView.model !== ''
      ? currentView.model
      : pendingSelection !== undefined
        ? `${pendingSelection.provider}/${pendingSelection.model}`
        : `${defaults.provider}/${defaults.model}`
    const effort = resolveEffectiveSelection(
      active?.selection.picked ?? pendingSelection,
      session?.requestHeader()?.config,
      defaults,
    ).reasoningEffort
    const permission = permissionPresets === undefined
      ? currentView.permission
      : effectivePermission(permissionPresets, session, pendingPermission)
    return createElement(App, {
      key: session?.id ?? 'pending',
      store,
      approval,
      questions,
      subagents,
      commands,
      skills,
      model,
      effort,
      cwd: basename(sessionCwd),
      workspaceRoot: sessionCwd,
      branch: gitBranch(sessionCwd),
      sessionId: session === undefined ? '' : session.id.slice(-8),
      resumed: active?.resumed ?? false,
      mode: active?.mode ?? pendingMode ?? presets.defaultId,
      permission,
      dispatch,
      steer,
      interrupt,
      quit,
      loadModels: () => loadModelDirectory(ctx),
      loadModelProviders: () => loadProviderSettings(ctx),
      subscribeModelProviders: listener => subscribeProviderSettings(ctx, listener),
      saveModelProviderCredential: (target, key) => saveProviderCredential(ctx, target, key),
      saveModelProviderConfiguration: (target, configuration) => saveProviderConfiguration(ctx, target, configuration),
      unsetModelProviderCredential: target => unsetProviderCredential(ctx, target),
      removeModelProvider: target => removeProviderSettings(ctx, target),
      loadMentions: (query: string, signal?: AbortSignal) => mentions.candidates(query, signal),
      cyclePermission,
      setPermission: setPermissionAction,
      selectModel,
      subagentModel: subagentModelLabel(),
      setSubagentModel,
      clearSubagentModel,
      deleteSession,
      exportTranscript,
      renameTitle,
      copyLastResponse,
      loadGitDiff: (argument: string) => loadGitDiff(session?.header.cwd ?? cwd, argument),
      reviewChanges,
      loadPresets: () => presets.list(),
      switchMode: switchModeAction,
      loadPermissions: () => permissionPresets === undefined
        ? Promise.reject(new Error('permission presets are not mounted in this composition'))
        : Promise.resolve(listPermissionRows(permissionPresets)),
      createSession,
      forkSession,
      loadSessions,
      loadSessionTranscript,
      loadSubagents: () => {
        const current = session
        if (current === undefined || sessionQuery === undefined) return Promise.resolve([])
        return loadSessions({ sessions: 'all', cwd: 'all', sort: 'newest', currentCwd: current.header.cwd ?? cwd, query: '' })
          .then(rows => rows.filter(row => row.parent === current.id && row.subagent))
      },
      switchSession,
      cancelSessionSwitch,
      loadPlugins: () => listPluginRows(ctx),
      loadJobs: () => listJobs(ctx, active?.agent),
      statusline: statuslineItems,
      saveStatusline,
      saveTheme,
      history: inputHistory,
      recordHistory,
      cancelQueued,
      onBridgeReady: (instance: AppBridge) => { bridge.notify = instance.notify },
    })
  }

  const renderCurrent = (): void => {
    mountRef.current?.rerender(appElement())
  }

  mountRef.current = io.mount(appElement())

  // Startup prompt/images use the same durable delivery path as composer
  // submissions. Image bytes are committed before the user/message event.
  if (startup.prompt !== undefined || (startup.images?.length ?? 0) > 0) {
    void saveImagePaths(startup.images ?? [], ctx.get('attachments')).then(
      images => send(startup.prompt ?? '', 'followup', images),
      (error: unknown) => bridge.notify(`initial prompt failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
    )
  }

  async function copyLastResponse(): Promise<string> {
    const text = latestAssistantText(store.getView())
    if (text === undefined) return 'nothing to copy yet'
    await copyText(text)
    return 'copied latest response'
  }

  // A corrupt statusline config must not vanish silently: surface it once
  // the notice channel is live, after the first frame settles.
  if (statuslineWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('statusline config unreadable, using defaults: ' + statuslineWarning, 'warning')
    }, 50)
  }
  // Same one-shot surface for a corrupt theme file (dark fallback stays live).
  if (themeWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('theme config unreadable, using dark: ' + themeWarning, 'warning')
    }, 50)
  }
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config resolved from the tuiStartup provider.
 */
export function apply(ctx: Context, config: Config): void {
  // The CLI validated --theme at parse time; the loose config schema falls
  // back to dark for anything unexpected.
  const theme = config.startup.theme === undefined ? undefined : parseThemeName(config.startup.theme)
  const input = {
    ...(theme === undefined ? {} : { theme }),
    ...(config.startup.prompt === undefined ? {} : { prompt: config.startup.prompt }),
    ...(config.startup.images === undefined ? {} : { images: config.startup.images }),
  }
  const startup: TuiStartup =
    config.startup.kind === 'resume' && config.startup.sessionId !== undefined
      ? { kind: 'resume', sessionId: config.startup.sessionId, ...input }
      : config.startup.kind === 'latest'
        ? { kind: 'latest', ...input }
        : config.startup.kind === 'named' && config.startup.sessionId !== undefined
          ? { kind: 'named', sessionId: config.startup.sessionId, ...config.startup.mode === undefined ? {} : { mode: config.startup.mode }, ...input }
          : { kind: 'fresh', ...config.startup.mode === undefined ? {} : { mode: config.startup.mode }, ...input }
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { mount: internals.mount, exit }
  void run(ctx, startup, io).catch((error: unknown) => { fail(io, error) })
}
