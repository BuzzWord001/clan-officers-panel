"""Архив переписки клановых чатов: ingest от ботов + listing для офицеров.

Дедупликация:
    Bot-мост хранит точно ОДНУ копию каждого сообщения (оригинал). При
    ретрансляции в парный чат другой платформы он НЕ зовёт /ingest второй
    раз. На случай ретрая / двойного запуска бота — UNIQUE индекс
    (platform, chat_id, message_id) + INSERT OR IGNORE.

Авторизация:
    POST /chat/ingest — Bearer-токен из ARCHIVE_BOT_TOKEN env. Знает
        только бот-мост.
    GET /chat/list, /chat/stats — обычная офицерская/админская сессия
        (current_session — что используют все остальные endpoint'ы).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

import db
from config import settings
from session import current_session, require_admin


log = logging.getLogger("officers.chat")
router = APIRouter(prefix="/chat", tags=["chat-archive"])


# ===================== SCHEMAS =====================

class ChatMediaIn(BaseModel):
    kind: str  # 'photo' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'
    url: str = ""           # MVP: ссылка на TG/VK; Phase 2 — R2 URL
    file_id: str = ""       # TG file_id / VK attachment_id
    thumb_url: str = ""
    size: int = 0
    mime: str = ""
    name: str = ""
    width: int = 0
    height: int = 0
    duration: int = 0


class ChatIngestIn(BaseModel):
    chat_group: str = Field(..., pattern="^(general|officers)$")
    platform: str = Field(..., pattern="^(tg|vk)$")
    chat_id: str
    message_id: str
    user_id: str
    user_display: str
    user_username: str = ""
    text: str = ""
    reply_to_msg_id: str = ""
    reply_to_user: str = ""    # автор цитируемого
    reply_to_text: str = ""    # фрагмент текста цитируемого
    media: list[ChatMediaIn] = Field(default_factory=list)
    sent_at: str  # ISO datetime от платформы


class ChatMessageOut(BaseModel):
    id: int
    chat_group: str
    platform: str
    chat_id: str
    message_id: str
    user_id: str
    user_display: str
    user_username: str
    text: str
    reply_to_msg_id: str
    media: list[dict[str, Any]]
    sent_at: str
    ingested_at: str


# ===================== AUTH =====================

def require_bot_token(
    authorization: str | None = Header(default=None),
) -> None:
    """Bearer-токен из настроек. Сравниваем константно чтобы не светить
    длиной правильного значения через timing."""
    expected = (settings.archive_bot_token or "").strip()
    if not expected:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "archive_bot_token не настроен на сервере",
        )
    given = ""
    if authorization and authorization.lower().startswith("bearer "):
        given = authorization[7:].strip()
    # constant-time сравнение
    import hmac
    if not hmac.compare_digest(given, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_token")


def require_officer(session: dict = Depends(current_session)) -> dict:
    """Архив доступен и офицерам, и админу."""
    if session["role"] not in ("officer", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "officer_only")
    return session


# ===================== ENDPOINTS =====================

@router.post("/ingest", status_code=status.HTTP_201_CREATED)
def ingest(payload: ChatIngestIn, _=Depends(require_bot_token)) -> dict:
    res = db.ingest_chat_message(
        chat_group=payload.chat_group,
        platform=payload.platform,
        chat_id=payload.chat_id,
        message_id=payload.message_id,
        user_id=payload.user_id,
        user_display=payload.user_display,
        user_username=payload.user_username,
        text=payload.text,
        reply_to_msg_id=payload.reply_to_msg_id,
        reply_to_user=payload.reply_to_user,
        reply_to_text=payload.reply_to_text,
        media=[m.model_dump() for m in payload.media],
        sent_at=payload.sent_at,
    )
    if res["duplicate"]:
        log.debug("ingest dup: %s/%s/%s",
                  payload.platform, payload.chat_id, payload.message_id)
    return res


class ChatIngestBatch(BaseModel):
    messages: list[ChatIngestIn]


@router.post("/ingest-batch")
def ingest_batch(payload: ChatIngestBatch,
                 _=Depends(require_bot_token)) -> dict:
    """Батч-ингест для миграции исторического JSONL архива. Каждое
    сообщение проходит ту же UNIQUE-дедупликацию что и /ingest."""
    inserted = 0
    duplicates = 0
    errors: list[str] = []
    for i, m in enumerate(payload.messages):
        try:
            res = db.ingest_chat_message(
                chat_group=m.chat_group, platform=m.platform,
                chat_id=m.chat_id, message_id=m.message_id,
                user_id=m.user_id, user_display=m.user_display,
                user_username=m.user_username,
                text=m.text,
                reply_to_msg_id=m.reply_to_msg_id,
                reply_to_user=m.reply_to_user,
                reply_to_text=m.reply_to_text,
                media=[mm.model_dump() for mm in m.media],
                sent_at=m.sent_at,
            )
            if res["duplicate"]:
                duplicates += 1
            else:
                inserted += 1
        except Exception as e:
            errors.append(f"[{i}] {e}")
    return {
        "received": len(payload.messages),
        "inserted": inserted,
        "duplicates": duplicates,
        "errors": errors[:10],  # первые 10 для диагностики
    }


@router.get("/list", response_model=list[ChatMessageOut])
def list_msgs(
    chat_group: str | None = Query(default=None,
                                   pattern="^(general|officers)$"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    user: str | None = Query(default=None),
    search: str | None = Query(default=None),
    before_id: int | None = Query(default=None),
    after_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    _: dict = Depends(require_officer),
) -> list[dict]:
    return db.list_chat_messages(
        chat_group=chat_group,
        date_from=date_from,
        date_to=date_to,
        user=user,
        search=search,
        before_id=before_id,
        after_id=after_id,
        limit=limit,
    )


@router.get("/stats")
def stats(_: dict = Depends(require_officer)) -> dict:
    return db.chat_archive_stats()


@router.get("/groups")
def groups(_: dict = Depends(require_officer)) -> list[dict]:
    """Список групп с человекочитаемыми лейблами."""
    return [
        {"id": "general", "label": "Общий чат"},
        {"id": "officers", "label": "Офицерский чат"},
    ]


@router.delete("/messages/{msg_id}")
def delete_message(msg_id: int, admin: dict = Depends(require_admin)) -> dict:
    """Удалить одно сообщение из архива. Только админ."""
    if not db.delete_chat_message(msg_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    log.info("chat archive: msg id=%s удалён админом %s",
             msg_id, admin.get("name"))
    return {"deleted": 1}


class MembersBulkSync(BaseModel):
    members: list[dict]


@router.post("/members/bulk-sync")
def members_bulk_sync(payload: MembersBulkSync,
                      _=Depends(require_bot_token)) -> dict:
    """Полная синхронизация зеркала clan_members.json из clan-reg-bot.
    Затирает существующее зеркало целиком и пишет новое. Используется
    для identity-расширения в умном поиске архива."""
    res = db.bulk_sync_clan_members(payload.members)
    log.info("clan_members bulk sync: %d members", res["synced"])
    return res


@router.get("/members/identity")
def members_identity(
    q: str = Query(..., min_length=1),
    _: dict = Depends(require_officer),
) -> dict:
    """Резолв одного имени → все известные варианты (для UI-подсказки)."""
    variants = db.resolve_identity(q)
    return {"query": q, "variants": variants, "matched": bool(variants)}


@router.delete("/messages")
def clear_archive(
    confirm: str = Query(default="", description="Должно быть 'yes'"),
    admin: dict = Depends(require_admin),
) -> dict:
    """Полная очистка архива. Только админ + явный confirm=yes."""
    if confirm != "yes":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "confirm=yes обязателен для очистки всего архива",
        )
    n = db.clear_chat_archive()
    log.warning("chat archive: ПОЛНАЯ ОЧИСТКА (%d сообщений) "
                "выполнена админом %s", n, admin.get("name"))
    return {"deleted": n}
