import { describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { CHANNEL, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { discordSyncAdd } from "./add"
import { createSyncFixture } from "./read.testing"
import { discordSyncRemove } from "./remove"
import { seedGuilds, THIRD_CHANNEL } from "./write.testing"

const UNKNOWN_SERVER = "1400000000000000999"
const UNKNOWN_CHANNEL = "1400000000000000998"

async function seeded() {
  const f = await createSyncFixture()
  seedGuilds(f)
  return f
}

describe("discord_sync_add description", () => {
  test.each([
    [
      "a whole server",
      { server: SERVER },
      "About to follow {server}",
      [{ label: "Follows", value: { text: "Whole server" } }],
    ],
    [
      "named channels, an unknown one by its id",
      { server: SERVER, channels: [CHANNEL, UNKNOWN_CHANNEL, THIRD_CHANNEL] },
      "About to follow channels of {server}",
      [
        { label: "Follows", value: { text: "Named channels" } },
        { label: "Channels", value: `#general, ${UNKNOWN_CHANNEL}, #memes` },
      ],
    ],
    [
      "a whole server with exclusions",
      { server: SERVER, exclude: [OTHER_CHANNEL] },
      "About to follow {server}",
      [
        { label: "Follows", value: { text: "Whole server" } },
        { label: "Excluded", value: "#random" },
      ],
    ],
  ])("describes %s", async (_name, args, text, facts) => {
    const f = await seeded()
    expect(await callDescription(discordSyncAdd, args, f.ctx)).toEqual({
      headline: { text, values: { server: "Alpha" } },
      facts,
    })
  })

  test("gives no description when the label has no mirror yet", async () => {
    const f = await createSyncFixture()
    expect(await callDescription(discordSyncAdd, { server: SERVER }, f.ctx)).toBeUndefined()
  })

  test("is the same on every call and sends no request", async () => {
    const f = await seeded()
    const args = { server: SERVER, channels: [CHANNEL] }
    const first = await callDescription(discordSyncAdd, args, f.ctx)
    expect(await callDescription(discordSyncAdd, args, f.ctx)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })
})

describe("discord_sync_remove description", () => {
  test.each([
    ["a whole server", { server: SERVER }, "About to stop following {server}", []],
    [
      "channels",
      { server: SERVER, channels: [OTHER_CHANNEL, UNKNOWN_CHANNEL] },
      "About to stop following channels of {server}",
      [{ label: "Channels", value: `#random, ${UNKNOWN_CHANNEL}` }],
    ],
  ])("describes %s", async (_name, args, text, facts) => {
    const f = await seeded()
    expect(await callDescription(discordSyncRemove, args, f.ctx)).toEqual({
      headline: { text, values: { server: "Alpha" } },
      facts,
    })
  })

  test("names a server the mirror lacks by its id", async () => {
    const f = await seeded()
    const description = await callDescription(discordSyncRemove, { server: UNKNOWN_SERVER }, f.ctx)
    expect(description?.headline?.values).toEqual({ server: UNKNOWN_SERVER })
  })

  test("gives no description when the label has no mirror yet", async () => {
    const f = await createSyncFixture()
    expect(await callDescription(discordSyncRemove, { server: SERVER }, f.ctx)).toBeUndefined()
  })
})
