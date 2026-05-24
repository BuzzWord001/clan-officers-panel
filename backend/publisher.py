"""Оркестратор: рендер + публикация в TG + VK + сохранение message_id."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from html import escape

import bot_tg
import bot_vk
import db
import renderer
from config import settings

log = logging.getLogger("officers.publish")


def _now_msk() -> str:
    return datetime.now(timezone(timedelta(hours=3))).strftime("%d.%m.%Y %H:%M")


def _site_url() -> str:
    return settings.frontend_url.rstrip("/")


def _caption_tg() -> str:
    site = _site_url()
    pwd = settings.caption_officer_password
    parts = [
        "<b>SanTDeviL — Реестр приёма в клан</b>",
        "",
        "Здесь публикуется актуальный список новичков, принятых в клан, с датой приёма и оставшимся сроком 7-дневного иммунитета.",
        "Внести нового, отредактировать или удалить запись — на сайте:",
        f'<a href="{escape(site)}">{escape(site)}</a>',
    ]
    if pwd:
        parts += ["", f"Общий пароль офицеров: <code>{escape(pwd)}</code>"]
    parts += ["", f"<i>Обновлено: {_now_msk()} мск</i>"]
    return "\n".join(parts)


def _caption_vk() -> str:
    site = _site_url()
    pwd = settings.caption_officer_password
    parts = [
        "SanTDeviL — Реестр приёма в клан",
        "",
        "Здесь публикуется актуальный список новичков, принятых в клан, с датой приёма и оставшимся сроком 7-дневного иммунитета.",
        "Внести нового, отредактировать или удалить запись — на сайте:",
        site,
    ]
    if pwd:
        parts += ["", f"Общий пароль офицеров: {pwd}"]
    parts += ["", f"Обновлено: {_now_msk()} мск"]
    return "\n".join(parts)


async def publish_now() -> dict:
    state = db.get_render_state()
    image = await asyncio.to_thread(renderer.render_png)
    result: dict = {}

    if settings.tg_bot_token and settings.tg_officer_chat_id:
        try:
            new_tg = await bot_tg.publish_manifest(
                image,
                _caption_tg(),
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
                _caption_vk(),
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
