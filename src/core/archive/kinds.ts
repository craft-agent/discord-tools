export type ArchiveFormat = "zip" | "tar" | "tar.gz"

/** What a file's first bytes give away besides an archive format. */
export type HeadKind = "program" | "script" | "archive"

/** How much of a file `kindOfHead` is given. */
export const HEAD_BYTES = 4096

/** File names that stand for an archive, an installer, a program or a script. */
export const RISKY_NAME =
  /\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz|zst|lz|lzma|cab|apk|aab|ipa|exe|msi|msp|dmg|pkg|mpkg|iso|img|jar|war|class|scr|bat|cmd|com|cpl|hta|lnk|reg|inf|msc|wsf|wsh|js|jse|mjs|cjs|vbs|vbe|ps1|psm1|sh|bash|zsh|fish|ksh|csh|command|tool|app|workflow|terminal|applescript|scpt|scptd|py|pyc|pyw|rb|pl|php|lua|tcl|dylib|so|dll|bin|run|deb|rpm|appimage|kext|plugin|prefpane|xpi|crx)$/i

/** Media types that stand for an archive, an installer, a program or a script. */
export const RISKY_TYPE =
  /zip|rar|7z|tar|gzip|bzip|x-xz|compressed|archive|java-archive|android\.package|msdownload|msdos|x-executable|x-mach|x-sh\b|x-shellscript|javascript|vbscript|x-apple-diskimage|x-iso|x-elf|x-sharedlib|x-object|x-python|x-ruby|x-perl|x-php|x-script|x-tcl|x-lua|x-applescript|x-msi|x-bat/i

/** The one kind of `RISKY_NAME` an archive may carry when scripts are allowed: source scripts, not installers or programs. */
export const SCRIPT_NAME =
  /\.(?:js|jse|mjs|cjs|vbs|vbe|ps1|psm1|sh|bash|zsh|fish|ksh|csh|bat|cmd|wsf|wsh|applescript|scpt|scptd|py|pyc|pyw|rb|pl|php|lua|tcl)$/i

const NAME_FORMATS: ReadonlyArray<readonly [RegExp, ArchiveFormat]> = [
  [/\.zip$/i, "zip"],
  [/\.tar$/i, "tar"],
  [/\.(?:tar\.gz|tgz)$/i, "tar.gz"],
]

const MACH_O = [
  "\xfe\xed\xfa\xce",
  "\xfe\xed\xfa\xcf",
  "\xce\xfa\xed\xfe",
  "\xcf\xfa\xed\xfe",
  "\xca\xfe\xba\xbe",
  "\xbe\xba\xfe\xca",
]
const OTHER_ARCHIVES = ["7z\xbc\xaf\x27\x1c", "Rar!", "\xfd7zXZ\x00"]
const PE_POINTER = 0x3c
const TAR_MAGIC_OFFSET = 257

/** Whether `head` holds the Latin-1 characters of `text` as bytes at `offset`. */
function hasBytes(head: Uint8Array, text: string, offset = 0): boolean {
  return head.length >= offset + text.length && [...text].every((char, i) => head[offset + i] === char.charCodeAt(0))
}

function isPortableExecutable(head: Uint8Array): boolean {
  if (head.length < PE_POINTER + 4 || !hasBytes(head, "MZ")) return false
  const offset = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(PE_POINTER, true)
  return offset + 4 <= head.length && hasBytes(head, "PE\0\0", offset)
}

/** The archive format a file name says it has, or undefined when it is not one of the formats this module reads. */
export function formatOfName(name: string): ArchiveFormat | undefined {
  return NAME_FORMATS.find(([pattern]) => pattern.test(name))?.[1]
}

/** The archive format a file's first bytes say it has. */
export function formatOfHead(head: Uint8Array): ArchiveFormat | undefined {
  if (hasBytes(head, "PK\x03\x04") || hasBytes(head, "PK\x05\x06")) return "zip"
  if (hasBytes(head, "\x1f\x8b")) return "tar.gz"
  if (hasBytes(head, "ustar", TAR_MAGIC_OFFSET)) return "tar"
  return undefined
}

/** What a file's first bytes give away: a program, another archive, or a script (a shebang line). */
export function kindOfHead(head: Uint8Array): HeadKind | undefined {
  if (hasBytes(head, "\x7fELF") || MACH_O.some((magic) => hasBytes(head, magic)) || isPortableExecutable(head)) {
    return "program"
  }
  if (formatOfHead(head) || OTHER_ARCHIVES.some((magic) => hasBytes(head, magic))) return "archive"
  if (hasBytes(head, "BZh") && head.length > 3 && head[3] >= 0x31 && head[3] <= 0x39) return "archive"
  if (hasBytes(head, "#!")) return "script"
  return undefined
}

/**
 * Why a file received on its own is refused, or undefined when it is not. A
 * file whose name says it is a readable archive is left to the archive
 * inspection, which looks at its content.
 */
export function refusalOfFile(file: { name: string; type?: string; head?: Uint8Array }): string | undefined {
  if (formatOfName(file.name)) return undefined
  if (RISKY_NAME.test(file.name) || (file.type !== undefined && RISKY_TYPE.test(file.type))) {
    return "an archive or a program"
  }
  const kind = file.head && kindOfHead(file.head)
  if (kind === "program") return "a program"
  if (kind === "script") return "a script"
  if (kind === "archive") return "an archive"
  return undefined
}
