# Prismatic 主题设计 — 霓虹 Synthwave

> 状态：已实施（单 commit 落地）。所有色值经过 WCAG 2.x 对比度实测并进入 `tests/theme.spec.ts` 的回归表；状态栏一节按实现做了简化（tone 驱动），见 §2 修订。

## 0. 决策记录（两轮弹窗确认）

| 决策点 | 选择 |
| --- | --- |
| 风格方向 | 霓虹 Synthwave（深色底） |
| 品牌双色 | 冷艳科技：brand=蓝紫电光、brandBright=霓虹品红 |
| 炫彩落点 | 全表面：状态栏/spinner、面板边框标题、composer 波浪提示符、markdown 强调与代码 |
| 流光色域 | 紫 ↔ 品红 ↔ 青 三角振荡 |
| 流光节奏 | 活泼明快，完整周期 2.4s |
| 面板分色 | 四色轮转（按面板打开顺序） |
| 代码色 | 霓虹青 |
| 语义色 | 保留（success/error/warn、diff 红绿原样） |
| 可读性 | 全量过 AA（正文 ≥4.5:1，装饰/状态 ≥3:1） |
| 命名 | `prismatic`（与 dark/light/auto 并列的第四主题） |

## 1. 调色板（15 个既有 token，零新增命名）

深色族主题，绘制于黑底终端。实测对比度基于纯黑背景。

| token | 值 | hex | 用途 | 实测 | 阈值 |
| --- | --- | --- | --- | --- | --- |
| brand | [139, 92, 246] | #8B5CF6 violet-500 | 鲸鱼/wordmark/工具名/面板主边框 | 4.96:1 | ≥3 |
| brandBright | [240, 171, 252] | #F0ABFC fuchsia-300 | streaming/markdown accent/选中行 | 11.94:1 | ≥4.5 |
| brandMid | [167, 139, 250] | #A78BFA violet-400 | 渐变中点/空闲状态点 | 7.72:1 | ≥3 |
| brandDeep | [124, 58, 237] | #7C3AED violet-600 | 次级边框/审批面板 | 3.69:1 | ≥3 |
| dim | [166, 163, 184] | #A6A3B8 薰衣草灰 | 提示/页脚/meta | 8.55:1 | ≥4.5 |
| text | [240, 238, 249] | #F0EEF9 微薰衣草白 | 正文 | 18.30:1 | ≥4.5 |
| code | [103, 232, 249] | #67E8F9 cyan-300 | 行内代码/代码块 | 14.49:1 | ≥4.5 |
| composerBand | [46, 46, 52] | #2E2E34 中性深灰 | composer 三行带（保持无彩，波浪读得清） | — | 无彩规则 |
| success / error / warn | 同 dark | — | 语义色原样保留 | 9.22 / 5.58 / 9.78 | ≥3 |
| diffAdd / diffDel | 同 dark | — | diff 行底色原样 | — | — |
| diffAddFg / diffDelFg | 同 dark | — | diff 前景原样 | 5.41 / 4.94 | ≥4.5 |

注：violet-700 #6D28D9 实测 2.96:1 不达 3:1，已弃用；brandDeep 取 violet-600。
composerBand 沿用「max−min ≤ 6 的无彩灰」规则（现有测试断言直接扩展到 prismatic）。

## 2. 表面分色 — 四色轮转 ring

新增模块级常量与取色 helper（theme.ts）：

```
ACCENT_RING = [ #22D3EE cyan-400, #E879F9 fuchsia-400, #A78BFA violet-400, #A3E635 lime-400 ]  // 全部 ≥3:1（11.62 / 8.53 / 7.72 / 13.93）
surfaceAccent(index): prismatic → RING[index % 4]；dark/light → brand（视觉零变化）
```

- **轮转规则**：App 维护一个单调递增的「面板打开序号」；每个面板挂载时取一个序号并终身持有该 ring 色（边框 + 标题同色）。关闭再开 → 序号推进 → 换下一个颜色。同屏多面板 = 一屏多色。
- dark/light 回退到 brand 单色，保证现有两个主题像素级不变。
- 状态栏（实现修订）：不做按分组的手工分色，而是让既有 tone 映射读 palette —— prismatic 换 palette 后自动呈现多色（model/path=霓虹青、live=品红、value=电紫、label 灰）；busy 点（live tone）在 prismatic 且动画开启时沿流光三角流转（StatusLine 持 125ms tick，其余主题零开销）。

## 3. 流光动效 — 三角振荡

纯函数进 `render/animations.ts`（与现有 shimmer/wave 同模式，Ink 层持有 tick）：

```
FLOW_ANCHORS = [ brand(violet-500), #E879F9(fuchsia-400), #22D3EE(cyan-400) ]  // 三锚点全部 ≥4.5:1，流转中当前景用也全程 AA
FLOW_PERIOD_MS = 2400            // 活泼明快：三段 × 800ms
flowColor(tick): 锚点间平滑插值（smoothstep），violet→fuchsia→cyan→violet 循环
```

落点：
| 表面 | 动效 | 关闭 animations.json 时 |
| --- | --- | --- |
| streaming shimmer 高亮 | highlight 锚点改用 flowColor(tick) | 静态 brandBright |
| busy spinner / 状态栏忙点 | 字符色沿 flowColor 流转 | 静态 brandBright |
| composer 提示符 ❯/… | flowColor（有动画时） | 静态 brandBright |
| 模型切换波浪 | 波浪 hues 直接取 FLOW_ANCHORS（palette 换色后 flash/deepseek 档已自动多色化，此处统一为三锚点） | 波浪本身不播放 |
| 面板边框/标题/状态栏分组 | **不参与流光**（静态 ring 色，避免整屏晃动） | 同左 |

## 4. 主题接入清单（上一轮重构后的大部分接入点已自动化）

| 接入点 | 改动 |
| --- | --- |
| `ThemeName` / `PALETTES` / `PRISMATIC_PALETTE` | 新增（`satisfies ThemePalette` 强制 15 token 齐全） |
| `THEME_NAMES` + `THEMES` 注册表 | 加一行 `{ id: 'prismatic', label: 'prismatic', description: 'neon synthwave palette (violet/magenta/cyan)' }` → /theme 面板、持久化白名单自动生效 |
| `resolveTheme` | 返回类型加 'prismatic'；`auto` 仍解析为 dark（prismatic 只能显式选择） |
| `parseThemeName` / `--theme` 报错文案 | 零改动（已从 THEME_NAMES 派生，自动包含 prismatic） |
| CLI help 文案 | 'color theme: dark (default), light, or auto' 手写文案需加 prismatic（唯一残留的手写清单） |
| README 中英文 | /theme 表加一行 |

## 5. 测试与验收

1. **对比度回归表扩展**：terminal 背景按主题参数化（dark→黑、light→白、prismatic→黑）；新增断言 ring 四色 ≥3、FLOW 三锚点 ≥4.5（流光会当 streaming 前景用）。
2. band 无彩断言扩展到 prismatic（max−min ≤ 6）。
3. `surfaceAccent` 单测：prismatic 轮转取模正确；dark/light 恒等于 brand。
4. `flowColor` 单测：周期边界连续（tick=period 与 tick=0 同色）、锚点时刻精确命中三色、关动画回退 brandBright。
5. app 级测试：开四个面板边框色依次为 ring 顺序；切换 dark 后边框回到 brand。

## 6. 实施切分（建议 3 个 commit）

1. **theme.ts + 测试**：PRISMATIC_PALETTE、注册表行、ACCENT_RING/surfaceAccent、flowColor 纯函数、对比度表扩展。
2. **app.ts 接线**：面板边框/标题走 surfaceAccent + 打开序号、状态栏静态 ring、shimmer/spinner/提示符接 flowColor（全部走现有 animations 门控）。
3. **文案与文档**：CLI help、README 中英文、/theme 描述定稿。

## 7. 风险与备注

- **注意力成本**：2.4s 周期活跃；已绑定 animations.json 总开关，一键静态。
- **lime-400 与 success 绿的接近**：不同表面（边框 vs 内容行），ring 顺序把 lime 排最后降低同屏概率；实施后肉眼复核 /todos 面板。
- **低端终端**：256/16 色下 chalk 自动量化，ring 可能坍缩为相近 ANSI 色（亮度仍有区分）；diff 背景门控逻辑复用，不受影响。
- **重绘开销**：流光只影响状态栏/composer/spinner 局部，tick 复用现有 33ms 波浪节拍，不新增全局重绘。
- **fuchsia-300 大面积观感**：仅用于标题/强调/选中行，正文始终 text 白。
