import type { Translations } from "../words"

/** The translations of the read-mark tool's words: title, intent, headline templates and the `Read state` fact. */
export const READ_MARK_TRANSLATIONS: Translations = {
  ja: {
    "Mark a Discord chat read": "Discord チャットを既読にする",
    "About to mark a Discord chat read": "Discord チャットを既読にしようとしています",
    "About to mark {chat} read up to a message by {author}":
      "{chat} を {author} のメッセージまで既読にしようとしています",
    "About to mark {chat} read": "{chat} を既読にしようとしています",
    "Read state": "既読状態",
    "cleared on every device up to this message": "このメッセージまで、すべての端末で既読になります",
  },
}
