"""Подписанная сессия в HTTP-only cookie. Без отдельной таблицы — данные в самом токене."""

from typing import Any
from fastapi import Request, HTTPException, Response, status
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from config import settings


COOKIE_NAME = "officer_session"
MAX_AGE_SEC = 60 * 60 * 24 * 7  # 7 дней
_serializer = URLSafeTimedSerializer(settings.session_secret, salt="officers.session.v1")


def sign(payload: dict[str, Any]) -> str:
    return _serializer.dumps(payload)


def verify(token: str) -> dict[str, Any]:
    return _serializer.loads(token, max_age=MAX_AGE_SEC)


def set_session(response: Response, payload: dict[str, Any]) -> None:
    token = sign(payload)
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=MAX_AGE_SEC,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", samesite="none", secure=True)


def current_actor(request: Request) -> dict[str, str]:
    """Достаём актора из cookie. Бросает 401, если нет/протух."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "no_session")
    try:
        data = verify(token)
    except SignatureExpired:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session_expired")
    except BadSignature:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_session")
    return {
        "platform": data["platform"],
        "id": str(data["id"]),
        "name": data["name"],
    }
