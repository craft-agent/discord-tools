import { describe, expect, test } from "bun:test"
import type { ToolSpec } from "../core"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { EXIT_OK, EXIT_USAGE } from "./cli"
import { cli, json } from "./testing"

const stateSpec: ToolSpec = {
  ...noteSpec,
  describe: (_args, ctx) => ({ facts: [{ label: "State", value: `${ctx.stateDir}|${ctx.options?.[NOTE_OPTION]}` }] }),
}

describe("command-line tool options", () => {
  test("target takes the storage flags beside the options", async () => {
    const target = await cli(
      ["target", NOTE_ID, "--cwd", "/work/project", "--state-dir", "/flag/state", "--note-text", "from flag"],
      "",
      { specs: [stateSpec] },
    )
    expect(target.code).toBe(EXIT_OK)
    expect(json(target).description.facts).toContainEqual({ label: "State", value: "/flag/state|from flag" })
  })

  test("run hands the storage settings and the options to the tool together", async () => {
    const seen: { stateDir?: string; options?: unknown }[] = []
    const spec: ToolSpec = {
      ...noteSpec,
      async execute(_args, ctx) {
        seen.push({ stateDir: ctx.stateDir, options: ctx.options })
        return { options: {} }
      },
    }
    const run = await cli(
      ["run", NOTE_ID, "--cwd", "/work/project", "--state-dir", "/flag/state", "--note-text", "from flag"],
      "",
      { specs: [spec] },
    )
    expect(run.code).toBe(EXIT_OK)
    expect(seen).toEqual([
      { stateDir: "/flag/state", options: { state_dir: "/flag/state", [NOTE_OPTION]: "from flag" } },
    ])
  })

  test("target and the person commands refuse the other settings' flags", async () => {
    for (const args of [
      ["target", NOTE_ID, "--cwd", "/work/project", "--read-only"],
      ["sync", "--note-text", "note"],
    ]) {
      expect((await cli(args, "", { specs: [noteSpec] })).code).toBe(EXIT_USAGE)
    }
  })

  test("run passes flags to execution and target passes them to the description", async () => {
    const run = await cli(["run", NOTE_ID, "--cwd", "/work/project", "--note-text", "from flag"], "", {
      specs: [noteSpec],
    })
    expect(run.code).toBe(EXIT_OK)
    expect(json(run)).toEqual({ result: { options: { [NOTE_OPTION]: "from flag" } } })
    const target = await cli(["target", NOTE_ID, "--cwd", "/work/project", "--note-text", "from flag"], "", {
      specs: [noteSpec],
    })
    expect(target.code).toBe(EXIT_OK)
    expect(json(target).description.facts).toContainEqual({ label: "Note", value: "from flag" })
  })

  test("run and target use environment options, overridden by flags", async () => {
    for (const command of ["run", "target"]) {
      for (const flags of [[], ["--note-text", "override"]]) {
        const result = await cli([command, NOTE_ID, "--cwd", "/work/project", ...flags], "", {
          specs: [noteSpec],
          env: { DEMO_NOTE_TEXT: "from env" },
        })
        expect(result.code).toBe(EXIT_OK)
        const value = flags.length ? "override" : "from env"
        if (command === "run") expect(json(result).result.options).toEqual({ [NOTE_OPTION]: value })
        else expect(json(result).description.facts).toContainEqual({ label: "Note", value })
      }
    }
  })

  test("run without options gets an empty set", async () => {
    expect(json(await cli(["run", NOTE_ID, "--cwd", "/work/project"], "", { specs: [noteSpec] }))).toEqual({
      result: { options: {} },
    })
  })

  test("list accepts tool options and every command rejects unknown flags", async () => {
    expect((await cli(["list", "--note-text", "note"], "", { specs: [noteSpec] })).code).toBe(EXIT_OK)
    for (const args of [
      ["list"],
      ["run", NOTE_ID, "--cwd", "/work/project"],
      ["target", NOTE_ID, "--cwd", "/work/project"],
    ]) {
      expect((await cli([...args, "--unknown", "value"], "", { specs: [noteSpec] })).code).toBe(EXIT_USAGE)
    }
  })
})
