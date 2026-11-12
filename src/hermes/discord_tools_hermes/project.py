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
    "people": "👥",
    "sends": "📤",
    "history": "📊",
    "files": "📎",
    "actions": "🔧",
}

#: The settings the tools themselves read, beside the ones every plugin takes: each snake_case name and its type
#: (``text``, ``boolean``, ``number`` or ``list``), as in ``src/project.ts``. A setting ``a_b`` becomes the flag
#: ``--a-b`` of the command line.
OPTIONS: dict[str, str] = {}

__all__ = [
    "CLI_NAME",
    "OPTIONS",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
