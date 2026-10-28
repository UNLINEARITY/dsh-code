/** Build a self-contained CLI tarball and audit a fresh consumer installation. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { x as extractTar } from 'tar'
import { npmInvocation } from '../bin/deepseek.mjs'
import { SECURITY_OVERRIDES } from '../bin/runtime-deps.mjs'

const args = process.argv.slice(2)
const destinationIndex = args.indexOf('--pack-destination')
const destination = resolve(destinationIndex < 0 ? 'dist' : args[destinationIndex + 1] ?? 'dist')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-release-pack-')))
const stage = join(scratch, 'package')
const npm = npmInvocation()
function run(args: string[], cwd = process.cwd()): void {
  const result = spawnSync(npm.command, [...npm.args, ...args], { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`release package step failed: npm ${args[0]}`)
}
try {
  const value = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string; files: string[]; dependencies: Record<string, string>; devDependencies?: unknown; scripts?: unknown }
  const { devDependencies: _dev, scripts: _scripts, ...production } = value
  mkdirSync(stage)
  for (const name of [...value.files, 'LICENSE', 'README.md', 'README_CN.md']) {
    const path = relative(process.cwd(), resolve(name))
    if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) throw new Error(`invalid package input: ${name}`)
    cpSync(name, join(stage, name), { recursive: true })
  }
  const staged = { ...production, overrides: { ...SECURITY_OVERRIDES, 'js-yaml': '$js-yaml' } }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(staged, null, 2) + '\n')
  run(['install', '--prefix', stage, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'])
  const lock = JSON.parse(readFileSync(join(stage, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; os?: unknown; cpu?: unknown }> }
  // npm installs only the current platform's optional bindings. Include the
  // other registry prebuilds too, without executing their install scripts.
  for (const [path, entry] of Object.entries(lock.packages)) {
    if ((entry.os === undefined && entry.cpu === undefined) || existsSync(join(stage, path))) continue
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const packed = spawnSync(npm.command, [...npm.args, 'pack', `${name}@${entry.version}`, '--ignore-scripts', '--pack-destination', scratch, '--json'], { encoding: 'utf8' })
    if (packed.status !== 0) throw new Error(`cannot fetch platform binding: ${name}`)
    const files = JSON.parse(packed.stdout) as { filename: string }[]
    const target = join(stage, path)
    mkdirSync(target, { recursive: true })
    await extractTar({ file: join(scratch, files[0]!.filename), cwd: target, strip: 1 })
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ ...staged, bundleDependencies: Object.keys(value.dependencies) }, null, 2) + '\n')
  run(['audit', '--prefix', stage, '--omit=dev', '--audit-level=low'])
  mkdirSync(destination, { recursive: true })
  run(['pack', '--ignore-scripts', '--pack-destination', destination], stage)
  const artifact = join(destination, `${value.name}-${value.version}.tgz`)
  const consumer = join(scratch, 'consumer')
  run(['install', '--prefix', consumer, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', artifact])
  run(['audit', '--prefix', consumer, '--omit=dev', '--audit-level=low'])
  console.log(`Audited release artifact: ${artifact}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
