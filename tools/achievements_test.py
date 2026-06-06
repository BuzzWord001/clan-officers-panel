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
# Пороги XP-пути (новая логика — НАСКОЛЬКО перевыполнил влияет на прогресс).
for x, key in [(50, "xp1"), (150, "xp2"), (400, "xp3"), (900, "xp4"),
               (2000, "xp5"), (4500, "xp6"), (10000, "xp7"), (22000, "xp8"),
               (48000, "xp9"), (100000, "xp10"), (220000, "xp11")]:
    check(f"XP: {x} → {key}", db._xp_tier(x) == key)
    check(f"XP: {x - 1} НЕ {key}", db._xp_tier(x - 1) != key)
check("XP: 0 → None", db._xp_tier(0) is None)

# A: 5 недель подряд 2× нормы (40, norm 20). XP = 40×(1+1.1+1.2+1.3+1.4)=240.
for i, wk in enumerate(["2026-W10", "2026-W11", "2026-W12", "2026-W13", "2026-W14"]):
    snap(wk, [("A", 40), ("B", 40 if i != 2 else 15), ("C", 189 if i == 0 else 21)])
cA, tA, sA = comp("A")
check("A: total_xp ~ 240 (доблесть×серия)", abs(cA["total_xp"] - 240) <= 2, cA["total_xp"])
check("A: XP-тир = xp2 (240 ≥ 150)", "xp2" in tA, tA)
check("A: пик-тир = double", "double" in tA, tA)
check("A: достижения (achievement) > 0", sA.get("achievement", 0) > 0, sA.get("achievement"))
check("A: achievement = discipline (alias)", sA.get("achievement") == sA.get("discipline"))
check("A: веса — достижения 45, доблесть 30",
      sA.get("achievement_max") == 45 and sA.get("compliance_max") == 30,
      (sA.get("achievement_max"), sA.get("compliance_max")))
check("A: доблесть = форма (recent_pct) присутствует", "recent_pct" in sA)
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
check("B: XP-тир есть (xp1+)", any(t in tB for t in ("xp1", "xp2", "xp3")), tB)

# C: одна неделя 189 (пик ~9.45) → titan; OFS_best=1.0
cC, tC, sC = comp("C")
check("C: пик-тир = titan", "titan" in tC, tC)
check("C: over_ofs_best = 1.0", abs(cC["over_ofs_best"] - 1.0) < 0.001,
      cC["over_ofs_best"])
check("C: достижения учитывают пик (>0)", sC["achievement"] > 0, sC["achievement"])

# Гость тоже получает compliance с XP (дерево доступно всем)
gm = db.valor_get_current(with_reg_notes=False)["members"]
check("compliance с total_xp есть у всех", all(
    (m["compliance"] is None) or ("total_xp" in m["compliance"]) for m in gm))

# ── КЛЮЧЕВОЕ: магнитуда влияет на прогресс. C набрал 189 на W10 (×9.45),
# A — ровно 40 (×2) каждую неделю. У C XP больше именно за счёт магнитуды,
# хотя серии одинаковой длины. То есть «насколько перевыполнил» теперь влияет.
check("магнитуда влияет на XP: C (был ×9.45) XP > A (ровно ×2)",
      cC["total_xp"] > cA["total_xp"], (cC["total_xp"], cA["total_xp"]))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
