"""Telegram: публикация и обновление закреплённого манифеста.

Стратегия: храним tg_message_id в render_state. На обновлении пытаемся
editMessageMedia; если не вышло (старое сообщение удалили или ему 48ч+) —
шлём новое, закрепляем, разлюбленное предыдущее удаляем.
"""

import logging
from pathlib import Path

import httpx

from config import settings

log = logging.getLogger("officers.bot.tg")

_BASE = "https://api.telegram.org/bot{token}/{method}"


async def _call(method: str, **kwargs) -> dict:
    url = _BASE.format(token=settings.tg_bot_token, method=method)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json=kwargs)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"telegram.{method} failed: {data}")
    return data["result"]


async def _send_photo(image_path: Path, caption: str) -> int:
    url = _BASE.format(token=settings.tg_bot_token, method="sendPhoto")
    async with httpx.AsyncClient(timeout=60.0) as client:
        with open(image_path, "rb") as f:
            r = await client.post(
                url,
                data={
                    "chat_id": settings.tg_officer_chat_id,
                    "caption": caption,
                    "parse_mode": "HTML",
                },
                files={"photo": ("manifest.png", f, "image/png")},
            )
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"telegram.sendPhoto failed: {data}")
    return int(data["result"]["message_id"])


async def _edit_photo(message_id: int, image_path: Path, caption: str) -> bool:
    url = _BASE.format(token=settings.tg_bot_token, method="editMessageMedia")
    media = {
        "type": "photo",
        "media": "attach://photo",
        "caption": caption,
        "parse_mode": "HTML",
    }
    import json as _json
    async with httpx.AsyncClient(timeout=60.0) as client:
        with open(image_path, "rb") as f:
            r = await client.post(
                url,
                data={
                    "chat_id": settings.tg_officer_chat_id,
                    "message_id": message_id,
                    "media": _json.dumps(media),
                },
                files={"photo": ("manifest.png", f, "image/png")},
            )
    data = r.json()
    return bool(data.get("ok"))


def _chunks(text: str, size: int = 4000):
    for i in range(0, len(text), size):
        yield text[i:i + size]


async def send_text(text: str, token: str = "", chat_id: str = "") -> None:
    """Отправляет текст в TG-чат (по умолчанию офицерский; можно задать свой токен/чат
    — например пробный @pw_spamer_bot в личку). С разбивкой на части."""
    token = token or settings.tg_bot_token
    chat_id = chat_id or settings.tg_officer_chat_id
    if not (token and chat_id):
        raise RuntimeError("tg_not_configured")
    for chunk in _chunks(text):
        url = _BASE.format(token=token, method="sendMessage")
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(url, json={"chat_id": chat_id, "text": chunk,
                                             "disable_web_page_preview": True})
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError("telegram.sendMessage failed: %s" % data)


async def delete_message_safe(message_id: int) -> None:
    """Удаляет сообщение в офицерском TG-чате, не падает если уже нет."""
    if not (settings.tg_bot_token and settings.tg_officer_chat_id):
        return
    try:
        await _call("deleteMessage",
                    chat_id=settings.tg_officer_chat_id,
                    message_id=message_id)
    except Exception as exc:
        log.info("TG delete %s skipped: %s", message_id, exc)


async def publish_manifest(image_path: Path, caption: str, prev_message_id: int | None) -> int:
    """Публикация/обновление закрепа. Возвращает актуальный message_id."""
    if not (settings.tg_bot_token and settings.tg_officer_chat_id):
        raise RuntimeError("tg_bot not configured (token + chat_id)")

    if prev_message_id:
        try:
            if await _edit_photo(prev_message_id, image_path, caption):
                log.info("TG manifest updated in place (msg %s)", prev_message_id)
                return prev_message_id
            log.warning("TG editMessageMedia returned not ok, sending new")
        except Exception as exc:
            log.warning("TG edit failed (%s), sending new", exc)

    new_id = await _send_photo(image_path, caption)
    try:
        await _call("pinChatMessage",
                    chat_id=settings.tg_officer_chat_id,
                    message_id=new_id,
                    disable_notification=True)
    except Exception as exc:
        log.warning("TG pin failed: %s", exc)

    if prev_message_id and prev_message_id != new_id:
        try:
            await _call("deleteMessage",
                        chat_id=settings.tg_officer_chat_id,
                        message_id=prev_message_id)
        except Exception as exc:
            log.info("TG cleanup old %s skipped: %s", prev_message_id, exc)

    log.info("TG manifest posted (msg %s)", new_id)
    return new_id
