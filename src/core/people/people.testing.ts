import { createChatFixture } from "../chats/read.testing"
import { ingestServers, ingestUsers } from "../discord/ingest"
import { columnOf } from "../discord/mirror.testing"
import { serverObject, userObject } from "../discord/objects.testing"
import { invoke } from "../tool"
import { discordPeopleRead } from "./read"

/** More made-up users, beside `ALICE` and `BOB`. */
export const CAROL = "1400000000000000004"
export const DAVE = "1400000000000000005"

/** A signed-in label with a mirror and a fake Discord behind the one HTTP client, and a way to run `discord_people_read`. */
export async function createPeopleFixture() {
  const f = await createChatFixture()
  return {
    ...f,
    /** Runs `discord_people_read` as an entry point does: strict arguments, a result checked against its schema. */
    people: (args: unknown) => invoke(discordPeopleRead, args, f.ctx),
  }
}

export type PeopleFixture = Awaited<ReturnType<typeof createPeopleFixture>>

/** Stores these ids as users the mirror knows, as a chat's messages would. */
export function seedUsers(f: PeopleFixture, ...ids: string[]): void {
  f.seed((m) =>
    ingestUsers(
      m,
      f.ingestContext(),
      ids.map((id) => userObject(id)),
    ),
  )
}

/** Stores servers as a server list would: each id with its name. */
export function seedServers(f: PeopleFixture, ...servers: [id: string, name: string][]): void {
  f.seed((m) =>
    ingestServers(
      m,
      f.ingestContext(),
      servers.map(([id, name]) => serverObject(id, { name })),
    ),
  )
}

/** The requests the fake received, each as `METHOD path`. */
export const requestsOf = (f: PeopleFixture) => f.discord.api.map((request) => `${request.method} ${request.path}`)

/** The ids of the users the mirror holds, in order. */
export const storedUsersOf = (f: PeopleFixture) =>
  f.inspect((m) => columnOf(m, "SELECT CAST(id AS TEXT) FROM users ORDER BY id"))

/** An entry of `/users/@me/relationships`: `type` 1 a friend, 2 blocked, 3 a request received, 4 a request sent. */
export function relationship(user: ReturnType<typeof userObject>, type = 1, extra: Record<string, unknown> = {}) {
  return { id: user.id, type, nickname: null, user, since: "2025-03-04T05:06:07.000000+00:00", ...extra }
}
