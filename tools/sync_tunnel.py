"""Запускает cloudflared quick-tunnel, ловит URL и обновляет config.js.

Если URL в frontend/config.js поменялся — переписывает, коммитит и пушит
в репозиторий BuzzWord001/clan-officers-panel. GitHub Pages подхватит
через свой workflow за ~30 сек.

Используется в автозапуске Windows: ярлык в shell:startup ведёт на
tools/start_all.vbs, который вызывает start_all.bat → стартует backend
и эту штуку параллельно.

Перезапускается автоматически: cloudflared падает → цикл вверху рестартит.
"""

import os
import re
import subprocess
import sys
import time
from pathlib import Path

# stdout/stderr должны принимать кириллицу/стрелки — иначе любой print()
# с не-ASCII символом валит весь скрипт под cp1251 Windows консолью.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


PROJECT_DIR = Path(__file__).resolve().parent.parent
CONFIG_JS   = PROJECT_DIR / "frontend" / "config.js"
CLOUDFLARED = PROJECT_DIR / "bin" / "cloudflared.exe"
LOCAL_BACKEND = "http://127.0.0.1:8765"

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def log(*args):
    print("[sync-tunnel]", *args, flush=True)


def read_current_url() -> str | None:
    try:
        text = CONFIG_JS.read_text(encoding="utf-8")
        m = re.search(r'API_URL:\s*"(https://[^"]+)"', text)
        return m.group(1) if m else None
    except FileNotFoundError:
        return None


def replace_url(new_url: str) -> bool:
    text = CONFIG_JS.read_text(encoding="utf-8")
    new = re.sub(r'(API_URL:\s*")[^"]+(")', rf'\1{new_url}\2', text)
    if new == text:
        return False
    CONFIG_JS.write_text(new, encoding="utf-8")
    return True


def git(*args, **kw):
    # encoding=utf-8 ОБЯЗАТЕЛЕН: иначе git stderr с кириллицей (commit msg,
    # пути в Russian-локали Windows) декодится cp1251 и падает UnicodeDecodeError.
    return subprocess.run(
        ["git", *args],
        cwd=str(PROJECT_DIR),
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        **kw,
    )


def push_config(new_url: str) -> None:
    # pull --rebase чтобы не словить non-fast-forward на другой машине
    git("pull", "--rebase", "--autostash", "origin", "main")
    git("add", "frontend/config.js")
    msg = f"chore: tunnel url -> {new_url}"
    r = git("-c", "core.autocrlf=true", "commit", "-m", msg)
    if "nothing to commit" in (r.stdout + r.stderr).lower():
        log("nothing to commit")
        return
    r = git("push", "origin", "main")
    if r.returncode != 0:
        log("push failed:", r.stderr.strip())
    else:
        log("pushed:", new_url)


def run_once() -> int:
    if not CLOUDFLARED.exists():
        log("cloudflared.exe не найден:", CLOUDFLARED)
        return 2
    log("starting cloudflared...")
    proc = subprocess.Popen(
        [str(CLOUDFLARED), "tunnel", "--url", LOCAL_BACKEND, "--loglevel", "info"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    url_handled = False
    try:
        for line in proc.stdout:  # type: ignore
            m = URL_RE.search(line)
            if m and not url_handled:
                url_handled = True
                new_url = m.group(0)
                log("tunnel URL:", new_url)
                current = read_current_url()
                if current == new_url:
                    log("config.js уже актуальный")
                else:
                    log(f"updating config.js: {current} -> {new_url}")
                    if replace_url(new_url):
                        push_config(new_url)
            # Печатаем строку cloudflared, чтобы видеть в логе
            print(line.rstrip(), flush=True)
    except KeyboardInterrupt:
        proc.terminate()
        return 0
    finally:
        if proc.poll() is None:
            proc.terminate()
    return proc.wait()


def main() -> int:
    backoff = 5
    while True:
        rc = run_once()
        log(f"cloudflared exited rc={rc}, restart in {backoff}s")
        time.sleep(backoff)
        backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    sys.exit(main())
