import { expect, test } from "bun:test"
import { PROJECT_PROFILE } from "./profile"
import { createToolRuntime } from "./runtime"
import { runtimeFixture } from "./runtime.testing"

test("runtime construction preserves injected references without inspecting state, scheduler or clock", () => {
  const options = runtimeFixture()
  options.env = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not read state or credentials")
      },
    },
  )
  const runtime = createToolRuntime(options)
  expect(runtime.envPrefix).toBe(options.profile.envPrefix)
  expect(runtime.cli).toBe(options.profile.cli)
  expect(runtime.serviceId).toBe(options.profile.serviceId)
  expect(runtime.env).toBe(options.env)
  expect(runtime.serviceHost).toBe(options.serviceHost)
  expect(runtime.now).toBe(options.now)
  expect(options.now).not.toHaveBeenCalled()
})

test("runtime defaults use the package identity and retain the process environment and clock", () => {
  const runtime = createToolRuntime()
  expect(runtime.envPrefix).toBe(PROJECT_PROFILE.envPrefix)
  expect(runtime.cli).toBe(PROJECT_PROFILE.cli)
  expect(runtime.serviceId).toBe(PROJECT_PROFILE.serviceId)
  expect(runtime.env === process.env).toBe(true)
  expect(runtime.now).toBe(Date.now)
  expect(typeof runtime.serviceHost.run).toBe("function")
})
