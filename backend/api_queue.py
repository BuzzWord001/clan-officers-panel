"""Раздел «Очередь за ресурсами с КХ» — ИЗОЛИРОВАННЫЙ модуль.

Своя авторизация (личный пароль игрока + запоминание устройства), НЕ трогает
офицерскую сессию. Свои таблицы queue_*. Полная спека — docs/QUEUE_PROJECT.md.

Фаза 1 (этот файл на старте): вход в раздел.
  - GET  /queue/nick-suggest?q=   — автоподсказки ников из реестра + Доблести (+ мэйн/твин)
  - POST /queue/check-nick        — проверить ник, вернуть мэйна и есть ли уже аккаунт
  - POST /queue/register          — ник + общий пароль + почта + личный пароль → аккаунт
  - POST /queue/login             — ник + личный пароль
  - GET  /queue/me                — кто я (по device-куке)
  - POST /queue/logout
  - POST /queue/admin/shared-password  — админ задаёт ОБЩИЙ пароль (из игры, кнопка G)
  - GET  /queue/admin/shared-password  — задан ли общий пароль (для админки)
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

import db
import distribution
import bot_tg
import bot_vk
import auth_pwd
from config import settings
from session import require_admin, current_session, set_session
from api_chat import require_bot_token   # bot-token auth (десктоп PW Анализ доблести)

log = logging.getLogger("officers.queue")


def require_officer_or_admin(request: Request) -> dict:
    """Офицер ИЛИ админ — для функций, доступных офицерам (связки супругов)."""
    s = current_session(request)
    if s["role"] not in ("officer", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "officer_only")
    return s

router = APIRouter(prefix="/queue", tags=["queue"])

# загруженные админом модели (персональные/классовые) — на томе /data, переживают редеплой
_UPLOAD_DIR = Path(settings.db_path).parent / "queue_models"
_SAFE_KEY = re.compile(r"[^\w\-]", re.U)
_IMG_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
def _safe_key(k: str) -> str:
    return _SAFE_KEY.sub("_", (k or "").strip())[:80]

COOKIE = "queue_device"
COOKIE_MAX_AGE = 180 * 24 * 3600           # «оставаться в системе» ~полгода
_MAIN_RE = re.compile(r"^~(.+)~$")          # титул ~Мэйн~ → это твин, мэйн внутри


# ─────────────────────────── утилиты ───────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")


def _check(pw: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("ascii"))
    except Exception:
        return False


def ensure_queue_tables() -> None:
    with db.connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS queue_config (
              id                   INTEGER PRIMARY KEY CHECK (id = 1),
              shared_password_hash TEXT NOT NULL DEFAULT '',
              updated_at           TEXT NOT NULL DEFAULT ''
            );
            INSERT OR IGNORE INTO queue_config (id, shared_password_hash) VALUES (1, '');

            CREATE TABLE IF NOT EXISTS queue_accounts (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              main_canon    TEXT NOT NULL UNIQUE,      -- аккаунт привязан к МЭЙНУ
              main_nick     TEXT NOT NULL DEFAULT '',  -- отображаемый ник мэйна
              reg_nick      TEXT NOT NULL DEFAULT '',  -- ник, которым регистрировались
              email         TEXT NOT NULL DEFAULT '',
              password_hash TEXT NOT NULL DEFAULT '',
              created_at    TEXT NOT NULL DEFAULT '',
              last_login_at TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_devices (
              token        TEXT PRIMARY KEY,
              account_id   INTEGER NOT NULL,
              created_at   TEXT NOT NULL DEFAULT '',
              last_seen_at TEXT NOT NULL DEFAULT '',
              ip           TEXT NOT NULL DEFAULT '',
              user_agent   TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_entries (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              queue      INTEGER NOT NULL,          -- 0 обычные, 1 редкие(R), 2 легендарные(S)
              pos        REAL    NOT NULL,          -- порядок (дробный — для вставки между)
              main_canon TEXT    NOT NULL DEFAULT '',
              nick       TEXT    NOT NULL,          -- отображаемый ник (мэйн/твин, которым встал)
              cls        TEXT    NOT NULL DEFAULT '',
              resource   TEXT    NOT NULL DEFAULT '',   -- выбранный ресурс (ключ item)
              added_by   TEXT    NOT NULL DEFAULT '',   -- 'self' или 'admin:<имя>'
              added_at   TEXT    NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_log (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              at         TEXT NOT NULL,
              kind       TEXT NOT NULL,             -- register|login|join|leave|admin_add|admin_remove|admin_move|admin_clear
              actor      TEXT NOT NULL DEFAULT '',
              nick       TEXT NOT NULL DEFAULT '',
              queue      INTEGER,
              ip         TEXT NOT NULL DEFAULT '',
              user_agent TEXT NOT NULL DEFAULT '',
              detail     TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_models (
              model_key  TEXT PRIMARY KEY,          -- 'class/Воин(м).png' | 'personal/Карася.png'
              flip       INTEGER NOT NULL DEFAULT 0, -- 1 = отзеркалить по горизонтали
              rotate     INTEGER NOT NULL DEFAULT 0, -- градусы
              scale      REAL    NOT NULL DEFAULT 1, -- индивидуальный размер модели
              updated_at TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_gender (
              canon      TEXT PRIMARY KEY,           -- канон ника/мэйна
              gender     TEXT NOT NULL DEFAULT '',   -- 'm' | 'f'
              updated_at TEXT NOT NULL DEFAULT ''
            );

            -- РУЧНОЙ КЛАСС (админ задал класс тем, кто есть только в реестре и чей
            -- класс ещё неизвестен — доблесть его не знает). Переопределяет cls в _people.
            CREATE TABLE IF NOT EXISTS queue_class (
              canon      TEXT PRIMARY KEY,
              cls        TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT ''
            );

            -- Предпочтение модели: 1 = использовать ОБЩУЮ классовую модель вместо
            -- персональной (у кого есть персональная и он хочет переключиться на классовую).
            CREATE TABLE IF NOT EXISTS queue_model_pref (
              canon        TEXT PRIMARY KEY,          -- канон мэйна
              prefer_class INTEGER NOT NULL DEFAULT 0,
              updated_at   TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_placements (
              key        TEXT PRIMARY KEY,           -- 'item:kamen-doblesti' | 'mount'
              x          REAL NOT NULL DEFAULT 0,    -- % сцены
              y          REAL NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_kv (
              key        TEXT PRIMARY KEY,           -- 'path:0' (JSON точек) | 'size:frame|char|item|mount|inset'
              val        TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_spouses (
              canon      TEXT PRIMARY KEY,           -- канон мэйна человека
              recipient  TEXT NOT NULL DEFAULT '',   -- ник супруга/твина по умолчанию (кому передавать)
              updated_by TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT ''
            );

            -- Ручные ТВИНЫ: офицер/админ вручную связывает ник-твин с его настоящим мэйном
            -- (когда авто-определение по титулу ~Мэйн~ не сработало / титул неверный).
            CREATE TABLE IF NOT EXISTS queue_twins (
              canon      TEXT PRIMARY KEY,           -- канон ника-твина
              main_canon TEXT NOT NULL DEFAULT '',   -- канон МЭЙНА, к которому он привязан
              main_nick  TEXT NOT NULL DEFAULT '',   -- отображаемый ник мэйна (для показа)
              twin_nick  TEXT NOT NULL DEFAULT '',   -- отображаемый ник твина (для показа)
              updated_by TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT ''
            );

            -- Ручные ники (админ подтверждает вручную) — для НОВЫХ людей, которых ещё нет
            -- в ростере доблести, ИЛИ чей ник сворачивается в тот же canon, что у другого
            -- человека (гомоглифы: HARDKISS латиница ≠ НаRDKisS кириллица, но оба → hardkiss).
            -- raw = регистро-НЕ-чувствительный, но СКРИПТО-чувствительный ключ (без свёртки
            -- гомоглифов) — по нему различаем таких людей. canon = уникальный identity очереди.
            CREATE TABLE IF NOT EXISTS queue_manual_nicks (
              canon      TEXT PRIMARY KEY,           -- уникальный identity (raw или raw~N при коллизии)
              raw        TEXT NOT NULL DEFAULT '',   -- скрипто-чувствительный ключ для сопоставления ввода
              nick       TEXT NOT NULL DEFAULT '',   -- отображаемый ник (точное написание)
              cls        TEXT NOT NULL DEFAULT '',   -- класс (необязательно)
              title      TEXT NOT NULL DEFAULT '',   -- имя/титул (необязательно, для различия)
              gender     TEXT NOT NULL DEFAULT '',   -- m|f|'' (для модели по умолчанию)
              added_by   TEXT NOT NULL DEFAULT '',
              added_at   TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_manual_raw ON queue_manual_nicks(raw);

            -- Принудительно ОБЫЧНЫЕ игроки: канон здесь НИКОГДА не считается офицером,
            -- даже если он есть в офиц.чате или фаззи-похож на офицера. Лечит ложные
            -- срабатывания (напр. игрок в офиц.чате, но не офицер → просило офиц.пароль).
            CREATE TABLE IF NOT EXISTS queue_officer_exclude (
              canon     TEXT PRIMARY KEY,
              nick      TEXT NOT NULL DEFAULT '',
              added_by  TEXT NOT NULL DEFAULT '',
              added_at  TEXT NOT NULL DEFAULT ''
            );

            -- РОЛИ (ручное регулирование офицерства). mode:
            --   'force_officer' — ЗАКРЕПЛЁН офицером (не снимать, даже если нет в чатах);
            --   'force_regular' — ЗАКРЕПЛЁН обычным игроком (никогда не офицер).
            -- Нет строки → 'auto' (следует авто-определению из офиц.чатов/тегов).
            -- Эффективные офицеры = (авто ∪ force_officer) − force_regular.
            CREATE TABLE IF NOT EXISTS queue_officer_roles (
              canon      TEXT PRIMARY KEY,
              nick       TEXT NOT NULL DEFAULT '',
              mode       TEXT NOT NULL DEFAULT '',
              updated_by TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT ''
            );
            -- миграция прежних исключений (force_regular) в единую таблицу ролей
            INSERT OR IGNORE INTO queue_officer_roles (canon, nick, mode, updated_by, updated_at)
              SELECT canon, nick, 'force_regular', added_by, added_at FROM queue_officer_exclude;

            -- Запросы игроков на ПОДТВЕРЖДЕНИЕ связи (твин/супруг) офицерами. Игрок хочет
            -- передать ресурс тому, кого система ещё не знает как связь → создаёт запрос;
            -- офицер/админ подтверждает как твина/супруга или отклоняет.
            CREATE TABLE IF NOT EXISTS queue_link_requests (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              from_canon   TEXT NOT NULL DEFAULT '',   -- кто просит (отправитель ресурса)
              from_nick    TEXT NOT NULL DEFAULT '',
              target_canon TEXT NOT NULL DEFAULT '',   -- кому хочет передать
              target_nick  TEXT NOT NULL DEFAULT '',
              status       TEXT NOT NULL DEFAULT 'pending',  -- pending|twin|spouse|rejected
              decided_by   TEXT NOT NULL DEFAULT '',   -- ник офицера/админа, кто решил
              decided_at   TEXT NOT NULL DEFAULT '',
              created_at   TEXT NOT NULL DEFAULT ''
            );

            -- Клики залогиненного игрока по ссылке чата клана (VK/TG) на сайте — для
            -- авто-регистрации в чате: бот на заходе новичка спрашивает сайт, кто ЖДАЛ
            -- захода (кликал ссылку в последние N секунд), и регистрирует его под игровым ником.
            CREATE TABLE IF NOT EXISTS queue_chat_link_click (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              canon       TEXT NOT NULL DEFAULT '',   -- канон мэйна игрока (кто кликнул)
              nick        TEXT NOT NULL DEFAULT '',   -- игровой ник игрока
              platform    TEXT NOT NULL DEFAULT '',   -- 'vk' | 'tg'
              clicked_at  TEXT NOT NULL DEFAULT '',   -- ISO UTC момента клика
              ip          TEXT NOT NULL DEFAULT '',
              matched     INTEGER NOT NULL DEFAULT 0, -- 1 когда сопоставлен с заходом
              matched_at  TEXT NOT NULL DEFAULT '',
              match_pid   TEXT NOT NULL DEFAULT '',   -- platform-id зашедшего
              match_name  TEXT NOT NULL DEFAULT ''    -- отображаемое имя зашедшего
            );
            CREATE INDEX IF NOT EXISTS idx_clkclick ON queue_chat_link_click(platform, matched, clicked_at);

            -- Запросы игроков на ПОДТВЕРЖДЕНИЕ новой ПЕРСОНАЛЬНОЙ модельки офицером/админом.
            -- Картинка складывается на том как 'mreq-<id>', при одобрении переносится в слот игрока.
            CREATE TABLE IF NOT EXISTS queue_model_requests (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              main_canon  TEXT NOT NULL DEFAULT '',    -- чей мэйн-аккаунт (кому модель)
              nick        TEXT NOT NULL DEFAULT '',    -- отображаемый ник просителя
              img_key     TEXT NOT NULL DEFAULT '',    -- временный ключ картинки на томе (mreq-<id>)
              status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
              decided_by  TEXT NOT NULL DEFAULT '',
              decided_at  TEXT NOT NULL DEFAULT '',
              created_at  TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS queue_reports (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at TEXT NOT NULL,              -- когда финализировали неделю (ISO)
              stages     INTEGER NOT NULL DEFAULT 0, -- сколько этапов КХ было закрыто
              report     TEXT NOT NULL DEFAULT '',   -- JSON полного отчёта распределения
              channels   TEXT NOT NULL DEFAULT '',   -- JSON: куда ушёл (tg/vk/test)
              summary    TEXT NOT NULL DEFAULT '',   -- краткая строка (групп N, роздано, остаток)
              actor      TEXT NOT NULL DEFAULT ''
            );

            -- Суперспособность топ-3: накапливаемые жетоны «взять обычный ресурс вне очереди».
            -- Топ-3 на 16:00 вс получают +1 жетон каждый при финализации; тратятся на след. неделе.
            CREATE TABLE IF NOT EXISTS queue_privileges (
              canon      TEXT PRIMARY KEY,           -- канон мэйна
              nick       TEXT NOT NULL DEFAULT '',
              tokens     INTEGER NOT NULL DEFAULT 0, -- сколько внеочередных захватов накоплено
              updated_at TEXT NOT NULL DEFAULT ''
            );

            -- Маркер: за какую неделю доблести жетоны ТОП-3 уже начислены.
            -- Идемпотентность: и валор-«Готово», и финализация очереди зовут одну
            -- функцию — начислит ТОЛЬКО первый, повторные вызовы — no-op (без двойных жетонов).
            CREATE TABLE IF NOT EXISTS valor_top3_grant (
              week       TEXT PRIMARY KEY,
              granted_at TEXT NOT NULL DEFAULT '',
              nicks      TEXT NOT NULL DEFAULT ''
            );

            -- Внеочередные захваты ТЕКУЩЕЙ недели (вычитаются из пула, чистятся при финализации).
            CREATE TABLE IF NOT EXISTS queue_priv_claims (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              canon      TEXT NOT NULL DEFAULT '',
              nick       TEXT NOT NULL DEFAULT '',
              resource   TEXT NOT NULL DEFAULT '',   -- ключ обычного ресурса
              amount     INTEGER NOT NULL DEFAULT 0, -- сколько штук взято
              created_at TEXT NOT NULL DEFAULT ''
            );
            -- Персональные уведомления игроку (напр. «не хватило доблести за ресурс»).
            -- Показываются при следующем входе в раздел, потом помечаются seen.
            CREATE TABLE IF NOT EXISTS queue_notices (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              canon      TEXT NOT NULL DEFAULT '',    -- МЭЙН-канон получателя
              kind       TEXT NOT NULL DEFAULT '',    -- 'low_valor' и т.п.
              payload    TEXT NOT NULL DEFAULT '',    -- JSON деталей
              created_at TEXT NOT NULL DEFAULT '',
              seen       INTEGER NOT NULL DEFAULT 0
            );

            -- Снимок «получивших ресурс» на ПОСЛЕДНЕЙ финализации (вс 00:00). Нужен,
            -- чтобы вернуть человека в очередь, если офицер отметил «не забрал» уже
            -- ПОСЛЕ сдвига (когда запись из очереди уже удалена). Перезаписывается каждый advance.
            CREATE TABLE IF NOT EXISTS queue_served_last (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              queue      INTEGER NOT NULL,
              orig_pos   REAL    NOT NULL,            -- позиция ДО сдвига (куда вернуть)
              main_canon TEXT    NOT NULL DEFAULT '',
              nick       TEXT    NOT NULL,
              cls        TEXT    NOT NULL DEFAULT '',
              resource   TEXT    NOT NULL DEFAULT '',
              recipient  TEXT    NOT NULL DEFAULT '',
              auto_repeat INTEGER NOT NULL DEFAULT 0,
              auto_plan  TEXT    NOT NULL DEFAULT '',
              added_by   TEXT    NOT NULL DEFAULT '',
              served_at  TEXT    NOT NULL DEFAULT ''
            );

            -- Ушедшие из клана, УДАЛЁННЫЕ из очереди авто-сверкой с актуальным ростером.
            -- Запоминаем ВСЁ для точного восстановления места, если человек вернётся:
            -- очередь, позицию (orig_pos), ресурс(ы), получателя, привилегию, и ПОСЛЕ КОГО
            -- он стоял (after_nick — человекочитаемо). restored_at != '' → уже возвращён.
            CREATE TABLE IF NOT EXISTS queue_departed (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              queue        INTEGER NOT NULL,
              orig_pos     REAL    NOT NULL,
              main_canon   TEXT    NOT NULL DEFAULT '',
              nick         TEXT    NOT NULL DEFAULT '',
              cls          TEXT    NOT NULL DEFAULT '',
              resource     TEXT    NOT NULL DEFAULT '',
              resources    TEXT    NOT NULL DEFAULT '',
              recipient    TEXT    NOT NULL DEFAULT '',
              privileged   INTEGER NOT NULL DEFAULT 0,
              priv_stacks  INTEGER NOT NULL DEFAULT 0,
              auto_repeat  INTEGER NOT NULL DEFAULT 0,
              auto_plan    TEXT    NOT NULL DEFAULT '',
              after_nick   TEXT    NOT NULL DEFAULT '',   -- после кого стоял (предыдущий по pos)
              after_canon  TEXT    NOT NULL DEFAULT '',
              removed_at   TEXT    NOT NULL DEFAULT '',
              reason       TEXT    NOT NULL DEFAULT 'left_clan',
              restored_at  TEXT    NOT NULL DEFAULT ''
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queue_notices_canon ON queue_notices(canon, seen)")
        # миграция для существующих БД: индивидуальный размер модели
        try:
            conn.execute("ALTER TABLE queue_models ADD COLUMN scale REAL NOT NULL DEFAULT 1")
        except Exception:
            pass
        # миграция: выбранный ресурс у записи очереди
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN resource TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: получатель (кому передать рес — твин/супруг)
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN recipient TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: авто-повтор (вставать за тем же ресурсом каждую неделю)
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN auto_repeat INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: план на будущие недели (JSON-список ключей ресурсов по порядку)
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN auto_plan TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: МУЛЬТИ-выбор ресурсов (JSON-список) для обычной/редкой очереди — каждый по стаку.
        # Пусто → вычисляется на лету (q0/q1 = все ресурсы очереди, q2 = один выбранный).
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN resources TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: отметка «не забрал ресурс на этой неделе» (офицер/админ) → остаётся в очереди
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN not_collected INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: применён жетон суперспособности (топ-3 взял вне очереди) → первый + свечение
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN privileged INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: уже ПОЛУЧЕННЫЕ игроком ресурсы (JSON-список ключей). Повторно выбрать их в
        # пикере нельзя (заблокированы). Сбрасывается при перезаходе в очередь (join).
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN received TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: сколько ПАЧЕК взято жетоном на этой записи (источник claim'а —
        # чтобы при смене ресурса пересчитать объём автоматически)
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN priv_stacks INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: пароль выдан/выслан (не придуман самим) → предложить придумать свой личный.
        # 1 = временный/высланный на почту; 0 = игрок придумал сам.
        try:
            conn.execute("ALTER TABLE queue_accounts ADD COLUMN pw_temp INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: выбранный игроком вариант модели (ключ конкретной модельки, если несколько доступно)
        try:
            conn.execute("ALTER TABLE queue_model_pref ADD COLUMN variant TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: аура модели (напр. 'death' — зловещая чёрная дымка вокруг конкретной модельки)
        try:
            conn.execute("ALTER TABLE queue_models ADD COLUMN aura TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: РОЛЬ супруга-получателя — 'husband'|'wife'|'' (кто он игроку: муж или жена)
        try:
            conn.execute("ALTER TABLE queue_spouses ADD COLUMN role TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: аккаунт офицера (личный пароль + офицерская роль по нику)
        try:
            conn.execute("ALTER TABLE queue_accounts ADD COLUMN is_officer INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: слой объекта на сцене — '' (авто по y) | 'front' | 'back'
        try:
            conn.execute("ALTER TABLE queue_placements ADD COLUMN z TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: АКТИВНАЯ ЛИЧНОСТЬ аккаунта — кем человек стоит/отображается (мэйн ИЛИ один
        # из его твинов). Пусто → мэйн. Аккаунт по-прежнему один на мэйн-канон (двойное стояние
        # невозможно), меняется только отображаемый ник/класс.
        try:
            conn.execute("ALTER TABLE queue_accounts ADD COLUMN active_nick TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE queue_accounts ADD COLUMN active_canon TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # миграция: активная личность записи очереди (канон выбранного ника). Пусто → мэйн.
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN active_canon TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass


def _main_of(nick: str, title: str) -> tuple[str, bool]:
    """(main_nick, is_twin). Титул ~X~ → мэйн X (ник — твин); иначе сам себе мэйн."""
    t = (title or "").strip()
    m = _MAIN_RE.match(t)
    if m and m.group(1).strip():
        return m.group(1).strip(), True
    return nick, False


def _resolve_partial(idx, cn):
    """Если canon `cn` не совпал ни с кем точно, но ОДНОЗНАЧНО является префиксом ника
    реального (не-твин) игрока — вернуть (real_canon, person). Нужно для НЕПОЛНЫХ/усечённых
    ников: обрезанный в игре титул твина (лимит длины строки титула, напр. ~Vandellia~) или
    когда человек ввёл часть ника (напр. «Ада» → «~АдаНет~»). Иначе None."""
    if not cn or len(cn) < 3 or cn in idx:
        return None
    cands = [c for c in idx if c != cn and c.startswith(cn) and not idx[c].get("is_twin")]
    if len(cands) == 1:
        return cands[0], idx[cands[0]]
    return None


# Фонетическая транслитерация латиница→кириллица — чтобы «SnegoVik» (набрано латиницей)
# сопоставилось с «СнегоVик» (кириллица). Применяем ТОЛЬКО как последний резерв и лишь при
# ОДНОЗНАЧНОМ совпадении, иначе — не трогаем (риск ложных совпадений).
_TRANSLIT = {
    "a": "а", "b": "б", "c": "с", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и",
    "j": "й", "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "к", "r": "р",
    "s": "с", "t": "т", "u": "у", "v": "в", "w": "в", "x": "х", "y": "у", "z": "з",
}


def _translit_canon(s: str) -> str:
    import re as _re
    s = _re.sub(r"[\W_]+", "", (s or "").lower(), flags=_re.UNICODE)
    return "".join(_TRANSLIT.get(ch, ch) for ch in s)


def _build_translit_map(idx) -> dict:
    """translit-canon -> real_canon, ТОЛЬКО для однозначных (без коллизий) не-твин игроков."""
    cnt: dict[str, int] = {}
    first: dict[str, str] = {}
    for c, pp in idx.items():
        if pp.get("is_twin"):
            continue
        tc = _translit_canon(pp["nick"])
        if not tc or len(tc) < 4:
            continue
        cnt[tc] = cnt.get(tc, 0) + 1
        first.setdefault(tc, c)
    return {tc: c for tc, c in first.items() if cnt[tc] == 1}


def _people(conn) -> dict[str, dict]:
    """canon(ника) -> {nick, title, cls, main_nick, main_canon, is_twin, sources}.
    Источники: текущий снимок Доблести + активный реестр приёма."""
    idx: dict[str, dict] = {}

    def add(nick: str, title: str, cls: str, true_name: str, source: str):
        nick = (nick or "").strip()
        if not nick:
            return
        cn = db._valor_canon(nick)
        if not cn:
            return
        cur = idx.get(cn)
        if cur is None:
            main_nick, is_twin = _main_of(nick, title)
            idx[cn] = {
                "nick": nick, "title": (title or "").strip(), "cls": (cls or "").strip(),
                "true_name": (true_name or "").strip(),
                "main_nick": main_nick, "main_canon": db._valor_canon(main_nick),
                "is_twin": is_twin, "sources": {source},
            }
        else:
            cur["sources"].add(source)
            if not cur["cls"] and cls:
                cur["cls"] = cls.strip()
            if not cur.get("true_name") and true_name:
                cur["true_name"] = true_name.strip()
            # титул из Доблести приоритетнее (там мэйн-метки живут)
            if title and not cur["title"]:
                cur["title"] = title.strip()
                mn, tw = _main_of(nick, title)
                cur["main_nick"], cur["main_canon"], cur["is_twin"] = mn, db._valor_canon(mn), tw

    snap = conn.execute(
        "SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    if snap:
        for r in conn.execute(
                "SELECT nick, title, class_ AS cls, true_name FROM valor_members WHERE snapshot_id=?",
                (snap["id"],)):
            add(r["nick"], r["title"], r["cls"], r["true_name"], "valor")
    for r in conn.execute(
            "SELECT game_nick AS nick, title FROM acceptances WHERE COALESCE(archived,0)=0"):
        add(r["nick"], r["title"], "", "", "registry")
    # Усечённые в игре титулы твинов: строка титула ограничена по длине, поэтому ~ПолныйМэйн~
    # мог обрезаться (напр. ~Vandellia~). Если мэйна из титула нет как реального игрока —
    # привяжем твина к настоящему мэйну по ОДНОЗНАЧНОМУ префиксу.
    for p in idx.values():
        if p["is_twin"] and p["main_canon"] and p["main_canon"] not in idx:
            res = _resolve_partial(idx, p["main_canon"])
            if res:
                p["main_canon"], p["main_nick"] = res[0], res[1]["nick"]
    # АВТО-твины по БАРЕ-титулу: клановая практика — писать в титул НИК своего мэйна.
    # Если титул человека (после снятия ~~) совпадает с ником реального игрока-мэйна
    # (сворачивая гомоглифы Τοмат=Томат) — значит это его твин. Напр. Ocheeva с титулом
    # «Череп@шка» → твин Череп@шки; KyбиК/Юнга_/… с «Vandelli» → твины Vandellia.
    # УСЕЧЁННЫЙ титул (ник не влез: «Vandelli»→«Vandellia», «Mortalit»→«Mortality») тоже
    # распознаётся через _resolve_partial (уникальный игрок-префикс). Не трогаем ручные связи.
    manual_forced = set()
    try:
        manual_forced = {r["canon"] for r in conn.execute("SELECT canon FROM queue_twins")}
    except Exception:
        manual_forced = set()
    # Аккаунт-холдеры — их личность УЖЕ заявлена (свой пароль). Авто-твин по титулу НЕ
    # переопределяет их мэйна: иначе, напр., у офицера с именем-титулом «Ната» main_canon
    # уехал бы на «наталия33» и сломал бы ему вход/аккаунт.
    acct_canons = set()
    try:
        acct_canons = {r["main_canon"] for r in conn.execute(
            "SELECT main_canon FROM queue_accounts") if r["main_canon"]}
    except Exception:
        acct_canons = set()
    for cn, p in list(idx.items()):
        if p.get("is_twin") or cn in manual_forced or cn in acct_canons:
            continue
        title = (p.get("title") or "").strip()
        if not title:
            continue
        mm = _MAIN_RE.match(title)
        inner = mm.group(1).strip() if mm else title
        tc = db._valor_canon(inner)
        if not tc or tc == cn:
            continue
        q = idx.get(tc)
        qc = tc
        if q is None:                                # усечённый титул → уникальный игрок-префикс
            part = _resolve_partial(idx, tc)
            if part:
                qc, q = part[0], part[1]
        if q is not None and qc != cn and not q.get("is_twin") and \
           q.get("main_canon") and q["main_canon"] != cn:
            p["main_canon"], p["main_nick"], p["is_twin"] = q["main_canon"], q["main_nick"], True
    # Ручные твины/фиксация мэйна (офицер/админ) — ПРИОРИТЕТНЕЕ авто. main_canon==canon → «это МЭЙН»
    # (снять ошибочный авто-твин). Иначе — привязать твина к указанному мэйну.
    try:
        for r in conn.execute("SELECT canon, main_canon, main_nick, twin_nick FROM queue_twins"):
            tc, mmc = r["canon"], r["main_canon"]
            if not tc or not mmc:
                continue
            p = idx.get(tc)
            if mmc == tc:                       # ЗАФИКСИРОВАН как мэйн (не твин)
                if p is not None:
                    p["main_canon"], p["main_nick"], p["is_twin"] = tc, (p.get("nick") or r["twin_nick"] or tc), False
                continue
            target = idx.get(mmc)
            real_mc = (target["main_canon"] if target else mmc) or mmc
            real_mn = (target["main_nick"] if target else "") or r["main_nick"] or mmc
            if p is not None:
                p["main_canon"], p["main_nick"], p["is_twin"] = real_mc, real_mn, True
            else:
                idx[tc] = {"nick": r["twin_nick"] or tc, "title": "", "cls": "", "true_name": "",
                           "main_nick": real_mn, "main_canon": real_mc, "is_twin": True, "sources": {"manual"}}
    except Exception:
        pass
    # Ручные ники (админ подтвердил) — как ОТДЕЛЬНЫЕ люди по их distinct canon.
    # Так они резолвятся ВЕЗДЕ по canon (записи очереди, модели), не сливаясь с двойником.
    try:
        for r in conn.execute("SELECT canon, nick, cls, title FROM queue_manual_nicks"):
            idx[r["canon"]] = {
                "nick": r["nick"], "title": r["title"] or "", "cls": r["cls"] or "",
                "true_name": "", "main_nick": r["nick"], "main_canon": r["canon"],
                "is_twin": False, "sources": {"manual"},
            }
    except Exception:
        pass
    # РУЧНОЙ КЛАСС (админ задал реестровым без класса) — переопределяет cls везде.
    try:
        for r in conn.execute("SELECT canon, cls FROM queue_class"):
            if r["cls"] and r["canon"] in idx:
                idx[r["canon"]]["cls"] = r["cls"].strip()
    except Exception:
        pass
    return idx


def _account_by_main(conn, main_canon: str):
    return conn.execute(
        "SELECT * FROM queue_accounts WHERE main_canon=?", (main_canon,)).fetchone()


def _set_device(conn, response: Response, account_id: int, request: Request) -> str:
    token = secrets.token_urlsafe(32)
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")[:300]
    conn.execute(
        "INSERT INTO queue_devices (token, account_id, created_at, last_seen_at, ip, user_agent)"
        " VALUES (?,?,?,?,?,?)", (token, account_id, _now(), _now(), ip, ua))
    response.set_cookie(COOKIE, token, max_age=COOKIE_MAX_AGE, httponly=True,
                        secure=True, samesite="lax", path="/")
    return token


def _account_from_request(conn, request: Request):
    # Кука ИЛИ заголовок X-Queue-Device (фолбэк для встроенных браузеров TG/VK и
    # Firefox ETP, которые режут cookie — иначе игрок попадал в петлю «войди заново»).
    token = request.cookies.get(COOKIE) or request.headers.get("x-queue-device", "")
    if not token:
        return None
    dev = conn.execute(
        "SELECT account_id FROM queue_devices WHERE token=?", (token,)).fetchone()
    if not dev:
        return None
    conn.execute("UPDATE queue_devices SET last_seen_at=? WHERE token=?", (_now(), token))
    acc = conn.execute(
        "SELECT * FROM queue_accounts WHERE id=?", (dev["account_id"],)).fetchone()
    # Если ник стал ОФИЦЕРСКИМ (тег/чат добавили позже) — старый игровой аккаунт больше
    # не пускает как игрока: офицер должен войти офицерским паролем. Возвращаем None →
    # клиент уводит на офицерский вход.
    if acc and acc["main_canon"] in _officer_canons(conn):
        return None
    return acc


def _acc_public(acc) -> dict:
    k = acc.keys()
    return {"main_nick": acc["main_nick"], "main_canon": acc["main_canon"],
            "reg_nick": acc["reg_nick"], "email": acc["email"],
            "active_nick": ((acc["active_nick"] if "active_nick" in k else "") or acc["main_nick"]),
            "pw_temp": bool(acc["pw_temp"]) if "pw_temp" in k else False}


def _player_ctx(conn, request: Request):
    """Кто действует в очереди: настоящий игрок (device-кука) ЛИБО ОФИЦЕР (по офиц. сессии,
    его ник). Раньше офицеры не могли встать в очередь («войди как игрок») — теперь могут,
    оставаясь офицерами. Возвращает dict с main_canon/main_nick/reg_nick или None."""
    acc = _account_from_request(conn, request)
    if acc:
        return dict(acc)
    try:
        s = current_session(request)
    except HTTPException:
        s = None
    if s and s.get("role") == "officer":
        name = (s.get("name") or "").strip()
        if not name:
            return None
        p = _people(conn).get(db._valor_canon(name))
        if p:
            return {"main_canon": p["main_canon"], "main_nick": p["main_nick"],
                    "reg_nick": p["nick"], "email": "", "id": None}
        cn = db._valor_canon(name)
        if cn:
            return {"main_canon": cn, "main_nick": name, "reg_nick": name, "email": "", "id": None}
    return None


# ─────────────────────────── схемы ───────────────────────────
class CheckIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)


class RegisterIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    shared_password: str = Field(min_length=1, max_length=200)
    email: str = Field(default="", max_length=200)
    # НЕ min_length=4 на уровне модели: офицер вводит офиц. пароль и может оставить это
    # поле пустым (аккаунт игрока ему не создаётся). Длину проверяем в ветке игрока.
    personal_password: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    personal_password: str = Field(min_length=1, max_length=200)


class OfficerLoginIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=200)


class RecoverIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    email: str = Field(default="", max_length=200)              # почта с регистрации (проверка)
    new_password: str = Field(default="", max_length=200)       # новый личный пароль (мин. 4)


class AdminNickIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)


class OfficerSetupIn(BaseModel):
    personal_password: str = Field(min_length=1, max_length=200)
    email: str = Field(default="", max_length=200)


class SharedPwIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class JoinIn(BaseModel):
    queue: int
    resource: str = Field(default="", max_length=64)
    resources: list[str] = Field(default_factory=list)   # МУЛЬТИ-выбор (обычная/редкая) — каждый по стаку
    recipient: str = Field(default="", max_length=64)   # кому передать (твин/супруг), необязательно
    auto_repeat: bool = False                            # вставать за этим же ресурсом каждую неделю
    plan: list[str] = Field(default_factory=list)        # план ресурсов на будущие недели (по порядку)
    privileged: bool = False                             # для leave: выйти из привилегированной (жетон) записи


class SetEntryIn(BaseModel):
    queue: int
    resource: str | None = Field(default=None, max_length=64)    # None = не менять
    resources: list[str] | None = None                           # None = не менять; список = мульти-выбор
    recipient: str | None = Field(default=None, max_length=64)   # None = не менять; "" = очистить
    auto_repeat: bool | None = None                              # None = не менять
    plan: list[str] | None = None                                # None = не менять
    privileged: bool = False                                     # менять привилегированную (жетон) запись, а не обычную


class SpouseIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)               # кому задаём получателя
    recipient: str = Field(default="", max_length=64)            # ник получателя; пусто = удалить связь
    role: str = Field(default="", max_length=8)                  # кто получатель игроку: 'husband'|'wife'|''


class TwinIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)               # ник-твин, который привязываем
    main_nick: str = Field(default="", max_length=64)            # ник мэйна; пусто = снять ручную привязку


class LinkRequestIn(BaseModel):
    recipient: str = Field(min_length=1, max_length=64)          # кому игрок хочет передать ресурс


class LinkDecideIn(BaseModel):
    id: int
    decision: str = Field(default="")                            # 'twin' | 'spouse' | 'reject'


class MarkUncollectedIn(BaseModel):
    entry_id: int
    uncollected: bool = True     # True = не забрал → остаётся в очереди; False = забрал (пройдёт дальше)


class RestoreUncollectedIn(BaseModel):
    served_id: int               # id строки из снимка queue_served_last (получивший на прошлой финализации)


class ReportRangeIn(BaseModel):
    from_stages: int = Field(ge=0, le=7)   # с какого числа закрытых этапов КХ
    to_stages: int = Field(ge=0, le=7)     # по какое (включительно) — по каждому свой отчёт


class PrivClaimIn(BaseModel):
    resource: str = Field(min_length=1, max_length=64)   # обычный ресурс (очередь 0)
    stacks: int = Field(default=1, ge=1, le=200)          # сколько пачек взять (= столько жетонов)


class ReportIn(BaseModel):
    from_stages: int = Field(ge=0, le=7)   # нижний этап (по нему считается ОСНОВНОЙ отчёт и сдвиг)
    to_stages: int = Field(ge=0, le=7)     # верхний этап; если > from → добавляется секция «если закроем ещё»
    commit: bool = False                   # False = превью (не двигать очередь); True = опубликовать + сдвинуть
    force: bool = False                    # обойти защиту от повторного сдвига в тот же день


class CilinDistributeIn(BaseModel):
    count: int = Field(ge=0, le=200)       # сколько Огненных цилиней выпало на этой неделе


class ReturnNicksIn(BaseModel):
    nicks: str = Field(min_length=1, max_length=4000)   # ники «не забравших» (запятая/перенос строки)


class GrantTokenIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    count: int = Field(default=1, ge=-50, le=50)          # +N дать / -N снять (для теста админом)


class AdminAddIn(BaseModel):
    queue: int
    nick: str = Field(min_length=1, max_length=64)
    position: int = Field(default=9999)      # 0-based индекс; большое число = в конец


# ── админ-тест: заполнить очереди людьми и действовать «как ник» (напр. Лирия!) ──
class TestFillIn(BaseModel):
    n: int = Field(default=6, ge=1, le=500)   # сколько человек добавить в каждую очередь


class TestAddItem(BaseModel):
    resource: str = Field(default="", max_length=64)
    count: int = Field(default=0, ge=0, le=300)


class TestAddIn(BaseModel):
    queue: int
    items: list[TestAddItem] = Field(default_factory=list)   # [{resource, count}] — заданные ресурсы
    random_count: int = Field(default=0, ge=0, le=300)        # + столько со случайными ресурсами


class JoinAsIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    queue: int
    resource: str = Field(default="", max_length=64)
    resources: list[str] = Field(default_factory=list)
    recipient: str = Field(default="", max_length=64)


class PrivClaimAsIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    resource: str = Field(min_length=1, max_length=64)
    stacks: int = Field(default=1, ge=1, le=50)


class LeaveAsIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    queue: int
    privileged: bool | None = None   # None = убрать всё (как раньше); False = только обычное; True = только жетон (+возврат)


class EntryIn(BaseModel):
    entry_id: int


class MoveIn(BaseModel):
    entry_id: int
    queue: int
    position: int = Field(default=9999)


class AdminSetEntryIn(BaseModel):
    entry_id: int
    resource: str | None = Field(default=None, max_length=64)
    resources: list[str] | None = None


class ClearIn(BaseModel):
    queue: int | None = None                 # None = очистить все очереди


class ModelIn(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    flip: int = Field(default=0)
    rotate: int = Field(default=0)
    scale: float = Field(default=1.0)
    aura: str = Field(default="", max_length=24)   # '' | 'death' — зловещая чёрная дымка вокруг модели


class ModelUploadIn(BaseModel):
    key: str = Field(min_length=1, max_length=120)      # 'person-<canon>' | 'class-<Класс>-<m|f>'
    data: str = Field(min_length=1, max_length=8_000_000)  # 'data:image/png;base64,...'


class GenderIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    gender: str = Field(default="")               # 'm' | 'f' | '' (сброс)


class MyGenderIn(BaseModel):
    gender: str = Field(default="")               # 'm' | 'f' | '' (авто по имени/классу)


class ModelPrefIn(BaseModel):
    prefer_class: bool = Field(default=False)     # True = общая классовая модель вместо персональной


class ModelVariantIn(BaseModel):
    key: str = Field(default="", max_length=120)  # ключ выбранного варианта модели ('' = авто)


class AdminModelVariantIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)  # чей вариант меняем (админ-тест, напр. Лирия!)
    key: str = Field(default="", max_length=120)


class PlacementIn(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    x: float
    y: float
    z: str = Field(default="")   # '' авто | 'front' | 'back' — слой объекта на сцене


class KVIn(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    val: str = Field(default="", max_length=4000)


# ─────────────────────────── офицеры (для входа в очередь) ───────────────────────────
_OFFICER_CACHE = {"at": 0.0, "set": frozenset()}
_OFFICER_AUTO_CACHE = {"at": 0.0, "set": frozenset()}


# Офицерские РАНГИ в клане (доблесть). Всё, что НЕ в этом наборе (Рядовой, рекрут и т.п.) —
# обычный игрок. Источник истины для авто-офицеров = ранг в последнем снимке доблести.
_OFFICER_RANKS = frozenset({
    "лейтенант", "капитан", "майор", "подполковник", "полковник", "генерал",
    "мастер", "маршал", "глава", "заместитель", "офицер", "командир",
})


def _officer_auto_canons(conn) -> frozenset:
    """АВТО-определение офицеров ПО РАНГУ в доблести (список офицеров виден в таблице
    Доблести): все, у кого в ПОСЛЕДНЕМ снимке офицерский ранг (Капитан/Майор/Мастер/Маршал
    и т.п. — см. _OFFICER_RANKS). Плюс ручной тег 'officer' в valor_tags. БОЛЬШЕ НЕ по
    офицерскому чату/фаззи (давало и ложные срабатывания, и пропуски). Кэш 5 мин."""
    import time
    now = time.time()
    if _OFFICER_AUTO_CACHE["at"] > 0 and now - _OFFICER_AUTO_CACHE["at"] < 300:
        return _OFFICER_AUTO_CACHE["set"]
    officers = set()
    # 1) ручной тег officer (пометка на сайте) — приоритетно
    try:
        for r in conn.execute("SELECT nick_canon FROM valor_tags WHERE tag='officer'"):
            if r["nick_canon"]:
                officers.add(r["nick_canon"])
    except Exception:
        pass
    # 2) офицерский РАНГ в последнем снимке доблести
    try:
        snap = conn.execute("SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
        if snap:
            for r in conn.execute(
                    "SELECT nick_canon, rank FROM valor_members WHERE snapshot_id=?", (snap["id"],)):
                if r["nick_canon"] and (r["rank"] or "").strip().lower() in _OFFICER_RANKS:
                    officers.add(r["nick_canon"])
    except Exception:
        pass
    res = frozenset(officers)
    _OFFICER_AUTO_CACHE["at"] = now
    _OFFICER_AUTO_CACHE["set"] = res
    return res


def _officer_roles(conn) -> dict:
    """{canon: mode} из queue_officer_roles ('force_officer' | 'force_regular')."""
    out = {}
    try:
        for r in conn.execute("SELECT canon, mode FROM queue_officer_roles"):
            if r["canon"]:
                out[r["canon"]] = r["mode"]
    except Exception:
        pass
    return out


def _officer_canons(conn) -> frozenset:
    """Итоговые офицеры = (авто ∪ force_officer) − force_regular. Кэш 5 мин."""
    import time
    now = time.time()
    if _OFFICER_CACHE["at"] > 0 and now - _OFFICER_CACHE["at"] < 300:
        return _OFFICER_CACHE["set"]
    auto = set(_officer_auto_canons(conn))
    roles = _officer_roles(conn)
    force_off = {c for c, m in roles.items() if m == "force_officer"}
    force_reg = {c for c, m in roles.items() if m == "force_regular"}
    res = frozenset((auto | force_off) - force_reg)
    _OFFICER_CACHE["at"] = now
    _OFFICER_CACHE["set"] = res
    return res


def _is_officer_nick(conn, nick: str) -> bool:
    cn = db._valor_canon(nick)
    if not cn:
        return False
    offs = _officer_canons(conn)
    if cn in offs:
        return True
    p = _people(conn).get(cn)
    return bool(p and p["main_canon"] in offs)


# ─────────────────────────── эндпоинты ───────────────────────────
def _raw_canon(s: str) -> str:
    """Скрипто-чувствительный ключ: lower + только буквы/цифры, БЕЗ свёртки гомоглифов.
    Так HARDKISS (латиница) и НаRDKisS (кириллица) РАЗЛИЧАЮТСЯ, хотя db._valor_canon
    сводит оба в 'hardkiss'. По нему сопоставляем ручные ники с введённым."""
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def _manual_person(row) -> dict:
    """Ручной ник в форме записи _people (для nick-suggest/check-nick/register)."""
    return {
        "nick": row["nick"], "cls": row["cls"] or "", "title": row["title"] or "",
        "main_nick": row["nick"], "main_canon": row["canon"], "is_twin": False,
        "sources": ["manual"], "gender": row["gender"] or "",
    }


def _manual_by_raw(conn, typed: str):
    """Ручной ник, совпадающий с введённым по скрипто-чувствительному ключу, или None."""
    raw = _raw_canon(typed)
    if not raw:
        return None
    row = conn.execute("SELECT * FROM queue_manual_nicks WHERE raw=? LIMIT 1", (raw,)).fetchone()
    return _manual_person(row) if row else None


def _resolve_person(conn, typed: str):
    """Резолв ника → человек. РУЧНОЙ ник (по raw) имеет ПРИОРИТЕТ над ростерным
    (folded canon), чтобы гомоглиф-двойники (HARDKISS/НаRDKisS) не сливались."""
    mp = _manual_by_raw(conn, typed)
    if mp:
        return mp
    return _people(conn).get(db._valor_canon(typed))


def _membership_main_canons(conn) -> dict:
    """MAIN-каноны действующего состава → источник ('valor'|'registry').
    = кто в ПОСЛЕДНЕМ снимке Доблести (после «Готово») + принятые в реестр ПОСЛЕ снимка.
    Базовый расчёт, из него материализуется clan_roster и считается вход."""
    idx = _people(conn)
    snap = conn.execute(
        "SELECT id, week, captured_at FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    if not snap:
        return {}                                   # снимков нет — вызывающий решает (fail-open)
    cut = (snap["captured_at"] or "")[:10]
    main_src: dict[str, str] = {}
    for r in conn.execute("SELECT nick FROM valor_members WHERE snapshot_id=?", (snap["id"],)):
        p = idx.get(db._valor_canon(r["nick"]))
        if p:
            main_src.setdefault(p["main_canon"], "valor")
    try:
        for r in conn.execute(
                "SELECT game_nick, created_at, accepted_date FROM acceptances "
                "WHERE COALESCE(archived,0)=0"):
            when = ((r["created_at"] or r["accepted_date"] or "")[:10])
            if cut and when and when >= cut:        # принят в тот день Готово или позже
                first = (r["game_nick"] or "").split(",")[0]
                p = idx.get(db._valor_canon(first))
                if p:
                    main_src.setdefault(p["main_canon"], "registry")
    except Exception:
        pass
    return main_src


def _compute_membership_canons(conn) -> set:
    """ВСЕ каноны (мэйн+твины) действующих + белый список — расчёт «на лету» (fallback)."""
    idx = _people(conn)
    main_src = _membership_main_canons(conn)
    if not main_src and not conn.execute(
            "SELECT 1 FROM valor_snapshots LIMIT 1").fetchone():
        return set(idx.keys())                      # снимков нет — не блокируем (fail-open)
    result = {cn for cn, p in idx.items() if p["main_canon"] in main_src}
    try:
        result |= db.chat_whitelist_nick_canons()
    except Exception:
        pass
    return result


def _current_login_canons(conn) -> set:
    """Кому РАЗРЕШЁН вход. АВТОРИТЕТ — материализованный clan_roster (active=1) + белый список.
    Если ростер ещё пуст (до первой сборки) — считаем на лету и заодно материализуем."""
    try:
        active = db.clan_roster_active_canons()
    except Exception:
        active = set()
    if active:
        try:
            active = active | db.chat_whitelist_nick_canons()
        except Exception:
            pass
        return active
    # Ростер пуст → соберём его один раз, дальше вход идёт из таблицы.
    try:
        rebuild_clan_roster()
        active = db.clan_roster_active_canons()
        if active:
            try:
                active = active | db.chat_whitelist_nick_canons()
            except Exception:
                pass
            return active
    except Exception:
        pass
    return _compute_membership_canons(conn)         # крайний fallback


def rebuild_clan_roster() -> dict:
    """Пересобрать МАТЕРИАЛИЗОВАННЫЙ ростер клана (db.clan_roster) из ПОСЛЕДНЕГО снимка доблести
    + принятых в реестр после. Разворачивает в ВСЕ каноны (мэйн+твины) действующих. Вызывается
    при «Готово» (ингест снимка), приёме в реестр и ежедневно планировщиком. Свои соединения —
    вызывать без открытой транзакции."""
    with db.connection() as conn:
        idx = _people(conn)
        snap = conn.execute(
            "SELECT week FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
        if not snap:
            return {"skipped": "no_snapshot"}
        main_src = _membership_main_canons(conn)
        week = snap["week"]
        rows = []
        for cn, p in idx.items():
            if p["main_canon"] in main_src:
                rows.append({"canon": cn, "nick": p["nick"], "main_canon": p["main_canon"],
                             "source": main_src[p["main_canon"]], "snapshot_week": week})
    res = db.clan_roster_replace(rows)               # своё write-соединение
    res["snapshot_week"] = week
    log.info("clan_roster rebuilt: active=%s added=%s removed=%s week=%s",
             res.get("active"), res.get("added"), res.get("removed"), week)
    return res


def _rget(r, k, d=""):
    """Безопасно достать колонку sqlite3.Row (может отсутствовать в старой схеме)."""
    try:
        return r[k] if k in r.keys() else d
    except Exception:
        return d


def reconcile_queue_with_roster() -> dict:
    """Синхронизирует ОЧЕРЕДЬ с актуальным ростером клана:
      • УДАЛЯЕТ из очереди тех, кого НЕТ в clan_roster (ушли из клана), ЗАПОМИНАЯ их место
        (queue_departed: очередь, позиция, ресурс(ы), получатель, привилегия, ПОСЛЕ КОГО стоял) —
        чтобы восстановить, если вернутся;
      • ВОЗВРАЩАЕТ ранее удалённых, кто СНОВА в ростере — на прежнюю позицию (orig_pos−0.5, без
        каскада), с тем же ресурсом/получателем.
    Fail-safe: пустой/подозрительно маленький ростер → ничего не трогаем."""
    active = db.clan_roster_active_canons()
    if len(active) < 20:                     # ростер пуст/битый — не трогаем очередь
        return {"skipped": "roster_too_small", "roster": len(active)}
    try:
        active = active | db.chat_whitelist_nick_canons()
    except Exception:
        pass
    removed, restored = [], []
    with db.connection() as conn:
        # ── 1) удалить ушедших, запомнив место ──
        by_queue: dict = {}
        for r in conn.execute("SELECT * FROM queue_entries ORDER BY queue, pos, id"):
            by_queue.setdefault(r["queue"], []).append(r)
        for q, rows in by_queue.items():
            prev_stay = None                 # последний ОСТАВШИЙСЯ (для «после кого»)
            for r in rows:
                mc = r["main_canon"] or ""
                if not mc or mc in active:   # пустой канон не трогаем (не можем проверить)
                    prev_stay = r
                    continue
                conn.execute(
                    "INSERT INTO queue_departed (queue, orig_pos, main_canon, nick, cls, resource,"
                    " resources, recipient, privileged, priv_stacks, auto_repeat, auto_plan,"
                    " after_nick, after_canon, removed_at, reason, restored_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'')",
                    (q, r["pos"], mc, r["nick"], _rget(r, "cls"), _rget(r, "resource"),
                     _rget(r, "resources"), _rget(r, "recipient"), _rget(r, "privileged", 0),
                     _rget(r, "priv_stacks", 0), _rget(r, "auto_repeat", 0), _rget(r, "auto_plan"),
                     (prev_stay["nick"] if prev_stay else ""),
                     (prev_stay["main_canon"] if prev_stay else ""), _now(), "left_clan"))
                conn.execute("DELETE FROM queue_entries WHERE id=?", (r["id"],))
                _log(conn, "auto_remove_left_clan", actor="система", nick=r["nick"], queue=q,
                     detail="ушёл из клана — убран из очереди %d (место запомнено: после «%s», ресурс %s)"
                            % (q, (prev_stay["nick"] if prev_stay else "начала"),
                               _rget(r, "resource") or _rget(r, "resources") or "-"))
                removed.append({"nick": r["nick"], "queue": q,
                                "after": (prev_stay["nick"] if prev_stay else "")})
        # ── 2) вернуть вернувшихся в клан на прежнее место ──
        for s in conn.execute("SELECT * FROM queue_departed WHERE restored_at='' ORDER BY queue, orig_pos"):
            mc = s["main_canon"] or ""
            if mc not in active:
                continue
            priv = s["privileged"]
            ex = conn.execute(
                "SELECT id FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=?",
                (s["queue"], mc, priv)).fetchone()
            target = float(s["orig_pos"]) - 0.5
            if ex:
                conn.execute("UPDATE queue_entries SET pos=? WHERE id=?", (target, ex["id"]))
            else:
                conn.execute(
                    "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, resources,"
                    " recipient, privileged, priv_stacks, auto_repeat, auto_plan, added_by, added_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (s["queue"], target, mc, s["nick"], s["cls"], s["resource"], s["resources"],
                     s["recipient"], priv, s["priv_stacks"], s["auto_repeat"], s["auto_plan"],
                     "restore_return", _now()))
            conn.execute("UPDATE queue_departed SET restored_at=? WHERE id=?", (_now(), s["id"]))
            _log(conn, "auto_restore_returned", actor="система", nick=s["nick"], queue=s["queue"],
                 detail="вернулся в клан — восстановлен в очереди %d на прежнее место (после «%s»)"
                        % (s["queue"], s["after_nick"] or "начала"))
            restored.append({"nick": s["nick"], "queue": s["queue"]})
    if removed or restored:
        log.info("queue reconcile: removed=%d restored=%d", len(removed), len(restored))
    return {"removed": removed, "restored": restored,
            "removed_count": len(removed), "restored_count": len(restored)}


def sync_queue_classes() -> int:
    """Досинк КЛАССА в очереди: у записей с пустым/устаревшим cls ставим АКТУАЛЬНЫЙ класс из
    _people (уточнённый последним снимком доблести). Класс новичка-реестровика неизвестен при
    вставании (cls=''), а после воскресного сбора доблести он становится известен — тут запись
    в очереди меняет класс на верный (в самой БД, не только в отображении). Ручной класс
    (queue_class) уже учтён в _people, поэтому не перетирается."""
    fixed = 0
    with db.connection() as conn:
        idx = _people(conn)
        for r in conn.execute(
                "SELECT id, main_canon, active_canon, cls FROM queue_entries").fetchall():
            ac = _rget(r, "active_canon") or r["main_canon"]     # класс по активной личности
            p = idx.get(ac) or idx.get(r["main_canon"]) or {}
            live = (p.get("cls") or "").strip()
            if live and live != (r["cls"] or ""):
                conn.execute("UPDATE queue_entries SET cls=? WHERE id=?", (live, r["id"]))
                fixed += 1
    if fixed:
        log.info("queue class sync: класс уточнён у %d записей", fixed)
    return fixed


def refresh_membership_and_queue() -> dict:
    """Полный автономный цикл (планировщик каждые 5 мин + «Готово» + приём в реестр):
    пересобрать ростер клана, синхронизировать очередь и уточнить классы в очереди."""
    r = rebuild_clan_roster()
    try:
        q = reconcile_queue_with_roster()
    except Exception as e:
        log.exception("queue reconcile failed")
        q = {"error": str(e)}
    try:
        cls_fixed = sync_queue_classes()
    except Exception:
        log.exception("queue class sync failed")
        cls_fixed = 0
    return {"roster": r, "queue": q, "class_synced": cls_fixed}


def _nick_allowed(conn, nick, allowed=None) -> bool:
    """Разрешён ли вход этому нику по правилу текущего ростера (см. _current_login_canons)."""
    if allowed is None:
        allowed = _current_login_canons(conn)
    p = _resolve_person(conn, nick)
    cans = {db._valor_canon(nick)}
    if p:
        cans.add(p["main_canon"])
    return bool(cans & allowed)


@router.get("/nick-suggest")
def nick_suggest(q: str = Query(..., min_length=1, max_length=64)) -> dict:
    ql = q.strip().lower()
    if len(ql) < 1:
        return {"results": []}
    qcanon = db._valor_canon(ql)
    out = []
    with db.connection() as conn:
        offs = _officer_canons(conn)
        allowed = _current_login_canons(conn)      # только текущий состав клана
        for cn, p in _people(conn).items():
            if cn not in allowed and p["main_canon"] not in allowed:
                continue
            if ql in p["nick"].lower() or (qcanon and qcanon in cn):
                out.append({
                    "nick": p["nick"], "cls": p["cls"], "title": p["title"],
                    "main_nick": p["main_nick"], "is_twin": p["is_twin"],
                    "sources": sorted(p["sources"]),
                    "officer": (cn in offs or p["main_canon"] in offs),
                })
    out.sort(key=lambda e: (0 if e["nick"].lower().startswith(ql) else 1, e["nick"].lower()))
    return {"results": out[:12]}


@router.post("/check-nick")
def check_nick(payload: CheckIn) -> dict:
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)   # ручной ник имеет приоритет
        if not p:
            return {"ok": False, "reason": "not_found"}
        offs = _officer_canons(conn)
        cn = p["main_canon"]
        is_off = cn in offs or db._valor_canon(payload.nick) in offs
        # ПРАВИЛО РОСТЕРА: пускаем только ТЕКУЩИЙ состав (последний снимок доблести + принятые
        # после + белый список). Ушедший из клана — not_in_clan, даже если он завёл пароль.
        # Офицеров пускаем всегда (у них отдельный сильный пароль).
        if not is_off and not _nick_allowed(conn, payload.nick):
            return {"ok": False, "reason": "not_in_clan"}
        acc = _account_by_main(conn, p["main_canon"])
        return {"ok": True, "nick": p["nick"], "main_nick": p["main_nick"],
                "is_twin": p["is_twin"], "registered": bool(acc),
                "officer": is_off}


# ── ЕДИНЫЙ ДОСТУП: массовая генерация личных паролей участников ─────────────

_PW_ALPHABET = "abcdefghjkmnpqrstvwxyz"    # без i,l,o,u — чтобы не путать при рассылке
_PW_DIGITS = "23456789"                     # без 0 и 1


def _gen_password() -> str:
    """Читаемый, но стойкий пароль: 4 буквы + '-' + 4 буквы/цифры."""
    a = "".join(secrets.choice(_PW_ALPHABET) for _ in range(4))
    b = "".join(secrets.choice(_PW_ALPHABET + _PW_DIGITS) for _ in range(4))
    return a + "-" + b


def _roster_persons(conn) -> dict[str, str]:
    """Реальные ЛЮДИ текущего клана: уник. main_canon по ПОСЛЕДНЕМУ снимку Доблести
    (актуальный ростер, 183 персонажа → люди с учётом твинов). Реестр приёмов
    НЕ подмешиваем — там ушедшие и фантомы. Возвращает {main_canon: отображаемый ник}."""
    idx = _people(conn)
    snap = conn.execute("SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    persons: dict[str, str] = {}
    if not snap:
        return persons
    for r in conn.execute("SELECT nick_canon FROM valor_members WHERE snapshot_id=?", (snap["id"],)):
        p = idx.get(r["nick_canon"])
        if not p:
            continue
        mc = p.get("main_canon") or r["nick_canon"]
        if mc and mc not in persons:
            persons[mc] = p.get("main_nick") or p.get("nick") or r["nick_canon"]
    return persons


class GenPwIn(BaseModel):
    scope: str = Field("missing", pattern=r"^(missing|all)$")


@router.post("/admin/gen-passwords")
def gen_passwords(payload: GenPwIn, actor: dict = Depends(require_admin)) -> dict:
    """Массовая генерация ЛИЧНЫХ паролей (по одному на человека = main_canon).
    scope=missing — только тем, у кого ещё НЕТ аккаунта; scope=all — перегенерить всем.
    Плейнтекст показывается ОДИН раз для рассылки; в БД хранится только bcrypt-хэш."""
    out = []
    with db.connection() as conn:
        persons = _roster_persons(conn)
        for mc, nick in sorted(persons.items(), key=lambda kv: (kv[1] or "").lower()):
            acc = _account_by_main(conn, mc)
            if acc and payload.scope == "missing":
                out.append({"nick": nick, "canon": mc, "status": "есть", "password": ""})
                continue
            pw = _gen_password()
            h = _hash(pw)
            if acc:
                conn.execute("UPDATE queue_accounts SET password_hash=?, pw_temp=1 WHERE id=?",
                             (h, acc["id"]))
                st = "сброшен"
            else:
                conn.execute(
                    "INSERT INTO queue_accounts (main_canon, main_nick, reg_nick, email, "
                    "password_hash, created_at, pw_temp) VALUES (?,?,?,?,?,?,1)",
                    (mc, nick, nick, "", h, _now()))
                st = "новый"
            out.append({"nick": nick, "canon": mc, "status": st, "password": pw})
    made = [o for o in out if o["password"]]
    return {"total": len(out), "generated": len(made), "items": out}


@router.get("/admin/chat-clicks")
def chat_clicks_log(limit: int = 60, _: dict = Depends(require_admin)) -> list[dict]:
    """Последние клики ссылок чата (для теста авто-регистрации): кто кликнул (ник/канон),
    платформа, время, IP, и сопоставлен ли с ЗАХОДОМ в чат (matched) + с кем/когда."""
    limit = max(1, min(limit, 300))
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT id, nick, canon, platform, clicked_at, ip, matched, matched_at, "
            "match_name, match_pid FROM queue_chat_link_click ORDER BY id DESC LIMIT ?",
            (limit,)).fetchall()
    return [dict(r) for r in rows]


@router.get("/admin/roster")
def clan_roster_view(active_only: bool = True, _: dict = Depends(require_admin)) -> dict:
    """Материализованный ростер клана: авторитетный список тех, кому разрешён вход
    (точные ники последнего снимка доблести + принятые после). Для админ-аудита."""
    return {"stats": db.clan_roster_stats(),
            "rows": db.clan_roster_list(active_only=active_only, limit=2000)}


@router.post("/admin/roster/rebuild")
def clan_roster_rebuild_ep(_: dict = Depends(require_admin)) -> dict:
    """Ручная пересборка ростера клана + синхронизация очереди (как на «Готово» и по таймеру)."""
    return refresh_membership_and_queue()


@router.get("/admin/queue-departed")
def queue_departed_list(include_restored: bool = False,
                        _: dict = Depends(require_admin)) -> dict:
    """Ушедшие из клана, УБРАННЫЕ из очереди авто-сверкой — с их местом (очередь, позиция,
    ресурс, после кого стояли). Для аудита/ручного восстановления."""
    where = "" if include_restored else "WHERE restored_at=''"
    with db.connection() as conn:
        rows = [dict(r) for r in conn.execute(
            f"SELECT * FROM queue_departed {where} ORDER BY removed_at DESC, queue, orig_pos LIMIT 500")]
    return {"count": len(rows), "rows": rows}


@router.post("/admin/queue-reconcile")
def queue_reconcile_ep(_: dict = Depends(require_admin)) -> dict:
    """Ручной запуск сверки очереди с ростером (убрать ушедших, вернуть вернувшихся)."""
    return reconcile_queue_with_roster()


@router.get("/admin/access-status")
def access_status(_: dict = Depends(require_admin)) -> dict:
    """Сводка по доступу: сколько людей с аккаунтом (личным паролем) и сколько без."""
    with db.connection() as conn:
        persons = _roster_persons(conn)
        have, missing = [], []
        for mc, nick in sorted(persons.items(), key=lambda kv: (kv[1] or "").lower()):
            (have if _account_by_main(conn, mc) else missing).append(nick)
    return {"total": len(persons), "have": len(have), "missing": missing}


def _acc_is_self_made(acc) -> bool:
    """Игрок придумал свой пароль на сайте (pw_temp=0). Высланные/сгенерированные — pw_temp=1."""
    try:
        return ("pw_temp" in acc.keys()) and not acc["pw_temp"]
    except Exception:
        return False


class MailPwIn(BaseModel):
    skip: list[str] = Field(default_factory=list, max_length=4000)   # ники, кому УЖЕ разослали


@router.post("/admin/mail-passwords")
def mail_passwords(payload: MailPwIn, actor: dict = Depends(require_admin)) -> dict:
    """Список для рассылки паролей ИГРОКАМ через внутриигровую почту: текущий ростер (последний
    снимок Доблести + принятые в реестр после «Готово») МИНУС офицеры МИНУС те, кто уже придумал
    свой пароль на сайте. skip — ники, кому уже разослали (их НЕ трогаем/не перегенерируем).
    Каждому оставшемуся — свежий читаемый пароль (pw_temp=1). Возвращает {nick,password} + счётчики."""
    out = []
    with db.connection() as conn:
        idx = _people(conn)
        allowed = _current_login_canons(conn)      # кому вообще разрешён вход (ростер)
        offs = _officer_canons(conn)
        persons = {}                               # main_canon -> отображаемый ник (не офицеры)
        for cn, p in idx.items():
            mc = p.get("main_canon") or cn
            if cn not in allowed and mc not in allowed:
                continue
            if mc in offs or cn in offs:           # офицеры — исключаем (у них офиц. пароль)
                continue
            if mc not in persons:
                persons[mc] = p.get("main_nick") or p.get("nick") or cn
        skip_norm = {db._valor_canon(s) for s in (payload.skip or [])}
        n_self = n_skip = 0
        for mc, nick in sorted(persons.items(), key=lambda kv: (kv[1] or "").lower()):
            if db._valor_canon(nick) in skip_norm or mc in skip_norm:
                n_skip += 1
                continue                           # уже разослан — не перегенерируем
            acc = _account_by_main(conn, mc)
            if acc and _acc_is_self_made(acc):
                n_self += 1
                continue                           # придумал свой пароль — не трогаем/не шлём
            pw = _gen_password()
            h = _hash(pw)
            if acc:
                conn.execute("UPDATE queue_accounts SET password_hash=?, pw_temp=1 WHERE id=?",
                             (h, acc["id"]))
            else:
                conn.execute(
                    "INSERT INTO queue_accounts (main_canon, main_nick, reg_nick, email, "
                    "password_hash, created_at, pw_temp) VALUES (?,?,?,?,?,?,1)",
                    (mc, nick, nick, "", h, _now()))
            out.append({"nick": nick, "password": pw})
    return {"items": out, "generated": len(out), "self_made_skipped": n_self,
            "already_sent_skipped": n_skip, "total_players": len(persons)}


@router.get("/admin/manual-nicks")
def manual_nicks_list(_: dict = Depends(require_admin)) -> dict:
    """Список ручных ников (для админ-панели)."""
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT canon, raw, nick, cls, title, gender, added_by, added_at "
            "FROM queue_manual_nicks ORDER BY added_at DESC").fetchall()
        accs = {r["main_canon"] for r in conn.execute("SELECT main_canon FROM queue_accounts")}
    return {"items": [{**dict(r), "registered": r["canon"] in accs} for r in rows]}


@router.post("/admin/manual-nick")
def manual_nick_add(payload: dict, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Админ вручную подтверждает ник (для новых людей / гомоглиф-двойников). Ник появится
    в подсказках при входе и будет РАЗДЕЛЬНЫМ identity (не сольётся с похожим ростерным)."""
    nick = (payload.get("nick") or "").strip()[:64]
    raw = _raw_canon(nick)
    if not nick or not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_nick")
    cls = (payload.get("cls") or "").strip()[:32]
    title = (payload.get("title") or "").strip()[:64]
    gender = (payload.get("gender") or "").strip().lower()
    gender = gender if gender in ("m", "f") else ""
    with db.connection() as conn:
        exist = conn.execute("SELECT canon FROM queue_manual_nicks WHERE raw=?", (raw,)).fetchone()
        if exist:
            canon = exist["canon"]
            conn.execute("UPDATE queue_manual_nicks SET nick=?, cls=?, title=?, gender=?, added_by=?, added_at=? WHERE canon=?",
                         (nick, cls, title, gender, _actor_name(actor), _now(), canon))
        else:
            # canon = raw, а при коллизии с ростерным/аккаунтом/другим ручным — raw~2, raw~3…
            taken = set(_people(conn).keys())
            taken |= {r["canon"] for r in conn.execute("SELECT canon FROM queue_manual_nicks")}
            taken |= {r["main_canon"] for r in conn.execute("SELECT main_canon FROM queue_accounts")}
            canon = raw
            n = 2
            while canon in taken:
                canon = raw + "~" + str(n); n += 1
            conn.execute("INSERT INTO queue_manual_nicks (canon, raw, nick, cls, title, gender, added_by, added_at) "
                         "VALUES (?,?,?,?,?,?,?,?)", (canon, raw, nick, cls, title, gender, _actor_name(actor), _now()))
        _log(conn, "manual_nick_add", actor=_actor_name(actor), nick=nick, request=request, detail="canon=" + canon)
    return {"ok": True, "canon": canon, "nick": nick}


@router.post("/admin/manual-nick-delete")
def manual_nick_delete(payload: dict, request: Request, actor: dict = Depends(require_admin)) -> dict:
    canon = (payload.get("canon") or "").strip()
    with db.connection() as conn:
        cur = conn.execute("DELETE FROM queue_manual_nicks WHERE canon=?", (canon,))
        _log(conn, "manual_nick_del", actor=_actor_name(actor), request=request, detail="canon=" + canon)
    return {"ok": True, "deleted": cur.rowcount}


def _set_officer_role(conn, actor, nick: str, mode: str):
    """Ставит роль человеку (и его мэйн-канону). mode:
       'auto' — снять пометку (следует чатам); 'force_officer' — закрепить офицером;
       'force_regular' — закрепить обычным. Синхронизирует is_officer на аккаунте
       (почту/пароль НЕ трогаем). Возвращает (nick, set(канонов))."""
    if mode not in ("auto", "force_officer", "force_regular"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_mode")
    idx = _people(conn)
    cn = db._valor_canon(nick)
    p = idx.get(cn)
    disp = (p["nick"] if p else (nick or "").strip())
    cns = {c for c in {cn, (p["main_canon"] if p else "")} if c}   # ник + его мэйн-канон
    if not cns:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_nick")
    for c in cns:
        if mode == "auto":
            conn.execute("DELETE FROM queue_officer_roles WHERE canon=?", (c,))
        else:
            conn.execute(
                "INSERT OR REPLACE INTO queue_officer_roles (canon, nick, mode, updated_by, updated_at)"
                " VALUES (?,?,?,?,?)", (c, disp, mode, _actor_name(actor), _now()))
        if mode == "force_officer":
            conn.execute("UPDATE queue_accounts SET is_officer=1 WHERE main_canon=?", (c,))
        elif mode == "force_regular":
            conn.execute("UPDATE queue_accounts SET is_officer=0 WHERE main_canon=?", (c,))
    _OFFICER_CACHE["at"] = 0.0        # сбросить кэш итоговых офицеров — эффект сразу
    return disp, cns


@router.get("/admin/officer-roles")
def officer_roles_list(_: dict = Depends(require_admin)) -> dict:
    """Управление офицерством: эффективные офицеры + все закреплённые. По каждому:
       mode ('auto'|'force_officer'|'force_regular'), is_officer (итог), in_chat (авто), registered."""
    with db.connection() as conn:
        idx = _people(conn)
        eff = _officer_canons(conn)
        auto = _officer_auto_canons(conn)
        roles = _officer_roles(conn)
        rnames = {r["canon"]: r["nick"]
                  for r in conn.execute("SELECT canon, nick FROM queue_officer_roles")}
        accs = {r["main_canon"] for r in conn.execute("SELECT main_canon FROM queue_accounts")}
        canons = set(eff) | set(roles.keys())
        items = []
        for c in canons:
            p = idx.get(c)
            nick = (p["nick"] if p else (rnames.get(c) or c))
            items.append({"canon": c, "nick": nick, "mode": roles.get(c, "auto"),
                          "is_officer": c in eff, "in_chat": c in auto,
                          "registered": c in accs})
        items.sort(key=lambda x: (not x["is_officer"], (x["nick"] or "").lower()))
    return {"items": items}


@router.post("/admin/officer-role")
def officer_role_set(payload: dict, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Установить роль: mode = 'auto' | 'force_officer' | 'force_regular'. Пароль/почта остаются."""
    nick = (payload.get("nick") or "").strip()[:64]
    mode = (payload.get("mode") or "").strip()
    if not nick:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_nick")
    with db.connection() as conn:
        disp, cns = _set_officer_role(conn, actor, nick, mode)
        _log(conn, "officer_role", actor=_actor_name(actor), nick=disp, request=request,
             detail="mode=%s (каноны: %s)" % (mode, ",".join(sorted(cns))))
    return {"ok": True, "nick": disp, "mode": mode}


# back-compat (старый фронт до обновления кэша) — через единую таблицу ролей
@router.get("/admin/officer-excludes")
def officer_excludes_list(_: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT canon, nick, updated_by AS added_by, updated_at AS added_at FROM queue_officer_roles"
            " WHERE mode='force_regular' ORDER BY updated_at DESC").fetchall()
    return {"items": [dict(r) for r in rows]}


@router.post("/admin/officer-exclude")
def officer_exclude_add(payload: dict, request: Request, actor: dict = Depends(require_admin)) -> dict:
    nick = (payload.get("nick") or "").strip()[:64]
    if not nick:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_nick")
    with db.connection() as conn:
        disp, _cns = _set_officer_role(conn, actor, nick, "force_regular")
        _log(conn, "officer_exclude", actor=_actor_name(actor), nick=disp, request=request, detail="force_regular")
    return {"ok": True, "nick": disp}


@router.post("/admin/officer-exclude-delete")
def officer_exclude_delete(payload: dict, request: Request, actor: dict = Depends(require_admin)) -> dict:
    canon = (payload.get("canon") or "").strip()
    with db.connection() as conn:
        conn.execute("DELETE FROM queue_officer_roles WHERE canon=? AND mode='force_regular'", (canon,))
        _log(conn, "officer_exclude_del", actor=_actor_name(actor), request=request, detail="canon=" + canon)
    _OFFICER_CACHE["at"] = 0.0
    return {"ok": True}


@router.post("/register")
def register(payload: RegisterIn, request: Request, response: Response) -> dict:
    with db.connection() as conn:
        cfg = conn.execute("SELECT shared_password_hash FROM queue_config WHERE id=1").fetchone()
        shared = cfg["shared_password_hash"] if cfg else ""
        p = _resolve_person(conn, payload.nick)   # ручной ник имеет приоритет над ростерным
        off_ok = auth_pwd.verify_officer(payload.shared_password)     # ЖИВОЙ офицерский пароль
        # РУЧНОЙ ник — отдельный человек, НЕ наследует офицерство своего гомоглиф-двойника
        # (иначе HARDKISS требовала бы офиц. пароль, если НаRDKisS — офицер).
        is_off_nick = (not _manual_by_raw(conn, payload.nick)) and _is_officer_nick(conn, payload.nick)
        # ОФИЦЕР (по офицерскому паролю ИЛИ офицерский ник) — регистрирует ЛИЧНЫЙ пароль,
        # но офицерский пароль обязателен как доказательство, что он офицер.
        role_officer = off_ok or is_off_nick
        if role_officer:
            if not off_ok:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "need_officer_password")
        else:
            # Обычный игрок — по ОБЩЕМУ паролю гильдии.
            if not (shared and _check(payload.shared_password, shared)):
                if not shared:
                    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "shared_password_not_set")
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_shared_password")
            if not p:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
            # ПРАВИЛО РОСТЕРА: регистрация только текущему составу клана
            if not _nick_allowed(conn, payload.nick):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "not_in_clan")

        main_canon = p["main_canon"] if p else db._valor_canon(payload.nick)
        main_nick = (p["main_nick"] if p else payload.nick.strip()) or payload.nick.strip()
        reg_nick = (p["nick"] if p else payload.nick.strip())
        if not main_canon:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        acc = _account_by_main(conn, main_canon)
        if acc:
            # уже есть аккаунт на мэйна — регистрация не нужна, пусть входит личным паролем
            raise HTTPException(status.HTTP_409_CONFLICT, "already_registered")
        if len(payload.personal_password) < 4:      # личный пароль обязателен (игроку и офицеру)
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "personal_password_too_short")

        # активная личность = ник, которым регистрируются (мэйн ИЛИ его твин)
        act_nick, act_canon, _ = _active_identity(_people(conn), main_canon, payload.nick)
        cur = conn.execute(
            "INSERT INTO queue_accounts (main_canon, main_nick, reg_nick, email, password_hash,"
            " is_officer, active_nick, active_canon, created_at, last_login_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (main_canon, main_nick, reg_nick, payload.email.strip(),
             _hash(payload.personal_password), 1 if role_officer else 0,
             act_nick, act_canon, _now(), _now()))
        acc_id = cur.lastrowid
        dev_token = _set_device(conn, response, acc_id, request)
        _log(conn, "register", actor=reg_nick, nick=reg_nick, request=request,
             detail=("офицер · " if role_officer else "") + ("email" if payload.email.strip() else "no-email"))
        acc = conn.execute("SELECT * FROM queue_accounts WHERE id=?", (acc_id,)).fetchone()
        if role_officer:
            tok = set_session(response, role="officer", name=main_nick)
            _log(conn, "officer_login", actor=main_nick, nick=main_nick, request=request,
                 detail="офицер зарегистрировал личный пароль")
            return {"ok": True, "role": "officer", "officer": True,
                    "account": _acc_public(acc), "device_token": dev_token, "token": tok}
        tok = set_session(response, role="member", name=main_nick)
        return {"ok": True, "role": "member", "account": _acc_public(acc),
                "device_token": dev_token, "token": tok}


@router.post("/login")
def login(payload: LoginIn, request: Request, response: Response) -> dict:
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)   # ручной ник имеет приоритет
        main_canon = p["main_canon"] if p else db._valor_canon(payload.nick)
        acc = _account_by_main(conn, main_canon)
        # ПРАВИЛО РОСТЕРА: вход только ТЕКУЩЕМУ составу — кто в последнем снимке доблести
        # (после «Готово — обновить доблесть») ИЛИ принят в реестр после него ИЛИ в белом
        # списке чатов. Ушедший из клана (даже со своим паролём) — НЕ входит. Офицеров не
        # блокируем (у них отдельный сильный пароль).
        if not _is_officer_nick(conn, payload.nick) and not _nick_allowed(conn, payload.nick):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "not_in_clan")
        # Офицерский ник, но аккаунта ещё нет → сначала зарегистрировать личный пароль офиц. паролем.
        # Ручной ник — отдельный человек, не наследует офицерство гомоглиф-двойника.
        if not acc and not _manual_by_raw(conn, payload.nick) and _is_officer_nick(conn, payload.nick):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "need_officer_password")
        if not acc or not _check(payload.personal_password, acc["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_credentials")
        conn.execute("UPDATE queue_accounts SET last_login_at=? WHERE id=?", (_now(), acc["id"]))
        dev_token = _set_device(conn, response, acc["id"], request)
        # ЭФФЕКТИВНЫЙ статус (авто из чатов ∪ закреплён офицером − закреплён обычным) —
        # чтобы вход отражал текущие роли: вышел из чатов/понижен → входит обычным и наоборот.
        is_off = acc["main_canon"] in _officer_canons(conn)
        conn.execute("UPDATE queue_accounts SET is_officer=? WHERE id=?", (1 if is_off else 0, acc["id"]))
        # игрок вошёл конкретным ником (мэйн/твин) → это его активная личность; записи обновляем
        if not is_off:
            _apply_identity(conn, acc["id"], acc["main_canon"], payload.nick)
        _log(conn, "login", actor=acc["main_nick"], nick=acc["main_nick"], request=request,
             detail="офицер" if is_off else "")
        if is_off:                                     # офицер входит личным паролём → офиц. сессия
            tok = set_session(response, role="officer", name=acc["main_nick"])
            return {"ok": True, "role": "officer", "officer": True,
                    "account": _acc_public(acc), "device_token": dev_token, "token": tok}
        # обычный игрок → member-сессия на весь сайт (единый вход)
        tok = set_session(response, role="member", name=acc["main_nick"])
        return {"ok": True, "role": "member", "account": _acc_public(acc),
                "device_token": dev_token, "token": tok}


class ChangePwIn(BaseModel):
    personal_password: str = Field(min_length=4, max_length=200)


@router.post("/change-password")
def change_password(payload: ChangePwIn, request: Request, response: Response) -> dict:
    """Сменить СВОЙ личный пароль (вошедший игрок). Используется после входа высланным
    паролем — «придумай свой». Ставит новый хэш и снимает флаг pw_temp."""
    with db.connection() as conn:
        acc = _account_from_request(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        conn.execute("UPDATE queue_accounts SET password_hash=?, pw_temp=0 WHERE id=?",
                     (_hash(payload.personal_password), acc["id"]))
        _log(conn, "change_password", actor=acc["main_nick"], nick=acc["main_nick"],
             request=request, detail="сменил личный пароль")
    return {"ok": True}


@router.post("/officer-login")
def officer_login(payload: OfficerLoginIn, request: Request, response: Response) -> dict:
    """Вход в очередь КАК ОФИЦЕР по ЖИВОМУ офицерскому паролю (из закрепа чатов TG/VK).
    Ставит офицерскую сессию → человек видит офицерскую панель. Ник — для отображения."""
    if not auth_pwd.verify_officer(payload.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_officer_password")
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        name = (p["main_nick"] if p else payload.nick.strip()) or "офицер"
        _log(conn, "officer_login", actor=name, nick=name, request=request,
             detail="вход офицером через очередь")
    tok = set_session(response, role="officer", name=name)
    return {"ok": True, "role": "officer", "nick": name, "token": tok}


def _mask_email(e: str) -> str:
    e = (e or "").strip()
    if "@" not in e:
        return ""
    loc, dom = e.split("@", 1)

    def m(s: str, keep: int) -> str:
        s = s or ""
        k = min(keep, max(1, len(s) - 1)) if len(s) > 1 else 1
        return s[:k] + "***" if s else "***"
    parts = dom.rsplit(".", 1)
    dm = (m(parts[0], 1) + "." + parts[1]) if len(parts) == 2 else m(dom, 1)
    return m(loc, 2) + "@" + dm


@router.get("/recover-hint")
def recover_hint(nick: str = Query(..., min_length=1, max_length=64)) -> dict:
    """Подсказка для восстановления: есть ли аккаунт и указана ли почта (в маскированном виде)."""
    with db.connection() as conn:
        p = _people(conn).get(db._valor_canon(nick))
        mc = p["main_canon"] if p else db._valor_canon(nick)
        acc = _account_by_main(conn, mc) if mc else None
    if not acc:
        return {"registered": False, "has_email": False, "email_mask": ""}
    email = acc["email"] or ""
    return {"registered": True, "has_email": bool(email.strip()),
            "email_mask": _mask_email(email)}


@router.post("/recover")
def recover(payload: RecoverIn, request: Request, response: Response) -> dict:
    """Восстановление пароля по ПОЧТЕ С РЕГИСТРАЦИИ (без отправки писем): ник + та же почта →
    задать новый личный пароль. Кто почту не указывал/забыл — сброс делает офицер/админ."""
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        mc = p["main_canon"] if p else db._valor_canon(payload.nick)
        acc = _account_by_main(conn, mc) if mc else None
        if not acc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no_account")
        stored = (acc["email"] or "").strip().lower()
        given = (payload.email or "").strip().lower()
        if not stored:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "no_email_on_file")
        if not given or given != stored:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "email_mismatch")
        if len(payload.new_password) < 4:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "personal_password_too_short")
        conn.execute("UPDATE queue_accounts SET password_hash=?, last_login_at=? WHERE id=?",
                     (_hash(payload.new_password), _now(), acc["id"]))
        dev_token = _set_device(conn, response, acc["id"], request)
        is_off = bool(acc["is_officer"]) if "is_officer" in acc.keys() else False
        _log(conn, "recover", actor=acc["main_nick"], nick=acc["main_nick"], request=request,
             detail="пароль восстановлен по почте")
        acc = conn.execute("SELECT * FROM queue_accounts WHERE id=?", (acc["id"],)).fetchone()
        if is_off:
            tok = set_session(response, role="officer", name=acc["main_nick"])
            return {"ok": True, "role": "officer", "account": _acc_public(acc),
                    "device_token": dev_token, "token": tok}
        return {"ok": True, "account": _acc_public(acc), "device_token": dev_token}


@router.post("/admin/reset-password")
def admin_reset_password(payload: AdminNickIn, request: Request,
                         actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Сброс регистрации игрока (офицер/админ): удаляет аккаунт — человек создаст пароль заново
    при следующем входе. Нужен тем, кто не указал/забыл почту для самостоятельного восстановления."""
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        mc = p["main_canon"] if p else db._valor_canon(payload.nick)
        acc = _account_by_main(conn, mc) if mc else None
        if not acc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no_account")
        # снимаем привязанные устройства и сам аккаунт
        conn.execute("DELETE FROM queue_devices WHERE account_id=?", (acc["id"],))
        conn.execute("DELETE FROM queue_accounts WHERE id=?", (acc["id"],))
        _log(conn, "reset_password", actor=_actor_name(actor), nick=acc["main_nick"],
             request=request, detail="сброс регистрации (создаст пароль заново)")
    return {"ok": True}


@router.post("/officer-setup")
def officer_setup(payload: OfficerSetupIn, request: Request, response: Response) -> dict:
    """Офицер, вошедший по офиц. сессии ДО нововведения (без личного пароля), придумывает
    личный пароль и указывает почту. Создаёт офицерский аккаунт — дальше вход личным паролём."""
    try:
        s = current_session(request)
    except HTTPException:
        s = None
    if not s or s.get("role") != "officer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_officer_session")
    name = (s.get("name") or "").strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no_officer_name")
    if len(payload.personal_password) < 4:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "personal_password_too_short")
    with db.connection() as conn:
        p = _people(conn).get(db._valor_canon(name))
        mc = p["main_canon"] if p else db._valor_canon(name)
        main_nick = (p["main_nick"] if p else name) or name
        reg_nick = (p["nick"] if p else name)
        if not mc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        if _account_by_main(conn, mc):
            raise HTTPException(status.HTTP_409_CONFLICT, "already_registered")
        cur = conn.execute(
            "INSERT INTO queue_accounts (main_canon, main_nick, reg_nick, email, password_hash,"
            " is_officer, created_at, last_login_at) VALUES (?,?,?,?,?,1,?,?)",
            (mc, main_nick, reg_nick, payload.email.strip(),
             _hash(payload.personal_password), _now(), _now()))
        acc_id = cur.lastrowid
        dev_token = _set_device(conn, response, acc_id, request)
        _log(conn, "officer_setup", actor=main_nick, nick=main_nick, request=request,
             detail="офицер задал личный пароль" + (" +email" if payload.email.strip() else ""))
        acc = conn.execute("SELECT * FROM queue_accounts WHERE id=?", (acc_id,)).fetchone()
        return {"ok": True, "role": "officer", "account": _acc_public(acc), "device_token": dev_token}


@router.get("/nick-role")
def nick_role(nick: str = Query(..., min_length=1, max_length=64)) -> dict:
    """Является ли ник офицерским (для подсказки на входе — сменить надпись у пароля)."""
    with db.connection() as conn:
        return {"officer": _is_officer_nick(conn, nick)}


@router.get("/me")
def me(request: Request, response: Response) -> dict:
    with db.connection() as conn:
        acc = _player_ctx(conn, request)              # игрок ИЛИ офицер (для жетонов/пола)
        dev = _account_from_request(conn, request)    # ТОЛЬКО настоящий игрок — для поля account
        # Device-кука живёт 6 мес, а site-сессия 7 дней. Если игрок с валидным устройством,
        # но сессия истекла — переиздаём member-сессию, иначе была бы петля login↔доблесть
        # (clan-valor видит 401 от /auth/me → login.html → тот видит device → шлёт назад).
        refreshed_token = None
        if dev:
            try:
                current_session(request)
            except HTTPException:
                refreshed_token = set_session(response, role="member", name=dev["main_nick"])
        tokens = 0
        gender = ""
        prefer_class = False
        variant = ""
        if acc:
            row = conn.execute("SELECT tokens FROM queue_privileges WHERE canon=?",
                               (acc["main_canon"],)).fetchone()
            tokens = row["tokens"] if row else 0
            grow = conn.execute("SELECT gender FROM queue_gender WHERE canon=?",
                                (acc["main_canon"],)).fetchone()
            gender = (grow["gender"] if grow else "") or ""
            prow = conn.execute("SELECT prefer_class, variant FROM queue_model_pref WHERE canon=?",
                                (acc["main_canon"],)).fetchone()
            prefer_class = bool(prow["prefer_class"]) if prow else False
            variant = (prow["variant"] if (prow and "variant" in prow.keys()) else "") or ""
        # ОФИЦЕР без личного пароля (вошёл по офиц. сессии до нововведения) → надо предложить
        # придумать личный пароль и указать почту, как настроено для всех.
        officer_needs_setup = False
        try:
            s = current_session(request)
        except HTTPException:
            s = None
        if s and s.get("role") == "officer":
            nm = (s.get("name") or "").strip()
            cn = db._valor_canon(nm) if nm else ""
            pp = _people(conn).get(cn)
            mc = pp["main_canon"] if pp else cn
            officer_needs_setup = not (mc and _account_by_main(conn, mc))
        # активная личность (мэйн/твин) + список своих ников (для переключения) — только у игрока
        active_nick, active_canon, identities = "", "", []
        if dev:
            dk = dev.keys()
            active_nick = (dev["active_nick"] if "active_nick" in dk else "") or dev["main_nick"]
            active_canon = (dev["active_canon"] if "active_canon" in dk else "") or dev["main_canon"]
            identities = _own_nicks(_people(conn), dev["main_canon"])
        return {"account": _acc_public(dev) if dev else None, "tokens": tokens,
                "gender": gender, "prefer_class": prefer_class, "variant": variant,
                "active_nick": active_nick, "active_canon": active_canon, "identities": identities,
                "officer_needs_setup": officer_needs_setup, "session_token": refreshed_token}


class SetIdentityIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)


@router.post("/set-identity")
def set_identity(payload: SetIdentityIn, request: Request) -> dict:
    """Игрок выбирает, каким из СВОИХ ников (мэйн или твин) стоять/отображаться в очереди.
    Меняет активную личность и обновляет его существующие записи (место сохраняется)."""
    with db.connection() as conn:
        acc = _account_from_request(conn, request)     # только настоящий игрок (не офицер-сессия)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        idx = _people(conn)
        own = {x["canon"] for x in _own_nicks(idx, acc["main_canon"])}
        tc = db._valor_canon(payload.nick)
        if not tc or tc not in own:                    # можно выбрать ТОЛЬКО свой ник
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "not_your_identity")
        an, acn, _acl = _apply_identity(conn, acc["id"], acc["main_canon"], payload.nick)
        _log(conn, "set_identity", actor=acc["main_nick"], nick=an, request=request,
             detail="стоит как %s (%s)" % (an, "мэйн" if acn == acc["main_canon"] else "твин"))
    return {"ok": True, "active_nick": an, "active_canon": acn}


@router.get("/notices")
def get_notices(request: Request) -> dict:
    """Непрочитанные персональные уведомления игрока (напр. «не хватило доблести»)."""
    import json as _json
    out = []
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if acc:
            for r in conn.execute(
                    "SELECT id, kind, payload, created_at FROM queue_notices"
                    " WHERE canon=? AND seen=0 ORDER BY id DESC", (acc["main_canon"],)):
                try:
                    pl = _json.loads(r["payload"])
                except (ValueError, TypeError):
                    pl = {}
                out.append({"id": r["id"], "kind": r["kind"], "created_at": r["created_at"], "data": pl})
    return {"notices": out}


@router.get("/token-board")
def token_board() -> dict:
    """Держатели жетонов ТОП-3 (для всех): ник + сколько жетонов, по убыванию.
    Публично — видят все пользователи в разделе очереди."""
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT nick, tokens FROM queue_privileges WHERE tokens>0 ORDER BY tokens DESC, nick").fetchall()
    return {"holders": [{"nick": r["nick"], "tokens": r["tokens"]} for r in rows]}


@router.post("/notices/seen")
def mark_notices_seen(request: Request) -> dict:
    """Пометить все уведомления игрока прочитанными (он их увидел)."""
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if acc:
            conn.execute("UPDATE queue_notices SET seen=1 WHERE canon=? AND seen=0",
                         (acc["main_canon"],))
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response) -> dict:
    token = request.cookies.get(COOKIE)
    if token:
        with db.connection() as conn:
            conn.execute("DELETE FROM queue_devices WHERE token=?", (token,))
    response.delete_cookie(COOKIE, path="/", samesite="lax", secure=True)
    return {"ok": True}


@router.get("/admin/shared-password")
def shared_pw_status(_: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        cfg = conn.execute("SELECT shared_password_hash, updated_at FROM queue_config WHERE id=1").fetchone()
        return {"is_set": bool(cfg and cfg["shared_password_hash"]),
                "updated_at": (cfg["updated_at"] if cfg else "")}


@router.post("/admin/shared-password")
def set_shared_pw(payload: SharedPwIn, _: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        conn.execute("UPDATE queue_config SET shared_password_hash=?, updated_at=? WHERE id=1",
                     (_hash(payload.password), _now()))
    return {"ok": True}


# ─────────────────── состояние очередей + лог (Фаза 2) ───────────────────
QUEUES = (0, 1, 2, 3)  # 0 обычные · 1 редкие(R) · 2 легендарные(S) · 3 мифические(SS)
# Ресурсы каждой очереди (порядок = как на витрине). Для обычной/редкой мультивыбор:
# пустой resources у записи → показываем/раздаём ВСЕ ресурсы очереди (по стаку).
_QUEUE_ITEMS = [
    ["kamen-doblesti", "meteorit", "zhemchuzhina", "znak-edinstva", "koloda-kart", "kamen-bessmertnyh", "pilyulya"],
    ["prikaz-feniksa"],   # грамоту убрали из очереди — мастер раздаёт её вручную
    ["drakonya-cheshuya", "sushchnost-karty", "mount-cilin"],   # высший камень перенесён в мифическую (SS)
    ["vysshiy-kamen"],                                          # 3 — Мифические (SS)
]


def _entry_resources(r):
    """Список выбранных ресурсов записи. Пусто в БД → q0/q1 = все ресурсы очереди (мультивыбор
    по умолчанию), q2 = один выбранный. Всегда только валидные ресурсы своей очереди."""
    import json as _json
    q = r["queue"]
    valid = _QUEUE_ITEMS[q] if 0 <= q < len(_QUEUE_ITEMS) else []
    # Привилегированная (жетон ТОП-3, вне очереди) запись берёт РОВНО ОДИН ресурс
    # (r["resource"]), НЕ мультивыбор. Иначе при пустом resources подставились бы ВСЕ
    # ресурсы очереди → над головой клона показывало «ресурс +6», хотя он берёт 1.
    try:
        is_priv = ("privileged" in r.keys()) and r["privileged"]
    except Exception:
        is_priv = False
    if is_priv:
        pres = (r["resource"] or "").strip() if ("resource" in r.keys()) else ""
        return [pres] if pres in valid else ([pres] if pres else [])
    raw = ""
    try:
        raw = r["resources"] if "resources" in r.keys() else ""
    except Exception:
        raw = ""
    lst = []
    if raw:
        try:
            lst = [x for x in _json.loads(raw) if x in valid]
        except (ValueError, TypeError):
            lst = []
    if lst:
        return lst
    if q in (0, 1):
        return list(valid)                      # существующие/без выбора → все ресурсы очереди
    res = (r["resource"] or "").strip() if ("resource" in r.keys()) else ""
    return [res] if res in valid else ([res] if res else [])


def _entry_received(r) -> list:
    """Уже полученные игроком ресурсы (JSON-список ключей) — заблокированы в пикере."""
    import json as _json
    try:
        raw = r["received"] if "received" in r.keys() else ""
    except Exception:
        raw = ""
    if not raw:
        return []
    try:
        return [x for x in _json.loads(raw) if x]
    except (ValueError, TypeError):
        return []

# ── параметры движка распределения (подтверждено Лиром 2026-07-16) ──
# Пороги доблести: обычная ≥60, редкие/легендарные ≥100, мифические (SS) ≥200 (с 2026-W30).
VALOR_THRESHOLD = {0: 60, 1: 100, 2: 100, 3: 200}
# Привилегия проводников: по умолчанию +10% к метеоритам и камням доблести.
SHOOTER_DEFAULT_PCT = 10
# Расписание (МСК): сбор доблести вс 16:00 → авто-сдвиг очереди вс 00:00 СЛЕДУЮЩЕЙ недели.
VALOR_COLLECT_MSK = "16:00"
QUEUE_ADVANCE_MSK = "00:00"
# NB: ядро (D/E) достраивается после получения файла наград (этап КХ → ресурсы/стаки).

_FEMALE_ONLY = {"друид", "стрелок"}
_MALE_ONLY = {"оборотень", "странник"}


def _gender_of(cls: str, true_name: str, override: str) -> str:
    """Пол для подбора модели. Приоритет: явное указание админа → класс с одним
    полом → эвристика по имени (оканч. на а/я/и/ь/е → ж), иначе м."""
    if override in ("m", "f"):
        return override
    c = (cls or "").strip().lower()
    if c in _FEMALE_ONLY:
        return "f"
    if c in _MALE_ONLY:
        return "m"
    nm = (true_name or "").strip().split(" ")[0].lower() if true_name else ""
    if nm and nm[-1] in "аяиье":
        return "f"
    return "m"


def _actor_name(actor: dict) -> str:
    return (actor.get("name") or actor.get("role") or "admin") if actor else "admin"


_PLAN_MAX = 8   # макс. длина плана на будущие недели


def _clean_plan(plan, queue) -> list[str]:
    """Оставляет только валидные ресурсы ЭТОЙ очереди, по порядку, без дублей, ≤ _PLAN_MAX."""
    out: list[str] = []
    for k in (plan or []):
        k = (k or "").strip()[:64]
        r = distribution.REWARDS.get(k)
        if r and r["q"] == queue and k not in out:
            out.append(k)
        if len(out) >= _PLAN_MAX:
            break
    return out


def _log(conn, kind, actor="", nick="", queue=None, request=None, detail=""):
    ip = ua = ""
    if request is not None:
        ip = request.client.host if request.client else ""
        ua = request.headers.get("user-agent", "")[:300]
    conn.execute(
        "INSERT INTO queue_log (at, kind, actor, nick, queue, ip, user_agent, detail)"
        " VALUES (?,?,?,?,?,?,?,?)", (_now(), kind, actor, nick, queue, ip, ua, detail))


def _parse_log_resources(detail: str):
    """Из detail лога join/set_entry достаёт список ресурсов, которые выбрал САМ игрок.
    Формат: 'res=<X> resources=[...]' или 'resources=None' (тогда одиночный res)."""
    import re as _re, ast as _ast
    if not detail:
        return None
    m = _re.search(r"resources=(\[[^\]]*\]|None)", detail)
    if m and m.group(1) != "None":
        try:
            lst = _ast.literal_eval(m.group(1))
            if isinstance(lst, list) and lst:
                return [str(x) for x in lst]
        except (ValueError, SyntaxError):
            pass
    m2 = _re.search(r"\bres=(\S+)", detail)          # одиночный ресурс (q2/старый выбор)
    if m2 and m2.group(1) not in ("—", "-", "None"):
        return [m2.group(1)]
    return None


def _own_nicks(idx, main_canon) -> list[dict]:
    """Все ники ОДНОГО человека (его мэйн + все твины) для главного канона main_canon.
    [{nick, canon, cls, is_main}] — мэйн первым. Твины = записи с тем же main_canon."""
    out = []
    for cn, p in idx.items():
        if p.get("main_canon") == main_canon:
            out.append({"nick": p.get("nick", "") or cn, "canon": cn,
                        "cls": p.get("cls", ""), "is_main": (cn == main_canon)})
    out.sort(key=lambda x: (not x["is_main"], (x["nick"] or "").lower()))
    return out


def _active_identity(idx, main_canon, typed_nick):
    """(active_nick, active_canon, active_cls) для выбранной личности. Если typed_nick —
    свой ник (мэйн или твин этого же main_canon), берём его; иначе — мэйн (безопасный дефолт)."""
    tc = db._valor_canon(typed_nick or "")
    p = idx.get(tc)
    if tc and p and p.get("main_canon") == main_canon:
        return (p.get("nick") or typed_nick, tc, p.get("cls", ""))
    mp = idx.get(main_canon) or {}
    return ((mp.get("nick") or main_canon), main_canon, mp.get("cls", ""))


def _apply_identity(conn, acc_id: int, main_canon: str, typed_nick: str):
    """Ставит выбранную личность (мэйн/твин) аккаунту и ОБНОВЛЯЕТ его записи в очередях
    (ник/класс/активный канон) — место в очереди сохраняется. Возвращает (nick, canon, cls)."""
    idx = _people(conn)
    an, acn, acl = _active_identity(idx, main_canon, typed_nick)
    conn.execute("UPDATE queue_accounts SET active_nick=?, active_canon=? WHERE id=?",
                 (an, acn, acc_id))
    # обновляем все текущие записи этого человека (обычную и привилегированную во всех очередях)
    conn.execute("UPDATE queue_entries SET active_canon=?, nick=?, cls=? WHERE main_canon=?",
                 (acn, an, acl, main_canon))
    return an, acn, acl


def _recipient_ok(rcpt, main_canon, idx, smap) -> bool:
    """True если получатель — твин (тот же мэйн) или супруг (связка); пусто → True."""
    if not rcpt:
        return True
    rc = db._valor_canon(rcpt)
    rp = idx.get(rc)
    if rp and rp.get("main_canon") == main_canon:      # твин: тот же мэйн-аккаунт
        return True
    spouse = (smap or {}).get(main_canon, "")           # супруг: связка
    return bool(spouse and db._valor_canon(spouse) == rc)


def _migrate_recipients(conn) -> int:
    """Разовая миграция: у кого в очереди уже указан получатель, который НЕ твин и НЕ супруг —
    НЕ удаляем связь, а закрепляем её как супруга (если это твин — он и так распознан по мэйну,
    связку не создаём). Так все прежние получатели становятся «разрешёнными». Идемпотентна."""
    if _cfg_val(conn, "recipients_migrated_v1", "") == "1":
        return 0
    idx = _people(conn)
    smap = _spouse_map(conn)
    made = 0
    seen: set[str] = set()
    for r in conn.execute("SELECT main_canon, recipient FROM queue_entries WHERE recipient!=''"):
        mc, rcpt = r["main_canon"], (r["recipient"] or "").strip()
        if not rcpt or mc in seen:
            continue
        # резолвим отправителя к реальному мэйну (усечённый/латиница)
        p = idx.get(mc)
        if p is None:
            res = _resolve_partial(idx, mc)
            if res:
                mc, p = res[0], res[1]
        real_mc = (p["main_canon"] if p else mc)
        if _recipient_ok(rcpt, real_mc, idx, smap):        # уже твин/супруг — ничего не делаем
            continue
        conn.execute(
            "INSERT INTO queue_spouses (canon, recipient, updated_by, updated_at) VALUES (?,?,?,?)"
            " ON CONFLICT(canon) DO UPDATE SET recipient=excluded.recipient,"
            " updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            (real_mc, rcpt, "миграция", _now()))
        smap[real_mc] = rcpt
        seen.add(real_mc)
        made += 1
    conn.execute(
        "INSERT INTO queue_kv (key, val, updated_at) VALUES ('recipients_migrated_v1','1',?)"
        " ON CONFLICT(key) DO UPDATE SET val='1', updated_at=excluded.updated_at", (_now(),))
    return made


def _entry_public(r, idx, gmap, smap=None, pmap=None, shooters_canon=None, tmap=None, vmap=None) -> dict:
    # Запись не совпала с реестром точно (ввели неполный/усечённый ник, напр. «Ада», или
    # набрали латиницей «SnegoVik» вместо «СнегоVик») — резолвим: точно → префикс →
    # транслитерация (однозначно). Покажем канонический ник/класс/модель как в базе.
    mc = r["main_canon"]
    p = idx.get(mc)
    if p is None:
        res = _resolve_partial(idx, mc)
        if res:
            mc, p = res[0], res[1]
    if p is None and tmap:                          # латиница↔кириллица (только однозначно)
        rc = tmap.get(_translit_canon(r["nick"]))
        if rc and rc in idx:
            mc, p = rc, idx[rc]
    p = p or {}
    keys = r.keys()
    # АКТИВНАЯ ЛИЧНОСТЬ: кем игрок выбрал стоять — мэйн ИЛИ его твин. Пусто/чужой → мэйн.
    ac = (r["active_canon"] if "active_canon" in keys else "") or ""
    dp = idx.get(ac) if ac else None
    if dp is None or dp.get("main_canon") != mc:       # защита: активный ник должен быть свой
        dp, ac = p, mc
    # ник/класс для показа — по активной личности; иначе сохранённый при вставании
    disp_nick = dp.get("nick") or r["nick"]
    cls = r["cls"] or dp.get("cls", "") or p.get("cls", "")
    tn = p.get("true_name", "")
    # РОДНЯ (админу/офицеру): остальные ники этого человека — мэйн + твины, кроме активного
    kin = []
    for _cn, _pp in idx.items():
        if _pp.get("main_canon") == mc and _cn != ac:
            kin.append({"nick": _pp.get("nick", "") or _cn, "cls": _pp.get("cls", ""),
                        "is_main": (_cn == mc)})
    kin.sort(key=lambda x: (not x["is_main"], (x["nick"] or "").lower()))
    rcpt = r["recipient"] if "recipient" in keys else ""
    import json as _json
    try:
        plan = _json.loads(r["auto_plan"]) if ("auto_plan" in keys and r["auto_plan"]) else []
    except (ValueError, TypeError):
        plan = []
    return {"id": r["id"], "nick": disp_nick, "cls": cls,
            "main_nick": p.get("main_nick", r["nick"]), "true_name": tn,
            "kin": kin, "active_canon": ac,
            "gender": _gender_of(cls, tn, gmap.get(mc, "")),
            "gender_by": ("manual" if gmap.get(mc) in ("m", "f") else "auto"),
            "prefer_class": bool((pmap or {}).get(mc, 0)),
            "variant": ((vmap or {}).get(mc, "") or ""),
            "is_shooter": bool(shooters_canon and (mc in shooters_canon
                               or db._valor_canon(disp_nick) in shooters_canon)),
            "resource": (r["resource"] if "resource" in keys else ""),
            "resources": _entry_resources(r),
            "received": _entry_received(r),
            "recipient": rcpt,
            "recipient_ok": _recipient_ok(rcpt, mc, idx, smap),
            "auto_repeat": (bool(r["auto_repeat"]) if "auto_repeat" in keys else False),
            "auto_plan": plan,
            "not_collected": (bool(r["not_collected"]) if "not_collected" in keys else False),
            "privileged": (bool(r["privileged"]) if "privileged" in keys else False),
            "priv_stacks": (r["priv_stacks"] if "priv_stacks" in keys else 0),
            "added_by": r["added_by"]}


def _append_pos(conn, q) -> float:
    row = conn.execute("SELECT MAX(pos) m FROM queue_entries WHERE queue=?", (q,)).fetchone()
    return (row["m"] or 0.0) + 1.0


def _pos_for_index(conn, q, index, exclude=None) -> float:
    rows = [r for r in conn.execute(
        "SELECT id, pos FROM queue_entries WHERE queue=? ORDER BY pos, id", (q,)).fetchall()
        if r["id"] != exclude]
    pos = [r["pos"] for r in rows]
    n = len(pos)
    if index <= 0:
        return (pos[0] - 1.0) if pos else 1.0
    if index >= n:
        return (pos[-1] + 1.0) if pos else 1.0
    return (pos[index - 1] + pos[index]) / 2.0


@router.get("/roster")
def roster() -> dict:
    with db.connection() as conn:
        idx = _people(conn)
    out = [{"nick": p["nick"], "cls": p["cls"], "true_name": p.get("true_name", ""),
            "main_nick": p["main_nick"], "is_twin": p["is_twin"]} for p in idx.values()]
    out.sort(key=lambda e: e["nick"].lower())
    return {"roster": out}


def _spouse_map(conn) -> dict:
    return {r["canon"]: r["recipient"]
            for r in conn.execute("SELECT canon, recipient FROM queue_spouses")}


@router.get("/state")
def state() -> dict:
    qs = [[], [], [], []]
    with db.connection() as conn:
        try:
            _migrate_recipients(conn)      # разово: прежние получатели → супруги (идемпотентно)
        except Exception:
            pass
        idx = _people(conn)
        gmap = {r["canon"]: r["gender"]
                for r in conn.execute("SELECT canon, gender FROM queue_gender")}
        pmap = {r["canon"]: r["prefer_class"]
                for r in conn.execute("SELECT canon, prefer_class FROM queue_model_pref")}
        vmap = {r["canon"]: (r["variant"] or "")
                for r in conn.execute("SELECT canon, variant FROM queue_model_pref")}
        import json as _json
        try:
            _sh = [s for s in _json.loads(_cfg_val(conn, "shooters", "[]")) if s]
        except (ValueError, TypeError):
            _sh = []
        shooters_canon = {db._valor_canon(s) for s in _sh if db._valor_canon(s)}
        tmap = _build_translit_map(idx)   # латиница↔кириллица (однозначно) для «SnegoVik» и т.п.
        smap = _spouse_map(conn)
        for r in conn.execute("SELECT * FROM queue_entries ORDER BY queue, pos, id"):
            if r["queue"] in QUEUES:
                qs[r["queue"]].append(_entry_public(r, idx, gmap, smap, pmap, shooters_canon, tmap, vmap))
    return {"queues": qs}


@router.post("/join")
def join(payload: JoinIn, request: Request) -> dict:
    q = payload.queue
    if q not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        # Обычное место в очереди (privileged=0). Привилегированную запись (жетон ТОП-3)
        # НЕ учитываем — она отдельная и живёт параллельно, не мешает встать обычным местом.
        if conn.execute("SELECT 1 FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
                        (q, acc["main_canon"])).fetchone():
            raise HTTPException(status.HTTP_409_CONFLICT, "already_in_queue")
        idx = _people(conn)
        p = idx.get(acc["main_canon"]) or {}
        # АКТИВНАЯ ЛИЧНОСТЬ: кем игрок выбрал стоять (мэйн/твин). Дефолт — мэйн.
        _ac = (acc.get("active_canon") or "") if isinstance(acc, dict) else ""
        _ap = idx.get(_ac) if _ac else None
        if _ap is None or _ap.get("main_canon") != acc["main_canon"]:
            _ap, _ac = p, acc["main_canon"]
        nick = (_ap.get("nick") or (acc.get("active_nick") if isinstance(acc, dict) else "")
                or acc["main_nick"] or acc["reg_nick"])
        ent_cls = _ap.get("cls", "") or p.get("cls", "")
        res = (payload.resource or "").strip()[:64]
        rcpt = (payload.recipient or "").strip()[:64]
        if not rcpt:   # не указан явно → берём получателя по умолчанию из связки супругов
            sp = conn.execute("SELECT recipient FROM queue_spouses WHERE canon=?",
                              (acc["main_canon"],)).fetchone()
            rcpt = (sp["recipient"] if sp else "")[:64]
        # ЗАПРЕТ: передавать можно ТОЛЬКО твину или супругу. Иначе — не сохраняем получателя.
        if rcpt and not _recipient_ok(rcpt, acc["main_canon"], _people(conn), _spouse_map(conn)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "recipient_not_linked")
        import json as _json
        plan = _clean_plan(payload.plan, q)
        # мульти-выбор: только валидные ресурсы своей очереди; resource = первый (совместимость)
        valid = _QUEUE_ITEMS[q] if 0 <= q < len(_QUEUE_ITEMS) else []
        picked = [x for x in (payload.resources or []) if x in valid]
        if not picked and res in valid:
            picked = [res]
        if picked:
            res = picked[0]
        conn.execute(
            "INSERT INTO queue_entries (queue, pos, main_canon, active_canon, nick, cls, resource, resources,"
            " recipient, auto_repeat, auto_plan, added_by, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (q, _append_pos(conn, q), acc["main_canon"], _ac, nick, ent_cls, res, _json.dumps(picked), rcpt,
             1 if payload.auto_repeat else 0, _json.dumps(plan), "self", _now()))
        _log(conn, "join", actor=nick, nick=nick, queue=q, request=request,
             detail=("res=%s resources=%r%s%s%s" % (
                 res, picked, (" →" + rcpt if rcpt else ""),
                 (" 🔁" if payload.auto_repeat else ""),
                 (" план:%d" % len(plan) if plan else ""))))
    return {"ok": True}


@router.post("/leave")
def leave(payload: JoinIn, request: Request) -> dict:
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        # Выходим ТОЛЬКО из обычного места (privileged=0). Привилегированная запись
        # (жетон ТОП-3) отдельная; при выходе из неё ВОЗВРАЩАЕМ потраченные жетоны,
        # чтобы человек их не терял (жетон вернётся ему обратно).
        priv = 1 if getattr(payload, "privileged", False) else 0
        if priv:
            # Возврат жетонов ТОЛЬКО если запись реально удалена этим запросом
            # (rowcount>0) — защита от двойного возврата при гонке/двойном клике.
            row = conn.execute(
                "SELECT priv_stacks FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=1",
                (payload.queue, acc["main_canon"])).fetchone()
            stacks = row["priv_stacks"] if row else 0
            cur = conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=1",
                               (payload.queue, acc["main_canon"]))
            if cur.rowcount > 0 and stacks > 0:
                conn.execute("UPDATE queue_privileges SET tokens=tokens+?, updated_at=? WHERE canon=?",
                             (stacks, _now(), acc["main_canon"]))
            _dn = 0
        else:
            _cur = conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
                                (payload.queue, acc["main_canon"]))
            _dn = _cur.rowcount
        _log(conn, "leave", actor=acc["main_nick"], nick=acc["main_nick"],
             queue=payload.queue, request=request,
             detail=("priv=%d удалено=%d %s" % (priv, (cur.rowcount if priv else _dn),
                     "жетон (возвращён)" if priv else "обычное место")))
    return {"ok": True}


@router.post("/set-entry")
def set_entry(payload: SetEntryIn, request: Request) -> dict:
    """Игрок меняет ресурс и/или получателя своей записи, пока стоит в очереди."""
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        # Обычная или привилегированная (жетон) запись — они живут параллельно, меняем нужную.
        want_priv = 1 if payload.privileged else 0
        row = conn.execute(
            "SELECT id, privileged FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=?",
            (payload.queue, acc["main_canon"], want_priv)).fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_in_queue")
        sets, vals = [], []
        if payload.resource is not None:
            new_res = payload.resource.strip()[:64]
            # у привилегированной записи (взял жетоном) можно менять ресурс, но только
            # на другой ОБЫЧНЫЙ стаковый — объём захвата пересчитается сам (priv_stacks × пачка)
            if row["privileged"]:
                rr = distribution.REWARDS.get(new_res)
                if not rr or rr["q"] != 0 or rr["mode"] == "pack":
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "only_regular_stack")
            sets.append("resource=?"); vals.append(new_res)
        if payload.resources is not None and not row["privileged"]:   # мульти-выбор (обычная/редкая)
            valid = _QUEUE_ITEMS[payload.queue] if 0 <= payload.queue < len(_QUEUE_ITEMS) else []
            picked = [x for x in payload.resources if x in valid]
            if not picked:
                # Игрок снял ВСЕ галочки-ресурсы → это выход из очереди. Раньше пустой
                # список молча игнорировался (галочка «зависала», сохранить не срабатывало).
                cur = conn.execute("DELETE FROM queue_entries WHERE id=?", (row["id"],))
                _log(conn, "leave", actor=acc["main_nick"], nick=acc["main_nick"],
                     queue=payload.queue, request=request,
                     detail="сняты все ресурсы → выход из очереди (set-entry resources=%r, удалено %d)"
                            % (list(payload.resources or []), cur.rowcount))
                return {"ok": True, "left": True}
            import json as _jsonr
            sets.append("resources=?"); vals.append(_jsonr.dumps(picked))
            sets.append("resource=?"); vals.append(picked[0])   # resource = первый (совместимость)
        if payload.recipient is not None:
            _rcpt = payload.recipient.strip()[:64]
            if _rcpt and not _recipient_ok(_rcpt, acc["main_canon"], _people(conn), _spouse_map(conn)):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "recipient_not_linked")
            sets.append("recipient=?"); vals.append(_rcpt)
        if payload.auto_repeat is not None:
            sets.append("auto_repeat=?"); vals.append(1 if payload.auto_repeat else 0)
        if payload.plan is not None:
            import json as _json
            sets.append("auto_plan=?"); vals.append(_json.dumps(_clean_plan(payload.plan, payload.queue)))
        _res_in = (list(payload.resources) if payload.resources is not None else None)
        if sets:
            vals.append(row["id"])
            conn.execute("UPDATE queue_entries SET " + ",".join(sets) + " WHERE id=?", vals)
            _log(conn, "set_entry", actor=acc["main_nick"], nick=acc["main_nick"],
                 queue=payload.queue, request=request,
                 detail=("priv=%d res=%s resources=%r →%s%s поля:%s" % (
                     want_priv, (payload.resource or "—"), _res_in, (payload.recipient or "—"),
                     ("" if payload.auto_repeat is None else (" 🔁" if payload.auto_repeat else " 🚫🔁")),
                     ",".join(s.split("=")[0] for s in sets))))
        else:
            # Ничего не поменялось — логируем, чтобы «сохранить не сработало» было видно в логах.
            _log(conn, "set_entry_noop", actor=acc["main_nick"], nick=acc["main_nick"],
                 queue=payload.queue, request=request,
                 detail="нет изменений (priv=%d res=%r resources=%r rcpt=%r)" % (
                     want_priv, payload.resource, _res_in, payload.recipient))
    return {"ok": True}


@router.get("/spouses")
def spouses() -> dict:
    """Связки канон→получатель. links — карта (для префилла), items — с никами (для панели)."""
    with db.connection() as conn:
        idx = _people(conn)
        try:
            rows = conn.execute(
                "SELECT canon, recipient, role FROM queue_spouses WHERE recipient!=''").fetchall()
        except Exception:
            rows = conn.execute(
                "SELECT canon, recipient FROM queue_spouses WHERE recipient!=''").fetchall()
    canon2nick = {p["main_canon"]: p["main_nick"] for p in idx.values()}
    def _role(r):
        try: return r["role"] or ""
        except Exception: return ""
    links = {r["canon"]: r["recipient"] for r in rows}
    roles = {r["canon"]: _role(r) for r in rows}
    items = [{"canon": r["canon"], "nick": canon2nick.get(r["canon"], r["canon"]),
              "recipient": r["recipient"], "role": _role(r)} for r in rows]
    items.sort(key=lambda e: (e["nick"] or "").lower())
    return {"links": links, "roles": roles, "items": items}


@router.post("/spouse")
def set_spouse(payload: SpouseIn, request: Request,
               actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Связка «кому этот человек передаёт рес». Доступно офицеру И админу."""
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        cn = p["main_canon"] if p else db._valor_canon(payload.nick)
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        rcpt = (payload.recipient or "").strip()[:64]
        role = payload.role if payload.role in ("husband", "wife") else ""
        if rcpt:
            conn.execute(
                "INSERT INTO queue_spouses (canon, recipient, role, updated_by, updated_at) VALUES (?,?,?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET recipient=excluded.recipient, role=excluded.role,"
                " updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (cn, rcpt, role, _actor_name(actor), _now()))
        else:
            conn.execute("DELETE FROM queue_spouses WHERE canon=?", (cn,))
        _rl = {"husband": " (муж)", "wife": " (жена)"}.get(role, "")
        _log(conn, "spouse", actor=_actor_name(actor), nick=payload.nick,
             request=request, detail="→" + (rcpt + _rl if rcpt else "(удалено)"))
    return {"ok": True, "recipient": rcpt, "role": role}


@router.get("/twins")
def twins(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Твин-связи для панели: manual — заданные вручную офицером/админом; auto — определённые
    автоматически по титулу ~Мэйн~ (для просмотра). Доступно офицеру и админу."""
    with db.connection() as conn:
        idx = _people(conn)
        man = conn.execute(
            "SELECT canon, main_nick, twin_nick FROM queue_twins ORDER BY main_nick, twin_nick").fetchall()
        man_c = {r["canon"] for r in man}
    canon2nick = {c: p["nick"] for c, p in idx.items()}
    manual = [{"twin_nick": (canon2nick.get(r["canon"]) or r["twin_nick"] or r["canon"]),
               "main_nick": r["main_nick"], "canon": r["canon"]} for r in man]
    auto = [{"twin_nick": p["nick"], "main_nick": p["main_nick"]}
            for c, p in idx.items()
            if p.get("is_twin") and "manual" not in p.get("sources", set()) and c not in man_c]
    auto.sort(key=lambda e: ((e["main_nick"] or "").lower(), (e["twin_nick"] or "").lower()))
    return {"manual": manual, "auto": auto}


@router.post("/twin")
def set_twin(payload: TwinIn, request: Request,
             actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Ручная привязка ника-твина к мэйну (или снятие, если main_nick пустой). Офицер/админ."""
    with db.connection() as conn:
        idx = _people(conn)
        tc = db._valor_canon(payload.nick)
        if not tc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        mn_in = (payload.main_nick or "").strip()
        if not mn_in:                                   # снять ручную привязку
            conn.execute("DELETE FROM queue_twins WHERE canon=?", (tc,))
            _log(conn, "twin", actor=_actor_name(actor), nick=payload.nick, request=request, detail="(снята)")
            return {"ok": True, "main_nick": ""}
        mp = idx.get(db._valor_canon(mn_in))
        mmc = (mp["main_canon"] if mp else db._valor_canon(mn_in))
        mmn = (mp["main_nick"] if mp else mn_in)
        if not mmc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_main")
        # mmc == tc → ЗАФИКСИРОВАТЬ как мэйн (снять ошибочный авто-твин): записываем self.
        tp = idx.get(tc)
        twin_nick = tp["nick"] if tp else payload.nick.strip()
        conn.execute(
            "INSERT INTO queue_twins (canon, main_canon, main_nick, twin_nick, updated_by, updated_at)"
            " VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(canon) DO UPDATE SET main_canon=excluded.main_canon, main_nick=excluded.main_nick,"
            " twin_nick=excluded.twin_nick, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            (tc, mmc, mmn, twin_nick, _actor_name(actor), _now()))
        _log(conn, "twin", actor=_actor_name(actor), nick=payload.nick, request=request,
             detail="твин → мэйн " + mmn)
    return {"ok": True, "main_nick": mmn}


@router.post("/link-request")
def link_request(payload: LinkRequestIn, request: Request) -> dict:
    """Игрок просит офицеров ПОДТВЕРДИТЬ связь с получателем (твин/супруг), если система её
    ещё не знает. Создаёт запрос, который увидят все офицеры и админ."""
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        idx = _people(conn)
        fmc, fnick = acc["main_canon"], (acc["main_nick"] or acc["reg_nick"])
        tp = idx.get(db._valor_canon(payload.recipient))
        if not tp:                                   # получатель должен быть реальным игроком
            raise HTTPException(status.HTTP_404_NOT_FOUND, "recipient_not_found")
        tmc, tnick = tp["main_canon"], tp["nick"]
        if tmc == fmc:                               # уже один и тот же аккаунт/твин
            return {"ok": True, "already_linked": True}
        if _recipient_ok(payload.recipient, fmc, idx, _spouse_map(conn)):
            return {"ok": True, "already_linked": True}
        # не плодим дубликаты pending на ту же пару
        ex = conn.execute(
            "SELECT id FROM queue_link_requests WHERE from_canon=? AND target_canon=? AND status='pending'",
            (fmc, tmc)).fetchone()
        if ex:
            return {"ok": True, "pending": True, "id": ex["id"]}
        cur = conn.execute(
            "INSERT INTO queue_link_requests (from_canon, from_nick, target_canon, target_nick, status, created_at)"
            " VALUES (?,?,?,?, 'pending', ?)", (fmc, fnick, tmc, tnick, _now()))
        _log(conn, "link_request", actor=fnick, nick=fnick, request=request,
             detail="просит подтвердить связь с " + tnick)
        return {"ok": True, "id": cur.lastrowid}


def _link_issues(idx) -> list:
    """Логические противоречия в связях (для уведомлений офицерам/админу):
    аккаунт помечен ТВИНОМ, но при этом сам является МЭЙНОМ для других (кто-то указывает на него).
    Напр. если у LiXin в титуле мэйн Мortаlitу, а у кого-то ещё мэйн LiXin — это надо разрулить."""
    is_main_of: dict[str, list] = {}
    for cn, p in idx.items():
        if p.get("is_twin") and p.get("main_canon"):
            is_main_of.setdefault(p["main_canon"], []).append(p.get("nick", cn))
    issues = []
    for cn, p in idx.items():
        if p.get("is_twin") and cn in is_main_of:
            issues.append({
                "nick": p.get("nick", cn),
                "main_nick": p.get("main_nick", ""),          # чьим твином помечен
                "also_main_of": is_main_of[cn][:6],           # но сам мэйн для этих
                "canon": cn,
            })
    return issues[:20]


@router.get("/link-requests")
def link_requests(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Для офицеров/админа: ожидающие запросы (боковые окошки) + недавно решённые + логические
    противоречия связей (twin-but-also-main), чтобы офицеры их исправили."""
    import datetime as _dt
    cutoff = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=3)).isoformat(timespec="seconds")
    with db.connection() as conn:
        idx = _people(conn)
        pend = conn.execute(
            "SELECT id, from_nick, target_nick, created_at FROM queue_link_requests"
            " WHERE status='pending' ORDER BY id").fetchall()
        dec = conn.execute(
            "SELECT id, from_nick, target_nick, status, decided_by, decided_at FROM queue_link_requests"
            " WHERE status!='pending' AND decided_at>=? ORDER BY id", (cutoff,)).fetchall()
    return {"requests": [dict(r) for r in pend], "decided": [dict(r) for r in dec],
            "issues": _link_issues(idx)}


@router.get("/link-requests/mine")
def link_requests_mine(request: Request) -> dict:
    """Статусы моих запросов (для игрока — увидеть, что офицер подтвердил/отклонил)."""
    out = []
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if acc:
            for r in conn.execute(
                    "SELECT id, target_nick, status, decided_by FROM queue_link_requests"
                    " WHERE from_canon=? ORDER BY id DESC LIMIT 8", (acc["main_canon"],)):
                out.append(dict(r))
    return {"requests": out}


@router.post("/link-request/decide")
def link_request_decide(payload: LinkDecideIn, request: Request,
                        actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Офицер/админ подтверждает связь как ТВИН или СУПРУГ, либо отклоняет. Создаёт связь,
    запоминает кто подтвердил. Если запрос уже решён кем-то — возвращаем, кем именно."""
    who = _actor_name(actor)
    with db.connection() as conn:
        row = conn.execute("SELECT * FROM queue_link_requests WHERE id=?", (payload.id,)).fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
        if row["status"] != "pending":               # уже кто-то решил
            return {"ok": True, "already": True, "status": row["status"], "decided_by": row["decided_by"]}
        idx = _people(conn)
        fmc, tmc = row["from_canon"], row["target_canon"]
        fp, tp = idx.get(fmc), idx.get(tmc)
        dec = payload.decision
        if dec == "twin":
            # получатель (target) — твин мэйна отправителя (общий мэйн). Привязываем target к мэйну from.
            anchor_mc = (fp["main_canon"] if fp else fmc)
            anchor_mn = (fp["main_nick"] if fp else row["from_nick"])
            twin_nick = tp["nick"] if tp else row["target_nick"]
            if anchor_mc and tmc and anchor_mc != tmc:
                conn.execute(
                    "INSERT INTO queue_twins (canon, main_canon, main_nick, twin_nick, updated_by, updated_at)"
                    " VALUES (?,?,?,?,?,?) ON CONFLICT(canon) DO UPDATE SET main_canon=excluded.main_canon,"
                    " main_nick=excluded.main_nick, twin_nick=excluded.twin_nick,"
                    " updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                    (tmc, anchor_mc, anchor_mn, twin_nick, who, _now()))
            new_status = "twin"
        elif dec == "spouse":
            conn.execute(
                "INSERT INTO queue_spouses (canon, recipient, updated_by, updated_at) VALUES (?,?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET recipient=excluded.recipient,"
                " updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (fmc, row["target_nick"], who, _now()))
            new_status = "spouse"
        else:
            new_status = "rejected"
        conn.execute("UPDATE queue_link_requests SET status=?, decided_by=?, decided_at=? WHERE id=?",
                     (new_status, who, _now(), payload.id))
        _log(conn, "link_decide", actor=who, nick=row["from_nick"], request=request,
             detail=new_status + " (" + row["from_nick"] + " ↔ " + row["target_nick"] + ")")
    return {"ok": True, "status": new_status, "decided_by": who}


@router.post("/admin/add")
def admin_add(payload: AdminAddIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        if not p:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        # не плодим дубли обычного места (privileged=0) — как в join/join-as
        if conn.execute("SELECT 1 FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
                        (payload.queue, p["main_canon"])).fetchone():
            raise HTTPException(status.HTTP_409_CONFLICT, "already_in_queue")
        conn.execute(
            "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, added_by, added_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (payload.queue, _pos_for_index(conn, payload.queue, payload.position),
             p["main_canon"], p["nick"], p["cls"], "admin:" + _actor_name(actor), _now()))
        _log(conn, "admin_add", actor=_actor_name(actor), nick=p["nick"], queue=payload.queue,
             request=request, detail="pos=%s" % payload.position)
    return {"ok": True}


@router.post("/admin/remove")
def admin_remove(payload: EntryIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        r = conn.execute("SELECT nick, queue FROM queue_entries WHERE id=?", (payload.entry_id,)).fetchone()
        conn.execute("DELETE FROM queue_entries WHERE id=?", (payload.entry_id,))
        if r:
            _log(conn, "admin_remove", actor=_actor_name(actor), nick=r["nick"],
                 queue=r["queue"], request=request)
    return {"ok": True}


@router.post("/admin/move")
def admin_move(payload: MoveIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        r = conn.execute("SELECT nick FROM queue_entries WHERE id=?", (payload.entry_id,)).fetchone()
        if not r:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "entry_not_found")
        pos = _pos_for_index(conn, payload.queue, payload.position, exclude=payload.entry_id)
        conn.execute("UPDATE queue_entries SET queue=?, pos=? WHERE id=?",
                     (payload.queue, pos, payload.entry_id))
        _log(conn, "admin_move", actor=_actor_name(actor), nick=r["nick"], queue=payload.queue,
             request=request, detail="pos=%s" % payload.position)
    return {"ok": True}


@router.post("/admin/set-entry")
def admin_set_entry(payload: AdminSetEntryIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Админ меняет ресурс(ы) любой записи в очереди по её id."""
    with db.connection() as conn:
        row = conn.execute("SELECT id, queue, nick, privileged FROM queue_entries WHERE id=?",
                           (payload.entry_id,)).fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "entry_not_found")
        sets, vals = [], []
        if payload.resources is not None and not row["privileged"]:
            valid = _QUEUE_ITEMS[row["queue"]] if 0 <= row["queue"] < len(_QUEUE_ITEMS) else []
            picked = [x for x in payload.resources if x in valid]
            if picked:
                import json as _json
                sets.append("resources=?"); vals.append(_json.dumps(picked))
                sets.append("resource=?"); vals.append(picked[0])
        elif payload.resource is not None:
            sets.append("resource=?"); vals.append(payload.resource.strip()[:64])
        if sets:
            vals.append(payload.entry_id)
            conn.execute("UPDATE queue_entries SET " + ",".join(sets) + " WHERE id=?", vals)
            _log(conn, "admin_set_entry", actor=_actor_name(actor), nick=row["nick"],
                 queue=row["queue"], request=request, detail="ресурсы")
    return {"ok": True}


@router.get("/admin/self-picks")
def admin_self_picks(actor: dict = Depends(require_admin)) -> dict:
    """АДМИНУ: какие ресурсы каждый игрок в очереди выбрал САМ (по логам join/set_entry),
    а не проставил админ (join_as/admin_set_entry). Ключ ответа — id текущей записи очереди,
    значение — список self-выбранных ресурсов (последний собственный выбор игрока для этой очереди)."""
    with db.connection() as conn:
        idx = _people(conn)
        # canon любого ника (мэйн/твин) → мэйн-канон человека
        nick2main: dict[str, str] = {}
        for cn, p in idx.items():
            mc = p.get("main_canon") or cn
            nick2main[cn] = mc
            dn = p.get("nick") or ""
            if dn:
                cdn = db._valor_canon(dn)
                if cdn:
                    nick2main[cdn] = mc
        # последний СОБСТВЕННЫЙ выбор игрока по (мэйн-канон, очередь)
        selfmap: dict[tuple, list] = {}
        for lg in conn.execute(
                "SELECT actor, queue, detail FROM queue_log "
                "WHERE kind IN ('join','set_entry') ORDER BY at"):
            mc = nick2main.get(db._valor_canon(lg["actor"] or ""))
            if not mc:
                continue
            res = _parse_log_resources(lg["detail"] or "")
            if res is None:
                continue
            selfmap[(mc, lg["queue"])] = res     # позже по времени → перезаписывает (последний выбор)
        out: dict[str, list] = {}
        for r in conn.execute(
                "SELECT id, main_canon, queue FROM queue_entries WHERE privileged=0"):
            picks = selfmap.get((r["main_canon"], r["queue"]))
            if picks is not None:
                out[str(r["id"])] = picks
    return {"picks": out}


@router.post("/admin/clear")
def admin_clear(payload: ClearIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        if payload.queue is None:
            conn.execute("DELETE FROM queue_entries")
            _log(conn, "admin_clear", actor=_actor_name(actor), request=request, detail="all")
        else:
            conn.execute("DELETE FROM queue_entries WHERE queue=?", (payload.queue,))
            _log(conn, "admin_clear", actor=_actor_name(actor), queue=payload.queue, request=request)
    return {"ok": True}


@router.get("/models")
def models() -> dict:
    with db.connection() as conn:
        rows = conn.execute("SELECT model_key, flip, rotate, scale, aura FROM queue_models").fetchall()
    return {"settings": {r["model_key"]: {"flip": r["flip"], "rotate": r["rotate"],
                                          "scale": r["scale"],
                                          "aura": (r["aura"] if "aura" in r.keys() else "") or ""} for r in rows}}


@router.post("/admin/model")
def set_model(payload: ModelIn, _: dict = Depends(require_admin)) -> dict:
    flip = 1 if payload.flip else 0
    rot = max(-180, min(180, int(payload.rotate)))
    scl = max(0.2, min(3.0, float(payload.scale)))
    aura = payload.aura if payload.aura in ("death",) else ""
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO queue_models (model_key, flip, rotate, scale, aura, updated_at) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(model_key) DO UPDATE SET flip=excluded.flip,"
            " rotate=excluded.rotate, scale=excluded.scale, aura=excluded.aura, updated_at=excluded.updated_at",
            (payload.key, flip, rot, scl, aura, _now()))
    return {"ok": True}


@router.post("/admin/model-upload")
def model_upload(payload: ModelUploadIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Загрузка картинки модели (персональной 'person-<canon>' или классовой
    'class-<Класс>-<m|f>'). Хранится на томе /data, отдаётся через /queue/model-img."""
    key = _safe_key(payload.key)
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_key")
    m = re.match(r"^data:(image/(?:png|jpeg|webp));base64,(.+)$", payload.data, re.S)
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_image")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_base64")
    if len(raw) > 5_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_big")
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for old in _UPLOAD_DIR.glob(key + ".*"):        # заменяем прежнюю
        try:
            old.unlink()
        except OSError:
            pass
    (_UPLOAD_DIR / (key + "." + _IMG_EXT[m.group(1)])).write_bytes(raw)
    with db.connection() as conn:
        _log(conn, "model_upload", actor=_actor_name(actor), request=request,
             detail=key + " (%d КБ)" % (len(raw) // 1024))
    return {"ok": True, "key": key}


def _save_model_image(key: str, data_url: str) -> str:
    """Сохранить dataURL-картинку под ключом на томе. Возвращает key или бросает HTTPException."""
    key = _safe_key(key)
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_key")
    m = re.match(r"^data:(image/(?:png|jpeg|webp));base64,(.+)$", data_url or "", re.S)
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_image")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_base64")
    if len(raw) > 5_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_big")
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for old in _UPLOAD_DIR.glob(key + ".*"):
        try:
            old.unlink()
        except OSError:
            pass
    (_UPLOAD_DIR / (key + "." + _IMG_EXT[m.group(1)])).write_bytes(raw)
    return key


def _uploaded_keys() -> set:
    out = set()
    if _UPLOAD_DIR.exists():
        for f in _UPLOAD_DIR.glob("*.*"):
            out.add(f.stem)
    return out


# Свёртка гомоглифов для КЛЮЧА МОДЕЛИ — 1:1 как на фронте (js/queue-scene.js canon()):
# латиница/греческий → кириллица, потом lower + только буквы/цифры. ВАЖНО: это НЕ
# db._valor_canon (тот сворачивает в латиницу). Ключи файлов person-<...> и поиск на
# фронте должны считаться ОДИНАКОВО, иначе загруженная модель «не видна» (EvgeniY: файл
# был person-evgeniy латиницей, а фронт искал person-еvgеniу кириллицей).
_MODEL_FOLD = {
    "a": "а", "b": "в", "c": "с", "e": "е", "h": "н", "k": "к", "m": "м", "o": "о",
    "p": "р", "t": "т", "x": "х", "y": "у",
    "α": "а", "β": "б", "γ": "г", "δ": "д", "ε": "е", "ζ": "з", "η": "н", "θ": "о",
    "ι": "и", "κ": "к", "λ": "л", "μ": "м", "ν": "н", "ο": "о", "π": "п", "ρ": "р",
    "σ": "с", "ς": "с", "τ": "т", "υ": "и", "φ": "ф", "χ": "х", "ω": "о",
}


def _model_canon(s: str) -> str:
    """Канон ника для КЛЮЧА персональной модели — идентично фронтовому canon()."""
    s = (s or "").lower()
    s = "".join(ch for ch in s if ch.isalnum())
    return "".join(_MODEL_FOLD.get(ch, ch) for ch in s)


def _next_person_slot(canon: str, extra_taken: set | None = None) -> str:
    """Следующий свободный слот персональной модели: person-<canon>, затем --2, --3…"""
    base = "person-" + canon
    taken = _uploaded_keys()
    if extra_taken:
        taken |= extra_taken
    if base not in taken:
        return base
    n = 2
    while (base + "--" + str(n)) in taken:
        n += 1
    return base + "--" + str(n)


@router.post("/officer/model-upload")
def officer_model_upload(payload: ModelUploadIn, request: Request,
                         actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Офицер/админ добавляет игроку ЕЩЁ ОДНУ персональную модельку (новый слот) — НЕ меняет
    силой: игрок сам переключится, если захочет. key = ник игрока (не сырой ключ)."""
    with db.connection() as conn:
        p = _resolve_person(conn, payload.key)
        nick = p["nick"] if p else payload.key.strip()
        # Ключ модели считаем ФРОНТ-каноном ника МЭЙНА (как ищет переключатель),
        # а не db-каноном — иначе загруженная модель не находится (EvgeniY-баг).
        cn = _model_canon(p["main_nick"] if p else payload.key)
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        slot = _next_person_slot(cn)
        _save_model_image(slot, payload.data)
        _log(conn, "officer_model_upload", actor=_actor_name(actor), nick=nick, request=request,
             detail="добавил облик игроку → " + slot)
    return {"ok": True, "key": slot}


@router.post("/officer/model-set")
def officer_model_set(payload: ModelIn, request: Request,
                      actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Офицер/админ настраивает ПЕРСОНАЛЬНУЮ модельку (размер/зеркало/поворот). Только person-*
    ключи (классовые трогать нельзя — они общие, это только у админа). Ауру сохраняем."""
    key = _safe_key(payload.key)
    if not key or not key.startswith("person-"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "person_key_only")
    flip = 1 if payload.flip else 0
    rot = max(-180, min(180, int(payload.rotate)))
    scl = max(0.2, min(3.0, float(payload.scale)))
    with db.connection() as conn:
        aura = ""
        row = conn.execute("SELECT aura FROM queue_models WHERE model_key=?", (key,)).fetchone()
        if row and "aura" in row.keys():
            aura = row["aura"] or ""
        conn.execute(
            "INSERT INTO queue_models (model_key, flip, rotate, scale, aura, updated_at) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(model_key) DO UPDATE SET flip=excluded.flip, rotate=excluded.rotate,"
            " scale=excluded.scale, updated_at=excluded.updated_at",
            (key, flip, rot, scl, aura, _now()))
        _log(conn, "officer_model_set", actor=_actor_name(actor), request=request,
             detail=key + " scale=%.2f" % scl)
    return {"ok": True}


@router.post("/model-request")
def model_request(payload: ModelUploadIn, request: Request) -> dict:
    """Игрок предлагает СВОЮ персональную модельку — уходит на подтверждение офицеру/админу.
    Картинка сохраняется во временный ключ mreq-<id>; при одобрении переносится в слот игрока."""
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        cn, nick = acc["main_canon"], (acc["main_nick"] or acc["reg_nick"])
        cur = conn.execute(
            "INSERT INTO queue_model_requests (main_canon, nick, img_key, status, created_at)"
            " VALUES (?,?,?, 'pending', ?)", (cn, nick, "", _now()))
        rid = cur.lastrowid
        img_key = _save_model_image("mreq-" + str(rid), payload.data)
        conn.execute("UPDATE queue_model_requests SET img_key=? WHERE id=?", (img_key, rid))
        _log(conn, "model_request", actor=nick, nick=nick, request=request, detail="предложил модельку")
    return {"ok": True, "id": rid}


@router.get("/model-requests")
def model_requests(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Для офицеров/админа: ожидающие модельки + недавно решённые (для боковых окошек)."""
    import datetime as _dt
    cutoff = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=3)).isoformat(timespec="seconds")
    with db.connection() as conn:
        pend = conn.execute(
            "SELECT id, nick, img_key, created_at FROM queue_model_requests"
            " WHERE status='pending' ORDER BY id").fetchall()
        dec = conn.execute(
            "SELECT id, nick, status, decided_by, decided_at FROM queue_model_requests"
            " WHERE status!='pending' AND decided_at>=? ORDER BY id", (cutoff,)).fetchall()
    return {"requests": [dict(r) for r in pend], "decided": [dict(r) for r in dec]}


@router.get("/model-requests/mine")
def model_requests_mine(request: Request) -> dict:
    out = []
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if acc:
            for r in conn.execute(
                    "SELECT id, status, decided_by FROM queue_model_requests"
                    " WHERE main_canon=? ORDER BY id DESC LIMIT 8", (acc["main_canon"],)):
                out.append(dict(r))
    return {"requests": out}


@router.post("/model-request/decide")
def model_request_decide(payload: LinkDecideIn, request: Request,
                         actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Офицер/админ одобряет (переносит картинку в слот игрока) или отклоняет предложенную модельку."""
    who = _actor_name(actor)
    approve = payload.decision != "reject"
    with db.connection() as conn:
        row = conn.execute("SELECT * FROM queue_model_requests WHERE id=?", (payload.id,)).fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
        if row["status"] != "pending":
            return {"ok": True, "already": True, "status": row["status"], "decided_by": row["decided_by"]}
        img_key = row["img_key"]
        files = sorted(_UPLOAD_DIR.glob(img_key + ".*")) if (img_key and _UPLOAD_DIR.exists()) else []
        if approve and files:
            # Ключ модели — ФРОНТ-каноном ника мэйна (как ищет переключатель), не db-каноном.
            mp = _resolve_person(conn, row["nick"])
            slot = _next_person_slot(_model_canon(mp["main_nick"] if mp else row["nick"]))
            src = files[0]
            (_UPLOAD_DIR / (slot + src.suffix)).write_bytes(src.read_bytes())
            new_status = "approved"
        else:
            new_status = "rejected" if not approve else "approved"
        for f in files:                                 # временный файл больше не нужен
            try:
                f.unlink()
            except OSError:
                pass
        conn.execute("UPDATE queue_model_requests SET status=?, decided_by=?, decided_at=?, img_key='' WHERE id=?",
                     (new_status, who, _now(), payload.id))
        _log(conn, "model_decide", actor=who, nick=row["nick"], request=request, detail=new_status)
    return {"ok": True, "status": new_status, "decided_by": who}


@router.post("/admin/model-delete")
def model_delete(payload: ModelIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Удалить загруженную модель по ключу (возврат к статической/заглушке)."""
    key = _safe_key(payload.key)
    n = 0
    if key and _UPLOAD_DIR.exists():
        for f in _UPLOAD_DIR.glob(key + ".*"):
            try:
                f.unlink(); n += 1
            except OSError:
                pass
    if n:
        with db.connection() as conn:
            _log(conn, "model_delete", actor=_actor_name(actor), request=request, detail=key)
    return {"ok": True, "removed": n}


@router.get("/uploaded-models")
def uploaded_models() -> dict:
    """key -> mtime (для cache-bust на фронте)."""
    out: dict[str, int] = {}
    if _UPLOAD_DIR.exists():
        for f in _UPLOAD_DIR.glob("*.*"):
            try:
                out[f.stem] = int(f.stat().st_mtime)
            except OSError:
                pass
    return {"keys": out}


def _hidden_personal_set(conn) -> set:
    import json as _j
    try:
        v = db.kv_get("hidden_personal")
        return set(_j.loads(v)) if v else set()
    except Exception:
        return set()


@router.get("/hidden-personal")
def hidden_personal_get() -> dict:
    """Каноны, у кого ВСТРОЕННАЯ персональная модель СКРЫТА (админ «удалил» её). Скрытую модель
    сцена/переключатель не показывают. Файл встроенной лежит в бандле фронта — удалить его как
    загруженную нельзя, поэтому скрываем через этот флаг."""
    with db.connection() as conn:
        return {"canons": sorted(_hidden_personal_set(conn))}


@router.post("/admin/hide-personal")
def hide_personal(payload: dict, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Скрыть (hidden=true) или вернуть (false) ВСТРОЕННУЮ персональную модель для канона."""
    import json as _j
    cn = (payload.get("canon") or "").strip()
    if not cn:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_canon")
    hide = bool(payload.get("hidden", True))
    with db.connection() as conn:
        s = _hidden_personal_set(conn)
        if hide:
            s.add(cn)
        else:
            s.discard(cn)
        db.kv_set("hidden_personal", _j.dumps(sorted(s)))
        _log(conn, "hide_personal", actor=_actor_name(actor), request=request,
             detail=("скрыл встроенную " if hide else "вернул встроенную ") + cn)
    return {"ok": True, "hidden": hide, "canon": cn}


@router.get("/models-info")
def models_info(_: dict = Depends(require_admin)) -> dict:
    """Детали загруженных моделей (ключ, вес в байтах, размеры) — для менеджера моделей
    и оценки оптимизации. Только админ."""
    out = []
    if _UPLOAD_DIR.exists():
        for f in _UPLOAD_DIR.glob("*.*"):
            try:
                sz = f.stat().st_size
            except OSError:
                continue
            w = h = 0
            try:
                from PIL import Image
                with Image.open(f) as im:
                    w, h = im.size
            except Exception:
                pass
            out.append({"key": f.stem, "bytes": sz, "w": w, "h": h})
    return {"models": out}


@router.get("/model-img/{key}")
def model_img(key: str) -> FileResponse:
    safe = _safe_key(key)
    files = sorted(_UPLOAD_DIR.glob(safe + ".*")) if (safe and _UPLOAD_DIR.exists()) else []
    if not files:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return FileResponse(files[0], headers={"Cache-Control": "no-cache, must-revalidate"})


@router.post("/admin/gender")
def set_gender(payload: GenderIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    g = payload.gender if payload.gender in ("m", "f") else ""
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        cn = p["main_canon"] if p else db._valor_canon(payload.nick)
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        if not g:
            conn.execute("DELETE FROM queue_gender WHERE canon=?", (cn,))
        else:
            conn.execute(
                "INSERT INTO queue_gender (canon, gender, updated_at) VALUES (?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET gender=excluded.gender, updated_at=excluded.updated_at",
                (cn, g, _now()))
        _log(conn, "gender", actor=_actor_name(actor), nick=payload.nick, request=request,
             detail="пол=" + (g or "авто"))
    return {"ok": True, "gender": g}


class ClassIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    cls: str = Field(default="", max_length=32)


@router.post("/admin/class")
def set_class(payload: ClassIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Админ задаёт КЛАСС игроку, которого знает только реестр (доблесть класс не
    знает) — чтобы моделька в очереди была по классу. Пусто = сброс."""
    c = (payload.cls or "").strip()[:32]
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        cn = p["main_canon"] if p else db._valor_canon(payload.nick)
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        if not c:
            conn.execute("DELETE FROM queue_class WHERE canon=?", (cn,))
        else:
            conn.execute(
                "INSERT INTO queue_class (canon, cls, updated_at) VALUES (?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET cls=excluded.cls, updated_at=excluded.updated_at",
                (cn, c, _now()))
        _log(conn, "class", actor=_actor_name(actor), nick=payload.nick, request=request,
             detail="класс=" + (c or "сброс"))
    return {"ok": True, "cls": c}


@router.post("/gender")
def set_my_gender(payload: MyGenderIn, request: Request) -> dict:
    """Игрок сам выбирает пол своей модельки (по device-куке). '' = авто по имени/классу."""
    g = payload.gender if payload.gender in ("m", "f") else ""
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        cn = acc["main_canon"]
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        if not g:
            conn.execute("DELETE FROM queue_gender WHERE canon=?", (cn,))
        else:
            conn.execute(
                "INSERT INTO queue_gender (canon, gender, updated_at) VALUES (?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET gender=excluded.gender, updated_at=excluded.updated_at",
                (cn, g, _now()))
        _log(conn, "gender", actor=acc["main_nick"], nick=acc["main_nick"], request=request,
             detail="сам: пол=" + (g or "авто"))
    return {"ok": True, "gender": g}


@router.post("/model-pref")
def set_model_pref(payload: ModelPrefIn, request: Request) -> dict:
    """Игрок с персональной моделью выбирает: показывать общую классовую модель
    вместо персональной (по device-куке). prefer_class=False → снова персональная."""
    pref = 1 if payload.prefer_class else 0
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        cn = acc["main_canon"]
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        # выбор «персональная/по классу» — это авто-режим, поэтому сбрасываем явно
        # закреплённый вариант модели (variant), чтобы сработала обычная логика.
        if not pref:
            conn.execute("DELETE FROM queue_model_pref WHERE canon=?", (cn,))
        else:
            conn.execute(
                "INSERT INTO queue_model_pref (canon, prefer_class, variant, updated_at) VALUES (?,?,'',?)"
                " ON CONFLICT(canon) DO UPDATE SET prefer_class=excluded.prefer_class, variant='', updated_at=excluded.updated_at",
                (cn, pref, _now()))
        _log(conn, "model_pref", actor=acc["main_nick"], nick=acc["main_nick"], request=request,
             detail="модель=" + ("классовая" if pref else "персональная"))
    return {"ok": True, "prefer_class": bool(pref)}


@router.post("/model-variant")
def set_model_variant(payload: ModelVariantIn, request: Request) -> dict:
    """Игрок выбирает КОНКРЕТНЫЙ вариант своей модели (если админ добавил несколько),
    ключ модели (person-… / class-…-…). Пусто → снять закрепление (авто по логике)."""
    key = _safe_key(payload.key)
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        cn = acc["main_canon"]
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        if not key:
            conn.execute("UPDATE queue_model_pref SET variant='', updated_at=? WHERE canon=?", (_now(), cn))
        else:
            conn.execute(
                "INSERT INTO queue_model_pref (canon, prefer_class, variant, updated_at) VALUES (?,0,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET variant=excluded.variant, updated_at=excluded.updated_at",
                (cn, key, _now()))
        _log(conn, "model_variant", actor=acc["main_nick"], nick=acc["main_nick"], request=request,
             detail="вариант=" + (key or "(авто)"))
    return {"ok": True, "variant": key}


@router.post("/admin/model-variant-as")
def set_model_variant_as(payload: AdminModelVariantIn, request: Request,
                         actor: dict = Depends(require_admin)) -> dict:
    """ТЕСТ: админ меняет вариант модели ОТ ИМЕНИ ника (напр. Лирия!) — чтобы проверить,
    как выглядит смена облика у игрока. Зеркалит /queue/model-variant."""
    key = _safe_key(payload.key)
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        cn = p["main_canon"] if p else db._valor_canon(payload.nick)
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        if not key:
            conn.execute("UPDATE queue_model_pref SET variant='', updated_at=? WHERE canon=?", (_now(), cn))
        else:
            conn.execute(
                "INSERT INTO queue_model_pref (canon, prefer_class, variant, updated_at) VALUES (?,0,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET variant=excluded.variant, updated_at=excluded.updated_at",
                (cn, key, _now()))
        _log(conn, "model_variant_as", actor=_actor_name(actor), nick=payload.nick, request=request,
             detail="АДМИН вариант «%s»=%s" % (payload.nick, key or "(авто)"))
    return {"ok": True, "variant": key}


@router.get("/placements")
def placements() -> dict:
    with db.connection() as conn:
        rows = conn.execute("SELECT key, x, y, z FROM queue_placements").fetchall()
    return {"placements": {r["key"]: {"x": r["x"], "y": r["y"], "z": (r["z"] if "z" in r.keys() else "")} for r in rows}}


@router.post("/admin/placement")
def set_placement(payload: PlacementIn, _: dict = Depends(require_admin)) -> dict:
    x = max(0.0, min(100.0, float(payload.x)))
    y = max(0.0, min(100.0, float(payload.y)))
    z = payload.z if payload.z in ("front", "back", "") else ""
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO queue_placements (key, x, y, z, updated_at) VALUES (?,?,?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, updated_at=excluded.updated_at",
            (payload.key, x, y, z, _now()))
    return {"ok": True}


@router.get("/config")
def get_config() -> dict:
    with db.connection() as conn:
        rows = conn.execute("SELECT key, val FROM queue_kv").fetchall()
    return {"config": {r["key"]: r["val"] for r in rows}}


# значимые настройки — логируем (кто менял); размеры/пути/расстановку — нет (спам)
_LOGGED_CFG = {"queue_open", "stages_closed", "pet_count", "shooters", "forceTime",
               "dayFrom", "nightFrom", "env_objects", "queue_test_send"}


@router.post("/admin/config")
def set_config(payload: KVIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO queue_kv (key, val, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET val=excluded.val, updated_at=excluded.updated_at",
            (payload.key, payload.val, _now()))
        if payload.key in _LOGGED_CFG:
            v = payload.val if len(payload.val) <= 60 else (payload.val[:57] + "…")
            _log(conn, "config", actor=_actor_name(actor), request=request,
                 detail=payload.key + "=" + v)
    return {"ok": True}


def _cfg_val(conn, key, dflt=""):
    row = conn.execute("SELECT val FROM queue_kv WHERE key=?", (key,)).fetchone()
    return row["val"] if row else dflt


def _cfg_int(conn, key, dflt=0):
    try:
        return int(float(_cfg_val(conn, key, "")))
    except (ValueError, TypeError):
        return dflt


def _cfg_set(conn, key, val) -> None:
    conn.execute(
        "INSERT INTO queue_kv (key, val, updated_at) VALUES (?,?,?)"
        " ON CONFLICT(key) DO UPDATE SET val=excluded.val, updated_at=excluded.updated_at",
        (key, str(val), _now()))


def _valor_map(conn) -> tuple[dict, dict]:
    """(canon->доблесть, canon->ник) из последнего снапшота (для порогов, топ-3, имён)."""
    snap = conn.execute("SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    if not snap:
        return {}, {}
    vmap: dict[str, int] = {}
    nmap: dict[str, str] = {}
    for r in conn.execute(
            "SELECT nick_canon, nick, valor FROM valor_members WHERE snapshot_id=?", (snap["id"],)):
        c = r["nick_canon"]
        v = r["valor"]
        if c and v is not None and v > vmap.get(c, -1):
            vmap[c] = v
            nmap[c] = r["nick"]
    return vmap, nmap


def grant_top3_valor_tokens(conn, week: str | None = None,
                            actor_name: str = "система") -> dict:
    """Начислить +1 жетон суперспособности ТОП-3 по доблести за неделю. ИДЕМПОТЕНТНО:
    маркер valor_top3_grant(week) гарантирует, что жетоны за неделю начислятся ОДИН раз,
    кто бы ни вызвал первым — валор-«Готово» или финализация очереди. ТОП-3 = 3 РАЗНЫХ
    человека (твины свёрнуты в мэйн по main_canon), только с доблестью > 0. Жетон идёт
    на МЭЙН-канон. Возвращает {ok, week, granted:[ники], already:bool}."""
    snap = conn.execute(
        "SELECT id, week FROM valor_snapshots WHERE week = ?", (week,)).fetchone() if week \
        else conn.execute("SELECT id, week FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    if not snap:
        return {"ok": False, "reason": "no_snapshot", "granted": []}
    wk = snap["week"]
    if conn.execute("SELECT 1 FROM valor_top3_grant WHERE week = ?", (wk,)).fetchone():
        return {"ok": True, "week": wk, "granted": [], "already": True}
    # доблесть за неделю: canon -> макс valor, canon -> ник
    vmap, nmap = {}, {}
    for r in conn.execute(
            "SELECT nick_canon, nick, valor FROM valor_members WHERE snapshot_id = ? "
            # порядок скринов (id) → детерминированный тай-брейк при равной доблести
            "ORDER BY COALESCE(sort_key, id), id", (snap["id"],)):
        c, v = r["nick_canon"], r["valor"]
        if c and v is not None and v > vmap.get(c, -1):
            vmap[c] = v; nmap[c] = r["nick"]
    idx = _people(conn)
    main_map = {cn: p["main_canon"] for cn, p in idx.items() if p.get("main_canon")}
    c2n = {p["main_canon"]: p["main_nick"] for p in idx.values() if p.get("main_canon")}
    # сворачиваем доблесть по МЭЙНУ (человек = мэйн + твины), ранг = макс доблесть
    person_valor, person_nick = {}, {}
    for c, v in vmap.items():
        p = main_map.get(c, c)
        if (v or 0) > person_valor.get(p, -1):
            person_valor[p] = v or 0
            person_nick[p] = c2n.get(p) or nmap.get(c) or c
    ranked = sorted(person_valor.items(), key=lambda kv: kv[1], reverse=True)
    top3 = [(p, person_nick.get(p, p)) for p, v in ranked[:3] if v > 0]
    granted = []
    for canon, nk in top3:
        conn.execute(
            "INSERT INTO queue_privileges (canon, nick, tokens, updated_at) VALUES (?,?,1,?)"
            " ON CONFLICT(canon) DO UPDATE SET tokens=tokens+1, nick=excluded.nick, updated_at=excluded.updated_at",
            (canon, nk, _now()))
        granted.append(nk)
    conn.execute(
        "INSERT INTO valor_top3_grant (week, granted_at, nicks) VALUES (?,?,?)"
        " ON CONFLICT(week) DO NOTHING",
        (wk, _now(), ", ".join(granted)))
    if granted:
        _log(conn, "priv_grant", actor=actor_name,
             detail="жетон ТОП-3 доблести (неделя %s): %s" % (wk, ", ".join(granted)))
    return {"ok": True, "week": wk, "granted": granted, "already": False}


# ───── авто-регистрация в чате по клику ссылки на сайте (тайм-корреляция) ─────
class ChatLinkClickIn(BaseModel):
    platform: str = Field(min_length=2, max_length=4)          # 'vk' | 'tg'


@router.post("/chat-link-click")
def chat_link_click(payload: ChatLinkClickIn, request: Request) -> dict:
    """Залогиненный игрок кликнул ссылку чата клана (VK/TG) на сайте. Пишем НАМЕРЕНИЕ с
    точным временем: бот на заходе новичка сопоставит по времени и зарегистрирует его под
    игровым ником. Гость (не залогинен) не пишется — некого регистрировать."""
    plat = (payload.platform or "").strip().lower()
    if plat not in ("vk", "tg"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_platform")
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            return {"ok": False, "anon": True}                 # не залогинен — молча не пишем
        nick = acc.get("main_nick") or acc.get("reg_nick") or ""
        ip = (request.client.host if request.client else "") or ""
        conn.execute(
            "INSERT INTO queue_chat_link_click (canon, nick, platform, clicked_at, ip) VALUES (?,?,?,?,?)",
            (acc.get("main_canon") or "", nick, plat, _now(), ip))
        _log(conn, "chat_link_click", actor=nick, nick=nick, request=request,
             detail="клик ссылки чата " + plat.upper())
    return {"ok": True}


_DEFAULT_CHAT_INVITE = {
    # Фолбэк, если в queue_kv нет chat_invite_*. TG — ссылка С ЗАЯВКОЙ НА ВСТУПЛЕНИЕ
    # (бот авто-одобряет только кликнувших на сайте). Обычно берётся из queue_kv (Настройки/kv_set).
    "tg": "https://t.me/+IoqFqrfivoxiNDJi",
    "vk": "https://vk.me/join/8NPd9uaougB4Yecwva_x2wRKsxB6HEAUP1Q=",
}


@router.get("/chat-invite")
def chat_invite(request: Request, p: str = Query(..., min_length=2, max_length=4)):
    """Переход в чат клана (VK/TG) ТОЛЬКО для залогиненных. Настоящая ссылка скрыта (в браузере
    видно /queue/chat-invite, а не t.me/vk.me), переход логируется под ником игрока (для авто-
    регистрации по тайм-корреляции) и делается 302 на приглашение. Не залогинен → на вход."""
    plat = (p or "").strip().lower()
    if plat not in ("vk", "tg"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_platform")
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        # Пускаем ЛЮБОГО залогиненного (игрок/офицер/участник/АДМИН). Клик под ником
        # логируем только для игрока/офицера (для авто-регистрации по тайм-корреляции);
        # админ не игрок — он просто идёт в чат, лог-матч ему не нужен.
        if not acc:
            try:
                s = current_session(request)
            except HTTPException:
                s = None
            if not (s and s.get("role") in ("admin", "officer", "member")):
                return RedirectResponse("/login.html", status_code=302)
        if acc:
            nick = acc.get("main_nick") or acc.get("reg_nick") or ""
            ip = (request.client.host if request.client else "") or ""
            try:
                conn.execute(
                    "INSERT INTO queue_chat_link_click (canon, nick, platform, clicked_at, ip) VALUES (?,?,?,?,?)",
                    (acc.get("main_canon") or "", nick, plat, _now(), ip))
                _log(conn, "chat_link_click", actor=nick, nick=nick, request=request,
                     detail="переход в чат " + plat.upper())
            except Exception:
                pass
        row = conn.execute("SELECT val FROM queue_kv WHERE key=?",
                           ("chat_invite_" + plat,)).fetchone()
        url = (row["val"] if row and row["val"] else "") or _DEFAULT_CHAT_INVITE[plat]
    return RedirectResponse(url, status_code=302)


class ChatJoinMatchIn(BaseModel):
    platform:    str = Field(min_length=2, max_length=4)
    platform_id: str = Field(default="", max_length=64)        # id зашедшего в чате
    name:        str = Field(default="", max_length=200)       # отображаемое имя зашедшего
    window:      int | None = None                             # окно секунд (деф. из конфига/120)


@router.post("/chat-join-match")
def chat_join_match(payload: ChatJoinMatchIn, _=Depends(require_bot_token)) -> dict:
    """Бот: в чат (VK/TG) только что зашёл человек. Ищем НЕсопоставленный клик ссылки этой
    площадки за окно (деф. 120с). РОВНО ОДИН уникальный игрок → сопоставляем, возвращаем его
    игровой ник (бот зарегистрирует под ним). Несколько → ambiguous (бот не гадает — ручной
    приём). Ноль → matched:false. Идемпотентно помечает клик matched, чтоб не сработал дважды."""
    plat = (payload.platform or "").strip().lower()
    if plat not in ("vk", "tg"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_platform")
    with db.connection() as conn:
        win = payload.window if (isinstance(payload.window, int) and payload.window > 0) else None
        if win is None:
            try:
                win = int(_cfg_val(conn, "chat_match_window", "600") or "600")
            except Exception:
                win = 600
        win = max(20, min(1800, win))   # до 30 мин: VK ловит вход по ссылке 3-мин поллом
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=win)).isoformat(timespec="seconds")
        rows = conn.execute(
            "SELECT id, canon, nick, clicked_at FROM queue_chat_link_click"
            " WHERE platform=? AND matched=0 AND clicked_at>=? ORDER BY clicked_at DESC",
            (plat, cutoff)).fetchall()
        if not rows:
            return {"matched": False, "reason": "no_click", "window": win}
        uniq: dict = {}
        for r in rows:
            uniq.setdefault(r["canon"], r)
        if len(uniq) > 1:                                      # неоднозначно — не гадаем
            _log(conn, "chat_join_ambiguous", actor="reg-bot",
                 detail="заход %s: %d кандидатов за %dс — ручной приём" % (plat, len(uniq), win))
            return {"matched": False, "ambiguous": True, "window": win,
                    "candidates": [{"nick": v["nick"], "canon": v["canon"]} for v in list(uniq.values())[:6]]}
        r = rows[0]
        conn.execute(
            "UPDATE queue_chat_link_click SET matched=1, matched_at=?, match_pid=?, match_name=? WHERE id=?",
            (_now(), str(payload.platform_id or ""), (payload.name or "")[:200], r["id"]))
        _log(conn, "chat_join_matched", actor="reg-bot", nick=r["nick"],
             detail="заход %s «%s» (id %s) → %s" % (plat, (payload.name or "?")[:40], payload.platform_id, r["nick"]))
        return {"matched": True, "nick": r["nick"], "canon": r["canon"],
                "clicked_at": r["clicked_at"], "window": win}


@router.get("/whitelist-ids")
def whitelist_ids(_=Depends(require_bot_token)) -> dict:
    """Белый список чатов (для аудит-скрипта бота): id и ник-каноны, кого НЕ считать чужим."""
    rows = db.chat_whitelist_list()
    return {
        "vk_ids": [str(r["vk_id"]) for r in rows if r.get("vk_id")],
        "tg_ids": [str(r["tg_id"]) for r in rows if r.get("tg_id")],
        "nick_canons": sorted(db.chat_whitelist_nick_canons()),
    }


@router.get("/rewards")
def rewards() -> dict:
    """Метаданные наград (режим/стак/порог/накопленный объём) — для пикера ресурса."""
    with db.connection() as conn:
        stages = _cfg_int(conn, "stages_closed", 0)
    return {"stages": stages, "rewards": distribution.reward_meta(stages)}


@router.get("/drops")
def drops() -> dict:
    """Что падает с каждого этапа КХ — ТОЧНО как в таблице наград «Награды за все этапы кх».
    st[i] = сколько ресурса даёт этап i (пул недели = сумма по закрытым этапам). Огненный
    цилинь падает С ШАНСОМ с конкретных этапов (4–7)."""
    CILIN_STAGES = {4, 5, 6, 7}
    st_rows = []
    for si in range(distribution.MAX_STAGES):
        stage = si + 1
        items = []
        for k, r in distribution.REWARDS.items():
            if k == "mount-cilin":
                continue                        # питомец — с шансом, ниже отдельной строкой
            amt = r["st"][si]                   # дроп ИМЕННО этого этапа (как в файле)
            if amt > 0:
                items.append({"res": k, "name": distribution.res_name(k), "qty": amt,
                              "q": r["q"], "mode": r["mode"]})
        st_rows.append({"stage": stage, "items": items, "cilin": stage in CILIN_STAGES})
    return {"stages": st_rows,
            "cilin_res": "mount-cilin",
            "cilin_name": distribution.res_name("mount-cilin"),
            "cilin_note": "падает С ШАНСОМ (может не выпасть на неделе), по 1 шт — с этапов 4–7",
            "queues": ["Обычные", "Редкие (R)", "Легендарные (S)", "Мифические (SS)"]}


def _priv_claims(conn) -> list[dict]:
    """Внеочередные захваты (жетоном) недели — ДЕРИВИРУЮТСЯ из привилегированных
    записей. Объём = priv_stacks × размер пачки текущего ресурса, поэтому смена
    ресурса игроком автоматически пересчитывает захват (raw='' — сырой код ресурса)."""
    out = []
    for c in conn.execute(
            "SELECT nick, resource, priv_stacks FROM queue_entries WHERE privileged=1 AND priv_stacks>0"):
        r = distribution.REWARDS.get(c["resource"]) or {}
        out.append({"nick": c["nick"], "resource": c["resource"],
                    "amount": c["priv_stacks"] * (r.get("unit") or 0)})
    return out


def _build_report(conn, stages_override: int | None = None, stages_from: int = 0) -> dict:
    import json
    idx = _people(conn)
    gmap = {r["canon"]: r["gender"] for r in conn.execute("SELECT canon, gender FROM queue_gender")}
    smap = _spouse_map(conn)
    queues = [[], [], [], []]
    for r in conn.execute("SELECT * FROM queue_entries ORDER BY queue, pos, id"):
        if r["queue"] in QUEUES:
            e = _entry_public(r, idx, gmap, smap)
            e["main_canon"] = r["main_canon"]
            e["canon_nick"] = db._valor_canon(e["nick"])
            queues[r["queue"]].append(e)
    valor_map, name_map = _valor_map(conn)
    # карта: canon персонажа -> canon мэйна (для сворачивания твинов в одну персону в топ-3)
    main_map = {cn: p["main_canon"] for cn, p in idx.items() if p.get("main_canon")}
    # имя мэйна по его канону (в т.ч. когда сам мэйн не встречается персонажем, только по титулу твина)
    main_nick_map: dict[str, str] = {}
    for cn, p in idx.items():
        mc, mn = p.get("main_canon"), p.get("main_nick")
        if mc and mn and mc not in main_nick_map:
            main_nick_map[mc] = mn
    # лучший (макс) валор персоны по её мэйн-канону — для отображения топ-3 поимённо
    person_best: dict[str, int] = {}
    for c, v in valor_map.items():
        p = main_map.get(c, c)
        if (v or 0) > person_best.get(p, -1):
            person_best[p] = v or 0
    try:
        shooters = [s for s in json.loads(_cfg_val(conn, "shooters", "[]")) if s]
    except (ValueError, TypeError):
        shooters = []
    claims = _priv_claims(conn)
    stages_use = _cfg_int(conn, "stages_closed", 0) if stages_override is None else int(stages_override)
    report = distribution.compute(
        {"queues": queues}, valor_map,
        {"stages": stages_use, "stages_from": stages_from,
         "pet_count": _cfg_int(conn, "pet_count", 0),
         "shooters": shooters, "claims": claims, "main_map": main_map})
    report["has_valor"] = bool(valor_map)
    # ВЫДАННЫЕ огненные цилини на этой неделе (из снимка раздачи, added_by='cilin') — чтобы
    # отчёт показывал КОМУ выдан цилинь (получатель выходит из очереди → в pet_queue его уже нет).
    try:
        report["cilin_given"] = [r["nick"] for r in conn.execute(
            "SELECT nick FROM queue_served_last WHERE added_by='cilin' ORDER BY served_at, id")]
    except Exception:
        report["cilin_given"] = []
    # топ-3 поимённо (для отчёта): имя МЭЙНА персоны + её лучший валор (человек+твины = 1 строка)
    report["top3_named"] = sorted(
        [{"nick": main_nick_map.get(c, name_map.get(c, c)),
          "valor": person_best.get(c, valor_map.get(c, 0))} for c in report.get("top3", [])],
        key=lambda t: t["valor"], reverse=True)
    return report


def _now_msk_str() -> str:
    return datetime.now(timezone(timedelta(hours=3))).strftime("%d.%m.%Y %H:%M мск")


def _is_test_mode() -> bool:
    # ПО УМОЛЧАНИЮ ВКЛ (пока раздел не запущен): отчёт идёт в личку через @pw_spamer_bot,
    # а не в офицерский чат. Чтобы слать в офицерский чат — явно queue_test_send="0".
    with db.connection() as conn:
        return _cfg_val(conn, "queue_test_send", "1") != "0"


async def _send_report_to_chats(report: dict, force_dm: bool = False) -> dict:
    """Шлёт текст отчёта. В ПРОБНОМ режиме (или force_dm) — только в личку Лиру через
    @pw_spamer_bot; иначе — в офицерский TG и VK чат. Возвращает статус по каналам."""
    text = distribution.format_report_text(report, _now_msk_str())
    channels: dict[str, str] = {}
    if force_dm or _is_test_mode():
        try:
            if not (settings.test_bot_token and settings.test_chat_id):
                raise RuntimeError("test_bot_not_configured")
            await bot_tg.send_text(text, token=settings.test_bot_token, chat_id=settings.test_chat_id)
            channels["test"] = "ok"
        except Exception as exc:
            channels["test"] = "error: %s" % exc
        return channels
    try:
        await bot_tg.send_text(text)
        channels["tg"] = "ok"
    except Exception as exc:
        channels["tg"] = "error: %s" % exc
    try:
        await asyncio.to_thread(bot_vk.send_text, text)
        channels["vk"] = "ok"
    except Exception as exc:
        channels["vk"] = "error: %s" % exc
    return channels


@router.get("/admin/distribute")
def distribute(_: dict = Depends(require_admin)) -> dict:
    """Полный отчёт о распределении по текущим очередям, этапам, доблести и шотёрам."""
    with db.connection() as conn:
        return _build_report(conn)


@router.post("/admin/distribute/send")
async def distribute_send(request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Строит отчёт и отправляет его в офицерский чат TG + VK (по кнопке)."""
    with db.connection() as conn:
        report = _build_report(conn)
    channels = await _send_report_to_chats(report)
    with db.connection() as conn:
        _log(conn, "report_sent", actor=_actor_name(actor), request=request,
             detail="tg=%s · vk=%s" % (channels.get("tg"), channels.get("vk")))
    return {"ok": True, "channels": channels, "report": report}


@router.post("/admin/distribute/send-range")
async def distribute_send_range(payload: ReportRangeIn, request: Request,
                                actor: dict = Depends(require_admin)) -> dict:
    """Прислать отчёты для КАЖДОГО числа закрытых этапов из диапазона [from..to] — Лиру
    в личку (@pw_spamer_bot). Нужно, когда до 00:00 могут закрыть ещё этап-другой: сразу
    видишь распределение для каждого варианта. Конфиг stages_closed НЕ меняется."""
    lo = min(payload.from_stages, payload.to_stages)
    hi = max(payload.from_stages, payload.to_stages)
    sent = []
    for s in range(lo, hi + 1):
        with db.connection() as conn:
            report = _build_report(conn, stages_override=s)
        ch = await _send_report_to_chats(report, force_dm=True)   # всегда в личку — это превью-варианты
        sent.append({"stages": s, "channels": ch})
    with db.connection() as conn:
        _log(conn, "report_range", actor=_actor_name(actor), request=request,
             detail="этапы %d–%d: прислано %d отчётов в личку" % (lo, hi, len(sent)))
    return {"ok": True, "sent": sent}


@router.post("/report-range-bot")
async def report_range_bot(payload: ReportRangeIn, _=Depends(require_bot_token)) -> dict:
    """То же, что send-range, но для ДЕСКТОП-приложения «PW Анализ доблести»
    (auth: bot-token). Диапазон этапов КХ → по отчёту на каждый вариант Лиру в личку."""
    lo = min(payload.from_stages, payload.to_stages)
    hi = max(payload.from_stages, payload.to_stages)
    sent = []
    for s in range(lo, hi + 1):
        with db.connection() as conn:
            report = _build_report(conn, stages_override=s)
        ch = await _send_report_to_chats(report, force_dm=True)
        sent.append({"stages": s, "channels": ch})
    return {"ok": True, "sent": sent}


# ─────────────────────────────────────────────────────────────────────────────
# НОВЫЙ поток раздачи наград: ручной отчёт по диапазону этапов + цилинь/возврат
# отдельными кнопками (панель админа справа). Заменяет связку /admin/advance.
# ─────────────────────────────────────────────────────────────────────────────

async def _send_text_to_chats(text: str, force_dm: bool = False) -> dict:
    """Отправить ГОТОВЫЙ текст: в пробном режиме (или force_dm) — в личку @pw_spamer_bot,
    иначе — в офицерский TG + VK. Возвращает статус по каналам."""
    channels: dict[str, str] = {}
    if force_dm or _is_test_mode():
        try:
            if not (settings.test_bot_token and settings.test_chat_id):
                raise RuntimeError("test_bot_not_configured")
            await bot_tg.send_text(text, token=settings.test_bot_token, chat_id=settings.test_chat_id)
            channels["test"] = "ok"
        except Exception as exc:
            channels["test"] = "error: %s" % exc
        return channels
    try:
        await bot_tg.send_text(text); channels["tg"] = "ok"
    except Exception as exc:
        channels["tg"] = "error: %s" % exc
    try:
        await asyncio.to_thread(bot_vk.send_text, text); channels["vk"] = "ok"
    except Exception as exc:
        channels["vk"] = "error: %s" % exc
    return channels


async def _send_report_media(image_path, text: str, force_dm: bool = False) -> dict:
    """Отправить отчёт: СНАЧАЛА картинку-рендер, ПОД ней текстовый вариант. В пробном режиме
    (или force_dm/превью) — в личку @pw_spamer_bot (только TG); иначе — в офицерский TG + VK."""
    channels: dict[str, str] = {}
    if force_dm or _is_test_mode():
        try:
            if not (settings.test_bot_token and settings.test_chat_id):
                raise RuntimeError("test_bot_not_configured")
            await bot_tg.send_photo(image_path, token=settings.test_bot_token, chat_id=settings.test_chat_id)
            await bot_tg.send_text(text, token=settings.test_bot_token, chat_id=settings.test_chat_id)
            channels["test"] = "ok"
        except Exception as exc:
            channels["test"] = "error: %s" % exc
        return channels
    # TG: сначала картинка, потом текст. Если картинка не вышла — текст всё равно шлём.
    try:
        photo_ok = True
        try:
            await bot_tg.send_photo(image_path)
        except Exception as ep:
            photo_ok = False
            _log_err("tg_photo", ep)
        await bot_tg.send_text(text)
        channels["tg"] = "ok" if photo_ok else "текст ok, фото не вышло"
    except Exception as exc:
        channels["tg"] = "error: %s" % exc
    # VK: то же самое — картинка, затем текст (текст даже если фото упало).
    try:
        photo_ok = True
        try:
            await asyncio.to_thread(bot_vk.send_photo, image_path, "")
        except Exception as ep:
            photo_ok = False
            _log_err("vk_photo", ep)
        await asyncio.to_thread(bot_vk.send_text, text)
        channels["vk"] = "ok" if photo_ok else "текст ok, фото не вышло"
    except Exception as exc:
        channels["vk"] = "error: %s" % exc
    return channels


def _render_report_image(main: dict, delta: dict | None):
    """Отрисовать картинку отчёта (Pillow). None при ошибке — тогда шлём текстом."""
    try:
        import report_render
        return report_render.render_report_png(main, delta, _now_msk_str(), "/tmp/qreport.png")
    except Exception as exc:
        _log_err("report_render", exc)
        return None


def _log_err(where: str, exc) -> None:
    import logging
    logging.getLogger("officers.queue").warning("%s failed: %s", where, exc)


def _repack_queue(conn, q: int) -> None:
    """Пересчитать pos очереди по текущему порядку (после удаления строк)."""
    rows = conn.execute("SELECT id FROM queue_entries WHERE queue=? ORDER BY pos, id", (q,)).fetchall()
    for i, r in enumerate(rows, 1):
        conn.execute("UPDATE queue_entries SET pos=? WHERE id=?", (float(i), r["id"]))


def _shift_queues(conn, report: dict) -> dict:
    """Сдвиг очередей после отчёта. Получившие (status ok): с 🔁/планом → в конец, разово →
    выходят; «не забрал» и не получившие → остаются впереди. Цилинь-ждуны в report НЕ попадают
    (они в pet_queue) → тут автоматически остаются на месте. Пишет снимок queue_served_last
    (для возврата «не забрал»)."""
    import json as _json
    served_by_q = {}
    row_by_id = {}                    # id → строка отчёта (для got/missing)
    for Q in report["queues"]:
        served_by_q[Q["queue"]] = {r["id"] for r in Q["rows"] if r["status"] == "ok" and r["id"] is not None}
        for r in Q["rows"]:
            if r.get("id") is not None:
                row_by_id[r["id"]] = r
    requeued = left_after = stayed_uncollected = partial_stay = 0
    # Чистим только снимки ПРОШЛОГО отчёта (added_by='report'). Снимки раздачи цилиня
    # (added_by='cilin') НЕ трогаем — иначе публикация отчёта стирала бы возможность вернуть
    # цилинь-получателя через «не забрал», если цилиня раздали ДО отчёта (порядок Лира).
    conn.execute("DELETE FROM queue_served_last WHERE added_by != 'cilin'")
    for q in QUEUES:
        rows = conn.execute(
            "SELECT id, pos, main_canon, nick, cls, resource, resources, received, recipient,"
            " auto_repeat, auto_plan, not_collected"
            " FROM queue_entries WHERE queue=? ORDER BY pos, id", (q,)).fetchall()
        served = served_by_q.get(q, set())
        keep_ids = []; requeue_ids = []
        for r in rows:
            if r["id"] not in served:
                keep_ids.append(r["id"])
            elif r["not_collected"]:
                keep_ids.append(r["id"])
                conn.execute("UPDATE queue_entries SET not_collected=0 WHERE id=?", (r["id"],))
                stayed_uncollected += 1
            elif (row_by_id.get(r["id"], {}).get("missing") or []):
                # Получил НЕ ВСЁ выбранное (часть ресурсов не досталась — pack ушёл первому /
                # fixed кончился). ОСТАЁТСЯ в очереди за НЕДОПОЛУЧЕННЫМИ; полученное сейчас →
                # received (в пикере станет серым, повторно не выберет). Не выкидываем.
                miss = row_by_id[r["id"]]["missing"]
                got_now = list((row_by_id[r["id"]].get("got") or {}).keys())
                try:
                    prev_recv = _json.loads(r["received"]) if r["received"] else []
                except (ValueError, TypeError):
                    prev_recv = []
                new_recv = sorted(set(prev_recv) | set(got_now))
                conn.execute(
                    "UPDATE queue_entries SET resource=?, resources=?, received=? WHERE id=?",
                    (miss[0], _json.dumps(miss), _json.dumps(new_recv), r["id"]))
                keep_ids.append(r["id"]); partial_stay += 1
            else:
                conn.execute(
                    "INSERT INTO queue_served_last (queue, orig_pos, main_canon, nick, cls,"
                    " resource, recipient, auto_repeat, auto_plan, added_by, served_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (q, r["pos"], r["main_canon"], r["nick"], r["cls"], r["resource"],
                     r["recipient"], r["auto_repeat"], r["auto_plan"] or "", "report", _now()))
                try:
                    plan = _json.loads(r["auto_plan"]) if r["auto_plan"] else []
                except (ValueError, TypeError):
                    plan = []
                if plan:
                    conn.execute("UPDATE queue_entries SET resource=?, auto_plan=? WHERE id=?",
                                 (plan[0], _json.dumps(plan[1:]), r["id"]))
                    requeue_ids.append(r["id"]); requeued += 1
                elif r["auto_repeat"]:
                    requeue_ids.append(r["id"]); requeued += 1
                else:
                    conn.execute("DELETE FROM queue_entries WHERE id=?", (r["id"],))
                    left_after += 1
        # СТАБИЛЬНЫЕ ПОЗИЦИИ: keep_ids ОСТАЮТСЯ на своих pos — НЕ перепаковываем. Ушедшие
        # оставляют пробелы в нумерации — это нормально (порядок только по pos), зато возврат
        # «не забрал» всегда попадает ТОЧНО на прежнее место без «съезда». Авто-повтор → в КОНЕЦ
        # (max(pos)+1), received сброшен (новый цикл).
        if requeue_ids:
            base = (conn.execute("SELECT COALESCE(MAX(pos), 0) m FROM queue_entries WHERE queue=?",
                                 (q,)).fetchone()["m"]) or 0
            p = float(base)
            for i in requeue_ids:
                p += 1.0
                conn.execute("UPDATE queue_entries SET pos=?, received='' WHERE id=?", (p, i))
    return {"requeued": requeued, "left_removed": left_after,
            "stayed_uncollected": stayed_uncollected, "partial_stay": partial_stay}


@router.post("/admin/report")
async def admin_report(payload: ReportIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Ручной отчёт по диапазону этапов КХ.
      • from == to → отчёт ТОЛЬКО за этот этап (без дописки про следующий);
      • from <  to → основной отчёт за FROM + секция «если закроем ещё этап» (дельта до TO).
    Огненный цилинь — отдельным списком (в раздачу не идёт). Грамота и остаток — не в отчёте.
    commit=False → превью (очередь не трогаем). commit=True → опубликовать текст в офиц.чаты
    И СДВИНУТЬ основные очереди (получившие уходят/в конец; цилинь-ждуны остаются — их двигает
    отдельная кнопка). Защита от повторного сдвига в тот же день (обойти force=True)."""
    import json as _json
    lo = min(payload.from_stages, payload.to_stages)
    hi = max(payload.from_stages, payload.to_stages)
    with db.connection() as conn:
        main = _build_report(conn, stages_override=lo)
        delta = _build_report(conn, stages_override=hi, stages_from=lo) if hi > lo else None
    text = distribution.format_report_compact(main, delta, _now_msk_str())
    img = _render_report_image(main, delta)     # картинка-рендер (None → шлём текстом)
    result = {"ok": True, "from_stages": lo, "to_stages": hi, "text": text, "image": bool(img),
              "groups": len(main.get("groups") or []),
              "pet_queue": [{"nick": p["receiver"], "status": p["status"]}
                            for p in (main.get("pet_queue") or [])],
              # список «не хватило доблести за ресурс» — ТОЛЬКО для админ-панели, в отчёт не идёт
              "low_valor": main.get("low_valor") or []}
    if not payload.commit:
        # ПРЕВЬЮ — картинка + текст ТОЛЬКО мне в личку (@pw_spamer_bot), очередь НЕ трогаем
        ch = await (_send_report_media(img, text, force_dm=True) if img
                    else _send_text_to_chats(text, force_dm=True))
        result.update({"preview": True, "channels": ch})
        return result
    # ПРОБНЫЙ РЕЖИМ: commit НЕ двигает очередь — сухой прогон целиком в личку. Так «пробный
    # отчёт» безопасен: жми сколько угодно, очередь не сдвинется.
    if _is_test_mode():
        ch = await (_send_report_media(img, text, force_dm=True) if img
                    else _send_text_to_chats(text, force_dm=True))
        result.update({"committed": False, "dry_run": True, "channels": ch,
                       "note": "пробный режим: отчёт ушёл в личку, очередь НЕ сдвинута"})
        return result
    # БОЕВОЙ РЕЖИМ (пробный выключен): сдвиг ОДИН раз за неделю. Повторное нажатие в то же
    # воскресенье — ПРОСТО ПОВТОРНАЯ отправка того же отчёта, БЕЗ второго сдвига и не за след.
    # неделю. Ключ недели = неделя последнего снапшота доблести.
    week = db.valor_latest_week() or ""
    with db.connection() as conn:
        done_week = _cfg_val(conn, "report_shift_week", "")
    if week and done_week == week and not payload.force:
        with db.connection() as conn:
            row = conn.execute("SELECT report FROM queue_reports ORDER BY id DESC LIMIT 1").fetchone()
        try:
            saved = _json.loads(row["report"]) if row and row["report"] else main
        except (ValueError, TypeError):
            saved = main
        text2 = distribution.format_report_compact(saved, None, _now_msk_str())
        img2 = _render_report_image(saved, None)
        ch = await (_send_report_media(img2, text2) if img2 else _send_text_to_chats(text2))
        result.update({"committed": True, "resent": True, "channels": ch, "text": text2,
                       "note": "повторная отправка отчёта за эту неделю — очередь НЕ сдвигалась"})
        return result
    # первый БОЕВОЙ сдвиг за эту неделю: публикуем (картинка→текст) и сдвигаем очередь
    channels = await (_send_report_media(img, text) if img else _send_text_to_chats(text))
    with db.connection() as conn:
        stats = _shift_queues(conn, main)
        n_groups = len(main.get("groups") or [])
        n_people = sum(len(g.get("people") or []) for g in (main.get("groups") or []))
        conn.execute(
            "INSERT INTO queue_reports (created_at, stages, report, channels, summary, actor)"
            " VALUES (?,?,?,?,?,?)",
            (_now(), lo, _json.dumps(main, ensure_ascii=False),
             _json.dumps(channels, ensure_ascii=False),
             "групп:%d получателей:%d (диап %d-%d)" % (n_groups, n_people, lo, hi), _actor_name(actor)))
        conn.execute("DELETE FROM queue_entries WHERE privileged=1")
        conn.execute("DELETE FROM queue_priv_claims")
        _save_low_valor_notices(conn, main)
        _cfg_set(conn, "report_shift_week", week)     # маркер: на этой неделе уже сдвигали
        _log(conn, "report_commit", actor=_actor_name(actor), request=request,
             detail="этапы %d-%d · вышли %d, в конец %d, не забрал(остались) %d · %s"
                    % (lo, hi, stats["left_removed"], stats["requeued"], stats["stayed_uncollected"], channels))
    result.update({"committed": True, "channels": channels, **stats})
    return result


@router.post("/admin/cilin-distribute")
def cilin_distribute(payload: CilinDistributeIn, request: Request,
                     actor: dict = Depends(require_admin)) -> dict:
    """Раздать выпавших Огненных цилиней. count = сколько выпало → первым `count` в очереди
    цилиня (q2, выбрали mount-cilin, доблесть ≥ порога, по порядку) выдаём питомца: они выходят
    из очереди (пишутся в снимок «не забрал» для возможного возврата), очередь сдвигается.
    count=0 → никто не двигается, все ждут (в т.ч. на следующей неделе)."""
    with db.connection() as conn:
        report = _build_report(conn)
        pet = report.get("pet_queue") or []
        elig = [p for p in pet if p.get("status") == "pet" and p.get("id")]
        n = min(payload.count, len(elig))
        given = []
        # Чистим снимки ПРОШЛОЙ раздачи цилиня (added_by='cilin'), чтобы не копились по неделям.
        # Снимки отчёта (added_by='report') не трогаем — они живут своим циклом.
        conn.execute("DELETE FROM queue_served_last WHERE added_by='cilin'")
        for p in elig[:n]:
            row = conn.execute("SELECT * FROM queue_entries WHERE id=?", (p["id"],)).fetchone()
            if not row:
                continue
            conn.execute(
                "INSERT INTO queue_served_last (queue, orig_pos, main_canon, nick, cls,"
                " resource, recipient, auto_repeat, auto_plan, added_by, served_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (row["queue"], row["pos"], row["main_canon"], row["nick"], row["cls"],
                 row["resource"], row["recipient"], row["auto_repeat"], row["auto_plan"] or "", "cilin", _now()))
            conn.execute("DELETE FROM queue_entries WHERE id=?", (row["id"],))
            given.append(p["receiver"])
        # НЕ перепаковываем q2 — остальные сохраняют свои позиции (стабильность для возврата).
        _log(conn, "cilin_distribute", actor=_actor_name(actor), request=request,
             detail="выпало %d · выдано %d · ждут ещё %d" % (payload.count, n, len(elig) - n))
    return {"ok": True, "dropped": payload.count, "given": given, "given_count": n,
            "waiting": [p["receiver"] for p in elig[n:]]}


def _restore_served_row(conn, s, actor_name: str, request) -> None:
    """Вернуть одного из снимка queue_served_last на прежнюю позицию за его ресурс.
    ДРОБНАЯ позиция (orig_pos − 0.5) БЕЗ каскадного сдвига остальных: человек встаёт ровно
    перед тем, кто сейчас на его прежнем месте, а чужие pos НЕ трогаются. Так возврат любого
    числа людей стабилен и не «съезжает» (каскад pos+1 путал порядок при нескольких возвратах)."""
    q = s["queue"]
    target = float(s["orig_pos"]) - 0.5
    existing = conn.execute(
        "SELECT id FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
        (q, s["main_canon"])).fetchone()
    if existing:
        conn.execute("UPDATE queue_entries SET pos=?, not_collected=0 WHERE id=?", (target, existing["id"]))
    else:
        conn.execute(
            "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, recipient,"
            " auto_repeat, auto_plan, added_by, added_at, not_collected)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,0)",
            (q, target, s["main_canon"], s["nick"], s["cls"], s["resource"], s["recipient"],
             s["auto_repeat"], s["auto_plan"], "restore", _now()))
    conn.execute("DELETE FROM queue_served_last WHERE id=?", (s["id"],))
    # ВАЖНО: возврат «не забрал» НЕ сбрасывает маркер недельного сдвига. Сдвиг очереди —
    # РОВНО ОДИН раз за неделю; возвращённые ждут СЛЕДУЮЩЕГО цикла. Иначе повторное
    # «Опубликовать» после возврата снова двигало бы очередь → интерливинг и путаница.
    # Принудительный пересдвиг в ту же неделю (редкий ре-ду) — только явным force.
    _log(conn, "restore_uncollected", actor=actor_name, nick=s["nick"], queue=q,
         request=request, detail="возвращён (не забрал) — на прежнее место за свой ресурс")


@router.post("/admin/return-nicks")
def return_nicks(payload: ReturnNicksIn, request: Request,
                 actor: dict = Depends(require_admin)) -> dict:
    """«Не забрал» по никам (перемотка назад): ники через запятую/перенос → вернуть каждого из
    снимка queue_served_last на ПРЕЖНЮЮ позицию за ЕГО ресурс, в ту очередь, где он не получил.
    Работает и после 00:00. Снимок пишется отчётом и раздачей цилиня."""
    import re as _re
    raw = [x.strip() for x in _re.split(r"[\n,;]+", payload.nicks) if x.strip()]
    returned = []; not_found = []
    with db.connection() as conn:
        served = conn.execute("SELECT * FROM queue_served_last").fetchall()
        for nk in raw:
            c = db._valor_canon(nk)
            low = nk.strip().lower()
            # ВСЕ записи этого человека в снимке (по ВСЕМ очередям) — возвращаем сразу везде,
            # а не по одной. Раньше брали только первую → человек в нескольких очередях
            # оставался частично невозвращённым.
            matches = [s for s in served
                       if db._valor_canon(s["nick"] or "") == c or (s["nick"] or "").strip().lower() == low]
            if not matches:
                not_found.append(nk)
                continue
            for s in matches:
                _restore_served_row(conn, s, _actor_name(actor), request)
            done = {s["id"] for s in matches}
            served = [x for x in served if x["id"] not in done]
            returned.append("%s (очередей: %d)" % (matches[0]["nick"], len(matches)))
    return {"ok": True, "returned": returned, "not_found": not_found}


@router.get("/due")
def due(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Кто на этой неделе «дошёл» (получил бы ресурс) — для отметки «не забрал».
    По умолчанию все они пройдут дальше; отмеченные «не забрал» останутся в очереди."""
    with db.connection() as conn:
        report = _build_report(conn)
    out = []
    for Q in report["queues"]:
        for r in Q["rows"]:
            if r["status"] == "ok" and r.get("got"):
                # что человек получает (может быть несколько ресурсов) — краткой строкой
                got = r["got"]
                summary = ", ".join("%s ×%d" % (distribution.res_name(k), v) for k, v in got.items())
                out.append({"entry_id": r["id"], "queue": Q["queue"], "nick": r["nick"],
                            "got": summary, "recipient": r["recipient"],
                            "not_collected": r["not_collected"]})
    return {"due": out, "has_valor": report.get("has_valor", False)}


@router.post("/mark-uncollected")
def mark_uncollected(payload: MarkUncollectedIn, request: Request,
                     actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Офицер/админ отмечает, что человек НЕ забрал ресурс → он останется в очереди."""
    with db.connection() as conn:
        row = conn.execute("SELECT nick, queue FROM queue_entries WHERE id=?",
                           (payload.entry_id,)).fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
        conn.execute("UPDATE queue_entries SET not_collected=? WHERE id=?",
                     (1 if payload.uncollected else 0, payload.entry_id))
        _log(conn, "uncollected", actor=_actor_name(actor), nick=row["nick"], queue=row["queue"],
             request=request, detail=("не забрал — остаётся" if payload.uncollected else "забрал — пройдёт"))
    return {"ok": True}


@router.get("/served-last")
def served_last(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Кто «получил» ресурс на ПОСЛЕДНЕЙ финализации (вс 00:00) и уже вышел из очереди.
    Если офицер не успел отметить «не забрал» до сдвига — отсюда его можно вернуть."""
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT id, queue, orig_pos, nick, resource FROM queue_served_last ORDER BY queue, orig_pos"
        ).fetchall()
    out = [{"id": r["id"], "queue": r["queue"], "nick": r["nick"],
            "resource": distribution.res_name(r["resource"]) if r["resource"] else ""} for r in rows]
    return {"served": out}


@router.post("/restore-uncollected")
def restore_uncollected(payload: RestoreUncollectedIn, request: Request,
                        actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Вернуть в очередь того, кто НЕ забрал ресурс, но уже вылетел при сдвиге. Ставит на
    прежнюю позицию (дробный orig_pos−0.5, без сдвига остальных) через единый _restore_served_row."""
    with db.connection() as conn:
        s = conn.execute("SELECT * FROM queue_served_last WHERE id=?", (payload.served_id,)).fetchone()
        if not s:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
        _restore_served_row(conn, s, _actor_name(actor), request)
    return {"ok": True}


def _make_privileged(conn, main_canon, nick, cls, res, add_stacks, added_by):
    """Ставит ОТДЕЛЬНУЮ светящуюся модель ПЕРВОЙ в очереди 0 (жетон применён). ВАЖНО:
    НЕ трогает обычную запись человека (privileged=0) — если он уже стоял в очереди,
    его обычная моделька остаётся на месте и движется дальше, а жетон добавляет ВТОРУЮ,
    привилегированную, у самого торговца. Повторное применение копит priv_stacks на ней.
    priv_stacks — единый источник объёма (стаки × размер пачки, пересчёт при смене ресурса)."""
    ex = conn.execute("SELECT id, priv_stacks FROM queue_entries WHERE queue=0 AND main_canon=? AND privileged=1",
                      (main_canon,)).fetchone()
    if ex:
        # ПОВТОРНОЕ применение — позицию НЕ меняем (сохраняем порядок применения жетонов, FIFO),
        # только копим стаки и, при желании, меняем ресурс.
        conn.execute("UPDATE queue_entries SET resource=?, priv_stacks=? WHERE id=?",
                     (res, ex["priv_stacks"] + add_stacks, ex["id"]))
    else:
        # НОВЫЙ жетонщик встаёт ПОСЛЕ уже применивших жетон, но ПЕРЕД обычной очередью — так среди
        # жетонщиков работает нормальный порядок (кто первый применил — первый получает, FIFO).
        # (Раньше front = MIN(pos)−1 давал каждому НОВОМУ меньшую позицию → LIFO, неверно.)
        min_reg = conn.execute("SELECT MIN(pos) m FROM queue_entries WHERE queue=0 AND privileged=0").fetchone()["m"]
        max_priv = conn.execute("SELECT MAX(pos) m FROM queue_entries WHERE queue=0 AND privileged=1").fetchone()["m"]
        if min_reg is None:
            min_reg = 1.0
        if max_priv is None:
            front = min_reg - 1.0                      # первый жетонщик — прямо перед очередью
        else:
            front = max_priv + (min_reg - max_priv) / 2.0   # между последним жетонщиком и очередью
        conn.execute(
            "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, privileged, priv_stacks, added_by, added_at)"
            " VALUES (0,?,?,?,?,?,1,?,?,?)",
            (front, main_canon, nick, cls, res, add_stacks, added_by, _now()))


@router.post("/priv-claim")
def priv_claim(payload: PrivClaimIn, request: Request) -> dict:
    """Суперспособность топ-3: взять ОБЫЧНЫЙ ресурс ВНЕ очереди, тратя накопленные жетоны.
    1 жетон = 1 пачка. Взятое вычитается из недельного пула распределения."""
    res = payload.resource.strip()
    r = distribution.REWARDS.get(res)
    if not r or r["q"] != 0 or r["mode"] == "pack":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "only_regular_stack")
    with db.connection() as conn:
        acc = _player_ctx(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        # ДОБЛЕСТЬ проверяется как в обычной очереди (q0 ≥ 60): жетон ТОП-3 даёт взять ресурс
        # ВНЕ очереди, но НЕ отменяет порог. Если доблести мало — жетон НЕ тратим (проверка ДО
        # списания), человек просто остаётся в очереди и НЕ получает ресурс.
        vmap, _vn = _valor_map(conn)
        pv = vmap.get(acc["main_canon"])
        if pv is None:
            pv = vmap.get(db._valor_canon(acc.get("main_nick") or acc.get("reg_nick") or "")) or 0
        thr = VALOR_THRESHOLD.get(0, 60)
        if pv < thr:
            raise HTTPException(status.HTTP_409_CONFLICT, "low_valor:%d:%d" % (pv, thr))
        row = conn.execute("SELECT tokens FROM queue_privileges WHERE canon=?",
                           (acc["main_canon"],)).fetchone()
        have = row["tokens"] if row else 0
        if have < payload.stacks:
            raise HTTPException(status.HTTP_409_CONFLICT, "not_enough_tokens")
        amount = payload.stacks * r["unit"]
        nick = acc["main_nick"] or acc["reg_nick"]
        # АТОМАРНО списываем жетоны: WHERE tokens>=? защищает от гонки/двойного клика
        # (иначе баланс мог уйти в минус, а ресурсы — бесплатно). rowcount==0 → откат.
        cur = conn.execute(
            "UPDATE queue_privileges SET tokens=tokens-?, updated_at=? WHERE canon=? AND tokens>=?",
            (payload.stacks, _now(), acc["main_canon"], payload.stacks))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_409_CONFLICT, "not_enough_tokens")
        p = _people(conn).get(acc["main_canon"]) or {}
        _make_privileged(conn, acc["main_canon"], nick, p.get("cls", ""), res, payload.stacks, "priv")
        _log(conn, "priv_claim", actor=nick, nick=nick, queue=0, request=request,
             detail="ВНЕ очереди: %s ×%d (жетонов −%d, осталось %d)"
                    % (distribution.res_name(res), amount, payload.stacks, have - payload.stacks))
    return {"ok": True, "tokens": have - payload.stacks, "amount": amount}


@router.post("/admin/grant-token")
def grant_token(payload: GrantTokenIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Админ выдаёт/снимает жетоны суперспособности игроку (для теста, напр. Лирия!)."""
    with db.connection() as conn:
        p = _resolve_person(conn, payload.nick)
        cn = p["main_canon"] if p else db._valor_canon(payload.nick)
        nick = p["main_nick"] if p else payload.nick
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        conn.execute(
            "INSERT INTO queue_privileges (canon, nick, tokens, updated_at) VALUES (?,?,?,?)"
            " ON CONFLICT(canon) DO UPDATE SET tokens=MAX(0, tokens+?), nick=excluded.nick, updated_at=excluded.updated_at",
            (cn, nick, max(0, payload.count), _now(), payload.count))
        row = conn.execute("SELECT tokens FROM queue_privileges WHERE canon=?", (cn,)).fetchone()
        _log(conn, "priv_grant", actor=_actor_name(actor), nick=nick, request=request,
             detail="жетонов %+d (тест) → %d" % (payload.count, row["tokens"]))
    return {"ok": True, "nick": nick, "tokens": row["tokens"]}


def _canon_and_person(conn, nick: str):
    """(canon, nick_для_показа, cls). Если ник не в ростере — используем сам ник
    (для теста работает даже с непривычным ником), класс пустой."""
    p = _people(conn).get(db._valor_canon(nick))
    if p:
        return p["main_canon"], p["nick"], p.get("cls", "")
    return db._valor_canon(nick), nick, ""


@router.post("/admin/test-fill")
def test_fill(payload: TestFillIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """ТЕСТ: набивает каждую очередь случайными людьми из ростера (added_by='test')
    с случайным подходящим ресурсом — чтобы проверить, как всё работает."""
    import random
    added = 0
    with db.connection() as conn:
        uniq, seen = [], set()
        for p in _people(conn).values():
            if p["main_canon"] in seen:
                continue
            seen.add(p["main_canon"]); uniq.append(p)
        # классы для синтетических людей — берём из реального ростера (гарантированно валидны)
        classes = sorted({p["cls"] for p in uniq if p.get("cls")}) or ["воин", "маг", "лучник", "друид"]
        for qn in QUEUES:
            byq = [k for k, v in distribution.REWARDS.items() if v["q"] == qn]
            existing = {r["main_canon"] for r in
                        conn.execute("SELECT main_canon FROM queue_entries WHERE queue=?", (qn,))}
            cand = [p for p in uniq if p["main_canon"] not in existing]
            random.shuffle(cand)
            pos = (conn.execute("SELECT MAX(pos) m FROM queue_entries WHERE queue=?", (qn,)).fetchone()["m"] or 0)
            real = cand[:payload.n]
            for p in real:
                pos += 1
                res = random.choice(byq) if byq else ""
                conn.execute(
                    "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, added_by, added_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (qn, pos, p["main_canon"], p["nick"], p["cls"], res, "test", _now()))
                added += 1
            # реальных уникальных в ростере меньше n → добиваем синтетическими «Тест N»
            for _i in range(payload.n - len(real)):
                pos += 1
                res = random.choice(byq) if byq else ""
                mc = "тест-%d-%d" % (qn, pos)          # уникальный main_canon (не пересечётся с реальными)
                conn.execute(
                    "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, added_by, added_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (qn, pos, mc, "Тест %d" % pos, random.choice(classes), res, "test", _now()))
                added += 1
        _log(conn, "test_fill", actor=_actor_name(actor), request=request,
             detail="добавлено тестовых: %d (по %d/очередь)" % (added, payload.n))
    return {"ok": True, "added": added}


@router.post("/admin/test-add")
def test_add(payload: TestAddIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """ТЕСТ: добавить в ОДНУ очередь людей с ЗАДАННЫМИ ресурсами (напр. 10 с метеоритом,
    20 с камнем) и/или со случайными. Берёт случайных людей из ростера, кого ещё нет в этой
    очереди; каждый человек добавляется один раз за вызов."""
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    import random
    qn = payload.queue
    byq = [k for k, v in distribution.REWARDS.items() if v["q"] == qn]
    added = 0
    with db.connection() as conn:
        existing = {r["main_canon"] for r in conn.execute("SELECT main_canon FROM queue_entries WHERE queue=?", (qn,))}
        pool, seen = [], set()
        for p in _people(conn).values():
            if p["main_canon"] in seen or p["main_canon"] in existing:
                continue
            seen.add(p["main_canon"]); pool.append(p)
        random.shuffle(pool)
        pos = (conn.execute("SELECT MAX(pos) m FROM queue_entries WHERE queue=?", (qn,)).fetchone()["m"] or 0)
        state = {"i": 0, "pos": pos}

        def add(res):
            nonlocal added
            if state["i"] >= len(pool):
                return False
            p = pool[state["i"]]; state["i"] += 1; state["pos"] += 1
            conn.execute(
                "INSERT INTO queue_entries (queue,pos,main_canon,nick,cls,resource,added_by,added_at) VALUES (?,?,?,?,?,?,?,?)",
                (qn, state["pos"], p["main_canon"], p["nick"], p["cls"], res, "test", _now()))
            added += 1
            return True

        for it in payload.items:
            res = (it.resource or "").strip()
            if res not in byq:
                continue
            for _ in range(it.count):
                if not add(res):
                    break
        for _ in range(payload.random_count):
            if not add(random.choice(byq) if byq else ""):
                break
        _log(conn, "test_add", actor=_actor_name(actor), queue=qn, request=request,
             detail="добавлено %d (осталось в пуле %d)" % (added, len(pool) - state["i"]))
    return {"ok": True, "added": added, "pool_left": len(pool) - state["i"]}


@router.post("/admin/test-clear")
def test_clear(request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Убирает всех тестовых (added_by='test') и записи админ-предпросмотра (admin-as:*)."""
    with db.connection() as conn:
        cur = conn.execute("DELETE FROM queue_entries WHERE added_by='test' OR added_by LIKE 'admin-as:%'")
        n = cur.rowcount
        _log(conn, "test_clear", actor=_actor_name(actor), request=request, detail="убрано тестовых: %d" % n)
    return {"ok": True, "removed": n}


@router.post("/admin/join-as")
def join_as(payload: JoinAsIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """ТЕСТ: админ встаёт в очередь ОТ ИМЕНИ ника (напр. Лирия!). Если уже стоит —
    просто меняет ресурс. Модель берётся по классу этого ника."""
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    res = (payload.resource or "").strip()[:64]
    import json as _json
    valid = _QUEUE_ITEMS[payload.queue] if 0 <= payload.queue < len(_QUEUE_ITEMS) else []
    picked = [x for x in (payload.resources or []) if x in valid]
    if not picked and res in valid:
        picked = [res]
    if picked:
        res = picked[0]
    res_json = _json.dumps(picked)
    with db.connection() as conn:
        cn, nick, cls = _canon_and_person(conn, payload.nick)
        ex = conn.execute("SELECT id FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
                          (payload.queue, cn)).fetchone()
        if ex:
            conn.execute("UPDATE queue_entries SET resource=?, resources=?, recipient=? WHERE id=?",
                         (res, res_json, (payload.recipient or "").strip()[:64], ex["id"]))
        else:
            pos = (conn.execute("SELECT MAX(pos) m FROM queue_entries WHERE queue=?", (payload.queue,)).fetchone()["m"] or 0) + 1
            conn.execute(
                "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, resources, recipient, added_by, added_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (payload.queue, pos, cn, nick, cls, res, res_json, (payload.recipient or "").strip()[:64],
                 "admin-as:" + _actor_name(actor), _now()))
        _log(conn, "join_as", actor=_actor_name(actor), nick=nick, queue=payload.queue, request=request,
             detail="АДМИН встал как «%s»%s" % (nick, (" за " + distribution.res_name(res)) if res else ""))
    return {"ok": True, "nick": nick}


@router.post("/admin/priv-claim-as")
def priv_claim_as(payload: PrivClaimAsIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """ТЕСТ: админ жмёт «Взять вне очереди» ОТ ИМЕНИ ника (напр. Лирия!) — модель
    встаёт первой со свечением. Жетоны при нехватке добираются (чтобы было видно списание)."""
    res = payload.resource.strip()
    r = distribution.REWARDS.get(res)
    if not r or r["q"] != 0 or r["mode"] == "pack":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "only_regular_stack")
    with db.connection() as conn:
        cn, nick, cls = _canon_and_person(conn, payload.nick)
        row = conn.execute("SELECT tokens FROM queue_privileges WHERE canon=?", (cn,)).fetchone()
        have = row["tokens"] if row else 0
        if have < payload.stacks:                 # для теста добираем недостающие жетоны
            conn.execute(
                "INSERT INTO queue_privileges (canon, nick, tokens, updated_at) VALUES (?,?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET tokens=?, nick=excluded.nick, updated_at=excluded.updated_at",
                (cn, nick, payload.stacks, _now(), payload.stacks))
            have = payload.stacks
        conn.execute("UPDATE queue_privileges SET tokens=tokens-?, updated_at=? WHERE canon=?",
                     (payload.stacks, _now(), cn))
        _make_privileged(conn, cn, nick, cls, res, payload.stacks, "admin-as:priv")
        amount = payload.stacks * r["unit"]
        _log(conn, "priv_claim", actor=_actor_name(actor), nick=nick, queue=0, request=request,
             detail="АДМИН-ТЕСТ вне очереди как «%s»: %s ×%d (жетонов −%d)"
                    % (nick, distribution.res_name(res), amount, payload.stacks))
    return {"ok": True, "nick": nick, "tokens": have - payload.stacks, "amount": amount}


@router.post("/admin/leave-as")
def leave_as(payload: LeaveAsIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    """ТЕСТ: убрать ник (напр. Лирия!) из очереди. Зеркалит игрока:
    privileged=None → убрать всё; False → только обычное место; True → только жетон (+возврат жетонов)."""
    with db.connection() as conn:
        cn, nick, _ = _canon_and_person(conn, payload.nick)
        if payload.privileged is None:
            conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=?", (payload.queue, cn))
            det = "АДМИН убрал «%s» из очереди (всё)" % nick
        elif payload.privileged:
            # вернуть жетон ТОП-3: удалить привилегированную запись и вернуть потраченные жетоны в кошелёк
            row = conn.execute(
                "SELECT priv_stacks FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=1",
                (payload.queue, cn)).fetchone()
            stacks = row["priv_stacks"] if row else 0
            cur = conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=1",
                               (payload.queue, cn))
            if cur.rowcount > 0 and stacks > 0:
                conn.execute("UPDATE queue_privileges SET tokens=tokens+?, updated_at=? WHERE canon=?",
                             (stacks, _now(), cn))
            det = "АДМИН вернул жетон «%s» (обычное место осталось)" % nick
        else:
            conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
                         (payload.queue, cn))
            det = "АДМИН убрал «%s» с обычного места (жетон остался)" % nick
        _log(conn, "leave_as", actor=_actor_name(actor), nick=nick, queue=payload.queue, request=request,
             detail=det)
    return {"ok": True}


@router.get("/privileges")
def privileges(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Кто накопил жетоны суперспособности + внеочередные захваты этой недели (офицер+админ)."""
    with db.connection() as conn:
        holders = conn.execute(
            "SELECT nick, tokens FROM queue_privileges WHERE tokens>0 ORDER BY tokens DESC, nick").fetchall()
        claims = _priv_claims(conn)
    return {"holders": [dict(h) for h in holders],
            "claims": [{"nick": c["nick"], "resource": distribution.res_name(c["resource"]),
                        "amount": c["amount"], "at": ""} for c in claims]}


def _prune_left_clan(conn, request=None, actor_name="") -> list[str]:
    """Убирает из очереди тех, кого нет в текущем ростере клана (вылетели).
    Защита: если ростер пуст (нет снапшота) — НИЧЕГО не трогаем."""
    idx = _people(conn)
    if not idx:
        return []
    valid = {p["main_canon"] for p in idx.values()} | set(idx.keys())
    removed = []
    for r in conn.execute("SELECT id, main_canon, nick FROM queue_entries").fetchall():
        if r["main_canon"] not in valid:
            conn.execute("DELETE FROM queue_entries WHERE id=?", (r["id"],))
            removed.append(r["nick"])
            _log(conn, "left_clan", actor=actor_name, nick=r["nick"], request=request,
                 detail="убран из очереди — нет в списке клана (вылетел)")
    return removed


@router.post("/admin/prune-left")
def prune_left(request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Ручная чистка: убрать вылетевших из клана из всех очередей."""
    with db.connection() as conn:
        removed = _prune_left_clan(conn, request, _actor_name(actor))
    return {"ok": True, "removed": removed}


_QUEUE_NAMES = ["Обычные", "Редкие (R)", "Легендарные (S)"]


def _save_low_valor_notices(conn, report) -> None:
    """Копит уведомления «очередь подошла, но не хватило доблести» по МЭЙН-канону.
    Заменяет прошлые непрочитанные (не плодит дубли по неделям)."""
    import json as _json
    misses: dict[str, dict] = {}
    for Q in report.get("queues", []):
        qn = Q.get("queue", 0)
        thr = Q.get("threshold", 0)
        for r in Q.get("rows", []):
            if r.get("status") != "low_valor":
                continue
            mc = r.get("main_canon") or ""
            if not mc:
                continue
            d = misses.setdefault(mc, {"nick": r.get("nick", ""), "items": []})
            d["items"].append({
                "queue": qn, "queue_name": _QUEUE_NAMES[qn] if 0 <= qn < 3 else str(qn),
                "resource": r.get("resource", ""), "res_name": r.get("res_name", ""),
                "qty": r.get("res_unit", 0), "threshold": thr, "valor": r.get("valor", 0),
            })
    # свежая финализация всегда заменяет прошлые непрочитанные low_valor
    conn.execute("DELETE FROM queue_notices WHERE kind='low_valor' AND seen=0")
    now = _now()
    for mc, data in misses.items():
        conn.execute(
            "INSERT INTO queue_notices (canon, kind, payload, created_at, seen) VALUES (?,?,?,?,0)",
            (mc, "low_valor", _json.dumps(data, ensure_ascii=False), now))


@router.post("/admin/advance")
async def advance(request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Финализация недели:
    1) убрать вылетевших из клана; 2) построить отчёт → отправить в офицерский чат;
    3) сдвиг очереди: получившие с авто-повтором/планом встают В КОНЕЦ (план — со
       следующим ресурсом), без авто-повтора — ВЫХОДЯТ из очереди; остальные (не
       хватило доблести/ресурс кончился/не выбран) остаются в начале."""
    import json as _json
    with db.connection() as conn:
        pruned = _prune_left_clan(conn, request, _actor_name(actor))   # (4) вылетевшие
        report = _build_report(conn)
    channels = await _send_report_to_chats(report)     # отчёт по умолчанию уходит в чаты
    served_by_q = {}
    for Q in report["queues"]:
        served_by_q[Q["queue"]] = {r["id"] for r in Q["rows"]
                                   if r["status"] == "ok" and r["id"] is not None}
    requeued = left_after = stayed_uncollected = 0
    with db.connection() as conn:
        conn.execute("DELETE FROM queue_served_last")   # снимок «получивших» перезаписываем
        for q in QUEUES:
            rows = conn.execute(
                "SELECT id, pos, main_canon, nick, cls, resource, recipient, auto_repeat, auto_plan, not_collected"
                " FROM queue_entries WHERE queue=? ORDER BY pos, id", (q,)).fetchall()
            served = served_by_q.get(q, set())
            keep_ids = []          # остаются впереди (не получили ИЛИ не забрали)
            requeue_ids = []       # авто-повтор/план → в конец
            for r in rows:
                if r["id"] not in served:
                    keep_ids.append(r["id"])           # не хватило/кончилось/не выбран → впереди
                elif r["not_collected"]:               # получил бы, но НЕ забрал → остаётся впереди
                    keep_ids.append(r["id"])
                    conn.execute("UPDATE queue_entries SET not_collected=0 WHERE id=?", (r["id"],))
                    stayed_uncollected += 1
                else:                                  # забрал → очередь проходит дальше
                    # снимок на случай, если офицер отметит «не забрал» уже ПОСЛЕ сдвига —
                    # тогда вернём человека в очередь на его прежнюю позицию (orig_pos).
                    conn.execute(
                        "INSERT INTO queue_served_last (queue, orig_pos, main_canon, nick, cls,"
                        " resource, recipient, auto_repeat, auto_plan, added_by, served_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (q, r["pos"], r["main_canon"], r["nick"], r["cls"], r["resource"],
                         r["recipient"], r["auto_repeat"], r["auto_plan"] or "", "advance", _now()))
                    try:
                        plan = _json.loads(r["auto_plan"]) if r["auto_plan"] else []
                    except (ValueError, TypeError):
                        plan = []
                    if plan:                     # план: берём следующий ресурс, встаём в конец
                        conn.execute("UPDATE queue_entries SET resource=?, auto_plan=? WHERE id=?",
                                     (plan[0], _json.dumps(plan[1:]), r["id"]))
                        requeue_ids.append(r["id"]); requeued += 1
                    elif r["auto_repeat"]:       # повтор: тот же ресурс, в конец
                        requeue_ids.append(r["id"]); requeued += 1
                    else:                        # разово: выходит из очереди
                        conn.execute("DELETE FROM queue_entries WHERE id=?", (r["id"],))
                        left_after += 1
            pos = 1
            for i in keep_ids + requeue_ids:            # оставшиеся впереди, авто → в конец
                conn.execute("UPDATE queue_entries SET pos=? WHERE id=?", (float(pos), i))
                pos += 1
        _log(conn, "advance", actor=_actor_name(actor), request=request,
             detail="вылетевших:%d · не забрали (остались):%d · авто-переочередь:%d · вышли:%d · отчёт tg=%s vk=%s"
                    % (len(pruned), stayed_uncollected, requeued, left_after, channels.get("tg"), channels.get("vk")))
        # снимок недели в архив (для ручной проверки истории распределений)
        n_groups = len(report.get("groups") or [])
        n_people = sum(len(g.get("people") or []) for g in (report.get("groups") or []))
        lo = {k: v for k, v in (report.get("leftovers") or {}).items() if v > 0}
        summary = "групп: %d · получателей: %d · остаток: %s" % (
            n_groups, n_people, (", ".join("%s×%d" % (distribution.res_name(k), v) for k, v in lo.items()) or "нет"))
        conn.execute(
            "INSERT INTO queue_reports (created_at, stages, report, channels, summary, actor)"
            " VALUES (?,?,?,?,?,?)",
            (_now(), report.get("stages", 0), _json.dumps(report, ensure_ascii=False),
             _json.dumps(channels, ensure_ascii=False), summary, _actor_name(actor)))
        # СУПЕРСПОСОБНОСТЬ: топ-3 доблести получают +1 жетон (использовать на след. неделе).
        # Единая ИДЕМПОТЕНТНАЯ функция (та же, что зовёт валор-«Готово») — если жетоны за
        # эту неделю уже начислены при обновлении доблести, повторно НЕ начисляем.
        _gt = grant_top3_valor_tokens(conn, week=None, actor_name=_actor_name(actor))
        granted = _gt.get("granted", [])
        # УВЕДОМЛЕНИЯ «не хватило доблести»: у кого очередь подошла, но доблести не хватило —
        # копим по мэйн-канону, покажем при следующем входе в раздел.
        _save_low_valor_notices(conn, report)
        # внеочередные захваты недели отработали (уже вычтены) → чистим на новую неделю;
        # привилегированные записи (взяли жетоном) тоже убираем — ресурс уже получен
        conn.execute("DELETE FROM queue_entries WHERE privileged=1")
        conn.execute("DELETE FROM queue_priv_claims")
    return {"ok": True, "requeued": requeued, "left_removed": left_after,
            "stayed_uncollected": stayed_uncollected, "priv_granted": granted,
            "pruned": len(pruned), "pruned_nicks": pruned, "channels": channels}


@router.get("/admin/log")
def admin_log(_: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT at, kind, actor, nick, queue, ip, user_agent, detail FROM queue_log"
            " ORDER BY id DESC LIMIT 300").fetchall()
        accs = conn.execute(
            "SELECT main_nick, reg_nick, email, created_at, last_login_at FROM queue_accounts"
            " ORDER BY last_login_at DESC").fetchall()
        devs = conn.execute(
            "SELECT d.ip, d.user_agent, d.last_seen_at, a.main_nick FROM queue_devices d"
            " LEFT JOIN queue_accounts a ON a.id=d.account_id ORDER BY d.last_seen_at DESC LIMIT 200").fetchall()
    return {"log": [dict(r) for r in rows], "accounts": [dict(a) for a in accs],
            "devices": [dict(x) for x in devs]}


@router.get("/admin/accounts")
def admin_accounts(_: dict = Depends(require_admin)) -> dict:
    """Полный список зарегистрированных в очереди аккаунтов с анализом ника: что ввёл при
    регистрации (reg_nick), к какому мэйну привязался, СОВПАДАЕТ ли с реестром/доблестью.
    status: exact — ввёл существующий ник; resolved — опознан (мэйн есть, но ввод неточный,
    напр. латиница/усечение); unknown — ника нет ни в реестре, ни в доблести (вероятно ошибся)."""
    with db.connection() as conn:
        idx = _people(conn)
        tmap = _build_translit_map(idx)
        accs = conn.execute(
            "SELECT main_canon, main_nick, reg_nick, email, created_at, last_login_at"
            " FROM queue_accounts ORDER BY last_login_at DESC").fetchall()
        inq = {r["main_canon"] for r in conn.execute("SELECT DISTINCT main_canon FROM queue_entries")}
    out = []
    for a in accs:
        mc = a["main_canon"]
        rc = db._valor_canon(a["reg_nick"] or "")
        exact = bool(rc and rc in idx)
        p = idx.get(mc) or idx.get(rc)
        if p is None:                                   # префикс (усечённые твины) как в очереди
            res = _resolve_partial(idx, mc)
            if res:
                p = res[1]
        if p is None:                                   # латиница↔кириллица (однозначно)
            tc = tmap.get(_translit_canon(a["reg_nick"] or ""))
            if tc and tc in idx:
                p = idx[tc]
        status = "exact" if exact else ("resolved" if p is not None else "unknown")
        roster_nick = (p or {}).get("nick", "")
        out.append({
            "reg_nick": a["reg_nick"], "main_nick": a["main_nick"], "email": a["email"],
            "created_at": a["created_at"], "last_login_at": a["last_login_at"],
            "status": status, "roster_nick": roster_nick,
            "roster_main": (p or {}).get("main_nick", ""),
            "is_twin": bool((p or {}).get("is_twin")),
            "cls": (p or {}).get("cls", ""),
            "in_queue": mc in inq,
        })
    return {"accounts": out}


@router.get("/activity-log")
def activity_log(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Активность очереди (без IP/аккаунтов) — доступно офицерам и админу.
    Кто вставал в очередь/за чем, выходил, менял ресурс, финализации и т.д."""
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT at, kind, actor, nick, queue, detail FROM queue_log"
            " ORDER BY id DESC LIMIT 400").fetchall()
    return {"log": [dict(r) for r in rows]}


def _iso_week_key(created_at: str) -> str:
    """ISO-неделя из created_at (для анти-дубля недель в истории). Все повторные публикации/
    перепубликации/пробные отчёты за одну неделю падают в один ключ → показываем только последний."""
    from datetime import datetime
    s = (created_at or "").strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.fromisoformat(s[:19])   # без таймзоны
        except ValueError:
            return created_at or ""
    y, w, _ = dt.isocalendar()
    return "%04d-W%02d" % (y, w)


@router.get("/history")
def history(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Архив недельных распределений (метаданные) — офицерам и админу.

    АНТИ-ДУБЛЬ НЕДЕЛЬ: за одну неделю бывает несколько записей queue_reports (перепубликации,
    пробные прогоны, дельта-отчёты). Показываем ТОЛЬКО последнюю (max id) за каждую ISO-неделю —
    один таб на неделю, без дублей."""
    import json as _json
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT id, created_at, stages, channels, summary, actor FROM queue_reports"
            " ORDER BY id DESC LIMIT 200").fetchall()
    out = []
    seen_weeks = set()
    for r in rows:                       # от новых к старым → первый за неделю = самый свежий
        wk = _iso_week_key(r["created_at"])
        if wk in seen_weeks:
            continue
        seen_weeks.add(wk)
        try:
            ch = _json.loads(r["channels"]) if r["channels"] else {}
        except (ValueError, TypeError):
            ch = {}
        out.append({"id": r["id"], "at": r["created_at"], "stages": r["stages"], "week": wk,
                    "channels": ch, "summary": r["summary"], "actor": r["actor"]})
        if len(out) >= 60:
            break
    return {"reports": out}


@router.get("/history/{rid}")
def history_one(rid: int, _: dict = Depends(require_officer_or_admin)) -> dict:
    """Полный отчёт распределения за конкретную неделю — офицерам и админу."""
    import json as _json
    with db.connection() as conn:
        row = conn.execute(
            "SELECT created_at, stages, report, channels FROM queue_reports WHERE id=?", (rid,)).fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    try:
        rep = _json.loads(row["report"]) if row["report"] else {}
    except (ValueError, TypeError):
        rep = {}
    try:
        ch = _json.loads(row["channels"]) if row["channels"] else {}
    except (ValueError, TypeError):
        ch = {}
    return {"report": rep, "at": row["created_at"], "channels": ch}


# таблицы создаём при импорте модуля (db-файл уже сконфигурирован settings)
try:
    ensure_queue_tables()
except Exception:
    pass
