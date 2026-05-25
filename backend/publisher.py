"""Оркестратор: рендер + публикация в TG + VK + сохранение message_id."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from html import escape

import auth_pwd
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


def _caption_password() -> str:
    """Берём из БД, чтобы смена через /settings.html сразу попадала в подпись."""
    return auth_pwd.officer_password_plain()


def _caption_tg() -> str:
    site = _site_url()
    pwd = _caption_password()
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
    pwd = _caption_password()
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


async def publish_now(*, force_repost: bool = False) -> dict:
    """Публикует/обновляет манифест в TG+VK офицерских чатах.

    force_repost=True — не редактирует существующий пост, а **пересоздаёт**:
    delete + send + pin. Нужно когда в чат заходит новый участник: edit
    оставит закреп на месте, но новички не увидят его в недавних сообщениях.
    """
    state = db.get_render_state()
    image = await asyncio.to_thread(renderer.render_png)
    result: dict = {}

    # При force_repost обнуляем prev_message_id, чтобы bot_tg/bot_vk сразу
    # пошли по ветке "sendPhoto + pin + delete old", минуя editMessageMedia.
    tg_prev = None if force_repost else state.get("tg_message_id")
    vk_prev = None if force_repost else state.get("vk_message_id")
    # Старые id для последующего delete после publish (только в force-режиме).
    tg_old_to_delete = state.get("tg_message_id") if force_repost else None
    vk_old_to_delete = state.get("vk_message_id") if force_repost else None

    if settings.tg_bot_token and settings.tg_officer_chat_id:
        try:
            new_tg = await bot_tg.publish_manifest(image, _caption_tg(), tg_prev)
            if tg_old_to_delete and tg_old_to_delete != new_tg:
                await bot_tg.delete_message_safe(tg_old_to_delete)
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
                bot_vk.publish_manifest, image, _caption_vk(), vk_prev,
            )
            if vk_old_to_delete and vk_old_to_delete != new_vk:
                await asyncio.to_thread(bot_vk.delete_message_safe, vk_old_to_delete)
            db.update_render_state(vk_message_id=new_vk)
            result["vk"] = new_vk
        except Exception as exc:
            log.exception("VK publish failed")
            result["vk_error"] = str(exc)
    else:
        result["vk_error"] = "vk_not_configured"

    now = datetime.utcnow().isoformat(timespec="seconds")
    db.update_render_state(dirty=0, last_render_at=now, last_publish_at=now)
    if force_repost:
        log.info("Force repost done: %s", {k: v for k, v in result.items() if "error" not in k})
    return result


async def publish_force_repost(reason: str = "") -> dict:
    """Shortcut: всегда новый пост в чат. Нужно при входе нового участника."""
    log.info("Force repost requested: %s", reason or "no reason")
    return await publish_now(force_repost=True)
