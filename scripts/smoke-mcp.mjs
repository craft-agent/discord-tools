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
const SEARCH_READ = "discord_search_read"
const SYNC_READ = "discord_sync_read"
const SYNC_ADD = "discord_sync_add"
const SYNC_REMOVE = "discord_sync_remove"
const MESSAGE_SEND = "discord_message_send"
const FILE_SEND = "discord_file_send"
const MESSAGE_EDIT = "discord_message_edit"
const MESSAGE_DELETE = "discord_message_delete"
const REACTION_ADD = "discord_reaction_add"
const REACTION_REMOVE = "discord_reaction_remove"
const PIN_ADD = "discord_pin_add"
const PIN_REMOVE = "discord_pin_remove"
const ACTION_TOOLS = [MESSAGE_EDIT, MESSAGE_DELETE, REACTION_ADD, REACTION_REMOVE, PIN_ADD, PIN_REMOVE]
const FILE_SAVE = "discord_file_save"
const EXPORT_CREATE = "discord_export_create"
const THREAD_CREATE = "discord_thread_create"
const POST_CREATE = "discord_post_create"
const FILE_POST = "discord_file_post"
const THREAD_JOIN = "discord_thread_join"
const THREAD_LEAVE = "discord_thread_leave"
const INBOX_READ = "discord_inbox_read"
const PEOPLE_READ = "discord_people_read"
const SERVER_READ = "discord_server_read"
const HISTORY_READ = "discord_history_read"
const ROLE_READ = "discord_role_read"
const INBOX_WRITE_TOOLS = ["discord_saved_add", "discord_saved_remove", "discord_read_mark"]
const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction"
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

    expectAnnotations(tools, SEARCH_READ, { readOnlyHint: true }, settings)
    await expectToolError(
      client,
      SEARCH_READ,
      { method: "mirror", channel: "general", query: "hi" },
      "invalid_argument",
    )
    console.log(`${SEARCH_READ} is read-only and refuses a name for an id under ${JSON.stringify(settings)}.`)

    expectAnnotations(tools, INBOX_READ, { readOnlyHint: true }, settings)
    console.log(`${INBOX_READ} is read-only under ${JSON.stringify(settings)}.`)

    expectAnnotations(tools, PEOPLE_READ, { readOnlyHint: true }, settings)
    await expectToolError(client, PEOPLE_READ, { method: "notes", user: "general" }, "invalid_argument")
    console.log(`${PEOPLE_READ} is read-only and refuses a name for an id under ${JSON.stringify(settings)}.`)

    expectAnnotations(tools, SERVER_READ, { readOnlyHint: true }, settings)
    await expectToolError(client, SERVER_READ, { method: "info", server: "general" }, "invalid_argument")
    console.log(`${SERVER_READ} is read-only and refuses a name for an id under ${JSON.stringify(settings)}.`)

    if (settings.includes("all")) {
      expectAnnotations(tools, HISTORY_READ, { readOnlyHint: true }, settings)
      console.log(`${HISTORY_READ} is read-only under ${JSON.stringify(settings)}.`)
    } else {
      expectAbsent(tools, HISTORY_READ, settings)
      console.log(`${HISTORY_READ} is absent under ${JSON.stringify(settings)}.`)
    }

    if (settings.includes("all")) {
      expectAnnotations(tools, ROLE_READ, { readOnlyHint: true }, settings)
      await expectToolError(client, ROLE_READ, { method: "list", server: "general" }, "invalid_argument")
      console.log(`${ROLE_READ} is read-only and refuses a name for an id under ${JSON.stringify(settings)}.`)
    } else {
      expectAbsent(tools, ROLE_READ, settings)
      console.log(`${ROLE_READ} is absent under ${JSON.stringify(settings)}.`)
    }

    if (settings.includes("--read-only")) {
      for (const name of [SYNC_ADD, SYNC_REMOVE, MESSAGE_SEND, FILE_SEND, ...INBOX_WRITE_TOOLS]) {
        expectAbsent(tools, name, settings)
      }
      console.log(
        `${SYNC_ADD}, ${SYNC_REMOVE}, ${MESSAGE_SEND}, ${FILE_SEND} and the inbox writes are absent under ${JSON.stringify(settings)}.`,
      )
    } else {
      for (const name of INBOX_WRITE_TOOLS) {
        expectAnnotations(tools, name, { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, settings)
      }
      console.log(`The inbox writes carry their write annotations under ${JSON.stringify(settings)}.`)
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
      expectAnnotations(
        tools,
        FILE_SEND,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        settings,
      )
      await expectToolError(client, FILE_SEND, { channel: "general", files: ["a.txt"] }, "invalid_argument")
      console.log(`${FILE_SEND} carries its write annotations and refuses a name for an id.`)
    }

    if (settings.includes("all") && !settings.includes("--read-only")) {
      const hints = {
        [MESSAGE_EDIT]: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        [MESSAGE_DELETE]: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        [REACTION_ADD]: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        [REACTION_REMOVE]: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        [PIN_ADD]: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        [PIN_REMOVE]: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      }
      for (const [name, expected] of Object.entries(hints)) expectAnnotations(tools, name, expected, settings)
      for (const name of ACTION_TOOLS) {
        const meta = tools.find((tool) => tool.name === name)?._meta?.[REQUIRES_USER_INTERACTION]
        if ((meta === true) !== (name === MESSAGE_DELETE)) {
          throw new Error(
            `Expected ${name} ${name === MESSAGE_DELETE ? "with" : "without"} ${REQUIRES_USER_INTERACTION}`,
          )
        }
      }
      await expectToolError(client, MESSAGE_EDIT, { channel: "general", message: "1", text: "hi" }, "invalid_argument")
      console.log(`The actions tools carry their write annotations; ${MESSAGE_EDIT} refuses a name for an id.`)
      expectAnnotations(tools, FILE_SAVE, { readOnlyHint: false, destructiveHint: false }, settings)
      await expectToolError(client, FILE_SAVE, { channel: "general", message: "1" }, "invalid_argument")
      console.log(`${FILE_SAVE} carries its write annotations and refuses a name for an id.`)
      expectAnnotations(
        tools,
        EXPORT_CREATE,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        settings,
      )
      await expectToolError(client, EXPORT_CREATE, { chat: "general" }, "invalid_argument")
      console.log(`${EXPORT_CREATE} carries its write annotations and refuses a name for an id.`)
      expectAnnotations(
        tools,
        THREAD_CREATE,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        settings,
      )
      await expectToolError(client, THREAD_CREATE, { channel: "general", name: "x" }, "invalid_argument")
      console.log(`${THREAD_CREATE} carries its write annotations and refuses a name for an id.`)
      expectAnnotations(
        tools,
        POST_CREATE,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        settings,
      )
      await expectToolError(client, POST_CREATE, { channel: "general", name: "x", text: "hi" }, "invalid_argument")
      console.log(`${POST_CREATE} carries its write annotations and refuses a name for an id.`)
      expectAnnotations(
        tools,
        FILE_POST,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        settings,
      )
      await expectToolError(client, FILE_POST, { channel: "general", name: "x", files: ["a.txt"] }, "invalid_argument")
      console.log(`${FILE_POST} carries its write annotations and refuses a name for an id.`)
      expectAnnotations(
        tools,
        THREAD_JOIN,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        settings,
      )
      expectAnnotations(
        tools,
        THREAD_LEAVE,
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        settings,
      )
      for (const name of [THREAD_JOIN, THREAD_LEAVE]) {
        await expectToolError(client, name, { thread: "general" }, "invalid_argument")
      }
      console.log(`${THREAD_JOIN} and ${THREAD_LEAVE} carry their write annotations and refuse a name for an id.`)
    } else {
      for (const name of [
        ...ACTION_TOOLS,
        FILE_SAVE,
        EXPORT_CREATE,
        THREAD_CREATE,
        POST_CREATE,
        FILE_POST,
        THREAD_JOIN,
        THREAD_LEAVE,
      ]) {
        expectAbsent(tools, name, settings)
      }
      console.log(`The actions, files, export, thread and post tools are absent under ${JSON.stringify(settings)}.`)
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
  for (const settings of [[], ["--read-only"], ["--toolsets", "all"], ["--toolsets", "all", "--read-only"]]) {
    await listTools(settings)
  }
  rejectsBadSettings()
  deepStrictEqual(readdirSync(stateDir), [])
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(stateDir, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
