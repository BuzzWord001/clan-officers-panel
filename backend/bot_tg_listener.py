"""TG long polling: ловит вход новых участников в офицерский чат → force repost.

Сам себе offset сохраняет в /data, чтобы переживать рестарт без потери последних
апдейтов и без дублирующих срабатываний. Один процесс — один listener: TG не
любит параллельный getUpdates с одного токена (вернёт 409).
"""

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

import publisher
from config import settings

log = logging.getLogger("officers.bot.tg.listener")

_OFFSET_PATH = Path(os.environ.get("TG_OFFSET_PATH") or "/data/.tg_offset")
_LONG_POLL_TIMEOUT = 30  # сек — TG держит соединение до этого срока
_HTTP_TIMEOUT = _LONG_POLL_TIMEOUT + 10
_BASE = "https://api.telegram.org/bot{token}/{method}"
# Дебаунс на повторные join'ы за короткий промежуток (например, человек 5 раз
# вышел/зашёл подряд) — не делаем 5 постов, делаем один.
_REPOST_COOLDOWN_SEC = 60


def _read_offset() -> int:
    try:
        return int(_OFFSET_PATH.read_text(encoding="utf-8").strip() or "0")
    except (FileNotFoundError, ValueError):
        return 0


def _write_offset(offset: int) -> None:
    try:
        _OFFSET_PATH.parent.mkdir(parents=True, exist_ok=True)
        _OFFSET_PATH.write_text(str(offset), encoding="utf-8")
    except OSError as exc:
        log.warning("write offset failed: %s", exc)


def _is_target_chat(chat_id: Any) -> bool:
    """Сравниваем chat_id из апдейта с TG_OFFICER_CHAT_ID. Telegram возвращает
    int, мы храним строку — нормализуем перед сравнением."""
    return str(chat_id) == str(settings.tg_officer_chat_id).strip()


def _has_join_event(message: dict) -> bool:
    """new_chat_members — массив пользователей, попавших в чат.
    chat_join_request обработка тут не нужна: бот публикует в чате, не подтверждает заявки.
    """
    members = message.get("new_chat_members") or []
    if not members:
        return False
    # Исключим самого бота, чтобы он не reposted при добавлении себя.
    me_id = _bot_self_id()
    real = [m for m in members if m.get("id") != me_id]
    return bool(real)


_self_id_cache: int | None = None


def _bot_self_id() -> int | None:
    """Кэш user_id самого бота (получаем через getMe один раз)."""
    return _self_id_cache


async def _ensure_self_id(client: httpx.AsyncClient) -> None:
    global _self_id_cache
    if _self_id_cache is not None:
        return
    try:
        r = await client.post(_BASE.format(token=settings.tg_bot_token, method="getMe"))
        data = r.json()
        if data.get("ok"):
            _self_id_cache = int(data["result"]["id"])
            log.info("TG bot self id = %s", _self_id_cache)
    except Exception as exc:
        log.warning("getMe failed: %s", exc)


async def _get_updates(client: httpx.AsyncClient, offset: int) -> list[dict]:
    url = _BASE.format(token=settings.tg_bot_token, method="getUpdates")
    r = await client.post(
        url,
        json={
            "offset": offset,
            "timeout": _LONG_POLL_TIMEOUT,
            # Бот публикует и редактирует, ему нужны только сами updates с join'ами.
            # Подписываемся явно — иначе TG присылает всё и offset двигается лишний раз.
            "allowed_updates": ["message", "chat_member"],
        },
        timeout=_HTTP_TIMEOUT,
    )
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"getUpdates failed: {data}")
    return data["result"]


async def _drop_webhook(client: httpx.AsyncClient) -> None:
    """Если когда-то в прошлом был webhook — getUpdates будет валиться 409.
    deleteWebhook в начале безопасен даже если webhook'а нет."""
    try:
        await client.post(
            _BASE.format(token=settings.tg_bot_token, method="deleteWebhook"),
            json={"drop_pending_updates": False},
            timeout=10,
        )
    except Exception as exc:
        log.info("deleteWebhook: %s", exc)


async def run() -> None:
    """Главный цикл listener'а. Запускается из app.py lifespan.

    Никогда не падает наружу — при любой ошибке логирует и пересоздаёт цикл
    после backoff. Останавливается через asyncio.CancelledError из lifespan'а.
    """
    if not (settings.tg_bot_token and settings.tg_officer_chat_id):
        log.warning("TG listener disabled: tg_bot_token or tg_officer_chat_id missing")
        return

    last_repost = 0.0
    backoff = 1.0
    log.info("TG listener starting, offset=%s chat=%s",
             _read_offset(), settings.tg_officer_chat_id)

    async with httpx.AsyncClient() as client:
        await _drop_webhook(client)
        await _ensure_self_id(client)

        while True:
            offset = _read_offset()
            try:
                updates = await _get_updates(client, offset)
                backoff = 1.0  # сбрасываем после успеха
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("getUpdates error: %s; backoff %ss", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue

            if not updates:
                continue

            join_seen_in_batch = False
            for upd in updates:
                # двигаем offset на (update_id + 1) — TG не пришлёт его снова
                offset = max(offset, upd.get("update_id", 0) + 1)
                msg = upd.get("message") or {}
                chat = msg.get("chat") or {}
                if not _is_target_chat(chat.get("id")):
                    continue
                if _has_join_event(msg):
                    log.info("Join detected in officer chat (msg_id=%s)", msg.get("message_id"))
                    join_seen_in_batch = True

            _write_offset(offset)

            if join_seen_in_batch:
                # Раньше тут пересоздавали закреп со списком новичков, чтобы
                # новый участник увидел его в недавних. По требованию Лира
                # список новых пользователей больше не рендерим и закреп на
                # join не трогаем — в закрепе просто скрин сайта.
                log.info("Join detected — repost disabled (pin is a static site shot)")
