/** User-level preference files under the DSH home.
 *
 * The statusline, theme, language, and animations customizations each live in
 * one small JSON file. They share exactly two policies: a missing file is the
 * default and stays silent while a corrupt one degrades to the default with a
 * surfaced warning (a user-authored customization must never fail silently),
 * and every save goes through the serialized crash-atomic writer.
 *
 * @module @deepseek-ai/dsh-code/preferences
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSettingsObject, type UserSettingsPersistence } from '../settings-file.ts'

/** Absolute path of one preference file under the DSH home. */
export function preferencePath(fileName: string): string {
  return join(homedir(), '.dsh', 'dsh-code', fileName)
}

/** Outcome of reading one preference file. */
export interface PreferenceRead<T> {
  /** Parsed value; undefined when the file is missing or corrupt (keep the default). */
  readonly value?: T
  /** Corruption message to surface; undefined for a missing or clean file. */
  readonly warning?: string
}

/**
 * Read one field of a preference file. A missing file is silence — the default
 * stands and nothing is reported — while unreadable JSON or a non-object
 * document both warn and keep the default.
 * @param path - absolute path of the preference file.
 * @param field - the JSON field the file carries.
 * @param parse - narrows the raw field to the usable value.
 * @returns the parsed value and/or the warning to surface.
 */
export function readPreference<T>(path: string, field: string, parse: (raw: unknown) => T): PreferenceRead<T> {
  try {
    return { value: parse(readSettingsObject(path)[field]) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { warning: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Persist one preference field through the serialized crash-atomic writer.
 * A failed write is reported through `onFailure` instead of rejecting.
 * @param persistence - the shared user-settings writer.
 * @param path - absolute path of the preference file.
 * @param field - the JSON field the file carries.
 * @param value - the value to store under `field`.
 * @param onFailure - receives the failure message for a bounded notice.
 */
export function savePreference(
  persistence: UserSettingsPersistence,
  path: string,
  field: string,
  value: unknown,
  onFailure: (message: string) => void,
): void {
  void persistence.save(path, JSON.stringify({ [field]: value }, null, 2) + '\n')
    .catch((error: unknown) => {
      onFailure(error instanceof Error ? error.message : String(error))
    })
}
