# DSH upstream audit: v0.1.5-rc.2 → v0.1.7-rc.1

## Compared revisions

| Release | Commit | Role |
| --- | --- | --- |
| `dsh-v0.1.5-rc.2` | `fb2c4b9e698e30edb738bca4cf0618587db7d203` | Previous dsh-code baseline |
| `dsh-v0.1.7-rc.1` | `46a7f68b0922371ce7144b668b90e377d8e799f4` | Target release |

The interval spans 3,304 commits (2,211 non-merge + 1,093 merged PRs) and
7,872 changed files. Most of that volume is upstream-internal or host-surface
noise (`.agents/notes`, `website/`, `benchmarks/`, `vendor/`, `native/`,
`python/`, `packages/client` web UI ≈ 928 files). The terminal-relevant
surface is concentrated in `packages/session` (71 files), `packages/llm` (58),
`packages/boot` (46), `packages/core` (41), `packages/subagent` (38),
`packages/preset` (36), plus the bundle/launcher directories. `dsh-v0.1.5-rc.3`
(a web-only backport line) is an ancestor of the target and included in range.
Every `@deepseek-ai/dsh-*` package version moves `0.1.5-rc.2 → 0.1.7-rc.1`,
published on npm under the `next` dist-tag (`latest` remains `0.1.0-rc.6`).

This audit records what the terminal consumes, what it must adapt to, and what
it can defer. Web-client-only work remains out of scope.

## Session log format v4 (the structural change)

`SESSION_FORMAT_VERSION` moves from `3` to `4`
(`packages/core/session/src/types.ts`; the constant is also re-exported through
the new `@deepseek-ai/dsh-session-format-catalog`). The format-status record
marks v4 as finalized with this checkout's writer; v4 first ships in a
published product with this RC line (the recorded release evidence still cites
`dsh-v0.1.5-alpha.1` / format 3, i.e. the record predates the rc publication).
The adjacent migration ships as a new library,
`@deepseek-ai/dsh-session-format-v3-to-v4`, orchestrated by the catalog;
persistence still migrates on read, in memory, without rewriting committed
generations.

- **Tool results become tool-role messages** (the headline for the projection):
  the `tool/result` event's message changes `role: 'user'` → `role: 'tool'`;
  the single canonical `tool-result` content wrapper is lifted away —
  `content[0].toolCallId` becomes `data.message.toolCallId` (equal to the
  retained `source.callId`), `content[0].content` becomes the direct
  `data.message.content` (including empty), and `content[0].isError` becomes
  optional `data.message.isError`. `data.error` requires `isError: true`.
  Wrapper leftovers are preserved as `plugin:result:<field>` /
  `plugin:message:<field>`. The retired `tool-result` block is refused in all
  interpreted positions (user/system/developer/assistant/tool messages, inbox
  splices, title requests, `team/message/queued`, `compaction/summary`,
  `tool/ptc-dispatch`, and embedded assistant stream block records).
- **Producer attribution vocabulary** (the second headline): message sources
  drop the `plugin: { kind: 'plugin', plugin: name }` shape for direct kinds.
  First-party producers keep their exact names (`time-context`,
  `tmux-context`, `schedule`, `goal`, `session-reference`, `skill-invocation`,
  `subagent-report`, `plan-mode`, `user-approval`, `hooks-codex`, …), while
  legacy plugin wrappers convert: `compact` → `compact-checkpoint`,
  `tools-ptc`/`tools-code-mode` → `ptc-mode`, `dsh-compaction-basic` →
  `compact-basic`, `@deepseek-ai/dsh-system-prompt` → `system-prompt`
  (system-role) or `runtime-context` (other roles); anything else becomes
  `plugin:<original-name>`. Native V4 requires source kinds to be nonempty and
  not `plugin`. The walker visits `user/message` `data`, the `data.message` of
  system/assistant/tool messages, `agent/inbox/spliced` `data.inserted[]`,
  and `session/title-llm-request` `data.messages[]`.
- **`developer/message` is a new durable event**: developer-surface messages
  carrying `tool-addition` / `tool-removal` blocks (each with `toolName`),
  bound to an earlier `request/header` through a required `headerSeq`;
  request-tool definitions gain `deferLoading: true`. Native support does not
  imply provider loading or UI rendering — consumers explicitly refuse
  developer history they cannot represent.
- **Interrupted-turn closure and sequence remapping**: an open turn with no
  open step can be closed by inserting `turn/end` (reason `interrupted`)
  before the next `turn/start` when evidence requires it; insertion renumbers
  subsequent envelopes densely and remaps `sourceEventSeqs`, replacement
  `startSeq/endSeq`, command `sourceEventSeq`, title `messageSeqs`, compaction
  `shadowedRange`/`shadowedSeqs`, and image-offload target `seq`. Seeded
  sessions identify the inherited prefix through the last
  `session/end-seed` marker carrying `inherited: true`.
- **Fork-generated results**: fork seeds may settle unstarted advertised calls
  with synthetic `TOOL_NOT_STARTED` error results
  (`forked-tool-result-<callId>-<seq>`) and started calls with
  `TOOL_OUTCOME_UNKNOWN`; the forked tail closes with
  `turn/end.reason.kind: 'forked'`. The `agents.create` fork contract
  (`meta.isSeeded` + `inheritedEventCount`) is unchanged at the target.
- **Parent catalog facts**: `subagent/catalog` gains version-0/version-1
  payloads with `childId`, `childCreatedAt`, mode (`continuable` /
  `one-shot` / v1 `unknown`), and label rules; v3→v4 restoration appends
  missing parent entries from child evidence without inventing labels.
- **Delivery generations**: `session-log-deepseek/delivery-accepted` markers
  gain generation watermarks (V4 = 4); a V3 source marker claiming generation 4
  is refused.
- **Envelope/header strictness (native V4)**: the logical header admits
  exactly `version`, `id`, `createdAt`, `isSeeded`, `delegationDepth`
  (required) plus optional `cwd`, `parentSession`, `origin`, `agentPreset`;
  event envelopes admit `type`, `seq`, `time`, `data` plus only `surfaceOp`,
  `sourceEventSeqs`, `ignorable`; all five surface message types require
  `surfaceOp`; `assistant/message` must omit `sourceEventSeqs`; the retired
  `request/header.header.system` is refused even when empty.
- **On-disk generations**: v4 continues the immutable multi-generation layout
  (`session.v4.jsonl`, optionally zstd — `sessionFormatLogFilename(4)`).
  Migration runs on read like the older edges: the JSONL backend decodes the
  historical generation in memory, and a write-open publishes the
  `session.v4.jsonl` successor; already-V4 logs never run the migration.
  dsh-code's `src/session/session-directory.ts` enumerates generation
  filenames from the imported `SESSION_FORMAT_VERSION`, so the v4 name joins
  automatically with the dependency bump — no source change needed there.
- **New known events**: `developer/message` (surface type; requires an open
  step; additions bind to an earlier `request/header` through `headerSeq`),
  `image/offload` (durable image-offload decisions, typed by the new
  `dsh-compaction-image-offload` plugin), and `workspace/changes` (git
  snapshot of turn file changes, typed by the web client). All three are
  absent from dsh-code's `KNOWN`/known-event dispositions in
  `src/render/projection-events.ts`, so the coverage spec fails on the
  dependency bump until they get dispositions.
- **Plugin-owned message projections**: new
  `SessionMessageProjection`/`foldSurface(events, projections?)` machinery
  with `MESSAGE_PROJECTION_EVENT_TYPES = {'image/offload'}` — folding a log
  containing `image/offload` without its registered projection throws.
  Upstream engines install the projection; dsh-code does not call
  `foldSurface` directly, but its raw token accounting will diverge from the
  model's view unless it interprets `image/offload` targets.
- **Request-header retirement**: `EpochHeader.system?: never` — the writer
  refuses `request/header.header.system` even in reserved empty forms.
- **Deprecations (still functional)**: `Session.eventAt`, `snapshotEvents`,
  `ownEvents` carry `@deprecated` ("new calls are prohibited"). dsh-code
  calls `snapshotEvents()` at three sites (resume seeding, turn usage,
  fork seed) — functional, policy-flagged only.

## Package renames and bundle composition

Three packages dsh-code references were removed upstream and replaced:

| 0.1.5-rc.2 (pinned by dsh-code) | 0.1.7-rc.1 replacement | Note |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset` + `@deepseek-ai/dsh-agent-preset-registry` | Preset authoring/registry split out; shipped presets are no longer a `presets/` tree inside the package |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | `@deepseek-ai/dsh-ptc-runtime-node` (id `ptc-runtime`) | `packages/code-runtime/*` removed entirely; `dsh-base` now ships `ptc-runtime` itself |
| (`workflow-worker-thread`, disabled in the patch) | `@deepseek-ai/dsh-workflow-ptc` (id `workflow-ptc`) | `packages/workflow/workflow-worker-thread` removed; `dsh-base` ships `workflow-ptc` |

- `packages/bundle/base/cordis.patch.yml` at the target includes
  `ptc-runtime` (`@deepseek-ai/dsh-ptc-runtime-node`) and `workflow-ptc`
  rows, so dsh-code's patch **insert** of `code-runtime` /
  `@deepseek-ai/dsh-code-runtime-worker-thread` resolves to a dead package
  and must be dropped or rewritten, and its **disable** list entries
  (`workflow-worker-thread`) reference ids that no longer exist.
- Shipped preset compositions moved to bundle patches
  (`packages/bundle/web-app/presets/{cordis,minimal,ptc,standard}.patch.yml`);
  the `agent-presets` insert in dsh-code's patch (with
  `config.default: standard`) needs the successor package/service.
- Vendored runtime deps stay caret-compatible with dsh-code's pins:
  `@deepseek-ai/cordis` 4.0.2 → 4.0.4 (`^4.0.2`), `cordis-plugin-loader`
  1.0.3 → 1.0.5 (`^1.0.3`), `schemastery` 3.18.2 → 3.18.4 (`^3.18.2`).

## Session core and persistence

- **Fork rework**: `SessionForkErrorCode` drops `'OPEN_TURN'`; `store.fork()`
  forks exact prefixes mid-turn through the new `buildForkSeed()` (also
  exported as the `@deepseek-ai/dsh-session/fork` subpath), appending the
  inherited `session/end-seed` marker plus synthetic closers — turn-end
  reason `forked: {kind:'forked'}` and `forked-tool-result-<callId>-<seq>`
  error results (`TOOL_NOT_STARTED` wording for unstarted calls,
  `TOOL_OUTCOME_UNKNOWN` for started ones). `inheritedEventCount` counts
  only copied source events (closers excluded). The `agents.create` fork
  contract (`meta.isSeeded` + `inheritedEventCount`) is unchanged, so
  dsh-code's balanced-prefix `/fork` keeps working; mid-turn forks are now
  possible upstream, and replayed fork children legitimately contain
  `turn/end {kind:'forked'}` markers the projection should label.
- **`SessionPersistence.identity: symbol`** (new, stable through Context
  proxies); session-query's observation cache keys on it
  (`PreparedEntry.persistence` → `persistenceIdentity`). dsh-code's
  session-query subclass seams (`_persistenceBinding`,
  `_lastPersistenceIdentity`) are byte-identical at the target — the
  skip-tolerant engine keeps working. session-query also hard-depends on the
  new format catalog and folds with `currentSessionMessageProjections`.
- **Compaction**: the checkpoint marker source became
  `{kind:'compact-checkpoint'}` (was `{kind:'plugin',plugin:'compact'}`),
  with a real `isCompactCheckpointSource` type guard; new cordis waterfall
  event `compaction/summary-error` drives durable image-offload recovery on
  failed summary requests.
- **Session references**: candidates gain `displayTitle?: string` (a
  subagent's durable creation label preferred over `label`); mention text
  upstream is `displayTitle ?? label`. `formatSessionReferenceMention` and
  the candidate API are otherwise unchanged.
- **Session title**: `SessionTitleModelProvenance` renamed
  `SessionTitleModelIdentity` (dsh-code imports types only — harmless).
- `Session.firstLifecycleSeq` added (child-owned history start; differs from
  `firstLiveSeq` for fork children); `SessionSurface.contentGeneration`
  added; `deriveEventMessage(event, projectedMessages?)` gained an optional
  parameter; `Session.create/fromRestore` gained trailing `projections`
  parameters; `SessionStore.registerMessageProjection()` registers plugin
  projections (async disposer, duplicate types refused).

## Agent, LLM, and subagent surface

- **Message model restructured**: `Message` is a closed `MessageRoleMap`
  union over roles `system | developer | user | assistant | tool`; tool
  results are a first-class tool-role message (`ToolResultMessage` with
  message-level `toolCallId`/`isError`); the `tool-result` content block is
  deleted, replaced by reserved `tool-addition`/`tool-removal` developer
  blocks; `Message.content` is `readonly ContentBlock[]`;
  `AssistantProvenance` renamed `AssistantProviderMetadata`;
  `createSystemMessage(text)` drops its `plugin` parameter; `BlockAssembler`
  requires an explicit source. `GenerateOptions.messages` accepts
  identity-free `RequestUserInput` entries.
- **`agent/session-start` deleted; `agent/created` is serial and awaited**:
  payload `{agent, source: SessionStartSource, signal?}`, mode `serial`;
  listeners are awaited before creation resolves and a rejection fails
  creation; `AgentRegistry.register` returns an awaitable disposer;
  `announce(agent, source, signal?)` is async. dsh-code does not touch these
  seams — `AgentSetup`, `CreateAgentOptions`, the inbox projection, the
  `agent/assistant-stream` frames, and `assistant/attempt` folding are all
  unchanged.
- **Settings rewritten around profile-backed forms**: `SettingsProvider`,
  `installSection`, `SettingsScope`, and `settings/updated` are gone; the new
  `SettingsForms` service (`configure`/`describe`/`update`/`replace`/`mutate`
  path-ops) edits only volatile schema fields through the config editor;
  legacy `settings.yaml` imports once into the active profile. dsh-code's
  `settings/document-updated(ns, revision)` listener survives with the same
  payload.
- **Default-model persistence changed rails**: the
  `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`/schema exports are removed;
  `Config` fields are `Volatile<string>`; `saveSelection` writes through
  `configEditor.edit(ownerContext.fiber.entry, …)` and **silently no-ops
  when the caller's fiber has no loader entry** — dsh-code's `/model`
  default save (`defaultModel.saveSelection`) must verify its mount context
  or saves vanish.
- **Subagent catalog migration**: `listChildren` now returns
  `SubagentCatalogEntry[]` (id/createdAt/mode/label) read from the parent's
  `subagentCatalog` projection via session-query; the browser Remote
  `subagent.list`, `SubagentCatalog`, `catalogView`, and the
  `subagent/projections-unavailable` error were removed. `subagent/catalog`
  events gain `version: 1` payloads retaining `mode: 'unknown'` children
  (projection `stateVersion` 3) — dsh-code's
  `src/session/subagents.ts:126` coerces unknown to `'one-shot'` and must
  handle the third mode explicitly.
- **Continuable capacity limits**: `SubagentRuntime.Config`
  (`maxActiveSubagents`, default 8; `maxDepth`, default 1); an
  `ActivationPool` shares slots per uninterrupted continuable root; the 9th
  concurrent child rejects `ACTIVATION_LIMIT_REACHED` (browser
  `subagent/delivery-unavailable`), including cold resume at capacity.
  Delegation policy overrides may set `permissionPreset: 'auto' |
  'danger-full-access'`.
- **Settlement notices are text-only**: non-text child output blocks no
  longer reach the parent's user message (full output stays in
  `SubagentResult.output`, now `readonly`). New
  `SubagentTimingProjection.lastTurnCompleted?` supports richer feed rows.
- **Durable image offload**: `ImageBlock.offloaded?: true`,
  `LlmFailure.offloadImages`, `IMAGE_OFFLOAD_REQUIRED_CODE`,
  `LlmImageRequestBudget`, and `requiredImageOffload(messages, budget,
  versionBytes)` replace the transient `RequestImageOffloadPolicy`; routes
  fail loudly with `IMAGE_OFFLOAD_REQUIRED` instead of silently projecting.
- **Model surface**: model-switch notices now carry
  `{kind:'model-selection', form:'notice', summary}`;
  `LlmDiscoveredModel.inputModalities?` flows through `listModels`;
  `ToolSchema.deferLoading?: true`; `LlmConfigurableProvider.error?` and the
  stream/retry contracts are unchanged.
- **Authorization**: `AuthorizationSession.commit(record)` added (commits
  route through the credential store; `cancel()` waits once committing).
  dsh-code's consumer API (`list`/`begin`) is unchanged; the `credentials`
  package src itself did not change.

## Interaction surface

- **Jobs seam rewritten (BREAKING for the terminal)**: `@deepseek-ai/dsh-jobs`
  replaces `JobSnapshot` with `JobView` and `JobStart` with `JobSpec`; the
  `onJobDone`/`onJobsChanged` callbacks are gone in favor of
  `events.subscribe(filter, listener)` over a `JobEvent` vocabulary
  (`registered|progress|stopping|settled|removed|output`); every caller
  parameter changed from `Agent` to `SessionId` (`list(caller?:
  SessionId): JobView[]`); `read()` returns `{chunks, lossy, result?, job}`
  instead of `{text, snapshot}`, with observer-side `readAt(id, from, caller)`
  and `remove(id, caller)`; a client-safe leaf `@deepseek-ai/dsh-jobs/view`
  ships. Output becomes one bounded ring per job (lossy retention, never
  errors), `kill(reason)` merges the reason into terminal `detail`, and
  `settled` carries `cause` (`producer|kill|teardown`) plus `awaited`.
  `dsh-code` impact: `src/index.ts` imports `JobSnapshot` and calls
  `jobs.list(agent)` — both must change; the mapped row fields
  (`id/kind/label/status/detail/startedAt/finishedAt`) all survive on
  `JobView`.
- **Producer sources also lost the catch-all off the durable path**: the
  `plugin` message-source kind is deleted from the in-flight
  `MessageSourceMap` as well. Emitters the terminal renders now own their
  kinds: user-approval policy notices → `{kind:'user-approval'}`, plan-mode
  notices → `{kind:'plan-mode', form:'notice', summary}`, schedule reminders
  → `{kind:'schedule'}` (time-context/tmux-context likewise). Combined with
  the v4 durable vocabulary, every `source.kind === 'plugin'` branch in the
  projection (~6 sites) is dead code: the snapshot/reminder sets become
  `HIDDEN_SNAPSHOT_KINDS = {'time-context','tmux-context'}` and
  `REMINDER_KINDS = {'schedule'}`, and notice summaries read `ContextFormed`
  fields with the kind string as the fallback label.
- **Permission presets became a dynamic catalog**: the `permissions`
  projection wire view is current-value-only
  (`PermissionSelection {currentValue}`; the old `PermissionSelect` carried
  `options` too); options moved to a process-level `PermissionCatalog` Remote
  (`catalog(): {options, defaultOptions, defaultPreset}`) with a payload-free
  `permission-presets/catalog-changed` emit event; a reserved live preset
  `AUTO_PRESET = 'auto'` registers through `registerAuto(admit)`
  (experimental Auto review); `PERMISSION_SETTINGS_NAMESPACE` is removed;
  `Config.presets` is required and `defaultPreset` is
  `Volatile<string|undefined>`. The `/permission` cycler should subscribe to
  the catalog-changed event instead of assuming a static table.
- **Commands gained definition identity**: optional branded
  `CommandDefinitionId` on `CommandDefinition`/`CommandDescriptor`; a scoped
  override never inherits the shadowed registration's identity.
  `CommandInvocation`/`command/run`/`command/done` are unchanged.
- **Plan review carries its source call**: the user-questions
  `AskUserQuestionIntent` approve variant gains `callId?: ToolCallId`
  (the logged tool invocation whose arguments contain the reviewed plan) —
  enables resolving the plan document in the review surface.
- **Skills expose their path**: `SkillSummary.path?` is now returned by
  `ctx.skills.list()`.
- **Attachment image requests re-targeted**: `ImageRequestPolicy` →
  `ImageRequestTarget` (`maxPixels` → `width`+`height`, `maxBytes` kept);
  `readImageRequest(ref, target, signal)`; new `longEdgeDimensions` +
  `ProjectedDimensions`. The terminal's save/admit paths are untouched.
- **Goal disarm timing**: the activation disarm hook moved from
  `agent/session-start` to `agent/created` (now an awaited async
  initialization edge); durable `goal/change` vocabulary is unchanged.
- **Schedule answers archive admission**: `workspace/session-activity`
  reports active reminders (`SessionActivity` kind `schedule`);
  `workspace/session-stop` appends durable `schedule/change` deletes;
  `ScheduleRuntime.activeRecords()` added; the invariant companion plugin is
  renamed `tool-schedule-invariant` → `schedule-invariant`.
- **Sandbox workspace root must be absolute**: `resolveWorkspaceRoot` no
  longer canonicalizes; a relative `workspaceRoot` throws. `SANDBOX_MODES` /
  `setSandboxMode` / the `sandbox/mode` event are unchanged.
- **util/values**: new `WeakMapWithValues<Key,Value>` (weak keys, strongly
  retained insertion-ordered values).
- **Unchanged in scope**: `boot/cmdline` (no flag changes),
  `runtime-diagnostics/invariants`, `todo/tool-todo` (`todo/change`, `TodoItem`
  untouched), `context/file-reference-local` (internal async-init only), and
  the `user-approval` API surface itself.

## Bundle, launcher, and compatibility

- **Peer compatibility is now enforced (the gate that forces this
  alignment)**: `evaluatePluginCompatibility`
  (`packages/boot/app-boot/src/plugin-compatibility.ts`) checks every
  `@deepseek-ai/dsh*` entry in a package's `peerDependencies` against the
  running runtime version (app-boot's own `package.json` version, semver
  `includePrerelease`). It is enforced at install time (typed refusal,
  failure code `incompatible-version`) and at boot:
  `loadProfileDirectory` **skips a whole bundle layer** whose peers
  mismatch, and `prepareProfileEntries` disables individual rows. dsh-code's
  exact `0.1.5-rc.2` pins would be refused under a `0.1.7-rc.1` host — the
  version bump is a hard prerequisite, not cosmetics. Escape hatch for
  users: per-profile `compatibility.json` granted via
  `dsh plugin allow-version <pkg@version> --dsh-version <exact>
  --accept-risk`.
- **`dsh.bundle.patch` accepts an ordered list**: `string | string[]`
  (`ProfileLayer.patchPath` → `patchPaths`); each file's relative plugin
  paths resolve beside that file. The web-app bundle is the flagship user
  (its `cordis.patch.yml` plus four preset patches).
- **Base bundle row churn** (`packages/bundle/base/cordis.patch.yml`): new
  rows `plugin-manager`, `tool-plugin-manager` (disabled), `config-editor`,
  `settings` (`dsh-settings-file` renamed `@deepseek-ai/dsh-settings`),
  `authorization`, `deepseek-account`, `mcp-resources`, `image-offload`,
  and `ptc-runtime` + `workflow-ptc`; `hmr` retargeted to
  `@deepseek-ai/dsh-hmr` (enabled in profile boots, owning profile-config
  reload); `workflow-worker-thread` removed;
  `spill-policy.maxInlineBytes: 50000` → `maxInlineTokens: 12500`;
  `tool-ralph` disabled by default. Consequences for dsh-code's patch: the
  `authorization` insert (lines 143–144) would double-mount and must be
  dropped (keep the dependency for `src/authorization.ts` imports); the
  `hmr`/`tool-ralph` disables are now partly redundant but harmless; the
  inserts base still lacks — `subagent-model-selection-settings`,
  `cordis-host-runner`, `session-reference`, `file-reference-local` —
  remain required.
- **Presets through bundles**: preset content ships as
  `packages/bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`
  (orders 1–4); `@deepseek-ai/dsh-agent-preset-registry` provides the
  `agentPresets` service (`Config.default` required; `selectedDefault` /
  `modeSelectionEnabled` volatile) and `@deepseek-ai/dsh-agent-preset` the
  declarative row (`config: {id, order, plugins}`). The CLI's shipped
  preset-root mechanism (`dsh.configTrees`) is removed; "legacy
  directory-based presets require migration". dsh-code must vendor the four
  preset declarations as `agent-preset` rows. Team mode comes free with the
  vendored presets (upstream uses `spawn_teammate` with `subagent` /
  `subagent_fork` disabled in team contexts).
- **PTC runtime**: `@deepseek-ai/dsh-ptc-runtime` (abstract `ctx.ptcRuntime`
  seam) + `@deepseek-ai/dsh-ptc-runtime-node` — process-isolated Node
  execution (fresh process per call, empty `process.env`, output/heap/time
  limits; Config `timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/…), renamed
  "without legacy aliases". Workflow orchestration executes in the same
  sandboxed runtime.
- **CLI launcher**: `dsh <name>` profile shorthand replaces the hardcoded
  `web` alias; new `--dump-config-schema` (JSON Schema for Cordis
  configuration — usable in CI to validate `cordis.patch.yml`); the
  `plugin` subcommand parses the compatibility exemption commands; startup
  failures save `StartupError` reports under `$DSH_HOME/logs/startup-*.log`
  and uncaught exceptions are fatal (`installFailLoud`).
- **Vendored trio**: `cordis` 4.0.2→4.0.4, `cordis-plugin-loader`
  1.0.3→1.0.5, `cordis-plugin-include` 1.0.7→1.0.9, `schemastery`
  3.18.2→3.18.4 — dsh-code's carets all still satisfy (NO-OP).
- **Line themes**: the 0.1.6 line was the engine re-architecture (boot
  runtime resolution, plugin-manager service extraction, HMR lifecycle
  ownership, sandboxed PTC execution, V4 groundwork, headless seam); the
  0.1.7 line is the product surface (web sidebar terminal, session
  archives, MCP resources, Office preview, voice input) plus the
  Messages-only DeepSeek adapter, presets-through-bundles, and the
  compatibility enforcement. Official release notes:
  [dsh-v0.1.7-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)
  (roll-up against `dsh-v0.1.5-rc.3`).

## Alignment plan (staged) — executed

Stages 0–2 below were implemented in the 0.1.7-rc.1 alignment; stage 3 is
deferred. Validation: `pnpm verify` green (89 files / 1211 tests, zero-warning
lint, both typechecks, performance gates), plus an isolated runtime probe —
the local tree installed into a `cli` profile over a stock
`@deepseek-ai/dsh@0.1.7-rc.1` host boots (`--help`) and dumps the expected
composition (`--dump-config`: registry row, all four preset declarations,
base's single `authorization` row, host-level `workflow-ptc`/`tool-workflow`
disabled). Beyond the plan items below, the alignment also refreshed
`tests/host-bundled.json` from a stock host install (278 resolved packages)
and extended `tests/bundle-patch.spec.ts` to walk every patch file in the
ordered `dsh.bundle.patch` list, recursing into `cordis:group` rows; test
fixtures moved to v4 shapes through a shared `tests/helpers/events.ts`
`fixtureEvent()` wrapper (branded sequences, mandatory `surfaceOp`).

### Stage 0 — pins and bundle composition (mechanical)

1. Move every `@deepseek-ai/dsh-*` pin (dependencies, peers, dev
   dependencies — 85 occurrences in `package.json`) from `0.1.5-rc.2` to
   `0.1.7-rc.1` and resolve the lockfile (npm carries the line under
   `next`). This is enforced by the new peer-compatibility gate: exact old
   pins are refused at install and the bundle layer is skipped at boot.
   `bin/deepseek.mjs` derives the harness line from
   `peerDependencies['@deepseek-ai/dsh-session']`, so the launcher's host
   anchor moves automatically; bump
   `src/runner/harness-gate.ts:26` `EXPECTED_HARNESS_VERSION` to
   `'0.1.7-rc.1'` (otherwise the TUI refuses the new host by design).
2. Swap removed packages: `@deepseek-ai/dsh-agent-presets` →
   `@deepseek-ai/dsh-agent-preset-registry` (the `agentPresets` service
   name survives — `ctx.get('agentPresets')`, `resolve`, `recompose`,
   `select`, `list` all exist on `AgentPresetRegistry`; `src/presets.ts`
   needs only the import swap); drop `@deepseek-ai/dsh-code-runtime-worker-thread`
   (deleted; base provides `ptc-runtime` now).
3. Rewrite `cordis.patch.yml`: delete the `code-runtime` insert and the
   dead `workflow-worker-thread` disable (decide the TUI's stance on
  `workflow-ptc` / `tool-workflow`); repoint the `agent-presets` insert at
   `@deepseek-ai/dsh-agent-preset-registry` and add the four preset
   declarations as `@deepseek-ai/dsh-agent-preset` rows vendored from
   `packages/bundle/web-app/presets/*.patch.yml`; **drop the
   `authorization` insert** (base ships it now; a second insert
   double-mounts — keep only the dependency for `src/authorization.ts`);
   refresh the stale preset-root comment.
4. Vendored runtime deps stay as pinned (`cordis` 4.0.4 / `loader` 1.0.5 /
   `schemastery` 3.18.4 all satisfy the current carets).

### Stage 1 — projection speaks v4 (BREAKING, the real work)

1. **Tool-result flattening, both fold paths** (live view and replay in
   `src/render/projection.ts`): read `message.toolCallId`,
   `message.content`, `message.isError` directly instead of the
   `content[0]` `tool-result` wrapper. Until fixed, every replayed tool
   result mis-renders (rows stuck running, wrong summaries).
2. **Producer source kinds**: replace every
   `message.source.kind === 'plugin'` branch (~6 sites) with direct-kind
   matching — `HIDDEN_SNAPSHOT_KINDS = {'time-context','tmux-context'}`,
   `REMINDER_KINDS = {'schedule'}`, foreign producers under `plugin:<name>`;
   notice rows read `ContextFormed` (`form:'notice'` + `summary`), which
   also upgrades model-change notices (`model-selection`) from the degraded
   kind-string label to their summary. The in-flight `MessageSourceMap`
   lost `plugin` too, so this is a type error, not just dead code.
3. **Known-event dispositions**: classify `developer/message`,
   `image/offload`, and `workspace/changes` in
   `src/render/projection-events.ts` (the coverage spec fails on the bump
   until then). `developer/message` is a surface type — it needs an entry in
   the fold (at minimum a bounded no-op/disposition consistent with the
   system-prompt node treatment).
4. **Turn-end vocabulary**: label `turn/end {kind:'forked'}` (fork children
   legitimately carry it); synthetic `forked-tool-result-*` error results
   render as ordinary failed tools with parent-specific wording.
5. Regression coverage: move projection fixtures to v4 shapes (flat tool
   results, direct kinds) and keep a v3-shaped resume fixture to prove the
   in-read migration path end to end.

### Stage 2 — service adaptations (BREAKING/ADAPTATION)

1. **Jobs**: import `JobView` (or the `@deepseek-ai/dsh-jobs/view` leaf),
   pass `SessionId` callers, move change notification to
   `events.subscribe`; the row fields survive. If the TUI reads job output,
   adopt the cursor-based `read()`/`readAt()` ring semantics.
2. **Subagent catalog v1**: handle `mode:'unknown'` explicitly in
   `src/session/subagents.ts` (today it silently coerces to `one-shot`).
3. **Permission presets**: subscribe to `permission-presets/catalog-changed`
   and re-read the catalog instead of assuming a static `names` table;
   decide whether to surface the experimental `auto` preset.
4. **Default-model persistence**: verify the TUI's mount context gives the
   plugin a loader entry — `saveSelection` silently no-ops otherwise.
5. Policy note: `session.snapshotEvents()` (3 call sites) is now
   `@deprecated` upstream; plan the migration off sync readers when the
   replacement path is convenient.

### Stage 3 — optional adoption (deferred)

- Plan-review `intent.callId` → resolve the reviewed plan document in the
  review surface (same pattern as approval previews).
- `SkillSummary.path` for skill file previews; `descriptor.definitionId`
  in the command fingerprint; `displayTitle ?? label` for @session mentions;
  `SubagentTimingProjection.lastTurnCompleted` for richer agent-feed rows;
  capacity hints (`maxActiveSubagents` 8 / `maxDepth` 1) and
  `subagent/delivery-unavailable` copy; `image/offload` parity in token
  accounting; mid-turn `/fork` via `buildForkSeed` (upstream now supports
  exact-prefix forks with synthetic closers).

## Evidence

- `a60af51e80` release(dsh): 0.1.7-rc.1 — uniform version bump to the rc line.
- `669b724a78` feat(session): add the V4 integration format and retain V3
  replay inputs; `8dc1d0e3ed` feat(session): add one-time V4 corpus
  migration command.
- `f4a32dbd0a` refactor(llm): flatten tool results and validate native V4
  sessions; `fb79a944f5` refactor(llm): separate durable producer sources
  from request inputs; `e0bd7e1960` feat(session): developer changes using
  historical tool schemas; `29f7e7bdf5` reserve retired system text.
- `8696ec6cef` feat(session): fork exact event prefixes with synthetic tail
  results; `b5e7fca4a5` record image offload decisions; `debb4b9a9c`
  recover durable image offload; `f937f4e23b` workspace/changes events.
- `9b7a8ccc9f` feat(agent): await initialization through `agent/created`;
  `11656ca683` startup-only registration; `cbae324bfa` stop a Session's
  running work before archiving it (#4765).
- `601d6761e4` feat(settings): project volatile Config through
  profile-backed forms (#4587); `3f7016a422` volatile schemas (#4579).
- `e55093b47d` migrate direct catalog consumers to parent projections;
  `f984683956`/`a978ad1994` catalog v1 unknown-mode; `16620a3a70`/
  `d7f9d3a773` activation caps; `0eed02d447` capacity refusal mapping;
  `29debb8b24` text-only settlement notices.
- `07941fe5e2` refactor(jobs): consolidate the seam into JobSpec,
  VisibleJobs, and one event stream (+ `cbae324bfa`, `bb20149360`,
  `0e35952802`, `2c0ca45f76`, `4baea3bb83`, `3df99217dc`).
- `55e53907ab` feat(permission): experimental Auto review; `996278e6ce`
  command identity; `f6428a164e` plan-review `callId`; `11d6bd05f3`
  `SkillSummary.path`; `ba30b73f7b` image request targets; `caa69608fb`
  sandbox workspace-root absoluteness; `c52ef9fada` ownership lifecycle
  primitives.
- `2c67633990` enforce DSH peer compatibility with exact exemptions;
  `747c98b0db` deny incompatible bundles; `51d70c5f5c` typed
  incompatibility refusals; merged by `07ad70817f`.
- `654caa4bbd` ordered patch file lists in `dsh.bundle.patch` (#4722);
  `d1e22a7e24` presets in profile YAML (#4569); `b13bbc027c` preset creator
  skills (#4836); `7c9bb5914c` PTC runtime naming; `75ed8da3e0` confined
  Node execution; `35af8698c2` workflow in the sandboxed PTC runtime;
  `98b92b683c` plugin-manager service; `abd765a600` HMR lifecycle;
  `4eb26f0e71` `--dump-config-schema` (#4705); `1d6534a810` profile
  shorthand; `99e22ebbeb`/`b0641b83fc` Messages-only DeepSeek adapter;
  `9f9a50e553` installFailLoud; `de662ee010` skip failed profile bundles
  (#4516).
- `d088572e11` `SessionPersistence.identity`; `6fef0f0af9` session-query
  cache identity; `86ca9de07e` cold rows from the projection cache;
  `34a43129a6` reference title fallback; `e62587c163` subagent-label
  mentions.
- `5cfc765ff6`/`aa491acc29`/`8f986c8da6`/`14da43d9ff` deprecate direct
  event readers; `048297321a`/`5b7195e032` credentials sign-in + commit.
- `packages/session/session-format-v3-to-v4` README — the V3→V4
  specification quoted above; `docs/session-format-status.md` @ target —
  writer/finalization/release records.
- Official release notes:
  https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1
