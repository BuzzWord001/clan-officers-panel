# -*- coding: utf-8 -*-
"""E2E управления отчётом распределения: жетон ТОП-3 → публикация → откат →
применить снова → откат. Проверяет, что очередь возвращается ПОБИТОВО и что захват
по жетону гаснет и восстанавливается вместе с ней.

Запускать ВНУТРИ контейнера (там лежит боевая база):
    flyctl ssh console -C "python /app/backend/tests/e2e_report_control.py"

Боевая база НЕ трогается: работаем на копии /tmp/e2e_report.db, отправка в чаты
и рендер картинки замоканы.
"""
import asyncio
import json
import os
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), "/app/backend", "/app"):   # backend рядом или в образе
    if os.path.isfile(os.path.join(_p, "config.py")) and _p not in sys.path:
        sys.path.insert(0, _p)
        break

SRC = os.environ.get("E2E_SRC_DB", "/data/officers.db")
DST = "/tmp/e2e_report.db"
shutil.copy(SRC, DST)
for _suf in ("-wal", "-shm"):
    if os.path.exists(SRC + _suf):
        shutil.copy(SRC + _suf, DST + _suf)

import config  # noqa: E402

config.settings.db_path = DST
import api_queue  # noqa: E402
import db  # noqa: E402

assert db.settings.db_path == DST, "тест обязан работать на КОПИИ базы"


async def _fake_send(a, b=None, force_dm=False):
    return {"tg": "ok(test)", "vk": "ok(test)"}


api_queue._send_report_media = _fake_send
api_queue._send_text_to_chats = _fake_send
api_queue._render_report_image = lambda *a, **k: None

ACTOR = {"name": "e2e", "role": "admin"}
FIELDS = ("queue", "pos", "resource", "resources", "received", "privileged",
          "priv_stacks", "not_collected")
_ok, _bad = [], []


def check(cond, what):
    (_ok if cond else _bad).append(what)
    print(("  [ok ] " if cond else "  [FAIL] ") + what)


def snap():
    with db.connection() as conn:
        return {r["id"]: tuple([r["queue"], round(r["pos"], 3), r["resource"],
                                r["resources"] or "", r["received"] or "", r["privileged"],
                                r["priv_stacks"], r["not_collected"]])
                for r in conn.execute("SELECT * FROM queue_entries")}


def diff(a, b, title):
    n = 0
    for k in sorted(set(a) | set(b)):
        if a.get(k) == b.get(k):
            continue
        n += 1
        if n <= 8:
            if k not in a:
                print("      + лишняя запись id=%s: %s" % (k, b[k]))
            elif k not in b:
                print("      - пропала запись id=%s: %s" % (k, a[k]))
            else:
                print("      ~ id=%s: %s" % (k, "; ".join(
                    "%s: %r → %r" % (f, a[k][i], b[k][i])
                    for i, f in enumerate(FIELDS) if a[k][i] != b[k][i])))
    if n:
        print("      расхождений (%s): %d" % (title, n))
    return n


def privs():
    with db.connection() as conn:
        return [(r["nick"], r["resource"], r["priv_stacks"])
                for r in conn.execute("SELECT nick, resource, priv_stacks FROM queue_entries"
                                      " WHERE privileged=1 ORDER BY nick")]


print("\n0. применяем жетон ТОП-3 (захват вне очереди)")
with db.connection() as conn:
    who = conn.execute("SELECT main_canon, nick, cls FROM queue_entries"
                       " WHERE queue=0 AND privileged=0 ORDER BY pos LIMIT 1").fetchone()
    api_queue._make_privileged(conn, who["main_canon"], who["nick"], who["cls"] or "",
                               "kamen-doblesti", 1, "e2e")
check(len(privs()) == 1, "жетон применён: %s" % (privs(),))
base = snap()

print("\n1. публикация отчёта")
out = asyncio.run(api_queue.admin_report(
    api_queue.ReportIn(from_stages=4, to_stages=4, commit=True, force=True), None, ACTOR))
with db.connection() as conn:
    rid = conn.execute("SELECT MAX(id) m FROM queue_reports").fetchone()["m"]
check(out.get("committed") is True, "отчёт #%d опубликован (вышли %s)" % (rid, out.get("left_removed")))
check(privs() == [], "захват по жетону погашен публикацией")
check(out.get("threshold_violations") == [], "пороги доблести соблюдены")
after_pub = snap()

print("\n2. план (dry-run) ничего не меняет и показывает жетон")
frozen = snap()
plan = api_queue.report_plan(rid, ACTOR)
check(plan["action"] == "rollback", "для применённого отчёта план = откат")
check(snap() == frozen, "dry-run не изменил базу")
check(len((plan.get("steps") or {}).get("jetons") or []) == 1, "в плане виден возврат жетона")

print("\n3. откат")
r1 = api_queue.report_rollback(rid, None, ACTOR)
check(r1["priv_restored"] == 1, "жетон-запись восстановлена")
check(diff(base, snap(), "после отката") == 0, "очередь вернулась 1-в-1")

print("\n4. применить снова (шаг вперёд)")
plan2 = api_queue.report_plan(rid, ACTOR)
check(plan2["action"] == "reapply", "для откаченного план = применить снова")
check(len(plan2.get("jetons_spent") or []) == 1, "план предупреждает о списании жетона")
r2 = api_queue.report_reapply(rid, None, ACTOR)
check(r2.get("jetons_spent") == 1, "жетон снова снят")
check(diff(after_pub, snap(), "после повторного применения") == 0, "состояние как после публикации")

print("\n5. откат ещё раз")
r3 = api_queue.report_rollback(rid, None, ACTOR)
check(r3["returned"] == r1["returned"], "вернулось столько же (%d)" % r3["returned"])
check(diff(base, snap(), "после второго отката") == 0, "очередь снова 1-в-1")
check(len(privs()) == 1, "жетон опять на месте")

print("\n6. защиты")
try:
    api_queue.report_rollback(rid, None, ACTOR)
    check(False, "повторный откат отклонён")
except Exception as exc:
    check("уже откачен" in str(getattr(exc, "detail", exc)), "повторный откат отклонён")
h = api_queue.history_one(rid, ACTOR)
check(h["can_reapply"] and not h["can_rollback"], "история предлагает только шаг «вперёд»")

print("\n" + "=" * 56)
print("ИТОГ: прошло %d, провалено %d" % (len(_ok), len(_bad)))
for f in _bad:
    print("   FAIL:", f)
sys.exit(1 if _bad else 0)
