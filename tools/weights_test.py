"""Проверка настраиваемых весов категорий ценности. Temp-DB."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "weights.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])
import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

db.init_db()
ACTOR = {"platform": "admin", "id": "admin", "name": "Тест"}
ok = True


def check(label, cond, got=None):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label + ("" if cond else f"  [{got}]"))


# 1) Дефолты
w = db.get_valor_weights()
check("дефолт 35/40/10/10/5",
      (w["base"], w["streak"], w["officer"], w["veteran"], w["social"]) == (35, 40, 10, 10, 5), w)

# 2) Сумма > 100 — отказ
r = db.set_valor_weights({"base": 50, "streak": 40, "officer": 15, "veteran": 10, "social": 5}, ACTOR)
check("сумма 120 > 100 → отказ", (not r.get("ok")) and r.get("error") == "sum_over_100", r)

# 3) Отрицательное — отказ
r = db.set_valor_weights({"base": -5, "streak": 40, "officer": 10, "veteran": 10, "social": 5}, ACTOR)
check("отрицательный вес → отказ", not r.get("ok"), r)

# 4) Валидные (сумма 100 ровно) — сохраняются
r = db.set_valor_weights({"base": 50, "streak": 20, "officer": 15, "veteran": 10, "social": 5}, ACTOR)
check("валидные (сумма 100) → ok", r.get("ok"), r)
w = db.get_valor_weights()
check("сохранилось base=50 officer=15", w["base"] == 50 and w["officer"] == 15, w)

# 5) Веса влияют на расчёт ценности (потолки в score)
db.create_acceptance(game_nick="Гера", title="", accepted_date="2020-01-01",
                     note="", actor=ACTOR)
db.valor_save_snapshot(week="2026-W22", valor_norm=14, members=[
    {"nick": "Гера", "valor": 200, "norm_met": True, "is_afk": False,
     "title": "", "rank": "Мастер", "class_": "", "level": 80, "true_name": ""}])
m = [x for x in db.valor_get_current()["members"] if x["nick"] == "Гера"][0]
s = m["score"]
check("score.doblest_base_max = вес base (50)", s["doblest_base_max"] == 50, s["doblest_base_max"])
check("score.officer_max = вес officer (15)", s["officer_max"] == 15, s["officer_max"])
check("score.veteran_max = вес veteran (10)", s["veteran_max"] == 10, s["veteran_max"])
check("score.social_max = вес social (5)", s["social_max"] == 5, s["social_max"])
# Сумма 100 → новый множитель-cap = 1 + streak/base = 1 + 20/50 = 1.4
check("множитель-cap по весам (1+20/50=1.4): mult ≤ 1.4",
      s["streak_mult"] <= 1.4 + 1e-6, s["streak_mult"])

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
