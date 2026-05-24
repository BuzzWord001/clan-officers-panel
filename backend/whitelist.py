"""Whitelist офицеров. Source-of-truth — JSON-файлы из clan-bridge-admin-bot.

tg_users.json: {"username": telegram_user_id, ...}
vk_users.json: {"имя фамилия": vk_user_id, ...}
"""

import json
import logging
from pathlib import Path

from config import settings

log = logging.getLogger("officers.whitelist")


def _load(path: str) -> dict[str, int]:
    p = Path(path)
    if not p.exists():
        log.warning("Whitelist file not found: %s", p)
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        log.error("Failed to read whitelist %s: %s", p, exc)
        return {}


def tg_whitelist() -> dict[str, int]:
    return _load(settings.whitelist_tg_path)


def vk_whitelist() -> dict[str, int]:
    return _load(settings.whitelist_vk_path)


def is_tg_allowed(user_id: int) -> bool:
    return user_id in set(tg_whitelist().values())


def is_vk_allowed(user_id: int) -> bool:
    return user_id in set(vk_whitelist().values())


def tg_name_for(user_id: int, fallback: str = "") -> str:
    for username, uid in tg_whitelist().items():
        if uid == user_id:
            return f"@{username}"
    return fallback or f"tg:{user_id}"


def vk_name_for(user_id: int, fallback: str = "") -> str:
    for name, uid in vk_whitelist().items():
        if uid == user_id:
            return name.title()
    return fallback or f"vk:{user_id}"
