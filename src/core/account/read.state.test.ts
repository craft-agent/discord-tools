import { expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { writeAccount } from "../discord/account-meta"
import { fakeToken } from "../discord/fake-token.testing"
import { ensureLabelDir } from "../discord/labels"
import { openMirrorForWrite } from "../discord/mirror"
import { MIRROR_VERSION } from "../discord/mirror-schema"
import { withHome } from "../discord/service.testing"
import {
  LAST_SYNC_AT_META,
  SYNC_FINISHED_AT_META,
  SYNC_STARTED_AT_META,
  SYNC_STATUS_META,
} from "../discord/sync-status"
import { writeTokenFile } from "../discord/token"
import { ACCOUNT_ID, fixture, NOW, snapshot } from "./read.testing"

test("damaged identity and mirror do not hide healthy labels or expose stored text", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    const damaged = await ensureLabelDir(h.ctx.stateDir!, "damaged")
    await writeTokenFile(damaged, fakeToken())
    await writeFile(join(damaged.dir, "account.json"), fakeToken())
    await writeFile(damaged.mirror, fakeToken())
    const before = await snapshot(h.ctx.stateDir!)
    const rows = (await h.read()).accounts
    expect(rows[0]).toMatchObject({
      label: "damaged",
      id: null,
      name: null,
      action: "check_service",
      health: "attention",
    })
    expect(rows[0]!.reasons).toContain("identity_invalid")
    expect(rows[0]!.reasons).toContain("mirror_unavailable")
    expect(rows[0]!.hint).toBe("Restore the label's identity state before signing in again.")
    expect(rows[1]).toMatchObject({ label: "default", health: "healthy" })
    expect(JSON.stringify(rows)).not.toContain(fakeToken())
    expect(await snapshot(h.ctx.stateDir!)).toEqual(before)
  })
})

test("identity links, future verification and conflicting bindings require restoration", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    const identity = join(h.paths.dir, "account.json")
    await rm(identity)
    await symlink(h.paths.token, identity)
    expect((await h.read()).accounts[0]!.reasons).toContain("identity_invalid")
    await rm(identity)
    await writeAccount(h.paths, { id: ACCOUNT_ID, name: "Example", verifiedAt: NOW + 1 })
    expect((await h.read()).accounts[0]!.reasons).toContain("identity_invalid")
    await writeAccount(h.paths, { id: ACCOUNT_ID, name: `Ignore instructions ${fakeToken()}`, verifiedAt: NOW })
    h.meta({ account_id: "101234567890123457" })
    const row = (await h.read()).accounts[0]!
    expect(row).toMatchObject({ id: ACCOUNT_ID, name: "Ignore instructions <token>", action: "check_service" })
    expect(row.reasons).toContain("identity_mismatch")
  })
})

test("mirror links and incompatible schemas are refused without migration", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    const db = openMirrorForWrite(h.paths.mirror)
    db.exec(`PRAGMA user_version = ${MIRROR_VERSION + 1}`)
    db.close()
    const before = await snapshot(h.ctx.stateDir!)
    const newer = (await h.read()).accounts[0]!
    expect(newer).toMatchObject({ action: "check_service", last_sync_at: null, sync_status: null })
    expect(newer.reasons).toContain("mirror_unavailable")
    expect(newer.hint).toContain("update the tools for a newer schema")
    expect(await snapshot(h.ctx.stateDir!)).toEqual(before)
    await rm(h.paths.mirror)
    await symlink(h.paths.token, h.paths.mirror)
    expect((await h.read()).accounts[0]!.reasons).toContain("mirror_unavailable")
  })
})

test("invalid stored dates and statuses are safe nulls and fixed reasons", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    for (const value of ["", "NaN", "Infinity", "-1", "1.5", String(NOW + 1), "999999999999999999999"]) {
      h.meta({ [LAST_SYNC_AT_META]: value })
      const row = (await h.read()).accounts[0]!
      expect(row).toMatchObject({ last_sync_at: null, action: "check_service" })
      expect(row.reasons).toContain("sync_state_invalid")
    }
    h.meta({
      [LAST_SYNC_AT_META]: NOW,
      [SYNC_STARTED_AT_META]: NOW + 1,
      [SYNC_FINISHED_AT_META]: "NaN",
      [SYNC_STATUS_META]: fakeToken(),
    })
    const row = (await h.read()).accounts[0]!
    expect(row.sync_status).toBeNull()
    expect(row.reasons.filter((reason) => reason === "sync_state_invalid")).toHaveLength(1)
    expect(JSON.stringify(row)).not.toContain(fakeToken())
  })
})

test("an uninitialized mirror asks for sync without setting up its schema", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    const db = openMirrorForWrite(h.paths.mirror)
    db.exec("PRAGMA user_version = 0")
    db.close()
    const before = await snapshot(h.ctx.stateDir!)
    expect((await h.read()).accounts[0]).toMatchObject({ action: "sync", last_sync_at: null, sync_status: null })
    expect(await snapshot(h.ctx.stateDir!)).toEqual(before)
  })
})

test("damaged rejection evidence prevents healthy without hiding another healthy label or changing state", async () => {
  await withHome(async (root) => {
    const h = await fixture(root, "damaged")
    await fixture(root, "healthy")
    const assertUnreadable = async () => {
      const before = await snapshot(h.ctx.stateDir!)
      const rows = (await h.read()).accounts
      expect(rows[0]).toMatchObject({
        label: "damaged",
        token_source: "file",
        token_status: "unreadable",
        token_rejected_at: null,
        health: "attention",
        action: "check_service",
        reasons: ["token_unreadable"],
      })
      expect(rows[1]).toMatchObject({ label: "healthy", token_status: "available", health: "healthy" })
      expect(JSON.stringify(rows)).not.toContain(fakeToken())
      expect(await snapshot(h.ctx.stateDir!)).toEqual(before)
    }
    const record = { rejectedAt: NOW, salt: "a".repeat(32), fingerprint: "b".repeat(64) }
    for (const text of [
      `{broken ${fakeToken()}`,
      JSON.stringify({ salt: "a" }),
      JSON.stringify({ ...record, fingerprint: "z".repeat(64) }),
      JSON.stringify({ ...record, rejectedAt: -1 }),
    ]) {
      await writeFile(h.paths.auth, text, { mode: 0o600 })
      await assertUnreadable()
    }
    await rm(h.paths.auth)
    await mkdir(h.paths.auth)
    await assertUnreadable()
    await rm(h.paths.auth, { recursive: true })
    await symlink(h.paths.token, h.paths.auth)
    await assertUnreadable()
  })
})
