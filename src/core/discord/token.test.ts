import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import { fakeToken } from "./fake-token.testing"
import { type LabelPaths, ensureLabelDir } from "./labels"
import { readToken, tokenSource, tokenVariable, writeTokenFile } from "./token"

const TOKEN = fakeToken()
const VARIABLE = "EXAMPLE_TOKEN_WORK"

let tempDir: string
let paths: LabelPaths

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "dsc-"))
  paths = await ensureLabelDir(join(tempDir, "state"), "work")
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

async function failure(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run()
  } catch (err) {
    return err as Error
  }
  throw new Error("expected a failure")
}

function putToken(text: string, mode = 0o600): void {
  writeFileSync(paths.token, text, { mode })
  chmodSync(paths.token, mode)
}

describe("tokenVariable", () => {
  test("upper-cases the label after the prefix", () => {
    expect(tokenVariable("EXAMPLE", "work_2")).toBe("EXAMPLE_TOKEN_WORK_2")
  })
})

describe("tokenSource", () => {
  test("is the variable when it is set, even beside a file", async () => {
    putToken(TOKEN)
    expect(await tokenSource(paths, VARIABLE, { [VARIABLE]: TOKEN })).toBe("variable")
  })

  test("is the file when the variable is missing or blank", async () => {
    putToken(TOKEN)
    expect(await tokenSource(paths, VARIABLE, {})).toBe("file")
    expect(await tokenSource(paths, VARIABLE, { [VARIABLE]: "  \n" })).toBe("file")
  })

  test("is undefined with neither", async () => {
    expect(await tokenSource(paths, VARIABLE, {})).toBeUndefined()
  })
})

describe("readToken", () => {
  test("reads the variable first, trimmed", async () => {
    putToken(fakeToken("file"))
    expect(await readToken(paths, VARIABLE, { [VARIABLE]: `  ${TOKEN}\n` })).toEqual({
      token: TOKEN,
      source: "variable",
    })
  })

  test("reads the file, trimmed", async () => {
    putToken(`${TOKEN}\n`)
    expect(await readToken(paths, VARIABLE, {})).toEqual({ token: TOKEN, source: "file" })
  })

  test("throws unauthenticated naming the variable when there is no token", async () => {
    for (const env of [{}, { [VARIABLE]: "" }]) {
      const error = await failure(() => readToken(paths, VARIABLE, env))
      expect(error.code).toBe("unauthenticated")
      expect(error.message).toContain(VARIABLE)
      expect(error.message).toContain("sign the account in")
    }
  })

  test("throws unauthenticated for an empty token file", async () => {
    putToken("  \n")
    expect((await failure(() => readToken(paths, VARIABLE, {}))).code).toBe("unauthenticated")
  })

  test("refuses a token file that group or others can reach", async () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666]) {
      putToken(TOKEN, mode)
      const error = await failure(() => readToken(paths, VARIABLE, {}))
      expect(error.code).toBe("forbidden")
      expect(error.message).toContain("chmod 600")
      expect(error.message).not.toContain(TOKEN)
    }
  })

  test("refuses a symlink, even to a good file", async () => {
    const real = join(tempDir, "real-token")
    writeFileSync(real, TOKEN, { mode: 0o600 })
    symlinkSync(real, paths.token)
    expect((await failure(() => readToken(paths, VARIABLE, {}))).code).toBe("forbidden")
  })

  test("refuses a token path that is not a regular file", async () => {
    mkdirSync(paths.token)
    expect((await failure(() => readToken(paths, VARIABLE, {}))).code).toBe("forbidden")
  })

  test("refuses text that does not look like a user token, without echoing it", async () => {
    const bad = ["Bot abc.def.ghi", "bot abc.def.ghi", "two words", "line\nbreak"]
    for (const text of bad) {
      const fromVariable = await failure(() => readToken(paths, VARIABLE, { [VARIABLE]: text }))
      expect(fromVariable.code).toBe("unauthenticated")
      expect(fromVariable.message).toContain("does not look like a user token")
      expect(fromVariable.message).not.toContain("abc.def")

      putToken(text)
      const fromFile = await failure(() => readToken(paths, VARIABLE, {}))
      expect(fromFile.code).toBe("unauthenticated")
      expect(fromFile.message).not.toContain("abc.def")
    }
  })

  test("errors are tool errors", async () => {
    expect(isToolError(await failure(() => readToken(paths, VARIABLE, {})))).toBe(true)
  })
})

describe("writeTokenFile", () => {
  test("writes the token with mode 600 and leaves no temporary file", async () => {
    await writeTokenFile(paths, `  ${TOKEN}\n`)
    expect(readFileSync(paths.token, "utf8")).toBe(TOKEN)
    expect(statSync(paths.token).mode & 0o777).toBe(0o600)
    expect(readdirSync(paths.dir)).toEqual(["token"])
    expect(await readToken(paths, VARIABLE, {})).toEqual({ token: TOKEN, source: "file" })
  })

  test("replaces a token and fixes a loose mode", async () => {
    putToken("old-token-value", 0o644)
    await writeTokenFile(paths, TOKEN)
    expect(readFileSync(paths.token, "utf8")).toBe(TOKEN)
    expect(statSync(paths.token).mode & 0o777).toBe(0o600)
  })

  test("refuses a token that does not look like a user token and writes nothing", async () => {
    for (const text of ["", "  ", "Bot abc", "a b"]) {
      expect((await failure(() => writeTokenFile(paths, text))).code).toBe("unauthenticated")
    }
    expect(readdirSync(paths.dir)).toEqual([])
  })
})
