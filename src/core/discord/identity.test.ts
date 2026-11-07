import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { getEmulationHeaders } from "wreq-js"
import { isToolError } from "../errors"
import {
  BROWSER_PROFILE,
  BROWSER_VERSION,
  LAUNCH_SIGNATURE_BITS,
  type ClientOs,
  acceptLanguage,
  clientHints,
  clientOs,
  discordLocale,
  launchSignature,
  locale,
  superProperties,
  timeZone,
  userAgent,
} from "./identity"

const OSES: ClientOs[] = ["macos", "linux"]

describe("clientOs", () => {
  test("maps the supported platforms", () => {
    expect(clientOs("darwin")).toBe("macos")
    expect(clientOs("linux")).toBe("linux")
  })

  test("refuses any other platform, naming it", () => {
    let error: unknown
    try {
      clientOs("win32")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect((error as Error).message).toContain("win32")
    expect((error as Error).message).toContain("macOS and Linux")
  })
})

describe("the claimed browser", () => {
  test("the user agent equals the wreq profile's, for both systems", () => {
    for (const os of OSES) {
      expect(userAgent(os)).toBe(getEmulationHeaders(BROWSER_PROFILE, os).get("user-agent")!)
      expect(userAgent(os)).toContain(`Chrome/${BROWSER_VERSION}`)
    }
  })

  test("the client hints are the profile's", () => {
    for (const os of OSES) {
      const headers = getEmulationHeaders(BROWSER_PROFILE, os)
      expect(clientHints(os)).toEqual({
        ua: headers.get("sec-ch-ua")!,
        mobile: headers.get("sec-ch-ua-mobile")!,
        platform: headers.get("sec-ch-ua-platform")!,
      })
    }
    expect(clientHints("macos").platform).toBe('"macOS"')
    expect(clientHints("linux").platform).toBe('"Linux"')
  })
})

describe("locale", () => {
  test("maps system locales to Discord's", () => {
    expect(discordLocale("ja-JP")).toBe("ja")
    expect(discordLocale("zh-TW")).toBe("zh-TW")
    expect(discordLocale("zh-CN")).toBe("zh-CN")
    expect(discordLocale("en-GB")).toBe("en-GB")
    expect(discordLocale("es-MX")).toBe("es-ES")
    expect(discordLocale("pt-PT")).toBe("pt-BR")
    expect(discordLocale("en-US")).toBe("en-US")
    expect(discordLocale("sv-SE")).toBe("en-US")
    expect(discordLocale("constructor")).toBe("en-US")
  })

  test("builds accept-language from the tag", () => {
    expect(acceptLanguage("ja")).toBe("ja,ja;q=0.9,en-US;q=0.8,en;q=0.7")
    expect(acceptLanguage("pt-BR")).toBe("pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7")
    expect(acceptLanguage("en-US")).toBe("en-US,en;q=0.9")
    expect(acceptLanguage("en-GB")).toBe("en-US,en;q=0.9")
  })

  test("reads the locale and time zone from Intl", () => {
    expect(locale()).toBe(Intl.DateTimeFormat().resolvedOptions().locale)
    expect(timeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})

describe("launchSignature", () => {
  test("is a UUID with the fixed bits cleared", () => {
    expect(LAUNCH_SIGNATURE_BITS.toString(2).length).toBeLessThanOrEqual(128)
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const signature = launchSignature()
      expect(signature).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(BigInt(`0x${signature.replaceAll("-", "")}`) & LAUNCH_SIGNATURE_BITS).toBe(0n)
      seen.add(signature)
    }
    expect(seen.size).toBe(50)
  })

  test("keeps the UUID version", () => {
    expect(launchSignature()[14]).toBe("4")
  })
})

describe("superProperties", () => {
  const launch = { id: "launch-id", heartbeat: "heartbeat-id", signature: "signature-id", started: 1 }

  function decode(os: ClientOs): Record<string, unknown> {
    const encoded = superProperties({ os, buildNumber: 123456, launch, systemLocale: "ja-JP" })
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>
  }

  test("has exactly the web client's keys in order", () => {
    expect(Object.keys(decode("macos"))).toEqual([
      "os",
      "browser",
      "device",
      "system_locale",
      "has_client_mods",
      "browser_user_agent",
      "browser_version",
      "os_version",
      "referrer",
      "referring_domain",
      "referrer_current",
      "referring_domain_current",
      "release_channel",
      "client_build_number",
      "client_event_source",
      "client_launch_id",
      "launch_signature",
      "client_heartbeat_session_id",
      "client_app_state",
    ])
  })

  test("describes macOS", () => {
    expect(decode("macos")).toMatchObject({
      os: "Mac OS X",
      os_version: "10.15.7",
      browser: "Chrome",
      browser_user_agent: userAgent("macos"),
      browser_version: BROWSER_VERSION,
      system_locale: "ja-JP",
      client_build_number: 123456,
      client_event_source: null,
      client_launch_id: "launch-id",
      launch_signature: "signature-id",
      client_heartbeat_session_id: "heartbeat-id",
      client_app_state: "focused",
      has_client_mods: false,
    })
  })

  test("describes Linux", () => {
    expect(decode("linux")).toMatchObject({ os: "Linux", os_version: "", browser_user_agent: userAgent("linux") })
  })

  test("is compact JSON", () => {
    const encoded = superProperties({ os: "linux", buildNumber: 1, launch, systemLocale: "en-US" })
    expect(Buffer.from(encoded, "base64").toString("utf8")).not.toContain(": ")
  })
})
