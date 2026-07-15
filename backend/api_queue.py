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

import base64
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import db
import distribution
from config import settings
from session import require_admin, current_session


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
            """
        )
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


def _main_of(nick: str, title: str) -> tuple[str, bool]:
    """(main_nick, is_twin). Титул ~X~ → мэйн X (ник — твин); иначе сам себе мэйн."""
    t = (title or "").strip()
    m = _MAIN_RE.match(t)
    if m and m.group(1).strip():
        return m.group(1).strip(), True
    return nick, False


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
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    dev = conn.execute(
        "SELECT account_id FROM queue_devices WHERE token=?", (token,)).fetchone()
    if not dev:
        return None
    conn.execute("UPDATE queue_devices SET last_seen_at=? WHERE token=?", (_now(), token))
    return conn.execute(
        "SELECT * FROM queue_accounts WHERE id=?", (dev["account_id"],)).fetchone()


def _acc_public(acc) -> dict:
    return {"main_nick": acc["main_nick"], "main_canon": acc["main_canon"],
            "reg_nick": acc["reg_nick"], "email": acc["email"]}


# ─────────────────────────── схемы ───────────────────────────
class CheckIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)


class RegisterIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    shared_password: str = Field(min_length=1, max_length=200)
    email: str = Field(default="", max_length=200)
    personal_password: str = Field(min_length=4, max_length=200)


class LoginIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)
    personal_password: str = Field(min_length=1, max_length=200)


class SharedPwIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class JoinIn(BaseModel):
    queue: int
    resource: str = Field(default="", max_length=64)
    recipient: str = Field(default="", max_length=64)   # кому передать (твин/супруг), необязательно


class SetEntryIn(BaseModel):
    queue: int
    resource: str | None = Field(default=None, max_length=64)    # None = не менять
    recipient: str | None = Field(default=None, max_length=64)   # None = не менять; "" = очистить


class SpouseIn(BaseModel):
    nick: str = Field(min_length=1, max_length=64)               # кому задаём получателя
    recipient: str = Field(default="", max_length=64)            # ник получателя; пусто = удалить связь


class AdminAddIn(BaseModel):
    queue: int
    nick: str = Field(min_length=1, max_length=64)
    position: int = Field(default=9999)      # 0-based индекс; большое число = в конец


class EntryIn(BaseModel):
    entry_id: int


class MoveIn(BaseModel):
    entry_id: int
    queue: int
    position: int = Field(default=9999)


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


class PlacementIn(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    x: float
    y: float


class KVIn(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    val: str = Field(default="", max_length=4000)


# ─────────────────────────── эндпоинты ───────────────────────────
@router.get("/nick-suggest")
def nick_suggest(q: str = Query(..., min_length=1, max_length=64)) -> dict:
    ql = q.strip().lower()
    if len(ql) < 1:
        return {"results": []}
    qcanon = db._valor_canon(ql)
    out = []
    with db.connection() as conn:
        for cn, p in _people(conn).items():
            if ql in p["nick"].lower() or (qcanon and qcanon in cn):
                out.append({
                    "nick": p["nick"], "cls": p["cls"], "title": p["title"],
                    "main_nick": p["main_nick"], "is_twin": p["is_twin"],
                    "sources": sorted(p["sources"]),
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
        return {"ok": True, "nick": p["nick"], "main_nick": p["main_nick"],
                "is_twin": p["is_twin"], "registered": bool(acc)}


@router.post("/register")
def register(payload: RegisterIn, request: Request, response: Response) -> dict:
    with db.connection() as conn:
        cfg = conn.execute("SELECT shared_password_hash FROM queue_config WHERE id=1").fetchone()
        shared = cfg["shared_password_hash"] if cfg else ""
        if not shared:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "shared_password_not_set")
        if not _check(payload.shared_password, shared):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_shared_password")

        idx = _people(conn)
        p = idx.get(db._valor_canon(payload.nick))
        if not p:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nick_not_found")

        acc = _account_by_main(conn, p["main_canon"])
        if acc:
            # уже есть аккаунт на мэйна — регистрация не нужна, пусть входит паролем
            raise HTTPException(status.HTTP_409_CONFLICT, "already_registered")

        cur = conn.execute(
            "INSERT INTO queue_accounts (main_canon, main_nick, reg_nick, email, password_hash,"
            " created_at, last_login_at) VALUES (?,?,?,?,?,?,?)",
            (p["main_canon"], p["main_nick"], p["nick"], payload.email.strip(),
             _hash(payload.personal_password), _now(), _now()))
        acc_id = cur.lastrowid
        _set_device(conn, response, acc_id, request)
        _log(conn, "register", actor=p["nick"], nick=p["nick"], request=request,
             detail="email" if payload.email.strip() else "no-email")
        acc = conn.execute("SELECT * FROM queue_accounts WHERE id=?", (acc_id,)).fetchone()
        return {"ok": True, "account": _acc_public(acc)}


@router.post("/login")
def login(payload: LoginIn, request: Request, response: Response) -> dict:
    with db.connection() as conn:
        idx = _people(conn)
        p = idx.get(db._valor_canon(payload.nick))
        main_canon = p["main_canon"] if p else db._valor_canon(payload.nick)
        acc = _account_by_main(conn, main_canon)
        if not acc or not _check(payload.personal_password, acc["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_credentials")
        conn.execute("UPDATE queue_accounts SET last_login_at=? WHERE id=?", (_now(), acc["id"]))
        _set_device(conn, response, acc["id"], request)
        _log(conn, "login", actor=acc["main_nick"], nick=acc["main_nick"], request=request)
        return {"ok": True, "account": _acc_public(acc)}


@router.get("/me")
def me(request: Request) -> dict:
    with db.connection() as conn:
        acc = _account_from_request(conn, request)
        return {"account": _acc_public(acc) if acc else None}


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

# ── параметры движка распределения (подтверждено Лиром 2026-07-16) ──
# Пороги доблести: обычная очередь ≥60, редкие/легендарные ≥100.
VALOR_THRESHOLD = {0: 60, 1: 100, 2: 100}
# Привилегия шотеров: по умолчанию +10% к метеоритам и камням доблести.
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


def _log(conn, kind, actor="", nick="", queue=None, request=None, detail=""):
    ip = ua = ""
    if request is not None:
        ip = request.client.host if request.client else ""
        ua = request.headers.get("user-agent", "")[:300]
    conn.execute(
        "INSERT INTO queue_log (at, kind, actor, nick, queue, ip, user_agent, detail)"
        " VALUES (?,?,?,?,?,?,?,?)", (_now(), kind, actor, nick, queue, ip, ua, detail))


def _entry_public(r, idx, gmap) -> dict:
    p = idx.get(r["main_canon"]) or {}
    cls = r["cls"] or p.get("cls", "")
    tn = p.get("true_name", "")
    return {"id": r["id"], "nick": r["nick"], "cls": cls,
            "main_nick": p.get("main_nick", r["nick"]), "true_name": tn,
            "gender": _gender_of(cls, tn, gmap.get(r["main_canon"], "")),
            "gender_by": ("manual" if gmap.get(r["main_canon"]) in ("m", "f") else "auto"),
            "resource": (r["resource"] if "resource" in r.keys() else ""),
            "recipient": (r["recipient"] if "recipient" in r.keys() else ""),
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


@router.get("/state")
def state() -> dict:
    qs = [[], [], []]
    with db.connection() as conn:
        idx = _people(conn)
        gmap = {r["canon"]: r["gender"]
                for r in conn.execute("SELECT canon, gender FROM queue_gender")}
        for r in conn.execute("SELECT * FROM queue_entries ORDER BY queue, pos, id"):
            if r["queue"] in QUEUES:
                qs[r["queue"]].append(_entry_public(r, idx, gmap))
    return {"queues": qs}


@router.post("/join")
def join(payload: JoinIn, request: Request) -> dict:
    q = payload.queue
    if q not in QUEUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_queue")
    with db.connection() as conn:
        acc = _account_from_request(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        if conn.execute("SELECT 1 FROM queue_entries WHERE queue=? AND main_canon=?",
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
        conn.execute(
            "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource, recipient, added_by, added_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (q, _append_pos(conn, q), acc["main_canon"], nick, p.get("cls", ""), res, rcpt, "self", _now()))
        _log(conn, "join", actor=nick, nick=nick, queue=q, request=request,
             detail=("res=" + res + (" →" + rcpt if rcpt else "")))
    return {"ok": True}


@router.post("/leave")
def leave(payload: JoinIn, request: Request) -> dict:
    with db.connection() as conn:
        acc = _account_from_request(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        conn.execute("DELETE FROM queue_entries WHERE queue=? AND main_canon=?",
                     (payload.queue, acc["main_canon"]))
        _log(conn, "leave", actor=acc["main_nick"], nick=acc["main_nick"],
             queue=payload.queue, request=request)
    return {"ok": True}


@router.post("/set-entry")
def set_entry(payload: SetEntryIn, request: Request) -> dict:
    """Игрок меняет ресурс и/или получателя своей записи, пока стоит в очереди."""
    with db.connection() as conn:
        acc = _account_from_request(conn, request)
        if not acc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_logged_in")
        row = conn.execute(
            "SELECT id FROM queue_entries WHERE queue=? AND main_canon=?",
            (payload.queue, acc["main_canon"])).fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not_in_queue")
        sets, vals = [], []
        if payload.resource is not None:
            sets.append("resource=?"); vals.append(payload.resource.strip()[:64])
        if payload.recipient is not None:
            sets.append("recipient=?"); vals.append(payload.recipient.strip()[:64])
        if sets:
            vals.append(row["id"])
            conn.execute("UPDATE queue_entries SET " + ",".join(sets) + " WHERE id=?", vals)
            _log(conn, "set_entry", actor=acc["main_nick"], nick=acc["main_nick"],
                 queue=payload.queue, request=request,
                 detail=("res=" + (payload.resource or "—") + " →" + (payload.recipient or "—")))
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
def model_upload(payload: ModelUploadIn, _: dict = Depends(require_admin)) -> dict:
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
    return {"ok": True, "key": key}


@router.post("/admin/model-delete")
def model_delete(payload: ModelIn, _: dict = Depends(require_admin)) -> dict:
    """Удалить загруженную модель по ключу (возврат к статической/заглушке)."""
    key = _safe_key(payload.key)
    n = 0
    if key and _UPLOAD_DIR.exists():
        for f in _UPLOAD_DIR.glob(key + ".*"):
            try:
                f.unlink(); n += 1
            except OSError:
                pass
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


@router.get("/model-img/{key}")
def model_img(key: str) -> FileResponse:
    safe = _safe_key(key)
    files = sorted(_UPLOAD_DIR.glob(safe + ".*")) if (safe and _UPLOAD_DIR.exists()) else []
    if not files:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return FileResponse(files[0], headers={"Cache-Control": "no-cache, must-revalidate"})


@router.post("/admin/gender")
def set_gender(payload: GenderIn, _: dict = Depends(require_admin)) -> dict:
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
    return {"ok": True, "gender": g}


@router.get("/placements")
def placements() -> dict:
    with db.connection() as conn:
        rows = conn.execute("SELECT key, x, y FROM queue_placements").fetchall()
    return {"placements": {r["key"]: {"x": r["x"], "y": r["y"]} for r in rows}}


@router.post("/admin/placement")
def set_placement(payload: PlacementIn, _: dict = Depends(require_admin)) -> dict:
    x = max(0.0, min(100.0, float(payload.x)))
    y = max(0.0, min(100.0, float(payload.y)))
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO queue_placements (key, x, y, updated_at) VALUES (?,?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET x=excluded.x, y=excluded.y, updated_at=excluded.updated_at",
            (payload.key, x, y, _now()))
    return {"ok": True}


@router.get("/config")
def get_config() -> dict:
    with db.connection() as conn:
        rows = conn.execute("SELECT key, val FROM queue_kv").fetchall()
    return {"config": {r["key"]: r["val"] for r in rows}}


@router.post("/admin/config")
def set_config(payload: KVIn, _: dict = Depends(require_admin)) -> dict:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO queue_kv (key, val, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET val=excluded.val, updated_at=excluded.updated_at",
            (payload.key, payload.val, _now()))
    return {"ok": True}


def _cfg_val(conn, key, dflt=""):
    row = conn.execute("SELECT val FROM queue_kv WHERE key=?", (key,)).fetchone()
    return row["val"] if row else dflt


def _cfg_int(conn, key, dflt=0):
    try:
        return int(float(_cfg_val(conn, key, "")))
    except (ValueError, TypeError):
        return dflt


def _valor_map(conn) -> dict:
    """canon -> доблесть из последнего снапшота (для порогов и топ-3)."""
    snap = conn.execute("SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()
    if not snap:
        return {}
    out: dict[str, int] = {}
    for r in conn.execute(
            "SELECT nick_canon, valor FROM valor_members WHERE snapshot_id=?", (snap["id"],)):
        c = r["nick_canon"]
        v = r["valor"]
        if c and v is not None and v > out.get(c, -1):
            out[c] = v
    return out


@router.get("/rewards")
def rewards() -> dict:
    """Метаданные наград (режим/стак/порог/накопленный объём) — для пикера ресурса."""
    with db.connection() as conn:
        stages = _cfg_int(conn, "stages_closed", 0)
    return {"stages": stages, "rewards": distribution.reward_meta(stages)}


def _build_report(conn) -> dict:
    import json
    idx = _people(conn)
    gmap = {r["canon"]: r["gender"] for r in conn.execute("SELECT canon, gender FROM queue_gender")}
    queues = [[], [], []]
    for r in conn.execute("SELECT * FROM queue_entries ORDER BY queue, pos, id"):
        if r["queue"] in QUEUES:
            e = _entry_public(r, idx, gmap)
            e["main_canon"] = r["main_canon"]
            e["canon_nick"] = db._valor_canon(e["nick"])
            queues[r["queue"]].append(e)
    valor_map = _valor_map(conn)
    try:
        shooters = [s for s in json.loads(_cfg_val(conn, "shooters", "[]")) if s]
    except (ValueError, TypeError):
        shooters = []
    report = distribution.compute(
        {"queues": queues}, valor_map,
        {"stages": _cfg_int(conn, "stages_closed", 0),
         "pet_count": _cfg_int(conn, "pet_count", 0),
         "shooters": shooters})
    report["has_valor"] = bool(valor_map)
    return report


@router.get("/admin/distribute")
def distribute(_: dict = Depends(require_admin)) -> dict:
    """Полный отчёт о распределении по текущим очередям, этапам, доблести и шотёрам."""
    with db.connection() as conn:
        return _build_report(conn)


@router.post("/admin/advance")
def advance(request: Request, actor: dict = Depends(require_admin)) -> dict:
    """Сдвиг очереди после распределения: получившие ресурс уходят В КОНЕЦ,
    остальные (не хватило доблести / ресурс кончился / не выбран) остаются
    в начале в прежнем порядке. Порядок внутри групп сохраняется."""
    with db.connection() as conn:
        report = _build_report(conn)
        served_by_q = {}
        for Q in report["queues"]:
            served_by_q[Q["queue"]] = {r["id"] for r in Q["rows"]
                                       if r["status"] in ("ok", "ok_pack") and r["id"] is not None}
        moved_total = 0
        for q in QUEUES:
            ids = [r["id"] for r in conn.execute(
                "SELECT id FROM queue_entries WHERE queue=? ORDER BY pos, id", (q,))]
            served = served_by_q.get(q, set())
            keep = [i for i in ids if i not in served]
            moved = [i for i in ids if i in served]
            pos = 1
            for i in keep + moved:            # оставшиеся впереди, получившие — в конец
                conn.execute("UPDATE queue_entries SET pos=? WHERE id=?", (float(pos), i))
                pos += 1
            moved_total += len(moved)
        _log(conn, "advance", actor=_actor_name(actor), request=request,
             detail="сдвинуто в конец: %d" % moved_total)
    return {"ok": True, "moved": moved_total}


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


# таблицы создаём при импорте модуля (db-файл уже сконфигурирован settings)
try:
    ensure_queue_tables()
except Exception:
    pass
