import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { deepStrictEqual } from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))
const SERVER = fileURLToPath(new URL("../dist/mcp.js", import.meta.url))
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const UNKNOWN_TOOL = "unknown_nonexistent_read"
const ACCOUNT_READ = "discord_account_read"
const CHAT_READ = "discord_chat_read"
const SEARCH_READ = "discord_search_read"
const SYNC_READ = "discord_sync_read"
const INBOX_READ = "discord_inbox_read"
const PEOPLE_READ = "discord_people_read"
const SERVER_READ = "discord_server_read"
const HISTORY_READ = "discord_history_read"
const WRITE_TOOLS = {
  discord_sync_add: "idempotent",
  discord_sync_remove: "overwrite",
  discord_message_send: "add",
  discord_file_send: "add",
  discord_saved_add: "overwrite",
  discord_saved_remove: "overwrite",
  discord_read_mark: "overwrite",
}
const ACTION_TOOLS = {
  discord_message_edit: "overwrite",
  discord_message_delete: "administrative",
  discord_reaction_add: "idempotent",
  discord_reaction_remove: "overwrite",
  discord_pin_add: "idempotent",
  discord_pin_remove: "overwrite",
  discord_file_save: "add",
  discord_export_create: "add",
  discord_thread_create: "add",
  discord_post_create: "add",
  discord_file_post: "add",
  discord_thread_join: "idempotent",
  discord_thread_leave: "overwrite",
}
const NO_ACCOUNT = "No Discord account is signed in yet"
const stateDir = mkdtempSync(join(tmpdir(), "cli-tools-smoke-"))

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function cli(args, input = "") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.includes("TOKEN")))
  return spawnSync(process.execPath, [CLI, ...args, "--state-dir", stateDir], {
    encoding: "utf8",
    input,
    stdio: "pipe",
    env,
  })
}

/** The tool names the MCP server lists with the given settings; it draws on the same registry as the CLI. */
async function mcpToolNames(args) {
  const client = new Client({ name: "smoke", version: "0.0.0" })
  try {
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args, "--state-dir", stateDir] }),
    )
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

async function listsTheServersTools() {
  for (const settings of [[], ["--read-only"], ["--toolsets", "all"], ["--toolsets", "all", "--read-only"]]) {
    const label = ["list", ...settings].join(" ")
    const run = cli(["list", ...settings])
    expect(run.status === 0, `Expected exit 0 for ${label}, got ${run.status}: ${run.stderr}`)
    const listed = JSON.parse(run.stdout)
    expect(
      listed.some((tool) => tool.id === ACCOUNT_READ && tool.class === "read"),
      `Expected ${label} to include ${ACCOUNT_READ} as a read tool`,
    )
    expect(
      listed.some((tool) => tool.id === CHAT_READ && tool.class === "read"),
      `Expected ${label} to include ${CHAT_READ} as a read tool`,
    )
    expect(
      listed.some((tool) => tool.id === SEARCH_READ && tool.class === "read"),
      `Expected ${label} to include ${SEARCH_READ} as a read tool`,
    )
    expect(
      listed.some((tool) => tool.id === SYNC_READ && tool.class === "read"),
      `Expected ${label} to include ${SYNC_READ} as a read tool`,
    )
    expect(
      listed.some((tool) => tool.id === INBOX_READ && tool.class === "read"),
      `Expected ${label} to include ${INBOX_READ} as a read tool`,
    )
    expect(
      listed.some((tool) => tool.id === PEOPLE_READ && tool.class === "read"),
      `Expected ${label} to include ${PEOPLE_READ} as a read tool`,
    )
    expect(
      listed.some((tool) => tool.id === SERVER_READ && tool.class === "read"),
      `Expected ${label} to include ${SERVER_READ} as a read tool`,
    )
    const historyOn = settings.includes("all")
    expect(
      historyOn
        ? listed.some((tool) => tool.id === HISTORY_READ && tool.class === "read")
        : !listed.some((tool) => tool.id === HISTORY_READ),
      `Expected ${label} to ${historyOn ? `include ${HISTORY_READ} as a read tool` : `omit ${HISTORY_READ}`}`,
    )
    for (const [id, writeClass] of Object.entries(WRITE_TOOLS)) {
      const tool = listed.find((entry) => entry.id === id)
      expect(
        settings.includes("--read-only") ? tool === undefined : tool?.class === writeClass,
        `Expected ${label} to ${settings.includes("--read-only") ? "omit" : `include as ${writeClass}`} ${id}`,
      )
    }
    for (const [id, writeClass] of Object.entries(ACTION_TOOLS)) {
      const tool = listed.find((entry) => entry.id === id)
      const on = settings.includes("all") && !settings.includes("--read-only")
      expect(
        on ? tool?.class === writeClass : tool === undefined,
        `Expected ${label} to ${on ? `include as ${writeClass}` : "omit"} ${id}`,
      )
    }
    const expected = await mcpToolNames(settings)
    expect(
      JSON.stringify(listed.map((tool) => tool.id)) === JSON.stringify(expected),
      `Expected ${label} to give ${JSON.stringify(expected)}, got ${run.stdout}`,
    )
    for (const tool of listed) {
      expect(
        typeof tool.title === "string" && typeof tool.class === "string" && tool.input_schema?.type === "object",
        `Expected a described tool, got ${JSON.stringify(tool)}`,
      )
    }
    console.log(`${label} gives the ${listed.length} tools the MCP server lists.`)
  }
}

function readsEmptyAccounts() {
  for (const settings of [[], ["--read-only"]]) {
    const run = cli(["run", ACCOUNT_READ, "--cwd", process.cwd(), ...settings], "{}")
    expect(run.status === 0, `Expected ${ACCOUNT_READ} to succeed, got ${run.status}: ${run.stderr}`)
    deepStrictEqual(JSON.parse(run.stdout), { result: { accounts: [] } })
  }
  expect(readdirSync(stateDir).length === 0, "Account reads must not create state")
  console.log(`${ACCOUNT_READ} returns empty accounts from isolated state, including read-only mode.`)
}

function rejectsAnUnknownTool() {
  const run = cli(["run", UNKNOWN_TOOL, "--cwd", process.cwd()], "{}")
  const code = JSON.parse(run.stdout).error?.code
  expect(
    run.status === EXIT_FAILED && code === "invalid_argument",
    `Expected exit ${EXIT_FAILED} and invalid_argument for ${UNKNOWN_TOOL}, got ${run.status}: ${run.stdout}`,
  )
  console.log(`run ${UNKNOWN_TOOL} exits ${EXIT_FAILED} with invalid_argument.`)
}

function refusesChatReadOffline() {
  for (const settings of [[], ["--read-only"]]) {
    const run = cli(["run", CHAT_READ, "--cwd", process.cwd(), ...settings], JSON.stringify({ method: "servers" }))
    const error = JSON.parse(run.stdout).error
    expect(
      run.status === EXIT_FAILED && error?.code === "not_found" && String(error.message).includes(NO_ACCOUNT),
      `Expected exit ${EXIT_FAILED} and not_found for ${CHAT_READ}, got ${run.status}: ${run.stdout}`,
    )
  }
  expect(readdirSync(stateDir).length === 0, "Chat reads must not create state")
  console.log(`run ${CHAT_READ} exits ${EXIT_FAILED} with not_found offline, including read-only mode.`)
}

function refusesSyncReadOffline() {
  for (const settings of [[], ["--read-only"]]) {
    const run = cli(["run", SYNC_READ, "--cwd", process.cwd(), ...settings], JSON.stringify({ method: "list" }))
    const error = JSON.parse(run.stdout).error
    expect(
      run.status === EXIT_FAILED && error?.code === "not_found" && String(error.message).includes(NO_ACCOUNT),
      `Expected exit ${EXIT_FAILED} and not_found for ${SYNC_READ}, got ${run.status}: ${run.stdout}`,
    )
  }
  expect(readdirSync(stateDir).length === 0, "Sync reads must not create state")
  console.log(`run ${SYNC_READ} exits ${EXIT_FAILED} with not_found offline, including read-only mode.`)
}

function rejectsConfirm() {
  const run = cli(["list", "--confirm", "x"])
  expect(run.status === EXIT_USAGE, `Expected exit ${EXIT_USAGE} for --confirm x, got ${run.status}: ${run.stderr}`)
  expect(run.stdout === "", `Expected nothing on stdout for --confirm x, got: ${run.stdout}`)
  console.log(`--confirm x exits ${EXIT_USAGE}: ${run.stderr.trim()}`)
}

function rejectsUnknownAccountsOffline() {
  for (const command of [["sync"], ["service", "install"]]) {
    const args = [...command, "--account", "unknown"]
    const run = cli(args)
    expect(run.status === EXIT_FAILED, `Expected exit ${EXIT_FAILED} for ${command.join(" ")}, got ${run.status}`)
    expect(run.stdout === "", `Expected no success output for ${command.join(" ")}`)
    expect(run.stderr.includes('account "unknown" was not found'), `Expected missing account, got: ${run.stderr}`)
  }
  for (const command of [["login"], ["sync"], ["service", "install"]]) {
    const run = cli([...command, "--account", "Bad"])
    expect(run.status === EXIT_USAGE, `Expected malformed ${command.join(" ")} flags to exit ${EXIT_USAGE}`)
  }
  expect(readdirSync(stateDir).length === 0, "Offline command checks must not create account state")
  console.log("Sync and installation reject unknown accounts offline; malformed flags exit 2.")
}

try {
  await listsTheServersTools()
  readsEmptyAccounts()
  rejectsAnUnknownTool()
  refusesChatReadOffline()
  refusesSyncReadOffline()
  rejectsConfirm()
  rejectsUnknownAccountsOffline()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(stateDir, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
