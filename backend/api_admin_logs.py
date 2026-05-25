"""Admin endpoints: блок-лист + детальный access log.

Лежит отдельно от api_auth.py чтобы маршруты `/admin/blocklist` и
`/admin/access-log` не смешивались с auth-роутами.
"""

import ipaddress

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, Field

import blocklist as _bl
import db
from session import require_admin


router = APIRouter(prefix="/admin", tags=["admin-logs"])


# ── blocklist ────────────────────────────────────────────────────────────


class BlocklistIn(BaseModel):
    kind: str = Field(..., pattern=r"^(ip|nick)$")
    pattern: str = Field(..., min_length=1, max_length=128)
    reason: str = Field("", max_length=200)


@router.get("/blocklist")
def get_blocklist(_: dict = Depends(require_admin)) -> list[dict]:
    return db.list_blocklist()


@router.post("/blocklist", status_code=status.HTTP_201_CREATED)
def add_blocklist_entry(payload: BlocklistIn, actor: dict = Depends(require_admin)) -> dict:
    pat = payload.pattern.strip()
    if payload.kind == "ip":
        # Валидация: либо IP (v4/v6), либо CIDR. ip_network принимает и то и то.
        try:
            ipaddress.ip_network(pat, strict=False)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"bad_ip_or_cidr: {exc}")
    try:
        entry = db.add_blocklist(
            kind=payload.kind, pattern=pat, reason=payload.reason,
            created_by=actor.get("name") or "admin",
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    _bl.invalidate_cache()
    return entry


@router.delete("/blocklist/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_blocklist_entry(entry_id: int, _: dict = Depends(require_admin)) -> None:
    ok = db.delete_blocklist(entry_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    _bl.invalidate_cache()


# ── access log ───────────────────────────────────────────────────────────


@router.get("/access-log")
def get_access_log(limit: int = 500, _: dict = Depends(require_admin)) -> list[dict]:
    if limit < 1: limit = 1
    if limit > 2000: limit = 2000
    return db.list_access(limit)


@router.delete("/access-log", status_code=status.HTTP_204_NO_CONTENT)
def clear_access_log(_: dict = Depends(require_admin)) -> None:
    db.clear_access()
