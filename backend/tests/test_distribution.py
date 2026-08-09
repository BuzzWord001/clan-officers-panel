# -*- coding: utf-8 -*-
"""Проверки движка распределения КХ — БЕЗ базы и сети.

Зачем: 02.08.2026 порог доблести в легендарной очереди отключили одной строкой, и 09.08
Драконья чешуя ушла игроку с 0 доблести, пока двое со 107 остались ни с чем. Поймать было
нечем — тестов в проекте не было. Эти тесты фиксируют правила раздачи, чтобы такая правка
падала сразу.

Запуск:  python backend/tests/test_distribution.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import distribution as d  # noqa: E402

_fails = []
_checks = 0


def check(cond, what):
    global _checks
    _checks += 1
    print(("  [ok ] " if cond else "  [FAIL] ") + what)
    if not cond:
        _fails.append(what)


def entry(nick, res, pos, queue=0, **kw):
    """Запись очереди в том виде, в каком её отдаёт _entry_public."""
    e = {"id": kw.pop("id", None) or (hash(nick + res) & 0xFFFF), "nick": nick,
         "main_canon": nick.lower(), "canon_nick": nick.lower(), "resource": res,
         "resources": kw.pop("resources", []), "received": kw.pop("received", []),
         "recipient": "", "recipients": {}, "pos": pos, "cls": ""}
    e.update(kw)
    return e


def run(queues, valor, **cfg):
    state = {"queues": [queues.get(q, []) for q in (0, 1, 2, 3)]}
    base = {"stages": 6, "stages_from": 0, "pet_count": 0, "shooters": [], "claims": [], "main_map": {}}
    base.update(cfg)
    return d.compute(state, valor, base)


def winners(rep, q):
    return [r["nick"] for r in rep["queues"][q]["rows"] if r["status"] == "ok" and r.get("got")]


print("\n1. ПОРОГ ДОБЛЕСТИ ДЕЙСТВУЕТ В КАЖДОЙ ОЧЕРЕДИ")
for q, res, thr in ((0, "kamen-doblesti", 60), (1, "prikaz-feniksa", 100),
                    (2, "drakonya-cheshuya", 100), (3, "vysshiy-kamen", 200)):
    rep = run({q: [entry("Мало", res, 1, q), entry("Хватает", res, 2, q)]},
              {"мало": thr - 1, "хватает": thr})
    w = winners(rep, q)
    check("Мало" not in w, "очередь %d (порог %d): ниже порога НЕ получает" % (q, thr))
    check("Хватает" in w, "очередь %d: ровно порог — получает" % q)
    check(rep["threshold_violations"] == [], "очередь %d: самопроверка порогов чистая" % q)

print("\n2. РЕГРЕСС 09.08: чешуя мимо нулевой доблести — следующему, кто набрал")
rep = run({2: [entry("EvgeniY", "drakonya-cheshuya", 11, 2),
               entry("Strannik", "drakonya-cheshuya", 30, 2)]},
          {"evgeniy": 0, "strannik": 107})
check(winners(rep, 2) == ["Strannik"], "чешую получил Strannik (107), а не EvgeniY (0)")
check(rep["threshold_violations"] == [], "нарушений порога нет")

print("\n3. САМОПРОВЕРКА ЛОВИТ НАРУШЕНИЕ, если порог кто-то снова отключит")
_orig = d.QUEUE_THRESHOLD.copy()
try:
    d.QUEUE_THRESHOLD[2] = 0          # имитируем правку «раздаём сверху очереди без порога»
    rep = run({2: [entry("Ноль", "drakonya-cheshuya", 1, 2)]}, {"ноль": 0})
    got_it = winners(rep, 2) == ["Ноль"]
    d.QUEUE_THRESHOLD.update(_orig)   # порог вернули → та же раздача обязана стать нарушением
    viol = [v for Q in rep["queues"] for v in ([] if Q["threshold"] >= 100 else [1])]
    check(got_it, "с отключённым порогом человек с 0 действительно получает (баг воспроизведён)")
    rep2 = run({2: [entry("Ноль", "drakonya-cheshuya", 1, 2)]}, {"ноль": 0})
    check(winners(rep2, 2) == [] and rep2["threshold_violations"] == [],
          "с нормальным порогом он не получает и нарушений нет")
finally:
    d.QUEUE_THRESHOLD.update(_orig)

print("\n4. РЕЖИМЫ ВЫДАЧИ")
rep = run({0: [entry("Первый", "kamen-bessmertnyh", 1), entry("Второй", "kamen-bessmertnyh", 2)]},
          {"первый": 100, "второй": 100})
rows = {r["nick"]: r for Q in rep["queues"] for r in Q["rows"]}
check(rows["Первый"]["got"].get("kamen-bessmertnyh") == d._total("kamen-bessmertnyh", 6),
      "pack (камень бессмертных) уходит ПЕРВОМУ целиком")
check(not rows["Второй"]["got"].get("kamen-bessmertnyh"), "второму пачка не достаётся")

rep = run({0: [entry("A", "kamen-doblesti", 1, resources=["kamen-doblesti"]),
               entry("B", "kamen-doblesti", 2, resources=["kamen-doblesti"])]},
          {"a": 100, "b": 100})
rows = {r["nick"]: r for Q in rep["queues"] for r in Q["rows"]}
total = d._total("kamen-doblesti", 6)
unit = d.REWARDS["kamen-doblesti"]["unit"]
whole = (total // unit) * unit                      # раздаём только ПОЛНЫЕ стаки
given = rows["A"]["got"]["kamen-doblesti"] + rows["B"]["got"]["kamen-doblesti"]
check(given == whole, "stack: роздано %d из %d — все полные стаки по %d" % (given, total, unit))
check(rep["leftovers"].get("kamen-doblesti", 0) == total - whole,
      "неполный стак (%d шт) уходит в остаток клана" % (total - whole))

print("\n5. ВЫБОР РЕСУРСОВ УВАЖАЕТСЯ")
rep = run({0: [entry("ТолькоМетеорит", "meteorit", 1, resources=["meteorit"]),
               entry("Всё", "kamen-doblesti", 2)]}, {"толькометеорит": 100, "всё": 100})
rows = {r["nick"]: r for Q in rep["queues"] for r in Q["rows"]}
check(set(rows["ТолькоМетеорит"]["got"]) == {"meteorit"}, "кто выбрал один ресурс — получает только его")
check("kamen-doblesti" in rows["Всё"]["got"], "кто не выбирал — получает всё подряд")

print("\n6. ПАРТИАЛ: недополучивший остаётся за недостающим (только q0)")
rep = run({0: [entry("Первый", "zhemchuzhina", 1), entry("Второй", "zhemchuzhina", 2)]},
          {"первый": 100, "второй": 100})
rows = {r["nick"]: r for Q in rep["queues"] for r in Q["rows"]}
check("zhemchuzhina" in (rows["Второй"]["missing"] or []),
      "второму пачка не досталась → жемчужина в missing (останется в очереди)")

print("\n7. ЦИЛИНЬ — отдельная очередь, в раздачу не идёт")
rep = run({2: [entry("Ждун", "mount-cilin", 1, 2), entry("Мало", "mount-cilin", 2, 2)]},
          {"ждун": 150, "мало": 10})
names = {p["receiver"]: p["status"] for p in rep["pet_queue"]}
check(names.get("Ждун") == "pet" and names.get("Мало") == "pet_low",
      "оба в списке цилиня, недобравший помечен pet_low")
check(winners(rep, 2) == [], "цилинь-ждуны ресурсы очереди не получают")

print("\n8. ДЕЛЬТА: проводники считаются от ПРИРОСТА этапов")
full = run({0: []}, {}, stages=5, shooters=["P"])
delta = run({0: []}, {}, stages=5, stages_from=4, shooters=["P"])
grow = d._total("kamen-doblesti", 5) - d._total("kamen-doblesti", 4)
check(full["shooters"][0]["got"]["kamen-doblesti"] == round(d._total("kamen-doblesti", 5) * 0.1),
      "полный отчёт: проводнику 10%% от всего объёма")
check(delta["shooters"][0]["got"]["kamen-doblesti"] == round(grow * 0.1),
      "дельта: проводнику 10%% от прироста (%d шт)" % grow)

print("\n9. ГРАМОТА не раздаётся автоматически")
rep = run({1: [entry("Кто-то", "gramota", 1, 1)]}, {"кто-то": 500})
rows = {r["nick"]: r for Q in rep["queues"] for r in Q["rows"]}
check("gramota" not in (rows["Кто-то"]["got"] or {}), "грамота не выдаётся автоматически")
check(rep["leftovers"].get("gramota", 0) == d._total("gramota", 6),
      "весь объём грамот уходит в остаток — мастер раздаёт вручную")

print("\n" + "=" * 58)
if _fails:
    print("ПРОВАЛЕНО %d из %d:" % (len(_fails), _checks))
    for f in _fails:
        print("   -", f)
    sys.exit(1)
print("ВСЕ %d ПРОВЕРОК ПРОШЛИ" % _checks)
