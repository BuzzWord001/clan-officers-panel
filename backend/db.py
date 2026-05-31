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

-- Архив переписки клановых чатов TG и VK. Каждое сообщение хранится
-- ровно один раз — bot-мост пишет ТОЛЬКО оригинал, ретрансляцию в
-- парный чат другой платформы НЕ дублирует.
--
-- chat_group: 'general' (общий чат) | 'officers' (офицерский). У каждой
-- группы есть пара TG↔VK, объединённая мостом.
-- platform:   'tg' | 'vk' — откуда родом сообщение.
-- UNIQUE на (platform, chat_id, message_id) защищает от случайного
-- двойного ingest со стороны бота — INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_group      TEXT    NOT NULL,            -- 'general' | 'officers'
    platform        TEXT    NOT NULL,            -- 'tg' | 'vk'
    chat_id         TEXT    NOT NULL,
    message_id      TEXT    NOT NULL,
    user_id         TEXT    NOT NULL,
    user_display    TEXT    NOT NULL,
    user_username   TEXT    NOT NULL DEFAULT '', -- @username (tg) или screen_name (vk)
    text            TEXT    NOT NULL DEFAULT '',
    reply_to_msg_id TEXT    NOT NULL DEFAULT '', -- message_id того на которое отвечают
    reply_to_user   TEXT    NOT NULL DEFAULT '', -- автор цитируемого
    reply_to_text   TEXT    NOT NULL DEFAULT '', -- фрагмент текста цитируемого
    media_json      TEXT    NOT NULL DEFAULT '[]',
    sent_at         TEXT    NOT NULL,            -- ISO datetime (от платформы)
    ingested_at     TEXT    NOT NULL,            -- когда сохранили
    UNIQUE(platform, chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_group_date
    ON chat_messages(chat_group, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_user
    ON chat_messages(user_display);
-- Для агрегата активности по участникам clan_members нужно быстро
-- выбирать сообщения по (platform, user_id) и группировать.
CREATE INDEX IF NOT EXISTS idx_chat_platform_user
    ON chat_messages(platform, user_id);

-- FTS5 индекс для полнотекстового поиска по тексту и автору. unicode61
-- + remove_diacritics=2 нормализует ёжё → ее, а заглавные в строчные —
-- поиск "марина" найдёт "Марина" и "МАРИНА".
CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
    text,
    user_display,
    content='chat_messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Триггеры синхронизации FTS5 ↔ основная таблица. В FTS5 кладём
-- нормализованную версию (ё → е), потому что FTS5 `remove_diacritics`
-- не сворачивает кириллическое ё/Ё (это не combining mark, а отдельный
-- код-поинт). В основной таблице text остаётся в оригинале — для
-- отображения. При search тоже сворачиваем ё→е в запросе.
CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(rowid, text, user_display)
        VALUES (new.id,
                REPLACE(REPLACE(new.text, 'ё', 'е'), 'Ё', 'Е'),
                REPLACE(REPLACE(new.user_display, 'ё', 'е'), 'Ё', 'Е'));
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text, user_display)
        VALUES ('delete', old.id,
                REPLACE(REPLACE(old.text, 'ё', 'е'), 'Ё', 'Е'),
                REPLACE(REPLACE(old.user_display, 'ё', 'е'), 'Ё', 'Е'));
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text, user_display)
        VALUES ('delete', old.id,
                REPLACE(REPLACE(old.text, 'ё', 'е'), 'Ё', 'Е'),
                REPLACE(REPLACE(old.user_display, 'ё', 'е'), 'Ё', 'Е'));
    INSERT INTO chat_messages_fts(rowid, text, user_display)
        VALUES (new.id,
                REPLACE(REPLACE(new.text, 'ё', 'е'), 'Ё', 'Е'),
                REPLACE(REPLACE(new.user_display, 'ё', 'е'), 'Ё', 'Е'));
END;

-- Накопительная таблица «всех кто хоть раз писал в чат» — независимо от
-- того зарегистрирован ли человек через /reg в клан или нет. Заполняется
-- автоматически при каждом /chat/ingest. Для зарегистрированных есть
-- более полная инфа в clan_members (TG+VK в одной записи); chat_users
-- хранит только то что видит сам бот-мост: что у человека есть на ОДНОЙ
-- платформе откуда он пишет.
CREATE TABLE IF NOT EXISTS chat_users (
    platform     TEXT NOT NULL,        -- 'tg' | 'vk'
    user_id      TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',  -- @username (tg) / screen_name (vk)
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    msg_count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (platform, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_users_display
    ON chat_users(display_name);
CREATE INDEX IF NOT EXISTS idx_chat_users_username
    ON chat_users(username);

-- Зеркало clan_members.json из clan-reg-bot. Используется для умного поиска
-- в архиве: «Мелодька» автоматически расширяется в OR со всеми известными
-- именами этого человека (игровой ник, имя в VK, @username в TG и т.п.).
-- key — оригинальный {platform}_{platform_id} из clan-reg-bot, identifier
-- сохраняем 1:1 чтобы апсерты были идемпотентны.
CREATE TABLE IF NOT EXISTS clan_members (
    key             TEXT    PRIMARY KEY,
    game_nick       TEXT    NOT NULL DEFAULT '',  -- через запятую
    display_name    TEXT    NOT NULL DEFAULT '',
    vk_id           TEXT    NOT NULL DEFAULT '',
    vk_display      TEXT    NOT NULL DEFAULT '',
    vk_first        TEXT    NOT NULL DEFAULT '',
    vk_last         TEXT    NOT NULL DEFAULT '',
    vk_screen_name  TEXT    NOT NULL DEFAULT '',
    tg_id           TEXT    NOT NULL DEFAULT '',
    tg_display      TEXT    NOT NULL DEFAULT '',
    tg_username     TEXT    NOT NULL DEFAULT '',
    tg_first_name   TEXT    NOT NULL DEFAULT '',
    tg_last_name    TEXT    NOT NULL DEFAULT '',
    raw_json        TEXT    NOT NULL DEFAULT '',  -- полный исходный объект на всякий случай
    synced_at       TEXT    NOT NULL,
    -- 1 если человек был в последнем sync. 0 если ушёл из чатов и его
    -- удалили из clan_members.json — данные остаются для identity-резолва
    -- по архиву, но в UI помечены как «не в чате».
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_seen_at    TEXT    NOT NULL DEFAULT ''
);

-- ── Доблесть (pw-valor-tracker) ───────────────────────────────────────
-- Каждый запуск pw-valor-tracker = один valor_snapshots row + N
-- valor_members. Лир собирает раз в неделю в воскресенье; для одной
-- недели хранится один свежий снимок (REPLACE при повторе).
CREATE TABLE IF NOT EXISTS valor_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    week          TEXT    NOT NULL UNIQUE,    -- 2026-W22
    captured_at   TEXT    NOT NULL,           -- ISO timestamp
    valor_norm    INTEGER NOT NULL,           -- норматив на эту неделю
    screens_count INTEGER NOT NULL DEFAULT 0, -- сколько кадров было
    members_count INTEGER NOT NULL DEFAULT 0,
    notes         TEXT    NOT NULL DEFAULT ''
);

-- Каждый соклан в каждом снапшоте.
-- nick_canon — для join'а history (один и тот же человек в разных
-- неделях даст разные nick если OCR drift'нул, но canon стабилен).
-- true_name — отдельная стабильная колонка (мэйн/настоящее имя), её
-- задаёт автор файлов на десктопе (true_names.py).
CREATE TABLE IF NOT EXISTS valor_members (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id      INTEGER NOT NULL REFERENCES valor_snapshots(id) ON DELETE CASCADE,
    nick             TEXT    NOT NULL,
    nick_canon       TEXT    NOT NULL,
    true_name        TEXT    NOT NULL DEFAULT '',
    rank             TEXT    NOT NULL DEFAULT '',
    title            TEXT    NOT NULL DEFAULT '',
    level            INTEGER,
    class_           TEXT    NOT NULL DEFAULT '',
    valor            INTEGER,
    is_afk           INTEGER NOT NULL DEFAULT 0,
    norm_met         INTEGER,   -- NULL=АФК (не оценивается), 0=нет, 1=да
    flag_new_nick    INTEGER NOT NULL DEFAULT 0,
    flag_ocr_suspect INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_valor_members_canon
    ON valor_members(nick_canon);
CREATE INDEX IF NOT EXISTS idx_valor_members_snapshot
    ON valor_members(snapshot_id);

-- История по полям должность/титул/уровень/класс — пишется ТОЛЬКО когда
-- значение сменилось относительно предыдущего снимка для того же ника.
-- Это позволяет в UI кликнуть по титулу и увидеть "Капитан с 2026-W20,
-- до того был Лейтенант с 2026-W14".
CREATE TABLE IF NOT EXISTS valor_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nick_canon  TEXT    NOT NULL,
    field       TEXT    NOT NULL,           -- rank|title|level|class
    value       TEXT    NOT NULL DEFAULT '',
    week        TEXT    NOT NULL,
    captured_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valor_history_member
    ON valor_history(nick_canon, field, week);

-- Архив ушедших из клана. При save_snapshot, если ник был в prev,
-- но в current его нет — INSERT/UPDATE сюда (последние известные
-- данные). Если ник снова появился в новом снапшоте — DELETE.
CREATE TABLE IF NOT EXISTS valor_departed (
    nick_canon    TEXT    PRIMARY KEY,
    nick          TEXT    NOT NULL,
    true_name     TEXT    NOT NULL DEFAULT '',
    last_week     TEXT    NOT NULL,
    last_rank     TEXT    NOT NULL DEFAULT '',
    last_title    TEXT    NOT NULL DEFAULT '',
    last_level    INTEGER,
    last_class    TEXT    NOT NULL DEFAULT '',
    last_valor    INTEGER,
    warning_count INTEGER NOT NULL DEFAULT 0,
    departed_at   TEXT    NOT NULL
);
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
        pass

    # 2026-05-29: reply-цитаты в архиве — храним имя автора и фрагмент текста
    # того сообщения на которое отвечают. Раньше в архиве был только ID,
    # пользователю это ничего не говорило.
    for col in ("reply_to_user TEXT NOT NULL DEFAULT ''",
                "reply_to_text TEXT NOT NULL DEFAULT ''"):
        try:
            conn.execute(f"ALTER TABLE chat_messages ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass

    # 2026-05-29 (вечер): сохраняем участников клана даже после выхода из
    # чатов — для identity-резолва в архиве. is_active помечает кто
    # сейчас в зеркале clan_members.json, кто уже нет. last_seen_at — когда
    # человек последний раз попадал в синхронизацию.
    for col in ("is_active INTEGER NOT NULL DEFAULT 1",
                "last_seen_at TEXT NOT NULL DEFAULT ''",
                # 2026-05-31: аватарки участников в R2 (заливает
                # clan-reg-bot/refresh_avatars.py). URL стабильный,
                # _updated — ISO когда последний раз перекачивали.
                "tg_avatar_url TEXT NOT NULL DEFAULT ''",
                "vk_avatar_url TEXT NOT NULL DEFAULT ''",
                "tg_avatar_updated TEXT NOT NULL DEFAULT ''",
                "vk_avatar_updated TEXT NOT NULL DEFAULT ''"):
        try:
            conn.execute(f"ALTER TABLE clan_members ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass

    # 2026-06-01: счётчик стрика невыполненного норматива в valor_members.
    # 0 — выполнил в эту неделю (или АФК). При невыполнении +1 от prev.
    # При выполнении сбрасывается до 0.
    try:
        conn.execute(
            "ALTER TABLE valor_members ADD COLUMN "
            "warning_count INTEGER NOT NULL DEFAULT 0"
        )
    except sqlite3.OperationalError:
        pass

    # 2026-05-29 (поздно вечером): дедуп медиа. Стикеры/GIF/часто повторяющиеся
    # картинки бесполезно качать и заливать снова — раз уже в R2, ссылка та же.
    # Двухключевая дедупликация: платформенный file_unique_id (стабилен в
    # пределах одного бота) и SHA256 содержимого (универсально).
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS media_dedup (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                kind        TEXT NOT NULL,   -- 'tg_unique' | 'vk_sticker' | 'vk_doc' | 'sha256'
                key         TEXT NOT NULL,
                r2_url      TEXT NOT NULL,
                r2_key      TEXT NOT NULL,
                mime        TEXT NOT NULL DEFAULT '',
                size        INTEGER NOT NULL DEFAULT 0,
                media_kind  TEXT NOT NULL DEFAULT '',
                width       INTEGER NOT NULL DEFAULT 0,
                height      INTEGER NOT NULL DEFAULT 0,
                first_seen  TEXT NOT NULL,
                last_seen   TEXT NOT NULL,
                hit_count   INTEGER NOT NULL DEFAULT 1,
                UNIQUE(kind, key)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_media_dedup_lookup "
                     "ON media_dedup(kind, key)")
    except sqlite3.OperationalError:
        pass


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


def vacuum() -> int:
    """Освобождает удалённые страницы в SQLite файле обратно в OS.

    Без VACUUM файл officers.db только растёт: DELETE помечает страницы
    свободными внутри, но не уменьшает размер файла. Снапшот тяжелее зря.

    Возвращает экономию в байтах. Запускать после trim_old_logs — иначе
    смысла нет. VACUUM нельзя в транзакции (sqlite требует autocommit) —
    делаем отдельным соединением с isolation_level=None.
    """
    db_path = Path(settings.db_path)
    before = db_path.stat().st_size if db_path.exists() else 0
    conn = sqlite3.connect(settings.db_path, isolation_level=None)
    try:
        conn.execute("VACUUM")
    finally:
        conn.close()
    after = db_path.stat().st_size if db_path.exists() else 0
    return max(0, before - after)


def storage_stats() -> dict[str, Any]:
    """Сводка для UI: размер БД и кол-во строк в основных таблицах."""
    db_path = Path(settings.db_path)
    size = db_path.stat().st_size if db_path.exists() else 0
    counts: dict[str, int] = {}
    with connection() as conn:
        for t in ("acceptances", "audit_log", "login_log",
                  "access_log", "telemetry_log", "blocklist",
                  "geoip_cache"):
            try:
                counts[t] = conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                counts[t] = 0
    return {"db_bytes": size, "rows": counts}


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


# ── chat archive ─────────────────────────────────────────────────────────

# Группы валидируются на API-слое, тут оставлены как контракт для bot-стороны.
CHAT_GROUPS = ("general", "officers")
CHAT_PLATFORMS = ("tg", "vk")


def _upsert_chat_user(conn: sqlite3.Connection, *, platform: str,
                      user_id: str, display: str, username: str,
                      sent_at: str) -> None:
    """Накапливаем метаданные автора в chat_users. Username сохраняется
    старый, если новый пустой (бот не всегда передаёт @username). Имя
    наоборот всегда берётся свежее — люди меняют ники, и popover должен
    показывать актуальное."""
    if not user_id or user_id == "0":
        return
    conn.execute(
        """INSERT INTO chat_users
           (platform, user_id, display_name, username,
            first_seen, last_seen, msg_count)
           VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(platform, user_id) DO UPDATE SET
             display_name = excluded.display_name,
             username     = CASE
                              WHEN excluded.username != '' THEN excluded.username
                              ELSE chat_users.username
                            END,
             last_seen    = excluded.last_seen,
             msg_count    = chat_users.msg_count + 1
        """,
        (platform, str(user_id), display[:128], (username or "")[:64],
         sent_at, sent_at),
    )


def ingest_chat_message(
    *,
    chat_group: str,
    platform: str,
    chat_id: str,
    message_id: str,
    user_id: str,
    user_display: str,
    user_username: str = "",
    text: str = "",
    reply_to_msg_id: str = "",
    reply_to_user: str = "",
    reply_to_text: str = "",
    media: list[dict[str, Any]] | None = None,
    sent_at: str,
) -> dict[str, Any]:
    """Сохраняет сообщение в архив. Дубль (platform, chat_id, message_id)
    тихо игнорируется — UNIQUE индекс защищает от повторного ingest от
    бота при перезапуске или ретрае.

    Возвращает {"id": int, "duplicate": bool}.
    """
    if chat_group not in CHAT_GROUPS:
        raise ValueError(f"invalid chat_group: {chat_group!r}")
    if platform not in CHAT_PLATFORMS:
        raise ValueError(f"invalid platform: {platform!r}")

    media_json = json.dumps(media or [], ensure_ascii=False)
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO chat_messages
               (chat_group, platform, chat_id, message_id,
                user_id, user_display, user_username,
                text, reply_to_msg_id, reply_to_user, reply_to_text,
                media_json,
                sent_at, ingested_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (chat_group, platform, str(chat_id), str(message_id),
             str(user_id), user_display[:128], user_username[:64],
             text, str(reply_to_msg_id),
             (reply_to_user or "")[:128], (reply_to_text or "")[:300],
             media_json,
             sent_at, now),
        )
        if cur.rowcount == 0:
            # Дубль — вернём id существующей записи для идемпотентности
            row = conn.execute(
                """SELECT id FROM chat_messages
                   WHERE platform = ? AND chat_id = ? AND message_id = ?""",
                (platform, str(chat_id), str(message_id)),
            ).fetchone()
            return {"id": row["id"] if row else 0, "duplicate": True}
        # Накапливаем метаданные автора в chat_users (видна в popover
        # для незарегистрированных).
        _upsert_chat_user(
            conn, platform=platform, user_id=str(user_id),
            display=user_display, username=user_username, sent_at=sent_at,
        )
        return {"id": cur.lastrowid, "duplicate": False}


def _row_to_chat_message(row: sqlite3.Row) -> dict[str, Any]:
    try:
        media = json.loads(row["media_json"]) if row["media_json"] else []
    except json.JSONDecodeError:
        media = []
    keys = row.keys()
    return {
        "id": row["id"],
        "chat_group": row["chat_group"],
        "platform": row["platform"],
        "chat_id": row["chat_id"],
        "message_id": row["message_id"],
        "user_id": row["user_id"],
        "user_display": row["user_display"],
        "user_username": row["user_username"],
        "text": row["text"],
        "reply_to_msg_id": row["reply_to_msg_id"],
        "reply_to_user": row["reply_to_user"] if "reply_to_user" in keys else "",
        "reply_to_text": row["reply_to_text"] if "reply_to_text" in keys else "",
        "media": media,
        "sent_at": row["sent_at"],
        "ingested_at": row["ingested_at"],
    }


def list_chat_messages(
    *,
    chat_group: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    user: str | None = None,
    search: str | None = None,
    limit: int = 100,
    before_id: int | None = None,
    after_id: int | None = None,
    order: str = "desc",
) -> list[dict[str, Any]]:
    """Возвращает сообщения в обратном хронологическом порядке (новые сверху).

    before_id  — пагинация: «всё что id < before_id». Устойчиво к новым
                 ingest'ам в процессе листания, в отличие от offset.
    after_id   — auto-refresh: «всё что id > after_id». Возвращается тоже
                 в обратном хронологическом порядке (id DESC), но фронт
                 ожидает только дельту чтобы вставить сверху.
    order      — "desc" (по умолчанию, новые сверху) или "asc". ASC нужен
                 для «контекста» при jump в архив: запрашиваем N сообщений
                 СРАЗУ ПОСЛЕ target (ближайшие свежее, не самые свежие в
                 архиве). Frontend потом разворачивает в DESC.

    search использует FTS5; остальное — обычные индексы.
    """
    order = (order or "desc").lower()
    order_sql = "ASC" if order == "asc" else "DESC"
    clauses = []
    params: list[Any] = []
    if chat_group:
        if chat_group not in CHAT_GROUPS:
            raise ValueError(f"invalid chat_group: {chat_group!r}")
        clauses.append("chat_group = ?")
        params.append(chat_group)
    if date_from:
        clauses.append("sent_at >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("sent_at <= ?")
        params.append(date_to)
    if user:
        clauses.append("user_display LIKE ?")
        params.append(f"%{user}%")
    if before_id:
        clauses.append("id < ?")
        params.append(before_id)
    if after_id:
        clauses.append("id > ?")
        params.append(after_id)

    with connection() as conn:
        if search:
            # FTS5 path — MATCH работает только с именем виртуальной таблицы,
            # не с алиасом. Поэтому подзапрос по chat_messages_fts даёт
            # rowid'ы, а внешний SELECT фильтрует по остальным условиям.
            fts_q = _build_fts_query(search)
            where = " AND ".join(clauses) if clauses else "1=1"
            sql = (
                "SELECT * FROM chat_messages "
                "WHERE id IN (SELECT rowid FROM chat_messages_fts "
                "             WHERE chat_messages_fts MATCH ?) "
                f"AND {where} "
                f"ORDER BY id {order_sql} LIMIT ?"
            )
            rows = conn.execute(sql, [fts_q, *params, limit]).fetchall()
        else:
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            sql = (
                f"SELECT * FROM chat_messages{where} "
                f"ORDER BY id {order_sql} LIMIT ?"
            )
            rows = conn.execute(sql, [*params, limit]).fetchall()
        return [_row_to_chat_message(r) for r in rows]


import re as _re

# Префиксы column-targeted поиска. После префикса значение матчится только
# по полю user_display в FTS5 индексе.
_AUTHOR_PREFIXES = ("от:", "автор:", "author:", "from:")
# Префикс явного выбора темы для расширения по словарю синонимов.
_THEME_PREFIXES = ("тема:", "theme:")
# Префикс «обсуждают X / говорят про X» — ищет упоминания человека В ТЕКСТАХ
# других людей. Само имя расширяется через identity-резолв (все варианты
# ника), но сообщения от самого X исключаются. Работает для всех известных
# клану людей — clan_members и chat_users.
_MENTION_PREFIXES = ("о:", "обсужд:", "упомин:", "mention:", "about:")
# Токенизатор: квотированная фраза с опциональным минусом и звёздочкой,
# либо обычное слово (тоже с опциональным минусом).
_FTS_TOK_RE = _re.compile(r'-?"[^"]+"\*?|-?\S+', _re.UNICODE)


# ── Клановые темы (словарь синонимов) ────────────────────────────────────
# Каждая тема = список «стемов». Стем — это короткий корень слова, по
# которому FTS5 с префикс-матчем (`стем*`) найдёт все формы:
#   «руга» → ругаться, ругаются, ругань, ругал и т.п.
#
# Используется двумя способами:
#   1. Явно: «тема:ссоры» → раскрывается в OR всех стемов темы.
#   2. Автоматически: если обычное слово в запросе совпадает с одним из
#      стемов любой темы — расширяется до OR всех стемов этой темы.
#      Например, «ссориться» совпадает со стемом «ссор» темы «ссоры»
#      → поиск найдёт также «ругаются», «конфликт», «обиделась» и т.п.
CHAT_THEMES: dict[str, list[str]] = {
    "ссоры":         ["руга", "ссор", "конфликт", "оскорб", "обид",
                      "скандал", "срач", "токсик", "хамл", "мат"],
    "рейды":         ["рейд", "поход", "босс", "инст", "пати", "патии",
                      "сейв", "рб ", "ивент"],
    "помощь":        ["помог", "помощ", "подскаж", "объясн", "научи",
                      "ищу", "нужн", "как"],
    "реклама":       ["рекла", "спам", "прода", "купл", "обмен"],
    "благодарность": ["спасиб", "благодар", "спс", "thanks", "thx"],
    # «ку» убран — цеплял «курсе», «курсы», «куда».
    "приветствие":   ["привет", "хай", "hello", "здаров", "йоу"],
    "прокачка":      ["кач", "лвл", "уровн", "опыт", "экспа"],
    "золото":        ["золот", "монет", "бартер", "лоты"],
    "опоздание":     ["опазд", "опозд", "отсут", "не смогу", "не могу"],
    # «арен» убран — цеплял «аренду» (арендованное оружие в PW).
    "пвп":           ["пвп", "дуэл", "бой"],
    "приходы":       ["присоединил", "вошел", "вошла", "вступил", "вступила",
                      "добавил", "заш", "joined", "приш"],
    "уходы":         ["покинул", "покинула", "вышел", "вышла", "ушел", "ушла",
                      "left", "кикн", "удалили", "выгн"],
    "события":       ["присоединил", "покинул", "вошел", "вошла", "вступил",
                      "вступила", "вышел", "вышла", "добавил", "кикн",
                      "удалили", "выгн", "joined", "left"],
    "кх":            ["кх", "каньон", "хаос"],
    "адепты":        ["адепт", "учен"],
    "приём":         ["прием", "приём", "набор", "вступ", "приним"],
    # Убраны: «лаг» (цеплял «лагеря»), «сломал» (слишком общее, «сломал руку»),
    # «падает», «вылет», «не работает» — слишком частые слова в игровом контексте.
    # Оставлены специфичные стемы. Префикс `*` всё равно может зацепить
    # «багги» по слову «баг» — это известный edge case.
    "баги":          ["баги", "багов", "глюч", "крашит", "виснет"],
    # Убран «реал» (цеплял «реалиях», «реальный»), «рубл» (редко).
    "банк":          ["банк", "перевод", "донат", "оплат"],
    "доблести":      ["добл"],
    "этапы":         ["этап"],
    # Удалены: «вопрос» (стемы ?, кто, где, когда — почти каждое сообщение),
    # «прощание» (стем «пока» ловил «пока что», «пока не» — 80% шума).
}

# Обратный индекс «стем → имя темы» для быстрого matching в поиске.
_THEME_BY_STEM: dict[str, str] = {}
for _t, _stems in CHAT_THEMES.items():
    for _s in _stems:
        _THEME_BY_STEM[_s.lower().replace("ё", "е").strip()] = _t


def _stems_to_fts_or(stems: list[str]) -> str:
    """OR-группа префикс-фраз для FTS5: ("стем1"* OR "стем2"* OR ...)."""
    phrases = []
    for s in stems:
        clean = _normalize_for_fts(s).replace('"', '').strip()
        if not clean:
            continue
        if " " in clean:
            phrases.append(f'"{clean}"')   # FTS5 prefix не работает на phrase
        else:
            phrases.append(f'"{clean}"*')
    return "(" + " OR ".join(phrases) + ")" if phrases else '""'


def expand_theme(token: str) -> list[str] | None:
    """Если token совпадает со стемом какой-то темы, вернёт список стемов
    этой темы. Иначе None. Используется для автоматического расширения
    обычных слов в запросе.
    """
    t = (token or "").lower().replace("ё", "е").strip()
    if not t or len(t) < 3:
        return None
    if t in _THEME_BY_STEM:
        return CHAT_THEMES[_THEME_BY_STEM[t]]
    # Префиксный матч в обе стороны: «ссориться» начинается со «ссор»
    for stem, theme in _THEME_BY_STEM.items():
        if len(stem) < 3:
            continue
        if t.startswith(stem) or stem.startswith(t):
            return CHAT_THEMES[theme]
    return None


def get_theme_stems(name: str) -> list[str] | None:
    """Берёт стемы темы по имени (для синтаксиса тема:X)."""
    n = (name or "").lower().replace("ё", "е").strip()
    if not n:
        return None
    return CHAT_THEMES.get(n)


def _normalize_for_fts(s: str) -> str:
    """ё→е для совпадения с нормализованным FTS5 индексом."""
    return s.replace("ё", "е").replace("Ё", "Е")


def _build_fts_query(user_q: str, expand_identity: bool = True) -> str:
    """Превращает поисковый запрос пользователя в FTS5 syntax.

    Поддерживает:
      - обычные слова → префикс-матч AND (марин* AND лоб*)
      - "точная фраза" → phrase-match без префикса
      - -слово / -"фраза" → исключение (FTS5 NOT)
      - от:Марина / автор:Лир / author:X — фильтр по user_display
        (FTS5 column-targeted: {user_display}: phrase)
      - ё / Ё нормализуются в е/Е чтобы совпало с индексом
      - если expand_identity=True и слово/«фраза» однозначно совпадает с
        участником клана из clan_members — заменяется на OR-группу со
        всеми его известными именами (game_nick, vk_display, tg_username, ...).
        Это даёт «всё про Мелодьку» по любому из её имён.
    """
    positives: list[str] = []
    negatives: list[str] = []

    for raw in _FTS_TOK_RE.findall(user_q):
        negate = raw.startswith("-")
        if negate:
            raw = raw[1:]
        if not raw:
            continue

        column = None
        is_theme = False
        is_mention = False
        lower = raw.lower()
        for px in _AUTHOR_PREFIXES:
            if lower.startswith(px):
                column = "user_display"
                raw = raw[len(px):]
                break
        else:
            for px in _THEME_PREFIXES:
                if lower.startswith(px):
                    is_theme = True
                    raw = raw[len(px):]
                    break
            else:
                for px in _MENTION_PREFIXES:
                    if lower.startswith(px):
                        is_mention = True
                        raw = raw[len(px):]
                        break
        raw_clean = raw  # без normalize — для identity-резолва
        raw = _normalize_for_fts(raw).strip()
        if not raw:
            continue

        # Явный «тема:ссоры» → раскрываем в OR всех стемов темы.
        if is_theme:
            stems = get_theme_stems(raw_clean)
            if stems:
                phrase = _stems_to_fts_or(stems)
                (negatives if negate else positives).append(phrase)
                continue
            # Тема неизвестна — fallback на обычный поиск этого слова.

        # Фраза в кавычках — точное совпадение без префикса
        is_phrase = raw.startswith('"') and raw.endswith('"') and len(raw) >= 2
        if is_phrase:
            inner = raw[1:-1].replace('"', '')
            if not inner:
                continue
            base_phrase = f'"{inner}"'
            identity_seed = inner
        else:
            clean = raw.replace('"', '')
            if not clean:
                continue
            base_phrase = f'"{clean}"*'
            identity_seed = raw_clean.replace('"', '').rstrip('*')

        # «о:Мелодька» — упоминания человека В ТЕКСТАХ других пользователей.
        # Резолвим все варианты ника через identity и:
        #   1) Ищем любой вариант в тексте (OR-группа)
        #   2) Исключаем сообщения где автор сам этот человек.
        # Если человек не нашёлся — просто ищем по тексту как есть.
        if is_mention and not negate:
            try:
                variants = resolve_identity(identity_seed)
            except Exception:
                variants = []
            # Список всех вариантов имени (включая исходный seed).
            names = []
            seen = set()
            for v in [identity_seed] + variants:
                nv = (v or "").lower().replace("ё", "е").strip()
                if not nv or nv in seen:
                    continue
                seen.add(nv)
                safe = _normalize_for_fts(v).replace('"', '').strip()
                if safe:
                    names.append(safe)
            if not names:
                names = [_normalize_for_fts(identity_seed).replace('"', '').strip()]
            # OR-группа по содержимому в тексте (text-колонка)
            text_terms = []
            user_terms = []
            for n in names:
                if " " in n:
                    text_terms.append(f'text:"{n}"')
                    user_terms.append(f'user_display:"{n}"')
                else:
                    text_terms.append(f'text:"{n}"*')
                    user_terms.append(f'user_display:"{n}"*')
            mention_q = (
                "(" + " OR ".join(text_terms) + ")"
                + " NOT ("
                + " OR ".join(user_terms) + ")"
            )
            positives.append(mention_q)
            continue

        # Identity-расширение: только для позитивов, без явной column-spec
        # (от:Марина уже сужает колонку — двойное расширение не нужно),
        # НЕ для phrase (точная фраза — это точный запрос, не нужно ловить
        # ник «Помощь» когда ищем «нужна помощь»), и только для нетривиальных
        # длинных токенов (>=3 чтобы не расширять «я», «не», и т.п.).
        expanded = None
        if (expand_identity and not negate and column is None
                and not is_phrase
                and len(identity_seed.strip()) >= 3):
            try:
                variants = resolve_identity(identity_seed)
            except Exception:
                variants = []
            if variants:
                # Собираем OR-группу: основной токен + все имена-варианты
                # как user_display-таргетед (имена принадлежат автору, а
                # не тексту сообщения — это сильно режет шум).
                # FTS5 prefix-match `*` работает только на одном слове —
                # фразы с пробелом идут без префикса.
                phrases = [base_phrase]
                seen = {identity_seed.lower().replace("ё", "е")}
                for v in variants:
                    nv = v.lower().replace("ё", "е").strip()
                    if not nv or nv in seen:
                        continue
                    seen.add(nv)
                    safe = _normalize_for_fts(v).replace('"', '').strip()
                    if not safe:
                        continue
                    if " " in safe:
                        phrases.append(f'user_display:"{safe}"')
                    else:
                        phrases.append(f'user_display:"{safe}"*')
                expanded = "(" + " OR ".join(phrases) + ")"

        # Theme-расширение для обычных слов (не для column, не для фраз):
        # «ссориться» → "руга"* OR "ссор"* OR "конфликт"* … Срабатывает
        # только если identity-резолв не нашёл человека (имена приоритетнее).
        if (expand_identity and not negate and column is None
                and not is_phrase and expanded is None):
            stems = expand_theme(identity_seed)
            if stems:
                phrases = [base_phrase] + [_stems_to_fts_or(stems).strip("()").split(" OR ")[0]]
                # Полностью переходим к stem-OR с включением исходного токена
                base_or = _stems_to_fts_or(stems)
                expanded = "(" + base_phrase + " OR " + base_or.strip("()") + ")"

        if expanded:
            phrase = expanded
        elif column:
            phrase = f"{column}:{base_phrase}"
        else:
            phrase = base_phrase

        (negatives if negate else positives).append(phrase)

    if not positives:
        return '""'

    # Между позитивами явный AND: implicit-AND через пробел в FTS5
    # ломается когда соседствуют `column:"X"*` и OR-группа в скобках
    # (парсер не может однозначно разделить выражения колонки и фразы).
    pos = " AND ".join(positives)
    if negatives:
        return pos + " NOT (" + " OR ".join(negatives) + ")"
    return pos


# ── clan_members (зеркало для identity-резолва) ──────────────────────────

_MEMBER_FIELDS = (
    "key", "game_nick", "display_name", "vk_id", "vk_display",
    "vk_first", "vk_last", "vk_screen_name", "tg_id", "tg_display",
    "tg_username", "tg_first_name", "tg_last_name",
    # Аватарки в R2 (URL + timestamp последнего refresh) — заполняет
    # clan-reg-bot/refresh_avatars.py, если у бота настроены R2-креды.
    # Если не настроены — поля просто пустые, popover покажет плейсхолдер.
    "tg_avatar_url", "vk_avatar_url",
    "tg_avatar_updated", "vk_avatar_updated",
)


def bulk_sync_clan_members(members: list[dict]) -> dict:
    """Аддитивная синхронизация зеркала clan_members.json.

    Старые записи НЕ удаляются — это критично для архива: если человек
    вышел из обоих чатов и его удалили из clan_members.json, мы всё
    равно должны уметь резолвить его имя в архиве переписки. Иначе
    popover и identity-расширение перестали бы работать для бывших
    участников.

    Логика:
      1. ВСЕ существующие записи помечаются is_active=0.
      2. UPSERT каждой записи из payload (is_active=1, обновляются поля).
      3. Те, кого нет в payload, остаются с is_active=0 и старыми данными.

    members — список словарей в формате clan_members.json (см. clan-reg-bot).
    """
    now = datetime.utcnow().isoformat(timespec="seconds")
    rows = []
    for m in members:
        key = m.get("key") or f"{m.get('platform','x')}_{m.get('platform_id', 0)}"
        row = {f: "" for f in _MEMBER_FIELDS}
        row["key"] = str(key)
        for f in _MEMBER_FIELDS[1:]:
            v = m.get(f)
            if v is not None:
                row[f] = str(v)
        rows.append(row)

    with connection() as conn:
        # Шаг 1: все текущие помечаются «не в чате» как стартовая точка.
        conn.execute("UPDATE clan_members SET is_active = 0")
        # Шаг 2: UPSERT каждого из payload — снова активный, поля свежие.
        for r in rows:
            raw = json.dumps(
                _serialise({k: v for k, v in r.items() if k != "raw_json"}),
                ensure_ascii=False,
            )
            # COALESCE для avatar_url: если в payload пусто, а в БД
            # уже что-то лежит — сохраняем старую ссылку. Это нужно
            # потому что reconcile может пройти БЕЗ refresh_avatars
            # (например если R2 не настроен в .env clan-reg-bot) —
            # не теряем уже скачанные аватарки.
            conn.execute(
                """INSERT INTO clan_members
                   (key, game_nick, display_name, vk_id, vk_display,
                    vk_first, vk_last, vk_screen_name, tg_id, tg_display,
                    tg_username, tg_first_name, tg_last_name,
                    tg_avatar_url, vk_avatar_url,
                    tg_avatar_updated, vk_avatar_updated,
                    raw_json, synced_at, is_active, last_seen_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
                   ON CONFLICT(key) DO UPDATE SET
                     game_nick      = excluded.game_nick,
                     display_name   = excluded.display_name,
                     vk_id          = excluded.vk_id,
                     vk_display     = excluded.vk_display,
                     vk_first       = excluded.vk_first,
                     vk_last        = excluded.vk_last,
                     vk_screen_name = excluded.vk_screen_name,
                     tg_id          = excluded.tg_id,
                     tg_display     = excluded.tg_display,
                     tg_username    = excluded.tg_username,
                     tg_first_name  = excluded.tg_first_name,
                     tg_last_name   = excluded.tg_last_name,
                     tg_avatar_url  = CASE WHEN excluded.tg_avatar_url != ''
                                           THEN excluded.tg_avatar_url
                                           ELSE clan_members.tg_avatar_url END,
                     vk_avatar_url  = CASE WHEN excluded.vk_avatar_url != ''
                                           THEN excluded.vk_avatar_url
                                           ELSE clan_members.vk_avatar_url END,
                     tg_avatar_updated = CASE WHEN excluded.tg_avatar_updated != ''
                                              THEN excluded.tg_avatar_updated
                                              ELSE clan_members.tg_avatar_updated END,
                     vk_avatar_updated = CASE WHEN excluded.vk_avatar_updated != ''
                                              THEN excluded.vk_avatar_updated
                                              ELSE clan_members.vk_avatar_updated END,
                     raw_json       = excluded.raw_json,
                     synced_at      = excluded.synced_at,
                     is_active      = 1,
                     last_seen_at   = excluded.last_seen_at
                """,
                (r["key"], r["game_nick"], r["display_name"],
                 r["vk_id"], r["vk_display"], r["vk_first"], r["vk_last"],
                 r["vk_screen_name"],
                 r["tg_id"], r["tg_display"], r["tg_username"],
                 r["tg_first_name"], r["tg_last_name"],
                 r["tg_avatar_url"], r["vk_avatar_url"],
                 r["tg_avatar_updated"], r["vk_avatar_updated"],
                 raw, now, now),
            )
        # Статистика после операции
        active = conn.execute(
            "SELECT count(*) FROM clan_members WHERE is_active = 1"
        ).fetchone()[0]
        inactive = conn.execute(
            "SELECT count(*) FROM clan_members WHERE is_active = 0"
        ).fetchone()[0]
    return {"synced": len(rows), "active": active,
            "inactive": inactive, "at": now}


def backfill_chat_users() -> dict:
    """Перестроить chat_users из chat_messages. Используется один раз
    после миграции, когда таблица только что создана и пустая, а в
    chat_messages уже есть исторические записи."""
    with connection() as conn:
        conn.execute("DELETE FROM chat_users")
        # GROUP BY platform+user_id, агрегируем счётчик и первое/последнее
        rows = conn.execute(
            """SELECT
                 platform,
                 user_id,
                 MAX(user_display) AS display_name,
                 MAX(user_username) AS username,
                 MIN(sent_at) AS first_seen,
                 MAX(sent_at) AS last_seen,
                 COUNT(*) AS msg_count
               FROM chat_messages
               WHERE user_id != '' AND user_id != '0'
               GROUP BY platform, user_id
            """
        ).fetchall()
        for r in rows:
            conn.execute(
                """INSERT INTO chat_users
                   (platform, user_id, display_name, username,
                    first_seen, last_seen, msg_count)
                   VALUES (?,?,?,?,?,?,?)""",
                (r["platform"], r["user_id"],
                 (r["display_name"] or "")[:128],
                 (r["username"] or "")[:64],
                 r["first_seen"], r["last_seen"], r["msg_count"]),
            )
        n = conn.execute("SELECT count(*) FROM chat_users").fetchone()[0]
    return {"created": n}


def list_clan_members() -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM clan_members ORDER BY display_name"
        ).fetchall()
        return [dict(r) for r in rows]


def _member_name_variants(m: dict) -> list[str]:
    """Все известные имена-варианты одного человека для FTS5 OR-раскрытия.

    Для multi-word полей («Марина Лобачёва») возвращаем И полную форму,
    И отдельные слова (Марина, Лобачёва) длиной >=3 — иначе FTS не
    найдёт упоминание только по имени без фамилии или наоборот.
    @-префикс у usernames снимаем (его в реальных упоминаниях обычно нет).
    """
    out: set[str] = set()

    def add_with_split(v: str) -> None:
        v = (v or "").strip().lstrip("@").strip()
        if not v:
            return
        out.add(v)
        # Multi-word → отдельные слова (исключаем стоп-слова и короткое).
        if " " in v:
            for word in v.split():
                word = word.strip(",.;:!?@#-_/\\")
                # Стоп-слова чтобы не цеплять «Иван Я» → «Я».
                if len(word) >= 3 and word.lower() not in _NAME_STOPWORDS:
                    out.add(word)

    for f in ("display_name", "vk_display", "vk_first", "vk_last",
              "vk_screen_name", "tg_username", "tg_first_name",
              "tg_last_name", "tg_display"):
        add_with_split(m.get(f) or "")
    for nick in (m.get("game_nick") or "").split(","):
        add_with_split(nick)
    return sorted(out)


# Стоп-слова: служебные слова, склонения, инициалы, которые получаются
# при split многословных имён и которые нельзя использовать как имя
# (либо слишком общие, либо пусты по смыслу).
_NAME_STOPWORDS = {
    "ник", "имя", "тг", "вк", "tg", "vk", "id", "ид", "the", "and", "или",
    "из", "от", "на", "по", "не", "да", "ну", "же",
}


# Карта омоглифов «латиница → кириллица». Очень частая проблема:
# «Мелодькa» (с латинской `a` в конце), «Лирия!» с латинской `и` и т.п.
# Без этой нормализации FTS/identity не может сматчить «Мелодька» (кир)
# с «Мелодькa» (микс) в clan_members → identity-резолв возвращает пусто.
_HOMOGLYPHS_LAT2CYR = str.maketrans({
    "a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "y": "у", "x": "х",
    "i": "і", "k": "к", "m": "м", "h": "н", "t": "т", "b": "ь",
    "A": "А", "B": "В", "E": "Е", "H": "Н", "K": "К", "M": "М",
    "O": "О", "P": "Р", "C": "С", "T": "Т", "Y": "У", "X": "Х",
})


def _norm_name(s: str) -> str:
    """ё→е, lowercase, латинские омоглифы → кириллические."""
    return (s or "").strip().lower().replace("ё", "е").translate(_HOMOGLYPHS_LAT2CYR)


def resolve_identity_full(token: str) -> dict | None:
    """Найти автора по любому имени → вернуть профиль или None.

    Стратегия:
      1. Сначала ищем среди зарегистрированных (clan_members) — там
         полная инфа TG+VK сразу. Если нашли — возвращаем + registered=True.
      2. Если не нашли — fallback в chat_users (накопительная таблица всех
         кто хоть раз писал). Возвращаем что есть + registered=False.

    Так popover работает И для зарегистрированных через /reg, И просто для
    участников чата которые ничего не регистрировали.
    """
    t = _norm_name(token)
    if not t or len(t) < 2:
        return None

    # ── 1) clan_members (зарегистрированные) ──
    matched = []
    for m in list_clan_members():
        haystack: list[str] = []
        for f in ("display_name", "vk_display", "vk_first", "vk_last",
                  "vk_screen_name", "tg_username", "tg_first_name",
                  "tg_last_name", "tg_display"):
            v = (m.get(f) or "").strip()
            if v:
                haystack.append(_norm_name(v))
        for nick in (m.get("game_nick") or "").split(","):
            nick = _norm_name(nick)
            if nick:
                haystack.append(nick)
        for h in haystack:
            if t == h or (len(t) >= 3 and (t in h or h in t)):
                matched.append(m)
                break

    def _mark(m: dict, source: str) -> dict:
        out = dict(m)
        out["_source"] = source
        out["registered"] = (source == "clan_members")
        return out

    if len(matched) == 1:
        return _mark(matched[0], "clan_members")
    exact = []
    for m in matched:
        for f in _member_name_variants(m):
            if _norm_name(f) == t:
                exact.append(m)
                break
    if len(exact) == 1:
        return _mark(exact[0], "clan_members")

    # ── 2) chat_users (просто были в чате) ──
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_users WHERE "
            "lower(display_name) = ? OR lower(username) = ? OR user_id = ?",
            (t, t.lstrip("@"), token.strip()),
        ).fetchall()
        if not rows:
            # Substring match (минимум 3 символа чтобы не цеплять «я»/«не»)
            if len(t) >= 3:
                rows = conn.execute(
                    "SELECT * FROM chat_users WHERE "
                    "lower(display_name) LIKE ? OR lower(username) LIKE ? "
                    "ORDER BY msg_count DESC LIMIT 5",
                    (f"%{t}%", f"%{t}%"),
                ).fetchall()
        if len(rows) == 1:
            r = dict(rows[0])
            # Преобразуем chat_users → совместимый с clan_members popover
            out = {
                "display_name": r["display_name"],
                f"{r['platform']}_id": r["user_id"],
                f"{r['platform']}_display": r["display_name"],
                "_first_seen": r["first_seen"],
                "_last_seen": r["last_seen"],
                "_msg_count": r["msg_count"],
            }
            if r["username"]:
                if r["platform"] == "tg":
                    out["tg_username"] = r["username"]
                else:
                    out["vk_screen_name"] = r["username"]
            return _mark(out, "chat_users")
    return None


def resolve_identity(token: str) -> list[str]:
    """Найти участника клана по любому имени-варианту → вернуть все его
    известные имена. Возвращает [] если не нашли или нашли >1 (неоднозначно).

    Сравнение case-insensitive с ё→е fold + омоглифы латиницы → кириллицы
    (Мелодькa с latin-a в clan_members стал бы непомачимым с «Мелодька»
    кириллицей в запросе без этой нормализации).
    Для одной находки удобно сразу подставить — для нескольких слишком
    рискованно (можно зацепить чужого).
    """
    t = _norm_name(token)
    if not t or len(t) < 2:
        return []
    matched = []
    members = list_clan_members()
    for m in members:
        # game_nick может быть запятая-список — проверяем каждый ник отдельно
        haystack: list[str] = []
        for f in ("display_name", "vk_display", "vk_first", "vk_last",
                  "vk_screen_name", "tg_username", "tg_first_name",
                  "tg_last_name", "tg_display"):
            v = (m.get(f) or "").strip()
            if v:
                haystack.append(_norm_name(v))
        for nick in (m.get("game_nick") or "").split(","):
            nick = _norm_name(nick)
            if nick:
                haystack.append(nick)
        for h in haystack:
            if t == h or (len(t) >= 3 and (t in h or h in t)):
                matched.append(m)
                break
    # Если запрос точно совпал ровно с одним человеком — берём его.
    # Substring может зацепить нескольких — лучше не расширять чтобы
    # не давать чужие результаты.
    if len(matched) == 1:
        return _member_name_variants(matched[0])
    # Если несколько кандидатов — попробуем сузить до тех у кого совпадение
    # ровно равно (без substring).
    exact = []
    for m in matched:
        for f in _member_name_variants(m):
            if _norm_name(f) == t:
                exact.append(m)
                break
    if len(exact) == 1:
        return _member_name_variants(exact[0])
    return []


def delete_chat_message(msg_id: int) -> bool:
    """Удалить одно сообщение из архива. True если запись существовала."""
    with connection() as conn:
        cur = conn.execute("DELETE FROM chat_messages WHERE id = ?", (msg_id,))
        return cur.rowcount > 0


def clear_chat_archive() -> int:
    """Удалить весь архив. Возвращает кол-во удалённых сообщений.
    Также пересоздаёт FTS5 индекс — после массового DELETE он может
    остаться раздутым."""
    with connection() as conn:
        n = conn.execute("SELECT count(*) FROM chat_messages").fetchone()[0]
        conn.execute("DELETE FROM chat_messages")
        # rebuild FTS5 чтобы убрать tombstones
        conn.execute("INSERT INTO chat_messages_fts(chat_messages_fts) "
                     "VALUES ('rebuild')")
        return n


# ── media dedup ──────────────────────────────────────────────────────────

def dedup_lookup(kind: str, key: str) -> dict[str, Any] | None:
    """Найти уже залитое в R2 медиа. Возвращает запись или None.
    При попадании инкрементируется hit_count и обновляется last_seen."""
    if not kind or not key:
        return None
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM media_dedup WHERE kind = ? AND key = ?",
            (kind, key),
        ).fetchone()
        if not row:
            return None
        # bump stats
        now = datetime.utcnow().isoformat(timespec="seconds")
        conn.execute(
            "UPDATE media_dedup SET hit_count = hit_count + 1, last_seen = ? "
            "WHERE id = ?",
            (now, row["id"]),
        )
        return dict(row)


def dedup_record(*, kind: str, key: str, r2_url: str, r2_key: str,
                 mime: str = "", size: int = 0, media_kind: str = "",
                 width: int = 0, height: int = 0) -> dict[str, Any]:
    """Записать дедуп. Если запись уже есть (race condition) — bump hit_count."""
    if not kind or not key or not r2_url:
        raise ValueError("kind, key, r2_url обязательны")
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            """INSERT INTO media_dedup
               (kind, key, r2_url, r2_key, mime, size, media_kind,
                width, height, first_seen, last_seen, hit_count)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
               ON CONFLICT(kind, key) DO UPDATE SET
                 hit_count = hit_count + 1,
                 last_seen = excluded.last_seen""",
            (kind, key, r2_url, r2_key, mime, size, media_kind,
             width, height, now, now),
        )
        row = conn.execute(
            "SELECT id, hit_count FROM media_dedup WHERE kind = ? AND key = ?",
            (kind, key),
        ).fetchone()
    return {"id": row["id"], "hit_count": row["hit_count"]}


def dedup_stats() -> dict[str, Any]:
    """Сводка для UI/мониторинга."""
    with connection() as conn:
        total = conn.execute(
            "SELECT count(*) FROM media_dedup"
        ).fetchone()[0]
        by_kind = {}
        for r in conn.execute(
            "SELECT kind, count(*) AS n, sum(hit_count) AS hits "
            "FROM media_dedup GROUP BY kind"
        ):
            by_kind[r["kind"]] = {"unique": r["n"], "hits": r["hits"]}
        saved = conn.execute(
            "SELECT sum(size * (hit_count - 1)) FROM media_dedup"
        ).fetchone()[0] or 0
    return {"total_unique": total, "by_kind": by_kind,
            "bytes_saved_via_dedup": int(saved)}


# Минимальный объём суммарной активности чтобы тренд считался «надёжным».
# При очень малых выборках (1-3 сообщения за пол-периода) percentage даёт
# ложное ощущение тренда — лучше показать «недостаточно данных».
_TREND_NOISE_FLOOR = 3
# Порог R² для определения значимости тренда. Если R² < 0.15 —
# активность скачет хаотично, slope не показателен → trend = "flat".
_R2_SIGNIFICANCE = 0.15


def _linear_regression(counts: list[int]) -> tuple[float, float]:
    """OLS slope + R² через все точки серии.

    slope — наклон линии least-squares fit (y = a + slope*x), где x
    это индекс периода 0..n-1. R² — насколько хорошо данные ложатся
    на эту линию (0..1).

    Возвращает (slope, r_squared). Для n<2 или нулевой дисперсии x — (0, 0).
    """
    n = len(counts)
    if n < 2:
        return 0.0, 0.0
    xs = list(range(n))
    x_mean = sum(xs) / n
    y_mean = sum(counts) / n
    sxx = sum((x - x_mean) ** 2 for x in xs)
    sxy = sum((xs[i] - x_mean) * (counts[i] - y_mean) for i in range(n))
    syy = sum((y - y_mean) ** 2 for y in counts)
    if sxx == 0:
        return 0.0, 0.0
    slope = sxy / sxx
    if syy == 0:
        r2 = 0.0
    else:
        r2 = (sxy * sxy) / (sxx * syy)
    return slope, r2


def _primary_display_name(m: dict) -> str:
    """Имя участника для UI с приоритетом ИГРОВОГО ника.

    Логика:
      1. game_nick (первый из через запятую) — основной приоритет, потому
         что в клане людей знают по игровым именам, а не по @username.
      2. display_name (если задан вручную в clan-reg-bot/GUI).
      3. VK display (если есть TG-only — будет пусто).
      4. TG display / username.
      5. ключ записи как последний fallback.
    """
    gn = (m.get("game_nick") or "").strip()
    if gn:
        # game_nick может быть «Мелодькa, БорЩиК» — берём первый ник.
        first = gn.split(",")[0].strip()
        if first:
            return first
    for f in ("display_name", "vk_display", "tg_display",
              "tg_username", "vk_screen_name"):
        v = (m.get(f) or "").strip()
        if v:
            return v
    return m.get("key") or "(без имени)"


def _compute_trend(counts: list[int]) -> dict[str, Any]:
    """Тренд активности по всему периоду.

    Использует ДВЕ метрики:
      1. Linear regression slope — наклон линии через все точки.
         Менее чувствителен к выбросам в крайних точках чем half-vs-half,
         и реально отражает рост/падение на колеблющейся активности.
      2. PoP (period-over-period): половина первая vs последняя —
         даёт «человеческий» % сравнения для tooltip.

    direction формируется по slope + R²:
      slope > 0 и R² >= 0.15 → up
      slope < 0 и R² >= 0.15 → down
      R² < 0.15              → flat (шум, нет статистически значимого
                                     тренда несмотря на любой slope)
      Особые случаи:
        first=0, second>0 → new (новичок)
        first>0, second=0 → dead (был активен, перестал)
        total=0           → null (никогда не писал)
        total<3           → flat (выборка слишком мала)

    pct в результате — это PoP %: (second_half - first_half)/first_half * 100.
    slope_pct — % изменения PER ПЕРИОД относительно среднего значения
              (т.е. сколько в среднем растёт/падает между соседними
              периодами в % от typical активности).
    """
    n = len(counts or [])
    if n < 2:
        return {"first_half": 0, "second_half": 0,
                "pct": None, "slope_pct": None, "r_squared": None,
                "direction": None}
    mid = n // 2
    first = sum(counts[:mid])
    second = sum(counts[mid:])
    total = first + second
    if total == 0:
        return {"first_half": 0, "second_half": 0,
                "pct": None, "slope_pct": None, "r_squared": None,
                "direction": None}
    if total < _TREND_NOISE_FLOOR:
        return {"first_half": first, "second_half": second,
                "pct": 0, "slope_pct": 0, "r_squared": 0,
                "direction": "flat"}
    # Linear regression — основной метод
    slope, r2 = _linear_regression(counts)
    mean_y = total / n
    # slope_pct: за период slope сообщений / mean = ~%/период
    slope_pct = (slope / mean_y * 100.0) if mean_y > 0 else 0.0
    # PoP для отображения
    if second == 0 and first > 0:
        direction = "dead"
        pct = -100.0
    elif first == 0 and second > 0:
        direction = "new"
        pct = None  # бесконечность
    else:
        pct = (second - first) / first * 100.0
        # direction по slope+R² — статистически более правильно
        if r2 < _R2_SIGNIFICANCE:
            direction = "flat"
        elif slope > 0:
            direction = "up"
        elif slope < 0:
            direction = "down"
        else:
            direction = "flat"
    # Recent trend — последние ~25% периодов vs предыдущие ~25%.
    # Это критично: общий тренд может быть «up» из-за роста месяц
    # назад, а ПРЯМО СЕЙЧАС активность падает. Помогает поймать
    # ранние сигналы угасания которые тонут в долгом среднем.
    #
    # Адаптивный размер окна:
    #   day-granularity   (n≈60-90):  окно 15-22 дня
    #   week-granularity  (n≈10-12):  окно 2-3 недели
    #   month-granularity (n≈3-12):   окно 1-3 месяца (MoM при малом n)
    #   year-granularity  (n≈1-3):    обычно отключено (n<3)
    # Минимум 1 точка чтобы для month/quarter был MoM/QoQ.
    recent_pct = None
    recent_dir = None
    recent_n = max(1, n // 4)
    # n>=3 чтобы и overall (first half + second half) и recent (последние
    # N + предыдущие N) имели разные точки. При n=2 recent просто
    # повторил бы overall PoP.
    if n >= 3 and n >= recent_n * 2:
        recent  = sum(counts[-recent_n:])
        prev    = sum(counts[-2 * recent_n:-recent_n])
        if recent == 0 and prev == 0:
            recent_dir = "flat"
            recent_pct = 0
        elif prev == 0 and recent > 0:
            recent_dir = "new"
            recent_pct = None
        elif recent == 0 and prev > 0:
            recent_dir = "dead"
            recent_pct = -100.0
        else:
            recent_pct = (recent - prev) / prev * 100.0
            if recent_pct > 5:    recent_dir = "up"
            elif recent_pct < -5: recent_dir = "down"
            else:                 recent_dir = "flat"

    return {
        "first_half": first,
        "second_half": second,
        "pct": None if pct is None else round(pct, 1),
        "slope_pct": round(slope_pct, 1),
        "r_squared": round(r2, 3),
        "direction": direction,
        "recent_pct": None if recent_pct is None else round(recent_pct, 1),
        "recent_direction": recent_dir,
        "recent_window": recent_n,
    }


def members_activity_timeline(
    granularity: str = "week",
    chat_group: str | None = None,
    include_inactive: bool = True,
) -> dict[str, Any]:
    """Гистограмма сообщений каждого участника clan_members по периодам.

    granularity:
      day   — %Y-%m-%d  (для последних 1-3 месяцев, иначе слишком много точек)
      week  — %Y-%W     (по умолчанию, для года-двух)
      month — %Y-%m     (для всей истории клана)
      year  — %Y

    chat_group:
      None       — оба чата суммарно (default)
      "general"  — только общий чат
      "officers" — только офицерский

    Возвращает {
      granularity, chat_group, periods (отсортированы ASC),
      series: [{key, name, total, counts, trend}],
      overall: {total, counts, trend}
    }
    """
    g = (granularity or "week").lower()
    fmt = {
        "day":   "%Y-%m-%d",
        "week":  "%Y-W%W",
        "month": "%Y-%m",
        "year":  "%Y",
    }.get(g, "%Y-W%W")

    where = ""
    params: list[Any] = []
    if chat_group:
        if chat_group not in CHAT_GROUPS:
            raise ValueError(f"invalid chat_group: {chat_group!r}")
        where = "WHERE chat_group = ?"
        params.append(chat_group)

    with connection() as conn:
        # Все периоды сразу с user_id+platform
        rows = list(conn.execute(
            f"""SELECT strftime('{fmt}', sent_at) AS period,
                       platform, user_id, COUNT(*) AS n
                FROM chat_messages
                {where}
                GROUP BY period, platform, user_id""",
            params,
        ))

    # Собираем все периоды (отсортированно)
    periods = sorted({r["period"] for r in rows if r["period"]})
    period_idx = {p: i for i, p in enumerate(periods)}

    # Считаем по (platform, user_id)
    from collections import defaultdict
    per_user: dict[tuple[str, str], list[int]] = defaultdict(
        lambda: [0] * len(periods)
    )
    for r in rows:
        p = r["period"]
        if not p:
            continue
        per_user[(r["platform"], str(r["user_id"]))][period_idx[p]] += r["n"]

    # Сводим к clan_members
    members = list_clan_members()
    skip_fields = {"key", "raw_json", "synced_at"}
    series: list[dict[str, Any]] = []

    for m in members:
        tg_id = (m.get("tg_id") or "").strip()
        vk_id = (m.get("vk_id") or "").strip()
        counts = [0] * len(periods)
        for key in (("tg", tg_id), ("vk", vk_id)):
            if not key[1]:
                continue
            src = per_user.get(key)
            if not src:
                continue
            for i, v in enumerate(src):
                counts[i] += v
        total = sum(counts)
        if total == 0:
            continue   # «тихих» в график не выводим
        is_active = bool(m.get("is_active", 1))
        if not include_inactive and not is_active:
            continue
        name = _primary_display_name(m)
        series.append({
            "key": m["key"],
            "name": name,
            "total": total,
            "counts": counts,
            "is_active": is_active,
            "unregistered": False,
        })

    # ── Незарегистрированные в таймлайне ──
    # Те (platform, user_id) что есть в per_user но не привязаны ни к
    # одной clan_members записи. При регистрации (bulk_sync) автоматически
    # переедут в зарегистрированных без потери истории.
    known_keys: set[tuple[str, str]] = set()
    for m in members:
        if m.get("tg_id"): known_keys.add(("tg", str(m["tg_id"])))
        if m.get("vk_id"): known_keys.add(("vk", str(m["vk_id"])))

    with connection() as conn:
        user_lookup = {
            (r["platform"], r["user_id"]): (r["display_name"], r["username"])
            for r in conn.execute(
                "SELECT platform, user_id, display_name, username FROM chat_users"
            )
        }

    for (platform, user_id), counts in per_user.items():
        if (platform, user_id) in known_keys:
            continue
        if not user_id or user_id in ("0", "None"):
            continue
        total = sum(counts)
        if total == 0:
            continue
        disp, uname = user_lookup.get((platform, user_id), ("", ""))
        if not disp and not uname:
            continue
        # is_active = True (пишут активно) — фильтр include_inactive их не
        # касается, он только про clan_members.is_active.
        name = (disp or uname or f"{platform} id {user_id}")
        series.append({
            "key":          f"unreg_{platform}_{user_id}",
            "name":         name,
            "total":        total,
            "counts":       list(counts),
            "is_active":    True,
            "unregistered": True,
        })

    # Тренд per-user (по тем периодам что прислали)
    for s in series:
        s["trend"] = _compute_trend(s["counts"])

    # Сортируем по total DESC чтобы топ-активные сразу попали в default-выборку
    series.sort(key=lambda s: -s["total"])

    # Общий тренд клана: суммируем counts по всем сериям, считаем trend
    total_counts = [0] * len(periods)
    for s in series:
        for i, c in enumerate(s["counts"]):
            total_counts[i] += c
    overall = {
        "total":  sum(total_counts),
        "counts": total_counts,
        "trend":  _compute_trend(total_counts),
    }

    # Счётчик ушедших — для UI (даже если они исключены параметром
    # include_inactive=False, фронт хочет показать «скрыто N»).
    n_left_total = sum(1 for m in members
                       if not bool(m.get("is_active", 1)))
    return {
        "granularity": g,
        "chat_group": chat_group,
        "periods": periods,
        "series": series,
        "overall": overall,
        "inactive_count": n_left_total,
    }


def list_members_activity() -> list[dict[str, Any]]:
    """Список всех зарегистрированных участников клана + их активность в
    архиве: сколько сообщений (общий/офицерский), символов, медиа,
    первое/последнее сообщение и гистограмма по неделям за 12 недель.

    Один человек обычно есть и в TG (tg_id), и в VK (vk_id). Сумма по
    обоим. Если оба ID пустые — статистика 0.
    """
    from datetime import datetime, timedelta
    WEEKS = 12

    with connection() as conn:
        # Считаем активность сразу одним проходом по chat_messages,
        # без N+1. Индекс idx_chat_platform_user делает это быстро.
        rows = list(conn.execute(
            "SELECT platform, user_id, chat_group, sent_at, text, media_json "
            "FROM chat_messages"
        ))

        # Группируем по (platform, user_id)
        from collections import defaultdict
        per_user: dict[tuple[str, str], dict] = defaultdict(
            lambda: {"msgs": 0, "msgs_general": 0, "msgs_officers": 0,
                     "chars": 0, "media": 0,
                     "first_seen": None, "last_seen": None,
                     "weeks": [0] * WEEKS})
        now = datetime.utcnow()
        week_zero = now - timedelta(weeks=WEEKS)
        week_zero_iso = week_zero.strftime("%Y-%m-%dT%H:%M:%S")

        for r in rows:
            key = (r["platform"], str(r["user_id"]))
            p = per_user[key]
            p["msgs"] += 1
            if r["chat_group"] == "general":
                p["msgs_general"] += 1
            elif r["chat_group"] == "officers":
                p["msgs_officers"] += 1
            p["chars"] += len(r["text"] or "")
            if r["media_json"] not in ("", "[]"):
                p["media"] += 1
            sa = r["sent_at"]
            if p["first_seen"] is None or sa < p["first_seen"]:
                p["first_seen"] = sa
            if p["last_seen"] is None or sa > p["last_seen"]:
                p["last_seen"] = sa
            # Histogram по неделям
            if sa >= week_zero_iso:
                try:
                    dt = datetime.fromisoformat(sa)
                    days = (dt - week_zero).days
                    if 0 <= days < WEEKS * 7:
                        p["weeks"][days // 7] += 1
                except Exception:
                    pass

        # Теперь идём по clan_members
        out: list[dict[str, Any]] = []
        members = list_clan_members()
        skip_fields = {"key", "raw_json", "synced_at"}

        for m in members:
            tg_id = (m.get("tg_id") or "").strip()
            vk_id = (m.get("vk_id") or "").strip()

            agg = {"msgs": 0, "msgs_general": 0, "msgs_officers": 0,
                   "chars": 0, "media": 0,
                   "first_seen": None, "last_seen": None,
                   "weeks": [0] * WEEKS}

            for key in (("tg", tg_id), ("vk", vk_id)):
                if not key[1]:
                    continue
                src = per_user.get(key)
                if not src:
                    continue
                agg["msgs"]          += src["msgs"]
                agg["msgs_general"]  += src["msgs_general"]
                agg["msgs_officers"] += src["msgs_officers"]
                agg["chars"]         += src["chars"]
                agg["media"]         += src["media"]
                for i in range(WEEKS):
                    agg["weeks"][i] += src["weeks"][i]
                if src["first_seen"] and (agg["first_seen"] is None
                                          or src["first_seen"] < agg["first_seen"]):
                    agg["first_seen"] = src["first_seen"]
                if src["last_seen"] and (agg["last_seen"] is None
                                         or src["last_seen"] > agg["last_seen"]):
                    agg["last_seen"] = src["last_seen"]

            # Тренд за последние 12 недель: первая половина vs вторая.
            agg["trend"] = _compute_trend(agg["weeks"])
            # is_active НЕ фильтруем: 0 это значимое значение «ушёл»,
            # фронт должен видеть факт чтобы поставить бейдж.
            profile = {k: v for k, v in m.items()
                       if k not in skip_fields
                       and (k == "is_active"
                            or v not in (None, "", 0, "0"))}
            out.append({
                "key":          m["key"],
                "profile":      profile,
                "stats":        agg,
                "is_active":    bool(m.get("is_active", 1)),
                "unregistered": False,
            })

        # ── Незарегистрированные ──
        # Те (platform, user_id) что есть в per_user, но не сматчились ни
        # с одним tg_id/vk_id в clan_members. Это люди которые активно
        # пишут в чатах но через /reg не проходили. Берём имя из
        # chat_users (last_seen display/username); если человека там нет —
        # пропускаем. Когда он зарегистрируется через бота — clan_members
        # пополнится, его (platform, user_id) сматчится с одной из
        # записей выше, и unregistered-строка исчезнет автоматически
        # (statistика та же — суммируется по user_id, не по member.key).
        known_keys: set[tuple[str, str]] = set()
        for m in members:
            if m.get("tg_id"): known_keys.add(("tg", str(m["tg_id"])))
            if m.get("vk_id"): known_keys.add(("vk", str(m["vk_id"])))

        # Один SQL для всех display'ев в chat_users — N+1 не нужен.
        with connection() as conn:
            user_lookup = {
                (r["platform"], r["user_id"]): (r["display_name"], r["username"])
                for r in conn.execute(
                    "SELECT platform, user_id, display_name, username "
                    "FROM chat_users"
                )
            }

        for (platform, user_id), src in per_user.items():
            if (platform, user_id) in known_keys:
                continue
            # Сообщения с user_id='0' (потеря id в старом backfill) —
            # не имеет смысла показывать как отдельного человека.
            if not user_id or user_id in ("0", "None"):
                continue
            disp, uname = user_lookup.get((platform, user_id), ("", ""))
            if not disp and not uname:
                # Не нашли в chat_users — может это совсем старая запись.
                # Не показываем, иначе будут безымянные «id 123456789».
                continue
            agg = {
                "msgs":          src["msgs"],
                "msgs_general":  src["msgs_general"],
                "msgs_officers": src["msgs_officers"],
                "chars":         src["chars"],
                "media":         src["media"],
                "first_seen":    src["first_seen"],
                "last_seen":     src["last_seen"],
                "weeks":         list(src["weeks"]),
            }
            agg["trend"] = _compute_trend(agg["weeks"])
            profile = {
                "display_name": disp or uname or f"{platform} id {user_id}",
                f"{platform}_id":         user_id,
            }
            if platform == "tg" and uname:
                profile["tg_username"] = uname
            if platform == "vk" and uname:
                profile["vk_screen_name"] = uname
            out.append({
                "key":          f"unreg_{platform}_{user_id}",
                "profile":      profile,
                "stats":        agg,
                "is_active":    True,
                "unregistered": True,
            })

        # Сортируем по убыванию количества сообщений.
        out.sort(key=lambda x: -x["stats"]["msgs"])
        return out


def members_activity_meta() -> dict[str, int]:
    """Сводка по статусам участников clan_members для UI-фильтров."""
    with connection() as conn:
        n_active = conn.execute(
            "SELECT count(*) FROM clan_members WHERE is_active = 1"
        ).fetchone()[0]
        n_left = conn.execute(
            "SELECT count(*) FROM clan_members WHERE is_active = 0"
        ).fetchone()[0]
    return {"active": n_active, "left": n_left, "total": n_active + n_left}


def list_backfill_targets(
    *, platform: str | None = None,
    chat_group: str | None = None,
    limit: int = 200,
    before_id: int | None = None,
) -> list[dict[str, Any]]:
    """Сообщения с media БЕЗ R2-URL — кандидаты на бэкфилл.

    Кандидат = media_json содержит хотя бы один элемент с пустым url
    (и kind != 'wall' / 'link' — это нечего качать).
    Сортировка id DESC чтобы курсорно идти к более старым.
    """
    where = ["media_json NOT IN ('','[]')"]
    params: list[Any] = []
    if platform:
        where.append("platform = ?"); params.append(platform)
    if chat_group:
        where.append("chat_group = ?"); params.append(chat_group)
    if before_id is not None:
        where.append("id < ?"); params.append(int(before_id))
    sql = f"""SELECT id, chat_group, platform, chat_id, message_id,
                     user_id, user_display, text, media_json, sent_at
              FROM chat_messages
              WHERE {' AND '.join(where)}
              ORDER BY id DESC
              LIMIT ?"""
    params.append(int(limit))
    out: list[dict[str, Any]] = []
    with connection() as conn:
        for r in conn.execute(sql, params):
            try:
                media = json.loads(r["media_json"])
            except Exception:
                media = []
            # фильтр: оставляем только те где есть пустой url у качаемого медиа
            need = [m for m in media
                    if isinstance(m, dict) and not (m.get("url") or "")
                    and (m.get("kind") or "") not in
                        ("", "text", "wall", "link", "unknown")]
            if not need:
                continue
            out.append({
                "id": r["id"],
                "chat_group": r["chat_group"],
                "platform": r["platform"],
                "chat_id": r["chat_id"],
                "message_id": r["message_id"],
                "user_id": r["user_id"],
                "user_display": r["user_display"],
                "text": r["text"][:120],
                "media": media,
                "sent_at": r["sent_at"],
            })
    return out


def update_chat_message_media(msg_id: int,
                              media: list[dict[str, Any]]) -> bool:
    """Перезаписать media_json одной записи (для backfill).
    Возвращает True если запись существовала."""
    media_json = json.dumps(media or [], ensure_ascii=False)
    with connection() as conn:
        cur = conn.execute(
            "UPDATE chat_messages SET media_json = ? WHERE id = ?",
            (media_json, int(msg_id)),
        )
        return cur.rowcount > 0


def chat_archive_stats() -> dict[str, Any]:
    """Сводка для UI и админ-страницы."""
    with connection() as conn:
        total = conn.execute(
            "SELECT count(*) FROM chat_messages"
        ).fetchone()[0]
        by_group = {}
        for g in CHAT_GROUPS:
            by_group[g] = conn.execute(
                "SELECT count(*) FROM chat_messages WHERE chat_group = ?", (g,)
            ).fetchone()[0]
        first_last = conn.execute(
            "SELECT MIN(sent_at) AS first, MAX(sent_at) AS last FROM chat_messages"
        ).fetchone()
        return {
            "total": total,
            "by_group": by_group,
            "first_at": first_last["first"],
            "last_at": first_last["last"],
        }


def _serialise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(x) for x in obj]
    if isinstance(obj, sqlite3.Row):
        return {k: obj[k] for k in obj.keys()}
    return obj


# ═══════ Доблесть (pw-valor-tracker) ════════════════════════════════════
# Canon ника — для join'а history. Простая нормализация: lower + strip
# whitespace + удаление пунктуации. Полный homoglyph-replace делается на
# стороне десктоп-приложения; здесь мы доверяем что nick уже нормализован
# в эталон через nick_registry.
def _valor_canon(nick: str) -> str:
    import re
    s = (nick or "").strip().lower()
    return re.sub(r"[\s\W_]+", "", s, flags=re.UNICODE)


# Какие поля валидно отслеживать в valor_history
_HIST_FIELDS = ("rank", "title", "level", "class")


def valor_save_snapshot(
    *,
    week: str,
    valor_norm: int,
    members: list[dict],
    screens_count: int = 0,
    notes: str = "",
) -> dict[str, Any]:
    """Сохраняет недельный снапшот. Если запись на эту неделю уже есть
    — REPLACE (старые valor_members удаляются каскадом).

    members — список dict из CSV/desktop с полями nick, true_name, rank,
    title, level, class_, valor, is_afk, flag_new_nick, flag_ocr_suspect,
    norm_met.

    Возвращает {snapshot_id, members, history_added}.
    """
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        # ── 1. Prev-snapshot для streak'а warning_count + departed ──
        prev_snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week < ? "
            "ORDER BY week DESC LIMIT 1",
            (week,)
        ).fetchone()
        prev_warnings: dict[str, int] = {}
        prev_canons: set[str] = set()
        prev_snapshot_data: dict[str, dict] = {}  # canon → row dict
        if prev_snap:
            for r in conn.execute(
                """SELECT nick, nick_canon, true_name, rank, title, level,
                          class_, valor, warning_count
                   FROM valor_members WHERE snapshot_id = ?""",
                (prev_snap["id"],)
            ):
                cn = r["nick_canon"]
                prev_canons.add(cn)
                prev_warnings[cn] = r["warning_count"] or 0
                prev_snapshot_data[cn] = dict(r)

        # ── 2. REPLACE snapshot на эту неделю (если уже был) ──
        old = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)
        ).fetchone()
        if old:
            conn.execute(
                "DELETE FROM valor_snapshots WHERE id = ?", (old["id"],)
            )

        cur = conn.execute(
            """INSERT INTO valor_snapshots
               (week, captured_at, valor_norm, screens_count,
                members_count, notes)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (week, now, int(valor_norm), int(screens_count),
             len(members), notes),
        )
        snap_id = cur.lastrowid

        # ── 3. Вставляем участников с расчётом warning_count ──
        current_canons: set[str] = set()
        for m in members:
            nick = (m.get("nick") or "").strip()
            if not nick:
                continue
            cls = m.get("class_") or m.get("class") or ""
            canon = _valor_canon(nick)
            current_canons.add(canon)

            is_afk = bool(m.get("is_afk"))
            norm_met_raw = m.get("norm_met")
            # Streak warning_count:
            #   выполнил норматив или АФК → 0 (сброс)
            #   не выполнил → prev_warnings[canon] + 1
            #   нет prev → если не выполнил → 1, иначе 0
            if is_afk or norm_met_raw is True:
                warning_count = 0
            else:
                warning_count = prev_warnings.get(canon, 0) + 1

            conn.execute(
                """INSERT INTO valor_members
                   (snapshot_id, nick, nick_canon, true_name, rank, title,
                    level, class_, valor, is_afk, norm_met,
                    flag_new_nick, flag_ocr_suspect, warning_count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    snap_id,
                    nick,
                    canon,
                    (m.get("true_name") or "").strip(),
                    (m.get("rank") or "").strip(),
                    (m.get("title") or "").strip(),
                    m.get("level") if isinstance(m.get("level"), int) else None,
                    cls.strip(),
                    m.get("valor") if isinstance(m.get("valor"), int) else None,
                    1 if is_afk else 0,
                    None if norm_met_raw is None
                    else (1 if norm_met_raw else 0),
                    1 if m.get("flag_new_nick") else 0,
                    1 if m.get("flag_ocr_suspect") else 0,
                    warning_count,
                ),
            )

        # ── 4. Departed / Returned ──
        # Кто был в prev_canons но НЕ в current_canons — ушёл из клана.
        # Снимаем последние известные данные и кладём в valor_departed.
        departed_now = prev_canons - current_canons
        for cn in departed_now:
            row = prev_snapshot_data.get(cn)
            if not row:
                continue
            conn.execute(
                """INSERT INTO valor_departed
                   (nick_canon, nick, true_name, last_week, last_rank,
                    last_title, last_level, last_class, last_valor,
                    warning_count, departed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(nick_canon) DO UPDATE SET
                     nick          = excluded.nick,
                     true_name     = excluded.true_name,
                     last_week     = excluded.last_week,
                     last_rank     = excluded.last_rank,
                     last_title    = excluded.last_title,
                     last_level    = excluded.last_level,
                     last_class    = excluded.last_class,
                     last_valor    = excluded.last_valor,
                     warning_count = excluded.warning_count,
                     departed_at   = excluded.departed_at
                """,
                (
                    cn,
                    row["nick"],
                    row.get("true_name", "") or "",
                    # last_week — это prev_snap week
                    conn.execute(
                        "SELECT week FROM valor_snapshots WHERE id = ?",
                        (prev_snap["id"],),
                    ).fetchone()["week"],
                    row.get("rank", "") or "",
                    row.get("title", "") or "",
                    row.get("level"),
                    row.get("class_", "") or "",
                    row.get("valor"),
                    row.get("warning_count", 0) or 0,
                    now,
                ),
            )
        # Returned: кто появился в current и был в valor_departed → удалим
        # из архива.
        returned = 0
        for cn in current_canons:
            cur_del = conn.execute(
                "DELETE FROM valor_departed WHERE nick_canon = ?", (cn,)
            )
            returned += cur_del.rowcount or 0

        # История: для каждого поля сравниваем с последней записью на
        # этого ника. Если значение поменялось — добавляем строку.
        history_added = 0
        for m in members:
            nick = (m.get("nick") or "").strip()
            if not nick:
                continue
            canon = _valor_canon(nick)
            for fld in _HIST_FIELDS:
                if fld == "class":
                    val = (m.get("class_") or m.get("class") or "").strip()
                elif fld == "level":
                    raw = m.get("level")
                    val = str(raw) if isinstance(raw, int) else ""
                else:
                    val = (m.get(fld) or "").strip()
                # Последнее значение для этого ника+поля
                prev = conn.execute(
                    """SELECT value FROM valor_history
                       WHERE nick_canon = ? AND field = ?
                       ORDER BY week DESC LIMIT 1""",
                    (canon, fld),
                ).fetchone()
                if prev is None or prev["value"] != val:
                    conn.execute(
                        """INSERT INTO valor_history
                           (nick_canon, field, value, week, captured_at)
                           VALUES (?, ?, ?, ?, ?)""",
                        (canon, fld, val, week, now),
                    )
                    history_added += 1

    return {
        "snapshot_id": snap_id,
        "members": len(members),
        "history_added": history_added,
        "departed_added": len(departed_now),
        "returned": returned,
    }


def valor_get_departed() -> list[dict[str, Any]]:
    """Список ушедших из клана с последними известными данными."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM valor_departed ORDER BY departed_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def valor_get_current() -> dict[str, Any]:
    """Самый свежий снапшот + все его участники + тренд vs предыдущий
    снапшот (если есть)."""
    with connection() as conn:
        snaps = conn.execute(
            "SELECT * FROM valor_snapshots ORDER BY week DESC LIMIT 2"
        ).fetchall()
        if not snaps:
            return {"snapshot": None, "previous_week": None, "members": []}
        cur = snaps[0]
        prev = snaps[1] if len(snaps) >= 2 else None
        # Предыдущая доблесть по canon — для расчёта тренда (delta + %).
        prev_valor: dict[str, int | None] = {}
        if prev is not None:
            for r in conn.execute(
                "SELECT nick_canon, valor FROM valor_members WHERE snapshot_id = ?",
                (prev["id"],)
            ):
                prev_valor[r["nick_canon"]] = (
                    r["valor"] if r["valor"] is not None else None)

        rows = conn.execute(
            """SELECT * FROM valor_members
               WHERE snapshot_id = ?
               ORDER BY valor DESC NULLS LAST, nick""",
            (cur["id"],),
        ).fetchall()
        members = []
        for r in rows:
            m = dict(r)
            m["is_afk"] = bool(m["is_afk"])
            m["flag_new_nick"] = bool(m["flag_new_nick"])
            m["flag_ocr_suspect"] = bool(m["flag_ocr_suspect"])
            if m["norm_met"] is not None:
                m["norm_met"] = bool(m["norm_met"])
            # Тренд: разница с прошлой неделей.
            #   pct = (cur - prev) / max(prev, 1) * 100
            # Если человека не было на прошлой неделе → "new".
            pv = prev_valor.get(m["nick_canon"])
            cv = m["valor"]
            if prev is None:
                m["trend"] = None
            elif pv is None and cv is None:
                m["trend"] = None
            elif pv is None:
                m["trend"] = {"kind": "new", "delta": cv, "pct": None}
            elif cv is None:
                m["trend"] = {"kind": "lost", "delta": -pv, "pct": -100}
            else:
                delta = cv - pv
                if pv == 0 and cv == 0:
                    pct = 0
                elif pv == 0:
                    pct = None  # делить на 0 — нет нормированного % роста
                else:
                    pct = round(delta / pv * 100, 1)
                kind = "up" if delta > 0 else "down" if delta < 0 else "flat"
                m["trend"] = {"kind": kind, "delta": delta, "pct": pct}
            members.append(m)
        return {
            "snapshot": dict(cur),
            "previous_week": prev["week"] if prev else None,
            "members": members,
        }


def valor_list_sessions() -> list[dict[str, Any]]:
    """Все снапшоты по убыванию недели — для UI «Архив доблести»."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM valor_snapshots ORDER BY week DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def valor_get_history(nick: str, field: str | None = None) -> dict[str, Any]:
    """История по полям для одного ника. Если field — только для этого
    поля. Иначе — словарь {field: [{week, value, captured_at}, ...]}."""
    canon = _valor_canon(nick)
    if not canon:
        return {}
    if field and field not in _HIST_FIELDS:
        raise ValueError(f"unknown field: {field!r}")
    with connection() as conn:
        if field:
            rows = conn.execute(
                """SELECT week, value, captured_at FROM valor_history
                   WHERE nick_canon = ? AND field = ?
                   ORDER BY week DESC""",
                (canon, field),
            ).fetchall()
            return {field: [dict(r) for r in rows]}
        else:
            out: dict[str, list[dict[str, Any]]] = {f: [] for f in _HIST_FIELDS}
            for r in conn.execute(
                """SELECT field, week, value, captured_at FROM valor_history
                   WHERE nick_canon = ?
                   ORDER BY week DESC""",
                (canon,),
            ):
                out[r["field"]].append({
                    "week": r["week"],
                    "value": r["value"],
                    "captured_at": r["captured_at"],
                })
            return out


def valor_timeline(weeks: int = 12) -> dict[str, Any]:
    """Timeline доблести по неделям для всех сокланов.

    weeks — сколько последних недель показывать.
    Возвращает: {periods, series, overall}
       periods = ['2026-W14', '2026-W15', ...]
       series  = [{nick, true_name, total, counts[]}]
       overall = сумма по всем неделям
    """
    with connection() as conn:
        rows = conn.execute(
            "SELECT week FROM valor_snapshots ORDER BY week DESC LIMIT ?",
            (weeks,),
        ).fetchall()
        periods = sorted([r["week"] for r in rows])
        if not periods:
            return {"periods": [], "series": [], "overall": {}}
        period_idx = {w: i for i, w in enumerate(periods)}

        # Все members за период
        snap_ids_rows = conn.execute(
            f"""SELECT id, week FROM valor_snapshots
                WHERE week IN ({','.join('?' * len(periods))})""",
            tuple(periods),
        ).fetchall()
        snap_to_week = {r["id"]: r["week"] for r in snap_ids_rows}
        snap_ids = list(snap_to_week.keys())

        # Группируем по canon
        from collections import defaultdict
        per_canon: dict[str, dict] = defaultdict(
            lambda: {"nick": "", "true_name": "",
                     "counts": [0] * len(periods)})
        for r in conn.execute(
            f"""SELECT snapshot_id, nick, nick_canon, true_name, valor
                FROM valor_members
                WHERE snapshot_id IN ({','.join('?' * len(snap_ids))})""",
            tuple(snap_ids),
        ):
            week = snap_to_week.get(r["snapshot_id"])
            if not week or week not in period_idx:
                continue
            canon = r["nick_canon"]
            p = per_canon[canon]
            p["nick"] = r["nick"]
            if r["true_name"]:
                p["true_name"] = r["true_name"]
            v = r["valor"] if r["valor"] is not None else 0
            p["counts"][period_idx[week]] = v

        series = []
        for canon, p in per_canon.items():
            total = sum(p["counts"])
            series.append({
                "canon":     canon,
                "nick":      p["nick"],
                "true_name": p["true_name"],
                "counts":    p["counts"],
                "total":     total,
            })
        series.sort(key=lambda s: -s["total"])

        overall = {
            "total":  sum(s["total"] for s in series),
            "people": len(series),
        }
        return {
            "periods": periods,
            "series":  series,
            "overall": overall,
        }
