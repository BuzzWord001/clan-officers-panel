"""Middleware: блок-лист + access log.

Один Starlette BaseHTTPMiddleware — короткие операции (BD insert на ~1мс),
не блокирует event loop надолго. CORS-preflight (OPTIONS) пропускаем без
логирования и проверок, чтобы не плодить мусор.
"""

import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response

import blocklist
import db
import rate_limit
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from config import settings
from session import COOKIE_NAME, client_ip, client_user_agent

log = logging.getLogger("officers.middleware")

_serializer = URLSafeTimedSerializer(settings.session_secret, salt="officers.session.v2")
_SESSION_MAX_AGE = 60 * 60 * 24 * 7

# POST-эндпоинты входа/смены пароля — под rate-limit (защита от брутфорса/DDoS).
_AUTH_PATHS = frozenset({
    "/queue/login", "/queue/register", "/queue/officer-login", "/queue/change-password",
    "/queue/recover", "/auth/login", "/auth/admin/login",
})

# Заголовки безопасности на КАЖДЫЙ ответ. CSP допускает inline (сайт его использует),
# но запрещает сторонние источники скриптов и фрейминг (анти-clickjacking/анти-XSS-инъекции).
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "media-src 'self' https:; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
)
_SEC_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": _CSP,
    "Cross-Origin-Opener-Policy": "same-origin",
}


def _secure(response):
    for k, v in _SEC_HEADERS.items():
        response.headers.setdefault(k, v)
    return response


def _actor_from_cookie(request: Request) -> tuple[str, str]:
    """Достаёт (role, name) из cookie ИЛИ Authorization: Bearer.
    Bearer-фолбэк нужен для браузеров где cross-site cookie блокируется
    (Firefox ETP, Brave, Yandex). Для незалогиненных возвращает ('', '')."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        auth = request.headers.get("authorization") or request.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    if not token:
        return "", ""
    try:
        data = _serializer.loads(token, max_age=_SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired, Exception):
        return "", ""
    role = data.get("role") or ""
    name = data.get("name") or ""
    return role, name


class GuardAndLogMiddleware(BaseHTTPMiddleware):
    """Single middleware = чтобы не плодить вложенные wrap'ы Starlette."""

    async def dispatch(self, request: Request, call_next):
        method = request.method
        path = request.url.path

        # CORS preflight — пропускаем без БД и без блок-листа.
        if method == "OPTIONS":
            return _secure(await call_next(request))

        # Кто инициатор — нужно ДО блок-листа, чтобы admin не словил self-lockout
        # (если он заблокирует свой IP, всё равно сможет зайти разблокировать).
        role, name = _actor_from_cookie(request)

        # 0) RATE-LIMIT входа: защита от брутфорса/DDoS. Ключ = IP + путь. При превышении
        # неудачных попыток — 429 с Retry-After. Успешный вход (200) сбрасывает счётчик.
        rl_key = None
        if method == "POST" and path in _AUTH_PATHS:
            ip = client_ip(request)
            rl_key = ip + "|" + path
            wait = rate_limit.check(rl_key)
            if wait > 0:
                log.info("rate-limit %s %s ip=%s wait=%ss", method, path, ip, wait)
                return _secure(JSONResponse(
                    {"detail": "too_many_attempts", "retry_after": wait},
                    status_code=429, headers={"Retry-After": str(wait)}))

        # 1) Block-list. Admin никогда не блокируется — это последняя страховка.
        if role != "admin":
            headers_b = {k: v for k, v in request.scope.get("headers", [])}
            block_reason = blocklist.is_blocked_request(request.scope, headers_b)
            if block_reason:
                log.warning("blocked request %s %s — %s", method, path, block_reason)
                try:
                    db.write_access(
                        method=method, path=path, status=403, latency_ms=0,
                        actor_role=role, actor_name=name,
                        ip=client_ip(request), user_agent=client_user_agent(request),
                    )
                except Exception:
                    log.exception("access_log write failed (block branch)")
                return _secure(PlainTextResponse(
                    f"blocked: {block_reason}",
                    status_code=403,
                ))

        # 2) Прокатить запрос, измерить latency и записать в access_log.
        if not db.should_access_log(method, path):
            response = await call_next(request)
            if rl_key is not None:
                rate_limit.record(rl_key, success=(response.status_code == 200))
            return _secure(response)

        started = time.perf_counter()
        response: Response = await call_next(request)
        latency_ms = int((time.perf_counter() - started) * 1000)
        if rl_key is not None:
            rate_limit.record(rl_key, success=(response.status_code == 200))

        try:
            db.write_access(
                method=method,
                path=path,
                status=response.status_code,
                latency_ms=latency_ms,
                actor_role=role,
                actor_name=name,
                ip=client_ip(request),
                user_agent=client_user_agent(request),
            )
        except Exception:
            # Любой сбой логирования НИКОГДА не должен валить ответ юзеру.
            log.exception("access_log write failed")
        return _secure(response)
