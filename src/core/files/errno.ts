/** The code of a file system error (`ENOENT`, ...), or "an error" when it has none, for a message. */
export const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "an error"
