import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

/** The runtimes a child process can take the lock in. */
export type LockRuntime = "bun" | "node"

/** How long a child may take to report, in milliseconds. */
const CHILD_TIMEOUT_MS = 4_000

/** The lock module as a child on Bun imports it. */
const SYNC_LOCK_MODULE = fileURLToPath(new URL("./sync-lock.ts", import.meta.url))

/** Holds the lock the way `acquireSyncLock` does, for a child that cannot import TypeScript. */
const NODE_HOLDER = `
const { DatabaseSync } = require("node:sqlite")
const db = new DatabaseSync(process.env.LOCK_PATH)
db.exec("PRAGMA busy_timeout = 0")
db.exec("BEGIN IMMEDIATE")
console.log("held")
setInterval(() => db, 1000)
`

const BUN_HOLDER = `
import { acquireSyncLock } from ${JSON.stringify(SYNC_LOCK_MODULE)}
const release = acquireSyncLock(process.env.LOCK_PATH)
console.log(release ? "held" : "busy")
setInterval(() => release, 1000)
`

const BUN_TRY = `
import { acquireSyncLock } from ${JSON.stringify(SYNC_LOCK_MODULE)}
try {
  const release = acquireSyncLock(process.env.LOCK_PATH)
  console.log(release ? "held" : "busy")
  release?.()
} catch {
  console.log("error")
}
`

function runChild(runtime: LockRuntime, script: string, lockPath: string): ChildProcess {
  const command = runtime === "bun" ? process.execPath : "node"
  const args = runtime === "bun" ? ["-e", script] : ["--no-warnings", "-e", script]
  const child = spawn(command, args, {
    env: { ...process.env, LOCK_PATH: lockPath },
    stdio: ["ignore", "pipe", "pipe"],
  })
  // A spawn or kill failure after the first line must not crash the test run as an unhandled event.
  child.on("error", () => {})
  return child
}

/** The first line the child prints; rejects when it fails to start, exits or stays silent first. */
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    let errors = ""
    const onStderr = (chunk: Buffer) => (errors += chunk)
    const onStdout = (chunk: Buffer) => {
      output += chunk
      const end = output.indexOf("\n")
      if (end >= 0) settle(() => resolve(output.slice(0, end)))
    }
    const onError = (error: Error) => settle(() => reject(error))
    const onExit = () => settle(() => reject(new Error(`child exited early: ${errors}`)))
    const timer = setTimeout(() => settle(() => reject(new Error(`child silent: ${errors}`))), CHILD_TIMEOUT_MS)

    function settle(finish: () => void): void {
      clearTimeout(timer)
      child.stderr?.off("data", onStderr)
      child.stdout?.off("data", onStdout)
      child.off("error", onError)
      child.off("exit", onExit)
      finish()
    }

    child.stderr?.on("data", onStderr)
    child.stdout?.on("data", onStdout)
    child.on("error", onError)
    child.on("exit", onExit)
  })
}

/** Kills the child and waits until it is gone, so its locks are released; a child that never started has nothing to wait for. */
function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once("exit", () => resolve())
    child.kill("SIGKILL")
  })
}

/** A child process that holds the lock until it is killed. */
export type LockHolder = { child: ChildProcess; kill(): Promise<void> }

/** Starts a child in `runtime` that takes the lock at `lockPath` and holds it; rejects unless it got it. */
export async function holdLockInChild(runtime: LockRuntime, lockPath: string): Promise<LockHolder> {
  const child = runChild(runtime, runtime === "bun" ? BUN_HOLDER : NODE_HOLDER, lockPath)
  try {
    const line = await firstLine(child)
    if (line !== "held") throw new Error(`child did not get the lock: ${line}`)
  } catch (error) {
    await killAndWait(child)
    throw error
  }
  return { child, kill: () => killAndWait(child) }
}

/** Runs a Bun child that tries the lock once, releasing it at once; says whether it got it, found it busy or failed. */
export async function tryLockInChild(lockPath: string): Promise<"held" | "busy" | "error"> {
  const child = runChild("bun", BUN_TRY, lockPath)
  try {
    return (await firstLine(child)) as "held" | "busy" | "error"
  } finally {
    await killAndWait(child)
  }
}
