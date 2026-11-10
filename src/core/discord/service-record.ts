import { existsSync } from "node:fs"
import type { LabelPaths } from "./labels"
import { readJsonFile, writePrivateFile } from "./private-file"
import { removeFile } from "./service-types"

/** The absolute paths of the program the scheduled sync runs and the script it runs. */
export type ServiceRecord = { program: string; script: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * Writes the label's service record (mode 600) atomically: a staging file in the label directory is renamed over
 * the record, so a reader never sees a partial file and a link at its path is replaced.
 */
export async function writeServiceRecord(paths: LabelPaths, record: ServiceRecord): Promise<void> {
  await writePrivateFile(paths.serviceRecord, JSON.stringify({ program: record.program, script: record.script }))
}

/**
 * The label's service record, or `null` when the file is missing, unreadable, not JSON, or `program` or `script`
 * is not a non-empty string. Never throws for those cases.
 */
export async function readServiceRecord(paths: LabelPaths): Promise<ServiceRecord | null> {
  const parsed = await readJsonFile(paths.serviceRecord)
  if (typeof parsed !== "object" || parsed === null) return null
  const { program, script } = parsed as Record<string, unknown>
  if (!isNonEmptyString(program) || !isNonEmptyString(script)) return null
  return { program, script }
}

/** Deletes the label's service record; a missing file is not an error. */
export async function removeServiceRecord(paths: LabelPaths): Promise<void> {
  await removeFile(paths.serviceRecord)
}

/**
 * Which of the record's paths no longer exist; `[]` when both do.
 * Links are followed, so a dangling link counts as missing.
 */
export function missingServiceFiles(record: ServiceRecord): Array<"program" | "script"> {
  const missing: Array<"program" | "script"> = []
  if (!existsSync(record.program)) missing.push("program")
  if (!existsSync(record.script)) missing.push("script")
  return missing
}
