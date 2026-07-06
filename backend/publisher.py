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
        "<b>SanTDeviL — клановый сайт</b>",
        "",
        "Доблесть участников, реестр приёма, архивы чатов и история клана — всё на сайте:",
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
        "SanTDeviL — клановый сайт",
        "",
        "Доблесть участников, реестр приёма, архивы чатов и история клана — всё на сайте:",
        site,
    ]
    if pwd:
        parts += ["", f"Общий пароль офицеров: {pwd}"]
    parts += ["", f"Обновлено: {_now_msk()} мск"]
    return "\n".join(parts)


async def publish_now(*, force_repost: bool = False,
                      platforms: tuple[str, ...] | None = None) -> dict:
    """Публикует/обновляет манифест в TG+VK офицерских чатах.

    force_repost=True — не редактирует существующий пост, а **пересоздаёт**:
    delete + send + pin. Нужно когда в чат заходит новый участник: edit
    оставит закреп на месте, но новички не увидят его в недавних сообщениях.

    platforms=None — обе площадки (так работает scheduler и republish после
    смены пароля). Передай ("tg",) или ("vk",) чтобы тронуть только одну —
    например когда listener видит join только в одной площадке, не нужно
    спамить вторую.
    """
    # ОТКЛЮЧЕНО (Лир, 2026-07): офицерский манифест-закреп (сайт + общий пароль)
    # больше не нужен. Теперь во ВСЕ каналы публикуется только еженедельная
    # таблица доблести — по кнопке «Готово» (weekly_top.py), отдельный механизм.
    # Ничего не постим/не пиним и не редактируем закреп. Сбрасываем dirty, чтобы
    # планировщик не крутил публикацию впустую каждую минуту.
    db.update_render_state(
        dirty=0, last_render_at=datetime.utcnow().isoformat(timespec="seconds"))
    log.info("officer manifest publishing DISABLED — skip (force_repost=%s, platforms=%s)",
             force_repost, platforms)
    return {"disabled": True}

    targets = set(platforms) if platforms else {"tg", "vk"}
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

    if "tg" in targets:
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

    if "vk" in targets:
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
    # При полной публикации сбрасываем dirty; при частичной (только одна
    # площадка) — НЕ сбрасываем, чтобы scheduler позже всё-таки прокатил
    # вторую площадку, если она dirty по обычным правкам.
    if not platforms:
        db.update_render_state(dirty=0, last_render_at=now, last_publish_at=now)
    else:
        db.update_render_state(last_render_at=now, last_publish_at=now)

    if force_repost:
        log.info("Force repost (platforms=%s) done: %s",
                 sorted(targets), {k: v for k, v in result.items() if "error" not in k})
    return result


async def publish_force_repost(platform: str, reason: str = "") -> dict:
    """Принудительно пересоздаёт закреп в одной площадке (по-новой sendPhoto+pin).

    platform: "tg" или "vk". Передаём строго одну — listener знает откуда
    пришёл join, нет смысла трогать вторую и плодить лишние посты.
    """
    if platform not in {"tg", "vk"}:
        raise ValueError(f"unsupported platform: {platform!r}")
    log.info("Force repost requested for %s: %s", platform, reason or "no reason")
    return await publish_now(force_repost=True, platforms=(platform,))
