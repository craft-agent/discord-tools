import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { readClientTokenStatus } from "./client-token-status"
import { fakeToken } from "./fake-token.testing"
import { ensureLabelDir, labelPaths } from "./labels"
import { withHome } from "./service.testing"
import { recordRejected, writeTokenFile } from "./token"

describe("local token status", () => {
  test("the environment wins, including empty and invalid values", async () => {
    await withHome(async (root) => {
      const paths = await ensureLabelDir(root, "test")
      await writeTokenFile(paths, fakeToken("file"))
      for (const [value, status] of [
        [fakeToken(), "available"],
        ["", "invalid"],
        ["Bot invalid", "invalid"],
      ] as const) {
        expect(await readClientTokenStatus({ paths, tokenVariable: "TEST_TOKEN", env: { TEST_TOKEN: value } })).toEqual(
          {
            source: "variable",
            status,
            rejectedAt: null,
          },
        )
      }
    })
  })

  test("private files are available; missing, invalid, loose and linked files remain distinct", async () => {
    await withHome(async (root) => {
      const paths = await ensureLabelDir(root, "test")
      const options = { paths, tokenVariable: "TEST_TOKEN", env: {} }
      expect(await readClientTokenStatus(options)).toEqual({ source: null, status: "missing", rejectedAt: null })
      await writeTokenFile(paths, fakeToken())
      expect((await readClientTokenStatus(options)).status).toBe("available")
      await writeFile(paths.token, "invalid token")
      expect((await readClientTokenStatus(options)).status).toBe("invalid")
      await writeTokenFile(paths, fakeToken())
      await chmod(paths.token, 0o644)
      expect(await readClientTokenStatus(options)).toEqual({ source: "file", status: "unreadable", rejectedAt: null })
      const other = await ensureLabelDir(root, "other")
      await symlink(paths.token, other.token)
      expect((await readClientTokenStatus({ ...options, paths: other })).status).toBe("unreadable")
      const directory = await ensureLabelDir(root, "directory")
      await mkdir(directory.token)
      expect((await readClientTokenStatus({ ...options, paths: directory })).status).toBe("unreadable")
    })
  })

  test("only a rejection of the current token counts and inspection changes no files", async () => {
    await withHome(async (root) => {
      const paths = await ensureLabelDir(root, "test")
      await writeTokenFile(paths, fakeToken())
      await recordRejected(paths, fakeToken(), 1234)
      const names = await readdir(paths.dir)
      const auth = await readFile(paths.auth, "utf8")
      const options = { paths, tokenVariable: "TEST_TOKEN", env: {} }
      expect(await readClientTokenStatus(options)).toEqual({ source: "file", status: "rejected", rejectedAt: 1234 })
      const replacement = await readClientTokenStatus({ ...options, env: { TEST_TOKEN: fakeToken("b") } })
      expect(replacement).toEqual({ source: "variable", status: "available", rejectedAt: null })
      expect(JSON.stringify(replacement)).not.toContain(fakeToken("b"))
      expect(await readdir(paths.dir)).toEqual(names)
      expect(await readFile(paths.auth, "utf8")).toBe(auth)
      expect(await readFile(paths.token, "utf8")).toBe(fakeToken())
    })
  })

  test("process-memory rejection survives a persistence failure", async () => {
    await withHome(async (root) => {
      const paths = labelPaths(root, "missing")
      await expect(recordRejected(paths, fakeToken(), 2345)).rejects.toThrow()
      expect(
        await readClientTokenStatus({ paths, tokenVariable: "TEST_TOKEN", env: { TEST_TOKEN: fakeToken() } }),
      ).toEqual({
        source: "variable",
        status: "rejected",
        rejectedAt: 2345,
      })
      expect(await readdir(root)).toEqual([])
    })
  })

  test("unforeseen failures return fixed statuses without a raw error or token", async () => {
    await withHome(async (root) => {
      const env = Object.defineProperty({}, "TEST_TOKEN", {
        get() {
          throw new Error(fakeToken())
        },
      })
      expect(
        await readClientTokenStatus({ paths: labelPaths(root, "test"), tokenVariable: "TEST_TOKEN", env }),
      ).toEqual({
        source: null,
        status: "unreadable",
        rejectedAt: null,
      })
    })
  })
})
