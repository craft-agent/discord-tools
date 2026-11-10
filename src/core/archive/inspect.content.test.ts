import { afterEach, describe, expect, test } from "bun:test"
import { Scratch } from "./archive.testing"
import { inspectTar, inspectZip } from "./inspect.testing"
import { tarBytes } from "./tar.testing"
import { zipBytes } from "./zip.testing"
import { CHUNK } from "./entry"
import { RECEIVED, inspectArchive, type InspectOptions } from "./inspect"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const STRICT: InspectOptions = { allowScripts: false, scanKeys: true }
const SCRIPTS_OFF: InspectOptions = { allowScripts: false, scanKeys: false }
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n"

const latin1 = (text: string) => Buffer.from(text, "latin1")
const PE = Buffer.alloc(0x100)
PE.write("MZ")
PE.writeUInt32LE(0x80, 0x3c)
PE.write("PE\0\0", 0x80, "latin1")
const USTAR = Buffer.alloc(512)
USTAR.write("ustar", 257)

describe("inspectArchive: what an entry's first bytes give away", () => {
  test.each([
    ["ELF", latin1("\x7fELF\x02\x01\x01"), "is a program"],
    ["Mach-O", latin1("\xcf\xfa\xed\xfe\x07"), "is a program"],
    ["fat Mach-O", latin1("\xca\xfe\xba\xbe\x00"), "is a program"],
    ["PE", PE, "is a program"],
    ["zip", zipBytes([{ name: "x", data: "x" }]), "is an archive inside the archive"],
    ["gzip", latin1("\x1f\x8b\x08\x00"), "is an archive inside the archive"],
    ["tar", USTAR, "is an archive inside the archive"],
    ["7z", latin1("7z\xbc\xaf\x27\x1c\x00\x04"), "is an archive inside the archive"],
    ["Rar", latin1("Rar!\x1a\x07\x00"), "is an archive inside the archive"],
    ["bzip2", latin1("BZh91AY"), "is an archive inside the archive"],
    ["xz", latin1("\xfd7zXZ\x00\x00"), "is an archive inside the archive"],
  ])("refuses %s bytes under a plain name, in a zip and in a tar", async (_label, bytes, refusal) => {
    await expect(inspectZip(scratch, [{ name: "notes.txt", data: bytes }])).rejects.toThrow(`notes.txt ${refusal}`)
    await expect(inspectTar(scratch, [{ name: "notes.txt", data: bytes }])).rejects.toThrow(`notes.txt ${refusal}`)
  })

  test("looks at the first bytes of deflated data too", async () => {
    const refused = inspectZip(scratch, [
      { name: "notes.txt", data: Buffer.concat([latin1("\x7fELF"), Buffer.alloc(9000)]), deflate: true },
    ])
    await expect(refused).rejects.toThrow("notes.txt is a program")
  })

  test("passes text that only starts like a program or an archive", async () => {
    const report = await inspectZip(scratch, [
      { name: "a.txt", data: "MZ is a name" },
      { name: "b.txt", data: "BZh not a bzip2 file" },
      { name: "c.txt", data: "PK is not a header" },
    ])
    expect(report?.entries).toBe(3)
  })
})

describe("inspectArchive: scripts", () => {
  test("passes scripts, by name and by shebang line, when they are allowed", async () => {
    const items = [
      { name: "run.sh", data: "echo hi" },
      { name: "tool.py", data: "print(1)" },
      { name: "bin/start", data: "#!/bin/sh\necho hi\n" },
    ]
    expect((await inspectZip(scratch, items, RECEIVED))?.entries).toBe(3)
    expect((await inspectTar(scratch, items, RECEIVED))?.entries).toBe(3)
  })

  test("refuses scripts by name and by shebang line when they are not", async () => {
    await expect(inspectZip(scratch, [{ name: "run.sh", data: "echo hi" }], SCRIPTS_OFF)).rejects.toThrow(
      "run.sh is an archive or a program",
    )
    await expect(inspectZip(scratch, [{ name: "start", data: "#!/bin/sh\n" }], SCRIPTS_OFF)).rejects.toThrow(
      "start is a script",
    )
    await expect(inspectTar(scratch, [{ name: "start", data: "#!/bin/sh\n" }], SCRIPTS_OFF)).rejects.toThrow(
      "start is a script",
    )
  })

  test("refuses installers and programs by name even when scripts are allowed", async () => {
    for (const name of ["setup.msi", "run.command", "tool.dll", "app.bin"]) {
      await expect(inspectZip(scratch, [{ name, data: "x" }], RECEIVED)).rejects.toThrow("is an archive or a program")
    }
  })
})

describe("inspectArchive: keys and secrets", () => {
  test("passes secret-looking names and private keys when keys are not scanned", async () => {
    const report = await inspectZip(scratch, [
      { name: ".env", data: "TOKEN=abc" },
      { name: ".ssh/id_rsa", data: KEY },
      { name: "notes.txt", data: KEY },
    ])
    expect(report?.entries).toBe(3)
  })

  test.each([
    ["RSA", KEY],
    ["PKCS#8", "-----BEGIN PRIVATE KEY-----\nMIIB\n"],
    ["OpenSSH", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n"],
    ["EC with other text", `some text first\n-----BEGIN EC PRIVATE KEY-----\n`],
  ])("refuses a %s private key when keys are scanned", async (_label, data) => {
    await expect(inspectZip(scratch, [{ name: "notes.txt", data }], STRICT)).rejects.toThrow(
      "notes.txt holds a private key",
    )
    await expect(inspectTar(scratch, [{ name: "notes.txt", data }], STRICT)).rejects.toThrow(
      "notes.txt holds a private key",
    )
  })

  test("passes a public key and a certificate when keys are scanned", async () => {
    const data = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----BEGIN CERTIFICATE-----\n"
    expect((await inspectZip(scratch, [{ name: "notes.txt", data }], STRICT))?.entries).toBe(1)
  })

  test("finds a key header split across two pieces of data", async () => {
    const header = "-----BEGIN RSA PRIVATE KEY-----"
    for (const cut of [1, 10, 20, header.length - 1]) {
      const data = Buffer.concat([Buffer.alloc(CHUNK - cut, 0x61), Buffer.from(`${header}\nMIIB\n`)])
      const refused = inspectZip(scratch, [{ name: "notes.txt", data }], STRICT)
      await expect(refused).rejects.toThrow("notes.txt holds a private key")
    }
  })

  test("finds a key in the second tar entry too", async () => {
    const path = await scratch.write(
      "a.tar",
      tarBytes([
        { name: "a.txt", data: "a" },
        { name: "b.txt", data: KEY },
      ]),
    )
    await expect(inspectArchive(path, "a.tar", STRICT)).rejects.toThrow("b.txt holds a private key")
  })
})
