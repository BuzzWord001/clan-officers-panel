"""Проверка: числовой титул-предупреждение НЕ накручивается, если титул не
менялся (просто старая роль). Временная БД."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "titlewarn_test.db")
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


def snap(week, title, valor=20):
    # valor >= NORM → норму выполняет, чтобы НОРМ-предупреждения не мешали
    db.valor_save_snapshot(week=week, valor_norm=NORM, members=[{
        "nick": "Игрок", "valor": valor, "norm_met": valor >= NORM,
        "is_afk": False, "title": title, "rank": "", "class_": "",
        "level": 80, "true_name": ""}])


def me():
    return {x["nick"]: x for x in db.valor_get_current()["members"]}["Игрок"]


# W20: титул «1» — офицер отметил 1 предупреждение в игре
snap("2026-W20", "1")
m = me()
check("W20: title_warn = 1", m.get("title_warn") == 1)
since20 = m.get("title_warn_since")
check("W20: title_warn_since проставлен", bool(since20))
check("W20: норм-предупреждений нет (норма выполнена)", m.get("warning_count", 0) == 0)

# W21: тот же титул «1» — НЕ должно стать 2
snap("2026-W21", "1")
m = me()
check("W21: title_warn ВСЁ ЕЩЁ 1 (не накрутилось)", m.get("title_warn") == 1)
check("W21: title_warn_since не изменился (старая роль)",
      m.get("title_warn_since") == since20)

# W22: снова «1»
snap("2026-W22", "1")
m = me()
check("W22: title_warn по-прежнему 1", m.get("title_warn") == 1)
check("W22: норм-предупреждений по-прежнему 0", m.get("warning_count", 0) == 0)

# W23: офицер сменил титул на «2» — ДОЛЖНО стать 2 и обновить неделю
snap("2026-W23", "2")
m = me()
check("W23: смена титула → title_warn = 2", m.get("title_warn") == 2)
check("W23: title_warn_since обновился на неделю смены",
      m.get("title_warn_since") == "2026-W23")

# W24: титул «2» держится — остаётся 2, не 3
snap("2026-W24", "2")
m = me()
check("W24: title_warn держится = 2 (не накрутилось до 3)", m.get("title_warn") == 2)

# W25: многозначный титул-дата «0512» → НЕ предупреждение
snap("2026-W25", "0512")
m = me()
check("W25: многозначный титул (дата) не считается предупреждением",
      m.get("title_warn") in (None, 0))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
