"""Проверка: титул-предупреждение «1» → другая роль → снова «1» = НОВОЕ
предупреждение (показывается снова, неделя обновляется). Временная БД."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "titlerecur_test.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])
import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

db.init_db()
NORM = 14
ok = True


def check(label, cond):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label)


def snap(week, title):
    db.valor_save_snapshot(week=week, valor_norm=NORM, members=[{
        "nick": "Игрок", "valor": 20, "norm_met": True, "is_afk": False,
        "title": title, "rank": "", "class_": "", "level": 80, "true_name": ""}])


def me():
    return {x["nick"]: x for x in db.valor_get_current()["members"]}["Игрок"]


# W20: титул «1» → предупреждение
snap("2026-W20", "1")
m = me()
check("W20: title_warn = 1", m.get("title_warn") == 1)
check("W20: since = 2026-W20", m.get("title_warn_since") == "2026-W20")

# W21: роль сменилась на «Ветеран» — предупреждения из титула нет
snap("2026-W21", "Ветеран")
m = me()
check("W21: title_warn снят (роль другая)", m.get("title_warn") in (None, 0))

# W22: ещё одна другая роль
snap("2026-W22", "Боец")
m = me()
check("W22: title_warn по-прежнему отсутствует", m.get("title_warn") in (None, 0))

# W23: СНОВА появился титул «1» → НОВОЕ предупреждение, неделя — новая
snap("2026-W23", "1")
m = me()
check("W23: title_warn снова = 1 (новое предупреждение)", m.get("title_warn") == 1)
check("W23: since ОБНОВИЛСЯ на 2026-W23 (а не старый W20)",
      m.get("title_warn_since") == "2026-W23")

# W24: «1» держится — остаётся 1, неделя не меняется (та же роль)
snap("2026-W24", "1")
m = me()
check("W24: title_warn держится = 1", m.get("title_warn") == 1)
check("W24: since не изменился (всё ещё W23)",
      m.get("title_warn_since") == "2026-W23")

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
