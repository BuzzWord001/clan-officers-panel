"""Защищённый одно-инстансный запуск FastAPI приложения.

Защита от двойного старта через msvcrt.locking на файле .bot.lock
(Windows). При попытке запустить второй процесс — мгновенно выходим.

Запуск:
    python launcher.py
"""

import logging
import os
import sys
from pathlib import Path

import msvcrt

_HERE = Path(__file__).resolve().parent
LOCK_PATH = _HERE / ".bot.lock"
PID_PATH = _HERE / ".bot_pid"


def _acquire_lock():
    fd = os.open(str(LOCK_PATH), os.O_RDWR | os.O_CREAT)
    try:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError:
        print(f"[launcher] Another instance is already running (lock: {LOCK_PATH})",
              file=sys.stderr)
        sys.exit(2)
    PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    return fd


def main():
    _acquire_lock()
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
