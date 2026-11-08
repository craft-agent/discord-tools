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
const SYNC_READ = "discord_sync_read"
const WRITE_TOOLS = ["discord_sync_add", "discord_sync_remove", "discord_message_send"]
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
async function mcpToolNames(readOnly) {
  const client = new Client({ name: "smoke", version: "0.0.0" })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, "--state-dir", stateDir, ...(readOnly ? ["--read-only"] : [])],
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

  for (const readOnly of [false, true]) {
    const expected = await mcpToolNames(readOnly)
    expect(expected.includes(ACCOUNT_READ), `Expected the MCP registry to include ${ACCOUNT_READ}.`)
    const options = { state_dir: stateDir, ...(readOnly ? { read_only: true } : {}) }
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
    expect(skills.includes("discord-sends"), "Expected setup to discover the sends skill.")
    expect(expected.includes(CHAT_READ), `Expected the MCP registry to include ${CHAT_READ}.`)
    expect(expected.includes(SYNC_READ), `Expected the MCP registry to include ${SYNC_READ}.`)
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
