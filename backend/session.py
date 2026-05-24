"""Подписанная сессия в HTTP-only cookie."""

from datetime import datetime
from typing import Any

from fastapi import Request, HTTPException, Response, status
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from config import settings


COOKIE_NAME = "officer_session"
MAX_AGE_SEC = 60 * 60 * 24 * 7  # 7 дней
_serializer = URLSafeTimedSerializer(settings.session_secret, salt="officers.session.v2")


def _sign(payload: dict[str, Any]) -> str:
    return _serializer.dumps(payload)


def _verify(token: str) -> dict[str, Any]:
    return _serializer.loads(token, max_age=MAX_AGE_SEC)


def set_session(response: Response, *, role: str, name: str) -> None:
    payload = {
        "role": role,
        "name": name,
        "login_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    token = _sign(payload)
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


def current_session(request: Request) -> dict[str, str]:
    """Возвращает {role, name, login_at}. Бросает 401, если нет/протух/битый."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "no_session")
    try:
        data = _verify(token)
    except SignatureExpired:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session_expired")
    except BadSignature:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_session")
    return {
        "role": data["role"],
        "name": data["name"],
        "login_at": data.get("login_at", ""),
    }


ADMIN_DISPLAY = "Администратор"


def current_actor(request: Request) -> dict[str, str]:
    """Для CRUD-эндпоинтов: формат как раньше (platform/id/name).

    Для admin-сессии namespace анонимизируется в «Администратор» — реальный
    логин админа (например, buzzword001 — он же игровой ник в Telegram) НЕ
    светится в acceptances.created_by_* и audit_log.actor_*. Это даёт админу
    инкогнито при правках в реестре.
    """
    s = current_session(request)
    if s["role"] == "admin":
        return {"platform": "admin", "id": "admin", "name": ADMIN_DISPLAY}
    return {
        "platform": s["role"],
        "id": s["name"],
        "name": s["name"],
    }


def require_admin(request: Request) -> dict[str, str]:
    s = current_session(request)
    if s["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin_only")
    return s
