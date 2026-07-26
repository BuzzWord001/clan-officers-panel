"""Рендер картинки отчёта распределения наград КХ (server-side, Pillow).

Chrome/Chromium на Fly (512МБ) не тянет — рендерим лёгким Pillow: фон День.png
(report-bg-day.webp) + затемняющая вуаль + карточки групп с иконками ресурсов +
очередь Огненного цилиня по порядку + группа «не хватило доблести». Возвращает
путь к PNG для отправки в TG/VK. Без эмодзи (LiberationSans их не рисует)."""

from __future__ import annotations

import logging
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

log = logging.getLogger("officers.report_render")

_SCENE = Path(__file__).resolve().parent.parent / "frontend" / "assets" / "queue" / "scene"
_BG = _SCENE / "report-bg-day.webp"
_ITEM = _SCENE / "item"
_FONT_DIR = Path("/usr/share/fonts/truetype/liberation")

W = 1040
PAD = 36
GOLD = (240, 200, 120)
TAN = (224, 201, 172)
CREAM = (246, 234, 210)
DIM = (156, 142, 120)
ORANGE = (255, 198, 150)
RED = (240, 168, 120)
LINE = (224, 162, 74)


def _font(size: int, bold: bool = False):
    name = "LiberationSans-Bold.ttf" if bold else "LiberationSans-Regular.ttf"
    try:
        return ImageFont.truetype(str(_FONT_DIR / name), size)
    except Exception:
        return ImageFont.load_default()


def _icon(key: str, px: int = 36):
    try:
        im = Image.open(_ITEM / (key + ".webp")).convert("RGBA")
        r = px / max(im.size)
        return im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))), Image.LANCZOS)
    except Exception:
        return None


def _wrap(draw, text, font, maxw):
    out, cur = [], ""
    for word in str(text).split(" "):
        t = (cur + " " + word).strip()
        if not cur or draw.textlength(t, font=font) <= maxw:
            cur = t
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out or [""]


def _plabel(p: dict) -> str:
    s = p.get("receiver", "")
    if p.get("via"):
        s += " (за %s)" % p["via"]
        if not p.get("ok", True):
            s += " !"
    return s


def _make_bg(w: int, h: int) -> Image.Image:
    base = Image.new("RGBA", (w, h), (20, 13, 7, 255))
    try:
        bg = Image.open(_BG).convert("RGBA")
        r = max(w / bg.width, h / bg.height)
        bg = bg.resize((int(bg.width * r) + 1, int(bg.height * r) + 1), Image.LANCZOS)
        base.alpha_composite(bg, (0, 0))
    except Exception as e:
        log.warning("report bg load failed: %s", e)
    base.alpha_composite(Image.new("RGBA", (w, h), (12, 8, 4, 202)))  # вуаль для читабельности
    return base


def render_report_png(report: dict, delta: dict | None, when: str, out_path) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    MAXH = 8000
    layer = Image.new("RGBA", (W, MAXH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x = PAD
    innerw = W - 2 * PAD
    y = [PAD]

    f_title = _font(40, True)
    f_sub = _font(21)
    f_sec = _font(27, True)
    f_grp = _font(24, True)
    f_body = _font(21)
    f_small = _font(19)

    def line(s, font, color, dx=0, gap=7):
        d.text((x + dx, y[0]), s, font=font, fill=color)
        y[0] += font.size + gap

    def wrap(s, font, color, dx=0, gap=5, mw=None):
        for ln in _wrap(d, s, font, (mw or innerw) - dx):
            d.text((x + dx, y[0]), ln, font=font, fill=color)
            y[0] += font.size + gap

    def hr(pad_top=8, pad_bot=14):
        y[0] += pad_top
        d.line([(x, y[0]), (x + innerw, y[0])], fill=LINE, width=2)
        y[0] += pad_bot

    # ── заголовок ──
    line("РАСПРЕДЕЛЕНИЕ РЕСУРСОВ КХ", f_title, GOLD)
    line("закрыто этапов: %d    %s" % (report.get("stages", 0), when), f_sub, TAN, gap=9)
    tn = report.get("top3_named") or []
    if tn:
        wrap("ТОП-3:  " + "    ".join("%s (%d)" % (t["nick"], t["valor"]) for t in tn), f_sub, GOLD)
    pc = report.get("priv_claims") or []
    if pc:
        wrap("Вне очереди (топ-3): " + " · ".join("%s—%s×%d" % (c["nick"], c["name"], c["amount"]) for c in pc), f_small, TAN)
    hr()

    # ── группы раздачи ──
    groups = report.get("groups") or []
    if not groups:
        line("некому раздавать", f_body, DIM)
    for gi, g in enumerate(groups, 1):
        tag = "  ·  проводники" if g.get("provodnik") else ""
        line("Группа %d%s — %d чел" % (gi, tag, len(g["people"])), f_grp, CREAM, gap=5)
        wrap(", ".join(_plabel(p) for p in g["people"]), f_body, TAN, dx=6, gap=4)
        for info in g["resources"]:
            ic = _icon(info.get("key", ""))
            iy = y[0]
            if ic:
                layer.alpha_composite(ic, (x + 8, iy))
            d.text((x + 52, iy + 7), "%s — %d шт" % (info["name"], info["total"]), font=f_body, fill=CREAM)
            y[0] += max(38, f_body.size + 6) + 6
        y[0] += 6
        d.line([(x, y[0]), (x + innerw, y[0])], fill=(120, 92, 52), width=1)
        y[0] += 12

    # ── Огненный цилинь (по порядку; мало доблести — ярко помечен, из списка НЕ убираем) ──
    hr()
    line("ОГНЕННЫЙ ЦИЛИНЬ — очередь по порядку", f_sec, ORANGE)
    line("раздаётся мастером по мере выпадения", f_small, DIM, gap=6)
    pet = report.get("pet_queue") or []
    if pet:
        for i, p in enumerate(pet, 1):
            base = "%d) %s" % (i, _plabel(p))
            if p.get("status") == "pet_low":
                d.text((x + 6, y[0]), base, font=f_body, fill=DIM)
                off = 6 + d.textlength(base + "   ", font=f_body)
                d.text((x + off, y[0]), "!! мало доблести: %d — не получит" % (p.get("valor") or 0),
                       font=f_body, fill=RED)
            else:
                d.text((x + 6, y[0]), base, font=f_body, fill=TAN)
            y[0] += f_body.size + 6
    else:
        line("очередь пуста", f_body, DIM, dx=6)
    # (группа «не хватило доблести» за ресурсы — только в админ-панели, в картинку НЕ рисуем)

    # ── дельта «если закроем ещё этап» ──
    if delta and (delta.get("groups") or []):
        hr()
        line("ЕСЛИ ЗАКРОЕМ %d-й ЭТАП — дополнительно:" % delta.get("stages", 0), f_sec, GOLD)
        for g in delta["groups"]:
            wrap("%d чел: %s" % (len(g["people"]), ", ".join(_plabel(p) for p in g["people"])), f_body, TAN, dx=6, gap=3)
            wrap(" · ".join("%s ×%d" % (info["name"], info["total"]) for info in g["resources"]), f_small, CREAM, dx=16, gap=4)

    final_h = min(MAXH, y[0] + PAD)
    content = layer.crop((0, 0, W, final_h))
    bg = _make_bg(W, final_h)
    bg.alpha_composite(content)
    ImageDraw.Draw(bg).rectangle([(2, 2), (W - 3, final_h - 3)], outline=LINE, width=3)
    bg.convert("RGB").save(out_path, "PNG")
    log.info("report image rendered: %s (%dx%d)", out_path, W, final_h)
    return out_path
