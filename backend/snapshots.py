"""Резервные копии SQLite-БД.

Каждый снапшот — это копия officers.db в data/snapshots/officers_<timestamp>.db.
SQLite копирование через online backup API (sqlite3.Connection.backup) — это
не ломает запись, не требует остановки приложения.

Восстановление: текущая БД сохраняется как pre_restore_*, затем выбранный
снапшот копируется поверх. После этого процесс перезапускает себя через
os.execv, чтобы все соединения с БД были закрыты и переоткрыты.
"""

import logging
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from config import settings

log = logging.getLogger("officers.snapshots")

SNAPSHOT_DIR = Path(settings.db_path).parent / "snapshots"
PREFIX_AUTO = "officers_"
PREFIX_MANUAL = "officers_manual_"
PREFIX_PRE_RESTORE = "officers_pre_restore_"
SUFFIX = ".db"


def _ensure_dir() -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def _safe_filename(name: str) -> Path:
    """Принимает либо просто имя файла, либо basename. Проверяет что не выходит
    за пределы snapshots/ и совпадает по форме."""
    if "/" in name or "\\" in name or ".." in name:
        raise ValueError("invalid snapshot name")
    path = SNAPSHOT_DIR / name
    if not name.endswith(SUFFIX) or not str(path).startswith(str(SNAPSHOT_DIR)):
        raise ValueError("invalid snapshot name")
    return path


def _now_stamp() -> str:
    return datetime.utcnow().strftime("%Y%m%d_%H%M%S")


def _backup_to(target: Path) -> None:
    """Делает онлайн-бэкап текущей БД в указанный файл."""
    src = sqlite3.connect(settings.db_path)
    try:
        dst = sqlite3.connect(str(target))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def create_auto() -> Path:
    """Авто-снапшот (ежедневный)."""
    _ensure_dir()
    name = f"{PREFIX_AUTO}{_now_stamp()}{SUFFIX}"
    target = SNAPSHOT_DIR / name
    _backup_to(target)
    log.info("auto snapshot: %s", target.name)
    return target


def create_manual() -> Path:
    """Снапшот по кнопке (на странице настроек)."""
    _ensure_dir()
    name = f"{PREFIX_MANUAL}{_now_stamp()}{SUFFIX}"
    target = SNAPSHOT_DIR / name
    _backup_to(target)
    log.info("manual snapshot: %s", target.name)
    return target


def list_all() -> list[dict]:
    _ensure_dir()
    out = []
    for f in sorted(SNAPSHOT_DIR.glob(f"*{SUFFIX}")):
        st = f.stat()
        out.append({
            "name": f.name,
            "size": st.st_size,
            "created_at": datetime.utcfromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    out.sort(key=lambda x: x["created_at"], reverse=True)
    return out


def delete_one(name: str) -> bool:
    path = _safe_filename(name)
    if path.exists():
        path.unlink()
        log.info("deleted snapshot: %s", name)
        return True
    return False


def restore(name: str) -> Path:
    """Восстанавливает БД из снапшота. Текущая БД сохраняется как pre_restore_*.
    После завершения нужно перезапустить процесс — все соединения должны быть
    закрыты, иначе SQLite будет читать старые WAL-страницы.
    """
    src = _safe_filename(name)
    if not src.exists():
        raise FileNotFoundError(name)

    _ensure_dir()
    # бэкап текущего состояния
    pre_name = f"{PREFIX_PRE_RESTORE}{_now_stamp()}{SUFFIX}"
    pre_path = SNAPSHOT_DIR / pre_name
    _backup_to(pre_path)
    log.info("pre-restore backup: %s", pre_path.name)

    # копируем snapshot поверх officers.db
    db_path = Path(settings.db_path)
    # Перед копированием — попытка очистить WAL у текущего файла
    try:
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
    except Exception as exc:
        log.warning("wal_checkpoint failed: %s", exc)

    # Безопасное копирование через бэкап (SQLite не любит cp на открытой БД).
    src_conn = sqlite3.connect(str(src))
    try:
        dst_conn = sqlite3.connect(str(db_path))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()

    log.info("restored from %s", name)
    return pre_path


def schedule_restart() -> None:
    """Перезапускает процесс. Используется после restore — чтобы все
    соединения с БД были закрыты, и новый бэкенд открыл свежий файл."""
    log.warning("scheduling restart in 1s")

    def _exit():
        import time
        time.sleep(1.5)
        os._exit(42)  # launcher.bat / .vbs могут это поймать; иначе нужен ручной рестарт

    import threading
    threading.Thread(target=_exit, daemon=True).start()
