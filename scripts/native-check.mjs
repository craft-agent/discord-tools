import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

try {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/native-check.mjs <dir>")
  const dir = resolve(process.argv[2])
  const require = createRequire(join(dir, "dist", "mcp.js"))
  const resolved = realpathSync(require.resolve("wreq-js"))
  const location = relative(realpathSync(join(dir, "node_modules")), resolved)
  if (isAbsolute(location) || location === ".." || location.startsWith("../")) {
    throw new Error(`wreq-js resolved outside the release tree: ${resolved}`)
  }
  const library = await import(pathToFileURL(resolved).href)
  if (!library.getProfiles().includes("chrome_149")) throw new Error("wreq-js has no chrome_149 profile.")
  console.log(`Native release tree loads wreq-js for ${process.platform}-${process.arch}.`)
} catch (error) {
  console.error(`Native check: ${error.message}`)
  process.exitCode = 1
}
