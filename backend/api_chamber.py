"""«Тайная комната» → «Курсы волшебства» — трекер обучения (ТОЛЬКО админ).

Все эндпоинты под require_admin: раздел виден всем (дверь), но входит и
управляет прогрессом только администратор.

GET   /chamber/courses    — курсы + прогресс + расчётная статистика
POST  /chamber/progress   — установить абсолютный прогресс курса {watched_sec?, completed?}
POST  /chamber/watch      — инкремент просмотра {course_id, delta_sec} (heartbeat плеера)
PUT   /chamber/settings   — дневная норма часов / дата старта
POST  /chamber/reset      — сброс прогресса (course_id или всё)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

import db
from session import require_admin

log = logging.getLogger("api.chamber")
router = APIRouter(prefix="/chamber", tags=["chamber"])


class ProgressIn(BaseModel):
    course_id: str
    watched_sec: int | None = None
    completed: bool | None = None


class WatchIn(BaseModel):
    course_id: str
    delta_sec: int


class SettingsIn(BaseModel):
    daily_target_h: float | None = None
    start_date: str | None = None


class ResetIn(BaseModel):
    course_id: str | None = None


@router.get("/courses")
def get_courses(_: dict = Depends(require_admin)) -> dict:
    return db.magic_get_state()


@router.post("/progress")
def set_progress(body: ProgressIn, _: dict = Depends(require_admin)) -> dict:
    if body.watched_sec is None and body.completed is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "нужно watched_sec или completed")
    db.magic_set_progress(body.course_id, watched_sec=body.watched_sec,
                          completed=body.completed)
    return db.magic_get_state()


@router.post("/watch")
def add_watch(body: WatchIn, _: dict = Depends(require_admin)) -> dict:
    if body.delta_sec <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "delta_sec должен быть > 0")
    db.magic_add_watch(body.course_id, body.delta_sec)
    return {"ok": True}


@router.put("/settings")
def set_settings(body: SettingsIn, _: dict = Depends(require_admin)) -> dict:
    db.magic_set_settings(daily_target_h=body.daily_target_h,
                          start_date=body.start_date)
    return db.magic_get_state()


@router.post("/reset")
def reset(body: ResetIn, _: dict = Depends(require_admin)) -> dict:
    db.magic_reset(body.course_id)
    return db.magic_get_state()
