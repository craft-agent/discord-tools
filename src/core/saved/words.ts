import type { Translations } from "../words"

/** The translations of the saved-message tools' words: titles, intents, headline templates and the `Reminder` fact. */
export const SAVED_TRANSLATIONS: Translations = {
  ja: {
    "Save a Discord message": "Discord メッセージを保存する",
    "About to save a Discord message": "Discord メッセージを保存しようとしています",
    "About to save a message by {author} in {chat}": "{chat} の {author} のメッセージを保存しようとしています",
    "About to save a message in {chat}": "{chat} のメッセージを保存しようとしています",
    "Remove a saved Discord message": "保存した Discord メッセージを削除する",
    "About to remove a saved Discord message": "保存した Discord メッセージを削除しようとしています",
    "About to remove a saved message by {author} in {chat}":
      "{chat} の {author} の保存済みメッセージを削除しようとしています",
    "About to remove a saved message in {chat}": "{chat} の保存済みメッセージを削除しようとしています",
    Reminder: "リマインダー",
    none: "なし",
  },
}
