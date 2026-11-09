import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { MessageFolder } from "./publish"

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A message folder that is not made yet, and a staged file holding `bytes`. */
async function setUp(bytes = "data") {
  root = await mkdtemp(join(tmpdir(), "dsc-publish-"))
  const staged = join(root, "staged")
  await writeFile(staged, bytes, { mode: 0o600 })
  const dir = join(root, "message")
  return { root, dir, staged, folder: new MessageFolder(dir) }
}

const names = async (dir: string) => (await readdir(dir)).sort()

describe("publishing a file", () => {
  test("makes the folder with the first file, not before, and copies the bytes with the right modes", async () => {
    const { dir, staged, folder } = await setUp("hello")
    await folder.check()
    expect(await readdir(join(dir, "..")).then((n) => n.includes("message"))).toBe(false)
    expect(await folder.publish(staged, "a.txt")).toEqual({ status: "saved", path: join(dir, "a.txt") })
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello")
    expect((await stat(join(dir, "a.txt"))).mode & 0o777).toBe(0o644)
    expect((await stat(dir)).mode & 0o777).toBe(0o755)
    expect(await names(dir)).toEqual(["a.txt"])
    expect((await stat(join(dir, "a.txt"))).nlink).toBe(1)
    expect(await readFile(staged, "utf8")).toBe("hello")
  })

  test("leaves the mode of a folder that is there as it is", async () => {
    const { dir, staged, folder } = await setUp()
    await mkdir(dir, { mode: 0o700 })
    await folder.publish(staged, "a.txt")
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  test("never replaces a file, and a file with other bytes makes the next number", async () => {
    const { dir, staged, folder } = await setUp("new")
    await mkdir(dir)
    await writeFile(join(dir, "a.txt"), "old")
    await writeFile(join(dir, "a-2.txt"), "older")
    expect(await folder.publish(staged, "a.txt")).toEqual({ status: "saved", path: join(dir, "a-3.txt") })
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("old")
    expect(await readFile(join(dir, "a-2.txt"), "utf8")).toBe("older")
    expect(await names(dir)).toEqual(["a-2.txt", "a-3.txt", "a.txt"])
  })

  test("a file with the same bytes is already there", async () => {
    const { dir, staged, folder } = await setUp("same")
    await mkdir(dir)
    await writeFile(join(dir, "a.txt"), "same", { mode: 0o600 })
    expect(await folder.publish(staged, "a.txt")).toEqual({ status: "already", path: join(dir, "a.txt") })
    expect((await stat(join(dir, "a.txt"))).mode & 0o777).toBe(0o600)
    expect(await names(dir)).toEqual(["a.txt"])
  })

  test("a link with the same bytes behind it is not the file, so it is never followed or counted", async () => {
    const { dir, root, staged, folder } = await setUp("same")
    await mkdir(dir)
    await writeFile(join(root, "target"), "same")
    await symlink(join(root, "target"), join(dir, "a.txt"))
    expect(await folder.publish(staged, "a.txt")).toEqual({ status: "saved", path: join(dir, "a-2.txt") })
    expect(await readFile(join(root, "target"), "utf8")).toBe("same")
  })

  test("a dangling link is no place for a file either", async () => {
    const { dir, root, staged, folder } = await setUp()
    await mkdir(dir)
    await symlink(join(root, "nowhere"), join(dir, "a.txt"))
    expect((await folder.publish(staged, "a.txt")).path).toBe(join(dir, "a-2.txt"))
    expect(await readdir(root)).not.toContain("nowhere")
  })

  test("a name taken earlier by this folder is taken whatever its case, and bytes do not matter", async () => {
    const { dir, staged, folder } = await setUp("same")
    await folder.publish(staged, "Photo.PNG")
    expect((await folder.publish(staged, "photo.png")).path).toBe(join(dir, "photo-2.png"))
    expect((await folder.publish(staged, "PHOTO.png")).path).toBe(join(dir, "PHOTO-3.png"))
  })

  test("gives up after 99 files of one name", async () => {
    const { dir, staged, folder } = await setUp("x")
    await mkdir(dir)
    await writeFile(join(dir, "a.txt"), "y")
    for (let n = 2; n <= 99; n++) await writeFile(join(dir, `a-${n}.txt`), "y")
    await expect(folder.publish(staged, "a.txt")).rejects.toThrow("99 files")
    expect((await names(dir)).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("leaves no temporary file when the staged file is missing", async () => {
    const { dir, folder } = await setUp()
    await expect(folder.publish(join(dir, "..", "nope"), "a.txt")).rejects.toThrow()
    expect(await names(dir)).toEqual([])
  })
})

describe("a file system without hard links", () => {
  const refusing = (code: string) => async () => {
    throw Object.assign(new Error(code), { code })
  }

  test.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"])(
    "%s: the file is copied, with its mode",
    async (code) => {
      const { dir, staged } = await setUp("hello")
      const folder = new MessageFolder(dir, refusing(code))
      expect(await folder.publish(staged, "a.txt")).toEqual({ status: "saved", path: join(dir, "a.txt") })
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello")
      expect((await stat(join(dir, "a.txt"))).mode & 0o777).toBe(0o644)
      expect(await names(dir)).toEqual(["a.txt"])
    },
  )

  test("a taken name is still never replaced: the same bytes are already there, others are numbered", async () => {
    const { dir, staged } = await setUp("same")
    await mkdir(dir)
    await writeFile(join(dir, "a.txt"), "same")
    await writeFile(join(dir, "b.txt"), "other")
    const folder = new MessageFolder(dir, refusing("EPERM"))
    expect(await folder.publish(staged, "a.txt")).toEqual({ status: "already", path: join(dir, "a.txt") })
    expect(await folder.publish(staged, "b.txt")).toEqual({ status: "saved", path: join(dir, "b-2.txt") })
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("other")
    expect(await names(dir)).toEqual(["a.txt", "b-2.txt", "b.txt"])
  })

  test("any other error of the link is not hidden by a copy", async () => {
    const { dir, staged } = await setUp()
    await expect(new MessageFolder(dir, refusing("EACCES")).publish(staged, "a.txt")).rejects.toThrow("EACCES")
    expect(await names(dir)).toEqual([])
  })
})

describe("the folder", () => {
  test("a link or a file in its place is refused as invalid_argument", async () => {
    const { dir, root, staged, folder } = await setUp()
    await mkdir(join(root, "real"))
    await symlink(join(root, "real"), dir)
    for (const call of [() => folder.check(), () => folder.publish(staged, "a.txt")]) {
      expect(await failure(call())).toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("not a plain folder"),
      })
    }
    await rm(dir)
    await writeFile(dir, "x")
    expect(await failure(folder.check())).toMatchObject({ code: "invalid_argument" })
    expect(await readdir(join(root, "real"))).toEqual([])
  })

  test("a folder that is not there yet passes the check", async () => {
    const { folder } = await setUp()
    await folder.check()
  })
})
