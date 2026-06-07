"""Офицер может: предупреждения +/-, АФК вкл/выкл; всё пишется в журнал."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "offact.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])
import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

db.init_db()
OFFICER = {"platform": "officer", "id": "Лейт", "name": "Лейтенант Икс"}
ok = True


def check(label, cond, got=None):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label + ("" if cond else f"  [{got}]"))


def audit_actions():
    return [(a["action"], a["actor_name"]) for a in db.list_audit(100)]


# Снимок с участником
db.valor_save_snapshot(week="2026-W22", valor_norm=14, members=[
    {"nick": "Тестер", "valor": 20, "norm_met": True, "is_afk": False,
     "title": "", "rank": "", "class_": "", "level": 80, "true_name": ""}])
mid = [m for m in db.valor_get_current()["members"] if m["nick"] == "Тестер"][0]["id"]

# 1) Предупреждение + (офицером) → лог
r = db.valor_add_manual_warning("Тестер", "mid", "за дело", OFFICER)
check("офицер добавил предупреждение", r.get("ok"), r)
check("warn_add в журнале с именем офицера",
      ("warn_add", "Лейтенант Икс") in audit_actions(), audit_actions()[:3])

# 2) Предупреждение − (офицером) → лог
check("офицер снял предупреждение", db.valor_remove_manual_warning(r["id"], OFFICER))
check("warn_remove в журнале", ("warn_remove", "Лейтенант Икс") in audit_actions())

# 3) АФК вкл офицером + комментарий → лог
res = db.valor_set_afk(mid, True, "отпуск до 20.07", OFFICER)
check("офицер дал АФК", res and res.get("is_afk") is True, res)
mm = [m for m in db.valor_get_current()["members"] if m["nick"] == "Тестер"][0]
check("статус АФК проставлен", mm["is_afk"] is True, mm["is_afk"])
check("комментарий АФК сохранён", mm.get("afk_note") == "отпуск до 20.07", mm.get("afk_note"))
check("afk_on в журнале", ("afk_on", "Лейтенант Икс") in audit_actions())

# 4) АФК выкл офицером → лог
db.valor_set_afk(mid, False, "", OFFICER)
mm = [m for m in db.valor_get_current()["members"] if m["nick"] == "Тестер"][0]
check("статус АФК снят", mm["is_afk"] is False, mm["is_afk"])
check("afk_off в журнале", ("afk_off", "Лейтенант Икс") in audit_actions())

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
