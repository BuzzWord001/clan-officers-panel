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
    "pilyulya": "Пилюля звёздного духа 4 ур.", "gramota": "Запечатанная грамота Лиги", "prikaz-feniksa": "Приказ Феникса",
    "drakonya-cheshuya": "Драконья чешуя", "sushchnost-karty": "Сущность карты", "vysshiy-kamen": "Высший камень божества",
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
        return "всё за неделю разом отдаётся первому в очереди"
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

    # 0) внеочередные захваты топ-3 (суперспособность) — вычитаем из пула СРАЗУ
    claims = cfg.get("claims") or []
    claim_rows = []
    for c in claims:
        res = c.get("resource"); amt = int(c.get("amount") or 0)
        if res in pool and amt > 0:
            pool[res] = max(0, pool[res] - amt)
            claim_rows.append({"nick": c.get("nick", ""), "resource": res,
                               "name": res_name(res), "amount": amt})

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

    # 3) топ-3 по доблести (привилегия — обслуживаются первыми в своей очереди).
    #    ЧЕЛОВЕК И ЕГО ТВИНЫ = ОДНА персона: сворачиваем валор по МЭЙН-аккаунту (main_canon),
    #    ранг персоны = лучший (макс) валор среди её персонажей. Топ-3 РАЗНЫХ персон получают
    #    жетон на МЭЙН — даже если сам мэйн не набрал доблесть (его подняли твины). Так, если
    #    топ занят одним человеком и его твинами, реальные 2-е и 3-е места достаются следующим
    #    ЛЮДЯМ после его твинов.
    main_map = cfg.get("main_map") or {}         # canon персонажа -> canon мэйна (твин -> мэйн)

    def _person(c):
        return main_map.get(c, c)

    person_valor: dict = {}
    for c, v in valor_map.items():
        p = _person(c)
        vv = v or 0
        if vv > person_valor.get(p, -1):
            person_valor[p] = vv
    ranked = sorted(person_valor.items(), key=lambda kv: kv[1], reverse=True)
    top3 = {p for p, _ in ranked[:3]}            # МЭЙН-каноны топ-3 РАЗНЫХ людей

    def entry_valor(e) -> int:
        for key in (e.get("canon_nick"), e.get("main_canon")):
            if key and key in valor_map and valor_map[key] is not None:
                return valor_map[key]
        return 0

    # 4) РАСПРЕДЕЛЕНИЕ ПО ОЧЕРЕДЯМ — пуловая модель (математическая оптимизация):
    #    Приоритет 1 (минимум остатка): каждый ресурс раздаём на min(вместимость, людей)
    #      полными пачками — остаток минимален (в идеале 0 среди тех, кто в очереди).
    #    Приоритет 2 (минимум групп): люди, получившие ОДИНАКОВЫЙ набор ресурсов, идут в
    #      одну группу («полосы» вместимости) → максимум эффективности при раздаче.
    queues_out = []
    for q in (0, 1, 2):
        raw = list((state.get("queues") or [[], [], []])[q])
        # защита: один игрок в очереди учитывается ОДИН раз (в проде join это гарантирует)
        seen = set()
        dedup = []
        for e in raw:
            mc = e.get("main_canon") or e.get("canon_nick") or id(e)
            if mc in seen:
                continue
            seen.add(mc)
            dedup.append(e)
        raw = dedup
        thr = QUEUE_THRESHOLD[q]
        # привилегированные (взяли вне очереди жетоном) — ПЕРВЫЕ, БЕЗ выдачи из пула
        priv = [e for e in raw if e.get("privileged")]
        rest_raw = [e for e in raw if not e.get("privileged")]
        elig = [e for e in rest_raw if entry_valor(e) >= thr]
        low = [e for e in rest_raw if entry_valor(e) < thr]
        # приоритет: топ-3 вперёд (по доблести), остальные — в порядке очереди
        top_here = [e for e in elig if e.get("main_canon") in top3 or e.get("canon_nick") in top3]
        top_here.sort(key=entry_valor, reverse=True)
        ordered = top_here + [e for e in elig if e not in top_here]
        N = len(ordered)
        got = [dict() for _ in range(N)]           # {res: amount} на каждого
        for res in [r for r in RES_ORDER if REWARDS[r]["q"] == q]:
            have = pool.get(res, 0)
            if have <= 0 or N == 0:
                continue
            r = REWARDS[res]
            if r["mode"] == "pack":                # пачка целиком — первому в очереди
                got[0][res] = have
                pool[res] = 0
            else:                                  # полными пачками/порциями сверху вниз
                unit = r["unit"]
                k = min(have // unit, N)           # скольким хватит ПОЛНОЙ пачки
                for i in range(k):
                    got[i][res] = unit
                pool[res] = have - k * unit         # остаток < пачки → в клан
        rows = [_row(e, entry_valor(e), top3, shooter_lc, {}, "privileged") for e in priv]  # первыми
        rows += [_row(e, entry_valor(e), top3, shooter_lc, got[i], "ok" if got[i] else "empty")
                 for i, e in enumerate(ordered)]
        rows += [_row(e, entry_valor(e), top3, shooter_lc, {}, "low_valor") for e in low]
        queues_out.append({"queue": q, "threshold": thr, "rows": rows})

    # остаток (неполные пачки + нераспределённое) → раздать в клане (иначе сгорит)
    leftovers = {res: pool[res] for res in REWARDS if pool[res] > 0}

    groups = _build_groups(queues_out)
    # проводники — отдельная ГРУППА раздачи (их +10% кладём как группу, не отдельной секцией)
    if shooter_rows:
        prov_res = []
        n = len(shooter_rows)
        for res in SHOOTER_RES:
            per = round(_total(res, stages) * SHOOTER_PCT / 100)
            if per > 0:
                prov_res.append({"key": res, "name": res_name(res), "per": per,
                                 "count": n, "total": per * n, "mode": "stack"})
        if prov_res:
            prov_people = [{"receiver": s["nick"], "via": "", "ok": True} for s in shooter_rows]
            prov_people.sort(key=lambda p: p["receiver"].casefold())
            groups.insert(0, {"people": prov_people, "resources": prov_res, "provodnik": True})

    return {
        "stages": stages,
        "pet_count": pet_count,
        "shooters": shooter_rows,
        "shooter_pct": SHOOTER_PCT,
        "top3": list(top3),
        "priv_claims": claim_rows,          # взято вне очереди (суперспособность топ-3)
        "queues": queues_out,
        "groups": groups,
        "leftovers": leftovers,
        "totals": {res: _total(res, stages) for res in REWARDS},
    }


# порядок ресурсов для отчёта (обычные → редкие → легендарные)
RES_ORDER = ["kamen-doblesti", "meteorit", "zhemchuzhina", "znak-edinstva", "koloda-kart",
             "kamen-bessmertnyh", "pilyulya", "gramota", "prikaz-feniksa",
             "drakonya-cheshuya", "sushchnost-karty", "vysshiy-kamen", "mount-cilin"]


def _row(e, v, top3, shooter_lc, got, status) -> dict:
    who = e.get("nick", "")
    to = (e.get("recipient") or "").strip()
    return {
        "id": e.get("id"), "nick": who, "recipient": to,
        "receiver": (to or who), "via": (who if to else ""),
        "valor": v, "top3": (e.get("main_canon") in top3 or e.get("canon_nick") in top3),
        "provodnik": who.strip().lower() in shooter_lc,
        "recipient_ok": e.get("recipient_ok", True),
        "not_collected": e.get("not_collected", False),
        "got": got, "status": status,
    }


def _build_groups(queues_out) -> list:
    """Минимум групп: собираем получателей КАЖДОГО ресурса (пуловая раздача сверху вниз),
    затем ресурсы с ОДИНАКОВЫМ списком получателей объединяем в одну группу.
    Один человек может попадать в несколько групп (стоял в нескольких очередях / разные полосы)."""
    alloc = {}   # res -> [{"receiver","via","ok"}] в порядке очереди
    per = {}     # res -> сколько каждому (пачка: весь объём)
    for Q in queues_out:
        for r in Q["rows"]:
            if r["status"] != "ok":
                continue
            for res, amt in r["got"].items():
                alloc.setdefault(res, []).append(
                    {"receiver": r["receiver"], "via": r["via"], "ok": r.get("recipient_ok", True)})
                per[res] = amt
    groups = []
    by_key = {}
    for res in RES_ORDER:
        if res not in alloc:
            continue
        people = alloc[res]
        key = tuple(sorted(p["receiver"].casefold() for p in people))   # объединяем по одинак. списку
        mode = REWARDS[res]["mode"]
        info = {"key": res, "name": res_name(res), "per": per[res], "count": len(people),
                "total": (per[res] if mode == "pack" else per[res] * len(people)), "mode": mode}
        if key in by_key:
            by_key[key]["resources"].append(info)
        else:
            g = {"people": people, "resources": [info]}
            by_key[key] = g
            groups.append(g)
    for g in groups:
        g["people"].sort(key=lambda p: p["receiver"].casefold())
    groups.sort(key=lambda g: -len(g["people"]))   # крупные группы выше — раздавать эффективнее
    return groups


_BAR = "━━━━━━━━━━━━━━━━━━━━━━━━"


def format_report_text(report: dict, when_msk: str = "") -> str:
    """Красивый компактный отчёт группами для офицерского чата (TG/VK)."""
    L = []
    L.append("📋 РАСПРЕДЕЛЕНИЕ РЕСУРСОВ КХ")
    meta = "🗓 %s · " % when_msk if when_msk else ""
    L.append(meta + "этапов закрыто: %d" % report.get("stages", 0))
    if not report.get("has_valor"):
        L.append("⚠ нет данных доблести — собери сбор")
    tn = report.get("top3_named") or []
    if tn:
        L.append("★ ТОП-3: " + " · ".join("%s(%d)" % (t["nick"], t["valor"]) for t in tn))
    if report.get("pet_count"):
        L.append("🐲 Огненный цилинь: %d шт" % report["pet_count"])
    pc = report.get("priv_claims") or []
    if pc:
        L.append("")
        L.append("⚡ ВНЕ ОЧЕРЕДИ (суперспособность топ-3, уже вычтено):")
        for c in pc:
            L.append("   • %s — %s ×%d" % (c["nick"], c["name"], c["amount"]))

    groups = report.get("groups") or []
    L.append(_BAR)
    if not groups:
        L.append("📦 некому раздавать")
    for gi, g in enumerate(groups, 1):
        tag = " · 🎯 проводники" if g.get("provodnik") else ""
        L.append("📦 Группа %d%s · %d чел" % (gi, tag, len(g["people"])))
        L.append("   " + ", ".join(_person_label(p) for p in g["people"]))
        res = g["resources"]
        for i, info in enumerate(res):
            branch = "┗" if i == len(res) - 1 else "┣"
            L.append("   %s %s — %d шт" % (branch, info["name"], info["total"]))
        L.append(_BAR)

    lo = {k: v for k, v in (report.get("leftovers") or {}).items() if v > 0}
    L.append("🔻 ОСТАТОК — в чат клана (до вс 00:00, иначе сгорит):")
    L.append("   " + (" · ".join("%s ×%d" % (res_name(k), v) for k, v in lo.items())
                      if lo else "— нет, всё распределено ✅"))
    return "\n".join(L)


def _person_label(p: dict) -> str:
    """Имя получателя в группе; если ресурс переадресован — «Получатель (за Ник)», ⚠ если не твин/супруг."""
    s = p["receiver"]
    if p.get("via"):
        s += " (за %s)" % p["via"]
        if not p.get("ok", True):
            s += " ⚠"
    return s
