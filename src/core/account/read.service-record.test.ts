import { describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { openMirrorForWrite } from "../discord/mirror"
import { MIRROR_VERSION } from "../discord/mirror-schema"
import { failed, ok, withHome } from "../discord/service.testing"
import { writeServiceRecord } from "../discord/service-record"
import { SYNC_STATUS_META } from "../discord/sync-status"
import { fixture } from "./read.testing"

const GONE_HINT =
  "The program the scheduled sync was installed with is gone, as after an update; install the service again."
const RUNNING_GONE_HINT =
  "A sync is running now, but the program the scheduled sync was installed with is gone, so it will not run again; install the service again."

type Harness = Awaited<ReturnType<typeof fixture>>

/** Writes a record whose files exist unless named in `missing`. */
async function record(h: Harness, root: string, missing: Array<"program" | "script"> = []) {
  const program = join(root, "program")
  const script = join(root, "script.js")
  if (!missing.includes("program")) await writeFile(program, "")
  if (!missing.includes("script")) await writeFile(script, "")
  await writeServiceRecord(h.paths, { program, script })
  return { program, script }
}

async function row(h: Harness) {
  return (await h.read()).accounts[0]!
}

describe("account read: service record", () => {
  test("a record with both files present changes nothing", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      await record(h, root)
      expect(await row(h)).toMatchObject({ health: "healthy", action: null, hint: null, reasons: [] })
    })
  })

  test("no record changes nothing", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      expect(await row(h)).toMatchObject({ health: "healthy", action: null, reasons: [] })
    })
  })

  test.each<"program" | "script">(["program", "script"])(
    "a schedule with the %s gone needs installing again",
    async (gone) => {
      await withHome(async (root) => {
        const h = await fixture(root)
        await record(h, root, [gone])
        const result = await row(h)
        expect(result).toMatchObject({
          health: "attention",
          scheduled: true,
          running: false,
          action: "install_service",
        })
        expect(result.hint).toBe(GONE_HINT)
        expect(result.reasons).toEqual(["service_program_gone"])
        expect(result.recovery_command).toContain(" service install --account 'default' --state-dir ")
      })
    },
  )

  test("a sync running now will not run again once the program is gone", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      h.ctx.runtime!.serviceHost.run = async () => ok("state = running\npid = 123")
      await record(h, root, ["program"])
      expect(await row(h)).toMatchObject({ running: true, action: "install_service", hint: RUNNING_GONE_HINT })
    })
  })

  test("a gone program wins over a failed sync and an unscheduled job", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      h.meta({ [SYNC_STATUS_META]: "failed" })
      await record(h, root, ["program"])
      expect(await row(h)).toMatchObject({ action: "install_service", hint: GONE_HINT })
      h.ctx.runtime!.serviceHost.run = async () => failed(113, "Could not find service")
      expect(await row(h)).toMatchObject({ scheduled: false, action: "install_service", hint: GONE_HINT })
    })
  })

  test("a gone program is still named when the scheduler cannot be read", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      h.ctx.runtime!.serviceHost.run = async () => {
        throw new Error("unavailable")
      }
      await record(h, root, ["program"])
      const result = await row(h)
      expect(result).toMatchObject({ health: "attention", action: "install_service", hint: GONE_HINT })
      expect(result.reasons).toEqual(["service_unknown", "service_program_gone"])
    })
  })

  test("a gone program wins over a refused mirror, which a new schedule could not fix", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      const db = openMirrorForWrite(h.paths.mirror)
      db.exec(`PRAGMA user_version = ${MIRROR_VERSION + 1}`)
      db.close()
      await record(h, root, ["program"])
      const result = await row(h)
      expect(result.reasons).toContain("mirror_unavailable")
      expect(result).toMatchObject({ action: "install_service", hint: GONE_HINT })
    })
  })

  test("signing in still comes first", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      await record(h, root, ["program"])
      await rm(h.paths.token)
      expect(await row(h)).toMatchObject({ action: "login" })
      await rm(join(h.paths.dir, "account.json"))
      expect(await row(h)).toMatchObject({ action: "login" })
    })
  })

  test("the result never contains the record's paths", async () => {
    await withHome(async (root) => {
      const h = await fixture(root)
      const files = await record(h, root, ["program"])
      const json = JSON.stringify(await row(h))
      for (const path of [files.program, files.script]) expect(json).not.toContain(path)
    })
  })
})
