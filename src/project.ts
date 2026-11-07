/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "discord-tools",
  /** The command line the Hermes plugin calls. */
  cli: "discord-tools-cli",
  /** The identity under which each account's scheduled sync is registered. */
  serviceId: "io.github.craft-agent.discord-tools",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "discord",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "DISCORD_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["account", "chats"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["account", "chats"] as readonly string[],
} as const
