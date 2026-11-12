import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { errorOf } from "../discord/mirror.testing"
import {
  ADMINISTRATOR,
  ALL_PERMISSIONS,
  MANAGE_ROLES,
  PERMISSION_BITS,
  parsePermissionNames,
  permissionNames,
  STRONG_PERMISSIONS,
  strongNames,
} from "./permissions"

describe("the permission table", () => {
  test("names bits 0 to 52 except 47, each once, in lower case", () => {
    const bits = Object.values(PERMISSION_BITS).sort((a, b) => a - b)
    expect(bits).toEqual(Array.from({ length: 53 }, (_, bit) => bit).filter((bit) => bit !== 47))
    for (const name of Object.keys(PERMISSION_BITS)) expect(name).toMatch(/^[a-z_]+$/)
  })

  test("agrees with Discord on the flags that moved late", () => {
    expect(PERMISSION_BITS).toMatchObject({
      create_instant_invite: 0,
      administrator: 3,
      manage_roles: 28,
      moderate_members: 40,
      set_voice_channel_status: 48,
      send_polls: 49,
      use_external_apps: 50,
      pin_messages: 51,
      bypass_slowmode: 52,
    })
  })

  test("has the administrator and manage_roles masks, and every named bit at once", () => {
    expect(ADMINISTRATOR).toBe(8n)
    expect(MANAGE_ROLES).toBe(1n << 28n)
    expect(permissionNames(ALL_PERMISSIONS)).toHaveLength(Object.keys(PERMISSION_BITS).length)
    expect(ALL_PERMISSIONS & (1n << 47n)).toBe(0n)
  })
})

describe("the strong permissions", () => {
  test("are exactly the sixteen the conventions list, all in the table", () => {
    expect([...STRONG_PERMISSIONS].sort()).toEqual(
      [
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
      ].sort(),
    )
    for (const name of STRONG_PERMISSIONS) expect(PERMISSION_BITS).toHaveProperty(name)
  })

  test("are picked out of a bit set in bit order", () => {
    const bits = (1n << 51n) | (1n << 13n) | (1n << 11n) | 8n
    expect(strongNames(bits)).toEqual(["administrator", "manage_messages", "pin_messages"])
    expect(strongNames(1n << 11n)).toEqual([])
  })
})

describe("permissionNames", () => {
  test("lists names in bit order, none for no bits", () => {
    expect(permissionNames(0n)).toEqual([])
    expect(permissionNames((1n << 52n) | 1n | (1n << 10n))).toEqual([
      "create_instant_invite",
      "view_channel",
      "bypass_slowmode",
    ])
  })

  test("tells a bit with no flag as bit{n}, up to bit 63", () => {
    expect(permissionNames((1n << 63n) | (1n << 47n) | (1n << 3n))).toEqual(["administrator", "bit47", "bit63"])
  })
})

describe("parsePermissionNames", () => {
  test("joins the bits of the names, a repeated name once", () => {
    expect(parsePermissionNames(["manage_roles", "administrator", "manage_roles"])).toBe((1n << 28n) | 8n)
    expect(parsePermissionNames([])).toBe(0n)
  })

  test("refuses unknown names as invalid_argument, naming each", () => {
    const error = errorOf(() => parsePermissionNames(["manage_roles", "Manage_Roles", "bit47", "toString"]))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect(error.message).toContain('"Manage_Roles", "bit47", "toString"')
  })
})
