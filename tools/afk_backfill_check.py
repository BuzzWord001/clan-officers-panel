"""Бэкфилл is_afk по титулу + проверка новой АФК-аналитики. Запуск на Fly."""
import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

# 1) Бэкфилл: строки, где в титуле есть афк/afk, но флаг is_afk=0.
with db.connection() as conn:
    rows = conn.execute(
        "SELECT id, title FROM valor_members WHERE is_afk = 0"
    ).fetchall()
    to_fix = [r["id"] for r in rows if db._title_is_afk(r["title"])]
    for vid in to_fix:
        conn.execute("UPDATE valor_members SET is_afk = 1 WHERE id = ?", (vid,))
print(f"backfill: проставлен is_afk на {len(to_fix)} строк(е) по титулу")

# 2) Проверка: текущие АФК-участники с новой аналитикой.
data = db.valor_get_current()
members = data.get("members", [])
afk = [m for m in members if m.get("is_afk")]
print(f"\nВсего участников: {len(members)}; в АФК сейчас: {len(afk)}\n")
print(f"{'ник':22} {'нед':>3} {'с_недели':>9} {'было':>6} {'стало':>6} {'набрал':>7}")
print("-" * 62)
for m in sorted(afk, key=lambda x: -((x.get('afk_info') or {}).get('weeks') or 0)):
    a = m.get("afk_info") or {}
    nick = (m.get("nick") or "")[:22]
    print(f"{nick:22} {str(a.get('weeks','?')):>3} "
          f"{str(a.get('since_week','?')):>9} "
          f"{str(a.get('valor_start','—')):>6} "
          f"{str(a.get('valor_now','—')):>6} "
          f"{str(a.get('valor_gained','—')):>7}")
    if a.get("weekly"):
        wk = ", ".join(f"{w['week']}:{w['valor']}" for w in a["weekly"])
        print(f"{'':22}   по неделям: {wk}")

# 3) Те, кто набирал доблесть ДАЖЕ в АФК (gained > 0) — главный кейс.
earning = [m for m in afk if (m.get("afk_info") or {}).get("valor_gained", 0)
           and (m["afk_info"]["valor_gained"] > 0)]
print(f"\nНабирали доблесть во время АФК: {len(earning)}")
for m in earning:
    a = m["afk_info"]
    print(f"  {m.get('nick')}: +{a['valor_gained']} за {a['weeks']} нед.")
