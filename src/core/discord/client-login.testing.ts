import { createHarness, type Harness, TOKEN_VARIABLE } from "./client.testing"
import type { loginAccount } from "./client-login"
import { fakeToken } from "./fake-token.testing"

/** Login over the existing fake transport and clock, never a real service. */
export async function loginFixture(): Promise<{
  harness: Harness
  options: Parameters<typeof loginAccount>[0]
}> {
  const harness = await createHarness()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "101", username: "example" } })
  return {
    harness,
    options: {
      stateDir: harness.stateDir,
      paths: harness.paths,
      tokenVariable: TOKEN_VARIABLE,
      env: {},
      readInput: async () => fakeToken(),
      transport: harness.discord.transport,
      os: "macos",
      now: harness.now,
      sleep: async (ms) => harness.advance(ms),
      random: () => 0.5,
    },
  }
}
