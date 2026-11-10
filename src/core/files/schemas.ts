import { z } from "zod"
import { actionFields } from "../actions/schemas"
import type { ArchiveFormat } from "../archive/kinds"

/** The kinds of file a message carries, in the order they are saved. */
export const FILE_KINDS = ["attachment", "preview", "sticker"] as const

/** What became of each file. */
export const FILE_STATUSES = ["saved", "already", "refused", "too_large", "missing", "failed"] as const

const ARCHIVE_FORMATS = ["zip", "tar", "tar.gz"] as const satisfies readonly ArchiveFormat[]

export const saveInput = z.object({
  ...actionFields,
  unpack: z
    .boolean()
    .optional()
    .describe(
      "Also unpack every archive (.zip, .tar, .tar.gz, .tgz) the call saves or finds already saved, into a new folder beside it (default false). Do this only when the person asks.",
    ),
  entries: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      "With `unpack`: unpack only these names or folders, as an archive's listing shows them (an unknown name unpacks nothing and is reported on the archive). Left out, everything is unpacked.",
    ),
})

/** The arguments of `discord_file_save` after validation. */
export type SaveInput = z.output<typeof saveInput>

const archiveReport = z.object({
  format: z.enum(ARCHIVE_FORMATS).describe("The archive format the bytes have."),
  entries: z.number().int().describe("How many files with data the archive holds."),
  unpacked: z.number().int().describe("How many bytes those files hold when unpacked, counted from the bytes read."),
  names: z.array(z.string()).describe("The first names in the archive, odd characters shown as `?` and cut to 80."),
  more: z.number().int().describe("How many files are not in `names`."),
})

const unpackReport = z.object({
  folder: z.string().describe("The absolute path of the new folder, beside the archive."),
  count: z.number().int().describe("How many files were written."),
  unpacked: z.number().int().describe("How many bytes were written."),
  files: z.array(z.string()).describe("The first paths written, relative to `folder`."),
  more: z.number().int().describe("How many files are not in `files`."),
})

const savedFile = z.object({
  name: z.string().describe("The name the file gets, cleaned to a base name of plain characters."),
  kind: z
    .enum(FILE_KINDS)
    .describe(
      "`attachment` is a file the message carries, `preview` the image of a link preview, `sticker` a sticker.",
    ),
  status: z
    .enum(FILE_STATUSES)
    .describe(
      "`saved` is a new file; `already` a file of the same name and the same bytes was there; `refused` it was not kept (see `why`); `too_large`, `missing` and `failed` it could not be downloaded.",
    ),
  why: z.string().optional().describe("What kept the file from being saved."),
  path: z.string().optional().describe("Where the file is, for `saved` and `already`."),
  type: z.string().optional().describe("The media type the host answered with, else the one Discord declared."),
  size: z.number().int().optional().describe("The size in bytes of what was saved, else the one Discord declared."),
  preview_of: z.string().optional().describe("The link whose preview this is."),
  archive: archiveReport.optional().describe("What the archive holds, for an archive that was saved."),
  unpacked: unpackReport.optional().describe("The result of unpacking this archive, when `unpack` was set."),
  unpack_error: z.string().optional().describe("Why this archive was not unpacked; the archive stays saved."),
})

export const saveOutput = z.object({
  channel: z.string().describe("The id of the chat the message is in."),
  id: z.string().describe("The id of the message."),
  folder: z
    .string()
    .nullable()
    .describe("The folder the files are in, or null when none was saved and none was found already saved."),
  files: z.array(savedFile).describe("Every file the message carries, in order, each with its outcome."),
  note: z.string(),
})

/** One file of the message and what became of it. */
export type SavedFile = z.infer<typeof savedFile>

/** The kind of a file of the message. */
export type FileKind = (typeof FILE_KINDS)[number]

/** The result of `discord_file_save`. */
export type SaveResult = z.infer<typeof saveOutput>
