# -*- coding: utf-8 -*-
"""E2E «не забрали»: список кандидатов и ПОЛНЫЙ возврат человека.

Правило клана: ресурсы выдаются человеку одной пачкой сразу по всем очередям. Не пришёл —
не забрал ничего. Поэтому:
  • в списке обязан быть КАЖДЫЙ, кому что-то выдали, включая получивших часть и оставшихся
    в очереди (10.08 так пропали Vanyta и Мерак — список строился из снимка выбывших);
  • возврат человека отменяет всю его выдачу: и выход из очереди, и следы у оставшихся строк.

Запуск внутри контейнера (работает на копии базы, прод не трогается):
    flyctl ssh console -C "python /app/backend/tests/e2e_uncollected.py"
"""
import asyncio
import json
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


def report_recipients():
    """Кому отчёт реально что-то выдал: canon -> {ник, очереди}."""
    with db.connection() as conn:
        r = api_queue._last_live_report(conn)
        rep = json.loads(r["report"])
    out = {}
    for Q in rep.get("queues") or []:
        for row in Q.get("rows") or []:
            if row.get("status") == "ok" and (row.get("got") or {}):
                cn = row.get("main_canon") or row.get("nick")
                out.setdefault(cn, {"nick": row.get("nick"), "queues": set()})["queues"].add(Q["queue"])
    return out


print("\n1. публикуем отчёт")
out = asyncio.run(api_queue.admin_report(
    api_queue.ReportIn(from_stages=5, to_stages=5, commit=True, force=True), None, ACTOR))
check(out.get("committed") is True,
      "опубликован: вышли %s, остались частично %s" % (out.get("left_removed"), out.get("partial_stay")))

print("\n2. в списке — ВСЕ получатели, а не только выбывшие")
data = api_queue.uncollected_candidates(ACTOR)
people = {p["canon"]: p for p in data["people"]}
recips = report_recipients()
missing = [v["nick"] for c, v in recips.items() if c not in people]
check(not missing, "никто из получателей не потерян" + (" (нет: %s)" % ", ".join(missing) if missing else ""))
stayed_only = [p["nick"] for p in data["people"] if p["out"] == 0 and p["stayed"] > 0]
check(bool(stayed_only), "в списке есть получившие ЧАСТЬ и оставшиеся в очереди: %s"
      % (", ".join(stayed_only[:4]) or "—"))
for p in data["people"][:6]:
    print("     %-14s очередей: %d (вышел из %d) · получил: %s"
          % (p["nick"], len(p["queues"]), p["out"],
             ", ".join("%s×%s" % (g["name"], g["amount"]) for g in p["got_list"])[:70]))

print("\n3. возврат человека — сразу по ВСЕМ его очередям")
multi = sorted(data["people"], key=lambda p: -len(p["queues"]))
target = multi[0]
check(len(target["queues"]) >= 1, "берём %s — очередей с выдачей: %d" % (target["nick"], len(target["queues"])))
want_q = {x["queue"] for x in target["queues"]}
res = api_queue.return_people(api_queue.ReturnPeopleIn(canons=[target["canon"]]), None, ACTOR)
got = res["people"][0] if res["people"] else {}
touched = len(got.get("returned") or []) + len(got.get("cleared") or [])
check(touched >= len(want_q), "затронуто очередей %d при %d выдачах" % (touched, len(want_q)))
with db.connection() as conn:
    rows = {r["queue"]: dict(r) for r in conn.execute(
        "SELECT queue, pos, resource, resources, received FROM queue_entries"
        " WHERE main_canon=? AND privileged=0", (target["canon"],))}
    rep_row = api_queue._last_live_report(conn)
    snap = json.loads(rep_row["snapshot"]) if rep_row and rep_row["snapshot"] else {}
check(want_q.issubset(set(rows)), "человек стоит во всех своих очередях: %s" % sorted(rows))
# следы выдачи сняты: запись совпадает со снимком, сделанным ДО раздачи
was = {e.get("queue"): e for e in api_queue._snap_entries(snap)
       if (e.get("main_canon") or "") == target["canon"]}
same = []
for qq, cur in rows.items():
    e = was.get(qq)
    if not e:
        continue
    same.append((cur["resource"] or "") == (e.get("resource") or "")
                and (cur["resources"] or "") == api_queue._jstore(api_queue._snap_resources(e))
                and (cur["received"] or "") == api_queue._jstore(api_queue._jlist(e.get("received"))))
check(bool(same) and all(same), "записи вернулись к состоянию до раздачи (выбор ресурсов и «получено»)")
with db.connection() as conn:
    left = conn.execute("SELECT COUNT(*) c FROM queue_served_last WHERE main_canon=?",
                        (target["canon"],)).fetchone()["c"]
check(left == 0, "строки этого человека убраны из снимка выдачи")

print("\n4. он помечен возвращённым, остальные ждут")
data2 = api_queue.uncollected_candidates(ACTOR)
now = {p["canon"]: p for p in data2["people"]}
check(now.get(target["canon"], {}).get("returned") is True,
      "%s помечен «уже возвращён» — второй раз не отметить" % target["nick"])
waiting = [c for c, p in now.items() if not p["returned"]]
check(len(waiting) == len(people) - 1,
      "остальные кандидаты на месте (%d ждут возврата из %d)" % (len(waiting), len(people)))

print("\n5. защиты")
try:
    api_queue.return_people(api_queue.ReturnPeopleIn(canons=[]), None, ACTOR)
    check(False, "пустой список отклонён")
except Exception as exc:
    check("Никто не отмечен" in str(getattr(exc, "detail", exc)), "пустой список отклонён")
r = api_queue.return_people(api_queue.ReturnPeopleIn(canons=["нет-такого-канона"]), None, ACTOR)
check(r["not_found"] == ["нет-такого-канона"] and not r["people"], "неизвестный ник не ломает возврат")

print("\n" + "=" * 56)
print("ИТОГ: прошло %d, провалено %d" % (len(_ok), len(_bad)))
for f in _bad:
    print("   FAIL:", f)
sys.exit(1 if _bad else 0)
