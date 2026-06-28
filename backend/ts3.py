"""TeamSpeak 3 client — автоскачивание и раздача файлов с нашего сервера.

Сокланам не всегда открывается teamspeak.com, поэтому мы сами скачиваем
официальные установщики TS3-клиента (Windows/macOS/Linux), кладём на volume
и раздаём с santdevil.com. Версию берём из официального JSON
https://www.teamspeak.com/versions/client.json — там version + checksum +
прямая ссылка на файл. Раз в сутки проверяем: вышла новая версия → качаем,
сверяем SHA-256, старый файл удаляем.
"""

import hashlib
import json
import logging
import shutil
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from config import settings

log = logging.getLogger("officers.ts3")

CLIENT_JSON_URL = "https://www.teamspeak.com/versions/client.json"
OFFICIAL_URL = "https://teamspeak.com/en/downloads/?product=ts3#ts3client"

# Папка на volume (рядом с officers.db → /data/ts3). Переживает редеплой.
TS3_DIR = Path(settings.db_path).resolve().parent / "ts3"
STATE_PATH = TS3_DIR / "state.json"

# platform → ключ архитектуры в client.json
PLATFORMS = {"windows": "x86_64", "macos": "x86_64", "linux": "x86_64"}
# красивые подписи для UI
LABELS = {"windows": "Windows", "macos": "macOS", "linux": "Linux"}

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124 Safari/537.36")
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {"platforms": {}, "updated_at": None}


def _write_state(state: dict) -> None:
    TS3_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2),
                          encoding="utf-8")


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _download(url: str, dest: Path, expect_sha256: str | None) -> int:
    """Качает url в dest потоково (мало RAM), сверяет SHA-256. Возвращает размер."""
    TS3_DIR.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    h = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            size += len(chunk)
    if expect_sha256 and h.hexdigest().lower() != expect_sha256.lower():
        tmp.unlink(missing_ok=True)
        raise ValueError(f"checksum mismatch for {dest.name}: "
                         f"got {h.hexdigest()}, want {expect_sha256}")
    tmp.replace(dest)   # атомарная замена
    return size


def refresh(force: bool = False) -> dict:
    """Проверяет client.json и докачивает новые версии. Безопасно при ошибках:
    если JSON недоступен или файл не скачался — оставляем что есть."""
    if not _lock.acquire(blocking=False):
        log.info("TS3 refresh уже идёт — пропускаю")
        return read_state()
    try:
        state = read_state()
        try:
            data = _fetch_json(CLIENT_JSON_URL)
        except Exception as exc:
            log.warning("TS3: не удалось получить client.json: %s", exc)
            return state

        plats = dict(state.get("platforms") or {})
        changed = False
        for plat, arch in PLATFORMS.items():
            try:
                entry = (data.get(plat) or {}).get(arch) or {}
                version = entry.get("version")
                checksum = entry.get("checksum")
                url = (entry.get("mirrors") or {}).get("teamspeak.com")
                if not (version and url):
                    log.warning("TS3: нет данных по %s в client.json", plat)
                    continue
                filename = url.rsplit("/", 1)[-1]
                dest = TS3_DIR / filename
                cur = plats.get(plat) or {}
                up_to_date = (not force and cur.get("version") == version
                              and dest.exists())
                if up_to_date:
                    continue
                log.info("TS3: качаю %s %s (%s)", plat, version, filename)
                size = _download(url, dest, checksum)
                # удаляем старый файл этой платформы, если имя сменилось
                old = cur.get("filename")
                if old and old != filename:
                    (TS3_DIR / old).unlink(missing_ok=True)
                plats[plat] = {
                    "version": version, "filename": filename,
                    "size": size, "checksum": checksum,
                    "updated_at": _now(),
                }
                changed = True
                log.info("TS3: готово %s %s (%.1f МБ)", plat, version,
                         size / 1048576)
            except Exception as exc:
                log.warning("TS3: ошибка обновления %s: %s", plat, exc)

        if changed:
            state = {"platforms": plats, "updated_at": _now()}
            _write_state(state)
        return state
    finally:
        _lock.release()


def file_for(platform: str) -> Path | None:
    """Путь к актуальному файлу платформы (или None, если ещё не скачан)."""
    st = read_state()
    info = (st.get("platforms") or {}).get(platform)
    if not info or not info.get("filename"):
        return None
    p = TS3_DIR / info["filename"]
    return p if p.exists() else None


def public_info() -> dict:
    """Данные для фронта: версии, размеры, доступность, ссылка на офсайт."""
    st = read_state()
    out = {"official_url": OFFICIAL_URL, "updated_at": st.get("updated_at"),
           "platforms": {}}
    plats = st.get("platforms") or {}
    for plat in PLATFORMS:
        info = plats.get(plat) or {}
        fname = info.get("filename")
        available = bool(fname and (TS3_DIR / fname).exists())
        out["platforms"][plat] = {
            "label": LABELS[plat],
            "version": info.get("version"),
            "size": info.get("size"),
            "available": available,
        }
    return out
