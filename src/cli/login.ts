import { loginAccount } from "../core/discord/client-login"
import { DEFAULT_LABEL, labelPaths } from "../core/discord/labels"
import { tokenVariable } from "../core/discord/token"
import { PROJECT_PROFILE } from "../entry/profile"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, usageError } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

/** Signs in from the environment or secret standard input; never accepts a token argument. */
export async function runLoginCommand(
  argv: string[],
  io: CommandIo & { readStdin(): Promise<string> },
  deps: { login?: typeof loginAccount } = {},
): Promise<number> {
  let stateDir: string
  let paths: ReturnType<typeof labelPaths>
  try {
    const { values, rest } = parseFlagArgs(argv, { values: ["--account", "--state-dir"] })
    if (rest.length) throw usageError("Login accepts only --account and --state-dir.")
    stateDir = parseCommandStateDir([], io, values["--state-dir"])
    paths = labelPaths(stateDir, values["--account"] ?? DEFAULT_LABEL)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }
  try {
    const account = await (deps.login ?? loginAccount)({
      stateDir,
      paths,
      tokenVariable: tokenVariable((io.profile ?? PROJECT_PROFILE).envPrefix, paths.label),
      env: io.env,
      readInput: () => io.readStdin(),
      signal: io.signal,
    })
    io.stdout(
      `Signed in "${paths.label}" as ${JSON.stringify(account.name)} (${account.id}); token source: ${account.source}.\n`,
    )
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Login was cancelled." })
  }
}
