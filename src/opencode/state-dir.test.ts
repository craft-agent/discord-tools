import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"
import { PROFILE } from "./testing"
import type { V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

describe("OpenCode state_dir setting", () => {
  const SESSION_ID = "ses_state"

  function stateTool(recorder: { target?: string; execute?: string }): ToolSpec {
    return defineTool({
      id: "demo_state_tool",
      title: "State Tool",
      description: "State Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.stateDir
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.stateDir
        return { ok: true }
      },
    })
  }

  describe("V1", () => {
    test("passes stateDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const { tool } = await createV1Server([stateTool(recorder)], { profile: PROFILE })(
        {},
        { state_dir: "/v1/custom/state" },
      )
      await tool.demo_state_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/custom/state")
      expect(recorder.execute).toBe("/v1/custom/state")
    })

    test("falls back to environment variable DEMO_STATE_DIR", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const { tool } = await createV1Server([stateTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_STATE_DIR: "/v1/env/state" },
      })({}, {})
      await tool.demo_state_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/env/state")
      expect(recorder.execute).toBe("/v1/env/state")
    })

    test("rejects an invalid state_dir option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { state_dir: 123 })).rejects.toThrow('Option "state_dir"')
      await expect(server({}, { state_dir: "relative/path" })).rejects.toThrow('Option "state_dir"')
    })
  })

  describe("download settings", () => {
    function downloadTool(recorder: { seen?: unknown }): ToolSpec {
      return defineTool({
        id: "demo_download_read",
        title: "Download Tool",
        description: "Download Tool",
        toolset: "alpha",
        class: "read",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async execute(_args, ctx) {
          recorder.seen = { downloadDir: ctx.downloadDir, downloadMaxMb: ctx.downloadMaxMb }
          return { ok: true }
        },
      })
    }

    test("V1 passes download_dir and download_max_mb from options, and the number may be a string", async () => {
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      for (const [max, expected] of [
        [25, 25],
        ["26", 26],
      ] as const) {
        const recorder: { seen?: unknown } = {}
        const { tool } = await createV1Server([downloadTool(recorder)], { profile: PROFILE })(
          {},
          { download_dir: "/v1/get", download_max_mb: max },
        )
        await tool.demo_download_read!.execute({}, context)
        expect(recorder.seen).toEqual({ downloadDir: "/v1/get", downloadMaxMb: expected })
      }
    })

    test("V2 passes download_dir and download_max_mb from options and falls back to the environment", async () => {
      const signal = new AbortController().signal
      for (const [options, env, expected] of [
        [{ download_dir: "/v2/get", download_max_mb: 30 }, {}, { downloadDir: "/v2/get", downloadMaxMb: 30 }],
        [
          {},
          { DEMO_DOWNLOAD_DIR: "/v2/env", DEMO_DOWNLOAD_MAX_MB: "31" },
          { downloadDir: "/v2/env", downloadMaxMb: 31 },
        ],
      ] as const) {
        const recorder: { seen?: unknown } = {}
        const tools = new Map<string, V2Tool>()
        const ctx: V2Context = {
          options: { ...options },
          session: { get: async () => ({ location: { directory: "/work/project" } }) },
          permission: { async assert() {} },
          tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
          skill: { transform: async () => {} },
        }
        await createV2Setup([downloadTool(recorder)], { profile: PROFILE, env })(ctx)
        await tools.get("demo_download_read")!.execute({}, { sessionID: SESSION_ID, signal })
        expect(recorder.seen).toEqual(expected)
      }
    })

    test("rejects an invalid download option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { download_dir: "relative/path" })).rejects.toThrow('Option "download_dir"')
      await expect(server({}, { download_max_mb: 0 })).rejects.toThrow("download_max_mb")
    })
  })

  describe("V2", () => {
    test("passes stateDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const tools = new Map<string, V2Tool>()
      const ctx: V2Context = {
        options: { state_dir: "/v2/custom/state" },
        session: {
          async get() {
            return { location: { directory: "/work/project" } }
          },
        },
        permission: {
          async assert() {},
        },
        tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
        skill: { transform: async () => {} },
      }
      await createV2Setup([stateTool(recorder)], { profile: PROFILE })(ctx)
      const signal = new AbortController().signal
      await tools.get("demo_state_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toBe("/v2/custom/state")
      expect(recorder.execute).toBe("/v2/custom/state")
    })

    test("rejects an invalid state_dir option", async () => {
      const ctx: V2Context = {
        options: { state_dir: "relative/path" },
        session: {
          async get() {
            return {}
          },
        },
        permission: { async assert() {} },
        tool: { transform: async () => {} },
        skill: { transform: async () => {} },
      }
      await expect(createV2Setup([], { profile: PROFILE })(ctx)).rejects.toThrow('Option "state_dir"')
    })
  })
})
