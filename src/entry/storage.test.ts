import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { ToolOptions } from "../core"
import { profile } from "./settings.testing"
import { storageContext, storageSettings } from "./storage"

const settings = (options: ToolOptions = {}, env: Record<string, string | undefined> = {}) =>
  storageSettings(options, env, profile)

describe("storageSettings", () => {
  test("keeps the values it is given", () => {
    expect(
      settings({
        state_dir: "/custom/state",
        download_dir: "/custom/get",
        download_max_mb: 250,
        send_dirs: ["/custom/send1", "/custom/send2"],
        send_max_mb: 25,
      }),
    ).toEqual({
      state_dir: "/custom/state",
      download_dir: "/custom/get",
      download_max_mb: 250,
      send_dirs: ["/custom/send1", "/custom/send2"],
      send_max_mb: 25,
    })
  })

  test("ignores options of another type than the setting's", () => {
    expect(
      settings({ state_dir: 1, download_dir: true, download_max_mb: "5", send_dirs: "/one", send_max_mb: ["6"] }),
    ).toEqual(settings())
  })

  describe("state_dir", () => {
    test("defaults to $XDG_STATE_HOME/<profile.name> when XDG_STATE_HOME is absolute", () => {
      expect(settings({}, { XDG_STATE_HOME: "/xdg/state", HOME: "/home/user" }).state_dir).toBe(
        resolve("/xdg/state", "demo-tools"),
      )
    })

    test("ignores a relative XDG_STATE_HOME and uses <home>/.local/state/<profile.name>", () => {
      expect(settings({}, { XDG_STATE_HOME: "relative/xdg", HOME: "/home/user" }).state_dir).toBe(
        resolve("/home/user", ".local", "state", "demo-tools"),
      )
      expect(settings({}, { HOME: "/home/user" }).state_dir).toBe(
        resolve("/home/user", ".local", "state", "demo-tools"),
      )
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), ".local", "state", "demo-tools")
      expect(settings().state_dir).toBe(expected)
      expect(settings({}, { HOME: "relative/home" }).state_dir).toBe(expected)
    })
  })

  describe("download_dir", () => {
    test("defaults to <home>/Downloads/<profile.name>", () => {
      expect(settings({}, { HOME: "/home/user" }).download_dir).toBe(resolve("/home/user", "Downloads", "demo-tools"))
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), "Downloads", "demo-tools")
      expect(settings().download_dir).toBe(expected)
      expect(settings({}, { HOME: "relative/home" }).download_dir).toBe(expected)
    })
  })

  test("limits default to 100 MB to receive and 10 MB to send", () => {
    expect(settings()).toMatchObject({ download_max_mb: 100, send_max_mb: 10 })
  })

  test("send_dirs stays absent when unset or empty, so tools use the working directory", () => {
    expect(settings()).not.toHaveProperty("send_dirs")
    expect(settings({ send_dirs: [] })).not.toHaveProperty("send_dirs")
  })
})

describe("storageContext", () => {
  test("hands the settings to a tool as the context fields they become", () => {
    expect(
      storageContext({
        state_dir: "/s",
        download_dir: "/d",
        download_max_mb: 5,
        send_dirs: ["/a"],
        send_max_mb: 6,
      }),
    ).toEqual({ stateDir: "/s", downloadDir: "/d", downloadMaxMb: 5, sendDirs: ["/a"], sendMaxMb: 6 })
  })

  test("leaves sendDirs out when there are none", () => {
    expect(storageContext({ state_dir: "/s", download_dir: "/d", download_max_mb: 5, send_max_mb: 6 })).toEqual({
      stateDir: "/s",
      downloadDir: "/d",
      downloadMaxMb: 5,
      sendMaxMb: 6,
    })
  })
})
