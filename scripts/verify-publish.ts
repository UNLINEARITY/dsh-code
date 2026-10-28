/** Verify the exact directory payload that npm publish will pack next. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { x as extractTar } from 'tar'
import { npmInvocation } from '../bin/deepseek.mjs'

const root = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-publish-check-')))
const npm = npmInvocation()
function run(args: string[]): void {
  const result = spawnSync(npm.command, [...npm.args, ...args, '--dry-run=false'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`publish verification failed: npm ${args[0]}`)
}
try {
  const addon = join(root, 'node_modules/node-addon-require-builtin/package.json')
  if (existsSync(addon)) {
    const value = JSON.parse(readFileSync(addon, 'utf8')) as { optionalDependencies?: Record<string, string> }
    for (const [name, version] of Object.entries(value.optionalDependencies ?? {})) {
      const target = join(root, 'node_modules', name)
      if (existsSync(join(target, 'package.json'))) continue
      const result = spawnSync(npm.command, [...npm.args, 'pack', `${name}@${version}`, '--ignore-scripts', '--pack-destination', scratch, '--json', '--dry-run=false'], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`cannot fetch platform binding: ${name}`)
      const files = JSON.parse(result.stdout) as { filename: string }[]
      mkdirSync(target, { recursive: true })
      await extractTar({ file: join(scratch, files[0]!.filename), cwd: target, strip: 1 })
    }
  }
  // npm publish --dry-run propagates its config to lifecycle scripts. These
  // local pack/install checks must still create files; none publishes remotely.
  const packed = spawnSync(npm.command, [...npm.args, 'pack', '--ignore-scripts', '--pack-destination', scratch, '--json', '--dry-run=false'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(packed.stderr || 'cannot pack the publish payload')
  const files = JSON.parse(packed.stdout) as { filename: string; bundled: string[] }[]
  if (!files[0]?.bundled.length) throw new Error('publish payload is missing bundled production dependencies')
  const consumer = join(scratch, 'consumer')
  run(['install', '--prefix', consumer, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', join(scratch, files[0].filename)])
  run(['audit', '--prefix', consumer, '--omit=dev', '--audit-level=low'])
  // pnpm's isolated layout can produce an apparently clean archive whose
  // transitive packages cannot be resolved. Exercise a real runtime import.
  const requireFromConsumer = createRequire(join(consumer, 'node_modules/dsh-code/package.json'))
  await import(requireFromConsumer.resolve('@deepseek-ai/schemastery'))
  console.log('Verified npm publish payload: bundled dependencies, consumer audit, and runtime import passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
