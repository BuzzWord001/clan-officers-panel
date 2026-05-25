"""Блок-лист пользователей по IP/CIDR и/или нику.

Middleware вешается на всё приложение и до handler'а отвечает 403, если
запрос матчится правилу. Кэш блок-листа в памяти на 5 секунд — без него
каждый запрос дёргал бы SQLite.
"""

import ipaddress
import logging
import re
import time
from typing import Any

import db
from session import client_ip, COOKIE_NAME
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from config import settings

log = logging.getLogger("officers.blocklist")

_CACHE_TTL_SEC = 5.0
_cache: dict[str, Any] = {"at": 0.0, "ips": [], "nicks": set()}

# Сессия (для извлечения ника без зависимости от FastAPI Request internals
# — мы в middleware ASGI, не в обработчике).
_serializer = URLSafeTimedSerializer(settings.session_secret, salt="officers.session.v2")
_SESSION_MAX_AGE = 60 * 60 * 24 * 7


def _load_rules() -> tuple[list, set[str]]:
    rows = db.list_blocklist()
    ips: list = []
    nicks: set[str] = set()
    for r in rows:
        kind = r["kind"]
        pat = r["pattern"].strip()
        if kind == "ip":
            try:
                # / в строке = CIDR; иначе одиночный IP → /32 либо /128.
                net = ipaddress.ip_network(pat, strict=False)
                ips.append(net)
            except ValueError:
                log.warning("bad blocklist ip pattern: %s", pat)
        elif kind == "nick":
            nicks.add(pat.casefold())
    return ips, nicks


def _refresh_if_stale() -> tuple[list, set[str]]:
    now = time.monotonic()
    if now - _cache["at"] < _CACHE_TTL_SEC:
        return _cache["ips"], _cache["nicks"]
    ips, nicks = _load_rules()
    _cache["ips"] = ips
    _cache["nicks"] = nicks
    _cache["at"] = now
    return ips, nicks


def invalidate_cache() -> None:
    """Сбросить TTL — следующий запрос перечитает блок-лист из БД.
    Дёргаем после add/delete, чтобы не ждать 5 сек."""
    _cache["at"] = 0.0


def _ip_blocked(ip: str, rules: list) -> bool:
    if not ip or not rules:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in rules)


def _extract_session_nick(cookie_value: str | None) -> str | None:
    if not cookie_value:
        return None
    try:
        data = _serializer.loads(cookie_value, max_age=_SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    # admin сидит под "Администратор" (не реальный ник) — блокировать по нику
    # admin'а смысла нет (это сам Лир). Сравниваем только офицеров.
    if data.get("role") != "officer":
        return None
    return (data.get("name") or "").strip()


def is_blocked_request(scope: dict, headers: dict[bytes, bytes]) -> str | None:
    """Возвращает причину блокировки или None если запрос разрешён.

    Парсит IP (cf-connecting-ip → x-forwarded-for → client), достаёт ник из
    подписанного cookie. Никаких раундтрипов кроме одного select раз в 5 сек.
    """
    ips, nicks = _refresh_if_stale()
    if not ips and not nicks:
        return None

    # IP из заголовков (фронт ходит через Fly proxy/Cloudflare).
    ip = ""
    for header_name in (b"fly-client-ip", b"cf-connecting-ip", b"x-forwarded-for"):
        raw = headers.get(header_name)
        if raw:
            ip = raw.decode("latin-1").split(",")[0].strip()
            break
    if not ip:
        # ASGI scope: client = (host, port) или None
        client = scope.get("client")
        if client:
            ip = client[0]

    if _ip_blocked(ip, ips):
        return f"ip {ip}"

    if nicks:
        # Cookie парсим вручную — у FastAPI request тут ещё нет.
        cookie_header = headers.get(b"cookie", b"").decode("latin-1")
        session_token: str | None = None
        for chunk in cookie_header.split(";"):
            k, _, v = chunk.strip().partition("=")
            if k == COOKIE_NAME:
                session_token = v
                break
        # Если cookie блокированы (РФ-Firefox/Brave), фронт шлёт токен
        # в Authorization: Bearer — оттуда тоже надо вытащить.
        if not session_token:
            auth = headers.get(b"authorization", b"").decode("latin-1")
            if not auth:
                auth = headers.get(b"Authorization", b"").decode("latin-1")
            if auth.lower().startswith("bearer "):
                session_token = auth[7:].strip()

        nick = _extract_session_nick(session_token)
        if nick and nick.casefold() in nicks:
            return f"nick {nick}"

    return None
