# dsh-cli

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)打造的 Claude-Code 式交互终端(TUI)bundle,以树外插件 bundle 的形式组合在官方 `@deepseek-ai/dsh-base` 之上——与官方 Web 界面同一套插件生态,零 fork。

## 功能

- DeepSeek 蓝横幅:鲸鱼字标由官方 FishLogo 精确路径半块栅格化,头部贴内容宽度、紧凑不占满
- 实时会话流:直接从持久会话日志投影——用户输入、流式助手文本、紧凑工具调用行(运行/完成/出错标记)、todo 快照
- 融合型状态栏:Claude Code 式身份信息(模型、工作目录、git 分支、会话)+ Web 作曲栏指标(轮数/步数、llm 与 tool 累计时长、缓存命中、token 总量)
- 本地命令 `/help`、`/clear`、`/quit`;Ctrl+C/Ctrl+D 退出前先 flush 会话

## 安装

需要 Node `^22.19 || >=24` 与 `dsh` CLI(`npm i -g @deepseek-ai/dsh@next`)。

```sh
dsh plugin --profile cli add dsh-cli        # npm 发布后
dsh plugin --profile cli add github:unlinearity/dsh-cli   # 跟踪本仓库
dsh plugin --profile cli add file:C:/path/to/dsh-cli      # 本地目录
```

然后:

```sh
dsh --profile cli
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
