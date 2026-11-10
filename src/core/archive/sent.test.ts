import { afterEach, describe, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { Scratch } from "./archive.testing"
import { CHUNK } from "./entry"
import { ArchiveRefused } from "./inspect"
import { checkSentFile } from "./sent"
import { zipBytes } from "./zip.testing"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n"
const latin1 = (text: string) => Buffer.from(text, "latin1")
const ELF = latin1("\x7fELF\x02\x01\x01\x00")

/** Checks `bytes` saved as a copy, as the file whose real path is `parts`. */
async function check(parts: string[], bytes: Uint8Array | string) {
  return checkSentFile(await scratch.write("copy", bytes), parts)
}

describe("checkSentFile: names", () => {
  test("passes a plain text file and reports no archive", async () => {
    expect(await check(["home", "me", "notes.txt"], "hello")).toEqual({})
  })

  test("passes an empty file under a plain name", async () => {
    expect(await check(["notes.txt"], "")).toEqual({})
  })

  test.each([
    [[".env"], "it is named like a credential, key or database"],
    [["home", "id_ed25519"], "it is named like a credential, key or database"],
    [["my-secret.txt"], "it is named like a credential, key or database"],
    [["server.pem"], "it is named like a credential, key or database"],
    [["home", ".aws", "notes.txt"], "it is in a .aws folder, which holds credentials"],
    [["home", ".SSH", "id_rsa"], "it is in a .SSH folder, which holds credentials"],
  ])("refuses %j", async (parts, reason) => {
    await expect(check(parts, "hello")).rejects.toThrow(reason)
    await expect(check(parts, "hello")).rejects.toBeInstanceOf(ArchiveRefused)
  })

  test.each(["setup.exe", "tool.dmg", "lib.so", "app.bin", "setup.msi", "x.rar", "x.7z", "x.tar.bz2", "x.tar.xz"])(
    "refuses %s by name",
    async (name) => {
      await expect(check(["home", name], "hello")).rejects.toThrow(
        "it is a program, an installer or an archive this cannot check",
      )
    },
  )

  test("passes scripts by name", async () => {
    expect(await check(["run.sh"], "echo hi")).toEqual({})
    expect(await check(["tool.py"], "print(1)")).toEqual({})
  })

  test("judges secrets before programs", async () => {
    await expect(check([".ssh", "setup.exe"], "x")).rejects.toThrow("it is in a .ssh folder")
  })
})

describe("checkSentFile: bytes", () => {
  test("passes a file that starts with a shebang line, whatever its name", async () => {
    expect(await check(["notes.txt"], "#!/bin/sh\necho hi\n")).toEqual({})
  })

  test.each([
    ["ELF", ELF],
    ["Mach-O", latin1("\xcf\xfa\xed\xfe\x07")],
    ["a program in a longer file", Buffer.concat([ELF, Buffer.alloc(9000)])],
  ])("refuses %s bytes under a picture's name", async (_label, bytes) => {
    await expect(check(["photo.png"], bytes)).rejects.toThrow("its content is a program")
  })

  test("refuses an archive whatever the name says", async () => {
    const zip = zipBytes([{ name: "a.txt", data: "a" }])
    await expect(check(["notes.txt"], zip)).rejects.toThrow("its content is an archive, whatever the name says")
    await expect(check(["data.bin"], zip)).rejects.toThrow("it is a program, an installer or an archive")
    await expect(check(["photo.png"], latin1("Rar!\x1a\x07\x00"))).rejects.toThrow("its content is an archive")
  })

  test("passes text that only starts like a program or an archive", async () => {
    expect(await check(["a.txt"], "MZ is a name")).toEqual({})
    expect(await check(["b.txt"], "PK is not a header")).toEqual({})
  })

  test("refuses a private key in a file with a plain name", async () => {
    await expect(check(["notes.txt"], `some text\n${KEY}`)).rejects.toThrow("it holds a private key")
  })

  test("passes a public key and a certificate", async () => {
    expect(await check(["notes.txt"], "-----BEGIN PUBLIC KEY-----\n-----BEGIN CERTIFICATE-----\n")).toEqual({})
  })

  test("finds a key header split across two pieces of the read", async () => {
    const header = "-----BEGIN RSA PRIVATE KEY-----"
    for (const cut of [1, 10, 20, header.length - 1]) {
      const bytes = Buffer.concat([Buffer.alloc(CHUNK - cut, 0x61), Buffer.from(`${header}\nMIIB\n`)])
      await expect(check(["notes.txt"], bytes)).rejects.toThrow("it holds a private key")
    }
  })

  test("finds a key past the first piece of a long file", async () => {
    const bytes = Buffer.concat([Buffer.alloc(3 * CHUNK, 0x61), Buffer.from(KEY)])
    await expect(check(["notes.txt"], bytes)).rejects.toThrow("it holds a private key")
  })
})

describe("checkSentFile: the copy and the signal", () => {
  test("rejects with the AbortError of an aborted signal", async () => {
    const path = await scratch.write("copy", "hello")
    const controller = new AbortController()
    controller.abort()
    await expect(checkSentFile(path, ["notes.txt"], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  test("refuses a link at the path and a folder instead of a file", async () => {
    const target = await scratch.write("target", "hello")
    const link = await scratch.path("link")
    await symlink(target, link)
    await expect(checkSentFile(link, ["notes.txt"])).rejects.toThrow("it is not a regular file")
    await expect(checkSentFile(await scratch.path("."), ["notes.txt"])).rejects.toThrow("it is not a regular file")
  })

  test("leaves a missing file to the caller", async () => {
    const error = await checkSentFile(await scratch.path("absent"), ["notes.txt"]).catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(ArchiveRefused)
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
  })
})
