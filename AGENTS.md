# AGENTS.md — Development Rules, Pitfalls, and Conventions

This file records every hard-won lesson from developing dsh-code. Read it before touching the codebase. Violations here have caused real crashes, lost user trust, and wasted debugging hours.

## 1. Testing Discipline

### 1.1 A passing unit test suite is NOT a passing application

The most expensive mistake in this repo's history: all 1282 tests passed, the code was shipped to the user, and the TUI crashed on boot with "Maximum call stack size exceeded". The unit tests exercised the logic in isolation; the crash was in the interaction between a stdout Proxy and Node.js's getter chain.

**Rule**: after any change to `src/internals.ts`, `src/app.ts` render tree, or anything touching stdout/stdin, run a real terminal boot test:

```bash
# Minimum: boot, send a streaming prompt, verify no crash
script -q /tmp/tui-test.log dsh --profile cli & TPID=$!
sleep 6; kill $TPID 2>/dev/null; pkill -f 'dsh --profile cli'
grep -c 'Maximum call stack\|Should not\|fatal' /tmp/tui-test.log
```

A 5-second pty probe that shows 56 bytes of output is a **red flag**, not a pass. Investigate suspiciously small output; do not rationalize it away.

### 1.2 Timing-sensitive tests must poll, not sleep

`fs.watch` delivery + debounce timing varies under parallel test load. A fixed `sleep(400)` assertion will pass in isolation and fail in the full suite. Always poll:

```typescript
for (let i = 0; i < 200 && actual() !== expected; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
expect(actual()).toBe(expected)
```

Set an explicit test timeout (`{ timeout: 15_000 }`) when the poll budget approaches the default 5000ms limit.

### 1.3 Real TTY tests need winsize

Without `fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))` the TUI renders nothing (zero-size terminal).

### 1.4 Kill stray processes after pty tests

```bash
ps -eo pid,command | grep deepseek | grep -v grep
# Kill by PID; never pkill -9 deepseek blindly (it can kill this session's host)
```

## 2. Ink Rendering Pitfalls

### 2.1 Ink's clear-all path (THE flickering root cause)

`node_modules/ink/build/ink.js:121-125`: when the Yoga root height >= `stdout.rows` (equality included!), every frame writes `clearTerminal + fullStaticOutput + output`. Under streaming load this fires ~57 times/second (compat throttle double-fires per 32ms window). Each write can be tens of kilobytes (full Static reprint).

**Prevention layers** (all three are load-bearing):

1. `inkSpare = 2` in `liveRegionBudget` (inspector.ts) — steady-state tree height stays at rows−2.
2. DEC 2026 synchronized output wrapper (internals.ts) — even if clear-all fires, the terminal buffers the frame and shows only the final state.
3. `anchoredSurfaceRows = Math.min(dynamicRows, allLiveLines.length)` — the anchored Box never exceeds its content.

### 2.2 Never wrap stdout writes in multiple sequential calls

Three sequential `target.write()` calls passing the same `...rest` callback fires the callback three times. If the callback belongs to React's scheduler, the process dies with "Should not already be working." **Always concatenate into ONE write**: `target.write(prefix + text + suffix, ...rest)`.

### 2.3 Never use Reflect.get(target, prop, proxy) on process.stdout

Node.js stdout has getter chains (`rows`, `columns`, `_refreshSize`). `Reflect.get` with the Proxy as receiver re-enters the getter through the Proxy, causing infinite recursion ("Maximum call stack size exceeded"). Use a **plain wrapper object** with explicit property delegation instead.

### 2.4 The flush cursor only moves forward

`advanceTranscriptViewport` uses `Math.max(previous.flushedRows, ...)`. A rows-only terminal resize (dragging a divider taller) grows the budget but the cursor stays — the anchored Box pads the gap with real blank rows. Fix: any size change (rows or columns) triggers a replay after the 75ms debounce settles.

### 2.5 Composer/menu/status heights report one frame late

`onEditorRows`/`onMenuRows`/`onStatusRows` are all `useEffect` (fires after commit, after Ink writes the frame). A menu opening (+10 rows) or editor pasting (+5 rows) overflows for exactly one frame. DEC 2026 makes this invisible; a structural fix (render-time height derivation) is future work.

### 2.6 The columns−1 contract

Painted lines must never exactly fill `stdout.columns`. VS Code's terminal auto-wraps on the last column, producing an unaccounted row that breaks Ink's row ledger. Every truncation in the codebase reserves at least one column: `truncateColumns(text, columns - 1)` minimum. Check NoticeLine, StatusLine, composer band, StreamTail — all follow this.

## 3. Version Alignment Procedure

### 3.1 Mechanical pin bump

All `@deepseek-ai/*` dependencies must be on the SAME version (one release candidate line). The bump touches:

- `package.json`: 92 version pins (dependencies + peerDependencies + devDependencies) — a simple string replace works.
- `src/runner/harness-gate.ts`: `EXPECTED_HARNESS_VERSION` constant.
- `tests/package.spec.ts`: version set assertion.

### 3.2 Upgrade the global CLI BEFORE or AFTER user sessions end

`npm install -g @deepseek-ai/dsh@<new>` while a TUI session is running replaces the files the old process is reading → `read EIO` crash on the TTY stream. **Always ask the user to close all dsh sessions first.**

### 3.3 The profile layer has its own dependency

`~/.dsh/profiles/cli/package.json` pins `@deepseek-ai/dsh-tool-session-query`. Bump it separately or the loader disables the row with a peer-version mismatch.

### 3.4 Global install shadows the profile link

After ANY runtime-facing change: `npm install -g .` from the repo root. The global `dsh-code` install is what actually runs (it shadows the profile's symlink). Verify via `dsh --profile cli --dump-config` — zero "skipping"/"disabling" lines means a clean composition.

### 3.5 Audit before bumping

Kernel releases are frequent (0.2.0-rc.1 → rc.2 was 187 commits). Before bumping, diff the changed packages:

```bash
cd /Users/nonlinear/GitHub/deepseek-harness
git diff --name-only <prev-release>..<new-release> -- packages/ \
  | grep -v 'package.json\|README\|i18n\|tsconfig\|\.snap\|tests/\|\.spec\.' \
  | grep -vE 'client/|web/'
```

If only version bumps and Web-side changes appear, the upgrade is mechanical. If core src files changed, check exports for breaking changes first (delegate to a subagent for large diffs).

## 4. Language and Terminology (UI copy, logs, commits)

### 4.1 Chinese terminology follows the kernel's official zh READMEs

Use: 子代理 (subagent) · 委派 (delegate) · 钩子 (hook) · 压缩 (compaction) · 权限预设 (permission preset) · 沙箱 (sandbox) · 谱系 (lineage) · 提供方 (provider) · 可继续子代理 (continuable subagent) · 连接状态 (connection state) · 触发点 (trigger point) · 转录 (transcript, NOT 转写) · 实机 (real machine, NOT 真机) · 全局安装副本 (global install copy)

### 4.2 Banned words (dramatic/slang, never use in any output)

撞车 · 炸 · 锚定 (when misused for "anchor" metaphor) · 实锤 · 真凶 · 全绿 · 武装 · 留存 · 键空间 · 钻取 · 相位 (when misused for "phase") · 方言 (for hook bridge type; use `<claude|codex>` literally) · 派发 · 裸 · 兜底过度

### 4.3 English technical terms stay in English inside Chinese prose

Keep code identifiers, API names, file paths, and technical terms verbatim: `Static`, `useSyncExternalStore`, `DEC 2026`, `peerDependencies`. Translate the surrounding sentence, not the term.

### 4.4 Commit messages: English paragraph then Chinese paragraph

No "中文:" prefix. Both paragraphs say the same thing semantically. Subject line: `type(scope): summary` (English only).

```
fix(status): follow external branch switches without a restart

<English body>

<Chinese body — semantic mirror, not word-for-word>
```

### 4.5 Commit messages describe outcomes, never process

Never mention internal workflow in a commit message: no "an agent extracted", no "two audits anchored the work", no "the user reported then we investigated". The commit message states WHAT changed and WHY for the end user reading `git log` — not HOW the change came about. Process notes (agent delegation, audit rounds, user corrections) belong in `log.md` only.

### 4.6 Report and log formatting

No emoji headers in reports. No military/drama metaphors. Tables over long prose when comparing options. `---` (three dashes) separates sections in markdown reports.

## 5. Local-Only Files (NEVER commit)

These files are in `.git/info/exclude` and must never enter git:

- `log.md` — session change log (local-only by design)
- `git-log.md` — commit message drafts (local-only by design)
- `.agents/` — agent scratch space
- `docs/capability-gap-plan.md` — internal progress tracking
- `docs/capability-gap-audit-*.md` — internal audit notes
- `lite-preset/` — untracked, pending user decision

The `update-log-md` and `update-git-log` skills enforce this. Never `git add -f` any of these.

## 6. Operational Rules

### 6.1 Never push without explicit user authorization

Commits stay local. Push only when the user says "push" explicitly.

### 6.2 NEVER commit without explicit per-batch user confirmation

Every batch of changes requires its own explicit "commit" from the user. A previous authorization covers only that batch — it does not carry forward. The sequence is strictly:

1. Write a detailed report for the user
2. **Wait for the user to verify and explicitly say "commit" (or equivalent)**
3. Write both logs (log.md + git-log.md) — local only
4. Commit on the current branch

Committing without step 2 — even for "trivial" or "docs-only" changes, even right after a batch the user did authorize — is a violation. The user has reverted commits made this way; do not make them do it again.

### 6.3 Rendering changes need extended verification

Never commit rendering-related changes immediately. Leave them in the working tree for the user to test over a long session. The user decides when to commit.

### 6.4 Reference before reinventing

Check `/Users/nonlinear/GitHub/CLI/` (codex, claude-code, opencode, pi) before building anything from scratch. Codex's TUI (Rust) is the primary reference for terminal layout decisions. If a mature CLI already solved the problem, follow their approach.

### 6.5 Subagent count display: running vs idle

The status line's "N 个运行中" counts `state !== 'done'`, which includes idle (finished their turn but continuable). This over-reports "running" agents. Consider splitting the count or adding a close action for unneeded continuable subagents.

## 7. Tool Call Discipline (minimizing agent mistakes)

Every item below was a real error in this repo's development session. Each cost debugging time or shipped a broken build. Internalize them before running any tool.

### 7.1 File editing: always read before writing or editing

The edit tool rejects operations on unread files, but the deeper rule is: **you cannot safely edit what you have not seen in its current state**. Multiple edit attempts failed because `old_string` no longer matched (file changed since last read) or matched multiple locations. Re-read the target region immediately before every edit. Prefer `edit` (surgical replacement) over `write` (full overwrite) for existing files.

### 7.2 Python heredoc string escaping

When using `python3 - <<'EOF'` to edit TypeScript files, three recurring traps:

- Apostrophes in English copy (`session's`) break single-quoted TS strings. Rephrase to avoid possessives, or use double-quoted TS strings.
- Python's `\\n` inside a heredoc produces the literal two characters `\n` in the Python string, which then matches TS source `\n` — but only if you intentionally wrote `\\n`. A single `\n` in Python becomes a real newline and silently mismatches.
- `assert s.count(old) == 1` anchors must match the file exactly. After any prior edit, the anchor may have shifted. Always run the count assertion before the replace, and never ignore its failure.

### 7.3 Never write self-referential conditions

A real bug: `terminalSizeRef.current.rows <= terminalSizeRef.current.rows` — always true, comparing a value to itself. The intent was to compare against the PREVIOUS rows value, but the variable holding it was never captured. When writing a comparison, verify that the two sides reference genuinely different storage. If you cannot name where each side's value comes from, the condition is wrong.

### 7.4 Python closures with immutable types

In pty test scripts, `out = b''` (bytes, immutable) captured by a `drain()` function using `nonlocal out` does NOT propagate to a variable assigned from the outer function's return value — `out += data` creates a new bytes object. Every test reported `bytes=0`. Fix: use a mutable container (`buf = bytearray()`; `buf.extend(...)`) or return the buffer from the same scope that drains it.

### 7.5 Suspiciously small test output is a failure, not a pass

A 5-second pty probe that captures 56 bytes of "streaming" output is not a successful test. Real streaming produces kilobytes. When a metric is absurdly low (bytes, line count, event count), investigate WHY before reporting success. "The test passed" means "the expected behavior was observed", not "no error was printed".

### 7.6 Rationalizing away missing evidence

DEC 2026 sequences were absent from a test's output. The correct action: find out why (proxy not wrapping? wrong detection pattern? output truncated?). The actual action: "short test may not have triggered it" — a guess that let a crash ship. **Missing evidence is a question, not an answer.**

### 7.7 Blind regex sweeps over semantic content

A ` — ` → ` · ` character sweep across locale files flattened two intentional em-dashes that carried meaning (range vs. contrast). Rule: character-level sweeps are safe only over mechanical content (version numbers, imports). Over natural language, check every match — or better, enumerate the changes individually.

### 7.8 macOS sed lacks GNU extensions

`sed -n 'N,+20p'` (print from line N plus 20 more) is GNU-only. On macOS use explicit two-address ranges: `sed -n '20,40p'`. Similarly, `sed -i` requires a backup suffix argument on macOS (`sed -i '' ...`). When a sed command errors on macOS, check for GNU-only syntax before debugging the pattern.

### 7.9 Shell quoting in long commands

Commands embedding code with apostrophes (`dsh-code's`) inside single-quoted shell strings break the shell's quoting balance. Use double quotes for the outer shell string, or write a temporary script file instead of a one-liner. A bash "unexpected EOF while looking for matching quote" almost always means an embedded quote broke the nesting.

### 7.10 TypeScript-only casts do nothing at runtime

`...rest as []` compiles (it satisfies the type checker) but at runtime the spread still passes every argument — including callbacks — to the function. A cast changes what TypeScript believes, not what JavaScript executes. When the runtime behavior is the problem, fix the runtime code, not the type annotation.

### 7.11 The anti-flicker guard feedback loop

A guard that conditionally removes a layout constraint (anchored Box height) based on the same inputs the constraint controls creates an oscillation: guard triggers → layout changes → guard condition flips → guard triggers again. Result: the guard produced the exact flickering it was meant to prevent. Rule: **a guard must not influence the inputs that trigger it.** If removing a constraint changes the condition that decides removal, the guard is an oscillator, not a guard.

### 7.12 Structural fixes need viewport compatibility checks

Setting `height: rows-2, overflow: hidden` on the root Box broke four panel tests because panel viewport budgets assume the root is unbounded. Before applying a global structural constraint (height caps, overflow rules, flex properties), check what every downstream consumer (panels, pickers, overlays) expects from the current geometry.

### 7.13 When tests race the timeout

A poll loop of 100 × 50ms = 5000ms exactly matches vitest's default timeout. Under parallel load the poll barely finishes before the timeout kills the test. Fix: either reduce the poll interval, increase iterations, or set an explicit per-test timeout that exceeds the poll budget by 2×. Never let the poll budget and the test timeout be the same number.

### 7.14 Multiple sequential writes sharing one callback

This is §2.2 restated as a tool-lesson: when wrapping a stream write, ALWAYS merge prefix + content + suffix into one call. The instinct to "write the begin sequence, then the content, then the end sequence" is correct for terminals but wrong for Node streams — each write invocation re-delivers the callback. If a function accepts a callback, the wrapper must call the underlying function exactly once.

## 8. Known Open Issues (do not re-litigate without new evidence)

| Issue | Status | Reference |
|---|---|---|
| H2: CJK Ambiguous width (●○█░⎿ count 1 but render 2 on macOS Terminal.app) | Skipped (user uses VS Code terminal) | width.ts:21-113 |
| L1: Markdown wrapped continuation lines lose hanging indent | Open (low) | markdown.ts:82-134 |
| L2: Unclosed diff fence in user prompt paints subsequent lines | Open (low) | lines.ts:300-346 |
| L3: IME anchor jumps during non-frame writes | Open (low) | ime-cursor.ts:112-127 |
| L4: Sub-12-column terminal width floors inconsistent | Open (low) | app.ts:1537 |
| M4: Width authority split (dsh=1 vs string-width@7=2 for some emoji) | Open (medium) | width.ts vs ink internals |
| /model panel Space deletes row in one press (violates Space=safe) | Open, deferred | Batch 6 |
| Duplicate locale-key merge; singular/plural variants | Open, deferred | locales |

## 9. Panel Key Grammar (user-mandated, inviolable)

- **Enter** = primary action / drill in
- **Space** = safe, reversible action (NEVER destructive)
- **Backspace ×2** = destructive (two-press arm required)
- **r** = refresh
- **esc / q** = close

No letter keys for actions expressible by these five. Any new panel MUST follow this grammar. The /model panel Space-deletes-row is a known violation (fix pending).

## 10. Keystone Lock

`KEYSTONE_MODULES` (44 module names, joined by module name because loader entryIds are `include:`-prefixed) locks exactly what dsh-code's own patch names plus `llm-pi-ai`. The drift test in `bundle-patch.spec.ts` catches any divergence. When the kernel adds or removes base patch rows, update `tests/base-row-ids.json` and the lock together.
