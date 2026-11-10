import { afterEach, describe, expect, test } from "bun:test"
import { Scratch } from "./archive.testing"
import { RECEIVED, SENT, inspectArchive } from "./inspect"
import { checkSentFile } from "./sent"
import { tarBytes, tarGzBytes, type TarItem } from "./tar.testing"
import { zipBytes, type ZipItem } from "./zip.testing"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n"

/** Checks a zip of `items` sent as `name`. */
async function sendZip(items: ZipItem[], name = "data.zip") {
  return checkSentFile(await scratch.write("copy", zipBytes(items)), ["home", "me", name])
}

describe("checkSentFile: an archive", () => {
  test("passes a zip of sources and scripts and reports its listing", async () => {
    const report = await sendZip([
      { name: "src/", data: "" },
      { name: "src/main.py", data: "print(1)" },
      { name: "run.sh", data: "echo hi" },
      { name: "bin/start", data: "#!/bin/sh\necho hi\n" },
      { name: "README.md", data: "hello" },
    ])
    expect(report.archive).toEqual({
      format: "zip",
      entries: 4,
      unpacked: 8 + 7 + 18 + 5,
      names: ["src/main.py", "run.sh", "bin/start", "README.md"],
      more: 0,
    })
  })

  test("passes a tar and a tar.gz the same way", async () => {
    const items: TarItem[] = [{ name: "a/b.txt", data: "hello" }]
    const tar = await checkSentFile(await scratch.write("copy", tarBytes(items)), ["x.tar"])
    const gz = await checkSentFile(await scratch.write("copy.gz", tarGzBytes(items)), ["x.tgz"])
    expect(tar.archive).toMatchObject({ format: "tar", entries: 1, names: ["a/b.txt"] })
    expect(gz.archive).toMatchObject({ format: "tar.gz", entries: 1, names: ["a/b.txt"] })
  })

  test("honors the limits it is given", async () => {
    const path = await scratch.write(
      "copy",
      zipBytes([
        { name: "a.txt", data: "a" },
        { name: "b.txt", data: "b" },
      ]),
    )
    await expect(checkSentFile(path, ["x.zip"], { limits: { entries: 1 } })).rejects.toThrow(
      "it has more than 1 entries",
    )
  })

  test.each([
    [{ name: ".env", data: "TOKEN=abc" }, ".env is named like a credential, key or database"],
    [{ name: "app/id_rsa", data: "x" }, "app/id_rsa is named like a credential, key or database"],
    [{ name: ".ssh/known", data: "x" }, ".ssh/known is in a .ssh folder, which holds credentials"],
    [{ name: "a/.git/config", data: "x" }, "a/.git/config is in a .git folder, which holds credentials"],
    [{ name: "notes.txt", data: KEY, deflate: true }, "notes.txt holds a private key"],
    [{ name: "setup.exe", data: "x" }, "setup.exe is an archive or a program"],
    [{ name: "inner.zip", data: "x" }, "inner.zip is an archive or a program"],
    [{ name: "tool", data: "\x7fELF\x02" }, "tool is a program"],
  ])("refuses a zip with an entry %j", async (item, reason) => {
    await expect(sendZip([{ name: "ok.txt", data: "fine" }, item])).rejects.toThrow(reason)
  })

  test("refuses a folder entry in a folder that holds credentials, with no file in it", async () => {
    await expect(
      sendZip([
        { name: "a.txt", data: "a" },
        { name: ".aws/", data: "" },
      ]),
    ).rejects.toThrow(".aws/ is in a .aws folder, which holds credentials")
    await expect(
      sendZip([
        { name: "a.txt", data: "a" },
        { name: "x/.kube/sub/", data: "" },
      ]),
    ).rejects.toThrow("x/.kube/sub/ is in a .kube folder, which holds credentials")
  })

  test("refuses a stored zip holding a private key by the file's own scan", async () => {
    await expect(sendZip([{ name: "notes.txt", data: KEY }])).rejects.toThrow("it holds a private key")
  })

  test("refuses a tar with a secret entry", async () => {
    const path = await scratch.write("copy", tarBytes([{ name: ".gnupg/key", data: "x" }]))
    await expect(checkSentFile(path, ["x.tar"])).rejects.toThrow(".gnupg/key is in a .gnupg folder")
  })

  test("refuses an encrypted entry as an inspection does", async () => {
    await expect(sendZip([{ name: "a.txt", data: "a", encrypted: true }])).rejects.toThrow("is encrypted")
  })

  test("refuses an archive named for a secret before reading it", async () => {
    await expect(sendZip([{ name: "a.txt", data: "a" }], "my-secret.zip")).rejects.toThrow(
      "it is named like a credential, key or database",
    )
  })

  test("refuses a file named like an archive whose content is not one", async () => {
    const path = await scratch.write("copy", "just text")
    await expect(checkSentFile(path, ["x.zip"])).rejects.toThrow("its content is not a zip archive")
  })

  test("refuses a program under an archive's name", async () => {
    const path = await scratch.write("copy", Buffer.from("\x7fELF\x02\x01", "latin1"))
    await expect(checkSentFile(path, ["x.zip"])).rejects.toThrow("its content is a program")
  })

  test("refuses an archive with no files", async () => {
    await expect(sendZip([{ name: "empty/", data: "" }])).rejects.toThrow("it contains no files")
  })
})

describe("inspectArchive: the options of a received archive", () => {
  const items: ZipItem[] = [
    { name: ".env", data: "TOKEN=abc" },
    { name: ".ssh/id_rsa", data: KEY },
    { name: "notes.txt", data: KEY },
  ]

  test("still passes secret names and private keys when received", async () => {
    const path = await scratch.write("a.zip", zipBytes(items))
    expect((await inspectArchive(path, "a.zip", RECEIVED))?.entries).toBe(3)
  })

  test("refuses them with the sent options", async () => {
    const path = await scratch.write("a.zip", zipBytes(items))
    await expect(inspectArchive(path, "a.zip", SENT)).rejects.toThrow(".env is named like")
  })

  test("sends scripts and refuses the rest as before", () => {
    expect(SENT).toEqual({ allowScripts: true, scanKeys: true, denySecrets: true })
  })
})
