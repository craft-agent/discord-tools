"""The plugin's identity and constants that differ between tool packages."""

from __future__ import annotations

#: The plugin's name: used as a log prefix, approval rule key prefix and Hermes toolset prefix.
PLUGIN_NAME = "discord-tools"

#: The built command-line name used in error and log messages.
CLI_NAME = "discord-tools-cli"

#: The prefix skills start with: skills named ``<SKILL_PREFIX><topic>`` are registered without it.
SKILL_PREFIX = "discord-"

#: The emoji each toolset is shown with.
TOOLSET_EMOJI: dict[str, str] = {
    "account": "🪪",
    "sync": "🔄",
    "chats": "💬",
    "search": "🔍",
    "inbox": "📥",
    "sends": "📤",
    "files": "📎",
    "actions": "🔧",
}

__all__ = [
    "CLI_NAME",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
