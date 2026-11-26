# 安装、升级与排障

[English](installation.md) | 中文 · [README](../README_CN.md)

本页说明原生模块加载、版本对齐、设置迁移与依赖修复。npm 基本安装步骤见[快速开始](../README_CN.md#二快速开始)。

## 原生安装脚本

如果 npm 提示 `npm warn install-scripts`，或 dsh 启动时无法加载原生模块，请重新执行快速开始中的 npm 命令，并保留 `--allow-scripts` 参数。该参数允许终端、会话存储和进程沙箱所需的依赖，以及 `@google/genai` 和 `protobufjs` 执行安装脚本。

## 版本对齐

DSH-Code 2.2.0 需要 Node.js 24.9.0 或更高版本，宿主版本为 `@deepseek-ai/dsh@0.2.2-rc.5`。请同时升级 dsh、DSH-Code 和单独安装的 Harness profile 插件。若 profile 使用本地 `link:` 挂载，先更新宿主，再用 `pnpm install --frozen-lockfile && pnpm build` 重新构建源码。

宿主已提供会话查询工具。如果 `cli` profile 中单独安装了 `@deepseek-ai/dsh-tool-session-query`，可用 `dsh plugin --profile cli remove @deepseek-ai/dsh-tool-session-query` 移除重复安装。

## 会话迁移

旧会话与旧参数中记录的 `code` 预设会自动映射到上游已改名的 `ptc`，无需手动迁移。会话日志读取端随上游升级到格式 v4：旧格式日志在读取时由内核自动迁移（v3→v4），磁盘上的原始文件保持不变。

## 设置迁移

面向 dsh 0.1.x 的旧版本首次启动时，宿主会把旧版全局 `settings.yaml` 一次性迁入当前 profile（文件随后改名为 `settings.yaml.imported`）。请让 dsh 与 dsh-code 同步升级，避免夹在中间的降级启动。若升级后发现模型/供应商配置消失：TUI 会在启动时检测并经由宿主自己的设置管道自动重新导入，无需手动操作（凭据不受影响，无需重新登录）；仅在设置服务不可写的极端情况下，才需要把 dsh 主目录下的 `settings.yaml.imported` 复制为 `settings.yaml` 后重启。

## 依赖修复

手动重装 dsh 后，先关闭全部 dsh 会话，再运行 `deepseek repair-deps`。该命令将宿主清单与锁文件备份到 `~/.dsh/backups/runtime-deps/`，在现有安装位置应用指定版本的依赖修复，检查各服务实际加载的版本，并审计生产依赖树。`deepseek setup` 与 `deepseek update --apply` 已包含此步骤。`deepseek repair-deps --check` 只检查实际版本，不修改文件；`deepseek doctor` 也包含该版本检查。

## 升级与安装排障

升级 `@deepseek-ai/dsh` 前，先退出所有正在运行的 `dsh` / `deepseek` 会话：全局安装会替换运行中 TUI 仍在读取的文件，该会话会以 `read EIO` 退出。每次安装或升级后检查组合：

```sh
dsh --profile cli --dump-config   # 输出中不应出现 "skipping"、"disabling" 或 "not found"
deepseek doctor
```

| 现象 | 原因 | 处理 |
|---|---|---|
| 出现 `npm warn install-scripts`，之后报 `Failed to load native module`（`pty.node`、`koffi`），或终端、会话持久化插件加载失败 | npm 11.6+ 默认跳过未经批准的全局依赖安装脚本 | 带上批准列表重装：`npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh@0.2.2-rc.5 pnpm` |
| 升级过程中正在运行的会话以 `read EIO` 崩溃 | 全局安装替换了会话正在读取的文件 | 退出所有 `dsh` 会话，重新执行安装，再重新启动 |
| `--dump-config` 输出 `skipping` 或 `disabling`，并提示 peer 版本不匹配 | profile 中有插件仍依赖较早的 Harness 版本 | 将提示中的插件重装为 `0.2.2-rc.5`。宿主已包含会话查询工具，可移除单独安装的 `@deepseek-ai/dsh-tool-session-query` |
| `patch: entry "<id>" not found` | `~/.dsh/profiles/cli/cordis.patch.yml` 覆盖了新版本线已删除的行。0.2.1 删除了 `tool-ralph`、`skill-badge` 和 `*-invariant` 各行 | 从 profile patch 中删除该条目 |
| `Cannot find module '@deepseek-ai/dsh-invariants'` 或 `.../invariant` | 0.2.1 删除了运行时 invariant 相关包 | 从 profile patch 中删除名为 `@deepseek-ai/dsh-invariants` 或以 `/invariant` 结尾的行 |
| 每次模型请求都在发送前失败，报 `unknown prompt variable "{{cwd}}"` | 0.2.1 删除了 `{{cwd}}` 提示变量，会话目录改为以上下文形式提供给模型 | 删除 profile patch 中 `personaPrefix` / `suffix` 里含 `{{cwd}}` 的句子 |
| `tool-subagent` 配置拒绝 `backgroundMode`、`persona` 或 `toolFilter` | 0.2.1 改用托管子代理激活和 Agent Preset | 从 profile patch 中删除这些键 |
| 工具配置拒绝 `mode: both` 或 `DSH_TOOLS_MODE=both` | 工具呈现方式只接受 `native` 或 `ptc` | 改为 `native` 或 `ptc` |
| 升级后报 `AUTH: Authentication Fails, Your api key ... is invalid`，但导出的 key 本身可用 | 自 0.2.1 起，`~/.dsh/.credentials.yaml` 中保存的同名 key 优先于导出的环境变量 | 在 `/model` 中替换已保存的 key（按 Tab 进入供应商管理），或删除 `~/.dsh/.credentials.yaml` 中 `refs` 下的同名条目，改用导出的变量 |
| `/model` 中 DeepSeek 或其他供应商分组消失 | API key 路线在凭据配置前不再列出模型 | 在 `/model` 中配置 key，或导出该路线 `apiKeyEnv` 指定的变量 |
| `/hooks` 拒绝写入并给出安装命令 | 宿主不再捆绑钩子桥 | 执行提示的命令，例如 `dsh plugin --profile cli add @deepseek-ai/dsh-hooks-claude-code@0.2.2-rc.5 @deepseek-ai/dsh-hook-protocol@0.2.2-rc.5`，然后重启 |

Harness 升级指南逐项列出了全部迁移步骤：[docs/upgrade-guide](https://github.com/deepseek-ai/deepseek-harness/tree/main/docs/upgrade-guide)。更多问题与处理：[常见问题与排障](problems.md)。
