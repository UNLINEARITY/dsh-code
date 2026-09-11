# 常见问题与排障

本页记录 DSH-Code 安装、启动和插件加载时最常见的问题。开始排查前，请确认 Node.js 版本符合 `^22.19 || >=24`，并使用 `dsh --profile cli` 启动。

## `session_search` 每次调用都失败并报「session query operation failed」

### 现象

模型调用 `session_search` / `session_event_search` 时总是返回通用错误「session query operation failed」，而 `session_trace`、`session_event_read` 正常。终端 stderr（被界面覆盖，翻看启动日志可见）里才有真实原因，形如：

```text
SessionQueryError: SESSION_QUERY_PERSISTENCE_FAILED
subagent/descriptor … uses unsupported descriptor version 2
```

### 原因

全文搜索在每次查询前要对全部持久化会话做一次语料核对。只要**任意一个**会话文件里存在当前版本的冻结解码器无法接受的事件（已知实例：0.1.5 发布前 alpha 时代的构建把 `subagent/descriptor` 以版本 2 写进了 v0 代会话文件，而发布版 v0 解码器只接受版本 3），整个核对就会失败，导致**所有**跨会话搜索整体不可用——同一工作区里可能存在**大量**此类历史会话。精确读取与谱系工具不经过语料核对，近期会话（v3 代）也不受影响，因此问题常被误判为局部故障。此外，若插件与宿主各自解析到两份物理不同的会话查询包（版本号相同但模块实例不同），类型化错误会在边界处退化为上述通用文案，真实诊断只进日志。

### 解决

本 bundle 已内置修复：dsh-code 自带的容错会话检索引擎在核对时**跳过**无法解析的会话（每次跳过在日志中留一条警告），其余会话照常索引；被跳过的会话在后续搜索中自动重试，升级到能够解析它的 dsh 版本线后会自动回到索引，无需任何手动处理。旧版 dsh-code 的临时办法是把对应会话目录移出会话根目录隔离（移出后该会话不再出现在 resume 列表，移回即恢复）：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\sessions-quarantine" | Out-Null
Move-Item "$env:USERPROFILE\.dsh\sessions\<工作区目录>\<会话 id>" "$env:USERPROFILE\.dsh\sessions-quarantine\"
```

## Linux：`Failed to load native module: pty.node`

### 现象

启动时出现类似错误：

```text
Failed to load native module: pty.node
Cannot find module './prebuilds/linux-x64/pty.node'
```

这类错误最外层常表现为插件树加载失败；真正的根因是 `node-pty` 找不到自己的原生二进制 `pty.node`。

### 原因

DSH 的本地子进程插件依赖 `node-pty@1.1.0`。在 Linux x64、Node 24 等没有匹配预构建二进制的环境中，它本应回退到 `node-gyp` 源码编译；但全局安装链路可能在编译失败后仍显示安装成功，留下缺失的 `pty.node`。这与 DeepSeek Harness 已报告的问题一致。[上游讨论 #1219](https://github.com/deepseek-ai/deepseek-harness/discussions/1219)

Node `v24.19.0` 本身仍处于 DSH 当前声明的 Node 支持范围内，不必先为了此问题降级 Node。[上游讨论 #649](https://github.com/deepseek-ai/deepseek-harness/discussions/649)

### 解决

先安装构建环境。Ubuntu/Debian：

```sh
sudo apt update
sudo apt install -y build-essential python3 make g++
```

`node-pty` 官方将 Linux 编译前提列为 `make`、Python 与 `build-essential`；上面的命令显式安装了这些工具。[node-pty 构建说明](https://github.com/microsoft/node-pty#linux-apt)

然后进入当前全局 DSH 安装所使用的 `node-pty`，手动重新构建：

```sh
cd "$(npm root -g)/@deepseek-ai/dsh/node_modules/node-pty"
npx node-gyp rebuild
```

成功时输出末尾应出现 `gyp info ok`。确认构建产物已生成：

```sh
ls -lh build/Release/pty.node
```

最后重新启动 DSH：

```sh
dsh --profile cli --help
```

也可以使用 `dsh web` 验证 Web UI。只要 `build/Release/pty.node` 存在且命令可启动，即表示原生模块已可加载。

若最初的安装日志明确提示安装脚本被拦截，请先按 npm 输出的 `--allow-scripts` 提示重新安装 DSH，再执行上面的手动构建。授权脚本是允许自动构建的前提，但在此故障中不能替代手动 `node-gyp rebuild`。

如果 `npx node-gyp rebuild` 仍失败，请保留从 `gyp info using node-gyp` 到最后一条 `gyp ERR!` 的完整输出；其中的 `Python not found`、`make not found`、`g++ not found` 或 Node 头文件下载失败，分别对应不同的环境修复路径。

## GitHub 源码安装：pnpm 要求 `allowBuilds`

### 现象

执行：

```sh
dsh plugin --profile cli add github:unlinearity/dsh-code
```

pnpm 报告 Git 依赖的 `prepare` 脚本未获许可，或要求在 `pnpm-workspace.yaml` 中配置 `allowBuilds`。

### 原因

GitHub 安装使用仓库源码，不包含发布包中的 `lib/` 构建产物。DSH-Code 会在 Git 包的 `prepare` 阶段构建它；pnpm 需要对此构建步骤显式授权。

### 解决

将 pnpm 输出的 **完整** `allowBuilds` 条目复制到 profile 的配置文件，然后重新执行同一条安装命令：

```text
~/.dsh/profiles/cli/pnpm-workspace.yaml
```

该键会包含 Git URL 和 commit，例如：

```yaml
allowBuilds:
  dsh-code@git+https://github.com/unlinearity/dsh-code.git#<commit>: true
```

不要将它简化成 `dsh-code: true`；pnpm 校验的是带来源与版本的完整键。Windows 上对应的文件位于 `%USERPROFILE%\\.dsh\\profiles\\cli\\pnpm-workspace.yaml`。

验证：

```sh
dsh --profile cli --dump-config
```

输出中应能看到 `dsh-code/startup`。

## GitHub 安装出现 `ERR_PNPM_ENOENT` 或临时目录错误

### 现象

pnpm 在 `dsh-code_tmp_*` 目录中报 `ENOENT`，例如无法扫描 `node_modules`。

### 原因

这通常是 Git 包的准备阶段未完成：旧版本的源码包没有在安装时构建 `lib/`，或者 pnpm 因未授予 `allowBuilds` 而跳过了构建。

### 解决

1. 先按上一节授予 pnpm 输出的完整 `allowBuilds` 条目。
2. 确认使用的是包含 Git 安装修复的 DSH-Code 提交。
3. 重新执行 GitHub 安装命令。

若只是使用 DSH-Code，而非参与源码开发，推荐改用 npm 发布包：

```sh
dsh plugin --profile cli add dsh-code
```

发布包已包含运行所需的构建产物，不需要 Git 包的准备阶段。

## 找不到 `pnpm`

### 现象

DSH 启动时显示：

```text
dsh: pnpm not found on PATH — install pnpm to manage profile plugins
```

### 解决

```sh
npm install -g pnpm
pnpm --version
```

重新打开终端后再执行 DSH。若 `pnpm --version` 仍不可用，请检查 npm 的全局 bin 目录是否已加入 `PATH`。

## 插件安装后仍无法启动

先检查 profile 是否已加载 DSH-Code：

```sh
dsh --profile cli --dump-config
```

再检查基础 CLI 和插件版本：

```sh
dsh --version
pnpm --version
```

如仍无法定位，请附上完整的安装输出、`dsh --profile cli --dump-config` 输出，以及系统、架构和 Node.js 版本信息后提交 Issue。不要只截取最后一行错误；原生模块和 pnpm 问题通常需要前面的安装日志来判断原因。

## 升级或本地开发后行为未变化

### 现象

已通过 `dsh plugin --profile cli add .` 重新挂载（或修改了仓库的 `cordis.patch.yml`），但 `--dump-config` 输出或运行行为仍是旧版本：例如禁用的插件仍禁用、配置键仍为旧名。

### 原因

宿主进程解析 bundle 的补丁层时，会从自身的包解析路径读取 `dsh-code`。若全局 npm 目录中存在一份 `npm install -g dsh-code` 安装的独立副本，它优先于 cli profile 中的挂载，profile 里的任何变更都不会进入组合结果。

```sh
ls "$(npm root -g)/dsh-code" >/dev/null 2>&1 && grep '"version"' "$(npm root -g)/dsh-code/package.json"
```

以上命令有输出，即存在全局副本。

### 解决

将全局副本更新到与当前使用版本一致：

```sh
npm install -g dsh-code@<version>
```

本地开发仓库则从仓库根重新安装全局副本：

```sh
npm install -g .
```

随后用 `dsh --profile cli --dump-config` 确认组合结果已更新。
