import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { readSecretInput } from "./secret-input"

function terminal(wasRaw = false) {
  const modes: boolean[] = []
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: wasRaw,
    setRawMode(mode: boolean) {
      modes.push(mode)
      this.isRaw = mode
      return this
    },
  })
  let output = ""
  const stderr = (text: string) => {
    output += text
  }
  return { input, modes, stderr, output: () => output }
}

function cleaned(input: PassThrough) {
  for (const event of ["data", "end", "close", "error"]) expect(input.listenerCount(event)).toBe(0)
  expect(input.isPaused()).toBe(true)
}

describe("secret stdin", () => {
  test("a pipe reads UTF-8 through EOF without a prompt", async () => {
    const input = new PassThrough()
    let output = ""
    const result = readSecretInput(input, (text) => {
      output += text
    })
    const bytes = Buffer.from("made-up-é\nsecond-line\n")
    input.write(bytes.subarray(0, 9))
    input.end(bytes.subarray(9))
    expect(await result).toBe(bytes.toString("utf8"))
    expect(output).toBe("")
    cleaned(input)
  })

  test.each(["\r", "\n", "\r\n"])("terminal input stops at %j and supports backspace without echo", async (ending) => {
    const t = terminal()
    const result = readSecretInput(t.input, t.stderr)
    t.input.write(`made-up-é\u007fx\btoken${ending}ignored`)
    expect(await result).toBe("made-up-token")
    expect(t.output()).toBe("Token (input hidden): \n")
    expect(t.modes).toEqual([true, false])
    cleaned(t.input)
  })

  test("Ctrl-C cancels and restores a previously raw terminal", async () => {
    const t = terminal(true)
    const result = readSecretInput(t.input, t.stderr)
    t.input.write("made-up\u0003")
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(t.modes).toEqual([true, true])
    expect(t.output()).not.toContain("made-up")
    cleaned(t.input)
  })

  test.each(["abort", "error", "close", "end"])("%s releases terminal controls and listeners", async (ending) => {
    const t = terminal()
    const controller = new AbortController()
    const result = readSecretInput(t.input, t.stderr, controller.signal)
    t.input.write("made-up")
    if (ending === "abort") controller.abort()
    else if (ending === "error") t.input.emit("error", new Error("input failed"))
    else if (ending === "close") t.input.emit("close")
    else t.input.end()
    if (ending === "end") expect(await result).toBe("made-up")
    else await expect(result).rejects.toBeInstanceOf(Error)
    expect(t.modes).toEqual([true, false])
    cleaned(t.input)
  })

  test("already cancelled input never enables raw mode", async () => {
    const t = terminal()
    await expect(readSecretInput(t.input, t.stderr, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" })
    expect(t.modes).toEqual([])
    expect(t.output()).toBe("")
    cleaned(t.input)
  })

  test("a prompt failure restores raw mode", async () => {
    const t = terminal()
    await expect(
      readSecretInput(t.input, () => {
        throw new Error("output failed")
      }),
    ).rejects.toThrow("output failed")
    expect(t.modes).toEqual([true, false])
    cleaned(t.input)
  })

  test("raw-mode setup failure still attempts restoration and releases listeners", async () => {
    const t = terminal()
    t.input.setRawMode = (mode: boolean) => {
      t.modes.push(mode)
      if (mode) throw new Error("raw mode failed")
      return t.input
    }
    await expect(readSecretInput(t.input, t.stderr)).rejects.toThrow("raw mode failed")
    expect(t.modes).toEqual([true, false])
    cleaned(t.input)
  })

  test("a cancelled pipe releases its listeners without printing a prompt", async () => {
    const input = new PassThrough()
    const controller = new AbortController()
    let output = ""
    const result = readSecretInput(
      input,
      (text) => {
        output += text
      },
      controller.signal,
    )
    input.write("made-up")
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(output).toBe("")
    cleaned(input)
  })
})
