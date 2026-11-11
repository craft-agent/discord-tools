import { rowsOf } from "../discord/mirror.testing"
import { createPeopleFixture } from "../people/people.testing"
import { invoke } from "../tool"
import { discordServerRead } from "./read"

/** A signed-in label with a mirror and a fake Discord behind the one HTTP client, and a way to run `discord_server_read`. */
export async function createServerFixture() {
  const f = await createPeopleFixture()
  return {
    ...f,
    /** Runs `discord_server_read` as an entry point does: strict arguments, a result checked against its schema. */
    servers: (args: unknown) => invoke(discordServerRead, args, f.ctx),
  }
}

export type ServerFixture = Awaited<ReturnType<typeof createServerFixture>>

/** Every row of the mirror's servers, as the mirror stores them. */
export const storedServersOf = (f: ServerFixture) =>
  f.inspect((m) => rowsOf(m, "SELECT CAST(id AS TEXT) AS id, name, owner, icon, raw, updated FROM servers ORDER BY id"))
