/** Terminal image-file adapter over the Harness durable attachment service. */

import { open, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { AttachmentStore, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

/** A validated path retained in the editor until submission persists it. */
export interface ImagePathInspection {
  readonly path: string
  readonly name: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

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

/** Whether a path-like token is worth probing as an image attachment. */
export function looksLikeImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** Parse a terminal paste/drop containing only one or more image paths. */
export function parsePastedImagePaths(input: string): readonly string[] {
  const text = input.trim()
  if (text === '') return []
  const tokens: string[] = []
  const matcher = /"([^"]+)"|'([^']+)'|(\S+)/gu
  for (const match of text.matchAll(matcher)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token === undefined) continue
    let path = token
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path)
      } catch {
        return []
      }
    }
    if (!looksLikeImagePath(path)) return []
    tokens.push(path)
  }
  return tokens
}

/** Validate path, byte size and encoded signature without writing an attachment object. */
export async function inspectImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  cwd = process.cwd(),
): Promise<readonly ImagePathInspection[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  if (paths.length > attachments.imageLimits.maxImagesPerMessage) {
    throw new Error(`too many images (${paths.length}; limit ${attachments.imageLimits.maxImagesPerMessage})`)
  }
  const inspected: ImagePathInspection[] = []
  let totalBytes = 0
  for (const raw of paths) {
    const path = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
    let facts: Awaited<ReturnType<typeof stat>>
    try {
      facts = await stat(path)
    } catch (error: unknown) {
      throw new Error(`cannot read image "${raw}": ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!facts.isFile()) throw new Error(`image path is not a file: "${raw}"`)
    if (facts.size > attachments.imageLimits.maxImageBytes) {
      throw new Error(`image "${basename(path)}" is ${facts.size} bytes; limit ${attachments.imageLimits.maxImageBytes}`)
    }
    totalBytes += facts.size
    if (totalBytes > attachments.imageLimits.maxMessageImageBytes) {
      throw new Error(`image batch is ${totalBytes} bytes; limit ${attachments.imageLimits.maxMessageImageBytes}`)
    }
    const handle = await open(path, 'r')
    try {
      const signature = new Uint8Array(16)
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
      const mediaType = detectImageMediaType(signature.subarray(0, bytesRead))
      if (mediaType === undefined || !attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`unsupported image file "${raw}" (expected PNG, JPEG, WebP, or GIF)`)
      }
      inspected.push({ path, name: basename(path), mediaType, bytes: facts.size })
    } finally {
      await handle.close()
    }
  }
  return inspected
}

/** Read, validate, and persist an ordered image path list as model content blocks. */
export async function saveImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly ImageBlock[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  const checkCancelled = (): void => {
    if (signal?.aborted === true) throw new Error('image submission cancelled')
  }
  const inputs: SaveImageAttachment[] = []
  for (const path of paths) {
    checkCancelled()
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
  checkCancelled()
  const refs = await attachments.saveImages(inputs)
  checkCancelled()
  return refs.map(attachment => ({ type: 'image', attachment }))
}
