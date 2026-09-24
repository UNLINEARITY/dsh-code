# DSH 上游对齐审计：v0.1.5-rc.2 → v0.1.7-rc.1

## 对比版本

| 版本 | Commit | 角色 |
| --- | --- | --- |
| `dsh-v0.1.5-rc.2` | `fb2c4b9e698e30edb738bca4cf0618587db7d203` | dsh-code 上一基线 |
| `dsh-v0.1.7-rc.1` | `46a7f68b0922371ce7144b668b90e377d8e799f4` | 目标版本 |

区间共 3,304 个提交（2,211 个非合并提交 + 1,093 个合并 PR）、7,872 个变更文件。体量大部分是上游内部或宿主面噪音（`.agents/notes`、`website/`、`benchmarks/`、`vendor/`、`native/`、`python/`、`packages/client` Web UI 约 928 个文件）。与终端相关的面集中在 `packages/session`（71 文件）、`packages/llm`（58）、`packages/boot`（46）、`packages/core`（41）、`packages/subagent`（38）、`packages/preset`（36），以及 bundle/launcher 目录。`dsh-v0.1.5-rc.3`（纯 Web backport 线）是目标的祖先，已包含在区间内。所有 `@deepseek-ai/dsh-*` 包版本从 `0.1.5-rc.2` 升至 `0.1.7-rc.1`，npm 上以 `next` dist-tag 发布（`latest` 仍是 `0.1.0-rc.6`）。

本笔记记录终端实际消费的内容、必须适配的部分与可以暂缓的部分；仅属于 Web 客户端的改动不在范围内。

## 会话日志格式 v4（结构性变更）

`SESSION_FORMAT_VERSION` 从 `3` 升到 `4`（`packages/core/session/src/types.ts`；该常量同时经新包 `@deepseek-ai/dsh-session-format-catalog` 再导出）。格式状态记录标记 v4 已定稿、随本 RC 线首发（已记录的发布证据仍指向 `dsh-v0.1.5-alpha.1` / 格式 3，即该记录早于本次 RC 发布）。邻接迁移以新库 `@deepseek-ai/dsh-session-format-v3-to-v4` 交付，由 catalog 编排；持久化仍在读取时于内存迁移，不改写已提交的代。

- **工具结果变为 tool 角色消息**（对投影层的头号变更）：`tool/result` 事件的消息 `role: 'user'` → `'tool'`；唯一的规范 `tool-result` 内容包装块被揭开 —— `content[0].toolCallId` 变为 `data.message.toolCallId`（等于保留的 `source.callId`），`content[0].content` 变为直接的 `data.message.content`（含空内容），`content[0].isError` 变为可选的 `data.message.isError`。`data.error` 要求 `isError: true`。包装块残余字段保存为 `plugin:result:<field>` / `plugin:message:<field>`。已退役的 `tool-result` 块在所有被解释位置都被拒绝（user/system/developer/assistant/tool 消息、inbox splice、标题请求、`team/message/queued`、`compaction/summary`、`tool/ptc-dispatch`、内嵌 assistant 流块记录）。
- **生产者署名词汇表**（第二号变更）：消息来源不再有 `plugin: { kind: 'plugin', plugin: name }` 形态，改为直接 kind。第一方生产者保留原名（`time-context`、`tmux-context`、`schedule`、`goal`、`session-reference`、`skill-invocation`、`subagent-report`、`plan-mode`、`user-approval`、`hooks-codex` 等），旧插件包装按表转换：`compact` → `compact-checkpoint`，`tools-ptc`/`tools-code-mode` → `ptc-mode`，`dsh-compaction-basic` → `compact-basic`，`@deepseek-ai/dsh-system-prompt` → `system-prompt`（system 角色）或 `runtime-context`（其他角色）；其余一律 `plugin:<原名>`。原生 V4 要求来源 kind 非空且不得为 `plugin`。
- **`developer/message` 是新的持久事件**：developer 面消息携带 `tool-addition` / `tool-removal` 块（各含 `toolName`），经必需的 `headerSeq` 绑定到更早的 `request/header`；request 工具定义新增 `deferLoading: true`。原生支持不意味着 provider 加载或 UI 渲染 —— 消费方会显式拒绝无法表达的 developer 历史。
- **中断回闭合拢与序列重映射**：无开放 step 的开放 turn 可在下一个 `turn/start` 前插入 `turn/end`（reason `interrupted`）；插入会稠密重排后续信封并重映射 `sourceEventSeqs`、替换的 `startSeq/endSeq`、命令 `sourceEventSeq`、标题 `messageSeqs`、压缩 `shadowedRange`/`shadowedSeqs`、图片卸载目标 `seq`。种子会话通过最后一个带 `inherited: true` 的 `session/end-seed` 标记识别继承前缀。
- **Fork 生成结果**：fork 种子可用合成 `TOOL_NOT_STARTED` 错误结果（`forked-tool-result-<callId>-<seq>`）结算未启动的已宣告调用，已启动的用 `TOOL_OUTCOME_UNKNOWN`；被 fork 的尾巴以 `turn/end.reason.kind: 'forked'` 闭合。`agents.create` 的 fork 契约（`meta.isSeeded` + `inheritedEventCount`）未变。
- **父目录事实**：`subagent/catalog` 获得 version-0/version-1 载荷（`childId`、`childCreatedAt`、mode `continuable`/`one-shot`/v1 `unknown`、label 规则）；v3→v4 恢复会从子证据补齐缺失的父条目而不虚构 label。
- **投递世代**：`session-log-deepseek/delivery-accepted` 标记获得世代水位（V4 = 4）；声称世代 4 的 V3 源标记被拒绝。
- **信封/头严格化（原生 V4）**：逻辑头只允许 `version`、`id`、`createdAt`、`isSeeded`、`delegationDepth`（必需）加可选 `cwd`、`parentSession`、`origin`、`agentPreset`；事件信封只允许 `type`、`seq`、`time`、`data` 加 `surfaceOp`、`sourceEventSeqs`、`ignorable`；五类面消息都必需 `surfaceOp`；`assistant/message` 必须省略 `sourceEventSeqs`；已退役的 `request/header.header.system` 即使为空也被拒绝。
- **磁盘多代文件**：v4 延续不可变多代布局（`session.v4.jsonl`，可选 zstd —— `sessionFormatLogFilename(4)`）。迁移与旧边界一样在读取时进行：JSONL 后端在内存解码历史代，写打开时发布 `session.v4.jsonl` 后继代；已是 v4 的日志不再迁移。dsh-code 的 `src/session/session-directory.ts` 用导入的 `SESSION_FORMAT_VERSION` 枚举代文件名，v4 文件名随依赖升级自动加入 —— 该处无需改码。
- **新已知事件**：`developer/message`（面类型；要求开放 step；addition 经 `headerSeq` 绑定更早的 `request/header`）、`image/offload`（持久图片卸载决策，由新 `dsh-compaction-image-offload` 插件定型）、`workspace/changes`（turn 文件变更的 git 快照，由 Web 客户端定型）。三者都不在 dsh-code `src/render/projection-events.ts` 的已知事件处置中，依赖升级后覆盖测试会失败，直到补上处置。
- **插件自有消息投影**：新的 `SessionMessageProjection`/`foldSurface(events, projections?)` 机制与 `MESSAGE_PROJECTION_EVENT_TYPES = {'image/offload'}` —— 折叠含 `image/offload` 的日志而没有注册投影会抛错。上游引擎会安装投影；dsh-code 不直接调用 `foldSurface`，但其原生 token 计量会与模型视角偏离，除非解释 `image/offload` 目标。
- **请求头退役**：`EpochHeader.system?: never` —— 写入器拒绝 `request/header.header.system`，包括保留的空形态。
- **弃用（仍可用）**：`Session.eventAt`、`snapshotEvents`、`ownEvents` 带 `@deprecated`（"禁止新调用"）。dsh-code 在三处调用 `snapshotEvents()`（resume 播种、turn 用量、fork 种子）—— 功能正常，仅策略性标记。

## 包换名与 bundle 组合

三个 dsh-code 引用的包在上游被移除并替换：

| 0.1.5-rc.2（dsh-code 所 pin） | 0.1.7-rc.1 替代 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset` + `@deepseek-ai/dsh-agent-preset-registry` | 预设创作/注册分离；内置预设不再是包内 `presets/` 目录树 |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | `@deepseek-ai/dsh-ptc-runtime-node`（id `ptc-runtime`） | `packages/code-runtime/*` 整体移除；`dsh-base` 现自带 `ptc-runtime` |
| （`workflow-worker-thread`，patch 中 disabled） | `@deepseek-ai/dsh-workflow-ptc`（id `workflow-ptc`） | `packages/workflow/workflow-worker-thread` 移除；`dsh-base` 自带 `workflow-ptc` |

- 目标的 `packages/bundle/base/cordis.patch.yml` 已含 `ptc-runtime`（`@deepseek-ai/dsh-ptc-runtime-node`）与 `workflow-ptc` 行，因此 dsh-code patch 对 `code-runtime` / `@deepseek-ai/dsh-code-runtime-worker-thread` 的 **insert** 指向已不存在的包，必须删除或重写；**disable** 列表中的 `workflow-worker-thread` 也是死引用。
- 内置预设组合移到 bundle patch（`packages/bundle/web-app/presets/{cordis,minimal,ptc,standard}.patch.yml`）；dsh-code patch 中的 `agent-presets` insert（`config.default: standard`）需要换成后继包/服务。
- vendor 运行时依赖与 dsh-code 的 caret pin 兼容：`@deepseek-ai/cordis` 4.0.2 → 4.0.4（`^4.0.2`）、`cordis-plugin-loader` 1.0.3 → 1.0.5（`^1.0.3`）、`schemastery` 3.18.2 → 3.18.4（`^3.18.2`）。

## 会话核心与持久化

- **Fork 重做**：`SessionForkErrorCode` 删除 `'OPEN_TURN'`；`store.fork()` 经新的 `buildForkSeed()`（同时以 `@deepseek-ai/dsh-session/fork` 子路径导出）支持回中精确前缀 fork，追加继承 `session/end-seed` 标记与合成闭合器 —— turn 结束原因 `forked: {kind:'forked'}` 与 `forked-tool-result-<callId>-<seq>` 错误结果。`inheritedEventCount` 只计复制的源事件（不含闭合器）。`agents.create` fork 契约未变，dsh-code 的平衡前缀 `/fork` 继续可用；上游现支持回中 fork，重放的 fork 子会话合法携带 `turn/end {kind:'forked'}` 标记，投影应为其标注。
- **`SessionPersistence.identity: symbol`**（新，经 Context 代理稳定）；session-query 的观察缓存以其为键（`PreparedEntry.persistence` → `persistenceIdentity`）。dsh-code 的 session-query 子类缝隙（`_persistenceBinding`、`_lastPersistenceIdentity`）在目标逐字节相同 —— 容错引擎继续工作。session-query 还硬依赖新格式 catalog 并以 `currentSessionMessageProjections` 折叠。
- **压缩**：检查点标记来源变为 `{kind:'compact-checkpoint'}`（原 `{kind:'plugin',plugin:'compact'}`），并成为真正的 `isCompactCheckpointSource` 类型守卫；新 cordis 瀑布事件 `compaction/summary-error` 驱动失败摘要请求的持久图片卸载恢复。
- **会话引用**：候选新增 `displayTitle?: string`（子代理持久创建 label 优先于 `label`）；上游 mention 文本为 `displayTitle ?? label`。`formatSessionReferenceMention` 与候选 API 其余未变。
- **会话标题**：`SessionTitleModelProvenance` 更名 `SessionTitleModelIdentity`（dsh-code 仅类型导入 —— 无害）。
- 新增 `Session.firstLifecycleSeq`（子自有历史起点；对 fork 子会话与 `firstLiveSeq` 不同）；`SessionSurface.contentGeneration`；`deriveEventMessage(event, projectedMessages?)` 增加可选参数；`Session.create/fromRestore` 增加尾随 `projections` 参数；`SessionStore.registerMessageProjection()` 注册插件投影（异步 disposer，重复类型拒绝）。

## Agent、LLM 与子代理面

- **消息模型重构**：`Message` 成为 `MessageRoleMap` 封闭联合（角色 `system | developer | user | assistant | tool`）；工具结果是第一类 tool 角色消息（`ToolResultMessage`，消息级 `toolCallId`/`isError`）；`tool-result` 内容块删除，由保留的 `tool-addition`/`tool-removal` developer 块取代；`Message.content` 为 `readonly ContentBlock[]`；`AssistantProvenance` 更名 `AssistantProviderMetadata`；`createSystemMessage(text)` 去掉 `plugin` 参数；`BlockAssembler` 必须显式给 source。`GenerateOptions.messages` 接受免身份的 `RequestUserInput`。
- **`agent/session-start` 删除；`agent/created` 串行且被等待**：载荷 `{agent, source: SessionStartSource, signal?}`，模式 `serial`；监听器在创建解析前被等待，拒绝会使创建失败；`AgentRegistry.register` 返回可等待 disposer；`announce(agent, source, signal?)` 异步。dsh-code 不触碰这些缝隙 —— `AgentSetup`、`CreateAgentOptions`、inbox 投影、`agent/assistant-stream` 帧、`assistant/attempt` 折叠全部未变。
- **设置围绕 profile 表单重写**：`SettingsProvider`、`installSection`、`SettingsScope`、`settings/updated` 移除；新 `SettingsForms` 服务（`configure`/`describe`/`update`/`replace`/`mutate` 路径操作）只经配置编辑器编辑 volatile 模式字段；遗留 `settings.yaml` 一次性导入活动 profile。dsh-code 的 `settings/document-updated(ns, revision)` 监听器以相同载荷保留。
- **默认模型持久化换轨**：`AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`/schema 导出移除；`Config` 字段为 `Volatile<string>`；`saveSelection` 经 `configEditor.edit(ownerContext.fiber.entry, …)` 写入，**调用方 fiber 无 loader 条目时静默 no-op** —— dsh-code 的 `/model` 默认保存（`defaultModel.saveSelection`）必须核实挂载上下文，否则保存消失。
- **子代理目录迁移**：`listChildren` 现返回 `SubagentCatalogEntry[]`（id/createdAt/mode/label），经 session-query 从父 `subagentCatalog` 投影读取；浏览器 Remote `subagent.list`、`SubagentCatalog`、`catalogView` 与 `subagent/projections-unavailable` 错误移除。`subagent/catalog` 事件获得 `version: 1` 载荷，保留 `mode: 'unknown'` 子代（投影 `stateVersion` 3）—— dsh-code 的 `src/session/subagents.ts:126` 把 unknown 强转为 `'one-shot'`，必须显式处理第三种模式。
- **可持续子代容量上限**：`SubagentRuntime.Config`（`maxActiveSubagents` 默认 8；`maxDepth` 默认 1）；`ActivationPool` 按不间断可持续根共享槽位；第 9 个并发子代拒绝 `ACTIVATION_LIMIT_REACHED`（浏览器 `subagent/delivery-unavailable`），容量满时冷恢复同样拒绝。委托策略覆写可设 `permissionPreset: 'auto' | 'danger-full-access'`。
- **结算通知纯文本化**：非文本子代输出块不再进入父 user 消息（完整输出留在 `SubagentResult.output`，现为 `readonly`）。新 `SubagentTimingProjection.lastTurnCompleted?` 支持更丰富的 feed 行。
- **持久图片卸载**：`ImageBlock.offloaded?: true`、`LlmFailure.offloadImages`、`IMAGE_OFFLOAD_REQUIRED_CODE`、`LlmImageRequestBudget`、`requiredImageOffload(messages, budget, versionBytes)` 取代临时 `RequestImageOffloadPolicy`；路由以 `IMAGE_OFFLOAD_REQUIRED` 响亮失败而非静默投影。
- **模型面**：模型切换通知现携带 `{kind:'model-selection', form:'notice', summary}`；`LlmDiscoveredModel.inputModalities?` 流经 `listModels`；`ToolSchema.deferLoading?: true`；`LlmConfigurableProvider.error?` 与流/重试契约未变。
- **授权**：新增 `AuthorizationSession.commit(record)`（提交经凭据库路由；committing 后 `cancel()` 等待）。dsh-code 的消费 API（`list`/`begin`）未变；`credentials` 包 src 本身未变。

## 交互面

- **Jobs 缝隙重写（对终端 BREAKING）**：`@deepseek-ai/dsh-jobs` 以 `JobView` 取代 `JobSnapshot`、`JobSpec` 取代 `JobStart`；`onJobDone`/`onJobsChanged` 回调移除，改为 `events.subscribe(filter, listener)` 与 `JobEvent` 词汇（`registered|progress|stopping|settled|removed|output`）；所有调用方参数从 `Agent` 改为 `SessionId`（`list(caller?: SessionId): JobView[]`）；`read()` 返回 `{chunks, lossy, result?, job}`（原 `{text, snapshot}`），观察侧 `readAt(id, from, caller)` 与 `remove(id, caller)`；新的客户端安全叶子 `@deepseek-ai/dsh-jobs/view`。输出变为每任务一个有界环（有损保留、从不报错），`kill(reason)` 把原因并入终态 `detail`，`settled` 携带 `cause`（`producer|kill|teardown`）与 `awaited`。dsh-code 影响：`src/index.ts` 导入 `JobSnapshot` 并调用 `jobs.list(agent)` —— 两者都要改；映射的行字段（`id/kind/label/status/detail/startedAt/finishedAt`）在 `JobView` 上全部保留。
- **生产者来源在持久路径外也失去兜底**：运行中 `MessageSourceMap` 的 `plugin` kind 同步删除。终端渲染的发射方现自有 kind：user-approval 策略通知 → `{kind:'user-approval'}`，plan-mode 通知 → `{kind:'plan-mode', form:'notice', summary}`，schedule 提醒 → `{kind:'schedule'}`（time-context/tmux-context 同理）。与 v4 持久词汇合并，投影中每处 `source.kind === 'plugin'` 分支（约 6 处）都是死代码：快照/提醒集合改为 `HIDDEN_SNAPSHOT_KINDS = {'time-context','tmux-context'}` 与 `REMINDER_KINDS = {'schedule'}`，通知摘要读 `ContextFormed` 字段、kind 字符串作回退标签。
- **权限预设成为动态目录**：`permissions` 投影视图只含当前值（`PermissionSelection {currentValue}`；旧 `PermissionSelect` 还带 `options`）；选项移到进程级 `PermissionCatalog` Remote（`catalog(): {options, defaultOptions, defaultPreset}`）与无载荷 `permission-presets/catalog-changed` 发射事件；保留的活预设 `AUTO_PRESET = 'auto'` 经 `registerAuto(admit)` 注册（实验性 Auto review）；`PERMISSION_SETTINGS_NAMESPACE` 移除；`Config.presets` 必需、`defaultPreset` 为 `Volatile<string|undefined>`。`/permission` 循环器应订阅 catalog-changed 事件而非假设静态表。
- **命令获得定义身份**：`CommandDefinition`/`CommandDescriptor` 可选品牌化 `CommandDefinitionId`；作用域覆写绝不继承被遮蔽注册的身份。`CommandInvocation`/`command/run`/`command/done` 未变。
- **计划评审携带来源调用**：user-questions 的 `AskUserQuestionIntent` approve 变体新增 `callId?: ToolCallId`（其参数包含被评审计划的已记录工具调用）—— 评审面可以据此解析计划文档。
- **技能暴露路径**：`ctx.skills.list()` 现返回 `SkillSummary.path?`。
- **附件图片请求改目标制**：`ImageRequestPolicy` → `ImageRequestTarget`（`maxPixels` → `width`+`height`，`maxBytes` 保留）；`readImageRequest(ref, target, signal)`；新增 `longEdgeDimensions` + `ProjectedDimensions`。终端的保存/接纳路径未受影响。
- **Goal 解除时机**：激活解除钩子从 `agent/session-start` 移到 `agent/created`（现为被等待的异步初始化边）；持久 `goal/change` 词汇未变。
- **Schedule 应答归档准入**：`workspace/session-activity` 以 `SessionActivity` kind `schedule` 报告活跃提醒；`workspace/session-stop` 追加持久 `schedule/change` 删除；新增 `ScheduleRuntime.activeRecords()`；不变量伴生插件更名 `tool-schedule-invariant` → `schedule-invariant`。
- **沙箱 workspace root 必须绝对**：`resolveWorkspaceRoot` 不再规范化；相对 `workspaceRoot` 抛错。`SANDBOX_MODES`/`setSandboxMode`/`sandbox/mode` 事件未变。
- **util/values**：新 `WeakMapWithValues<Key,Value>`（弱键 + 强保留插入序值）。
- **范围内未变**：`boot/cmdline`（无 flag 变化）、`runtime-diagnostics/invariants`、`todo/tool-todo`（`todo/change`、`TodoItem` 未动）、`context/file-reference-local`（仅内部异步初始化）、`user-approval` API 面本身。

## Bundle、launcher 与兼容性

- **peer 兼容性开始强制（迫使本次对齐的门）**：`evaluatePluginCompatibility`（`packages/boot/app-boot/src/plugin-compatibility.ts`）以运行时版本（app-boot 自身 `package.json` 版本，semver `includePrerelease`）检查包 `peerDependencies` 中每个 `@deepseek-ai/dsh*` 条目。安装时强制（类型化拒绝、失败码 `incompatible-version`），引导时也强制：`loadProfileDirectory` **跳过 peer 不匹配的整个 bundle 层**，`prepareProfileEntries` 禁用单行。dsh-code 的精确 `0.1.5-rc.2` pin 在 `0.1.7-rc.1` 宿主下会被拒绝 —— 版本升级是硬前提，不是装饰。用户侧逃生门：经 `dsh plugin allow-version <pkg@version> --dsh-version <exact> --accept-risk` 授予的 per-profile `compatibility.json`。
- **`dsh.bundle.patch` 接受有序列表**：`string | string[]`（`ProfileLayer.patchPath` → `patchPaths`）；每个文件的相对插件路径在该文件旁解析。web-app bundle 是旗舰用户（其 `cordis.patch.yml` + 四个预设 patch）。
- **基础 bundle 行变更**（`packages/bundle/base/cordis.patch.yml`）：新行 `plugin-manager`、`tool-plugin-manager`（disabled）、`config-editor`、`settings`（`dsh-settings-file` 更名 `@deepseek-ai/dsh-settings`）、`authorization`、`deepseek-account`、`mcp-resources`、`image-offload`、`ptc-runtime` + `workflow-ptc`；`hmr` 改指 `@deepseek-ai/dsh-hmr`（profile 引导中启用，拥有 profile 配置重载）；`workflow-worker-thread` 移除；`spill-policy.maxInlineBytes: 50000` → `maxInlineTokens: 12500`；`tool-ralph` 默认 disabled。对 dsh-code patch 的后果：`authorization` insert（143–144 行）会双重挂载，必须删除（依赖保留给 `src/authorization.ts` 导入）；`hmr`/`tool-ralph` disable 现部分冗余但无害；基础仍缺、dsh-code 仍需 insert 的 —— `subagent-model-selection-settings`、`cordis-host-runner`、`session-reference`、`file-reference-local`。
- **预设经 bundle**：预设内容以 `packages/bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` 发布（顺序 1–4）；`@deepseek-ai/dsh-agent-preset-registry` 提供 `agentPresets` 服务（`Config.default` 必需；`selectedDefault`/`modeSelectionEnabled` volatile），`@deepseek-ai/dsh-agent-preset` 提供声明行（`config: {id, order, plugins}`）。CLI 的内置预设根机制（`dsh.configTrees`）移除；"遗留目录式预设需要迁移"。dsh-code 必须把四个预设声明以 `agent-preset` 行内联（vendor 自上游 patch 文件）。Team 模式随内联预设免费获得（上游用 `spawn_teammate`，team 上下文中 `subagent`/`subagent_fork` 禁用）。
- **PTC 运行时**：`@deepseek-ai/dsh-ptc-runtime`（抽象 `ctx.ptcRuntime` 缝）+ `@deepseek-ai/dsh-ptc-runtime-node` —— 进程隔离的 Node 执行（每次调用新进程、空 `process.env`、输出/堆/时限；Config `timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/…），"无遗留别名"地更名。Workflow 编排在同一沙箱运行时中执行。
- **CLI launcher**：`dsh <name>` profile 简写取代硬编码 `web` 别名；新 `--dump-config-schema`（Cordis 配置的 JSON Schema —— 可在 CI 中校验 `cordis.patch.yml`）；`plugin` 子命令解析兼容性豁免命令；启动失败把 `StartupError` 报告存到 `$DSH_HOME/logs/startup-*.log`，未捕获异常致命（`installFailLoud`）。
- **vendor 三件套**：`cordis` 4.0.2→4.0.4、`cordis-plugin-loader` 1.0.3→1.0.5、`cordis-plugin-include` 1.0.7→1.0.9、`schemastery` 3.18.2→3.18.4 —— dsh-code 的 caret 全部仍满足（NO-OP）。
- **线主题**：0.1.6 线是引擎重构（boot 运行时解析、plugin-manager 服务抽取、HMR 生命周期、沙箱 PTC 执行、V4 地基、headless 缝）；0.1.7 线是产品面（Web 侧栏终端、会话归档、MCP 资源、Office 预览、语音输入）加 Messages-only DeepSeek 适配器、预设经 bundle、兼容性强制。官方发布说明：[dsh-v0.1.7-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)（相对 `dsh-v0.1.5-rc.3` 的汇总）。

## 对齐计划（分阶段）—— 已执行

下面的 Stage 0–2 已在 0.1.7-rc.1 对齐中实施；Stage 3 暂缓。验证：`pnpm verify` 全绿（89 文件 / 1211 测试、零警告 lint、两项类型检查、性能门禁），另有隔离运行时探针 —— 本地工作树装入 stock `@deepseek-ai/dsh@0.1.7-rc.1` 宿主上的 `cli` profile 后可引导（`--help`），`--dump-config` 输出预期组合（registry 行、四个预设声明、base 的单一 `authorization` 行、host 级 `workflow-ptc`/`tool-workflow` 禁用）。除下述条目外，本次对齐还从 stock 宿主安装重新生成了 `tests/host-bundled.json`（278 个解析包），并扩展 `tests/bundle-patch.spec.ts` 以遍历有序 `dsh.bundle.patch` 列表中的每个 patch 文件（递归 `cordis:group` 行）；测试 fixture 经共享的 `tests/helpers/events.ts` `fixtureEvent()` 包装迁移到 v4 形状（品牌化序列、必填 `surfaceOp`）。

### Stage 0 —— pin 与 bundle 组合（机械）

1. 把 `package.json` 中所有 `@deepseek-ai/dsh-*` pin（依赖、peer、dev 依赖 —— 85 处）从 `0.1.5-rc.2` 升到 `0.1.7-rc.1` 并解析 lockfile（npm `next` tag 有货）。新的 peer 兼容门会强制这一点：旧精确 pin 安装被拒、bundle 层引导被跳过。`bin/deepseek.mjs` 从 `peerDependencies['@deepseek-ai/dsh-session']` 推导宿主线，launcher 锚点自动移动；把 `src/runner/harness-gate.ts:26` 的 `EXPECTED_HARNESS_VERSION` 升到 `'0.1.7-rc.1'`（否则 TUI 按设计拒绝新宿主）。
2. 换被移除的包：`@deepseek-ai/dsh-agent-presets` → `@deepseek-ai/dsh-agent-preset-registry`（`agentPresets` 服务名保留 —— `ctx.get('agentPresets')`、`resolve`、`recompose`、`select`、`list` 都在 `AgentPresetRegistry` 上；`src/presets.ts` 只需换导入）；删除 `@deepseek-ai/dsh-code-runtime-worker-thread`（已删除；基础包现在提供 `ptc-runtime`）。
3. 重写 `cordis.patch.yml`：删除 `code-runtime` insert 与死掉的 `workflow-worker-thread` disable（决定 TUI 对 `workflow-ptc` / `tool-workflow` 的立场）；把 `agent-presets` insert 指向 `@deepseek-ai/dsh-agent-preset-registry`，并把四个预设声明作为 `@deepseek-ai/dsh-agent-preset` 行从 `packages/bundle/web-app/presets/*.patch.yml` 内联；**删除 `authorization` insert**（基础包现已自带；二次 insert 双重挂载 —— 只保留依赖给 `src/authorization.ts`）；刷新过时的预设根注释。
4. vendor 运行时依赖保持现状（`cordis` 4.0.4 / `loader` 1.0.5 / `schemastery` 3.18.4 都满足现有 caret）。

### Stage 1 —— 投影改说 v4（BREAKING，真正的工作）

1. **工具结果扁平化，两条折叠路径**（`src/render/projection.ts` 的实时视图与重放）：直接读 `message.toolCallId`、`message.content`、`message.isError`，不再读 `content[0]` 的 `tool-result` 包装。修好之前，每个重放的工具结果都会错误渲染（行卡在运行中、摘要错误）。
2. **生产者来源 kind**：把每处 `message.source.kind === 'plugin'` 分支（约 6 处）换成直接 kind 匹配 —— `HIDDEN_SNAPSHOT_KINDS = {'time-context','tmux-context'}`、`REMINDER_KINDS = {'schedule'}`、外来生产者走 `plugin:<name>`；通知行读 `ContextFormed`（`form:'notice'` + `summary`），这也把模型切换通知（`model-selection`）从退化的 kind 字符串标签升级为摘要。运行中 `MessageSourceMap` 也删了 `plugin`，所以这是类型错误，不只是死代码。
3. **已知事件处置**：在 `src/render/projection-events.ts` 中归类 `developer/message`、`image/offload`、`workspace/changes`（升级后覆盖测试失败直到补上）。`developer/message` 是面类型 —— 折叠需要一个条目（至少与系统提示节点处理一致的有界 no-op/处置）。
4. **Turn 结束词汇**：标注 `turn/end {kind:'forked'}`（fork 子会话合法携带）；合成 `forked-tool-result-*` 错误结果按普通失败工具渲染，措辞是父会话特定的。
5. 回归覆盖：把投影 fixture 迁到 v4 形状（扁平工具结果、直接 kind），保留一个 v3 形状的 resume fixture 端到端证明读取时迁移路径。

### Stage 2 —— 服务适配（BREAKING/ADAPTATION）

1. **Jobs**：导入 `JobView`（或 `@deepseek-ai/dsh-jobs/view` 叶子）、传 `SessionId` 调用方、变更通知改 `events.subscribe`；行字段保留。若 TUI 读任务输出，采用游标式 `read()`/`readAt()` 环语义。
2. **子代理目录 v1**：在 `src/session/subagents.ts` 显式处理 `mode:'unknown'`（今天它静默强转为 `one-shot`）。
3. **权限预设**：订阅 `permission-presets/catalog-changed` 并重读目录，不再假设静态 `names` 表；决定是否暴露实验性 `auto` 预设。
4. **默认模型持久化**：核实 TUI 挂载上下文给插件 loader 条目 —— 否则 `saveSelection` 静默 no-op。
5. 策略注记：`session.snapshotEvents()`（3 处调用）上游已 `@deprecated`；在方便时规划离开同步读取器的迁移。

### Stage 3 —— 可选采纳（暂缓）

- 计划评审 `intent.callId` → 在评审面解析被评审的计划文档（与审批预览同模式）。
- `SkillSummary.path` 做技能文件预览；`descriptor.definitionId` 进命令指纹；@session mention 用 `displayTitle ?? label`；`SubagentTimingProjection.lastTurnCompleted` 做更丰富的 agent-feed 行；容量提示（`maxActiveSubagents` 8 / `maxDepth` 1）与 `subagent/delivery-unavailable` 文案；token 计量的 `image/offload` 对齐；经 `buildForkSeed` 的回中 `/fork`（上游现支持带合成闭合器的精确前缀 fork）。

## 证据

- `a60af51e80` release(dsh): 0.1.7-rc.1 —— 统一升到 rc 线。
- `669b724a78` V4 集成格式与 V3 重放输入；`8dc1d0e3ed` 一次性 V4 语料迁移命令。
- `f4a32dbd0a` 扁平化工具结果并校验原生 V4；`fb79a944f5` 分离持久生产者来源与请求输入；`e0bd7e1960` developer 变更；`29f7e7bdf5` 保留已退役系统文本。
- `8696ec6cef` 精确前缀 fork 与合成尾结果；`b5e7fca4a5` 图片卸载决策；`debb4b9a9c` 持久图片卸载恢复；`f937f4e23b` workspace/changes 事件。
- `9b7a8ccc9f` 经 `agent/created` 等待初始化；`11656ca683` 仅启动注册；`cbae324bfa` 归档前停止会话运行中的工作 (#4765)。
- `601d6761e4` 经 profile 表单投影 volatile Config (#4587)；`3f7016a422` volatile 模式 (#4579)。
- `e55093b47d` 目录消费方迁移到父投影；`f984683956`/`a978ad1994` catalog v1 unknown-mode；`16620a3a70`/`d7f9d3a773` 激活上限；`0eed02d447` 容量拒绝映射；`29debb8b24` 纯文本结算通知。
- `07941fe5e2` jobs 缝隙合并（+ `cbae324bfa`、`bb20149360`、`0e35952802`、`2c0ca45f76`、`4baea3bb83`、`3df99217dc`）。
- `55e53907ab` 实验性 Auto review；`996278e6ce` 命令身份；`f6428a164e` 计划评审 `callId`；`11d6bd05f3` `SkillSummary.path`；`ba30b73f7b` 图片请求目标；`caa69608fb` 沙箱根绝对化；`c52ef9fada` 所有权生命周期原语。
- `2c67633990` DSH peer 兼容强制与精确豁免；`747c98b0db` 拒绝不兼容 bundle；`51d70c5f5c` 类型化不兼容拒绝；经 `07ad70817f` 合并。
- `654caa4bbd` `dsh.bundle.patch` 有序 patch 列表 (#4722)；`d1e22a7e24` profile YAML 预设 (#4569)；`b13bbc027c` 预设创作技能 (#4836)；`7c9bb5914c` PTC 运行时命名；`75ed8da3e0` 受限进程 Node 执行；`35af8698c2` 编排进沙箱 PTC；`98b92b683c` plugin-manager 服务；`abd765a600` HMR 生命周期；`4eb26f0e71` `--dump-config-schema` (#4705)；`1d6534a810` profile 简写；`99e22ebbeb`/`b0641b83fc` Messages-only DeepSeek 适配器；`9f9a50e553` installFailLoud；`de662ee010` 跳过失败 profile bundle (#4516)。
- `d088572e11` `SessionPersistence.identity`；`6fef0f0af9` session-query 缓存身份；`86ca9de07e` 冷行来自投影缓存；`34a43129a6` 引用标题回退；`e62587c163` 子代理标签 mention。
- `5cfc765ff6`/`aa491acc29`/`8f986c8da6`/`14da43d9ff` 弃用直接事件读取器；`048297321a`/`5b7195e032` 凭据登录 + commit。
- `packages/session/session-format-v3-to-v4` README —— 上文引用的 V3→V4 规格；目标上的 `docs/session-format-status.md` —— 写入器/定稿/发布记录。
- 官方发布说明：https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1
