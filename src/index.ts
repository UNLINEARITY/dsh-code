/**
 * @deepseek-ai/dsh-code — the interactive terminal driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates (or resumes) one Agent through the core registry, mounts the Ink
 * app (DeepSeek blue, whale wordmark), folds submitted prompts into the same
 * durable session, answers approval asks with a y/n bar, dispatches slash
 * commands through the shared registry, and on quit flushes and requests
 * process exit.
 *
 * @module @deepseek-ai/dsh-code
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { App } from './app.ts'
import { mountApprovalAnswerer, type ApprovalStore } from './approval.ts'
import { isSlashLine, watchCommands, type CommandsView } from './commands.ts'
import { internals, type TuiMount } from './internals.ts'
import { loadModelDirectory, type ModelRow } from './models.ts'
import { createTranscriptStore } from './store.ts'
import { watchSkills, type SkillsView } from './skills.ts'
import type { TuiStartup } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the startup resolved from this app's injected provider service. */
export interface Config {
  /** How this invocation obtains its session identity (validated loosely; narrowed in {@link apply}). */
  startup: { kind: string; sessionId?: string }
}

export const Config: z<Config> = z.object({
  startup: z.object({
    kind: z.string().required(),
    sessionId: z.string(),
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
  if (startup.kind === 'fresh') return { sessionId: `session-${randomUUID()}`, resume: false }
  if (startup.kind === 'named') return { sessionId: startup.sessionId, resume: false }
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
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['command', 'cmd', 'description', 'path', 'pattern', 'query']) {
        const value = record[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
  } catch {
    // Raw JSON parse failed: fall through to the bounded raw arguments.
  }
  return args.length > 80 ? `${args.slice(0, 77)}...` : args === '' ? toolName : args
}

/** The runner's connection between the React app and the process side. */
interface AppBridge {
  /** Post one local notice line (feedback the transcript does not carry). */
  notify(text: string): void
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
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const cwd = process.cwd()
  const target = await resolveTarget(startup, persistence, cwd)

  const defaults = defaultModel.currentSelection()
  let picked: ModelSelection | undefined
  let session: Session
  let agent: Agent
  if (target.resume) {
    const resumed = await agents.resume({
      resumeSessionId: SessionId(target.sessionId),
      agentOptions: { provider: defaults.provider, model: defaults.model },
      setup: (agentCtx) => {
        // The getter order mirrors the web host's resume selection: an
        // in-process switch wins, then the session's own last logged request
        // header, then the deployment default. Without this, a resumed
        // session's first request would silently fall back to the default.
        const selection: ModelSelectionRef = {
          get current(): ModelSelection | undefined {
            if (picked !== undefined) return picked
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
          set current(next: ModelSelection | undefined) {
            picked = next
          },
          assembled: undefined,
        }
        installModelSelection(agentCtx, selection)
      },
    })
    agent = resumed.agent
    session = agent.session
  } else {
    const created = await agents.create({
      sessionId: SessionId(target.sessionId),
      meta: { cwd },
      agentOptions: { provider: defaults.provider, model: defaults.model },
      setup: (agentCtx) => {
        // Same getter shape as resume, minus the logged-header arm (a fresh
        // session has no request header yet).
        const selection: ModelSelectionRef = {
          get current(): ModelSelection | undefined {
            return picked ?? defaults
          },
          set current(next: ModelSelection | undefined) {
            picked = next
          },
          assembled: undefined,
        }
        installModelSelection(agentCtx, selection)
      },
    })
    agent = created.agent
    session = agent.session
  }

  // Seed the transcript from the full session log: constructor seeds never
  // fire on `session/event`, so a resumed session paints its history once,
  // here, before the first render.
  const store = createTranscriptStore(session.events)
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
    off()
    mountRef.current?.unmount()
    void sessions.flush(session)
      .catch((flushError: unknown) => {
        // The session log already carries every durable event; a failed flush
        // must not trap the user in a dead terminal, so report and still exit.
        internals.stderr.write(`dsh: session flush failed: ${flushError instanceof Error ? flushError.message : String(flushError)}\n`)
      })
      .then(() => { io.exit(0) })
  }

  /** Dispatch one submitted line: slash commands to the registry, other text to the agent. */
  const dispatch = (text: string): void => {
    const line = text.trim()
    if (line === '') return
    if (isSlashLine(line)) {
      const registry = ctx.get('commands')
      if (registry === undefined) {
        bridge.notify('no command registry is mounted in this composition')
        return
      }
      const controller = new AbortController()
      void registry.execute(agent, line, controller.signal).then((execution) => {
        if (execution === undefined) {
          // No command owns this line: send it verbatim so a user-invocable
          // skill gesture (`/skill-name`) reaches the host's tool-skill
          // pre-step injection — the web composer's same fall-through.
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: line }],
            source: { kind: 'user' },
          }))
        }
      }, (error: unknown) => {
        bridge.notify(`command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'user' },
    }))
  }

  /**
   * Submit steering: a running driver consumes the text at its next step
   * boundary (the inbox delivers between steps); an idle driver just starts
   * a turn, so this doubles as the busy-state submit path.
   */
  const steer = (text: string): void => {
    const line = text.trim()
    if (line === '') return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'user' },
    }))
    bridge.notify('steering queued — the next step sees it')
  }

  /** Interrupt the running turn (Esc); true when a turn was actually cancelled. */
  const interrupt = (): boolean => {
    if (agent.status !== 'running') return false
    agent.cancel({ kind: 'user' })
    bridge.notify('turn cancelled — Ctrl+C or /quit to exit')
    return true
  }

  /** Apply one /model selection: takes effect from the next assembled step. */
  const selectModel = (row: ModelRow): string => {
    picked = { provider: row.provider, model: row.model }
    return `${row.provider}/${row.model}`
  }

  const initialModel = store.getView().model !== ''
    ? store.getView().model
    : `${defaults.provider}/${defaults.model}`

  mountRef.current = io.mount(createElement(App, {
    store,
    approval,
    commands,
    skills,
    model: initialModel,
    cwd: basename(cwd),
    branch: gitBranch(cwd),
    sessionId: session.id.slice(-8),
    resumed: target.resume,
    dispatch,
    steer,
    interrupt,
    quit,
    loadModels: () => loadModelDirectory(ctx),
    selectModel,
    onBridgeReady: (instance: AppBridge) => {
      bridge.notify = instance.notify
    },
  }))
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
          ? { kind: 'named', sessionId: config.startup.sessionId }
          : { kind: 'fresh' }
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { mount: internals.mount, exit }
  void run(ctx, startup, io).catch((error: unknown) => { fail(io, error) })
}
