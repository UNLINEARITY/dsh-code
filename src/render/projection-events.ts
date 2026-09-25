/**
 * Explicit compatibility policy for durable session events entering the TUI.
 *
 * The Harness event map is merge-extensible, so a reducer default branch is
 * unavoidable: deployments may mount plugins this bundle does not know. The
 * default must not, however, let a NEW first-party event silently bypass
 * review. Tests compare this policy with `KNOWN_SESSION_EVENT_TYPES`; every
 * kernel event must be deliberately classified before a Harness-line bump.
 *
 * @module @deepseek-ai/dsh-tui/render/projection-events
 */

/** How one durable event relates to the terminal transcript projection. */
export type SessionEventDisposition =
  | 'transcript'
  | 'other-surface'
  | 'ignored'
  | 'unknown'

/** Events folded directly into `TranscriptView`. */
export const TRANSCRIPT_SESSION_EVENT_TYPES = [
  'agent/inbox/spliced',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/summary',
  // v4 dynamic tool loading: tool-addition/removal blocks render one dim row.
  'developer/message',
  'goal/change',
  // v4 durable offload decisions: consumed image prices leave the segments bar.
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session/title',
  'step/start',
  'system/message',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  // v4 turn change announcements: the fold records the marker the live
  // summary joins by seq.
  'workspace/changes',
] as const

/**
 * Events consumed by another TUI adapter rather than the transcript fold.
 * Keeping these separate documents that they are visible behavior, not
 * accidental no-ops.
 */
export const OTHER_SURFACE_SESSION_EVENT_TYPES = [
  'agent-preset/selected',
  'model/selection',
  'subagent/catalog',
] as const

/**
 * Kernel events deliberately omitted from terminal presentation. Their
 * model-visible consequences arrive through projected message/tool/session
 * events, while audit-only facts do not need a second transcript row.
 */
export const IGNORED_SESSION_EVENT_TYPES = [
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'compaction/start',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'hook/invoked',
  'hook/result',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title-llm-request',
  'step/end',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'web/deepseek-search-llm-request',
] as const

const EVENT_DISPOSITIONS = new Map<string, Exclude<SessionEventDisposition, 'unknown'>>([
  ...TRANSCRIPT_SESSION_EVENT_TYPES.map(type => [type, 'transcript'] as const),
  ...OTHER_SURFACE_SESSION_EVENT_TYPES.map(type => [type, 'other-surface'] as const),
  ...IGNORED_SESSION_EVENT_TYPES.map(type => [type, 'ignored'] as const),
])

/**
 * Classify a durable event without rejecting merge-extensible plugin events.
 * `unknown` remains a runtime no-op for forward/plugin compatibility; the
 * known-event coverage test is what makes a first-party addition fail CI.
 */
export function sessionEventDisposition(type: string): SessionEventDisposition {
  return EVENT_DISPOSITIONS.get(type) ?? 'unknown'
}
