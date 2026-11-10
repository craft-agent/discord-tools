/** How many characters of a name a message shows by default. */
export const NAME_SHOWN = 80

/** Control, line-separator, bidi-override and invisible characters: names are written by whoever sent the archive. */
export const ODD_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g

/** An entry name as it may appear in a message: odd characters replaced by `?`, the length cut. */
export function shownName(name: string, max = NAME_SHOWN): string {
  const cleaned = name.replace(ODD_CHARACTERS, "?")
  const characters = Array.from(cleaned)
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : cleaned
}
