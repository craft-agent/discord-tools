# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; a change
to a rule changes this file first, with its reason.

## Names

- **Tool IDs are `<prefix>_<domain>_<verb>`**: `<prefix>_note_read` and
  `<prefix>_note_create` for a `note` domain. The prefix is `toolPrefix` in
  `src/project.ts`; it keeps a name unambiguous where a harness lists every
  tool in one namespace. When the domain has a well-known command line,
  follow its word order, so a name maps to a command anyone can look up.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are plain**: `create`, `edit`, `delete`, `add`, `remove`, and these
  with a fixed meaning:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `resolve` | find which object a call means                               |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `<prefix>_<domain>_read` takes a `method` argument (`view`, `list`, …). A
  model picks tools worse as their number grows, and reads share one set of
  annotations, so folding them loses nothing. Writes stay apart because a
  merged write tool would carry its strictest class: creating something would
  ask like overwriting it.
- **Names stay within 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit. `defineTool` enforces
  the shape and the length; `src/tools.test.ts` enforces the prefix.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads.
- **Lists change through flat arguments**: `add_tags`, `remove_tags`. Shallow
  schemas are read reliably by every model the harnesses run. An argument that
  replaces a whole list, where one is needed, is named for the list (`tags`)
  and its description says it replaces.
- **Unknown arguments are refused.** Every entry point validates the
  arguments as strict, so a misspelt one fails as `invalid_argument` instead
  of being ignored.
- **The tools' own install directory is never the working tree.** A harness
  may start a tool inside the directory the package is installed in.
  `ToolContext.ownDir` names it; a tool that reads the working tree refuses
  to treat that directory as the caller's, saying so.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails does not throw.
  The result names what was created and lists the failed steps under
  `errors`, keyed by step (`StepErrors`).
- **Text a tool reads is returned as it is.** Content from files or services
  is data, never instructions; every read tool's description and the skills
  say so. Nothing is wrapped or rewritten.

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `not_found`        | the object does not exist, or the caller cannot see it                     |
| `forbidden`        | the caller lacks the permission the call needs                             |
| `invalid_argument` | the arguments cannot describe a valid call                                 |
| `stale`            | what the call relied on changed before it could finish                     |
| `unauthenticated`  | the service or program the tool calls is not logged in                     |
| `rate_limited`     | the service refused the call for its rate limit                            |
| `declined`         | the person declined a confirmation the tool asked for                      |
| `upstream_error`   | the service or program the tool calls failed; the message carries its text |
| `uncertain`        | a write may have reached Discord; check before trying it again             |
| `internal_error`   | a bug in a tool or an entry point, such as a result off its schema         |

A project adds a code to `src/core/errors.ts` and to this table together.

- **Structure the caller needs goes in `details`, not in the message.** When
  fixing the cause takes more than a sentence (the lint violations, the
  findings, the output of a hook), the error carries it as `details`: a JSON
  object with snake_case keys, like a result. A model then reads the fields
  instead of parsing them back out of prose; the message still says what to
  do next on its own.
- **`details` is fixed when the error is made.** `ToolError` keeps a frozen
  JSON copy, so every entry point renders the same value. The copy is what
  JSON makes of it (`undefined` is dropped, `NaN` becomes `null`), and a value
  JSON cannot write at all, such as a cycle or a `BigInt`, fails where it was
  thrown, as a bug, not where it is rendered.
- **Each entry point passes `details` on only when it is set**, so an error
  without it reads as it always did. The MCP server and the command line put
  it beside the code and the message, as `error.details`. The OpenCode and
  Hermes plugins, whose errors are text, append it to `<code>: <message>` as
  JSON on a line of its own.
- The `errors` of a partial result (`StepErrors`) stay `<code>: <message>`
  strings.

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool.

| Class             | Examples                              | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                   | `true`         | —                 | `true`           |
| add               | create, add                           | `false`        | `false`           | `false`          |
| idempotent change | ensure, adding a tag                  | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, removing one | `false`        | `true`            | `true`           |
| administrative    | delete, visibility, publishing        | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for everything the call writes to.** A write tool's `targets`
  resolver names what the call writes to, as the permission rules name it
  (a path, an account, a record). Anything it cannot tell, every tool
  without a resolver, and a target holding `*` or `?` (which a harness would
  store as a pattern) is `*`, and `*` is never stored. An "always" answer then
  covers only what it named, never a write somewhere else.
- **It shows what the call carries, where the tool can say.** Targets are
  ids, so they cannot tell one kind of target from another, and the person
  decides on the text, the file or the kind of target as much as on where it
  goes. A write tool's `describe` says it. An MCP client draws the call's
  arguments in its own prompt, so the MCP server adds nothing.
- **Every native plugin's prompt has one shape**, so a person reads every
  tool's prompt the same way:

  ```text
  About to create "todo.md"

  --- Details ---

  Target: /work/tree/notes/todo.md
  Size: 42 bytes

  --- Note text ---

  # Todo
  ```

  The headline says what the agent is about to do, as its next step; the
  Details name each target on a `Target` line, then the tool's facts; the
  last section is the text the call carries, under the tool's own label. A
  section with nothing to show is left out, so a tool without `describe`
  shows its intent and its targets, and one whose targets cannot be told
  shows its intent alone. The harness names the tool beside the prompt, so
  the prompt does not repeat its id.

- **A write tool states its intent.** Besides its title, which names the
  tool wherever tools are listed, a write tool gives an `intent`: a fixed
  phrase in the headline's tone that carries no value (`About to create a
note`). The prompt shows it wherever no headline can stand: a tool without
  `describe`, a headline that is dropped, and one that gives way to keep the
  targets within the budget. A tool without an intent shows its title there.

- **The tool's words are fixed; what the call carries is data.** A model
  chooses the arguments and nothing else, and a prompt is only as good as the
  person's trust in its lines. The headline is the tool's intent, or a
  template the tool picks (`About to create {file}`) whose values the entry
  point quotes, so where the tool's words end and the call's data begins is
  always visible. A value comes from what the tool resolved, never from a
  model's account of it (the record's real name, not the name the model
  gave). The text section holds what the call writes, as it is, never a
  summary of it; a summary the tool can compute is a fact (`Size`, `Lines`).
- **Facts are short and ordered by what they decide.** A label is a noun of
  one or two words, in English like the tool's title, and a value carries
  its unit (`42 bytes`). A value with a unit or other words of the tool's is
  a template the tool picks with the values it holds (`{bytes} bytes` with
  `bytes: 42`), so the unit is the tool's word and the number the call's
  data; the tool picks the English form for the count (`{bytes} byte` for
  one), and numbers are shown as written, without digit grouping. A plain
  string value has no words of the tool's. The fact that changes the person's answer comes
  first (the kind of target, whether it overwrites); amounts come last. A
  fact never repeats the headline or a target. `src/core/facts.ts` holds the
  facts every package can use (`sizeFact`); a package adds its own beside its
  tools in the same form and lists them in its section below.
- **The head of the prompt comes first and fits; the text comes last.** Some
  harnesses cut a prompt from its end at a few hundred characters, so the
  headline, the targets and the facts are kept within the budget of where the
  prompt is shown, and the text is what is cut. A headline that would push a
  target past the cut gives way to the intent, since the targets are what an
  "always" answer stores. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. A surface the plugin does not
  know gets the strictest budget and escaping, so a new one is safe before it
  is known.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. Right
  before the call runs, the entry point resolves both again, and a call
  whose hash differs, or whose description can no longer be told, fails with
  `stale` without running; the person is asked again on the next call. A
  call whose prompt showed no description pins nothing and runs as before,
  and so does every call of a tool without `describe`. A `describe` may also
  give `pins`, values the prompt does not show that the call must still find
  unchanged (a file's hash, beside a size that can stay the same); they go
  into the hash and nowhere else. A `describe` therefore gives the same
  answer for the same state: a value that changes on every call, such as the
  time, makes every call `stale`. The check narrows the gap between the
  answer and the run to the moment before `execute`; a tool that must close
  it entirely still checks inside `execute`. An MCP client draws the call's
  arguments, not a description, so the MCP server pins nothing.
- **The prompt speaks the language set for the harness.** A native plugin
  draws its prompt in the language of the `language` setting, else in the
  harness's own display language where it has one (Hermes's
  `display.language`), else in English. No harness tells a plugin who
  approves a call, so this is the language set where the plugin runs, not
  each person's. The server's locale (`LANG`) is never read: it is the
  machine's, and a person reading English on a machine set to another
  language would see the prompt change. A tag matches its own table, else
  the one of its first subtag (`ja-JP` and `ja_JP` are `ja`; `zh-Hant` can
  have its own), and a language the package has no words for falls back to
  English without a word. An MCP client draws its own prompt,
  so the MCP server takes no `language`.
- **Translations are tables keyed by the English words.** The plugin's own
  words (`Details`, `Target`, `(+N more)`) and a tool's (its title, its
  intent, its headline templates, its fact labels, its value templates and its text
  label) are written in
  English in the code. Per language, a package gives one table from those
  English words to their translation (`src/words.ts`), and the entry point
  looks each word up as it draws the prompt, so a tool's code does not change.
  A translated template must hold the same placeholders as the English one
  and keep within its limits, or the English one is used, so a translation
  cannot move the line between the tool's words and the call's data. Values
  are the call's data and are never translated: a value template is looked
  up and its values filled in after (`{bytes} バイト`), and a plain string
  value stays as the tool wrote it. A translation is marked like every other
  piece of the prompt.
- **`confirm: "elicitation"` adds the tool's own form** for administrative
  tools, where the client offers form-mode elicitation. It is for people who
  switch the client's approvals off: the tool states what will happen in plain
  words and stops on anything but an accept. Where the client does not offer
  elicitation the setting adds nothing, and the harness's approval is then the
  only confirmation.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain, listed in `src/project.ts` with the ones on by
  default. A small default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`language`** is the language of a native plugin's approval prompt (see
  "Write classes"); unset, the prompt follows the harness's display language
  or stays in English.
- **`state_dir`**: where every account's state lives (see "Accounts and state").

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree) and an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.

## Programs a tool runs

- **Every program a tool runs goes through one runner** built on `exec`, with
  an explicit environment: what the program needs to find itself and
  authenticate is passed through, and nothing else, so a stray variable
  cannot redirect a call. Prompts and colors are switched off, so nothing
  waits on a person and output parses the same everywhere.
- **Every variable the tools read besides the settings is named in
  `toolVariables` in `src/project.ts`**, whether a tool reads it itself or
  passes it through to a program. Codex gives a plugin's server only a few
  basic variables (`PATH`, `HOME` and the like) and those its manifest names,
  and `pnpm run manifests` writes that list from the settings and
  `toolVariables`: a variable left out is set everywhere but in Codex.
- **Every call has a time limit**, and a call that is stopped, by that limit
  or by cancellation, has its child process killed: `SIGTERM`, then `SIGKILL`
  after two seconds. A hung program neither holds a harness forever nor
  outlives its call.
- **The runner maps the program's failures to the error codes above.**

## Tests

- Tests sit beside the code they test (`*.test.ts`) and run on `bun test`;
  CI also starts the built MCP server, plugin and command line under Node and
  lists their tools, so a runtime-only API cannot slip in unnoticed.
- No test reaches a real service. A tool that runs a program is tested
  against a fake of that program on `PATH`.
- A test file stays within about 300 lines, split by topic
  (`<name>.<topic>.test.ts`), so one commit can carry a change and its test.
- **No test reaches Discord.** The HTTP client is tested against a fake
  Discord, and tests use made-up tokens and ids only.

## Accounts and state

- **One label is one Discord account**, signed in with its token. The tools
  act from the user's own account through the web client's API, so whatever
  they do, Discord sees the user doing.
- **A label is 1 to 24 lowercase letters, digits and `_`**, starting and
  ending with a letter or a digit; `login` names it `default` when no label is
  given. A label is also a directory name and part of a variable's name, so
  the set is kept to what both take as it is.
- **Each label keeps all of its state in one directory**,
  `<state root>/<label>/`, created with mode 700: the mirror, the sync list,
  the token file when there is one, the sync service's lock and progress, and
  the short-lived copies of files being sent or received. The state root is
  the `state_dir` setting, by default `$XDG_STATE_HOME/discord-tools`, or
  `~/.local/state/discord-tools` without it. One directory per label means a
  label is moved, backed up or removed as a whole.
- **`account` picks the label.** Left out, it picks the only label; with
  several, the call fails as `invalid_argument` and lists them. One account is
  the common case and needs no argument, while several never depend on which
  one a tool guesses.
- **A label reaches only its own account.** An id is looked up only in that
  label's mirror, and a request carries only that label's token, so no
  argument can carry a call to an account the label does not name.

### Account health

- **The account read lists every label when `account` is absent**, unlike
  tools that operate on one account. An explicit label inspects only that
  label. It reads local state and scheduler status, never contacts Discord,
  migrates a mirror or changes a service.
- **Token availability is not live authentication.** The HTTP client boundary
  inspects the current credential and returns only its source and safe status.
  A replacement token does not inherit the old token's rejection.
- **A scheduled, idle job is normal.** Health needs a complete sync within
  15 minutes as well as usable credentials, a verified identity and a scheduled
  service. This account-level threshold makes missed runs visible; it does not
  replace each channel's freshness check. A partial run needs continuation.
  Recorded sync status is history, not proof that a process is running.
- **Unknown state stays unknown.** A failed scheduler inspection or damaged
  state produces a diagnostic for that label, not a fabricated healthy result
  or a failure that hides every other label. Recovery gives a person one next
  command, including the label and state directory; a read never runs it.

## The token

- **The token comes from the environment first.** `<envPrefix>_TOKEN_<LABEL>`
  (`DISCORD_TOOLS_TOKEN_DEFAULT` for `default`) is used when it is set, and the
  package then stores nothing; otherwise the label's token file
  (`<state root>/<label>/token`, mode 600) is used, which `login` writes from
  standard input. The MCP server each harness starts needs the token as much
  as the sync service does, and how it reaches both (a keychain, a password
  manager, a service manager's credentials) is the user's choice; the file
  works where nothing injects it.
- **A token is never an argument, a setting or a tool's input.** A harness
  shows and logs a call's arguments, and settings land in configuration files.
- **Only the HTTP client reads the token, and nothing from it reaches a
  result, an error or a log**; anything token-shaped in an error is masked. A
  user token stands for the account itself: whoever holds it reads and writes
  as the user, past the password and the second factor, until Discord
  invalidates it.
- **The account tool says which source a label uses**, the variable or the
  file, never the token.

## The HTTP client

- **Every request to Discord goes through one client**, as every program goes
  through one runner: it presents Chrome's TLS and HTTP/2 fingerprint and the
  web client's headers, speaks `/api/v9`, has a time limit with cancellation,
  and maps Discord's answers to the error codes above. A tool never makes a
  request itself. A request whose fingerprint does not match the browser its
  headers claim is the easiest pattern to flag.
- **No recent build number, no request.** `X-Super-Properties` carries the
  web client's `client_build_number`, read from its pages every 12 hours and
  cached; a cached one serves for 7 days when the refresh fails, and past that
  the client refuses to send rather than claim a build that no longer exists.
- **Requests are paced**, 0.6 to 1.6 seconds apart within a process, so the
  account moves at a person's pace. A read waits out one rate limit of up to
  30 seconds and then throws `rate_limited`. A write is never retried: a
  retried write can act twice.
- **A rejected token is recorded.** A 401 throws `unauthenticated`, marks the
  label's token rejected and stops its sync service until a new token is
  given. A two-factor challenge throws `forbidden` and leaves the token alone:
  the token is good, and the action needs the person.
- **The token goes only to Discord's API.** Uploads go to the signed storage
  URL Discord returns and downloads come from Discord's CDN and media proxy,
  both without the token and on those hosts only.

## The sync service

- **The sync service polls in bounded runs**: one run every 5 minutes, at
  most 60 requests a run, one run per label at a time, each page committed
  with its progress before the next request. A run that stops halfway loses
  nothing, and the cap keeps the account's traffic near what a person makes.
- **It follows DMs and group DMs always, and servers only as the sync list
  names them**: at most 10 servers and 30 channels, a whole server counting as
  its 10 most active text channels. Only channels whose last message moved are
  fetched. The limits are code, not judgement, and a run's 60 requests go
  round them.
- **The sync list changes through write tools the harness asks about.** A
  change is local, but every channel it follows adds requests to each later
  run, so the person sees it. A change is checked against the mirror and the
  limits, written whole and atomically under a lock of its own, and never
  waits for a sync run; a run reads the list once, at its start. Switching a
  server between whole and named channels takes a removal first, so coverage
  never shrinks silently.
- **It sends nothing of its own**: no presence, no typing, no read marks, no
  messages. Nobody learns from the account that a tool is reading, and the
  user's phone keeps its notifications.
- **The gateway is opened at most once a run**, to read `READY`: Identify with
  no presence (`status: "unknown"`, no activities), read what is needed,
  close with 1000 at once. It sends no presence update, subscribes to nothing
  and is never held open. Unread and mention counts exist nowhere else, while
  a session held open, or marked present, can hold back the phone's push
  notifications. Whether a run opens it is settled with the inbox tools,
  after a check on a real phone.
- **A rejected token stops the service** for its label until a new token is
  given, rather than polling an account it can no longer reach. The run
  disables future starts and keeps the service definition; it reports the
  rejection before a scheduler operation can terminate the run itself.
  After a new token is verified, `service install` re-enables the schedule.
- **Signing in, running and installing the service, and removing a label are
  a person's commands, never tools**: signing in hands the account over, and
  installing a service changes the machine.
- **The scheduler starts one run, not a resident loop.** On macOS a user
  launchd agent uses `StartInterval` 300; on Linux a user systemd timer starts
  a oneshot service every 300 seconds. Installing a job requires an executable
  sync command; an unfinished command must never be registered as a service.
- **The label's `sync.lock` is a private SQLite lock file**, separate from the
  mirror. A run holds a write transaction until it ends; closing the connection
  or losing the process releases it. The file stays in place so contenders
  always lock the same file, without guessing whether a stored pid is stale.
- **Removal stops the scheduled service and takes the same lock.** A busy
  label's local state is left intact, with its schedule stopped. Under the
  lock its directory is renamed out of the label namespace before deletion,
  so a waiting run cannot write into state
  being removed. This deletes local state only, not remote account data.

## The mirror

- **One SQLite file per label, on `node:sqlite`.** Its schema version is
  SQLite's `user_version`; the sync service migrates an older mirror forward,
  and a read of a newer one fails, saying to update the package.
- **Every write to the mirror goes through one ingest**: the sync run, a live
  read storing what it fetched, a write recording what it did. Only a sync run
  marks a channel current, so a stray live read never makes a lagging channel
  look complete.
- **A read serves a channel from the mirror only while it was marked current
  under 15 minutes ago**, and reads it live otherwise, so a channel that lags,
  left the sync list, or whose service stopped never reads as complete.
  **A search of the mirror is the exception**: it looks through everything
  the mirror holds, current or not, and lists each chat it found something in
  with when a sync run last marked it current, so a result never stands for
  what Discord holds.
- **A whole list vouches for itself.** The server list and the DM list are
  stored with the time they were read in full, and a read lists only what the
  latest full list held: from the mirror while it is under 15 minutes old for
  DMs and 6 hours for servers, live otherwise. A server left or a DM closed
  drops out without anything being deleted, and servers, which change rarely
  and are refreshed by a sync run only when the sync list names one, are not
  fetched on every read.
- **A tool stores what it read on a connection that never creates or migrates
  the mirror.** A missing mirror, or one of another version, is refused as it
  is for any read: only the sync service shapes the file.
- **A contiguous page vouches for its range.** Discord has no feed of edits
  and deletions a user account can poll, so every page of a channel's history
  overwrites what it returns and drops mirrored messages inside its range that
  it did not return: those were deleted. Search, pin and mention results are
  not contiguous and drop nothing. **An empty page vouches for nothing**:
  Discord answers an account that cannot read a channel's history with an
  empty list, so it deletes nothing and never marks a history complete; only a
  short page with messages reaches a history's start.
- **Things are ids.** Channels, messages, servers, users and roles are
  Discord's snowflake ids, and names are never accepted as a target: anyone
  can choose any name.
- **Other people's words are data.** Message text, names, embeds and file
  names are written by other people; every read tool's description and the
  skills say so, and nothing a message says is followed as an instruction.

## Files

- **Files go in and out only through the directories a setting names**,
  judged by real path, so a link that leads elsewhere counts as elsewhere.
  The state directory and the tools' own install directory are never among
  them. Which settings, and their defaults, are settled with the tools that
  save and send files.

## Writes

- **A write's arguments are the whole change**: the channel and the message
  by id, and only ones the label's mirror knows; the text as it should arrive.
  Nothing is chosen at run time from the current state. The harness shows the
  arguments when it asks, so what it shows is what goes out.
- **A send never opens a new DM, and a reply does not ping its author.**
  Discord flags accounts that open new DMs quickly (about 10 in 10 minutes),
  and a ping reaches a person's phone.
- **A write's outcome is never guessed.** A result says what Discord
  returned. A failure known to happen before anything changed (Discord
  refusing the request, a connection never made) throws its code. Every other
  failure (a server error, a time-out after the request left, an answer
  without the message) throws `uncertain`, never retried, with what a
  read-back saw as a hint. A resend that guessed wrong posts twice.
- **A send carries a fresh nonce with `enforce_nonce`**, recorded before it
  leaves, so a request that reaches Discord twice posts once. The record is a
  row of the mirror's send ledger, written through the ingest and settled with
  the outcome; it holds a hash of the text, never the text, and is pruned
  after 30 days.
- **A send notifies only whom a person's would.** The text arrives as
  written, but `@everyone`, `@here` and role mentions notify only when an
  argument asks for it, and a silent send is one argument away: a mass ping
  reaches many phones and cannot be taken back.
- **An action on a message sets a state, checked before it leaves.** An
  edit or a delete reaches only the user's own messages, a custom emoji only
  one already on the message, a pin only a plain message or a reply, and
  taking back a reaction only one the mirror shows the user made; a request
  that fails a check is refused without being sent. Discord decides the rest
  (the right to pin, the caps on reactions and pins). Deleting a message
  Discord no longer has is done, marked `already`, since the state asked for
  holds. A done action is followed in the mirror through the ingest, without
  another request.
- **Nothing marks a chat read but the tool for it.** A read mark clears the
  unread state on every device the user has, so it is a call the harness asks
  about, never a side effect of looking.

## Approval prompts

- **Every write tool states its intent and describes its call** (see Write
  classes above), so a person answers on the chat's name and the text rather
  than on ids.
- **A description is read from the mirror alone**, on a connection that
  writes nothing, and never from Discord: drawing a prompt sends no request
  and leaves no trace, and gives the same answer for the same mirror. A chat
  or a message the mirror does not know gives no description, and the call
  is then refused when it runs.
- **A chat is named as people see it.** A server channel is `#name`, a
  thread its name, a DM the other person's display name, a group DM its name
  or else its members' display names; one without a name is its id. The name
  is the mirror's, never one a model gave, and a rename before the call runs
  makes it `stale`.
- **A message is quoted short.** Where a fact quotes a message, it is the
  first 80 characters, with each run of whitespace as one space, so the
  facts stay within the head of the prompt. A delete is the exception: the
  text it removes is shown whole, as the prompt's text, since it cannot be
  read again once the call runs.
- **An edit pins the text it replaces.** The quote of the current text can
  stay the same while the text past it changes, so an edit pins a hash of
  the whole current text, and a message edited after the prompt makes the
  call `stale`.
- **A change to the sync list names the server and its channels.** The
  server is its name in the mirror, else its id, since a server the account
  has left can still be removed; a channel is `#name`, else its id. The
  list itself is local, so its prompt has no text.
- **The facts the tools add**, in the order they are shown:

  | Label           | Value                                                             | Shown                                |
  | --------------- | ----------------------------------------------------------------- | ------------------------------------ |
  | `Chat`          | the kind of chat: `Direct message`, `Group DM`, `Text channel`, … | always                               |
  | `Server`        | the server's name                                                 | a chat in a server                   |
  | `Channel`       | the channel a thread belongs to, as `#name`                       | a thread                             |
  | `Author`        | who wrote the message, `You` for the user's own                   | a reaction, a pin                    |
  | `Message`       | the message, quoted short                                         | a reaction, a pin                    |
  | `Current text`  | the text an edit replaces, quoted short                           | an edit                              |
  | `Reply to`      | the message replied to, quoted short                              | a reply                              |
  | `Mass mentions` | `Notify`                                                          | `mass_mentions` of a send or an edit |
  | `Notifications` | `Silent`                                                          | `silent`                             |
  | `Follows`       | `Whole server` or `Named channels`                                | an addition to the sync list         |
  | `Channels`      | the channels named, as `#name`, joined with `, `                  | a sync list change with `channels`   |
  | `Excluded`      | the channels excluded, as `#name`, joined with `, `               | an addition with `exclude`           |
  | `Length`        | `{count} characters`, in code points                              | a send, an edit's new text           |

## Toolsets

- **One per domain**: `account`, `sync` (the sync list), `chats`, `search`,
  `inbox`, `people` (people and server info), `sends`, `history` (counts and
  the export), `files` (saving received files), `actions` (the user's own
  messages, reactions and pins), `threads` (creating threads and forum posts)
  and `roles`.
- **`account`, `sync`, `chats`, `search`, `inbox`, `people` and `sends` are on
  by default.** They cover reading a chat and answering it. `history` and
  `files` write files to disk; `actions` changes messages other people have
  already read and `threads` creates lasting posts; `roles` changes what
  others may do in a server. Each is one setting away.
- **Text and file sends are tools of their own** in `sends`, so a permission
  rule can let texts through while files are asked for every time.
