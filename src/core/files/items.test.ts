import { describe, expect, test } from "bun:test"
import { collectItems } from "./items"

const STICKER = "1400000000000000800"
const attachmentUrl = (name: string) => `https://cdn.discordapp.com/attachments/1/2/${name}?ex=1&is=2&hm=3`
const attachment = (name: string, extra: Record<string, unknown> = {}) => ({
  filename: name,
  content_type: "image/png",
  size: 4,
  url: attachmentUrl(name),
  ...extra,
})

const PROXY = "https://images-ext-1.discordapp.net/external/AbC/https/example.com/pics/cat%20one.png"

describe("collectItems", () => {
  test("lists attachments, then preview images, then stickers", () => {
    const items = collectItems({
      sticker_items: [{ id: STICKER, name: "wave", format_type: 1 }],
      embeds: [{ url: "https://example.com/page", image: { url: "https://example.com/i.png", proxy_url: PROXY } }],
      attachments: [attachment("a.png", { content_type: "image/png", size: 12 })],
    })
    expect(items).toEqual([
      { kind: "attachment", name: "a.png", url: attachmentUrl("a.png"), type: "image/png", size: 12 },
      { kind: "preview", name: "preview-cat one.png", url: PROXY, previewOf: "https://example.com/page" },
      { kind: "sticker", name: "wave.png", url: `https://cdn.discordapp.com/stickers/${STICKER}.png` },
    ])
  })

  test("names an attachment without a file name after its place", () => {
    const items = collectItems({ attachments: [attachment("a.png"), { url: attachmentUrl("b"), size: 1 }] })
    expect(items.map((item) => item.name)).toEqual(["a.png", "file-2"])
  })

  test("leaves out what has no link, a bad size and a type that is not text", () => {
    const [item, ...rest] = collectItems({
      attachments: [{ filename: "x" }, null, { url: attachmentUrl("a"), filename: "a", size: -1, content_type: 5 }],
    })
    expect(rest).toEqual([])
    expect(item).toEqual({ kind: "attachment", name: "a", url: attachmentUrl("a") })
  })

  test("takes only the proxy link of an embed's image, thumbnail and video, never its url", () => {
    const items = collectItems({
      embeds: [
        {
          image: { url: "https://example.com/i.png" },
          thumbnail: { proxy_url: `${PROXY}?t=1` },
          video: { url: "https://example.com/v.mp4", proxy_url: "https://images-ext-2.discordapp.net/x/v.mp4" },
        },
      ],
    })
    expect(items.map((item) => [item.name, item.url])).toEqual([
      ["preview-cat one.png", `${PROXY}?t=1`],
      ["preview-v.mp4", "https://images-ext-2.discordapp.net/x/v.mp4"],
    ])
    expect(items.every((item) => item.previewOf === undefined)).toBe(true)
  })

  test("names a preview after its part when the link's path has no name", () => {
    const items = collectItems({
      embeds: [{ image: { proxy_url: "https://images-ext-1.discordapp.net/dir/" }, video: { proxy_url: "not a url" } }],
    })
    expect(items.map((item) => item.name)).toEqual(["preview-image", "preview-video"])
  })

  test("keeps an undecodable segment as it is", () => {
    const [item] = collectItems({
      embeds: [{ image: { proxy_url: "https://images-ext-1.discordapp.net/a/%E0%A4%A" } }],
    })
    expect(item?.name).toBe("preview-%E0%A4%A")
  })

  test.each([
    [1, "png", "cdn.discordapp.com"],
    [2, "png", "cdn.discordapp.com"],
    [3, "json", "cdn.discordapp.com"],
    [4, "gif", "media.discordapp.net"],
  ])("a sticker of format %i is a .%s file from %s", (format_type, extension, host) => {
    const [item] = collectItems({ sticker_items: [{ id: STICKER, name: "s", format_type }] })
    expect(item).toEqual({
      kind: "sticker",
      name: `s.${extension}`,
      url: `https://${host}/stickers/${STICKER}.${extension}`,
    })
  })

  test("names a sticker without a name by its id and skips one of another format or without an id", () => {
    const items = collectItems({
      sticker_items: [
        { id: STICKER, format_type: 1 },
        { id: STICKER, name: "x", format_type: 9 },
        { id: "not an id", name: "y", format_type: 1 },
      ],
    })
    expect(items.map((item) => item.name)).toEqual([`${STICKER}.png`])
  })

  test("lists a link once, the first time", () => {
    const items = collectItems({
      attachments: [attachment("a.png"), attachment("copy.png", { url: attachmentUrl("a.png") })],
      embeds: [
        { image: { proxy_url: attachmentUrl("a.png") } },
        { image: { proxy_url: PROXY } },
        { image: { proxy_url: PROXY } },
      ],
    })
    expect(items.map((item) => item.name)).toEqual(["a.png", "preview-cat one.png"])
  })

  test("finds nothing in a message that carries nothing", () => {
    expect(collectItems({})).toEqual([])
    expect(collectItems({ attachments: "x", embeds: [null, {}, { image: 3 }], sticker_items: {} })).toEqual([])
  })
})
