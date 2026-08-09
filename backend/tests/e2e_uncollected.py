# -*- coding: utf-8 -*-
"""E2E «не забрали»: список вышедших → возврат ОТМЕЧЕННЫХ по id → проверка мест и выбора.

Ключевое отличие от возврата по никам: возвращаем ровно ту запись, которую отметили —
человек, стоявший в нескольких очередях, не возвращается разом во все.

Запуск внутри контейнера (работает на копии базы, прод не трогается):
    flyctl ssh console -C "python /app/backend/tests/e2e_uncollected.py"
"""
import asyncio
import os
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), "/app/backend", "/app"):
    if os.path.isfile(os.path.join(_p, "config.py")) and _p not in sys.path:
        sys.path.insert(0, _p)
        break

SRC = os.environ.get("E2E_SRC_DB", "/data/officers.db")
DST = "/tmp/e2e_uncollected.db"
shutil.copy(SRC, DST)
for _s in ("-wal", "-shm"):
    if os.path.exists(SRC + _s):
        shutil.copy(SRC + _s, DST + _s)

import config  # noqa: E402

config.settings.db_path = DST
import api_queue  # noqa: E402
import db  # noqa: E402

assert db.settings.db_path == DST, "тест обязан работать на КОПИИ базы"


async def _fake(a, b=None, force_dm=False):
    return {"tg": "ok(test)", "vk": "ok(test)"}


api_queue._send_report_media = _fake
api_queue._send_text_to_chats = _fake
api_queue._render_report_image = lambda *a, **k: None
ACTOR = {"name": "e2e", "role": "admin"}
_ok, _bad = [], []


def check(cond, what):
    (_ok if cond else _bad).append(what)
    print(("  [ok ] " if cond else "  [FAIL] ") + what)


def entry_of(canon, queue):
    with db.connection() as conn:
        r = conn.execute("SELECT id, pos, resource, resources, received FROM queue_entries"
                         " WHERE main_canon=? AND queue=? AND privileged=0", (canon, queue)).fetchone()
    return dict(r) if r else None


print("\n1. публикуем отчёт, чтобы кто-то вышел из очереди")
out = asyncio.run(api_queue.admin_report(
    api_queue.ReportIn(from_stages=5, to_stages=5, commit=True, force=True), None, ACTOR))
check(out.get("committed") is True, "отчёт опубликован, вышли %s" % out.get("left_removed"))

print("\n2. список для галочек (/queue/served-last)")
served = api_queue.served_last(ACTOR)["served"]
check(bool(served), "список не пустой: %d чел" % len(served))
need = ("id", "nick", "queue", "queue_name", "pos", "resource", "source")
check(all(all(k in s for k in need) for s in served), "у каждой строки есть ник, очередь, место, ресурс, источник")
for s in served[:5]:
    print("     %-14s %-16s место %-5s %-22s %s" % (s["nick"], s["queue_name"], s["pos"], s["resource"], s["source"]))

if not served:
    print("\nНекого возвращать — тест дальше не идёт")
    sys.exit(1 if _bad else 0)

print("\n3. возврат ОДНОГО отмеченного")
target = served[0]
with db.connection() as conn:
    snap_row = conn.execute("SELECT main_canon, orig_pos, resources FROM queue_served_last"
                            " WHERE id=?", (target["id"],)).fetchone()
canon, orig_pos, want_res = snap_row["main_canon"], snap_row["orig_pos"], (snap_row["resources"] or "")
check(entry_of(canon, target["queue"]) is None, "%s сейчас НЕ в очереди %d" % (target["nick"], target["queue"]))

res = api_queue.restore_served(api_queue.RestoreServedIn(ids=[target["id"]]), None, ACTOR)
check(len(res["restored"]) == 1 and not res["missing"], "вернулся ровно один: %s" % res["restored"])
back = entry_of(canon, target["queue"])
check(back is not None, "%s снова в очереди %d" % (target["nick"], target["queue"]))
check(back and abs(float(back["pos"]) - (float(orig_pos) - 0.5)) < 0.001,
      "встал на прежнее место (%s → %s, перед тем, кто там сейчас)" % (orig_pos, back and back["pos"]))
check(back and (back["resources"] or "") == want_res,
      "выбор ресурсов сохранён: %s" % ((back and back["resources"]) or "(один ресурс)"))
with db.connection() as conn:
    gone = conn.execute("SELECT 1 FROM queue_served_last WHERE id=?", (target["id"],)).fetchone()
check(gone is None, "строка ушла из списка — второй раз вернуть нельзя")

print("\n4. человек в нескольких очередях возвращается ТОЛЬКО в отмеченную")
served2 = api_queue.served_last(ACTOR)["served"]
multi = {}
for s in served2:
    multi.setdefault(s["nick"], []).append(s)
pick = next((v for v in multi.values() if len(v) > 1), None)
if not pick:
    # в живых данных такого не случилось — собираем случай сами: один и тот же человек
    # значится вышедшим сразу из двух очередей
    print("     (в снимке такого нет — создаю случай вручную)")
    with db.connection() as conn:
        src = conn.execute("SELECT * FROM queue_served_last LIMIT 1").fetchone()
        if src:
            for qn, res in ((0, "kamen-doblesti"), (1, "prikaz-feniksa")):
                conn.execute(
                    "INSERT INTO queue_served_last (queue, orig_pos, main_canon, nick, cls,"
                    " resource, recipient, auto_repeat, auto_plan, added_by, served_at,"
                    " resources, received, recipients)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (qn, 9.0, "e2e~twin", "Е2Е-Двойник", "", res, "", 0, "", "report",
                     api_queue._now(), "", "", ""))
    served2 = api_queue.served_last(ACTOR)["served"]
    multi = {}
    for s in served2:
        multi.setdefault(s["nick"], []).append(s)
    pick = next((v for v in multi.values() if len(v) > 1), None)

if pick:
    one, other = pick[0], pick[1]
    api_queue.restore_served(api_queue.RestoreServedIn(ids=[one["id"]]), None, ACTOR)
    with db.connection() as conn:
        left = conn.execute("SELECT 1 FROM queue_served_last WHERE id=?", (other["id"],)).fetchone()
        got = conn.execute("SELECT COUNT(*) c FROM queue_entries WHERE main_canon=?"
                           " AND privileged=0", ("e2e~twin",)).fetchone()["c"]
    check(left is not None, "%s возвращён в «%s», а в «%s» остался в списке"
          % (one["nick"], one["queue_name"], other["queue_name"]))
    if one["nick"] == "Е2Е-Двойник":
        check(got == 1, "в очереди появилась ровно одна запись, а не обе (%d)" % got)
else:
    check(False, "не удалось проверить случай «человек в двух очередях»")

print("\n5. защиты")
try:
    api_queue.restore_served(api_queue.RestoreServedIn(ids=[]), None, ACTOR)
    check(False, "пустой список отклонён")
except Exception as exc:
    check("Никто не отмечен" in str(getattr(exc, "detail", exc)), "пустой список отклонён")
r = api_queue.restore_served(api_queue.RestoreServedIn(ids=[999999]), None, ACTOR)
check(r["missing"] == [999999] and not r["restored"], "несуществующий id не ломает возврат")

print("\n" + "=" * 56)
print("ИТОГ: прошло %d, провалено %d" % (len(_ok), len(_bad)))
for f in _bad:
    print("   FAIL:", f)
sys.exit(1 if _bad else 0)
