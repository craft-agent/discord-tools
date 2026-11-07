import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { fakeToken } from "../discord/fake-token.testing"
import { failed, ok, withHome } from "../discord/service.testing"
import { LAST_SYNC_AT_META, SYNC_STATUS_META } from "../discord/sync-status"
import { recordRejected } from "../discord/token"
import { SYNC_FRESHNESS_MS } from "./health"
import { fixture, NOW } from "./read.testing"

test("partial, failed and cancelled runs need sync despite fresh complete history", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    for (const status of ["partial", "failed", "cancelled"]) {
      h.meta({ [SYNC_STATUS_META]: status, sync_error: fakeToken() })
      const row = (await h.read()).accounts[0]!
      expect(row).toMatchObject({ health: "attention", action: "sync", sync_status: status })
      expect(row.reasons).toContain(`sync_${status}`)
      expect(row.last_sync_at).toBe(new Date(NOW - 1000).toISOString())
      expect(JSON.stringify(row)).not.toContain(fakeToken())
    }
  })
})

test("freshness includes the boundary and recorded running never proves liveness", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    h.meta({ [LAST_SYNC_AT_META]: NOW - SYNC_FRESHNESS_MS })
    expect((await h.read()).accounts[0]!.health).toBe("healthy")
    h.meta({ [LAST_SYNC_AT_META]: NOW - SYNC_FRESHNESS_MS - 1, [SYNC_STATUS_META]: "running" })
    const stale = (await h.read()).accounts[0]!
    expect(stale).toMatchObject({ health: "attention", action: "sync", running: false, sync_status: "running" })
    expect(stale.reasons).toEqual(["sync_stale", "interrupted_sync"])
    h.ctx.runtime!.serviceHost.run = async () => ok("state = running\npid = 123")
    expect((await h.read()).accounts[0]!.health).toBe("attention")
    h.meta({ [LAST_SYNC_AT_META]: NOW - 1000 })
    expect((await h.read()).accounts[0]).toMatchObject({ health: "healthy", running: true, sync_status: "running" })
    h.meta({ [LAST_SYNC_AT_META]: null })
    expect((await h.read()).accounts[0]!.reasons).toContain("sync_never_completed")
  })
})

test("historical rejection is not current authentication failure after token replacement", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    await recordRejected(h.paths, fakeToken(), NOW - 1000)
    h.meta({ [SYNC_STATUS_META]: "rejected" })
    const rejected = (await h.read()).accounts[0]!
    expect(rejected).toMatchObject({
      token_status: "rejected",
      action: "login",
      token_rejected_at: new Date(NOW - 1000).toISOString(),
    })
    expect(rejected.hint).toContain("then run service install")
    h.ctx.runtime!.env.EXAMPLE_TOKEN_DEFAULT = fakeToken("b")
    const replaced = (await h.read()).accounts[0]!
    expect(replaced).toMatchObject({
      token_source: "variable",
      token_status: "available",
      token_rejected_at: null,
      sync_status: "rejected",
      action: "sync",
    })
    expect(replaced.reasons).not.toContain("token_rejected")
  })
})

test("empty environment overrides saved credentials and login commands quote every dynamic argument", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    h.ctx.runtime!.env.EXAMPLE_TOKEN_DEFAULT = ""
    const row = (await h.read()).accounts[0]!
    expect(row).toMatchObject({ token_source: "variable", token_status: "invalid", action: "login" })
    expect(row.recovery_command).toBe(
      `'/opt/example'\\''s cli' login --account 'default' --state-dir '${h.ctx.stateDir!.replaceAll("'", "'\\''")}'`,
    )
    delete h.ctx.runtime!.env.EXAMPLE_TOKEN_DEFAULT
    await rm(h.paths.token)
    expect((await h.read()).accounts[0]).toMatchObject({ token_source: null, token_status: "missing", action: "login" })
  })
})

test("missing identity needs login even with a valid mirror, and missing mirror needs sync", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    await rm(h.paths.mirror)
    expect((await h.read()).accounts[0]).toMatchObject({
      action: "sync",
      reasons: ["mirror_missing", "sync_never_completed"],
    })
    await rm(join(h.paths.dir, "account.json"))
    expect((await h.read()).accounts[0]).toMatchObject({ id: null, name: null, action: "login" })
  })
})

test("known unscheduled services need installation; unknown managers never become false", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    h.ctx.runtime!.serviceHost.run = async () => failed(113, "Could not find service")
    expect((await h.read()).accounts[0]).toMatchObject({ scheduled: false, running: false, action: "install_service" })
    h.ctx.runtime!.serviceHost.run = async () => {
      throw new Error(fakeToken())
    }
    const row = (await h.read()).accounts[0]!
    expect(row).toMatchObject({
      installed: null,
      scheduled: null,
      running: null,
      health: "unknown",
      action: "check_service",
    })
    expect(row.reasons).toEqual(["service_unknown"])
    expect(JSON.stringify(row)).not.toContain(fakeToken())
    h.ctx.runtime!.serviceHost.platform = "win32"
    expect((await h.read()).accounts[0]!.health).toBe("unknown")
    await rm(h.paths.token)
    expect((await h.read()).accounts[0]).toMatchObject({ health: "attention", action: "login" })
  })
})
