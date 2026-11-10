/** The most characters a saved name has. */
const NAME_MAX_CHARACTERS = 120

/** The most UTF-8 bytes a saved name has, which leaves room for a number and the file system's own limit. */
const NAME_MAX_BYTES = 200

/** The longest extension, dot included, a cut name keeps. */
const EXTENSION_MAX_CHARACTERS = 16

/** Everything but letters, digits, `_`, `.`, `-` and space; a run of it becomes one `_`. */
const ODD_RUN = /[^\p{L}\p{N}_.\- ]+/gu

/** Spaces and dots at either end, which a system may drop or hide. */
const EDGE = /^[ .]+|[ .]+$/g

/** The extension that has a dot inside it. */
const DOUBLE_EXTENSION = /\.tar\.gz$/i

/** A name split into the part a number goes before and the extension. */
function splitName(name: string): [stem: string, extension: string] {
  const double = DOUBLE_EXTENSION.exec(name)
  if (double && double.index > 0) return [name.slice(0, double.index), double[0]]
  const dot = name.lastIndexOf(".")
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
}

/** The longest start of `text` of at most `characters` code points and `bytes` UTF-8 bytes, never splitting a code point. */
function cut(text: string, characters: number, bytes: number): string {
  let kept = ""
  let count = 0
  let used = 0
  for (const character of text) {
    count += 1
    used += Buffer.byteLength(character)
    if (count > characters || used > bytes) break
    kept += character
  }
  return kept
}

/**
 * The name a received file gets on disk, from the name its sender gave it:
 * the base name only (cut at `/` and `\`), every run of characters other than
 * letters, digits, `_`, `.`, `-` and space made one `_`, spaces and dots
 * trimmed at both ends, and at most 120 characters and 200 bytes of UTF-8,
 * keeping an extension of at most 16 characters. A name that is empty
 * after that is `file-<position>`.
 */
export function cleanName(raw: string, position: number): string {
  const base = raw.split(/[/\\]/).at(-1) ?? ""
  const name = base.replace(ODD_RUN, "_").replace(EDGE, "")
  if (name === "") return `file-${position}`
  const [stem, extension] = splitName(name)
  const keepExtension = extension.length <= EXTENSION_MAX_CHARACTERS
  const room = keepExtension
    ? { characters: NAME_MAX_CHARACTERS - extension.length, bytes: NAME_MAX_BYTES - Buffer.byteLength(extension) }
    : { characters: NAME_MAX_CHARACTERS, bytes: NAME_MAX_BYTES }
  const kept = cut(keepExtension ? stem : name, room.characters, room.bytes).replace(EDGE, "")
  return kept === "" ? `file-${position}` : `${kept}${keepExtension ? extension : ""}`
}

/** The name with `-<n>` before its extension: `photo-2.png`. */
export function numberedName(name: string, n: number): string {
  const [stem, extension] = splitName(name)
  return `${stem}-${n}${extension}`
}
