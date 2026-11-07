import { z } from "zod"
import type { ClientTokenStatus } from "../discord/client-token-status"
import type { SyncStatus } from "../discord/sync-status"

export const accountReadInput = z.object({ account: z.string().optional() })

export const syncStatusSchema = z.enum([
  "running",
  "complete",
  "partial",
  "rejected",
  "failed",
  "cancelled",
] satisfies SyncStatus[])

export const accountSchema = z.object({
  label: z.string(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  token_source: z.enum(["variable", "file"] satisfies NonNullable<ClientTokenStatus["source"]>[]).nullable(),
  token_status: z.enum([
    "available",
    "missing",
    "invalid",
    "unreadable",
    "rejected",
  ] satisfies ClientTokenStatus["status"][]),
  token_rejected_at: z.iso.datetime().nullable(),
  installed: z.boolean().nullable(),
  scheduled: z.boolean().nullable(),
  running: z.boolean().nullable(),
  last_sync_at: z.iso.datetime().nullable(),
  sync_status: syncStatusSchema.nullable(),
  health: z.enum(["healthy", "attention", "unknown"]),
  reasons: z.array(z.string()),
  action: z.enum(["login", "sync", "install_service", "check_service"]).nullable(),
  hint: z.string().nullable(),
  recovery_command: z.string().nullable(),
})

export const accountReadOutput = z.object({ accounts: z.array(accountSchema) })
export type AccountRow = z.infer<typeof accountSchema>
export type AccountReadResult = z.infer<typeof accountReadOutput>
