"""Тест админ-инструментов доблести на ВРЕМЕННОЙ БД (прод не трогаем)."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "admin_tools_test.db")
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


def mk(nick, valor):
    return {"nick": nick, "valor": valor, "title": "", "is_afk": False,
            "rank": "", "class_": "", "level": 80, "true_name": ""}


def cur_by_nick():
    return {m["nick"]: m for m in db.valor_get_current()["members"]}


# W22 базовый список
db.valor_save_snapshot(week="2026-W22", valor_norm=14,
    members=[mk("Xavier", 50), mk("Yana", 30), mk("Zorro", 20)])
# W23: Xavier распознан криво как "Xaviar" (OCR), Zorro пропал
db.valor_save_snapshot(week="2026-W23", valor_norm=14,
    members=[mk("Xaviar", 60), mk("Yana", 35)])

c = cur_by_nick()
# Xaviar должен быть ai_nick (новый из-за кривого OCR), Xavier — в departed
check("кривой 'Xaviar' помечен ai_nick", c.get("Xaviar", {}).get("ai_nick") is True)
dep = {d["nick"] for d in db.valor_get_departed()}
check("настоящий Xavier ушёл в departed (OCR не распознал)", "Xavier" in dep)
# Подсказка должна указать на похожего (Xavier из departed)
sug = c.get("Xaviar", {}).get("suggest")
check("подсказка 'возможно это X' выдана", bool(sug))
check("подсказка указывает на Xavier", bool(sug) and sug["nick"] == "Xavier")

# MERGE: «это он и есть» — Xaviar = Xavier
src = db._valor_canon("Xaviar")
db.valor_merge(src, "Xavier", ACTOR)
c = cur_by_nick()
check("после merge показывается Xavier", "Xavier" in c)
check("после merge 'Xaviar' исчез из списка", "Xaviar" not in c)
dep = {d["nick"] for d in db.valor_get_departed()}
check("после merge Xavier убран из departed", "Xavier" not in dep)
# История слита: у Xavier должны быть недели W22 и W23
hist = db.valor_get_history("Xavier", "valor")
check("история Xavier слита (>=1 запись valor)", bool(hist))

# W24: OCR снова криво «Xaviar» → alias должен авто-сматчить на Xavier
db.valor_save_snapshot(week="2026-W24", valor_norm=14,
    members=[mk("Xaviar", 70), mk("Yana", 40)])
c = cur_by_nick()
check("W24: кривой 'Xaviar' авто-сматчен на Xavier (alias)", "Xavier" in c and "Xaviar" not in c)
check("W24: Xavier не помечен новичком повторно", c.get("Xavier", {}).get("ai_nick") is not True)

# ARCHIVE (ручной кик): убрать Yana
db.valor_archive_member(db._valor_canon("Yana"), ACTOR, reason="кикнули")
c = cur_by_nick()
check("после кика Yana нет в основном списке", "Yana" not in c)
dep = {d["nick"] for d in db.valor_get_departed()}
check("после кика Yana в архиве", "Yana" in dep)

# RESTORE: вернуть Yana (она есть в текущем снимке W24)
db.valor_restore(db._valor_canon("Yana"), ACTOR)
c = cur_by_nick()
check("после restore Yana снова в основном списке", "Yana" in c)
dep = {d["nick"] for d in db.valor_get_departed()}
check("после restore Yana убрана из архива", "Yana" not in dep)

# DELETE phantom: удалить строку Xavier из текущего снимка
mid = cur_by_nick()["Xavier"]["id"]
db.valor_delete_member(mid)
c = cur_by_nick()
check("после delete строка удалена из текущего списка", "Xavier" not in c)

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
