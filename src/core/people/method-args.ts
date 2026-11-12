import { invalid } from "../chats/args"

export function checkMethodArgs<Method extends string, Field extends string>(
  args: { method: Method } & Record<string, unknown>,
  methods: readonly Method[],
  always: readonly Field[],
  allowed: Record<Method, readonly Field[]>,
): void {
  const takes = [...always, ...allowed[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as Field)) {
      const takenBy = methods.filter((method) => allowed[method].includes(field as Field))
      const only =
        takenBy.length === 1
          ? ` Only method ${takenBy[0]} takes it.`
          : takenBy.length > 1
            ? ` Only methods ${takenBy.slice(0, -1).join(", ")} and ${takenBy.at(-1)} take it.`
            : ""
      invalid(`${field} is not an argument of method ${args.method}; it takes: ${takes.join(", ")}.${only}`)
    }
  }
}
