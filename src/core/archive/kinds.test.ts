import { describe, expect, test } from "bun:test"
import { formatOfHead, formatOfName, kindOfHead, refusalOfFile } from "./kinds"

const latin1 = (text: string) => Buffer.from(text, "latin1")

/** A Windows executable head: "MZ", a pointer at 0x3C to the "PE" signature at 0x80. */
function portableExecutable(signature = "PE\0\0"): Buffer {
  const head = Buffer.alloc(0x100)
  head.write("MZ")
  head.writeUInt32LE(0x80, 0x3c)
  head.write(signature, 0x80, "latin1")
  return head
}

function ustar(): Buffer {
  const head = Buffer.alloc(512)
  head.write("ustar", 257)
  return head
}

describe("formatOfName", () => {
  test.each([
    ["report.zip", "zip"],
    ["REPORT.ZIP", "zip"],
    ["data.tar", "tar"],
    ["data.tar.gz", "tar.gz"],
    ["data.TGZ", "tar.gz"],
    ["a.b.tgz", "tar.gz"],
    ["data.tar.bz2", undefined],
    ["data.tar.xz", undefined],
    ["data.gz", undefined],
    ["data.rar", undefined],
    ["data.7z", undefined],
    ["zip", undefined],
    ["notes.zip.txt", undefined],
  ])("%s is %p", (name, format) => {
    expect(formatOfName(name)).toBe(format as ReturnType<typeof formatOfName>)
  })
})

describe("formatOfHead", () => {
  test("recognizes zip, gzip and ustar by their magic numbers", () => {
    expect(formatOfHead(latin1("PK\x03\x04rest"))).toBe("zip")
    expect(formatOfHead(latin1("PK\x05\x06"))).toBe("zip")
    expect(formatOfHead(latin1("\x1f\x8b\x08"))).toBe("tar.gz")
    expect(formatOfHead(ustar())).toBe("tar")
  })

  test("takes anything else, and heads too short to say, for no archive", () => {
    expect(formatOfHead(latin1("PK"))).toBeUndefined()
    expect(formatOfHead(latin1("plain text"))).toBeUndefined()
    expect(formatOfHead(new Uint8Array())).toBeUndefined()
  })
})

describe("kindOfHead", () => {
  test.each([
    ["ELF", latin1("\x7fELF\x02\x01"), "program"],
    ["Mach-O 32-bit", latin1("\xfe\xed\xfa\xce"), "program"],
    ["Mach-O 64-bit", latin1("\xcf\xfa\xed\xfe"), "program"],
    ["fat Mach-O (and Java class)", latin1("\xca\xfe\xba\xbe"), "program"],
    ["fat Mach-O, swapped", latin1("\xbe\xba\xfe\xca"), "program"],
    ["PE", portableExecutable(), "program"],
    ["7z", latin1("7z\xbc\xaf\x27\x1c\x00"), "archive"],
    ["Rar", latin1("Rar!\x1a\x07"), "archive"],
    ["bzip2", latin1("BZh9"), "archive"],
    ["xz", latin1("\xfd7zXZ\x00"), "archive"],
    ["zip", latin1("PK\x03\x04"), "archive"],
    ["gzip", latin1("\x1f\x8b\x08"), "archive"],
    ["ustar", ustar(), "archive"],
    ["shebang", latin1("#!/bin/sh\necho hi\n"), "script"],
  ])("%s", (_label, head, kind) => {
    expect(kindOfHead(head)).toBe(kind as ReturnType<typeof kindOfHead>)
  })

  test("leaves text that only starts like a program or an archive alone", () => {
    expect(kindOfHead(latin1("MZ is a good name for a cat"))).toBeUndefined()
    expect(kindOfHead(portableExecutable("NOPE"))).toBeUndefined()
    expect(kindOfHead(latin1("BZh and nothing else"))).toBeUndefined()
    expect(kindOfHead(latin1("BZh0"))).toBeUndefined()
    expect(kindOfHead(latin1("hello"))).toBeUndefined()
    expect(kindOfHead(new Uint8Array())).toBeUndefined()
  })

  test("does not follow a PE pointer that leaves the head", () => {
    const head = Buffer.alloc(0x40)
    head.write("MZ")
    head.writeUInt32LE(0x1000, 0x3c)
    expect(kindOfHead(head)).toBeUndefined()
  })
})

describe("refusalOfFile", () => {
  test("leaves a readable archive name to the archive inspection", () => {
    expect(refusalOfFile({ name: "report.zip" })).toBeUndefined()
    expect(refusalOfFile({ name: "report.zip", type: "application/zip", head: latin1("\x7fELF") })).toBeUndefined()
  })

  test("refuses by name or by type", () => {
    expect(refusalOfFile({ name: "photo.jpg", type: "application/zip" })).toBe("an archive or a program")
    expect(refusalOfFile({ name: "setup.exe" })).toBe("an archive or a program")
    expect(refusalOfFile({ name: "run.sh" })).toBe("an archive or a program")
    expect(refusalOfFile({ name: "data.rar" })).toBe("an archive or a program")
    expect(refusalOfFile({ name: "data.tar.bz2" })).toBe("an archive or a program")
  })

  test("refuses by content under an innocent name", () => {
    expect(refusalOfFile({ name: "notes.txt", head: latin1("\x7fELF") })).toBe("a program")
    expect(refusalOfFile({ name: "notes.txt", head: latin1("#!/bin/sh\n") })).toBe("a script")
    expect(refusalOfFile({ name: "notes.txt", head: latin1("PK\x03\x04") })).toBe("an archive")
  })

  test("passes what is plain", () => {
    expect(refusalOfFile({ name: "notes.txt" })).toBeUndefined()
    expect(refusalOfFile({ name: "notes.txt", type: "text/plain", head: latin1("hello") })).toBeUndefined()
    expect(refusalOfFile({ name: "photo.jpg", type: "image/jpeg" })).toBeUndefined()
  })
})
