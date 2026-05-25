"""Защищённый одно-инстансный запуск FastAPI приложения.

Защита от двойного старта через файловый lock. На Windows — msvcrt.locking,
на Linux/macOS — fcntl.lockf. При попытке запустить второй процесс
мгновенно выходим. В Fly.io (один процесс в контейнере) lock тоже работает
и не мешает.

Запуск:
    python launcher.py
"""

import logging
import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# BOT_LOCK_PATH перекрывает дефолт — нужно в Docker, где /app — слой overlay,
# а долгоживущее состояние пишем в /data (mount volume).
LOCK_PATH = Path(os.environ.get("BOT_LOCK_PATH") or _HERE / ".bot.lock")
PID_PATH = LOCK_PATH.with_name(".bot_pid")


def _acquire_lock():
    fd = os.open(str(LOCK_PATH), os.O_RDWR | os.O_CREAT)
    try:
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        print(f"[launcher] Another instance is already running (lock: {LOCK_PATH})",
              file=sys.stderr)
        sys.exit(2)
    PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    return fd


def main():
    _acquire_lock()
    # stdout под Windows = cp1251 по умолчанию. Любой кириллический лог
    # (например auth_pwd.log при логине Russian-ника) — UnicodeEncodeError.
    # На Linux/Fly stdout уже utf-8, reconfigure безвреден.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stdout,
    )
    log = logging.getLogger("officers.launcher")
    log.info("Lock acquired pid=%s", os.getpid())

    # Импортируем поздно, чтобы lock сработал до тяжёлой инициализации.
    import uvicorn
    from config import settings

    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
