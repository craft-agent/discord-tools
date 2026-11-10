import type { Translations } from "../words"

/** The translations of the file send tool's words: its title, intent, headline templates and `Files` label; the rest it shares with the text send. */
export const FILE_SEND_TRANSLATIONS: Translations = {
  ja: {
    "Send files to a Discord chat": "Discord のチャットにファイルを送信する",
    "About to send files to a Discord chat": "Discord のチャットにファイルを送信しようとしています",
    "About to send files to {chat}": "{chat} にファイルを送信しようとしています",
    "About to reply with files to {author} in {chat}": "{chat} で {author} にファイル付きで返信しようとしています",
    "About to reply with files in {chat}": "{chat} でファイル付きで返信しようとしています",
    Files: "ファイル",
  },
}
