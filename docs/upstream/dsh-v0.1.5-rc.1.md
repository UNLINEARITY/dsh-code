# DSH upstream audit: v0.1.2-rc.1 → v0.1.5-rc.1

## Compared revisions

| Release | Commit | Role |
| --- | --- | --- |
| `dsh-v0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | Previous dsh-code baseline |
| `dsh-v0.1.5-rc.1` | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | Target release |

The interval spans 1,486 commits and 159 merged pull requests. This audit
records what the terminal consumes, what it adapts to, and what it defers.
Web-client-only work (sidebars, dock layouts, open-in-app, image tool cards)
is out of scope for the TUI and is not restated here.

## Session log format v3 (the structural change)

`SESSION_FORMAT_VERSION` moved from `0` to `3`; three migrations
(`v0-to-v1`, `v1-to-v2`, `v2-to-v3`) ship in the kernel. Consumers reading
through the persistence service always receive the migrated current stream —
migration happens inside the JSONL backend on read, in memory, without
touching the committed files.

- **Settlement-only durable logs** (`v1→v2`): top-level `assistant/chunk`
  events no longer exist. The assembled `assistant/message` (and the new
  log-only `assistant/attempt` for failed, retried, or cancelled attempts)
  embeds the precise timing as `data.stream: AssistantStreamRecord[]`, with
  readers (`expandAssistantStream`, `joinAssistantStreamText`,
  `assistantStreamFirstTokenTime`) exported from `@deepseek-ai/dsh-llm`.
- **Live typing is a separate channel**: process-local `agent/assistant-stream`
  frames (`start`/`chunk`/`end`, keyed by `attemptId` + `revision`; the `end`
  frame names the durable settlement that committed). It is not a write-ahead
  log — a hard crash before settlement loses the in-flight stream.
- **System prompt as a surface node** (`v2→v3`): the first `system/message`
  event is surface node 0; `request/header.data.header.system` is removed.
  Compaction never covers system node 0; later nodes may fall inside a
  compaction range, and the terminal's fold retires them through any surface
  replace, not only `system/message` ones.
- **PTC durable vocabulary** (`v2→v3`): `tool/code-dispatch(-start)` became
  `tool/ptc-dispatch(-start)`; the plugin signature `tools-code-mode` became
  `tools-ptc` in `user/message` source slots; preset id `code` became `ptc`
  in headers and `agent-preset/selected`.
- **Canonical envelopes** (`v2→v3`): `surfaceOp.replace` fields renamed
  `start/end` → `startSeq/endSeq`; surface events carry `surfaceOp` mandatorily;
  `assistant/message` forbids `sourceEventSeqs`.
- **New known events**: `assistant/attempt`, `system/message`,
  `tool/ptc-dispatch(-start)`, `subagent/catalog`, `deliverables/presented`,
  `feedback/message-put`, `feedback/message-delete`. The `present` tool ships
  MOUNTED in the standard and ptc presets, so `deliverables/presented`
  arrives in the terminal too — the terminal keeps folding it as a known
  no-op because the presenting tool's own result card already shows the
  presented paths, not because the tool is absent.
- **Immutable generations on disk**: one session directory may hold
  `session.jsonl` (v0) alongside `session.v1.jsonl`/`session.v2.jsonl`/
  `session.v3.jsonl` (each optionally zstd-compressed); readers take the
  highest generation and never rewrite the earlier ones.

## Persistence service

- The service is handle-based: `open(id, 'read'|'write')` returns a
  `SessionHandle` with `read(offset?, length?)`, plus `stat(id)` / `list()`
  returning lightweight snapshots (`{header, revision, eventCount?, sizeBytes?}`).
- `load`/`inspect`/`readFrom`/`locate` are gone; artifact paths are no longer
  a consumer-facing query (`SessionLocation` now appears only on refusal diagnostics).
- `SessionPersistence.list` takes an options object; `SessionHeader.version`
  is the current format version; `RestoredSessionOptions.seedSource` became
  `eventState: 'detached' | 'shared-frozen'`.

dsh-code derives its two filesystem needs (session-list last-activity mtimes
and the `/delete` guard) locally: the JSONL backend exposes its configured
root through the public plugin config, and `<root>/<projectKey(cwd)>/
<encodeSegment(id)>/` plus the generation filenames are pure upstream
contracts mirrored in `src/session-directory.ts`.

## Commands and attachments

- `CommandInputDescriptor.images` became `attachments`; `execute()` takes
  `CommandSubmitAttachment[]` (`image` parts or staged `file` receipts), and
  `CommandInvocation.attachments` may hold `FileBlock`s alongside images.
- The attachment store grew `saveFile`/`saveFileStream`/`readFileStream`/
  `admitEncodedFile` and a method-based `admitPromptContent`; `saveImages`
  and the image limits are unchanged, so the TUI's image path needed no edits.

## System prompt plugin config

The `system-prompt` plugin's `persona` key was split into `personaPrefix`
and `personaSuffix` around the first-party guidance sections. The bundle
patch now overrides `personaPrefix`.

## Presets and tools

- The preset set (`cordis`, `minimal`, `ptc`, `standard`) is unchanged; the
  upstream rename of `code` → `ptc` in durable logs is handled by the v2→v3
  migration, and dsh-code's `LEGACY_PRESET_IDS` bridge keeps covering
  hand-typed legacy ids.
- The base bundle dropped `tool-str-replace-editor` (the `minimal` preset is
  a single-tool composition now); the bundle patch no longer disables it.
- `web-app` still carries the `subagent-model-selection-settings` host row
  dsh-base does not ship, so the patch keeps its compatibility insert.

## Models and discovery

- New catalog model `deepseek-flash` (DeepSeek-V41-Flash, text+image); the
  base bundle's default model switched to it.
- Provider discovery lists models over `anthropic-messages`
  (`GET /v1/models` with `x-api-key` + `anthropic-version`) and understands
  more gateway-rich fields; broken provider catalogs no longer vanish —
  `LlmConfigurableProvider.error?` and pi-ai `catalogError`/`modelErrors`
  carry the diagnosis.
- Proxy environment (`HTTP_PROXY` & co.) resolution is now honored for
  child processes; MCP tool pagination detects continuation-cursor cycles;
  subprocess containment on Windows moved to Job Objects (immediate kill).

## Agent surface

- `ctx.agent` accessor removed; `AgentSetup` callbacks receive the composed
  agent as their second argument.
- The inbox became a session projection rebuilt from durable splices;
  `Inbox` methods are read-arrays plus `clear`/`append`/`prepend`/`replace`/
  `remove`/`splice`.
- Subagents gained a durable catalog (`subagent/catalog`,
  one-shot vs continuable) and steer delivery
  (`subagent.start` `delivery: 'queue' | 'steer'`); goals publish
  `goal/activation-changed` (armed/disarmed) and the model can no longer
  resume a paused goal.
- dsh-code consumes the stream frames for live typing and folds
  `assistant/attempt` as durable diagnostics; catalog/steer/activation
  surfaces follow in later stages: the durable catalog feeds the /agents live rows (an
  idle row carrying the authored label and mode; late deliveries never
  regress a row that already ran), while steer delivery and the armed
  indicator remain follow-ups.

## What dsh-code adopted in this alignment (stages 1–3)

Stage 2 added the provider configuration diagnostics (the adapter's `error`
now appears on the provider row in the /model list and the setup page) and the
system-prompt data layer (per-node fold, `TranscriptView.systemPrompt`,
/export collapsed block). Stage 3 added terminal file attachments (paste/drop
split into image and file blocks, terminal-side bounds of 8 MiB and 8 files,
composer drafts, projection/export labels) and the subagent catalog rows.
The launcher refuses to downgrade an installed host to the line an older
published dsh-code pins, and `/fork` records lineage through the 0.1.5
contract (`meta.isSeeded` plus the top-level `inheritedEventCount` — the
`meta.seedLength` spelling belongs to a later upstream draft and the released
kernel rejects it).

- All `@deepseek-ai/dsh-*` pins moved to `0.1.5-rc.1` (dependencies, peers,
  dev dependencies, the launcher's harness-line anchor, and the two specs
  that pin the line).
- `src/render/projection.ts` speaks v3: the `assistant/chunk` branches are
  gone; live typing now arrives over `agent/assistant-stream` frames folded through new
  accumulator primitives (`applyAssistantStreamChunk`, `clearAssistantStream`)
  in `src/store.ts`; settlements restore replayed text/timings from the
  embedded `data.stream` (first-token latency included);
  `assistant/attempt` releases step anchors and clears abandoned tails;
  `system/message` maintains the system context estimate that
  `request/header` used to carry.
- `src/session-directory.ts` derives the multi-generation layout and keeps
  `/delete` guarded; `src/index.ts` reads snapshot lists, uses the setup
  callback's agent argument, and wires the stream listener.
- `cordis.patch.yml` overrides `personaPrefix` and drops the retired
  str-replace-editor row.
