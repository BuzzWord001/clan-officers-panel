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
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import db
import distribution
import bot_tg
import bot_vk
import auth_pwd
from config import settings
from session import require_admin, current_session, set_session
from api_chat import require_bot_token   # bot-token auth (десктоп PW Анализ доблести)


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
        # миграция: сколько ПАЧЕК взято жетоном на этой записи (источник claim'а —
        # чтобы при смене ресурса пересчитать объём автоматически)
        try:
            conn.execute("ALTER TABLE queue_entries ADD COLUMN priv_stacks INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # миграция: слой объекта на сцене — '' (авто по y) | 'front' | 'back'
        try:
            conn.execute("ALTER TABLE queue_placements ADD COLUMN z TEXT NOT NULL DEFAULT ''")
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
    return {"main_nick": acc["main_nick"], "main_canon": acc["main_canon"],
            "reg_nick": acc["reg_nick"], "email": acc["email"]}


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


def _officer_canons(conn) -> frozenset:
    """Каноны ников, которых считаем ОФИЦЕРАМИ:
      1) тег 'officer' в valor_tags (роль на сайте);
      2) участники ОФИЦЕРСКОГО чата TG/VK (chat_messages, chat_group='officers') —
         их ники (user_display/user_username) сопоставляем с ростером: сначала точным
         каноном, а если не совпало — фаззи-похожестью (ник в TG/VK может быть написан
         иначе, напр. «Томат» в TG → офицер «Томат» на сайте).
    Кэш 5 мин (иначе фаззи-цикл гоняется на каждый keystroke автоподсказки)."""
    import time
    now = time.time()
    if _OFFICER_CACHE["at"] > 0 and now - _OFFICER_CACHE["at"] < 300:
        return _OFFICER_CACHE["set"]          # кэшируем и ПУСТОЙ набор (иначе гоняем на каждый keystroke)
    officers = set()
    try:
        for r in conn.execute("SELECT nick_canon FROM valor_tags WHERE tag='officer'"):
            if r["nick_canon"]:
                officers.add(r["nick_canon"])
    except Exception:
        pass
    names = set()
    try:
        for r in conn.execute(
            "SELECT DISTINCT user_display, user_username FROM chat_messages WHERE chat_group='officers'"):
            for nm in (r["user_display"], r["user_username"]):
                if nm and nm.strip():
                    names.add(nm.strip())
    except Exception:
        pass
    if names:
        idx = _people(conn)
        roster = list(idx.keys())
        for nm in names:
            cn = db._valor_canon(nm)
            if not cn:
                continue
            if cn in idx:                       # точное совпадение канона
                officers.add(cn)
                continue
            # Фаззи — ТОЛЬКО для достаточно длинных ников и с ЖЁСТКИМИ условиями,
            # чтобы случайно не пометить офицером обычного игрока (это заблокировало бы
            # ему вход). Офицеры и так покрыты тегом officer + точным совпадением.
            if len(cn) < 6:
                continue
            best_c, best_r, second = None, 0.0, 0.0
            for c in roster:
                if abs(len(c) - len(cn)) > 2:   # сильно разной длины — точно не он
                    continue
                sim = db._valor_similar(cn, c)
                if sim > best_r:
                    second = best_r; best_r, best_c = sim, c
                elif sim > second:
                    second = sim
            if best_c and best_r >= 0.93 and (best_r - second) >= 0.06:  # очень похоже И явный отрыв
                officers.add(best_c)
    res = frozenset(officers)
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
@router.get("/nick-suggest")
def nick_suggest(q: str = Query(..., min_length=1, max_length=64)) -> dict:
    ql = q.strip().lower()
    if len(ql) < 1:
        return {"results": []}
    qcanon = db._valor_canon(ql)
    out = []
    with db.connection() as conn:
        offs = _officer_canons(conn)
        for cn, p in _people(conn).items():
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
        idx = _people(conn)
        cn = db._valor_canon(payload.nick)
        p = idx.get(cn)
        if not p:
            return {"ok": False, "reason": "not_found"}
        acc = _account_by_main(conn, p["main_canon"])
        offs = _officer_canons(conn)
        return {"ok": True, "nick": p["nick"], "main_nick": p["main_nick"],
                "is_twin": p["is_twin"], "registered": bool(acc),
                "officer": (cn in offs or p["main_canon"] in offs)}


@router.post("/register")
def register(payload: RegisterIn, request: Request, response: Response) -> dict:
    with db.connection() as conn:
        cfg = conn.execute("SELECT shared_password_hash FROM queue_config WHERE id=1").fetchone()
        shared = cfg["shared_password_hash"] if cfg else ""
        idx = _people(conn)
        p = idx.get(db._valor_canon(payload.nick))
        off_ok = auth_pwd.verify_officer(payload.shared_password)     # ЖИВОЙ офицерский пароль
        # Кто ввёл ОФИЦЕРСКИЙ пароль — входит КАК ОФИЦЕР (сессия + панель), даже если его
        # нет в чатах TG/VK. Аккаунт игрока не создаём — это отдельная роль.
        if off_ok:
            name = (p["main_nick"] if p else payload.nick.strip()) or "офицер"
            _log(conn, "officer_login", actor=name, nick=name, request=request,
                 detail="офицер через вход в очередь")
            tok = set_session(response, role="officer", name=name)
            return {"ok": True, "role": "officer", "officer": True, "token": tok}
        # Не офицерский пароль. Если выбран ОФИЦЕРСКИЙ ник — обычным паролем нельзя.
        if _is_officer_nick(conn, payload.nick):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "need_officer_password")
        # Обычный игрок — по ОБЩЕМУ паролю гильдии.
        if not (shared and _check(payload.shared_password, shared)):
            if not shared:
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "shared_password_not_set")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_shared_password")

        if not p:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")

        acc = _account_by_main(conn, p["main_canon"])
        if acc:
            # уже есть аккаунт на мэйна — регистрация не нужна, пусть входит паролем
            raise HTTPException(status.HTTP_409_CONFLICT, "already_registered")
        if len(payload.personal_password) < 4:      # личный пароль обязателен для игрока
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "personal_password_too_short")

        cur = conn.execute(
            "INSERT INTO queue_accounts (main_canon, main_nick, reg_nick, email, password_hash,"
            " created_at, last_login_at) VALUES (?,?,?,?,?,?,?)",
            (p["main_canon"], p["main_nick"], p["nick"], payload.email.strip(),
             _hash(payload.personal_password), _now(), _now()))
        acc_id = cur.lastrowid
        dev_token = _set_device(conn, response, acc_id, request)
        _log(conn, "register", actor=p["nick"], nick=p["nick"], request=request,
             detail="email" if payload.email.strip() else "no-email")
        acc = conn.execute("SELECT * FROM queue_accounts WHERE id=?", (acc_id,)).fetchone()
        return {"ok": True, "account": _acc_public(acc), "device_token": dev_token}


@router.post("/login")
def login(payload: LoginIn, request: Request, response: Response) -> dict:
    with db.connection() as conn:
        # Офицерский ник — обычным паролем нельзя, только офицерский (защита ника офицера).
        if _is_officer_nick(conn, payload.nick):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "need_officer_password")
        idx = _people(conn)
        p = idx.get(db._valor_canon(payload.nick))
        main_canon = p["main_canon"] if p else db._valor_canon(payload.nick)
        acc = _account_by_main(conn, main_canon)
        if not acc or not _check(payload.personal_password, acc["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_credentials")
        conn.execute("UPDATE queue_accounts SET last_login_at=? WHERE id=?", (_now(), acc["id"]))
        dev_token = _set_device(conn, response, acc["id"], request)
        _log(conn, "login", actor=acc["main_nick"], nick=acc["main_nick"], request=request)
        return {"ok": True, "account": _acc_public(acc), "device_token": dev_token}


@router.post("/officer-login")
def officer_login(payload: OfficerLoginIn, request: Request, response: Response) -> dict:
    """Вход в очередь КАК ОФИЦЕР по ЖИВОМУ офицерскому паролю (из закрепа чатов TG/VK).
    Ставит офицерскую сессию → человек видит офицерскую панель. Ник — для отображения."""
    if not auth_pwd.verify_officer(payload.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_officer_password")
    with db.connection() as conn:
        p = _people(conn).get(db._valor_canon(payload.nick))
        name = (p["main_nick"] if p else payload.nick.strip()) or "офицер"
        _log(conn, "officer_login", actor=name, nick=name, request=request,
             detail="вход офицером через очередь")
    tok = set_session(response, role="officer", name=name)
    return {"ok": True, "role": "officer", "nick": name, "token": tok}


@router.get("/nick-role")
def nick_role(nick: str = Query(..., min_length=1, max_length=64)) -> dict:
    """Является ли ник офицерским (для подсказки на входе — сменить надпись у пароля)."""
    with db.connection() as conn:
        return {"officer": _is_officer_nick(conn, nick)}


@router.get("/me")
def me(request: Request) -> dict:
    with db.connection() as conn:
        acc = _player_ctx(conn, request)              # игрок ИЛИ офицер (для жетонов/пола)
        dev = _account_from_request(conn, request)    # ТОЛЬКО настоящий игрок — для поля account
        tokens = 0
        gender = ""
        prefer_class = False
        if acc:
            row = conn.execute("SELECT tokens FROM queue_privileges WHERE canon=?",
                               (acc["main_canon"],)).fetchone()
            tokens = row["tokens"] if row else 0
            grow = conn.execute("SELECT gender FROM queue_gender WHERE canon=?",
                                (acc["main_canon"],)).fetchone()
            gender = (grow["gender"] if grow else "") or ""
            prow = conn.execute("SELECT prefer_class FROM queue_model_pref WHERE canon=?",
                                (acc["main_canon"],)).fetchone()
            prefer_class = bool(prow["prefer_class"]) if prow else False
        return {"account": _acc_public(dev) if dev else None, "tokens": tokens,
                "gender": gender, "prefer_class": prefer_class}


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
QUEUES = (0, 1, 2)  # 0 обычные · 1 редкие(R) · 2 легендарные(S)
# Ресурсы каждой очереди (порядок = как на витрине). Для обычной/редкой мультивыбор:
# пустой resources у записи → показываем/раздаём ВСЕ ресурсы очереди (по стаку).
_QUEUE_ITEMS = [
    ["kamen-doblesti", "meteorit", "zhemchuzhina", "znak-edinstva", "koloda-kart", "kamen-bessmertnyh", "pilyulya"],
    ["gramota", "prikaz-feniksa"],
    ["drakonya-cheshuya", "sushchnost-karty", "vysshiy-kamen", "mount-cilin"],
]


def _entry_resources(r):
    """Список выбранных ресурсов записи. Пусто в БД → q0/q1 = все ресурсы очереди (мультивыбор
    по умолчанию), q2 = один выбранный. Всегда только валидные ресурсы своей очереди."""
    import json as _json
    q = r["queue"]
    valid = _QUEUE_ITEMS[q] if 0 <= q < len(_QUEUE_ITEMS) else []
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

# ── параметры движка распределения (подтверждено Лиром 2026-07-16) ──
# Пороги доблести: обычная очередь ≥60, редкие/легендарные ≥100.
VALOR_THRESHOLD = {0: 60, 1: 100, 2: 100}
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


def _entry_public(r, idx, gmap, smap=None, pmap=None, shooters_canon=None, tmap=None) -> dict:
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
    # ник для показа — как в таблице доблести/реестре (p["nick"]), иначе сохранённый при вставании
    disp_nick = p.get("nick") or r["nick"]
    cls = r["cls"] or p.get("cls", "")
    tn = p.get("true_name", "")
    keys = r.keys()
    rcpt = r["recipient"] if "recipient" in keys else ""
    import json as _json
    try:
        plan = _json.loads(r["auto_plan"]) if ("auto_plan" in keys and r["auto_plan"]) else []
    except (ValueError, TypeError):
        plan = []
    return {"id": r["id"], "nick": disp_nick, "cls": cls,
            "main_nick": p.get("main_nick", r["nick"]), "true_name": tn,
            "gender": _gender_of(cls, tn, gmap.get(mc, "")),
            "gender_by": ("manual" if gmap.get(mc) in ("m", "f") else "auto"),
            "prefer_class": bool((pmap or {}).get(mc, 0)),
            "is_shooter": bool(shooters_canon and (mc in shooters_canon
                               or db._valor_canon(disp_nick) in shooters_canon)),
            "resource": (r["resource"] if "resource" in keys else ""),
            "resources": _entry_resources(r),
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
    qs = [[], [], []]
    with db.connection() as conn:
        idx = _people(conn)
        gmap = {r["canon"]: r["gender"]
                for r in conn.execute("SELECT canon, gender FROM queue_gender")}
        pmap = {r["canon"]: r["prefer_class"]
                for r in conn.execute("SELECT canon, prefer_class FROM queue_model_pref")}
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
                qs[r["queue"]].append(_entry_public(r, idx, gmap, smap, pmap, shooters_canon, tmap))
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
        p = _people(conn).get(acc["main_canon"]) or {}
        nick = acc["main_nick"] or acc["reg_nick"]
        res = (payload.resource or "").strip()[:64]
        rcpt = (payload.recipient or "").strip()[:64]
        if not rcpt:   # не указан явно → берём получателя по умолчанию из связки супругов
            sp = conn.execute("SELECT recipient FROM queue_spouses WHERE canon=?",
                              (acc["main_canon"],)).fetchone()
            rcpt = (sp["recipient"] if sp else "")[:64]
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
            "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, resources, recipient,"
            " auto_repeat, auto_plan, added_by, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (q, _append_pos(conn, q), acc["main_canon"], nick, p.get("cls", ""), res, _json.dumps(picked), rcpt,
             1 if payload.auto_repeat else 0, _json.dumps(plan), "self", _now()))
        _log(conn, "join", actor=nick, nick=nick, queue=q, request=request,
             detail=("res=" + res + (" →" + rcpt if rcpt else "") +
                     (" 🔁" if payload.auto_repeat else "") + (" план:%d" % len(plan) if plan else "")))
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
        else:
            conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
                         (payload.queue, acc["main_canon"]))
        _log(conn, "leave", actor=acc["main_nick"], nick=acc["main_nick"],
             queue=payload.queue, request=request, detail=("жетон (возвращён)" if priv else "обычное место"))
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
            if picked:                    # пустой НЕ сохраняем (иначе трактуется как «все ресурсы»)
                import json as _jsonr
                sets.append("resources=?"); vals.append(_jsonr.dumps(picked))
                sets.append("resource=?"); vals.append(picked[0])   # resource = первый (совместимость)
        if payload.recipient is not None:
            sets.append("recipient=?"); vals.append(payload.recipient.strip()[:64])
        if payload.auto_repeat is not None:
            sets.append("auto_repeat=?"); vals.append(1 if payload.auto_repeat else 0)
        if payload.plan is not None:
            import json as _json
            sets.append("auto_plan=?"); vals.append(_json.dumps(_clean_plan(payload.plan, payload.queue)))
        if sets:
            vals.append(row["id"])
            conn.execute("UPDATE queue_entries SET " + ",".join(sets) + " WHERE id=?", vals)
            _log(conn, "set_entry", actor=acc["main_nick"], nick=acc["main_nick"],
                 queue=payload.queue, request=request,
                 detail=("res=" + (payload.resource or "—") + " →" + (payload.recipient or "—") +
                         ("" if payload.auto_repeat is None else (" 🔁" if payload.auto_repeat else " 🚫🔁"))))
    return {"ok": True}


@router.get("/spouses")
def spouses() -> dict:
    """Связки канон→получатель. links — карта (для префилла), items — с никами (для панели)."""
    with db.connection() as conn:
        idx = _people(conn)
        rows = conn.execute(
            "SELECT canon, recipient FROM queue_spouses WHERE recipient!=''").fetchall()
    canon2nick = {p["main_canon"]: p["main_nick"] for p in idx.values()}
    links = {r["canon"]: r["recipient"] for r in rows}
    items = [{"canon": r["canon"], "nick": canon2nick.get(r["canon"], r["canon"]),
              "recipient": r["recipient"]} for r in rows]
    items.sort(key=lambda e: (e["nick"] or "").lower())
    return {"links": links, "items": items}


@router.post("/spouse")
def set_spouse(payload: SpouseIn, request: Request,
               actor: dict = Depends(require_officer_or_admin)) -> dict:
    """Связка «кому этот человек передаёт рес». Доступно офицеру И админу."""
    with db.connection() as conn:
        p = _people(conn).get(db._valor_canon(payload.nick))
        cn = p["main_canon"] if p else db._valor_canon(payload.nick)
        if not cn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")
        rcpt = (payload.recipient or "").strip()[:64]
        if rcpt:
            conn.execute(
                "INSERT INTO queue_spouses (canon, recipient, updated_by, updated_at) VALUES (?,?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET recipient=excluded.recipient,"
                " updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (cn, rcpt, _actor_name(actor), _now()))
        else:
            conn.execute("DELETE FROM queue_spouses WHERE canon=?", (cn,))
        _log(conn, "spouse", actor=_actor_name(actor), nick=payload.nick,
             request=request, detail="→" + (rcpt or "(удалено)"))
    return {"ok": True, "recipient": rcpt}


@router.post("/admin/add")
def admin_add(payload: AdminAddIn, request: Request, actor: dict = Depends(require_admin)) -> dict:
    if payload.queue not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        p = _people(conn).get(db._valor_canon(payload.nick))
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
        rows = conn.execute("SELECT model_key, flip, rotate, scale FROM queue_models").fetchall()
    return {"settings": {r["model_key"]: {"flip": r["flip"], "rotate": r["rotate"],
                                          "scale": r["scale"]} for r in rows}}


@router.post("/admin/model")
def set_model(payload: ModelIn, _: dict = Depends(require_admin)) -> dict:
    flip = 1 if payload.flip else 0
    rot = max(-180, min(180, int(payload.rotate)))
    scl = max(0.2, min(3.0, float(payload.scale)))
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO queue_models (model_key, flip, rotate, scale, updated_at) VALUES (?,?,?,?,?)"
            " ON CONFLICT(model_key) DO UPDATE SET flip=excluded.flip,"
            " rotate=excluded.rotate, scale=excluded.scale, updated_at=excluded.updated_at",
            (payload.key, flip, rot, scl, _now()))
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
        p = _people(conn).get(db._valor_canon(payload.nick))
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
        if not pref:
            conn.execute("DELETE FROM queue_model_pref WHERE canon=?", (cn,))
        else:
            conn.execute(
                "INSERT INTO queue_model_pref (canon, prefer_class, updated_at) VALUES (?,?,?)"
                " ON CONFLICT(canon) DO UPDATE SET prefer_class=excluded.prefer_class, updated_at=excluded.updated_at",
                (cn, pref, _now()))
        _log(conn, "model_pref", actor=acc["main_nick"], nick=acc["main_nick"], request=request,
             detail="модель=" + ("классовая" if pref else "персональная"))
    return {"ok": True, "prefer_class": bool(pref)}


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
            "SELECT nick_canon, nick, valor FROM valor_members WHERE snapshot_id = ?", (snap["id"],)):
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
            "queues": ["Обычные", "Редкие (R)", "Легендарные (S)"]}


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


def _build_report(conn, stages_override: int | None = None) -> dict:
    import json
    idx = _people(conn)
    gmap = {r["canon"]: r["gender"] for r in conn.execute("SELECT canon, gender FROM queue_gender")}
    smap = _spouse_map(conn)
    queues = [[], [], []]
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
        {"stages": stages_use,
         "pet_count": _cfg_int(conn, "pet_count", 0),
         "shooters": shooters, "claims": claims, "main_map": main_map})
    report["has_valor"] = bool(valor_map)
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
    """Вернуть в очередь того, кто НЕ забрал ресурс, но уже вылетел при сдвиге (отметили
    после вс 00:00). Ставит его на ПРЕЖНЮЮ позицию (orig_pos), раздвигая остальных."""
    with db.connection() as conn:
        s = conn.execute("SELECT * FROM queue_served_last WHERE id=?", (payload.served_id,)).fetchone()
        if not s:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
        q, target = s["queue"], s["orig_pos"]
        # раздвигаем очередь: всем с pos >= orig_pos сдвигаем на +1, освобождая место
        conn.execute("UPDATE queue_entries SET pos = pos + 1 WHERE queue=? AND pos >= ?", (q, target))
        existing = conn.execute(
            "SELECT id FROM queue_entries WHERE queue=? AND main_canon=? AND privileged=0",
            (q, s["main_canon"])).fetchone()
        if existing:                                  # уже в очереди (напр. авто-повтор в конце) → на место
            conn.execute("UPDATE queue_entries SET pos=?, not_collected=0 WHERE id=?", (target, existing["id"]))
        else:                                         # вылетел → вставляем заново на прежнее место
            conn.execute(
                "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, recipient,"
                " auto_repeat, auto_plan, added_by, added_at, not_collected)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,0)",
                (q, target, s["main_canon"], s["nick"], s["cls"], s["resource"], s["recipient"],
                 s["auto_repeat"], s["auto_plan"], "restore", _now()))
        conn.execute("DELETE FROM queue_served_last WHERE id=?", (payload.served_id,))
        _log(conn, "restore_uncollected", actor=_actor_name(actor), nick=s["nick"], queue=q,
             request=request, detail="возвращён в очередь (не забрал ресурс — отмечен после сдвига)")
    return {"ok": True}


def _make_privileged(conn, main_canon, nick, cls, res, add_stacks, added_by):
    """Ставит ОТДЕЛЬНУЮ светящуюся модель ПЕРВОЙ в очереди 0 (жетон применён). ВАЖНО:
    НЕ трогает обычную запись человека (privileged=0) — если он уже стоял в очереди,
    его обычная моделька остаётся на месте и движется дальше, а жетон добавляет ВТОРУЮ,
    привилегированную, у самого торговца. Повторное применение копит priv_stacks на ней.
    priv_stacks — единый источник объёма (стаки × размер пачки, пересчёт при смене ресурса)."""
    front = (conn.execute("SELECT MIN(pos) m FROM queue_entries WHERE queue=0").fetchone()["m"] or 1.0) - 1.0
    ex = conn.execute("SELECT id, priv_stacks FROM queue_entries WHERE queue=0 AND main_canon=? AND privileged=1",
                      (main_canon,)).fetchone()
    if ex:
        conn.execute("UPDATE queue_entries SET pos=?, resource=?, priv_stacks=? WHERE id=?",
                     (front, res, ex["priv_stacks"] + add_stacks, ex["id"]))
    else:
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
        p = _people(conn).get(db._valor_canon(payload.nick))
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


@router.get("/activity-log")
def activity_log(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Активность очереди (без IP/аккаунтов) — доступно офицерам и админу.
    Кто вставал в очередь/за чем, выходил, менял ресурс, финализации и т.д."""
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT at, kind, actor, nick, queue, detail FROM queue_log"
            " ORDER BY id DESC LIMIT 400").fetchall()
    return {"log": [dict(r) for r in rows]}


@router.get("/history")
def history(_: dict = Depends(require_officer_or_admin)) -> dict:
    """Архив недельных распределений (метаданные) — офицерам и админу."""
    import json as _json
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT id, created_at, stages, channels, summary, actor FROM queue_reports"
            " ORDER BY id DESC LIMIT 60").fetchall()
    out = []
    for r in rows:
        try:
            ch = _json.loads(r["channels"]) if r["channels"] else {}
        except (ValueError, TypeError):
            ch = {}
        out.append({"id": r["id"], "at": r["created_at"], "stages": r["stages"],
                    "channels": ch, "summary": r["summary"], "actor": r["actor"]})
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
