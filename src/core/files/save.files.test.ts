import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, SERVER } from "../discord/objects.testing"
import {
  FILES_MESSAGE,
  MESSAGES_PATH,
  STICKER,
  attachment,
  attachmentUrl,
  createFilesFixture,
  namesIn,
  saveArgs,
  type FilesFixture,
} from "./files.testing"

const PROXY = "https://images-ext-1.discordapp.net/external/AbC/https/example.com/pics/cat.png"
const STICKER_URL = `https://cdn.discordapp.com/stickers/${STICKER}.png`

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
})

afterEach(() => f.dispose())

const mode = async (path: string) => (await stat(path)).mode & 0o777

describe("saving an attachment", () => {
  beforeEach(() => {
    f.carry({ attachments: [attachment("cat.png", { size: 4 })] })
    f.host(attachmentUrl("cat.png"), ["me", "ow"], { "content-type": "Image/PNG; charset=binary" })
  })

  test("saves it under the message's folder with its bytes, type and size", async () => {
    const result = await f.save(saveArgs())
    expect(result).toEqual({
      channel: CHANNEL,
      id: FILES_MESSAGE,
      folder: f.folder,
      files: [
        {
          name: "cat.png",
          kind: "attachment",
          status: "saved",
          path: join(f.folder, "cat.png"),
          type: "image/png",
          size: 4,
        },
      ],
      note: expect.stringContaining("other people"),
    })
    expect(await readFile(join(f.folder, "cat.png"), "utf8")).toBe("meow")
  })

  test("writes a file without an execute bit in a folder others can enter, and leaves nothing beside it", async () => {
    await f.save(saveArgs())
    expect(await mode(join(f.folder, "cat.png"))).toBe(0o644)
    expect(await mode(f.folder)).toBe(0o755)
    expect(await mode(f.downloadDir)).toBe(0o755)
    expect(await namesIn(f.folder)).toEqual(["cat.png"])
    expect(await f.staged()).toEqual([])
  })

  test("reads the message once, with the chat's page as referer, and asks the media host once without the token", async () => {
    await f.save(saveArgs())
    const reads = f.discord.api.filter((request) => request.path === MESSAGES_PATH)
    expect(f.discord.api).toHaveLength(1)
    expect(reads[0]!.query.get("around")).toBe(FILES_MESSAGE)
    expect(reads[0]!.query.get("limit")).toBe("5")
    expect(headerOf(reads[0]!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
    expect(f.media.requests.map((request) => request.url)).toEqual([attachmentUrl("cat.png")])
    expect(f.media.requests[0]!.headers.map(([name]) => name)).not.toContain("authorization")
  })

  test("gives a download 180 seconds", async () => {
    await f.save(saveArgs())
    expect(f.media.requests[0]!.timeoutMs).toBe(180_000)
  })

  test("falls back to the declared type when the host names none", async () => {
    f.host(attachmentUrl("cat.png"), ["meow"])
    const result = await f.save(saveArgs())
    expect(result.files[0]).toMatchObject({ status: "saved", type: "image/png", size: 4 })
  })
})

describe("saving previews and stickers", () => {
  beforeEach(() => {
    f.carry({
      attachments: [attachment("a.png")],
      embeds: [{ url: "https://example.com/page", image: { url: "https://example.com/i.png", proxy_url: PROXY } }],
      sticker_items: [{ id: STICKER, name: "wave", format_type: 1 }],
    })
    f.host(attachmentUrl("a.png"), ["aaaa"], { "content-type": "image/png" })
    f.host(PROXY, ["preview"], { "content-type": "image/webp" })
    f.host(STICKER_URL, ["sticker"], { "content-type": "image/png" })
  })

  test("saves them after the attachments, in order, each with its kind", async () => {
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => [file.name, file.kind, file.status])).toEqual([
      ["a.png", "attachment", "saved"],
      ["preview-cat.png", "preview", "saved"],
      ["wave.png", "sticker", "saved"],
    ])
    expect(await namesIn(f.folder)).toEqual(["a.png", "preview-cat.png", "wave.png"])
    expect(f.media.requests.map((request) => request.url)).toEqual([attachmentUrl("a.png"), PROXY, STICKER_URL])
  })

  test("says which link a preview is of, and never fetches the site behind it", async () => {
    const result = await f.save(saveArgs())
    expect(result.files[1]).toMatchObject({ preview_of: "https://example.com/page", type: "image/webp", size: 7 })
    expect(f.media.requests.map((request) => request.url)).not.toContain("https://example.com/page")
    expect(f.media.requests.map((request) => request.url)).not.toContain("https://example.com/i.png")
  })

  test("asks for a lottie sticker as .json and a GIF sticker from the media proxy", async () => {
    const lottie = "1400000000000000801"
    const gif = "1400000000000000802"
    f.carry({
      sticker_items: [
        { id: lottie, name: "anim", format_type: 3 },
        { id: gif, name: "move", format_type: 4 },
      ],
    })
    f.host(`https://cdn.discordapp.com/stickers/${lottie}.json`, ["{}"], { "content-type": "application/json" })
    f.host(`https://media.discordapp.net/stickers/${gif}.gif`, ["GIF89a"], { "content-type": "image/gif" })
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => [file.name, file.status])).toEqual([
      ["anim.json", "saved"],
      ["move.gif", "saved"],
    ])
  })

  test("saves a link that is attachment and preview at once only once", async () => {
    f.carry({ attachments: [attachment("a.png")], embeds: [{ image: { proxy_url: attachmentUrl("a.png") } }] })
    f.host(attachmentUrl("a.png"), ["aaaa"], { "content-type": "image/png" })
    const result = await f.save(saveArgs())
    expect(result.files).toHaveLength(1)
    expect(f.media.requests).toHaveLength(1)
  })
})
