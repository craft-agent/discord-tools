import { ToolError } from "../errors"

/**
 * Discord's permission flags by name, in lower case, and the bit of each. Bit 47
 * has no flag; a bit the table lacks is told as `bit{n}`.
 */
export const PERMISSION_BITS: Readonly<Record<string, number>> = {
  create_instant_invite: 0,
  kick_members: 1,
  ban_members: 2,
  administrator: 3,
  manage_channels: 4,
  manage_guild: 5,
  add_reactions: 6,
  view_audit_log: 7,
  priority_speaker: 8,
  stream: 9,
  view_channel: 10,
  send_messages: 11,
  send_tts_messages: 12,
  manage_messages: 13,
  embed_links: 14,
  attach_files: 15,
  read_message_history: 16,
  mention_everyone: 17,
  use_external_emojis: 18,
  view_guild_insights: 19,
  connect: 20,
  speak: 21,
  mute_members: 22,
  deafen_members: 23,
  move_members: 24,
  use_vad: 25,
  change_nickname: 26,
  manage_nicknames: 27,
  manage_roles: 28,
  manage_webhooks: 29,
  manage_guild_expressions: 30,
  use_application_commands: 31,
  request_to_speak: 32,
  manage_events: 33,
  manage_threads: 34,
  create_public_threads: 35,
  create_private_threads: 36,
  use_external_stickers: 37,
  send_messages_in_threads: 38,
  use_embedded_activities: 39,
  moderate_members: 40,
  view_creator_monetization_analytics: 41,
  use_soundboard: 42,
  create_guild_expressions: 43,
  create_events: 44,
  use_external_sounds: 45,
  send_voice_messages: 46,
  set_voice_channel_status: 48,
  send_polls: 49,
  use_external_apps: 50,
  pin_messages: 51,
  bypass_slowmode: 52,
}

/** The permissions that act on other people, the server or its settings; a read marks them. */
export const STRONG_PERMISSIONS: ReadonlySet<string> = new Set([
  "administrator",
  "ban_members",
  "kick_members",
  "manage_guild",
  "manage_roles",
  "manage_channels",
  "manage_webhooks",
  "manage_messages",
  "moderate_members",
  "mention_everyone",
  "manage_nicknames",
  "manage_guild_expressions",
  "manage_events",
  "manage_threads",
  "view_audit_log",
  "pin_messages",
])

const flag = (name: string): bigint => 1n << BigInt(PERMISSION_BITS[name]!)

/** The `administrator` permission: whoever holds it has every other. */
export const ADMINISTRATOR = flag("administrator")

/** The `manage_roles` permission. */
export const MANAGE_ROLES = flag("manage_roles")

/** Every named permission at once: what an owner or an administrator holds. */
export const ALL_PERMISSIONS = Object.keys(PERMISSION_BITS).reduce((all, name) => all | flag(name), 0n)

const NAME_OF_BIT = new Map(Object.entries(PERMISSION_BITS).map(([name, bit]) => [bit, name]))

/** The names of the bits set in `bits`, in bit order; a set bit without a flag is `bit{n}`. */
export function permissionNames(bits: bigint): string[] {
  const names: string[] = []
  for (let bit = 0; bits >> BigInt(bit) > 0n; bit += 1) {
    if ((bits >> BigInt(bit)) & 1n) names.push(NAME_OF_BIT.get(bit) ?? `bit${bit}`)
  }
  return names
}

/** The strong permissions among `bits`, by name in bit order. */
export function strongNames(bits: bigint): string[] {
  return permissionNames(bits).filter((name) => STRONG_PERMISSIONS.has(name))
}

/** The bit set of permission names; a name Discord has no flag of is `invalid_argument`, naming every one. */
export function parsePermissionNames(names: readonly string[]): bigint {
  const unknown = names.filter((name) => !Object.hasOwn(PERMISSION_BITS, name))
  if (unknown.length > 0) {
    throw new ToolError(
      "invalid_argument",
      `Unknown permission ${unknown.map((name) => JSON.stringify(name)).join(", ")}: use Discord's lower-case names, such as manage_messages.`,
    )
  }
  return names.reduce((bits, name) => bits | flag(name), 0n)
}
