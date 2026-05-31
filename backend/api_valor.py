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
from api_chat import require_bot_token, require_officer

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
def valor_current(_: dict = Depends(require_officer)) -> dict:
    """Самый свежий снимок + все участники."""
    return db.valor_get_current()


@router.get("/sessions")
def valor_sessions(_: dict = Depends(require_officer)) -> list[dict]:
    """Все снапшоты — для «Архив доблести»."""
    return db.valor_list_sessions()


@router.get("/departed")
def valor_departed(_: dict = Depends(require_officer)) -> list[dict]:
    """Ушедшие из клана с последними известными данными."""
    return db.valor_get_departed()


@router.get("/history")
def valor_history(nick: str = Query(..., min_length=1),
                  field: str | None = Query(default=None,
                                             pattern="^(rank|title|level|class)$"),
                  _: dict = Depends(require_officer)) -> dict:
    """История изменений полей для одного ника. Если field=None — все
    отслеживаемые поля."""
    return db.valor_get_history(nick, field)


@router.get("/timeline")
def valor_timeline(weeks: int = Query(default=12, ge=1, le=52),
                   _: dict = Depends(require_officer)) -> dict:
    """Timeline доблести за последние N недель."""
    return db.valor_timeline(weeks=weeks)
