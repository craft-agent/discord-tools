import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, renameSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHarness, type Harness } from "./client.testing"
import { CHANNEL, OTHER_CHANNEL, SERVER } from "./objects.testing"
import { MAX_SYNC_SERVERS, readSyncList, SYNC_LIST_FILE, type SyncList } from "./sync-list"
import { changeSyncList, SYNC_LIST_LOCK_FILE } from "./sync-list-write"
import { acquireSyncLock } from "./sync-lock"

const FAST = { retryMs: 5, waitMs: 20 }

/** The `n`th made-up server id. */
const serverId = (n: number) => String(BigInt(SERVER) + BigInt(n))

let h: Harness
let file: string
beforeEach(async () => {
  h = await createHarness()
  file = join(h.paths.dir, SYNC_LIST_FILE)
})
afterEach(async () => {
  await h.dispose()
})

describe("changeSyncList", () => {
  test("writes the list it is given and reads it back", async () => {
    const next: SyncList = { servers: [{ id: SERVER, channels: [CHANNEL], exclude: [OTHER_CHANNEL] }] }
    const result = await changeSyncList(h.paths, () => next)
    expect(result).toEqual({ list: next, changed: true })
    expect(await readSyncList(h.paths)).toEqual(next)
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(next, null, 2)}\n`)
  })

  test("hands the current list to the change", async () => {
    await writeFile(file, JSON.stringify({ servers: [{ id: SERVER }] }))
    let seen: SyncList | undefined
    await changeSyncList(h.paths, (list) => {
      seen = list
      return undefined
    })
    expect(seen).toEqual({ servers: [{ id: SERVER }] })
  })

  test("the file is private", async () => {
    await changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("no change creates no file", async () => {
    expect(await changeSyncList(h.paths, () => undefined)).toEqual({ list: { servers: [] }, changed: false })
    expect(await changeSyncList(h.paths, (list) => structuredClone(list))).toEqual({
      list: { servers: [] },
      changed: false,
    })
    expect(existsSync(file)).toBe(false)
  })

  test("an equal list leaves the file as it is", async () => {
    await writeFile(file, '{"servers":[{"id":"1400000000000000100"}]}')
    const result = await changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }))
    expect(result.changed).toBe(false)
    expect(await readFile(file, "utf8")).toBe('{"servers":[{"id":"1400000000000000100"}]}')
  })

  test("a list that breaks the limits is refused and the file stays", async () => {
    await writeFile(file, '{"servers":[]}')
    const tooMany = { servers: Array.from({ length: MAX_SYNC_SERVERS + 1 }, (_, n) => ({ id: serverId(n) })) }
    await expect(changeSyncList(h.paths, () => tooMany)).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(changeSyncList(h.paths, () => ({ servers: [{ id: "not-an-id" }] }))).rejects.toMatchObject({
      code: "invalid_argument",
    })
    expect(await readFile(file, "utf8")).toBe('{"servers":[]}')
  })

  test("a failing change leaves the lock free", async () => {
    await expect(
      changeSyncList(h.paths, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    const release = acquireSyncLock(join(h.paths.dir, SYNC_LIST_LOCK_FILE))
    expect(release).toBeFunction()
    release?.()
  })

  test("an account removed during the change is not_found, not a raw file error", async () => {
    const moved = `${h.paths.dir}-removed`
    await expect(
      changeSyncList(h.paths, () => {
        renameSync(h.paths.dir, moved)
        return { servers: [{ id: SERVER }] }
      }),
    ).rejects.toMatchObject({ code: "not_found" })
    renameSync(moved, h.paths.dir)
    expect(existsSync(file)).toBe(false)
  })
})

describe("the list lock", () => {
  test("a held lock is stale after the wait, and nothing is written", async () => {
    const release = acquireSyncLock(join(h.paths.dir, SYNC_LIST_LOCK_FILE))!
    try {
      await expect(changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }), FAST)).rejects.toMatchObject({
        code: "stale",
      })
    } finally {
      release()
    }
    expect(existsSync(file)).toBe(false)
  })

  test("a lock released during the wait lets the change through", async () => {
    const release = acquireSyncLock(join(h.paths.dir, SYNC_LIST_LOCK_FILE))!
    setTimeout(release, 20)
    const result = await changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }), { retryMs: 5, waitMs: 2000 })
    expect(result.changed).toBe(true)
  })

  test("a sync run's lock does not block a change", async () => {
    const release = acquireSyncLock(h.paths.lock)!
    try {
      expect((await changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }), FAST)).changed).toBe(true)
    } finally {
      release()
    }
  })

  test("a cancelled wait stops with the cancellation", async () => {
    const release = acquireSyncLock(join(h.paths.dir, SYNC_LIST_LOCK_FILE))!
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    try {
      await expect(
        changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }), {
          signal: controller.signal,
          retryMs: 1000,
          waitMs: 5000,
        }),
      ).rejects.toMatchObject({ name: "AbortError" })
    } finally {
      release()
    }
  })

  test("a call cancelled before it starts writes nothing, even with the lock free", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      changeSyncList(h.paths, () => ({ servers: [{ id: SERVER }] }), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(existsSync(file)).toBe(false)
  })

  test("two changes at once both land", async () => {
    const add = (id: string) => changeSyncList(h.paths, (list) => ({ servers: [...list.servers, { id }] }))
    await Promise.all([add(serverId(0)), add(serverId(1))])
    expect((await readSyncList(h.paths)).servers).toHaveLength(2)
  })
})
