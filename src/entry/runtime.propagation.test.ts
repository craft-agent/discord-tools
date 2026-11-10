import { afterEach, expect, test } from "bun:test"
import { z } from "zod"
import { cli } from "../cli/testing"
import { defineTool, type ToolContext } from "../core"
import { call, connect, runCleanups, settings } from "../mcp/testing"
import type { V2Context, V2Tool } from "../opencode/types"
import { createV1Server } from "../opencode/v1"
import { createV2Setup } from "../opencode/v2"
import { runtimeFixture } from "./runtime.testing"

afterEach(runCleanups)

function probe() {
  const options = runtimeFixture()
  const targets: ToolContext[] = []
  const executions: ToolContext[] = []
  const spec = defineTool({
    id: "demo_runtime_probe",
    title: "Runtime probe",
    description: "Records the context supplied to targets and execution.",
    toolset: "alpha",
    class: "add",
    input: z.object({}),
    output: z.object({ time: z.number() }),
    targets(_args, ctx) {
      targets.push(ctx)
      return ["runtime-target"]
    },
    async execute(_args, ctx) {
      executions.push(ctx)
      return { time: ctx.runtime!.now() }
    },
  })
  function check(ctx: ToolContext) {
    expect(ctx.stateDir).toBe("/runtime/state")
    expect(ctx.downloadDir).toBe("/runtime/downloads")
    expect(ctx.downloadMaxMb).toBe(42)
    expect(ctx.sendDirs).toEqual(["/runtime/send1", "/runtime/send2"])
    expect(ctx.sendMaxMb).toBe(15)
    expect(ctx.runtime?.envPrefix).toBe(options.profile.envPrefix)
    expect(ctx.runtime?.cli).toBe(options.profile.cli)
    expect(ctx.runtime?.serviceId).toBe(options.profile.serviceId)
    expect(ctx.runtime?.env).toBe(options.env)
    expect(ctx.runtime?.serviceHost).toBe(options.serviceHost)
    expect(ctx.runtime?.now).toBe(options.now)
  }
  return { options, spec, targets, executions, check }
}

test("CLI run and target receive the injected runtime", async () => {
  const p = probe()
  for (const command of ["run", "target"]) {
    const result = await cli([command, p.spec.id, "--cwd", "/work"], "{}", { ...p.options, specs: [p.spec] })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
  }
  expect(p.executions).toHaveLength(1)
  expect(p.targets).toHaveLength(1)
  p.check(p.executions[0]!)
  p.check(p.targets[0]!)
})

test("MCP uses the injected profile name, default toolsets and execution runtime", async () => {
  const p = probe()
  const { client } = await connect(
    [p.spec],
    settings({
      state_dir: "/runtime/state",
      download_dir: "/runtime/downloads",
      download_max_mb: 42,
      send_dirs: ["/runtime/send1", "/runtime/send2"],
      send_max_mb: 15,
    }),
    {},
    {
      ...p.options,
      toolsets: undefined,
    },
  )
  expect(client.getServerVersion()?.name).toBe(p.options.profile.name)
  expect((await call(client, p.spec.id)).structuredContent).toEqual({ time: 123456 })
  expect(p.executions).toHaveLength(1)
  p.check(p.executions[0]!)
})

test("MCP explicit toolsets still override the injected profile", async () => {
  const p = probe()
  const { client } = await connect([p.spec], settings(), {}, { ...p.options, toolsets: { names: [], defaults: [] } })
  expect((await client.listTools()).tools).toEqual([])
})

test("OpenCode V1 shares one injected runtime between targets and execution", async () => {
  const p = probe()
  const { tool } = await createV1Server([p.spec], p.options)({})
  expect(
    await tool[p.spec.id]!.execute(
      {},
      {
        directory: "/work",
        worktree: "/work",
        abort: new AbortController().signal,
        ask: async () => {},
      },
    ),
  ).toBe('{"time":123456}')
  expect(p.targets).toHaveLength(1)
  expect(p.executions).toHaveLength(1)
  p.check(p.targets[0]!)
  p.check(p.executions[0]!)
  expect(p.targets[0]!.runtime).toBe(p.executions[0]!.runtime)
})

test("OpenCode V2 shares one injected runtime between targets and execution", async () => {
  const p = probe()
  const tools: V2Tool[] = []
  const context: V2Context = {
    session: { get: async () => ({ location: { directory: "/work" } }) },
    permission: { assert: async () => {} },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.push(tool) })
      },
    },
    skill: { transform: async () => {} },
  }
  await createV2Setup([p.spec], p.options)(context)
  expect((await tools[0]!.execute({}, { sessionID: "ses_test", signal: new AbortController().signal })).output).toEqual(
    { time: 123456 },
  )
  expect(p.targets).toHaveLength(1)
  expect(p.executions).toHaveLength(1)
  p.check(p.targets[0]!)
  p.check(p.executions[0]!)
  expect(p.targets[0]!.runtime).toBe(p.executions[0]!.runtime)
})
