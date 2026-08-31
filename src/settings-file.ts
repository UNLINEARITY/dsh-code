/**
 * Serialized, crash-atomic persistence for the small user-level JSON files
 * under the DSH home (statusline.json, theme.json). Two guarantees the bare
 * floating `writeFile` path could not give:
 *
 * 1. Every save is appended to ONE chain, so rapid consecutive edits land
 *    in submission order and the last snapshot is the one on disk (parallel
 *    floating writes let an older snapshot finish last and win).
 * 2. Each write goes to a sibling temp file first and is renamed into
 *    place, so a crash mid-write can never leave a half-written JSON
 *    document behind.
 *
 * The chain itself never rejects: a failed write is reported to that
 * save's caller while later saves keep their turn.
 *
 * @module @deepseek-ai/dsh-code/settings-file
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The serialized persistence surface; flush() is handed to the quit sequence. */
export interface UserSettingsPersistence {
  /**
   * Queue one file snapshot. Resolves when the chain reaches (and renames)
   * it; rejects only to THIS caller when its own write failed.
   */
  save(path: string, text: string): Promise<void>
  /** Wait for every queued write; safe to call repeatedly. */
  flush(): Promise<void>
}

/**
 * Create the shared settings-write chain. One instance per process keeps
 * every user-level JSON file mutually serialized.
 * @returns the persistence handle.
 */
export function createUserSettingsPersistence(): UserSettingsPersistence {
  let chain: Promise<void> = Promise.resolve()
  return {
    save(path: string, text: string): Promise<void> {
      const write = chain.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.tmp`
        await writeFile(temp, text, 'utf8')
        await rename(temp, path)
      })
      // A failed write must not break the chain for later saves.
      chain = write.catch(() => {})
      return write
    },
    flush(): Promise<void> {
      return chain
    },
  }
}
