# DSH 上游对齐审计：v0.1.2-rc.1 → v0.1.5-rc.1

## 对比版本

| 版本 | Commit | 角色 |
| --- | --- | --- |
| `dsh-v0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | dsh-code 上一基线 |
| `dsh-v0.1.5-rc.1` | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | 目标版本 |

区间共 1,486 个提交、159 个合并的 pull request。本笔记记录终端实际消费的内容、被动适配的部分与暂缓引入的部分；仅属于 Web 客户端的改动（侧栏、dock 布局、open-in-app、图片工具卡）与 TUI 无关，不再复述。

## 会话日志格式 v3（结构性变更）

`SESSION_FORMAT_VERSION` 从 `0` 升到 `3`，内核随附三条迁移（`v0-to-v1`、`v1-to-v2`、`v2-to-v3`）。经持久化服务读取的消费方拿到的永远是迁移后的当前流——迁移在 JSONL 后端读取时于内存完成，不改动已提交的文件。

- **持久日志只含结算**（`v1→v2`）：顶层 `assistant/chunk` 事件不复存在。装配完成的 `assistant/message`（以及承载失败、重试、取消尝试的新日志事件 `assistant/attempt`）以内嵌的 `data.stream: AssistantStreamRecord[]` 保留精确计时，读取器（`expandAssistantStream`、`joinAssistantStreamText`、`assistantStreamFirstTokenTime`）由 `@deepseek-ai/dsh-llm` 导出。
- **实时打字是独立通道**：进程内 `agent/assistant-stream` 帧（`start`/`chunk`/`end`，以 `attemptId` + `revision` 标识；`end` 帧指明落账的结算事件）。它不是预写日志——结算落盘前的硬崩溃会丢失在途流。
- **系统提示成为 surface 节点**（`v2→v3`）：首个 `system/message` 事件是 surface 节点 0；`request/header.data.header.system` 字段被移除。压缩区间永远不会覆盖系统节点 0；后续节点可能落入压缩区间，终端的折叠对任意 surface 替换（不限于 `system/message`）都会退役被覆盖的节点。
- **PTC 持久词汇**（`v2→v3`）：`tool/code-dispatch(-start)` 改名为 `tool/ptc-dispatch(-start)`；插件署名 `tools-code-mode` 在 `user/message` 的来源槽位改为 `tools-ptc`；头与 `agent-preset/selected` 中的预设 id `code` 改为 `ptc`。
- **规范信封**（`v2→v3`）：`surfaceOp.replace` 的字段 `start/end` 改名为 `startSeq/endSeq`；surface 事件必带 `surfaceOp`；`assistant/message` 禁止携带 `sourceEventSeqs`。
- **新增已知事件**：`assistant/attempt`、`system/message`、`tool/ptc-dispatch(-start)`、`subagent/catalog`、`deliverables/presented`、`feedback/message-put`、`feedback/message-delete`。`present` 工具随 standard 与 ptc 预设挂载，因此 `deliverables/presented` 同样会到达终端——终端将其按已知类型空操作折叠，原因是发起展示的工具自身的工具卡已呈现所展示的路径，而非该工具缺席。
- **磁盘上的不可变多代文件**：一个会话目录可以同时存放 `session.jsonl`（v0）与 `session.v1.jsonl`/`session.v2.jsonl`/`session.v3.jsonl`（各自可选 zstd 压缩）；读取方取数字最大的一代，绝不改写更早的代。

## 持久化服务

- 服务改为 handle 形态：`open(id, 'read'|'write')` 返回带 `read(offset?, length?)` 的 `SessionHandle`，另有 `stat(id)` / `list()` 返回轻量快照（`{header, revision, eventCount?, sizeBytes?}`）。
- `load`/`inspect`/`readFrom`/`locate` 已删除；工件路径不再是面向消费方的查询（`SessionLocation` 只随拒绝诊断携带）。
- `SessionPersistence.list` 改为接收选项对象；`SessionHeader.version` 即当前格式版本；`RestoredSessionOptions.seedSource` 改为 `eventState: 'detached' | 'shared-frozen'`。

dsh-code 的两处文件系统需求（会话列表的最后活动时间、`/delete` 的布局守卫）改为本地推导：JSONL 后端通过公开的插件配置暴露其 root，`<root>/<projectKey(cwd)>/<encodeSegment(id)>/` 布局与多代文件名是镜像到 `src/session-directory.ts` 的纯上游契约。

## 命令与附件

- `CommandInputDescriptor.images` 改为 `attachments`；`execute()` 接收 `CommandSubmitAttachment[]`（`image` 部件或暂存的 `file` 凭据），`CommandInvocation.attachments` 中 `FileBlock` 与图片并列。
- 附件库新增 `saveFile`/`saveFileStream`/`readFileStream`/`admitEncodedFile` 与方法化的 `admitPromptContent`；`saveImages` 与图片限制未变，TUI 的图片路径无需改动。

## 系统提示插件配置

`system-prompt` 插件的 `persona` 键拆分为 `personaPrefix` 与 `personaSuffix`，分置第一方指导段的前后。bundle patch 现在覆写 `personaPrefix`。

## 预设与工具

- 预设集合（`cordis`、`minimal`、`ptc`、`standard`）不变；持久日志中 `code` → `ptc` 的改名由 v2→v3 迁移处理，dsh-code 的 `LEGACY_PRESET_IDS` 桥继续覆盖手输的旧 id。
- 上游 base bundle 移除了 `tool-str-replace-editor`（`minimal` 预设改为单工具组合）；本包 patch 不再禁用该行。
- 上游 `web-app` 仍携带 dsh-base 未提供的 `subagent-model-selection-settings` 宿主行，本 patch 保留对应的兼容插入。

## 模型与发现

- 目录新增模型 `deepseek-flash`（DeepSeek-V41-Flash，文本+图片输入）；base bundle 的默认模型切换为它。
- 供应商模型发现支持经 `anthropic-messages` 协议（`GET /v1/models`，`x-api-key` + `anthropic-version`）列举，并识别更多网关富字段；损坏的供应商目录不再整体消失——`LlmConfigurableProvider.error?` 与 pi-ai 的 `catalogError`/`modelErrors` 携带诊断。
- 子进程现遵循代理解析（`HTTP_PROXY` 等）；MCP 工具分页检测 continuation 游标循环；Windows 子进程隔离改用 Job Objects（立即终止）。

## Agent 面

- `ctx.agent` 访问器移除；`AgentSetup` 回调以第二参数接收装配完成的 agent。
- 收件箱改为由持久 splice 重建的会话投影；`Inbox` 的形态是只读数组加 `clear`/`append`/`prepend`/`replace`/`remove`/`splice`。
- 子代理新增持久目录（`subagent/catalog`，one-shot 与 continuable 之分）与转向投递（`subagent.start` 的 `delivery: 'queue' | 'steer'`）；goal 发布 `goal/activation-changed`（armed/disarmed），且模型不能再自行恢复暂停的 goal。
- dsh-code 以流帧驱动实时打字、将 `assistant/attempt` 折叠为持久诊断；目录已进入 /agents 实时行（以 idle 行显示授权标签与模式，迟到投递不会使已运行的行回退）；转向投递与激活状态仍留待后续。

## 本次对齐中 dsh-code 的采纳（阶段 1–3）

阶段 2 补充供应商配置诊断（适配器的 `error` 随目录行进入 /model 列表与统一配置页）与系统提示数据层（逐节点折叠、`TranscriptView.systemPrompt`、/export 折叠块）。阶段 3 补充终端文件附件（粘贴/拖拽按图片与文件块分流，终端侧自设单文件 8 MiB、每条 8 个上限，composer 草稿与投影/导出标签）以及子代理目录行。启动器在计划版本线低于已装宿主时拒绝降级；`/fork` 经 0.1.5 契约记录谱系（`meta.isSeeded` 加顶层 `inheritedEventCount`——`meta.seedLength` 拼法属于上游更晚的草案，已发布内核会拒绝该字段）。

- 全部 `@deepseek-ai/dsh-*` 依赖升至 `0.1.5-rc.1`（dependencies、peers、devDependencies、启动器的宿主版本线锚点以及两个锁定版本线的测试）。
- `src/render/projection.ts` 改讲 v3 词汇：`assistant/chunk` 分支删除；实时打字走 `agent/assistant-stream` 帧，经 `src/store.ts` 中新的累加器原语（`applyAssistantStreamChunk`、`clearAssistantStream`）折叠；结算事件从内嵌的 `data.stream` 恢复重放文本与计时（含首 token 延迟）；`assistant/attempt` 释放步骤锚点并清空被放弃的尾部；`system/message` 接管 `request/header` 原先携带的系统段估算。
- `src/session-directory.ts` 推导多代布局并保持 `/delete` 守卫；`src/index.ts` 读取快照列表、使用 setup 回调的 agent 参数并接线流监听。
- `cordis.patch.yml` 覆写 `personaPrefix` 并移除已退役的 str-replace-editor 行。
