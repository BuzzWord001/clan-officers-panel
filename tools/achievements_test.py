"""Тест новой системы достижений: серии перевыполнения, тиры, ценность OFS.
Временная БД."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "ach_test.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])
import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

NORM = 20
ok = True


def check(label, cond, got=None):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label + ("" if cond else f"  [got={got}]"))


def snap(week, members):
    db.valor_save_snapshot(week=week, valor_norm=NORM, members=[
        {"nick": n, "valor": v, "norm_met": v >= NORM, "is_afk": False,
         "title": "", "rank": "", "class_": "", "level": 80, "true_name": ""}
        for n, v in members])


def comp(nick):
    m = {x["nick"]: x for x in db.valor_get_current()["members"]}[nick]
    return m["compliance"], m.get("tags", []), m.get("score", {})


db.init_db()
# helpers напрямую
check("_streak_tier(1) = None", db._streak_tier(1) is None)
check("_streak_tier(2) = streak2", db._streak_tier(2) == "streak2")
check("_streak_tier(4) = month1", db._streak_tier(4) == "month1")
check("_streak_tier(5) = month1 (между 4 и 8)", db._streak_tier(5) == "month1")
check("_streak_tier(12) = month3", db._streak_tier(12) == "month3")
check("_streak_tier(520) = year10", db._streak_tier(520) == "year10")
check("_peak_tier(2.0) = double", db._peak_tier(2.0) == "double")
check("_peak_tier(9.45) = titan", db._peak_tier(9.45) == "titan")

# ── ВСЕ пороги получения ролей (логика обретения) ──
for mult, key in [(1.5, "over"), (2, "double"), (3, "triple"), (4, "record"),
                  (5.5, "phenom"), (7, "titan"), (9.5, "overlord"), (13, "absolute")]:
    check(f"магнитуда: пик {mult} → {key}", db._peak_tier(mult) == key)
    check(f"магнитуда: пик {mult - 0.01:.2f} НЕ {key}", db._peak_tier(mult - 0.01) != key)
for w, key in [(2, "streak2"), (3, "streak3"), (4, "month1"), (8, "month2"),
               (12, "month3"), (26, "half1"), (52, "year1"), (104, "year2"),
               (156, "year3"), (260, "year5"), (520, "year10")]:
    check(f"серия: {w} нед → {key}", db._streak_tier(w) == key)
    check(f"серия: {w - 1} нед НЕ {key}", db._streak_tier(w - 1) != key)
# Монотонность веса тира серии (не убывает с длиной).
_w = [db._streak_tier_weight(x) for x in (1, 2, 4, 12, 52, 520)]
check("вес тира серии монотонно растёт", all(_w[i] <= _w[i + 1] for i in range(len(_w) - 1)), _w)

# A: 5 недель подряд 2× нормы (40) → серия 5 → month1, пик double
for i, wk in enumerate(["2026-W10", "2026-W11", "2026-W12", "2026-W13", "2026-W14"]):
    snap(wk, [("A", 40), ("B", 40 if i != 2 else 15), ("C", 189 if i == 0 else 21)])
cA, tA, sA = comp("A")
check("A: over_streak_max=5", cA["over_streak_max"] == 5, cA["over_streak_max"])
check("A: over_streak_cur=5", cA["over_streak_cur"] == 5, cA["over_streak_cur"])
check("A: тир серии = month1", "month1" in tA, tA)
check("A: пик-тир = double", "double" in tA, tA)
ofs_expected = round((40 - NORM) / (189 - NORM), 3)
check("A: over_ofs_avg ~ OFS(40)", abs(cA["over_ofs_avg"] - ofs_expected) < 0.01,
      cA["over_ofs_avg"])
check("A: достижения (achievement) > 0", sA.get("achievement", 0) > 0, sA.get("achievement"))
check("A: achievement = discipline (alias)", sA.get("achievement") == sA.get("discipline"))
check("A: веса — достижения 40, доблесть 35",
      sA.get("achievement_max") == 40 and sA.get("compliance_max") == 35,
      (sA.get("achievement_max"), sA.get("compliance_max")))
check("A: ветеран12/офицер8/соцсети3/чаты2",
      sA.get("veteran_max") == 12 and sA.get("officer_max") == 8
      and sA.get("socials_max") == 3 and sA.get("chat_max") == 2)
_sum = ((sA.get("compliance") or 0) + sA.get("achievement", 0) + sA.get("veteran", 0)
        + sA.get("officer", 0) + sA.get("socials", 0) + sA.get("chat", 0))
check("A: total = сумма компонентов (в пределах 100)",
      abs(sA["total"] - round(_sum, 1)) < 0.2 and sA["total"] <= 100, (sA["total"], _sum))

# B: серия прервалась на W12 (15<20) → max серия = 4 (W11..W14? нет: W10 over,
#    W11 over, W12 miss, W13 over, W14 over) → omax=2
cB, tB, sB = comp("B")
check("B: over_streak_max=2 (прервалась на miss)", cB["over_streak_max"] == 2,
      cB["over_streak_max"])
check("B: тир серии = streak2", "streak2" in tB, tB)

# C: одна неделя 189 (пик ~9.45) → overlord; OFS_best=1.0
cC, tC, sC = comp("C")
check("C: пик-тир = titan", "titan" in tC, tC)
check("C: over_ofs_best = 1.0", abs(cC["over_ofs_best"] - 1.0) < 0.001,
      cC["over_ofs_best"])
check("C: discipline учитывает пик (>0)", sC["discipline"] > 0, sC["discipline"])

# Гость тоже получает compliance со стриками (дерево доступно всем)
gm = db.valor_get_current(with_reg_notes=False)["members"]
check("compliance со стриками есть у всех", all(
    (m["compliance"] is None) or ("over_streak_max" in m["compliance"]) for m in gm))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
