import { GRANTS_TOOLSET, type OptionSpec, type Toolsets } from "../core"
import { PROJECT } from "../project"

/** The package identity, command, service, toolsets and the types of its tool options, with their bounds, an entry point supplies. */
export type EntryProfile = {
  name: string
  cli: string
  serviceId: string
  envPrefix: string
  toolsets: Toolsets
  options?: Readonly<Record<string, OptionSpec>>
}

/** The profile of this package, which every entry point uses unless a test supplies its own. */
export const PROJECT_PROFILE: EntryProfile = {
  name: PROJECT.name,
  cli: PROJECT.cli,
  serviceId: PROJECT.serviceId,
  envPrefix: PROJECT.envPrefix,
  toolsets: { names: [...PROJECT.toolsets, GRANTS_TOOLSET], defaults: PROJECT.defaultToolsets },
  options: PROJECT.options,
}
