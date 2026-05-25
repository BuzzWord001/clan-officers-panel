"""Хранилище учётных данных в SQLite + bcrypt.

Таблица auth_config (одна строка id=1):
  officer_password_hash  — общий пароль офицеров для входа
  admin_username         — логин админа (Лир)
  admin_password_hash    — пароль админа

Инициализация: при первом старте читает из env DEFAULT_ADMIN_*, DEFAULT_OFFICER_PASSWORD.
Дальше — пароли меняются только через UI.
"""

import logging
from datetime import datetime

import bcrypt

import db
from config import settings

log = logging.getLogger("officers.auth_pwd")


def _hash(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")


def _check(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
    except Exception:
        return False


def ensure_initialised() -> None:
    """Создать строку auth_config с дефолтами при первом запуске.

    Подсевает officer_password_plain если он пустой — нужно для случая когда
    БД уже была инициализирована до миграции (старая версия без plain поля).
    """
    cfg = _read()
    if cfg is None:
        now = datetime.utcnow().isoformat(timespec="seconds")
        with db.connection() as conn:
            conn.execute(
                """INSERT INTO auth_config
                   (id, officer_password_hash, admin_username, admin_password_hash,
                    officer_password_plain, updated_at)
                   VALUES (1, ?, ?, ?, ?, ?)""",
                (
                    _hash(settings.default_officer_password),
                    settings.default_admin_username,
                    _hash(settings.default_admin_password),
                    settings.default_officer_password,
                    now,
                ),
            )
        log.warning(
            "auth_config initialised with defaults — admin=%r, change passwords via UI ASAP",
            settings.default_admin_username,
        )
        return
    # backfill plaintext если он пустой после миграции старой БД
    if not cfg.get("officer_password_plain"):
        with db.connection() as conn:
            conn.execute(
                "UPDATE auth_config SET officer_password_plain = ? WHERE id = 1",
                (settings.default_officer_password,),
            )
        log.info("backfilled officer_password_plain from default")


def _read() -> dict | None:
    with db.connection() as conn:
        row = conn.execute("SELECT * FROM auth_config WHERE id = 1").fetchone()
        return dict(row) if row else None


def verify_officer(password: str) -> bool:
    cfg = _read() or {}
    return _check(password, cfg.get("officer_password_hash", ""))


def verify_admin(username: str, password: str) -> bool:
    cfg = _read() or {}
    if username != cfg.get("admin_username"):
        return False
    return _check(password, cfg.get("admin_password_hash", ""))


def set_officer_password(new_password: str) -> None:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with db.connection() as conn:
        conn.execute(
            """UPDATE auth_config
               SET officer_password_hash = ?, officer_password_plain = ?, updated_at = ?
               WHERE id = 1""",
            (_hash(new_password), new_password, now),
        )
    log.info("officer password changed")


def officer_password_plain() -> str:
    """Plain-текст пароля офицеров для подписи в TG/VK закрепе.

    Лежит в БД, обновляется только через set_officer_password (UI).
    Fallback на env-дефолт если БД ещё не инициализирована.
    """
    cfg = _read() or {}
    return cfg.get("officer_password_plain") or settings.default_officer_password


def update_admin(*, current_password: str,
                 new_username: str | None,
                 new_password: str | None) -> bool:
    cfg = _read()
    if not cfg:
        return False
    if not _check(current_password, cfg["admin_password_hash"]):
        return False
    new_u = new_username or cfg["admin_username"]
    new_h = _hash(new_password) if new_password else cfg["admin_password_hash"]
    now = datetime.utcnow().isoformat(timespec="seconds")
    with db.connection() as conn:
        conn.execute(
            "UPDATE auth_config SET admin_username = ?, admin_password_hash = ?, updated_at = ? WHERE id = 1",
            (new_u, new_h, now),
        )
    log.info("admin credentials updated (username=%s)", new_u)
    return True


def admin_username() -> str:
    cfg = _read() or {}
    return cfg.get("admin_username", "")
