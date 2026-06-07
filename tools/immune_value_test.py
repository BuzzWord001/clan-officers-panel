"""Иммунитет = только преимущество: иммунный/АФК, набравший доблесть, получает
ценность, роли и историю (не лишается очков)."""
import os, tempfile, datetime
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "immval.db")
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


today = datetime.date.today()
y, w, _ = today.isocalendar()
WEEK = f"{y}-W{w:02d}"
NORM = 14

# Новичок принят СЕГОДНЯ → активный иммунитет; набрал 40 (×2.86 нормы).
db.create_acceptance(game_nick="Новичок", title="", accepted_date=today.isoformat(),
                     note="", actor=ACTOR)
db.valor_save_snapshot(week=WEEK, valor_norm=NORM, members=[
    {"nick": "Новичок", "valor": 40, "norm_met": True, "is_afk": False,
     "title": "", "rank": "", "class_": "", "level": 80, "true_name": ""}])

m = [x for x in db.valor_get_current()["members"] if x["nick"] == "Новичок"][0]
check("иммунитет активен", m.get("immunity") and m["immunity"]["status"] in ("active", "extended"),
      m.get("immunity"))
check("у иммунного ЕСТЬ compliance (не пропущен)", m.get("compliance") is not None)
check("пик засчитан (>0)", (m.get("compliance") or {}).get("peak_ratio", 0) > 0,
      (m.get("compliance") or {}).get("peak_ratio"))
check("ЦЕННОСТЬ начисляется иммунному (doblest_value>0)", m["score"]["doblest_value"] > 0,
      m["score"]["doblest_value"])
check("итоговая ценность > 0", m["score"]["total"] > 0, m["score"]["total"])
check("роль за перевыполнение есть (double)", "double" in (m.get("tags_all") or []),
      m.get("tags_all"))
check("предупреждений у иммунного нет", m.get("warning_count", 0) == 0, m.get("warning_count"))
check("стрик засчитан (≥1)", (m.get("compliance") or {}).get("over_streak_cur", 0) >= 1,
      (m.get("compliance") or {}).get("over_streak_cur"))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
