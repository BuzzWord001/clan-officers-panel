# -*- coding: utf-8 -*-
"""Написание ников: откуда берётся и не «застывает» ли в старых списках.

10.08: в списке «не забрали» висел «Strannik», хотя человек давно «stRaNniK». Причин было
две — карта персон брала написание из распознанной доблести (кто первым попал в индекс),
а списки показывали ник, застывший в снимке отчёта. Тест закрывает обе.

Приоритет написания: ручная правка ✎ (valor_nick_override) → реестр приёма (acceptances,
Лир копирует ник из игры) → как распознал OCR (valor_members).

Запуск внутри контейнера (копия базы, прод не трогается):
    flyctl ssh console -C "python /app/backend/tests/e2e_nick_spelling.py"
"""
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
DST = "/tmp/e2e_nicks.db"
shutil.copy(SRC, DST)
for _s in ("-wal", "-shm"):
    if os.path.exists(SRC + _s):
        shutil.copy(SRC + _s, DST + _s)

import config  # noqa: E402

config.settings.db_path = DST
import api_queue  # noqa: E402
import db  # noqa: E402

assert db.settings.db_path == DST, "тест обязан работать на КОПИИ базы"
_ok, _bad = [], []


def check(cond, what):
    (_ok if cond else _bad).append(what)
    print(("  [ok ] " if cond else "  [FAIL] ") + what)


print("\n1. реестр приёма важнее распознанной доблести")
CN = "e2etestnick"
with db.connection() as conn:
    sid = conn.execute("SELECT id FROM valor_snapshots ORDER BY week DESC LIMIT 1").fetchone()["id"]
    conn.execute("INSERT INTO valor_members (snapshot_id, nick, nick_canon, title, class_,"
                 " true_name, rank, level, valor, is_afk, norm_met)"
                 " VALUES (?,?,?,?,?,?,?,?,?,0,1)",
                 (sid, "E2Etestnick", CN, "", "Убийца", "", "Рядовой", 105, 50))
    now = api_queue._now()
    conn.execute("INSERT INTO acceptances (game_nick, title, accepted_date, created_at, updated_at,"
                 " created_by_platform, created_by_id, created_by_name, archived)"
                 " VALUES (?,?,?,?,?,'e2e','0','e2e',0)",
                 ("e2eTESTnick", "", now[:10], now, now))
    idx = api_queue._people(conn)
check(CN in idx, "персона собралась")
check(idx.get(CN, {}).get("nick") == "e2eTESTnick",
      "написание из реестра приёма победило распознанное: %r" % idx.get(CN, {}).get("nick"))

print("\n2. ручная правка ✎ важнее всего")
with db.connection() as conn:
    conn.execute("INSERT INTO valor_nick_override (nick_canon, nick, updated_at, updated_by)"
                 " VALUES (?,?,?,'e2e') ON CONFLICT(nick_canon) DO UPDATE SET nick=excluded.nick",
                 (CN, "E2E~TestNick~", api_queue._now()))
    idx2 = api_queue._people(conn)
check(idx2.get(CN, {}).get("nick") == "E2E~TestNick~",
      "написание из админ-правки победило: %r" % idx2.get(CN, {}).get("nick"))
check(idx2.get(CN, {}).get("main_nick") == "E2E~TestNick~", "имя мэйна обновилось вместе с ником")

print("\n3. реальный случай: stRaNniK")
with db.connection() as conn:
    idx3 = api_queue._people(conn)
p = idx3.get("strannik")
if p:
    check(p["nick"] == "stRaNniK", "персона strannik пишется как в реестре: %r" % p["nick"])
else:
    check(False, "персона strannik не найдена")

print("\n4. старые списки показывают НЫНЕШНЕЕ написание, а не застывшее в снимке")
with db.connection() as conn:
    r = api_queue._last_live_report(conn)
    rep = json.loads(r["report"]) if r else {}
    frozen = set()
    for Q in rep.get("queues") or []:
        for row in Q.get("rows") or []:
            if row.get("status") == "ok" and (row.get("got") or {}):
                frozen.add((row.get("main_canon"), row.get("nick")))
    idx4 = api_queue._people(conn)
data = api_queue.uncollected_candidates({"name": "e2e", "role": "admin"})
shown = {p["canon"]: p["nick"] for p in data["people"]}
wrong = [(c, old, shown.get(c)) for c, old in frozen
         if c in shown and shown[c] != api_queue._live_nick(idx4, c, old)]
check(not wrong, "все ники в списке «не забрали» актуальны" + (" (расходятся: %s)" % wrong if wrong else ""))
stale = [(c, old) for c, old in frozen
         if c in shown and old != shown[c]]
print("     обновлено написаний по сравнению со снимком: %d %s"
      % (len(stale), ("(например %s → %s)" % (stale[0][1], shown[stale[0][0]])) if stale else ""))

print("\n5. served-last тоже отдаёт актуальные ники")
served = api_queue.served_last({"name": "e2e", "role": "admin"})["served"]
with db.connection() as conn:
    idx5 = api_queue._people(conn)
    raw = {row["id"]: (row["main_canon"], row["nick"]) for row in
           conn.execute("SELECT id, main_canon, nick FROM queue_served_last")}
bad_rows = [s["nick"] for s in served
            if s["nick"] != api_queue._live_nick(idx5, raw.get(s["id"], ("", ""))[0], raw.get(s["id"], ("", ""))[1])]
check(not bad_rows, "в снимке выдачи ники актуальны" + (" (%s)" % bad_rows if bad_rows else ""))

print("\n" + "=" * 56)
print("ИТОГ: прошло %d, провалено %d" % (len(_ok), len(_bad)))
for f in _bad:
    print("   FAIL:", f)
sys.exit(1 if _bad else 0)
