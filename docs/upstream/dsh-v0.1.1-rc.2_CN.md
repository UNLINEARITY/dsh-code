# DSH 上游审计：v0.1.1-rc.1 与 v0.1.1-rc.2

## 对比版本

| 版本 | Commit | 作用 |
| --- | --- | --- |
| `dsh-v0.1.0-rc.8` | `141eb6fef83422698aef7a981029e843e8161534` | dsh-code 之前的对齐基线 |
| `dsh-v0.1.1-rc.1` | `528c682e061696f5a160f363f236ecbf53cbd006` | 第一个新增上游版本 |
| `dsh-v0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 本次目标版本 |

本文区分 Harness 内核/服务变化与只属于 Web 界面的改动。dsh-code 复用 Harness 运行时契约，只把适合终端完整交互的能力接入 TUI。

## v0.1.1-rc.1

### 凭据记录与授权流程

- Harness credentials 现在分为两类存储：
  - `DEEPSEEK_API_KEY` 这类环境变量式 reference；
  - provider 自有的 API key 或不透明授权 grant record。
- 新增 `@deepseek-ai/dsh-authorization` 服务，插件可以注册 OAuth、设备码、交互式 API key、文本、秘密输入和选项流程，而调用界面不需要理解具体 provider SDK。
- pi-ai provider 可以持久化 OAuth grant 与交互式 API key，包括 OpenAI Codex 等只支持 OAuth 的路由。
- 旧的平面 `.credentials.yaml` 会自动迁移为 `version` / `refs` / `records` 结构。
- Breaking change：`credentials/updated` 改名为 `credentials/reference-updated`；record 使用独立的 `credentials/record-updated`。

dsh-code 1.0.1 挂载 authorization 服务，在 `/model` 中提供完整登录，同时保留手动 API key 配置。

### Session Projection 协议

- Projection 通过 `stateSchema` 和可选 `wire` 分离 host 内部状态与客户端视图。
- 只在 host 使用的状态不再强制序列化给客户端。
- 缓存恢复前会验证内部状态；损坏缓存自动退回完整事件重放。
- 所有 projection unit 使用统一 checkpoint。

dsh-code 1.0.1 继续使用现有纯 transcript projection。只替换标题、权限、Goal、Plan 或 Todo 会形成两份状态来源，却删不掉多少代码。

### 模型与运行时变化

- 默认 DeepSeek 模型目录加入支持文字与图片输入的 `deepseek-v4-flash-vision-exp`。
- Linux bubblewrap 增加 PID namespace 隔离，堵住 `/proc/<pid>/root` 逃逸路径。
- 模型重试耗尽后，最终 turn error 仍保持可见。
- 稳定 Session snapshot 的工作加强了夹具和重放验证，不要求迁移已有会话。

### 不作为内核功能处理的变化

多行问题编辑、宽 Markdown 表格、subagent header 切换、composer 编辑范围和缓存小数显示主要属于 Web 客户端。dsh-code 只独立采用适合终端的“粘贴多行回答”和缓存一位小数显示。

rc.1 曾短暂加入空白会话默认权限设置，但 rc.2 已完整撤销，因此 dsh-code 不依赖该临时功能。

## v0.1.1-rc.2

### 统一图片存储与请求管线

- 源图片先规范化为 provider 无关的持久附件，再进入模型请求。
- 默认源文件限制提高到单图 20 MiB、单消息 200 MiB、6400 万像素和 8192 像素源边长。
- 持久化阶段统一处理 EXIF 方向、元数据、色彩空间、位深、动画输入和超大尺寸；默认持久化长边为 2048 像素。
- 当图片被缩小时，`ImageAttachmentRef.originalDimensions` 记录应用方向后的原始尺寸。
- `readImageRequest(ref, policy)` 生成确定性的模型请求版本，通过 `ImageVariantId` 复用结果并限制 native 图片处理并发。

### DeepSeek Files API

- DeepSeek Vision 优先上传并复用 Files file id。
- 上传身份按 endpoint 与凭据范围隔离。
- 过期、删除、拒绝或受 quota 影响的 file id 会被定向失效并按策略重试。
- Files 解析失败时，整次请求回退为 inline data URL；同一次请求不会混用 file id 与 inline。
- Files 与模型流式响应使用独立 timeout。
- 当前 adapter 不会发布“已经回退”的事件，因此 dsh-code 只在文档中说明，不通过网络或日志猜测。

### 模型能力与纯文本降级

- 精确模型元数据包含输入模态和模型路由自己的图片预算。
- 会话历史包含图片时仍可切换纯文本模型；该次请求会把图片稳定投影为文字占位符。
- `prepareCall()` 让能力解析和真正 dispatch 使用同一 adapter generation，避免热更新期间错配。

dsh-code 在 `/model` 中显示 `image`，切换纯文本模型时明确提示，并在 transcript 与导出中显示规范化尺寸和原始尺寸。

### 配置与兼容

- 旧 DeepSeek 配置项 `maxRequestImageBytes` 已删除。
- 图片限制改为 Files 与 inline 两组请求策略。
- 自定义 attachment provider 虽可继续编译，但若不实现 `readImageRequest()`，Vision 请求会在运行时拒绝。
- 从 rc.8 升级不需要迁移 dsh-code 持久会话。

## dsh-code 1.0.1 的采用范围

已接入：

- 全部依赖精确对齐 `0.1.1-rc.2`；
- provider 登录、状态、取消、退出、浏览器和设备码交互；
- `@` 图片附件与终端拖入图片转换；
- 图片模型标识、纯文本提示和规范化元数据；
- 凭据事件迁移与重试最终错误回归。

明确保留：

- dsh-code 自己的事件驱动 transcript projection；
- 原有手动 API key 与 provider 配置工作流；
- 上游 Files 到 inline 的静默回退；
- 1.0.0 文档中对 rc.8 的历史记录。
