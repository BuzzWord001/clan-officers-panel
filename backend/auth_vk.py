"""VK ID — обмен code на access_token + получение user info.

Frontend получает code от VK ID, шлёт сюда. Мы дёргаем VK напрямую
с server_secret и проверяем user.
"""

import httpx
from fastapi import HTTPException, status

from config import settings


VK_OAUTH_TOKEN_URL = "https://oauth.vk.com/access_token"
VK_API_USERS_GET = "https://api.vk.com/method/users.get"
VK_API_VERSION = "5.199"


async def exchange_code(code: str, redirect_uri: str) -> dict:
    if not (settings.vk_app_id and settings.vk_app_secret):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "vk_oauth_not_configured")

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            VK_OAUTH_TOKEN_URL,
            params={
                "client_id": settings.vk_app_id,
                "client_secret": settings.vk_app_secret,
                "redirect_uri": redirect_uri,
                "code": code,
            },
        )
    if r.status_code != 200:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"vk_token_http_{r.status_code}")
    data = r.json()
    if "access_token" not in data or "user_id" not in data:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, data.get("error_description", "vk_token_error"))
    return data


async def fetch_user(access_token: str, user_id: int) -> dict:
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            VK_API_USERS_GET,
            params={
                "user_ids": user_id,
                "fields": "screen_name",
                "access_token": access_token,
                "v": VK_API_VERSION,
            },
        )
    payload = r.json()
    items = payload.get("response") or []
    if not items:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "vk_user_not_found")
    return items[0]
