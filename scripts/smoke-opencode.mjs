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
const stateDir = mkdtempSync(join(tmpdir(), "opencode-smoke-"))

function expect(condition, message) {
  if (!condition) throw new Error(message)
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
    const signal = new AbortController().signal
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
