import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LAUNCH_TTL_MS, loadLaunch } from "./identity"
import { type LabelPaths, ensureLabelDir } from "./labels"

let tempDir: string
let paths: LabelPaths

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "dsc-"))
  paths = await ensureLabelDir(join(tempDir, "state"), "work")
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("loadLaunch", () => {
  test("makes and saves a launch when there is none", async () => {
    const launch = await loadLaunch(paths, 1000)
    expect(launch.started).toBe(1000)
    expect(new Set([launch.id, launch.heartbeat, launch.signature]).size).toBe(3)
    expect(JSON.parse(readFileSync(paths.client, "utf8"))).toEqual(launch)
    expect(statSync(paths.client).mode & 0o777).toBe(0o600)
  })

  test("serves the saved launch for a day", async () => {
    const first = await loadLaunch(paths, 1000)
    expect(await loadLaunch(paths, 1000 + LAUNCH_TTL_MS)).toEqual(first)
  })

  test("renews it after a day", async () => {
    const first = await loadLaunch(paths, 1000)
    const next = await loadLaunch(paths, 1001 + LAUNCH_TTL_MS)
    expect(next.id).not.toBe(first.id)
    expect(next.started).toBe(1001 + LAUNCH_TTL_MS)
    expect(JSON.parse(readFileSync(paths.client, "utf8"))).toEqual(next)
  })

  test("renews a launch that starts in the future", async () => {
    const first = await loadLaunch(paths, 5000)
    expect((await loadLaunch(paths, 1000)).id).not.toBe(first.id)
  })

  test("renews a malformed file", async () => {
    for (const text of ["", "nope", "[]", '{"id":"a"}', '{"id":"a","heartbeat":"b","signature":"c","started":"x"}']) {
      writeFileSync(paths.client, text)
      const launch = await loadLaunch(paths, 10)
      expect(launch.started).toBe(10)
      expect(JSON.parse(readFileSync(paths.client, "utf8"))).toEqual(launch)
    }
  })

  test("still serves a launch it cannot save", async () => {
    const lost: LabelPaths = { ...paths, client: join(tempDir, "missing-dir", "client.json") }
    expect((await loadLaunch(lost, 7)).started).toBe(7)
  })
})
