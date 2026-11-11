import type { Translations } from "../words"

/** The translations of the export tool's words: title, intent, headline template, fact labels and value templates. */
export const HISTORY_TRANSLATIONS: Translations = {
  ja: {
    "Export a Discord chat": "Discord チャットを書き出す",
    "About to export a Discord chat": "Discord チャットを書き出そうとしています",
    "About to export {chat}": "{chat} を書き出そうとしています",
    Format: "形式",
    Markdown: "Markdown",
    JSON: "JSON",
    JSONL: "JSONL",
    Messages: "メッセージ",
    "The newest {count}": "最新の {count} 件",
    "The newest {count}, before {before}": "{before} より前の最新の {count} 件",
    "The first {count} after {after}": "{after} より後の最初の {count} 件",
    "The first {count} after {after}, before {before}": "{after} より後、{before} より前の最初の {count} 件",
    Folder: "フォルダー",
  },
}
