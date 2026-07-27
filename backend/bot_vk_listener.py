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


def _process_message(session, m: dict, target_peer: int) -> None:
    """Одно сообщение офиц.чата (из messages.getHistory) → если это команда, выполнить и ответить."""
    text = (m.get("text") or "").strip()
    if not text.startswith("/"):
        return
    from_id = m.get("from_id") or 0
    if from_id <= 0:                       # сообщение сообщества/бота — игнор
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

# Маркер последнего обработанного сообщения офиц.чата (conversation_message_id) на томе —
# чтобы после рестарта продолжить с того же места (как TG offset) и не переиграть старое.
_CMID_FILE = "/data/vk_officer_last_cmid.txt"


def _load_last_cmid():
    try:
        with open(_CMID_FILE, encoding="utf-8") as f:
            return int(f.read().strip() or "0")
    except Exception:
        return None                        # None → первый запуск (стартуем с текущего максимума)


def _save_last_cmid(cmid):
    try:
        with open(_CMID_FILE, "w", encoding="utf-8") as f:
            f.write(str(int(cmid)))
    except Exception:
        pass


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
    """Опрос истории офицерского VK-чата (messages.getHistory) и выполнение команд.
    НЕ используем Bot Long Poll: его на этом сообществе уже держит clan-reg-bot, а два
    Long Poll на одну группу КОНКУРИРУЮТ за события — officers-panel терял часть команд
    (в TG такого нет: у ботов разные токены + offset переигрывает). getHistory + маркер
    cmid — независимый источник, и переигрывает пропущенное при рестарте (как TG offset)."""
    if not (settings.vk_group_token and settings.vk_officer_peer_id):
        log.warning("VK listener disabled: vk_group_token or vk_officer_peer_id missing")
        return

    target_peer = _peer_id()
    session = vk_api.VkApi(token=settings.vk_group_token, api_version="5.199")
    api = session.get_api()

    last_cmid = _load_last_cmid()
    if last_cmid is None:                       # первый запуск — стартуем с текущего максимума
        try:
            h0 = api.messages.getHistory(peer_id=target_peer, count=1)
            its = h0.get("items") or []
            last_cmid = (its[0].get("conversation_message_id") or 0) if its else 0
        except Exception as e:
            log.warning("VK poller init getHistory failed: %s", e)
            last_cmid = 0
        _save_last_cmid(last_cmid)
    log.info("VK officer poller started, peer=%s, from cmid=%s", target_peer, last_cmid)

    backoff = _RECONNECT_BACKOFF_INITIAL
    while not stop.is_set():
        try:
            h = api.messages.getHistory(peer_id=target_peer, count=30)
            items = h.get("items") or []
            new = sorted(
                [m for m in items if (m.get("conversation_message_id") or 0) > last_cmid],
                key=lambda m: m.get("conversation_message_id") or 0)
            for m in new:
                cmid = m.get("conversation_message_id") or 0
                try:
                    _process_message(session, m, target_peer)
                finally:
                    if cmid > last_cmid:
                        last_cmid = cmid
                        _save_last_cmid(last_cmid)
            backoff = _RECONNECT_BACKOFF_INITIAL
        except Exception as exc:
            log.warning("VK poller error: %s; retry in %ss", exc, backoff)
            stop.wait(backoff)
            backoff = min(backoff * 2, _RECONNECT_BACKOFF_MAX)
            continue
        stop.wait(3)                            # опрос офиц.чата каждые 3с (низкочастотный)


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
