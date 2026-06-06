"""Тест жизненного цикла участников на ВРЕМЕННОЙ БД (прод не трогаем).

Проверяет: departed→архив, детект новичка (flag+ai_nick+first_seen+иммун),
что регистрант и founding-член НЕ помечаются новичками, и админ-правку ника.
"""
import os
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "lifecycle_test.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])

import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

db.init_db()
ACTOR = {"platform": "admin", "id": "admin", "name": "Тест"}
ok = True


def check(label, cond):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label)


def mk(nick, valor, title="", afk=False):
    return {"nick": nick, "valor": valor, "title": title, "is_afk": afk,
            "rank": "", "class_": "", "level": 80, "true_name": ""}


# Регистрант D — в реестре, но в снимках появится только на W23.
db.create_acceptance(game_nick="DRegular", title="", accepted_date="2026-06-01",
                     note="", actor=ACTOR)

# W22 — ПЕРВЫЙ снимок (базовый список): A, B, C. Новичков тут не помечаем.
db.valor_save_snapshot(week="2026-W22", valor_norm=14,
                       members=[mk("Alpha", 20), mk("Bravo", 10), mk("Cee", 5)])
cur1 = db.valor_get_current()
flagged_w22 = [m["nick"] for m in cur1["members"] if m.get("ai_nick")]
check("первый снимок: никто не помечен новичком (ai_nick)", flagged_w22 == [])

# W23 — A,B остаются; C ПРОПАЛ (ушёл); NEW1 — новенький; DRegular — из реестра.
db.valor_save_snapshot(week="2026-W23", valor_norm=14,
                       members=[mk("Alpha", 30), mk("Bravo", 18),
                                mk("NewGuy", 7), mk("DRegular", 12)])
cur2 = db.valor_get_current()
by_nick = {m["nick"]: m for m in cur2["members"]}

# 1) C ушёл → в архиве departed, нет в текущем списке
departed = {d["nick"] for d in db.valor_get_departed()}
check("ушедший Cee попал в архив доблести (departed)", "Cee" in departed)
check("ушедший Cee отсутствует в текущем списке", "Cee" not in by_nick)

# 2) NEW1 — новичок: ai_nick + flag_new_nick + first_seen + источник иммунитета
check("новичок NewGuy помечен ai_nick (ник от ИИ)",
      by_nick.get("NewGuy", {}).get("ai_nick") is True)
with db.connection() as c:
    fs = {r["nick_canon"] for r in c.execute("SELECT nick_canon FROM valor_first_seen")}
    fn = c.execute("SELECT flag_new_nick FROM valor_members WHERE nick=?",
                   ("NewGuy",)).fetchone()["flag_new_nick"]
check("новичок в valor_first_seen", db._valor_canon("NewGuy") in fs)
check("новичок имеет flag_new_nick=1", fn == 1)
check("новичок — источник иммунитета (accepted_date_per_canon)",
      db._valor_canon("NewGuy") in db.valor_accepted_date_per_canon())

# 3) Регистрант DRegular и founding Bravo НЕ помечены новичками
check("регистрант DRegular НЕ помечен ai_nick",
      by_nick.get("DRegular", {}).get("ai_nick") is not True)
check("founding Bravo НЕ помечен ai_nick",
      by_nick.get("Bravo", {}).get("ai_nick") is not True)

# 4) Админ-правка ника новичка → override держится, ai_nick снят
mid = by_nick["NewGuy"]["id"]
db.valor_update_member(mid, {"nick": "НовичокИсправлен", "valor": 9}, ACTOR)
cur3 = db.valor_get_current()
by_nick3 = {m["nick"]: m for m in cur3["members"]}
check("после правки отображается исправленный ник",
      "НовичокИсправлен" in by_nick3)
check("после правки ai_nick снят",
      by_nick3.get("НовичокИсправлен", {}).get("ai_nick") is False)
check("после правки обновилась доблесть (9)",
      by_nick3.get("НовичокИсправлен", {}).get("valor") == 9)

# 5) Возврат: C снова в W24 → удаляется из архива
db.valor_save_snapshot(week="2026-W24", valor_norm=14,
                       members=[mk("Alpha", 40), mk("Cee", 9)])
departed2 = {d["nick"] for d in db.valor_get_departed()}
check("вернувшийся Cee удалён из архива departed", "Cee" not in departed2)

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
