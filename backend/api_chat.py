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
from session import current_session


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
        media=[m.model_dump() for m in payload.media],
        sent_at=payload.sent_at,
    )
    if res["duplicate"]:
        log.debug("ingest dup: %s/%s/%s",
                  payload.platform, payload.chat_id, payload.message_id)
    return res


@router.get("/list", response_model=list[ChatMessageOut])
def list_msgs(
    chat_group: str | None = Query(default=None,
                                   pattern="^(general|officers)$"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    user: str | None = Query(default=None),
    search: str | None = Query(default=None),
    before_id: int | None = Query(default=None),
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
