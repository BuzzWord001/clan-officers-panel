"""Авто-детекция сетки строк/колонок на скрине списка гильдии PW.

Без AI/платных сервисов — классические проекционные профили (numpy+PIL):
  • строки: горизонтальные линии-разделители = пики вертикального градиента
    яркости; высота строки = медиана промежутков между линиями;
  • колонки: на области данных дисперсия яркости по столбцу высокая там, где
    текст, и низкая в гэпах между колонками → левые края текстовых блоков =
    границы колонок (близкие сливаются, скроллбар справа отсекается).

Скрины PW устроены одинаково: шапка (Имя/Должность/Титул/Ур./Класс/Сторона/
В сети/Доблесть) + строки игроков. Поэтому колонкам присваиваются поля по
ФИКСИРОВАННОМУ шаблону раскладки. Возвращает калибровку в ДОЛЯХ кадра (0..1),
совместимую с ручной (valor_frame_calib): {x,y,w,h,rh,cols:[{x,key}]}.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

# Фикс. порядок колонок списка PW → поля сайта. Сторона/В сети не трекаются → "other".
COL_TEMPLATE = ["nick", "rank", "title", "level", "class", "other", "other", "valor"]


def _smooth(a: np.ndarray, k: int) -> np.ndarray:
    return np.convolve(a, np.ones(k) / k, mode="same")


def detect_grid(im: Image.Image) -> dict | None:
    """im → калибровка в долях кадра или None, если разметить не удалось."""
    im = im.convert("RGB")
    W, H = im.size
    if W < 60 or H < 60:
        return None
    g = np.asarray(im.convert("L"), dtype=np.float32)

    # ── Строки: пики вертикального градиента (горизонт. линии-разделители) ──
    vg = _smooth(np.abs(np.diff(g, axis=0)).mean(axis=1), 3)
    thr = vg.mean() + vg.std() * 0.7
    peaks: list[int] = []
    for y in range(1, len(vg) - 1):
        if vg[y] >= thr and vg[y] >= vg[y - 1] and vg[y] > vg[y + 1]:
            if not peaks or y - peaks[-1] >= 10:
                peaks.append(y)
            elif vg[y] > vg[peaks[-1]]:
                peaks[-1] = y
    if len(peaks) < 3:
        return None
    rh = int(np.median(np.diff(peaks)))
    if rh < 6:
        return None
    y0, y1 = peaks[0], peaks[-1]
    if y0 < rh * 0.5 and len(peaks) >= 2:   # первая линия = верх рамки → шапка ниже
        y0 = peaks[1]
    if y1 - y0 < rh:
        return None

    # ── Колонки: дисперсия яркости по столбцу на области данных; гэпы = впадины ──
    sb = max(int(W * 0.9), W - 35)          # отсечь скроллбар справа
    region = g[y0:y1, :sb]
    cstd = _smooth(region.std(axis=0), 5)
    cthr = cstd.mean() * 0.55
    ink = cstd > cthr
    raw = [x for x in range(1, sb) if ink[x] and not ink[x - 1]]
    cols_x: list[int] = []
    for x in raw:
        if not cols_x or x - cols_x[-1] >= rh * 0.7:   # слить близкие границы
            cols_x.append(x)
    if not cols_x:
        return None

    # ── Поля по шаблону (точное совпадение числа колонок) или эвристика ──
    n = len(cols_x)
    keys: list[str] = []
    for i in range(n):
        if n == len(COL_TEMPLATE):
            keys.append(COL_TEMPLATE[i])
        else:
            keys.append("nick" if i == 0 else ("valor" if i == n - 1 else "other"))
    cols = [{"x": round(cx / W, 4), "key": k} for cx, k in zip(cols_x, keys)]

    nrows = max(1, round((y1 - y0) / rh))
    return {
        "x": round(cols_x[0] / W, 4),
        "y": round(y0 / H, 4),
        "w": round((sb - cols_x[0]) / W, 4),
        "h": round(nrows * rh / H, 4),
        "rh": round(rh / H, 4),
        "cols": cols,
        "_meta": {"img_w": W, "img_h": H, "rows": nrows, "ncols": n},
    }


def detect_from_bytes(data: bytes) -> dict | None:
    import io
    return detect_grid(Image.open(io.BytesIO(data)))
