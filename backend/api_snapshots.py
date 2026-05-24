"""Резервные копии — admin-only управление."""

from fastapi import APIRouter, Depends, HTTPException, status

import snapshots
from session import require_admin


router = APIRouter(prefix="/admin/snapshots", tags=["snapshots"])


@router.get("")
def list_snapshots(_: dict = Depends(require_admin)) -> list[dict]:
    return snapshots.list_all()


@router.post("")
def create_now(_: dict = Depends(require_admin)) -> dict:
    p = snapshots.create_manual()
    st = p.stat()
    return {
        "name": p.name,
        "size": st.st_size,
        "created_at": p.stat().st_mtime,
    }


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_snapshot(name: str, _: dict = Depends(require_admin)) -> None:
    try:
        ok = snapshots.delete_one(name)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")


@router.get("/{name}/inspect")
def inspect_snapshot(name: str, _: dict = Depends(require_admin)) -> dict:
    """Открыть снапшот readonly, отдать его acceptances + audit_log."""
    try:
        return snapshots.inspect(name)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "snapshot_not_found")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.post("/{name}/restore")
def restore_snapshot(name: str, _: dict = Depends(require_admin)) -> dict:
    try:
        pre = snapshots.restore(name)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "snapshot_not_found")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    snapshots.schedule_restart()
    return {"ok": True, "pre_restore_snapshot": pre.name}
