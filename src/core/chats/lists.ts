import { getMeta } from "../discord/mirror"
import type { ChatSession } from "./session"

/**
 * The time a whole list was last read, when the mirror may still serve it: its
 * `meta` stamp exists, is under `maxAgeMs` old (a stamp from the future does
 * not count) and `force` is not set. `null` means the list is read live.
 */
export function freshStamp(session: ChatSession, key: string, maxAgeMs: number, force = false): number | null {
  const stamp = listStamp(session, key)
  if (stamp === null || force) return null
  const age = session.now() - stamp
  return age >= 0 && age < maxAgeMs ? stamp : null
}

/** The time a whole list was last stored in full, or `null` when it never was. */
export function listStamp(session: ChatSession, key: string): number | null {
  const value = getMeta(session.mirror)[key]
  const stamp = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(stamp) ? stamp : null
}
