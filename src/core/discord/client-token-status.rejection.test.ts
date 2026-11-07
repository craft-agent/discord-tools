import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { readClientTokenStatus } from "./client-token-status"
import { fakeToken } from "./fake-token.testing"
import { ensureLabelDir } from "./labels"
import { withHome } from "./service.testing"
import { recordRejected, rejectedAt, writeTokenFile } from "./token"

test("strict diagnostics reject corrupt records with fixed errors and unchanged bytes", async () => {
  await withHome(async (root) => {
    const paths = await ensureLabelDir(root, "test")
    await writeTokenFile(paths, fakeToken())
    const record = { rejectedAt: 1234, salt: "a".repeat(32), fingerprint: "b".repeat(64) }
    const corrupt = [
      `{broken ${fakeToken()}`,
      "null",
      "[]",
      JSON.stringify({ rejectedAt: 1234 }),
      JSON.stringify({ ...record, salt: fakeToken() }),
      JSON.stringify({ ...record, salt: "a".repeat(31) }),
      JSON.stringify({ ...record, fingerprint: "z".repeat(64) }),
      JSON.stringify({ ...record, fingerprint: "b".repeat(63) }),
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1].map((rejectedAt) =>
        JSON.stringify({ ...record, rejectedAt }),
      ),
      JSON.stringify({ ...record, rejectedAt: "1234" }),
      JSON.stringify(record).replace("1234", "1e999"),
    ]
    for (const text of corrupt) {
      await writeFile(paths.auth, text, { mode: 0o600 })
      expect(await readClientTokenStatus({ paths, tokenVariable: "TEST_TOKEN", env: {} })).toEqual({
        source: "file",
        status: "unreadable",
        rejectedAt: null,
      })
      const error = await rejectedAt(paths, fakeToken(), { strict: true }).catch((error: unknown) => error)
      expect(error).toMatchObject({
        code: "stale",
        message: "The credential rejection record is unreadable or malformed; inspect it and its permissions.",
      })
      expect((error as Error).cause).toBeUndefined()
      expect(await rejectedAt(paths, fakeToken())).toBeUndefined()
      expect(await readFile(paths.auth, "utf8")).toBe(text)
    }
  })
})

test("directories, links and read errors remain unreadable without exposing their contents", async () => {
  await withHome(async (root) => {
    const paths = await ensureLabelDir(root, "test")
    const options = { paths, tokenVariable: "TEST_TOKEN", env: { TEST_TOKEN: fakeToken() } }
    const unreadable = { source: "variable", status: "unreadable", rejectedAt: null } as const
    await mkdir(paths.auth)
    expect(await readClientTokenStatus(options)).toEqual(unreadable)
    await rm(paths.auth, { recursive: true })
    await symlink(paths.token, paths.auth)
    expect(await readClientTokenStatus(options)).toEqual(unreadable)
    expect((await lstat(paths.auth)).isSymbolicLink()).toBe(true)
    await rm(paths.auth)
    await writeFile(paths.auth, fakeToken(), { mode: 0o600 })
    await chmod(paths.auth, 0)
    try {
      expect(await readClientTokenStatus(options)).toEqual(unreadable)
      expect((await lstat(paths.auth)).mode & 0o777).toBe(0)
    } finally {
      await chmod(paths.auth, 0o600)
    }
    expect(await readFile(paths.auth, "utf8")).toBe(fakeToken())
  })
})

test("absent and valid different-token records stay available; disk rejection accepts valid hexadecimal", async () => {
  await withHome(async (root) => {
    const paths = await ensureLabelDir(root, "test")
    const source = await ensureLabelDir(root, "source")
    const options = { paths, tokenVariable: "TEST_TOKEN", env: { TEST_TOKEN: fakeToken() } }
    const available = { source: "variable", status: "available", rejectedAt: null } as const
    expect(await readClientTokenStatus(options)).toEqual(available)
    await recordRejected(source, fakeToken("b"), 1234)
    await writeFile(paths.auth, await readFile(source.auth))
    expect(await readClientTokenStatus(options)).toEqual(available)
    await recordRejected(source, fakeToken(), 1234)
    const record = JSON.parse(await readFile(source.auth, "utf8"))
    record.fingerprint = record.fingerprint.toUpperCase()
    const text = JSON.stringify(record)
    await writeFile(paths.auth, text)
    expect(await readClientTokenStatus(options)).toEqual({ source: "variable", status: "rejected", rejectedAt: 1234 })
    expect(await readFile(paths.auth, "utf8")).toBe(text)
  })
})
