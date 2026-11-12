import { ingestRoleSnapshot } from "../discord/ingest"
import { readRoleSnapshot } from "../discord/mirror-roles"
import { ALICE, BOB, ME, SERVER } from "../discord/objects.testing"
import { CAROL, seedUsers } from "../people/people.testing"
import { invoke, type ToolContext } from "../tool"
import { discordRoleAssign, discordRoleUnassign } from "./assign-tool"
import { createRoleFixture, MOD, roleObject, SERVER_ROLES, TIE_A } from "./roles.testing"

/** More made-up role ids, all above 2^53: a role as high as the moderator, one above it, and two below it that hold `administrator` and bit 47, which has no name. */
export const [PEER, HIGH, WEAK_ADMIN, BIT47] = [
  "1400000000000000820",
  "1400000000000000821",
  "1400000000000000822",
  "1400000000000000823",
]

/** The roles of the made-up server, and four more (see `PEER`, `HIGH`, `WEAK_ADMIN` and `BIT47`). */
export const ASSIGN_ROLES = [
  ...SERVER_ROLES,
  roleObject(PEER, 5, { name: "Peer" }),
  roleObject(HIGH, 8, { name: "High" }),
  roleObject(WEAK_ADMIN, 2, { name: "Weak admin", permissions: "8" }),
  roleObject(BIT47, 2, { name: "Bit 47", permissions: String(1n << 47n) }),
]

/** An id of a user the mirror does not hold. */
export const STRANGER = "1400000000000000998"

type AssignFixtureOptions = { owner?: boolean; held?: string[]; roles?: unknown[]; stored?: boolean }

/**
 * The role fixture with a stored snapshot of `roles`, read now, in which the
 * user holds `held` (by default the moderator, who may manage roles and sits at
 * position 5), and the users `ME`, `ALICE`, `BOB` and `CAROL` known to the
 * mirror. `stored: false` leaves the snapshot out.
 */
export async function createAssignFixture({
  owner = false,
  held = [MOD],
  roles = ASSIGN_ROLES,
  stored = true,
}: AssignFixtureOptions = {}) {
  const f = await createRoleFixture({ owner })
  seedUsers(f, ME, ALICE, BOB, CAROL)
  const store = (list: unknown[] = roles, own: string[] = held) =>
    f.seed((m) => ingestRoleSnapshot(m, f.ingestContext(), SERVER, list, own))
  if (stored) store()
  const target = { server: SERVER, role: TIE_A }
  return {
    ...f,
    /** Stores the snapshot again, as a read of the roles would. */
    store,
    /** Runs `discord_role_assign` as an entry point does; the arguments default to giving `TIE_A` to `ALICE`. */
    assign: (args: object = {}, ctx: ToolContext = f.ctx) =>
      invoke(discordRoleAssign, { ...target, users: [ALICE], ...args }, ctx),
    /** Runs `discord_role_unassign` the same way. */
    unassign: (args: object = {}, ctx: ToolContext = f.ctx) =>
      invoke(discordRoleUnassign, { ...target, user: ALICE, ...args }, ctx),
    /** The requests that change something, and those that read. */
    writes: () => f.discord.api.filter((request) => request.method !== "GET"),
    reads: () => f.discord.api.filter((request) => request.method === "GET"),
    /** The stored snapshot of the made-up server. */
    snapshot: () => f.inspect((m) => readRoleSnapshot(m, SERVER)),
  }
}

export type AssignFixture = Awaited<ReturnType<typeof createAssignFixture>>
