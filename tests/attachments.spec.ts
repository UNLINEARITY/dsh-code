import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectImageMediaType,
  inspectImagePaths,
  looksLikeImagePath,
  parsePastedImagePaths,
  saveImagePaths,
} from '../src/attachments.ts'

describe('terminal image attachments', () => {
  it('detects supported formats from encoded bytes', () => {
    expect(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(detectImageMediaType(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(detectImageMediaType(new TextEncoder().encode('RIFFxxxxWEBP'))).toBe('image/webp')
    expect(detectImageMediaType(new TextEncoder().encode('not an image'))).toBeUndefined()
  })

  it('does not require an attachment service for a text-only prompt', async () => {
    await expect(saveImagePaths([], undefined)).resolves.toEqual([])
  })

  it('parses quoted multi-image terminal drops without treating prose as paths', () => {
    expect(looksLikeImagePath('diagram.PNG')).toBe(true)
    expect(parsePastedImagePaths('"C:\\work files\\a.png" "D:\\b.webp"'))
      .toEqual(['C:\\work files\\a.png', 'D:\\b.webp'])
    expect(parsePastedImagePaths('please inspect C:\\a.png')).toEqual([])
  })

  it('validates signature and limits before submission without persisting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-image-inspect-'))
    const path = join(directory, 'pixel.png')
    const attachments = {
      imageLimits: {
        maxImageBytes: 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 2048,
        maxImagePixels: 1_000_000,
        maxImageDimension: 4096,
        mediaTypes: ['image/png'],
      },
    }
    try {
      await writeFile(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      await expect(inspectImagePaths([path], attachments as never)).resolves.toEqual([{
        path,
        name: 'pixel.png',
        mediaType: 'image/png',
        bytes: 8,
      }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads image bytes and returns only durable references', async () => {
    const saveImages = vi.fn(async inputs => inputs.map((input: { name?: string; mediaType: string; data: Uint8Array }, index: number) => ({
      attachmentId: `sha-${index}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    })))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-image-'))
    const path = join(directory, 'pixel.png')
    try {
      await writeFile(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      const blocks = await saveImagePaths([path], { saveImages } as never)
      expect(saveImages).toHaveBeenCalledOnce()
      expect(blocks).toMatchObject([{ type: 'image', attachment: { mediaType: 'image/png', name: 'pixel.png' } }])
      expect(JSON.stringify(blocks)).not.toContain(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
