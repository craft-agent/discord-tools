/** The schema version a current mirror has: the number of `MIGRATIONS`. */
export const MIRROR_VERSION = 3

/**
 * `MIGRATIONS[i]` takes a mirror from version `i` to `i + 1`; entry 0 creates
 * the first schema. A change to the schema adds an entry and never edits one,
 * so a mirror of any older version reaches the current one.
 *
 * Every id is a snowflake kept as an INTEGER, so ranges compare numerically;
 * ids exceed 2^53, so they are bound as BigInt and read back as text. Times
 * are milliseconds. A boolean is 0 or 1. `recipients`, `thread`, `forum`,
 * `mentions`, `mention_roles`, `attachments`, `embeds`, `stickers` and
 * `reactions` hold JSON text, and `raw` the object exactly as Discord sent it,
 * so a later tool can read a field without fetching history again.
 * The send ledger holds a SHA-256 hex of the text, never the text; `code`
 * is the error code of a `not_sent` or `uncertain` send. `roles` holds one
 * server's whole role list as its last snapshot read it, `permissions` being
 * Discord's decimal bit-set text; `role_snapshots` holds, per server, the ids
 * of the user's own roles (JSON text) and when the snapshot was read.
 */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE servers (
  id INTEGER PRIMARY KEY,
  name TEXT,
  owner INTEGER CHECK (owner IN (0, 1)),
  icon TEXT,
  raw TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  server INTEGER,
  type INTEGER NOT NULL,
  name TEXT,
  parent INTEGER,
  position INTEGER,
  last_message INTEGER,
  recipients TEXT,
  thread TEXT,
  forum TEXT,
  raw TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX channels_server ON channels (server);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  global_name TEXT,
  bot INTEGER NOT NULL DEFAULT 0 CHECK (bot IN (0, 1)),
  raw TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  channel INTEGER NOT NULL,
  server INTEGER,
  author INTEGER,
  from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  type INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  author_nick TEXT,
  ref_kind TEXT CHECK (ref_kind IN ('reply', 'forward')),
  ref_message INTEGER,
  ref_channel INTEGER,
  mentions TEXT,
  mention_roles TEXT,
  mention_everyone INTEGER NOT NULL DEFAULT 0 CHECK (mention_everyone IN (0, 1)),
  attachments TEXT,
  embeds TEXT,
  stickers TEXT,
  reactions TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  flags INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  raw TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX messages_channel ON messages (channel, id);
CREATE INDEX messages_author ON messages (author, id);

CREATE TABLE cursors (
  channel INTEGER PRIMARY KEY,
  newest INTEGER,
  oldest INTEGER,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  synced_at INTEGER,
  rechecked_at INTEGER
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`,
  `
CREATE TABLE sends (
  nonce INTEGER PRIMARY KEY,
  channel INTEGER NOT NULL,
  reply_to INTEGER,
  text_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'not_sent', 'uncertain')),
  message INTEGER,
  code TEXT,
  settled INTEGER
);
CREATE INDEX sends_created ON sends (created);
`,
  `
CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  server INTEGER NOT NULL,
  name TEXT,
  position INTEGER NOT NULL,
  permissions TEXT NOT NULL,
  managed INTEGER NOT NULL CHECK (managed IN (0, 1)),
  raw TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX roles_server ON roles (server);

CREATE TABLE role_snapshots (
  server INTEGER PRIMARY KEY,
  own_roles TEXT NOT NULL,
  read_at INTEGER NOT NULL
);
`,
]
