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

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

import db
from api_chat import require_bot_token, require_officer, require_viewer
from session import require_admin, current_actor

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
def valor_current(s: dict = Depends(require_viewer)) -> dict:
    """Самый свежий снимок + все участники. Примечание из реестра (reg_note)
    добавляется только офицерам/админу — гость его не получает."""
    return db.valor_get_current(with_reg_notes=(s.get("role") != "guest"))


@router.get("/known-nicks")
def known_nicks(_=Depends(require_bot_token)) -> dict:
    """Список известных ников клана (снимки доблести + override + активный
    реестр/новенькие) — десктоп-сборщик шлёт его в Gemini как подсказку,
    чтобы правильно распознавать и писать ники."""
    return {"nicks": db.valor_known_nicks()}


# ── Архив скриншотов сбора (по неделям) ──
class ScreenshotsIn(BaseModel):
    week:  str
    shots: list[dict]   # [{idx, url, key}]


@router.post("/screenshots")
def valor_screenshots_save(payload: ScreenshotsIn,
                           _=Depends(require_bot_token)) -> dict:
    """Сохранить ссылки на скрины недели (заливает pw-valor-tracker в R2)."""
    return db.valor_screenshots_set(payload.week, payload.shots)


@router.get("/screenshots/weeks")
def valor_screenshot_weeks(_: dict = Depends(require_officer)) -> list[dict]:
    """Список недель со скринами (папки) — офицеру/админу."""
    return db.valor_screenshot_weeks()


@router.get("/screenshots")
def valor_screenshots_list(week: str = Query(..., min_length=1),
                           _: dict = Depends(require_officer)) -> dict:
    """Скрины конкретной недели — офицеру/админу."""
    return {"week": week, "shots": db.valor_screenshots_for(week)}


@router.get("/compare")
def valor_compare(week: str = Query(..., min_length=1),
                  _: dict = Depends(require_officer)) -> dict:
    """Сравнение скринов недели с распознанными данными (офицеру/админу)."""
    return db.valor_compare_data(week)


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
                      _: dict = Depends(require_officer),
                      actor: dict = Depends(current_actor)) -> dict:
    """Добавить предупреждение (офицер/админ). Пишется в журнал действий."""
    return db.valor_add_manual_warning(
        payload.nick, payload.severity, payload.reason, actor)


@router.delete("/warning")
def valor_warning_delete(id: int = Query(..., ge=1),
                         _: dict = Depends(require_officer),
                         actor: dict = Depends(current_actor)) -> dict:
    """Удалить предупреждение (офицер/админ). Пишется в журнал действий."""
    return {"ok": db.valor_remove_manual_warning(id, actor)}


class ValorAfkIn(BaseModel):
    is_afk:   bool
    afk_note: str | None = None


@router.post("/afk/{member_id}")
def valor_afk_set(member_id: int, payload: ValorAfkIn,
                  _: dict = Depends(require_officer),
                  actor: dict = Depends(current_actor)) -> dict:
    """Дать/снять статус АФК + комментарий (офицер/админ). Лог действий."""
    res = db.valor_set_afk(member_id, payload.is_afk, payload.afk_note, actor)
    if res is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member_not_found")
    return res


class ValorMemberEdit(BaseModel):
    """Админ-правка строки доблести. Любое подмножество полей."""
    nick:      str | None = None
    true_name: str | None = None
    rank:      str | None = None
    title:     str | None = None
    level:     int | None = None
    class_:    str | None = Field(default=None, alias="class")
    valor:     int | None = None
    is_afk:    bool | None = None
    afk_note:  str | None = None

    class Config:
        populate_by_name = True


@router.patch("/member/{member_id}")
def valor_member_edit(member_id: int, payload: ValorMemberEdit,
                      actor: dict = Depends(require_admin)) -> dict:
    """Редактирование строки доблести (написание ника и любые данные).
    ТОЛЬКО админ. Коррекция ника держится между неделями (override по canon)."""
    fields = payload.model_dump(by_alias=True, exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing_to_update")
    out = db.valor_update_member(member_id, fields, actor)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member_not_found")
    return out


# ── Веса (проценты) категорий ценности ───────────────────────────────────
class ValorWeightsIn(BaseModel):
    base:    float = Field(..., ge=0, le=100)
    streak:  float = Field(..., ge=0, le=100)
    officer: float = Field(..., ge=0, le=100)
    veteran: float = Field(..., ge=0, le=100)
    social:  float = Field(..., ge=0, le=100)


@router.get("/weights")
def valor_weights_get(_: dict = Depends(require_viewer)) -> dict:
    """Текущие веса категорий (видно всем — для пояснений; правка — админ)."""
    return db.get_valor_weights()


@router.put("/weights")
def valor_weights_set(payload: ValorWeightsIn,
                      actor: dict = Depends(require_admin)) -> dict:
    """Сохранить веса. Сумма не должна превышать 100% (проверяет и сервер)."""
    res = db.set_valor_weights(payload.model_dump(), actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            res.get("error", "invalid_weights"))
    return res


class MergeIn(BaseModel):
    source_canon: str = Field(..., min_length=1)
    target_nick:  str = Field(..., min_length=1)


class CanonIn(BaseModel):
    canon:  str = Field(..., min_length=1)
    reason: str | None = ""


@router.post("/merge")
def valor_merge_ep(payload: MergeIn, actor: dict = Depends(require_admin)) -> dict:
    """«Это он и есть»: слить неверно распознанного в существующего (admin)."""
    res = db.valor_merge(payload.source_canon, payload.target_nick, actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("reason", "merge_failed"))
    return res


@router.post("/archive")
def valor_archive_ep(payload: CanonIn, actor: dict = Depends(require_admin)) -> dict:
    """Ручной кик: убрать человека в архив доблести (admin)."""
    res = db.valor_archive_member(payload.canon, actor, payload.reason or "")
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "not_found"))
    return res


@router.post("/restore")
def valor_restore_ep(payload: CanonIn, actor: dict = Depends(require_admin)) -> dict:
    """Вернуть человека из архива в основной список (admin)."""
    return db.valor_restore(payload.canon, actor)


@router.delete("/member/{member_id}")
def valor_delete_ep(member_id: int, _: dict = Depends(require_admin)) -> dict:
    """Удалить ошибочную строку/фантом OCR из текущего снимка (admin)."""
    res = db.valor_delete_member(member_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "not_found"))
    return res


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
