/** Permission-preset policy for pending and active TUI sessions. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Structural boundary over Harness permission presets; values stay service-owned. */
export interface PermissionPresetsService {
  readonly names: readonly string[]
  readonly defaultPreset: string
  resolve(name: string): unknown
  current(events: readonly SessionEvent[]): string
  set(session: Session, preset: string): void
}

/** Read the optional Harness service without importing its runtime package. */
export function permissionPresetsFrom(ctx: Context): PermissionPresetsService | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('permissionPresets') as PermissionPresetsService | undefined
}

/** Effective label for either an active session or the not-yet-created first one. */
export function effectivePermission(
  service: PermissionPresetsService,
  session: Session | undefined,
  pending: string | undefined,
): string {
  return session === undefined ? pending ?? service.defaultPreset : service.current(session.events)
}

/** Validate a preset and write it only when a durable session already exists. */
export function selectPermission(
  service: PermissionPresetsService,
  session: Session | undefined,
  preset: string,
): string {
  service.resolve(preset)
  if (session !== undefined) service.set(session, preset)
  return preset
}

/** Cycle table order from the active, pending, or configured-default value. */
export function cyclePermission(
  service: PermissionPresetsService,
  session: Session | undefined,
  pending: string | undefined,
): string {
  if (service.names.length === 0) return ''
  const at = service.names.indexOf(effectivePermission(service, session, pending))
  const next = service.names[(at + 1) % service.names.length] ?? ''
  return next === '' ? '' : selectPermission(service, session, next)
}

/** Materialize a pre-session choice after Harness creates the first session. */
export function applyPendingPermission(
  service: PermissionPresetsService,
  session: Session,
  pending: string | undefined,
): void {
  if (pending !== undefined && effectivePermission(service, session, undefined) !== pending) {
    selectPermission(service, session, pending)
  }
}
