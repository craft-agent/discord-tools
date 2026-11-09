import { z } from "zod"
import { isSnowflake } from "./snowflake"

/** An argument that must be a snowflake id, never a name; `what` names it in the refusal, as in "a channel id". */
export const snowflakeId = (what: string) =>
  z.string().refine(isSnowflake, `must be ${what}: a number of up to 20 digits, not a name`)
