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


def inspect(name: str, audit_limit: int = 500) -> dict:
    """Открыть снапшот readonly и вернуть его acceptances + audit_log.
    Не подменяет текущую БД. Используется чтобы посмотреть удалённую историю.
    """
    src = _safe_filename(name)
    if not src.exists():
        raise FileNotFoundError(name)
    # SQLite URI с режимом ro — гарантия что мы не модифицируем файл.
    uri = f"file:{src.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        try:
            acc_rows = [dict(r) for r in conn.execute("SELECT * FROM acceptances ORDER BY accepted_date ASC, id ASC").fetchall()]
        except sqlite3.Error:
            acc_rows = []
        try:
            aud_rows = [dict(r) for r in conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (audit_limit,)).fetchall()]
        except sqlite3.Error:
            aud_rows = []
    finally:
        conn.close()
    return {"acceptances": acc_rows, "audit": aud_rows}


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


def trim_auto(keep_last: int = 120) -> int:
    """Оставить keep_last новейших auto-снапшотов, остальные удалить.

    Manual / pre_restore — НЕ трогаем: это точки восстановления, которые
    Лир делал явно (через UI). Подметаем только PREFIX_AUTO.
    """
    _ensure_dir()
    auto_files = sorted(
        SNAPSHOT_DIR.glob(f"{PREFIX_AUTO}*{SUFFIX}"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    # Manual использует PREFIX_MANUAL который начинается с того же PREFIX_AUTO=
    # "officers_" → отфильтруем по более жёсткому условию.
    auto_files = [p for p in auto_files
                  if not p.name.startswith(PREFIX_MANUAL)
                  and not p.name.startswith(PREFIX_PRE_RESTORE)]
    to_remove = auto_files[keep_last:]
    removed = 0
    for p in to_remove:
        try:
            p.unlink()
            removed += 1
        except OSError as exc:
            log.warning("trim_auto failed to remove %s: %s", p.name, exc)
    return removed


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
