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


def tags_all(nick):
    m = {x["nick"]: x for x in db.valor_get_current()["members"]}[nick]
    return m.get("tags_all", [])


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
# Множитель: текущий стрик 5 нед × OFS(40,norm20)=0.118 → Σ≈0.59 → ×1.71.
check("A: текущий стрик = 5", cA["over_streak_cur"] == 5, cA["over_streak_cur"])
check("A: множитель ~1.7 (1.5..1.9)", 1.5 < sA["streak_mult"] < 1.9, sA["streak_mult"])
# База доблести теперь ПЛАВНАЯ (выполнил норму → ~30%, растёт до 100% при ×13).
check("A: доблесть-база плавная (= формуле _mag_base_w)",
      abs(sA["doblest_base"] - db._mag_base_w(cA["peak_ratio"], 35)) < 0.2, sA["doblest_base"])
check("выполнение нормы (×1) даёт базу > 0", db._mag_base_w(1.0, 35) > 0, db._mag_base_w(1.0, 35))
check("лёгкое перевыполнение (×1.43) > просто нормы (×1)",
      db._mag_base_w(1.43, 35) > db._mag_base_w(1.0, 35),
      (db._mag_base_w(1.43, 35), db._mag_base_w(1.0, 35)))
check("пик-тир met для ×1..1.5", db._peak_tier(1.43) == "met" and db._peak_tier(1.0) == "met")
check("A: доблесть-итог = база × множитель",
      abs(sA["doblest_value"] - round(sA["doblest_base"] * sA["streak_mult"], 1)) < 0.2, sA["doblest_value"])
check("A: бонус серий = итог − база",
      abs(sA["streak_bonus"] - round(sA["doblest_value"] - sA["doblest_base"], 1)) < 0.2, sA["streak_bonus"])
check("A: руна перевыполнения даёт базу (>0)", sA["doblest_base"] > 0)
check("A: total = доблесть×множ + офицер + общит + ветеран",
      abs(sA["total"] - round(sA["doblest_value"] + sA["officer"] + sA["social"] + sA["veteran"], 1)) < 0.2,
      (sA["total"], sA["doblest_value"]))
check("A: веса-потолки по умолчанию (офицер 10, ветеран 10, общит 5)",
      sA["officer_max"] == 10 and sA["veteran_max"] == 10 and sA["social_max"] == 5,
      (sA["officer_max"], sA["veteran_max"], sA.get("social_max")))
# Множители веток в разумных пределах (офицер ≤ ~1.4, общит ≤ 1.2).
gm0 = db.valor_get_current()["members"]
check("офицер-множитель в пределах 1..1.4",
      all(1 <= (x["score"]["officer_mult"]) <= 1.41 for x in gm0))
check("общит-множитель в пределах 1..1.2",
      all(1 <= (x["score"]["social_mult"]) <= 1.2 for x in gm0))
check("баланс: доблесть-ветка ≥ офицерства у сильного игрока",
      sA["doblest_value"] >= sA["officer"])
check("A: пик-тир = double", "double" in tA, tA)
check("A: стрик-тир в таблице (текущий) есть", any(t.startswith("streak") or t.startswith("month") for t in tA), tA)

# C: 189 на W10 (×9.45) + 21×4. Текущий стрик тоже 5, но множитель ВЫШЕ A,
# т.к. магнитуда (OFS большой 189-недели) усиливает множитель.
cC, tC, sC = comp("C")
check("C: лучший пик titan — в ролях ЗА ВСЁ ВРЕМЯ", "titan" in tags_all("C"), tags_all("C"))
check("C: за неделю пик НЕ titan (последняя ×1.5)", "titan" not in tC, tC)
check("C: множитель > A (магнитуда усиливает)", sC["streak_mult"] > sA["streak_mult"],
      (sC["streak_mult"], sA["streak_mult"]))
check("C: доблесть-итог > A (тот же стрик, больше магнитуда)",
      sC["doblest_value"] > sA["doblest_value"], (sC["doblest_value"], sA["doblest_value"]))

# B: серия прервалась на W12 → текущий стрик = 2 (W13,W14). Множитель меньше.
cB, tB, sB = comp("B")
check("B: текущий стрик = 2 (после miss)", cB["over_streak_cur"] == 2, cB["over_streak_cur"])
check("B: множитель < A (стрик короче)", sB["streak_mult"] < sA["streak_mult"],
      (sB["streak_mult"], sA["streak_mult"]))

# Множитель сбрасывается при потере стрика: свежая неделя без перевыполнения.
db.valor_save_snapshot(week="2026-W15", valor_norm=NORM, members=[
    {"nick": n, "valor": v, "norm_met": v >= NORM, "is_afk": False,
     "title": "", "rank": "", "class_": "", "level": 80, "true_name": ""}
    for n, v in [("A", 10), ("C", 21)]])   # A провалил норму → стрик сброшен
sA2 = comp("A")[2]
check("сброс стрика: A набрал <нормы → множитель = 1",
      sA2["streak_mult"] == 1.0 and sA2["over_streak_cur"] == 0,
      (sA2["streak_mult"], sA2["over_streak_cur"]))

# Гость тоже получает score (Зал доступен всем)
gm = db.valor_get_current(with_reg_notes=False)["members"]
check("score есть у всех", all(m.get("score") for m in gm))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
