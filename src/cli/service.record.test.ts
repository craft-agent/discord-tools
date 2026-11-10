import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { writeAccount } from "../core/discord/account-meta"
import { labelPaths, type LabelPaths } from "../core/discord/labels"
import { readServiceRecord } from "../core/discord/service-record"
import { PROJECT } from "../project"
import { EXIT_OK, type CommandIo } from "./command-io"
import { fakeHost, runCommand, signedInAccount, tempStateDir } from "./commands.testing"
import { runServiceCommand } from "./service"

const VERSION = "9.8.7"
const LABEL = "work"

const run = runCommand.bind(null, runServiceCommand)

/** A signed-in label, a directory for the made-up program and script, and the label's paths. */
async function setup(): Promise<{ dir: string; tools: string; paths: LabelPaths }> {
  const dir = await tempStateDir()
  const tools = await tempStateDir()
  await signedInAccount(dir, LABEL)
  const paths = labelPaths(dir, LABEL)
  await writeAccount(paths, { id: "123456789012345678", name: "test", verifiedAt: 1 })
  return { dir, tools, paths }
}

async function makeFile(path: string, body = "", mode = 0o644): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
  await chmod(path, mode)
  return path
}

async function versionedProgram(tools: string): Promise<string> {
  const program = join(tools, "rt", VERSION, "bin", "node")
  return makeFile(program, `#!/bin/sh\necho ${program}\n`, 0o755)
}

function install(dir: string, io: Partial<CommandIo>, host = fakeHost(dir)) {
  return run(["install", `--account=${LABEL}`, `--state-dir=${dir}`], { serviceHost: host, ...io })
}

function plistText(dir: string): Promise<string> {
  return readFile(join(dir, "Library", "LaunchAgents", `${PROJECT.serviceId}.${LABEL}.plist`), "utf8")
}

describe("service record: install", () => {
  test("writes the program and script, mode 600", async () => {
    const { dir, tools, paths } = await setup()
    const entryPath = await makeFile(join(tools, "cli.js"))
    const { code, stderr } = await install(dir, { program: "/bin/node", entryPath })

    expect(code).toBe(EXIT_OK)
    expect(stderr).toBe("")
    expect(await readServiceRecord(paths)).toEqual({ program: "/bin/node", script: entryPath })
    expect((await stat(paths.serviceRecord)).mode & 0o777).toBe(0o600)
  })

  test("says to install again after updating Node or the package", async () => {
    const { dir, tools } = await setup()
    const entryPath = await makeFile(join(tools, "cli.js"))
    const { stdout } = await install(dir, { program: "/bin/node", entryPath })

    expect(stdout).toContain("Install the service again after updating Node or this package, as it records both paths.")
  })

  test("warns when the program path holds its version and no stable node exists", async () => {
    const { dir, tools, paths } = await setup()
    const program = await versionedProgram(tools)
    const entryPath = await makeFile(join(tools, "cli.js"))
    const { code, stderr } = await install(dir, { env: { PATH: "" }, program, version: VERSION, entryPath })

    expect(code).toBe(EXIT_OK)
    expect(stderr).toContain(`Warning: the service runs Node at a path that holds its version (${program});`)
    expect((await readServiceRecord(paths))?.program).toBe(program)
    expect(await plistText(dir)).toContain(`<string>${program}</string>`)
  })

  test("records a node at a path without the version when it starts the same program", async () => {
    const { dir, tools, paths } = await setup()
    const program = await versionedProgram(tools)
    const entryPath = await makeFile(join(tools, "cli.js"))
    const binDir = join(tools, "stable")
    await mkdir(binDir)
    const link = join(binDir, "node")
    await symlink(program, link)

    const { code, stderr } = await install(dir, { env: { PATH: binDir }, program, version: VERSION, entryPath })

    expect(code).toBe(EXIT_OK)
    expect(stderr).toBe("")
    expect((await readServiceRecord(paths))?.program).toBe(link)
    expect(await plistText(dir)).toContain(`<string>${link}</string>`)
  })

  test("passes over a node under the temporary or runtime directory", async () => {
    const { dir, tools, paths } = await setup()
    const program = await versionedProgram(tools)
    const entryPath = await makeFile(join(tools, "cli.js"))
    const runtime = join(tools, "runtime")
    const binDir = join(runtime, "session", "bin")
    await mkdir(binDir, { recursive: true })
    await symlink(program, join(binDir, "node"))

    for (const volatile of [{ XDG_RUNTIME_DIR: runtime }, { TMPDIR: runtime }]) {
      const { code, stderr } = await install(dir, {
        env: { PATH: binDir, ...volatile },
        program,
        version: VERSION,
        entryPath,
      })
      expect(code).toBe(EXIT_OK)
      expect(stderr).toContain("Warning: the service runs Node at a path that holds its version")
      expect((await readServiceRecord(paths))?.program).toBe(program)
    }
  })

  test("does not warn when the program path does not hold the version", async () => {
    const { dir, tools } = await setup()
    const entryPath = await makeFile(join(tools, "cli.js"))
    const { stderr } = await install(dir, { program: "/bin/node", version: VERSION, entryPath })

    expect(stderr).toBe("")
  })

  test("a failed install leaves no record of the earlier program", async () => {
    const { dir, tools, paths } = await setup()
    const entryPath = await makeFile(join(tools, "cli.js"))
    await install(dir, { program: "/bin/node", entryPath })
    expect(await readServiceRecord(paths)).not.toBeNull()

    const failing = fakeHost(dir, { run: async () => ({ code: 1, stdout: "", stderr: "boom" }) })
    const { code } = await install(dir, { program: "/bin/node", entryPath }, failing)

    expect(code).not.toBe(EXIT_OK)
    expect(await readServiceRecord(paths)).toBeNull()
  })
})

describe("service record: uninstall", () => {
  test("deletes the record", async () => {
    const { dir, tools, paths } = await setup()
    const entryPath = await makeFile(join(tools, "cli.js"))
    await install(dir, { program: "/bin/node", entryPath })
    expect(await readServiceRecord(paths)).not.toBeNull()

    const { code } = await run(["uninstall", `--account=${LABEL}`, `--state-dir=${dir}`], {
      serviceHost: fakeHost(dir),
    })

    expect(code).toBe(EXIT_OK)
    expect(await stat(paths.serviceRecord).catch(() => undefined)).toBeUndefined()
  })

  test("succeeds without a record", async () => {
    const { dir } = await setup()
    const { code, stdout } = await run(["uninstall", `--account=${LABEL}`, `--state-dir=${dir}`], {
      serviceHost: fakeHost(dir),
    })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toBe(`Uninstalled sync service for "${LABEL}".\n`)
  })
})

describe("service record: status", () => {
  const status = (dir: string) =>
    run(["status", `--account=${LABEL}`, `--state-dir=${dir}`], { serviceHost: fakeHost(dir) })

  async function installed(): Promise<{ dir: string; program: string; script: string }> {
    const { dir, tools } = await setup()
    const program = await makeFile(join(tools, "bin", "node"), "", 0o755)
    const script = await makeFile(join(tools, "cli.js"))
    await install(dir, { program, entryPath: script })
    return { dir, program, script }
  }

  test("shows the program and script when both exist", async () => {
    const { dir, program, script } = await installed()
    const { code, stdout } = await status(dir)

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain(`  Program: ${program}\n`)
    expect(stdout).toContain(`  Script: ${script}\n`)
    expect(stdout).not.toContain("Missing:")
    expect(stdout).not.toContain("gone")
  })

  test("names a missing program with the fix", async () => {
    const { dir, program, script } = await installed()
    await rm(program)
    const { stdout } = await status(dir)

    expect(stdout).toContain(`  Missing: ${program}\n`)
    expect(stdout).not.toContain(`  Missing: ${script}\n`)
    expect(stdout).toContain(
      `The program it was installed with is gone, as after updating Node or this package; install it again with: ${PROJECT.cli} service install --account ${LABEL}\n`,
    )
  })

  test("names a missing program and script", async () => {
    const { dir, program, script } = await installed()
    await rm(program)
    await rm(script)
    const { stdout } = await status(dir)

    expect(stdout).toContain(`  Missing: ${program}\n`)
    expect(stdout).toContain(`  Missing: ${script}\n`)
    expect(stdout).toContain(
      "The program and script it was installed with are gone, as after updating Node or this package;",
    )
  })

  test("prints none of these lines without a record", async () => {
    const { dir } = await setup()
    const { code, stdout } = await status(dir)

    expect(code).toBe(EXIT_OK)
    for (const line of ["Program:", "Script:", "Missing:", "gone"]) expect(stdout).not.toContain(line)
  })
})
