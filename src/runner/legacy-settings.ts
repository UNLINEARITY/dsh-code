/** One-shot detection of an incomplete legacy-settings migration.
 *
 * dsh 0.1.7 retired the global `~/.dsh/settings.yaml`: on the first boot of
 * the new line the settings service renames it to `settings.yaml.imported`
 * and imports each section into the booting profile's patch layer. The
 * rename precedes the section writes, there is no retry, and rejections only
 * reach stderr — so a first boot in a degraded state (a plugin refused by the
 * peer gate, an interrupted import) leaves provider/model config stranded in
 * the renamed file while every surface shows the defaults. The data is never
 * destroyed; it just stops loading.
 *
 * This module answers one question at startup: does the renamed document
 * still carry TUI-relevant sections that the active profile's patch has no
 * row for? When it does, {@link reimportLegacySettings} re-runs the host's
 * own import in-process — each stranded section goes back through the live
 * settings service, which stays the single writer and validates every field.
 *
 * @module @deepseek-ai/dsh-code/legacy-settings
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'

/** The retired global document's post-import name (the host renames to it). */
export const LEGACY_SETTINGS_IMPORTED = 'settings.yaml.imported'
/** The retired global document's original name (the restore target). */
export const LEGACY_SETTINGS_ACTIVE = 'settings.yaml'

/**
 * Profile patches may legally carry `!!js` expressions (the stock template
 * advertises them), which the default schema refuses. The passthrough keeps
 * those values opaque exactly like the host's own config editor parses them.
 */
const patchSchema = DEFAULT_SCHEMA.extend(
  new Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (value: unknown) => String(value) }),
)

/** Whether a value is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The sections of the retired document the terminal reads, each with the
 * predicate that says it carries something a migration should have landed:
 * `llm-pi-ai` needs providers, `llm-deepseek` needs models, and
 * `agent-default-model` needs a selection. Section names the 0.1.7 line
 * remaps to other entry ids are upstream's business and stay out of scope.
 */
const RELEVANT_SECTIONS: ReadonlyArray<readonly [id: string, carries: (section: Record<string, unknown>) => boolean]> = [
  ['llm-pi-ai', section => isPlainObject(section.providers) && Object.keys(section.providers).length > 0],
  ['llm-deepseek', section => Array.isArray(section.models) && section.models.length > 0],
  ['agent-default-model', section => typeof section.provider === 'string' || typeof section.model === 'string'],
]

/** A detected migration gap: what is stranded, and where to restore from. */
export interface LegacySettingsGap {
  /** Section ids present in the renamed document but absent from the patch. */
  readonly sections: readonly string[]
  /** The stranded sections' raw values, keyed by settings namespace. */
  readonly stranded: Readonly<Record<string, Record<string, unknown>>>
  /** Absolute path of the renamed document (the recovery source). */
  readonly importedPath: string
  /** Absolute path restoring to re-runs the host's import (the target). */
  readonly restorePath: string
}

/** Read one file as text; undefined when missing (any other failure throws). */
export type LegacySettingsReader = (path: string) => string | undefined

/** The subset of the launcher's profile facts this check reads. */
export interface LegacySettingsProfile {
  /** The dsh home (the retired document's directory). */
  readonly home: string
  /** The active profile's patch path (where a landed migration writes). */
  readonly patchPath: string
}

/**
 * Startup adapter over the live profile facts: one bounded read per file,
 * any failure reading either file degrades to "absent" — a courtesy check
 * must never break or delay a boot it exists to advise.
 * @param profile - the launcher's profile context, when the process runs in one.
 * @returns the gap to surface, or undefined.
 */
export function readLegacySettingsGap(profile: LegacySettingsProfile | undefined): LegacySettingsGap | undefined {
  if (profile === undefined) return undefined
  const read: LegacySettingsReader = path => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
  return detectLegacySettingsGap({ home: profile.home, patchPath: profile.patchPath, read })
}

/** The subset of the `settings` service the re-import writes through. */
export interface LegacySettingsWriteFace {
  /** Merge one namespace's editable fields into the active profile. */
  update(ns: string, patch: object): Promise<void>
}

/** What a re-import attempt did, per stranded section. */
export interface LegacyReimportOutcome {
  /** Sections whose values landed in the profile patch. */
  readonly recovered: readonly string[]
  /** Sections the settings service rejected, with its single-line reason. */
  readonly failed: readonly { readonly ns: string; readonly message: string }[]
}

/** Collapse every whitespace/control run to one space so notices stay one line. */
function singleLine(message: string): string {
  return message.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Re-run the host's own import for the stranded sections: each write goes
 * through the live settings service (the same validated, file-locked,
 * hot-reloading pipe the provider panel uses), so a rejected section changes
 * nothing while a landed one needs no restart. Sections are written in
 * document order and one failure never stops the next.
 * @param settings - the live settings service, when the profile exposes one.
 * @param gap - the detected gap carrying the stranded values.
 * @returns per-section outcomes; empty lists when no service is available.
 */
export async function reimportLegacySettings(
  settings: LegacySettingsWriteFace | undefined,
  gap: LegacySettingsGap,
): Promise<LegacyReimportOutcome> {
  const recovered: string[] = []
  const failed: { ns: string; message: string }[] = []
  if (settings === undefined) return { recovered, failed }
  for (const ns of gap.sections) {
    const values = gap.stranded[ns]
    if (values === undefined) continue
    try {
      await settings.update(ns, values)
      recovered.push(ns)
    } catch (error) {
      failed.push({ ns, message: singleLine(error instanceof Error ? error.message : String(error)) })
    }
  }
  return { recovered, failed }
}

/** Section ids of the retired document that carry terminal-relevant config. */
function carriedSections(document: Record<string, unknown>): string[] {
  const carried: string[] = []
  for (const [id, carries] of RELEVANT_SECTIONS) {
    const section = document[id]
    if (isPlainObject(section) && carries(section)) carried.push(id)
  }
  return carried
}

/**
 * Compare the renamed global settings document against the active profile's
 * patch layer. Unparseable or missing inputs never claim a gap on their own:
 * a missing renamed document means "no migration to check", and a missing or
 * corrupt patch means "nothing landed", which only matters when the renamed
 * document still carries a relevant section.
 * @param input - the dsh home, the active profile's patch path, and a reader.
 * @returns the stranded sections and recovery paths, or undefined when the
 *   migration is complete, absent, or cannot be judged (no active profile).
 */
export function detectLegacySettingsGap(input: {
  readonly home: string
  readonly patchPath: string | undefined
  readonly read: LegacySettingsReader
}): LegacySettingsGap | undefined {
  const importedPath = join(input.home, LEGACY_SETTINGS_IMPORTED)
  const text = input.read(importedPath)
  if (text === undefined) return undefined
  let document: unknown
  try {
    document = load(text, { schema: patchSchema })
  } catch {
    return undefined
  }
  if (!isPlainObject(document)) return undefined
  const stranded = carriedSections(document)
  if (stranded.length === 0) return undefined
  // Without the active profile's patch there is no migration to compare
  // against; a notice that cannot name a gap would only speculate.
  if (input.patchPath === undefined) return undefined
  const landed = new Set<string>()
  const patchText = input.read(input.patchPath)
  if (patchText !== undefined) {
    try {
      const rows = load(patchText, { schema: patchSchema })
      if (Array.isArray(rows)) {
        for (const row of rows) {
          // Only a row that carries config counts as landed: the host's
          // import writes { id, name, config }, and a bare id row is an
          // override shell that inherited nothing.
          if (isPlainObject(row) && typeof row.id === 'string' && isPlainObject(row.config)) {
            landed.add(row.id)
          }
        }
      }
    } catch {
      // A corrupt patch layer fails far louder at boot; here it reads as
      // "nothing landed", which is what the stranded sections need it to be.
    }
  }
  const sections = stranded.filter(id => !landed.has(id))
  if (sections.length === 0) return undefined
  const values: Record<string, Record<string, unknown>> = {}
  for (const id of sections) values[id] = document[id] as Record<string, unknown>
  return { sections, stranded: values, importedPath, restorePath: join(input.home, LEGACY_SETTINGS_ACTIVE) }
}
