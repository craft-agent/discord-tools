import { z } from "zod"
import { fileSendInput, sentFilesOutput } from "../sends/schemas"
import { postCreateInput, postCreateOutput } from "./post-schemas"

export const filePostInput = postCreateInput.extend({
  text: fileSendInput.shape.text,
  files: fileSendInput.shape.files,
})

/** The arguments of `discord_file_post` after validation. */
export type FilePostInput = z.output<typeof filePostInput>

export const filePostOutput = postCreateOutput.extend({ files: sentFilesOutput })

/** The result of `discord_file_post`. */
export type FilePostResult = z.infer<typeof filePostOutput>
