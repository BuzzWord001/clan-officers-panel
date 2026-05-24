"""История изменений + admin-only удаление."""

from fastapi import APIRouter, Depends, HTTPException, Query, status

import db
from schemas import AuditOut
from session import current_session, require_admin


router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=list[AuditOut])
def history(
    limit: int = Query(default=200, ge=1, le=1000),
    _: dict = Depends(current_session),
) -> list[dict]:
    return db.list_audit(limit)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(entry_id: int, _: dict = Depends(require_admin)) -> None:
    if not db.delete_audit_entry(entry_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def clear(_: dict = Depends(require_admin)) -> None:
    db.clear_audit()
