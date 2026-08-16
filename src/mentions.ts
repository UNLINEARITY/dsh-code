/**
 * Workspace @mention support: file and directory candidates from a bounded
 * async scan of the session cwd, session candidates from the opt-in
 * `sessionReferenceResolver` service, and submission preparation through its
 * `prepare()` API. Picked session mentions land as canonical
 * `@[label](dsh-session:…)` tokens; on submit the text is parsed back into
 * readable `@label` text plus structured references, snapshots are injected
 * via `agent.inject()` before the readable message wakes the driver
 * (`followup` idle, `steer` running) — exactly the upstream README's wiring.
 *
 * Harness exposes no workspace-file mention service (only session references
 * plus a post-hoc produced-file linker), so the file index is the lightweight
 * bounded scan below, kept deliberately smaller than Codex's streaming
 * gitignore-aware walker.
 *
 * @module @deepseek-ai/dsh-code/mentions
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  formatSessionReferenceMention,
  parseSessionReferenceText,
  type SessionReferenceCandidate,
  type SessionReferenceInput,
} from '@deepseek-ai/dsh-session-reference'

/** Parsed submission text: readable text plus structured references. */
type ParsedSessionReferenceText = ReturnType<typeof parseSessionReferenceText>

/** One filesystem entry the @ menu can complete. */
export interface FileCandidate {
  /** Workspace-relative path with forward slashes. */
  path: string
  /** Entry kind; directories insert with a trailing slash. */
  kind: 'file' | 'directory'
}

/** One merged menu candidate (files and sessions, already ranked). */
export interface MentionCandidate {
  /** Text inserted after the `@` (directories carry a trailing slash). */
  label: string
  /** Human-readable origin shown beside the label. */
  description: string
  /** Origin kind for icon/coloring decisions. */
  kind: 'file' | 'directory' | 'session'
}

/** Prepared submission: readable content plus optional injected context. */
export interface PreparedMention {
  /** Readable text with mention tokens normalized to `@label`. */
  text: string
  /** Structured source sessions in appearance order (empty when none). */
  references: SessionReferenceInput[]
  /** Aggregated snapshot for `agent.inject()`, undefined without references. */
  additionalContext?: import('@deepseek-ai/dsh-session').UserMessage
}

/** Directories never entered and files never listed during the scan. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib', 'dist', 'out', '.omc', 'coverage'])
const MAX_FILES = 4000
const MAX_DEPTH = 12
/** Empty-query default rows: proves the index exists without typing (Codex's
 * popups show something on a bare sigil too). */
const EMPTY_QUERY_ROWS = 20

/**
 * Bounded async BFS scan of a workspace; unreadable entries are skipped.
 * Both files and directories are indexed (directories insert with a trailing
 * slash), mirroring Codex's `MatchType::{File,Directory}` index. Dotfiles and
 * the {@link SKIP_DIRS} list are excluded, which is a coarser filter than
 * Codex's gitignore-aware walker but stays dependency-free and bounded.
 */
export async function scanWorkspaceFiles(root: string, signal?: AbortSignal): Promise<readonly FileCandidate[]> {
  const found: FileCandidate[] = []
  const pending: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: '', depth: 0 }]
  const aborted = (): boolean => signal?.aborted === true
  while (pending.length > 0 && found.length < MAX_FILES && !aborted()) {
    const current = pending.shift()
    if (current === undefined) break
    let entries
    try {
      entries = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES || aborted()) return found
      if (entry.name.startsWith('.')) continue
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || current.depth + 1 > MAX_DEPTH) continue
        found.push({ path: relative, kind: 'directory' })
        pending.push({ absolute: join(current.absolute, entry.name), relative, depth: current.depth + 1 })
      } else if (entry.isFile()) {
        found.push({ path: relative, kind: 'file' })
      }
    }
  }
  return found.sort((left, right) => left.path < right.path ? -1 : 1)
}

/** True when every query character appears in order in the haystack. */
function isSubsequence(query: string, haystack: string): boolean {
  let at = 0
  for (const char of haystack) {
    if (char === query[at]) at += 1
    if (at >= query.length) return true
  }
  return at >= query.length
}

/** Rank one file path against the typed query (community-TUI scoring shape). */
function scoreFile(path: string, query: string): number {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (query === '') return 0
  if (name === query) return 1000
  if (name.startsWith(query)) return 900
  if (name.includes(query)) return 700
  if (path.includes(query)) return 500
  if (isSubsequence(query, name)) return 300
  return 0
}

/** The mention API the input editor and the runner share. */
export interface MentionsApi {
  /** Scanned workspace files and directories, cached across one session. */
  files(): Promise<readonly FileCandidate[]>
  /** Ranked menu candidates for the typed `@` query. */
  candidates(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]>
  /** Parse submission text into readable text plus structured references. */
  parse(text: string): ParsedSessionReferenceText
  /**
   * Snapshot references and build the injected context. Throws the service's
   * typed error on failure — the caller restores the draft and notifies.
   */
  prepare(parsed: ParsedSessionReferenceText, signal?: AbortSignal): Promise<PreparedMention>
  /** Canonical mention token for a picked session candidate. */
  sessionMention(candidate: SessionReferenceCandidate): string
}

/**
 * Create the mention API for one agent's workspace. A missing
 * session-reference service degrades to file mentions only (the scan still
 * works); `prepare` then passes text through untouched. An undefined agent
 * (a bare launch before any session exists) also degrades to file-only
 * mentions, so `@` file completion works before the first message.
 *
 * `files` is hoisted into the closure so `candidates` never reaches for
 * `this` — the runner hands `mentions.candidates` to the input editor as a
 * detached callback, and a `this`-bound method would throw on every `@` key.
 * @param ctx - context carrying the optional `sessionReferenceResolver`.
 * @param agent - the session owner; excluded from its own candidates.
 * @param cwd - workspace root to scan.
 */
export function createMentions(ctx: Context, agent: Agent | undefined, cwd: string): MentionsApi {
  const resolver = ctx.get('sessionReferenceResolver')
  const sessionCapable = agent !== undefined && resolver !== undefined
  let filesPromise: Promise<readonly FileCandidate[]> | undefined
  const files = (): Promise<readonly FileCandidate[]> => {
    filesPromise ??= scanWorkspaceFiles(cwd)
    return filesPromise
  }

  return {
    files,
    async candidates(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]> {
      const needle = query.trim()
      const [scanned, sessions] = await Promise.all([
        files(),
        sessionCapable && needle !== '' && agent !== undefined
          ? resolver!.listCandidates(agent, needle, 10, signal).catch(() => [] as readonly SessionReferenceCandidate[])
          : Promise.resolve([] as readonly SessionReferenceCandidate[]),
      ])
      // A bare `@` lists the first path-sorted entries so the menu is live
      // before any typing; a non-empty needle ranks by the Codex-shaped score.
      const fileRows: MentionCandidate[] = (needle === ''
        ? scanned.slice(0, EMPTY_QUERY_ROWS)
        : scanned
          .filter(candidate => scoreFile(candidate.path, needle) > 0)
          .sort((left, right) => scoreFile(right.path, needle) - scoreFile(left.path, needle))
          .slice(0, 20))
        .map(candidate => ({
          label: candidate.path,
          description: candidate.kind === 'directory' ? 'Folder' : 'File',
          kind: candidate.kind,
        }))
      // Sessions join only with a typed needle and always AFTER the file
      // rows: `@` is a file mention first (Codex's semantics), and session
      // references are the secondary vocabulary.
      const sessionRows: MentionCandidate[] = sessions.map(candidate => ({
        label: formatSessionReferenceMention(candidate),
        description: `Session · ${candidate.cwd ?? '(no cwd)'}`,
        kind: 'session',
      }))
      return [...fileRows, ...sessionRows]
    },
    parse(text: string): ParsedSessionReferenceText {
      return parseSessionReferenceText(text)
    },
    async prepare(parsed: ParsedSessionReferenceText, signal?: AbortSignal): Promise<PreparedMention> {
      if (parsed.references.length === 0 || resolver === undefined || agent === undefined) {
        return { text: parsed.text, references: parsed.references }
      }
      const prepared = await resolver.prepare(
        agent,
        [{ type: 'text', text: parsed.text }],
        parsed.references,
        signal,
      )
      return {
        text: prepared.content.filter(block => block.type === 'text').map(block => block.text).join(''),
        references: parsed.references,
        additionalContext: prepared.additionalContext,
      }
    },
    sessionMention(candidate: SessionReferenceCandidate): string {
      return formatSessionReferenceMention({ sessionId: candidate.sessionId, label: candidate.label })
    },
  }
}
