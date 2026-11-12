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

  test("inbox read is a read tool selected by default and in read-only mode", () => {
    const id = "discord_inbox_read"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "inbox", class: "read" })
    for (const settings of [{}, { read_only: true }]) {
      expect(selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    }
  })

  test.each(["discord_people_read", "discord_server_read"])(
    "%s is a read tool in the people toolset, selected by default and in read-only mode",
    (id) => {
      expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "people", class: "read" })
      for (const settings of [{}, { read_only: true }]) {
        expect(selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
      }
    },
  )

  test("history read is a read tool in the off-by-default history toolset, kept in read-only mode", () => {
    const id = "discord_history_read"
    const ids = (settings: Parameters<typeof selectTools>[1]) =>
      selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "history", class: "read" })
    expect(ids({})).not.toContain(id)
    expect(ids({ read_only: true })).not.toContain(id)
    expect(ids({ toolsets: ["history"] })).toContain(id)
    expect(ids({ toolsets: ["history"], read_only: true })).toContain(id)
  })

  test("export create is an add tool in the off-by-default history toolset, left out in read-only mode", () => {
    const id = "discord_export_create"
    const ids = (settings: Parameters<typeof selectTools>[1]) =>
      selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "history", class: "add" })
    expect(ids({})).not.toContain(id)
    expect(ids({ toolsets: ["history"] })).toContain(id)
    expect(ids({ toolsets: ["history"], read_only: true })).not.toContain(id)
  })

  test.each(["discord_saved_add", "discord_saved_remove", "discord_read_mark"])(
    "%s is an overwrite tool in the inbox toolset, on by default and left out in read-only mode",
    (id) => {
      const ids = (settings: Parameters<typeof selectTools>[1]) =>
        selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
      expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "inbox", class: "overwrite" })
      expect(ids({})).toContain(id)
      expect(ids({ read_only: true })).not.toContain(id)
    },
  )

  test("message send is an add tool in the sends toolset, on by default and left out in read-only mode", () => {
    const id = "discord_message_send"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "sends", class: "add" })
    expect(selectTools(ALL_TOOLS, {}, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    expect(selectTools(ALL_TOOLS, { read_only: true }, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).not.toContain(
      id,
    )
  })

  test("file send is an add tool in the sends toolset, on by default and left out in read-only mode", () => {
    const id = "discord_file_send"
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "sends", class: "add" })
    expect(selectTools(ALL_TOOLS, {}, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).toContain(id)
    expect(selectTools(ALL_TOOLS, { read_only: true }, PROJECT_PROFILE.toolsets).map((spec) => spec.id)).not.toContain(
      id,
    )
  })

  test.each([
    ["discord_message_edit", "overwrite"],
    ["discord_message_delete", "administrative"],
    ["discord_reaction_add", "idempotent"],
    ["discord_reaction_remove", "overwrite"],
    ["discord_pin_add", "idempotent"],
    ["discord_pin_remove", "overwrite"],
  ])("%s is a %s tool in the off-by-default actions toolset, left out in read-only mode", (id, writeClass) => {
    const ids = (settings: Parameters<typeof selectTools>[1]) =>
      selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "actions", class: writeClass })
    expect(ids({})).not.toContain(id)
    expect(ids({ toolsets: ["actions"] })).toContain(id)
    expect(ids({ toolsets: ["actions"], read_only: true })).not.toContain(id)
  })

  test("file save is an add tool in the off-by-default files toolset, left out in read-only mode", () => {
    const id = "discord_file_save"
    const ids = (settings: Parameters<typeof selectTools>[1]) =>
      selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "files", class: "add" })
    expect(ids({})).not.toContain(id)
    expect(ids({ toolsets: ["files"] })).toContain(id)
    expect(ids({ toolsets: ["files"], read_only: true })).not.toContain(id)
  })

  test.each(["discord_thread_create", "discord_post_create", "discord_file_post"])(
    "%s is an add tool in the off-by-default threads toolset, left out in read-only mode",
    (id) => {
      const ids = (settings: Parameters<typeof selectTools>[1]) =>
        selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
      expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "threads", class: "add" })
      expect(ids({})).not.toContain(id)
      expect(ids({ toolsets: ["threads"] })).toContain(id)
      expect(ids({ toolsets: "all" })).toContain(id)
      expect(ids({ toolsets: ["threads"], read_only: true })).not.toContain(id)
    },
  )

  test.each([
    ["discord_thread_join", "idempotent"],
    ["discord_thread_leave", "overwrite"],
  ])("%s is a %s tool in the off-by-default threads toolset, left out in read-only mode", (id, writeClass) => {
    const ids = (settings: Parameters<typeof selectTools>[1]) =>
      selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "threads", class: writeClass })
    expect(ids({})).not.toContain(id)
    expect(ids({ toolsets: ["threads"] })).toContain(id)
    expect(ids({ toolsets: ["threads"], read_only: true })).not.toContain(id)
  })

  test("role read is a read tool in the off-by-default roles toolset, kept in read-only mode", () => {
    const id = "discord_role_read"
    const ids = (settings: Parameters<typeof selectTools>[1]) =>
      selectTools(ALL_TOOLS, settings, PROJECT_PROFILE.toolsets).map((spec) => spec.id)
    expect(ALL_TOOLS.find((spec) => spec.id === id)).toMatchObject({ toolset: "roles", class: "read" })
    expect(ids({})).not.toContain(id)
    expect(ids({ read_only: true })).not.toContain(id)
    expect(ids({ toolsets: ["roles"] })).toContain(id)
    expect(ids({ toolsets: "all" })).toContain(id)
    expect(ids({ toolsets: ["roles"], read_only: true })).toContain(id)
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
