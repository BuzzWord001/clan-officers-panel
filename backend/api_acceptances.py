"""CRUD для записей приёма игроков."""

from fastapi import APIRouter, Depends, HTTPException, status

import db
from schemas import AcceptanceIn, AcceptanceUpdate, AcceptanceOut, ArchiveIn
from session import current_actor, current_session


router = APIRouter(prefix="/acceptances", tags=["acceptances"])


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
def create(payload: AcceptanceIn, actor: dict = Depends(current_actor)) -> dict:
    return db.create_acceptance(
        game_nick=payload.game_nick,
        title=payload.title,
        accepted_date=payload.accepted_date.isoformat(),
        note=payload.note,
        veteran=payload.veteran,
        elite=payload.elite,
        role_pending=payload.role_pending,
        actor=actor,
    )


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
        actor=actor,
    )
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res


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
