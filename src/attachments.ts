/** Terminal image-file adapter over the Harness durable attachment service. */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AttachmentStore, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

/** Detect the supported encoded raster formats from bytes, never from a path suffix. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

/** Read, validate, and persist an ordered image path list as model content blocks. */
export async function saveImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
): Promise<readonly ImageBlock[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  const inputs: SaveImageAttachment[] = []
  for (const path of paths) {
    let data: Uint8Array
    try {
      data = await readFile(path)
    } catch (error: unknown) {
      throw new Error(`cannot read image "${path}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const mediaType = detectImageMediaType(data)
    if (mediaType === undefined) throw new Error(`unsupported image file "${path}" (expected PNG, JPEG, WebP, or GIF)`)
    inputs.push({ data, mediaType, name: basename(path) })
  }
  const refs = await attachments.saveImages(inputs)
  return refs.map(attachment => ({ type: 'image', attachment }))
}
