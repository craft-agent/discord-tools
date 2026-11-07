import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"

const modulePath = JSON.stringify(new URL("./command-io.ts", import.meta.url).pathname)

/** Runs the real terminal reader in a child with pipes, a deadline and no inherited credentials. */
function readInChild(
  mode: "eof" | "answer" | "abort" | "already-aborted",
): Promise<{ stdout: string; stderr: string }> {
  const script = `
    import { defaultReadLine } from ${modulePath};
    const controller = new AbortController();
    if (${JSON.stringify(mode)} === "already-aborted") controller.abort();
    const answer = defaultReadLine("Confirm: ", controller.signal);
    if (${JSON.stringify(mode)} === "abort") controller.abort();
    console.log(JSON.stringify({ answer: (await answer) ?? null }));
  `
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--eval", script],
      {
        env: { PATH: process.env.PATH },
        timeout: 5_000,
      },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    )
    if (mode === "eof") child.stdin!.end()
    if (mode === "answer") child.stdin!.end("work\n")
  })
}

describe("defaultReadLine", () => {
  test("EOF resolves promptly rather than leaving question pending", async () => {
    const result = await readInChild("eof")
    expect(result.stdout).toBe('{"answer":null}\n')
    expect(result.stderr).toContain("Confirm: ")
  })

  test("the prompt goes to stderr and the answer is read", async () => {
    const result = await readInChild("answer")
    expect(result.stdout).toBe('{"answer":"work"}\n')
    expect(result.stderr).toContain("Confirm: ")
  })

  test.each(["abort", "already-aborted"] as const)("%s closes the reader even while stdin stays open", async (mode) => {
    const result = await readInChild(mode)
    expect(result.stdout).toBe('{"answer":null}\n')
  })
})
