# dsh-code

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)打造的 Claude-Code 式交互终端(TUI)bundle,以树外插件 bundle 的形式组合在官方 `@deepseek-ai/dsh-base` 之上——与官方 Web 界面同一套插件生态,零 fork。

## 功能

- DeepSeek 蓝横幅:鲸鱼字标由官方 FishLogo 精确路径半块栅格化,头部贴内容宽度、紧凑不占满
- 实时会话流:直接从持久会话日志投影——用户输入、流式助手文本、紧凑工具调用/斜杠命令行(运行/完成/出错标记)、todo 快照
- **工具审批 y/n 条**:agent 请求许可时(sandbox 升级、hook 的 ask 决策),琥珀色审批条显示原因与配对命令行;`y` 允许一次、`n` 拒绝
- **`/model` 面板**:列出 `llm` 注册表的全部 provider 路由,为下一步切换会话模型;恢复的会话自动还原其上次的模型
- **会话恢复**:`--resume <id|前缀>` 续接持久会话,`--continue` 取当前目录最新一个;完整转录从日志重放,续写同一持久会话
- **斜杠命令透传**:共享 `ctx.commands` 注册表(Web 作曲栏同一分发面)里的命令都可在终端执行,`/` 弹出补全菜单;用户可调用技能也进同一菜单(标注 `skill`),未知 `/name` 回退为普通提示词、由 host 的技能注入接管
- **todo 面板**:实时 todo 列表内联渲染,含 done/active/pending 计数与三态标记,每个新 turn 清空(对齐 Web TodoPanel)
- 输入组件:历史(↑/↓)、光标编辑(←/→、Ctrl+A/E/U)、斜杠命令与技能 Tab 补全;`Esc` 或 Ctrl+C 中断运行中的 turn,Ctrl+C 在空闲空输入时退出,Ctrl+D 运行中拒绝退出
- 融合型状态栏:Claude Code 式身份信息(模型、工作目录、git 分支、会话)+ Web 作曲栏指标(轮数/步数、llm 与 tool 累计时长、缓存命中、token 总量)

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
