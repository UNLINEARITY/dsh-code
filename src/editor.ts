/** Host editor and clipboard adapters used by the terminal surface. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptView } from './render/projection.ts'

function waitForProcess(command: string, args: readonly string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: input === undefined ? 'inherit' : ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** Open a temporary Markdown draft in the configured blocking editor. */
export async function editTextInExternalEditor(initial: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-editor-'))
  const path = join(directory, 'prompt.md')
  try {
    await writeFile(path, initial, 'utf8')
    const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim()
    if (editor === undefined || editor === '') {
      await waitForProcess(process.platform === 'win32' ? 'notepad.exe' : 'vi', [path])
    } else {
      const quotedPath = `"${path.replaceAll('"', '\\"')}"`
      await waitForProcess(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32'
        ? ['/d', '/s', '/c', `${editor} ${quotedPath}`]
        : ['-c', `${editor} ${quotedPath}`])
    }
    return (await readFile(path, 'utf8')).replace(/\r?\n$/u, '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Copy UTF-8 text through the platform clipboard command. */
export async function copyText(text: string): Promise<void> {
  if (process.platform === 'win32') {
    await waitForProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'], text)
    return
  }
  if (process.platform === 'darwin') {
    await waitForProcess('pbcopy', [], text)
    return
  }
  await waitForProcess('xclip', ['-selection', 'clipboard'], text)
}

/** Latest complete assistant text, excluding streaming and reasoning. */
export function latestAssistantText(view: TranscriptView): string | undefined {
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]
    if (entry?.kind === 'assistant' && entry.text !== '') return entry.text
  }
  return undefined
}
