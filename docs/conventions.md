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
- **The MCP server takes the call's directory from the client.** It uses a
  directory sent with the call (Codex), else the client's first usable root,
  else the process's working directory; never inside the install directory.
  This keeps a server started in its install directory out of the working tree.

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
  "always" answer stores. Facts that do not fit are counted on a notice
  line, which stays even when the head alone fills the budget: a person
  must know that something was left out. The facts a description drops past
  its eighth are counted on the same line, `(+N more)` after the facts, in
  every prompt, budget or none. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **A cut text says how much it leaves out.** A `…` also ends many ordinary
  messages, so it alone cannot tell a person that the text goes on, or how
  far. A text cut at its 2000 characters is followed by a notice line,
  `(+N more characters)`, and a fact's value cut at its 200 by the same
  notice after it on its line, where the line still fits the budget; a value
  the budget cuts further ends in `…` alone, since what it drops is no longer
  counted in the tool's characters. N counts the code points left out of what
  the tool gave, the unit the cut counts (`(+1 more character)` for one), and
  the notice is the plugin's own words, translated like the facts' notice.
  Only the head counts towards the budget, so the text's notice is lost
  wherever the harness cuts the text, which then shows its own end mark.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names. A surface the harness shows as
  written, such as its own clients, gets neither. A surface it names that the
  plugin does not know is one the harness does not cut, so it gets no budget,
  but it may render markup the plugin cannot tell, so it gets the strictest
  escaping of all: an escape shown as written reads as a stray backslash,
  while a name left unescaped can draw a link or a mention. A prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call no answer may let run is refused before anyone is asked.** Some
  calls are out of reach whatever the person would say, such as one naming
  an object the settings keep away from the agent; a prompt for it would
  show what it names and invite an "allow" that cannot be honored. A tool
  that can tell such a call from its arguments and settings gives a `gate`
  (see "The core contract"). Every entry point runs it before the approval
  and again before `execute`, so a refusal is the call's result, as an
  error, and no prompt is drawn: a native plugin asks nothing, and the
  Hermes plugin blocks the call. Unlike `targets` and `describe`, a gate
  fails closed: one that cannot tell fails the call with `internal_error`.
  Where the question itself cannot be resolved (the Hermes plugin's `target`
  fails or times out), the person is asked as before, and the run refuses
  the call after the answer. An MCP client draws its own prompt before the server sees the call, so
  there the refusal comes after the client's question, never after the run.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. The hash
  takes the description whole, before the budgets above cut it: a text past
  its 2000 characters, a value past its cut and the facts past the eighth
  are what the call carries too, so a change there is a change of the call
  even where the prompt could not show it. Right
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
- **`emoji`** maps a toolset name to the emoji the Hermes plugin shows beside
  it, merged over the package's `TOOLSET_EMOJI`; `""` shows no emoji for that
  toolset, and no other entry point shows an emoji. A value that is not a
  mapping, an entry whose value is not a string, and a name that is no toolset
  are ignored rather than refused: the setting only changes what is shown, so a
  typo must not take every tool away.
- **`require_plugins`** names the Hermes plugins the Hermes plugin's writes
  depend on, such as a guard whose `pre_tool_call` block keeps writes from
  running unattended. Hermes drops a plugin that fails to import or register
  and loads the rest, and treats a manifest's `requires_plugins` as advisory,
  so a guard can vanish with nothing to say so. While any named plugin is not
  loaded (`ctx.has_plugin` says no, or cannot be asked), every call of a tool
  that is not a read is refused before its approval is asked, so neither YOLO,
  an approvals mode of `off` nor a remembered answer lets it run, and again
  before it runs. The refusal is `forbidden` with `details.reason`
  `missing_plugin` and `details.plugins` the names missing. Reads run as
  before. The check runs on every call, not at registration, since the order
  in which Hermes loads two plugins is not the plugins' to fix. Unset or
  empty, nothing is checked. A value that is not a list of names is refused,
  like a wrong `read_only`, and the plugin then registers nothing: ignoring it
  would loosen what the person asked for. No other entry point has it.
- **`state_dir`**: this package's `path` option for every account's state
  (see "Accounts and state"), read as "Options" below describes.
- **`download_dir`** and **`download_max_mb`**: this package's `path` and
  whole `number` (1 to 500) options for received files and their size
  (see "Files"), read as "Options" below describes.
- **`send_dirs`** and **`send_max_mb`**: this package's `paths` (at most 20
  directories) and whole `number` (1 to 500) options for sent files and their
  size (see "Files"), read as "Options" below describes.
- **Options** are the package's own settings, the ones the tools themselves
  read, listed in `options` in `src/project.ts` (and `OPTIONS` in the Hermes
  plugin's `project.py`), each mapping a snake_case name to its type (`text`,
  `boolean`, `number`, `list`, `path` or `paths`) or a declaration with
  `{ type, integer, min, max }`. `integer: true` requires a whole `number`;
  `min` and `max` bound a `number` or count the items of a `list` or `paths`.
  Only `type` is required. Its flag is the name with `_` as `-` (a
  `boolean` flag takes no value), its variable is `<envPrefix>_<NAME>`
  uppercased, and its plugin option or setting is the name itself. A flag wins
  over its variable, an option over its variable, and a blank text or path or
  empty list counts as unset. A `path` is trimmed; `~` alone or followed by
  `/` (or the platform separator) stands for the home directory: `HOME` when
  it is absolute, else the account's.
  The expanded path must be absolute and reaches the tool normalized, without
  a filesystem check. A `paths` value is a list of such paths, comma-separated
  in a flag or variable and an array of strings in a plugin option; items are
  trimmed and blank items dropped, and none left counts as unset. Bounds
  check only a value that is given, after blanks are dropped; unset stays
  unset. Refused values are `invalid_argument`, naming the flag, variable or
  option and what it must be. A package should not have to check a directory
  or a limit again inside its tool. They reach a tool as `context.options`,
  keyed by name, and one that is not given is absent: a neutral default means
  unset, and the tool then does nothing extra. A tool reads an option when it
  runs, so a change applies on the next call.
- **`unattended`** says that no person can answer a question, as in a
  scheduled job, CI or a headless run; **`grants_dir`** is the `path` where
  grants and their use are kept. See "Writes no one is there to approve".

## Writes no one is there to approve

When no person can answer, a harness either refuses a write or, with its
approvals skipped, runs it with no limit at all; a host's allow rule names a
tool and at most its targets, with no expiry, no count and nothing about what
the call carries. So a person delegates, in advance, a bounded set of writes,
and every entry point checks them the same way.

- **The person decides what to delegate; the package keeps only its
  guarantees.** A person who cannot delegate a write still runs it
  unattended through the host, with no bound and no record, so a rule that
  narrows what can be delegated protects nothing and only pushes the person
  there. The package limits a grant only where the mechanism needs it: the
  expiry ceiling, that only a person's answer creates a grant, and the
  signatures, the log and the lock. Everything else (which tool, which
  targets, which bounds, how many calls) is the person's choice, shown whole
  on the consent screen.

- **A setting says that no one can be asked.** No harness tells a plugin or
  an MCP server that its questions will go unanswered, and the modes that
  skip approvals are the ones with no person in the loop, so nothing is
  inferred from them. `unattended` says it. Off, the default, nothing changes
  and grants are not read. On, a read runs as before and a write runs only
  under a live grant that covers it.
- **Every write tool can be granted; a tool may add what a grant can
  bound.** A grant over any write tool limits its targets, its rate and its
  expiry. `bounds` adds more, naming each bound with its kind: `max` (a whole
  number the call must stay at or under, such as a text's length in
  characters), `allow` (whether the call may do one thing, such as attach a
  file) or `oneOf` (the values the call may use, such as DNS record types).
  `measure(args, context)` gives the call's value for each: a number, a
  boolean, or one or more of the declared values. A tool declares at most six
  bounds and a grant's values must fit a fact (200 characters), so the consent
  screen shows every one. A bound is a fact about the call, computed the same
  way every time, never the model's account of it, and it is checked whole,
  never cut to a budget as a prompt's facts are.
- **A grant** names one tool, its targets, a value for the bounds the person
  limits, a rate in calls per hour or none, and an expiry of at most 90 days.
  Its targets are names, or `*` alone for any target, the call's included when
  it cannot be told; a pattern beside or inside a name is refused. A call is
  covered when its tool matches, every target it resolves is among the
  grant's (or the grant's is `*`), every bound the grant sets is met by the
  measured value (at or under a `max`, `false` or allowed for an `allow`,
  every value among a `oneOf`'s), the grant has not expired, and, when it sets
  a rate, fewer calls than the rate ran under it in the last 60 minutes. A
  bound the grant leaves out is no limit, and the consent screen says so; a
  measure that fails or returns another shape covers nothing under a grant
  that sets a bound. Where several grants cover a call, one that names its
  targets is used before a `*` one, then the one with the fewest targets,
  then the one that sets the most bounds, then the one that expires first.
  A call counts against its grant's rate whether it succeeds or fails, and
  every call is logged whether the grant sets a rate or not.
- **Grants restrict; the host still allows.** `invoke` checks the grant
  after the gate and before `execute`, so the MCP server and the command
  line's `run` enforce it too, and the native plugins and the Hermes
  plugin's `target` check it before they ask, refusing without a question.
  The harness's own permission still decides whether the call reaches the
  package at all (an allow rule, an allowed-tools list, an approve mode), so
  a grant means the same in every harness and never lets a call through
  that the host would stop.
- **A refusal says why.** It is `forbidden`, with `details.reason`.
  `person_only` (a tool only a person's own answer may run), `no_key` and
  `tampered` (a grant or the log fails its MAC) refuse every call. Otherwise
  each grant that names the tool is checked in order, `expired`, `target` (a
  target outside the grant, or one that cannot be told, under a grant that
  names its targets), `bound` (named in
  `details.bound`) and `rate`, and the reason is the one of the grant that
  passed the most checks; `no_grant` when none names the tool. The message
  says what a person would change: a new grant, or waiting for the rate.
- **A person delegates; the agent only asks.** `<prefix>_grant_create`
  takes the tool, the targets, the bounds, the rate, the days it lasts and a
  reason. It is administrative, and its prompt is the consent screen: the
  headline names the tool (and says it may write anywhere under `*`), the
  facts the rate (or no limit), the expiry and every bound the tool declares
  (`no limit` for one left out), named targets stand as targets (a prompt
  shows no target line for `*`, so the headline carries it) and the reason
  as text, and the pin makes the
  grant exactly what the prompt showed. Widening or extending one is a new
  grant. `<prefix>_grant_read` lists the grants and their use, and
  `<prefix>_grant_revoke` removes one. They form the `grants` toolset, off by
  default.
- **Only a person's answer creates a grant.** A grant that the agent could
  give itself would bound nothing. `grant_create` is marked person-only: it is
  refused while `unattended` is on, no grant ever covers a person-only tool
  nor can one be created for it, and every
  entry point keeps a standing answer from covering it: the OpenCode plugin
  makes its permission `ask` with nothing to save, the MCP server marks it
  `requiresUserInteraction` and asks through form elicitation where the
  client offers it, whatever `confirm` says, and the Hermes plugin gives each
  call a rule key of its own. A harness run with every approval skipped asks
  about nothing, and no package can tell; the README says so for each
  harness. Revoking only narrows, so `grant_revoke` runs while `unattended`
  is on without a grant.
- **Grants and their use are signed with a key the host supplies.** The
  variable `<envPrefix>_GRANT_KEY` (at least 32 characters; a variable only,
  never a flag or a plugin option, so it stays out of configuration files)
  keys an HMAC-SHA256 over each grant and over a chained log of every call
  made under one: the grant, the tool, the targets, the measured values, a
  digest of the arguments, when it started and how it ended. A grant or a
  log edited outside the package fails its MAC, and nothing runs under any
  grant until a person revokes the grant that fails (`grant_read` marks it)
  or, for the log, clears the directory. Without the
  key, while `unattended` is on, no write runs and no grant can be created.
  The files are written under a lock and replaced whole, since several
  processes may run calls at once. An earlier copy put back whole, MACs
  included, is not detected; the expiry bounds what it can bring back.

## Skills

- **A skill names the toolset it documents**, under `metadata` in its
  frontmatter:

  ```yaml
  metadata:
    toolset: sends
  ```

  The Agent Skills format allows no other top-level key, and its validators
  refuse one. The value is a plain or quoted one-line scalar; any other form
  reads as no link. A folder's name never links a skill, so every entry point
  reads the link the same way without knowing the package's toolsets.

- **A native plugin registers a linked skill only when its toolset is on**:
  when the settings register at least one tool of that toolset, from the same
  selection the tools come from. A skill that describes tools the model does
  not have invites calls that fail. So `read_only`, `tools` and
  `exclude_tools` count too: a toolset whose every tool is left out takes its
  skill with it. A skill with no link is always registered.
- **Plugins that install the skill folder whole cannot follow the settings**:
  Claude Code, Codex, Grok Build and Antigravity load every skill, since the
  settings reach only the MCP server.
- **Every linked skill names one of the package's toolsets**; a test checks
  it, since a misspelt link would hide the skill wherever it is filtered.
- **A skill that works across toolsets names the one it cannot work without.**
  The link holds one toolset, and a skill linked to none would be registered
  with every tool it describes turned off. Its body says which steps to skip
  when another toolset's tools are missing, and it leans only on toolsets that
  are on by default, since the plugins that install the skill folder whole
  list it whatever the settings select.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- Any tool, read or write, may declare `gate(args, context)`, which throws a
  `ToolError` (usually `not_found`, worded as for an object that does not
  exist) for a call no approval may let run, and returns otherwise. `invoke`
  runs it after the arguments are checked and before `execute`; the entry
  points also run it before they ask (see "Write classes"). It is cheap, it
  reads only what it needs to decide, and its message says no more about
  the target than the arguments already do.
- A write tool may declare `bounds` and `measure(args, context)`, which say
  what a grant over it can limit beyond its targets, rate and expiry, and
  what this call's values are (see "Writes
  no one is there to approve"). `defineTool` refuses a `measure` without
  `bounds`, a bound of an unknown kind, a `oneOf` with no values and more than
  six bounds.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree), the values of the package's own settings as `options` (see
  "Toolsets and settings"; `gate`, `describe` and `targets` get them too) and
  an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.
- **The one vendor name in `src/core/` is a protocol key.** The
  administrative class publishes `_meta["anthropic/requiresUserInteraction"]`
  (see "Write classes"), a key of the MCP metadata every entry point sends
  alike, so the class keeps it beside its annotations. No code, description
  or message names a harness or a product besides it, comments included.

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
  the set is kept to what both take as it is. `grants` is reserved: the grants
  directory (`<state root>/grants` by default) sits beside the labels'
  directories, so no label may take that name, and listing the labels skips it.
- **Each label keeps all of its state in one directory**,
  `<state root>/<label>/`, created with mode 700: the mirror, the sync list,
  the token file when there is one, the sync service's lock and progress, the
  service record, and the short-lived copies of files being sent or received.
  The state root is
  the `state_dir` path option, by default `$XDG_STATE_HOME/discord-tools`
  when `XDG_STATE_HOME` is absolute, else `~/.local/state/discord-tools`.
  One directory per label means a
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
- **The gateway is never opened.** Unread and mention counts exist only in
  the gateway's `READY`, but a check on a real phone showed that even brief
  sessions (Identify with no presence, closed with 1000 as soon as `READY`
  came) hold back the phone's push notifications: with no session 3 of 3
  pushes arrived, with sessions opened and closed every 10 seconds 3 of 7,
  and every 30 seconds 6 of 10. A missed push costs the user more than an
  unread count gives, so no tool offers unread counts, and the inbox says
  what waits from mentions and the mirror instead.
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
- **The service record names what the scheduler starts.** Installing the
  service writes `<label>/service.json`, mode 600: the program and the script
  it runs, as paths, and nothing else; uninstalling deletes it. The account
  read checks that both still exist, since a program removed by an update
  stops the schedule only at its next start, and the system's own log names
  just the missing file. A schedule whose program is gone is then told to be
  installed again, rather than found stale after it has stopped syncing.
- **Installing prefers a program at a path that outlives updates.** A
  program whose path holds its own version goes when that version is
  removed, so installing looks on the recorded `PATH` for one at a path
  without it that starts the same program, and says so when there is none.
  One under the temporary or runtime directory is passed over, since it is
  gone after a restart. The program is the same at install only: a link or
  a shim follows whatever its owner makes current later, which is the point
  of choosing it.
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

## Inbox

- **Mentions are Discord's list, not the mirror's.** `discord_inbox_read`
  method `mentions` asks `GET /users/@me/mentions` for the past 7 days, newest
  first, with roles, `@everyone` and `@here` asked for. Discord decides what
  counts as a mention, so servers the sync does not follow are included, and
  the server argument needs no sync list entry. The messages are stored
  through the ingest as search results are: they add to the mirror, delete
  nothing, keep stored reactions and mark no channel current. The list is not
  contiguous history, so a page is full, and `next_before` given, exactly when
  Discord answered as many messages as asked for.
- **`waiting` is the mirror's "not answered", never "unread".** The mirror
  holds no read state, and a message read on the phone is still waiting here.
  It makes no request. A message waits when it is from someone else, an
  ordinary message or a reply, newer than the window (14 days by default) and
  than the user's last message in its chat. In a DM or group DM that alone
  qualifies; in a server channel or thread it must also reply to one of the
  user's messages or mention the user's id: `@everyone`, `@here` and role
  mentions do not, since they ask everyone. Waiting chats are listed by their
  latest message, each with whether its chat is current and when the last
  complete sync run finished, since a chat that lags may hold messages, or the
  user's own answer, the mirror does not have yet.
- **`saved` is the user's own list, from Discord.** `discord_inbox_read`
  method `saved` asks `GET /users/@me/saved-messages`, which has no paging, and
  lists reminders first by their time, then saves without one, newest first,
  each with its message (null when Discord sent none) and whether a reminder's
  time has passed (`due`). The messages are stored through the ingest as
  mention results are. A reminder is Discord's own mark on the save, never a
  notification this package sends. Saving and removing change only that list
  (see "Writes"), never the message or the chat.
- **None of these marks anything read**, so the phone's unread state and its
  push notifications stay as they were; the one tool that marks a chat read is
  its own write tool (see "Writes").

## People

- **People and servers are read live, one request at a time.** The `people`
  toolset's reads (`discord_people_read`, `discord_server_read`) ask Discord
  on every call and keep no friend list, note, profile, member or role in the
  mirror: such things change without a trace a user account can poll, and a
  stored copy would be stale with nothing to say so. The one exception is the
  `roles` toolset's snapshot, stored with its time so it can say how old it
  is (see "Roles"). Only the user objects a
  read returns go through the ingest into the users the mirror knows, as a
  search's authors do, so a later call can name them.
- **A person or a server is an id the mirror knows.** A user argument must be
  a user the label's mirror holds (from a chat, a mention, a friend list), a
  server argument a server it holds; anything else is `not_found` before a
  request is made. A name is only ever search text or a filter.
- **`friends` is the user's own list.** `discord_people_read` method
  `friends` asks `GET /users/@me/relationships` and lists friends only, by
  name, each with the nickname the user gave them and the id of a DM with
  them that the mirror already holds (never one opened for the call). Pending
  requests are counted, incoming and outgoing, without saying who sent them,
  and blocked users are left out. A local `query` filters by name.
- **`notes` are the user's own words about others.** Method `notes` asks
  `GET /users/@me/notes`, or `GET /users/@me/notes/{user}` for one user. A
  note is private to the user; the result says so, and a user with no note is
  `note: null`, not an error.
- **A profile is read one person at a time, when asked.** Method `profile`
  asks `GET /users/{user}/profile` with mutual servers and friends, and with
  `server` the member's profile there. Discord shows a profile only to a
  friend, someone sharing a server, a bot or a pending request, and answers
  others with a refusal that is passed on as it is. The official client reads
  a profile when one is opened, never in bulk, so the tool and the skill keep
  to the person asked about. Mutual servers are named from the mirror, null
  for one it does not hold.
- **A member is one server's view of a person.** Method `member` asks
  `GET /guilds/{server}/members/{user}` and `GET /guilds/{server}/roles`, so
  each role comes with its name, highest first. Method `members` searches a
  server's members by name with `POST /guilds/{server}/members-search`, a
  POST that changes nothing and is sent as a read, as a search's is; it needs
  Manage Server, and
  without it the refusal says to take ids from messages, mentions or the
  friend list instead. Discord answers 202 while it indexes a server; that is
  waited out once, as a search's is, then reported.
- **A server is read whole, never through the mirror's copy.**
  `discord_server_read` takes a `server` the mirror knows. Method `info` asks
  `GET /guilds/{server}?with_counts=true` for what the server says of itself
  and its approximate member and online counts; Discord's counts are
  estimates, and the result says so. Method `roles` asks
  `GET /guilds/{server}/roles` and `/roles/member-counts` and lists every role
  highest first, with how many members hold it (null when Discord gives no
  count). Method `emojis` asks `GET /guilds/{server}/emojis` and `/stickers`,
  filters them by name locally and caps each list, saying when it did; an
  emoji comes with the text that uses it in a message. Nothing they return is
  stored: the mirror's server row stays what the sync last wrote.
- **Events are Discord's upcoming list.** Method `events` asks
  `GET /guilds/{server}/scheduled-events?with_user_count=true`, which holds
  scheduled and active events only, never finished ones, and lists them by
  start time with how many are interested. With `event` it asks
  `GET /guilds/{server}/scheduled-events/{event}/users` for who is
  interested, 100 at most, with `after` for the next page; those users go
  through the ingest as a friend list's do.
- **An invite code is a key, told to the user alone.** Method `invites` asks
  `GET /guilds/{server}/invites`, which needs Manage Server; without it the
  refusal says so. The inviters go through the ingest as interested users
  do. Anyone holding a code can join the server, so the result
  and the skill say a code goes to the user only, never into a message, a
  file or another tool unless the user asks for that.

## Roles

- **A role write is checked against a snapshot, so the snapshot is stored.**
  A prompt is drawn from the mirror alone, and the checks before a role write
  (the user's highest role, the permissions the user holds) need the server's
  roles and the user's own. `discord_role_read` methods `list` and `role` ask
  `GET /guilds/{server}/roles`, `/roles/member-counts` and
  `GET /users/@me/guilds/{server}/member`, and store through the ingest the
  server's roles and the ids of the user's own roles, with the time they were
  read. The roles a read did not return are dropped: a whole list vouches for
  itself. Nobody else's roles are stored; a member's roles are
  `discord_people_read`'s, read live.
- **The snapshot says how old it is.** A read returns when it was taken, and
  a role write refuses one older than 15 minutes, saying to read the roles
  again: roles change without a trace a user account can poll.
- **Permissions have Discord's names**, in lower case (`manage_messages`),
  never bit numbers. A read lists a role's permissions by name, a bit with no
  name as `bit{n}`, and marks the strong ones: those that act on other people,
  the server or its settings (`administrator`, `ban_members`, `kick_members`,
  `manage_guild`, `manage_roles`, `manage_channels`, `manage_webhooks`,
  `manage_messages`, `moderate_members`, `mention_everyone`,
  `manage_nicknames`, `manage_guild_expressions`, `manage_events`,
  `manage_threads`, `view_audit_log`, `pin_messages`).
- **The user's own permissions are worked out as Discord does.** They are
  `@everyone`'s and every role the user holds, joined; an owner or a holder
  of `administrator` has them all. A role is manageable when the user may
  manage roles (`manage_roles`, `administrator` or owning the server), it sits
  below the user's highest role (an owner is exempt; an equal position is not
  below), it is not managed by an integration, and it is not `@everyone`.
  Ownership is the mirror's server row, as the server list last said.
- **A role's members are Discord's list of ids.** Method `members` asks
  `GET /guilds/{server}/roles/{role}/member-ids` for a role the snapshot
  holds, other than `@everyone`, which Discord does not list; Discord returns
  at most 100 ids, and the result says when it reached that. Each id comes
  with the name the mirror holds, null for a user it does not, and nothing is
  stored.

## History

- **Counts are the mirror's, and say where it falls short.**
  `discord_history_read` method `counts` makes no request: it counts the
  ordinary messages and replies the mirror holds, never system events, per
  chat, per author or per day, over a window (the past 30 days by default).
  A chat whose mirrored history does not reach back to the window's start,
  or that the mirror holds only scraps of (search results, mentions), is
  partial, and one no sync run marked in the last 15 minutes is not current;
  the result counts both, so a reader knows the numbers are lower bounds
  rather than finding out later. A backfill is how a partial chat is made
  whole. Counting never summarizes text.
- **A day is a day where the person is.** Days are cut at midnight in
  `time_zone`, an IANA name, by default the machine's, and the result names
  the zone it used. Messages are grouped in quarter hours before they are
  given a day, since every zone's offset is a whole number of them.
- **An export is only what the mirror holds in one piece.** It runs from the
  chat's vouched oldest message to its newest, never over a gap; messages
  stored past the newest edge (live reads, sends, search results) are left
  out and counted, so a file never claims more than the mirror vouches for.
  Any chat with vouched history can be exported, followed or not; the file
  and the result say whether it is current. It makes no request.
- **What an export says is what a reader needs to cite it**: every message
  with its time and offset, its id, its author's id and name, a permalink
  (`https://discord.com/channels/<server or @me>/<chat>/<message>`), its whole
  text, what it replies to or forwards, whether it was edited, and its
  attachments, embeds, stickers and reactions as metadata (no file is
  downloaded). The file and the result say whether it reaches the chat's
  first message, whether `limit` cut it, and how to continue: `before` its
  oldest message, or a backfill first when the mirror reaches no further.
- **Text is quoted and never cut.** In Markdown every line of a text starts
  with `> `, Unicode line separators included, so a text cannot pass for a
  heading of the file; a name has its line breaks folded into spaces, and
  only the author's id attributes a message. JSON is one object (`export`, a
  `note` that the text is other people's words, `messages`); JSONL is that
  head on its first line, then one message per line.
- **Exports are only created, and private**: under `<download_dir>/exports/`,
  a folder of mode 0700, each file of mode 0600, named
  `<chat>-<first day>[-<last day>].<md|json|jsonl>` by the days of the zone it
  was written in. The file is written in full under a temporary name and
  then given its final one without replacing anything, so a reader never
  finds half an export and a name already taken gets a number. An export can
  hold private DMs, so it is never readable by others.

## Files

- **Files go in and out only through the directories a setting names**,
  judged by real path, so a link that leads elsewhere counts as elsewhere.
  The state directory and the tools' own install directory are never among
  them, nor a directory that holds either, so a home directory never
  qualifies.
- **Received files are saved under `download_dir`**, a `path` option read as
  "Options" describes, by default `~/Downloads/discord-tools`, where a person
  looks for downloads first. Each message gets a folder of its own,
  `<channel>-<message>`, so files from different people never mix, and
  nothing is ever overwritten: a name already taken gets a number. A
  directory that is not there yet is made on the first save, never by a
  read.
- **A file is at most `download_max_mb` megabytes**, a whole `number` option
  from 1 to 500 read as "Options" describes, 100 by default.
  Discord's own limits on uploads are smaller for most accounts; the
  cap keeps a link preview or an archive from filling the disk.
- **Downloads come only from Discord's CDN and media proxy**
  (`cdn.discordapp.com`, `media.discordapp.net`,
  `images-ext-<n>.discordapp.net`), over `https`, without the token, through
  the HTTP client and its pacing, without following a redirect, 180 seconds
  each and 540 a call. The site behind a link is never fetched.
- **What someone sent is checked before it is kept**, by its name, its
  declared type and its bytes, and an archive by everything in it; a program,
  an installer, a script or an archive that cannot be read is not saved.
  Files are written without an execute bit and, on macOS, marked as
  downloaded, so the system asks before one is opened. An archive is
  unpacked only when asked, into a new folder beside it.
- **Files are sent only from `send_dirs`**, a `paths` option of at most 20
  directories read as "Options" describes, by default the call's working
  directory, where the file an agent made usually is. A message carries at
  most 10 files, each at most `send_max_mb` megabytes, a whole `number` option
  from 1 to 500, 10 by default (Discord's limit without Nitro).
- **What would leak is never sent, wherever it is**: credentials, keys and
  local databases by name or by a folder on the way (`.ssh`, `.aws`, `.git`,
  `.config`, …), and any file holding a private key. Programs, installers and
  disk images are refused by name and by bytes; scripts are code a person
  asked to share and go. An archive goes only when the inspection passes it
  with the same rules applied to everything inside, and one the module cannot
  read does not go. One refused file refuses the whole send, before anything
  is requested.
- **What is checked is what is sent.** Each file is opened without following
  a link, checked again by its real path, and copied once into the label's
  state; every check reads the copy and the copy is uploaded, so a file
  changed or swapped after the check is never the one that leaves. The
  approval prompt pins each file's hash, and a file changed after the prompt
  makes the call `stale`.
- **Uploads go only to the signed storage URL Discord returns**, over `https`
  on `*.storage.googleapis.com`, without the token, paced like every request
  and never retried, 120 seconds each and 600 for all. A reservation or an
  upload that fails means nothing was sent: the message is posted only once
  every file is up.
- **A post with files sends them as a file send does.** `discord_file_post`
  takes a post's arguments and `files`, found, checked, copied, reserved in
  the forum channel and uploaded by the rules above, and its prompt pins them
  the same way; the text is optional, since files alone make a first message.
  Everything a post refuses before a request is refused before the files are
  copied or reserved.

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
- **A change to the saved list names a message the mirror knows**, as an
  action does, and changes only the user's own list: saving again replaces the
  reminder, so a save is an overwrite, and removing a save Discord does not
  have is done, marked `already`. The reminder time is an ISO 8601 timestamp
  with a zone later than now, sent in UTC; a time that is not is refused
  without a request. Discord's cap on saves without a reminder comes back as
  its refusal. The list is not in the mirror, so nothing follows a change
  there, and a read-back after an uncertain outcome reads the list itself.
- **A read mark is one chat, up to one message.** `discord_read_mark` names
  the chat and, optionally, a message of it the mirror holds; left out, the
  newest message the mirror holds for the chat. It sends `POST
/channels/{c}/messages/{m}/ack` with `{ token: null }` and never `manual`,
  so a mark older than the chat's current one never moves the read state
  back. It replaces the chat's read state on every device, so it is an
  overwrite. Discord offers no read of read state, so an outcome that may
  have reached Discord is `uncertain` with `read_back: "skipped"`; a second
  mark changes nothing further. When the message is left out, the prompt pins
  the newest one it showed, so a message that arrives after the prompt makes
  the call `stale` instead of marking past what the person saw.
- **Nothing marks a chat read but the tool for it.** A read mark clears the
  unread state on every device the user has, so it is a call the harness asks
  about, never a side effect of looking.
- **A thread is started where its arguments say, and only there.**
  `discord_thread_create` names a text or announcement channel the mirror
  knows and, to start from a message, a message the mirror holds in that
  channel: `POST /channels/{c}/messages/{m}/threads` makes a public thread
  whose id is the message's. Without a message it sends
  `POST /channels/{c}/threads` with `type` always given (11 public, 12 private,
  since Discord's default is private), and a private thread only in a text
  channel. Forums, media channels, threads and DMs are refused before any
  request; Discord decides the rest (permissions, slowmode, a message that
  already has a thread). Thread creation carries no nonce, so an outcome that
  may have reached Discord is `uncertain` after one read-back: the message's
  thread, or the channel's newest threads the user owns with that name. The
  thread Discord returns goes through the ingest; nothing is marked current.
  A first message is a send of its own.
- **A post is a thread with its first message, in a forum or media
  channel.** `discord_post_create` names a forum or media channel the mirror
  knows, the post's name, its text and up to 5 tags by id, each one the
  forum's tags in the mirror list (`discord_chat_read` method `threads`
  shows them); a tag it does not list, or no tag where the forum's flags
  require one, is refused before any request. It sends
  `POST /channels/{c}/threads` with the name, `applied_tags` and a `message`
  built as a send's is: the text exactly as given, `@everyone`, `@here` and
  role mentions notifying only with `mass_mentions`, and `silent` one
  argument away. Discord decides the rest (moderated tags, slowmode, a media
  channel that wants a file). Thread creation takes no nonce, so an outcome
  that may have reached Discord is `uncertain` after one read-back of the
  channel's newest posts the user owns with that name. The post and its
  first message, which shares its id, go through the ingest.
- **Joining and leaving a thread change only the user's membership.**
  `discord_thread_join` and `discord_thread_leave` name a thread the mirror
  knows (a public, private or announcement thread, or a post) and send `PUT`
  or `DELETE /channels/{t}/thread-members/@me`; anything else is refused
  before a request. Joining again changes nothing, so a join is idempotent;
  leaving a private thread may take an invite to undo, so a leave is an
  overwrite. Discord refuses an archived thread, and that refusal is passed
  on: joining does not reopen one. The mirror holds no membership, so nothing
  follows a change there, and an outcome that may have reached Discord is
  `uncertain` after one read of the user's membership.
- **A role write is administrative and checked against the snapshot first.**
  Roles change what others may do in a server, so every role write is asked
  about each time. Before any request, from the mirror alone: the server's
  snapshot is under 15 minutes old, the user may manage roles, and the role
  is one the user may manage (see "Roles"). A refused check names what to do,
  such as reading the roles again. An optional `reason`, up to 512
  characters, goes as `X-Audit-Log-Reason` and is shown in the prompt. A role
  write that changes the user's own roles expires the snapshot through the
  ingest, so the next role write reads them again. Discord checks the same
  rules again and decides the rest.
- **Giving a role never hands over more than the user has.**
  `discord_role_assign` names a role and 1 to 30 distinct users the mirror
  knows; `discord_role_unassign` names one. Giving a role that holds
  `administrator`, or a permission the user lacks, is refused before a
  request; taking one away is not. One user is
  `PUT /guilds/{s}/members/{u}/roles/{r}`, several
  `PATCH /guilds/{s}/roles/{r}/members` with `member_ids`; taking a role is
  `DELETE /guilds/{s}/members/{u}/roles/{r}`. Giving a role someone holds,
  or taking one they lack, changes nothing, so both are sent as asked. An
  outcome that may have reached Discord is `uncertain` after one read-back:
  the member's roles for one user, the role's member ids for several (which
  list at most 100, so a user missing past that is unknown). Other people's
  roles are never stored.
- **Creating and editing a role grant only what the user may hand out.**
  `discord_role_create` takes a name (1 to 100 characters), permissions by
  name (none when left out), a color (`#rrggbb`), `hoist` and `mentionable`,
  and sends `POST /guilds/{s}/roles`; Discord puts a new role at the bottom,
  above `@everyone`. `discord_role_edit` names a role the user may manage and
  any of a name, a color (or `none`), `hoist`, `mentionable`, permissions to
  `grant` and to `revoke`, and sends `PATCH /guilds/{s}/roles/{r}` with only
  what changes; `@everyone` may be edited, its permissions only. An edit
  sends the role's whole new permission set, worked out from the snapshot,
  so a name in both `grant` and `revoke`, or an edit that changes nothing, is
  refused. Creating or granting `administrator`, or a permission the user
  lacks, is refused before a request; revoking is not.
- **Deleting a role is final.** `discord_role_delete` names a role the user
  may manage and sends `DELETE /guilds/{s}/roles/{r}`; the role leaves
  everyone who held it, and nothing brings it back.
- **A done change follows in the snapshot.** The role Discord returns from a
  creation or an edit, and the removal of a deleted one, go through the
  ingest into the snapshot's roles without changing when it was read; a
  change to a role the user holds expires the snapshot instead. Creating a
  role takes no nonce, so an outcome that may have reached Discord is
  `uncertain` after one read of the server's roles, whose roles with that
  name are candidates, never a confirmation, and the creation is never
  repeated. An unclear edit or delete reads the roles once too, and says
  whether the role is there and as asked.

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
- **A file send pins the files it sends.** The prompt names each file and its
  size, which says little about its bytes, so the `files` pin holds the
  SHA-256 of each file's content in the order given, joined with `,`; a file
  changed after the prompt makes the call `stale`. The files are found by the
  send's own rules (where they are, what they are, their size), so one the
  send would refuse for those gives no description. What the send checks in
  its copy (names, bytes, archives) is left to the send.
- **A save lists what the mirror holds.** Its prompt's text, under the label
  `Attachments`, is the attachment names the mirror stores for the message,
  one to a line; link previews and stickers are read from Discord when the call
  runs, so the prompt cannot list them, and a message whose attachments the
  mirror does not hold has no text. Every name is another person's data.
- **An export names the chat, the messages and where the file goes.** Its
  facts are the format, which messages it takes as the arguments name them
  (the newest, or the first after a bound), and the exports folder; the
  file's own name depends on what the mirror holds when the call runs, so the
  prompt names the folder. Nothing leaves the machine, so the prompt has no
  text, but the file can hold private DMs: a person approves every export.
- **A new thread names where it starts and what it is called.** Its prompt
  shows the channel, the message it starts from (author and a short quote)
  when there is one, its name, public or private, and when it archives; the
  name is the model's words for others to read, shown as given, never
  translated.
- **A join or a leave names the thread.** Its prompt is the thread's chat
  facts (its kind, server and channel) under "About to join {chat}" or
  "About to leave {chat}", with no text.
- **A post shows what it puts up.** Its prompt names the forum, the post's
  name, its tags by the names the mirror holds, and a send's facts
  (`Mass mentions`, `Notifications`, `Length`); its text is the first
  message, verbatim, as a send's is.
- **A role write names the role and whom it reaches.** Its prompt names the
  server, the role by its name in the snapshot and, for giving or taking, the
  members by the names the mirror holds (an id for one it does not); giving a
  role with strong permissions lists them, since the person approves handing
  them over. The `reason` is the prompt's text, verbatim. The prompt pins the
  role's permissions and position as the snapshot holds them, so a role that
  changed before the call runs makes it `stale`. A new role is named in the
  headline by the name given; a creation lists every permission it gives and
  an edit what it changes, each value as it will be, with the strong
  permissions given marked apart.
- **A change to the sync list names the server and its channels.** The
  server is its name in the mirror, else its id, since a server the account
  has left can still be removed; a channel is `#name`, else its id. The
  list itself is local, so its prompt has no text.
- **The facts the tools add**, in the order they are shown:

  | Label                | Value                                                                                               | Shown                                                                                |
  | -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
  | `Chat`               | the kind of chat: `Direct message`, `Group DM`, `Text channel`, …                                   | always                                                                               |
  | `Server`             | the server's name                                                                                   | a chat in a server                                                                   |
  | `Channel`            | the channel a thread belongs to, as `#name`                                                         | a thread                                                                             |
  | `Reminder`           | the reminder's time in UTC, as an ISO 8601 time, or `none`                                          | an addition to the saved list                                                        |
  | `Author`             | who wrote the message, `You` for the user's own                                                     | a reaction, a pin, a save, a thread from a message                                   |
  | `Message`            | the message, quoted short                                                                           | a reaction, a pin, a save, a saved-list change, a read mark, a thread from a message |
  | `Read state`         | `cleared on every device up to this message`                                                        | a read mark                                                                          |
  | `Unpack`             | the entries named, joined with `, `, or `Every archive`                                             | `unpack` of a save                                                                   |
  | `Format`             | `Markdown`, `JSON` or `JSONL`                                                                       | an export                                                                            |
  | `Messages`           | `The newest {count}` or `The first {count} after {after}`, each with `, before {before}` when given | an export                                                                            |
  | `Folder`             | the exports folder, as an absolute path                                                             | an export                                                                            |
  | `Name`               | the new thread's or post's name, as given                                                           | a new thread, a post                                                                 |
  | `Tags`               | the tags given, by their names in the mirror, joined with `, `                                      | a post with `tags`                                                                   |
  | `Visibility`         | `Public` or `Private`                                                                               | a new thread                                                                         |
  | `Archives after`     | `1 hour`, `1 day`, `3 days` or `1 week`, or `Discord's default`                                     | a new thread                                                                         |
  | `Current text`       | the text an edit replaces, quoted short                                                             | an edit                                                                              |
  | `Reply to`           | the message replied to, quoted short                                                                | a reply                                                                              |
  | `Mass mentions`      | `Notify`                                                                                            | `mass_mentions` of a send, an edit or a post                                         |
  | `Notifications`      | `Silent`                                                                                            | `silent`                                                                             |
  | `Files`              | each file's name and size, as `a.pdf (1.2 MB)`, joined with `, `                                    | a file send, a post with files                                                       |
  | `Role`               | the role's name in the snapshot                                                                     | a write to an existing role                                                          |
  | `Members`            | the members' names, joined with `, `                                                                | giving or taking a role                                                              |
  | `New name`           | the role's name, as given                                                                           | a new role, an edit with `name`                                                      |
  | `Strong permissions` | the strong permissions given, by name, joined with `, `                                             | giving, creating or granting any                                                     |
  | `Color`              | `#rrggbb`, or `None`                                                                                | a role with `color`                                                                  |
  | `Listed apart`       | `Yes` or `No`                                                                                       | a role with `hoist`                                                                  |
  | `Mentionable`        | `Yes` or `No`                                                                                       | a role with `mentionable`                                                            |
  | `Permissions`        | every permission given, by name, joined with `, `, or `None`                                        | a new role                                                                           |
  | `Grant`              | the permissions granted, by name, joined with `, `                                                  | an edit with `grant`                                                                 |
  | `Revoke`             | the permissions revoked, by name, joined with `, `                                                  | an edit with `revoke`                                                                |
  | `Follows`            | `Whole server` or `Named channels`                                                                  | an addition to the sync list                                                         |
  | `Channels`           | the channels named, as `#name`, joined with `, `                                                    | a sync list change with `channels`                                                   |
  | `Excluded`           | the channels excluded, as `#name`, joined with `, `                                                 | an addition with `exclude`                                                           |
  | `Length`             | `{count} characters`, in code points                                                                | a send, an edit's new text, a post                                                   |

## Toolsets

- **One per domain**: `account`, `sync` (the sync list), `chats`, `search`,
  `inbox` (mentions, what waits for an answer, the saved list and read marks), `people` (people and server
  info), `sends`, `history` (counts and the export), `files` (saving received
  files), `actions` (the user's own messages, reactions and pins), `threads`
  (creating threads and forum posts, joining and leaving threads) and `roles`
  (reading a server's roles and changing them).
- **`account`, `sync`, `chats`, `search`, `inbox`, `people` and `sends` are on
  by default.** They cover reading a chat and answering it. `history` and
  `files` write files to disk; `actions` changes messages other people have
  already read and `threads` creates lasting posts; `roles` changes what
  others may do in a server. Each is one setting away.
- **Text and file sends are tools of their own** in `sends`, so a permission
  rule can let texts through while files are asked for every time. A post and
  a post with files are tools of their own in `threads` for the same reason.
