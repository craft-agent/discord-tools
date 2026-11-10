import { ToolError, type ToolContext, type ToolSettings, type Toolsets } from "../core"
import { PROJECT } from "../project"
import { PROJECT_PROFILE, type EntryProfile } from "./profile"
import { resolveDownloadDir, resolveDownloadMaxMb } from "./download-dir"
import { resolveSendDirs, resolveSendMaxMb } from "./send-dirs"
import { type SettingText, resolveStateDir } from "./state-dir"

/** Who asks the person before an administrative tool acts: the harness, or the tool through the client's form. */
export type ConfirmMode = "harness" | "elicitation"

/** Where state, received files, and sendable files live, and how large received or sent files may be, all resolved. */
export type StorageSettings = {
  state_dir: string
  download_dir: string
  download_max_mb: number
  send_dirs?: string[]
  send_max_mb: number
}

/** The settings needed to run tools: tool selection, read-only mode, and the resolved state, download and send settings. */
export type RunSettings = ToolSettings & StorageSettings

/** The parts of a call's context that the storage settings give. */
export type StorageContext = Pick<ToolContext, "stateDir" | "downloadDir" | "downloadMaxMb" | "sendDirs" | "sendMaxMb">

/** Hands the storage settings to a tool as the context fields they become. */
export function storageContext(settings: StorageSettings): StorageContext {
  return {
    stateDir: settings.state_dir,
    downloadDir: settings.download_dir,
    downloadMaxMb: settings.download_max_mb,
    ...(settings.send_dirs !== undefined && { sendDirs: settings.send_dirs }),
    sendMaxMb: settings.send_max_mb,
  }
}

export type EntrySettings = RunSettings & { confirm: ConfirmMode }

const CONFIRM_MODES: readonly ConfirmMode[] = ["harness", "elicitation"]
const DEFAULT_CONFIRM_MODE: ConfirmMode = "harness"
const ALL_TOOLSETS = "all"
const TRUE_VALUES: readonly string[] = ["1", "true"]
const FALSE_VALUES: readonly string[] = ["0", "false"]

type OptionName =
  | "toolsets"
  | "read_only"
  | "tools"
  | "exclude_tools"
  | "confirm"
  | "state_dir"
  | "download_dir"
  | "download_max_mb"
  | "send_dirs"
  | "send_max_mb"

/** A setting's command-line flag and the end of its environment variable, which follows the profile's prefix; a boolean flag takes no value. */
type Option = { flag: string; envSuffix: string; boolean?: true }

const OPTIONS: Record<OptionName, Option> = {
  toolsets: { flag: "--toolsets", envSuffix: "TOOLSETS" },
  read_only: { flag: "--read-only", envSuffix: "READ_ONLY", boolean: true },
  tools: { flag: "--tools", envSuffix: "TOOLS" },
  exclude_tools: { flag: "--exclude-tools", envSuffix: "EXCLUDE_TOOLS" },
  confirm: { flag: "--confirm", envSuffix: "CONFIRM" },
  state_dir: { flag: "--state-dir", envSuffix: "STATE_DIR" },
  download_dir: { flag: "--download-dir", envSuffix: "DOWNLOAD_DIR" },
  download_max_mb: { flag: "--download-max-mb", envSuffix: "DOWNLOAD_MAX_MB" },
  send_dirs: { flag: "--send-dirs", envSuffix: "SEND_DIRS" },
  send_max_mb: { flag: "--send-max-mb", envSuffix: "SEND_MAX_MB" },
}

function envName(name: OptionName, profile: EntryProfile): string {
  return `${profile.envPrefix}_${OPTIONS[name].envSuffix}`
}

/** The environment variables the settings are read from, in the order the settings are listed. */
export function settingVariables(profile: EntryProfile = PROJECT_PROFILE): string[] {
  return (Object.keys(OPTIONS) as OptionName[]).map((name) => envName(name, profile))
}

/** The environment variables a harness that forwards only named variables must pass the server: the settings' variables, then the package's `toolVariables`. */
export function forwardedVariables(
  profile: EntryProfile = PROJECT_PROFILE,
  toolVariables: readonly string[] = PROJECT.toolVariables,
): string[] {
  return [...settingVariables(profile), ...toolVariables]
}

function readFlags(argv: string[]): Partial<Record<OptionName, string>> {
  const byFlag = new Map(
    (Object.keys(OPTIONS) as OptionName[]).map((name) => [OPTIONS[name].flag, { name, ...OPTIONS[name] }]),
  )
  const given: Partial<Record<OptionName, string>> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.indexOf("=")
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const option = byFlag.get(flag)
    if (!arg.startsWith("--") || !option) throw new ToolError("invalid_argument", `Unknown option "${arg}".`)
    if (option.boolean) {
      if (equals !== -1) throw new ToolError("invalid_argument", `Option ${flag} takes no value.`)
      given[option.name] = "true"
      continue
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || (equals === -1 && value.startsWith("--"))) {
      throw new ToolError("invalid_argument", `Option ${flag} needs a value.`)
    }
    given[option.name] = value
  }
  return given
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

function checkToolsets(names: string[], source: string, toolsets: Toolsets): string[] | "all" | undefined {
  if (names.includes(ALL_TOOLSETS)) return ALL_TOOLSETS
  const unknown = names.find((name) => !toolsets.names.includes(name))
  if (unknown !== undefined) {
    const known =
      toolsets.names.length > 0
        ? `use one of ${toolsets.names.join(", ")} or "${ALL_TOOLSETS}"`
        : "no toolsets are defined"
    throw new ToolError("invalid_argument", `Unknown toolset "${unknown}" in ${source}; ${known}.`)
  }
  return names.length ? names : undefined
}

function parseBoolean(value: string, source: string): boolean {
  const text = value.trim().toLowerCase()
  if (TRUE_VALUES.includes(text)) return true
  if (FALSE_VALUES.includes(text)) return false
  throw new ToolError(
    "invalid_argument",
    `Unknown value "${value}" in ${source}; use one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}.`,
  )
}

function parseConfirm(value: string, source: string): ConfirmMode {
  const mode = CONFIRM_MODES.find((candidate) => candidate === value)
  if (!mode) {
    throw new ToolError(
      "invalid_argument",
      `Unknown confirm mode "${value}" in ${source}; use one of ${CONFIRM_MODES.join(", ")}.`,
    )
  }
  return mode
}

function envText(
  name: OptionName,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): SettingText | undefined {
  const variable = envName(name, profile)
  const text = env[variable]
  return text === undefined || text.trim() === "" ? undefined : { text, source: variable }
}

/**
 * Reads the settings every entry point takes from its command line and
 * environment (`<envPrefix>_<SETTING>` variables). A flag wins over its
 * environment variable; an empty list item is dropped. A mistake is
 * `invalid_argument` naming the culprit.
 */
export function parseSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): EntrySettings {
  const flags = readFlags(argv)
  const value = (name: OptionName): SettingText | undefined =>
    flags[name] !== undefined ? { text: flags[name], source: OPTIONS[name].flag } : envText(name, env, profile)

  const sendDirs = resolveSendDirs(value("send_dirs"), env)
  const settings: EntrySettings = {
    confirm: DEFAULT_CONFIRM_MODE,
    state_dir: resolveStateDir(value("state_dir"), env, profile),
    download_dir: resolveDownloadDir(value("download_dir"), env, profile),
    download_max_mb: resolveDownloadMaxMb(value("download_max_mb")),
    ...(sendDirs !== undefined && { send_dirs: sendDirs }),
    send_max_mb: resolveSendMaxMb(value("send_max_mb")),
  }
  const toolsets = value("toolsets")
  if (toolsets) settings.toolsets = checkToolsets(splitList(toolsets.text), toolsets.source, profile.toolsets)
  const readOnly = value("read_only")
  if (readOnly) settings.read_only = parseBoolean(readOnly.text, readOnly.source)
  const tools = value("tools")
  if (tools) settings.tools = splitList(tools.text)
  const excluded = value("exclude_tools")
  if (excluded) settings.exclude_tools = splitList(excluded.text)
  const confirm = value("confirm")
  if (confirm) settings.confirm = parseConfirm(confirm.text.trim(), confirm.source)
  return settings
}

/**
 * Reads the tool settings from a command line that has no `confirm` setting,
 * for entry points whose caller does the confirming: `--confirm` is
 * `invalid_argument`, and `<envPrefix>_CONFIRM` is ignored. Everything else
 * is read as `parseSettings` reads it.
 */
export function parseToolSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): RunSettings {
  const { flag } = OPTIONS.confirm
  if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
    throw new ToolError("invalid_argument", `Option ${flag} is not available here.`)
  }
  const { confirm: _confirm, ...settings } = parseSettings(
    argv,
    { ...env, [envName("confirm", profile)]: undefined },
    profile,
  )
  return settings
}

/**
 * Reads only the storage settings from a command line that takes no other
 * setting, for commands that select no tools: `--state-dir`, `--download-dir`
 * and `--send-dirs` are read, any other settings flag is `invalid_argument`,
 * and `download_max_mb` and `send_max_mb` come from their environment
 * variables. A flag wins over its environment variable.
 */
export function parseStorageSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): StorageSettings {
  const flags = readFlags(argv)
  const other = (Object.keys(flags) as OptionName[]).find(
    (name) => name !== "state_dir" && name !== "download_dir" && name !== "send_dirs",
  )
  if (other !== undefined)
    throw new ToolError("invalid_argument", `Option ${OPTIONS[other].flag} is not available here.`)
  const value = (name: "state_dir" | "download_dir" | "send_dirs"): SettingText | undefined =>
    flags[name] !== undefined ? { text: flags[name], source: OPTIONS[name].flag } : envText(name, env, profile)
  const sendDirs = resolveSendDirs(value("send_dirs"), env)
  return {
    state_dir: resolveStateDir(value("state_dir"), env, profile),
    download_dir: resolveDownloadDir(value("download_dir"), env, profile),
    download_max_mb: resolveDownloadMaxMb(envText("download_max_mb", env, profile)),
    ...(sendDirs !== undefined && { send_dirs: sendDirs }),
    send_max_mb: resolveSendMaxMb(envText("send_max_mb", env, profile)),
  }
}

const TOOL_OPTION_NAMES = [
  "toolsets",
  "read_only",
  "tools",
  "exclude_tools",
  "state_dir",
  "download_dir",
  "download_max_mb",
  "send_dirs",
  "send_max_mb",
] as const satisfies readonly OptionName[]
type ToolOptionName = (typeof TOOL_OPTION_NAMES)[number]

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined
}

function optionError(name: string, expected: string): ToolError {
  return new ToolError("invalid_argument", `Option "${name}" must be ${expected}.`)
}

function pathOption(name: "state_dir" | "download_dir", value: unknown): string {
  if (typeof value !== "string") throw optionError(name, "an absolute path")
  return value
}

function sendDirsOption(value: unknown): string[] {
  if (typeof value === "string") return [value]
  const list = stringList(value)
  if (list) return list
  throw optionError("send_dirs", "a path or a list of paths")
}

function maxMbOption(name: "download_max_mb" | "send_max_mb", value: unknown): string {
  if (typeof value === "number") return String(value)
  if (typeof value !== "string") throw optionError(name, "a whole number from 1 to 500")
  return value
}

function toolsetsOption(value: unknown, toolsets: Toolsets): string[] | "all" | undefined {
  if (value === ALL_TOOLSETS) return ALL_TOOLSETS
  const names = stringList(value)
  if (!names) throw optionError("toolsets", `a list of toolset names or "${ALL_TOOLSETS}"`)
  return checkToolsets(names, 'option "toolsets"', toolsets)
}

function booleanOption(value: unknown): boolean {
  if (typeof value !== "boolean") throw optionError("read_only", "true or false")
  return value
}

function listOption(name: "tools" | "exclude_tools"): (value: unknown) => string[] {
  return (value) => {
    const list = stringList(value)
    if (!list) throw optionError(name, "a list of tool ids")
    return list
  }
}

const LANGUAGE_OPTION = "language"
const PLUGIN_OPTION_NAMES: readonly string[] = [...TOOL_OPTION_NAMES, LANGUAGE_OPTION]

/** The environment variable of the `language` setting: `<envPrefix>_LANGUAGE`. */
export function languageVariable(profile: EntryProfile = PROJECT_PROFILE): string {
  return `${profile.envPrefix}_LANGUAGE`
}

/** The tool settings plus the language of a native plugin's approval prompt, as given (matched later against the package's translations). */
export type PluginSettings = RunSettings & { language?: string }

function nonBlank(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed === "" ? undefined : trimmed
}

/** The language of the prompt from a command line's `--language` value, else `<envPrefix>_LANGUAGE`, else the harness's own display language; blank values count as unset. */
export function promptLanguage(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  harness: string | undefined,
  profile: EntryProfile = PROJECT_PROFILE,
): string | undefined {
  return nonBlank(flag) ?? nonBlank(env[languageVariable(profile)]) ?? nonBlank(harness)
}

function languageOption(value: unknown): string | undefined {
  if (typeof value !== "string") throw optionError(LANGUAGE_OPTION, 'a language tag such as "ja"')
  return nonBlank(value)
}

/**
 * Reads the tool settings and the prompt language from the options a plugin
 * is configured with, for entry points that have no command line. An option
 * wins over its environment variable (`language` falls back to
 * `<envPrefix>_LANGUAGE`, blank meaning unset, and is not checked against any
 * list); an option of the wrong type, or one this function does not know, is
 * `invalid_argument` naming it. `confirm` is not an option here: the harness
 * asks.
 */
export function settingsFromOptions(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): PluginSettings {
  const given = options ?? {}
  const unknown = Object.keys(given).find((name) => !PLUGIN_OPTION_NAMES.includes(name))
  if (unknown !== undefined) {
    throw new ToolError(
      "invalid_argument",
      `Unknown option "${unknown}"; use one of ${PLUGIN_OPTION_NAMES.join(", ")}.`,
    )
  }

  const resolve = <T>(
    name: ToolOptionName,
    fromOption: (value: unknown) => T,
    fromText: (text: SettingText) => T,
  ): T | undefined => {
    if (given[name] !== undefined) return fromOption(given[name])
    const text = envText(name, env, profile)
    return text !== undefined ? fromText(text) : undefined
  }

  const text = (
    name: "state_dir" | "download_dir" | "download_max_mb" | "send_max_mb",
    fromOption: (value: unknown) => string,
  ): SettingText | undefined =>
    given[name] !== undefined
      ? { text: fromOption(given[name]), source: `Option "${name}"` }
      : envText(name, env, profile)
  const sendDirs =
    given.send_dirs !== undefined
      ? resolveSendDirs({ entries: sendDirsOption(given.send_dirs), source: 'Option "send_dirs"' }, env)
      : resolveSendDirs(envText("send_dirs", env, profile), env)
  const settings: PluginSettings = {
    state_dir: resolveStateDir(
      text("state_dir", (value) => pathOption("state_dir", value)),
      env,
      profile,
    ),
    download_dir: resolveDownloadDir(
      text("download_dir", (value) => pathOption("download_dir", value)),
      env,
      profile,
    ),
    download_max_mb: resolveDownloadMaxMb(text("download_max_mb", (value) => maxMbOption("download_max_mb", value))),
    ...(sendDirs !== undefined && { send_dirs: sendDirs }),
    send_max_mb: resolveSendMaxMb(text("send_max_mb", (value) => maxMbOption("send_max_mb", value))),
  }
  const toolsets = resolve(
    "toolsets",
    (value) => toolsetsOption(value, profile.toolsets),
    ({ text, source }) => checkToolsets(splitList(text), source, profile.toolsets),
  )
  if (toolsets !== undefined) settings.toolsets = toolsets
  const readOnly = resolve("read_only", booleanOption, ({ text, source }) => parseBoolean(text, source))
  if (readOnly !== undefined) settings.read_only = readOnly
  const tools = resolve("tools", listOption("tools"), ({ text }) => splitList(text))
  if (tools !== undefined) settings.tools = tools
  const excluded = resolve("exclude_tools", listOption("exclude_tools"), ({ text }) => splitList(text))
  if (excluded !== undefined) settings.exclude_tools = excluded
  const language =
    given[LANGUAGE_OPTION] !== undefined
      ? languageOption(given[LANGUAGE_OPTION])
      : promptLanguage(undefined, env, undefined, profile)
  if (language !== undefined) settings.language = language
  return settings
}
