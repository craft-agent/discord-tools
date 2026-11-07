import { expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureLabelDir } from "../discord/labels"
import { withHome } from "../discord/service.testing"
import { annotations, invoke, selectTools } from "../tool"
import { discordAccountRead } from "./read"
import { ACCOUNT_ID, fixture, snapshot } from "./read.testing"

test("a complete, scheduled but idle account is healthy and read-only", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    const before = await snapshot(h.ctx.stateDir!)
    const {
      accounts: [row],
    } = await h.read()
    expect(row).toEqual({
      label: "default",
      id: ACCOUNT_ID,
      name: "Example",
      token_source: "file",
      token_status: "available",
      token_rejected_at: null,
      installed: false,
      scheduled: true,
      running: false,
      last_sync_at: new Date(1_800_000_000_000 - 1000).toISOString(),
      sync_status: "complete",
      health: "healthy",
      reasons: [],
      action: null,
      hint: null,
      recovery_command: null,
    })
    expect(await snapshot(h.ctx.stateDir!)).toEqual(before)
    expect(h.calls.every((call) => call[0] === "launchctl" && call[1] === "print")).toBe(true)
    expect(annotations(discordAccountRead)).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(
      selectTools([discordAccountRead], { read_only: true }, { names: ["account"], defaults: ["account"] }),
    ).toEqual([discordAccountRead])
  })
})

test("default reads sorted valid directories; explicit selection rejects missing and malformed labels", async () => {
  await withHome(async (root) => {
    const h = await fixture(root, "zeta")
    await ensureLabelDir(h.ctx.stateDir!, "alpha")
    await mkdir(join(h.ctx.stateDir!, "bad-label"))
    await writeFile(join(h.ctx.stateDir!, "file"), "")
    await symlink(h.paths.dir, join(h.ctx.stateDir!, "link"))
    expect((await h.read()).accounts.map((row) => row.label)).toEqual(["alpha", "zeta"])
    expect((await h.read({ account: "zeta" })).accounts.map((row) => row.label)).toEqual(["zeta"])
    await expect(h.read({ account: "absent" })).rejects.toMatchObject({ code: "not_found" })
    await expect(h.read({ account: "../bad" })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(h.read({ unexpected: true })).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

test("an absent root produces no account, service query or state creation", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    await rm(h.ctx.stateDir!, { recursive: true })
    const before = await snapshot(root)
    expect(await h.read()).toEqual({ accounts: [] })
    expect(h.calls).toEqual([])
    expect(await snapshot(root)).toEqual(before)
  })
})

test("runtime and state directory are required with fixed internal errors", async () => {
  await expect(invoke(discordAccountRead, {}, { cwd: "/" })).rejects.toMatchObject({
    code: "internal_error",
    message: "Account reads require a runtime and an absolute state directory.",
  })
  await withHome(async (root) => {
    const h = await fixture(root)
    h.ctx.stateDir = undefined
    await expect(h.read()).rejects.toMatchObject({ code: "internal_error" })
  })
})

test("cancellation before a read or between scheduler calls is not downgraded to unknown", async () => {
  await withHome(async (root) => {
    const h = await fixture(root)
    const controller = new AbortController()
    h.ctx.signal = controller.signal
    h.ctx.runtime!.serviceHost.run = async () => {
      controller.abort()
      return { code: 0, stdout: "state = waiting", stderr: "" }
    }
    await expect(h.read()).rejects.toMatchObject({ name: "AbortError" })
    await expect(h.read()).rejects.toMatchObject({ name: "AbortError" })
  })
})
