"""Тест страницы «Скрины сбора»: добавление пропущенной строки, удаление
фантома OCR и данные сравнения — на ВРЕМЕННОЙ БД (прод не трогаем).

Проверяет db.valor_add_member / db.valor_delete_member / db.valor_compare_data:
happy-path добавления, дубль по canon, АФК из титула, продолжение серии
предупреждений, возврат из departed, members_count, и что compare отдаёт
строки с флагами и скринами.
"""
import os
import sys
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "valor_screens_test.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])

# Локальный запуск и запуск на Fly (/app/backend).
for p in ("/app/backend", os.path.join(os.path.dirname(__file__), "..", "backend")):
    if os.path.isdir(p):
        sys.path.insert(0, p)
import db  # noqa: E402

db.init_db()
ACTOR = {"platform": "admin", "id": "admin", "name": "Тест"}
ok = True


def check(label, cond):
    global ok
    ok = ok and bool(cond)
    print(("OK  " if cond else "XX  ") + label)


def mk(nick, valor, title="", afk=False):
    return {"nick": nick, "valor": valor, "title": title, "is_afk": afk,
            "rank": "", "class_": "", "level": 80, "true_name": ""}


# ── База: два снимка (для серий предупреждений и departed) ──
db.valor_save_snapshot(week="2026-W22", valor_norm=14,
                       members=[mk("Alpha", 20), mk("Bravo", 5), mk("Cee", 3)])
db.valor_save_snapshot(week="2026-W23", valor_norm=14,
                       members=[mk("Alpha", 30), mk("Bravo", 4)])
# На W23: Alpha выполнил, Bravo НЕ выполнил (2 недели подряд → warn растёт),
# Cee пропал → должен быть в departed.

departed0 = {d["nick"] for d in db.valor_get_departed()}
check("Cee ушёл в архив departed после W23", "Cee" in departed0)

# ── 1) Добавить пропущенную строку (OCR не распознал MissedGuy) ──
res = db.valor_add_member("2026-W23", mk("MissedGuy", 25), ACTOR)
check("add: ok=True", res.get("ok") is True)
check("add: вернулся id", isinstance(res.get("id"), int))

cmp23 = db.valor_compare_data("2026-W23")
nicks23 = {m["nick"] for m in cmp23["members"]}
check("compare содержит добавленного MissedGuy", "MissedGuy" in nicks23)
mg = next(m for m in cmp23["members"] if m["nick"] == "MissedGuy")
check("MissedGuy: доблесть 25 сохранилась", mg["valor"] == 25)

cur = db.valor_get_current()
cur_nicks = {m["nick"] for m in cur["members"]}
check("таблица Доблести (current) видит MissedGuy сразу", "MissedGuy" in cur_nicks)

# members_count снимка обновился
with db.connection() as c:
    mc = c.execute("SELECT members_count FROM valor_snapshots WHERE week=?",
                   ("2026-W23",)).fetchone()["members_count"]
    real = c.execute(
        "SELECT COUNT(*) AS n FROM valor_members m JOIN valor_snapshots s "
        "ON m.snapshot_id=s.id WHERE s.week=?", ("2026-W23",)).fetchone()["n"]
check("members_count снимка совпал с числом строк", mc == real)

# ── 2) Дубль по canon → reason=exists ──
dup = db.valor_add_member("2026-W23", mk("missedguy", 9), ACTOR)
check("add дубля (тот же canon) → ok=False, reason=exists",
      dup.get("ok") is False and dup.get("reason") == "exists")

# ── 3) АФК из титула → norm_met не оценивается (None) ──
db.valor_add_member("2026-W23", mk("SleepyGuy", 2, title="АФК до пт"), ACTOR)
with db.connection() as c:
    nm = c.execute("SELECT norm_met, is_afk FROM valor_members WHERE nick=?",
                   ("SleepyGuy",)).fetchone()
check("АФК-строка: is_afk=1", nm["is_afk"] == 1)
check("АФК-строка: norm_met=None (не оценивается)", nm["norm_met"] is None)

# ── 4) Возврат: добавляем ушедшего Cee обратно в W23 → уходит из departed ──
db.valor_add_member("2026-W23", mk("Cee", 16), ACTOR)
departed1 = {d["nick"] for d in db.valor_get_departed()}
check("добавленный обратно Cee удалён из departed", "Cee" not in departed1)

# ── 5) Серия предупреждений: добавим недовыполнившего, у кого была W22-серия ──
# Bravo уже в W23, проверим что у него warn растёт (2 недели подряд провал).
with db.connection() as c:
    bw = c.execute("SELECT warning_count FROM valor_members m JOIN valor_snapshots s "
                   "ON m.snapshot_id=s.id WHERE s.week=? AND m.nick=?",
                   ("2026-W23", "Bravo")).fetchone()["warning_count"]
check("Bravo (2 недели провал) имеет warning_count>=2", bw >= 2)

# ── 6) Удаление строки (фантом OCR) ──
del_id = next(m["id"] for m in db.valor_compare_data("2026-W23")["members"]
              if m["nick"] == "MissedGuy")
dres = db.valor_delete_member(del_id)
check("delete: ok=True", dres.get("ok") is True)
after = {m["nick"] for m in db.valor_compare_data("2026-W23")["members"]}
check("после удаления MissedGuy исчез из compare", "MissedGuy" not in after)
check("после удаления MissedGuy исчез из таблицы Доблести",
      "MissedGuy" not in {m["nick"] for m in db.valor_get_current()["members"]})

# ── 7) Добавление без снимка / пустой ник ──
nores = db.valor_add_member("2026-W99", mk("Ghost", 1), ACTOR)
check("add в несуществующую неделю → reason=no_snapshot",
      nores.get("ok") is False and nores.get("reason") == "no_snapshot")
empty = db.valor_add_member("2026-W23", mk("", 1), ACTOR)
check("add без ника → reason=no_nick",
      empty.get("ok") is False and empty.get("reason") == "no_nick")

# ── 8) Состояния бейджа: реестр / постоянный-не-в-реестре (кейс ~АдаНет~) ──
# Alpha заносим в реестр → in_registry=True. Bravo есть в W22+W23 (стабильный,
# flag_new_nick=0), но НЕ в реестре → должен быть «в Доблести», НЕ «ИИ-ник».
db.create_acceptance(game_nick="Alpha", title="", accepted_date="2026-06-01",
                     note="", actor=ACTOR)
bcmp = {m["nick"]: m for m in db.valor_compare_data("2026-W23")["members"]}
check("Alpha в реестре → in_registry=True",
      bcmp.get("Alpha", {}).get("in_registry") is True)
check("Bravo постоянный, не в реестре → in_registry=False",
      bcmp.get("Bravo", {}).get("in_registry") is False)
check("Bravo НЕ помечен как новый (flag_new_nick falsy) → бейдж «в Доблести», не «ИИ-ник»",
      not bcmp.get("Bravo", {}).get("flag_new_nick"))
check("compare отдаёт флаг flag_new_nick для каждой строки (для бейджа)",
      all("flag_new_nick" in m for m in bcmp.values()))

# ── 9) Кадр (frame): сохранение в снимке + бэкфилл по canon ──
db.valor_save_snapshot(week="2026-W30", valor_norm=14, members=[
    {**mk("Frodo", 50), "frame": 0},
    {**mk("Sam", 20), "frame": 3},
    {**mk("Gandalf", 10)},  # без кадра
])
fcmp = {m["nick"]: m for m in db.valor_compare_data("2026-W30")["members"]}
check("frame сохранился из снимка (Frodo=0)", fcmp.get("Frodo", {}).get("frame") == 0)
check("frame сохранился из снимка (Sam=3)", fcmp.get("Sam", {}).get("frame") == 3)
check("без кадра → frame=None (Gandalf)", fcmp.get("Gandalf", {}).get("frame") is None)
# Бэкфилл кадров по нику без пересохранения снимка.
rf = db.valor_set_frames("2026-W30", [
    {"nick": "Frodo", "frame": 5}, {"nick": "Никонет", "frame": 9}])
check("set_frames: updated=1, missing=1", rf.get("updated") == 1 and rf.get("missing") == 1)
fcmp2 = {m["nick"]: m for m in db.valor_compare_data("2026-W30")["members"]}
check("frame обновлён бэкфиллом (Frodo=5)", fcmp2.get("Frodo", {}).get("frame") == 5)
check("Sam не тронут бэкфиллом (=3)", fcmp2.get("Sam", {}).get("frame") == 3)
check("set_frames в несуществующую неделю → no_snapshot",
      db.valor_set_frames("2026-W99", []).get("reason") == "no_snapshot")

# ── 10) Порядок compare: равная доблесть → ранний кадр выше (как на скринах) ──
# Кейс Silhead/Silhair: ник по алфавиту дал бы обратный порядок, но кадр
# (физическая позиция в списке) должен победить.
db.valor_save_snapshot(week="2026-W31", valor_norm=14, members=[
    {**mk("Alpha", 62), "frame": 1},   # алфавитно первый, но кадр 1 (ниже)
    {**mk("Bravo", 62), "frame": 0},   # алфавитно второй, но кадр 0 (выше)
    {**mk("Top", 90), "frame": 0},     # высшая доблесть — всегда первый
])
order = [m["nick"] for m in db.valor_compare_data("2026-W31")["members"]]
check("высшая доблесть первой (Top)", order[0] == "Top")
check("равная доблесть: ранний кадр выше, даже против алфавита (Bravo f0 > Alpha f1)",
      order.index("Bravo") < order.index("Alpha"))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
sys.exit(0 if ok else 1)
