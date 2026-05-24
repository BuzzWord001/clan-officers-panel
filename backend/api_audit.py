"""История изменений — кто что и когда правил."""

from fastapi import APIRouter, Depends, Query

import db
from schemas import AuditOut
from session import current_actor


router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=list[AuditOut])
def history(
    limit: int = Query(default=200, ge=1, le=1000),
    _: dict = Depends(current_actor),
) -> list[dict]:
    return db.list_audit(limit)
