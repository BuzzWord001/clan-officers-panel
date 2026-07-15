"""Движок распределения ресурсов КХ (Фаза C–D).

Источник данных: «Награды за все этапы кх PW.txt» (подтверждено Лиром).
Таблица REWARDS: по каждому ресурсу — сколько даёт каждый из 7 этапов, к какой
очереди относится и КАК выдаётся:
  • stack — стаками по `unit` штук (каждому по очереди, пока есть);
  • pack  — весь накопленный объём отдаётся ПЕРВОМУ в очереди сразу пачкой;
  • fixed — по `unit` штук каждому (грамоты по 2, легендарки по 1).

Пороги доблести: обычные (оч.0) ≥60, редкие/легендарные (оч.1/2) ≥100.
Шотеры получают по 10% камней доблести и метеоритов «сверху» (до очереди).
"""

from __future__ import annotations

# ключ ресурса -> правила. st = [этап1..этап7] (накопительно суммируем до N).
REWARDS: dict[str, dict] = {
    # ── обычные (очередь 0), порог 60 ──
    "kamen-doblesti":    {"q": 0, "st": [20, 40, 60, 80, 100, 120, 140], "mode": "stack", "unit": 50},
    "meteorit":          {"q": 0, "st": [20, 20, 30, 30, 40, 40, 50],    "mode": "stack", "unit": 20},
    "zhemchuzhina":      {"q": 0, "st": [0, 5, 5, 5, 5, 5, 5],           "mode": "pack",  "unit": 0},
    "znak-edinstva":     {"q": 0, "st": [0, 2, 2, 2, 3, 3, 4],           "mode": "stack", "unit": 3},
    "koloda-kart":       {"q": 0, "st": [0, 0, 1, 2, 3, 4, 5],           "mode": "pack",  "unit": 0},
    "kamen-bessmertnyh": {"q": 0, "st": [100, 100, 200, 200, 300, 300, 400], "mode": "pack", "unit": 0},
    "pilyulya":          {"q": 0, "st": [20, 20, 30, 30, 40, 40, 50],    "mode": "stack", "unit": 20},
    # ── редкие (очередь 1), порог 100 ──
    "gramota":           {"q": 1, "st": [2, 2, 2, 2, 2, 2, 2],           "mode": "fixed", "unit": 2},
    "prikaz-feniksa":    {"q": 1, "st": [0, 0, 0, 100, 100, 100, 100],   "mode": "stack", "unit": 50},
    # ── легендарные (очередь 2), порог 100 ──
    "drakonya-cheshuya": {"q": 2, "st": [0, 0, 0, 1, 1, 1, 1],           "mode": "fixed", "unit": 1},
    "sushchnost-karty":  {"q": 2, "st": [0, 0, 0, 1, 1, 1, 1],           "mode": "fixed", "unit": 1},
    "vysshiy-kamen":     {"q": 2, "st": [0, 0, 0, 0, 0, 1, 1],           "mode": "fixed", "unit": 1},
}

QUEUE_THRESHOLD = {0: 60, 1: 100, 2: 100}
SHOOTER_PCT = 10                       # % камней доблести и метеоритов каждому шотеру
SHOOTER_RES = ("kamen-doblesti", "meteorit")
MAX_STAGES = 7


def _total(res: str, stages: int) -> int:
    """Суммарное количество ресурса за `stages` закрытых этапов."""
    st = REWARDS[res]["st"]
    n = max(0, min(MAX_STAGES, stages))
    return sum(st[:n])


def stack_text(res: str) -> str:
    """Человеческая подпись «что получишь» для пикера ресурса."""
    r = REWARDS.get(res)
    if not r:
        return ""
    if r["mode"] == "pack":
        return "вся пачка за все этапы — первому в очереди"
    if r["mode"] == "fixed":
        return "по %d шт" % r["unit"]
    return "стак по %d шт" % r["unit"]   # stack


def reward_meta(stages: int) -> dict:
    """Для фронта: по каждому ресурсу режим/размер/порог/накопленный объём."""
    out = {}
    for res, r in REWARDS.items():
        out[res] = {
            "queue": r["q"], "mode": r["mode"], "unit": r["unit"],
            "threshold": QUEUE_THRESHOLD[r["q"]],
            "total": _total(res, stages),
            "text": stack_text(res),
        }
    return out


def compute(state: dict, valor_map: dict, cfg: dict) -> dict:
    """Полный отчёт о распределении.

    state    — {"queues": [[entry,...], [...], [...]]}; entry: nick, main_canon,
               resource, recipient, cls (как из _entry_public + canon-хелпер извне).
    valor_map — canon -> доблесть (последний снапшот).
    cfg      — {"stages": int, "pet_count": int, "shooters": [nick,...],
                "shooter_canons": {nick: canon}}  (каноны шотеров для валора).
    Возвращает структуру для рендера на фронте.
    """
    stages = max(0, min(MAX_STAGES, int(cfg.get("stages") or 0)))
    pet_count = max(0, int(cfg.get("pet_count") or 0))
    shooters = [s for s in (cfg.get("shooters") or []) if s]

    # 1) накопленные объёмы
    pool = {res: _total(res, stages) for res in REWARDS}

    # 2) шотеры «сверху» — по 10% камней доблести и метеоритов каждому
    shooter_rows = []
    shooter_totals = {r: 0 for r in SHOOTER_RES}
    for sh in shooters:
        got = {}
        for res in SHOOTER_RES:
            amt = round(_total(res, stages) * SHOOTER_PCT / 100)
            got[res] = amt
            shooter_totals[res] += amt
        shooter_rows.append({"nick": sh, "got": got})
    for res in SHOOTER_RES:                       # вычитаем из общего пула
        pool[res] = max(0, pool[res] - shooter_totals[res])

    # 3) топ-3 по доблести (привилегия — обслуживаются первыми в своей очереди)
    ranked = sorted(valor_map.items(), key=lambda kv: (kv[1] or 0), reverse=True)
    top3 = {c for c, _ in ranked[:3]}

    def entry_valor(e) -> int:
        for key in (e.get("canon_nick"), e.get("main_canon")):
            if key and key in valor_map and valor_map[key] is not None:
                return valor_map[key]
        return 0

    # 4) распределение по очередям
    queues_out = []
    for q in (0, 1, 2):
        entries = list((state.get("queues") or [[], [], []])[q])
        thr = QUEUE_THRESHOLD[q]
        # топ-3 всплывают вперёд (по убыванию доблести), остальные — в порядке очереди
        top_here = [e for e in entries if e.get("main_canon") in top3 or e.get("canon_nick") in top3]
        top_here.sort(key=entry_valor, reverse=True)
        rest = [e for e in entries if e not in top_here]
        ordered = top_here + rest

        rows = []
        for e in ordered:
            v = entry_valor(e)
            res = (e.get("resource") or "").strip()
            who = e.get("nick", "")
            to = (e.get("recipient") or "").strip()
            is_top = e.get("main_canon") in top3 or e.get("canon_nick") in top3
            row = {"id": e.get("id"), "nick": who, "recipient": to, "resource": res, "valor": v,
                   "top3": is_top, "amount": 0, "status": "", "res_name": res}
            if not res or res not in REWARDS:
                row["status"] = "no_res"
            elif v < thr:
                row["status"] = "low_valor"
            else:
                r = REWARDS[res]
                have = pool.get(res, 0)
                if have <= 0:
                    row["status"] = "empty"
                elif r["mode"] == "pack":
                    row["amount"] = have; pool[res] = 0; row["status"] = "ok_pack"
                else:  # stack | fixed
                    amt = min(r["unit"], have)
                    row["amount"] = amt; pool[res] = have - r["unit"]
                    if pool[res] < 0:
                        pool[res] = 0
                    row["status"] = "ok"
            rows.append(row)
        queues_out.append({"queue": q, "threshold": thr, "rows": rows})

    leftovers = {res: pool[res] for res in REWARDS if pool[res] > 0}

    return {
        "stages": stages,
        "pet_count": pet_count,
        "shooters": shooter_rows,
        "shooter_pct": SHOOTER_PCT,
        "top3": list(top3),
        "queues": queues_out,
        "leftovers": leftovers,
        "totals": {res: _total(res, stages) for res in REWARDS},
    }
