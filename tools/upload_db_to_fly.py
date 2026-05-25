"""One-off: заливаем data/officers.db на Fly volume через flyctl ssh console.

sftp shell интерактивный и stdin pipe в нём через flyctl ломается. Поэтому
кодируем БД в base64 и пишем по 4 KB чанками через ssh console, потом
собираем на сервере и атомарно подменяем /data/officers.db.

Запускать только после остановки локального backend (WAL должен быть
прочекпойнчен — `PRAGMA wal_checkpoint(TRUNCATE)`).
"""

import base64
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
DB = PROJECT / "data" / "officers.db"
APP = "clan-officers-panel"
CHUNK = 3500  # с запасом до Windows cmdline 32 KB и Linux ARG_MAX


def flyctl() -> str:
    p = shutil.which("flyctl") or str(Path.home() / ".fly" / "bin" / "flyctl.exe")
    if not Path(p).exists():
        sys.exit(f"flyctl not found at {p}")
    return p


def ssh_cmd(cmd: str) -> None:
    """ВАЖНО: flyctl ssh console --command не запускает шелл, аргументы
    передаются в exec напрямую. Поэтому всё с pipe/redirect/&&/$()
    обязательно оборачивать в `sh -c '...'`.
    """
    fly = flyctl()
    r = subprocess.run(
        [fly, "ssh", "console", "-a", APP, "--command", f"sh -c '{cmd}'"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    # ssh console на Windows иногда возвращает "Неверный дескриптор" в конце,
    # но команда уже отработала. Игнорируем код возврата если stderr только об этом.
    if r.returncode != 0 and "Неверный дескриптор" not in r.stderr and "invalid handle" not in r.stderr.lower():
        sys.exit(f"ssh failed ({r.returncode}): {r.stderr}\n{r.stdout}")


def main() -> None:
    if not DB.exists():
        sys.exit(f"DB not found: {DB}")
    data = DB.read_bytes()
    print(f"Local DB size: {len(data)} bytes")

    b64 = base64.b64encode(data).decode("ascii")
    chunks = [b64[i:i + CHUNK] for i in range(0, len(b64), CHUNK)]
    print(f"Chunks: {len(chunks)} of {CHUNK} chars")

    ssh_cmd("rm -f /data/upload.b64 /data/officers.db.new")
    for i, c in enumerate(chunks, 1):
        # `printf %s` — без интерпретации %, без trailing newline.
        ssh_cmd(f"printf %s {c} >> /data/upload.b64")
        if i % 5 == 0 or i == len(chunks):
            print(f"  [{i}/{len(chunks)}]")
    print("Decoding + swap...")
    ssh_cmd(
        "base64 -d /data/upload.b64 > /data/officers.db.new "
        "&& mv /data/officers.db.new /data/officers.db "
        "&& rm /data/upload.b64 "
        "&& ls -la /data/officers.db"
    )
    print("Done. Now: flyctl apps restart " + APP)


if __name__ == "__main__":
    main()
