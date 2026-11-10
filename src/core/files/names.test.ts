import { describe, expect, test } from "bun:test"
import { cleanName, numberedName } from "./names"

describe("cleanName", () => {
  test("keeps a plain name as it is", () => {
    expect(cleanName("Holiday photo-1_final.v2.png", 1)).toBe("Holiday photo-1_final.v2.png")
  })

  test("keeps letters and digits of any script", () => {
    expect(cleanName("写真 ２０２６.jpg", 1)).toBe("写真 ２０２６.jpg")
  })

  test.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\a.txt", "a.txt"],
    ["dir/sub\\file.txt", "file.txt"],
    ["a/b/", "file-3"],
  ])("takes the base name of %s", (raw, expected) => {
    expect(cleanName(raw, 3)).toBe(expected)
  })

  test("makes a run of odd characters one underscore", () => {
    expect(cleanName('a<>:"|?*\n\u202e\u0000b.txt', 1)).toBe("a_b.txt")
    expect(cleanName("a\u200b.png", 1)).toBe("a_.png")
  })

  test("trims spaces and dots at both ends", () => {
    expect(cleanName("  ..hidden.txt. . ", 1)).toBe("hidden.txt")
    expect(cleanName("evil.exe . ", 1)).toBe("evil.exe")
  })

  test.each(["", "   ", "...", ".", "..", "/", "a/.."])("names %p after its position", (raw) => {
    expect(cleanName(raw, 7)).toBe("file-7")
  })

  test("a name of odd characters only is one underscore", () => {
    expect(cleanName("???", 1)).toBe("_")
  })
})

describe("cleanName: the length", () => {
  test("cuts a long name to 120 characters and keeps the extension", () => {
    const name = cleanName(`${"a".repeat(300)}.png`, 1)
    expect(name).toBe(`${"a".repeat(116)}.png`)
    expect(Array.from(name)).toHaveLength(120)
  })

  test("cuts a long CJK name to 200 bytes without splitting a character", () => {
    const name = cleanName(`${"写".repeat(100)}.png`, 1)
    expect(name).toBe(`${"写".repeat(65)}.png`)
    expect(Buffer.byteLength(name)).toBe(199)
  })

  test("counts code points outside the basic plane as one character and four bytes", () => {
    const name = cleanName(`${"𠮷".repeat(100)}.txt`, 1)
    expect(name).toBe(`${"𠮷".repeat(49)}.txt`)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
  })

  test("cuts the whole name when its extension is longer than 16 characters", () => {
    const name = cleanName(`${"a".repeat(200)}.${"x".repeat(20)}`, 1)
    expect(name).toBe("a".repeat(120))
  })

  test("trims what the cut leaves at the end of the stem", () => {
    expect(cleanName(`${"a".repeat(115)} . .png`, 1)).toBe(`${"a".repeat(115)}.png`)
  })

  test("leaves a name within the limits as it is", () => {
    const name = `${"a".repeat(116)}.png`
    expect(cleanName(name, 1)).toBe(name)
  })
})

describe("numberedName", () => {
  test("puts the number before the extension", () => {
    expect(numberedName("photo.png", 2)).toBe("photo-2.png")
    expect(numberedName("a.b.c", 3)).toBe("a.b-3.c")
  })

  test("keeps .tar.gz whole", () => {
    expect(numberedName("pack.tar.gz", 2)).toBe("pack-2.tar.gz")
  })

  test("puts the number at the end of a name without an extension", () => {
    expect(numberedName("README", 2)).toBe("README-2")
  })
})
