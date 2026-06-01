"""Endpoint'ы для pw-valor-tracker.

POST /valor/snapshot — приём недельного снимка от десктоп-приложения
                       (auth: bot-token, тот же что у clan-bridge-bot и
                       clan-reg-bot)
GET  /valor/current  — самый свежий снимок (для UI «Доблесть»)
GET  /valor/sessions — список всех снимков (для «Архив доблести»)
GET  /valor/history  — история по нику (rank/title/level/class)
GET  /valor/timeline — timeline доблести по неделям (тренды)
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

import db
from api_chat import require_bot_token, require_officer, require_viewer

log = logging.getLogger("api.valor")
router = APIRouter(prefix="/valor", tags=["valor"])


# ── Pydantic ────────────────────────────────────────────────────────────
class ValorMemberIn(BaseModel):
    nick:             str
    true_name:        str | None = ""
    rank:             str | None = ""
    title:            str | None = ""
    level:            int | None = None
    class_:           str | None = Field(default="", alias="class")
    valor:            int | None = None
    is_afk:           bool | None = False
    norm_met:         bool | None = None
    flag_new_nick:    bool | None = False
    flag_ocr_suspect: bool | None = False

    class Config:
        populate_by_name = True


class ValorSnapshotIn(BaseModel):
    week:          str   # 2026-W22
    valor_norm:    int
    screens_count: int = 0
    notes:         str = ""
    members:       list[ValorMemberIn]


# ── Endpoints ───────────────────────────────────────────────────────────
@router.post("/snapshot")
def valor_snapshot(payload: ValorSnapshotIn,
                   _=Depends(require_bot_token)) -> dict:
    """Сохраняет недельный снапшот. Если на эту неделю уже был — REPLACE.
    История полей (rank/title/level/class) дописывается только при смене
    значения относительно предыдущего снимка.
    """
    members = []
    for m in payload.members:
        d = m.model_dump(by_alias=False)
        # FastAPI кладёт class_ как ключ — db.py его так и хочет.
        members.append(d)
    res = db.valor_save_snapshot(
        week=payload.week,
        valor_norm=payload.valor_norm,
        members=members,
        screens_count=payload.screens_count,
        notes=payload.notes,
    )
    log.info("valor snapshot saved: week=%s members=%d history_added=%d",
             payload.week, res["members"], res["history_added"])
    return res


@router.get("/current")
def valor_current(_: dict = Depends(require_viewer)) -> dict:
    """Самый свежий снимок + все участники."""
    return db.valor_get_current()


@router.get("/sessions")
def valor_sessions(_: dict = Depends(require_officer)) -> list[dict]:
    """Все снапшоты — для «Архив доблести»."""
    return db.valor_list_sessions()


@router.get("/departed")
def valor_departed(_: dict = Depends(require_viewer)) -> list[dict]:
    """Ушедшие из клана с последними известными данными."""
    return db.valor_get_departed()


@router.get("/by-canon")
def valor_by_canon(weeks: int = Query(default=0, ge=0, le=52),
                   _: dict = Depends(require_officer)) -> dict:
    """Map canon_nick → доблесть для совмещения с chat-активностью.
    weeks=0 — по всем неделям. >0 — последние N недель."""
    return db.valor_by_canon_map(weeks=weeks)


class TagsBulkIn(BaseModel):
    tag:    str = Field(..., min_length=1, max_length=32)
    nicks:  list[str]
    source: str = "manual"


class TagOne(BaseModel):
    nick: str
    tag:  str


@router.post("/tags/bulk")
def valor_tags_bulk(payload: TagsBulkIn,
                    _=Depends(require_bot_token)) -> dict:
    """Помечает множество ников одним тегом. Используется для разового
    заливки «ветеранов» из clan-checklist. Auth — bot-token (тот же
    что у других ботов клана)."""
    return db.valor_add_tags(payload.tag, payload.nicks, payload.source)


@router.post("/tags")
def valor_tag_one(payload: TagOne,
                  _: dict = Depends(require_officer)) -> dict:
    """Добавить один тег одному нику."""
    return db.valor_add_tags(payload.tag, [payload.nick], source="manual")


@router.delete("/tags")
def valor_tag_delete(nick: str = Query(..., min_length=1),
                     tag: str = Query(..., min_length=1),
                     _: dict = Depends(require_officer)) -> dict:
    """Удалить тег с ника."""
    ok = db.valor_remove_tag(nick, tag)
    return {"ok": ok}


class ManualWarnIn(BaseModel):
    nick:     str
    severity: str = "mid"   # ok|mid|low|bad|crit
    reason:   str = ""


@router.post("/warning")
def valor_warning_add(payload: ManualWarnIn,
                      who: dict = Depends(require_officer)) -> dict:
    """Добавить ручное предупреждение нику (любой строгости)."""
    by = who.get("name") or who.get("nick") or who.get("role") or ""
    return db.valor_add_manual_warning(
        payload.nick, payload.severity, payload.reason, by)


@router.delete("/warning")
def valor_warning_delete(id: int = Query(..., ge=1),
                         _: dict = Depends(require_officer)) -> dict:
    """Удалить ручное предупреждение по id."""
    return {"ok": db.valor_remove_manual_warning(id)}


@router.get("/history")
def valor_history(nick: str = Query(..., min_length=1),
                  field: str | None = Query(default=None,
                                             pattern="^(rank|title|level|class|valor)$"),
                  _: dict = Depends(require_viewer)) -> dict:
    """История изменений полей для одного ника. Если field=None — все
    отслеживаемые поля."""
    return db.valor_get_history(nick, field)


@router.get("/timeline")
def valor_timeline(weeks: int = Query(default=12, ge=1, le=52),
                   _: dict = Depends(require_viewer)) -> dict:
    """Timeline доблести за последние N недель."""
    return db.valor_timeline(weeks=weeks)
