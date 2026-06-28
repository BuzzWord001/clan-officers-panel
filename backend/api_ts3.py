"""Endpoint'ы раздачи TeamSpeak 3 клиента (скачивание с нашего сервера)."""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

import ts3
from session import require_admin

log = logging.getLogger("api.ts3")
router = APIRouter(prefix="/ts3", tags=["ts3"])


@router.get("/info")
def ts3_info() -> dict:
    """Версии/размеры/доступность файлов + ссылка на офсайт. Публично:
    установщики TS3 не секрет, а карточки грузятся до гостевой сессии."""
    return ts3.public_info()


@router.get("/download/{platform}")
def ts3_download(platform: str) -> FileResponse:
    """Отдаёт установщик TS3 для платформы (windows|macos|linux) как файл."""
    if platform not in ts3.PLATFORMS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown_platform")
    path = ts3.file_for(platform)
    if not path:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "not_ready")
    return FileResponse(path, filename=path.name,
                        media_type="application/octet-stream")


@router.post("/refresh")
async def ts3_refresh(force: bool = False,
                      _: dict = Depends(require_admin)) -> dict:
    """Принудительно проверить/докачать версии (admin)."""
    return await asyncio.to_thread(ts3.refresh, force)
