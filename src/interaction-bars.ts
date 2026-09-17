/** Approval and structured-question keyboard-owned terminal surfaces. */

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalSnapshot } from './approval.ts'
import type { QuestionSnapshot, QuestionStore } from './questions.ts'
import { PanelGap } from './panel-gap.ts'
import { deleteLastGrapheme } from './render/editor.ts'
import { clampScroll, moveScroll, panelViewport, revealRow } from './render/inspector.ts'
import { lineSegment, markdownLines, styledLines, textLines, type LineStyle, type StyledLine } from './render/lines.ts'
import { truncateColumns } from './render/text.ts'
import { StyledRows } from './styled-rows.ts'
import { dim, getPalette, inkColor } from './theme.ts'
import { t } from './i18n.ts'
import type { NoticeTone } from './ui-contract.ts'
import { stripPasteMarkers } from './keyboard.ts'
import { useStableInput } from './use-stable-input.ts'

interface ApprovalOption {
  readonly key: 'allow' | 'reject-note' | 'reject'
  readonly label: string
  readonly hotkey: string
}

/** The fixed decision list; answers stay in the binary answerer vocabulary. */
const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { key: 'allow', label: 'Yes, proceed', hotkey: 'y' },
  { key: 'reject-note', label: 'No, and tell it what to do differently', hotkey: 'n' },
  { key: 'reject', label: 'No, continue without running it', hotkey: 'd' },
]

/**
 * The approval dialog (Codex ApprovalOverlay contract): a bold question
 * header, the bounded command body with an explicit overflow marker, a
 * numbered option list with a `›` cursor, single-key shortcuts, and digits
 * for direct selection. Askers queue FIFO — the count rides the header.
 * The upstream answerer vocabulary stays binary (`allowed-once` /
 * `rejected`): "tell it what to do differently" rejects and hands the
 * composer back with a hint notice, exactly Codex's decline-then-type flow.
 */
export function ApprovalBar({ snapshot, locked, notify, interrupt, summarize }: {
  snapshot: ApprovalSnapshot
  locked: boolean
  notify: (text: string, tone?: NoticeTone) => void
  /** Cancel the running turn (Ctrl+C), matching the composer's busy branch. */
  interrupt: () => boolean
  /** Render as the bounded one-line form even on tall terminals (another
   * human-asked surface already owns the full panel budget). */
  summarize?: boolean
}): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [cursor, setCursor] = useState(0)
  const pending = snapshot.pending
  const active = !locked && pending !== undefined && !snapshot.answered
  const body = useMemo<readonly StyledLine[]>(() => pending === undefined || pending.command === ''
    ? []
    : textLines(pending.command, viewport.contentColumns, 'dim'), [pending, viewport.contentColumns])

  useEffect(() => {
    setCursor(0)
  }, [pending])

  const decide = (option: ApprovalOption): void => {
    const ask = snapshot.pending
    if (ask === undefined || snapshot.answered) return
    if (option.key === 'allow') {
      ask.answer('allowed-once')
      return
    }
    ask.answer('rejected')
    if (option.key === 'reject-note') {
      notify(t('notice.rejected'), 'warning')
    }
  }

  useInput((input, key) => {
    const ask = snapshot.pending
    if (ask === undefined || snapshot.answered) return
    // Ctrl+C keeps its app-wide meaning while the ask owns the keys: cancel
    // the running turn (the ask's abort signal withdraws the question).
    // Without this branch the keystroke died here silently — the ask was the
    // only reachable surface and offered no way out.
    if (key.ctrl && input === 'c') {
      interrupt()
      return
    }
    if (key.upArrow) {
      setCursor(current => (current + APPROVAL_OPTIONS.length - 1) % APPROVAL_OPTIONS.length)
      return
    }
    if (key.downArrow) {
      setCursor(current => (current + 1) % APPROVAL_OPTIONS.length)
      return
    }
    if (key.return) {
      decide(APPROVAL_OPTIONS[cursor])
      return
    }
    if (key.escape) {
      decide(APPROVAL_OPTIONS[2])
      return
    }
    if (input === 'y' || input === 'Y') {
      decide(APPROVAL_OPTIONS[0])
      return
    }
    if (input === 'n' || input === 'N') {
      decide(APPROVAL_OPTIONS[1])
      return
    }
    if (input === 'd' || input === 'D') {
      decide(APPROVAL_OPTIONS[2])
      return
    }
    if (/^[1-9]$/u.test(input)) {
      const index = Number(input) - 1
      if (index < APPROVAL_OPTIONS.length) decide(APPROVAL_OPTIONS[index])
    }
  }, { isActive: active })

  if (pending === undefined) return undefined
  const queuedSuffix = snapshot.queued > 0 ? ` · +${snapshot.queued} queued` : ''
  if (viewport.maxHeight === 0 || viewport.compact || summarize === true) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('approval.compact', { queued: queuedSuffix }), viewport.contentColumns))
  }
  // Body budget: title + options + footer consume fixed rows; the command
  // preview shrinks with an explicit overflow marker (Codex's "[… N lines]").
  const reservedRows = 3 + APPROVAL_OPTIONS.length
  const bodyBudget = Math.max(1, viewport.bodyRows - reservedRows)
  const visibleBody = body.slice(0, bodyBudget)
  const overflow = body.length - visibleBody.length
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(
      Text,
      { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${pending.headline}${queuedSuffix}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 && body.length > 0 }),
    ...visibleBody.map((line, index) => createElement(StyledRows, { key: `body-${index}`, lines: [line] })),
    ...(overflow > 0
      ? [createElement(Text, { key: 'overflow', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('approval.overflow', { count: overflow }), viewport.contentColumns))]
      : []),
    ...(body.length > 0 ? [createElement(PanelGap, { visible: viewport.gapRows > 0 })] : []),
    ...APPROVAL_OPTIONS.map((option, index) => {
      const selected = !snapshot.answered && index === cursor
      return createElement(
        Text,
        {
          key: option.key,
          color: selected ? inkColor(getPalette().brandBright) : inkColor(getPalette().text),
          bold: selected || undefined,
          wrap: 'truncate-end',
        },
        truncateColumns(`${selected ? '›' : ' '} ${index + 1}. ${option.label} (${option.hotkey})`, viewport.contentColumns),
      )
    }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(snapshot.answered
      ? t('approval.submitted')
      : t('approval.footer'), viewport.contentColumns)),
  )
}

interface QuestionDraftState {
  readonly selected: readonly number[]
  readonly custom: string
  readonly cursor: number
  readonly mode: 'options' | 'custom'
  readonly scroll: number
  readonly manualScroll: boolean
  readonly followCustomTail: boolean
  readonly committed: boolean
}

function initialQuestionDraft(question: AskUserQuestionItem | undefined): QuestionDraftState {
  const hasOptions = (question?.options?.length ?? 0) > 0
  return {
    selected: [],
    custom: '',
    cursor: 0,
    mode: hasOptions ? 'options' : 'custom',
    scroll: 0,
    manualScroll: false,
    followCustomTail: !hasOptions,
    committed: false,
  }
}

function answerFromQuestionDraft(question: AskUserQuestionItem, draft: QuestionDraftState): AskUserQuestionAnswerItem {
  // Multi-select changes are answers as soon as a value is toggled, matching
  // Claude-Code's draft store. `committed` still records an explicit Enter so
  // an intentionally empty answer can be submitted, while navigation away
  // from a non-empty draft never discards the user's selection.
  const hasAnswer = question.multiSelect === true
    ? draft.committed || draft.selected.length > 0 || draft.custom.trim() !== ''
    : draft.committed
  if (!hasAnswer) {
    return { id: question.id, selected: [] }
  }
  const options = question.options ?? []
  const selected = draft.selected
    .map(at => options[at]?.label)
    .filter((label): label is string => label !== undefined)
  const custom = draft.custom.trim()
  return { id: question.id, selected, ...(custom === '' ? {} : { custom }) }
}

/**
 * The ask_user_question bar: walks one request question by question,
 * retaining an independent draft for every question. Options use Space/1-9
 * to toggle a multi-select, Enter to confirm, and arrows/Ctrl+P/N to move
 * between questions. Plan reviews arrive through the same service with a
 * `plan-review` intent — the approve option gets a ✓ mark, the answer
 * encoding stays identical.
 */
export function QuestionBar({ store, snapshot, locked }: { store: QuestionStore; snapshot: QuestionSnapshot; locked: boolean }): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const pending = snapshot.pending
  const request = pending?.request
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<readonly QuestionDraftState[]>(() => request?.questions.map(question => initialQuestionDraft(question)) ?? [])
  const [submitted, setSubmitted] = useState(false)
  const draftsRef = useRef<readonly QuestionDraftState[]>([])
  const indexRef = useRef(0)
  draftsRef.current = drafts
  indexRef.current = index

  // A new request resets the walk; questions without options start in the
  // custom-answer box (a free-form question). Depend on the request rather
  // than its wrapper snapshot: external stores may refresh that wrapper while
  // a question is still active, and a reset must never become a render loop.
  useEffect(() => {
    const next = request?.questions.map(question => initialQuestionDraft(question)) ?? []
    draftsRef.current = next
    indexRef.current = 0
    setDrafts(next)
    setIndex(0)
    setSubmitted(false)
  }, [request])

  const question = pending?.request.questions[index]
  const options = useMemo(() => question?.options ?? [], [question])
  const isPlan = question?.intent?.kind === 'plan-review'
  const isMulti = question?.multiSelect === true
  const currentDraft = drafts[index] ?? initialQuestionDraft(question)
  const { cursor, selected, mode, custom, scroll, manualScroll, followCustomTail } = currentDraft
  const active = !locked && pending !== undefined && question !== undefined && !submitted
  const rendered = useMemo(() => {
    if (question === undefined) return { lines: [] as readonly StyledLine[], optionRows: [] as readonly number[] }
    const lines: StyledLine[] = []
    const optionRows: number[] = []
    if (question.header !== undefined) {
      lines.push(...styledLines([lineSegment(question.header, 'bold')], viewport.contentColumns))
    }
    lines.push(...textLines(question.question, viewport.contentColumns))
    if (question.detail !== undefined) {
      lines.push(...(isPlan
        ? markdownLines(question.detail, viewport.contentColumns)
        : textLines(question.detail, viewport.contentColumns, 'dim')))
    }
    if (submitted) {
      lines.push(...textLines('  submitted…', viewport.contentColumns, 'dim'))
    } else if (mode === 'custom' || options.length === 0) {
      lines.push(...styledLines([
        lineSegment('  custom: ', 'brand'),
        lineSegment(custom, 'plain'),
        lineSegment('▌', 'brand'),
      ], viewport.contentColumns))
    } else {
      options.forEach((option, at) => {
        optionRows.push(lines.length)
        const chosen = isMulti && selected.includes(at)
        const approve = isPlan && question.intent?.approve === option.label
        const mark = approve ? '✓ ' : chosen ? '◉ ' : at === cursor ? '❯ ' : '  '
        const style: LineStyle = at === cursor ? 'brand' : chosen || approve ? 'success' : 'plain'
        lines.push(...styledLines([
          lineSegment(mark, style),
          // Claude-Code numbering: the digit addresses the row from the
          // keyboard, so the prefix advertises the binding it enables.
          lineSegment(at < 9 ? `${at + 1}. ` : '', 'dim'),
          lineSegment(option.label, style),
          lineSegment(option.description === undefined ? '' : ` — ${option.description}`, 'dim'),
        ], viewport.contentColumns))
      })
    }
    return { lines, optionRows }
  }, [question, isPlan, submitted, mode, options, custom, isMulti, selected, cursor, viewport.contentColumns])
  // Keeping a focused option visible is derived from the current render. It
  // deliberately does not write state from an effect: keyboard selection
  // then has one update path, rather than a cursor update repeatedly causing
  // a post-render scroll update (and, under rapid input, an update-depth
  // loop). Page scrolling explicitly takes ownership until focus moves again.
  const focusedRow = rendered.optionRows[cursor] ?? 0
  const automaticScroll = mode === 'options' && options.length > 0 && !manualScroll
    ? revealRow(scroll, focusedRow, rendered.lines.length, viewport.bodyRows)
    : (mode === 'custom' || options.length === 0) && followCustomTail
      ? Math.max(0, rendered.lines.length - viewport.bodyRows)
      : scroll
  const visibleScroll = clampScroll(automaticScroll, rendered.lines.length, viewport.bodyRows)

  const updateDrafts = (update: (current: readonly QuestionDraftState[]) => readonly QuestionDraftState[]): void => {
    const next = update(draftsRef.current)
    draftsRef.current = next
    setDrafts(next)
  }

  const updateCurrentDraft = (update: (current: QuestionDraftState) => QuestionDraftState): void => {
    const currentIndex = indexRef.current
    updateDrafts(current => current.map((draft, at) => at === currentIndex ? update(draft) : draft))
  }

  const moveQuestion = (direction: -1 | 1): void => {
    const total = request?.questions.length ?? 0
    if (total <= 1) return
    const currentIndex = indexRef.current
    const nextIndex = Math.max(0, Math.min(total - 1, currentIndex + direction))
    if (nextIndex === currentIndex) return
    indexRef.current = nextIndex
    setIndex(nextIndex)
  }

  const commit = (answer: AskUserQuestionAnswerItem): void => {
    if (pending === undefined || question === undefined) return
    const currentIndex = indexRef.current
    const optionLabels = new Set(answer.selected)
    const selectedIndices = (question.options ?? [])
      .map((option, at) => optionLabels.has(option.label) ? at : -1)
      .filter((at): at is number => at >= 0)
    const nextDrafts = draftsRef.current.map((draft, at) => at === currentIndex
      ? { ...draft, selected: selectedIndices, custom: answer.custom ?? '', committed: true }
      : draft)
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    const total = pending.request.questions.length
    if (currentIndex + 1 >= total) {
      setSubmitted(true)
      store.submit(pending, {
        answers: pending.request.questions.map((item, at) => answerFromQuestionDraft(item, nextDrafts[at] ?? initialQuestionDraft(item))),
      })
      return
    }
    const nextIndex = currentIndex + 1
    indexRef.current = nextIndex
    setIndex(nextIndex)
  }

  const commitOption = (): void => {
    if (pending === undefined || question === undefined) return
    const currentIndex = indexRef.current
    const current = draftsRef.current[currentIndex] ?? initialQuestionDraft(question)
    if (isMulti) {
      const labels = current.selected
        .map(at => options[at]?.label)
        .filter((label): label is string => label !== undefined)
      const customText = current.custom.trim()
      commit({ id: question.id, selected: labels, ...(customText === '' ? {} : { custom: customText }) })
      return
    }
    const option = options[current.cursor]
    if (option === undefined) return
    commit({ id: question.id, selected: [option.label] })
  }

  /**
   * A question with choices has two local focus surfaces, just like Codex:
   * the choice list and the optional custom-answer editor. Returning to the
   * list keeps the user's current choice and multi-select state, but drops the
   * transient custom draft so a second Escape can cancel the question.
   */
  const returnToOptions = (): void => {
    if (options.length === 0) return
    updateCurrentDraft(current => ({ ...current, mode: 'options', custom: '', scroll: 0, manualScroll: false, followCustomTail: false }))
  }

  useStableInput((input, key) => {
    if (pending === undefined || question === undefined || submitted) return
    if (viewport.maxHeight === 0) {
      // Options are not rendered at this height, so blind picks stay
      // disabled; only the explicit cancel remains available.
      if (key.escape || (key.ctrl && input === 'c')) store.cancel(pending)
      return
    }
    if (key.ctrl && input === 'c') {
      store.cancel(pending)
      return
    }
    if (key.escape) {
      if (mode === 'custom' && options.length > 0) {
        returnToOptions()
        return
      }
      store.cancel(pending)
      return
    }
    if (key.tab && key.shift) {
      moveQuestion(-1)
      return
    }
    if (key.leftArrow || (key.ctrl && input === 'p')) {
      moveQuestion(-1)
      return
    }
    if (key.rightArrow || (key.ctrl && input === 'n')) {
      moveQuestion(1)
      return
    }
    if (key.pageUp) {
      updateCurrentDraft(current => ({
        ...current,
        manualScroll: true,
        followCustomTail: false,
        scroll: moveScroll(visibleScroll, -Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows),
      }))
      return
    }
    if (key.pageDown) {
      updateCurrentDraft(current => ({
        ...current,
        manualScroll: true,
        followCustomTail: false,
        scroll: moveScroll(visibleScroll, Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows),
      }))
      return
    }
    if (mode === 'custom' || options.length === 0) {
      if (key.tab && options.length > 0) {
        returnToOptions()
        return
      }
      if (key.upArrow) {
        updateCurrentDraft(current => ({
          ...current,
          followCustomTail: false,
          scroll: moveScroll(visibleScroll, -1, rendered.lines.length, viewport.bodyRows),
        }))
        return
      }
      if (key.downArrow) {
        updateCurrentDraft(current => ({
          ...current,
          followCustomTail: false,
          scroll: moveScroll(visibleScroll, 1, rendered.lines.length, viewport.bodyRows),
        }))
        return
      }
      if (key.return) {
        if (custom.trim() === '' && options.length > 0) {
          commitOption()
          return
        }
        commit({
          id: question.id,
          selected: isMulti
            ? selected.map(at => options[at]?.label).filter((label): label is string => label !== undefined)
            : [],
          ...(custom.trim() === '' ? {} : { custom: custom.trim() }),
        })
        return
      }
      if (key.backspace || key.delete) {
        if (custom === '' && options.length > 0) {
          returnToOptions()
          return
        }
        updateCurrentDraft(current => ({ ...current, custom: deleteLastGrapheme(current.custom), committed: false }))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        // Panel drafts see paste markers as literal text (Ink strips only the
        // leading ESC); strip them so a pasted answer never persists "[200~".
        const text = stripPasteMarkers(input)
        if (text !== '') updateCurrentDraft(current => ({ ...current, custom: current.custom + text, committed: false }))
      }
      return
    }
    if (key.upArrow) {
      updateCurrentDraft(current => ({
        ...current,
        cursor: (current.cursor + options.length - 1) % options.length,
        manualScroll: false,
      }))
      return
    }
    if (key.downArrow) {
      updateCurrentDraft(current => ({
        ...current,
        cursor: (current.cursor + 1) % options.length,
        manualScroll: false,
      }))
      return
    }
    if (key.return) {
      commitOption()
      return
    }
    if (key.tab || input === 'c' || input === 'C') {
      updateCurrentDraft(current => ({ ...current, mode: 'custom', manualScroll: false, followCustomTail: true }))
      return
    }
    if (input === ' ' && isMulti) {
      updateCurrentDraft(current => ({
        ...current,
        selected: current.selected.includes(current.cursor)
          ? current.selected.filter(at => at !== current.cursor)
          : [...current.selected, current.cursor],
        committed: false,
      }))
      return
    }
    // Claude-Code option numbers: the digit addresses a row directly — a
    // toggle in multi-select, an immediate pick in single-select.
    if (/^[1-9]$/.test(input)) {
      const at = Number(input) - 1
      if (at >= options.length) return
      if (isMulti) {
        updateCurrentDraft(current => ({
          ...current,
          selected: current.selected.includes(at)
            ? current.selected.filter(row => row !== at)
            : [...current.selected, at],
          committed: false,
        }))
      } else {
        const option = options[at]
        if (option !== undefined) commit({ id: question.id, selected: [option.label] })
      }
    }
  }, active)

  if (pending === undefined || question === undefined) return undefined
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(isPlan ? t('question.compact.plan') : t('question.compact.normal'), viewport.contentColumns))
  }
  const footerBase = submitted
    ? t('question.submitted')
    : mode === 'custom'
      ? options.length === 0
        ? t('question.customNoOptions')
        : t('question.customOptions')
      : options.length === 0
        ? t('question.customNoOptions')
      : isMulti
        ? t('question.multiOptions')
        : t('question.singleOptions')
  const footer = pending.request.questions.length > 1 && !submitted
    ? `${footerBase}${t('question.switch')}`
    : footerBase
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(isPlan ? getPalette().brand : getPalette().brandDeep) },
    createElement(
      Text,
      { color: inkColor(isPlan ? getPalette().brand : getPalette().brandDeep), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${isPlan ? t('question.title.plan') : t('question.title.normal')} ${index + 1}/${pending.request.questions.length} · lines ${rendered.lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(rendered.lines.length, visibleScroll + viewport.bodyRows)}/${rendered.lines.length}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: rendered.lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(footer, viewport.contentColumns))),
  )
}

/** The /model panel: a scrolling list over the advisory model directory. */
