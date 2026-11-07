import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTempDir } from "./mirror.testing"
import { acquireSyncLock } from "./sync-lock"
import { holdLockInChild, tryLockInChild, type LockHolder, type LockRuntime } from "./sync-lock.testing"

let tempDir: string
let lockPath: string
const holders: LockHolder[] = []
const releases: (() => void)[] = []

beforeEach(() => {
  tempDir = makeTempDir()
  lockPath = join(tempDir, "sync.lock")
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(holders.splice(0).map((holder) => holder.kill()))
  rmSync(tempDir, { recursive: true, force: true })
})

/** Tracks even an unexpectedly successful acquisition for teardown. */
function acquireTrackedLock(): (() => void) | undefined {
  const release = acquireSyncLock(lockPath)
  if (release) releases.push(release)
  return release
}

async function hold(runtime: LockRuntime): Promise<LockHolder> {
  const holder = await holdLockInChild(runtime, lockPath)
  holders.push(holder)
  return holder
}

describe.each<LockRuntime>(["bun", "node"])("a lock held by a %s process", (runtime) => {
  test("keeps this process out", async () => {
    await hold(runtime)
    expect(acquireTrackedLock()).toBeUndefined()
  })

  test("is free again once the holder is killed", async () => {
    const holder = await hold(runtime)
    await holder.kill()
    const release = acquireTrackedLock()
    expect(release).toBeDefined()
    release?.()
  })

  test("excludes this process on a file left behind by an earlier release", async () => {
    acquireTrackedLock()?.()
    await hold(runtime)
    expect(acquireTrackedLock()).toBeUndefined()
  })
})

describe("a lock held by this process", () => {
  test("keeps a separate process out until it is released", async () => {
    const release = acquireTrackedLock()
    expect(release).toBeDefined()
    expect(await tryLockInChild(lockPath)).toBe("busy")
    release?.()
    expect(await tryLockInChild(lockPath)).toBe("held")
  })

  test("is not mistaken for busy by a process that finds a corrupt file", async () => {
    writeFileSync(lockPath, "not a database, just stale bytes")
    expect(await tryLockInChild(lockPath)).toBe("error")
  })

  test("holders in two runtimes exclude each other", async () => {
    await hold("node")
    expect(await tryLockInChild(lockPath)).toBe("busy")
  })
})
