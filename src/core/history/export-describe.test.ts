import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { callDescription } from "../describe"
import { ingestChannels } from "../discord/ingest"
import { channelObject, CHANNEL, msgId, SERVER } from "../discord/objects.testing"
import { THREAD } from "../search/search.testing"
import { writeTargets } from "../targets"
import { describeExport } from "./export-describe"
import { discordExportCreate } from "./export-tool"
import { createExportFixture, type ExportFixture } from "./export-tool.testing"

let f: ExportFixture
beforeEach(async () => {
  f = await createExportFixture()
})
afterEach(async () => {
  await f.dispose()
})

const describeArgs = (extra: Record<string, unknown> = {}) =>
  callDescription(discordExportCreate, { chat: CHANNEL, ...extra }, f.ctx)

const FACTS_OF_CHAT = [
  { label: "Chat", value: { text: "Text channel" } },
  { label: "Server", value: "Test server" },
]

describe("discord_export_create description", () => {
  test("names the chat, the format, the messages and the folder, and has no text", async () => {
    expect(await describeArgs()).toEqual({
      headline: { text: "About to export {chat}", values: { chat: "#general" } },
      facts: [
        ...FACTS_OF_CHAT,
        { label: "Format", value: { text: "Markdown" } },
        { label: "Messages", value: { text: "The newest {count}", values: { count: 2000 } } },
        { label: "Folder", value: join(f.downloadDir, "exports") },
      ],
    })
  })

  test.each([
    ["markdown", "Markdown"],
    ["json", "JSON"],
    ["jsonl", "JSONL"],
  ])("format %s is shown as %s", async (format, shown) => {
    const description = await describeArgs({ format })
    expect(description?.facts.find((fact) => fact.label === "Format")).toEqual({
      label: "Format",
      value: { text: shown },
    })
  })

  test.each([
    [{}, { text: "The newest {count}", values: { count: 2000 } }],
    [{ limit: 50 }, { text: "The newest {count}", values: { count: 50 } }],
    [
      { limit: 50, before: "2026-01-02" },
      { text: "The newest {count}, before {before}", values: { count: 50, before: "2026-01-02" } },
    ],
    [{ after: msgId(3) }, { text: "The first {count} after {after}", values: { count: 2000, after: msgId(3) } }],
    [
      { after: "2026-01-01T00:00:00Z", before: msgId(9), limit: 7 },
      {
        text: "The first {count} after {after}, before {before}",
        values: { count: 7, after: "2026-01-01T00:00:00Z", before: msgId(9) },
      },
    ],
  ])("the messages of %j are %j", async (extra, value) => {
    const description = await describeArgs(extra)
    expect(description?.facts.find((fact) => fact.label === "Messages")).toEqual({ label: "Messages", value })
  })

  test("a thread also names the channel it belongs to", async () => {
    const description = await describeArgs({ chat: THREAD })
    expect(description?.headline).toEqual({ text: "About to export {chat}", values: { chat: "a thread" } })
    expect(description?.facts.map((fact) => fact.label)).toEqual([
      "Chat",
      "Server",
      "Channel",
      "Format",
      "Messages",
      "Folder",
    ])
  })

  test("is the same twice, sends no request, and changes when the chat is renamed", async () => {
    const first = await describeArgs()
    expect(await describeArgs()).toEqual(first)
    expect(f.discord.api).toEqual([])
    f.seed((m) => ingestChannels(m, f.ingestContext(), [channelObject(CHANNEL, { name: "lobby" })], SERVER))
    expect((await describeArgs())?.headline).toEqual({ text: "About to export {chat}", values: { chat: "#lobby" } })
  })

  test("is not_found for a chat the mirror lacks, and no description is given", async () => {
    const args = { chat: "1400000000000000999" }
    expect(await failure(describeExport(args, f.ctx))).toMatchObject({ code: "not_found" })
    expect(await callDescription(discordExportCreate, args, f.ctx)).toBeUndefined()
  })
})

describe("discord_export_create targets", () => {
  const CTX = { cwd: "/work", downloadDir: "/home/me/Downloads/discord-tools", downloadMaxMb: 100 }

  test("name the exports folder under the download directory", async () => {
    expect(await writeTargets(discordExportCreate, { chat: CHANNEL }, CTX)).toEqual([
      "/home/me/Downloads/discord-tools/exports",
    ])
  })

  test("fall back to * without a download directory, or when it holds a wildcard", async () => {
    expect(await writeTargets(discordExportCreate, { chat: CHANNEL }, { cwd: "/work" })).toEqual(["*"])
    expect(
      await writeTargets(discordExportCreate, { chat: CHANNEL }, { ...CTX, downloadDir: "/home/me/Down*loads" }),
    ).toEqual(["*"])
  })

  test("fall back to * for arguments the schema refuses", async () => {
    expect(await writeTargets(discordExportCreate, { chat: "general" }, CTX)).toEqual(["*"])
  })
})
