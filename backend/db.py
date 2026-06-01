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

-- Метки сокланов: ветеран, ядро клана и пр. Тег → один на пару
-- (nick_canon, tag). Persistent — не зависит от снимков, не
-- удаляется при ушёл/вернулся.
CREATE TABLE IF NOT EXISTS valor_tags (
    nick_canon TEXT NOT NULL,
    tag        TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'manual',
    added_at   TEXT NOT NULL,
    PRIMARY KEY (nick_canon, tag)
);
CREATE INDEX IF NOT EXISTS idx_valor_tags_tag ON valor_tags(tag);

-- Ручные предупреждения (офицер добавляет вручную через UI). Не зависят
-- от норматива — снимаются вручную (✕). severity: ok|mid|low|bad|crit.
CREATE TABLE IF NOT EXISTS valor_manual_warnings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nick_canon  TEXT    NOT NULL,
    severity    TEXT    NOT NULL DEFAULT 'mid',
    reason      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    created_by  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_valor_mwarn ON valor_manual_warnings(nick_canon);

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
# Гомоглифы: визуально одинаковые буквы кириллицы/греческого → латиница.
# Нужно потому что ник в реестре (вводит офицер) и в доблести (OCR с экрана)
# часто пишутся РАЗНЫМИ алфавитами для одних и тех же букв: напр. реестр
# «ОnliF» (кир. О) vs доблесть «OnliF» (лат. O). Без сворачивания canon не
# совпадает → иммунитет/соцсети/офицерство не подтягиваются.
_CANON_HOMO = {
    # кириллица строчная → латиница
    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o",
    "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ј": "j",
    "ѕ": "s", "ё": "e", "г": "r", "ь": "b", "ԁ": "d",
    # греческий строчный → латиница (частые стилизации ников)
    "σ": "o", "ς": "o", "τ": "t", "ρ": "p", "ν": "v", "α": "a", "ε": "e",
    "ι": "i", "κ": "k", "ο": "o", "μ": "m", "υ": "y", "χ": "x", "γ": "y",
    "π": "n", "θ": "o", "δ": "d",
}


def _valor_canon(nick: str) -> str:
    import re
    import unicodedata
    # NFKC — приводит полноширинные/совместимые формы (ＩＲＩＫ→IRIK и т.п.).
    s = unicodedata.normalize("NFKC", (nick or "")).strip().lower()
    # Сворачиваем гомоглифы в латиницу.
    s = "".join(_CANON_HOMO.get(ch, ch) for ch in s)
    return re.sub(r"[\s\W_]+", "", s, flags=re.UNICODE)


# Иерархия должностей в PW (для умной сортировки в UI).
# Чем меньше число — тем выше должность.
_RANK_ORDER = {
    "мастер":      0,
    "мастер гильдии": 0,
    "мастер клана":   0,
    "маршал":      1,
    "майор":       2,
    "капитан":     3,
    "лейтенант":   4,
    "ефрейтор":    5,
    "рядовой":     6,
    "":            7,
}


def rank_order(s: str) -> int:
    """Числовой ранг должности — для сортировки. Неизвестные → 99."""
    return _RANK_ORDER.get((s or "").strip().lower(), 99)


# Баллы за «офицерство» в финальном score «Ценность для клана».
# Чем выше пост — тем больше очков. Учитывается максимальный пост,
# который человек когда-либо занимал (по valor_members + valor_history).
_RANK_SCORE = {
    "мастер":         30,
    "мастер гильдии": 30,
    "мастер клана":   30,
    "маршал":         24,
    "майор":          18,
    "капитан":        12,
    "лейтенант":      6,
    "ефрейтор":       2,
    "рядовой":        0,
}


def _rank_score(rank: str) -> int:
    return _RANK_SCORE.get((rank or "").strip().lower(), 0)


def _achievement(comp: dict | None) -> str | None:
    """Высшая метка-достижение за доблесть (по степени перевыполнения,
    сериям перевыполнений и безупречной истории). Иерархия (сверху вниз —
    от высшей к простой), берётся первая подходящая:

      legend  👑 безупречная история (≥3 нед без провала) + серия ≥3 нед ≥2× нормы
      ace     🔥 безупречная история + серия ≥3 нед ≥1.5× нормы
      etalon  ⭐ безупречная история (≥3 нед без единого провала)
      record  ⚡ серия ≥2 нед ≥2× нормы ИЛИ пик ≥2.5× (история не безупречна)
      double  💎 хотя бы раз удвоил норму (пик ≥2×)
      over    ➕ хотя бы раз перевыполнил (пик ≥1.5×)

    Логика: при безупречной истории чем выше степень перевыполнения серией —
    тем выше метка (legend > ace > etalon). Без безупречной истории —
    метки за силу/серии перевыполнения (record > double > over).
    """
    if not comp or not comp.get("n"):
        return None
    wc = comp["weeks_count"]
    flawless = comp["weeks_met"] == wc and wc >= 3
    peak = comp.get("peak_ratio", 0.0)
    s2 = comp.get("streak2", 0)   # серия ≥1.5×
    s3 = comp.get("streak3", 0)   # серия ≥2×
    if flawless and s3 >= 3:
        return "legend"
    if flawless and s2 >= 3:
        return "ace"
    if flawless:
        return "etalon"
    if s3 >= 2 or peak >= 2.5:
        return "record"
    if peak >= 2.0:
        return "double"
    if peak >= 1.5:
        return "over"
    return None


def _title_warn(title: str):
    """Предупреждения, отмеченные офицером В ИГРЕ через числовой титул.

    Однозначная цифра 1–9 в титуле = столько предупреждений у человека
    (кикаем обычно после 2-го). Многозначные числа (даты вроде «0305»,
    «1205», «100526») — это НЕ предупреждения, игнорируем.
    Возвращает int 1..9 или None.
    """
    t = (title or "").strip()
    if len(t) == 1 and t.isdigit() and t != "0":
        return int(t)
    return None


_RANK_SCORE_MAX = max(_RANK_SCORE.values())  # 30 (мастер)


def _rank_frac(rank: str) -> float:
    """Ранг → доля 0..1 (мастер=1.0, рядовой/нет=0)."""
    return _rank_score(rank) / _RANK_SCORE_MAX


# ── Веса финального score «Ценность для клана» (сумма = 100) ──
# Доминирует доблесть (сколько набрал человек). Остальное — «гораздо
# менее ценно», но с градацией: ветеран > офицер > соцсети ≈ чаты.
VALOR_W_DOBLEST = 60   # compliance.avg_pct, главный фактор
VALOR_W_VETERAN = 16   # был в первоначальном списке клана
VALOR_W_OFFICER = 14   # макс; смесь высшего поста (70%) и текущего (30%)
VALOR_W_SOCIALS = 5    # присутствие в соцсетях (2.5 VK + 2.5 TG)
VALOR_W_CHAT    = 5    # активность в чатах


def valor_top_rank_per_canon() -> dict[str, str]:
    """Map canon → top rank (по баллам), который этот человек когда-либо
    занимал — текущий + вся история valor_history. Нужно для авто-тега
    «Офицер» и баллов в финальном score.
    """
    out: dict[str, str] = {}
    with connection() as conn:
        # Текущие ранги из valor_members
        for r in conn.execute(
            "SELECT nick_canon, rank FROM valor_members WHERE rank != ''"
        ):
            cn, rk = r["nick_canon"], r["rank"]
            if not cn:
                continue
            if _rank_score(rk) > _rank_score(out.get(cn, "")):
                out[cn] = rk
        # Исторические ранги из valor_history
        for r in conn.execute(
            "SELECT nick_canon, value FROM valor_history "
            "WHERE field = 'rank' AND value != ''"
        ):
            cn, rk = r["nick_canon"], r["value"]
            if not cn:
                continue
            if _rank_score(rk) > _rank_score(out.get(cn, "")):
                out[cn] = rk
    return out


# ── Иммунитет новичков (7 дней от accepted_date) ──────────────────────
# Когда офицер принимает человека в клан (создаёт acceptance), ему даётся
# 7-дневный иммунитет: он не обязан набирать недельный норматив доблести.
# Логика учёта в недельной оценке:
#   • immune_until > конец оцениваемой недели → status="active",
#     вся неделя иммунная, оценку пропускаем
#   • immune_until < начало оцениваемой недели → иммун уже истёк,
#     обычная оценка
#   • immune_until попадает в оцениваемую неделю → status="grace":
#     норматив снижается пропорционально дням иммуна в неделе.
#     dow окончания (Пн=0..Вс=6) задаёт credit_pct
#     - dow=0 (Пн): 0% скидки — целая неделя без иммуна
#     - dow=3 (Чт): ~43% скидки — почти половина недели иммунная
#     - dow=5..6 (Сб/Вс): фактически вся неделя пропущена → продлеваем
#       (status="extended"), оценку этой недели пропускаем
def _iso_week_range(week: str) -> tuple[date, date]:
    """«2026-W22» → (date понедельника, date воскресенья) ISO-недели."""
    year_str, w_str = week.split("-W")
    year, week_num = int(year_str), int(w_str)
    # ISO: четверг недели — в году. Берём понедельник через fromisocalendar.
    monday = date.fromisocalendar(year, week_num, 1)
    return monday, monday + timedelta(days=6)


def _compute_immunity(accepted_date: date,
                       week: str) -> dict[str, Any] | None:
    """Возвращает immunity-инфо или None если иммун уже истёк до начала
    недели. Поля:
      status:      "active"|"extended"|"grace"
      accepted_date: ISO
      immune_until:  ISO (день когда иммун заканчивается, exclusive)
      ended_dow:   0..6 (Пн..Вс) день недели окончания (только grace/ended)
      credit_pct:  0..100 — насколько норматив должен быть снижен
      effective_norm_factor: 0..1 — что осталось от норматива
    """
    immune_until = accepted_date + timedelta(days=IMMUNITY_DAYS)
    try:
        week_start, week_end = _iso_week_range(week)
    except Exception:
        return None
    # Случай: иммун полностью покрывает неделю и далее
    if immune_until > week_end:
        return {
            "status":        "active",
            "accepted_date": accepted_date.isoformat(),
            "immune_until":  immune_until.isoformat(),
            "ended_dow":     None,
            "credit_pct":    100,
            "effective_norm_factor": 0.0,
        }
    # Случай: иммун закончился до начала недели → нет специального статуса
    if immune_until < week_start:
        return None
    # Иммун заканчивается в этой неделе → grace или extended
    dow = immune_until.weekday()  # Пн=0..Вс=6
    extended = dow >= 5  # Сб (5) или Вс (6)
    # Дней в неделе БЕЗ иммунитета = 7 - (dow + 1)
    # т.к. сам день immune_until ещё считаем иммунным до вечера.
    # Для простоты: credit_pct = (dow + 1) / 7 * 100
    if extended:
        credit_pct = 100
        norm_factor = 0.0
        status = "extended"
    else:
        credit_pct = round((dow + 1) / 7.0 * 100)
        norm_factor = round((6 - dow) / 7.0, 3)
        status = "grace"
    return {
        "status":        status,
        "accepted_date": accepted_date.isoformat(),
        "immune_until":  immune_until.isoformat(),
        "ended_dow":     dow,
        "credit_pct":    credit_pct,
        "effective_norm_factor": norm_factor,
    }


def valor_accepted_date_per_canon() -> dict[str, date]:
    """Map nick_canon → MAX(accepted_date). Используется для per-week
    проверки иммунитета в исторических данных (compliance)."""
    out: dict[str, date] = {}
    with connection() as conn:
        rows = conn.execute(
            "SELECT game_nick, MAX(accepted_date) AS d FROM acceptances "
            "GROUP BY game_nick"
        ).fetchall()
    for r in rows:
        try:
            d = date.fromisoformat(r["d"])
        except Exception:
            continue
        canon = _valor_canon(r["game_nick"])
        if not canon:
            continue
        # Если на тот же canon уже есть — берём более позднюю
        existing = out.get(canon)
        if existing is None or d > existing:
            out[canon] = d
    return out


def valor_immunity_per_canon(week: str) -> dict[str, dict]:
    """Map nick_canon → immunity-инфо для оцениваемой недели. Берёт
    самую позднюю accepted_date по канону (если вернулся в клан — это
    его свежий иммунитет). Возвращает только тех, у кого статус активен
    или в grace; уже истекший иммун не возвращается."""
    out: dict[str, dict] = {}
    with connection() as conn:
        # Группируем по canon, берём максимальный accepted_date.
        rows = conn.execute(
            "SELECT game_nick, MAX(accepted_date) AS d FROM acceptances "
            "GROUP BY game_nick"
        ).fetchall()
    for r in rows:
        try:
            accepted = date.fromisoformat(r["d"])
        except Exception:
            continue
        canon = _valor_canon(r["game_nick"])
        if not canon:
            continue
        info = _compute_immunity(accepted, week)
        if info:
            # Если на тот же canon уже есть запись — оставляем более свежую
            existing = out.get(canon)
            if existing and existing["accepted_date"] >= info["accepted_date"]:
                continue
            out[canon] = info
    return out


def valor_active_warnings() -> dict[str, list[dict]]:
    """Активные предупреждения за невыполнение норматива по каждому канону.

    Воспроизводим историю по неделям:
      • НЕ выполнил норматив → добавляем предупреждение (с % набранного
        норматива — это его «строгость»: чем меньше %, тем строже);
      • ВЫПОЛНИЛ норматив → снимаем САМОЕ СТРОГОЕ (наименьший %), и только
        потом более мягкие (правило: строгое уходит первым);
      • неделя АФК / под иммунитетом — не оценивается (пропускаем).
    Возвращает canon → список активных предупреждений
    [{week, valor, norm, pct}] (в порядке появления).
    """
    accepted = valor_accepted_date_per_canon()
    grouped: dict[str, list] = {}
    with connection() as conn:
        rows = conn.execute(
            """SELECT vm.nick_canon AS cn, vs.week AS week, vm.valor AS valor,
                      vm.is_afk AS is_afk, vm.norm_met AS norm_met,
                      vs.valor_norm AS norm
               FROM valor_members vm
               JOIN valor_snapshots vs ON vm.snapshot_id = vs.id
               ORDER BY vm.nick_canon, vs.week"""
        ).fetchall()
    for r in rows:
        grouped.setdefault(r["cn"], []).append(r)
    out: dict[str, list[dict]] = {}
    for cn, weeks in grouped.items():
        acc = accepted.get(cn)
        active: list[dict] = []
        for r in weeks:
            if acc:
                imm = _compute_immunity(acc, r["week"])
                if imm and imm["status"] in ("active", "extended"):
                    continue  # иммунная неделя — не оцениваем
            if r["is_afk"] or r["valor"] is None or r["norm_met"] is None:
                continue
            norm = r["norm"] or 1
            if r["norm_met"]:
                if active:
                    idx = min(range(len(active)),
                              key=lambda i: active[i]["pct"])
                    active.pop(idx)  # снять самое строгое
            else:
                pct = round(min(r["valor"] / norm, 1.0) * 100, 1)
                active.append({"week": r["week"], "valor": r["valor"],
                               "norm": norm, "pct": pct})
        if active:
            out[cn] = active
    return out


# Какие поля валидно отслеживать в valor_history.
# valor — пишется каждую неделю даже без изменений (для timeline и
# popover-биржевого вида). rank/title/level/class пишутся только при
# смене значения.
_HIST_FIELDS = ("rank", "title", "level", "class", "valor")


# ── Имена / диминутивы (для нормализации «TatyanaMarkina» → «Таня») ──
# Транслит частых ASCII-форм русских имён в кириллицу.
_NAME_TRANSLIT = {
    "tatyana": "татьяна", "tatiana": "татьяна",
    "alexander": "александр", "aleksandr": "александр",
    "alexandra": "александра", "alex": "александр",
    "alexey": "алексей", "aleksey": "алексей",
    "alena": "алёна", "alyona": "алёна",
    "anastasia": "анастасия", "anastasiya": "анастасия",
    "andrey": "андрей", "andrei": "андрей",
    "anna": "анна", "anton": "антон", "anatoly": "анатолий",
    "boris": "борис",
    "denis": "денис", "dima": "дмитрий",
    "dmitry": "дмитрий", "dmitri": "дмитрий", "dmitriy": "дмитрий",
    "ekaterina": "екатерина", "elena": "елена",
    "evgeny": "евгений", "evgeniy": "евгений", "evgenia": "евгения",
    "german": "герман",
    "irina": "ирина", "ivan": "иван",
    "katya": "катя", "konstantin": "константин", "kostya": "константин",
    "kirill": "кирилл", "ksenia": "ксения", "kseniya": "ксения",
    "larisa": "лариса", "lera": "лера",
    "maksim": "максим", "maxim": "максим",
    "marina": "марина", "maria": "мария", "mariya": "мария",
    "mikhail": "михаил", "misha": "михаил",
    "natalya": "наталья", "natalia": "наталья", "natasha": "наталья",
    "nikita": "никита",
    "nikolay": "николай", "nikolai": "николай",
    "olga": "ольга", "olya": "ольга",
    "pavel": "павел", "pasha": "павел",
    "petr": "пётр", "petya": "пётр",
    "polina": "полина",
    "roman": "роман", "roma": "роман",
    "ruslan": "руслан",
    "sasha": "александр", "sergey": "сергей", "sergei": "сергей",
    "stas": "станислав", "stanislav": "станислав",
    "svetlana": "светлана", "sveta": "светлана",
    "tanya": "татьяна",
    "tim": "тимофей", "tima": "тимофей", "timofey": "тимофей",
    "valera": "валерий", "valery": "валерий",
    "valeria": "валерия", "valeriya": "валерия",
    "vlad": "владислав", "vladimir": "владимир", "vova": "владимир",
    "yury": "юрий", "yuri": "юрий", "yulia": "юлия", "yuliya": "юлия",
    "vitya": "виктор", "victor": "виктор", "viktor": "виктор",
    "vasily": "василий",
}

# Полное имя → уменьшительная форма.
_DIMINUTIVES = {
    "татьяна": "Таня",
    "александр": "Саша", "александра": "Саша",
    "алексей": "Лёша", "анастасия": "Настя",
    "сергей": "Серёжа",
    "андрей": "Андрей",
    "владимир": "Володя", "владислав": "Влад",
    "екатерина": "Катя", "елена": "Лена",
    "ольга": "Оля", "наталья": "Наташа", "светлана": "Света",
    "виктория": "Вика", "анна": "Аня", "мария": "Маша",
    "ирина": "Ира", "евгений": "Женя", "евгения": "Женя",
    "дмитрий": "Дима", "михаил": "Миша", "юрий": "Юра",
    "николай": "Коля", "константин": "Костя", "максим": "Макс",
    "артём": "Тёма", "артем": "Тёма", "роман": "Рома",
    "павел": "Паша", "пётр": "Петя", "петр": "Петя",
    "юлия": "Юля", "ярослав": "Ярик", "валерий": "Валера",
    "валерия": "Лера", "тимофей": "Тима", "филипп": "Филя",
    "степан": "Стёпа", "лидия": "Лида", "вячеслав": "Слава",
    "станислав": "Стас", "арсений": "Сеня", "вадим": "Вадим",
    "даниил": "Даня", "данила": "Даня", "лев": "Лёва",
    "леонид": "Лёня", "виктор": "Витя",
    "надежда": "Надя", "любовь": "Люба", "галина": "Галя",
    "людмила": "Люся", "валентина": "Валя", "валентин": "Валя",
    "марина": "Марина", "ангелина": "Геля", "альбина": "Аля",
    "софия": "Соня", "софья": "Соня", "арина": "Арина",
    "полина": "Поля", "ксения": "Ксюша", "елизавета": "Лиза",
}


def _camel_split(s: str) -> list[str]:
    """TatyanaMarkina → ['Tatyana', 'Markina'].
    Татьяна → ['Татьяна'] (одно слово, не camelCase).
    Между нижним регистром и верхним (lat ИЛИ cyr) вставляем пробел,
    затем split по пробелу."""
    import re as _re
    if not s:
        return []
    # Вставляем разделитель между «строчная буква» и «прописная буква»,
    # поддерживая и латиницу, и кириллицу.
    out = _re.sub(r"([a-zа-яё])([A-ZА-ЯЁ])", r"\1 \2", s)
    return [w for w in out.split() if w]


def _normalize_name(raw: str) -> str:
    """«TatyanaMarkina» / «Татьяна» / «Tatyana» → «Таня».

    1) разрезаем camelCase, оставляем первое слово (= имя)
    2) если ASCII — мэппим через _NAME_TRANSLIT в кириллицу
    3) если получившаяся форма в _DIMINUTIVES — возвращаем уменьшительное
    4) иначе возвращаем исходное «Имя» с заглавной буквы
    """
    s = (raw or "").strip()
    if not s:
        return ""
    # Если строка содержит пробелы — берём первое слово
    if " " in s:
        s = s.split()[0]
    else:
        parts = _camel_split(s)
        if parts:
            s = parts[0]
    if not s:
        return ""
    import re as _re
    key = s.lower()
    if _re.fullmatch(r"[a-z']+", key):
        key = _NAME_TRANSLIT.get(key, key)  # translit если знаем
    if key in _DIMINUTIVES:
        return _DIMINUTIVES[key]
    # Не нашли уменьшительное — отдаём капитализированный original
    return s[0].upper() + s[1:]


def _title_looks_like_name(title: str) -> bool:
    """Эвристика: title в PW может содержать что угодно. Считаем именем
    если это короткое слово (или 2 слова) из букв с заглавной первой,
    без цифр/«АФК»/спецсимволов.
    Примеры:
      «Костя»     → True
      «АФК до пт» → False (АФК)
      «12345»     → False (цифры)
      «КрутойБой» → False (CamelCase ник)
      «Аня»       → True
      «лёша»     → False (строчная первая)
    """
    import re as _re
    t = (title or "").strip()
    if not t:
        return False
    low = t.lower()
    if "афк" in low or "afk" in low:
        return False
    if _re.search(r"\d", t):
        return False
    if not (2 <= len(t) <= 25):
        return False
    # Допускаем 1-2 слова из букв-кириллица/латиница, начинается с верхней
    if not _re.match(r"^[A-ZА-ЯЁ][a-zA-Zа-яё]+(?:[ \-][A-ZА-ЯЁ][a-zA-Zа-яё]+)?$", t):
        return False
    return True


def _enrich_true_names_from_title(members: list[dict]) -> int:
    """Для тех у кого true_name пуст — пытаемся взять из title через
    _normalize_name, если titлe похож на имя (а не «АФК»/цифры)."""
    filled = 0
    for m in members:
        if (m.get("true_name") or "").strip():
            continue
        title = (m.get("title") or "").strip()
        if not _title_looks_like_name(title):
            continue
        # Прогоняем через _normalize_name — Татьяна → Таня, и т.п.
        name = _normalize_name(title)
        if name:
            m["true_name"] = name
            filled += 1
    return filled


def _enrich_true_names_from_clan_members(members: list[dict]) -> int:
    """Если у member пустое true_name — ищем имя в clan_members JOIN
    по canon одного из game_nick'ов человека.

    Источники имени в clan_members (по приоритету):
      1. vk_first  (точное «Имя» из VK)
      2. tg_first_name (имя из TG)
      3. первое слово display_name (если оно похоже на одно имя,
         а не на полное «Имя Фамилия» — взято для безопасности)

    Возвращает количество заполненных записей.
    """
    with connection() as conn:
        rows = conn.execute(
            """SELECT game_nick, display_name, vk_first, tg_first_name,
                      tg_username
               FROM clan_members WHERE is_active = 1"""
        ).fetchall()
    lookup: dict[str, str] = {}
    for r in rows:
        # Источники имени по приоритету
        candidates = [
            (r["vk_first"] or "").strip(),
            (r["tg_first_name"] or "").strip(),
        ]
        dn = (r["display_name"] or "").strip()
        if dn:
            candidates.append(dn.split()[0])
        # TG-username (TatyanaMarkina) — последний резерв
        candidates.append((r["tg_username"] or "").strip())
        name = ""
        for c in candidates:
            if c:
                name = _normalize_name(c)
                if name:
                    break
        if not name:
            continue
        for nick in (r["game_nick"] or "").split(","):
            cn = _valor_canon(nick)
            if cn and cn not in lookup:
                lookup[cn] = name
    filled = 0
    for m in members:
        if (m.get("true_name") or "").strip():
            continue
        cn = _valor_canon(m.get("nick", ""))
        if cn in lookup:
            m["true_name"] = lookup[cn]
            filled += 1
    return filled


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
    # ── 0. Обогащение пустых true_name:
    #   а) из clan_members (рег-бот) — приоритет
    #   б) из title текущего сбора если title похож на имя
    enriched = _enrich_true_names_from_clan_members(members)
    enriched += _enrich_true_names_from_title(members)
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

        # ── 1.5. Дедуп входных строк по canon ──
        # Десктоп/OCR иногда отдаёт один ник дважды (например «AtiScaT» с
        # valor 14 и фантомные 8). Без дедупа обе строки попадают в снимок,
        # фейково раздувают число «недель» и занижают среднюю compliance —
        # из-за чего сортировка по «ценности» врёт. Оставляем строку с
        # бОльшим valor (более полное чтение).
        def _vint(x):
            return x if isinstance(x, int) else -1
        _dedup: dict[str, dict] = {}
        for _m in members:
            _nick = (_m.get("nick") or "").strip()
            if not _nick:
                continue
            _cn = _valor_canon(_nick)
            _ex = _dedup.get(_cn)
            if _ex is None or _vint(_m.get("valor")) > _vint(_ex.get("valor")):
                _dedup[_cn] = _m
        members = list(_dedup.values())

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
        # Иммунитет на эту неделю — учитываем при оценке norm_met и streak.
        # Десктоп-бот не знает про иммунитет, шлёт norm_met по факту;
        # переписываем здесь.
        immunity_map = valor_immunity_per_canon(week)
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
            valor_val = m.get("valor") if isinstance(m.get("valor"), int) else None
            imm = immunity_map.get(canon)

            # Иммунные новички:
            #  active/extended → norm_met = None (не оцениваем),
            #                    warning_count = 0
            #  grace          → пересчитываем по effective_norm:
            #                    valor >= eff_norm → True (warn=0)
            #                    valor <  eff_norm → False (warn+=1)
            if imm and imm["status"] in ("active", "extended"):
                norm_met_raw = None
                warning_count = 0
            elif imm and imm["status"] == "grace":
                eff_norm = max(1, round(valor_norm * imm["effective_norm_factor"]))
                if valor_val is None:
                    norm_met_raw = False
                else:
                    norm_met_raw = valor_val >= eff_norm
                if norm_met_raw:
                    warning_count = 0
                else:
                    warning_count = prev_warnings.get(canon, 0) + 1
            elif is_afk or norm_met_raw is True:
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
                elif fld in ("level", "valor"):
                    raw = m.get(fld)
                    val = str(raw) if isinstance(raw, int) else ""
                else:
                    val = (m.get(fld) or "").strip()
                # valor пишется ВСЕГДА (для биржевого графика по неделям).
                # Остальные — только при смене значения относительно
                # последней записи на ника.
                if fld == "valor":
                    # Удаляем предыдущую запись этой же недели если есть
                    # (REPLACE — на случай ре-аплоада)
                    conn.execute(
                        """DELETE FROM valor_history
                           WHERE nick_canon = ? AND field = ? AND week = ?""",
                        (canon, fld, week),
                    )
                    conn.execute(
                        """INSERT INTO valor_history
                           (nick_canon, field, value, week, captured_at)
                           VALUES (?, ?, ?, ?, ?)""",
                        (canon, fld, val, week, now),
                    )
                    history_added += 1
                    continue
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
        "true_name_enriched": enriched,
    }


def valor_add_tags(tag: str, nicks: list[str],
                    source: str = "manual") -> dict[str, int]:
    """Bulk-добавление тегов. tag нормализуется в lowercase."""
    tag = (tag or "").strip().lower()
    if not tag:
        return {"added": 0, "skipped": 0}
    now = datetime.utcnow().isoformat(timespec="seconds")
    added = 0
    skipped = 0
    with connection() as conn:
        for nick in nicks:
            canon = _valor_canon(nick)
            if not canon:
                skipped += 1
                continue
            cur = conn.execute(
                "INSERT OR IGNORE INTO valor_tags "
                "(nick_canon, tag, source, added_at) VALUES (?,?,?,?)",
                (canon, tag, source, now),
            )
            if cur.rowcount:
                added += 1
            else:
                skipped += 1
    return {"added": added, "skipped": skipped}


def valor_remove_tag(nick: str, tag: str) -> bool:
    """Удалить один тег. True если удалено."""
    tag = (tag or "").strip().lower()
    canon = _valor_canon(nick)
    if not canon or not tag:
        return False
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM valor_tags WHERE nick_canon = ? AND tag = ?",
            (canon, tag),
        )
        return cur.rowcount > 0


_MWARN_SEV = ("light", "mid", "severe")


def valor_add_manual_warning(nick: str, severity: str, reason: str,
                              created_by: str = "") -> dict:
    """Добавить ручное предупреждение нику. severity ∈ ok|mid|low|bad|crit."""
    canon = _valor_canon(nick)
    if not canon:
        return {"ok": False, "error": "bad nick"}
    sev = severity if severity in _MWARN_SEV else "mid"
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO valor_manual_warnings "
            "(nick_canon, severity, reason, created_at, created_by) "
            "VALUES (?,?,?,?,?)",
            (canon, sev, (reason or "").strip()[:200], now, created_by or ""),
        )
        return {"ok": True, "id": cur.lastrowid}


def valor_remove_manual_warning(warning_id: int) -> bool:
    """Удалить ручное предупреждение по id."""
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM valor_manual_warnings WHERE id = ?", (warning_id,)
        )
        return cur.rowcount > 0


def valor_manual_warnings_by_canon() -> dict[str, list[dict]]:
    """Map canon → список ручных предупреждений."""
    out: dict[str, list[dict]] = {}
    with connection() as conn:
        for r in conn.execute(
            "SELECT id, nick_canon, severity, reason, created_at, created_by "
            "FROM valor_manual_warnings ORDER BY created_at"
        ):
            out.setdefault(r["nick_canon"], []).append({
                "id": r["id"], "severity": r["severity"],
                "reason": r["reason"], "created_at": r["created_at"],
                "created_by": r["created_by"], "manual": True,
            })
    return out


def valor_list_tags() -> dict[str, list[str]]:
    """Возвращает map canon → [tags...]."""
    out: dict[str, list[str]] = {}
    with connection() as conn:
        for r in conn.execute(
            "SELECT nick_canon, tag FROM valor_tags ORDER BY tag"
        ):
            out.setdefault(r["nick_canon"], []).append(r["tag"])
    return out


def valor_chat_activity_by_canon() -> dict[str, int]:
    """Возвращает canon → суммарное количество сообщений в архиве чатов.
    Матчинг через clan_members.tg_id / vk_id (узнаём кто это)."""
    out: dict[str, int] = {}
    with connection() as conn:
        # Сначала собираем canon → (tg_id, vk_id) из clan_members
        for r in conn.execute(
            "SELECT game_nick, tg_id, vk_id FROM clan_members "
            "WHERE is_active = 1"
        ):
            canons = [_valor_canon(n) for n in (r["game_nick"] or "").split(",")]
            canons = [c for c in canons if c]
            if not canons:
                continue
            total = 0
            if r["tg_id"]:
                tg_total = conn.execute(
                    "SELECT count(*) FROM chat_messages "
                    "WHERE platform = 'tg' AND user_id = ?",
                    (str(r["tg_id"]),),
                ).fetchone()[0]
                total += tg_total or 0
            if r["vk_id"]:
                vk_total = conn.execute(
                    "SELECT count(*) FROM chat_messages "
                    "WHERE platform = 'vk' AND user_id = ?",
                    (str(r["vk_id"]),),
                ).fetchone()[0]
                total += vk_total or 0
            for c in canons:
                out[c] = max(out.get(c, 0), total)
    return out


def valor_by_canon_map(weeks: int = 0) -> dict[str, dict[str, Any]]:
    """Map canon_nick → {nick, true_name, valor, norm_pct, compliance_avg,
    weeks_count, weeks_met} для последнего N-недельного периода.

    weeks=0 → по всем неделям.
    Используется в chat-members.html для совмещённой статистики
    «общительность + доблесть».
    """
    with connection() as conn:
        if weeks > 0:
            week_rows = conn.execute(
                "SELECT week FROM valor_snapshots ORDER BY week DESC LIMIT ?",
                (weeks,),
            ).fetchall()
            allowed_weeks = {r["week"] for r in week_rows}
        else:
            allowed_weeks = None
        # Compliance + текущий valor (из последнего снапшота)
        cur_snap = conn.execute(
            "SELECT id, valor_norm FROM valor_snapshots ORDER BY week DESC LIMIT 1"
        ).fetchone()
        cur_data: dict[str, dict] = {}
        if cur_snap:
            for r in conn.execute(
                """SELECT nick_canon, nick, true_name, valor, is_afk
                   FROM valor_members WHERE snapshot_id = ?""",
                (cur_snap["id"],),
            ):
                cn = r["nick_canon"]
                norm = cur_snap["valor_norm"] or 1
                if r["is_afk"] or r["valor"] is None:
                    norm_pct = None
                else:
                    norm_pct = round(min(r["valor"] / norm, 1.0) * 100, 1)
                cur_data[cn] = {
                    "nick":      r["nick"],
                    "true_name": r["true_name"] or "",
                    "valor":     r["valor"],
                    "is_afk":    bool(r["is_afk"]),
                    "norm_pct":  norm_pct,
                }
        # Compliance — среднее по всем (или последним N) неделям.
        # Иммунные (norm_met IS NULL) пропускаем как АФК — они не оцениваются.
        comp: dict[str, dict] = {}
        for r in conn.execute(
            """SELECT vm.nick_canon, vm.valor, vm.is_afk, vm.norm_met,
                      vs.valor_norm, vs.week
               FROM valor_members vm
               JOIN valor_snapshots vs ON vm.snapshot_id = vs.id"""
        ):
            if allowed_weeks is not None and r["week"] not in allowed_weeks:
                continue
            if r["is_afk"] or r["valor"] is None:
                continue
            if r["norm_met"] is None:
                continue
            norm = r["valor_norm"] or 1
            pct = min(r["valor"] / norm, 1.0) * 100
            d = comp.setdefault(r["nick_canon"],
                                 {"sum": 0.0, "n": 0, "met": 0})
            d["sum"] += pct
            d["n"]   += 1
            if r["valor"] >= norm:
                d["met"] += 1
        # Объединяем
        out: dict[str, dict] = {}
        # Берём все ники где есть current_data или compliance
        all_canons = set(cur_data) | set(comp)
        for cn in all_canons:
            base = cur_data.get(cn, {})
            c = comp.get(cn)
            out[cn] = {
                "nick":         base.get("nick", ""),
                "true_name":    base.get("true_name", ""),
                "valor":        base.get("valor"),
                "is_afk":       base.get("is_afk", False),
                "norm_pct":     base.get("norm_pct"),
                "compliance":   ({
                    "avg_pct":     round(c["sum"] / c["n"], 1),
                    "weeks_count": c["n"],
                    "weeks_met":   c["met"],
                } if c else None),
            }
        return out


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
        # Предыдущая доблесть и % выполнения предыдущей недели по canon
        prev_valor: dict[str, int | None] = {}
        prev_pct: dict[str, float | None] = {}
        if prev is not None:
            prev_norm = prev["valor_norm"] or 1
            for r in conn.execute(
                "SELECT nick_canon, valor, is_afk FROM valor_members WHERE snapshot_id = ?",
                (prev["id"],)
            ):
                cn = r["nick_canon"]
                v = r["valor"]
                prev_valor[cn] = v if v is not None else None
                if r["is_afk"] or v is None:
                    prev_pct[cn] = None
                else:
                    prev_pct[cn] = round(min(v / prev_norm, 1.0) * 100, 1)

        # Compliance по всем неделям для каждого ника (среднее % выполнения).
        # Пропускаем:
        #   • АФК (is_afk)
        #   • norm_met IS NULL (иммунные/не оцениваемые — после фиксов)
        #   • per-week иммунитет (для старых снапшотов где norm_met
        #     записывалась до фикса) — определяем по accepted_date
        accepted_by_canon = valor_accepted_date_per_canon()
        compliance: dict[str, dict] = {}
        # ORDER BY ... week — чтобы корректно считать серии подряд (streak).
        for r in conn.execute(
            """SELECT vm.nick_canon, vm.valor, vm.is_afk, vm.norm_met,
                      vs.valor_norm, vs.week
               FROM valor_members vm
               JOIN valor_snapshots vs ON vm.snapshot_id = vs.id
               ORDER BY vm.nick_canon, vs.week"""
        ):
            cn = r["nick_canon"]
            if r["is_afk"]:
                continue
            if r["norm_met"] is None:
                continue
            if r["valor"] is None:
                continue
            # Фикс: на старых снапшотах norm_met=False у иммунных — это
            # ошибка. Пересчитываем _compute_immunity для week,canon.
            acc = accepted_by_canon.get(cn)
            if acc:
                imm = _compute_immunity(acc, r["week"])
                if imm and imm["status"] in ("active", "extended"):
                    continue  # эта неделя была иммунная — пропускаем
            norm = r["valor_norm"] or 1
            ratio = r["valor"] / norm
            pct = min(ratio, 1.0) * 100
            # Перевыполнение этой недели (0..100): на сколько % сверх нормы,
            # с потолком +100% (2× норма) — чтобы нельзя было «нафармить».
            overshoot = max(0.0, min((ratio - 1.0) * 100, 100.0))
            d = compliance.setdefault(cn, {
                "sum": 0.0, "n": 0, "met": 0, "over_sum": 0.0,
                "streak": 0, "max_streak": 0, "peak": 0.0,
                "cs2": 0, "ms2": 0, "cs3": 0, "ms3": 0})
            d["sum"] += pct
            d["over_sum"] += overshoot
            d["n"] += 1
            if ratio > d["peak"]:
                d["peak"] = ratio
            if r["valor"] >= norm:
                d["met"] += 1
                d["streak"] += 1
                if d["streak"] > d["max_streak"]:
                    d["max_streak"] = d["streak"]
            else:
                d["streak"] = 0
            # серии перевыполнения по степеням: ≥1.5× (cs2) и ≥2× (cs3)
            if ratio >= 1.5:
                d["cs2"] += 1
                if d["cs2"] > d["ms2"]:
                    d["ms2"] = d["cs2"]
            else:
                d["cs2"] = 0
            if ratio >= 2.0:
                d["cs3"] += 1
                if d["cs3"] > d["ms3"]:
                    d["ms3"] = d["cs3"]
            else:
                d["cs3"] = 0

        # Теги по canon (ветеран и т.п.) — для UI меток.
        tags_map = valor_list_tags()
        # Активность в чатах по canon — для финального score.
        chat_msgs = valor_chat_activity_by_canon()
        # Top-rank когда-либо (для авто-тега «Офицер» + score).
        top_rank_map = valor_top_rank_per_canon()
        # Иммунитет новичков по canon — только активный/grace в неделе снимка
        immunity_map = valor_immunity_per_canon(cur["week"])

        # Неделя последнего изменения титула по canon — чтобы знать, КОГДА
        # офицер проставил числовой титул-предупреждение (для UI). История
        # пишется только при смене значения, поэтому последняя запись по
        # нику = неделя, на которой титул стал текущим.
        title_hist_week: dict[str, str] = {}
        for r in conn.execute(
            "SELECT nick_canon, week FROM valor_history "
            "WHERE field='title' ORDER BY week"
        ):
            title_hist_week[r["nick_canon"]] = r["week"]

        # Активные предупреждения за невыполнение норматива (replay истории).
        warn_map = valor_active_warnings()
        # Ручные предупреждения, добавленные офицером через UI.
        manual_warn_map = valor_manual_warnings_by_canon()

        # Социалки по canon — для UI колонки «Данные VK / Telegram».
        socials: dict[str, dict] = {}
        for r in conn.execute(
            """SELECT game_nick, vk_id, vk_screen_name, vk_display,
                      tg_id, tg_username, tg_display
               FROM clan_members WHERE is_active = 1"""
        ):
            entry = {
                "vk_id":          (r["vk_id"] or "") or None,
                "vk_screen_name": (r["vk_screen_name"] or "") or None,
                "vk_display":     (r["vk_display"] or "") or None,
                "tg_id":          (r["tg_id"] or "") or None,
                "tg_username":    (r["tg_username"] or "") or None,
                "tg_display":     (r["tg_display"] or "") or None,
            }
            if not any(entry.values()):
                continue
            for nick in (r["game_nick"] or "").split(","):
                cn = _valor_canon(nick)
                if cn and cn not in socials:
                    socials[cn] = entry

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
            # Соцсети (по canon ника)
            cn = m["nick_canon"]
            m["socials"] = socials.get(cn) or None
            # Теги: ручные + авто. Авто-теги НЕ пишутся в БД —
            # подмешиваются на лету при выдаче.
            auto_tags = []
            if m["socials"]:
                auto_tags.append("in_socials")
            top_rank = top_rank_map.get(cn, "")
            if _rank_score(top_rank) > 0:
                auto_tags.append("officer")
            manual_tags = tags_map.get(cn, [])
            # Сохраняем порядок: сначала ручные (veteran и т.п.) — затем авто
            m["tags"] = manual_tags + [t for t in auto_tags if t not in manual_tags]
            m["top_rank"] = top_rank or None

            # Иммунитет новичка: если активен или попадает в эту неделю —
            # корректируем оценку (effective_norm меньше base или null).
            immunity = immunity_map.get(cn)
            m["immunity"] = immunity

            # Текущий % выполнения норматива (учитывает иммун) + ПЕРЕпишем
            # norm_met для иммунных. Это нужно потому что старые снапшоты
            # были загружены до фиксов и имеют norm_met=False/True по факту,
            # игнорируя иммунитет. Здесь приводим в консистентное состояние.
            cur_norm = cur["valor_norm"] or 1
            cv = m["valor"]
            if m["is_afk"]:
                m["norm_pct"] = None
            elif immunity and immunity["status"] in ("active", "extended"):
                m["norm_pct"] = None
                m["norm_met"] = None  # иммунный — не оцениваем
            elif immunity and immunity["status"] == "grace":
                eff_norm = max(1, round(cur_norm * immunity["effective_norm_factor"]))
                if cv is None:
                    m["norm_pct"] = 0.0
                    m["norm_met"] = False
                else:
                    m["norm_pct"] = round(min(cv / eff_norm, 1.0) * 100, 1)
                    m["norm_met"] = cv >= eff_norm
                m["effective_norm"] = eff_norm
            elif cv is None:
                m["norm_pct"] = 0.0
            else:
                m["norm_pct"] = round(min(cv / cur_norm, 1.0) * 100, 1)

            # Compliance — среднее % выполнения по всем неделям.
            d = compliance.get(m["nick_canon"])
            if d and d["n"]:
                m["compliance"] = {
                    "avg_pct":     round(d["sum"] / d["n"], 1),
                    "weeks_count": d["n"],
                    "weeks_met":   d["met"],
                    "over_avg":    round(d["over_sum"] / d["n"], 1),
                    "max_streak":  d["max_streak"],
                    "peak_ratio":  round(d["peak"], 2),
                    "streak2":     d["ms2"],
                    "streak3":     d["ms3"],
                }
            else:
                m["compliance"] = None
            # Метка-достижение за доблесть (в начало списка меток).
            ach = _achievement(m["compliance"])
            m["achievement"] = ach
            if ach:
                m["tags"] = [ach] + [t for t in m["tags"] if t != ach]

            # Тренд: сравниваем % выполнения этой недели vs прошлой.
            #   pct_delta = cur_pct - prev_pct  (в процентных пунктах)
            #   delta = cur_valor - prev_valor
            # Если человека не было на прошлой неделе → "new".
            pv = prev_valor.get(m["nick_canon"])
            pp = prev_pct.get(m["nick_canon"])
            if prev is None:
                m["trend"] = None
            elif pv is None and cv is None:
                m["trend"] = None
            elif pv is None:
                m["trend"] = {"kind": "new", "delta": cv,
                              "pct_delta": None}
            elif cv is None:
                m["trend"] = {"kind": "lost", "delta": -pv,
                              "pct_delta": -100.0}
            else:
                delta = cv - pv
                # pct_delta — разность процентов выполнения, если оба
                # участвовали в нормативе (не АФК на прошлой и этой)
                if pp is None or m["norm_pct"] is None:
                    pct_delta = None
                else:
                    pct_delta = round(m["norm_pct"] - pp, 1)
                # Kind определяем по pct_delta если есть, иначе по delta
                ref = pct_delta if pct_delta is not None else delta
                kind = "up" if ref > 0 else "down" if ref < 0 else "flat"
                m["trend"] = {"kind": kind, "delta": delta,
                              "pct_delta": pct_delta}

            # ── Финальный score: «ценность для клана» ──
            # Раскладка (max 100, веса см. VALOR_W_*):
            #   compliance: 0..60  (доблесть — главный фактор)
            #   veteran:    0..16  (был в первоначальном списке клана)
            #   officer:    0..14  смесь высшего поста ever (70%) +
            #               текущего поста (30%) — важно и где был, и где сейчас
            #   socials:    0..5   (2.5 за VK + 2.5 за TG)
            #   chat:       0..5   (min(msgs/50, 1) * 5)
            # Если человек ПРЯМО СЕЙЧАС под иммунитетом (active/extended),
            # доблесть-компонент не оценивается: comp_pts=None,
            # max=100-VALOR_W_DOBLEST. total нормализуется к /100.
            comp_obj = m.get("compliance")
            is_immune_now = (immunity and
                             immunity["status"] in ("active", "extended"))
            if is_immune_now:
                comp_pts = None  # «не оценивается»
            elif comp_obj:
                comp_pts = round(comp_obj["avg_pct"] * VALOR_W_DOBLEST / 100, 1)
            else:
                comp_pts = 0.0
            msgs = chat_msgs.get(cn, 0)
            chat_pts = round(min(msgs / 50.0, 1.0) * VALOR_W_CHAT, 1)
            soc_pts = 0.0
            soc = m.get("socials") or {}
            if soc.get("vk_id") or soc.get("vk_screen_name"):
                soc_pts += VALOR_W_SOCIALS / 2
            if soc.get("tg_id") or soc.get("tg_username"):
                soc_pts += VALOR_W_SOCIALS / 2
            veteran_pts = VALOR_W_VETERAN if "veteran" in m["tags"] else 0
            # Офицер: высший пост за всё время (вес 70%) + текущий пост (30%).
            officer_pts = round(
                VALOR_W_OFFICER * (0.7 * _rank_frac(top_rank)
                                   + 0.3 * _rank_frac(m.get("rank", ""))), 1)
            # ── Бонус дисциплины (сверх базовых 100) ──
            #   перевыполнение: до +5 (по среднему % сверх нормы),
            #   серия выполнений подряд: до +5 (max_streak),
            #   безупречная история: +3 (все недели выполнены, при ≥3 нед.).
            discipline = 0.0
            if comp_obj and not is_immune_now:
                over_bonus = round(comp_obj.get("over_avg", 0.0) / 100 * 5, 1)
                streak_bonus = min(comp_obj.get("max_streak", 0), 5)
                perfect_bonus = (3 if comp_obj["weeks_met"] == comp_obj["weeks_count"]
                                 and comp_obj["weeks_count"] >= 3 else 0)
                discipline = round(over_bonus + streak_bonus + perfect_bonus, 1)
            # Сумма доступных компонентов
            other_pts = chat_pts + soc_pts + veteran_pts + officer_pts
            if is_immune_now:
                max_pts = 100 - VALOR_W_DOBLEST  # без доблести
                raw_total = round(other_pts, 1)
                # Нормализуем к 100 чтобы было сопоставимо с обычными
                total = round(raw_total / max_pts * 100, 1)
            else:
                max_pts = 100
                raw_total = round((comp_pts or 0) + other_pts, 1)
                total = round(raw_total + discipline, 1)  # дисциплина сверх 100
            m["score"] = {
                "total":           total,
                "raw_total":       raw_total,
                "max":             max_pts,
                "discipline":      discipline,
                "over_avg":        (comp_obj or {}).get("over_avg", 0) if comp_obj else 0,
                "max_streak":      (comp_obj or {}).get("max_streak", 0) if comp_obj else 0,
                "immunity_adjusted": is_immune_now,
                "compliance":      comp_pts,  # None если иммун
                "chat":            chat_pts,
                "chat_msgs":       msgs,
                "socials":         soc_pts,
                "veteran":         veteran_pts,
                "officer":         officer_pts,
                "top_rank":        top_rank or None,
                "cur_rank":        m.get("rank") or None,
            }
            # Предупреждения, отмеченные офицером в игре (числовой титул 1–9).
            # Показываем ОТДЕЛЬНО от авто-счётчика по нормативу. Так как это
            # абсолютное число из титула, повторно (пока цифра та же) оно не
            # «накручивается» — новым предупреждением считается только смена.
            tw = _title_warn(m.get("title"))
            m["title_warn"] = tw
            m["title_warn_since"] = title_hist_week.get(cn) if tw else None
            # Активные норматив-предупреждения (строгие — первыми для показа).
            w = warn_map.get(cn, [])
            m["warnings"] = sorted(w, key=lambda x: x["pct"])
            m["warning_count"] = len(w)  # для бейджа в колонке «Норматив»
            m["manual_warnings"] = manual_warn_map.get(cn, [])
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
