"""АФК = пауза стрика; перевыполнение в АФК продолжает стрик; нет предупреждений."""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "afkstreak.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])
import sys
sys.path.insert(0, "/app/backend")
import db  # noqa: E402

db.init_db()
NORM = 14
ok = True


def check(label, cond, got=None):
    global ok
    ok = ok and cond
    print(("OK  " if cond else "XX  ") + label + ("" if cond else f"  [{got}]"))


def snap(week, rows):   # rows: (nick, valor, afk)
    db.valor_save_snapshot(week=week, valor_norm=NORM, members=[
        {"nick": n, "valor": v, "norm_met": (v >= NORM), "is_afk": afk,
         "title": "", "rank": "", "class_": "", "level": 80, "true_name": ""}
        for n, v, afk in rows])


def m(nick):
    for x in db.valor_get_current()["members"]:
        if x["nick"] == nick:
            return x
    return None


OV = 40  # перевыполнение (>14)
# W10..W14. A: всегда over. B: over,over,АФК-простой,over,over.
# C: всегда АФК но перевыполняет. D: over,over,не-АФК-провал,over,over.
snap("2026-W10", [("A", OV, False), ("B", OV, False), ("C", OV, True),  ("D", OV, False)])
snap("2026-W11", [("A", OV, False), ("B", OV, False), ("C", OV, True),  ("D", OV, False)])
snap("2026-W12", [("A", OV, False), ("B", 0, True),   ("C", OV, True),  ("D", 0,  False)])
snap("2026-W13", [("A", OV, False), ("B", OV, False), ("C", OV, True),  ("D", OV, False)])
snap("2026-W14", [("A", OV, False), ("B", OV, False), ("C", OV, True),  ("D", OV, False)])

cA, cB, cC, cD = (m("A")["compliance"], m("B")["compliance"],
                  m("C")["compliance"], m("D")["compliance"])
check("A: стрик 5 (без АФК, всё over)", cA["over_streak_cur"] == 5, cA["over_streak_cur"])
check("B: АФК-простой НЕ сорвал стрик (=4)", cB["over_streak_cur"] == 4, cB["over_streak_cur"])
check("C: перевыполнение В АФК продолжает стрик (=5)", cC["over_streak_cur"] == 5, cC["over_streak_cur"])
check("C: доблесть в АФК идёт в статистику (пик>0)", cC["peak_ratio"] > 0, cC["peak_ratio"])
check("C: у АФК-игрока есть ценность доблести (>0)", m("C")["score"]["doblest_value"] > 0,
      m("C")["score"]["doblest_value"])
check("D: НЕ-АФК провал сорвал стрик (=2)", cD["over_streak_cur"] == 2, cD["over_streak_cur"])

# Предупреждения: у C (АФК) их нет, у D (провалил не в АФК на W12) — есть в ту неделю.
check("C: нет предупреждений (АФК)", m("C").get("warning_count", 0) == 0, m("C").get("warning_count"))

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
