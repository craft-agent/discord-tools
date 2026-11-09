import { fileURLToPath } from "node:url"
import { packageRoot } from "../entry/package-root"
import { PROJECT } from "../project"
import { ALL_TOOLS } from "../tools"
import { ALL_TRANSLATIONS } from "../words"
import { EXIT_FAILED, runCli } from "./cli"
import { readSecretInput } from "./secret-input"

const CANCEL_SIGNALS = ["SIGTERM", "SIGINT"] as const

/** Login reads secret input; tool JSON reads a pipe only and never prompts on a terminal. */
async function readStdin(signal: AbortSignal): Promise<string> {
  if (process.argv[2] === "login") {
    return readSecretInput(process.stdin, (text) => process.stderr.write(text), signal)
  }
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const controller = new AbortController()
  for (const signal of CANCEL_SIGNALS) process.once(signal, () => controller.abort())

  const argv = process.argv.slice(2)
  process.exitCode = await runCli(argv, {
    specs: ALL_TOOLS,
    translations: ALL_TRANSLATIONS,
    env: process.env,
    ownDir: packageRoot(import.meta.url),
    readStdin: () => readStdin(controller.signal),
    program: process.execPath,
    entryPath: fileURLToPath(import.meta.url),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  })
  // A description given up on may still hold the process open, and the approval waits for it to end.
  if (argv[0] === "target") process.stdout.write("", () => process.stderr.write("", () => process.exit()))
}

main().catch((error: unknown) => {
  process.stderr.write(`${PROJECT.cli}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = EXIT_FAILED
})
