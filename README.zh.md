# dsh-code

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)打造的 Claude-Code 式交互终端(TUI)bundle,以树外插件 bundle 的形式组合在官方 `@deepseek-ai/dsh-base` 之上——与官方 Web 界面同一套插件生态,零 fork。

## 功能

- DeepSeek 蓝横幅:鲸鱼字标由官方 FishLogo 精确路径半块栅格化,头部贴内容宽度、紧凑不占满
- 实时会话流:直接从持久会话日志投影——用户输入、流式助手文本、紧凑工具调用/斜杠命令行(运行/完成/出错标记)、todo 快照
- **工具审批 y/n 条**:agent 请求许可时(sandbox 升级、hook 的 ask 决策),琥珀色审批条显示原因与配对命令行;`y` 允许一次、`n` 拒绝
- **`/model` 面板**:列出 `llm` 注册表的全部 provider 路由,为下一步切换会话模型;恢复的会话自动还原其上次的模型
- **每会话 Agent Preset**:每个会话从 `standard`、`code`、`minimal`、`cordis` 或用户预设组合自己的工具、提示词、技能、压缩、plan 与委派能力;`/mode [preset]` 只允许在空会话切换,状态栏始终显示当前 mode
- **进程内会话生命周期**:`/new [preset]` 新建会话,`/resume [id|前缀]` 在同一个终端所有者中打开 Codex 风格搜索面板;忙碌时等待当前 turn 自然结束,`/resume cancel` 可取消排队切换
- **会话恢复**:`--resume <id|前缀>` 续接持久会话,`--continue` 取当前目录最新一个;`--mode <preset>` 为新会话选择预设
- **Resume 检查器**:默认列出全部根会话,可切换全部会话、当前/全部工作目录、排序和密度;subagent 会话保持只读,`e` 展开元数据,只有显式按 `t` 才加载完整可滚动转录
- **插件诊断**:`/plugin [query]` 只读展示实时 Cordis loader,包括 Preset 挂载条目、启用状态与 fiber 阶段
- **斜杠命令透传**:共享 `ctx.commands` 注册表(Web 作曲栏同一分发面)里的命令都可在终端执行,`/` 弹出补全菜单;用户可调用技能也进同一菜单(标注 `skill`),未知 `/name` 回退为普通提示词、由 host 的技能注入接管
- **todo 面板**:实时 todo 列表内联渲染,含 done/active/pending 计数与三态标记,每个新 turn 清空(对齐 Web TodoPanel)
- **思考行**:模型推理以 Claude Code 式 `✻` 折叠呈现——默认收起为 dim 标记 + 字符数,展开为 dim 斜体,模型思考时流式显示;Ctrl+R 全局切换
- **终端 markdown**:助手回复经纯 GFM 子集渲染器(标题/围栏与行内代码/强调/列表/引用/链接)按终端宽度排版;流式阶段保持纯文本直到消息落定
- **Ctrl+O 历史检查器**:逐条浏览保留的完整转录,同时保留输入框与状态栏;←/→ 切换条目,↑/↓ 与 PageUp/PageDown 滚动全部内容,`g`/`G` 跳到两端
- **结构化工具详情**:持久化的 edit/write diff、带行号 read 窗口、web 搜索来源、fetch 摘要与有界原始输出在普通转录中保持紧凑,并可在 Ctrl+O 中展开查看完整展示
- **ask_user_question 问答条**:模型提问呈现为选项菜单(↑/↓ 移动、space 多选、`c` 自定义答案、Esc 中断);计划评审(exit_plan_mode)走同一条并高亮 approve 选项
- **@ 补全**:`@` 触发工作区文件与持久会话补全;会话引用展开为有界只读快照,以带来源的上下文注入到提示词之前
- **plan 与权限**:plan、权限与 Agent Preset mode 在状态栏中相互独立;`/permission <name>` 与 Shift+Tab 切换权限预设,registry 自带的 `/plan` 命令启用 plan 模式
- **终端本地工作流**:`/help` 打开完整按键/命令/技能说明,`/export` 将折叠转录写为 Markdown,`/title` 固定会话标题,Ctrl+K 删除到行尾,Ctrl+L 重绘终端,裸工作区路径参与 Tab 补全
- 输入组件:历史(↑/↓)、光标编辑(←/→、Ctrl+A/E/U)、斜杠命令/技能/@ 补全 Tab 补全;运行中提交即 steering(下一个 step 边界消费),`Esc` 或 Ctrl+C 中断本轮,Ctrl+C 在空闲空输入时退出,Ctrl+D 运行中拒绝退出
- 融合型状态栏:Claude Code 式身份信息(模型、工作目录、git 分支、标题/会话、plan、权限预设、goal 与 sandbox 覆盖)+ Web 作曲栏指标(轮数/步数、llm 与 tool 累计时长、TTFT、解码 tok/s、上下文占用、缓存命中、token 总量)
- 有界动态渲染:流式输出、Ctrl+O、全部斜杠子页、审批与问题/计划评审面板均受终端视口约束;输入框始终位于状态栏正上方,连续缩放只在最终宽度执行一次防抖重排

## 安装

需要 Node `^22.19 || >=24` 与 `dsh` CLI(`npm i -g @deepseek-ai/dsh@next`)。

```sh
dsh plugin --profile cli add dsh-code       # npm 发布后
dsh plugin --profile cli add github:unlinearity/dsh-code  # 跟踪本仓库
dsh plugin --profile cli add file:C:/path/to/dsh-code     # 本地目录
```

然后:

```sh
dsh --profile cli                    # 全新会话
dsh --profile cli --continue         # 恢复本目录最新的会话
dsh --profile cli --resume abc123    # 按会话 id 或唯一前缀恢复
dsh --profile cli --session my-id    # 以显式 id 建新会话
dsh --profile cli --mode minimal     # 使用指定 Agent Preset 新建会话
```

在环境变量(或启动目录 / `$DSH_HOME` 的 `.env`)里设置 `DEEPSEEK_API_KEY`。

git 安装会在安装期执行构建脚本,pnpm 会先行拦截:若 `add` 失败,按提示把对应键加入 `~/.dsh/profiles/cli/pnpm-workspace.yaml` 的 `allowBuilds` 后重试。

## 开发

```sh
pnpm install
pnpm test         # vitest 单元测试
pnpm typecheck
pnpm build        # tsdown 打包 lib/*.mjs,tsc 产出 lib/types
pnpm run gen:whale   # 从 vendor 的官方路径重新生成 src/whale-glyph.ts
```

鲸鱼点阵由 `scripts/fish-logo.ts` 中 vendor 的 DeepSeek 鱼形 Logo 路径生成(来源:[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),MIT)。

## 许可

[MIT](LICENSE)。vendor 的鱼形 Logo 几何数据来自 DeepSeek Harness(MIT)。
