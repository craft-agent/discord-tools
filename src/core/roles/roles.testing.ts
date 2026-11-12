import { ingestServers } from "../discord/ingest"
import { SERVER, serverObject } from "../discord/objects.testing"
import { createPeopleFixture, seedServers } from "../people/people.testing"
import { rolesPath } from "../people/role-list"
import { roleCountsPath } from "../servers/roles"
import { invoke } from "../tool"
import { ownMemberPath } from "./live"
import { discordRoleRead } from "./read"

/** Made-up role ids, all above 2^53. */
export const [ADMIN, MOD, HELPER, TIE_A, TIE_B, BOT] = [
  "1400000000000000801",
  "1400000000000000802",
  "1400000000000000803",
  "1400000000000000810",
  "1400000000000000811",
  "1400000000000000812",
]

/** The permission bit sets of the made-up roles: the admin has `administrator`, the moderator `manage_roles` and `kick_members`, the helper `manage_messages`, @everyone `send_messages`. */
export const PERMISSIONS = { admin: "8", mod: String((1n << 28n) | 2n), helper: String(1n << 13n), everyone: "2048" }

/** A role of a server's role list as Discord sends it. */
export const roleObject = (id: string, position: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `role ${id.slice(-3)}`,
  position,
  color: 0,
  hoist: false,
  mentionable: false,
  managed: false,
  permissions: "0",
  ...extra,
})

/** The role list of the made-up server: @everyone, a moderator who may manage roles, a helper, two roles tied, a bot role and an admin. */
export const SERVER_ROLES = [
  roleObject(SERVER, 0, { name: "@everyone", permissions: PERMISSIONS.everyone }),
  roleObject(MOD, 5, { name: "Moderator", color: 0x1abc9c, hoist: true, permissions: PERMISSIONS.mod }),
  roleObject(HELPER, 3, { name: "Helper", mentionable: true, permissions: PERMISSIONS.helper }),
  roleObject(TIE_B, 1),
  roleObject(TIE_A, 1),
  roleObject(BOT, 7, { name: "Bot", managed: true }),
  roleObject(ADMIN, 9, { name: "Admin", permissions: PERMISSIONS.admin }),
]

/** How many members hold each of `SERVER_ROLES`, except `TIE_B`, which Discord gives no count for. */
export const MEMBER_COUNTS = { [SERVER]: 40, [ADMIN]: 1, [MOD]: 3, [HELPER]: 6, [BOT]: 1, [TIE_A]: 0 }

/** A signed-in label with a mirror that holds the made-up server, a fake Discord behind the one HTTP client, and a way to run `discord_role_read`. */
export async function createRoleFixture({ owner = false } = {}) {
  const f = await createPeopleFixture()
  if (owner) {
    f.seed((m) => ingestServers(m, f.ingestContext(), [serverObject(SERVER, { name: "Tea house", owner: true })]))
  } else {
    seedServers(f, [SERVER, "Tea house"])
  }
  return {
    ...f,
    /** Runs `discord_role_read` as an entry point does: strict arguments, a result checked against its schema. */
    roles: (args: unknown) => invoke(discordRoleRead, args, f.ctx),
  }
}

export type RoleFixture = Awaited<ReturnType<typeof createRoleFixture>>

/** Makes the fake answer the three requests of `list` and `role`: the roles, their counts, and the user's own membership. */
export function serveRoles(
  f: RoleFixture,
  held: string[] = [MOD],
  list: unknown = SERVER_ROLES,
  counts: unknown = MEMBER_COUNTS,
): void {
  f.discord
    .route("GET", rolesPath(SERVER), { status: 200, json: list })
    .route("GET", roleCountsPath(SERVER), { status: 200, json: counts })
    .route("GET", ownMemberPath(SERVER), { status: 200, json: { roles: held, nick: null, joined_at: null } })
}
