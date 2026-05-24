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
    actor_name      TEXT    NOT NULL
);

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
"""


def init_db() -> None:
    db_path = Path(settings.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connection() as conn:
        conn.executescript(SCHEMA)


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
    return {
        "id": row["id"],
        "game_nick": row["game_nick"],
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
    accepted_date: str,
    note: str,
    actor: dict[str, str],
) -> dict[str, Any]:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            """INSERT INTO acceptances
               (game_nick, accepted_date, note, created_at, updated_at,
                created_by_platform, created_by_id, created_by_name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                game_nick.strip(),
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
        new_date = accepted_date or before["accepted_date"]
        new_note = before["note"] if note is None else note.strip()
        now = datetime.utcnow().isoformat(timespec="seconds")

        conn.execute(
            """UPDATE acceptances
               SET game_nick = ?, accepted_date = ?, note = ?, updated_at = ?
               WHERE id = ?""",
            (new_nick, new_date, new_note, now, acc_id),
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


def list_audit(limit: int = 200) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        out = []
        for r in rows:
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
            })
        return out


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
            actor_platform, actor_id, actor_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
        ),
    )


def _serialise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(x) for x in obj]
    if isinstance(obj, sqlite3.Row):
        return {k: obj[k] for k in obj.keys()}
    return obj
