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
import { homedir } from 'node:os'
import { writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId, SessionLogOffset, type Session, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
// Type-only: carries the ctx.sessionTitle service merge for /title.
import type {} from '@deepseek-ai/dsh-session-title'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { App } from './app.ts'
import type { NoticeTone, QueueMutation } from './ui/ui-contract.ts'
import { planCycleDecision } from './runner/mode-cycle.ts'
export { planCycleDecision, type ModeCycleDecision } from './runner/mode-cycle.ts'
import { runQuitSequence, type QuitCleanupStep } from './runner/quit.ts'
export { runQuitSequence, type QuitCleanupStep } from './runner/quit.ts'
import { exportSessionIdSuffix, resolveTarget, type Target } from './runner/session-target.ts'
export { exportSessionIdSuffix, resolveTarget } from './runner/session-target.ts'
import {
  applyQueueMutation,
  cancelPreservingQueue,
  StartupInputGate,
  submissionBelongsToSession,
} from './runner/submissions.ts'
export {
  applyQueueMutation,
  cancelPreservingQueue,
  queueEditContent,
  StartupInputGate,
  submissionBelongsToSession,
  type QueuedSubmission,
  type QueueMutationOutcome,
} from './runner/submissions.ts'
import { mountApprovalAnswerer, type ApprovalStore } from './approval.ts'
import { isSlashLine, submissionPayload, watchCommands, type CommandsView } from './commands.ts'
import { internals, type TuiMount } from './internals.ts'
import { syncModelCapabilities } from './model-capabilities.ts'
import { buildModelSelection, applyModelSelectionToConfig, loadModelDirectory, modelSelectionLabel, pendingModelSelection, resolveEffectiveSelection, type ModelRow } from './models.ts'
import {
  discoverProviderModels,
  loadProviderSettings,
  removeProviderSettings,
  saveProviderCredential,
  saveProviderConfiguration,
  subscribeProviderSettings,
  unsetProviderCredential,
} from './provider-settings.ts'
import { createMentions, type MentionsApi } from './mentions.ts'
import { mountQuestionProvider, type QuestionStore } from './questions.ts'
// Type-only import merges the settings Events declarations ('settings/updated',
// 'settings/document-updated') into this program's Cordis bus typing.
import type {} from '@deepseek-ai/dsh-settings'
import { createTranscriptStore, type TranscriptStore } from './session/store.ts'
import { createSubagentFeed, subagentCatalogSeed, type SubagentFeedView } from './session/subagents.ts'
export { subagentCatalogSeed } from './session/subagents.ts'
import { parseStatuslineItems } from './render/status.ts'
import { watchSkills, type SkillsView } from './skills.ts'
import { toolArgumentsPreview } from './render/tool-preview.ts'
import { buildExportMarkdown } from './render/export.ts'
import { inspectFilePaths, inspectImagePaths, saveFilePaths, saveImagePaths } from './attachments.ts'
import { copyText, latestAssistantText } from './editor.ts'
import { applyCtrlRPassthrough, resolveEditorKeysStartupHint, type EditorKeysEnv } from './editor-keys.ts'
import {
  beginProviderAuthorization,
  cancelProviderAuthorization,
  loadProviderAuthorizations,
  logoutProviderAuthorization,
  openAuthorizationUrl,
  subscribeProviderAuthorizations,
} from './authorization.ts'
import { selectForkSeed } from './session/fork.ts'
import { gitBranch } from './git-workflow.ts'
import {
  buildReviewPrompt,
  listReviewBranches,
  listReviewCommits,
  loadCommitDiff,
  loadGitDiff,
  mergeBaseWith,
  type ReviewSelection,
} from './git-workflow.ts'
import type { TuiStartup } from './startup.ts'
import { SessionSwitchQueue } from './session/session-switch.ts'
import { agentPresetsFrom, normalizePresetId, resolvePreset, selectPreset } from './presets.ts'
import {
  applyPendingPermission,
  effectivePermission,
  listPermissionRows,
  permissionPresetsFrom,
  selectPermission,
} from './permissions.ts'
import { listPluginRows } from './plugin-inventory.ts'
import { applyLauncherUpdate, probeLauncherUpdate } from './update.ts'
import { parseAnimationsPref } from './render/animations.ts'
import { parseThemeName, setTheme, type ThemeName } from './theme.ts'
import { parseLanguageName, setLanguage, t, type LanguageName } from './i18n.ts'
import {
  isSubagentSession,
  type SessionQueryService,
  type SessionRow,
} from './session/session-directory.ts'
import type { JobRow } from './panels/kernel-panels.ts'
import { searchHitToRow, type SearchRow } from './runner/search-rows.ts'
export { searchHitToRow } from './runner/search-rows.ts'
import { createUserSettingsPersistence } from './settings-file.ts'
import { preferencePath, readPreference, savePreference } from './runner/preferences.ts'
import { createInputHistory } from './runner/input-history.ts'
import { createSessionIo } from './runner/session-io.ts'
import { EXPECTED_HARNESS_VERSION, probeRunningHarness, requireHarnessVersion } from './runner/harness-gate.ts'
import { resolveStartupConfig } from './runner/startup-config.ts'
import { turnUsages, type UsageView } from './render/usage.ts'
// Type-only import: merges the projection registry into the Context type so
// `ctx.get('sessionProjections')` is typed (the service itself is mounted by
// dsh-base at runtime).
import type {} from '@deepseek-ai/dsh-session-projection'

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
  exit: (code: number) => void
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
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
function listJobs(ctx: Context, caller: Agent | undefined): readonly JobRow[] {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return []
  try {
    return jobs.list(caller).map((job: JobSnapshot) => ({
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
  notify: (text: string, tone?: NoticeTone) => void
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
    /**
     * Root-log `subagent/catalog` facts (resume path): constructor seeds
     * never fire on the live bus, so activation replays them into the
     * subagent feed after its reset — a resumed session's children stay
     * visible instead of vanishing behind a restart.
     */
    catalogSeed: readonly SessionEvent<'subagent/catalog'>[]
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
    // An explicit `--mode` or the settings-layer service default may still name
    // an id an upstream rename retired (code → ptc); normalize both.
    if (!next.resume) mode = (await presets.resolve(normalizePresetId(mode ?? presets.defaultId))).id
    // 0.1.5 AgentSetup passes the composed agent as its second argument (the
    // former `ctx.agent` accessor is gone); the preset mount still needs the
    // agent-scoped context.
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      const sessionPreset = next.resume
        ? resolvePreset(agent.session)
        : mode
      const mounted = await presets.mount(agentCtx, sessionPreset)
      mode = mounted.id
      const selection: ModelSelectionRef = {
        get current(): ModelSelection | undefined {
          return resolveEffectiveSelection(selectionState.picked, agent.session.requestHeader()?.config, currentDefaults())
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
          ...(next.origin === undefined ? {} : { origin: next.origin }),
          // 0.1.5 fork lineage: the seed marker lives on the metadata and the
          // inherited prefix length on the top-level option (the v0 header's
          // numeric `seedLength` field is gone from the create contract).
          ...(next.seedLength === undefined ? {} : { isSeeded: true }),
        },
        ...(next.seedLength === undefined ? {} : { inheritedEventCount: SessionLogOffset(next.seedLength) }),
        ...(next.seed === undefined ? {} : { seed: next.seed }),
        agentOptions: seedOptions,
        signal: quitAbort.signal,
        setup,
      })
    const session = handle.agent.session
    if (!next.resume && permissionPresets !== undefined) {
      applyPendingPermission(permissionPresets, session, pendingPermission)
    }
    const seedEvents = session.snapshotEvents()
    // Resume precedence, middle layer: the log's unconsumed `model/selection`
    // (a pick the web host recorded that no request ever assembled) outranks
    // the older request header; an in-process pick still outranks both.
    if (next.resume && selectionState.picked === undefined) {
      const pending = pendingModelSelection(seedEvents)
      if (pending !== undefined) selectionState.picked = pending
    }
    return {
      handle,
      agent: handle.agent,
      session,
      store: createTranscriptStore(seedEvents),
      mentions: createMentions(ctx, handle.agent, session.header.cwd ?? nextCwd),
      mode: mode ?? 'standard',
      selection: selectionState,
      resumed: next.resume,
      catalogSeed: subagentCatalogSeed(seedEvents),
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
   * Plan-mode choice made before the first session exists: materialized as a
   * /plan registry command delivered ahead of the first queued input when the
   * session composes, so the first assembled step already plans.
   */
  let pendingPlan = false
  /**
   * In-flight mid-session plan choice from the Shift+Tab cycle. Upstream
   * queues a plan switch during an open turn (and the command pipeline is
   * async even idle), so the committed plan/mode fold lags the press that
   * chose it; the cycle reads this intent until the durable event lands,
   * then the session/event funnel clears it.
   */
  let planIntent: boolean | undefined
  /**
   * Whether the pre-session effective preset composes plan mode, answered by
   * the presets service composition inventory (minimal does not). Cached and
   * refreshed whenever the pending mode moves; unknown reads as unavailable
   * so one keypress at most lands before the answer arrives.
   */
  let preSessionPlanAvailable = false
  let preSessionPlanKnown = false
  const refreshPreSessionPlan = (): void => {
    if (presets === undefined) {
      preSessionPlanAvailable = false
      preSessionPlanKnown = true
      return
    }
    preSessionPlanKnown = false
    void presets.compositionInventory().then(inventory => {
      const id = pendingMode ?? normalizePresetId(presets.defaultId)
      preSessionPlanAvailable = inventory.some(composition => composition.id === id
        && composition.rows.some(row => row.moduleName === '@deepseek-ai/dsh-plan-mode' && row.enabled !== false))
      preSessionPlanKnown = true
    }, () => {
      preSessionPlanAvailable = false
      preSessionPlanKnown = true
    })
  }
  refreshPreSessionPlan()
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
    // Replayed catalog facts rebuild the resumed session's child rows before
    // the first render (the live handler only folds events from now on).
    for (const event of prepared.catalogSeed) subagents.apply(event.data.childId, event)
  }

  // Seed the transcript from the full session log: constructor seeds never
  // fire on `session/event`, so a resumed session paints its history once
  // before the first render. The handler reads the current session/store, so
  // the deferred first session of a bare launch is covered by the same feed.
  const off = ctx.on('session/event', (subject: Session, event: SessionEvent) => {
    if (session === undefined) return
    if (subject.id === session.id) {
      store.apply(event)
      // The committed plan fold caught up (or diverged via a typed /plan or
      // an approved plan review): the durable event is the live truth again,
      // so the cycle's in-flight intent retires.
      if (event.type === 'plan/mode') planIntent = undefined
      // The parent-owned subagent catalog rides the ROOT log (0.1.5); each
      // fact describes one child, so it feeds that child's live row.
      if (event.type === 'subagent/catalog' && event.data.childId !== '') subagents.apply(event.data.childId, event)
      return
    }
    // Child sessions (subagent conversations this root spawned) fold into
    // the bounded live-activity feed, never the transcript: the root stays
    // the only durable transcript truth while a running subagent remains
    // visible. Lineage comes from the child header, same field the session
    // directory uses to tag `↳` rows.
    if (subject.header.parentSession === session.id && subject.header.origin === 'subagent') subagents.apply(subject.id, event)
  })

  // Live assistant typing (session-log v2+): durable logs are settlement-only,
  // so the streaming tails ride the process-local `agent/assistant-stream`
  // frames of the current root agent. Settlement events clear the tails when
  // they land (always before a committed end frame); an abandoned attempt's
  // partial tail is dropped by the store on its end frame.
  ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
    if (agent === undefined || source.id !== agent.id) return
    store.applyStreamFrame(frame)
  })

  const commands: CommandsView = watchCommands(ctx)
  if (agent !== undefined) commands.setAgent(agent)

  const skills: SkillsView = watchSkills(ctx, cwd)
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
    // Only the ACTIVE session's explicit pick may steer a subagent request.
    // During a switch window the old agent can still be mid-flight; routing
    // it by the NEW session's pick sent one of its requests to the wrong
    // model. A subject outside the active tree falls back to its own request
    // header (plus any explicit /subagent override, which is user intent).
    const activeAgent = active
    const belongsToActive = activeAgent !== undefined
      && (header.parentSession ?? subject.session.id) === activeAgent.session.id
    const picked = subagentOverride
      ?? resolveEffectiveSelection(
        belongsToActive && activeAgent !== undefined ? (activeAgent.selection.picked ?? pendingSelection) : undefined,
        subject.session.requestHeader()?.config,
        currentDefaults(),
      )
    return next().then(resolved => applyModelSelectionToConfig(resolved, picked))
  })

  // ask_user_question answerer: one waterfall listener, one request on
  // screen at a time. Plan reviews (exit_plan_mode) arrive through this same
  // pipe; sibling answerers stay usable through the claim/defer split.
  const questions: QuestionStore = mountQuestionProvider(
    ctx,
    candidate => agent !== undefined && candidate.id === agent.id,
  )

  // The bridge the React app registers on mount: local notices from the
  // process side (unknown commands, switch confirmations, cancels).
  const bridge: AppBridge = { notify: () => {} }

  // Same-id capability inheritance. Catalog capabilities flow by route key,
  // not model id, so a hand-declared relay model without an explicit
  // reasoningEfforts declaration serves no reasoning levels and offers no
  // effort picker. This background pass materializes declarations from
  // same-id donors (sibling settings entries first, then other routes'
  // advertised levels) over the panel's settings.mutate path, where the
  // upstream serviceability gate still rejects invalid writes atomically.
  // The debounce coalesces the settings/adapters event pair; the applier
  // skips only a same-source same-revision echo of its own write, so the
  // loop converges without ever ignoring a real external edit.
  const capabilitySyncDebounceMs = 400
  const runCapabilitySync = (): void => {
    void syncModelCapabilities(ctx, bridge.notify)
  }
  let capabilitySyncTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleCapabilitySync = (): void => {
    if (capabilitySyncTimer !== undefined) clearTimeout(capabilitySyncTimer)
    capabilitySyncTimer = setTimeout(() => {
      capabilitySyncTimer = undefined
      runCapabilitySync()
    }, capabilitySyncDebounceMs)
  }
  const offCapabilitySync = [
    ctx.on('settings/document-updated', scheduleCapabilitySync),
    ctx.on('llm/adapters-updated', scheduleCapabilitySync),
  ]
  scheduleCapabilitySync()

  // /statusline persistence: one user-level JSON file under the DSH home.
  // Missing file means defaults; a corrupt file degrades to defaults with a
  // surfaced warning (the customization is user-authored, never silent).
  const statuslinePath = preferencePath('statusline.json')
  const statuslineRead = readPreference(statuslinePath, 'items', parseStatuslineItems)
  const statuslineWarning: string | undefined = statuslineRead.warning
  let statuslineItems: readonly string[] = statuslineRead.value ?? parseStatuslineItems(undefined)
  // Serialized, crash-atomic writes for the user-level JSON files: the chain
  // orders rapid consecutive saves (the LAST snapshot wins on disk), each
  // write goes through a sibling temp file + rename, and quit waits for the
  // flush exactly like it waits for the recall history.
  const settingsPersistence = createUserSettingsPersistence()
  const saveStatusline = (items: readonly string[]): void => {
    statuslineItems = [...items]
    savePreference(settingsPersistence, statuslinePath, 'items', items, message => {
      bridge.notify(t('notice.statuslineSaveFailed', { message }), 'error')
    })
  }

  // /vscode-keys: detect the hosting editor's user keybindings.json and pass
  // Ctrl+R through the workbench. One marker file under the DSH home keeps
  // the startup hint a once-per-install event.
  const editorKeysEnv: EditorKeysEnv = {
    env: process.env,
    paths: { homedir: homedir(), appdata: process.env.APPDATA, platform: process.platform },
    flagPath: preferencePath('editor-keys.json'),
  }
  const applyEditorKeys = (): Promise<string> => applyCtrlRPassthrough(editorKeysEnv)

  // /theme persistence: one user-level JSON file under the DSH home, mirroring
  // the statusline file. A missing file means the dark default; a corrupt file
  // degrades to dark with a surfaced warning. Precedence: CLI --theme > file >
  // auto detection > dark (auto detection itself is a later enhancement and
  // currently falls back to dark inside theme.ts).
  const themePath = preferencePath('theme.json')
  let themeWarning: string | undefined
  if (startup.theme === undefined) {
    const read = readPreference(themePath, 'theme', parseThemeName)
    themeWarning = read.warning
    // A missing or corrupt file leaves theme.ts on its own dark default.
    if (read.value !== undefined) setTheme(read.value)
  } else {
    setTheme(startup.theme)
  }
  const saveTheme = (name: ThemeName): void => {
    setTheme(name)
    savePreference(settingsPersistence, themePath, 'theme', name, message => {
      bridge.notify(t('notice.themeSaveFailed', { message }), 'error')
    })
  }

  // /language persistence: one user-level JSON file beside theme.json. A
  // missing file means English; a corrupt file degrades to English with a
  // surfaced warning.
  const languagePath = preferencePath('language.json')
  const languageRead = readPreference(languagePath, 'language', parseLanguageName)
  const languageWarning: string | undefined = languageRead.warning
  // A missing or corrupt file leaves i18n on its own English default.
  if (languageRead.value !== undefined) setLanguage(languageRead.value)
  const saveLanguage = (name: LanguageName): void => {
    setLanguage(name)
    savePreference(settingsPersistence, languagePath, 'language', name, message => {
      bridge.notify(t('notice.languageSaveFailed', { message }), 'error')
    })
  }

  // /animation persistence: one user-level JSON file under the DSH home,
  // mirroring the theme file. A missing file means animations are on; a
  // corrupt file degrades to on with a surfaced warning. Only an explicit
  // `false` disables (parseAnimationsPref), so hand-edited or partial files
  // never silently freeze the UI.
  const animationsPath = preferencePath('animations.json')
  // A literal `null` file reads as corruption and surfaces a warning, instead
  // of a property access on `null`.
  const animationsRead = readPreference(animationsPath, 'animations', parseAnimationsPref)
  const animationsWarning: string | undefined = animationsRead.warning
  const animationsEnabled = animationsRead.value ?? true
  const saveAnimations = (enabled: boolean): void => {
    savePreference(settingsPersistence, animationsPath, 'animations', enabled, message => {
      bridge.notify(t('notice.animationsSaveFailed', { message }), 'error')
    })
  }

  // Global input recall (Codex composer-history contract): one JSONL file
  // under the DSH home. A missing file means an empty history; unreadable or
  // corrupt content degrades to the valid lines it could parse, silently —
  // recall is a convenience surface, never a gate.
  const inputHistory = createInputHistory(preferencePath('history.jsonl'), message => {
    bridge.notify(t('notice.historySaveFailed', { message }), 'error')
  })

  /** Mutate one next-turn inbox item; durable inbox splices remain the UI truth. */
  const updateQueued = (messageId: string, action: QueueMutation): void => {
    const current = agent
    if (current === undefined) return
    try {
      const outcome = applyQueueMutation(
        current.inbox,
        current.status,
        messageId,
        action,
        message => current.steer(message),
      )
      switch (outcome) {
        case 'removed': bridge.notify(t('notice.queueCancelled')); return
        case 'edited': bridge.notify(t('notice.queueEdited')); return
        case 'steered': bridge.notify(t('notice.queueSteered')); return
        case 'empty': bridge.notify(t('notice.queueEditEmpty'), 'warning'); return
        case 'steerUnavailable': bridge.notify(t('notice.queueSteerUnavailable'), 'warning'); return
        case 'unavailable': bridge.notify(t('notice.queueUnavailable'), 'warning'); return
      }
    } catch (error: unknown) {
      bridge.notify(t('notice.queueActionFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
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
    for (const dispose of offCapabilitySync) dispose()
    if (capabilitySyncTimer !== undefined) clearTimeout(capabilitySyncTimer)
    const currentSession = session
    const currentActive = active
    const report = (name: string, error: unknown): void => {
      internals.stderr.write(`dsh: quit ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    // A throwing unmount must not strand the terminal (stdin tap alive,
    // keyboard protocol stacks unpopped) or skip the exit sequence below.
    try {
      mountRef.current?.unmount()
    } catch (error: unknown) {
      report('unmount', error)
    }
    // One ordered cleanup: settle the visible session (if any — a bare launch
    // that never composed one resolves immediately), then wait for the final
    // in-flight composition (its work swallows errors and the quitting guard
    // disposes any half-prepared agent), then flush the durable recall and
    // the queued user-level settings writes, then request exit. `composing`
    // and `historyWriteChain` are read at step run
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
      { name: 'history', run: () => inputHistory.flush() },
      { name: 'settings', run: () => settingsPersistence.flush() },
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
      bridge.notify(t('notice.commandRegistryMissing'), 'error')
      return
    }
    const controller = new AbortController()
    const atEpoch = epoch
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // 0.1.5 registry.execute's third parameter admits submitted attachments
    // (images and file receipts); the TUI composer never attaches images to a
    // slash line, so every invocation is the empty batch (commands declaring
    // input.attachments still run attachment-free).
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
          bridge.notify(t('notice.commandFallbackFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
        }
      }
    }, (error: unknown) => {
      finish()
      if (epoch !== atEpoch || agent !== currentAgent) return
      // A failed plan switch never appends the plan/mode event the cycle's
      // intent retirement waits for, so the in-flight choice dies here too —
      // otherwise every later Shift+Tab reads a phantom plan state.
      if (line === '/plan' || line === '/plan off') planIntent = undefined
      bridge.notify(t('notice.commandFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  /** Delivery serialization state: the chain's epoch pins it to one session. */
  let deliveryChain: { epoch: number; tail: Promise<void> } = { epoch: 0, tail: Promise.resolve() }

  /** Deliver one trimmed line to the live session, expanding mentions first. */
  const deliverLine = (line: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    const currentAgent = agent!
    const currentMentions = mentions
    // The command registry is a closed namespace: slash lines run out of
    // band and never reach the model through this path.
    if (images.length === 0 && isSlashLine(line)) {
      runSlash(line)
      return
    }
    let parsed: ReturnType<MentionsApi['parse']>
    try {
      parsed = currentMentions.parse(line)
    } catch (error: unknown) {
      bridge.notify(t('notice.invalidReference', { message: error instanceof Error ? error.message : String(error) }), 'error')
      return
    }
    // Ordered delivery: the inbox order IS the user's message order. A line
    // with session mentions prepares asynchronously, and a later plain line
    // used to deliver synchronously past it. Every line now waits for the
    // previous line of the same session; an epoch change (switch/quit)
    // abandons the chain instead of gating the next session on the old one.
    if (deliveryChain.epoch !== epoch) deliveryChain = { epoch, tail: Promise.resolve() }
    const enqueueDelivery = (run: () => void): void => {
      deliveryChain.tail = deliveryChain.tail.then(run)
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
        // Steering is consumed at the next step boundary of the turn already
        // running; a followup becomes its own turn instead.
        if (mode === 'steer') currentAgent.steer(message)
        else currentAgent.followup(message)
      } catch (error: unknown) {
        bridge.notify(t('notice.messageFailed', { kind: mode === 'steer' ? 'steering' : 'message', message: error instanceof Error ? error.message : String(error) }), 'error')
      }
    }
    if (parsed.references.length === 0) {
      enqueueDelivery(() => deliver(parsed.text))
      return
    }
    const controller = new AbortController()
    pendingControllers.add(controller)
    // `enqueueDelivery` returns nothing; the delivery chain only orders the
    // work, so the promise is consumed here with an explicit void.
    enqueueDelivery(() => {
      void currentMentions.prepare(parsed, controller.signal).then((prepared) => {
        pendingControllers.delete(controller)
        deliver(prepared.text, prepared.additionalContext)
      }, (error: unknown) => {
        pendingControllers.delete(controller)
        if (controller.signal.aborted || epoch !== atEpoch) return
        bridge.notify(t('notice.referenceFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
      })
    })
  }

  // Deferred first-session creation for a bare launch: the session is composed
  // only when the user submits real input (or /new), and every line that
  // arrives during creation is delivered in order afterwards. A creation
  // failure reports and clears the queue, leaving the transient state ready
  // for the next attempt.
  const pendingInputs: Array<{ text: string; mode: 'followup' | 'steer'; images: readonly ContentBlock[] }> = []
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
          for (const item of queued) deliverLine(item.text, item.images, item.mode)
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
        const previous = { active, agent, session, store, mentions }
        try {
          active = next
          agent = next.agent
          session = next.session
          store = next.store
          mentions = next.mentions
          subagents.reset()
          for (const event of next.catalogSeed) subagents.apply(event.data.childId, event)
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
        } catch (error: unknown) {
          // The session composed but the screen handoff threw (stdout EPIPE,
          // a render-time failure). Roll the published state back exactly
          // like the switch path does — otherwise the runner reports "session
          // creation failed" while the new session is actually live, clears
          // the queued inputs, and every later line lands in the ghost. The
          // queued inputs are KEPT for the next attempt.
          active = previous.active
          agent = previous.agent
          session = previous.session
          store = previous.store === undefined ? createTranscriptStore() : previous.store
          mentions = previous.mentions === undefined ? createMentions(ctx, undefined, cwd) : previous.mentions
          if (agent !== undefined) {
            commands.setAgent(agent)
            skills.setAgent(agent)
          }
          await next.handle.dispose().catch(() => {})
          if (!quitting) renderCurrent()
          bridge.notify(t('notice.activationFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
          return
        }
        abortPendingControllers()
        epoch += 1
        const queued = pendingInputs.splice(0)
        if (pendingPlan) {
          pendingPlan = false
          // A pre-session plan choice materializes as the registry command
          // delivered AHEAD of the queued lines, so the first assembled step
          // of the user's opening message already runs in plan mode.
          deliverLine('/plan')
        }
        for (const item of queued) deliverLine(item.text, item.images, item.mode)
      } finally {
        creating = false
      }
    }).catch((error: unknown) => {
      pendingInputs.length = 0
      bridge.notify(t('notice.creationFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  /** Deliver one readable line to the agent, expanding session mentions first. */
  const sendNow = (text: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    // Blank check on the trimmed form; the payload itself keeps the draft's
    // exact whitespace unless the line is a syntactic slash command.
    const line = submissionPayload(text)
    if (line.trim() === '' && images.length === 0) return
    // A switch between the idle wait and the handoff keeps the OLD session
    // installed: a line delivered now would start a turn the handoff discards.
    // Refusing loudly beats losing it silently — the caller can retry after the
    // switch, and `switchQueue.cancel()` is the way out.
    if (switchQueue.activating) {
      bridge.notify(t('notice.switchInProgress'), 'warning')
      return
    }
    if (images.length === 0 && line.startsWith('/mode ')) {
      void switchModeAction(line.slice(6).trim()).then(
        selected => bridge.notify(t('notice.modeChanged', { value: selected })),
        error => bridge.notify(t('notice.modeChangeFailed', { message: error instanceof Error ? error.message : String(error) }), 'error'),
      )
      return
    }
    if (images.length === 0 && line.startsWith('/permission ')) {
      try {
        const selected = setPermissionAction(line.slice(12).trim())
        bridge.notify(t('notice.permissionChanged', { value: selected }))
      } catch (error: unknown) {
        bridge.notify(t('notice.permissionChangeFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
      }
      return
    }
    if (session === undefined) {
      // The delivery mode rides the buffered line: a steer picked before the
      // first session exists must still steer once that session composes.
      pendingInputs.push({ text: line, mode, images })
      ensureSession()
      return
    }
    deliverLine(line, images, mode)
  }

  // Startup serialization: input submitted while the startup prompt/images
  // are still preparing queues behind the initial request.
  const inputGate = new StartupInputGate(({ text, mode, images }) => sendNow(text, images, mode))
  const send = (text: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    inputGate.submit({ text, mode, images })
  }

  /** Dispatch one submitted line: slash commands to the registry, other text to the agent. */
  const dispatch = (text: string, images: readonly ContentBlock[] = [], origin?: string): void => {
    // An attachment prepare resolved after the app remounted onto another
    // session (queued switch): the composing session is gone, so the stale
    // delivery is dropped instead of landing in the new session's inbox.
    if (!submissionBelongsToSession(origin, session?.id)) return
    send(text, images)
  }

  /**
   * Deliver one line as steering: a running driver consumes it at its next
   * step boundary, an idle one starts a turn with it. The composer's Tab
   * toggle picks this over {@link dispatch} for the next submission.
   */
  const steer = (text: string, images: readonly ContentBlock[] = [], origin?: string): void => {
    if (!submissionBelongsToSession(origin, session?.id)) return
    send(text, images, 'steer')
  }

  /**
   * Interrupt the running turn (Esc); true when a turn was actually
   * cancelled. {@link cancelPreservingQueue} keeps the next-turn queue alive
   * AND re-wakes the driver, so the preserved messages run instead of
   * parking; next-step steering dies with the turn.
   */
  const interrupt = (): boolean => {
    if (agent === undefined || agent.status !== 'running') return false
    try {
      const preserved = cancelPreservingQueue(agent)
      bridge.notify(t(preserved > 0 ? 'notice.turnCancelledKeepQueue' : 'notice.turnCancelled'))
      return true
    } catch (error: unknown) {
      bridge.notify(t('notice.cancelFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
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
   * Shift+Tab mode cycle: permission presets in table order, then the plan
   * station when the composition offers the /plan command (preset-mounted,
   * so minimal sessions and the pre-session state cycle permissions only).
   * Plan transitions submit the upstream registry command — it stays the
   * single owner of plan state; the TUI renders the durable plan/mode event
   * it appends. Because that event lags the press (upstream queues the
   * switch during an open turn), each mid-session plan decision records the
   * choice in `planIntent` and the next press reads it back, so the cycle
   * advances stations instead of re-issuing one transition. Returns the
   * notice label, or '' when nothing changed.
   */
  const cycleMode = (): string => {
    if (permissionPresets === undefined || permissionPresets.names.length === 0) {
      bridge.notify(t('notice.permissionPresetsUnmounted'), 'warning')
      return ''
    }
    try {
      // Pre-session the plan station rides the pending choice; once a
      // session exists the scoped /plan command descriptor decides, and the
      // durable plan/mode event is the live truth.
      const preSession = session === undefined
      if (preSession && !preSessionPlanKnown) refreshPreSessionPlan()
      const decision = planCycleDecision({
        names: permissionPresets.names,
        current: effectivePermission(permissionPresets, session, pendingPermission),
        inPlan: preSession ? pendingPlan : store.getView().plan === true,
        ...(preSession ? {} : { planIntent }),
        planAvailable: preSession ? preSessionPlanAvailable : commands.descriptors.some(descriptor => descriptor.name === 'plan'),
      })
      if (decision === undefined) return ''
      if (decision.kind === 'permission') {
        const next = selectPermission(permissionPresets, session, decision.preset)
        if (preSession) {
          pendingPermission = next
          renderCurrent()
        }
        return `permission → ${next}`
      }
      if (decision.kind === 'plan-on') {
        // Plan IS the most restrictive preset plus the plan prompt layer:
        // the cycle arrives here from that preset, so permission needs no
        // switch — only the plan mode itself toggles.
        if (preSession) {
          pendingPlan = true
          renderCurrent()
          return 'plan → on (applies to the first session)'
        }
        planIntent = true
        send('/plan')
        return 'plan → on'
      }
      // Leaving plan lands on the station after the most restrictive
      // preset (workspace-write with the shipped table).
      if (preSession) {
        pendingPlan = false
        pendingPermission = decision.preset
        renderCurrent()
        return `plan → off · permission → ${decision.preset}`
      }
      planIntent = false
      send('/plan off')
      selectPermission(permissionPresets, session, decision.preset)
      return `plan → off · permission → ${decision.preset}`
    } catch (error: unknown) {
      bridge.notify(t('notice.modeChangeFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
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
      bridge.notify(t('notice.modelNotDefault', { message: error instanceof Error ? error.message : String(error) }), 'warning')
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
        bridge.notify(t('notice.modelSelectionRejected', { message: error instanceof Error ? error.message : String(error) }), 'error')
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
      bridge.notify(t('notice.noSessionYet'), 'warning')
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
      bridge.notify(t('notice.exported', { path: target }))
    } catch (error: unknown) {
      bridge.notify(t('notice.exportFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
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


  const { loadSessions, deleteSession, loadSessionTranscript } = createSessionIo({
    sessionQuery,
    persistence,
    activeSessionId: () => session?.id,
  })

  /**
   * Read one session's usage blocks for the /usage panel: the mounted
   * projection's session totals plus the meter's own per-turn fold over the
   * durable log (which the panel merges by model). A deployment without the
   * projection registry renders the totals as explicitly unavailable rather
   * than as zeros. The read is synchronous — the registry materializes a cell
   * on first touch — so it is handed to the panel behind a resolved promise,
   * which keeps the fold out of the keystroke that opens the panel.
   * @param current - the session to read, or undefined before the first one.
   * @returns the resolved panel data.
   */
  const loadUsage = (current: Session | undefined): Promise<UsageView> => {
    if (current === undefined) return Promise.resolve({ turns: [] })
    const values = ctx.get('sessionProjections')?.snapshot(current, ['tokenUsage']).values
    return Promise.resolve({
      totals: values?.tokenUsage,
      turns: turnUsages(current.snapshotEvents(), deriveTurnTokenUsage),
    })
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


    // Serialize the recomposition with session activations: a /mode that
    // interleaves a switch must not rebind the shared command/skill
    // registries while the switch is composing the next agent.
    const currentActive = active
    const atEpoch = epoch
    let selected: string | undefined
    await compose(async () => {
      const preset = await selectPreset(presets, currentAgent, id)
      // A switch/quit landed while the recomposition ran: applying here
      // would write the old choice into the new session's state and rebind
      // the registries back to a disposed agent. The preset-selection log
      // entry rode the old agent's session; only the local application is
      // dropped.
      if (epoch !== atEpoch || agent !== currentAgent || active !== currentActive) {
        throw new Error('session changed while switching mode — nothing applied; retry in the active session')
      }
      if (active === undefined) throw new Error('active Agent has no session state')
      active.mode = preset.id
      commands.setAgent(currentAgent)
      skills.setAgent(currentAgent)
      selected = preset.id
      renderCurrent()
    })
    return selected!
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
      commands.setAgent(agent)
      skills.setAgent(agent)
      try {
        // Reseed the feed BEFORE the first frame of the new session so no
        // stale row from the previous one flashes; a rolled-back handoff
        // re-seeds the previous session's catalog the same way.
        subagents.reset()
        for (const event of next.catalogSeed) subagents.apply(event.data.childId, event)
        process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
        renderCurrent()
        // Only a successful handoff may clear the transient per-session
        // surfaces: a rolled-back switch keeps the previous session's
        // subagent feed plus the user's pre-session /mode and permission
        // picks (the bare-launch promise: explicit choices survive until
        // composition takes them). The in-flight cycle intent belonged to
        // the previous session's presses; the new session's committed fold
        // decides from here.
        pendingMode = undefined
        pendingPermission = undefined
        pendingPlan = false
        planIntent = undefined
      } catch (error: unknown) {
        active = previous
        agent = previous?.agent
        session = previous?.session
        store = previous === undefined ? createTranscriptStore() : previous.store
        mentions = previous === undefined ? createMentions(ctx, undefined, cwd) : previous.mentions
        if (agent !== undefined) commands.setAgent(agent)
        if (agent !== undefined) skills.setAgent(agent)
        subagents.reset()
        if (previous !== undefined) {
          for (const event of previous.catalogSeed) subagents.apply(event.data.childId, event)
        }
        // The failed handoff disposed the incoming session; the restored
        // store's committed plan fold is the truth, so any cycle intent
        // collected against the switch churn retires too.
        planIntent = undefined
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
        // The key-change remount above swaps the App in this same synchronous
        // continuation; the new App registers its bridge.notify in a passive
        // effect AFTER it, so an immediate notice reaches the UNMOUNTED
        // instance and React drops it silently. Defer past the commit.
        setTimeout(() => {
          bridge.notify(t(next.resumed ? 'notice.sessionResumed' : 'notice.sessionCreated', {
            id: next.session.id.slice(-12),
            mode: next.mode,
          }))
        }, 0)
        return
      }
      let cleanupWarning: string | undefined
      try {
        await sessions.flush(previous.session)
      } catch (error: unknown) {
        cleanupWarning = t('notice.flushFailed', { message: error instanceof Error ? error.message : String(error) })
      }
      try {
        await previous.handle.dispose()
      } catch (error: unknown) {
        const release = t('notice.agentReleaseFailed', { message: error instanceof Error ? error.message : String(error) })
        cleanupWarning = cleanupWarning === undefined ? release : `${cleanupWarning}; ${release}`
      }
      const shortId = next.session.id.slice(-12)
      bridge.notify(cleanupWarning === undefined
        ? t(next.resumed ? 'notice.sessionResumed' : 'notice.sessionCreated', { id: shortId, mode: next.mode })
        : t('notice.sessionSwitchedDirty', { id: shortId, detail: cleanupWarning }),
      cleanupWarning === undefined ? 'info' : 'warning')
    })
  }

  const switchQueue = new SessionSwitchQueue<PendingSwitch>(
    async request => { if (!quitting) await activate(request.target) },
    error => bridge.notify(t('notice.sessionSwitchFailed', { message: error instanceof Error ? error.message : String(error) }), 'error'),
  )

  const requestSwitch = (request: PendingSwitch): void => {
    if (session === undefined) {
      // No session yet (a bare launch using /resume before any input): activate
      // the target directly — there is no running turn to wait on and nothing
      // to flush.
      void activate(request.target).catch((error: unknown) => {
        bridge.notify(t('notice.sessionSwitchFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
      })
      return
    }
    if (request.target.sessionId === session.id) {
      bridge.notify(t('notice.alreadyActive'), 'warning')
      return
    }
    const outcome = switchQueue.request(agent!, request)
    if (outcome === 'queued') {
      bridge.notify(t('notice.switchQueued', { label: request.label }))
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
    const matched = matches[0]
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
    }, (error: unknown) => bridge.notify(t('notice.resumeFailed', { message: error instanceof Error ? error.message : String(error) }), 'error'))
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

  const reviewChanges = (selection: ReviewSelection): void => {
    // Works from a bare launch too: with no session yet the read-only
    // choice goes to pendingPermission (materialized when the first
    // session composes) and the review prompt queues behind that
    // creation exactly like a typed first submission. The identity guard
    // below still aborts a load that outlives a mid-flight switch —
    // including one landing on an undefined agent.
    const currentAgent = agent
    // The diff loads from the CALLING session's cwd; capture that
    // workspace and this turn's identity so a switch mid-load can neither
    // flip the new session read-only nor send the old workspace's review
    // into it. The controller rides pendingControllers, so a switch/quit
    // kills the git subprocess itself instead of only ignoring its result.
    const atEpoch = epoch
    const reviewCwd = session?.header.cwd ?? cwd
    const controller = new AbortController()
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // Branch reviews diff from the precomputed merge base (what would
    // actually land), commit reviews the commit's own patch, everything
    // else reviews the uncommitted working tree.
    const load = selection.kind === 'commit'
      ? loadCommitDiff(reviewCwd, selection.sha, controller.signal)
      : selection.kind === 'base-branch'
        ? mergeBaseWith(reviewCwd, selection.branch, controller.signal)
          .then(base => loadGitDiff(reviewCwd, base ?? selection.branch, controller.signal))
        : loadGitDiff(reviewCwd, '', controller.signal)
    const note = selection.kind === 'custom' ? selection.instructions : undefined
    void load.then(({ title, files }) => {
      finish()
      if (controller.signal.aborted || epoch !== atEpoch || agent !== currentAgent) return
      try {
        setPermissionAction('read-only')
      } catch (error: unknown) {
        bridge.notify(t('notice.reviewUnavailable', { message: error instanceof Error ? error.message : String(error) }), 'error')
        return
      }
      send(buildReviewPrompt(files.flatMap(file => file.lines).join('\n'), title, note))
      bridge.notify(t('notice.reviewStarted'))
    }, (error: unknown) => {
      finish()
      if (controller.signal.aborted || epoch !== atEpoch) return
      bridge.notify(t('notice.reviewFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  const forkSession = (argument: string): void => {
    if (session === undefined || active === undefined) {
      bridge.notify(t('notice.noSessionYet'), 'warning')
      return
    }
    try {
      const text = argument.trim()
      const atSeq = text === '' ? undefined : Number(text)
      if (text !== '' && (!Number.isSafeInteger(atSeq) || (atSeq ?? -1) < 0)) {
        throw new Error('usage: /fork [event-seq]')
      }
      const seed = selectForkSeed(session.snapshotEvents(), atSeq)
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
      bridge.notify(t('notice.forkFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    }
  }

  const switchSession = (row: SessionRow): void => {
    if (!row.resumable) {
      bridge.notify(t('notice.subagentsReadOnly'), 'warning')
      return
    }
    requestSwitch({ target: { sessionId: row.id, resume: true }, label: row.title ?? row.id.slice(-12) })
  }

  // /search reads the SAME in-process engine the model's session_search
  // tools use (the bundle's skip-tolerant subclass). The row may be disabled
  // by a deployment; /search then degrades to a notice instead of a panel.
  const searchSessions = sessionQuery === undefined
    ? undefined
    : async (query: string, signal?: AbortSignal): Promise<readonly SearchRow[]> => {
      const page = await sessionQuery.searchSessions({ query, limit: 30 }, signal === undefined ? undefined : { signal })
      const rows = page.items.map(hit => searchHitToRow(hit))
      // Best-effort title enrichment (the same snapshots /resume merges):
      // a failure keeps the short-id labels instead of failing the search.
      try {
        const observations = await sessionQuery.readTitleSnapshots(rows.map(row => row.id), signal)
        const titles = new Map<string, string>()
        for (const observation of observations) {
          if (observation.status !== 'fulfilled') continue
          const title = observation.value?.title?.title
          if (title !== undefined && title.trim() !== '') titles.set(observation.sessionId, title)
        }
        return rows.map(row => titles.has(row.id) ? { ...row, label: titles.get(row.id)! } : row)
      } catch {
        return rows
      }
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
      sessionKey: session?.id ?? '',
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
      mode: active?.mode ?? pendingMode ?? normalizePresetId(presets.defaultId),
      permission,
      /** Pre-session plan choice for the status badge until a session composes. */
      pendingPlan: session === undefined && pendingPlan,
      dispatch,
      steer,
      interrupt,
      quit,
      loadModels: () => loadModelDirectory(ctx),
      loadModelProviders: () => loadProviderSettings(ctx),
      subscribeModelProviders: listener => subscribeProviderSettings(ctx, listener),
      saveModelProviderCredential: (target, key) => saveProviderCredential(ctx, target, key),
      saveModelProviderConfiguration: (target, configuration) => saveProviderConfiguration(ctx, target, configuration),
      discoverModelProvider: (target, request, signal) => discoverProviderModels(ctx, target, request, signal),
      unsetModelProviderCredential: target => unsetProviderCredential(ctx, target),
      removeModelProvider: target => removeProviderSettings(ctx, target),
      loadProviderAuthorizations: () => loadProviderAuthorizations(ctx),
      subscribeProviderAuthorizations: listener => subscribeProviderAuthorizations(ctx, listener),
      beginProviderAuthorization: (row, method, interaction, signal) => (
        beginProviderAuthorization(ctx, row, method, interaction, signal)
      ),
      cancelProviderAuthorization: row => cancelProviderAuthorization(ctx, row.key),
      logoutProviderAuthorization: row => logoutProviderAuthorization(ctx, row),
      openAuthorizationUrl,
      copyTextValue: copyText,
      loadMentions: (query: string, signal?: AbortSignal) => mentions.candidates(query, signal),
      inspectImages: paths => inspectImagePaths(paths, ctx.get('attachments'), session?.header.cwd ?? cwd),
      prepareImages: (paths, signal) => saveImagePaths(paths, ctx.get('attachments'), signal),
      inspectFiles: paths => inspectFilePaths(paths, ctx.get('attachments'), session?.header.cwd ?? cwd),
      prepareFiles: (paths, signal) => saveFilePaths(paths, ctx.get('attachments'), signal),
      cycleMode,
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
      listReviewBranches: (signal?: AbortSignal) => listReviewBranches(session?.header.cwd ?? cwd, signal),
      listReviewCommits: (signal?: AbortSignal) => listReviewCommits(session?.header.cwd ?? cwd, signal),
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
      loadUsage: () => loadUsage(session),
      loadSubagents: () => {
        const current = session
        if (current === undefined || sessionQuery === undefined) return Promise.resolve([])
        return loadSessions({ sessions: 'all', cwd: 'all', sort: 'newest', currentCwd: current.header.cwd ?? cwd, query: '' })
          .then(rows => rows.filter(row => row.parent === current.id && row.subagent))
      },
      switchSession,
      searchSessions,
      cancelSessionSwitch,
      loadPlugins: () => listPluginRows(ctx),
      // The launcher owns every update decision; the TUI only drives its
      // read-only probe and streamed apply as child processes.
      probeUpdate: () => probeLauncherUpdate(),
      applyUpdate: (onLine, plan) => applyLauncherUpdate(onLine, undefined, plan),
      loadJobs: () => listJobs(ctx, active?.agent),
      statusline: statuslineItems,
      saveStatusline,
      applyEditorKeys,
      saveTheme,
      saveLanguage,
      animations: animationsEnabled,
      saveAnimations,
      history: inputHistory.entries(),
      recordHistory: inputHistory.record,
      updateQueued,
      onBridgeReady: (instance: AppBridge) => { bridge.notify = instance.notify },
    })
  }

  const renderCurrent = (): void => {
    mountRef.current?.rerender(appElement())
  }

  mountRef.current = io.mount(appElement())

  // Startup prompt/images use the same durable delivery path as composer
  // submissions. Image bytes are committed before the user/message event, and
  // input typed during that preparation queues behind the initial request so
  // the agent always receives the startup prompt first.
  if (startup.prompt !== undefined || (startup.images?.length ?? 0) > 0) {
    if ((startup.images?.length ?? 0) > 0) {
      bridge.notify(t('notice.startupImages', { count: startup.images!.length, plural: startup.images!.length === 1 ? '' : 's' }))
    }
    void inputGate.run(async deliver => {
      const images = await saveImagePaths(startup.images ?? [], ctx.get('attachments'))
      if (images.length > 0) bridge.notify(t('notice.startupImagesAttached', { count: images.length, plural: images.length === 1 ? '' : 's' }))
      deliver({ text: startup.prompt ?? '', mode: 'followup', images })
    }).catch((error: unknown) => {
      bridge.notify(t('notice.initialPromptFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  async function copyLastResponse(): Promise<string> {
    const text = latestAssistantText(store.getView())
    if (text === undefined) return t('notice.copyEmpty')
    await copyText(text)
    return t('notice.copied')
  }

  // A corrupt statusline config must not vanish silently: surface it once
  // the notice channel is live, after the first frame settles.
  if (statuslineWarning !== undefined) {
    setTimeout(() => {
      bridge.notify(t('notice.statuslineConfigUnreadable', { message: statuslineWarning }), 'warning')
    }, 50)
  }
  // Same one-shot surface for a corrupt theme file (dark fallback stays live).
  if (languageWarning !== undefined) {
    setTimeout(() => {
      bridge.notify(t('notice.languageConfigUnreadable', { message: languageWarning }), 'warning')
    }, 0)
  }
  if (themeWarning !== undefined) {
    setTimeout(() => {
      bridge.notify(t('notice.themeConfigUnreadable', { message: themeWarning }), 'warning')
    }, 50)
  }
  // And for a corrupt animations file (on-by-default fallback stays live).
  if (animationsWarning !== undefined) {
    setTimeout(() => {
      bridge.notify(t('notice.animationsConfigUnreadable', { message: animationsWarning }), 'warning')
    }, 50)
  }

  // One-shot VS Code Ctrl+R hint: resolveEditorKeysStartupHint checks the
  // marker file and the live keybindings config; surfacing waits for the
  // notice channel like the other startup warnings. A failed probe stays
  // silent — the hint is cosmetic and /vscode-keys remains discoverable.
  void resolveEditorKeysStartupHint(editorKeysEnv).then(hint => {
    if (hint === undefined) return
    setTimeout(() => {
      bridge.notify(hint)
    }, 50)
  }, () => {})
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config resolved from the tuiStartup provider.
 */
export function apply(ctx: Context, config: Config): void {
  // The host resolves every bare @deepseek-ai/* import against its own
  // installed copies with no version check anywhere on that path, so refuse
  // to run against an identified-but-different Harness before anything loads.
  requireHarnessVersion(EXPECTED_HARNESS_VERSION, probeRunningHarness(process.argv[1]))
  const startup = resolveStartupConfig(config)
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { mount: internals.mount, exit }
  void run(ctx, startup, io).catch((error: unknown) => { fail(io, error) })
}
