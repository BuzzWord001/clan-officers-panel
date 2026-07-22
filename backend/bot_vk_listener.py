"""VK BotsLongPoll: ловит вход новых участников в офицерский чат → force repost.

vk_api.bot_longpoll синхронный (генератор) — крутим его в asyncio.to_thread и
дёргаем publisher.publish_force_repost из основного loop'а через
asyncio.run_coroutine_threadsafe.

Для группы должен быть включён Bots Long Poll в настройках сообщества +
event "chat_invite_user" (Действия в беседе) в группах настроек event'ов.
"""

import asyncio
import logging
import threading
import time
from typing import Any

import vk_api
from vk_api.bot_longpoll import VkBotLongPoll, VkBotEventType

import bot_vk
import officer_commands
import publisher
from config import settings

log = logging.getLogger("officers.bot.vk.listener")


def _vk_name(session, uid: int) -> str:
    """Читаемое имя автора VK (для колонки «Добавил»)."""
    try:
        r = session.method("users.get", {"user_ids": uid})
        if r:
            nm = ((r[0].get("first_name") or "") + " " + (r[0].get("last_name") or "")).strip()
            if nm:
                return nm
    except Exception:
        pass
    return "VK " + str(uid)


def _handle_command(session, raw: dict, target_peer: int) -> None:
    """Офицерская команда (/принять …) из VK-чата → выполнить и ответить."""
    msg = (raw.get("object") or {}).get("message") or {}
    text = (msg.get("text") or "").strip()
    if not text.startswith("/"):
        return
    if msg.get("peer_id") != target_peer:
        return
    from_id = msg.get("from_id") or 0
    if from_id <= 0:                       # сообщение от группы/бота — игнор
        return
    actor = {"platform": "vk", "id": str(from_id),
             "name": _vk_name(session, from_id), "ip": "", "user_agent": "vk-command"}
    try:
        reply = officer_commands.handle(text, actor)
    except Exception:
        log.exception("officer command crashed")
        reply = "⚠ Ошибка команды. Попробуй ещё раз или сделай на сайте."
    if reply:
        try:
            bot_vk.send_text(reply)
        except Exception:
            log.exception("VK command reply failed")

_REPOST_COOLDOWN_SEC = 60
_RECONNECT_BACKOFF_INITIAL = 2.0
_RECONNECT_BACKOFF_MAX = 60.0


def _group_id_from_token() -> int | None:
    """VK BotsLongPoll требует group_id. Достаём через groups.getById с токеном
    сообщества — он возвращает id сообщества к которому привязан токен."""
    try:
        session = vk_api.VkApi(token=settings.vk_group_token, api_version="5.199")
        api = session.get_api()
        resp = api.groups.getById()
        # API 5.199: groups.getById с нулевыми параметрами вернёт активное сообщество.
        if isinstance(resp, dict) and "groups" in resp:
            return int(resp["groups"][0]["id"])
        if isinstance(resp, list):
            return int(resp[0]["id"])
    except Exception as exc:
        log.warning("group_id lookup failed: %s", exc)
    return None


def _peer_id() -> int:
    raw = str(settings.vk_officer_peer_id).strip()
    pid = int(raw)
    return pid if pid >= 2_000_000_000 else 2_000_000_000 + pid


def _is_invite_event(event_type: Any, raw: dict) -> bool:
    """VK 5.x: invite-event приходит как message_new с action типа
    chat_invite_user / chat_invite_user_by_link / chat_invite_user_by_call.
    На старых API event типа CHAT_INVITE_USER приходил напрямую, но в API >=5.103
    единый message_new с action."""
    if event_type == VkBotEventType.MESSAGE_NEW:
        action = (raw.get("object", {}).get("message") or {}).get("action") or {}
        return action.get("type") in {
            "chat_invite_user",
            "chat_invite_user_by_link",
            "chat_invite_user_by_call",
        }
    # Резерв: старый формат для backward-compat если группа на 5.80
    name = getattr(event_type, "value", "") or str(event_type)
    return "invite" in name.lower()


def _event_peer_id(event_type: Any, raw: dict) -> int | None:
    if event_type == VkBotEventType.MESSAGE_NEW:
        msg = (raw.get("object") or {}).get("message") or {}
        return msg.get("peer_id")
    return (raw.get("object") or {}).get("peer_id")


def _blocking_loop(loop: asyncio.AbstractEventLoop, stop: threading.Event) -> None:
    """Главный sync-цикл — крутится в отдельном thread."""
    if not (settings.vk_group_token and settings.vk_officer_peer_id):
        log.warning("VK listener disabled: vk_group_token or vk_officer_peer_id missing")
        return

    target_peer = _peer_id()
    last_repost = 0.0
    backoff = _RECONNECT_BACKOFF_INITIAL

    while not stop.is_set():
        try:
            session = vk_api.VkApi(token=settings.vk_group_token, api_version="5.199")
            group_id = _group_id_from_token()
            if not group_id:
                log.error("VK listener: cannot determine group_id, retry in %ss", backoff)
                stop.wait(backoff)
                backoff = min(backoff * 2, _RECONNECT_BACKOFF_MAX)
                continue

            longpoll = VkBotLongPoll(session, group_id, wait=25)
            log.info("VK listener connected, group_id=%s peer=%s", group_id, target_peer)
            backoff = _RECONNECT_BACKOFF_INITIAL

            for event in longpoll.listen():
                if stop.is_set():
                    return
                raw = event.raw if hasattr(event, "raw") else {}
                etype = event.type
                # Офицерская команда приёма (/принять, /удалить, /список, /помощь)
                if etype == VkBotEventType.MESSAGE_NEW:
                    try:
                        _handle_command(session, raw, target_peer)
                    except Exception:
                        log.exception("VK command handling failed")
                if not _is_invite_event(etype, raw):
                    continue
                peer = _event_peer_id(etype, raw)
                if peer != target_peer:
                    continue
                # Раньше тут пересоздавали закреп со списком новичков для
                # нового участника. По требованию Лира список новых
                # пользователей больше не рендерим — в закрепе просто скрин
                # сайта, на join его не трогаем.
                log.info("VK invite event — repost disabled (pin is a static site shot)")

        except Exception as exc:
            log.warning("VK longpoll error: %s; reconnect in %ss", exc, backoff)
            stop.wait(backoff)
            backoff = min(backoff * 2, _RECONNECT_BACKOFF_MAX)


async def run() -> None:
    """Async-обёртка для запуска из lifespan. Крутит sync-цикл в thread,
    при cancel из lifespan корректно тушит."""
    if not (settings.vk_group_token and settings.vk_officer_peer_id):
        log.warning("VK listener disabled")
        return

    stop = threading.Event()
    loop = asyncio.get_running_loop()
    th = threading.Thread(target=_blocking_loop, args=(loop, stop), daemon=True)
    th.start()

    try:
        # Просыпаемся раз в секунду чтобы проверить cancel; долгие операции —
        # внутри thread'а на longpoll.listen().
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        log.info("VK listener stopping")
        stop.set()
        # Не блокируем долго основной loop — longpoll сам выйдет в течение wait=25 сек.
        raise
