"""Архив реестра: отправить ушедшего (даже без доблести) в архив и вернуть."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "regarch.db")
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


a = db.create_acceptance(game_nick="Ливнул", title="", accepted_date="2026-06-01",
                         note="", actor=ACTOR)
b = db.create_acceptance(game_nick="Остался", title="", accepted_date="2026-06-01",
                         note="", actor=ACTOR)
check("активный реестр = 2", len(db.list_acceptances()) == 2)

# В архив (человек ушёл, в доблесть не попадал)
res = db.set_acceptance_archived(a["id"], True, reason="ливнул досрочно", actor=ACTOR)
check("архивирование ok", res and res["archived"] is True, res)
check("активный реестр стал 1", len(db.list_acceptances()) == 1)
check("в архиве 1", len(db.list_archived_acceptances()) == 1)
check("причина сохранилась", db.list_archived_acceptances()[0]["archived_reason"] == "ливнул досрочно")

# Вернуть из архива
db.set_acceptance_archived(a["id"], False, reason="", actor=ACTOR)
check("после возврата активный = 2", len(db.list_acceptances()) == 2)
check("архив пуст", len(db.list_archived_acceptances()) == 0)

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
