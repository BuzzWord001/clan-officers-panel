"""Простой in-memory rate limiter для auth-эндпоинтов (защита от брутфорса/DDoS входа).

Одна машина на Fly → in-memory достаточно. Считаем НЕУДАЧНЫЕ попытки по ключу (обычно IP+путь)
в скользящем окне; при превышении — временный блок с растущим (но ограниченным) кулдауном.
Успешный вход сбрасывает счётчик. Потокобезопасно.
"""

import threading
import time

_lock = threading.Lock()
_state: dict[str, dict] = {}          # key -> {"fails":[ts...], "blocked_until":ts, "strikes":int, "seen":ts}

WINDOW = 300          # окно подсчёта неудач, сек (5 мин)
MAX_FAILS = 6         # столько неудач в окне → временный блок
BASE_COOLDOWN = 30    # базовый таймаут блока, сек
MAX_COOLDOWN = 600    # потолок таймаута, сек (10 мин)
_MAX_KEYS = 5000


def check(key: str) -> int:
    """0 — можно; иначе секунды до разблокировки (для Retry-After)."""
    now = time.time()
    with _lock:
        st = _state.get(key)
        if st and st.get("blocked_until", 0) > now:
            return int(st["blocked_until"] - now) + 1
    return 0


def record(key: str, success: bool) -> None:
    """Зафиксировать исход попытки. success=True сбрасывает счётчик."""
    now = time.time()
    with _lock:
        st = _state.get(key)
        if st is None:
            st = _state[key] = {"fails": [], "blocked_until": 0.0, "strikes": 0, "seen": now}
        st["seen"] = now
        if success:
            st["fails"] = []
            st["blocked_until"] = 0.0
            st["strikes"] = 0
            return
        st["fails"] = [t for t in st["fails"] if now - t < WINDOW]
        st["fails"].append(now)
        if len(st["fails"]) >= MAX_FAILS:
            st["strikes"] = st.get("strikes", 0) + 1
            cooldown = min(BASE_COOLDOWN * (2 ** (st["strikes"] - 1)), MAX_COOLDOWN)
            st["blocked_until"] = now + cooldown
            st["fails"] = []
        # разовая чистка старых ключей, чтобы память не росла
        if len(_state) > _MAX_KEYS:
            dead = [k for k, v in _state.items()
                    if now - v.get("seen", 0) > 3600 and v.get("blocked_until", 0) < now]
            for k in dead:
                _state.pop(k, None)
