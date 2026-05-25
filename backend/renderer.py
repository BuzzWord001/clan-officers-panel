"""Рендер списка приёма в PNG через headless Chrome (Selenium).

Адаптация renderer.py из clan-reg-bot под Matrix-тему и 3 колонки
(№, ник, дата приёма, иммунитет до).
"""

import logging
import os
import random
import sys
import time
from datetime import date, datetime, timedelta, timezone
from html import escape
from pathlib import Path

from config import settings
import db

log = logging.getLogger("officers.render")

_PROJECT_DIR = settings.project_dir
RENDER_DIR = settings.render_dir
TEMPLATE_PATH = RENDER_DIR / "template.html"
LOGO_PATH = RENDER_DIR / "assets" / "logo.png"
OUTPUT_DIR = RENDER_DIR / "output"
OUTPUT_PATH = OUTPUT_DIR / "manifest.png"
TMP_HTML = RENDER_DIR / "_render.html"


_GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニABCDEFGHIJKLMN0123456789СТАЛКЕРZONESDEVIL"


def _glyph_rain(width: int = 60, height: int = 70) -> str:
    """Случайная сетка символов для фонового эффекта в шаблоне."""
    rnd = random.Random(0xC0DE)
    lines = []
    for _ in range(height):
        lines.append("".join(rnd.choice(_GLYPHS) for _ in range(width)))
    return "\n".join(lines)


def _fmt_date(iso: str) -> str:
    y, m, d = iso.split("-")
    return f"{d}.{m}.{y}"


def _build_rows(rows: list[dict]) -> str:
    if not rows:
        return (
            '<tr><td colspan="5" class="empty">Список пуст</td></tr>'
        )
    html_rows = []
    today = date.today()
    for i, r in enumerate(rows, 1):
        immune_until = date.fromisoformat(r["immune_until"])
        active = today < immune_until
        immune_cls = "immune-active" if active else "immune-expired"
        if active:
            days_left = (immune_until - today).days
            immune_text = f"{_fmt_date(r['immune_until'])} ({days_left} дн.)"
        else:
            immune_text = f"истёк {_fmt_date(r['immune_until'])}"

        title = r.get("title") or "—"

        html_rows.append(
            "<tr>"
            f'<td>{i}</td>'
            f'<td class="nick">{escape(r["game_nick"])}</td>'
            f'<td class="title">{escape(title)}</td>'
            f'<td class="date">{_fmt_date(r["accepted_date"])}</td>'
            f'<td class="{immune_cls}">{immune_text}</td>'
            "</tr>"
        )
    return "\n        ".join(html_rows)


def render_png(rows: list[dict] | None = None) -> Path:
    if rows is None:
        rows = db.list_acceptances()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    html = TEMPLATE_PATH.read_text(encoding="utf-8")

    logo_uri = "file:///" + str(LOGO_PATH).replace("\\", "/")
    html = html.replace("LOGO_PATH", logo_uri)
    html = html.replace("GLYPH_RAIN", _glyph_rain())

    today = date.today()
    immune_count = sum(1 for r in rows if date.fromisoformat(r["immune_until"]) > today)
    duty_count = len(rows) - immune_count

    html = html.replace("TOTAL_COUNT", str(len(rows)))
    html = html.replace("IMMUNE_COUNT", str(immune_count))
    html = html.replace("DUTY_COUNT", str(duty_count))

    now_msk = datetime.now(timezone(timedelta(hours=3))).strftime("%d.%m.%Y %H:%M")
    html = html.replace("UPDATED_TIME", now_msk)

    html = html.replace("TABLE_ROWS", _build_rows(rows))

    TMP_HTML.write_text(html, encoding="utf-8")

    driver = None
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        import base64

        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--no-sandbox")
        # --disable-dev-shm-usage обязателен в Docker: /dev/shm только 64MB,
        # на длинных страницах Chromium падает с "session not created".
        opts.add_argument("--disable-dev-shm-usage")
        # Ужимаем потребление RAM на 512MB Fly VM. Без этих опций
        # tab crashes на рендере страницы с emoji + Noto шрифтами.
        opts.add_argument("--disable-extensions")
        opts.add_argument("--disable-background-networking")
        opts.add_argument("--disable-default-apps")
        opts.add_argument("--disable-sync")
        opts.add_argument("--disable-translate")
        opts.add_argument("--mute-audio")
        opts.add_argument("--disable-features=Translate,VizDisplayCompositor")
        opts.add_argument("--hide-scrollbars")
        opts.add_argument("--window-size=1100,2000")
        # На Fly/Linux chromium лежит в /usr/bin/chromium, на Windows — в PATH.
        chrome_bin = os.environ.get("CHROME_BIN")
        if chrome_bin:
            opts.binary_location = chrome_bin

        driver = webdriver.Chrome(options=opts)
        driver.get("file:///" + str(TMP_HTML).replace("\\", "/"))

        # Ждём загрузки шрифтов, изображений и layout
        time.sleep(0.6)
        driver.execute_script("return document.fonts && document.fonts.ready;")
        time.sleep(0.4)

        # Берём именно нижнюю границу .footer — последнего видимого элемента.
        # scrollHeight ненадёжен: absolute-фон .bg растягивается до высоты
        # body, и обратно body — до .bg → циклически большое число.
        height = driver.execute_script("""
            const f = document.querySelector('.footer');
            const r = f.getBoundingClientRect();
            return Math.ceil(r.bottom + 14);
        """)

        # Full-page screenshot через CDP — захватывает ВСЁ содержимое body,
        # даже если оно длиннее viewport. На длинных списках это надёжнее
        # чем менять window size.
        result = driver.execute_cdp_cmd("Page.captureScreenshot", {
            "format": "png",
            "captureBeyondViewport": True,
            "clip": {
                "x": 0,
                "y": 0,
                "width": 1100,
                "height": height,
                "scale": 1,
            },
        })
        png_bytes = base64.b64decode(result["data"])
        OUTPUT_PATH.write_bytes(png_bytes)

        from PIL import Image
        img = Image.open(OUTPUT_PATH)
        img.save(OUTPUT_PATH, optimize=True)
        actual_w, actual_h = img.size

        log.info("Manifest rendered: %s (%dx%d, content=%d)",
                 OUTPUT_PATH, actual_w, actual_h, height)
        return OUTPUT_PATH
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        try:
            TMP_HTML.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    db.init_db()
    # Демо-данные если БД пустая
    rows = db.list_acceptances()
    if not rows:
        actor = {"platform": "demo", "id": "0", "name": "preview"}
        db.create_acceptance(
            game_nick="Меченый", accepted_date=str(date.today() - timedelta(days=2)),
            note="первый из посвящённых", actor=actor,
        )
        db.create_acceptance(
            game_nick="Стрелок", accepted_date=str(date.today() - timedelta(days=10)),
            note="иммунитет уже истёк", actor=actor,
        )
        db.create_acceptance(
            game_nick="Кречет", accepted_date=str(date.today()),
            note="принят сегодня", actor=actor,
        )
        rows = db.list_acceptances()
    path = render_png(rows)
    print(f"OK: {path}")
