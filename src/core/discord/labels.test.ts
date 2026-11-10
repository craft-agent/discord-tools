import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import { DEFAULT_LABEL, checkLabel, ensureLabelDir, isLabel, labelPaths, listLabels, pickLabel } from "./labels"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dsc-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

async function failure(run: () => unknown): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  return undefined
}

describe("isLabel and checkLabel", () => {
  const valid = [DEFAULT_LABEL, "a", "work_2", "a" + "0".repeat(22) + "b"]
  const invalid = [
    "",
    "a".repeat(25),
    "Work",
    "A",
    "DEFAULT",
    "_work",
    "work_",
    "work-1",
    "work.1",
    "work..1",
    "work/1",
    "work 1",
  ]

  test("accepts valid labels", () => {
    for (const label of valid) {
      expect(isLabel(label)).toBe(true)
      expect(checkLabel(label)).toBe(label)
    }
  })

  test("refuses invalid labels with an invalid_argument ToolError", async () => {
    for (const label of invalid) {
      expect(isLabel(label)).toBe(false)
      const error = await failure(() => checkLabel(label))
      expect(isToolError(error) && error.code).toBe("invalid_argument")
    }
  })

  test("quotes and truncates a bad label in the message", async () => {
    const error = await failure(() => checkLabel("A".repeat(50)))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain(`"${"A".repeat(40)}…"`)
  })
})

describe("labelPaths", () => {
  test("returns the directory and file layout", () => {
    const stateDir = join(tempDir, "state")
    const dir = join(stateDir, "work")
    expect(labelPaths(stateDir, "work")).toEqual({
      label: "work",
      dir,
      token: join(dir, "token"),
      auth: join(dir, "auth.json"),
      client: join(dir, "client.json"),
      mirror: join(dir, "mirror.sqlite"),
      lock: join(dir, "sync.lock"),
      transfers: join(dir, "transfers"),
      incoming: join(dir, "incoming"),
      outgoing: join(dir, "outgoing"),
      serviceRecord: join(dir, "service.json"),
    })
  })

  test("throws internal_error on a relative stateDir", async () => {
    const error = await failure(() => labelPaths("relative/state", "work"))
    expect(isToolError(error) && error.code).toBe("internal_error")
  })

  test("throws invalid_argument on a bad label", async () => {
    const error = await failure(() => labelPaths(tempDir, "Bad"))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })
})

describe("listLabels", () => {
  test("returns an empty array when stateDir does not exist", async () => {
    expect(await listLabels(join(tempDir, "missing"))).toEqual([])
  })

  test("returns sorted labels, skipping files, symlinks and invalid names", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)
    for (const name of ["zebra", "apple", "middle", "UPPERCASE", "with-hyphen", "_leading"]) {
      mkdirSync(join(state, name))
    }
    writeFileSync(join(state, "file_label"), "data")
    const targetDir = join(tempDir, "target")
    mkdirSync(targetDir)
    symlinkSync(targetDir, join(state, "symlink_dir"))

    expect(await listLabels(state)).toEqual(["apple", "middle", "zebra"])
  })
})

describe("pickLabel", () => {
  test("returns the paths of a given account that exists", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "work"), { recursive: true })
    expect((await pickLabel(state, "work")).label).toBe("work")
  })

  test("throws not_found for a missing account when none is signed in", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)
    const error = await failure(() => pickLabel(state, "work"))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect((error as Error).message).toBe('Discord account "work" was not found; no Discord account is signed in yet.')
  })

  test("throws not_found naming the known accounts", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "personal"), { recursive: true })
    const error = await failure(() => pickLabel(state, "work"))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect((error as Error).message).toBe('Discord account "work" was not found; known accounts: personal.')
  })

  test("throws invalid_argument for a bad account name", async () => {
    mkdirSync(join(tempDir, "state"))
    const error = await failure(() => pickLabel(join(tempDir, "state"), "INVALID"))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })

  test("returns the only label when none is given", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "solo"), { recursive: true })
    expect((await pickLabel(state, undefined)).label).toBe("solo")
  })

  test("throws not_found with the sign-in hint when none is given and none exists", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)
    const error = await failure(() => pickLabel(state, undefined))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect((error as Error).message).toBe("No Discord account is signed in yet; sign one in first.")
  })

  test("throws invalid_argument listing the labels when several exist", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "alpha"), { recursive: true })
    mkdirSync(join(state, "beta"), { recursive: true })
    const error = await failure(() => pickLabel(state, undefined))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toBe(
      "Several Discord accounts are signed in; name one with `account`: alpha, beta.",
    )
  })
})

describe("ensureLabelDir", () => {
  test("creates stateDir and the label directory with mode 0700", async () => {
    const state = join(tempDir, "sub", "state")
    const paths = await ensureLabelDir(state, "work")
    expect(statSync(state).mode & 0o777).toBe(0o700)
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700)
  })

  test("fixes existing 0755 directories to 0700", async () => {
    const state = join(tempDir, "state")
    const labelDir = join(state, "work")
    mkdirSync(labelDir, { recursive: true, mode: 0o755 })
    chmodSync(state, 0o755)
    chmodSync(labelDir, 0o755)

    await ensureLabelDir(state, "work")

    expect(statSync(state).mode & 0o777).toBe(0o700)
    expect(statSync(labelDir).mode & 0o777).toBe(0o700)
  })

  test("refuses a symlink as the label directory", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)
    const realDir = join(tempDir, "real")
    mkdirSync(realDir)
    symlinkSync(realDir, join(state, "link_label"))

    const error = await failure(() => ensureLabelDir(state, "link_label"))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })
})
