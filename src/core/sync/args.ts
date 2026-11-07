import { ToolError } from "../errors"
import type { SyncMethod, SyncReadInput } from "./schemas"

/** The arguments every method takes. */
const ALWAYS: readonly (keyof SyncReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `SYNC_METHODS`. */
const ALLOWED: Record<SyncMethod, readonly (keyof SyncReadInput)[]> = {
  list: [],
  suggest: ["after", "limit"],
}

/** Refuses an argument the method does not take, before anything is opened. */
export function checkArgs(args: SyncReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof SyncReadInput)) {
      throw new ToolError(
        "invalid_argument",
        `${field} is not an argument of method ${args.method}; it takes: ${takes.join(", ")}.`,
      )
    }
  }
}
