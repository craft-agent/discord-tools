import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/** What release tags carry: macOS and Linux with glibc. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu"]

const PACKAGES = ["wreq-js", ...PLATFORMS.map((platform) => `@wreq-js/binding-${platform}`)]

export function parseLockfile(text) {
  const packages = text.match(/^packages:\r?\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1]
  if (packages === undefined) throw new Error("The lockfile has no packages section.")
  const entries = [...packages.matchAll(/^  ['"]?([^\s'"]+)['"]?:\r?\n((?: {4}.*\r?\n|\r?\n)*)/gm)]
  return PACKAGES.map((name) => {
    const matches = entries.filter((entry) => entry[1].startsWith(`${name}@`))
    if (matches.length !== 1)
      throw new Error(`Expected one lockfile packages entry for ${name}; found ${matches.length}.`)
    const [, key, body] = matches[0]
    const version = key.slice(name.length + 1)
    const integrity = body.match(/\bintegrity:\s*['"]?(sha512-[A-Za-z0-9+/]+={0,2})['"]?(?=[,}\s]|$)/)?.[1]
    if (!/^\d+\.\d+\.\d+$/.test(version) || !integrity) {
      throw new Error(`Invalid version or missing sha512 integrity in the lockfile for ${name}.`)
    }
    return { name, version, integrity }
  })
}

export function checkIntegrity(data, integrity) {
  const actual = `sha512-${createHash("sha512").update(data).digest("base64")}`
  if (actual !== integrity) throw new Error("Tarball sha512 integrity mismatch.")
}

async function nativeTree(dir) {
  const entries = parseLockfile(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"))
  mkdirSync(dir, { recursive: true })
  const staging = mkdtempSync(join(dir, "node_modules.tmp-"))
  try {
    for (const { name, version, integrity } of entries) {
      const basename = name.split("/").at(-1)
      const url = `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Downloading ${name}: HTTP ${response.status} ${response.statusText}.`)
      const data = Buffer.from(await response.arrayBuffer())
      try {
        checkIntegrity(data, integrity)
      } catch (error) {
        throw new Error(`${name}@${version}: ${error.message}`)
      }
      const archive = join(staging, `${basename}.tgz`)
      const dest = join(staging, name)
      writeFileSync(archive, data)
      mkdirSync(dest, { recursive: true })
      execFileSync("tar", ["-xzf", archive, "-C", dest, "--strip-components=1"])
      if (readdirSync(dest, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink())) {
        throw new Error(`${name}@${version}: the tarball contains symlinks.`)
      }
      rmSync(archive)
    }
    const destination = join(dir, "node_modules")
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/native-tree.mjs <dir>")
    await nativeTree(resolve(process.argv[2]))
  } catch (error) {
    console.error(`Native tree: ${error.message}`)
    process.exitCode = 1
  }
}
