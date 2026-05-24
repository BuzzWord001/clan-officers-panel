"""Оркестратор: рендер + публикация в TG + VK + сохранение message_id.

Запускается из шедулера или вручную через /admin/republish.
"""

import asyncio
import logging
from datetime import datetime
from html import escape

import bot_tg
import bot_vk
import db
import renderer
from config import settings

log = logging.getLogger("officers.publish")


def _caption() -> str:
    rows = db.list_acceptances()
    today_iso = datetime.now().strftime("%d.%m.%Y %H:%M")
    site = settings.frontend_url
    return (
        f"<b>SanTDeviL // OFFICER MANIFEST</b>\n"
        f"Принятых в клан: <b>{len(rows)}</b>\n"
        f"Обновлено: {today_iso} (мск)\n\n"
        f"Внести изменения: {escape(site)}"
    )


async def publish_now() -> dict:
    state = db.get_render_state()
    image = await asyncio.to_thread(renderer.render_png)
    caption = _caption()
    result: dict = {}

    if settings.tg_bot_token and settings.tg_officer_chat_id:
        try:
            new_tg = await bot_tg.publish_manifest(
                image,
                caption,
                state.get("tg_message_id"),
            )
            db.update_render_state(tg_message_id=new_tg)
            result["tg"] = new_tg
        except Exception as exc:
            log.exception("TG publish failed")
            result["tg_error"] = str(exc)
    else:
        result["tg_error"] = "tg_not_configured"

    if settings.vk_group_token and settings.vk_officer_peer_id:
        try:
            new_vk = await asyncio.to_thread(
                bot_vk.publish_manifest,
                image,
                caption,
                state.get("vk_message_id"),
            )
            db.update_render_state(vk_message_id=new_vk)
            result["vk"] = new_vk
        except Exception as exc:
            log.exception("VK publish failed")
            result["vk_error"] = str(exc)
    else:
        result["vk_error"] = "vk_not_configured"

    now = datetime.utcnow().isoformat(timespec="seconds")
    db.update_render_state(dirty=0, last_render_at=now, last_publish_at=now)
    return result
