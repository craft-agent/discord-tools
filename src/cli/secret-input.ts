import type { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import type { ReadStream } from "node:tty"
import { abortError } from "../core"

/** A real stdin or an injected stream with the terminal controls used here. */
type SecretInput = Readable &
  Partial<Pick<ReadStream, "isTTY" | "isRaw">> & {
    setRawMode?(mode: boolean): void
  }

/** Reads a pipe to EOF, or one terminal line without echoing any input. */
export function readSecretInput(
  input: SecretInput,
  stderr: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const terminal = input.isTTY === true
    const wasRaw = input.isRaw === true
    const wasFlowing = input.readableFlowing === true
    const decoder = new StringDecoder("utf8")
    let text = ""
    let finished = false
    let rawAttempted = false

    function finish(error?: unknown): void {
      if (finished) return
      finished = true
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("close", onClose)
      input.off("error", onError)
      signal?.removeEventListener("abort", onAbort)
      try {
        if (rawAttempted) input.setRawMode!(wasRaw)
      } catch (restoreError) {
        error ??= restoreError
      } finally {
        if (wasFlowing) input.resume()
        else input.pause()
      }
      try {
        if (terminal && rawAttempted) stderr("\n")
      } catch (outputError) {
        error ??= outputError
      }
      if (error !== undefined) reject(error)
      else resolve(text)
      text = ""
    }

    function onAbort(): void {
      finish(abortError(signal ?? AbortSignal.abort()))
    }

    function onData(chunk: Buffer | string): void {
      const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk)
      if (!terminal) {
        text += decoded
        return
      }
      for (const character of decoded) {
        if (character === "\u0003") {
          finish(abortError(AbortSignal.abort()))
          return
        }
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish()
          return
        }
        if (character === "\u007f" || character === "\b") text = Array.from(text).slice(0, -1).join("")
        else if (character >= " ") text += character
      }
    }

    function onEnd(): void {
      text += decoder.end()
      finish()
    }

    function onClose(): void {
      finish(new Error("Secret input closed before completion."))
    }

    function onError(error: unknown): void {
      finish(error)
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    if (input.readableEnded) {
      finish()
      return
    }
    if (input.destroyed) {
      onClose()
      return
    }
    input.on("data", onData)
    input.once("end", onEnd)
    input.once("close", onClose)
    input.once("error", onError)
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      if (terminal) {
        if (!input.setRawMode) throw new Error("Secret input requires terminal raw mode.")
        rawAttempted = true
        input.setRawMode(true)
        stderr("Token (input hidden): ")
      }
      if (!finished) input.resume()
    } catch (error) {
      finish(error)
    }
  })
}
