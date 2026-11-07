import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILD_CACHE_FILE } from "./build-number"
import { type DiscordClient, type DiscordClientOptions, createDiscordClient } from "./client"
import { FakeDiscord } from "./fake-discord.testing"
import { fakeToken } from "./fake-token.testing"
import { type LabelPaths, ensureLabelDir } from "./labels"
import { resetPacing } from "./pacing"
import { writePrivateFile } from "./private-file"

/** A made-up token, shaped like a user token. */
export const FAKE_TOKEN = fakeToken()

/** The variable the harness's account reads its token from. */
export const TOKEN_VARIABLE = "EXAMPLE_TOKEN_DEFAULT"

/** A client over a fake Discord, a state directory and a clock that only moves when the client sleeps. */
export type Harness = {
  discord: FakeDiscord
  stateDir: string
  paths: LabelPaths
  client: DiscordClient
  /** The waits the clients asked for, in ms; the fixed `random` makes a pacing wait 1100 ms. */
  sleeps: number[]
  /** When each request reached the fake, by the fake clock. */
  sentAt: number[]
  now(): number
  advance(ms: number): void
  /** Caches a build number, so the next request is an API request and not the login page. */
  warm(): Promise<void>
  /** Another client of the same label, clock and fake. */
  another(overrides?: Partial<DiscordClientOptions>): DiscordClient
  dispose(): Promise<void>
}

const START_MS = 1_700_000_000_000

export async function createHarness(overrides: Partial<DiscordClientOptions> = {}): Promise<Harness> {
  resetPacing()
  const root = await mkdtemp(join(tmpdir(), "dsc-"))
  const stateDir = join(root, "state")
  const paths = await ensureLabelDir(stateDir, "default")
  const discord = new FakeDiscord()
  let time = START_MS
  const sleeps: number[] = []
  const sentAt: number[] = []

  const build = (extra: Partial<DiscordClientOptions>): DiscordClient =>
    createDiscordClient({
      stateDir,
      paths,
      tokenVariable: TOKEN_VARIABLE,
      env: { [TOKEN_VARIABLE]: FAKE_TOKEN },
      transport: (request) => {
        sentAt.push(time)
        return discord.transport(request)
      },
      os: "macos",
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms)
        time += ms
      },
      random: () => 0.5,
      ...overrides,
      ...extra,
    })

  return {
    discord,
    stateDir,
    paths,
    client: build({}),
    sleeps,
    sentAt,
    now: () => time,
    advance: (ms) => {
      time += ms
    },
    warm: () =>
      writePrivateFile(join(stateDir, BUILD_CACHE_FILE), JSON.stringify({ number: 100_000, fetchedAt: time })),
    another: build,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}
