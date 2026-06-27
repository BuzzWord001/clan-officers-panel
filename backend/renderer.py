"""Готовый скрин сайта для офицерского закрепа.

Раньше тут headless-Chrome рендерил локальный список приёма новичков
(template.html) — по требованию Лира больше не нужен. В закреп идёт просто
скрин сайта (страница «Доблесть»).

Живьём снимать сайт на Fly-VM нельзя: 512МБ не тянут Chart.js + таблицу
доблести на 180 строк — вкладка Chromium падает по OOM (WebDriver виснет).
Поэтому скрин снимается заранее на ПК (там RAM хватает) и кладётся в образ
как render/site_shot.png. Обновить — перезаписать этот файл и передеплоить
(скрипт scratchpad/local_shot.py делает кадр одной командой).
"""

import logging
import shutil
import sys
from pathlib import Path

from config import settings

log = logging.getLogger("officers.render")

RENDER_DIR = settings.render_dir
OUTPUT_DIR = RENDER_DIR / "output"
OUTPUT_PATH = OUTPUT_DIR / "manifest.png"
# Заранее снятый скрин сайта (в образе: /app/render/site_shot.png).
SITE_SHOT_PATH = RENDER_DIR / "site_shot.png"


def render_png(rows: list[dict] | None = None) -> Path:
    """Возвращает PNG для закрепа — заранее снятый скрин сайта.

    Аргумент rows сохранён для обратной совместимости с вызовами из
    publisher/тестов и игнорируется — список новичков больше не рендерим.
    """
    if not SITE_SHOT_PATH.exists():
        raise FileNotFoundError(
            f"site screenshot missing: {SITE_SHOT_PATH} — положи кадр сайта "
            f"в render/site_shot.png и передеплой")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SITE_SHOT_PATH, OUTPUT_PATH)
    log.info("Pin image = static site shot: %s -> %s", SITE_SHOT_PATH, OUTPUT_PATH)
    return OUTPUT_PATH


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    path = render_png()
    print(f"OK: {path}")
