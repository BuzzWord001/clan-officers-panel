# -*- coding: utf-8 -*-
"""E2E нового потока раздачи: ПУБЛИКАЦИЯ и СДВИГ — разные кнопки (16.08.2026).

Что фиксируем (каждый пункт — раньше был одним действием и мог разъехаться):
  1. публикация отчёта НЕ двигает очередь, сколько её ни жми;
  2. сдвиг двигает — ровно по тому числу этапов, которое ввели, и ровно один раз за неделю;
  3. отчёт Огненного цилиня — отдельная публикация, очередь цилиня не трогает;
  4. раздача цилиня двигает ТОЛЬКО очередь цилиня и не стирает снимок отчёта;
  5. «не забрал» возвращает человека на прежнее место после сдвига;
  6. откат сдвига возвращает очередь побитово, откат раздачи цилиня — своих получателей;
  7. индикаторы недели показывают правду на каждом шаге.

База своя, временная (создаётся с нуля) — боевую не трогаем и flyctl не нужен:
    python backend/tests/e2e_report_shift.py
"""
import asyncio
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), "/app/backend", "/app"):
    if os.path.isfile(os.path.join(_p, "config.py")) and _p not in sys.path:
        sys.path.insert(0, _p)
        break

DST = os.path.join(tempfile.gettempdir(), "e2e_report_shift.db")
for _s in ("", "-wal", "-shm"):
    if os.path.exists(DST + _s):
        os.remove(DST + _s)

import config  # noqa: E402

config.settings.db_path = DST
import api_queue  # noqa: E402
import db  # noqa: E402
import distribution  # noqa: E402

assert db.settings.db_path == DST, "тест обязан работать на СВОЕЙ базе"

_ok, _bad = [], []


def check(cond, what):
    (_ok if cond else _bad).append(what)
    print(("  [ok ] " if cond else "  [FAIL] ") + what)


# ── окружение: чаты, картинка и доблесть замоканы, считаем только логику очередей ──
async def _fake_send(a, b=None, force_dm=False):
    return {"tg": "ok(test)", "vk": "ok(test)"}


api_queue._send_report_media = _fake_send
api_queue._send_text_to_chats = _fake_send
api_queue._render_report_image = lambda *a, **k: None
api_queue._valor_week_stale = lambda: ""          # доблесть считаем свежей
api_queue._is_test_mode = lambda: False           # боевой режим (пробный проверяем отдельно)
db.valor_latest_week = lambda: "2026-W33"
api_queue._save_low_valor_notices = lambda conn, rep: None

VALOR = 500          # всем хватает на любой порог
PEOPLE = ["Аня", "Боря", "Вера", "Гена", "Дима"]


def _fake_build_report(conn, stages_override=None, stages_from=0):
    """Тот же движок distribution.compute, но записи берём прямо из таблицы, без ростера и
    снимков доблести (их наполнение к этому тесту отношения не имеет)."""
    import json as _json
    queues = [[], [], [], []]
    for r in conn.execute("SELECT * FROM queue_entries ORDER BY queue, pos, id"):
        try:
            ress = _json.loads(r["resources"]) if r["resources"] else []
        except (ValueError, TypeError):
            ress = []
        try:
            recv = _json.loads(r["received"]) if r["received"] else []
        except (ValueError, TypeError):
            recv = []
        queues[r["queue"]].append({
            "id": r["id"], "nick": r["nick"], "main_canon": r["main_canon"],
            "canon_nick": r["main_canon"], "resource": r["resource"], "resources": ress,
            "received": recv, "recipient": r["recipient"] or "", "recipients": {},
            "pos": r["pos"], "cls": "", "auto_repeat": r["auto_repeat"],
            "auto_plan": [], "not_collected": bool(r["not_collected"]),
            "privileged": bool(r["privileged"]), "priv_stacks": r["priv_stacks"],
        })
    state = {"queues": queues}
    valor = {p.lower(): VALOR for p in PEOPLE}
    cfg = {"stages": 6 if stages_override is None else stages_override,
           "stages_from": stages_from, "pet_count": 0, "shooters": [], "claims": [],
           "main_map": {}}
    return distribution.compute(state, valor, cfg)


api_queue._build_report = _fake_build_report

ACTOR = {"name": "e2e", "role": "admin"}


class _Req:                       # заглушка Request для _log
    client = type("c", (), {"host": "test"})()
    headers: dict = {}


REQ = _Req()


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if asyncio.iscoroutine(coro) else coro


def seed():
    """Чистая очередь: четверо за обычными ресурсами (q0) и двое за цилинём (q2)."""
    db.init_db()                  # общие таблицы (доблесть, люди) — иначе снимок очереди не соберётся
    api_queue.ensure_queue_tables()
    with db.connection() as conn:
        conn.execute("DELETE FROM queue_entries")
        conn.execute("DELETE FROM queue_served_last")
        conn.execute("DELETE FROM queue_reports")
        conn.execute("DELETE FROM queue_kv WHERE key='report_shift_week'")
        rows = [(0, 1.0, "аня", "Аня", "kamen-doblesti", 0),
                (0, 2.0, "боря", "Боря", "kamen-doblesti", 1),   # 🔁 повтор → уйдёт в конец
                (0, 3.0, "вера", "Вера", "meteorit", 0),
                (2, 1.0, "гена", "Гена", "mount-cilin", 0),      # очередь цилиня
                (2, 2.0, "дима", "Дима", "mount-cilin", 0)]
        for q, pos, canon, nick, res, rep in rows:
            conn.execute(
                "INSERT INTO queue_entries (queue, pos, main_canon, nick, cls, resource,"
                " resources, received, recipient, auto_repeat, auto_plan, added_by, added_at)"
                " VALUES (?,?,?,?,'',?,?,'','',?,'','seed',?)",
                (q, pos, canon, nick, res, '["%s"]' % res, rep, api_queue._now()))


def queue_state():
    with db.connection() as conn:
        return {r["nick"]: (r["queue"], round(r["pos"], 3))
                for r in conn.execute("SELECT * FROM queue_entries")}


def week_status():
    return api_queue.admin_week_status(ACTOR)


print("\n1. ПУБЛИКАЦИЯ ОТЧЁТА НЕ ДВИГАЕТ ОЧЕРЕДЬ")
seed()
before = queue_state()
r1 = run(api_queue.admin_report(api_queue.ReportIn(from_stages=6, to_stages=6, commit=True), REQ, ACTOR))
check(r1.get("published") and r1.get("shifted") is False, "отчёт опубликован, флаг shifted=False")
check(queue_state() == before, "очередь после публикации не изменилась")
run(api_queue.admin_report(api_queue.ReportIn(from_stages=6, to_stages=6, commit=True), REQ, ACTOR))
check(queue_state() == before, "повторная публикация тоже не двигает очередь")
with db.connection() as conn:
    n_rep = conn.execute("SELECT COUNT(*) c FROM queue_reports WHERE kind='report'").fetchone()["c"]
check(n_rep == 1, "две публикации за неделю дали ОДНУ запись в истории (без дублей)")
ws = week_status()
check(ws["report"]["published"] and not ws["shift"]["done"],
      "индикаторы: отчёт опубликован, очередь ещё не сдвинута")

print("\n2. ПРОБНЫЙ ОТЧЁТ НИЧЕГО НЕ ОТПРАВЛЯЕТ И НЕ ДВИГАЕТ")
pv = run(api_queue.admin_report(api_queue.ReportIn(from_stages=6, to_stages=6, commit=False), REQ, ACTOR))
check(pv.get("preview") and not pv.get("sent"), "пробный отчёт: в каналы не ушёл")
check(bool(pv.get("text")) and bool(pv.get("report")), "пробный отчёт вернул текст и расчёт для показа на сайте")
check(queue_state() == before, "пробный отчёт очередь не тронул")
# Диапазон этапов = ПОЛНЫЙ отчёт на каждый вариант. Раньше на «4-5» приходил один расклад
# (за 4) с припиской «если закроем 5-й — дополнительно», и раздачу за 5 надо было
# складывать в уме.
rng = run(api_queue.admin_report(api_queue.ReportIn(from_stages=4, to_stages=6, commit=False), REQ, ACTOR))
vs = rng.get("variants") or []
check([v["stages"] for v in vs] == [4, 5, 6], "диапазон 4-6 даёт три полных варианта отчёта")
check(all(v.get("text") and v.get("report") for v in vs), "у каждого варианта свой текст и свой расчёт")
one = run(api_queue.admin_report(api_queue.ReportIn(from_stages=6, to_stages=6, commit=False), REQ, ACTOR))
check(len(one.get("variants") or []) == 1, "один этап — один вариант, лишнего не считаем")

print("\n3. ЦИЛИНЬ — ОТДЕЛЬНЫЙ ОТЧЁТ, ОЧЕРЕДЬ НЕ ДВИГАЕТ")
cr = run(api_queue.admin_cilin_report(api_queue.CilinReportIn(count=1, commit=True), REQ, ACTOR))
check(cr.get("published") and cr.get("shifted") is False, "отчёт цилиня опубликован, очередь не сдвинута")
check("Гена" in cr["text"] and "Дима" in cr["text"], "в отчёте цилиня оба стоящих")
check(queue_state() == before, "очередь цилиня после публикации отчёта не изменилась")
check("ЦИЛИНЬ" not in (r1.get("text") or "").upper(), "в отчёте ресурсов цилиня больше нет")
ws = week_status()
check(ws["cilin_report"]["published"] and not ws["cilin_shift"]["done"],
      "индикаторы: отчёт цилиня опубликован, цилинь не роздан")

print("\n4. СДВИГ ОЧЕРЕДИ — ОТДЕЛЬНОЙ КНОПКОЙ")
plan = api_queue.admin_shift(api_queue.ShiftIn(stages=6, dry_run=True), REQ, ACTOR)
check(plan["dry_run"] and queue_state() == before, "план сдвига ничего не меняет")
sh = api_queue.admin_shift(api_queue.ShiftIn(stages=6), REQ, ACTOR)
after = queue_state()
check(sh["shifted"] and after != before, "сдвиг произошёл")
check("Аня" not in after, "получившая разово вышла из очереди")
check(after.get("Боря", (0, 0))[1] > before["Боря"][1], "с 🔁 ушёл в конец очереди")
check(after.get("Гена") == before["Гена"] and after.get("Дима") == before["Дима"],
      "очередь цилиня сдвигом ресурсов НЕ тронута")
ws = week_status()
check(ws["shift"]["done"] and ws["shift"]["stages"] == 6, "индикаторы: очередь сдвинута по 6 этапам")
try:
    api_queue.admin_shift(api_queue.ShiftIn(stages=6), REQ, ACTOR)
    check(False, "повторный сдвиг за ту же неделю заблокирован")
except Exception as e:
    check("уже сдвигали" in str(getattr(e, "detail", e)), "повторный сдвиг за ту же неделю заблокирован")

print("\n5. РАЗДАЧА ЦИЛИНЯ ДВИГАЕТ ТОЛЬКО СВОЮ ОЧЕРЕДЬ")
before_c = queue_state()
cd = api_queue.cilin_distribute(api_queue.CilinDistributeIn(count=1, dry_run=True), REQ, ACTOR)
check(cd["given"] == ["Гена"] and queue_state() == before_c, "превью раздачи: получит первый, БД не тронута")
cd = api_queue.cilin_distribute(api_queue.CilinDistributeIn(count=1), REQ, ACTOR)
after_c = queue_state()
check(cd["given_count"] == 1 and "Гена" not in after_c, "цилинь выдан первому, он вышел из очереди")
check(after_c.get("Дима") == before_c["Дима"], "второй в очереди цилиня остался на месте")
check({k: v for k, v in after_c.items() if k != "Гена"} ==
      {k: v for k, v in before_c.items() if k != "Гена"}, "очереди ресурсов раздача цилиня не тронула")
with db.connection() as conn:
    rep_snaps = conn.execute("SELECT COUNT(*) c FROM queue_served_last WHERE added_by='report'").fetchone()["c"]
check(rep_snaps > 0, "снимок отчёта пережил раздачу цилиня (возврат «не забрал» возможен)")
ws = week_status()
check(ws["cilin_shift"]["done"] and ws["cilin_shift"]["given"] == 1, "индикаторы: цилинь роздан (1)")

print("\n6. «НЕ ЗАБРАЛ» ВОЗВРАЩАЕТ НА ПРЕЖНЕЕ МЕСТО")
with db.connection() as conn:
    sid = conn.execute("SELECT id FROM queue_served_last WHERE nick='Аня'").fetchone()
check(sid is not None, "вышедшая Аня есть в снимке «кто получил»")
cand = api_queue.uncollected_candidates(ACTOR)["people"]
check(any(p["nick"] == "Аня" for p in cand), "Аня в списке «кому выдали» (кандидаты на возврат)")
check(any(p.get("cilin") for p in cand), "получатель цилиня тоже в списке кандидатов")
ret = api_queue.return_people(api_queue.ReturnPeopleIn(canons=["аня"]), REQ, ACTOR)
back = queue_state()
check(ret.get("ok") and "Аня" in back, "Аня вернулась в очередь")
check(back["Аня"][0] == 0 and back["Аня"][1] < before["Боря"][1], "вернулась ПЕРЕД тем, кто стоял за ней")

print("\n7. ОТКАТЫ")
with db.connection() as conn:
    rid = conn.execute("SELECT id FROM queue_reports WHERE kind='report'").fetchone()["id"]
    cid = conn.execute("SELECT id FROM queue_reports WHERE kind='cilin'").fetchone()["id"]
    r = api_queue._report_or_404(conn, rid)
    rb = api_queue._rollback_report(conn, r, "e2e", REQ)
check(rb["ok"], "откат сдвига отработал")
st = queue_state()
check("Аня" in st and "Боря" in st and st["Боря"][1] == before["Боря"][1],
      "очередь ресурсов вернулась к состоянию до сдвига")
with db.connection() as conn:
    c = api_queue._report_or_404(conn, cid)
    cb = api_queue._rollback_cilin(conn, c, "e2e", REQ)
check(cb["returned"] == 1 and "Гена" in queue_state(), "откат раздачи цилиня вернул получателя")
with db.connection() as conn:
    c2 = api_queue._report_or_404(conn, cid)
    try:
        api_queue._rollback_cilin(conn, c2, "e2e", REQ)
        check(False, "повторный откат цилиня заблокирован")
    except Exception as e:
        check("не двигали" in str(getattr(e, "detail", e)), "повторный откат цилиня заблокирован")

print("\n8. ОТКАТ НЕСДВИНУТОГО ОТЧЁТА ЗАПРЕЩЁН")
seed()
run(api_queue.admin_report(api_queue.ReportIn(from_stages=6, to_stages=6, commit=True), REQ, ACTOR))
with db.connection() as conn:
    rid2 = conn.execute("SELECT id FROM queue_reports WHERE kind='report'"
                        " ORDER BY id DESC LIMIT 1").fetchone()["id"]
    r2 = api_queue._report_or_404(conn, rid2)
    try:
        api_queue._rollback_report(conn, r2, "e2e", REQ)
        check(False, "откатить неcдвинутый отчёт нельзя")
    except Exception as e:
        check("не сдвигали" in str(getattr(e, "detail", e)), "откатить неcдвинутый отчёт нельзя")

print("\n9. ИСТОРИЯ: ДВА ВИДА ОТЧЁТА ЗА НЕДЕЛЮ НЕ ВЫТЕСНЯЮТ ДРУГ ДРУГА")
run(api_queue.admin_cilin_report(api_queue.CilinReportIn(count=0, commit=True), REQ, ACTOR))
h = api_queue.history(False, ACTOR)["reports"]
kinds = {x["kind"] for x in h}
check("report" in kinds and "cilin" in kinds, "в истории видны оба отчёта за одну неделю")

print("\n10. ДОБЛЕСТЬ НА ПОЛОСАХ ОЧЕРЕДЕЙ (наложение для админа)")
seed()
ov = api_queue.valor_overlay(ACTOR)
with db.connection() as conn:
    ids = [str(r["id"]) for r in conn.execute("SELECT id FROM queue_entries")]
check(set(ov["valor"].keys()) == set(ids), "доблесть отдаётся по КАЖДОЙ записи очереди (ключ = id)")
check(ov["thresholds"].get(0) == 60 and ov["thresholds"].get(2) == 100,
      "пороги очередей приходят вместе с доблестью — сцена красит по ним")
check("week" in ov and "has_valor" in ov, "видно, за какую неделю доблесть и собрана ли она")

print("\n" + "=" * 58)
if _bad:
    print("ПРОВАЛЕНО %d из %d:" % (len(_bad), len(_ok) + len(_bad)))
    for b in _bad:
        print("  ✗ " + b)
    sys.exit(1)
print("ВСЕ %d ПРОВЕРОК ПРОШЛИ" % len(_ok))
