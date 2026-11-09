import { describe, expect, test } from "bun:test"
import { selectTools } from "./core"
import { PROJECT_PROFILE } from "./entry/profile"
import { PROJECT } from "./project"
import { ALL_TOOLS } from "./tools"

describe("the registry", () => {
  test("account read is a read tool selected by default and in read-only mode", () => {
    const id = "discord_account_read"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "account", class: "read" })
    for (const settings of [{}, { read_only: true }]) {
      expect(selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    }
  })

  test("sync read is a read tool selected by default and in read-only mode", () => {
    const id = "discord_sync_read"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "sync", class: "read" })
    for (const settings of [{}, { read_only: true }]) {
      expect(selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    }
  })

  test.each([
    ["discord_sync_add", "idempotent"],
    ["discord_sync_remove", "overwrite"],
  ])("%s is a %s write tool in the sync toolset, left out in read-only mode", (id, writeClass) => {
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "sync", class: writeClass })
    expect(selectTools(ALL_TOOLS, {}, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    expect(selectTools(ALL_TOOLS, { read_only: true }, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).not.toContain(
      id,
    )
  })

  test("chat read is a read tool selected by default and in read-only mode", () => {
    const id = "discord_chat_read"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "chats", class: "read" })
    for (const settings of [{}, { read_only: true }]) {
      expect(selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    }
  })

  test("search read is a read tool selected by default and in read-only mode", () => {
    const id = "discord_search_read"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "search", class: "read" })
    for (const settings of [{}, { read_only: true }]) {
      expect(selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    }
  })

  test("message send is an add tool in the sends toolset, on by default and left out in read-only mode", () => {
    const id = "discord_message_send"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "sends", class: "add" })
    expect(selectTools(ALL_TOOLS, {}, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    expect(selectTools(ALL_TOOLS, { read_only: true }, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).not.toContain(
      id,
    )
  })

  test("every tool id is unique", () => {
    const ids = ALL_TOOLS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every tool id starts with the package's tool prefix", () => {
    const stray = ALL_TOOLS.filter((spec) => !spec.id.startsWith(`${PROJECT.toolPrefix}_`)).map((spec) => spec.id)
    expect(stray).toEqual([])
  })

  test("every tool belongs to a toolset the package defines", () => {
    const stray = ALL_TOOLS.filter((spec) => !PROJECT.toolsets.includes(spec.toolset)).map((spec) => spec.id)
    expect(stray).toEqual([])
  })
})

describe("the package's toolsets", () => {
  test("none is listed twice", () => {
    expect(new Set(PROJECT.toolsets).size).toBe(PROJECT.toolsets.length)
  })

  test("the default toolsets are among them", () => {
    const stray = PROJECT.defaultToolsets.filter((name) => !PROJECT.toolsets.includes(name))
    expect(stray).toEqual([])
  })
})
