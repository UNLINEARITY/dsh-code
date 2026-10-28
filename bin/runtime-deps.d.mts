export const SECURITY_OVERRIDES: Readonly<Record<string, string>>
export function findRuntimeRoot(command?: string, searchPath?: string): string
export function securityOverridePlan(value: Record<string, unknown>): Record<string, unknown>
export interface RuntimeDependency {
  owner: string
  dependency: string
  version: string
  minimum: string
  path: string
  safe: boolean
}
export function inspectRuntimeDependencies(root: string): RuntimeDependency[]
export function repairRuntimeDependencies(options: {
  root: string
  npm: { command: string; args: string[] }
  check?: boolean
  backupBase?: string
  run?: (command: string, args: string[], options: { stdio: 'inherit'; windowsHide: boolean }) => { status: number | null }
}): { rows: RuntimeDependency[]; backup?: string }
