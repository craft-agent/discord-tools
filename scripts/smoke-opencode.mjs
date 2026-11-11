import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { deepStrictEqual } from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PLUGIN_NAME } from "./package-name.mjs"

const PLUGIN = fileURLToPath(new URL("../dist/opencode.js", import.meta.url))
const SERVER = fileURLToPath(new URL("../dist/mcp.js", import.meta.url))
const ACCOUNT_READ = "discord_account_read"
const CHAT_READ = "discord_chat_read"
const SEARCH_READ = "discord_search_read"
const SYNC_READ = "discord_sync_read"
const INBOX_READ = "discord_inbox_read"
const PEOPLE_READ = "discord_people_read"
const SERVER_READ = "discord_server_read"
const HISTORY_READ = "discord_history_read"
const WRITE_TOOLS = [
  "discord_sync_add",
  "discord_sync_remove",
  "discord_message_send",
  "discord_file_send",
  "discord_saved_add",
  "discord_saved_remove",
  "discord_read_mark",
]
const ACTION_TOOLS = [
  "discord_message_edit",
  "discord_message_delete",
  "discord_reaction_add",
  "discord_reaction_remove",
  "discord_pin_add",
  "discord_pin_remove",
]
const FILE_SAVE = "discord_file_save"
const EXPORT_CREATE = "discord_export_create"
const NO_ACCOUNT = "not_found: No Discord account is signed in yet"
const stateDir = mkdtempSync(join(tmpdir(), "opencode-smoke-"))

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function expectRejects(call, label) {
  try {
    await call()
  } catch (error) {
    expect(
      String(error?.message).includes(NO_ACCOUNT),
      `Expected ${label} to fail with a missing account, got: ${error}`,
    )
    return
  }
  throw new Error(`Expected ${label} to fail offline.`)
}

/** The tool names the MCP server lists with matching settings; it draws on the same registry as the plugin. */
async function mcpToolNames(readOnly, allToolsets) {
  const client = new Client({ name: "smoke", version: "0.0.0" })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          SERVER,
          "--state-dir",
          stateDir,
          ...(allToolsets ? ["--toolsets", "all"] : []),
          ...(readOnly ? ["--read-only"] : []),
        ],
      }),
    )
    return (await client.listTools()).tools.map((tool) => tool.name).sort()
  } finally {
    await client.close()
  }
}

try {
  const { default: plugin } = await import(pathToFileURL(PLUGIN).href)
  expect(
    typeof plugin?.id === "string" && typeof plugin.setup === "function" && typeof plugin.server === "function",
    `Expected a default export with id, setup and server, got ${JSON.stringify(Object.keys(plugin ?? {}))}.`,
  )
  expect(plugin.id === PLUGIN_NAME, `Expected the plugin to be named ${PLUGIN_NAME}, got ${plugin.id}.`)
  console.log(`The OpenCode plugin ${plugin.id} exports setup and server.`)

  for (const [readOnly, allToolsets] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const expected = await mcpToolNames(readOnly, allToolsets)
    expect(expected.includes(ACCOUNT_READ), `Expected the MCP registry to include ${ACCOUNT_READ}.`)
    const options = {
      state_dir: stateDir,
      ...(readOnly ? { read_only: true } : {}),
      ...(allToolsets ? { toolsets: "all" } : {}),
    }
    const added = new Map()
    const skills = []
    const noPermission = async () => {
      throw new Error("Account reads must not request permission")
    }
    await plugin.setup({
      options,
      tool: { transform: async (callback) => callback({ add: (tool) => added.set(tool.name, tool) }) },
      skill: { transform: async (callback) => callback({ add: (skill) => skills.push(skill.id) }) },
      session: { get: async () => ({ location: { directory: process.cwd() } }) },
      permission: { assert: noPermission },
    })
    deepStrictEqual([...added.keys()].sort(), expected)
    expect(skills.includes("discord-account"), "Expected setup to discover the account skill.")
    expect(skills.includes("discord-chats"), "Expected setup to discover the chats skill.")
    expect(skills.includes("discord-sync"), "Expected setup to discover the sync skill.")
    expect(skills.includes("discord-search"), "Expected setup to discover the search skill.")
    expect(skills.includes("discord-inbox"), "Expected setup to discover the inbox skill.")
    // A skill comes with its toolset's tools: sends has only writes, actions and files are off by default.
    for (const [skill, on] of [
      ["discord-sends", !readOnly],
      ["discord-actions", allToolsets && !readOnly],
      ["discord-history", allToolsets],
      ["discord-files", allToolsets && !readOnly],
    ]) {
      expect(
        skills.includes(skill) === on,
        `Expected setup to ${on ? "discover" : "leave out"} ${skill} with read_only=${readOnly}.`,
      )
    }
    for (const name of [...ACTION_TOOLS, FILE_SAVE, EXPORT_CREATE]) {
      expect(
        expected.includes(name) === (allToolsets && !readOnly),
        `Expected the MCP registry to ${allToolsets && !readOnly ? "include" : "omit"} ${name} with read_only=${readOnly}.`,
      )
    }
    expect(expected.includes(CHAT_READ), `Expected the MCP registry to include ${CHAT_READ}.`)
    expect(expected.includes(SEARCH_READ), `Expected the MCP registry to include ${SEARCH_READ}.`)
    expect(expected.includes(SYNC_READ), `Expected the MCP registry to include ${SYNC_READ}.`)
    expect(expected.includes(INBOX_READ), `Expected the MCP registry to include ${INBOX_READ}.`)
    expect(expected.includes(PEOPLE_READ), `Expected the MCP registry to include ${PEOPLE_READ}.`)
    expect(expected.includes(SERVER_READ), `Expected the MCP registry to include ${SERVER_READ}.`)
    expect(
      expected.includes(HISTORY_READ) === allToolsets,
      `Expected the MCP registry to ${allToolsets ? "include" : "omit"} ${HISTORY_READ} with toolsets all.`,
    )
    for (const name of WRITE_TOOLS) {
      expect(
        expected.includes(name) === !readOnly,
        `Expected the MCP registry to ${readOnly ? "omit" : "include"} ${name} with read_only=${readOnly}.`,
      )
    }
    const signal = new AbortController().signal
    await expectRejects(
      () => added.get(CHAT_READ).execute({ method: "servers" }, { sessionID: "ses_smoke", signal }),
      `V2 ${CHAT_READ}`,
    )
    await expectRejects(
      () => added.get(SYNC_READ).execute({ method: "list" }, { sessionID: "ses_smoke", signal }),
      `V2 ${SYNC_READ}`,
    )
    const result = await added.get(ACCOUNT_READ).execute({}, { sessionID: "ses_smoke", signal })
    deepStrictEqual(result.output, { accounts: [] })
    deepStrictEqual(JSON.parse(result.content), { accounts: [] })
    console.log(`setup registers ${added.size} tools (as many as the MCP server lists) and ${skills.length} skills.`)

    const { tool } = await plugin.server({}, options)
    const served = Object.keys(tool).sort()
    deepStrictEqual(served, expected)
    const output = await tool[ACCOUNT_READ].execute(
      {},
      {
        directory: process.cwd(),
        worktree: process.cwd(),
        abort: signal,
        ask: noPermission,
      },
    )
    deepStrictEqual(JSON.parse(output), { accounts: [] })
    await expectRejects(
      () =>
        tool[CHAT_READ].execute(
          { method: "servers" },
          { directory: process.cwd(), worktree: process.cwd(), abort: signal, ask: noPermission },
        ),
      `V1 ${CHAT_READ}`,
    )
    await expectRejects(
      () =>
        tool[SYNC_READ].execute(
          { method: "list" },
          { directory: process.cwd(), worktree: process.cwd(), abort: signal, ask: noPermission },
        ),
      `V1 ${SYNC_READ}`,
    )
    console.log(`server returns ${served.length} tools; V1 and V2 read empty accounts with read_only=${readOnly}.`)
  }
  deepStrictEqual(readdirSync(stateDir), [])
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(stateDir, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
