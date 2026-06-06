"""Проверка снятия предупреждений: выполнил норму → снимается одно, самое
суровое первым. Временная БД (прод не трогаем)."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "warn_test.db")
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


def snap(week, valor):
    db.valor_save_snapshot(week=week, valor_norm=NORM, members=[{
        "nick": "Боец", "valor": valor, "norm_met": valor >= NORM,
        "is_afk": False, "title": "", "rank": "", "class_": "", "level": 80,
        "true_name": ""}])


def warns():
    m = {x["nick"]: x for x in db.valor_get_current()["members"]}["Боец"]
    return m.get("warnings", []), m.get("warning_count", 0)


# W20: valor 3 → 21% (СУРОВОЕ предупреждение, не выполнил)
snap("2026-W20", 3)
w, n = warns()
check("после W20: 1 предупреждение", n == 1)

# W21: valor 9 → 64% (более ЛЁГКОЕ предупреждение, не выполнил)
snap("2026-W21", 9)
w, n = warns()
check("после W21: 2 предупреждения", n == 2)
check("W21: предупреждения отсортированы строгое→лёгкое",
      n == 2 and w[0]["pct"] < w[1]["pct"])
severe_pct = round(3 / NORM * 100, 1)
mild_pct = round(9 / NORM * 100, 1)
check(f"W21: суровое={severe_pct}% и лёгкое={mild_pct}% присутствуют",
      {round(x["pct"], 1) for x in w} == {severe_pct, mild_pct})

# W22: valor 20 → выполнил норму → снимается ОДНО, самое СУРОВОЕ (21%)
snap("2026-W22", 20)
w, n = warns()
check("после W22 (норма выполнена): осталось 1 предупреждение", n == 1)
check("снялось именно СУРОВОЕ — осталось лёгкое (64%)",
      n == 1 and round(w[0]["pct"], 1) == mild_pct)

# W23: снова выполнил → снимается последнее → 0
snap("2026-W23", 20)
w, n = warns()
check("после W23 (норма выполнена): предупреждений не осталось", n == 0)

# W24: выполнил при нуле предупреждений → так и 0 (не уходит в минус)
snap("2026-W24", 20)
w, n = warns()
check("после W24: всё ещё 0 (без отрицательных)", n == 0)

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
