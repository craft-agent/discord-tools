import { mergeTranslations, type Translations } from "./core"
import { ACTION_TRANSLATIONS } from "./core/actions/words"
import { CHAT_TRANSLATIONS } from "./core/chats/describe"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_TRANSLATIONS } from "./core/files/words"
import { HISTORY_TRANSLATIONS } from "./core/history/words"
import { READ_MARK_TRANSLATIONS } from "./core/read-mark/words"
import { SAVED_TRANSLATIONS } from "./core/saved/words"
import { FILE_SEND_TRANSLATIONS } from "./core/sends/file-words"
import { SEND_TRANSLATIONS } from "./core/sends/words"
import { SYNC_TRANSLATIONS } from "./core/sync/words"
import { THREAD_TRANSLATIONS } from "./core/threads/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  FACT_TRANSLATIONS,
  CHAT_TRANSLATIONS,
  SEND_TRANSLATIONS,
  FILE_SEND_TRANSLATIONS,
  FILE_TRANSLATIONS,
  HISTORY_TRANSLATIONS,
  ACTION_TRANSLATIONS,
  SAVED_TRANSLATIONS,
  READ_MARK_TRANSLATIONS,
  SYNC_TRANSLATIONS,
  THREAD_TRANSLATIONS,
)
