"""Проверка взаимной синхронизации данных Реестр <-> Доблесть. Temp-DB."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "linksync.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])
import sys, datetime
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

db.init_db()
ACTOR = {"platform": "admin", "id": "admin", "name": "Тест"}
ok = True


def check(label, cond, got=None):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label + ("" if cond else f"  [{got}]"))


def vmember(nick):
    for m in db.valor_get_current(with_reg_notes=True)["members"]:
        if m["nick"] == nick or m.get("nick_canon") == db._valor_canon(nick):
            return m
    return None


today = datetime.date.today().isoformat()
_y, _w, _ = datetime.date.today().isocalendar()
WEEK = f"{_y}-W{_w:02d}"   # текущая неделя — чтобы иммунитет (принят сегодня) сработал
# Реестр: принимаем "Ронин" с примечанием
acc = db.create_acceptance(game_nick="Ронин", title="", accepted_date=today,
                           note="ядро клана", actor=ACTOR)
# Доблесть: снимок с тем же ником
db.valor_save_snapshot(week=WEEK, valor_norm=14, members=[
    {"nick": "Ронин", "valor": 30, "norm_met": True, "is_afk": False,
     "title": "", "rank": "", "class_": "", "level": 80, "true_name": ""}])

m = vmember("Ронин")
check("связь: примечание из Реестра видно в Доблести", m and m.get("reg_note") == "ядро клана", m and m.get("reg_note"))
check("связь: иммунитет из Реестра применён в Доблести (новичок/принят сегодня)",
      m and m.get("immunity") is not None, m and m.get("immunity"))

# 1) Меняем ПРИМЕЧАНИЕ в Реестре → меняется ли в Доблести (live)?
db.update_acceptance(acc["id"], game_nick=None, title=None, accepted_date=None,
                     note="топ-боец", actor=ACTOR)
m = vmember("Ронин")
check("Реестр→Доблесть: правка примечания подхватывается", m and m.get("reg_note") == "топ-боец", m and m.get("reg_note"))

# 2) Меняем НИК в Доблести (админ) → меняется ли ник в Реестре?
mid = vmember("Ронин")["id"]
db.valor_update_member(mid, {"nick": "Ронин-Босс"}, ACTOR)
disp = vmember("Ронин-Босс")
check("Доблесть: ник изменился на отображение", disp is not None, [x["nick"] for x in db.valor_get_current()["members"]])
reg = [a for a in db.list_acceptances()]
reg_nick = reg[0]["game_nick"] if reg else None
check("Доблесть→Реестр: ник в Реестре тоже сменился на «Ронин-Босс»",
      reg_nick == "Ронин-Босс", reg_nick)

# 3) Меняем НИК в Реестре → меняется ли отображаемый ник в Доблести?
db.update_acceptance(acc["id"], game_nick="Ронин-Лидер", title=None,
                     accepted_date=None, note=None, actor=ACTOR)
disp2 = vmember("Ронин-Лидер")
check("Реестр→Доблесть: ник в Доблести тоже сменился на «Ронин-Лидер»",
      disp2 is not None, [x["nick"] for x in db.valor_get_current()["members"]])
# и примечание/иммунитет не потерялись после смены ника
check("после смены ника связь примечания сохранилась",
      disp2 and disp2.get("reg_note") == "топ-боец", disp2 and disp2.get("reg_note"))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
