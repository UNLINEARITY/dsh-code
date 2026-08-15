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
import { writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
import { loadModelDirectory, type ModelRow } from './models.ts'
import { createMentions, type MentionsApi } from './mentions.ts'
import { mountQuestionProvider, type QuestionStore } from './questions.ts'
import { createTranscriptStore } from './store.ts'
import { watchSkills, type SkillsView } from './skills.ts'
import { toolArgumentsPreview } from './render/tool-preview.ts'
import { buildExportMarkdown } from './render/export.ts'
import type { TuiStartup } from './startup.ts'
import { SessionSwitchQueue } from './session-switch.ts'
import { agentPresetsFrom, resolvePreset, switchPreset } from './presets.ts'
import { listPluginRows } from './plugin-inventory.ts'
import {
  mergeSessionTitles,
  projectSessionRows,
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
  startup: { kind: string; sessionId?: string; mode?: string }
}

export const Config: z<Config> = z.object({
  startup: z.object({
    kind: z.string().required(),
    sessionId: z.string(),
    mode: z.string(),
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
}

/**
 * Resolve the invocation's target session against the persisted headers.
 * @param startup - the parsed startup flags.
 * @param persistence - the persistence service; required for resume/latest.
 * @param cwd - the working directory `--continue` filters by.
 * @returns the target identity.
 * @throws with a user-facing message when the flags name nothing resolvable.
 */
async function resolveTarget(startup: TuiStartup, persistence: SessionPersistence | undefined, cwd: string): Promise<Target> {
  if (startup.kind === 'fresh') return { sessionId: `session-${randomUUID()}`, resume: false, mode: startup.mode }
  if (startup.kind === 'named') return { sessionId: startup.sessionId, resume: false, mode: startup.mode }
  if (persistence === undefined) {
    throw new Error('cannot resolve the requested session: session persistence is not configured')
  }
  const headers: readonly SessionHeader[] = await persistence.list()
  if (startup.kind === 'resume') {
    const wanted = startup.sessionId
    const exact = headers.filter(header => header.id === wanted)
    const matches = exact.length > 0 ? exact : headers.filter(header => header.id.startsWith(wanted))
    if (matches.length === 0) throw new Error(`no persisted session matches "${wanted}"`)
    if (matches.length > 1) {
      throw new Error(`session prefix "${wanted}" is ambiguous (${matches.length} matches): use more of the id`)
    }
    return { sessionId: matches[0]!.id, resume: true }
  }
  // --continue: the newest persisted session whose header pins this cwd.
  const local = headers
    .filter(header => header.cwd === cwd)
    .sort((left, right) => right.createdAt - left.createdAt)
  if (local.length === 0) throw new Error(`no persisted session for this directory (${cwd}); start one without --continue`)
  return { sessionId: local[0]!.id, resume: true }
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
  const target = await resolveTarget(startup, persistence, cwd)
  const defaults = defaultModel.currentSelection()
  const presets = agentPresetsFrom(ctx)
  if (presets === undefined) throw new Error('agent preset service is unavailable; check the dsh-code bundle patch')

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
    const selectionState: { picked?: ModelSelection } = {}
    let mode = next.mode
    if (!next.resume) mode = (await presets.resolve(mode)).id
    const setup = async (agentCtx: Context): Promise<void> => {
      const sessionPreset = next.resume
        ? resolvePreset(agentCtx.agent!.session)
        : mode
      const mounted = await presets.mount(agentCtx, sessionPreset)
      mode = mounted.id
      const selection: ModelSelectionRef = {
        get current(): ModelSelection | undefined {
          if (selectionState.picked !== undefined) return selectionState.picked
          const logged = agentCtx.agent?.session.requestHeader()?.config
          if (logged !== undefined) {
            return {
              provider: logged.provider,
              model: logged.model,
              ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
            }
          }
          return defaults
        },
        set current(value: ModelSelection | undefined) { selectionState.picked = value },
        assembled: undefined,
      }
      installModelSelection(agentCtx, selection)
    }
    const handle = next.resume
      ? await agents.resume({
        resumeSessionId: SessionId(next.sessionId),
        agentOptions: { provider: defaults.provider, model: defaults.model },
        setup,
      })
      : await agents.create({
        sessionId: SessionId(next.sessionId),
        meta: { cwd: nextCwd, agentPreset: mode },
        agentOptions: { provider: defaults.provider, model: defaults.model },
        setup,
      })
    const session = handle.agent.session
    const sessionCwd = session.header.cwd ?? nextCwd
    return {
      handle,
      agent: handle.agent,
      session,
      store: createTranscriptStore(session.events),
      mentions: createMentions(ctx, handle.agent, sessionCwd),
      mode: mode ?? 'standard',
      selection: selectionState,
      resumed: next.resume,
    }
  }

  let active = await prepare(target)
  let agent = active.agent
  let session = active.session
  let store = active.store
  let mentions = active.mentions

  // Seed the transcript from the full session log: constructor seeds never
  // fire on `session/event`, so a resumed session paints its history once,
  // here, before the first render.
  const off = ctx.on('session/event', (subject: Session, event: SessionEvent) => {
    if (subject.id === session.id) store.apply(event)
  })

  const commands: CommandsView = watchCommands(ctx)
  commands.setAgent(agent)

  const skills: SkillsView = watchSkills(ctx)
  skills.setAgent(agent)

  // Approval answerer: renders the ask as a y/n bar; only this TUI's agent is
  // claimed, every other ask falls through to the fail-closed waterfall.
  const approval: ApprovalStore = mountApprovalAnswerer(
    ctx,
    candidate => candidate.id === agent.id,
    request => approvalCommandPreview(store.getView().entries, request.callId, request.toolName),
  )

  // ask_user_question provider: the single UI provider on the shared service,
  // one request on screen at a time. Plan reviews (exit_plan_mode) arrive
  // through this same pipe.
  const questions: QuestionStore = mountQuestionProvider(ctx)

  // The bridge the React app registers on mount: local notices from the
  // process side (unknown commands, switch confirmations, cancels).
  const bridge: AppBridge = { notify: () => {} }

  // The mount handle lives in a box: quit closes over it, while the mount
  // itself is created after quit (the App element needs quit as a prop).
  const mountRef: { current?: TuiMount } = {}
  let quitting = false
  const quit = (): void => {
    if (quitting) return
    quitting = true
    switchQueue.cancel()
    off()
    mountRef.current?.unmount()
    void sessions.flush(session)
      .catch((flushError: unknown) => {
        // The session log already carries every durable event; a failed flush
        // must not trap the user in a dead terminal, so report and still exit.
        internals.stderr.write(`dsh: session flush failed: ${flushError instanceof Error ? flushError.message : String(flushError)}\n`)
      })
      .then(() => active.handle.dispose())
      .catch((disposeError: unknown) => {
        internals.stderr.write(`dsh: agent disposal failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}\n`)
      })
      .then(() => { io.exit(0) })
  }

  /** Run one slash line through the command registry (closed namespace). */
  const runSlash = (line: string): void => {
    if (line.startsWith('/mode ')) {
      void switchModeAction(line.slice(6).trim())
      return
    }
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
    void Promise.resolve().then(() => registry.execute(agent, line, controller.signal)).then((execution) => {
      if (execution === undefined) {
        // No command owns this line: send it verbatim so a user-invocable
        // skill gesture (`/skill-name`) reaches the host's tool-skill
        // pre-step injection — the web composer's same fall-through.
        try {
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: line }],
            source: { kind: 'user' },
          }))
        } catch (error: unknown) {
          bridge.notify(`command fallback failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      }
    }, (error: unknown) => {
      bridge.notify(`command failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /** Deliver one readable line to the agent, expanding session mentions first. */
  const send = (text: string, mode: 'followup' | 'steer'): void => {
    const line = text.trim()
    if (line === '') return
    // The command registry is a closed namespace: slash lines run out of
    // band and never reach the model through this path (steering keeps the
    // registry out of the inbox, so slash lines steer as literal text).
    if (isSlashLine(line) && mode === 'followup') {
      runSlash(line)
      return
    }
    let parsed: ReturnType<typeof mentions.parse>
    try {
      parsed = mentions.parse(line)
    } catch (error: unknown) {
      bridge.notify(`invalid session reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    const deliver = (readable: string, context?: UserMessage): void => {
      // Session snapshots ride the inbox as model-facing context ahead of
      // the readable message (upstream README wiring: inject before the
      // followup/steer that wakes the driver).
      try {
        if (context !== undefined) agent.inject(context)
        const message = createUserMessage({
          content: [{ type: 'text', text: readable }],
          source: { kind: 'user' },
        })
        if (mode === 'steer') {
          agent.steer(message)
          bridge.notify('steering queued — the next step sees it')
        } else {
          agent.followup(message)
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
    void mentions.prepare(parsed, controller.signal).then((prepared) => {
      deliver(prepared.text, prepared.additionalContext)
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      bridge.notify(`session reference failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
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
    if (agent.status !== 'running') return false
    try {
      agent.cancel({ kind: 'user' })
      bridge.notify('turn cancelled — Ctrl+C or /quit to exit')
      return true
    } catch (error: unknown) {
      bridge.notify(`cancel failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    }
  }

  /**
   * Cycle to the next permission preset (Shift+Tab, the Claude-Code
   * permission-mode convention mapped onto dsh presets). A session in a
   * custom knob state wraps to the first declared preset.
   */
  const cyclePermission = (): string => {
    const service = ctx.get('permissionPresets') as
      | {
        names: readonly string[]
        current(events: readonly SessionEvent[]): string
        set(target: Session, preset: string): void
      }
      | undefined
    if (service === undefined || service.names.length === 0) {
      bridge.notify('permission presets are not mounted in this composition', 'warning')
      return ''
    }
    const at = service.names.indexOf(service.current(session.events))
    const next = service.names[(at + 1) % service.names.length] ?? ''
    if (next === '') return ''
    try {
      service.set(session, next)
      return next
    } catch (error: unknown) {
      bridge.notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return ''
    }
  }

  /** Apply one /model selection: takes effect from the next assembled step. */
  const selectModel = (row: ModelRow): string => {
    active.selection.picked = { provider: row.provider, model: row.model }
    return `${row.provider}/${row.model}`
  }

  /**
   * Export the folded transcript to a markdown file (/export). The default
   * target sits beside the session's cwd so the file lands in the user's
   * workspace; an absolute or cwd-relative argument overrides it.
   */
  const exportTranscript = async (argument: string): Promise<void> => {
    const wanted = argument.trim()
    const sessionCwd = session.header.cwd ?? cwd
    const defaultName = `dsh-session-${session.id.slice(-8)}.md`
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
    const projected = projectSessionRows(await sessionQuery.listSessions(signal), options)
    // Titles are the expensive fold. Fetch only the first bounded picker page;
    // navigation/filter changes trigger a fresh, cancellable observation.
    const page = projected.slice(0, 32)
    if (page.length === 0) return projected
    const observations = await sessionQuery.readTitleSnapshots(page.map(row => row.id), signal)
    return mergeSessionTitles(projected, observations)
  }

  const loadSessionTranscript = async (id: string, signal?: AbortSignal): Promise<string> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const snapshot = await sessionQuery.readSession(id, signal)
    return buildExportMarkdown(createTranscriptStore(snapshot.events).getView(), snapshot.session.id)
  }

  const switchModeAction = async (id: string): Promise<string> => {
    if (id === '') throw new Error('usage: /mode <preset>')
    const preset = await switchPreset(presets, agent, id)
    active.mode = preset.id
    commands.setAgent(agent)
    skills.setAgent(agent)
    renderCurrent()
    return preset.id
  }

  interface PendingSwitch { readonly target: Target; readonly label: string }

  const activate = async (nextTarget: Target): Promise<void> => {
    const previous = active
    const next = await prepare(nextTarget)
    active = next
    agent = next.agent
    session = next.session
    store = next.store
    mentions = next.mentions
    commands.setAgent(agent)
    skills.setAgent(agent)
    try {
      process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
      renderCurrent()
    } catch (error: unknown) {
      active = previous
      agent = previous.agent
      session = previous.session
      store = previous.store
      mentions = previous.mentions
      commands.setAgent(agent)
      skills.setAgent(agent)
      await next.handle.dispose()
      renderCurrent()
      throw error
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
  }

  const switchQueue = new SessionSwitchQueue<PendingSwitch>(
    async request => { if (!quitting) await activate(request.target) },
    error => bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
  )

  const requestSwitch = (request: PendingSwitch): void => {
    if (request.target.sessionId === session.id) {
      bridge.notify('that session is already active', 'warning')
      return
    }
    const outcome = switchQueue.request(agent, request)
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
    if (matches[0]!.header.parentSession !== undefined || matches[0]!.header.origin === 'subagent') {
      throw new Error('subagent conversations are read-only in /resume; resume a root session')
    }
    if (agents.get(SessionId(matches[0]!.header.id)) !== undefined && matches[0]!.header.id !== session.id) {
      throw new Error('that session is already live in another owner')
    }
    return matches[0]!.header.id
  }

  const requestResume = (wanted: string): void => {
    void resolveResumeId(wanted).then(id => {
      requestSwitch({ target: { sessionId: id, resume: true }, label: id.slice(-12) })
    }, (error: unknown) => bridge.notify(`resume failed: ${error instanceof Error ? error.message : String(error)}`, 'error'))
  }

  const createSession = (mode?: string): void => {
    const nextCwd = session.header.cwd ?? cwd
    const id = `session-${randomUUID()}`
    requestSwitch({ target: { sessionId: id, resume: false, mode, cwd: nextCwd }, label: id.slice(-12) })
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
    const sessionCwd = session.header.cwd ?? cwd
    const model = store.getView().model !== '' ? store.getView().model : `${defaults.provider}/${defaults.model}`
    return createElement(App, {
      key: session.id,
      store,
      approval,
      questions,
      commands,
      skills,
      model,
      cwd: basename(sessionCwd),
      workspaceRoot: sessionCwd,
      branch: gitBranch(sessionCwd),
      sessionId: session.id.slice(-8),
      resumed: active.resumed,
      mode: active.mode,
      dispatch,
      steer,
      interrupt,
      quit,
      loadModels: () => loadModelDirectory(ctx),
      loadMentions: mentions.candidates,
      cyclePermission,
      selectModel,
      exportTranscript,
      renameTitle,
      loadPresets: () => presets.list(),
      switchMode: switchModeAction,
      createSession,
      loadSessions,
      loadSessionTranscript,
      switchSession,
      cancelSessionSwitch,
      loadPlugins: () => listPluginRows(ctx),
      onBridgeReady: (instance: AppBridge) => { bridge.notify = instance.notify },
    })
  }

  const renderCurrent = (): void => {
    mountRef.current?.rerender(appElement())
  }

  mountRef.current = io.mount(appElement())
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config resolved from the tuiStartup provider.
 */
export function apply(ctx: Context, config: Config): void {
  const startup: TuiStartup =
    config.startup.kind === 'resume' && config.startup.sessionId !== undefined
      ? { kind: 'resume', sessionId: config.startup.sessionId }
      : config.startup.kind === 'latest'
        ? { kind: 'latest' }
        : config.startup.kind === 'named' && config.startup.sessionId !== undefined
          ? { kind: 'named', sessionId: config.startup.sessionId, ...config.startup.mode === undefined ? {} : { mode: config.startup.mode } }
          : { kind: 'fresh', ...config.startup.mode === undefined ? {} : { mode: config.startup.mode } }
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { mount: internals.mount, exit }
  void run(ctx, startup, io).catch((error: unknown) => { fail(io, error) })
}
