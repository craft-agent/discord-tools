import { readdir } from "node:fs/promises"
import { FILES_MAX } from "../sends/outgoing"
import { createOutgoingFixture } from "../sends/outgoing.testing"
import { slotOf } from "../sends/upload.testing"
import { invoke, type ToolContext } from "../tool"
import { discordFilePost } from "./file-post-tool"
import { createPostsFixture, postObject, postPath, starterObject, TAGGED_FORUM } from "./post.testing"

/** Where Discord's reservation of a forum's uploads is asked. */
export const attachPath = (forum = TAGGED_FORUM) => `/channels/${forum}/attachments`

/** The made-up text of a post that carries one besides its files. */
export const FILE_TEXT = "Screenshots attached."

/**
 * The posts fixture, a temporary tree for the files (`files.work` is the
 * working directory), and a forum that reserves and accepts uploads and
 * answers a post, unless a test says otherwise.
 */
export async function createFilePostFixture() {
  const f = await createPostsFixture()
  const files = await createOutgoingFixture()
  const ctx: ToolContext = { ...f.ctx, cwd: files.work }
  const serveUploads = (forum: string) =>
    f.discord.route("POST", attachPath(forum), (request) => ({
      status: 200,
      json: { attachments: (JSON.parse(request.body!) as { files: unknown[] }).files.map((_, index) => slotOf(index)) },
    }))
  serveUploads(TAGGED_FORUM)
  for (let index = 0; index < FILES_MAX; index++) {
    f.discord.route("PUT", `/up/${index}/file.bin`, { status: 200 })
  }
  f.discord.route("POST", postPath(), { status: 200, json: { ...postObject(), message: starterObject() } })
  return {
    ...f,
    files,
    ctx,
    serveUploads,
    /** Runs `discord_file_post` as an entry point does, in the fixture's working directory unless `overrides` say otherwise. */
    postFiles: (args: unknown, overrides: Partial<ToolContext> = {}) =>
      invoke(discordFilePost, args, { ...ctx, ...overrides }),
    /** The uploads the fake received, in order. */
    puts: () => f.discord.requests.filter((request) => request.method === "PUT"),
    /** The reservations the fake received for a forum. */
    reservations: (forum = TAGGED_FORUM) =>
      f.discord.api.filter((request) => request.method === "POST" && request.path === attachPath(forum)),
    /** The bodies of the posts the fake received for a forum, as sent. */
    posted: (forum = TAGGED_FORUM) =>
      f.discord.api
        .filter((request) => request.method === "POST" && request.path === postPath(forum))
        .map((request) => JSON.parse(request.body!) as { name: string; applied_tags: string[]; message: object }),
    /** Every request to Discord's API and to its storage, as `METHOD path`, in order. */
    sequence: () =>
      f.discord.requests
        .filter((request) => request.method === "PUT" || request.url.includes("/api/v9"))
        .map((request) => `${request.method} ${request.path}`),
    /** Whether nothing was requested of Discord, its API or its storage. */
    untouched: () => f.discord.api.length === 0 && f.discord.requests.every((request) => request.method !== "PUT"),
    /** What the label's staging folder holds. */
    staged: () =>
      readdir(f.paths.outgoing).then(
        (names) => names.sort(),
        () => [] as string[],
      ),
    dispose: async () => {
      await files.dispose()
      await f.dispose()
    },
  }
}

export type FilePostFixture = Awaited<ReturnType<typeof createFilePostFixture>>
