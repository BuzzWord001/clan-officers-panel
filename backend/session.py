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


def make_token(*, role: str, name: str) -> str:
    """Подписанный токен. Тот же что лежит в cookie — но может быть отдан
    в response body для клиентов которым cross-site cookies заблокированы
    (Firefox ETP, Brave, Yandex Browser, любой Chrome у которого юзер
    отключил third-party cookies). Срок жизни — те же 7 дней."""
    return _sign({
        "role": role,
        "name": name,
        "login_at": datetime.utcnow().isoformat(timespec="seconds"),
    })


def set_session(response: Response, *, role: str, name: str) -> str:
    """Ставит cookie И возвращает тот же токен — фронт сложит его в localStorage
    как фолбэк. Если cookie доедет, фронт всё равно её предпочтёт."""
    token = make_token(role=role, name=name)
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=MAX_AGE_SEC,
        httponly=True,
        secure=True,
        # Сайт single-origin (фронт и API на одном домене santdevil.com) →
        # cookie first-party, и правильный режим — Lax. Прежний "none" помечал
        # cookie как cross-site: Safari ITP, Firefox ETP, встроенные браузеры
        # Telegram/VK и приватные вкладки телефонов её РЕЗАЛИ → сессия не
        # вставала → me()→401→петля на login.html («людей не пускает»).
        samesite="lax",
        path="/",
    )
    return token


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", samesite="lax", secure=True)


def _token_from_request(request: Request) -> str | None:
    """Cookie приоритетнее (HTTP-only, не утечёт через XSS); fallback —
    Authorization: Bearer для клиентов где cookie не работает."""
    token = request.cookies.get(COOKIE_NAME)
    if token:
        return token
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def current_session(request: Request) -> dict[str, str]:
    """Возвращает {role, name, login_at}. Бросает 401, если нет/протух/битый."""
    token = _token_from_request(request)
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


def client_ip(request: Request) -> str:
    """Достаёт реальный IP клиента из заголовков прокси/туннеля."""
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()[:64]
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()[:64]
    if request.client:
        return (request.client.host or "")[:64]
    return ""


def client_user_agent(request: Request) -> str:
    """Берёт User-Agent. Обрезаем до 200 символов для БД."""
    return (request.headers.get("user-agent") or "")[:200]


def current_actor(request: Request) -> dict[str, str]:
    """Для CRUD-эндпоинтов: формат platform/id/name + ip/user_agent.

    Для admin-сессии namespace анонимизируется в «Администратор» — реальный
    логин админа (например, buzzword001 — он же игровой ник в Telegram) НЕ
    светится в acceptances.created_by_* и audit_log.actor_*. Это даёт админу
    инкогнито при правках в реестре. Но IP+UA для аудита сохраняются.
    """
    s = current_session(request)
    if s["role"] == "guest":
        # Гость — только просмотр; любые CRUD-действия запрещены.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "officer_only")
    ip = client_ip(request)
    ua = client_user_agent(request)
    if s["role"] == "admin":
        return {"platform": "admin", "id": "admin", "name": ADMIN_DISPLAY,
                "ip": ip, "user_agent": ua}
    return {
        "platform": s["role"],
        "id": s["name"],
        "name": s["name"],
        "ip": ip,
        "user_agent": ua,
    }


def require_admin(request: Request) -> dict[str, str]:
    s = current_session(request)
    if s["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin_only")
    return s
