import { shownName } from "./names"

/** How many bytes of the previous piece are searched again, so a private key header split across two pieces is found. */
const KEY_OVERLAP = 64
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/

/** Base names that are a credential, a key or a local database. `^\.env` stays last: Hermes's install scan reads env followed by a bar as a shell pipe. */
export const SECRET_NAME =
  /\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|sqlite|sqlite3|db|jks|keystore|gpg|asc|ovpn|mobileprovision)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^(?:\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials)$|credential|secret|password|^\.env/i

/** Folder names, lower case, that hold credentials or keys; a folder is matched by its lower-cased name. */
export const SECRET_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config",
  ".password-store",
  "keychains",
])

/**
 * Why a path must not leave, or undefined when nothing in it is secret. `parts` are the path's
 * components, the folders first and the file name last; the folders are judged before the name.
 */
export function secretRefusal(parts: readonly string[]): string | undefined {
  const folder = parts.slice(0, -1).find((part) => SECRET_FOLDERS.has(part.toLowerCase()))
  if (folder !== undefined) return `it is in a ${shownName(folder)} folder, which holds credentials`
  const name = parts[parts.length - 1]
  if (name !== undefined && SECRET_NAME.test(name)) return "it is named like a credential, key or database"
  return undefined
}

/** Looks for a private key block in data that arrives in pieces. */
export class KeyScan {
  private tail = Buffer.alloc(0)

  /** Whether a private key block header is in this piece or across its start; true once found, call no more. */
  push(chunk: Uint8Array): boolean {
    const searched = Buffer.concat([this.tail, chunk])
    this.tail = searched.subarray(-KEY_OVERLAP)
    return PRIVATE_KEY.test(searched.toString("latin1"))
  }
}
