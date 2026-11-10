import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { zipBytes } from "../archive/zip.testing"
import { createOutgoingFixture, MAX_BYTES, type OutgoingFixture } from "./outgoing.testing"

let f: OutgoingFixture
beforeEach(async () => {
  f = await createOutgoingFixture()
})
afterEach(() => f.dispose())

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n"

/** Refuses `paths` as `invalid_argument` with the message and the file as given, leaving nothing staged. */
async function expectRefused(paths: string[], message: string, file = paths[0], options = {}) {
  const error = await f.refusal(f.prepare(paths, options))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain(message)
  expect(error.message).not.toContain("\n")
  expect(error.details).toEqual({ file })
  expect(await f.staged()).toEqual([])
}

describe("prepareOutgoing: the list", () => {
  test("refuses no file and more than ten", async () => {
    await f.write("work/a.txt")
    expect((await f.refusal(f.prepare([]))).message).toBe("A message carries 1 to 10 files; got 0.")
    expect((await f.refusal(f.prepare(Array(11).fill("a.txt")))).message).toBe(
      "A message carries 1 to 10 files; got 11.",
    )
    expect(await f.staged()).toEqual([])
  })

  test("accepts ten", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`)
    for (const name of names) await f.write(`work/${name}`, name)
    expect((await f.prepare(names)).files).toHaveLength(10)
  })
})

describe("prepareOutgoing: the send directories", () => {
  const refused = async (dirs: string[], message: string) => {
    await f.write("work/a.txt")
    const error = await f.refusal(f.prepare(["a.txt"], { dirs }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(await f.staged()).toEqual([])
  }

  test("refuses a missing directory and a file given as one", async () => {
    await refused([join(f.root, "missing")], "which is not a folder")
    await refused([await f.write("work/a.txt")], "which is not a folder")
  })

  test("refuses the state directory, one that holds it and one inside it", async () => {
    const own = "which holds or sits in the tools' own state; nothing is sent from it"
    await refused([f.state], own)
    await refused([f.root], own)
    await mkdir(join(f.state, "label"), { recursive: true })
    await refused([join(f.state, "label")], own)
  })

  test("refuses the install directory, one that holds it and one inside it", async () => {
    const own = "which holds or sits in the tools' own state; nothing is sent from it"
    const install = join(f.other, "install")
    await mkdir(join(install, "dist"), { recursive: true })
    for (const dir of [install, f.other, join(install, "dist")]) {
      const error = await f.refusal(
        f.prepare(["a.txt"], { dirs: [dir], privateDirs: { stateDir: f.state, ownDir: install } }),
      )
      expect(error.message).toContain(own)
    }
  })

  test("judges a directory by real path", async () => {
    await symlink(f.state, join(f.work, "state-link"))
    await refused([join(f.work, "state-link")], "which holds or sits in the tools' own state")
  })
})

describe("prepareOutgoing: the files", () => {
  test("refuses a missing file", async () => {
    await expectRefused(["nothing.txt"], "nothing.txt: no such file")
  })

  test("refuses a file outside every directory, absolute or through ..", async () => {
    const outside = await f.write("other/b.txt")
    await expectRefused([outside], "is outside the folders files may be sent from")
    await expectRefused(["../other/b.txt"], "is outside the folders files may be sent from")
  })

  test("a path that merely starts like the directory is outside", async () => {
    await f.write("work-2/a.txt")
    await expectRefused(["../work-2/a.txt"], "is outside the folders files may be sent from")
  })

  test("refuses a link inside the directory that leads outside, by real path", async () => {
    const outside = await f.write("other/b.txt")
    await symlink(outside, join(f.work, "escape.txt"))
    await expectRefused(["escape.txt"], "is outside the folders files may be sent from")
    await symlink(f.other, join(f.work, "escape-dir"))
    await expectRefused(["escape-dir/b.txt"], "is outside the folders files may be sent from")
  })

  test("refuses a folder", async () => {
    await mkdir(join(f.work, "sub"))
    await expectRefused(["sub"], "sub is not a regular file")
  })

  test("refuses an empty file and one over the cap", async () => {
    await f.write("work/empty.txt", "")
    await expectRefused(["empty.txt"], "empty.txt is empty")
    const mb = 1024 * 1024
    await f.write("work/big.txt", Buffer.alloc(2 * mb + 1, 1))
    await expectRefused(["big.txt"], "big.txt is larger than 2 MB", "big.txt", { maxBytes: 2 * mb })
    await f.write("work/limit.txt", "x".repeat(MAX_BYTES + 1))
    await expectRefused(["limit.txt"], "limit.txt is larger than", "limit.txt")
  })

  test("refuses the same file twice, also through a link", async () => {
    await f.write("work/a.txt")
    await symlink(join(f.work, "a.txt"), join(f.work, "same.txt"))
    await expectRefused(["a.txt", "a.txt"], "a.txt is listed twice")
    await expectRefused(["a.txt", "same.txt"], "same.txt is listed twice", "same.txt")
  })

  test("one refused file refuses the send, and the later ones are not copied", async () => {
    await f.write("work/a.txt")
    await f.write("work/.env", "TOKEN=abc")
    await expectRefused(["a.txt", ".env"], ".env is not sent", ".env")
  })
})

describe("prepareOutgoing: what would leak or run", () => {
  test.each([
    [".env", "TOKEN=abc", "it is named like a credential"],
    ["id_ed25519", "x", "it is named like a credential"],
    [".ssh/config", "Host x", "it is in a .ssh folder"],
    ["notes.txt", KEY, "it holds a private key"],
    ["setup.exe", "x", "it is a program, an installer or an archive"],
    ["tool", "\x7fELF\x02\x01\x01\x00", "its content is a program"],
    ["old.rar", "x", "it is a program, an installer or an archive"],
  ])("refuses %s", async (name, data, reason) => {
    await f.write(`work/${name}`, data)
    await expectRefused([name], `is not sent: ${reason}`, name)
  })

  test("refuses a zip holding .aws/credentials", async () => {
    await f.write("work/pack.zip", zipBytes([{ name: ".aws/credentials", data: "[default]" }]))
    await expectRefused(["pack.zip"], "pack.zip is not sent: .aws/credentials")
  })

  test("refuses a file under a credentials folder above the directory too", async () => {
    await f.write("hidden/.ssh/work/a.txt", "x")
    await expectRefused(["a.txt"], "a.txt is not sent: it is in a .ssh folder", "a.txt", {
      cwd: join(f.root, "hidden/.ssh/work"),
      dirs: [join(f.root, "hidden/.ssh/work")],
    })
  })
})

describe("prepareOutgoing: cancellation", () => {
  test("a signal already aborted rejects with its AbortError and leaves no copy", async () => {
    await f.write("work/a.txt")
    await expect(f.prepare(["a.txt"], { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" })
    expect(await f.staged()).toEqual([])
  })

  test("a signal aborted between files stops the call and removes the copies", async () => {
    await f.write("work/a.txt")
    await f.write("work/b.txt")
    const controller = new AbortController()
    const now = () => {
      queueMicrotask(() => controller.abort())
      return Date.now()
    }
    await expect(f.prepare(["a.txt", "b.txt"], { signal: controller.signal, now })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(await f.staged()).toEqual([])
  })
})
