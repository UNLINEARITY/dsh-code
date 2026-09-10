import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectImageMediaType,
  inspectFilePaths,
  inspectImagePaths,
  looksLikeImagePath,
  parsePastedAttachmentPaths,
  saveFilePaths,
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
    expect(parsePastedAttachmentPaths('"C:\\work files\\a.png" "D:\\b.webp"'))
      .toEqual({ images: ['C:\\work files\\a.png', 'D:\\b.webp'], files: [] })
    expect(parsePastedAttachmentPaths('please inspect C:\\a.png')).toEqual({ images: [], files: [] })
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

  it('stops before persistence when image submission is cancelled', async () => {
    const saveImages = vi.fn(async () => [])
    const directory = await mkdtemp(join(tmpdir(), 'dsh-image-cancel-'))
    const path = join(directory, 'pixel.png')
    const controller = new AbortController()
    try {
      await writeFile(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      controller.abort()
      await expect(saveImagePaths([path], { saveImages } as never, controller.signal))
        .rejects.toThrow('image submission cancelled')
      expect(saveImages).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('terminal file attachments', () => {
  it('splits a dropped path list into images and files without eating commands', () => {
    expect(parsePastedAttachmentPaths('C:\\repo\\a.png C:\\repo\\notes.txt'))
      .toEqual({ images: ['C:\\repo\\a.png'], files: ['C:\\repo\\notes.txt'] })
    // file:// URLs decode to a local path on either platform.
    const decoded = parsePastedAttachmentPaths('file:///C:/repo/notes.txt')
    expect(decoded.images).toEqual([])
    expect(decoded.files).toHaveLength(1)
    expect(decoded.files[0]).not.toContain('file://')
    // Prose, slash commands, and bare words are text, never attachments.
    expect(parsePastedAttachmentPaths('/permission')).toEqual({ images: [], files: [] })
    expect(parsePastedAttachmentPaths('run the tests now')).toEqual({ images: [], files: [] })
    expect(parsePastedAttachmentPaths('notes')).toEqual({ images: [], files: [] })
    // A dot-suffixed leaf after a POSIX/relative separator is a real drop.
    expect(parsePastedAttachmentPaths('./report.pdf')).toEqual({ images: [], files: ['./report.pdf'] })
  })

  it('validates path and byte bounds before persisting a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-file-inspect-'))
    const path = join(directory, 'notes.txt')
    const attachments = {}
    try {
      await writeFile(path, 'hello')
      await expect(inspectFilePaths([path], attachments as never)).resolves.toEqual([{ path, name: 'notes.txt', bytes: 5 }])
      await expect(inspectFilePaths([join(directory, 'missing.txt')], attachments as never)).rejects.toThrow(/cannot read file/)
      await expect(inspectFilePaths([], undefined)).resolves.toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads file bytes and returns durable file blocks', async () => {
    const saveFile = vi.fn(async (input: { data: Uint8Array; name?: string }) => ({
      attachmentId: `sha-${input.name}`,
      name: input.name ?? 'file',
      bytes: input.data.byteLength,
    }))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-file-'))
    const path = join(directory, 'notes.txt')
    try {
      await writeFile(path, 'hello file')
      const blocks = await saveFilePaths([path], { saveFile } as never)
      expect(saveFile).toHaveBeenCalledOnce()
      expect(blocks).toEqual([{ type: 'file', attachment: { attachmentId: 'sha-notes.txt', name: 'notes.txt', bytes: 10 } }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops before persistence when file submission is cancelled', async () => {
    const saveFile = vi.fn(async () => ({ attachmentId: 'x', name: 'x', bytes: 1 }))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-file-cancel-'))
    const path = join(directory, 'notes.txt')
    const controller = new AbortController()
    try {
      await writeFile(path, 'hello')
      controller.abort()
      await expect(saveFilePaths([path], { saveFile } as never, controller.signal))
        .rejects.toThrow('file submission cancelled')
      expect(saveFile).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
