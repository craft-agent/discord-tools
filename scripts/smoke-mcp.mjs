import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { deepStrictEqual } from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_NAME } from "./package-name.mjs"

const SERVER = fileURLToPath(new URL("../dist/mcp.js", import.meta.url))
const EXIT_USAGE = 2
const UNKNOWN_TOOL = "unknown_nonexistent_read"
const ACCOUNT_READ = "discord_account_read"
const CHAT_READ = "discord_chat_read"
const SYNC_READ = "discord_sync_read"
const SYNC_ADD = "discord_sync_add"
const SYNC_REMOVE = "discord_sync_remove"
const MESSAGE_SEND = "discord_message_send"
const NO_ACCOUNT = "No Discord account is signed in yet"
const stateDir = mkdtempSync(join(tmpdir(), "mcp-smoke-"))

async function expectToolError(client, name, args, expectedCode, expectedText) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content
  const error = block?.type === "text" ? JSON.parse(block.text).error : undefined
  if (
    result.isError !== true ||
    error?.code !== expectedCode ||
    (expectedText !== undefined && !String(error.message).includes(expectedText))
  ) {
    throw new Error(
      `Expected a ${expectedCode} error for ${name} ${JSON.stringify(args)}, got ${JSON.stringify(result)}`,
    )
  }
}

function expectAnnotations(tools, name, expected, settings) {
  const annotations = tools.find((tool) => tool.name === name)?.annotations
  for (const [hint, value] of Object.entries(expected)) {
    if (annotations?.[hint] !== value) {
      throw new Error(`Expected ${name} with ${hint} ${value} under ${JSON.stringify(settings)}`)
    }
  }
}

function expectAbsent(tools, name, settings) {
  if (tools.some((tool) => tool.name === name)) {
    throw new Error(`Expected ${name} to be absent under ${JSON.stringify(settings)}`)
  }
}

async function listTools(settings) {
  const client = new Client({ name: "smoke", version: "0.0.0" })
  try {
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SERVER, "--state-dir", stateDir, ...settings] }),
    )
    const serverName = client.getServerVersion()?.name
    if (serverName !== PLUGIN_NAME)
      throw new Error(`Expected the server to be named ${PLUGIN_NAME}, got ${serverName}.`)
    const { tools } = await client.listTools()
    const account = tools.find((tool) => tool.name === ACCOUNT_READ)
    if (account?.annotations?.readOnlyHint !== true) {
      throw new Error(`Expected ${ACCOUNT_READ} with readOnlyHint under ${JSON.stringify(settings)}`)
    }
    console.log(`The MCP server ${serverName} lists ${tools.length} tools.`)

    const accounts = await client.callTool({ name: ACCOUNT_READ, arguments: {} })
    if (accounts.isError) throw new Error(`Expected a successful ${ACCOUNT_READ} result`)
    deepStrictEqual(accounts.structuredContent, { accounts: [] })
    deepStrictEqual(accounts.content, [{ type: "text", text: JSON.stringify({ accounts: [] }) }])
    console.log(`${ACCOUNT_READ} returns empty accounts under ${JSON.stringify(settings)}.`)

    const chat = tools.find((tool) => tool.name === CHAT_READ)
    if (chat?.annotations?.readOnlyHint !== true) {
      throw new Error(`Expected ${CHAT_READ} with readOnlyHint under ${JSON.stringify(settings)}`)
    }
    await expectToolError(client, CHAT_READ, { method: "servers" }, "not_found", NO_ACCOUNT)
    await expectToolError(client, CHAT_READ, { method: "servers", server: "1" }, "invalid_argument")
    console.log(`${CHAT_READ} is read-only and refuses offline under ${JSON.stringify(settings)}.`)

    expectAnnotations(tools, SYNC_READ, { readOnlyHint: true }, settings)
    await expectToolError(client, SYNC_READ, { method: "list" }, "not_found", NO_ACCOUNT)
    console.log(`${SYNC_READ} is read-only and refuses offline under ${JSON.stringify(settings)}.`)

    if (settings.includes("--read-only")) {
      for (const name of [SYNC_ADD, SYNC_REMOVE, MESSAGE_SEND]) expectAbsent(tools, name, settings)
      console.log(`${SYNC_ADD}, ${SYNC_REMOVE} and ${MESSAGE_SEND} are absent under ${JSON.stringify(settings)}.`)
    } else {
      expectAnnotations(
        tools,
        SYNC_ADD,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        settings,
      )
      expectAnnotations(
        tools,
        SYNC_REMOVE,
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        settings,
      )
      await expectToolError(client, SYNC_ADD, { server: "general" }, "invalid_argument")
      console.log(`${SYNC_ADD} and ${SYNC_REMOVE} carry their write annotations; ${SYNC_ADD} refuses a name for an id.`)
      expectAnnotations(
        tools,
        MESSAGE_SEND,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        settings,
      )
      await expectToolError(client, MESSAGE_SEND, { channel: "general", text: "hi" }, "invalid_argument")
      console.log(`${MESSAGE_SEND} carries its write annotations and refuses a name for an id.`)
    }

    const result = await client.callTool({ name: UNKNOWN_TOOL })
    const [block] = result.content
    const code = block?.type === "text" ? JSON.parse(block.text).error?.code : undefined
    if (result.isError !== true || code !== "invalid_argument") {
      throw new Error(`Expected an invalid_argument error result for ${UNKNOWN_TOOL}, got ${JSON.stringify(result)}`)
    }
    console.log(`Calling ${UNKNOWN_TOOL} gives an invalid_argument error result.`)
  } finally {
    await client.close()
  }
}

function rejectsBadSettings() {
  const run = spawnSync(process.execPath, [SERVER, "--toolsets", "bogus", "--state-dir", stateDir], {
    encoding: "utf8",
    stdio: "pipe",
  })
  if (run.status !== EXIT_USAGE) {
    throw new Error(`Expected exit ${EXIT_USAGE} for --toolsets bogus, got ${run.status}: ${run.stderr}`)
  }
  if (run.stdout !== "") throw new Error(`Expected nothing on stdout for --toolsets bogus, got: ${run.stdout}`)
  console.log(`--toolsets bogus exits ${EXIT_USAGE}: ${run.stderr.trim()}`)
}

try {
  for (const settings of [[], ["--read-only"]]) await listTools(settings)
  rejectsBadSettings()
  deepStrictEqual(readdirSync(stateDir), [])
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(stateDir, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
