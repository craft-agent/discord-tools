import { expect, test } from "bun:test"
import { messagePermalink } from "./permalink"

test("a message of a server chat links to the server, a private one to @me", () => {
  expect(messagePermalink("1", "2", "3")).toBe("https://discord.com/channels/1/2/3")
  expect(messagePermalink(null, "2", "3")).toBe("https://discord.com/channels/@me/2/3")
})
