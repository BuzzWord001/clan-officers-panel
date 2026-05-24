"""CRUD для записей приёма игроков."""

from fastapi import APIRouter, Depends, HTTPException, status

import db
from schemas import AcceptanceIn, AcceptanceUpdate, AcceptanceOut
from session import current_actor


router = APIRouter(prefix="/acceptances", tags=["acceptances"])


@router.get("", response_model=list[AcceptanceOut])
def list_all() -> list[dict]:
    return db.list_acceptances()


@router.post("", response_model=AcceptanceOut, status_code=status.HTTP_201_CREATED)
def create(payload: AcceptanceIn, actor: dict = Depends(current_actor)) -> dict:
    return db.create_acceptance(
        game_nick=payload.game_nick,
        title=payload.title,
        accepted_date=payload.accepted_date.isoformat(),
        note=payload.note,
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
        actor=actor,
    )
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res


@router.delete("/{acc_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove(acc_id: int, actor: dict = Depends(current_actor)) -> None:
    if not db.delete_acceptance(acc_id, actor=actor):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
