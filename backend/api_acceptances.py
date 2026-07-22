"""CRUD для записей приёма игроков."""

import base64
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

import db
from config import settings
from schemas import AcceptanceIn, AcceptanceUpdate, AcceptanceOut, ArchiveIn
from session import current_actor, current_session


router = APIRouter(prefix="/acceptances", tags=["acceptances"])

# Скрины «Боевых Характеристик» — на томе рядом с БД (не в самой БД, чтобы список не пух).
_SHOT_DIR = Path(settings.db_path).parent / "acc_shots"
_SHOT_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def _save_shot(acc_id: int, data_url: str) -> bool:
    """Сохранить/удалить скрин боевых характеристик. Пустая строка → удалить. Возвращает has_shot."""
    _SHOT_DIR.mkdir(parents=True, exist_ok=True)
    for old in _SHOT_DIR.glob(f"{acc_id}.*"):
        try:
            old.unlink()
        except OSError:
            pass
    if not (data_url or "").strip():
        return False
    m = re.match(r"^data:(image/(?:png|jpeg|webp));base64,(.+)$", data_url, re.S)
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_image")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_base64")
    if len(raw) > 5_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_big")
    (_SHOT_DIR / f"{acc_id}.{_SHOT_EXT[m.group(1)]}").write_bytes(raw)
    return True


def _officer_only(s: dict) -> None:
    if s["role"] == "guest":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "officer_only")


def _admin_only(s: dict) -> None:
    if s.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin_only")


@router.get("/role-pending-default")
def role_pending_default_get(s: dict = Depends(current_session)) -> dict:
    """Состояние глобального тумблера «роль пока не выдана в игре» (для новых)."""
    _officer_only(s)
    return {"enabled": db.get_role_pending_default()}


@router.post("/role-pending-default")
def role_pending_default_set(payload: dict, s: dict = Depends(current_session)) -> dict:
    """Включить/выключить глобальный тумблер (только админ = Лир)."""
    _admin_only(s)
    on = bool(payload.get("enabled"))
    db.set_role_pending_default(on)
    return {"enabled": on}


@router.post("/role-pending-clear")
def role_pending_clear(s: dict = Depends(current_session)) -> dict:
    """Снять флаг «роль не выдана» со ВСЕХ (после копирования списка). Только админ."""
    _admin_only(s)
    return {"cleared": db.clear_role_pending_all()}


@router.get("", response_model=list[AcceptanceOut])
def list_all(s: dict = Depends(current_session)) -> list[dict]:
    # Реестр — только для офицеров/админа. Гостю (просмотр Доблести) нельзя.
    _officer_only(s)
    return db.list_acceptances()


@router.get("/archived", response_model=list[AcceptanceOut])
def list_archived(s: dict = Depends(current_session)) -> list[dict]:
    """Архив реестра — ушедшие/кикнутые (в т.ч. не попавшие в доблесть)."""
    _officer_only(s)
    return db.list_archived_acceptances()


@router.post("", response_model=AcceptanceOut, status_code=status.HTTP_201_CREATED)
def create(payload: AcceptanceIn, actor: dict = Depends(current_actor),
           s: dict = Depends(current_session)) -> dict:
    # ОФИЦЕР принимает → по умолчанию флаг «титул не выдан в игре» ВКЛ, чтобы человек
    # автоматически попал в список админа «кому выдать титулы в игре». Явное значение
    # (если фронт прислал) уважаем; для админа — как раньше (глобальный тумблер).
    rp = payload.role_pending
    if rp is None and s.get("role") == "officer":
        rp = True
    # Пометка «принят офицером» — всё, что добавил НЕ админ (Лир) через сайт.
    # Приём через чат-команды помечается by_officer=True на стороне officer_commands.
    res = db.create_acceptance(
        game_nick=payload.game_nick,
        title=payload.title,
        accepted_date=payload.accepted_date.isoformat(),
        note=payload.note,
        veteran=payload.veteran,
        elite=payload.elite,
        role_pending=rp,
        combat_power=payload.combat_power,
        survivability=payload.survivability,
        by_officer=(s.get("role") == "officer"),
        actor=actor,
    )
    if payload.combat_shot:
        has = _save_shot(res["id"], payload.combat_shot)
        db.acceptance_set_shot(res["id"], has)
        res["has_shot"] = has
    return res


@router.patch("/{acc_id}", response_model=AcceptanceOut)
def update(acc_id: int, payload: AcceptanceUpdate, actor: dict = Depends(current_actor)) -> dict:
    res = db.update_acceptance(
        acc_id,
        game_nick=payload.game_nick,
        title=payload.title,
        accepted_date=payload.accepted_date.isoformat() if payload.accepted_date else None,
        note=payload.note,
        veteran=payload.veteran,
        elite=payload.elite,
        role_pending=payload.role_pending,
        combat_power=payload.combat_power,
        survivability=payload.survivability,
        actor=actor,
    )
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if payload.combat_shot is not None:          # "" удалит, dataURL заменит
        has = _save_shot(acc_id, payload.combat_shot)
        db.acceptance_set_shot(acc_id, has)
        res["has_shot"] = has
    return res


@router.get("/{acc_id}/shot")
def get_shot(acc_id: int, s: dict = Depends(current_session)) -> FileResponse:
    """Скрин боевых характеристик записи приёма (офицер/админ)."""
    _officer_only(s)
    files = sorted(_SHOT_DIR.glob(f"{acc_id}.*")) if _SHOT_DIR.exists() else []
    if not files:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no_shot")
    return FileResponse(files[0], headers={"Cache-Control": "no-cache"})


@router.delete("/{acc_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove(acc_id: int, actor: dict = Depends(current_actor)) -> None:
    if not db.delete_acceptance(acc_id, actor=actor):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")


@router.post("/{acc_id}/archive", response_model=AcceptanceOut)
def archive(acc_id: int, payload: ArchiveIn, actor: dict = Depends(current_actor)) -> dict:
    """В архив: человек ушёл/кикнут (даже если не попал в таблицу доблести)."""
    res = db.set_acceptance_archived(acc_id, True, reason=payload.reason, actor=actor)
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res


@router.post("/{acc_id}/unarchive", response_model=AcceptanceOut)
def unarchive(acc_id: int, actor: dict = Depends(current_actor)) -> dict:
    """Вернуть из архива в активный реестр."""
    res = db.set_acceptance_archived(acc_id, False, reason="", actor=actor)
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res
