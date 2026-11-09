import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CHANNEL } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { FILES_MESSAGE, saveArgs } from "./files.testing"
import { discordFileSave } from "./save-tool"
import { saveTargets } from "./targets"

const CTX = { cwd: "/work", downloadDir: "/home/me/Downloads/discord-tools", downloadMaxMb: 100 }

describe("the save's targets", () => {
  test("name the message's folder under the download directory", () => {
    expect(saveTargets(saveArgs() as Parameters<typeof saveTargets>[0], CTX)).toEqual([
      join(CTX.downloadDir, `${CHANNEL}-${FILES_MESSAGE}`),
    ])
  })

  test("are what a permission rule sees", async () => {
    expect(await writeTargets(discordFileSave, saveArgs(), CTX)).toEqual([
      `/home/me/Downloads/discord-tools/${CHANNEL}-${FILES_MESSAGE}`,
    ])
  })

  test("fall back to * without a download directory, or when it holds a wildcard", async () => {
    expect(await writeTargets(discordFileSave, saveArgs(), { cwd: "/work" })).toEqual(["*"])
    expect(await writeTargets(discordFileSave, saveArgs(), { ...CTX, downloadDir: "/home/me/Down*loads" })).toEqual([
      "*",
    ])
  })

  test("fall back to * for arguments the schema refuses", async () => {
    expect(await writeTargets(discordFileSave, saveArgs({ channel: "general" }), CTX)).toEqual(["*"])
  })
})
