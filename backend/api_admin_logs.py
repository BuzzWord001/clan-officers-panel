"""Admin endpoints: блок-лист + детальный access log.

Лежит отдельно от api_auth.py чтобы маршруты `/admin/blocklist` и
`/admin/access-log` не смешивались с auth-роутами.
"""

import ipaddress

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

import blocklist as _bl
import db
import geoip
from session import client_ip, client_user_agent, require_admin, current_session


router = APIRouter(prefix="/admin", tags=["admin-logs"])
telemetry_router = APIRouter(prefix="/telemetry", tags=["telemetry"])


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


# ── storage stats ────────────────────────────────────────────────────────


@router.get("/storage")
def storage(_: dict = Depends(require_admin)) -> dict:
    """Сводка для UI: размер БД, кол-во строк в таблицах + размер снапшотов."""
    import snapshots as _snap
    snap_list = _snap.list_all()
    total_snap_bytes = sum(s["size"] for s in snap_list)
    return {
        "db": db.storage_stats(),
        "snapshots": {
            "count": len(snap_list),
            "total_bytes": total_snap_bytes,
        },
    }


# ── geoip resolve ────────────────────────────────────────────────────────


class ResolveIPsIn(BaseModel):
    ips: list[str] = Field(..., max_length=500)


@router.post("/resolve-ips")
async def resolve_ips(payload: ResolveIPsIn, _: dict = Depends(require_admin)) -> dict:
    return await geoip.resolve(payload.ips)


# ── telemetry ────────────────────────────────────────────────────────────


@router.get("/telemetry")
def get_telemetry(limit: int = 200, _: dict = Depends(require_admin)) -> list[dict]:
    if limit < 1: limit = 1
    if limit > 1000: limit = 1000
    return db.list_telemetry(limit)


@router.delete("/telemetry", status_code=status.HTTP_204_NO_CONTENT)
def clear_telemetry(_: dict = Depends(require_admin)) -> None:
    db.clear_telemetry()


# Публичный POST — фронт пишет сюда когда сам fetch упал. Auth не нужен.
class TelemetryIn(BaseModel):
    kind: str = Field(..., min_length=1, max_length=32)
    message: str = Field("", max_length=500)
    url: str = Field("", max_length=300)


@telemetry_router.post("/connect-error", status_code=status.HTTP_204_NO_CONTENT)
def telemetry_connect_error(payload: TelemetryIn, request: Request) -> None:
    """Frontend сюда POSTит из catch'а fetch'а — позволяет видеть кто
    пытался зайти даже если основной запрос упал."""
    db.write_telemetry(
        kind=payload.kind,
        message=payload.message,
        url=payload.url,
        ip=client_ip(request),
        user_agent=client_user_agent(request),
    )


# ── Отпечаток устройства визитёра (часовой пояс браузера и пр.) ──
class FpIn(BaseModel):
    tz: str = Field("", max_length=48)
    tz_offset: int = Field(0)
    lang: str = Field("", max_length=24)
    platform: str = Field("", max_length=48)
    screen: str = Field("", max_length=24)
    dev_mem: str = Field("", max_length=8)
    hw_cores: str = Field("", max_length=8)
    touch: bool = Field(False)
    url: str = Field("", max_length=200)


@telemetry_router.post("/fp", status_code=status.HTTP_204_NO_CONTENT)
def telemetry_fp(payload: FpIn, request: Request) -> None:
    """Пассивный сбор отпечатка устройства визитёра. Часовой пояс браузера VPN НЕ прячет —
    помогает вычислить, кто заходит за ссылками на чаты (по поясу + модели устройства)."""
    try:
        s = current_session(request)
        actor = s.get("name") or s.get("role") or "гость"
    except Exception:
        actor = "гость"
    db.write_visit_fp(
        ip=client_ip(request), actor=actor, tz=payload.tz, tz_offset=payload.tz_offset,
        lang=payload.lang, platform=payload.platform, screen=payload.screen,
        dev_mem=payload.dev_mem, hw_cores=payload.hw_cores, touch=payload.touch,
        url=payload.url, user_agent=client_user_agent(request))


@router.get("/visit-fp")
def get_visit_fp(limit: int = 300, _: dict = Depends(require_admin)) -> list[dict]:
    """Админу: отпечатки визитёров (для расследований). С гео по IP."""
    with db.connection() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM visit_fp ORDER BY id DESC LIMIT ?", (min(limit, 1000),))]
        geo = {r["ip"]: dict(r) for r in conn.execute("SELECT * FROM geoip_cache")}
    for r in rows:
        g = geo.get(r["ip"]) or {}
        r["geo"] = "%s/%s [%s]" % (g.get("country_code", "?"), g.get("city", "?"), (g.get("isp") or "")[:24])
    return rows
