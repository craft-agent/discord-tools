import { afterEach, beforeEach, expect, test } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readSyncList, validateSyncList } from "./sync-list"
import { getMeta } from "./mirror"
import { getCursor } from "./mirror-cursors"
import { DM_LIST_AT_META, SERVER_LIST_AT_META } from "./mirror-meta"
import { rowById } from "./mirror.testing"
import { createSyncHarness, syncMessage, type SyncHarness } from "./sync-testing"

let h: SyncHarness
beforeEach(async () => {
  h = await createSyncHarness()
})
afterEach(async () => {
  await h.dispose()
})

test("absent list is DMs only; explicit lists and empty selections retain exact ids", async () => {
  expect(await readSyncList(h.paths)).toEqual({ servers: [] })
  const list = {
    servers: [
      { id: "1", channels: [], exclude: ["5"] },
      { id: "2", channels: ["6"] },
    ],
  }
  await writeFile(join(h.paths.dir, "sync.json"), JSON.stringify(list))
  expect(await readSyncList(h.paths)).toEqual(list)
})

test("limits, duplicate ids, unknown fields, malformed JSON and links are refused before network", async () => {
  for (const list of [
    null,
    [],
    {},
    { servers: "1" },
    { servers: [], extra: true },
    { servers: [{ id: "name" }] },
    { servers: [{ id: "1", name: "test" }] },
    { servers: [{ id: "1" }, { id: "1" }] },
    { servers: [{ id: "1", channels: ["2", "2"] }] },
    { servers: [{ id: "1", exclude: ["2", "2"] }] },
    {
      servers: [
        { id: "1", channels: ["9"] },
        { id: "2", channels: ["9"] },
      ],
    },
    { servers: Array.from({ length: 11 }, (_, i) => ({ id: String(i + 1), channels: [] })) },
    { servers: Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1) })) },
    { servers: [{ id: "1", channels: Array.from({ length: 31 }, (_, i) => String(i + 1)) }] },
  ]) {
    await writeFile(join(h.paths.dir, "sync.json"), JSON.stringify(list))
    await expect(h.run()).rejects.toMatchObject({ code: "invalid_argument" })
  }
  await writeFile(join(h.paths.dir, "sync.json"), "not json")
  await expect(h.run()).rejects.toMatchObject({ code: "invalid_argument" })
  expect(h.discord.requests).toHaveLength(0)
})

test("a sync list symlink is refused", async () => {
  const target = join(h.stateDir, "list.json")
  await writeFile(target, JSON.stringify({ servers: [] }))
  await symlink(target, join(h.paths.dir, "sync.json"))
  await expect(h.run()).rejects.toMatchObject({ code: "invalid_argument" })
  expect(h.discord.requests).toHaveLength(0)
})

test("whole servers count ten slots and thirty explicit channels are accepted", () => {
  expect(validateSyncList({ servers: [{ id: "1" }, { id: "2" }, { id: "3" }] }).servers).toHaveLength(3)
  expect(
    validateSyncList({ servers: [{ id: "1", channels: Array.from({ length: 30 }, (_, i) => String(i + 1)) }] })
      .servers[0]?.channels,
  ).toHaveLength(30)
})

test("only known servers are requested and explicit unknown channels stay unstamped", async () => {
  await writeFile(
    join(h.paths.dir, "sync.json"),
    JSON.stringify({ servers: [{ id: "11", channels: ["21", "22"] }, { id: "12" }] }),
  )
  h.discord.route("GET", "/users/@me/guilds", { status: 200, json: [{ id: "11", name: "test" }] })
  h.discord.route("GET", "/guilds/11/channels", {
    status: 200,
    json: [{ id: "21", guild_id: "11", type: 0, last_message_id: "100" }],
  })
  h.discord.route("GET", "/channels/21/messages", { status: 200, json: [syncMessage("100", "21")] })
  expect(await h.run()).toMatchObject({ status: "partial", channels: 1, skipped: 2 })
  expect(h.discord.api.some((request) => request.path === "/guilds/12/channels")).toBe(false)
  expect(h.inspect((m) => getCursor(m, "22"))).toBeUndefined()
  expect(h.inspect((m) => rowById(m, "channels", "21")?.server)).toBe("11")
})

test("a run stamps the DM list, and the server list only when the sync list names a server", async () => {
  const started = h.now()
  await h.run()
  const dmStamp = Number(h.inspect((m) => getMeta(m)[DM_LIST_AT_META]))
  expect(dmStamp).toBeGreaterThanOrEqual(started)
  expect(h.inspect((m) => getMeta(m)[SERVER_LIST_AT_META])).toBeUndefined()
  await writeFile(join(h.paths.dir, "sync.json"), JSON.stringify({ servers: [{ id: "11", channels: [] }] }))
  h.discord.route("GET", "/users/@me/guilds", { status: 200, json: [{ id: "11", name: "test" }] })
  h.discord.route("GET", "/guilds/11/channels", { status: 200, json: [] })
  await h.run()
  const meta = h.inspect(getMeta)
  expect(Number(meta[SERVER_LIST_AT_META])).toBeGreaterThan(dmStamp)
  expect(Number(meta[DM_LIST_AT_META])).toBeGreaterThan(dmStamp)
})

test("whole-server selection takes ten most-active supported channels after exclusions", async () => {
  await writeFile(join(h.paths.dir, "sync.json"), JSON.stringify({ servers: [{ id: "11", exclude: ["1015"] }] }))
  h.discord.route("GET", "/users/@me/guilds", { status: 200, json: [{ id: "11" }] })
  const channels = Array.from({ length: 15 }, (_, i) => ({
    id: String(1001 + i),
    type: [0, 5, 10, 11, 12][i % 5],
    last_message_id: String(2001 + i),
  }))
  h.discord.route("GET", "/guilds/11/channels", {
    status: 200,
    json: [...channels, { id: "1099", type: 2, last_message_id: "9999" }],
  })
  for (const channel of channels)
    h.discord.route("GET", `/channels/${channel.id}/messages`, {
      status: 200,
      json: [syncMessage(channel.last_message_id, channel.id)],
    })
  expect(await h.run()).toMatchObject({ status: "complete", channels: 10 })
  expect(h.discord.api.filter((request) => request.path.endsWith("/messages")).map((request) => request.path)).toEqual(
    channels
      .slice(4, 14)
      .reverse()
      .map((channel) => `/channels/${channel.id}/messages`),
  )
})

test("foreign guild membership is rejected before metadata or messages are ingested", async () => {
  await writeFile(join(h.paths.dir, "sync.json"), JSON.stringify({ servers: [{ id: "11", channels: ["21"] }] }))
  h.discord.route("GET", "/users/@me/guilds", { status: 200, json: [{ id: "11" }] })
  h.discord.route("GET", "/guilds/11/channels", {
    status: 200,
    json: [{ id: "21", guild_id: "12", type: 0, last_message_id: "100" }],
  })
  expect((await h.run()).status).toBe("partial")
  expect(h.inspect((m) => rowById(m, "channels", "21"))).toBeUndefined()
  expect(h.discord.api.some((request) => request.path.endsWith("/messages"))).toBe(false)
})
