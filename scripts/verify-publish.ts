/** Verify the exact directory payload that npm publish will pack next. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmInvocation } from '../bin/deepseek.mjs'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-publish-check-')))
const npm = npmInvocation()
function run(args: string[]): void {
  const result = spawnSync(npm.command, [...npm.args, ...args, '--dry-run=false'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`publish verification failed: npm ${args[0]}`)
}
try {
  // npm publish --dry-run propagates its config to lifecycle scripts. These
  // local pack/install checks must still create files; none publishes remotely.
  const packed = spawnSync(npm.command, [...npm.args, 'pack', '--ignore-scripts', '--pack-destination', scratch, '--json', '--dry-run=false'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(packed.stderr || 'cannot pack the publish payload')
  const files = JSON.parse(packed.stdout) as { filename: string; bundled: string[] }[]
  if (!files[0]?.bundled.length) throw new Error('publish payload is missing bundled production dependencies')
  if (files[0].bundled.some(name => name.startsWith('@deepseek-ai/'))) {
    throw new Error('publish payload duplicates host-owned Harness dependencies')
  }
  const consumer = join(scratch, 'consumer')
  run(['install', '--prefix', consumer, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', join(scratch, files[0].filename)])
  run(['audit', '--prefix', consumer, '--omit=dev', '--audit-level=low'])
  // pnpm's isolated layout can produce an apparently clean archive whose
  // transitive packages cannot be resolved. Exercise a real runtime import.
  const requireFromConsumer = createRequire(join(consumer, 'node_modules/dsh-code/package.json'))
  await import(pathToFileURL(requireFromConsumer.resolve('js-yaml')).href)
  console.log('Verified npm publish payload: bundled dependencies, consumer audit, and runtime import passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
