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

def _smooth(a: np.ndarray, k: int) -> np.ndarray:
    return np.convolve(a, np.ones(k) / k, mode="same")


# Левые трекаемые поля по порядку (Сторона/В сети = "other" в середине,
# Доблесть = последняя). Маппинг устойчив к слиянию Сторона+В сети в 1 колонку.
_LEFT_KEYS = ["nick", "rank", "title", "level", "class"]


def _peaks(sig, min_dist, thr):
    out = []
    for i in range(1, len(sig) - 1):
        if sig[i] >= thr and sig[i] >= sig[i - 1] and sig[i] > sig[i + 1]:
            if not out or i - out[-1] >= min_dist:
                out.append(i)
            elif sig[i] > sig[out[-1]]:
                out[-1] = i
    return out


def detect_grid(im: Image.Image) -> dict | None:
    """im → калибровка в долях кадра или None, если разметить не удалось.
    Строки выравниваются по ЦЕНТРАМ текста; колонки — в ГЭПАХ между ними."""
    im = im.convert("RGB")
    W, H = im.size
    if W < 60 or H < 60:
        return None
    g = np.asarray(im.convert("L"), dtype=np.float32)
    sb = max(int(W * 0.9), W - 35)          # отсечь скроллбар справа

    # ── Высота строки rh: из линий-разделителей (пики вертикального градиента),
    #    медиана БЕЗ аномально больших промежутков (шапка выше обычной строки). ──
    vg = _smooth(np.abs(np.diff(g[:, :sb], axis=0)).mean(axis=1), 3)
    pk = _peaks(vg, 10, vg.mean() + vg.std() * 0.7)
    if len(pk) < 3:
        return None
    sp = np.diff(pk)
    med = np.median(sp)
    rh = int(np.median(sp[sp < med * 1.6])) if np.any(sp < med * 1.6) else int(med)
    if rh < 6:
        return None

    # ── Строки по ЦЕНТРАМ ТЕКСТА: «текстовость» = дисперсия яркости по строке.
    #    Шапку (верхняя ~строка) отбрасываем → первый центр данных. ──
    rowact = _smooth(g[:, :sb].std(axis=1), 3)
    centers = _peaks(rowact, int(rh * 0.6), rowact.mean() * 0.8)
    centers = [c for c in centers if c > rh * 0.9]      # выкинуть шапку
    if len(centers) < 2:
        return None
    y0 = max(0, int(round(centers[0] - rh / 2)))
    nrows = max(1, min(len(centers), int((H - y0) / rh)))
    y1 = min(H - 1, y0 + nrows * rh)
    if y1 - y0 < rh:
        return None

    # ── Колонки: текстовые блоки по дисперсии; границы — в ЦЕНТРАХ гэпов ──
    cstd = _smooth(g[y0:y1, :sb].std(axis=0), 5)
    ink = cstd > cstd.mean() * 0.55
    blocks = []
    s = None
    for x in range(sb):
        if ink[x] and s is None:
            s = x
        elif not ink[x] and s is not None:
            blocks.append([s, x - 1]); s = None
    if s is not None:
        blocks.append([s, sb - 1])
    merged = []
    for b in blocks:
        if merged and b[0] - merged[-1][1] < rh * 0.7:   # слить внутриколоночные гэпы
            merged[-1][1] = b[1]
        else:
            merged.append(b)
    if not merged:
        return None
    bounds = [max(0, merged[0][0] - 3)]                  # левый край 1-й колонки
    for i in range(1, len(merged)):
        bounds.append((merged[i - 1][1] + merged[i][0]) // 2)   # центр гэпа

    # ── Поля: первые 5 = nick/rank/title/level/class, последняя = valor, прочие = other ──
    n = len(bounds)
    keys = []
    for i in range(n):
        if i == n - 1:
            keys.append("valor")
        elif i < len(_LEFT_KEYS):
            keys.append(_LEFT_KEYS[i])
        else:
            keys.append("other")
    cols = [{"x": round(bx / W, 4), "key": k} for bx, k in zip(bounds, keys)]

    return {
        "x": round(bounds[0] / W, 4),
        "y": round(y0 / H, 4),
        "w": round((sb - bounds[0]) / W, 4),
        "h": round(nrows * rh / H, 4),
        "rh": round(rh / H, 4),
        "cols": cols,
        "_meta": {"img_w": W, "img_h": H, "rows": nrows, "ncols": n},
    }


def detect_from_bytes(data: bytes) -> dict | None:
    import io
    return detect_grid(Image.open(io.BytesIO(data)))
