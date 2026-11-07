import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { isToolError, type ErrorCode } from "../errors"
import { makeTempDir } from "./mirror.testing"
import { removeLabel } from "./removal"
import { acquireSyncLock } from "./sync-lock"

let root: string
let stateDir: string
let uninstalls: number

beforeEach(() => {
  root = makeTempDir()
  stateDir = join(root, "state")
  uninstalls = 0
  makeLabel("work")
  makeLabel("work2")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A label directory holding fake mirror and token files. */
function makeLabel(label: string): void {
  const dir = join(stateDir, label)
  mkdirSync(join(dir, "transfers"), { recursive: true })
  writeFileSync(join(dir, "mirror.sqlite"), "fake mirror")
  writeFileSync(join(dir, "token"), "fake-token-value", { mode: 0o600 })
  writeFileSync(join(dir, "transfers", "file"), "x")
}

async function uninstall(): Promise<void> {
  uninstalls += 1
}

async function codeOf(run: () => Promise<unknown>): Promise<ErrorCode> {
  try {
    await run()
  } catch (error) {
    if (isToolError(error)) return error.code
    throw error
  }
  throw new Error("expected the call to throw")
}

function remove(label: string, callback: () => Promise<void> = uninstall): Promise<void> {
  return removeLabel({ stateDir, label, uninstall: callback })
}

describe("removeLabel", () => {
  test("removes the whole label and nothing beside it, leaving no detached copy", async () => {
    chmodSync(join(stateDir, "work", "token"), 0o000)
    await remove("work")
    expect(readdirSync(stateDir)).toEqual(["work2"])
    expect(readFileSync(join(stateDir, "work2", "token"), "utf8")).toBe("fake-token-value")
    expect(uninstalls).toBe(1)
  })

  test("refuses a missing label before it uninstalls anything", async () => {
    expect(await codeOf(() => remove("absent"))).toBe("not_found")
    expect(uninstalls).toBe(0)
  })

  test("refuses an invalid label before it uninstalls anything", async () => {
    expect(await codeOf(() => remove("../work"))).toBe("invalid_argument")
    expect(await codeOf(() => remove("Work"))).toBe("invalid_argument")
    expect(uninstalls).toBe(0)
    expect(existsSync(join(stateDir, "work"))).toBe(true)
  })

  test("refuses a symlink and a plain file, leaving the symlink's target alone", async () => {
    const target = join(root, "target")
    mkdirSync(target)
    writeFileSync(join(target, "keep"), "x")
    symlinkSync(target, join(stateDir, "linked"))
    writeFileSync(join(stateDir, "plain"), "x")
    expect(await codeOf(() => remove("linked"))).toBe("invalid_argument")
    expect(await codeOf(() => remove("plain"))).toBe("invalid_argument")
    expect(uninstalls).toBe(0)
    expect(existsSync(join(target, "keep"))).toBe(true)
    expect(existsSync(join(stateDir, "linked"))).toBe(true)
  })

  test("leaves the state when the uninstall fails", async () => {
    const failing = async () => {
      throw new Error("service manager unavailable")
    }
    await expect(remove("work", failing)).rejects.toThrow("service manager unavailable")
    expect(existsSync(join(stateDir, "work", "mirror.sqlite"))).toBe(true)
  })

  test("leaves the state when a sync run holds the lock", async () => {
    const release = acquireSyncLock(join(stateDir, "work", "sync.lock"))
    try {
      expect(await codeOf(() => remove("work"))).toBe("invalid_argument")
      expect(readdirSync(stateDir).sort()).toEqual(["work", "work2"])
    } finally {
      release?.()
    }
    await remove("work")
    expect(readdirSync(stateDir)).toEqual(["work2"])
  })
})

describe("removeLabel while the uninstall runs", () => {
  test("does not delete a directory that replaced the label", async () => {
    const replace = async () => {
      renameSync(join(stateDir, "work"), join(root, "moved-away"))
      makeLabel("work")
      writeFileSync(join(stateDir, "work", "new-account"), "x")
    }
    expect(await codeOf(() => remove("work", replace))).toBe("stale")
    expect(existsSync(join(stateDir, "work", "new-account"))).toBe(true)
    expect(existsSync(join(root, "moved-away", "mirror.sqlite"))).toBe(true)
    acquireSyncLock(join(stateDir, "work", "sync.lock"))?.()
  })

  test("does not follow a symlink that replaced the label", async () => {
    const target = join(root, "target")
    mkdirSync(target)
    writeFileSync(join(target, "keep"), "x")
    const replace = async () => {
      renameSync(join(stateDir, "work"), join(root, "moved-away"))
      symlinkSync(target, join(stateDir, "work"))
    }
    expect(await codeOf(() => remove("work", replace))).toBe("stale")
    expect(existsSync(join(target, "keep"))).toBe(true)
    expect(existsSync(join(target, "sync.lock"))).toBe(false)
  })

  test("is stale when the label vanished", async () => {
    const vanish = async () => rmSync(join(stateDir, "work"), { recursive: true })
    expect(await codeOf(() => remove("work", vanish))).toBe("stale")
    expect(existsSync(join(stateDir, "work"))).toBe(false)
  })
})

describe("removeLabel when deleting fails", () => {
  const locked = () => join(stateDir, "work", "transfers")

  afterEach(() => {
    for (const name of readdirSync(stateDir)) {
      const transfers = join(stateDir, name, "transfers")
      if (existsSync(transfers)) chmodSync(transfers, 0o700)
    }
  })

  // Root ignores directory permissions, so nothing blocks the deletion there.
  test.skipIf(process.getuid?.() === 0)("names the detached directory and does not put it back", async () => {
    chmodSync(locked(), 0o500)
    let error: unknown
    try {
      await remove("work")
    } catch (caught) {
      error = caught
    }
    if (!isToolError(error)) throw new Error("expected a ToolError")
    const detached = readdirSync(stateDir).find((name) => name.startsWith(".removed-work-"))
    expect(error.code).toBe("upstream_error")
    expect(detached).toBeDefined()
    expect(error.message).toContain(join(stateDir, detached!))
    expect(existsSync(join(stateDir, "work"))).toBe(false)
  })
})
