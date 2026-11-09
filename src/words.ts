import { mergeTranslations, type Translations } from "./core"
import { CHAT_TRANSLATIONS } from "./core/chats/describe"
import { FACT_TRANSLATIONS } from "./core/facts"
import { SEND_TRANSLATIONS } from "./core/sends/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(FACT_TRANSLATIONS, CHAT_TRANSLATIONS, SEND_TRANSLATIONS)
