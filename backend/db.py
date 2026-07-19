"""SQLite с двумя таблицами: acceptances + audit_log.

Сознательно без ORM — схема плоская, удобнее видеть SQL целиком.
"""

import sqlite3
import json
import math
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
    members_count INTEGER NOT NULL DEFAULT 0,  -- сколько распознал Gemini
    actual_members INTEGER,                    -- реально людей в клане на сбор (ввод офицера)
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
    flag_ocr_suspect INTEGER NOT NULL DEFAULT 0,
    frame            INTEGER   -- номер кадра (R2 idx), на котором ник распознан
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

-- Ручной ИММУНИТЕТ на конкретную неделю (офицер/админ). Освобождает от нормы
-- на эту неделю (как иммунитет новичка): нет предупреждений, форма не падает,
-- набранная доблесть всё равно засчитывается. Пример: человека по ошибке
-- кикнули и приняли обратно → бан на базе клана неделю, играть не мог.
CREATE TABLE IF NOT EXISTS valor_manual_immunity (
    nick_canon  TEXT    NOT NULL,
    week        TEXT    NOT NULL,          -- '2026-W28'
    reason      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    created_by  TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (nick_canon, week)
);

-- «Чистый лист» возвращенца из архива. Когда человека возвращают из архива
-- Доблести (valor_return_from_archive), фиксируем неделю возврата. Все недели
-- СТРОГО ДО slate_week — «прошлая жизнь»: норматив с них не требуется (недоборы
-- не считаются негативом), но набранная доблесть/титулы/история сохраняются.
-- В UI прошлые недели с недобором штрихуются синим (как иммун), а в разворот
-- истории добавляется пометка «возвращён — с чистого листа».
CREATE TABLE IF NOT EXISTS valor_return_slate (
    nick_canon   TEXT    NOT NULL PRIMARY KEY,
    slate_week   TEXT    NOT NULL,         -- '2026-W28' (неделя возврата)
    returned_at  TEXT    NOT NULL DEFAULT '',
    returned_by  TEXT    NOT NULL DEFAULT ''
);

-- История примечаний о человеке (append-only «свиток»). Синхронизируется с
-- примечанием реестра (acceptances.note): и офицер/админ дополняют прямо из
-- таблицы Доблести, и правка заметки в реестре дописывается сюда. Текущее
-- примечание = самая свежая запись. source: valor|registry|seed.
CREATE TABLE IF NOT EXISTS valor_note_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nick_canon  TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    author      TEXT    NOT NULL DEFAULT '',
    author_role TEXT    NOT NULL DEFAULT '',
    source      TEXT    NOT NULL DEFAULT 'valor',
    created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valor_note_hist ON valor_note_history(nick_canon);

-- «Прощённые» вычисляемые предупреждения (офицер снял вручную):
--   kind='norm'  ref=week   — прощён авто-штраф за невыполнение норматива в неделю
--   kind='title' ref=<N>    — прощён штраф из титула (цифра N); при смене цифры
--                             в титуле штраф появится снова (это уже другое).
CREATE TABLE IF NOT EXISTS valor_warn_dismiss (
    nick_canon  TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    ref         TEXT    NOT NULL DEFAULT '',
    detail      TEXT    NOT NULL DEFAULT '',   -- JSON: что было на момент выставления
    reason      TEXT    NOT NULL DEFAULT '',   -- комментарий: почему простили
    created_at  TEXT    NOT NULL DEFAULT '',
    created_by  TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (nick_canon, kind, ref)
);

-- Журнал правок данных доблести (Архив скринов) — по неделям, с before/after
-- для отмены. action: edit | add | delete | verify | meta.
CREATE TABLE IF NOT EXISTS valor_edit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    week        TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    member_id   INTEGER,
    nick_canon  TEXT    NOT NULL DEFAULT '',
    nick        TEXT    NOT NULL DEFAULT '',
    before_json TEXT    NOT NULL DEFAULT '',
    after_json  TEXT    NOT NULL DEFAULT '',
    actor_name  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT '',
    undone      INTEGER NOT NULL DEFAULT 0,
    undone_at   TEXT    NOT NULL DEFAULT '',
    undone_by   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_valor_edit_log_week ON valor_edit_log(week);

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

-- Новички: впервые замечены в снимке, при этом НЕ были в прошлом снимке,
-- НЕ в реестре приёма и не возвращенцы. Дают основание для авто-иммунитета
-- (first_date + 7д) без записи в реестр. verified=0 → ник распознан ИИ,
-- ждёт ручной проверки (подсветка в таблице); админ-правка ставит verified=1.
CREATE TABLE IF NOT EXISTS valor_first_seen (
    nick_canon TEXT    PRIMARY KEY,
    first_nick TEXT    NOT NULL,
    first_week TEXT    NOT NULL,
    first_date TEXT    NOT NULL,           -- ISO date для иммунитета
    verified   INTEGER NOT NULL DEFAULT 0  -- 1 = ник проверен админом
);

-- Ручная коррекция написания ника админом. Ключ — стабильный canon
-- (он не меняется при правке отображаемого ника), поэтому коррекция
-- держится из недели в неделю, даже если OCR снова отдаёт кривой ник.
CREATE TABLE IF NOT EXISTS valor_nick_override (
    nick_canon TEXT PRIMARY KEY,
    nick       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT ''
);

-- Слияние ников: ИИ распознал кого-то как нового/другого человека из-за
-- ошибки OCR. Админ говорит «это он и есть» → alias_canon приравнивается к
-- target_canon. Применяется при сохранении снимка (будущие кривые чтения
-- сразу матчатся на правильного) и единоразово переписывает уже сохранённые
-- строки на target.
CREATE TABLE IF NOT EXISTS valor_alias (
    alias_canon  TEXT PRIMARY KEY,
    target_canon TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    created_by   TEXT NOT NULL DEFAULT ''
);

-- Ручной кик: админ переместил человека в архив, даже если он ещё есть в
-- снимке (система не должна держать его в основном списке). Снимается при
-- восстановлении или если человек снова появляется в новом снимке.
CREATE TABLE IF NOT EXISTS valor_force_archived (
    nick_canon  TEXT PRIMARY KEY,
    archived_at TEXT NOT NULL,
    archived_by TEXT NOT NULL DEFAULT '',
    reason      TEXT NOT NULL DEFAULT ''
);

-- Веса (проценты) категорий «Ценности для клана». Одна строка id=1.
-- Сумма ≤ 100; задаёт админ. Из них выводятся все коэффициенты формулы.
CREATE TABLE IF NOT EXISTS valor_weights (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    w_base     REAL NOT NULL DEFAULT 35,
    w_streak   REAL NOT NULL DEFAULT 40,
    w_officer  REAL NOT NULL DEFAULT 10,
    w_veteran  REAL NOT NULL DEFAULT 10,
    w_social   REAL NOT NULL DEFAULT 5,
    updated_at TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT ''
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

    # 2026-06-07: архив Реестра — человек ушёл/кикнут (в т.ч. ДО попадания в
    # таблицу доблести: добавлен в реестр, но не появился на воскресном скрине).
    # archived=1 → скрыт из активного реестра, виден в «Архиве реестра».
    for col in ("archived INTEGER NOT NULL DEFAULT 0",
                "archived_at TEXT NOT NULL DEFAULT ''",
                "archived_by TEXT NOT NULL DEFAULT ''",
                "archived_reason TEXT NOT NULL DEFAULT ''"):
        try:
            conn.execute(f"ALTER TABLE acceptances ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass

    # 2026-07-19: флаг «роль пока не выдана в игре» на записи реестра. Глобальный
    # тумблер (kv_meta.acc_role_pending) при добавлении ставит этот флаг всем новым
    # (и от Лира, и от офицеров), пока Лир его не выключит; снимается по человеку.
    try:
        conn.execute("ALTER TABLE acceptances ADD COLUMN role_pending INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    # 2026-06-08: архив скриншотов сбора доблести (по неделям) — ссылки на R2.
    # Сами кадры в R2 (заливает pw-valor-tracker), здесь — метаданные/ссылки.
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS valor_screenshots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            week        TEXT    NOT NULL,
            idx         INTEGER NOT NULL,
            r2_url      TEXT    NOT NULL,
            r2_key      TEXT    NOT NULL DEFAULT '',
            uploaded_at TEXT    NOT NULL DEFAULT '',
            uploaded_by TEXT    NOT NULL DEFAULT '',
            recognized  INTEGER,   -- сколько строк OCR распознал на этом кадре
            expected    INTEGER,   -- эталон (типичный полный кадр, обычно 9)
            UNIQUE(week, idx)
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_valor_screens_week "
                     "ON valor_screenshots(week)")
        # Запрос на авто-публикацию топа (кнопка «Готово»): 1 строка. Локальный
        # поллер видит requested_at, ждёт 5 мин и публикует, ставит published_at.
        conn.execute("""CREATE TABLE IF NOT EXISTS valor_publish_request (
            id           INTEGER PRIMARY KEY CHECK (id = 1),
            week         TEXT,
            requested_at TEXT,
            published_at TEXT
        )""")
    except sqlite3.OperationalError:
        pass
    # Миграция для существующих БД: колонки распознанных/ожидаемых строк.
    for _col in ("recognized INTEGER", "expected INTEGER"):
        try:
            conn.execute(f"ALTER TABLE valor_screenshots ADD COLUMN {_col}")
        except sqlite3.OperationalError:
            pass

    # 2026-06-07: комментарий к статусу АФК (причина, до какого числа) — по
    # canon, переживает недельные снимки. Заполняет админ в правке участника.
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS valor_afk_note (
            nick_canon TEXT PRIMARY KEY,
            note       TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT ''
        )""")
    except sqlite3.OperationalError:
        pass
    # 2026-06-30: срок АФК — дата 'YYYY-MM-DD', после которой статус снимается
    # сам (valor_expire_afk). Пусто = бессрочно (как было). Офицер/админ задаёт.
    try:
        conn.execute("ALTER TABLE valor_afk_note ADD COLUMN afk_until TEXT NOT NULL DEFAULT ''")
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

    # 2026-06-08: номер кадра (R2 idx), на котором Gemini увидел ник —
    # чтобы клик по нику в «Скринах сбора» подсвечивал ТОЧНЫЙ скрин.
    try:
        conn.execute("ALTER TABLE valor_members ADD COLUMN frame INTEGER")
    except sqlite3.OperationalError:
        pass

    # 2026-06-08: реально людей в клане на момент сбора (ввод офицера) —
    # чтобы сравнивать с тем, сколько распознал Gemini (members_count).
    try:
        conn.execute("ALTER TABLE valor_snapshots ADD COLUMN actual_members INTEGER")
    except sqlite3.OperationalError:
        pass

    # 2026-07-01: ключ ручной сортировки строк (дробный индекс). NULL → строка
    # сортируется по id (порядок чтения со скрина, как раньше). Задаётся при
    # вставке пропущенного ника МЕЖДУ двумя строками: sort_key = середина между
    # соседями → строка встаёт ровно на нужное место, не трогая id остальных.
    try:
        conn.execute("ALTER TABLE valor_members ADD COLUMN sort_key REAL")
    except sqlite3.OperationalError:
        pass

    # 2026-06-16: недели, за которые данные НЕ собирались (пропуск).
    # ОТДЕЛЬНАЯ таблица — чтобы НЕ засорять valor_snapshots (иначе пустой
    # «пропущенный» снимок становился бы «последним» и ломал текущую таблицу
    # Доблести/дельты/статистику). Архив показывает их как виртуальные папки.
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS valor_skipped_weeks (
            week       TEXT PRIMARY KEY,
            marked_at  TEXT NOT NULL DEFAULT '',
            marked_by  TEXT NOT NULL DEFAULT ''
        )""")
    except sqlite3.OperationalError:
        pass

    # 2026-07-02: СИСТЕМА ВОЗВРАТА СОСТАВА. Датированные снимки ростера чатов —
    # чтобы при удалении/чистке чатов владельцем можно было пригласить назад
    # именно тех, кто был у нас В ПОСЛЕДНЕЕ ВРЕМЯ (а не всех когда-либо). Каждый
    # снимок — полный профиль всех участников на дату (JSON) + счётчики.
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS member_snapshots (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            day          TEXT NOT NULL UNIQUE,   -- YYYY-MM-DD (один снимок в день)
            captured_at  TEXT NOT NULL,          -- полный ISO timestamp
            member_count INTEGER NOT NULL DEFAULT 0,
            active_count INTEGER NOT NULL DEFAULT 0,
            roster_json  TEXT NOT NULL DEFAULT '[]'
        )""")
    except sqlite3.OperationalError:
        pass
    # 2026-07-02: ЖИВОЙ РОСТЕР чатов — множество id ВСЕХ участников (вкл.
    # незарегистрированных), кто СЕЙЧАС в VK/TG чатах. Присылает reconcile бота.
    # Даёт точный «в чате сейчас» для ЛЮБОГО (не только зарег.). kv_meta.k=
    # 'live_roster_as_of' хранит дату последнего опроса.
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS live_chat_members (
            platform TEXT NOT NULL,
            user_id  TEXT NOT NULL,
            PRIMARY KEY (platform, user_id)
        )""")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS kv_meta (
            k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT ''
        )""")
    except sqlite3.OperationalError:
        pass

    # last_active_day — последний день, когда человек ПОДТВЕРЖДЁННО был в чатах
    # (is_active=1 на момент снимка). Даёт «был у нас до ДД.ММ» без разбора всех
    # снимков. Обновляется при каждом capture_member_snapshot.
    try:
        conn.execute("ALTER TABLE clan_members ADD COLUMN last_active_day TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass

    # 2026-06-08: детали прощённого предупреждения (для истории прощений).
    try:
        conn.execute("ALTER TABLE valor_warn_dismiss ADD COLUMN detail TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    # 2026-06-08: комментарий-причина прощения.
    try:
        conn.execute("ALTER TABLE valor_warn_dismiss ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
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

    # 2026-06-12: «Тайная комната» → «Курсы волшебства» — трекер обучения
    # (admin-only). Список курсов сидируется из chamber_courses.json (порт
    # десктопного Learning Tracker). magic_courses держит метаданные курса
    # (+ поля под будущий VK-трекинг), magic_progress — прогресс просмотра,
    # magic_daily — посуточный журнал для расчёта темпа, magic_settings —
    # дневная норма и дата старта.
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS magic_courses (
                id           TEXT PRIMARY KEY,
                phase_id     INTEGER NOT NULL DEFAULT 0,
                phase_name   TEXT NOT NULL DEFAULT '',
                category     TEXT NOT NULL DEFAULT '',
                name         TEXT NOT NULL DEFAULT '',
                type         TEXT NOT NULL DEFAULT 'must',
                alt_for      TEXT,
                hours        REAL NOT NULL DEFAULT 0,
                why          TEXT NOT NULL DEFAULT '',
                sort         INTEGER NOT NULL DEFAULT 0,
                vk_owner_id  INTEGER,
                vk_video_id  INTEGER,
                duration_sec INTEGER
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS magic_progress (
                course_id   TEXT PRIMARY KEY,
                watched_sec INTEGER NOT NULL DEFAULT 0,
                completed   INTEGER NOT NULL DEFAULT 0,
                updated_at  TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS magic_daily (
                day         TEXT PRIMARY KEY,
                watched_sec INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS magic_settings (
                id             INTEGER PRIMARY KEY CHECK (id = 1),
                daily_target_h REAL NOT NULL DEFAULT 4,
                start_date     TEXT
            )
        """)
        conn.execute("INSERT OR IGNORE INTO magic_settings (id, daily_target_h) "
                     "VALUES (1, 4)")
    except sqlite3.OperationalError:
        pass

    # 2026-06-30: ручная калибровка раскладки строк на скринах сбора доблести.
    # Для недели (snapshot) можно задать прямоугольник области строк в ДОЛЯХ
    # кадра (0..1): frame=-1 — дефолт на все кадры недели, frame>=0 —
    # переопределение конкретного кадра. Строки внутри прямоугольника
    # раскладываются равномерно по числу участников этого кадра. Нужно для
    # старых сборов, где десктоп ещё не присылал координаты строк (без неё
    # подсветка строки оценивается грубо — по всей высоте кадра).
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS valor_frame_calib (
                snapshot_id INTEGER NOT NULL
                            REFERENCES valor_snapshots(id) ON DELETE CASCADE,
                frame       INTEGER NOT NULL,   -- idx скрина; -1 = дефолт недели
                x  REAL NOT NULL, y  REAL NOT NULL,
                w  REAL NOT NULL, h  REAL NOT NULL,
                rh  REAL,                       -- фикс. высота строки (доля кадра)
                off REAL,                       -- перекрытие кадров (строк, на default)
                cols TEXT,                      -- колонки: JSON [{x,key}] (вертик. разметка)
                PRIMARY KEY (snapshot_id, frame)
            )
        """)
    except sqlite3.OperationalError:
        pass

    # 2026-06-30: фикс. высота строки rh — чтобы сетка строк была ОДИНАКОВОЙ на
    # всех кадрах (раньше делили область /n, а n у кадров разное → разнобой).
    try:
        conn.execute("ALTER TABLE valor_frame_calib ADD COLUMN rh REAL")
    except sqlite3.OperationalError:
        pass
    # 2026-06-30: перекрытие кадров off (строк) — частичная прокрутка между
    # скринами (строки нового кадра начинаются ниже на off). Хранится на default.
    try:
        conn.execute("ALTER TABLE valor_frame_calib ADD COLUMN off REAL")
    except sqlite3.OperationalError:
        pass
    # 2026-06-30: вертикальная разметка колонок cols — JSON [{x,key}] (левый край
    # колонки в долях кадра + поле: nick/level/class/rank/title/valor). Чтобы
    # программа знала где какая КОЛОНКА (вместе со строками = полная сетка ячеек).
    try:
        conn.execute("ALTER TABLE valor_frame_calib ADD COLUMN cols TEXT")
    except sqlite3.OperationalError:
        pass

    # 2026-07-06: valor_history копил ДУБЛИ (одна неделя/поле у одного канона
    # дважды) — из-за merge ников (UPDATE nick_canon сливал строки двух канонов
    # без дедупа) и повторной загрузки прошлой недели/ручного добавления.
    # В попапе истории это давало дважды одну и ту же неделю. Чистим дубли
    # (оставляем самую свежую строку = max id) и ставим UNIQUE-индекс, чтобы
    # впредь дубли были невозможны (вставки идут через INSERT OR REPLACE).
    conn.execute(
        """DELETE FROM valor_history WHERE id NOT IN (
               SELECT MAX(id) FROM valor_history
               GROUP BY nick_canon, field, week)""")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_valor_history_uniq "
        "ON valor_history(nick_canon, field, week)")


def init_db() -> None:
    db_path = Path(settings.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connection() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        magic_seed_courses(conn)


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
    note = row["note"]
    return {
        "id": row["id"],
        "game_nick": row["game_nick"],
        "nick_canon": _valor_canon(row["game_nick"]),
        "note_count": 0 if (not note or _is_note_noise(note)) else 1,
        "title": row["title"] if "title" in keys else "",
        "accepted_date": row["accepted_date"],
        "immune_until": immune_until.isoformat(),
        "immune_active": date.today() < immune_until,
        "note": "" if _is_note_noise(note) else note,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "created_by_platform": row["created_by_platform"],
        "created_by_id": row["created_by_id"],
        "created_by_name": row["created_by_name"],
        "archived": bool(row["archived"]) if "archived" in keys else False,
        "archived_at": row["archived_at"] if "archived_at" in keys else "",
        "archived_by": row["archived_by"] if "archived_by" in keys else "",
        "archived_reason": row["archived_reason"] if "archived_reason" in keys else "",
        "role_pending": bool(row["role_pending"]) if "role_pending" in keys else False,
    }


def list_acceptances(include_archived: bool = False) -> list[dict[str, Any]]:
    """Активный реестр (archived=0). include_archived=True → и ушедшие тоже."""
    where = "" if include_archived else "WHERE COALESCE(archived,0) = 0"
    with connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM acceptances {where} ORDER BY accepted_date ASC, id ASC"
        ).fetchall()
        # Признак «Ветеран» по тегу в Доблести (для отображения и редактирования).
        vet = {r["nick_canon"] for r in conn.execute(
            "SELECT nick_canon FROM valor_tags WHERE tag = 'veteran'")}
        # Признак «Элита» (Топ по урону) — тоже по тегу в Доблести.
        elite_set = {r["nick_canon"] for r in conn.execute(
            "SELECT nick_canon FROM valor_tags WHERE tag = 'elite'")}
        # Число записей в «свитке» по канону (шум не считаем) — для бейджа, как в
        # таблице Доблести. Реестр и Доблесть показывают примечание одинаково.
        note_cnt: dict[str, int] = {}
        for r in conn.execute("SELECT nick_canon, text FROM valor_note_history"):
            if _is_note_noise(r["text"]):
                continue
            note_cnt[r["nick_canon"]] = note_cnt.get(r["nick_canon"], 0) + 1
        out = []
        for r in rows:
            d = _row_to_acceptance(r)
            canon = _valor_canon(d["game_nick"])
            d["veteran"] = canon in vet
            d["elite"] = canon in elite_set
            d["nick_canon"] = canon
            # Шум («Ветеран») в примечании не показываем — как в Доблести.
            if _is_note_noise(d.get("note")):
                d["note"] = ""
            cnt = note_cnt.get(canon, 0)
            # Нет истории, но есть непустая заметка реестра → это 1 (ленивый seed).
            if not cnt and (d.get("note") or "").strip():
                cnt = 1
            d["note_count"] = cnt
            out.append(d)
        return out


def valor_screenshots_set(week: str, shots: list[dict], actor: dict | None = None) -> dict:
    """Сохранить (заменить) набор скринов недели. shots: [{idx,url,key}]."""
    week = (week or "").strip()
    if not week:
        return {"ok": False, "error": "no_week"}
    by = (actor or {}).get("name", "")
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute("DELETE FROM valor_screenshots WHERE week = ?", (week,))
        n = 0
        for s in shots or []:
            url = (s.get("url") or "").strip()
            if not url:
                continue
            rec = s.get("recognized")
            exp = s.get("expected")
            conn.execute(
                "INSERT OR REPLACE INTO valor_screenshots "
                "(week, idx, r2_url, r2_key, uploaded_at, uploaded_by, recognized, expected) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (week, int(s.get("idx", n)), url, s.get("key", ""), now, by,
                 int(rec) if isinstance(rec, int) else None,
                 int(exp) if isinstance(exp, int) else None))
            n += 1
    return {"ok": True, "week": week, "count": n}


def valor_request_publish(week: str) -> dict:
    """Кнопка «Готово»: заявка на авто-публикацию топа за неделю. Сброс
    published_at → поллер опубликует через 5 мин."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            "INSERT INTO valor_publish_request (id, week, requested_at, published_at) "
            "VALUES (1, ?, ?, NULL) "
            "ON CONFLICT(id) DO UPDATE SET week = ?, requested_at = ?, published_at = NULL",
            ((week or "").strip(), now, (week or "").strip(), now))
    return {"ok": True, "week": week, "requested_at": now}


def valor_get_publish_request() -> dict:
    """Текущая заявка на публикацию (для локального поллера)."""
    with connection() as conn:
        r = conn.execute(
            "SELECT week, requested_at, published_at FROM valor_publish_request "
            "WHERE id = 1").fetchone()
    if not r:
        return {"week": None, "requested_at": None, "published_at": None}
    return {"week": r["week"], "requested_at": r["requested_at"],
            "published_at": r["published_at"]}


def valor_mark_published(week: str) -> dict:
    """Поллер отметил, что опубликовал за неделю."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            "UPDATE valor_publish_request SET published_at = ? "
            "WHERE id = 1 AND week = ?", (now, (week or "").strip()))
    return {"ok": True, "published_at": now}


def valor_latest_week() -> str | None:
    with connection() as conn:
        r = conn.execute(
            "SELECT week FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    return r["week"] if r else None


def valor_compare_data(week: str) -> dict:
    """Данные для страницы сравнения скринов с распознанным: участники недели
    (как внесла база) + флаги (распознан из реестра / ИИ / сомнительно) +
    список скринов. Участники по убыванию доблести (как в игре)."""
    week = (week or "").strip()
    with connection() as conn:
        snap = conn.execute(
            "SELECT * FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"week": week, "snapshot": None, "members": [], "screenshots": []}
        # Реестр приёма: набор canon + точное написание ника (эталон, Лир
        # копирует из игры). reg_nick[canon] = написание; позднее перетирает.
        reg: set[str] = set()
        reg_nick: dict[str, str] = {}
        for rr in conn.execute(
                "SELECT game_nick FROM acceptances WHERE COALESCE(archived,0)=0 "
                "ORDER BY accepted_date"):
            for c, p in _acceptance_nicks(rr["game_nick"]):
                reg.add(c)
                reg_nick[c] = p
        # Явная админ-коррекция ника (override) ГЛАВЕНСТВУЕТ над реестром:
        # если админ поправил написание кнопкой ✎, оно и показывается, даже
        # если в реестре другой вариант (напр. реестр внесён с опечаткой, или
        # два разных ника канонятся одинаково и поздняя запись реестра перетёрла).
        nick_override: dict[str, str] = {
            r["nick_canon"]: r["nick"]
            for r in conn.execute(
                "SELECT nick_canon, nick FROM valor_nick_override WHERE nick != ''")}
        # Ручной кик (force_archived): такие есть в снимке, но Таблица их
        # скрывает. Без этой инфы Скрины молча показывали бы на 1 больше, чем
        # Таблица (напр. распознано 200, а в Таблице 199). Отдаём флаг + инфо,
        # чтобы фронт пометил строку и честно свёл счётчик.
        arch_info: dict[str, dict] = {
            r["nick_canon"]: {"at": r["archived_at"], "by": r["archived_by"],
                              "reason": r["reason"]}
            for r in conn.execute(
                "SELECT nick_canon, archived_at, archived_by, reason "
                "FROM valor_force_archived")}
        rows = conn.execute(
            "SELECT id, nick, nick_canon, true_name, rank, title, level, "
            "class_, valor, is_afk, norm_met, flag_new_nick, flag_ocr_suspect, frame "
            "FROM valor_members WHERE snapshot_id = ? "
            # Порядок РОВНО как на скринах: сборщик присылает ников в порядке
            # чтения сверху вниз (доблесть по убыванию, тай-брейки — реальный
            # порядок в игровом списке), и мы храним их в этом же порядке (id).
            # Пересортировка по valor/frame/nick ломала это (тёзки одной доблести
            # вставали по алфавиту, а не как на экране). Поэтому ORDER BY id.
            # sort_key (дробный индекс) задаётся только у вручную вставленных
            # МЕЖДУ строк — иначе NULL → падает в id, порядок чтения сохраняется.
            "ORDER BY COALESCE(sort_key, id), id",
            (snap["id"],)).fetchall()
        members = [{
            "id": r["id"],
            # Приоритет написания: админ-override → реестр → как распознали.
            "nick": (nick_override.get(r["nick_canon"])
                     or reg_nick.get(r["nick_canon"], r["nick"])),
            "nick_canon": r["nick_canon"],
            "in_registry": r["nick_canon"] in reg,
            # Если ник есть в реестре приёма — написание авторитетно (Лир
            # копирует ник из игры), сомнений по нику быть не должно. Поэтому
            # flag_new_nick подавляется для тех, кто уже в реестре (флаг мог
            # «устареть»: ник пометился новым ДО добавления в реестр).
            "flag_new_nick": bool(r["flag_new_nick"]) and (r["nick_canon"] not in reg),
            "flag_ocr_suspect": bool(r["flag_ocr_suspect"]),
            "true_name": r["true_name"], "rank": r["rank"], "title": r["title"],
            "level": r["level"], "class": r["class_"], "valor": r["valor"],
            "is_afk": bool(r["is_afk"]), "frame": r["frame"],
            # Ручной кик: строка есть в снимке, но в Таблице скрыта.
            "force_archived": r["nick_canon"] in arch_info,
            "archive_info": arch_info.get(r["nick_canon"]),
        } for r in rows]
        shots = [{"idx": r["idx"], "url": r["r2_url"],
                  "recognized": r["recognized"], "expected": r["expected"]}
                 for r in conn.execute(
            "SELECT idx, r2_url, recognized, expected FROM valor_screenshots "
            "WHERE week = ? ORDER BY idx", (week,))]
        # Ручная калибровка раскладки строк (если задана) — фронт точно
        # подсвечивает строку-источник вместо грубой оценки по высоте кадра.
        calib = {"default": None, "frames": {}}
        for cr in conn.execute(
                "SELECT frame, x, y, w, h, rh, off, cols FROM valor_frame_calib "
                "WHERE snapshot_id = ?", (snap["id"],)):
            rect = {"x": cr["x"], "y": cr["y"], "w": cr["w"], "h": cr["h"],
                    "rh": cr["rh"], "off": cr["off"], "cols": _cols_from_json(cr["cols"])}
            if cr["frame"] == -1:
                calib["default"] = rect
            else:
                calib["frames"][str(cr["frame"])] = rect
        return {"week": week, "snapshot": dict(snap), "members": members,
                "screenshots": shots, "calib": calib}


def valor_set_frames(week: str, items: list[dict]) -> dict:
    """Проставляет valor_members.frame (idx скрина) по canon для снимка недели.
    items: [{nick, frame}]. Не трогает остальные поля (правки сохраняются).
    Возвращает {ok, updated, missing}."""
    week = (week or "").strip()
    updated = 0
    missing = 0
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        amap = _alias_map(conn)
        for it in items:
            nick = (it.get("nick") or "").strip()
            frame = it.get("frame")
            if not nick or not isinstance(frame, int):
                continue
            canon = _resolve_canon(_valor_canon(nick), amap)
            cur = conn.execute(
                "UPDATE valor_members SET frame = ? "
                "WHERE snapshot_id = ? AND nick_canon = ?",
                (frame, snap["id"], canon))
            if cur.rowcount:
                updated += cur.rowcount
            else:
                missing += 1
    return {"ok": True, "updated": updated, "missing": missing}


def _clamp01(v) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


_CALIB_COL_KEYS = {"nick", "level", "class", "rank", "title", "valor", "true_name", "other"}


def valor_first_screenshot_url(week: str) -> str | None:
    """URL первого (по idx) скрина недели — для авто-детекции сетки."""
    week = (week or "").strip()
    with connection() as conn:
        r = conn.execute(
            "SELECT r2_url FROM valor_screenshots WHERE week = ? ORDER BY idx LIMIT 1",
            (week,)).fetchone()
        return r["r2_url"] if r else None


def _norm_cols(cols) -> list:
    """Валидирует вертикальную разметку колонок: список {x (0..1), key}.
    Отбрасывает мусор, сортирует по x. Возвращает [] если пусто/некорректно."""
    if not isinstance(cols, (list, tuple)):
        return []
    out = []
    for c in cols:
        if not isinstance(c, dict):
            continue
        key = str(c.get("key", "")).strip()
        if key not in _CALIB_COL_KEYS:
            continue
        x = _clamp01(c.get("x"))
        out.append({"x": x, "key": key})
    out.sort(key=lambda c: c["x"])
    return out


def _cols_from_json(s):
    try:
        return _norm_cols(json.loads(s)) if s else []
    except (ValueError, TypeError):
        return []


def valor_calib_get(week: str) -> dict:
    """Ручная калибровка раскладки строк недели:
    {"default": {x,y,w,h}|None, "frames": {"<idx>": {x,y,w,h}}}.
    Координаты — доли кадра 0..1."""
    week = (week or "").strip()
    out = {"default": None, "frames": {}}
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return out
        for r in conn.execute(
                "SELECT frame, x, y, w, h, rh, off, cols FROM valor_frame_calib "
                "WHERE snapshot_id = ?", (snap["id"],)):
            rect = {"x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"],
                    "rh": r["rh"], "off": r["off"], "cols": _cols_from_json(r["cols"])}
            if r["frame"] == -1:
                out["default"] = rect
            else:
                out["frames"][str(r["frame"])] = rect
    return out


def valor_calib_set(week: str, frame: int, rect: dict | None) -> dict:
    """Задать/обновить (rect={x,y,w,h} в долях 0..1) или удалить (rect=None)
    калибровку строк кадра. frame=-1 — дефолт на всю неделю."""
    week = (week or "").strip()
    try:
        frame = int(frame)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "bad_frame"}
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        sid = snap["id"]
        if rect is None:
            conn.execute("DELETE FROM valor_frame_calib "
                         "WHERE snapshot_id = ? AND frame = ?", (sid, frame))
            return {"ok": True, "deleted": True}
        x, y = _clamp01(rect.get("x")), _clamp01(rect.get("y"))
        w, h = _clamp01(rect.get("w")), _clamp01(rect.get("h"))
        if w <= 0 or h <= 0:
            return {"ok": False, "reason": "empty_rect"}
        rh = rect.get("rh")
        rh = _clamp01(rh) if rh is not None else None
        if rh is not None and rh <= 0:
            rh = None
        off = rect.get("off")
        try:
            off = float(off) if off is not None else None
        except (TypeError, ValueError):
            off = None
        if off is not None and off < 0:
            off = 0.0
        # Вертикальная разметка колонок (если прислана) → JSON.
        cols = _norm_cols(rect.get("cols")) if rect.get("cols") is not None else None
        cols_json = json.dumps(cols, ensure_ascii=False) if cols is not None else None
        conn.execute(
            "INSERT INTO valor_frame_calib (snapshot_id, frame, x, y, w, h, rh, off, cols) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(snapshot_id, frame) "
            # cols через COALESCE: если не прислали (None) — сохраняем прежние.
            "DO UPDATE SET x = ?, y = ?, w = ?, h = ?, rh = ?, off = ?, "
            "cols = COALESCE(?, cols)",
            (sid, frame, x, y, w, h, rh, off, cols_json,
             x, y, w, h, rh, off, cols_json))
        return {"ok": True, "rect": {"x": x, "y": y, "w": w, "h": h,
                                     "rh": rh, "off": off, "cols": cols or []}}


def valor_calib_clear(week: str) -> dict:
    """Удалить всю калибровку недели (дефолт + переопределения кадров)."""
    week = (week or "").strip()
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        cur = conn.execute("DELETE FROM valor_frame_calib WHERE snapshot_id = ?",
                           (snap["id"],))
        return {"ok": True, "deleted": cur.rowcount}


def valor_screenshot_weeks() -> list[dict]:
    """Список недель со скринами (для «папок»): {week, count, uploaded_at}."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT week, COUNT(*) AS cnt, MAX(uploaded_at) AS up "
            "FROM valor_screenshots GROUP BY week ORDER BY week DESC").fetchall()
        return [{"week": r["week"], "count": r["cnt"], "uploaded_at": r["up"]}
                for r in rows]


def valor_screenshots_for(week: str) -> list[dict]:
    """Скрины конкретной недели по порядку: {idx, url}."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT idx, r2_url, recognized, expected FROM valor_screenshots "
            "WHERE week = ? ORDER BY idx", ((week or "").strip(),)).fetchall()
        return [{"idx": r["idx"], "url": r["r2_url"],
                 "recognized": r["recognized"], "expected": r["expected"]}
                for r in rows]


def valor_afk_notes() -> dict[str, str]:
    """canon → комментарий к АФК (причина/до какого числа)."""
    with connection() as conn:
        return {r["nick_canon"]: r["note"] for r in conn.execute(
            "SELECT nick_canon, note FROM valor_afk_note WHERE note != ''")}


def valor_afk_info() -> dict[str, dict]:
    """canon → {note, until}: комментарий к АФК и срок (дата 'YYYY-MM-DD' или '')."""
    with connection() as conn:
        return {r["nick_canon"]: {"note": r["note"], "until": r["afk_until"]}
                for r in conn.execute(
                    "SELECT nick_canon, note, afk_until FROM valor_afk_note")}


def _norm_afk_until(v) -> str:
    """Нормализует срок АФК в 'YYYY-MM-DD' (или '' если пусто/некорректно)."""
    if not v:
        return ""
    s = str(v).strip()[:10]
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return s
    except ValueError:
        return ""


def valor_expire_afk() -> dict:
    """Снимает АФК у тех, чей срок (afk_until) истёк (дата < сегодня, UTC).
    Снимает флаг is_afk на ПОСЛЕДНЕМ снимке игрока и удаляет запись срока/заметки.
    Запускается лениво при чтении текущей таблицы и в планировщике."""
    today = datetime.utcnow().date().isoformat()
    expired = 0
    with connection() as conn:
        rows = conn.execute(
            "SELECT nick_canon, afk_until FROM valor_afk_note "
            "WHERE afk_until != '' AND afk_until < ?", (today,)).fetchall()
        sysactor = {"platform": "system", "id": "", "name": "авто (срок АФК)"}
        for r in rows:
            canon = r["nick_canon"]
            last = conn.execute(
                "SELECT vm.id, vm.nick, vm.is_afk, vm.title FROM valor_members vm "
                "JOIN valor_snapshots vs ON vm.snapshot_id = vs.id "
                "WHERE vm.nick_canon = ? ORDER BY vs.week DESC, vm.id DESC LIMIT 1",
                (canon,)).fetchone()
            if last and last["is_afk"]:
                conn.execute("UPDATE valor_members SET is_afk = 0 WHERE id = ?",
                             (last["id"],))
                # Если в ТИТУЛЕ всё ещё «АФК» — игрок остаётся АФК по титулу
                # (игровой сигнал); снимаем только РУЧНОЙ срок. Аудит — правдиво.
                still = _title_is_afk(last["title"])
                _write_audit(conn, "afk_expired", None, last["nick"],
                             {"is_afk": True, "afk_until": r["afk_until"]},
                             {"is_afk": still, "afk_via_title": still}, sysactor)
            conn.execute("DELETE FROM valor_afk_note WHERE nick_canon = ?", (canon,))
            expired += 1
    return {"expired": expired}


def valor_known_nicks() -> list[str]:
    """Все известные ники клана — для подсказки Gemini/OCR при распознавании:
    из снимков доблести, ручных override-ников и АКТИВНОГО реестра (новенькие).
    Дедуп по нижнему регистру, сортировка по алфавиту."""
    seen: dict[str, str] = {}
    with connection() as conn:
        queries = (
            "SELECT DISTINCT nick FROM valor_members WHERE nick != ''",
            "SELECT DISTINCT nick FROM valor_nick_override WHERE nick != ''",
            "SELECT DISTINCT game_nick AS nick FROM acceptances "
            "WHERE COALESCE(archived,0) = 0 AND game_nick != ''",
        )
        for q in queries:
            for r in conn.execute(q):
                n = (r["nick"] or "").strip()
                if n:
                    seen.setdefault(n.lower(), n)
    return sorted(seen.values(), key=lambda s: s.lower())


def list_archived_acceptances() -> list[dict[str, Any]]:
    """Только ушедшие из клана (archived=1) — для «Архива реестра»."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM acceptances WHERE COALESCE(archived,0) = 1 "
            "ORDER BY archived_at DESC, id DESC"
        ).fetchall()
        return [_row_to_acceptance(r) for r in rows]


def set_acceptance_archived(acc_id: int, archived: bool, *, reason: str,
                            actor: dict[str, str]) -> dict[str, Any] | None:
    """Отправить запись реестра в архив (ушёл/кикнут) или вернуть из архива."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = actor.get("name") or actor.get("role") or ""
    with connection() as conn:
        before = conn.execute("SELECT * FROM acceptances WHERE id = ?", (acc_id,)).fetchone()
        if not before:
            return None
        conn.execute(
            "UPDATE acceptances SET archived = ?, archived_at = ?, archived_by = ?, "
            "archived_reason = ?, updated_at = ? WHERE id = ?",
            (1 if archived else 0, now if archived else "", by if archived else "",
             (reason or "").strip() if archived else "", now, acc_id))
        after = conn.execute("SELECT * FROM acceptances WHERE id = ?", (acc_id,)).fetchone()
        _write_audit(conn, "archive" if archived else "unarchive", acc_id,
                     before["game_nick"], dict(before), dict(after), actor)
        _mark_dirty(conn)
        return _row_to_acceptance(after)


def get_acceptance(acc_id: int) -> dict[str, Any] | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        return _row_to_acceptance(row) if row else None


_ROLE_PENDING_KEY = "acc_role_pending"


def get_role_pending_default() -> bool:
    """Глобальный тумблер «роль пока не выдана в игре» для новых записей реестра."""
    with connection() as conn:
        r = conn.execute("SELECT v FROM kv_meta WHERE k = ?", (_ROLE_PENDING_KEY,)).fetchone()
        return bool(r and str(r["v"]) == "1")


def set_role_pending_default(on: bool) -> bool:
    with connection() as conn:
        conn.execute(
            "INSERT INTO kv_meta(k, v) VALUES(?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (_ROLE_PENDING_KEY, "1" if on else "0"))
    return on


def clear_role_pending_all() -> int:
    """Снять флаг role_pending со ВСЕХ записей (после копирования списка Лиром).
    Список набирается заново по мере добавления новых. Не трогает Доблесть."""
    with connection() as conn:
        cur = conn.execute("UPDATE acceptances SET role_pending = 0 WHERE role_pending = 1")
        return cur.rowcount


def create_acceptance(
    *,
    game_nick: str,
    title: str,
    accepted_date: str,
    note: str,
    veteran: bool = False,
    elite: bool = False,
    role_pending: bool | None = None,
    actor: dict[str, str],
) -> dict[str, Any]:
    now = datetime.utcnow().isoformat(timespec="seconds")
    # role_pending не задан явно → берём глобальный тумблер (активен для всех новых,
    # кого добавляет Лир И офицеры, пока Лир его не выключит).
    rp = get_role_pending_default() if role_pending is None else bool(role_pending)
    with connection() as conn:
        cur = conn.execute(
            """INSERT INTO acceptances
               (game_nick, title, accepted_date, note, created_at, updated_at,
                created_by_platform, created_by_id, created_by_name, role_pending)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                1 if rp else 0,
            ),
        )
        acc_id = cur.lastrowid
        # Слияние с Доблестью: если этот человек уже есть в таблице доблести
        # (тот же canon — напр. твин старичка уже светился на скрине), привязываем
        # запись реестра к нему: эталонное написание ника, снятие «ИИ/новичок»-флага,
        # миграция canon при расхождении написания. Тот же механизм, что при
        # переименовании (update_acceptance). Если в доблести его ещё нет — безвредно.
        canon = _valor_canon(game_nick)
        if canon:
            _by = actor.get("name") or actor.get("role") or ""
            _sync_nick_in_conn(conn, canon, game_nick.strip(), now, _by)
            # Роль «Ветеран» сразу при добавлении (твины старичков клана).
            if veteran:
                conn.execute(
                    "INSERT OR IGNORE INTO valor_tags "
                    "(nick_canon, tag, source, added_at) VALUES (?, 'veteran', 'registry', ?)",
                    (canon, now),
                )
            # Роль «Элита» (Топ по урону) — тоже сразу при добавлении.
            if elite:
                conn.execute(
                    "INSERT OR IGNORE INTO valor_tags "
                    "(nick_canon, tag, source, added_at) VALUES (?, 'elite', 'registry', ?)",
                    (canon, now),
                )
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
    veteran: bool | None = None,
    elite: bool | None = None,
    role_pending: bool | None = None,
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
        cur_rp = (before["role_pending"] if "role_pending" in before.keys() else 0)
        new_rp = cur_rp if role_pending is None else (1 if role_pending else 0)
        now = datetime.utcnow().isoformat(timespec="seconds")

        conn.execute(
            """UPDATE acceptances
               SET game_nick = ?, title = ?, accepted_date = ?, note = ?, updated_at = ?,
                   role_pending = ?
               WHERE id = ?""",
            (new_nick, new_title, new_date, new_note, now, new_rp, acc_id),
        )
        after = conn.execute(
            "SELECT * FROM acceptances WHERE id = ?", (acc_id,)
        ).fetchone()
        # Синхронизация ника Реестр → Доблесть: если ник сменился, обновляем
        # отображаемый ник в Доблести (override) и привязку (canon-миграция),
        # чтобы это был тот же человек и связи (примечание/иммунитет) держались.
        old_nick = before["game_nick"]
        if new_nick != old_nick:
            _by = actor.get("name") or actor.get("role") or ""
            _sync_nick_in_conn(conn, _valor_canon(old_nick), new_nick, now, _by)
        # Роль «Ветеран» при редактировании: ставим/снимаем тег в Доблести.
        if veteran is not None:
            canon = _valor_canon(new_nick)
            if canon:
                if veteran:
                    conn.execute(
                        "INSERT OR IGNORE INTO valor_tags "
                        "(nick_canon, tag, source, added_at) VALUES (?, 'veteran', 'registry', ?)",
                        (canon, now))
                else:
                    conn.execute(
                        "DELETE FROM valor_tags WHERE nick_canon = ? AND tag = 'veteran'",
                        (canon,))
        # Роль «Элита» (Топ по урону) при редактировании: ставим/снимаем тег.
        if elite is not None:
            canon = _valor_canon(new_nick)
            if canon:
                if elite:
                    conn.execute(
                        "INSERT OR IGNORE INTO valor_tags "
                        "(nick_canon, tag, source, added_at) VALUES (?, 'elite', 'registry', ?)",
                        (canon, now))
                else:
                    conn.execute(
                        "DELETE FROM valor_tags WHERE nick_canon = ? AND tag = 'elite'",
                        (canon,))
        # Синхрон примечания Реестр → «свиток»: если текст изменился и непустой,
        # дописываем в историю (source=registry), чтобы заметки реестра и таблицы
        # Доблести были одной историей.
        if note is not None and (new_note or "") != (before["note"] or "") and new_note:
            _note_hist_append_conn(conn, _valor_canon(new_nick), new_note,
                                   actor.get("name") or "", actor.get("role") or "",
                                   source="registry")
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


# ==================== ИСТОРИЯ ПРИМЕЧАНИЙ («свиток») ====================
# Примечание о человеке ведётся как append-only история, общая для реестра
# приёма (acceptances.note) и таблицы Доблести. Текущее примечание = самая
# свежая запись. Офицеры и админ дополняют прямо из таблицы; правка заметки
# в реестре тоже дописывается сюда (см. update_acceptance).

# Слова-«шум»: роль/статус, случайно вписанные в поле примечания вместо реальной
# заметки. Роль «Ветеран» уже есть отдельным тегом — в примечании она не нужна.
# Точное совпадение (bare «Ветеран»), реальные заметки со словом внутри не трогаем.
_NOTE_NOISE = {"ветеран", "вет", "veteran"}


def _is_note_noise(text):
    return (text or "").strip().lower() in _NOTE_NOISE


def _note_hist_append_conn(conn, nick_canon, text, author, author_role, source="valor"):
    """Дописать запись в историю примечаний ВНУТРИ существующей транзакции."""
    text = (text or "").strip()
    nick_canon = (nick_canon or "").strip()
    if not nick_canon or not text:
        return None
    now = datetime.utcnow().isoformat(timespec="seconds")
    cur = conn.execute(
        "INSERT INTO valor_note_history "
        "(nick_canon, text, author, author_role, source, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (nick_canon, text, author or "", author_role or "", source, now))
    return {"id": cur.lastrowid, "nick_canon": nick_canon, "text": text,
            "author": author or "", "author_role": author_role or "",
            "source": source, "created_at": now}


def _note_hist_seed_conn(conn, nick_canon):
    """Ленивая инициализация: если истории ещё нет, а в реестре (acceptances.note)
    есть непустое примечание — заносим его первой записью «свитка» (source=seed),
    чтобы старые заметки реестра появились в истории."""
    nick_canon = (nick_canon or "").strip()
    if not nick_canon:
        return
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM valor_note_history WHERE nick_canon = ?",
        (nick_canon,)).fetchone()
    if row and row["n"]:
        return
    for r in conn.execute(
            "SELECT game_nick, note, accepted_date, updated_at FROM acceptances"):
        note = (r["note"] or "").strip()
        if not note or _is_note_noise(note):
            continue
        if any(_valor_canon(p) == nick_canon
               for p in (r["game_nick"] or "").split(",")):
            ts = r["updated_at"] or r["accepted_date"] \
                or datetime.utcnow().isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO valor_note_history "
                "(nick_canon, text, author, author_role, source, created_at) "
                "VALUES (?, ?, 'Реестр', '', 'seed', ?)",
                (nick_canon, note, ts))
            break


def _note_hist_rows(conn, nick_canon):
    return [dict(r) for r in conn.execute(
        "SELECT id, text, author, author_role, source, created_at "
        "FROM valor_note_history WHERE nick_canon = ? ORDER BY created_at, id",
        (nick_canon,))]


def _note_sync_registry(conn, nick_canon, text):
    """Обновляет acceptances.note для этого канона на `text` (последняя версия),
    если запись приёма существует. Держит реестр и «свиток» синхронными."""
    for r in conn.execute("SELECT id, game_nick FROM acceptances"):
        if any(_valor_canon(p) == nick_canon
               for p in (r["game_nick"] or "").split(",")):
            conn.execute(
                "UPDATE acceptances SET note = ?, updated_at = ? WHERE id = ?",
                (text, datetime.utcnow().isoformat(timespec="seconds"), r["id"]))
            return True
    return False


def valor_note_history(nick_canon):
    """История примечаний по канону (старые сверху). Ленивый seed из реестра.
    Возвращает {"notes":[...], "current":<текст последней>, "count":N}."""
    nick_canon = (nick_canon or "").strip()
    if not nick_canon:
        return {"notes": [], "current": "", "count": 0}
    with connection() as conn:
        _note_hist_seed_conn(conn, nick_canon)
        rows = _note_hist_rows(conn, nick_canon)
    return {"notes": rows, "current": rows[-1]["text"] if rows else "",
            "count": len(rows)}


def valor_note_add(nick_canon, text, actor):
    """Добавляет запись в «свиток» + синхронизирует acceptances.note (последняя
    версия). Возвращает историю целиком (как getter). None — если пусто."""
    nick_canon = (nick_canon or "").strip()
    text = (text or "").strip()
    if not nick_canon or not text:
        return None
    author = (actor or {}).get("name") or ""
    role = (actor or {}).get("role") or ""
    with connection() as conn:
        _note_hist_seed_conn(conn, nick_canon)
        _note_hist_append_conn(conn, nick_canon, text, author, role, source="valor")
        _note_sync_registry(conn, nick_canon, text)
        _mark_dirty(conn)
        rows = _note_hist_rows(conn, nick_canon)
    return {"notes": rows, "current": rows[-1]["text"] if rows else "",
            "count": len(rows)}


def valor_note_delete(entry_id, nick_canon):
    """Удаляет одну запись «свитка» (админ — правка ошибок). Пересинхронизирует
    примечание реестра на новую последнюю запись. None — если записи не было."""
    nick_canon = (nick_canon or "").strip()
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM valor_note_history WHERE id = ? AND nick_canon = ?",
            (entry_id, nick_canon))
        if not cur.rowcount:
            return None
        rows = _note_hist_rows(conn, nick_canon)
        current = rows[-1]["text"] if rows else ""
        _note_sync_registry(conn, nick_canon, current)
        _mark_dirty(conn)
    return {"notes": rows, "current": current, "count": len(rows)}


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


# Категории фильтра по типу вложения (UI-ключ → реальные kind'ы в media_json).
# Позволяет искать «только фото / только голосовые / только видео» и т.д.
_CHAT_MEDIA_CATEGORIES = {
    "photo":   ("photo",),
    "video":   ("video", "video_note"),
    "voice":   ("voice",),
    "audio":   ("audio",),
    "sticker": ("sticker", "sticker_video", "sticker_anim_thumb", "animation"),
    "file":    ("doc", "document"),
    "link":    ("link", "wall"),
}


def list_chat_messages(
    *,
    chat_group: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    user: str | None = None,
    search: str | None = None,
    media: str | None = None,
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
    if media:
        mk = media.strip().lower()
        if mk == "any":                       # любое вложение
            clauses.append("media_json != '[]' AND media_json != ''")
        elif mk == "text":                    # только текст (без вложений)
            clauses.append(
                "(media_json = '[]' OR media_json = '' OR media_json IS NULL)")
        elif mk in _CHAT_MEDIA_CATEGORIES:     # конкретная категория типа
            kinds = _CHAT_MEDIA_CATEGORIES[mk]
            ph = ",".join("?" * len(kinds))
            clauses.append(
                "EXISTS (SELECT 1 FROM json_each(media_json) "
                f"WHERE json_extract(value, '$.kind') IN ({ph}))")
            params.extend(kinds)
        # неизвестное значение — игнорируем (без фильтра)
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


def _merge_member_group(group: list[dict]) -> dict:
    """Склеивает несколько записей ОДНОГО человека (общий tg_id/vk_id) в одну.

    Нужно потому что один человек, зарегавшийся дважды (напр. вернулся под
    новым ником через другую площадку), попадает в clan_members двумя рядами
    с разными key (tg_… и vk_…) и разными game_nick. Система должна понимать,
    что это ОДИН человек. Берём самую свежую активную запись за основу, пустые
    поля дозаполняем из остальных, game_nick = все ники (текущий первым)."""
    g = sorted(group, key=lambda r: (
        1 if str(r.get("is_active")) == "1" else 0,
        r.get("synced_at") or ""), reverse=True)
    merged = dict(g[0])
    for r in g[1:]:
        for f, v in r.items():
            cur = merged.get(f)
            if (cur is None or str(cur).strip() == "") and v not in (None, "") \
                    and str(v).strip():
                merged[f] = v
    merged["is_active"] = 1 if any(str(r.get("is_active")) == "1"
                                   for r in group) else 0
    nicks: list[str] = []
    for r in g:
        for nk in (r.get("game_nick") or "").split(","):
            nk = nk.strip()
            if nk and nk not in nicks:
                nicks.append(nk)
    merged["game_nick"] = ",".join(nicks)
    merged["_aka"] = nicks[1:]                     # прежние ники
    merged["_merged_keys"] = [r.get("key") for r in group]
    # last_active_day — самый свежий среди всех записей человека.
    merged["last_active_day"] = max(
        (str(r.get("last_active_day") or "") for r in group), default="")
    return merged


def _unify_members(rows: list[dict]) -> list[dict]:
    """Объединяет записи одного человека (общий непустой tg_id ИЛИ vk_id)
    в одну запись через union-find. Один человек = одна карточка со всеми
    никами/аккаунтами — чинит дубли в «Участниках», поиске и identity-резолве."""
    n = len(rows)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    by_tg: dict[str, int] = {}
    by_vk: dict[str, int] = {}
    for i, r in enumerate(rows):
        tg = (r.get("tg_id") or "").strip()
        vk = (r.get("vk_id") or "").strip()
        if tg:
            if tg in by_tg:
                union(i, by_tg[tg])
            else:
                by_tg[tg] = i
        if vk:
            if vk in by_vk:
                union(i, by_vk[vk])
            else:
                by_vk[vk] = i
    groups: dict[int, list[dict]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(rows[i])
    out = [_merge_member_group(g) if len(g) > 1 else dict(g[0])
           for g in groups.values()]
    out.sort(key=lambda m: (m.get("display_name") or "").lower())
    return out


def list_clan_members(unified: bool = True) -> list[dict]:
    with connection() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM clan_members ORDER BY display_name")]
    # unified=True (по умолчанию) — склеиваем дубли одного человека.
    # Сырые ряды (unified=False) нужны только служебной синхронизации.
    return _unify_members(rows) if unified else rows


# ═══════════ СИСТЕМА ВОЗВРАТА СОСТАВА (backup / re-invite) ═══════════

_MEMBER_PROFILE_FIELDS = (
    "key", "game_nick", "display_name",
    "tg_id", "tg_username", "tg_display", "tg_first_name", "tg_last_name",
    "tg_avatar_url",
    "vk_id", "vk_screen_name", "vk_display", "vk_first", "vk_last",
    "vk_avatar_url",
    "is_active", "last_active_day", "last_seen_at",
)


def _reinvite_links(m: dict) -> dict:
    """Ссылки чтобы позвать человека обратно: TG и VK."""
    links: dict[str, str] = {}
    tgu = (m.get("tg_username") or "").lstrip("@").strip()
    tgid = str(m.get("tg_id") or "").strip()
    if tgu:
        links["tg"] = f"https://t.me/{tgu}"
    elif tgid:
        links["tg"] = f"tg://user?id={tgid}"
    vks = (m.get("vk_screen_name") or "").strip()
    vkid = str(m.get("vk_id") or "").strip()
    if vks:
        links["vk"] = f"https://vk.com/{vks}"
    elif vkid:
        links["vk"] = f"https://vk.com/id{vkid}"
    return links


def _is_active_val(v) -> int:
    return 1 if str(v) in ("1", "True", "true") else 0


def capture_member_snapshot(day: str | None = None) -> dict:
    """Снимает ДАТИРОВАННЫЙ ростер состава (полные профили всех участников).

    Один снимок в день (upsert по day). Плюс обновляет last_active_day у тех,
    кто СЕЙЧАС в чате (is_active=1). Это фундамент восстановления: видно, кто
    был у нас в какой день → можно позвать назад именно недавних, а не всех.
    """
    now = datetime.utcnow()
    day = day or now.strftime("%Y-%m-%d")
    members = list_clan_members()          # унифицированные, 1 запись/человек
    roster = []
    active = 0
    for m in members:
        prof = {f: m.get(f) for f in _MEMBER_PROFILE_FIELDS}
        prof["is_active"] = _is_active_val(m.get("is_active"))
        prof["aka"] = m.get("_aka") or []
        if prof["is_active"]:
            active += 1
        roster.append(prof)
    roster_json = json.dumps(roster, ensure_ascii=False)
    with connection() as conn:
        conn.execute(
            "INSERT INTO member_snapshots (day, captured_at, member_count, "
            "active_count, roster_json) VALUES (?,?,?,?,?) "
            "ON CONFLICT(day) DO UPDATE SET captured_at=excluded.captured_at, "
            "member_count=excluded.member_count, active_count=excluded.active_count, "
            "roster_json=excluded.roster_json",
            (day, now.isoformat(timespec="seconds"), len(roster), active,
             roster_json))
        conn.execute(
            "UPDATE clan_members SET last_active_day = ? WHERE is_active = 1",
            (day,))
    return {"day": day, "members": len(roster), "active": active}


def set_live_roster(members: list | None = None, tg_ids: list | None = None,
                    vk_ids: list | None = None, as_of: str = "") -> dict:
    """Сохраняет ЖИВОЙ список участников чатов (кто СЕЙЧАС в VK/TG), присланный
    reconcile бота. Полная замена. Боты исключаются. Профили незнакомых
    участников (кто не писал и не регался) дозаписываются в chat_users —
    чтобы они тоже показывались в «Возврате» со ссылкой (полное совпадение 1-в-1
    с реальным составом чатов)."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    as_of = as_of or now
    rows = []   # (platform, id, name, username, is_bot)
    if members:
        for m in members:
            rows.append((m.get("platform"), str(m.get("id") or ""),
                         (m.get("name") or "").strip(),
                         (m.get("username") or "").strip(),
                         bool(m.get("is_bot"))))
    else:   # обратная совместимость: голые списки id
        for i in (tg_ids or []):
            rows.append(("tg", str(i), "", "", False))
        for i in (vk_ids or []):
            rows.append(("vk", str(i), "", "", False))
    tg_n = vk_n = 0
    with connection() as conn:
        conn.execute("DELETE FROM live_chat_members")
        for plat, uid, name, uname, is_bot in rows:
            if plat not in ("tg", "vk") or not uid or is_bot:
                continue  # боты и мусор — не люди
            conn.execute(
                "INSERT OR IGNORE INTO live_chat_members(platform,user_id) VALUES(?,?)",
                (plat, uid))
            tg_n += (plat == "tg")
            vk_n += (plat == "vk")
            if name or uname:
                # дозапись профиля: имя/username обновляем свежими, msg_count и
                # first_seen НЕ трогаем (у писавших сохраняется история).
                conn.execute(
                    "INSERT INTO chat_users(platform,user_id,display_name,username,"
                    "first_seen,last_seen,msg_count) VALUES(?,?,?,?,?,?,0) "
                    "ON CONFLICT(platform,user_id) DO UPDATE SET "
                    "display_name=CASE WHEN excluded.display_name!='' "
                    "THEN excluded.display_name ELSE chat_users.display_name END, "
                    "username=CASE WHEN excluded.username!='' "
                    "THEN excluded.username ELSE chat_users.username END, "
                    "last_seen=excluded.last_seen",
                    (plat, uid, name, uname, now, now))
        conn.execute(
            "INSERT INTO kv_meta(k,v) VALUES('live_roster_as_of',?) "
            "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (as_of,))
    return {"tg": tg_n, "vk": vk_n, "total": tg_n + vk_n, "as_of": as_of}


def _live_roster() -> tuple[set, set, str]:
    """(tg_ids, vk_ids, as_of) живого ростера. Пустые множества, если ещё не
    присылали (тогда фолбэк на is_active)."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT platform, user_id FROM live_chat_members").fetchall()
        m = conn.execute(
            "SELECT v FROM kv_meta WHERE k='live_roster_as_of'").fetchone()
    tg = {r["user_id"] for r in rows if r["platform"] == "tg"}
    vk = {r["user_id"] for r in rows if r["platform"] == "vk"}
    return tg, vk, (m["v"] if m else "")


def _days_since(day: str, today) -> int | None:
    day = (day or "").strip()[:10]
    if not day:
        return None
    try:
        return (today - datetime.strptime(day, "%Y-%m-%d").date()).days
    except ValueError:
        return None


def member_restore_roster(recent_days: int | None = None) -> dict:
    """Ростер для восстановления состава. Включает И зарегистрированных
    (clan_members), И НЕзарегистрированных, кто просто писал в чатах
    (chat_users, не сопоставлен с реестром). У каждого — максимум профиля
    TG/VK + ссылки для возврата.

    ВАЖНО: «в составе» у зарегистрированных = по последней сверке (reconcile),
    дата в `as_of`. Живой статус в чате обновляется только запуском reconcile.

    Возвращает {as_of, active_count, total, members:[...]}.
    """
    today = datetime.utcnow().date()
    out = []
    known_tg: set[str] = set()
    known_vk: set[str] = set()
    as_of = ""
    # Живой ростер чатов (все id, вкл. незарег.). Если есть — «в чате сейчас»
    # считаем по нему для ВСЕХ; иначе фолбэк на is_active (только зарег.).
    live_tg, live_vk, live_as_of = _live_roster()
    has_live = bool(live_tg or live_vk)

    def _live_active(tg, vk):
        return (tg in live_tg) or (vk in live_vk)

    # 1) Зарегистрированные (реестр clan_members)
    for m in list_clan_members():
        tg = str(m.get("tg_id") or "").strip()
        vk = str(m.get("vk_id") or "").strip()
        active = _live_active(tg, vk) if has_live else _is_active_val(m.get("is_active"))
        lad = (m.get("last_active_day") or "").strip()
        sy = (m.get("synced_at") or "")[:10]
        if active and sy > as_of:
            as_of = sy
        if tg:
            known_tg.add(tg)
        if vk:
            known_vk.add(vk)
        out.append({
            "key": m.get("key"),
            "registered": True,
            "display_name": m.get("display_name"),
            "game_nick": m.get("game_nick"),
            "aka": m.get("_aka") or [],
            "tg_id": tg, "tg_username": m.get("tg_username"),
            "tg_display": m.get("tg_display"),
            "tg_first_name": m.get("tg_first_name"),
            "tg_last_name": m.get("tg_last_name"),
            "tg_avatar_url": m.get("tg_avatar_url"),
            "vk_id": vk, "vk_screen_name": m.get("vk_screen_name"),
            "vk_display": m.get("vk_display"),
            "vk_first": m.get("vk_first"), "vk_last": m.get("vk_last"),
            "vk_avatar_url": m.get("vk_avatar_url"),
            "has_tg": bool(tg), "has_vk": bool(vk),
            "active": bool(active),
            "last_active_day": lad,
            "days_ago": _days_since(lad, today),
            "msgs": None,
            "links": _reinvite_links(m),
        })

    # Индекс СИЛЬНЫХ имён зарег. участников (полное имя / ник / username) → его
    # запись. Чтобы сопоставить незарегистрированного из чата с уже известным
    # человеком по НИКУ/ИМЕНИ (напр. «СестрёнкА» в TG = Светлана Серова, у которой
    # в реестре только VK). Только длинные ключи (>=4) — не сливать разных людей
    # по общему короткому имени.
    name_index: dict[str, dict] = {}
    for e in out:
        keys = [e.get("display_name")]
        keys += [n.strip() for n in (e.get("game_nick") or "").split(",")]
        keys += [e.get("tg_username"), e.get("vk_screen_name"),
                 e.get("vk_display"), e.get("tg_display")]
        for k in keys:
            nk = _norm_name((k or "").lstrip("@"))
            if len(nk) >= 4:
                name_index.setdefault(nk, e)

    _JUNK_IDS = {"0", "1"}
    _JUNK_NAMES = {"test", "тест", "deleted", "deleted account",
                   "удаленный аккаунт", "bot", "бот"}

    # 2) НЕзарегистрированные — просто писали в чатах (chat_users)
    with connection() as conn:
        cu = conn.execute(
            "SELECT platform, user_id, display_name, username, last_seen, "
            "msg_count FROM chat_users").fetchall()
    for r in cu:
        uid = str(r["user_id"]).strip()
        plat = r["platform"]
        dname = r["display_name"] or ""
        uname = r["username"] or ""
        if (plat == "tg" and uid in known_tg) or (plat == "vk" and uid in known_vk):
            continue  # уже есть как зарегистрированный (по соц-id)
        if uid in _JUNK_IDS or _norm_name(dname) in _JUNK_NAMES:
            continue  # тестовое/битое — не показываем
        # Умный матч по нику/имени (СестрёнкА → Светлана): это тот же человек.
        match = name_index.get(_norm_name(dname)) or name_index.get(_norm_name(uname))
        if match:
            # Если ЭТОТ чат-аккаунт человека СЕЙЧАС в чате — человек активен,
            # даже если в реестре у него записан другой/старый id этой площадки
            # (напр. сменил TG-аккаунт). Иначе показывался бы «вышел», хотя он тут.
            if has_live and ((plat == "tg" and uid in live_tg)
                             or (plat == "vk" and uid in live_vk)):
                match["active"] = True
            # Обогащаем недостающей площадкой — вторая ссылка для возврата.
            if plat == "tg" and not match.get("has_tg"):
                match["tg_id"] = uid
                match["tg_username"] = uname
                match["tg_display"] = dname
                match["has_tg"] = True
                match["links"] = _reinvite_links(match)
            elif plat == "vk" and not match.get("has_vk"):
                match["vk_id"] = uid
                match["vk_screen_name"] = uname
                match["vk_display"] = dname
                match["has_vk"] = True
                match["links"] = _reinvite_links(match)
            continue
        m = {"tg_id": uid, "tg_username": uname} if plat == "tg" \
            else {"vk_id": uid, "vk_screen_name": uname}
        seen = (r["last_seen"] or "")[:10]
        # Незарег. «в чате сейчас» — по живому ростеру (если он есть).
        cu_active = has_live and ((uid in live_tg) if plat == "tg" else (uid in live_vk))
        out.append({
            "key": f"cu_{plat}_{uid}",
            "registered": False,
            "display_name": dname,
            "game_nick": "",
            "aka": [],
            "tg_id": uid if plat == "tg" else "", "tg_username": uname if plat == "tg" else "",
            "tg_display": dname if plat == "tg" else "",
            "tg_first_name": "", "tg_last_name": "", "tg_avatar_url": "",
            "vk_id": uid if plat == "vk" else "", "vk_screen_name": uname if plat == "vk" else "",
            "vk_display": dname if plat == "vk" else "",
            "vk_first": "", "vk_last": "", "vk_avatar_url": "",
            "has_tg": plat == "tg", "has_vk": plat == "vk",
            "active": bool(cu_active),
            "last_active_day": seen,
            "days_ago": _days_since(seen, today),
            "msgs": r["msg_count"],
            "links": _reinvite_links(m),
        })

    if recent_days is not None:
        if recent_days <= 0:                  # «только в чате сейчас» = строго active
            out = [m for m in out if m["active"]]
        else:
            out = [m for m in out if m["active"]
                   or (m["days_ago"] is not None and m["days_ago"] <= recent_days)]
    out.sort(key=lambda m: (0 if m["active"] else 1,
                            m["days_ago"] if m["days_ago"] is not None else 10 ** 9,
                            (m["display_name"] or "").lower()))
    return {
        "as_of": (live_as_of[:10] if has_live else as_of),
        "live": has_live,        # True = «в чате сейчас» точный (живой опрос)
        "total": len(out),
        "active_count": sum(1 for m in out if m["active"]),
        "members": out,
    }


def member_snapshots_list() -> list[dict]:
    """Датированные снимки (история — на какую дату какой был состав)."""
    with connection() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT day, captured_at, member_count, active_count "
            "FROM member_snapshots ORDER BY day DESC")]


def member_snapshot_roster(day: str) -> list[dict]:
    """Ростер на конкретную дату из снимка — с кем мы были в тот день."""
    with connection() as conn:
        r = conn.execute(
            "SELECT roster_json FROM member_snapshots WHERE day=?",
            (day,)).fetchone()
    if not r:
        return []
    try:
        roster = json.loads(r["roster_json"])
    except Exception:
        return []
    for m in roster:
        m["links"] = _reinvite_links(m)
    return roster


def member_backup_export() -> dict:
    """ПОЛНЫЙ дамп для оффсайт-бэкапа: все сырые записи clan_members + все
    датированные снимки. Отдаётся JSON'ом для скачивания / гита у бота."""
    with connection() as conn:
        members = [dict(r) for r in conn.execute("SELECT * FROM clan_members")]
        snaps = [dict(r) for r in conn.execute(
            "SELECT day, captured_at, member_count, active_count, roster_json "
            "FROM member_snapshots ORDER BY day")]
    return {
        "exported_at": datetime.utcnow().isoformat(timespec="seconds"),
        "member_count": len(members),
        "snapshot_count": len(snaps),
        "members": members,
        "snapshots": snaps,
    }


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


# Разные игроки клана с никами, которые канон ИНАЧЕ схлопнул бы в один
# (отличаются только регистром или декор-символами ~/_). Ключ — точное
# написание ника как в игре; значение — отдельный уникальный канон.
# Применяется ДО нормализации, чтобы развести их во ВСЕХ таблицах
# (доблесть, реестр, чаты) одинаково.
_CANON_OVERRIDE = {
    "~Lica~":  "licatilde",    # Друид
    "_Lica_":  "licaunder",    # Жнец
    "AtiScaT": "atiscatscat",  # Бард
    "AtisCat": "atiscatcat",   # Дух крови
    # _Hоps_ (Оборотень, ур105) — главный, канон по умолчанию = hops.
    # __Hops__ (Бард, ур102) — его ТВИН, ОТДЕЛЬНЫЙ игрок. Без этого канон
    # стирает подчёркивания и оба сливаются в hops. Кир./лат. о — на случай OCR.
    "__Hops__": "hopstwin",
    "__Hоps__": "hopstwin",
}


def _valor_canon(nick: str) -> str:
    import re
    import unicodedata
    raw = (nick or "").strip()
    if raw in _CANON_OVERRIDE:        # разводим тёзок-омонимов вручную
        return _CANON_OVERRIDE[raw]
    # NFKC — приводит полноширинные/совместимые формы (ＩＲＩＫ→IRIK и т.п.).
    s = unicodedata.normalize("NFKC", raw).lower()
    # Сворачиваем гомоглифы в латиницу.
    s = "".join(_CANON_HOMO.get(ch, ch) for ch in s)
    return re.sub(r"[\s\W_]+", "", s, flags=re.UNICODE)


# Тёзки-ОМОНИМЫ, которых OCR/ИИ читает ОДИНАКОВО (гомоглиф в игре, но ИИ
# приводит ник к латинице → написание в данных идентичное). Различить можно
# ТОЛЬКО по КЛАССУ. Ключ: (базовый канон, класс в нижнем регистре) → отдельный
# канон, чтобы «одинаковый ник + разный класс» считались РАЗНЫМИ игроками.
# ДЕРЖАТЬ В СИНХРОНЕ с pw-valor-tracker/gemini_vision.py.
_CANON_CLASS_SPLIT = {
    ("interpris", "оборотень"): "interprisoboroten",  # твин INTerpris-Жреца
}


def _valor_canon_cls(nick: str, class_: str | None) -> str:
    """Канон с учётом класса — для тёзок-омонимов, неотличимых по написанию.
    Если пара (канон, класс) есть в _CANON_CLASS_SPLIT — отдельный канон,
    иначе обычный _valor_canon."""
    base = _valor_canon(nick)
    cl = (class_ or "").strip().lower()
    return _CANON_CLASS_SPLIT.get((base, cl), base)


def _acceptance_nicks(raw: str) -> list[tuple[str, str]]:
    """Разбор поля game_nick реестра приёма в [(canon, написание), ...].

    Запятая — разделитель нескольких ников ОДНОЙ записи («Main,Alt»). НО если
    в записи ник один, сохраняем исходное написание ЦЕЛИКОМ — вместе с
    возможной хвостовой запятой в самом нике (напр. «Рэйни,»), иначе split
    съедал бы её как разделитель."""
    raw = raw or ""
    nonempty = [p.strip() for p in raw.split(",") if p.strip()]
    out: list[tuple[str, str]] = []
    if len(nonempty) == 1:
        disp = raw.strip()
        c = _valor_canon(disp)
        if c:
            out.append((c, disp))
        return out
    for p in nonempty:
        c = _valor_canon(p)
        if c:
            out.append((c, p))
    return out


def _alias_map(conn) -> dict:
    """alias_canon → target_canon из valor_alias."""
    return {r["alias_canon"]: r["target_canon"]
            for r in conn.execute(
                "SELECT alias_canon, target_canon FROM valor_alias")}


def _resolve_canon(canon: str, amap: dict) -> str:
    """Разворачивает цепочку алиасов до конечного target (с защитой от петель)."""
    seen = set()
    while canon in amap and canon not in seen:
        seen.add(canon)
        canon = amap[canon]
    return canon


def _valor_similar(a: str, b: str) -> float:
    """Похожесть двух canon-ников 0..1 (для подсказки «возможно это X» при
    ошибке OCR). difflib — стандартная либа, без зависимостей."""
    import difflib
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


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
    """Высшая метка-достижение за доблесть. Две оси:

    1) КОНСИСТЕНТНОСТЬ (безупречная история) — высший приоритет:
       legend  👑 безупречная история (≥3 нед без провала) + серия ≥3 нед ≥2×
       ace     🔥 безупречная история + серия ≥3 нед ≥1.5×
       etalon  ⭐ безупречная история (≥3 нед без единого провала)
    2) СТЕПЕНЬ ПЕРЕВЫПОЛНЕНИЯ (пик, для тех, кто ещё не безупречен):
       titan   ✺ пик ≥7× нормы
       phenom  ✸ пик ≥5×
       record  ⚡ пик ≥4×
       triple  ✶ пик ≥3×
       double  ◆ пик ≥2×
       over    ▲ пик ≥1.5×

    Точная степень (×N) показывается на самой метке и в подсказке.
    """
    if not comp or not comp.get("weeks_count"):
        return None
    wc = comp["weeks_count"]
    flawless = comp["weeks_met"] == wc and wc >= 3
    g = comp.get("geomean_all", 0.0)      # геом.среднее кратностей за всё время
    clen = comp.get("combo_len", 0)        # длина серии перевыполнений (≥1.5×)
    cgeo = comp.get("combo_geo", 0.0)      # геом.среднее кратностей этой серии
    peak = comp.get("peak_ratio", 0.0)     # лучший единичный пик
    # 1) Безупречная история (≥3 нед без провала) — градация по геом.среднему
    if flawless:
        if g >= 3.0:
            return "immortal"   # Бессмертная легенда
        if g >= 2.0:
            return "legend"     # Легенда доблести
        if g >= 1.4:
            return "ace"        # Ас доблести
        return "etalon"         # Эталон
    # 2) Комбо перевыполнений (серия ≥3 нед ≥1.5×) — градация по геом.среднему
    if clen >= 3:
        if cgeo >= 3.0:
            return "combo_legend"   # Комбо-легенда
        if cgeo >= 2.0:
            return "combo_record"   # Серийный рекордсмен
        return "combo_over"         # Серия перевыполнений
    # 3) Пик единичного перевыполнения (до ×13.5 = абсолютный максимум 189)
    if peak >= 13.0:
        return "absolute"   # Абсолют доблести (≈189)
    if peak >= 9.5:
        return "overlord"   # Властелин доблести
    if peak >= 7.0:
        return "titan"      # Титан доблести
    if peak >= 5.5:
        return "phenom"     # Феномен доблести
    if peak >= 4.0:
        return "record"     # Рекордсмен
    if peak >= 3.0:
        return "triple"     # Утроил норму
    if peak >= 2.0:
        return "double"     # Удвоил норму
    if peak >= 1.5:
        return "over"       # Перевыполнил
    return None


# ── Новая система достижений за доблесть (2026-06) ──────────────────────
# Технический потолок доблести за неделю в PW — относительно него
# оценивается «ценность» каждого перевыполнения (сколько headroom закрыто).
VALOR_MAX_WEEKLY = 189

# Магнитудная ветка: роль по ЛУЧШЕЙ единичной неделе (пик ×N от нормы).
def _peak_tier(peak: float):
    if peak >= 13.0: return "absolute"   # Абсолют доблести (≈189)
    if peak >= 9.5:  return "overlord"   # Властелин доблести
    if peak >= 7.0:  return "titan"      # Титан доблести
    if peak >= 5.5:  return "phenom"     # Феномен доблести
    if peak >= 4.0:  return "record"     # Рекордсмен
    if peak >= 3.0:  return "triple"     # Утроил норму
    if peak >= 2.0:  return "double"     # Удвоил норму
    if peak >= 1.5:  return "over"       # Перевыполнил
    if peak >= 1.0:  return "met"        # Выполнил норматив
    return None

# Лестница СЕРИЙ перевыполнения (подряд недель с valor > norm). Разблокируется
# по МАКСИМАЛЬНОЙ серии за всё время — один срыв не лишает достигнутого
# (как ачивки в игре). Сбалансировано на горизонт ~10 лет.
#   (минимум недель подряд, ключ, макс.вес тира при идеальном качестве)
_STREAK_LADDER = [
    (2,   "streak2", 3.0),
    (3,   "streak3", 5.0),
    (4,   "month1",  8.0),    # 1 месяц
    (8,   "month2",  10.0),   # 2 месяца
    (12,  "month3",  12.0),   # 3 месяца (квартал)
    (26,  "half1",   13.0),   # полгода
    (52,  "year1",   14.0),   # год
    (104, "year2",   14.5),   # 2 года
    (156, "year3",   14.8),   # 3 года
    (260, "year5",   15.0),   # 5 лет
    (520, "year10",  15.0),   # 10 лет
]


def _streak_tier(weeks: int):
    """Ключ ВЫСШЕГО разблокированного тира серии по числу недель подряд."""
    key = None
    for thr, k, _w in _STREAK_LADDER:
        if weeks >= thr:
            key = k
        else:
            break
    return key


def _streak_tier_weight(weeks: int) -> float:
    """Макс. вес (ценность) высшего разблокированного тира серии."""
    w = 0.0
    for thr, _k, tw in _STREAK_LADDER:
        if weeks >= thr:
            w = tw
        else:
            break
    return w


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


def _title_is_afk(title: str) -> bool:
    """АФК-статус определяется по подстроке в титуле, в любом регистре и
    форме: «афк», «АФК», «НикАФК», «АФК до пт», «afk», «Afk» и т.п.
    Офицеры помечают АФК по-разному, поэтому матчим вхождение, а не равенство.
    """
    low = (title or "").lower()
    return "афк" in low or "afk" in low


def _afk_streak(history):
    """history: список кортежей (week, is_afk, valor) по ВОЗРАСТАНИЮ недели.

    Если в последней неделе человек НЕ АФК — возвращаем None. Иначе считаем
    серию АФК-недель подряд с конца. Доблесть НЕДЕЛЬНАЯ (снимок в вс фиксирует
    набор за неделю пн→вс, потом сброс), поэтому значение каждой недели — это
    и есть «сколько набрал за ту неделю», а суммарно за АФК = их сумма.
    """
    if not history or not history[-1][1]:
        return None
    i = len(history) - 1
    while i >= 0 and history[i][1]:
        i -= 1
    streak = history[i + 1:]               # последовательные АФК-недели
    # Понедельно: valor каждой недели = набрано за эту неделю в статусе АФК.
    weekly = [{"week": w, "valor": v} for (w, _a, v) in streak]
    total = sum(v for (_w, _a, v) in streak if isinstance(v, int))
    return {
        "weeks":       len(streak),
        "since_week":  streak[0][0],
        "valor_total": total,              # суммарно набрано за все недели АФК
        "valor_last":  streak[-1][2],      # за последнюю неделю АФК
        "weekly":      weekly,
    }


_RANK_SCORE_MAX = max(_RANK_SCORE.values())  # 30 (мастер)


def _rank_frac(rank: str) -> float:
    """Ранг → доля 0..1 (мастер=1.0, рядовой/нет=0)."""
    return _rank_score(rank) / _RANK_SCORE_MAX


def _iso_week_of(ts: str) -> str:
    """ISO-строка даты/времени → «YYYY-Www» (для сравнения с неделей снимка)."""
    try:
        d = date.fromisoformat(str(ts)[:10])
        y, w, _ = d.isocalendar()
        return f"{y}-W{w:02d}"
    except Exception:
        return ""


# Офицерство начинается с КАПИТАНА (Капитан→Майор→Маршал→Мастер). Лейтенант и
# ниже офицерами НЕ считаются — не дают офицерскую ценность/руну.
_OFFICER_MIN_SCORE = _RANK_SCORE["капитан"]   # 12


def _officer_frac(rank: str) -> float:
    """Офицерская доля 0..1 (мастер=1.0). Ниже Капитана → 0 (не офицер)."""
    sc = _rank_score(rank)
    return (sc / _RANK_SCORE_MAX) if sc >= _OFFICER_MIN_SCORE else 0.0


# Тег-руна конкретного офицерского звания (для колонки «Роли»).
_OFFICER_TAG = {
    "мастер": "rank_master", "мастер гильдии": "rank_master", "мастер клана": "rank_master",
    "маршал": "rank_marshal", "майор": "rank_major", "капитан": "rank_capitan",
}


def _officer_tag(rank: str) -> str | None:
    """Звание → ключ руны (rank_master/marshal/major/capitan) или None (не офицер)."""
    return _OFFICER_TAG.get((rank or "").strip().lower())


# ── Модель «Ценность для клана» (3 ветки, пересчёт 2026-06-07) ──
# Ветка 1 «Доблесть»: база (форма за 4 нед) × МНОЖИТЕЛЬ за текущий стрик.
#   Множитель = 1 + Σ(OFS за недели текущего стрика) × K, потолок MULT_CAP.
#   OFS недели = (доблесть−норма)/(189−норма) ∈ [0..1]. Сумма растёт и с
#   длиной серии, и с магнитудой → 2 нед ×3 ≈ ×1.4, 2 нед ×5 ≈ ×1.7,
#   мощные длинные стрики → потолок ×3. Сбился стрик → множитель 1.
# Ветки 2 и 3 и Ветеран — АДДИТИВНЫ, ничего не умножают.
DOBLEST_BASE = 40.0   # (legacy, не используется в новой формуле)
# Целевые доли ценности (потолки веток, сумма = 100): база доблести 35 +
# стрики (бонус множителя) 40 + офицерство 10 + ветеран 10 + общительность 5.
MULT_K       = 1.2    # коэффициент множителя стрика
MULT_CAP     = 2.15   # потолок: бонус = база35 × (2.15−1) ≈ 40
VALOR_W_VETERAN = 10  # руна ветерана (флэт; потолок 10 = 10%)
VALOR_W_OFFICER = 7   # база офицерства × множитель ≤×1.4 → потолок ~9.8 (~10%)
VALOR_W_VK   = 1      # руна ВКонтакте
VALOR_W_TG   = 1      # руна Telegram
VALOR_W_CHAT = 2      # общительность: база VK1+TG1+чаты2=4 × ≤×1.2 → ~4.8 (~5%)
# legacy-алиасы (могут встречаться в старом коде)
VALOR_W_DOBLEST = DOBLEST_BASE
VALOR_W_ACHIEVE = DOBLEST_BASE
VALOR_W_SOCIALS = VALOR_W_VK + VALOR_W_TG
VALOR_W_OVERFULFILL = DOBLEST_BASE


def _streak_multiplier(cur_ofs_sum: float, cap: float | None = None) -> float:
    """Множитель ветки доблести по ТЕКУЩЕМУ стрику. cur_ofs_sum — сумма OFS
    недель текущей серии перевыполнения (0 если стрик сбит). Растёт и с
    длиной, и с магнитудой; потолок cap (по умолчанию MULT_CAP)."""
    return round(min(1.0 + cur_ofs_sum * MULT_K, MULT_CAP if cap is None else cap), 2)


# Редкость текущей стрик-руны по средней магнитуде серии (avg OFS).
def _streak_rarity(avg_ofs: float) -> str:
    if avg_ofs >= 0.55: return "mythic"
    if avg_ofs >= 0.38: return "legendary"
    if avg_ofs >= 0.24: return "epic"
    if avg_ofs >= 0.14: return "rare"
    if avg_ofs >= 0.07: return "uncommon"
    return "common"


# База ценности по магнитудной руне (пик ×N): чем выше перевыполнение —
# тем больше базовая ценность. Серии-руны её УМНОЖАЮТ. Будет определена ниже
# через _peak_tier (объявлен раньше).
# База доблести по руне (потолок 35 = 35% ценности). Серии её множат до ×2.15
# → бонус серий до ~40 (40%).
_MAG_BASE = {"over": 7.0, "double": 11.0, "triple": 15.0, "record": 20.0,
             "phenom": 25.0, "titan": 28.0, "overlord": 31.0, "absolute": 35.0}
MAG_BASE_MAX = 35.0


def _magnitude_base(peak: float) -> float:
    return _MAG_BASE.get(_peak_tier(peak), 0.0)


# Доли тиров магнитуды (отношение к высшему). Реальная база = ratio × вес «база».
_MAG_RATIO = {"over": 0.20, "double": 0.314, "triple": 0.429, "record": 0.571,
              "phenom": 0.714, "titan": 0.80, "overlord": 0.886, "absolute": 1.0}


def _mag_base_w(peak: float, w_base: float) -> float:
    """База доблести (ПЛАВНО, в долях веса «база»):
      • выполнил норму (×1)           → 30% веса (минимальный зачёт);
      • дальше растёт логарифмически  → 100% при ×13 (Абсолют);
      • не дотянул до нормы (peak<1)  → пропорционально меньше (частичный зачёт).
    Так даже выполнение норматива и лёгкое перевыполнение оцениваются."""
    if peak <= 0:
        return 0.0
    if peak < 1.0:
        frac = 0.30 * peak
    else:
        frac = 0.30 + 0.70 * min(math.log(peak) / math.log(13.0), 1.0)
    return round(frac * w_base, 2)


_WEIGHT_DEFAULTS = {"base": 35.0, "streak": 40.0, "officer": 10.0,
                    "veteran": 10.0, "social": 5.0}
_WEIGHT_KEYS = ("base", "streak", "officer", "veteran", "social")


def get_valor_weights() -> dict:
    """Текущие веса (%) категорий ценности. Если строки нет — дефолты."""
    with connection() as conn:
        row = conn.execute(
            "SELECT w_base, w_streak, w_officer, w_veteran, w_social, "
            "updated_at, updated_by FROM valor_weights WHERE id = 1"
        ).fetchone()
    if not row:
        return dict(_WEIGHT_DEFAULTS, updated_at="", updated_by="")
    return {"base": row["w_base"], "streak": row["w_streak"],
            "officer": row["w_officer"], "veteran": row["w_veteran"],
            "social": row["w_social"], "updated_at": row["updated_at"],
            "updated_by": row["updated_by"]}


def set_valor_weights(vals: dict, actor: dict) -> dict:
    """Сохраняет веса. Валидация: каждый ≥0, сумма ≤ 100. Возвращает {ok}|{error}."""
    w = {}
    for k in _WEIGHT_KEYS:
        try:
            v = float(vals.get(k))
        except (TypeError, ValueError):
            return {"ok": False, "error": f"bad_value:{k}"}
        if v < 0:
            return {"ok": False, "error": f"negative:{k}"}
        w[k] = round(v, 2)
    if sum(w.values()) > 100.0 + 1e-6:
        return {"ok": False, "error": "sum_over_100", "sum": round(sum(w.values()), 2)}
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = actor.get("name") or actor.get("role") or ""
    with connection() as conn:
        conn.execute(
            """INSERT INTO valor_weights
               (id, w_base, w_streak, w_officer, w_veteran, w_social, updated_at, updated_by)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 w_base=excluded.w_base, w_streak=excluded.w_streak,
                 w_officer=excluded.w_officer, w_veteran=excluded.w_veteran,
                 w_social=excluded.w_social, updated_at=excluded.updated_at,
                 updated_by=excluded.updated_by""",
            (w["base"], w["streak"], w["officer"], w["veteran"], w["social"], now, by))
    return {"ok": True, **w}

# Очки достижений по редкости тира (зеркало фронтовой RARITY) — из них
# складывается «achievement score» игрока, который и даёт компонент ценности.
_RARITY_PTS = {"common": 5, "uncommon": 10, "rare": 25, "epic": 50,
               "legendary": 100, "mythic": 250}
_TIER_RARITY = {
    "over": "uncommon", "double": "uncommon", "triple": "rare", "record": "rare",
    "phenom": "epic", "titan": "epic", "overlord": "legendary", "absolute": "mythic",
    "streak2": "common", "streak3": "uncommon", "month1": "uncommon",
    "month2": "rare", "month3": "rare", "half1": "epic",
    "year1": "legendary", "year2": "legendary", "year3": "mythic",
    "year5": "mythic", "year10": "mythic",
}
# Пороги магнитуды (роль по лучшей единичной неделе, пик ×N).
_MAG_THRESH = [(1.5, "over"), (2, "double"), (3, "triple"), (4, "record"),
               (5.5, "phenom"), (7, "titan"), (9.5, "overlord"), (13, "absolute")]

# ── Путь доблести: накопительный XP (НЕ сбрасывается, всегда можно докачать) ──
# XP за неделю = набранная доблесть × бонус за серию перевыполнения, поэтому
# НАСКОЛЬКО перевыполнил — напрямую влияет на прогресс (×7 даёт втрое больше
# чем ×2). Роли открываются по порогам накопленного XP — как ноды в Diablo.
#   (порог XP, ключ, редкость)
_XP_LADDER = [
    (50,     "xp1",  "common"),
    (150,    "xp2",  "uncommon"),
    (400,    "xp3",  "uncommon"),
    (900,    "xp4",  "rare"),
    (2000,   "xp5",  "rare"),
    (4500,   "xp6",  "epic"),
    (10000,  "xp7",  "epic"),
    (22000,  "xp8",  "legendary"),
    (48000,  "xp9",  "legendary"),
    (100000, "xp10", "mythic"),
    (220000, "xp11", "mythic"),
]
for _thr, _k, _r in _XP_LADDER:
    _TIER_RARITY[_k] = _r   # XP-тиры тоже в карту редкости

_ACH_POINTS_K = 120   # мягкая кривая: ранние ачивки дают заметный прирост


def _xp_tier(total_xp: float):
    """Ключ высшего открытого XP-тира по накопленному доблесть-XP."""
    key = None
    for thr, k, _r in _XP_LADDER:
        if total_xp >= thr:
            key = k
        else:
            break
    return key


def _xp_progress(total_xp: float) -> dict:
    """Прогресс к следующему XP-тиру (для шкалы прокачки)."""
    prev, cur, nxt = 0, None, None
    for thr, k, _r in _XP_LADDER:
        if total_xp >= thr:
            cur, prev = k, thr
        elif nxt is None:
            nxt = thr
    pct = 100.0 if nxt is None else (
        round((total_xp - prev) / (nxt - prev) * 100, 1) if nxt > prev else 0.0)
    return {"cur": cur, "next": nxt, "prev": prev, "pct": pct}


def _achievement_points(peak: float, total_xp: float) -> int:
    """Сумма очков редкости ВСЕХ открытых достижений (магнитуда + путь XP).
    Совпадает с «очки достижений» в Зале достижений."""
    pts = 0
    for mult, key in _MAG_THRESH:
        if peak >= mult:
            pts += _RARITY_PTS[_TIER_RARITY[key]]
    for thr, key, _r in _XP_LADDER:
        if total_xp >= thr:
            pts += _RARITY_PTS[_TIER_RARITY[key]]
    return pts


def _achievement_value(points: int) -> float:
    """Очки достижений → компонент ценности 0..VALOR_W_ACHIEVE. Кривая с
    насыщением: ранние ачивки заметно поднимают ценность, топ — асимптота."""
    if points <= 0:
        return 0.0
    return round(VALOR_W_ACHIEVE * points / (points + _ACH_POINTS_K), 1)


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
    # immune_until — день, С КОТОРОГО игрок уже играет (exclusive конец иммуна).
    # Доступно дней в неделе = 7 - dow:
    #   dow=0 (Пн): 7/7 — целая неделя → 0% скидки, полный норматив
    #   dow=1 (Вт): 6/7 → 14% скидки;  dow=2 (Ср): 5/7 → 29%
    #   dow=3 (Чт): 4/7 → 43%;          dow=4 (Пт): 3/7 → 57%
    #   dow>=5 (Сб/Вс): слишком мало времени → продлеваем иммун (extended)
    if extended:
        credit_pct = 100
        norm_factor = 0.0
        status = "extended"
    else:
        credit_pct = round(dow / 7.0 * 100)
        norm_factor = round((7 - dow) / 7.0, 3)
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
    """Map nick_canon → MAX(дата иммунитета). Источники: реестр приёма
    (acceptances.accepted_date) И авто-новички (valor_first_seen.first_date).
    Используется для per-week проверки иммунитета (compliance + текущая)."""
    out: dict[str, date] = {}
    with connection() as conn:
        rows = conn.execute(
            "SELECT game_nick, MAX(accepted_date) AS d FROM acceptances "
            "GROUP BY game_nick"
        ).fetchall()
        fs = conn.execute(
            "SELECT nick_canon, first_date AS d FROM valor_first_seen"
        ).fetchall()

    def _add(canon: str, dstr: str) -> None:
        if not canon:
            return
        try:
            d = date.fromisoformat(dstr)
        except Exception:
            return
        existing = out.get(canon)
        if existing is None or d > existing:
            out[canon] = d

    for r in rows:
        _add(_valor_canon(r["game_nick"]), r["d"])
    for r in fs:
        _add(r["nick_canon"], r["d"])
    return out


def valor_immunity_per_canon(week: str) -> dict[str, dict]:
    """Map nick_canon → immunity-инфо для оцениваемой недели. Берёт самую
    позднюю дату иммунитета по канону из реестра приёма И авто-новичков
    (valor_first_seen). Возвращает только тех, у кого статус активен или в
    grace; уже истекший иммун не возвращается."""
    out: dict[str, dict] = {}
    for canon, accepted in valor_accepted_date_per_canon().items():
        info = _compute_immunity(accepted, week)
        if info:
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
    man_imm = valor_manual_immunity_map()   # ручной иммунитет: {canon:{week:reason}}
    grouped: dict[str, list] = {}
    dismissed_norm: dict[str, set] = {}   # canon → {прощённые недели}
    with connection() as conn:
        rows = conn.execute(
            """SELECT vm.nick_canon AS cn, vs.week AS week, vm.valor AS valor,
                      vm.is_afk AS is_afk, vm.norm_met AS norm_met,
                      vs.valor_norm AS norm
               FROM valor_members vm
               JOIN valor_snapshots vs ON vm.snapshot_id = vs.id
               ORDER BY vm.nick_canon, vs.week"""
        ).fetchall()
        for d in conn.execute(
                "SELECT nick_canon, ref FROM valor_warn_dismiss WHERE kind='norm'"):
            dismissed_norm.setdefault(d["nick_canon"], set()).add(d["ref"])
    for r in rows:
        grouped.setdefault(r["cn"], []).append(r)
    out: dict[str, list[dict]] = {}
    for cn, weeks in grouped.items():
        acc = accepted.get(cn)
        active: list[dict] = []
        cimm = man_imm.get(cn, {})
        for r in weeks:
            if r["week"] in cimm:
                continue  # РУЧНОЙ иммунитет на эту неделю — не оцениваем
            imm = _compute_immunity(acc, r["week"]) if acc else None
            if imm and imm["status"] in ("active", "extended"):
                continue  # иммунная неделя целиком — не оцениваем
            if r["is_afk"] or r["valor"] is None or r["norm_met"] is None:
                continue
            full_norm = r["norm"] or 1        # полный норматив недели
            norm = full_norm
            is_grace = bool(imm and imm["status"] == "grace")
            factor = 1.0
            if is_grace:
                # У grace-недели норматив СНИЖЕН пропорционально дням без
                # иммунитета — поэтому и «жёсткость» (pct) считаем от сниженной
                # нормы, а не от полной (иначе 4/6 выглядит как суровое 29%).
                factor = imm["effective_norm_factor"]
                norm = max(1, round(full_norm * factor))
            if r["norm_met"]:
                if active:
                    idx = min(range(len(active)),
                              key=lambda i: active[i]["pct"])
                    active.pop(idx)  # снять самое строгое
            else:
                pct = round(min(r["valor"] / norm, 1.0) * 100, 1)
                active.append({"week": r["week"], "valor": r["valor"],
                               "norm": norm, "full_norm": full_norm,
                               "grace_factor": round(factor, 3),
                               "pct": pct, "grace": is_grace})
        # Убираем недели, которые офицер «простил» (сняты вручную).
        dn = dismissed_norm.get(cn)
        if dn:
            active = [a for a in active if a["week"] not in dn]
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


def _class_from_history(conn, canon: str, exclude_snapshot_id: int) -> str:
    """Последний известный НЕпустой класс игрока из ДРУГИХ снимков. Класс в
    игре не меняется → прошлое значение надёжно. '' если нигде не встречался."""
    r = conn.execute(
        "SELECT m.class_ FROM valor_members m "
        "JOIN valor_snapshots s ON m.snapshot_id = s.id "
        "WHERE m.nick_canon = ? AND m.snapshot_id != ? AND TRIM(m.class_) != '' "
        "ORDER BY s.week DESC LIMIT 1",
        (canon, exclude_snapshot_id)).fetchone()
    return (r["class_"] if r else "") or ""


def valor_fill_class_from_history(week: str) -> dict:
    """Заполнить пустой/сомнительный класс из ранее известного класса игрока
    (прежние сборы). Класс не меняется, поэтому прошлое значение надёжнее
    текущего OCR. Снимаем flag_ocr_suspect, если класс взят/подтверждён
    историей. Возвращает {ok, filled, cleared}."""
    week = (week or "").strip()
    filled = 0
    cleared = 0
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        sid = snap["id"]
        rows = conn.execute(
            "SELECT id, nick_canon, class_, flag_ocr_suspect "
            "FROM valor_members WHERE snapshot_id = ?", (sid,)).fetchall()
        for r in rows:
            cls = (r["class_"] or "").strip()
            suspect = bool(r["flag_ocr_suspect"])
            if cls and not suspect:
                continue   # класс есть и сомнений нет — не трогаем
            hist = _class_from_history(conn, r["nick_canon"], sid)
            if not hist:
                continue   # негде взять — оставляем как есть (сомнение остаётся)
            sets, vals = [], []
            if hist != cls:
                sets.append("class_ = ?"); vals.append(hist); filled += 1
            if suspect:
                sets.append("flag_ocr_suspect = ?"); vals.append(0); cleared += 1
            if sets:
                conn.execute(
                    f"UPDATE valor_members SET {', '.join(sets)} WHERE id = ?",
                    (*vals, r["id"]))
    return {"ok": True, "filled": filled, "cleared": cleared}


def valor_smooth_frames(week: str) -> dict:
    """Сглаживает номера кадров (frame) недели. Строки идут в порядке скринов
    (по id = чтение сверху вниз), значит кадр должен НЕ убывать. Бэкфилл через
    батчи Gemini иногда давал одиночные выбросы (ник помечен поздним кадром
    из-за перекрытия) — напр. сосед-кадры 18/19, а у строки 35.

    1) Пустые кадры заполняем линейной интерполяцией между ближайшими.
    2) Медиана-3 убивает одиночные выбросы (median(18,35,19)=19), монотонные
       последовательности не трогает.
    Возвращает {ok, fixed}."""
    week = (week or "").strip()
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        rows = conn.execute(
            "SELECT id, frame FROM valor_members WHERE snapshot_id = ? ORDER BY id",
            (snap["id"],)).fetchall()
        n = len(rows)
        frames = [r["frame"] for r in rows]
        if not any(isinstance(f, int) for f in frames):
            return {"ok": True, "fixed": 0}   # кадров вообще нет

        # 1) Заполнить null интерполяцией между ближайшими известными.
        filled = list(frames)
        for i in range(n):
            if isinstance(filled[i], int):
                continue
            prev = next((j for j in range(i - 1, -1, -1)
                         if isinstance(filled[j], int)), None)
            nxt = next((j for j in range(i + 1, n)
                        if isinstance(filled[j], int)), None)
            if prev is not None and nxt is not None:
                filled[i] = round(frames[prev] + (frames[nxt] - frames[prev])
                                  * (i - prev) / (nxt - prev))
            elif prev is not None:
                filled[i] = frames[prev]
            elif nxt is not None:
                filled[i] = frames[nxt]

        # 2) Медиана-3 — убирает одиночные выбросы, монотонность сохраняет.
        smooth = list(filled)
        for i in range(1, n - 1):
            trio = [filled[i - 1], filled[i], filled[i + 1]]
            smooth[i] = sorted(trio)[1]

        fixed = 0
        for r, old, new in zip(rows, frames, smooth):
            if isinstance(new, int) and new != old:
                conn.execute("UPDATE valor_members SET frame = ? WHERE id = ?",
                             (int(new), r["id"]))
                fixed += 1
    return {"ok": True, "fixed": fixed}


def valor_save_snapshot(
    *,
    week: str,
    valor_norm: int,
    members: list[dict],
    screens_count: int = 0,
    notes: str = "",
    actual_members: int | None = None,
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
        # Карта алиасов (слияния ников админом) — кривые OCR-чтения матчим
        # на правильного человека ещё на этапе сохранения.
        alias_map = _alias_map(conn)
        prev_canons: set[str] = set()
        prev_snapshot_data: dict[str, dict] = {}  # canon → row dict
        if prev_snap:
            for r in conn.execute(
                """SELECT nick, nick_canon, true_name, rank, title, level,
                          class_, valor, warning_count
                   FROM valor_members WHERE snapshot_id = ?""",
                (prev_snap["id"],)
            ):
                cn = _resolve_canon(r["nick_canon"], alias_map)
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
            # Класс-aware канон: тёзки-омонимы (одинаковый ник, разный класс) —
            # разные игроки, НЕ схлопываем.
            _cn = _valor_canon_cls(_nick, _m.get("class_") or _m.get("class"))
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
                members_count, actual_members, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (week, now, int(valor_norm), int(screens_count),
             len(members),
             int(actual_members) if isinstance(actual_members, int) else None,
             notes),
        )
        snap_id = cur.lastrowid

        # ── 3. Вставляем участников с расчётом warning_count ──
        # Иммунитет на эту неделю — учитываем при оценке norm_met и streak.
        # Десктоп-бот не знает про иммунитет, шлёт norm_met по факту;
        # переписываем здесь.
        immunity_map = valor_immunity_per_canon(week)

        # ── 3.0. Подготовка к детекту новичков ──
        # Новичок = есть в этом снимке, но НЕ был в прошлом снимке, при этом
        # его НЕТ в реестре приёма, он НЕ возвращенец (нет в valor_departed)
        # и ещё не зафиксирован в valor_first_seen. Такому ставим flag_new_nick
        # (ник распознан ИИ — проверить вручную) и заводим first_seen, что даёт
        # авто-иммунитет на 7 дней. Только если есть ПРЕДЫДУЩИЙ снимок: первый
        # сбор — это базовый список клана, там новичков не помечаем.
        registered_canons: set[str] = set()
        for rr in conn.execute("SELECT DISTINCT game_nick FROM acceptances"):
            for piece in (rr["game_nick"] or "").split(","):
                c = _valor_canon(piece)
                if c:
                    registered_canons.add(c)
        departed_canons = {rr["nick_canon"] for rr in conn.execute(
            "SELECT nick_canon FROM valor_departed")}
        first_seen_canons = {rr["nick_canon"] for rr in conn.execute(
            "SELECT nick_canon FROM valor_first_seen")}
        today_iso = now[:10]
        new_first_seen: list[tuple] = []  # (canon, nick)

        current_canons: set[str] = set()
        for m in members:
            nick = (m.get("nick") or "").strip()
            if not nick:
                continue
            cls = m.get("class_") or m.get("class") or ""
            canon = _resolve_canon(_valor_canon_cls(nick, cls), alias_map)
            current_canons.add(canon)

            # АФК: флаг от бота ИЛИ подстрока «афк/afk» в титуле (НикАФК и т.п.).
            is_afk = bool(m.get("is_afk")) or _title_is_afk(m.get("title"))
            norm_met_raw = m.get("norm_met")
            valor_val = m.get("valor") if isinstance(m.get("valor"), int) else None
            imm = immunity_map.get(canon)

            # Новичок этой недели?
            is_new = (prev_snap is not None
                      and canon not in prev_canons
                      and canon not in registered_canons
                      and canon not in departed_canons
                      and canon not in first_seen_canons)
            if is_new:
                new_first_seen.append((canon, nick))

            # Иммунные новички:
            #  active/extended → norm_met = None (не оцениваем),
            #                    warning_count = 0
            #  grace          → пересчитываем по effective_norm:
            #                    valor >= eff_norm → True (warn=0)
            #                    valor <  eff_norm → False (warn+=1)
            if is_new:
                # Только появился — иммун стартует сейчас, эту неделю не
                # оцениваем (norm_met=None, без предупреждений).
                norm_met_raw = None
                warning_count = 0
            elif imm and imm["status"] in ("active", "extended"):
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
                    flag_new_nick, flag_ocr_suspect, warning_count, frame)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                    1 if (m.get("flag_new_nick") or is_new) else 0,
                    1 if m.get("flag_ocr_suspect") else 0,
                    warning_count,
                    m.get("frame") if isinstance(m.get("frame"), int) else None,
                ),
            )

        # ── 3.9. Зафиксировать новичков (даёт авто-иммунитет 7д) ──
        for canon_new, nick_new in new_first_seen:
            conn.execute(
                """INSERT OR IGNORE INTO valor_first_seen
                   (nick_canon, first_nick, first_week, first_date, verified)
                   VALUES (?, ?, ?, ?, 0)""",
                (canon_new, nick_new, week, today_iso),
            )

        # Кто снова появился в снимке — снимаем ручной кик (force_archived):
        # человек вернулся, держать его в архиве больше не нужно.
        for cn in current_canons:
            conn.execute(
                "DELETE FROM valor_force_archived WHERE nick_canon = ?", (cn,))

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
                        """INSERT OR REPLACE INTO valor_history
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
                        """INSERT OR REPLACE INTO valor_history
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
                             actor: dict | None = None) -> dict:
    """Добавить ручное предупреждение нику. severity ∈ ok|mid|low|bad|crit.
    Доступно офицеру/админу; пишется в журнал действий (audit_log)."""
    canon = _valor_canon(nick)
    if not canon:
        return {"ok": False, "error": "bad nick"}
    actor = actor or {"platform": "", "id": "", "name": ""}
    sev = severity if severity in _MWARN_SEV else "mid"
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO valor_manual_warnings "
            "(nick_canon, severity, reason, created_at, created_by) "
            "VALUES (?,?,?,?,?)",
            (canon, sev, (reason or "").strip()[:200], now, actor.get("name", "")),
        )
        _write_audit(conn, "warn_add", None, nick, None,
                     {"severity": sev, "reason": (reason or "").strip()[:200]}, actor)
        return {"ok": True, "id": cur.lastrowid}


def valor_remove_manual_warning(warning_id: int, actor: dict | None = None) -> bool:
    """Удалить ручное предупреждение по id. Пишется в журнал действий."""
    actor = actor or {"platform": "", "id": "", "name": ""}
    with connection() as conn:
        row = conn.execute(
            "SELECT nick_canon, severity, reason FROM valor_manual_warnings WHERE id = ?",
            (warning_id,)).fetchone()
        cur = conn.execute(
            "DELETE FROM valor_manual_warnings WHERE id = ?", (warning_id,))
        if cur.rowcount > 0 and row:
            _write_audit(conn, "warn_remove", None, row["nick_canon"],
                         {"severity": row["severity"], "reason": row["reason"]},
                         None, actor)
        return cur.rowcount > 0


def valor_manual_immunity_map() -> dict[str, dict[str, str]]:
    """{nick_canon: {week: reason}} — ручной иммунитет по неделям."""
    out: dict[str, dict[str, str]] = {}
    with connection() as conn:
        for r in conn.execute(
                "SELECT nick_canon, week, reason FROM valor_manual_immunity"):
            out.setdefault(r["nick_canon"], {})[r["week"]] = r["reason"]
    return out


def valor_manual_immunity_set(nick: str, week: str, reason: str,
                              actor: dict | None = None) -> dict:
    """Дать ручной иммунитет нику на конкретную неделю (офицер/админ) + причина.
    Освобождает от нормы на эту неделю (нет предупреждений, форма не падает)."""
    canon = _valor_canon(nick)
    week = (week or "").strip()
    if not canon or not week:
        return {"ok": False, "error": "bad nick/week"}
    actor = actor or {"platform": "", "id": "", "name": ""}
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            """INSERT INTO valor_manual_immunity
               (nick_canon, week, reason, created_at, created_by)
               VALUES (?,?,?,?,?)
               ON CONFLICT(nick_canon, week) DO UPDATE SET
                 reason=excluded.reason, created_at=excluded.created_at,
                 created_by=excluded.created_by""",
            (canon, week, (reason or "").strip()[:200], now, actor.get("name", "")))
        _write_audit(conn, "immune_manual_on", None, nick, None,
                     {"week": week, "reason": (reason or "").strip()[:200]}, actor)
    return {"ok": True, "week": week}


def valor_manual_immunity_remove(nick: str, week: str,
                                 actor: dict | None = None) -> dict:
    """Снять ручной иммунитет нику на неделю."""
    canon = _valor_canon(nick)
    week = (week or "").strip()
    actor = actor or {"platform": "", "id": "", "name": ""}
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM valor_manual_immunity WHERE nick_canon=? AND week=?",
            (canon, week))
        if cur.rowcount:
            _write_audit(conn, "immune_manual_off", None, nick, None,
                         {"week": week}, actor)
    return {"ok": True, "removed": cur.rowcount}


# ── «Чистый лист» возвращенца из архива ───────────────────────────────
def valor_return_slate_map() -> dict[str, dict[str, str]]:
    """{nick_canon: {slate_week, returned_at, returned_by}} — недели возврата
    из архива. Недели СТРОГО ДО slate_week — прошлая жизнь (норматив не требуется,
    недоборы не считаются, но доблесть/титулы/история сохраняются)."""
    out: dict[str, dict[str, str]] = {}
    with connection() as conn:
        for r in conn.execute(
                "SELECT nick_canon, slate_week, returned_at, returned_by "
                "FROM valor_return_slate"):
            out[r["nick_canon"]] = {
                "slate_week":  r["slate_week"],
                "returned_at": r["returned_at"],
                "returned_by": r["returned_by"],
            }
    return out


def valor_return_slate_set(nick: str, slate_week: str,
                           actor: dict | None = None) -> dict:
    """Отметить неделю возврата человека из архива (чистый лист)."""
    canon = _valor_canon(nick)
    slate_week = (slate_week or "").strip()
    if not canon or not slate_week:
        return {"ok": False, "error": "bad nick/week"}
    actor = actor or {"platform": "", "id": "", "name": ""}
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            """INSERT INTO valor_return_slate
               (nick_canon, slate_week, returned_at, returned_by)
               VALUES (?,?,?,?)
               ON CONFLICT(nick_canon) DO UPDATE SET
                 slate_week=excluded.slate_week,
                 returned_at=excluded.returned_at,
                 returned_by=excluded.returned_by""",
            (canon, slate_week, now, actor.get("name", "")))
    return {"ok": True, "slate_week": slate_week}


def valor_set_afk(member_id: int, is_afk: bool, afk_note: str | None,
                  actor: dict | None = None, afk_until: str | None = None) -> dict | None:
    """Дать/снять статус АФК + комментарий + СРОК (офицер/админ). Лог в audit_log.
    afk_until — дата 'YYYY-MM-DD', после которой АФК снимется сам (пусто =
    бессрочно). При снятии АФК (is_afk=False) срок и заметка очищаются."""
    actor = actor or {"platform": "", "id": "", "name": ""}
    now = datetime.utcnow().isoformat(timespec="seconds")
    until = _norm_afk_until(afk_until) if afk_until is not None else None
    with connection() as conn:
        row = conn.execute(
            "SELECT nick, nick_canon, is_afk FROM valor_members WHERE id = ?",
            (member_id,)).fetchone()
        if not row:
            return None
        canon = row["nick_canon"]
        before = {"is_afk": bool(row["is_afk"])}
        conn.execute("UPDATE valor_members SET is_afk = ? WHERE id = ?",
                     (1 if is_afk else 0, member_id))
        # Заметку/срок ведём в valor_afk_note (по canon, переживает снимки).
        if not is_afk:
            # АФК снят — срок и заметка больше не нужны.
            conn.execute("DELETE FROM valor_afk_note WHERE nick_canon = ?", (canon,))
        elif afk_note is not None or until is not None:
            note = (str(afk_note).strip() if afk_note is not None else "")
            cur = conn.execute(
                "SELECT note, afk_until FROM valor_afk_note WHERE nick_canon = ?",
                (canon,)).fetchone()
            new_note = note if afk_note is not None else (cur["note"] if cur else "")
            new_until = (until if until is not None
                         else (cur["afk_until"] if cur else ""))
            if new_note or new_until:
                conn.execute(
                    """INSERT INTO valor_afk_note (nick_canon, note, afk_until, updated_at, updated_by)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(nick_canon) DO UPDATE SET
                         note=excluded.note, afk_until=excluded.afk_until,
                         updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
                    (canon, new_note, new_until, now, actor.get("name", "")))
            else:
                conn.execute("DELETE FROM valor_afk_note WHERE nick_canon = ?", (canon,))
        after = {"is_afk": bool(is_afk),
                 "afk_note": (afk_note or "").strip() if afk_note is not None else "—",
                 "afk_until": until if until is not None else "—"}
        _write_audit(conn, "afk_on" if is_afk else "afk_off", None,
                     row["nick"], before, after, actor)
        return {"ok": True, "is_afk": bool(is_afk), "afk_until": until or ""}


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


def valor_dismiss_warnings(canon: str, kind: str, actor: dict,
                           reason: str = "", ref: str | None = None) -> dict:
    """«Простить» вычисляемое предупреждение (офицер/админ):
      kind='norm'  — авто-штраф за невыполнение норматива. ref=неделя → снять
                     ТОЛЬКО её (по одной); ref=None → все текущие недели.
      kind='title' — штраф из числового титула (текущая цифра).
    Запись переживает пересчёт; фильтруется в valor_active_warnings /
    valor_get_current. canon приходит с фронта (m.nick_canon) — совпадает с
    ключами активных предупреждений."""
    canon = (canon or "").strip()
    if not canon:
        return {"ok": False, "reason": "bad_canon"}
    ref = (ref or "").strip() or None
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = actor.get("name") or actor.get("role") or ""
    details: dict[str, dict] = {}   # ref → подробности на момент выставления
    if kind == "norm":
        active = valor_active_warnings().get(canon, [])
        if ref:                       # снять только одну конкретную неделю
            active = [a for a in active if a["week"] == ref]
        refs = [a["week"] for a in active]
        for a in active:
            details[a["week"]] = {
                "week": a["week"], "valor": a.get("valor"),
                "norm": a.get("norm"),                 # норматив (для grace — сниженный)
                "full_norm": a.get("full_norm"),       # полный норматив недели
                "grace_factor": a.get("grace_factor"), # доля (дней без иммунитета)
                "pct": a.get("pct"),
                "grace": bool(a.get("grace")),         # иммунитет спал среди недели
            }
    elif kind == "title":
        with connection() as conn:
            row = conn.execute(
                "SELECT title FROM valor_members WHERE nick_canon = ? "
                "ORDER BY snapshot_id DESC LIMIT 1", (canon,)).fetchone()
        tw = _title_warn(row["title"]) if row else None
        if tw is None:
            return {"ok": True, "dismissed": 0}
        refs = [str(tw)]
        details[str(tw)] = {"value": tw, "title": (row["title"] if row else "")}
    else:
        return {"ok": False, "reason": "bad_kind"}
    if not refs:
        return {"ok": True, "dismissed": 0}
    reason = (reason or "").strip()[:500]
    with connection() as conn:
        for ref in refs:
            det = json.dumps(details.get(ref, {}), ensure_ascii=False)
            conn.execute(
                "INSERT OR IGNORE INTO valor_warn_dismiss "
                "(nick_canon, kind, ref, detail, reason, created_at, created_by) "
                "VALUES (?,?,?,?,?,?,?)",
                (canon, kind, str(ref), det, reason, now, by))
    return {"ok": True, "dismissed": len(refs)}


def valor_dismissed_history(canon: str) -> list[dict]:
    """Полная история прощённых предупреждений игрока (для окна у ника):
    тип, что было (неделя/доблесть/норма/цифра), кто и когда простил."""
    canon = (canon or "").strip()
    out: list[dict] = []
    if not canon:
        return out
    with connection() as conn:
        for r in conn.execute(
                "SELECT kind, ref, detail, reason, created_at, created_by "
                "FROM valor_warn_dismiss WHERE nick_canon = ? ORDER BY created_at",
                (canon,)):
            try:
                det = json.loads(r["detail"]) if r["detail"] else {}
            except Exception:
                det = {}
            out.append({"kind": r["kind"], "ref": r["ref"], "detail": det,
                        "reason": r["reason"] or "",
                        "created_at": r["created_at"], "created_by": r["created_by"]})
    return out


def valor_restore_warnings(canon: str, actor: dict) -> dict:
    """Вернуть прощённые предупреждения (снять прощение) для канона — все типы."""
    canon = (canon or "").strip()
    if not canon:
        return {"ok": False, "reason": "bad_canon"}
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM valor_warn_dismiss WHERE nick_canon = ?", (canon,))
    return {"ok": True, "restored": cur.rowcount or 0}


def valor_list_tags() -> dict[str, list[str]]:
    """Возвращает map canon → [tags...]."""
    out: dict[str, list[str]] = {}
    with connection() as conn:
        for r in conn.execute(
            "SELECT nick_canon, tag FROM valor_tags ORDER BY tag"
        ):
            out.setdefault(r["nick_canon"], []).append(r["tag"])
    return out


def valor_tag_dates() -> dict[str, dict]:
    """canon → {tag: added_at} — когда роль добавлена (для ручных меток)."""
    out: dict[str, dict] = {}
    with connection() as conn:
        for r in conn.execute(
            "SELECT nick_canon, tag, added_at FROM valor_tags"
        ):
            out.setdefault(r["nick_canon"], {})[r["tag"]] = r["added_at"]
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
    """Список ушедших из клана с последними известными данными.
    Если человека увели в архив вручную (кик) — добавляем пометку (причину)
    и кто это сделал из valor_force_archived (LEFT JOIN: у самостоятельно
    ушедших пометки нет → NULL).

    Для АВТО-ушедших (пропал из сбора, вручную не кикали) добавляем:
      first_week   — первая неделя, где человек был в сборе;
      missing_week — первый сбор, где его УЖЕ НЕ было (следующий после last_week)
                     = неделя, из-за которой он авто-кикнут в архив.
    Фронт лепит пометку «был в сборах X…Y, нет в сборе Z → авто-архив»."""
    with connection() as conn:
        # Первая неделя присутствия каждого (по всем снимкам) — для диапазона.
        first_seen = {r["cn"]: r["fw"] for r in conn.execute(
            "SELECT vm.nick_canon AS cn, MIN(vs.week) AS fw "
            "FROM valor_members vm JOIN valor_snapshots vs ON vs.id = vm.snapshot_id "
            "GROUP BY vm.nick_canon")}
        all_weeks = [r["week"] for r in conn.execute(
            "SELECT week FROM valor_snapshots ORDER BY week")]
        rows = conn.execute(
            "SELECT d.*, fa.reason AS archive_reason, fa.archived_by AS archive_by "
            "FROM valor_departed d "
            "LEFT JOIN valor_force_archived fa ON fa.nick_canon = d.nick_canon "
            "ORDER BY d.departed_at DESC"
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            lw = d.get("last_week") or ""
            d["first_week"] = first_seen.get(d["nick_canon"], lw)
            nxt = [w for w in all_weeks if w > lw]   # первый сбор без него
            d["missing_week"] = nxt[0] if nxt else ""
            out.append(d)
        return out


# Синонимы ролей для глобального поиска (по названию роли — русское/латиница).
_ROLE_SEARCH_SYN = {
    "veteran": ("ветеран", "veteran", "вет"),
    "elite":   ("элита", "elite", "топ по урону", "урон"),
    "officer": ("офицер", "officer"),
}
_ROLE_LABELS = {"veteran": "Ветеран", "elite": "Элита", "officer": "Офицер"}


def global_search(q: str, limit: int = 40) -> list[dict[str, Any]]:
    """Единый поиск по ВСЕМ разделам сайта: реестр приёма, таблица Доблести
    (сейчас/когда-либо), архив «Покинули клан», ручные кики, участники чатов,
    роли. Ищет по нику/имени (в т.ч. реальные имя-фамилия из VK/Telegram)/титулу
    (в реестре и Доблести)/примечанию/соц-нику И по названию роли.
    Возвращает список людей (по канону) с тем, в КАКИХ разделах они есть, и
    какие у них роли — чтобы понять «был ли человек на сайте и где он сейчас».
    Каждый: {canon, nick, sections:[...], roles:[...]}."""
    ql = (q or "").strip().lower()
    if len(ql) < 2:
        return []
    qcanon = _valor_canon(ql)
    # Роли, чьё название совпало с запросом → добавим всех их носителей.
    role_hit = {tag for tag, syns in _ROLE_SEARCH_SYN.items()
                if any(ql in s or s in ql for s in syns)}

    def _hit(*fields) -> bool:
        for f in fields:
            if f and ql in str(f).lower():
                return True
        return False

    from collections import defaultdict
    sections_of: dict[str, set] = defaultdict(set)  # canon -> {section,...}
    nick_of: dict[str, tuple] = {}                  # canon -> (nick, priority)
    matched: set[str] = set()

    def _nick(cn: str, nick: str, pri: int) -> None:
        if not nick:
            return
        cur = nick_of.get(cn)
        if cur is None or pri < cur[1]:
            nick_of[cn] = (nick, pri)

    with connection() as conn:
        amap = _alias_map(conn)
        roles_by_canon: dict[str, set] = {}
        for r in conn.execute("SELECT nick_canon, tag FROM valor_tags"):
            roles_by_canon.setdefault(_resolve_canon(r["nick_canon"], amap), set()).add(r["tag"])

        # 1) Реестр приёма (активный + архив).
        for r in conn.execute(
                "SELECT game_nick, title, note, COALESCE(archived,0) AS arch FROM acceptances"):
            cn = _resolve_canon(_valor_canon(r["game_nick"]), amap)
            if not cn:
                continue
            sections_of[cn].add("registry_archived" if r["arch"] else "registry")
            _nick(cn, r["game_nick"], 2)
            if _hit(r["game_nick"], r["title"], r["note"]):
                matched.add(cn)

        # 2) Доблесть — когда-либо + сейчас.
        cur_snap = conn.execute(
            "SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
        cur_id = cur_snap["id"] if cur_snap else None
        for r in conn.execute(
                "SELECT DISTINCT nick_canon, nick, true_name, title FROM valor_members"):
            cn = _resolve_canon(r["nick_canon"], amap)
            sections_of[cn].add("valor_ever")
            _nick(cn, r["nick"], 1)
            if _hit(r["nick"], r["true_name"], r["title"]):
                matched.add(cn)
        if cur_id:
            for r in conn.execute(
                    "SELECT nick_canon, nick, true_name, title FROM valor_members WHERE snapshot_id=?",
                    (cur_id,)):
                cn = _resolve_canon(r["nick_canon"], amap)
                sections_of[cn].add("valor_current")
                _nick(cn, r["nick"], 0)
                if _hit(r["nick"], r["true_name"], r["title"]):
                    matched.add(cn)

        # 3) Архив «Покинули клан» + ручные кики.
        for r in conn.execute("SELECT nick_canon, nick, true_name, last_title FROM valor_departed"):
            cn = _resolve_canon(r["nick_canon"], amap)
            sections_of[cn].add("departed")
            _nick(cn, r["nick"], 3)
            if _hit(r["nick"], r["true_name"], r["last_title"]):
                matched.add(cn)
        for r in conn.execute("SELECT nick_canon FROM valor_force_archived"):
            sections_of[_resolve_canon(r["nick_canon"], amap)].add("force_archived")

        # 4) Участники чатов (VK / Telegram).
        for r in conn.execute(
                "SELECT game_nick, display_name, vk_display, vk_first, vk_last, "
                "vk_screen_name, tg_display, tg_username, tg_first_name, tg_last_name "
                "FROM clan_members WHERE is_active=1"):
            gn = (r["game_nick"] or "").split(",")[0].strip()
            cn = (_resolve_canon(_valor_canon(gn), amap) if gn
                  else (r["display_name"] or "").lower())
            if not cn:
                continue
            sections_of[cn].add("chat")
            _nick(cn, gn or r["display_name"] or r["vk_display"], 4)
            # Ищем и по реальным имени/фамилии из VK/Telegram, не только по нику.
            if _hit(r["game_nick"], r["display_name"], r["vk_display"],
                    r["vk_first"], r["vk_last"], r["vk_screen_name"],
                    r["tg_display"], r["tg_username"], r["tg_first_name"], r["tg_last_name"]):
                matched.add(cn)

        # 5) Прямое совпадение по канону + по НАЗВАНИЮ роли.
        if qcanon:
            for cn in list(sections_of.keys()):
                if qcanon in cn:
                    matched.add(cn)
        if role_hit:
            for cn, tags in roles_by_canon.items():
                if tags & role_hit:
                    matched.add(cn)

        _SEC_RANK = {"valor_current": 0, "registry": 1, "chat": 2,
                     "departed": 3, "force_archived": 4, "valor_ever": 5,
                     "registry_archived": 6}
        out = []
        for cn in matched:
            secs = sections_of.get(cn, set())
            out.append({
                "canon":    cn,
                "nick":     nick_of.get(cn, (cn, 9))[0],
                "sections": sorted(secs, key=lambda s: _SEC_RANK.get(s, 9)),
                "roles":    sorted(roles_by_canon.get(cn, set())),
            })
        # Сортировка: сначала кто есть «сейчас» (в снимке/реестре), потом остальные.
        def _key(e):
            has_now = ("valor_current" in e["sections"]) or ("registry" in e["sections"])
            return (0 if has_now else 1, str(e["nick"]).lower())
        out.sort(key=_key)
        return out[:limit]


def valor_departed_match(game_nick: str) -> list[dict]:
    """Для вводимого в реестр ника(ов) ищет совпадения в архиве «Покинули клан»
    (valor_departed) и в ручных киках (valor_force_archived — с причиной).
    Ник канонизируется тем же способом, что и доблесть (гомоглифы + алиасы),
    поэтому «ОnliF» матчит «OnliF». Возвращает список найденных:
    {input, nick, nick_canon, kicked, reason, by, last_week, departed_at}."""
    out: list[dict] = []
    with connection() as conn:
        amap = _alias_map(conn)
        # Логин админа → показываем как «Админ» (не светим личный логin Лира).
        arow = conn.execute(
            "SELECT admin_username FROM auth_config WHERE id = 1").fetchone()
        admin_name = (arow["admin_username"] if arow else "") or ""

        def _by_label(name: str) -> str:
            name = name or ""
            return "Админ" if name and (name == admin_name or name == "Администратор") else name

        seen: set[str] = set()
        for canon, disp in _acceptance_nicks(game_nick):
            rc = _resolve_canon(canon, amap)
            if rc in seen:
                continue
            seen.add(rc)
            dep = conn.execute(
                "SELECT nick, last_week, departed_at FROM valor_departed "
                "WHERE nick_canon = ?", (rc,)).fetchone()
            fa = conn.execute(
                "SELECT reason, archived_by, archived_at FROM valor_force_archived "
                "WHERE nick_canon = ?", (rc,)).fetchone()
            if not dep and not fa:
                continue
            out.append({
                "input": disp,
                "nick": dep["nick"] if dep else disp,
                "nick_canon": rc,
                "kicked": bool(fa),                       # ручной кик (есть причина)
                "reason": fa["reason"] if fa else "",
                "by": _by_label(fa["archived_by"]) if fa else "",
                "last_week": dep["last_week"] if dep else "",
                "departed_at": (dep["departed_at"] if dep
                                else (fa["archived_at"] if fa else "")),
            })
    return out


def valor_get_current(with_reg_notes: bool = False,
                      with_socials: bool = True) -> dict[str, Any]:
    """Самый свежий снапшот + все его участники + тренд vs предыдущий
    снапшот (если есть).

    with_reg_notes=True добавляет каждому участнику reg_note — примечание из
    реестра приёма (по canon ника). Видно только офицерам/админу; гостю флаг
    не выставляется, поэтому примечания в ответ не попадают.
    """
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
        prev_rank: dict[str, str] = {}     # ранг на прошлой неделе (для «новый офицер»)
        if prev is not None:
            prev_norm = prev["valor_norm"] or 1
            for r in conn.execute(
                "SELECT nick_canon, valor, is_afk, rank FROM valor_members WHERE snapshot_id = ?",
                (prev["id"],)
            ):
                cn = r["nick_canon"]
                v = r["valor"]
                prev_valor[cn] = v if v is not None else None
                prev_rank[cn] = r["rank"] or ""
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
        man_imm = valor_manual_immunity_map()   # ручной иммунитет {canon:{week:reason}}
        ret_slate = valor_return_slate_map()    # {canon:{slate_week,...}} — возвращенцы
        # Веса категорий (нужны уже в цикле — для накопительной ценности).
        _wr = conn.execute(
            "SELECT w_base, w_streak, w_officer, w_veteran, w_social "
            "FROM valor_weights WHERE id = 1").fetchone()
        W = ({"base": _wr["w_base"], "streak": _wr["w_streak"],
              "officer": _wr["w_officer"], "veteran": _wr["w_veteran"],
              "social": _wr["w_social"]} if _wr else dict(_WEIGHT_DEFAULTS))
        _mult_cap = round(1.0 + W["streak"] / max(W["base"], 0.01), 3)
        _soc_base_max = W["social"] / 1.2 if W["social"] > 0 else 0.0
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
            if r["valor"] is None:
                continue
            is_afk = bool(r["is_afk"])
            # Иммунитет (новичок) — это ПРЕИМУЩЕСТВО, а не лишение ценности:
            # как и АФК, иммунный «освобождён» от нормы (нет предупреждений,
            # серия не рвётся при недоборе), НО набранную доблесть засчитываем
            # в ценность/роли/историю.
            acc = accepted_by_canon.get(cn)
            is_immune = False
            is_grace = False
            _gfactor = 1.0
            if acc:
                imm = _compute_immunity(acc, r["week"])
                if imm and imm["status"] in ("active", "extended"):
                    is_immune = True
                elif imm and imm["status"] == "grace":
                    is_grace = True
                    _gfactor = imm["effective_norm_factor"]
            # РУЧНОЙ иммунитет (офицер выдал на эту неделю) — тоже освобождает.
            if r["week"] in man_imm.get(cn, {}):
                is_immune = True
                is_grace = False
            # «ЧИСТЫЙ ЛИСТ» возвращенца: неделя СТРОГО ДО недели возврата — прошлая
            # жизнь. Освобождаем от нормы (недобор не считается негативом), но
            # набранную доблесть/серии/ценность оставляем. Помечаем для UI (синяя
            # штриховка + пометка в истории).
            _slate = ret_slate.get(cn)
            is_pre_return = bool(_slate) and r["week"] < _slate["slate_week"]
            if is_pre_return:
                is_immune = True
                is_grace = False
            # Неоценённая (norm_met None) и НЕ освобождённая неделя — пропуск (legacy).
            if r["norm_met"] is None and not is_afk and not is_immune:
                continue
            excused = is_afk or is_immune   # освобождён от нормы (АФК или иммун)
            norm = r["valor_norm"] or 1
            # Оценку/форму grace-недели считаем от СНИЖЕННОЙ нормы (eff_norm),
            # ценность/серию — от полной (ratio ниже). Иначе «Оценка всех недель»
            # у только-что-вышедшего из иммуна занижается (4/6 как 29%, не 67%).
            norm_eval = max(1, round(norm * _gfactor)) if is_grace else norm
            ratio = r["valor"] / norm
            pct = min(r["valor"] / norm_eval, 1.0) * 100
            overshoot = max(0.0, min((ratio - 1.0) * 100, 100.0))
            wk = r["week"]
            over = r["valor"] > norm
            head = max(VALOR_MAX_WEEKLY - norm, 1)
            ofs = max(0.0, min((r["valor"] - norm) / head, 1.0))
            d = compliance.setdefault(cn, {
                "sum": 0.0, "n": 0, "met": 0, "over_sum": 0.0, "any": 0,
                "streak": 0, "max_streak": 0, "peak": 0.0,
                "cs2": 0, "ms2": 0, "cs3": 0, "ms3": 0,
                "ln_sum": 0.0, "cs2_ln": 0.0, "ms2_geo": 1.0,
                "peak_week": "", "first_week": "", "last_week": "",
                "cs2_start": "", "combo_start": "", "combo_end": "",
                # ── Серии ПЕРЕВЫПОЛНЕНИЯ (valor > norm) + сила OFS ──
                # OFS недели = доля закрытого headroom до потолка 189:
                #   (valor-norm)/(189-norm), 0..1.
                "ostreak": 0, "omax": 0, "o_cur_ofs": 0.0, "omax_ofs": 0.0,
                "o_cur_start": "", "omax_start": "", "omax_end": "",
                "ofs_best": 0.0, "xp": 0.0, "cum_value": 0.0,
                "pcts": [],    # % выполнения по неделям (для «формы» 4 нед)
                "spark": []})  # мини-график: (ratio к норме, excused) по неделям
            d["any"] += 1
            if not d["first_week"]:
                d["first_week"] = wk
            d["last_week"] = wk
            # ── Статистика НАБРАННОЙ доблести — считается ВСЕГДА, в т.ч. в АФК
            #    (если человек в АФК всё равно набрал — это идёт в зачёт). ──
            if ratio > d["peak"]:
                d["peak"] = ratio
                d["peak_week"] = wk
            if ofs > d["ofs_best"]:
                d["ofs_best"] = ofs
            # ── Серия (множитель). Активный: растёт при ПЕРЕВЫПОЛНЕНИИ (>норма),
            #    рвётся при невыполнении. АФК: растёт при ВЫПОЛНЕНИИ нормы
            #    (≥норма); при недоборе/0 — НЕ растёт и НЕ рвётся (заморозка). ──
            met = r["valor"] >= norm
            grow = met if excused else over
            if grow:
                if d["ostreak"] == 0:
                    d["o_cur_start"] = wk
                    d["o_cur_ofs"] = 0.0
                d["ostreak"] += 1
                d["o_cur_ofs"] += ofs          # ofs=0 если ровно норма (длина растёт, множитель — нет)
                if d["ostreak"] > d["omax"]:
                    d["omax"] = d["ostreak"]
                    d["omax_ofs"] = d["o_cur_ofs"]
                    d["omax_start"] = d["o_cur_start"]
                    d["omax_end"] = wk
            elif not excused:
                d["ostreak"] = 0
                d["o_cur_ofs"] = 0.0
            # else: АФК/иммун + недобор → заморозка, серию не трогаем.
            # ── Доблесть-XP (накопительно): набранная доблесть × бонус серии. ──
            xp_mult = min(1 + 0.1 * (d["ostreak"] - 1), 2.0) if d["ostreak"] > 0 else 1.0
            d["xp"] += max(r["valor"], 0) * xp_mult
            # ── Накопительная «Ценность для клана»: ценность ЭТОЙ недели =
            # база(руна недели) × множитель серии. Копится навсегда (прогресс). ──
            _wk_base = _mag_base_w(ratio, W["base"])
            if _wk_base > 0:
                d["cum_value"] += _wk_base * _streak_multiplier(d["o_cur_ofs"], _mult_cap)

            # Точка мини-графика набора доблести (спарклайн в колонке норматива):
            # отношение к норме (1.0 = норма выполнена) + флаг «освобождён»
            # (АФК/иммун — не в счёт нормы, рисуем приглушённо). Пишем ДО
            # excused-continue, чтобы график был непрерывным по всем неделям.
            # a=1 — именно АФК-неделя (для фиолетовой покраски столбика, как в
            # истории). e без a = иммунитет/новичок (синий).
            # p=1 — неделя «прошлой жизни» возвращенца (до недели возврата):
            # рисуем как иммун (синий), недобор штрихуем синим (не «провал»).
            d["spark"].append({"r": round(ratio, 2), "e": 1 if excused else 0,
                               "a": 1 if is_afk else 0,
                               "p": 1 if is_pre_return else 0})

            # ── Оценка НОРМЫ и «форма» ──
            #  • Иммунитет/новичок — освобождён полностью (пропуск).
            #  • АФК: убираем только НЕГАТИВ. Неделя АФК с ВЫПОЛНЕННОЙ нормой
            #    (набрал ≥ норму даже в АФК) засчитывается как обычная выполненная
            #    неделя (позитив в «форму»/оценку/серию). АФК с НЕДОБОРОМ —
            #    пропускаем (форма не падает).
            if excused and not (is_afk and r["valor"] >= norm_eval):
                continue
            d["pcts"].append(pct)
            d["sum"] += pct
            d["over_sum"] += overshoot
            d["n"] += 1
            d["ln_sum"] += math.log(max(ratio, 0.01))
            if r["valor"] >= norm_eval:   # grace — по сниженной норме
                d["met"] += 1
                d["streak"] += 1
                if d["streak"] > d["max_streak"]:
                    d["max_streak"] = d["streak"]
            else:
                d["streak"] = 0
            # серии перевыполнения: ≥1.5× (cs2, + геом.среднее серии) и ≥2× (cs3)
            if ratio >= 1.5:
                if d["cs2"] == 0:
                    d["cs2_start"] = wk      # начало текущей серии ≥1.5×
                d["cs2"] += 1
                d["cs2_ln"] += math.log(ratio)
                if d["cs2"] > d["ms2"]:
                    d["ms2"] = d["cs2"]
                    d["ms2_geo"] = math.exp(d["cs2_ln"] / d["cs2"])
                    d["combo_start"] = d["cs2_start"]   # span самой длинной серии
                    d["combo_end"] = wk
            else:
                d["cs2"] = 0
                d["cs2_ln"] = 0.0
            if ratio >= 2.0:
                d["cs3"] += 1
                if d["cs3"] > d["ms3"]:
                    d["ms3"] = d["cs3"]
            else:
                d["cs3"] = 0

        # Теги по canon (ветеран и т.п.) — для UI меток.
        tags_map = valor_list_tags()
        tag_dates_map = valor_tag_dates()
        afk_info_map = valor_afk_info()     # {canon: {note, until}} — коммент + срок
        afk_notes_map = {c: v["note"] for c, v in afk_info_map.items() if v["note"]}
        man_imm_map = valor_manual_immunity_map()   # ручной иммун {canon:{week:reason}}
        _iy, _iw, _iwd = datetime.utcnow().isocalendar()
        _cur_iso_week = f"{_iy}-W{_iw:02d}"         # текущая ISO-неделя (в игре сейчас)
        _latest_week = cur["week"]                  # неделя отображаемого снапшота
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

        # ── АФК-история по неделям (для подсчёта недель подряд и доблести,
        # набранной за время статуса). is_afk берём РОВНО как сохранён — при
        # загрузке снимка он уже проставляется из титула/флага. Отдельный
        # fallback по титулу здесь ломал РУЧНОЕ снятие АФК у вернувшихся
        # (ник с «АФК» в титуле держал бы серию АФК даже после снятия).
        afk_hist: dict[str, list] = {}
        for r in conn.execute(
            """SELECT vm.nick_canon, vs.week, vm.is_afk, vm.valor
               FROM valor_members vm
               JOIN valor_snapshots vs ON vm.snapshot_id = vs.id
               ORDER BY vm.nick_canon, vs.week"""
        ):
            afk_hist.setdefault(r["nick_canon"], []).append(
                (r["week"], bool(r["is_afk"]), r["valor"]))

        # Ручная коррекция написания ников (админ) — применяется к отображению.
        nick_override: dict[str, str] = {
            r["nick_canon"]: r["nick"]
            for r in conn.execute("SELECT nick_canon, nick FROM valor_nick_override")
        }
        # Новички с непроверенным ником (распознан ИИ) — для подсветки в UI.
        ai_nick_canons: set[str] = {
            r["nick_canon"] for r in conn.execute(
                "SELECT nick_canon FROM valor_first_seen WHERE verified = 0")
        }
        # Реестр приёма: написание авторитетно (Лир копирует из игры). Кто в
        # реестре — не помечаем «распознан ИИ», и показываем ИХ написание ника.
        # canon → точное написание (позднее по дате перетирает раннее).
        ai_registered: set[str] = set()
        reg_nick: dict[str, str] = {}
        for rr in conn.execute(
                "SELECT game_nick FROM acceptances WHERE COALESCE(archived,0)=0 "
                "ORDER BY accepted_date"):
            for c, p in _acceptance_nicks(rr["game_nick"]):
                ai_registered.add(c)
                reg_nick[c] = p
        # Ручной кик (force_archived) — этих в основном списке не показываем.
        force_archived: set[str] = {
            r["nick_canon"] for r in conn.execute(
                "SELECT nick_canon FROM valor_force_archived")
        }
        # Примечание из реестра приёма по canon (только для офицеров/админа).
        # ORDER BY accepted_date — более поздняя запись перетирает раннюю.
        note_by_canon: dict[str, str] = {}
        note_hist_by_canon: dict[str, tuple] = {}   # canon -> (latest_text, count)
        if with_reg_notes:
            for r in conn.execute(
                "SELECT game_nick, note FROM acceptances ORDER BY accepted_date"
            ):
                for piece in (r["game_nick"] or "").split(","):
                    c = _valor_canon(piece)
                    if c:
                        val = r["note"] or ""
                        note_by_canon[c] = "" if _is_note_noise(val) else val
            # История «свитка»: последняя запись перекрывает реестр (они синхронны;
            # для valor-only участников без записи приёма — единственный источник).
            # Записи-«шум» (bare «Ветеран») не учитываем ни в тексте, ни в счётчике.
            _cnt: dict[str, int] = {}
            _last: dict[str, str] = {}
            for r in conn.execute(
                "SELECT nick_canon, text FROM valor_note_history "
                "ORDER BY nick_canon, created_at, id"
            ):
                if _is_note_noise(r["text"]):
                    continue
                c = r["nick_canon"]
                _cnt[c] = _cnt.get(c, 0) + 1
                _last[c] = r["text"]     # ASC → последняя перезапишет
            note_hist_by_canon = {c: (_last[c], _cnt[c]) for c in _cnt}
        # Пул кандидатов для подсказки «возможно это X» при кривом OCR-нике:
        # текущие участники + ушедшие (искомый часто «ушёл», т.к. его нормальный
        # ник в этом снимке не распознался).
        match_pool: list[tuple] = []  # (canon, display_nick)
        for r in conn.execute(
                "SELECT nick_canon, nick FROM valor_members WHERE snapshot_id = ?",
                (cur["id"],)):
            match_pool.append((r["nick_canon"], r["nick"]))
        for r in conn.execute("SELECT nick_canon, nick FROM valor_departed"):
            match_pool.append((r["nick_canon"], r["nick"]))

        # Активные предупреждения за невыполнение норматива (replay истории).
        warn_map = valor_active_warnings()
        # Ручные предупреждения, добавленные офицером через UI.
        manual_warn_map = valor_manual_warnings_by_canon()
        # «Прощённые» титульные предупреждения: canon → {реф-значения}.
        dismissed_title: dict[str, set] = {}
        for r in conn.execute(
                "SELECT nick_canon, ref FROM valor_warn_dismiss WHERE kind='title'"):
            dismissed_title.setdefault(r["nick_canon"], set()).add(r["ref"])
        # Сколько всего прощённых предупреждений у канона — для кнопки истории.
        dismissed_count: dict[str, int] = {}
        for r in conn.execute(
                "SELECT nick_canon, COUNT(*) AS c FROM valor_warn_dismiss "
                "GROUP BY nick_canon"):
            dismissed_count[r["nick_canon"]] = r["c"]

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
        # ── Кубки за место в ТОПе по неделям (накопительно за ВСЕ недели) ──
        # По valor DESC внутри недели: места 1-10 → золото, 11-20 → серебро,
        # 21-30 → бронза (один кубок за неделю). Для КАЖДОГО кубка храним ДЕТАЛИ
        # {week, place, norm} — тултип покажет за какие недели/места/норматив.
        _norms = {r["week"]: r["valor_norm"] for r in conn.execute(
            "SELECT week, valor_norm FROM valor_snapshots")}
        cup_map: dict = {}
        _cw: dict = {}
        for cr in conn.execute(
                "SELECT vs.week AS wk, vm.nick_canon AS cn FROM valor_members vm "
                "JOIN valor_snapshots vs ON vm.snapshot_id = vs.id "
                "WHERE vm.valor IS NOT NULL "
                "ORDER BY vs.week, vm.valor DESC, vm.nick"):
            _cw.setdefault(cr["wk"], []).append(cr["cn"])
        for _wk in sorted(_cw):
            _seen = set(); _rank = 0
            for _cn in _cw[_wk]:
                if _cn in _seen:
                    continue
                _seen.add(_cn)
                _band = ("gold" if _rank < 10 else "silver" if _rank < 20
                         else "bronze" if _rank < 30 else None)
                if _band:
                    e = cup_map.setdefault(_cn, {"gold": [], "silver": [], "bronze": []})
                    e[_band].append({"week": _wk, "place": _rank + 1,
                                     "norm": _norms.get(_wk)})
                _rank += 1

        # W / _mult_cap / _soc_base_max уже получены выше (до цикла compliance).
        members = []
        for r in rows:
            m = dict(r)
            # АФК — РОВНО как сохранён. При загрузке снимка is_afk уже ставится
            # из титула/флага (valor_add_snapshot). НЕ пересчитываем из титула
            # здесь: иначе РУЧНОЕ снятие АФК не срабатывает, пока в титуле
            # осталось «АФК» (напр. ник «ЛюбаАФК» у вернувшегося из архива).
            m["is_afk"] = bool(m["is_afk"])
            m["flag_new_nick"] = bool(m["flag_new_nick"])
            m["flag_ocr_suspect"] = bool(m["flag_ocr_suspect"])
            if m["norm_met"] is not None:
                m["norm_met"] = bool(m["norm_met"])
            # Соцсети (по canon ника)
            cn = m["nick_canon"]
            # Ручной кик — этого человека в основном списке не показываем.
            if cn in force_archived:
                continue
            m["socials"] = socials.get(cn) or None
            m["cups"] = cup_map.get(cn)   # {gold,silver,bronze} за топ по неделям
            # Возвращён из архива — «чистый лист» (для пометки в истории/штриховки).
            _rs = ret_slate.get(cn)
            m["returned"] = ({"week": _rs["slate_week"], "at": _rs["returned_at"]}
                             if _rs else None)
            # Ручная коррекция ника админом (canon стабилен — держится из
            # недели в неделю). ai_nick = ник распознан ИИ и ещё не проверен.
            m["id"] = r["id"]
            ov = nick_override.get(cn)
            # Написание ника (приоритет): ЯВНАЯ админ-коррекция (override, кнопка
            # ✎) → реестр приёма (Лир копирует из игры) → как распознал OCR.
            # Override главнее реестра: это осознанная точечная правка админа
            # (напр. реестр внесён с опечаткой, или два ника канонятся одинаково
            # и поздняя запись реестра перетёрла нужное написание). Едино со
            # страницей Скринов (valor_compare_data).
            reg_n = reg_nick.get(cn)
            if ov:
                m["nick"] = ov
            elif reg_n:
                m["nick"] = reg_n
            m["ai_nick"] = (cn in ai_nick_canons) and not ov and (cn not in ai_registered)
            # Примечание (только если запрошено — т.е. не гость). Текущее = самая
            # свежая запись истории; для не-seed'нутых — из реестра. note_count —
            # сколько записей в «свитке» (для бейджа/индикатора в UI).
            if with_reg_notes:
                h = note_hist_by_canon.get(cn)
                if h:
                    m["reg_note"] = h[0]
                    m["note_count"] = h[1]
                else:
                    base = note_by_canon.get(cn, "")
                    m["reg_note"] = base
                    m["note_count"] = 1 if base else 0
            # Подсказка «возможно это X»: для непроверенного ИИ-ника ищем
            # самого похожего среди других участников и ушедших.
            m["suggest"] = None
            if m["ai_nick"]:
                best = None
                for pcn, pnick in match_pool:
                    if pcn == cn:
                        continue
                    rt = _valor_similar(cn, pcn)
                    if best is None or rt > best[0]:
                        best = (rt, pnick, pcn)
                if best and best[0] >= 0.72:
                    m["suggest"] = {"nick": best[1], "canon": best[2],
                                    "ratio": round(best[0], 2)}
            # АФК: недели подряд в статусе + доблесть, набранная за это время.
            m["afk_info"] = _afk_streak(afk_hist.get(cn)) if m["is_afk"] else None
            # Теги: ручные + авто. Авто-теги НЕ пишутся в БД —
            # подмешиваются на лету при выдаче.
            # Соц-роли по отдельности: ВКонтакте / Telegram / Общительность(чаты).
            _soc = m["socials"] or {}
            _has_vk = bool(_soc.get("vk_id") or _soc.get("vk_screen_name"))
            _has_tg = bool(_soc.get("tg_id") or _soc.get("tg_username"))
            _msgs = chat_msgs.get(cn, 0)
            top_rank = top_rank_map.get(cn, "")
            is_officer = _rank_score(top_rank) >= _OFFICER_MIN_SCORE   # Капитан+
            manual_tags = tags_map.get(cn, [])
            m["tag_dates"] = tag_dates_map.get(cn, {})
            m["top_rank"] = top_rank or None
            # Руна офицерского ЗВАНИЯ: за всё время — по высшему посту,
            # за неделю — по текущему (если стал офицером впервые на этой неделе).
            off_tag_all = _officer_tag(top_rank) if is_officer else None
            # ВСЕ статусные роли (для «за всё время»): ручные (veteran…) +
            # руна звания + vk + tg + общительность.
            status_all = list(manual_tags)
            for t in ((off_tag_all,) if off_tag_all else ()):
                if t not in status_all:
                    status_all.append(t)
            for t, has in (("vk", _has_vk), ("tg", _has_tg), ("chat", _msgs > 0)):
                if has and t not in status_all:
                    status_all.append(t)
            # Статусы, полученные ИМЕННО НА ЭТОЙ НЕДЕЛЕ (для «за неделю»):
            #   veteran — если метка проставлена на текущей неделе;
            #   офицерство — если стал офицером впервые (на прошлой неделе не был).
            status_new = []
            # «Новая на этой неделе» статус-роль = появилась ПОСЛЕ прошлого
            # сбора. Сравниваем со временем захвата прошлого снапшота, а НЕ с
            # ISO-неделей: массовая выдача veteran при миграции (01.06 00:30)
            # попадала в ISO-неделю W23 и ложно светилась у всех ветеранов.
            _prev_cap = prev["captured_at"] if prev else None
            _vd = m["tag_dates"].get("veteran")
            if "veteran" in manual_tags and _vd and _prev_cap and _vd > _prev_cap:
                status_new.append("veteran")
            # «Элита» (Топ по урону) — если метка проставлена на этой неделе.
            _ed = m["tag_dates"].get("elite")
            if "elite" in manual_tags and _ed and _prev_cap and _ed > _prev_cap:
                status_new.append("elite")
            # Офицерство: показываем руну, если человек ПОВЫСИЛСЯ относительно
            # прошлой недели (Рядовой→Капитан ИЛИ Капитан→Майор и т.д.).
            if is_officer and _rank_score(top_rank) > _rank_score(prev_rank.get(cn, "")):
                if off_tag_all:   # руна текущего звания ⊆ «за всё время»
                    status_new.append(off_tag_all)
            _has_vet = "veteran" in manual_tags

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
            if d and d.get("any"):
                _recent = d["pcts"][-4:]
                _xp = round(d["xp"])
                _xpp = _xp_progress(_xp)
                _n = d["n"] or 1   # АФК-игрок может иметь 0 оценённых недель
                m["compliance"] = {
                    "avg_pct":     round(d["sum"] / _n, 1),
                    "spark":       d["spark"][-16:],   # мини-график (посл. 16 нед.)
                    "recent_pct":  round(sum(_recent) / len(_recent), 1) if _recent else 0.0,
                    "recent_weeks": len(_recent),
                    "total_xp":    _xp,
                    "xp_next":     _xpp["next"],
                    "xp_prev":     _xpp["prev"],
                    "xp_pct":      _xpp["pct"],
                    "cur_ofs_sum": round(d["o_cur_ofs"], 3),
                    "cum_value":   round(d["cum_value"], 1),
                    "weeks_count": d["n"],
                    "weeks_met":   d["met"],
                    "over_avg":    round(d["over_sum"] / _n, 1),
                    "max_streak":  d["max_streak"],
                    "peak_ratio":  round(d["peak"], 2),
                    "streak2":     d["ms2"],
                    "streak3":     d["ms3"],
                    "geomean_all": round(math.exp(d["ln_sum"] / _n), 2),
                    "combo_len":   d["ms2"],
                    "combo_geo":   round(d["ms2_geo"], 2),
                    "peak_week":   d["peak_week"],
                    "first_week":  d["first_week"],
                    "last_week":   d["last_week"],
                    "combo_start": d["combo_start"],
                    "combo_end":   d["combo_end"],
                    # ── Серии перевыполнения (новая система достижений) ──
                    "over_streak_max": d["omax"],
                    "over_streak_cur": d["ostreak"],
                    "over_ofs_avg":    round(d["omax_ofs"] / d["omax"], 3) if d["omax"] else 0.0,
                    "over_ofs_best":   round(d["ofs_best"], 3),
                    "over_start":      d["omax_start"],
                    "over_end":        d["omax_end"],
                }
            else:
                m["compliance"] = None
            # Роли в таблице: магнитуда (пик ×N) + ТЕКУЩИЙ стрик-тир
            # (сбрасывается при потере серии — как и множитель).
            _cc = m["compliance"] or {}
            # Две колонки ролей:
            #   tags     — «за неделю»: магнитуда ЭТОЙ недели + ТЕКУЩИЙ стрик;
            #   tags_all — «за всё время»: лучший пик + МАКС. стрик + статусы.
            _cur_ratio = (cv / cur_norm) if (cv is not None and cur_norm) else 0.0
            week_mag = _peak_tier(_cur_ratio)
            cur_streak = _streak_tier(_cc.get("over_streak_cur", 0))
            # «за всё время» = максимум достигнутого; не меньше текущей недели.
            peak_mag = _peak_tier(max(_cc.get("peak_ratio", 0.0), _cur_ratio))
            max_streak = _streak_tier(max(_cc.get("over_streak_max", 0),
                                          _cc.get("over_streak_cur", 0)))
            m["achievement"] = peak_mag        # для совместимости (лучший пик)
            m["streak_tag"] = cur_streak
            # «за неделю»: магнитуда+стрик этой недели + СТАТУСЫ, полученные
            # именно на этой неделе (veteran/officer впервые).
            _week = [k for k in (week_mag, cur_streak) if k]
            m["tags"] = _week + [t for t in status_new if t not in _week]
            # «за всё время»: лучший пик + макс. стрик + ВСЕ статусы.
            _all = [k for k in (peak_mag, max_streak) if k]
            m["tags_all"] = _all + [t for t in status_all if t not in _all]

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
                # Kind определяем по pct_delta если есть, иначе по delta.
                # «Стабильно» (flat) — небольшая зона около нуля (а не только
                # ровно 0): ±5 п.п. выполнения или ±3 доблести. Это позитивная
                # оценка «держится стабильно», а не упрёк.
                if pct_delta is not None:
                    kind = "flat" if abs(pct_delta) <= 5 else ("up" if pct_delta > 0 else "down")
                else:
                    kind = "flat" if abs(delta) <= 3 else ("up" if delta > 0 else "down")
                m["trend"] = {"kind": kind, "delta": delta,
                              "pct_delta": pct_delta}

            # ── Финальный score: «ценность для клана» ──
            # База (max 100) + перевыполнение сверху (до +20). По значимости:
            #   compliance:  0..60  (доблесть — главный фактор)
            #   ПЕРЕВЫПОЛН.: 0..20  (бонус сверх 100 — #2, важнее ветерана)
            #   veteran:     0..16  (был в первоначальном списке клана)
            #   officer:     0..14  смесь высшего поста ever (70%) +
            #                текущего поста (30%) — важно и где был, и где сейчас
            #   socials:     0..5   (2.5 за VK + 2.5 за TG)
            #   chat:        0..5   (min(msgs/50, 1) * 5)
            # Если человек ПРЯМО СЕЙЧАС под иммунитетом (active/extended),
            # доблесть-компонент не оценивается: comp_pts=None,
            # max=100-VALOR_W_DOBLEST. total нормализуется к /100.
            comp_obj = m.get("compliance")
            is_immune_now = (immunity and
                             immunity["status"] in ("active", "extended"))
            _c = comp_obj or {}
            # ── ВЕТКА 1: ПЕРЕВЫПОЛНЕНИЕ (база по магнитудной руне) × СЕРИЯ ──
            # База = ценность лучшей магнитудной руны (пик ×N): чем выше
            # перевыполнение — тем больше база. Стрик-руны её УМНОЖАЮТ.
            recent = _c.get("recent_pct", _c.get("avg_pct", 0)) if comp_obj else 0
            doblest_base = _mag_base_w(_c.get("peak_ratio", 0.0), W["base"])
            cur_ofs_sum = _c.get("cur_ofs_sum", 0.0)
            mult = _streak_multiplier(cur_ofs_sum, _mult_cap)
            doblest_value = round(doblest_base * mult, 1)
            streak_bonus = round(doblest_value - doblest_base, 1)
            # ── ВЕТКА 3: ОБЩИТЕЛЬНОСТЬ (VK+TG+чаты) × НЕБОЛЬШОЙ множитель ──
            # Доли веса: VK 25% + TG 25% + чаты 50% от базы; множитель ≤ ×1.2.
            msgs = chat_msgs.get(cn, 0)
            soc = m.get("socials") or {}
            vk_pts = round(_soc_base_max * 0.25, 2) if (soc.get("vk_id") or soc.get("vk_screen_name")) else 0.0
            tg_pts = round(_soc_base_max * 0.25, 2) if (soc.get("tg_id") or soc.get("tg_username")) else 0.0
            # Чат-вклад растёт с активностью до 300 сообщений (а не насыщается
            # на 50) — чтобы САМЫЕ общительные получали больше, чем умеренные.
            chat_pts = round(_soc_base_max * 0.5 * min(msgs / 300.0, 1.0), 2)
            social_base = round(vk_pts + tg_pts + chat_pts, 1)
            social_mult = round(1.0 + min(msgs / 600.0, 0.2), 2)        # до ×1.2 (≈1200 сообщ.)
            social_value = round(social_base * social_mult, 1)
            # ── ВЕТКА 2: ОФИЦЕРСТВО (база по высшему посту × СЛАБЫЙ множитель).
            # База нормирована так, чтобы потолок ветки = вес «офицерство».
            officer_base = round((W["officer"] / 1.4) * _officer_frac(top_rank), 2)
            is_cur_officer = _officer_frac(m.get("rank", "")) > 0
            officer_mult = round(1.0 + (0.25 if is_cur_officer else 0.0)
                                 + 0.15 * _officer_frac(top_rank), 2)    # до ~×1.4
            officer_value = round(officer_base * officer_mult, 1)
            # ── Руна ВЕТЕРАНА (сама по себе, БЕЗ множителя) ──
            veteran_pts = W["veteran"] if _has_vet else 0
            # ── Итог ЗА НЕДЕЛЮ: доблесть×множ + офицерство×множ + общит×множ + ветеран ──
            total = round((doblest_value or 0) + officer_value + social_value + veteran_pts, 1)
            # ── Итог ЗА ВСЁ ВРЕМЯ: накопленная доблесть-ценность (копится по
            # неделям) + текущие аддитивные ветки. Только растёт. ──
            total_all_time = round(_c.get("cum_value", 0.0) + officer_value
                                   + social_value + veteran_pts, 1)
            # Очки достижений (флейвор для Зала) — по открытым рунам.
            ach_points = _achievement_points(_c.get("peak_ratio", 0.0), _c.get("total_xp", 0))
            m["score"] = {
                "total":           total,
                "total_all_time":  total_all_time,
                "cum_value":       _c.get("cum_value", 0.0),
                "immunity_adjusted": is_immune_now,
                # ветка 1 — доблесть × множитель
                "doblest_base":    doblest_base,        # ценность магнитудной руны
                "doblest_base_max": W["base"],
                "streak_mult":     mult,
                "streak_bonus":    streak_bonus,        # вклад множителя (доля стриков)
                "streak_max":      W["streak"],
                "doblest_value":   doblest_value,
                "recent_pct":      _c.get("recent_pct", 0),
                "recent_weeks":    _c.get("recent_weeks", 0),
                "avg_pct":         _c.get("avg_pct", 0),
                "peak_ratio":      _c.get("peak_ratio", 0),
                "over_streak_max": _c.get("over_streak_max", 0),
                "over_streak_cur": _c.get("over_streak_cur", 0),
                "over_ofs_avg":    _c.get("over_ofs_avg", 0),
                "total_xp":        _c.get("total_xp", 0),
                "achievement_points": ach_points,
                # ветка 2 — офицерство (× слабый множитель)
                "officer":         officer_value,
                "officer_base":    officer_base,
                "officer_mult":    officer_mult,
                "officer_max":     W["officer"],
                "is_cur_officer":  is_cur_officer,
                "top_rank":        top_rank or None,
                "cur_rank":        m.get("rank") or None,
                # ветка 3 — общительность (× небольшой множитель)
                "vk":              vk_pts,
                "tg":              tg_pts,
                "chat":            chat_pts,
                "chat_msgs":       msgs,
                "social_base":     social_base,
                "social_mult":     social_mult,
                "social":          social_value,
                "social_max":      W["social"],
                # руна ветерана
                "veteran":         veteran_pts,
                "veteran_max":     W["veteran"],
                # legacy-алиасы (совместимость со старым фронтом до обновления)
                "compliance":      doblest_value,
                "achievement":     streak_bonus,
                "discipline":      streak_bonus,
                "socials":         round(vk_pts + tg_pts, 1),
            }
            # Предупреждения, отмеченные офицером в игре (числовой титул 1–9).
            # Показываем ОТДЕЛЬНО от авто-счётчика по нормативу. Так как это
            # абсолютное число из титула, повторно (пока цифра та же) оно не
            # «накручивается» — новым предупреждением считается только смена.
            tw = _title_warn(m.get("title"))
            # Офицер мог «простить» титульное предупреждение для этой цифры.
            if tw is not None and str(tw) in dismissed_title.get(cn, set()):
                tw = None
            m["title_warn"] = tw
            m["title_warn_since"] = title_hist_week.get(cn) if tw else None
            # Активные норматив-предупреждения (строгие — первыми для показа).
            w = warn_map.get(cn, [])
            m["warnings"] = sorted(w, key=lambda x: x["pct"])
            m["warning_count"] = len(w)  # для бейджа в колонке «Норматив»
            m["manual_warnings"] = manual_warn_map.get(cn, [])
            m["dismissed_count"] = dismissed_count.get(cn, 0)  # прощённых всего
            m["afk_note"] = afk_notes_map.get(cn, "")
            m["afk_until"] = (afk_info_map.get(cn) or {}).get("until", "")
            # Ручной иммунитет: показываем только АКТУАЛЬНЫЙ — на ОТОБРАЖАЕМУЮ
            # неделю (тогда ячейка станет иммунной) ИЛИ на текущую/будущую ISO-
            # неделю (тогда кнопка подсвечена, «выдан наперёд»). Прошедшие
            # иммунитеты кнопку НЕ подсвечивают — иммун «спадает» через неделю сам
            # (в оценке каждая неделя проверяется отдельно, запись остаётся историей).
            _cimm = man_imm_map.get(cn)
            if _cimm:
                _rel = [w for w in _cimm if w == _latest_week or w >= _cur_iso_week]
                if _rel:
                    _iw_wk = _latest_week if _latest_week in _cimm else min(_rel)
                    m["manual_immune"] = {"week": _iw_wk, "reason": _cimm[_iw_wk],
                                          "current": _iw_wk == _latest_week}
            # АФК — снимаем ВСЕ предупреждения (по требованию Лира): пока человек
            # в АФК, на сайте у него нет ни норматив-, ни титульных, ни ручных
            # предупреждений. Вернётся из АФК — реальные провалы прошлых недель
            # снова отобразятся (история не теряется).
            if m["is_afk"]:
                m["warnings"] = []
                m["warning_count"] = 0
                m["title_warn"] = None
                m["title_warn_since"] = None
                m["manual_warnings"] = []
            # Данные VK/Telegram (профили) — только офицерам/админу. Гостю
            # отдаём None. Соц-баллы (score.socials, теги vk/tg) уже посчитаны
            # выше на полных данных, поэтому зануление дисплея их не ломает.
            if not with_socials:
                m["socials"] = None
            members.append(m)
        # Карта недель → дата/время сбора (для расшифровки «W22» в UI).
        weeks_meta = {}
        for r in conn.execute(
            "SELECT week, captured_at, valor_norm FROM valor_snapshots"
        ):
            weeks_meta[r["week"]] = {
                "captured_at": r["captured_at"], "norm": r["valor_norm"]}
        return {
            "snapshot": dict(cur),
            "previous_week": prev["week"] if prev else None,
            "members": members,
            "weeks_meta": weeks_meta,
        }


_VALOR_EDIT_TEXT = ("true_name", "rank", "title", "class_")
_VALOR_EDIT_INT = ("level", "valor")

# Поля строки valor_members, которые имеют смысл хранить в журнале правок.
_MEMBER_LOG_FIELDS = ("nick", "nick_canon", "true_name", "rank", "title",
                      "level", "class_", "valor", "is_afk", "norm_met",
                      "flag_new_nick", "flag_ocr_suspect", "frame", "warning_count")


def _member_snap(row) -> dict:
    """Срез строки valor_members (dict) для журнала before/after."""
    if row is None:
        return {}
    d = dict(row)
    return {k: d.get(k) for k in _MEMBER_LOG_FIELDS if k in d}


def _week_of_member(conn, member_id: int) -> str:
    r = conn.execute(
        "SELECT vs.week AS w FROM valor_members vm "
        "JOIN valor_snapshots vs ON vm.snapshot_id = vs.id WHERE vm.id = ?",
        (member_id,)).fetchone()
    return r["w"] if r else ""


def _log_valor_edit(conn, *, week, action, member_id, nick, canon,
                    before, after, actor):
    """Записать действие правки данных доблести в журнал (внутри транзакции)."""
    conn.execute(
        "INSERT INTO valor_edit_log "
        "(week, action, member_id, nick_canon, nick, before_json, after_json, "
        " actor_name, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (week or "", action, member_id, canon or "", nick or "",
         json.dumps(before, ensure_ascii=False) if before is not None else "",
         json.dumps(after, ensure_ascii=False) if after is not None else "",
         (actor.get("name") or actor.get("role") or "") if actor else "",
         datetime.utcnow().isoformat(timespec="seconds")))


def valor_update_member(member_id: int, fields: dict, actor: dict) -> dict | None:
    """Админ-правка строки доблести. Редактируемые поля: nick, true_name,
    rank, title, class_, level, valor, is_afk.

    Особое поведение для nick: nick_canon (ключ матчинга по неделям и с
    реестром) НЕ меняем — правим только отображаемый nick И заводим
    valor_nick_override(canon→nick), чтобы коррекция держалась из недели в
    неделю, даже если OCR снова отдаёт кривой ник. При правке ника снимаем
    флаг «распознан ИИ» (flag_new_nick=0) и помечаем first_seen.verified=1.
    """
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = actor.get("name") or actor.get("role") or ""
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM valor_members WHERE id = ?", (member_id,)
        ).fetchone()
        if not row:
            return None
        canon = row["nick_canon"]

        # Текстовые/числовые поля строки снимка.
        sets, vals = [], []
        for f in _VALOR_EDIT_TEXT:
            key = "class" if f == "class_" else f
            if key in fields and fields[key] is not None:
                sets.append(f"{f} = ?")
                vals.append(str(fields[key]).strip())
        for f in _VALOR_EDIT_INT:
            if f in fields:
                v = fields[f]
                sets.append(f"{f} = ?")
                vals.append(int(v) if isinstance(v, int) else None)
        if "is_afk" in fields and fields["is_afk"] is not None:
            sets.append("is_afk = ?")
            vals.append(1 if fields["is_afk"] else 0)

        # Снимаем «сомнение OCR» (по классу) ТОЛЬКО если класс реально
        # ИЗМЕНИЛИ — форма правки шлёт все поля сразу, поэтому проверяем
        # фактическое изменение значения, а не само наличие поля. Правка
        # другого поля не должна гасить сомнение по классу.
        if ("class" in fields and fields["class"] is not None
                and str(fields["class"]).strip() != (row["class_"] or "")):
            sets.append("flag_ocr_suspect = ?")
            vals.append(0)

        # Комментарий к АФК (причина, до какого числа) — по canon, держится
        # между неделями. Пустая строка → удаляем запись.
        if "afk_note" in fields and fields["afk_note"] is not None:
            note = str(fields["afk_note"]).strip()
            if note:
                conn.execute(
                    """INSERT INTO valor_afk_note (nick_canon, note, updated_at, updated_by)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(nick_canon) DO UPDATE SET
                         note=excluded.note, updated_at=excluded.updated_at,
                         updated_by=excluded.updated_by""",
                    (canon, note, now, by))
            else:
                conn.execute("DELETE FROM valor_afk_note WHERE nick_canon = ?", (canon,))

        # Ник: правим отображаемый ник строки. Флаг «распознан ИИ» снимаем
        # ТОЛЬКО если ник реально изменили (форма шлёт ник всегда; правка
        # другого поля не должна гасить сомнение по нику).
        new_nick = fields.get("nick")
        nn = str(new_nick).strip() if (new_nick is not None) else ""
        nick_changed = bool(nn) and nn != (row["nick"] or "")
        if nn:
            sets.append("nick = ?"); vals.append(nn)
        if nick_changed:
            sets.append("flag_new_nick = ?"); vals.append(0)

        if sets:
            conn.execute(
                f"UPDATE valor_members SET {', '.join(sets)} WHERE id = ?",
                (*vals, member_id),
            )
        # Двусторонняя синхронизация ника: Доблесть ↔ Реестр (override +
        # game_nick по canon, с миграцией canon если он сменился). Только при
        # реальной смене ника.
        if nick_changed:
            # member_id строки не меняется (мигрируется только nick_canon).
            _sync_nick_in_conn(conn, canon, nn, now, by)
        out_row = conn.execute(
            "SELECT * FROM valor_members WHERE id = ?", (member_id,)).fetchone()
        out = dict(out_row) if out_row else {"ok": True}
        _log_valor_edit(conn, week=_week_of_member(conn, member_id),
                        action="edit", member_id=member_id,
                        nick=(out_row["nick"] if out_row else ""),
                        canon=canon, before=_member_snap(row),
                        after=_member_snap(out_row), actor=actor)
    return out


def valor_verify_member(member_id: int, actor: dict) -> dict:
    """Человек проверил строку и подтвердил, что распознано верно — снимаем
    флаги сомнений: «ник распознан ИИ» (flag_new_nick) и «сомнение OCR по
    классу» (flag_ocr_suspect). Значения полей не меняются."""
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM valor_members WHERE id = ?", (member_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "not_found"}
        before = _member_snap(row)
        conn.execute(
            "UPDATE valor_members SET flag_new_nick = 0, flag_ocr_suspect = 0 "
            "WHERE id = ?", (member_id,))
        after = dict(before)
        after["flag_new_nick"] = 0
        after["flag_ocr_suspect"] = 0
        _log_valor_edit(conn, week=_week_of_member(conn, member_id),
                        action="verify", member_id=member_id,
                        nick=row["nick"], canon=row["nick_canon"],
                        before=before, after=after, actor=actor)
    return {"ok": True}


def valor_auto_verify(week: str, actor: dict | None = None) -> dict:
    """ШАГ 1 авто-проверки скринов (БЕЗ AI): снимает ЛОЖНЫЙ флаг «ИИ-ник»
    (flag_new_nick) у строк, чей canon уже есть в АВТОРИТЕТНЫХ источниках сайта —
    история Доблести ДРУГИХ недель ∪ реестр приёма ∪ архив ушедших. Значит ник
    распознан верно (совпал по канону с известным игроком), флаг лишний. Каждое
    снятие пишется в журнал правок недели → откатываемо. Возвращает
    {checked, cleared, remaining:[{id,nick}]} (remaining — реально неизвестные)."""
    actor = actor or {"platform": "system", "id": "auto", "name": "авто-проверка"}
    week = (week or "").strip()
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        sid = snap["id"]
        amap = _alias_map(conn)
        # Авторитетные canon'ы (с разворотом alias).
        known = {_resolve_canon(r["nick_canon"], amap) for r in conn.execute(
            "SELECT DISTINCT nick_canon FROM valor_members WHERE snapshot_id != ?", (sid,))}
        known |= {_resolve_canon(r["nick_canon"], amap) for r in conn.execute(
            "SELECT nick_canon FROM valor_departed")}
        for rr in conn.execute(
                "SELECT game_nick FROM acceptances WHERE COALESCE(archived,0)=0"):
            for c, _p in _acceptance_nicks(rr["game_nick"]):
                known.add(_resolve_canon(c, amap))
        rows = conn.execute(
            "SELECT * FROM valor_members WHERE snapshot_id = ? AND flag_new_nick = 1",
            (sid,)).fetchall()
        cleared, remaining = 0, []
        for r in rows:
            if _resolve_canon(r["nick_canon"], amap) in known:
                before = _member_snap(r)
                conn.execute(
                    "UPDATE valor_members SET flag_new_nick = 0 WHERE id = ?", (r["id"],))
                after = dict(before)
                after["flag_new_nick"] = 0
                _log_valor_edit(conn, week=week, action="verify", member_id=r["id"],
                                nick=r["nick"], canon=r["nick_canon"],
                                before=before, after=after, actor=actor)
                cleared += 1
            else:
                remaining.append({"id": r["id"], "nick": r["nick"]})
        return {"ok": True, "checked": len(rows), "cleared": cleared,
                "remaining": remaining}


def valor_auto_fuzzy(week: str, actor: dict | None = None) -> dict:
    """ШАГ 2 авто-проверки (БЕЗ AI): резолв по ПОХОЖЕСТИ. Находит ФАНТОМНЫЕ
    ДУБЛИ — строку с флагом «ИИ-ник», у которой в ТОМ ЖЕ снимке есть двойник с
    почти идентичным ником (similarity ≥ 0.86) и ИДЕНТИЧНЫМИ доблесть+уровень+
    кадр, причём двойник — известный игрок (история/реестр/архив). Это один
    игрок, распознанный OCR дважды → удаляем фантом (лог, откатываемо).
    Возвращает {checked, deduped, deleted:[{nick,twin}], remaining:[{id,nick}]}."""
    actor = actor or {"platform": "system", "id": "auto", "name": "авто-проверка"}
    week = (week or "").strip()
    SIM = 0.86
    with connection() as conn:
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        sid = snap["id"]
        amap = _alias_map(conn)
        auth = {_resolve_canon(r["nick_canon"], amap) for r in conn.execute(
            "SELECT DISTINCT nick_canon FROM valor_members WHERE snapshot_id != ?", (sid,))}
        auth |= {_resolve_canon(r["nick_canon"], amap) for r in conn.execute(
            "SELECT nick_canon FROM valor_departed")}
        for rr in conn.execute(
                "SELECT game_nick FROM acceptances WHERE COALESCE(archived,0)=0"):
            for c, _p in _acceptance_nicks(rr["game_nick"]):
                auth.add(_resolve_canon(c, amap))
        cur = conn.execute(
            "SELECT id, nick, nick_canon, valor, level, frame, flag_new_nick "
            "FROM valor_members WHERE snapshot_id = ?", (sid,)).fetchall()
    flagged = [r for r in cur if r["flag_new_nick"]]
    to_delete, remaining = [], []
    for X in flagged:
        xc = _resolve_canon(X["nick_canon"], amap)
        twin, tsim = None, 0.0
        for Y in cur:
            if Y["id"] == X["id"]:
                continue
            s = _valor_similar(xc, _resolve_canon(Y["nick_canon"], amap))
            if s > tsim:
                tsim, twin = s, Y
        if (twin and tsim >= SIM
                and twin["valor"] == X["valor"] and twin["level"] == X["level"]
                and twin["frame"] == X["frame"]
                and _resolve_canon(twin["nick_canon"], amap) in auth):
            to_delete.append((X["id"], X["nick"], twin["nick"]))
        else:
            remaining.append({"id": X["id"], "nick": X["nick"]})
    deduped = 0
    for mid, _nk, _twin in to_delete:
        if valor_delete_member(mid, actor).get("ok"):
            deduped += 1
    return {"ok": True, "checked": len(flagged), "deduped": deduped,
            "deleted": [{"nick": n, "twin": t} for _i, n, t in to_delete],
            "remaining": remaining}


def valor_add_member(week: str | None, fields: dict, actor: dict) -> dict:
    """Админ: добавить пропущенную строку (OCR не распознал игрока) в снимок.

    week пустой → последний снимок. Дубликат по canon в этом снимке →
    {ok:False, reason:'exists', id}. Логика иммунитета/АФК/warning_count и
    история повторяют valor_save_snapshot, чтобы оценки/графики были верны.
    Если человек был помечен ушедшим/кикнутым — снимается (он снова в списке).
    """
    nick = (fields.get("nick") or "").strip()
    if not nick:
        return {"ok": False, "reason": "no_nick"}
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connection() as conn:
        if week and week.strip():
            snap = conn.execute(
                "SELECT * FROM valor_snapshots WHERE week = ?", (week.strip(),)
            ).fetchone()
        else:
            snap = conn.execute(
                "SELECT * FROM valor_snapshots ORDER BY week DESC LIMIT 1"
            ).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        snap_id = snap["id"]
        wk = snap["week"]
        valor_norm = int(snap["valor_norm"] or 0)

        alias_map = _alias_map(conn)
        raw_canon = _valor_canon(nick)
        resolved = _resolve_canon(raw_canon, alias_map)
        if not resolved:
            return {"ok": False, "reason": "bad_nick"}
        # break_alias=True → пользователь подтвердил, что это ДРУГОЙ игрок,
        # чей ник авто-связан (алиасом) с уже существующим. Разрываем связь и
        # добавляем под СОБСТВЕННЫМ каноном ника (напр. реальная «Нефеса» ур105
        # ≠ «Небеса» ур102, хотя алиас heфeca→heбeca их слил).
        break_alias = bool(fields.get("break_alias")) and (raw_canon in alias_map)
        if break_alias:
            conn.execute("DELETE FROM valor_alias WHERE alias_canon = ?", (raw_canon,))
            canon = raw_canon
        else:
            canon = resolved
        dup = conn.execute(
            "SELECT id, nick, frame, valor, level FROM valor_members "
            "WHERE snapshot_id = ? AND nick_canon = ?",
            (snap_id, canon)).fetchone()
        if dup:
            # via_alias — конфликт возник ТОЛЬКО из-за авто-связи ников (алиаса),
            # а не прямого совпадения → фронт предложит «разорвать связь и добавить».
            # Иначе (прямой дубль canon) — предложит исправить существующую строку.
            via_alias = (raw_canon != resolved) and (raw_canon in alias_map)
            return {"ok": False, "reason": "exists", "id": dup["id"],
                    "conflict": {"id": dup["id"], "nick": dup["nick"],
                                 "frame": dup["frame"], "valor": dup["valor"],
                                 "level": dup["level"], "via_alias": via_alias,
                                 "typed": nick}}

        # ── Позиция вставки (удобно для проверки скринов) ──
        # after_id задан → вставляем МЕЖДУ строкой after_id и следующей за ней:
        # sort_key = середина между их ключами (дробный индекс, ничего не сдвигаем).
        # Кадр по умолчанию берём у строки-соседа (та же перемотка скрина) →
        # добавленный ник сразу виден на сетке/лупе в правильном месте.
        # after_id нет → sort_key=NULL, строка падает в конец (как раньше).
        after_id = fields.get("after_id") if isinstance(fields.get("after_id"), int) else None
        frame_val = fields.get("frame") if isinstance(fields.get("frame"), int) else None
        sort_key = None
        if after_id:
            ordered = conn.execute(
                "SELECT id, sort_key, frame FROM valor_members WHERE snapshot_id = ? "
                "ORDER BY COALESCE(sort_key, id), id", (snap_id,)).fetchall()
            pos = next((i for i, r in enumerate(ordered) if r["id"] == after_id), None)
            if pos is not None:
                aft = ordered[pos]
                aft_key = aft["sort_key"] if aft["sort_key"] is not None else float(aft["id"])
                nxt = ordered[pos + 1] if pos + 1 < len(ordered) else None
                if nxt is not None:
                    nxt_key = nxt["sort_key"] if nxt["sort_key"] is not None else float(nxt["id"])
                    sort_key = (aft_key + nxt_key) / 2.0
                else:
                    sort_key = aft_key + 1.0
                if frame_val is None and aft["frame"] is not None:
                    frame_val = aft["frame"]

        cls = (fields.get("class_") or fields.get("class") or "").strip()
        title = (fields.get("title") or "").strip()
        rank = (fields.get("rank") or "").strip()
        true_name = (fields.get("true_name") or "").strip()
        is_afk = bool(fields.get("is_afk")) or _title_is_afk(title)
        valor_val = fields.get("valor") if isinstance(fields.get("valor"), int) else None
        level_val = fields.get("level") if isinstance(fields.get("level"), int) else None

        # warning_count: продолжаем серию от прошлой недели этого человека.
        prev_snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week < ? ORDER BY week DESC LIMIT 1",
            (wk,)).fetchone()
        prev_warn = 0
        if prev_snap:
            r = conn.execute(
                "SELECT warning_count FROM valor_members "
                "WHERE snapshot_id = ? AND nick_canon = ?",
                (prev_snap["id"], canon)).fetchone()
            if r:
                prev_warn = r["warning_count"] or 0

        imm = valor_immunity_per_canon(wk).get(canon)
        if imm and imm["status"] in ("active", "extended"):
            norm_met_raw, warning_count = None, 0
        elif imm and imm["status"] == "grace":
            eff = max(1, round(valor_norm * imm["effective_norm_factor"]))
            norm_met_raw = (valor_val is not None and valor_val >= eff)
            warning_count = 0 if norm_met_raw else prev_warn + 1
        elif is_afk:
            norm_met_raw, warning_count = None, 0
        else:
            norm_met_raw = (valor_val is not None and valor_val >= valor_norm) if valor_norm else None
            warning_count = 0 if norm_met_raw else prev_warn + 1

        cur = conn.execute(
            """INSERT INTO valor_members
               (snapshot_id, nick, nick_canon, true_name, rank, title,
                level, class_, valor, is_afk, norm_met,
                flag_new_nick, flag_ocr_suspect, warning_count, frame, sort_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (snap_id, nick, canon, true_name, rank, title, level_val, cls,
             valor_val, 1 if is_afk else 0,
             None if norm_met_raw is None else (1 if norm_met_raw else 0),
             0, 0, warning_count, frame_val, sort_key))
        mid = cur.lastrowid

        # Снова в списке → не ушедший и не кикнутый.
        conn.execute("DELETE FROM valor_departed WHERE nick_canon = ?", (canon,))
        conn.execute("DELETE FROM valor_force_archived WHERE nick_canon = ?", (canon,))
        cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM valor_members WHERE snapshot_id = ?",
            (snap_id,)).fetchone()["c"]
        conn.execute(
            "UPDATE valor_snapshots SET members_count = ? WHERE id = ?", (cnt, snap_id))

        # История (valor — всегда; остальные — если значение задано).
        for fld in _HIST_FIELDS:
            if fld == "class":
                val = cls
            elif fld == "level":
                val = str(level_val) if isinstance(level_val, int) else ""
            elif fld == "valor":
                val = str(valor_val) if isinstance(valor_val, int) else ""
            elif fld == "rank":
                val = rank
            elif fld == "title":
                val = title
            else:
                val = (fields.get(fld) or "").strip()
            if fld == "valor":
                conn.execute(
                    "DELETE FROM valor_history WHERE nick_canon = ? AND field = ? AND week = ?",
                    (canon, fld, wk))
                conn.execute(
                    "INSERT OR REPLACE INTO valor_history (nick_canon, field, value, week, captured_at) "
                    "VALUES (?, ?, ?, ?, ?)", (canon, fld, val, wk, now))
            elif val:
                conn.execute(
                    "INSERT OR REPLACE INTO valor_history (nick_canon, field, value, week, captured_at) "
                    "VALUES (?, ?, ?, ?, ?)", (canon, fld, val, wk, now))

        out = conn.execute("SELECT * FROM valor_members WHERE id = ?", (mid,)).fetchone()
        _log_valor_edit(conn, week=wk, action="add", member_id=mid,
                        nick=(out["nick"] if out else nick),
                        canon=(out["nick_canon"] if out else canon),
                        before=None, after=_member_snap(out), actor=actor)
    return {"ok": True, "id": mid, "week": wk, "member": dict(out) if out else None}


def _dedup_member_rows(conn, canon: str) -> None:
    """В каждом снимке оставляем одну строку для canon (с макс valor)."""
    rows = conn.execute(
        "SELECT id, snapshot_id FROM valor_members WHERE nick_canon = ? "
        "ORDER BY snapshot_id, COALESCE(valor, -1) DESC", (canon,)
    ).fetchall()
    seen = set()
    for r in rows:
        if r["snapshot_id"] in seen:
            conn.execute("DELETE FROM valor_members WHERE id = ?", (r["id"],))
        else:
            seen.add(r["snapshot_id"])


def _sync_nick_in_conn(conn, base_canon: str, new_nick: str, now: str, by: str) -> str:
    """Двусторонняя синхронизация ника человека между Доблестью и Реестром.

    Меняет отображаемый ник ВЕЗДЕ, где это один и тот же человек (по canon):
      • Доблесть — valor_nick_override(canon→nick) (+ снимает «ИИ»-флаг);
      • Реестр — game_nick всех acceptances этого человека.
    Если новый ник даёт ДРУГОЙ canon — мигрируем canon (как при merge:
    переписываем valor-таблицы base→new + alias), чтобы примечание, иммунитет
    и история не порвались. Возвращает итоговый canon.
    """
    new_nick = (new_nick or "").strip()
    if not new_nick or not base_canon:
        return base_canon
    amap = _alias_map(conn)
    src = _resolve_canon(base_canon, amap)
    target = _resolve_canon(_valor_canon(new_nick), amap)
    if target and src and target != src:
        conn.execute("UPDATE valor_members SET nick_canon=? WHERE nick_canon=?", (target, src))
        conn.execute("UPDATE OR REPLACE valor_history SET nick_canon=? WHERE nick_canon=?", (target, src))
        for tbl in ("valor_tags", "valor_manual_warnings"):
            try:
                conn.execute(f"UPDATE OR IGNORE {tbl} SET nick_canon=? WHERE nick_canon=?", (target, src))
            except Exception:
                pass
        conn.execute("DELETE FROM valor_first_seen WHERE nick_canon=?", (src,))
        conn.execute("DELETE FROM valor_departed WHERE nick_canon IN (?,?)", (src, target))
        conn.execute("DELETE FROM valor_force_archived WHERE nick_canon=?", (src,))
        _dedup_member_rows(conn, target)
        conn.execute(
            """INSERT INTO valor_alias (alias_canon, target_canon, note, created_at, created_by)
               VALUES (?, ?, 'nick-sync', ?, ?)
               ON CONFLICT(alias_canon) DO UPDATE SET target_canon=excluded.target_canon,
                 created_at=excluded.created_at, created_by=excluded.created_by""",
            (src, target, now, by))
        final = target
    else:
        final = src
    # Доблесть: отображаемый ник + снять «ИИ»-флаг.
    conn.execute(
        """INSERT INTO valor_nick_override (nick_canon, nick, updated_at, updated_by)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(nick_canon) DO UPDATE SET nick=excluded.nick,
             updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
        (final, new_nick, now, by))
    conn.execute("UPDATE valor_first_seen SET verified=1 WHERE nick_canon=?", (final,))
    # Реестр: меняем game_nick у всех записей этого же человека (по canon).
    for r in conn.execute("SELECT id, game_nick FROM acceptances").fetchall():
        c = _resolve_canon(_valor_canon(r["game_nick"]), amap)
        if c in (src, target, final) and r["game_nick"] != new_nick:
            conn.execute("UPDATE acceptances SET game_nick=? WHERE id=?", (new_nick, r["id"]))
    return final


def valor_merge(source_canon: str, target_nick: str, actor: dict) -> dict:
    """«Это он и есть»: сливаем неверно распознанного (source_canon) в
    существующего (target по нику). Переписывает строки/историю на target,
    запоминает alias (будущие кривые чтения сами матчатся), чистит архив,
    ставит отображаемый ник target. Чинит сразу оба случая ошибки ИИ:
    «посчитал новым» и «отправил в архив»."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = actor.get("name") or actor.get("role") or ""
    with connection() as conn:
        amap = _alias_map(conn)
        target = _resolve_canon(_valor_canon(target_nick), amap)
        source = _resolve_canon(source_canon, amap)
        if not source or not target or source == target:
            return {"ok": False, "reason": "same_or_empty"}
        moved = conn.execute(
            "UPDATE valor_members SET nick_canon = ? WHERE nick_canon = ?",
            (target, source)).rowcount
        conn.execute("UPDATE OR REPLACE valor_history SET nick_canon = ? WHERE nick_canon = ?",
                     (target, source))
        for tbl in ("valor_tags", "valor_manual_warnings"):
            try:
                conn.execute(
                    f"UPDATE OR IGNORE {tbl} SET nick_canon = ? WHERE nick_canon = ?",
                    (target, source))
            except Exception:
                pass
        conn.execute("DELETE FROM valor_first_seen WHERE nick_canon = ?", (source,))
        conn.execute("DELETE FROM valor_departed WHERE nick_canon IN (?, ?)",
                     (source, target))
        conn.execute("DELETE FROM valor_force_archived WHERE nick_canon IN (?, ?)",
                     (source, target))
        _dedup_member_rows(conn, target)
        conn.execute(
            """INSERT INTO valor_alias (alias_canon, target_canon, note, created_at, created_by)
               VALUES (?, ?, 'merge', ?, ?)
               ON CONFLICT(alias_canon) DO UPDATE SET target_canon=excluded.target_canon,
                 created_at=excluded.created_at, created_by=excluded.created_by""",
            (source, target, now, by))
        conn.execute(
            """INSERT INTO valor_nick_override (nick_canon, nick, updated_at, updated_by)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(nick_canon) DO UPDATE SET nick=excluded.nick,
                 updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
            (target, target_nick.strip(), now, by))
        conn.execute("UPDATE valor_first_seen SET verified = 1 WHERE nick_canon = ?",
                     (target,))
    return {"ok": True, "moved": moved, "target_canon": target}


def valor_archive_member(canon: str, actor: dict, reason: str = "") -> dict:
    """Ручной кик: убрать человека из основного списка в архив доблести,
    даже если он ещё есть в снимке (система поймёт, что его кикнули)."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = actor.get("name") or actor.get("role") or ""
    with connection() as conn:
        canon = _resolve_canon(canon, _alias_map(conn))
        row = conn.execute(
            """SELECT vm.*, vs.week AS week FROM valor_members vm
               JOIN valor_snapshots vs ON vm.snapshot_id = vs.id
               WHERE vm.nick_canon = ? ORDER BY vs.week DESC LIMIT 1""",
            (canon,)).fetchone()
        if not row:
            return {"ok": False, "reason": "not_found"}
        ov = conn.execute("SELECT nick FROM valor_nick_override WHERE nick_canon = ?",
                          (canon,)).fetchone()
        disp_nick = ov["nick"] if ov else row["nick"]
        conn.execute(
            """INSERT INTO valor_departed
               (nick_canon, nick, true_name, last_week, last_rank, last_title,
                last_level, last_class, last_valor, warning_count, departed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(nick_canon) DO UPDATE SET
                 nick=excluded.nick, true_name=excluded.true_name,
                 last_week=excluded.last_week, last_rank=excluded.last_rank,
                 last_title=excluded.last_title, last_level=excluded.last_level,
                 last_class=excluded.last_class, last_valor=excluded.last_valor,
                 warning_count=excluded.warning_count, departed_at=excluded.departed_at""",
            (canon, disp_nick, row["true_name"] or "", row["week"],
             row["rank"] or "", row["title"] or "", row["level"],
             row["class_"] or "", row["valor"], row["warning_count"] or 0, now))
        conn.execute(
            """INSERT INTO valor_force_archived (nick_canon, archived_at, archived_by, reason)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(nick_canon) DO UPDATE SET archived_at=excluded.archived_at,
                 archived_by=excluded.archived_by, reason=excluded.reason""",
            (canon, now, by, reason or ""))
        _write_audit(conn, "valor_archive", None, disp_nick, None,
                     {"reason": (reason or "").strip()[:200]}, actor)
    return {"ok": True}


def valor_restore(canon: str, actor: dict, reason: str = "") -> dict:
    """Вернуть человека из архива в основной список (снять ручной кик и убрать
    из departed). Если он есть в текущем снимке — снова появится в списке.
    Причина возврата (пометка) пишется в журнал действий.

    in_snapshot в ответе: True — человек есть на ПОСЛЕДНЕМ скрине (сразу виден в
    таблице, его доблесть уже учтена); False — на последнем скрине его нет, он
    просто возвращён в ростер и появится в таблице, когда попадёт на скрин
    (его доблесть за текущую неделю НЕ учитывается, пока он не на скрине)."""
    with connection() as conn:
        canon = _resolve_canon(canon, _alias_map(conn))
        row = conn.execute(
            "SELECT nick FROM valor_departed WHERE nick_canon = ?", (canon,)
        ).fetchone()
        disp_nick = row["nick"] if row else canon
        conn.execute("DELETE FROM valor_force_archived WHERE nick_canon = ?", (canon,))
        conn.execute("DELETE FROM valor_departed WHERE nick_canon = ?", (canon,))
        # Есть ли человек на последнем скрине (текущий снапшот)?
        _snap = conn.execute(
            "SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
        in_snapshot = bool(_snap and conn.execute(
            "SELECT 1 FROM valor_members WHERE snapshot_id = ? AND nick_canon = ? LIMIT 1",
            (_snap["id"], canon)).fetchone())
        _write_audit(conn, "valor_restore", None, disp_nick,
                     {"reason": (reason or "").strip()[:200]}, None, actor)
    return {"ok": True, "nick": disp_nick, "in_snapshot": in_snapshot}


def valor_return_from_archive(*, game_nick: str, title: str, note: str,
                              accepted_date: str, veteran: bool,
                              elite: bool = False,
                              actor: dict) -> dict:
    """Повторный приём человека, который был в архиве доблести. Одним действием:
      1) регистрируем в реестре (свежая дата → недельный ИММУН новичка);
      2) возвращаем из архива (departed + force_archived);
      3) УБИРАЕМ все предупреждения (норматив + титульные + ручные) — чистый лист.
    """
    game_nick = (game_nick or "").strip()
    if not game_nick:
        return {"ok": False, "error": "bad_nick"}
    # 1) Регистрация — create_acceptance даёт свежий иммун новичка (IMMUNITY_DAYS).
    acc = create_acceptance(game_nick=game_nick, title=(title or ""),
                            accepted_date=accepted_date, note=(note or ""),
                            veteran=bool(veteran), elite=bool(elite), actor=actor)
    canon = _valor_canon(game_nick)
    # 2) Вернуть из архива доблести (снять кик / убрать из «покинули»).
    _rest = valor_restore(canon, actor, reason="повторный приём из архива")
    # 3) Убрать ВСЕ предупреждения (по требованию Лира — чистый лист).
    valor_dismiss_warnings(canon, "norm", actor,
                           reason="возврат из архива — чистый лист")
    valor_dismiss_warnings(canon, "title", actor,
                           reason="возврат из архива — чистый лист")
    with connection() as conn:
        conn.execute("DELETE FROM valor_manual_warnings WHERE nick_canon = ?", (canon,))
    # 4) Отметить «чистый лист»: неделя возврата = ISO-неделя даты приёма. Все
    #    недели ДО неё — прошлая жизнь (недоборы не в счёт, история сохраняется).
    try:
        _ad = date.fromisoformat(accepted_date)
        _y, _w, _ = _ad.isocalendar()
        valor_return_slate_set(game_nick, f"{_y}-W{_w:02d}", actor)
    except Exception:
        pass
    return {"ok": True, "acceptance": acc, "canon": canon,
            "in_snapshot": bool(_rest.get("in_snapshot"))}


def valor_delete_member(member_id: int, actor: dict | None = None) -> dict:
    """Удалить ошибочную строку (фантом OCR) из текущего снимка."""
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM valor_members WHERE id = ?", (member_id,)
        ).fetchone()
        if not row:
            return {"ok": False, "reason": "not_found"}
        cn = row["nick_canon"]
        week = _week_of_member(conn, member_id)
        before = _member_snap(row)
        before["snapshot_week"] = week   # чтобы восстановить в нужную неделю
        conn.execute("DELETE FROM valor_members WHERE id = ?", (member_id,))
        left = conn.execute(
            "SELECT 1 FROM valor_members WHERE nick_canon = ? LIMIT 1", (cn,)
        ).fetchone()
        if not left:
            conn.execute("DELETE FROM valor_first_seen WHERE nick_canon = ?", (cn,))
        _log_valor_edit(conn, week=week, action="delete", member_id=member_id,
                        nick=row["nick"], canon=cn,
                        before=before, after=None, actor=actor or {})
    return {"ok": True}


def valor_move_member(member_id: int, after_id: int | None,
                      actor: dict | None = None) -> dict:
    """Переместить строку в списке: поставить СРАЗУ ПОСЛЕ строки after_id (или в начало,
    если after_id пустой). Меняем только sort_key (дробный индекс между соседями) —
    КАДР участника НЕ трогаем, чтобы подсветка источника на скрине осталась верной.
    Порядок в списке совпадёт с экраном, когда офицер переставит строки как на скрине."""
    with connection() as conn:
        row = conn.execute(
            "SELECT id, snapshot_id, nick, nick_canon FROM valor_members WHERE id = ?",
            (member_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "not_found"}
        if after_id == member_id:
            return {"ok": True}                       # сам после себя — ничего не делаем
        snap_id = row["snapshot_id"]
        ordered = conn.execute(
            "SELECT id, sort_key FROM valor_members WHERE snapshot_id = ? "
            "ORDER BY COALESCE(sort_key, id), id", (snap_id,)).fetchall()
        keyed = [(r["id"], (r["sort_key"] if r["sort_key"] is not None else float(r["id"])))
                 for r in ordered]
        if after_id:
            pos = next((i for i, (rid, _k) in enumerate(keyed) if rid == after_id), None)
            if pos is None:
                return {"ok": False, "reason": "after_not_found"}
            aft_key = keyed[pos][1]
            nxt_key = None
            for rid, k in keyed[pos + 1:]:            # следующий сосед, ПРОПУСКАЯ саму строку
                if rid == member_id:
                    continue
                nxt_key = k
                break
            new_key = (aft_key + nxt_key) / 2.0 if nxt_key is not None else aft_key + 1.0
        else:                                         # в начало списка
            mn = min((k for _rid, k in keyed if _rid != member_id), default=1.0)
            new_key = mn - 1.0
        conn.execute("UPDATE valor_members SET sort_key = ? WHERE id = ?",
                     (new_key, member_id))
        week = _week_of_member(conn, member_id)
        _log_valor_edit(conn, week=week, action="move", member_id=member_id,
                        nick=row["nick"], canon=row["nick_canon"],
                        before=None, after={"after_id": after_id, "sort_key": new_key},
                        actor=actor or {})
    return {"ok": True}


def valor_list_sessions() -> list[dict[str, Any]]:
    """Все снапшоты + пропущенные недели по убыванию — для UI «Архив доблести».
    Реальные снимки: skipped=0. Пропущенные недели (из valor_skipped_weeks) —
    виртуальные записи skipped=1 (без участников), если за неделю реально нет
    собранного снимка."""
    with connection() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM valor_snapshots ORDER BY week DESC")]
        for r in rows:
            r["skipped"] = 0
        existing = {r["week"] for r in rows}
        for s in conn.execute(
                "SELECT week, marked_at FROM valor_skipped_weeks"):
            if s["week"] in existing:
                continue  # неделя реально собрана — метку «не собрано» игнорим
            rows.append({
                "week": s["week"], "skipped": 1,
                "captured_at": s["marked_at"], "valor_norm": None,
                "members_count": 0, "screens_count": 0,
                "actual_members": None, "notes": "не собрано",
            })
        rows.sort(key=lambda x: x["week"], reverse=True)
        return rows


def _valor_week_label(d: date) -> str:
    """Метка недели `YYYY-Www` — 1-в-1 как в десктопе pw-valor-tracker
    (неделя начинается с воскресенья, номер — ISO от этого воскресенья)."""
    days_since_sunday = (d.weekday() + 1) % 7      # Sun→0, Mon→1, ... Sat→6
    sunday = d - timedelta(days=days_since_sunday)
    iso_year, iso_week, _ = sunday.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def _sunday_of(d: date) -> date:
    return d - timedelta(days=(d.weekday() + 1) % 7)


def valor_missing_weeks() -> list[dict]:
    """Недели между первым снимком и текущей, для которых НЕТ снимка вообще
    (не собирали и не помечали). Кандидаты на пометку «не собрано».
    Возвращает [{week, sunday}] от новых к старым."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT week, captured_at FROM valor_snapshots").fetchall()
    if not rows:
        return []
    existing = {r["week"] for r in rows}
    with connection() as conn:
        for s in conn.execute("SELECT week FROM valor_skipped_weeks"):
            existing.add(s["week"])     # уже помеченные не предлагаем снова
    # самая ранняя дата сбора → её воскресенье
    earliest = None
    for r in rows:
        try:
            dt = datetime.fromisoformat(str(r["captured_at"]).replace("Z", "")).date()
        except Exception:
            continue
        if earliest is None or dt < earliest:
            earliest = dt
    if earliest is None:
        return []
    start = _sunday_of(earliest)
    today_sunday = _sunday_of(date.today())
    out, cur = [], start
    while cur <= today_sunday:
        wk = _valor_week_label(cur)
        if wk not in existing:
            out.append({"week": wk, "sunday": cur.isoformat()})
        cur += timedelta(days=7)
    out.reverse()  # новые сверху
    return out


def valor_skip_week(week: str, skipped: bool = True,
                    norm: int | None = None, actor: dict | None = None) -> dict:
    """Пометить неделю как «данные не собирались» (или снять пометку).

    Хранится в ОТДЕЛЬНОЙ таблице valor_skipped_weeks — НЕ трогает valor_snapshots
    (поэтому текущая Доблесть/дельты/статистика не ломаются).
    skipped=True: если за неделю уже есть РЕАЛЬНЫЙ снимок с данными — отказ
      (has_data, нельзя затирать сбор); иначе ставим метку.
    skipped=False: снимаем метку."""
    week = (week or "").strip()
    if not _re.match(r"^\d{4}-W\d{2}$", week):
        return {"ok": False, "reason": "bad_week"}
    now = datetime.utcnow().isoformat(timespec="seconds")
    by = (actor or {}).get("name", "") or (actor or {}).get("nick", "")
    with connection() as conn:
        if skipped:
            snap = conn.execute(
                "SELECT members_count FROM valor_snapshots WHERE week = ?",
                (week,)).fetchone()
            if snap and (snap["members_count"] or 0) > 0:
                return {"ok": False, "reason": "has_data"}
            conn.execute(
                "INSERT OR REPLACE INTO valor_skipped_weeks "
                "(week, marked_at, marked_by) VALUES (?, ?, ?)",
                (week, now, by))
        else:
            conn.execute(
                "DELETE FROM valor_skipped_weeks WHERE week = ?", (week,))
    return {"ok": True, "week": week, "skipped": skipped}


_SNAP_META_FIELDS = ("actual_members", "valor_norm", "notes")


def valor_update_snapshot_meta(week: str, fields: dict, actor: dict | None = None) -> dict:
    """Правка метаданных снимка недели (для «Архива скринов»): реально людей в
    клане (actual_members), норматив, заметки. Меняет только переданные поля."""
    week = (week or "").strip()
    sets, vals = [], []
    for k in ("actual_members", "valor_norm"):
        if k in fields and fields[k] is not None:
            sets.append(f"{k} = ?")
            vals.append(int(fields[k]))
    if "notes" in fields and fields["notes"] is not None:
        sets.append("notes = ?")
        vals.append(str(fields["notes"]))
    if not sets:
        return {"ok": False, "reason": "nothing_to_update"}
    with connection() as conn:
        snap = conn.execute(
            "SELECT * FROM valor_snapshots WHERE week = ?", (week,)).fetchone()
        if not snap:
            return {"ok": False, "reason": "no_snapshot"}
        before = {k: dict(snap).get(k) for k in _SNAP_META_FIELDS}
        conn.execute(
            f"UPDATE valor_snapshots SET {', '.join(sets)} WHERE week = ?",
            (*vals, week))
        after = dict(before)
        for k in ("actual_members", "valor_norm"):
            if k in fields and fields[k] is not None:
                after[k] = int(fields[k])
        if "notes" in fields and fields["notes"] is not None:
            after["notes"] = str(fields["notes"])
        _log_valor_edit(conn, week=week, action="meta", member_id=None,
                        nick="(снимок недели)", canon="",
                        before=before, after=after, actor=actor or {})
    return {"ok": True}


def valor_edit_log_for(week: str) -> list[dict]:
    """Журнал правок недели (новые сверху). Для UI «Журнал правок»."""
    week = (week or "").strip()
    out = []
    with connection() as conn:
        for r in conn.execute(
                "SELECT * FROM valor_edit_log WHERE week = ? ORDER BY id DESC",
                (week,)):
            d = dict(r)
            for k in ("before_json", "after_json"):
                try:
                    d[k[:-5]] = json.loads(d[k]) if d[k] else None
                except Exception:
                    d[k[:-5]] = None
            d.pop("before_json", None); d.pop("after_json", None)
            d["undone"] = bool(d.get("undone"))
            out.append(d)
    return out


def valor_edit_log_actors(week: str) -> list[dict]:
    """Кто и сколько НЕотменённых правок сделал за неделю (для выбора человека)."""
    week = (week or "").strip()
    with connection() as conn:
        return [{"actor_name": r["actor_name"], "count": r["c"]} for r in conn.execute(
            "SELECT actor_name, COUNT(*) AS c FROM valor_edit_log "
            "WHERE week = ? AND undone = 0 GROUP BY actor_name ORDER BY c DESC",
            (week,))]


def _undo_one(conn, entry, by: str) -> bool:
    """Отменить одно действие журнала (внутри транзакции). Возвращает True
    если что-то изменилось. Сам по себе НЕ пишет новых записей в журнал."""
    if entry["undone"]:
        return False
    action = entry["action"]
    before = entry["before"]
    mid = entry["member_id"]
    ok = False
    if action in ("edit", "verify") and before:
        cols = [c for c in _MEMBER_LOG_FIELDS if c in before]
        if cols:
            sets = ", ".join(f"{c} = ?" for c in cols)
            vals = [before[c] for c in cols]
            cur = None
            if mid:
                cur = conn.execute(
                    f"UPDATE valor_members SET {sets} WHERE id = ?", (*vals, mid))
            # Фолбэк: строку могли удалить+восстановить (новый id) — ищем по
            # canon в снимке этой недели.
            if (not cur or not cur.rowcount) and before.get("nick_canon"):
                snap = conn.execute(
                    "SELECT id FROM valor_snapshots WHERE week = ?",
                    (entry["week"],)).fetchone()
                if snap:
                    cur = conn.execute(
                        f"UPDATE valor_members SET {sets} "
                        "WHERE snapshot_id = ? AND nick_canon = ?",
                        (*vals, snap["id"], before["nick_canon"]))
            ok = bool(cur and cur.rowcount)
    elif action == "add" and mid:
        cur = conn.execute("DELETE FROM valor_members WHERE id = ?", (mid,))
        ok = bool(cur.rowcount)
    elif action == "delete" and before:
        sw = before.get("snapshot_week") or entry["week"]
        snap = conn.execute(
            "SELECT id FROM valor_snapshots WHERE week = ?", (sw,)).fetchone()
        if snap:
            cols = [c for c in _MEMBER_LOG_FIELDS if c in before]
            collist = ", ".join(["snapshot_id"] + cols)
            ph = ", ".join(["?"] * (len(cols) + 1))
            vals = [snap["id"]] + [before[c] for c in cols]
            conn.execute(
                f"INSERT INTO valor_members ({collist}) VALUES ({ph})", vals)
            ok = True
    elif action == "meta" and before:
        sets, vals = [], []
        for k in _SNAP_META_FIELDS:
            if k in before:
                sets.append(f"{k} = ?"); vals.append(before[k])
        if sets:
            cur = conn.execute(
                f"UPDATE valor_snapshots SET {', '.join(sets)} WHERE week = ?",
                (*vals, entry["week"]))
            ok = bool(cur.rowcount)
    # помечаем запись отменённой в любом случае (действие обработано)
    conn.execute(
        "UPDATE valor_edit_log SET undone = 1, undone_at = ?, undone_by = ? "
        "WHERE id = ?",
        (datetime.utcnow().isoformat(timespec="seconds"), by, entry["id"]))
    return ok


def _load_log_entry(conn, log_id: int):
    r = conn.execute("SELECT * FROM valor_edit_log WHERE id = ?", (log_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    try:
        d["before"] = json.loads(d["before_json"]) if d["before_json"] else None
    except Exception:
        d["before"] = None
    d["undone"] = bool(d["undone"])
    return d


def valor_undo_edit(log_id: int, actor: dict) -> dict:
    """Отменить одно действие журнала (только админ — гейт на уровне API)."""
    by = (actor.get("name") or actor.get("role") or "") if actor else ""
    with connection() as conn:
        entry = _load_log_entry(conn, log_id)
        if not entry:
            return {"ok": False, "reason": "not_found"}
        if entry["undone"]:
            return {"ok": False, "reason": "already_undone"}
        changed = _undo_one(conn, entry, by)
    return {"ok": True, "changed": changed}


def valor_undo_by_actor(week: str, actor_name: str, actor: dict) -> dict:
    """Отменить ВСЕ неотменённые действия одного человека за неделю
    (в обратном порядке — сначала самые поздние)."""
    week = (week or "").strip()
    by = (actor.get("name") or actor.get("role") or "") if actor else ""
    undone = 0
    with connection() as conn:
        rows = conn.execute(
            "SELECT id FROM valor_edit_log WHERE week = ? AND actor_name = ? "
            "AND undone = 0 ORDER BY id DESC", (week, actor_name)).fetchall()
        for r in rows:
            entry = _load_log_entry(conn, r["id"])
            if entry and not entry["undone"]:
                _undo_one(conn, entry, by)
                undone += 1
    return {"ok": True, "undone": undone}


def valor_get_history(nick: str, field: str | None = None) -> dict[str, Any]:
    """История по полям для одного ника. Если field — только для этого
    поля. Иначе — словарь {field: [{week, value, captured_at}, ...]}."""
    canon = _valor_canon(nick)
    if not canon:
        return {}
    if field and field not in _HIST_FIELDS:
        raise ValueError(f"unknown field: {field!r}")
    # Возвращенец из архива: неделя «чистого листа» — недели ДО неё помечаем
    # pre_return (для синей штриховки + пометки «с чистого листа» в разворот).
    _slate = valor_return_slate_map().get(canon)
    _slate_wk = _slate["slate_week"] if _slate else None
    _returned = ({"week": _slate["slate_week"], "at": _slate["returned_at"]}
                 if _slate else None)
    with connection() as conn:
        if field == "valor":
            # Обогащаем историю доблести нормой/АФК/выполнением той недели —
            # чтобы попап показывал не только «сколько набрал», но и «попал ли
            # в норматив» (цвет строки) и не путал 0 в АФК с провалом.
            rows = conn.execute(
                """SELECT vh.week AS week, vh.value AS value,
                          vh.captured_at AS captured_at,
                          vs.valor_norm AS norm,
                          vm.is_afk AS is_afk, vm.norm_met AS norm_met
                   FROM valor_history vh
                   LEFT JOIN valor_snapshots vs ON vs.week = vh.week
                   LEFT JOIN valor_members vm
                          ON vm.snapshot_id = vs.id
                         AND vm.nick_canon = vh.nick_canon
                   WHERE vh.nick_canon = ? AND vh.field = 'valor'
                   ORDER BY vh.week DESC""",
                (canon,),
            ).fetchall()
            out_rows = []
            for r in rows:
                d = dict(r)
                d["pre_return"] = 1 if (_slate_wk and d["week"] < _slate_wk) else 0
                out_rows.append(d)
            return {"valor": out_rows, "returned": _returned}
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

        # Суммарная доблесть ВСЕГО клана по каждой неделе (для линии «Сумма
        # по клану» на графике + это и есть запись истории по неделям).
        week_totals = [sum(s["counts"][i] for s in series)
                       for i in range(len(periods))]
        overall = {
            "total":  sum(s["total"] for s in series),
            "people": len(series),
            "week_totals": week_totals,
        }
        return {
            "periods": periods,
            "series":  series,
            "overall": overall,
        }


# ════════════════════════════════════════════════════════════════════════
# «Тайная комната» → «Курсы волшебства» (трекер обучения, admin-only)
# Порт десктопного Learning Tracker: курсы с плановыми часами, прогресс
# просмотра, дневная норма, расчёт темпа и прогноза завершения.
# ════════════════════════════════════════════════════════════════════════

from datetime import timezone as _timezone

_MSK_TZ = _timezone(timedelta(hours=3))
_CHAMBER_SEED = Path(__file__).parent / "chamber_courses.json"


def _msk_today() -> date:
    return datetime.now(_MSK_TZ).date()


def magic_seed_courses(conn: sqlite3.Connection | None = None) -> int:
    """Сидирование/обновление метаданных курсов из chamber_courses.json.
    Прогресс (magic_progress) НЕ трогается — апсертим только метаданные."""
    if not _CHAMBER_SEED.exists():
        return 0
    try:
        seed = json.loads(_CHAMBER_SEED.read_text(encoding="utf-8"))
    except Exception:
        return 0

    def _do(c):
        n = 0
        for course in seed:
            c.execute(
                """INSERT INTO magic_courses
                   (id, phase_id, phase_name, category, name, type, alt_for,
                    hours, why, sort)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     phase_id=excluded.phase_id, phase_name=excluded.phase_name,
                     category=excluded.category, name=excluded.name,
                     type=excluded.type, alt_for=excluded.alt_for,
                     hours=excluded.hours, why=excluded.why, sort=excluded.sort""",
                (course["id"], course.get("phase_id", 0),
                 course.get("phase_name", ""), course.get("category", ""),
                 course.get("name", ""), course.get("type", "must"),
                 course.get("alt_for"), float(course.get("hours") or 0),
                 course.get("why", ""), course.get("sort", 0)),
            )
            n += 1
        return n

    if conn is not None:
        return _do(conn)
    with connection() as c:
        return _do(c)


def _magic_dur_h(row) -> float:
    """Длительность курса в часах: реальная (duration_sec) или плановая (hours)."""
    dsec = row["duration_sec"] if "duration_sec" in row.keys() else None
    if dsec:
        return dsec / 3600.0
    return float(row["hours"] or 0)


def magic_get_state() -> dict[str, Any]:
    """Полное состояние трекера: курсы + прогресс + посуточный журнал +
    настройки + расчётная статистика (часы/дни/темп/прогноз)."""
    with connection() as conn:
        courses = conn.execute(
            "SELECT * FROM magic_courses ORDER BY sort, id").fetchall()
        prog = {r["course_id"]: r for r in conn.execute(
            "SELECT * FROM magic_progress").fetchall()}
        st = conn.execute("SELECT * FROM magic_settings WHERE id=1").fetchone()
        daily = conn.execute(
            "SELECT day, watched_sec FROM magic_daily ORDER BY day").fetchall()

    daily_target = float(st["daily_target_h"]) if st else 4.0
    start_date_set = st["start_date"] if st else None

    out_courses = []
    phases: dict[int, dict] = {}
    total_h = done_h = 0.0
    done_courses = 0
    for row in courses:
        dur_h = _magic_dur_h(row)
        p = prog.get(row["id"])
        watched_sec = p["watched_sec"] if p else 0
        completed = bool(p["completed"]) if p else False
        watched_h = dur_h if completed else min(watched_sec / 3600.0, dur_h)
        pct = (watched_h / dur_h * 100.0) if dur_h else (100.0 if completed else 0.0)
        is_done = completed or (dur_h and watched_h >= dur_h * 0.99)
        total_h += dur_h
        done_h += watched_h
        if is_done:
            done_courses += 1

        out_courses.append({
            "id": row["id"], "phase_id": row["phase_id"],
            "phase_name": row["phase_name"], "category": row["category"],
            "name": row["name"], "type": row["type"], "alt_for": row["alt_for"],
            "hours": float(row["hours"] or 0), "why": row["why"],
            "duration_sec": row["duration_sec"] if "duration_sec" in row.keys() else None,
            "vk_owner_id": row["vk_owner_id"] if "vk_owner_id" in row.keys() else None,
            "vk_video_id": row["vk_video_id"] if "vk_video_id" in row.keys() else None,
            "watched_sec": watched_sec, "completed": completed,
            "watched_h": round(watched_h, 3), "dur_h": round(dur_h, 3),
            "pct": round(pct, 1), "done": is_done,
        })
        ph = phases.setdefault(row["phase_id"], {
            "id": row["phase_id"], "name": row["phase_name"],
            "total_h": 0.0, "done_h": 0.0, "total": 0, "done": 0})
        ph["total_h"] += dur_h
        ph["done_h"] += watched_h
        ph["total"] += 1
        ph["done"] += 1 if is_done else 0

    for ph in phases.values():
        ph["pct"] = round(ph["done_h"] / ph["total_h"] * 100.0, 1) if ph["total_h"] else 0.0
        ph["total_h"] = round(ph["total_h"], 1)
        ph["done_h"] = round(ph["done_h"], 1)

    # ── Расчёты темпа и прогноза ──
    today = _msk_today()
    days = [{"day": r["day"], "watched_h": round(r["watched_sec"] / 3600.0, 2)}
            for r in daily]
    if start_date_set:
        try:
            start = date.fromisoformat(start_date_set)
        except ValueError:
            start = date.fromisoformat(daily[0]["day"]) if daily else today
    elif daily:
        start = date.fromisoformat(daily[0]["day"])
    else:
        start = today
    days_elapsed = max(1, (today - start).days + 1)

    remaining_h = max(0.0, total_h - done_h)
    pct = (done_h / total_h * 100.0) if total_h else 0.0
    actual_pace = done_h / days_elapsed  # ч/день в среднем с начала
    today_watched_h = next(
        (d["watched_h"] for d in days if d["day"] == today.isoformat()), 0.0)

    days_left_plan = math.ceil(remaining_h / daily_target) if daily_target > 0 else None
    finish_plan = (today + timedelta(days=days_left_plan)).isoformat() \
        if days_left_plan is not None else None
    if actual_pace > 0.01 and remaining_h > 0:
        days_left_actual = math.ceil(remaining_h / actual_pace)
        finish_actual = (today + timedelta(days=days_left_actual)).isoformat()
    elif remaining_h <= 0:
        days_left_actual, finish_actual = 0, today.isoformat()
    else:
        days_left_actual, finish_actual = None, None
    ahead_days = (days_left_plan - days_left_actual) \
        if (days_left_plan is not None and days_left_actual is not None) else None

    stats = {
        "total_h": round(total_h, 1), "done_h": round(done_h, 1),
        "remaining_h": round(remaining_h, 1), "pct": round(pct, 1),
        "total_courses": len(out_courses), "done_courses": done_courses,
        "daily_target_h": round(daily_target, 2),
        "today": today.isoformat(), "start_date": start.isoformat(),
        "days_elapsed": days_elapsed,
        "actual_pace_h": round(actual_pace, 2),
        "today_watched_h": round(today_watched_h, 2),
        "on_track": actual_pace >= daily_target,
        "days_left_plan": days_left_plan, "finish_plan": finish_plan,
        "days_left_actual": days_left_actual, "finish_actual": finish_actual,
        "ahead_days": ahead_days,
        # перевод часов в дни/месяцы как в Learning Tracker (4ч/день, 80ч/мес)
        "done_days": round(done_h / 4.0, 1), "total_days": round(total_h / 4.0, 1),
        "done_months": round(done_h / 80.0, 2), "total_months": round(total_h / 80.0, 2),
    }

    return {
        "courses": out_courses,
        "phases": sorted(phases.values(), key=lambda p: p["id"]),
        "settings": {"daily_target_h": round(daily_target, 2),
                     "start_date": start.isoformat()},
        "stats": stats,
        "daily": days[-60:],
    }


def _magic_bump_daily(conn: sqlite3.Connection, delta_sec: int) -> None:
    if delta_sec <= 0:
        return
    day = _msk_today().isoformat()
    conn.execute(
        """INSERT INTO magic_daily (day, watched_sec) VALUES (?, ?)
           ON CONFLICT(day) DO UPDATE SET watched_sec = watched_sec + ?""",
        (day, delta_sec, delta_sec))


def magic_set_progress(course_id: str, *, watched_sec: int | None = None,
                       completed: bool | None = None) -> None:
    """Установить абсолютный прогресс курса. Прирост watched_sec идёт в
    посуточный журнал для расчёта темпа."""
    now = datetime.now(_MSK_TZ).isoformat(timespec="seconds")
    with connection() as conn:
        cur = conn.execute(
            "SELECT watched_sec, completed FROM magic_progress WHERE course_id=?",
            (course_id,)).fetchone()
        old_w = cur["watched_sec"] if cur else 0
        old_c = bool(cur["completed"]) if cur else False
        new_w = old_w if watched_sec is None else max(0, int(watched_sec))
        new_c = old_c if completed is None else bool(completed)
        conn.execute(
            """INSERT INTO magic_progress (course_id, watched_sec, completed, updated_at)
               VALUES (?,?,?,?)
               ON CONFLICT(course_id) DO UPDATE SET
                 watched_sec=excluded.watched_sec, completed=excluded.completed,
                 updated_at=excluded.updated_at""",
            (course_id, new_w, 1 if new_c else 0, now))
        if new_w > old_w:
            _magic_bump_daily(conn, new_w - old_w)


def magic_add_watch(course_id: str, delta_sec: int) -> None:
    """Инкремент просмотренного времени (для heartbeat встроенного плеера VK)."""
    delta_sec = int(delta_sec)
    if delta_sec <= 0:
        return
    now = datetime.now(_MSK_TZ).isoformat(timespec="seconds")
    with connection() as conn:
        conn.execute(
            """INSERT INTO magic_progress (course_id, watched_sec, completed, updated_at)
               VALUES (?,?,0,?)
               ON CONFLICT(course_id) DO UPDATE SET
                 watched_sec = watched_sec + ?, updated_at = excluded.updated_at""",
            (course_id, delta_sec, now, delta_sec))
        _magic_bump_daily(conn, delta_sec)


def magic_set_settings(*, daily_target_h: float | None = None,
                       start_date: str | None = None) -> None:
    with connection() as conn:
        if daily_target_h is not None:
            conn.execute("UPDATE magic_settings SET daily_target_h=? WHERE id=1",
                         (max(0.1, float(daily_target_h)),))
        if start_date is not None:
            sd = start_date or None
            if sd:
                date.fromisoformat(sd)  # валидация
            conn.execute("UPDATE magic_settings SET start_date=? WHERE id=1", (sd,))


def magic_reset(course_id: str | None = None) -> None:
    """Сбросить прогресс одного курса или всего (course_id=None)."""
    with connection() as conn:
        if course_id:
            conn.execute("DELETE FROM magic_progress WHERE course_id=?", (course_id,))
        else:
            conn.execute("DELETE FROM magic_progress")
            conn.execute("DELETE FROM magic_daily")
