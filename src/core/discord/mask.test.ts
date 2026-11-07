import { describe, expect, test } from "bun:test"
import { maskTokens } from "./mask"
import { fakeMfaToken, fakeToken } from "./fake-token.testing"

const SHAPED = fakeToken()

describe("maskTokens", () => {
  test("masks the exact token, whatever its shape", () => {
    const token = "plain-token-with-no-dots"
    expect(maskTokens(`bad ${token} and ${token}`, token)).toBe("bad <token> and <token>")
  })

  test("masks token-shaped text without being told the token", () => {
    expect(maskTokens(`Authorization failed for ${SHAPED}.`)).toBe("Authorization failed for <token>.")
  })

  test("masks mfa tokens", () => {
    expect(maskTokens(`got ${fakeMfaToken()} here`)).toBe("got <token> here")
  })

  test("leaves ordinary text and short dotted strings alone", () => {
    const text = "Discord 404 (code 10003): Unknown Channel; version 1.2.3 of a.b.c"
    expect(maskTokens(text)).toBe(text)
  })

  test("treats an empty token as no token", () => {
    expect(maskTokens("some text", "")).toBe("some text")
  })

  test("does not read replacement patterns in the token", () => {
    expect(maskTokens("a $& b", "$&")).toBe("a <token> b")
  })
})
