import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { renameSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, readFile, stat, symlink, utimes } from "node:fs/promises"
import { join } from "node:path"
import { zipBytes } from "../archive/zip.testing"
import { hashFile } from "./outgoing"
import { createOutgoingFixture, type OutgoingFixture } from "./outgoing.testing"

let f: OutgoingFixture
beforeEach(async () => {
  f = await createOutgoingFixture()
})
afterEach(() => f.dispose())

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

describe("prepareOutgoing: copies", () => {
  test("copies the bytes into a private folder, 0600, with the size and hash of the copy", async () => {
    const source = await f.write("work/report.txt", "the quarterly numbers")
    const { files } = await f.prepare([source])
    expect(files).toHaveLength(1)
    const [file] = files
    expect(file).toMatchObject({
      given: source,
      source,
      name: "report.txt",
      size: 21,
      sha256: sha256("the quarterly numbers"),
    })
    expect(file.copy).not.toBe(source)
    expect(file.copy.startsWith(f.staging)).toBe(true)
    expect(await readFile(file.copy, "utf8")).toBe("the quarterly numbers")
    expect((await stat(file.copy)).mode & 0o777).toBe(0o600)
    expect((await stat(join(file.copy, ".."))).mode & 0o777).toBe(0o700)
    expect(file.archive).toBeUndefined()
  })

  test("copies a file larger than one chunk whole", async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7)
    const source = await f.write("work/big.dat", data)
    const [file] = (await f.prepare([source], { maxBytes: 4 * 1024 * 1024 })).files
    expect(file.size).toBe(data.length)
    expect(file.sha256).toBe(sha256(data))
    expect(Buffer.compare(await readFile(file.copy), data)).toBe(0)
  })

  test("keeps the order, one numbered copy each, and cleans each name", async () => {
    await f.write("work/my report (1).txt", "a")
    await f.write("work/b.txt", "b")
    const { files } = await f.prepare(["my report (1).txt", "b.txt"])
    expect(files.map((file) => file.name)).toEqual(["my report _1_.txt", "b.txt"])
    expect(files.map((file) => file.copy.split("/").at(-1))).toEqual(["01", "02"])
    expect(files.map((file) => file.given)).toEqual(["my report (1).txt", "b.txt"])
  })

  test("resolves a relative path against cwd, nested paths too", async () => {
    await f.write("work/sub/deeper/a.txt", "x")
    const [file] = (await f.prepare(["sub/deeper/a.txt"])).files
    expect(file.source).toBe(join(f.work, "sub", "deeper", "a.txt"))
  })

  test("sends from any of the directories", async () => {
    const mine = await f.write("work/a.txt", "a")
    const theirs = await f.write("other/b.txt", "b")
    const { files } = await f.prepare([mine, theirs], { dirs: [f.work, f.other] })
    expect(files.map((file) => file.name)).toEqual(["a.txt", "b.txt"])
  })

  test("a link that stays inside is allowed and the name comes from the real path", async () => {
    const real = await f.write("work/real-name.txt", "data")
    await symlink(real, join(f.work, "alias.txt"))
    const [file] = (await f.prepare(["alias.txt"])).files
    expect(file).toMatchObject({ given: "alias.txt", source: real, name: "real-name.txt" })
  })

  test("returns the listing of an archive and a script passes", async () => {
    const zip = await f.write("work/pack.zip", zipBytes([{ name: "src/main.py", data: "print(1)" }]))
    await f.write("work/run.sh", "echo hi")
    const { files } = await f.prepare([zip, "run.sh"])
    expect(files[0].archive).toMatchObject({ format: "zip", entries: 1, names: ["src/main.py"] })
    expect(files[1].archive).toBeUndefined()
  })

  test("a file at exactly the cap passes", async () => {
    const source = await f.write("work/edge.txt", "x".repeat(4096))
    expect((await f.prepare([source])).files[0].size).toBe(4096)
  })
})

describe("prepareOutgoing: the copies' life", () => {
  test("close removes the folder and the copies, and may be called twice", async () => {
    const source = await f.write("work/a.txt", "a")
    const outgoing = await f.prepare([source])
    expect(await f.staged()).toHaveLength(1)
    await outgoing.close()
    expect(await f.staged()).toEqual([])
    await outgoing.close()
  })

  test("prunes leftovers older than a day and keeps recent ones", async () => {
    const old = join(f.staging, "0".repeat(16))
    const recent = join(f.staging, "1".repeat(16))
    await mkdir(old, { recursive: true })
    await mkdir(recent, { recursive: true })
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(old, twoDaysAgo, twoDaysAgo)
    const outgoing = await f.prepare([await f.write("work/a.txt", "a")])
    const staged = await f.staged()
    expect(staged).toContain("1".repeat(16))
    expect(staged).not.toContain("0".repeat(16))
    await outgoing.close()
    expect(await f.staged()).toEqual(["1".repeat(16)])
  })

  test("the copy stays as it was when the source changes afterwards", async () => {
    const source = await f.write("work/a.txt", "before")
    const [file] = (await f.prepare([source])).files
    await f.write("work/a.txt", "after!")
    expect(await readFile(file.copy, "utf8")).toBe("before")
    expect(file.sha256).toBe(sha256("before"))
  })
})

describe("prepareOutgoing: a file that changes between the check and the copy", () => {
  /** Runs `change` when the call reaches the staging step, after every file is checked and before any is copied. */
  const changing = (change: () => void) => () => {
    change()
    return Date.now()
  }

  test("swapped for another file", async () => {
    const source = await f.write("work/a.txt", "original")
    const other = await f.write("work/b.txt", "something else")
    const error = await f.refusal(f.prepare([source], { now: changing(() => renameSync(other, source)) }))
    expect(error.message).toContain("changed before it could be copied")
    expect(error.details).toEqual({ file: source })
    expect(await f.staged()).toEqual([])
  })

  test("replaced by a link", async () => {
    const source = await f.write("work/a.txt", "original")
    const target = await f.write("work/b.txt", "something else")
    const swap = changing(() => {
      renameSync(source, `${source}.gone`)
      symlinkSync(target, source)
    })
    const error = await f.refusal(f.prepare([source], { now: swap }))
    expect(error.message).toContain("changed before it could be copied")
    expect(await f.staged()).toEqual([])
  })

  test("grown past the cap", async () => {
    const source = await f.write("work/a.txt", "small")
    const error = await f.refusal(f.prepare([source], { now: changing(() => writeFileSync(source, "x".repeat(5000))) }))
    expect(error.message).toContain("grew past")
    expect(error.details).toEqual({ file: source })
    expect(await f.staged()).toEqual([])
  })

  test("emptied", async () => {
    const source = await f.write("work/a.txt", "small")
    const error = await f.refusal(f.prepare([source], { now: changing(() => writeFileSync(source, "")) }))
    expect(error.message).toContain("is empty")
    expect(await f.staged()).toEqual([])
  })
})

describe("hashFile", () => {
  test("matches the hash of a copy", async () => {
    const source = await f.write("work/a.txt", "some bytes")
    const [file] = (await f.prepare([source])).files
    expect(await hashFile(source)).toBe(file.sha256)
    expect(await hashFile(file.copy)).toBe(file.sha256)
  })

  test("refuses a link at the path, a folder and a missing file", async () => {
    const real = await f.write("work/a.txt", "x")
    await symlink(real, join(f.work, "link.txt"))
    const link = (await f.refusal(hashFile(join(f.work, "link.txt")))).message
    expect(link).toContain("is not a regular file")
    expect((await f.refusal(hashFile(f.work))).message).toContain("is not a regular file")
    expect((await f.refusal(hashFile(join(f.work, "missing")))).message).toContain("no such file")
  })

  test("stops at a cancelled signal", async () => {
    const real = await f.write("work/a.txt", "x")
    await expect(hashFile(real, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" })
  })
})
