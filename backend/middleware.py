"""Middleware: блок-лист + access log.

Один Starlette BaseHTTPMiddleware — короткие операции (BD insert на ~1мс),
не блокирует event loop надолго. CORS-preflight (OPTIONS) пропускаем без
логирования и проверок, чтобы не плодить мусор.
"""

import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

import blocklist
import db
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from config import settings
from session import COOKIE_NAME, client_ip, client_user_agent

log = logging.getLogger("officers.middleware")

_serializer = URLSafeTimedSerializer(settings.session_secret, salt="officers.session.v2")
_SESSION_MAX_AGE = 60 * 60 * 24 * 7


def _actor_from_cookie(request: Request) -> tuple[str, str]:
    """Достаёт (role, name) из подписанной session-cookie без падений.
    Для незалогиненных возвращает ('', '')."""
    token = request.cookies.get(COOKIE_NAME)
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
            return await call_next(request)

        # Кто инициатор — нужно ДО блок-листа, чтобы admin не словил self-lockout
        # (если он заблокирует свой IP, всё равно сможет зайти разблокировать).
        role, name = _actor_from_cookie(request)

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
                return PlainTextResponse(
                    f"blocked: {block_reason}",
                    status_code=403,
                )

        # 2) Прокатить запрос, измерить latency и записать в access_log.
        if not db.should_access_log(method, path):
            return await call_next(request)

        started = time.perf_counter()
        response: Response = await call_next(request)
        latency_ms = int((time.perf_counter() - started) * 1000)

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
        return response
