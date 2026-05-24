"""VK Implicit Flow — валидация access_token через users.get.

Клиент получает токен от VK сам (popup на oauth.vk.com/blank.html),
шлёт нам access_token + заявленный user_id. Мы дёргаем users.get
с этим токеном и проверяем, что VK возвращает того же user_id.
Если совпало — токен подлинный.

Преимущество: не нужен client_secret, не нужны кастомные redirect URI
в настройках VK-приложения, не нужна ИП-верификация.
"""

import httpx
from fastapi import HTTPException, status


VK_API_USERS_GET = "https://api.vk.com/method/users.get"
VK_API_VERSION = "5.199"


async def validate_token(access_token: str, claimed_user_id: int) -> dict:
    """Проверяет access_token, возвращает данные пользователя.

    Бросает 401 если токен невалиден или не принадлежит claimed_user_id.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            VK_API_USERS_GET,
            params={
                "user_ids": claimed_user_id,
                "fields": "screen_name",
                "access_token": access_token,
                "v": VK_API_VERSION,
            },
        )
    payload = r.json()
    if "error" in payload:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            payload["error"].get("error_msg", "vk_api_error"),
        )

    items = payload.get("response") or []
    if not items:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "vk_user_not_found")

    user = items[0]
    if int(user["id"]) != int(claimed_user_id):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "vk_token_user_mismatch")

    return user
