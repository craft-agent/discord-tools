import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ToolError } from "../errors"
import { prepareOutgoing, type Outgoing, type OutgoingOptions } from "./outgoing"

/** The cap the fixture gives, in bytes. */
export const MAX_BYTES = 4096

/**
 * A temporary tree for one test: a working directory `work` (the one send
 * directory by default), a state directory `state` with the label's
 * `outgoing` folder, and a spare `other` directory.
 */
export async function createOutgoingFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsc-outgoing-")))
  const work = join(root, "work")
  const other = join(root, "other")
  const state = join(root, "state")
  const staging = join(state, "label", "outgoing")
  for (const dir of [work, other, state]) await mkdir(dir)
  const open: Outgoing[] = []

  return {
    root,
    work,
    other,
    state,
    staging,
    /** Writes a file under `root` (folders made as needed) and returns its path. */
    async write(path: string, data: string | Uint8Array = "hello") {
      const full = join(root, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, data)
      return full
    },
    /** `prepareOutgoing` with the fixture's directories; copies are closed with the fixture. */
    async prepare(paths: string[], overrides: Partial<OutgoingOptions> = {}) {
      const outgoing = await prepareOutgoing(paths, {
        cwd: work,
        dirs: [work],
        maxBytes: MAX_BYTES,
        privateDirs: { stateDir: state },
        staging,
        now: Date.now,
        ...overrides,
      })
      open.push(outgoing)
      return outgoing
    },
    /** The error a failed call throws. */
    async refusal(call: Promise<unknown>): Promise<ToolError> {
      const error = await call.then(
        () => undefined,
        (caught: unknown) => caught,
      )
      if (!(error instanceof ToolError)) throw new Error(`expected a ToolError, got ${String(error)}`)
      return error
    },
    /** What the staging folder holds, sorted; none when it is not there. */
    staged: () =>
      readdir(staging).then(
        (names) => names.sort(),
        () => [] as string[],
      ),
    async dispose() {
      await Promise.all(open.map((outgoing) => outgoing.close()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type OutgoingFixture = Awaited<ReturnType<typeof createOutgoingFixture>>
