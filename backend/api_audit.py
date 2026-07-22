"""История изменений + admin-only удаление."""

from fastapi import APIRouter, Depends, HTTPException, Query, status

import db
from schemas import AuditOut
from session import current_session, require_admin


router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=list[AuditOut])
def history(
    limit: int = Query(default=200, ge=1, le=1000),
    s: dict = Depends(current_session),
) -> list[dict]:
    if s["role"] == "guest":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "officer_only")
    return db.list_audit(limit)


@router.get("/commands")
def command_log(
    limit: int = Query(default=300, ge=1, le=1000),
    _: dict = Depends(require_admin),
) -> list[dict]:
    """Подробный лог команд офицеров из чатов (кто/что/когда). Только админ."""
    return db.list_chat_commands(limit)


@router.delete("/commands", status_code=status.HTTP_204_NO_CONTENT)
def clear_command_log(_: dict = Depends(require_admin)) -> None:
    db.clear_chat_commands()


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(entry_id: int, _: dict = Depends(require_admin)) -> None:
    if not db.delete_audit_entry(entry_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def clear(_: dict = Depends(require_admin)) -> None:
    db.clear_audit()
