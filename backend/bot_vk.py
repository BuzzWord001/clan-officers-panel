"""VK: публикация и обновление закреплённого манифеста в офицерском чате.

Сообщество с правами админа в чате → отправляем photo через peer_id
(2000000000 + chat_id). messages.pin закрепляет, messages.edit с
вложением — обновляет существующее.
"""

import logging
from pathlib import Path

import vk_api
from vk_api.upload import VkUpload

from config import settings

log = logging.getLogger("officers.bot.vk")


def _api():
    if not settings.vk_group_token:
        raise RuntimeError("VK_GROUP_TOKEN not set")
    session = vk_api.VkApi(token=settings.vk_group_token, api_version="5.199")
    return session, session.get_api()


def _peer_id() -> int:
    raw = str(settings.vk_officer_peer_id).strip()
    if not raw:
        raise RuntimeError("VK_OFFICER_PEER_ID not set")
    pid = int(raw)
    # Удобство: разрешаем указывать chat_id (1..2e9) → автодополним до peer.
    if 0 < pid < 2_000_000_000:
        pid = 2_000_000_000 + pid
    return pid


def _upload_photo(session, image_path: Path, peer_id: int) -> str:
    upload = VkUpload(session)
    photo = upload.photo_messages(photos=str(image_path), peer_id=peer_id)[0]
    return f"photo{photo['owner_id']}_{photo['id']}"


def send_text(text: str) -> None:
    """Отправляет обычное текстовое сообщение в офицерский VK-чат (с разбивкой)."""
    if not (settings.vk_group_token and settings.vk_officer_peer_id):
        raise RuntimeError("vk_not_configured")
    session, api = _api()
    peer_id = _peer_id()
    for i in range(0, len(text), 4000):
        api.messages.send(peer_id=peer_id, message=text[i:i + 4000], random_id=0)


def delete_message_safe(cm_id: int) -> None:
    """Удаляет conversation_message в офицерском VK-чате, не падает если уже нет."""
    if not (settings.vk_group_token and settings.vk_officer_peer_id):
        return
    try:
        _, api = _api()
        api.messages.delete(peer_id=_peer_id(), cmids=cm_id, delete_for_all=1)
    except Exception as exc:
        log.info("VK delete %s skipped: %s", cm_id, exc)


def publish_manifest(image_path: Path, caption: str, prev_message_id: int | None) -> int:
    """Публикует/обновляет манифест в VK офицерском чате. Возвращает conversation_message_id."""
    session, api = _api()
    peer_id = _peer_id()
    attachment = _upload_photo(session, image_path, peer_id)

    if prev_message_id:
        try:
            api.messages.edit(
                peer_id=peer_id,
                conversation_message_id=prev_message_id,
                message=caption,
                attachment=attachment,
                keep_forward_messages=1,
                keep_snippets=1,
            )
            log.info("VK manifest edited (cm_id %s)", prev_message_id)
            return prev_message_id
        except vk_api.exceptions.ApiError as exc:
            log.warning("VK edit failed (%s), sending new", exc)

    sent = api.messages.send(
        peer_id=peer_id,
        message=caption,
        attachment=attachment,
        random_id=0,
    )
    # send в чат с пользователями вернёт message_id; для conversation_message_id
    # достаём из getById.
    info = api.messages.getById(message_ids=sent, extended=0)
    cm_id = info["items"][0]["conversation_message_id"]

    try:
        api.messages.pin(peer_id=peer_id, conversation_message_id=cm_id)
    except vk_api.exceptions.ApiError as exc:
        log.warning("VK pin failed: %s", exc)

    if prev_message_id and prev_message_id != cm_id:
        try:
            api.messages.delete(
                peer_id=peer_id,
                cmids=prev_message_id,
                delete_for_all=1,
            )
        except vk_api.exceptions.ApiError as exc:
            log.info("VK cleanup old %s skipped: %s", prev_message_id, exc)

    log.info("VK manifest posted (cm_id %s)", cm_id)
    return cm_id
