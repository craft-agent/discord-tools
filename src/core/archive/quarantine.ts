import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { exec } from "../exec"

const XATTR = "/usr/bin/xattr"
const ATTRIBUTE = "com.apple.quarantine"
/** The flags a browser gives a download: "quarantined, not yet approved by the user". */
const FLAGS = "0081"
const GROUP_SIZE = 100
const TIMEOUT_MS = 60_000
const UNSAFE_AGENT = /[;\u0000-\u001f\u007f-\u009f]/g

export type QuarantineOptions = {
  /** The name of the program that "downloaded" the files, as the system shows it. */
  agent: string
  /** The environment the marking program runs in. */
  env: Record<string, string>
  /** Milliseconds since the epoch. */
  now: () => number
  platform?: NodeJS.Platform
  run?: typeof exec
  signal?: AbortSignal
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** Marks files as downloaded on macOS (`com.apple.quarantine`) so the system asks before opening them; does nothing elsewhere and never throws. */
export async function quarantine(paths: string[], options: QuarantineOptions): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin" || paths.length === 0) return
  const run = options.run ?? exec
  const agent = options.agent.replace(UNSAFE_AGENT, "")
  const files: string[] = []
  for (const path of paths) if (await isRegularFile(path)) files.push(path)
  for (let start = 0; start < files.length; start += GROUP_SIZE) {
    if (options.signal?.aborted) return
    const seconds = Math.floor(options.now() / 1000).toString(16)
    const value = `${FLAGS};${seconds};${agent};${randomUUID().toUpperCase()}`
    try {
      // `-s` marks a link put in a file's place since the check, never what it points to.
      await run([XATTR, "-s", "-w", ATTRIBUTE, value, "--", ...files.slice(start, start + GROUP_SIZE)], {
        env: options.env,
        timeoutMs: TIMEOUT_MS,
        signal: options.signal,
      })
    } catch {
      // Marking is best effort: a failed group does not stop the next.
    }
  }
}
