"""SQLite с двумя таблицами: acceptances + audit_log.

Сознательно без ORM — схема плоская, удобнее видеть SQL целиком.
"""

import sqlite3
import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from config import settings


IMMUNITY_DAYS = 7


SCHEMA = """
CREATE TABLE IF NOT EXISTS acceptances (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_nick       TEXT    NOT NULL,
    title           TEXT    NOT NULL DEFAULT '',
    accepted_date   TEXT    NOT NULL,            -- ISO YYYY-MM-DD
    note            TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    created_by_platform TEXT NOT NULL,
    created_by_id   TEXT    NOT NULL,
    created_by_name TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acceptances_date ON acceptances(accepted_date);
CREATE INDEX IF NOT EXISTS idx_acceptances_nick ON acceptances(game_nick);

CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    action          TEXT    NOT NULL,            -- create | update | delete
    acceptance_id   INTEGER,
    game_nick       TEXT,
    before_json     TEXT,
    after_json      TEXT,
    actor_platform  TEXT    NOT NULL,
    actor_id        TEXT    NOT NULL,
    actor_name      TEXT    NOT NULL,
    actor_ip        TEXT    NOT NULL DEFAULT '',
    actor_user_agent TEXT   NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS login_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    role            TEXT    NOT NULL,            -- officer | admin
    name            TEXT    NOT NULL,            -- game_nick (officer) или логин (admin)
    success         INTEGER NOT NULL,            -- 0/1
    reason          TEXT    NOT NULL DEFAULT '', -- 'wrong_password' / '' и т.п.
    ip              TEXT    NOT NULL DEFAULT '',
    user_agent      TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_login_time ON login_log(timestamp);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp);

CREATE TABLE IF NOT EXISTS render_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    dirty           INTEGER NOT NULL DEFAULT 0,
    last_change_at  TEXT,
    last_render_at  TEXT,
    last_publish_at TEXT,
    tg_message_id   INTEGER,
    vk_message_id   INTEGER
);

INSERT OR IGNORE INTO render_state (id, dirty) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS auth_config (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),
    officer_password_hash    TEXT NOT NULL,
    admin_username           TEXT NOT NULL,
    admin_password_hash      TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocklist (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL,            -- 'ip' | 'nick'
    pattern         TEXT    NOT NULL,            -- IP / CIDR / точный ник
    reason          TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
    created_by      TEXT    NOT NULL DEFAULT 'admin'
);

CREATE INDEX IF NOT EXISTS idx_blocklist_kind ON blocklist(kind);

CREATE TABLE IF NOT EXISTS access_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    method          TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    status          INTEGER NOT NULL,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    actor_role      TEXT    NOT NULL DEFAULT '', -- 'admin' | 'officer' | '' (no session)
    actor_name      TEXT    NOT NULL DEFAULT '',
    ip              TEXT    NOT NULL DEFAULT '',
    user_agent      TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_access_time ON access_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_access_ip ON access_log(ip);

-- Кэш гео-IP. ip-api.com бесплатен (45 req/min), результат не меняется
-- неделями — кэшируем чтобы не упереться в лимит и видеть страну сразу.
CREATE TABLE IF NOT EXISTS geoip_cache (
    ip              TEXT PRIMARY KEY,
    country         TEXT NOT NULL DEFAULT '',
    country_code    TEXT NOT NULL DEFAULT '',
    region          TEXT NOT NULL DEFAULT '',
    city            TEXT NOT NULL DEFAULT '',
    isp             TEXT NOT NULL DEFAULT '',
    resolved_at     TEXT NOT NULL
);

-- Telemetry от фронта: ошибки fetch которые НЕ дошли до auth (когда сервер
-- недоступен из РФ, СORS lock, TLS issues). Доходят через GitHub Pages
-- путь, если backend жив хотя бы частично.
CREATE TABLE IF NOT EXISTS telemetry_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    kind            TEXT    NOT NULL,        -- 'connect_error' | 'tls' | 'cors' | ...
    message         TEXT    NOT NULL DEFAULT '',
    url             TEXT    NOT NULL DEFAULT '',
    ip              TEXT    NOT NULL DEFAULT '',
    user_agent      TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry_log(timestamp);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Доращиваем БД до текущей версии. ALTER TABLE ADD COLUMN идемпотентен
    через try/except — sqlite кидает OperationalError если колонка уже есть."""
    # 2026-05-25: храним plaintext пароль офицеров для подписи в TG/VK.
    # Без этого подпись остаётся со старым паролем из env после смены через UI.
    try:
        conn.execute(
            "ALTER TABLE auth_config ADD COLUMN officer_password_plain TEXT NOT NULL DEFAULT ''"
        )
    except sqlite3.OperationalError:
        pass  # колонка уже есть


def init_db() -> None:
    db_path = Path(settings.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connection() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


@contextmanager
def connection():
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _row_to_acceptance(row: sqlite3.Row) -> dict[str, Any]:
    accepted = date.fromisoformat(row["accepted_date"])
    immune_until = accepted + timedelta(days=IMMUNITY_DAYS)
    keys = row.keys()
    return {
        "id": row["id"],
        "game_nick": row["game_nick"],
        "title": row["title"] if "title" in keys else "",
        "accepted_date": row["accepted_date"],
        "immune_until": immune_until.isoformat(),
        "immune_active": date.today() < immune_until,
        "note": row["note"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "created_by_platform": row["created_by_platform"],
        "created_by_id": row["created_by_id"],
        "created_by_name": row["created_by_name"],
    }


def list_acceptances() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM acceptances ORDER BY accepted_date ASC, id ASC"
        ).fetchall()
        return [_row_to_acceptance(r) for r in rows]


def get_acceptance(acc_id: int) -> dict[str, Any] | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        return _row_to_acceptance(row) if row else None


def create_acceptance(
    *,
    game_nick: str,
    title: str,
    accepted_date: str,
    note: str,
    actor: dict[str, str],
) -> dict[str, Any]:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            """INSERT INTO acceptances
               (game_nick, title, accepted_date, note, created_at, updated_at,
                created_by_platform, created_by_id, created_by_name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                game_nick.strip(),
                title.strip(),
                accepted_date,
                note.strip(),
                now,
                now,
                actor["platform"],
                str(actor["id"]),
                actor["name"],
            ),
        )
        acc_id = cur.lastrowid
        after = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        _write_audit(conn, "create", acc_id, game_nick, None, dict(after), actor)
        _mark_dirty(conn)
        return _row_to_acceptance(after)


def update_acceptance(
    acc_id: int,
    *,
    game_nick: str | None,
    title: str | None,
    accepted_date: str | None,
    note: str | None,
    actor: dict[str, str],
) -> dict[str, Any] | None:
    with connection() as conn:
        before = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        if not before:
            return None

        new_nick = (game_nick or before["game_nick"]).strip()
        new_title = (before["title"] if title is None else title).strip()
        new_date = accepted_date or before["accepted_date"]
        new_note = before["note"] if note is None else note.strip()
        now = datetime.utcnow().isoformat(timespec="seconds")

        conn.execute(
            """UPDATE acceptances
               SET game_nick = ?, title = ?, accepted_date = ?, note = ?, updated_at = ?
               WHERE id = ?""",
            (new_nick, new_title, new_date, new_note, now, acc_id),
        )
        after = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        _write_audit(conn, "update", acc_id, new_nick, dict(before), dict(after), actor)
        _mark_dirty(conn)
        return _row_to_acceptance(after)


def delete_acceptance(acc_id: int, *, actor: dict[str, str]) -> bool:
    with connection() as conn:
        before = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        if not before:
            return False
        conn.execute("DELETE FROM acceptances WHERE id = ?", (acc_id,))
        _write_audit(conn, "delete", acc_id, before["game_nick"], dict(before), None, actor)
        _mark_dirty(conn)
        return True


def delete_audit_entry(entry_id: int) -> bool:
    with connection() as conn:
        cur = conn.execute("DELETE FROM audit_log WHERE id = ?", (entry_id,))
        return cur.rowcount > 0


def clear_audit() -> int:
    with connection() as conn:
        cur = conn.execute("DELETE FROM audit_log")
        return cur.rowcount


def get_render_state() -> dict[str, Any]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM render_state WHERE id = 1").fetchone()
        return dict(row) if row else {}


def update_render_state(**fields: Any) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    params = list(fields.values())
    with connection() as conn:
        conn.execute(f"UPDATE render_state SET {sets} WHERE id = 1", params)


def _mark_dirty(conn: sqlite3.Connection) -> None:
    conn.execute(
        "UPDATE render_state SET dirty = 1, last_change_at = ? WHERE id = 1",
        (datetime.utcnow().isoformat(timespec="seconds"),),
    )


def _write_audit(
    conn: sqlite3.Connection,
    action: str,
    acc_id: int | None,
    nick: str,
    before: dict | None,
    after: dict | None,
    actor: dict[str, str],
) -> None:
    conn.execute(
        """INSERT INTO audit_log
           (timestamp, action, acceptance_id, game_nick, before_json, after_json,
            actor_platform, actor_id, actor_name, actor_ip, actor_user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.utcnow().isoformat(timespec="seconds"),
            action,
            acc_id,
            nick,
            json.dumps(_serialise(before), ensure_ascii=False) if before else None,
            json.dumps(_serialise(after), ensure_ascii=False) if after else None,
            actor["platform"],
            str(actor["id"]),
            actor["name"],
            actor.get("ip", ""),
            actor.get("user_agent", ""),
        ),
    )


def list_audit(limit: int = 200) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        out = []
        for r in rows:
            keys = r.keys()
            out.append({
                "id": r["id"],
                "timestamp": r["timestamp"],
                "action": r["action"],
                "acceptance_id": r["acceptance_id"],
                "game_nick": r["game_nick"],
                "before": json.loads(r["before_json"]) if r["before_json"] else None,
                "after": json.loads(r["after_json"]) if r["after_json"] else None,
                "actor_platform": r["actor_platform"],
                "actor_id": r["actor_id"],
                "actor_name": r["actor_name"],
                "actor_ip": r["actor_ip"] if "actor_ip" in keys else "",
                "actor_user_agent": r["actor_user_agent"] if "actor_user_agent" in keys else "",
            })
        return out


# ── login_log ─────────────────────────────────────────────────────────────

def write_login(*, role: str, name: str, success: bool,
                ip: str, user_agent: str, reason: str = "") -> None:
    with connection() as conn:
        conn.execute(
            """INSERT INTO login_log (timestamp, role, name, success, reason, ip, user_agent)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.utcnow().isoformat(timespec="seconds"),
                role,
                name,
                1 if success else 0,
                reason,
                ip,
                user_agent,
            ),
        )


def list_logins(limit: int = 200) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM login_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "role": r["role"],
                "name": r["name"],
                "success": bool(r["success"]),
                "reason": r["reason"],
                "ip": r["ip"],
                "user_agent": r["user_agent"],
            }
            for r in rows
        ]


def clear_logins() -> int:
    with connection() as conn:
        cur = conn.execute("DELETE FROM login_log")
        return cur.rowcount


# ── blocklist ────────────────────────────────────────────────────────────

def list_blocklist() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM blocklist ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def add_blocklist(*, kind: str, pattern: str, reason: str, created_by: str) -> dict[str, Any]:
    if kind not in {"ip", "nick"}:
        raise ValueError(f"invalid kind: {kind!r}")
    pattern = pattern.strip()
    if not pattern:
        raise ValueError("empty pattern")
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO blocklist (kind, pattern, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
            (kind, pattern, reason.strip(), now, created_by),
        )
        row = conn.execute(
            "SELECT * FROM blocklist WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(row)


def delete_blocklist(entry_id: int) -> bool:
    with connection() as conn:
        cur = conn.execute("DELETE FROM blocklist WHERE id = ?", (entry_id,))
        return cur.rowcount > 0


# ── access_log (детальный журнал действий) ──────────────────────────────

# Не пишем чисто-read traffic — он раздувает БД и не несёт пользы.
# Логируем mutations + auth + admin endpoints.
_ACCESS_LOG_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_ACCESS_LOG_GET_PREFIXES = ("/admin/",)  # GET /admin/snapshots и пр. — нужно знать кто смотрел
_ACCESS_LOG_SKIP_PATHS = {"/health", "/openapi.json", "/docs", "/redoc"}
# Префиксы которые НЕ пишем в access_log даже если POST — это сами telemetry
# и геоипы (иначе двойной шум: пользователь не дошёл → telemetry POST → access_log).
_ACCESS_LOG_SKIP_PREFIXES = ("/telemetry/",)


def should_access_log(method: str, path: str) -> bool:
    if path in _ACCESS_LOG_SKIP_PATHS:
        return False
    if any(path.startswith(p) for p in _ACCESS_LOG_SKIP_PREFIXES):
        return False
    if method.upper() in _ACCESS_LOG_METHODS:
        return True
    if method.upper() == "GET" and any(path.startswith(p) for p in _ACCESS_LOG_GET_PREFIXES):
        return True
    return False


def write_access(*, method: str, path: str, status: int, latency_ms: int,
                 actor_role: str, actor_name: str, ip: str, user_agent: str) -> None:
    with connection() as conn:
        conn.execute(
            """INSERT INTO access_log
               (timestamp, method, path, status, latency_ms,
                actor_role, actor_name, ip, user_agent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.utcnow().isoformat(timespec="seconds"),
                method.upper(),
                path[:200],
                status,
                latency_ms,
                actor_role,
                actor_name[:64],
                ip[:64],
                user_agent[:200],
            ),
        )


def list_access(limit: int = 500) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM access_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def clear_access() -> int:
    with connection() as conn:
        cur = conn.execute("DELETE FROM access_log")
        return cur.rowcount


# Сколько дней храним детальный access_log/login_log/audit_log.
# 30 — баланс: достаточно для расследования инцидента, но БД не пухнет.
_LOG_RETENTION_DAYS = 30


def trim_old_logs() -> dict[str, int]:
    """Удаляет записи старше _LOG_RETENTION_DAYS. Вызывается из daily snapshot job
    в scheduler. Audit_log тоже подрезаем — снапшоты держат историю на бэкап."""
    cutoff = (datetime.utcnow() - timedelta(days=_LOG_RETENTION_DAYS)).isoformat(timespec="seconds")
    removed: dict[str, int] = {}
    with connection() as conn:
        for table in ("access_log", "login_log", "audit_log", "telemetry_log"):
            cur = conn.execute(f"DELETE FROM {table} WHERE timestamp < ?", (cutoff,))
            removed[table] = cur.rowcount
    return removed


# ── geoip cache ──────────────────────────────────────────────────────────


def get_geoip_cached(ips: list[str]) -> dict[str, dict[str, Any]]:
    """Возвращает {ip: row} только для тех IP, что уже в кэше."""
    if not ips:
        return {}
    placeholders = ",".join("?" * len(ips))
    with connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM geoip_cache WHERE ip IN ({placeholders})", ips
        ).fetchall()
        return {r["ip"]: dict(r) for r in rows}


def upsert_geoip(ip: str, *, country: str, country_code: str, region: str,
                 city: str, isp: str) -> None:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            """INSERT INTO geoip_cache (ip, country, country_code, region, city, isp, resolved_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(ip) DO UPDATE SET
                   country=excluded.country, country_code=excluded.country_code,
                   region=excluded.region, city=excluded.city, isp=excluded.isp,
                   resolved_at=excluded.resolved_at""",
            (ip, country, country_code, region, city, isp, now),
        )


# ── telemetry ────────────────────────────────────────────────────────────


def write_telemetry(*, kind: str, message: str, url: str, ip: str, user_agent: str) -> None:
    with connection() as conn:
        conn.execute(
            """INSERT INTO telemetry_log (timestamp, kind, message, url, ip, user_agent)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                datetime.utcnow().isoformat(timespec="seconds"),
                kind[:32], message[:500], url[:300], ip[:64], user_agent[:200],
            ),
        )


def list_telemetry(limit: int = 200) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM telemetry_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def clear_telemetry() -> int:
    with connection() as conn:
        cur = conn.execute("DELETE FROM telemetry_log")
        return cur.rowcount


def _serialise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(x) for x in obj]
    if isinstance(obj, sqlite3.Row):
        return {k: obj[k] for k in obj.keys()}
    return obj
