"""Движок распределения ресурсов КХ (Фаза C–D).

Источник данных: «Награды за все этапы кх PW.txt» (подтверждено Лиром).
Таблица REWARDS: по каждому ресурсу — сколько даёт каждый из 7 этапов, к какой
очереди относится и КАК выдаётся:
  • stack — стаками по `unit` штук (каждому по очереди, пока есть);
  • pack  — весь накопленный объём отдаётся ПЕРВОМУ в очереди сразу пачкой;
  • fixed — по `unit` штук каждому (грамоты по 2, легендарки по 1).

Пороги доблести: обычные (оч.0) ≥60, редкие/легендарные (оч.1/2) ≥100.
Проводники получают по 10% камней доблести и метеоритов «сверху» (до очереди).
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
    # Огненный цилинь (питомец) — падает с шансом; объём НЕ из этапов, а из
    # админского pet_count (переопределяется в compute). По 1 шт каждому.
    "mount-cilin":       {"q": 2, "st": [0, 0, 0, 0, 0, 0, 0],           "mode": "fixed", "unit": 1},
}

QUEUE_THRESHOLD = {0: 60, 1: 100, 2: 100}
SHOOTER_PCT = 10                       # % камней доблести и метеоритов каждому проводнику
SHOOTER_RES = ("kamen-doblesti", "meteorit")
MAX_STAGES = 7

RES_NAME = {
    "kamen-doblesti": "Камень доблести", "meteorit": "Метеорит", "zhemchuzhina": "Жемчужина Фу Си",
    "znak-edinstva": "Знак единства", "koloda-kart": "Колода карт", "kamen-bessmertnyh": "Камень бессмертных",
    "pilyulya": "Пилюля звёздного духа", "gramota": "Запечатанная грамота", "prikaz-feniksa": "Приказ Феникса",
    "drakonya-cheshuya": "Драконья чешуя", "sushchnost-karty": "Сущность карты", "vysshiy-kamen": "Высший камень",
    "mount-cilin": "Огненный цилинь (питомец)",
}


def res_name(k: str) -> str:
    return RES_NAME.get(k, k)


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
                "shooter_canons": {nick: canon}}  (каноны проводников для валора).
    Возвращает структуру для рендера на фронте.
    """
    stages = max(0, min(MAX_STAGES, int(cfg.get("stages") or 0)))
    pet_count = max(0, int(cfg.get("pet_count") or 0))
    shooters = [s for s in (cfg.get("shooters") or []) if s]

    # 1) накопленные объёмы
    pool = {res: _total(res, stages) for res in REWARDS}
    pool["mount-cilin"] = pet_count               # питомец: объём из pet_count, не из этапов
    shooter_lc = {s.strip().lower() for s in shooters}

    # 2) проводники «сверху» — по 10% камней доблести и метеоритов каждому
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
                   "top3": is_top, "provodnik": who.strip().lower() in shooter_lc,
                   "recipient_ok": e.get("recipient_ok", True),
                   "not_collected": e.get("not_collected", False),
                   "amount": 0, "status": "", "res_name": res}
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
                elif have >= r["unit"]:      # только ПОЛНАЯ пачка/порция
                    row["amount"] = r["unit"]; pool[res] = have - r["unit"]; row["status"] = "ok"
                else:                        # остаток < пачки — человеку не даём, уйдёт в клан
                    row["status"] = "empty"
            rows.append(row)
        queues_out.append({"queue": q, "threshold": thr, "rows": rows})

    # остаток (сюда попадают неполные пачки и нераспределённое) → раздать в клане
    leftovers = {res: pool[res] for res in REWARDS if pool[res] > 0}

    return {
        "stages": stages,
        "pet_count": pet_count,
        "shooters": shooter_rows,
        "shooter_pct": SHOOTER_PCT,
        "top3": list(top3),
        "queues": queues_out,
        "groups": _build_groups(queues_out),
        "leftovers": leftovers,
        "totals": {res: _total(res, stages) for res in REWARDS},
    }


# порядок ресурсов для отчёта (обычные → редкие → легендарные)
RES_ORDER = ["kamen-doblesti", "meteorit", "zhemchuzhina", "znak-edinstva", "koloda-kart",
             "kamen-bessmertnyh", "pilyulya", "gramota", "prikaz-feniksa",
             "drakonya-cheshuya", "sushchnost-karty", "vysshiy-kamen", "mount-cilin"]


def _build_groups(queues_out) -> list:
    """Группы раздачи: ресурсы с ОДИНАКОВЫМ списком получателей объединяются в
    одну группу (минимум групп). Каждый в группе получает по `per` каждого ресурса.
    Получатель = кому передать (recipient) если указан, иначе сам игрок."""
    alloc = {}   # res -> [{"receiver","via","ok"}]
    per = {}     # res -> сколько каждому
    for Q in queues_out:
        for r in Q["rows"]:
            if r["status"] not in ("ok", "ok_pack"):
                continue
            receiver = r["recipient"] or r["nick"]
            alloc.setdefault(r["resource"], []).append(
                {"receiver": receiver, "via": (r["nick"] if r["recipient"] else ""),
                 "ok": r.get("recipient_ok", True)})
            per[r["resource"]] = r["amount"]
    groups = []
    by_key = {}
    for res in RES_ORDER:
        if res not in alloc:
            continue
        people = alloc[res]
        key = tuple(sorted(p["receiver"] for p in people))
        mode = REWARDS[res]["mode"]
        info = {"key": res, "name": res_name(res), "per": per[res], "count": len(people),
                "total": (per[res] if mode == "pack" else per[res] * len(people)), "mode": mode}
        if key in by_key:
            by_key[key]["resources"].append(info)
        else:
            g = {"people": people, "resources": [info]}
            by_key[key] = g
            groups.append(g)
    return groups


_QNAMES = {0: "ОБЫЧНЫЕ (≥60)", 1: "РЕДКИЕ R (≥100)", 2: "ЛЕГЕНДАРНЫЕ S (≥100)"}
_STATUS = {
    "ok": "получает", "ok_pack": "ЗАБИРАЕТ ВСЮ ПАЧКУ",
    "low_valor": "не хватает доблести", "empty": "ресурс кончился — ждёт след. недели",
    "no_res": "ресурс не выбран",
}


def format_report_text(report: dict, when_msk: str = "") -> str:
    """Отчёт в виде текста для офицерского чата (TG/VK)."""
    lines = ["📋 ОТЧЁТ О РАСПРЕДЕЛЕНИИ РЕСУРСОВ КХ"]
    if when_msk:
        lines.append(when_msk)
    lines.append("Закрыто этапов КХ: %d" % report.get("stages", 0))
    if not report.get("has_valor"):
        lines.append("⚠ Нет данных доблести — собери сбор доблести.")
    if report.get("pet_count"):
        lines.append("🐲 Огненный цилинь (питомец): %d шт" % report["pet_count"])
    tn = report.get("top3_named") or []
    if tn:
        lines.append("★ ТОП-3 клана: " + ", ".join("%s (%d)" % (t["nick"], t["valor"]) for t in tn))

    sh = report.get("shooters") or []
    if sh:
        lines.append("")
        lines.append("🎯 ПРОВОДНИКИ (+%d%%):" % report.get("shooter_pct", 10))
        for s in sh:
            g = s.get("got", {})
            lines.append(" • %s — Камень доблести ×%d, Метеорит ×%d"
                         % (s["nick"], g.get("kamen-doblesti", 0), g.get("meteorit", 0)))

    # ── ГРУППЫ РАЗДАЧИ (минимум групп: каждый в группе получает по пачке каждого ресурса) ──
    groups = report.get("groups") or []
    lines.append("")
    lines.append("📦 ГРУППЫ РАЗДАЧИ:")
    if not groups:
        lines.append("   (некому раздавать)")
    for gi, g in enumerate(groups, 1):
        names = ", ".join(_person_label(p) for p in g["people"])
        lines.append("")
        lines.append("Группа %d (%d чел): %s" % (gi, len(g["people"]), names))
        for info in g["resources"]:
            if info["mode"] == "pack":
                lines.append("   • %s — ВСЁ одному (%d)" % (info["name"], info["total"]))
            else:
                lines.append("   • %s — по %d × %d чел = %d"
                             % (info["name"], info["per"], info["count"], info["total"]))

    lo = report.get("leftovers") or {}
    lo = {k: v for k, v in lo.items() if v > 0}
    lines.append("")
    lines.append("🔻 ОСТАТОК — РАЗДАТЬ В ЧАТЕ КЛАНА (до вс 00:00, иначе сгорит):")
    if lo:
        lines.append("   " + " · ".join("%s ×%d" % (res_name(k), v) for k, v in lo.items()))
    else:
        lines.append("   — нет, всё распределено")
    return "\n".join(lines)


def _person_label(p: dict) -> str:
    """Имя получателя в группе; если ресурс переадресован — «Получатель (за Ник)», ⚠ если не твин/супруг."""
    s = p["receiver"]
    if p.get("via"):
        s += " (за %s)" % p["via"]
        if not p.get("ok", True):
            s += " ⚠"
    return s
