import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import type { ToolContext } from "../tool"
import { exportsDir, writeExport } from "./private-export"

let root: string
let ctx: ToolContext
let umask: number | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsc-export-"))
  await mkdir(join(root, "state"))
  ctx = { cwd: root, stateDir: join(root, "state"), downloadDir: join(root, "downloads"), downloadMaxMb: 1 }
})

afterEach(async () => {
  if (umask !== undefined) process.umask(umask)
  umask = undefined
  await rm(root, { recursive: true, force: true })
})

/** Runs the following code under a umask that would take the owner's write bit away from anything made with a mode. */
const strictUmask = () => {
  umask = process.umask(0o277)
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777
const names = async (dir: string) => (await readdir(dir)).sort()

describe("exportsDir", () => {
  test("makes <download_dir>/exports with mode 0700, whatever the umask", async () => {
    await mkdir(ctx.downloadDir!)
    strictUmask()
    const dir = await exportsDir(ctx)
    expect(dir).toBe(join(root, "downloads", "exports"))
    expect(await modeOf(dir)).toBe(0o700)
  })

  test("makes the download directory too, as for received files", async () => {
    const dir = await exportsDir(ctx)
    expect(dir).toBe(join(root, "downloads", "exports"))
    expect(await modeOf(join(root, "downloads"))).toBe(0o755)
  })

  test("a plain folder that is there is made private, and what is in it stays", async () => {
    await mkdir(join(root, "downloads", "exports"), { recursive: true, mode: 0o755 })
    await chmod(join(root, "downloads", "exports"), 0o755)
    await writeFile(join(root, "downloads", "exports", "old.md"), "old", { mode: 0o644 })
    const dir = await exportsDir(ctx)
    expect(await modeOf(dir)).toBe(0o700)
    expect(await names(dir)).toEqual(["old.md"])
    expect(await modeOf(join(dir, "old.md"))).toBe(0o644)
  })

  test("a link in its place is refused and what it points to is left alone", async () => {
    const elsewhere = join(root, "elsewhere")
    await mkdir(elsewhere, { mode: 0o755 })
    await chmod(elsewhere, 0o755)
    await mkdir(join(root, "downloads"))
    await symlink(elsewhere, join(root, "downloads", "exports"))
    expect(await failure(exportsDir(ctx))).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("not a plain folder"),
    })
    expect(await modeOf(elsewhere)).toBe(0o755)
    expect(await names(elsewhere)).toEqual([])
  })

  test("a dangling link or a file in its place is refused", async () => {
    await mkdir(join(root, "downloads"))
    const path = join(root, "downloads", "exports")
    await symlink(join(root, "nowhere"), path)
    expect(await failure(exportsDir(ctx))).toMatchObject({ code: "invalid_argument" })
    await rm(path)
    await writeFile(path, "x")
    expect(await failure(exportsDir(ctx))).toMatchObject({ code: "invalid_argument" })
    expect(await readFile(path, "utf8")).toBe("x")
  })

  test.each([
    ["the state directory", () => join(root, "state")],
    ["inside the state directory", () => join(root, "state", "downloads")],
    ["a directory holding it", () => root],
  ])("a download directory that is %s is refused and nothing is made", async (_, downloadDir) => {
    const before = await names(join(root, "state"))
    expect(await failure(exportsDir({ ...ctx, downloadDir: downloadDir() }))).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("state directory"),
    })
    expect(await names(join(root, "state"))).toEqual(before)
    expect(await names(root)).not.toContain("exports")
  })

  test("a call without a download directory is a bug of the entry point", async () => {
    expect(await failure(exportsDir({ ...ctx, downloadDir: undefined }))).toMatchObject({ code: "internal_error" })
  })
})

describe("writeExport", () => {
  let folder: string
  beforeEach(async () => {
    folder = join(root, "exports")
    await mkdir(folder)
  })

  test("writes the whole content as a file of mode 0600, whatever the umask, and leaves nothing else", async () => {
    strictUmask()
    const content = `${"line ✓\u2028\n".repeat(100_000)}end\n`
    const path = await writeExport(folder, "a.md", content)
    expect(path).toBe(join(folder, "a.md"))
    expect(await readFile(path, "utf8")).toBe(content)
    expect(await modeOf(path)).toBe(0o600)
    expect((await stat(path)).nlink).toBe(1)
    expect(await names(folder)).toEqual(["a.md"])
  })

  test("a name already taken gets a number and the file there is never touched", async () => {
    await writeFile(join(folder, "a.md"), "old", { mode: 0o644 })
    await writeFile(join(folder, "a-2.md"), "older")
    expect(await writeExport(folder, "a.md", "new")).toBe(join(folder, "a-3.md"))
    expect(await writeExport(folder, "a.md", "newer")).toBe(join(folder, "a-4.md"))
    expect(await readFile(join(folder, "a.md"), "utf8")).toBe("old")
    expect(await modeOf(join(folder, "a.md"))).toBe(0o644)
    expect(await readFile(join(folder, "a-2.md"), "utf8")).toBe("older")
    expect(await names(folder)).toEqual(["a-2.md", "a-3.md", "a-4.md", "a.md"])
  })

  test("a link at the name is not followed, even a dangling one, and a folder is no place for a file", async () => {
    await writeFile(join(root, "target"), "keep")
    await symlink(join(root, "target"), join(folder, "a.md"))
    await symlink(join(root, "nowhere"), join(folder, "a-2.md"))
    await mkdir(join(folder, "a-3.md"))
    expect(await writeExport(folder, "a.md", "new")).toBe(join(folder, "a-4.md"))
    expect(await readFile(join(root, "target"), "utf8")).toBe("keep")
    expect(await names(root)).not.toContain("nowhere")
  })

  test("gives up after 99 files of one name and leaves no temporary file", async () => {
    await writeFile(join(folder, "a.md"), "y")
    for (let n = 2; n <= 99; n++) await writeFile(join(folder, `a-${n}.md`), "y")
    await expect(writeExport(folder, "a.md", "x")).rejects.toThrow("99 files")
    expect((await names(folder)).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("removes the temporary file when the link fails for another reason", async () => {
    const refusing = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" })
    }
    await expect(writeExport(folder, "a.md", "x", refusing)).rejects.toThrow("EACCES")
    expect(await names(folder)).toEqual([])
  })

  test("fails and leaves nothing when the folder is not there", async () => {
    await expect(writeExport(join(root, "missing"), "a.md", "x")).rejects.toThrow()
    expect(await names(root)).not.toContain("missing")
  })

  describe("on a file system without hard links", () => {
    const refusing = (code: string) => async () => {
      throw Object.assign(new Error(code), { code })
    }

    test.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"])(
      "%s: the file is copied, with its mode",
      async (code) => {
        strictUmask()
        const path = await writeExport(folder, "a.md", "hello", refusing(code))
        expect(path).toBe(join(folder, "a.md"))
        expect(await readFile(path, "utf8")).toBe("hello")
        expect(await modeOf(path)).toBe(0o600)
        expect(await names(folder)).toEqual(["a.md"])
      },
    )

    test("a taken name is still never replaced", async () => {
      await writeFile(join(folder, "a.md"), "old")
      await symlink(join(root, "nowhere"), join(folder, "a-2.md"))
      expect(await writeExport(folder, "a.md", "new", refusing("EPERM"))).toBe(join(folder, "a-3.md"))
      expect(await readFile(join(folder, "a.md"), "utf8")).toBe("old")
      expect(await names(root)).not.toContain("nowhere")
      expect((await names(folder)).filter((name) => name.startsWith("."))).toEqual([])
    })
  })

  test.each(["../a.md", "sub/a.md", ".part-x", ""])("%j is not a name for an export", async (name) => {
    expect(await failure(writeExport(folder, name, "x"))).toMatchObject({ code: "internal_error" })
    expect(await names(folder)).toEqual([])
    expect(await names(root)).toEqual(["exports", "state"])
  })
})
