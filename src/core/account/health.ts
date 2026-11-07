import type { AccountRow } from "./schemas"

/** A successful sync stays fresh across three normal scheduler intervals. */
export const SYNC_FRESHNESS_MS = 15 * 60 * 1000

const HINTS = {
  login: "Verify a new token by signing in, then run service install to resume scheduled sync.",
  sync: "Run a sync to refresh the local mirror.",
  install_service: "Install the service to resume scheduled sync.",
  check_service: "Check the service and local account state before retrying.",
} as const

const COMMANDS = {
  login: ["login"],
  sync: ["sync"],
  install_service: ["service", "install"],
  check_service: ["service", "status"],
} as const

/** POSIX shell quoting keeps injected executable names and state paths single arguments. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Derives one next action; damaged bindings outrank login, and a missing mirror outranks installation. */
export function applyHealth(row: AccountRow, now: number, cli: string, stateDir: string): AccountRow {
  const reasons = [...row.reasons]
  if (row.token_status !== "available") reasons.push(`token_${row.token_status}`)
  if (row.scheduled === false) reasons.push("service_unscheduled")
  const last = row.last_sync_at === null ? null : Date.parse(row.last_sync_at)
  const stale = last === null || now - last > SYNC_FRESHNESS_MS
  if (last === null) reasons.push("sync_never_completed")
  else if (stale) reasons.push("sync_stale")
  if (row.sync_status === "running" && row.running === false && stale) reasons.push("interrupted_sync")
  if (row.sync_status !== null && ["partial", "failed", "cancelled", "rejected"].includes(row.sync_status)) {
    reasons.push(`sync_${row.sync_status}`)
  }

  const has = (...codes: string[]): boolean => codes.some((code) => reasons.includes(code))
  let action: AccountRow["action"] = null
  let hint: string | null = null
  if (has("identity_invalid", "identity_mismatch")) {
    action = "check_service"
    hint = "Restore the label's identity state before signing in again."
  } else if (has("token_missing", "token_invalid", "token_rejected", "identity_missing")) {
    action = "login"
  } else if (has("token_unreadable", "mirror_unavailable", "sync_state_invalid")) {
    action = "check_service"
    if (has("mirror_unavailable")) {
      hint = "Check the mirror: sync migrates older schemas; update the tools for a newer schema."
    }
  } else if (has("mirror_missing", "mirror_outdated")) {
    action = "sync"
  } else if (row.scheduled === false) {
    action = "install_service"
  } else if (
    row.scheduled === true &&
    has("sync_never_completed", "sync_stale", "sync_partial", "sync_failed", "sync_cancelled", "sync_rejected")
  ) {
    action = "sync"
  } else if (has("service_unknown")) {
    action = "check_service"
  }

  let health: AccountRow["health"] = action === null ? "healthy" : "attention"
  if (
    has("service_unknown") &&
    action === "check_service" &&
    !has("identity_invalid", "identity_mismatch", "token_unreadable", "mirror_unavailable", "sync_state_invalid")
  )
    health = "unknown"
  return {
    ...row,
    reasons,
    health,
    action,
    hint: action === null ? null : (hint ?? HINTS[action]),
    recovery_command:
      action === null
        ? null
        : [quote(cli), ...COMMANDS[action], "--account", quote(row.label), "--state-dir", quote(stateDir)].join(" "),
  }
}
