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
    reply_to_user: str = ""
    reply_to_text: str = ""
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


class DedupCheckIn(BaseModel):
    kind: str = Field(..., min_length=1, max_length=32)
    key: str  = Field(..., min_length=1, max_length=300)


class DedupRecordIn(BaseModel):
    kind: str = Field(..., min_length=1, max_length=32)
    key: str  = Field(..., min_length=1, max_length=300)
    r2_url: str
    r2_key: str
    mime: str = ""
    size: int = 0
    media_kind: str = ""
    width: int = 0
    height: int = 0


@router.post("/media/dedup-check")
def media_dedup_check(payload: DedupCheckIn,
                      _=Depends(require_bot_token)) -> dict:
    """Бот проверяет: не залит ли этот контент уже в R2.

    kind может быть:
      'tg_unique'   — TG file_unique_id (стабильный для одного контента)
      'vk_sticker'  — VK sticker_id (число как строка)
      'vk_doc'      — VK doc owner_id + doc_id (формат 'owner_doc')
      'sha256'      — SHA256 hex от bytes файла (универсальный fallback)
    """
    row = db.dedup_lookup(payload.kind, payload.key)
    if not row:
        return {"found": False}
    return {
        "found": True,
        "url":        row["r2_url"],
        "r2_key":     row["r2_key"],
        "mime":       row["mime"],
        "size":       row["size"],
        "media_kind": row["media_kind"],
        "width":      row["width"],
        "height":     row["height"],
    }


@router.post("/media/dedup-record")
def media_dedup_record(payload: DedupRecordIn,
                       _=Depends(require_bot_token)) -> dict:
    """Бот после успешной заливки сообщает: вот ключ → вот URL.
    При попадании на дубль (race condition) — bump hit_count."""
    res = db.dedup_record(
        kind=payload.kind, key=payload.key,
        r2_url=payload.r2_url, r2_key=payload.r2_key,
        mime=payload.mime, size=payload.size,
        media_kind=payload.media_kind,
        width=payload.width, height=payload.height,
    )
    return res


@router.get("/media/dedup-stats")
def media_dedup_stats(_: dict = Depends(require_officer)) -> dict:
    """Сводка для офицеров — сколько уникальных медиа, сколько сэкономлено."""
    return db.dedup_stats()


# ── BACKFILL endpoints ────────────────────────────────────────────────────

@router.get("/media/backfill-targets")
def media_backfill_targets(
    platform: str | None = Query(default=None, pattern="^(tg|vk)$"),
    chat_group: str | None = Query(default=None,
                                   pattern="^(general|officers)$"),
    limit: int = Query(default=200, ge=1, le=1000),
    before_id: int | None = Query(default=None),
    _=Depends(require_bot_token),
) -> dict:
    """Сообщения архива с медиа БЕЗ R2 URL — кандидаты для backfill.

    Курсор: before_id — id последнего сообщения предыдущей страницы.
    Сортировка id DESC (новые → старые), чтобы шагать пагинацией.
    """
    rows = db.list_backfill_targets(
        platform=platform, chat_group=chat_group,
        limit=limit, before_id=before_id,
    )
    next_before = rows[-1]["id"] if rows else None
    return {"items": rows, "next_before_id": next_before}


class BackfillUpdateIn(BaseModel):
    id: int
    media: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/media/backfill-update")
def media_backfill_update(payload: BackfillUpdateIn,
                          _=Depends(require_bot_token)) -> dict:
    """Перезаписать media_json одного сообщения после backfill.
    Бот после успешной заливки/dedup-hit'а сообщает новые объекты media."""
    ok = db.update_chat_message_media(payload.id, payload.media)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return {"updated": 1}


# ── MEDIA DOWNLOAD PROXY ──────────────────────────────────────────────────
# R2 dev URL не даёт CORS, поэтому fetch+blob с фронта не работает напрямую.
# Прокси из FastAPI: офицер → backend → R2 → офицер с Content-Disposition.
# Whitelist URL'ов: только наш R2 public domain, ничего другого.

import re as _re
from urllib.parse import urlparse, unquote
from fastapi.responses import StreamingResponse


_R2_DOMAIN_RE = _re.compile(
    r"^pub-[0-9a-f]+\.r2\.dev$|"
    r"^[0-9a-f]+\.r2\.cloudflarestorage\.com$",
    _re.IGNORECASE,
)


def _safe_filename(name: str, fallback: str = "file") -> str:
    """Безопасное имя для Content-Disposition. Убираем спецсимволы.
    Не позволяем path-traversal или новые строки."""
    name = (name or "").strip()
    if not name:
        name = fallback
    # Только буквы/цифры/основные знаки. Иные → подчёркивание.
    name = _re.sub(r"[\\/:*?\"<>|\r\n\x00-\x1f]", "_", name)
    return name[:200] or fallback


@router.get("/media/download")
def media_download(
    u: str = Query(..., description="R2 URL (наш public домен)"),
    name: str | None = Query(default=None, description="Имя файла для save-as"),
    _: dict = Depends(require_officer),
):
    """Проксирует скачивание R2 → клиенту с Content-Disposition: attachment.
    Без этого браузер при cross-origin fetch упирается в CORS и не может
    отдать blob; а `<a download>` с непрямым атрибутом всё равно открывает
    inline для image/video/audio mime."""
    # Проверка URL
    try:
        parsed = urlparse(u)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_url")
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_scheme")
    if not _R2_DOMAIN_RE.match(parsed.netloc or ""):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "domain_not_allowed")

    import requests as _req
    try:
        upstream = _req.get(u, stream=True, timeout=30)
    except Exception as e:
        log.warning("media proxy fail %s: %s", u[:80], e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_error")
    if upstream.status_code != 200:
        upstream.close()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            f"upstream_{upstream.status_code}")

    ctype = upstream.headers.get("Content-Type", "application/octet-stream")
    clen = upstream.headers.get("Content-Length")

    # Имя файла: query param > последний segment URL > "file"
    if not name:
        try:
            name = (parsed.path or "").rsplit("/", 1)[-1]
            name = unquote(name) or "file"
        except Exception:
            name = "file"
    safe = _safe_filename(name)

    def gen():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    headers = {
        "Content-Disposition": f'attachment; filename="{safe}"',
        "Cache-Control": "private, max-age=0, no-store",
    }
    if clen:
        headers["Content-Length"] = clen
    return StreamingResponse(gen(), media_type=ctype, headers=headers)


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


@router.get("/members/profile")
def members_profile(
    q: str = Query(..., min_length=1),
    _: dict = Depends(require_officer),
) -> dict:
    """Полный профиль участника клана по любому из его имён.

    Возвращает {found: bool, profile: {...}}. profile содержит
    game_nick, display_name, tg_*, vk_* поля если они есть в зеркале.
    """
    m = db.resolve_identity_full(q)
    if not m:
        return {"found": False, "profile": None}
    # Чистим служебные поля и пустые строки.
    skip = {"key", "raw_json", "synced_at"}
    profile = {k: v for k, v in m.items()
               if k not in skip and v not in (None, "", 0, "0")}
    return {"found": True, "profile": profile}


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
