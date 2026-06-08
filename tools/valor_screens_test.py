"""Тест страницы «Скрины сбора»: добавление пропущенной строки, удаление
фантома OCR и данные сравнения — на ВРЕМЕННОЙ БД (прод не трогаем).

Проверяет db.valor_add_member / db.valor_delete_member / db.valor_compare_data:
happy-path добавления, дубль по canon, АФК из титула, продолжение серии
предупреждений, возврат из departed, members_count, и что compare отдаёт
строки с флагами и скринами.
"""
import os
import sys
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "valor_screens_test.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])

# Локальный запуск и запуск на Fly (/app/backend).
for p in ("/app/backend", os.path.join(os.path.dirname(__file__), "..", "backend")):
    if os.path.isdir(p):
        sys.path.insert(0, p)
import db  # noqa: E402

db.init_db()
ACTOR = {"platform": "admin", "id": "admin", "name": "Тест"}
ok = True


def check(label, cond):
    global ok
    ok = ok and bool(cond)
    print(("OK  " if cond else "XX  ") + label)


def mk(nick, valor, title="", afk=False):
    return {"nick": nick, "valor": valor, "title": title, "is_afk": afk,
            "rank": "", "class_": "", "level": 80, "true_name": ""}


# ── База: два снимка (для серий предупреждений и departed) ──
db.valor_save_snapshot(week="2026-W22", valor_norm=14,
                       members=[mk("Alpha", 20), mk("Bravo", 5), mk("Cee", 3)])
db.valor_save_snapshot(week="2026-W23", valor_norm=14,
                       members=[mk("Alpha", 30), mk("Bravo", 4)])
# На W23: Alpha выполнил, Bravo НЕ выполнил (2 недели подряд → warn растёт),
# Cee пропал → должен быть в departed.

departed0 = {d["nick"] for d in db.valor_get_departed()}
check("Cee ушёл в архив departed после W23", "Cee" in departed0)

# ── 1) Добавить пропущенную строку (OCR не распознал MissedGuy) ──
res = db.valor_add_member("2026-W23", mk("MissedGuy", 25), ACTOR)
check("add: ok=True", res.get("ok") is True)
check("add: вернулся id", isinstance(res.get("id"), int))

cmp23 = db.valor_compare_data("2026-W23")
nicks23 = {m["nick"] for m in cmp23["members"]}
check("compare содержит добавленного MissedGuy", "MissedGuy" in nicks23)
mg = next(m for m in cmp23["members"] if m["nick"] == "MissedGuy")
check("MissedGuy: доблесть 25 сохранилась", mg["valor"] == 25)

cur = db.valor_get_current()
cur_nicks = {m["nick"] for m in cur["members"]}
check("таблица Доблести (current) видит MissedGuy сразу", "MissedGuy" in cur_nicks)

# members_count снимка обновился
with db.connection() as c:
    mc = c.execute("SELECT members_count FROM valor_snapshots WHERE week=?",
                   ("2026-W23",)).fetchone()["members_count"]
    real = c.execute(
        "SELECT COUNT(*) AS n FROM valor_members m JOIN valor_snapshots s "
        "ON m.snapshot_id=s.id WHERE s.week=?", ("2026-W23",)).fetchone()["n"]
check("members_count снимка совпал с числом строк", mc == real)

# ── 2) Дубль по canon → reason=exists ──
dup = db.valor_add_member("2026-W23", mk("missedguy", 9), ACTOR)
check("add дубля (тот же canon) → ok=False, reason=exists",
      dup.get("ok") is False and dup.get("reason") == "exists")

# ── 3) АФК из титула → norm_met не оценивается (None) ──
db.valor_add_member("2026-W23", mk("SleepyGuy", 2, title="АФК до пт"), ACTOR)
with db.connection() as c:
    nm = c.execute("SELECT norm_met, is_afk FROM valor_members WHERE nick=?",
                   ("SleepyGuy",)).fetchone()
check("АФК-строка: is_afk=1", nm["is_afk"] == 1)
check("АФК-строка: norm_met=None (не оценивается)", nm["norm_met"] is None)

# ── 4) Возврат: добавляем ушедшего Cee обратно в W23 → уходит из departed ──
db.valor_add_member("2026-W23", mk("Cee", 16), ACTOR)
departed1 = {d["nick"] for d in db.valor_get_departed()}
check("добавленный обратно Cee удалён из departed", "Cee" not in departed1)

# ── 5) Серия предупреждений: добавим недовыполнившего, у кого была W22-серия ──
# Bravo уже в W23, проверим что у него warn растёт (2 недели подряд провал).
with db.connection() as c:
    bw = c.execute("SELECT warning_count FROM valor_members m JOIN valor_snapshots s "
                   "ON m.snapshot_id=s.id WHERE s.week=? AND m.nick=?",
                   ("2026-W23", "Bravo")).fetchone()["warning_count"]
check("Bravo (2 недели провал) имеет warning_count>=2", bw >= 2)

# ── 6) Удаление строки (фантом OCR) ──
del_id = next(m["id"] for m in db.valor_compare_data("2026-W23")["members"]
              if m["nick"] == "MissedGuy")
dres = db.valor_delete_member(del_id)
check("delete: ok=True", dres.get("ok") is True)
after = {m["nick"] for m in db.valor_compare_data("2026-W23")["members"]}
check("после удаления MissedGuy исчез из compare", "MissedGuy" not in after)
check("после удаления MissedGuy исчез из таблицы Доблести",
      "MissedGuy" not in {m["nick"] for m in db.valor_get_current()["members"]})

# ── 7) Добавление без снимка / пустой ник ──
nores = db.valor_add_member("2026-W99", mk("Ghost", 1), ACTOR)
check("add в несуществующую неделю → reason=no_snapshot",
      nores.get("ok") is False and nores.get("reason") == "no_snapshot")
empty = db.valor_add_member("2026-W23", mk("", 1), ACTOR)
check("add без ника → reason=no_nick",
      empty.get("ok") is False and empty.get("reason") == "no_nick")

# ── 8) Состояния бейджа: реестр / постоянный-не-в-реестре (кейс ~АдаНет~) ──
# Alpha заносим в реестр → in_registry=True. Bravo есть в W22+W23 (стабильный,
# flag_new_nick=0), но НЕ в реестре → должен быть «в Доблести», НЕ «ИИ-ник».
db.create_acceptance(game_nick="Alpha", title="", accepted_date="2026-06-01",
                     note="", actor=ACTOR)
bcmp = {m["nick"]: m for m in db.valor_compare_data("2026-W23")["members"]}
check("Alpha в реестре → in_registry=True",
      bcmp.get("Alpha", {}).get("in_registry") is True)
check("Bravo постоянный, не в реестре → in_registry=False",
      bcmp.get("Bravo", {}).get("in_registry") is False)
check("Bravo НЕ помечен как новый (flag_new_nick falsy) → бейдж «в Доблести», не «ИИ-ник»",
      not bcmp.get("Bravo", {}).get("flag_new_nick"))
check("compare отдаёт флаг flag_new_nick для каждой строки (для бейджа)",
      all("flag_new_nick" in m for m in bcmp.values()))

# ── 9) Кадр (frame): сохранение в снимке + бэкфилл по canon ──
db.valor_save_snapshot(week="2026-W30", valor_norm=14, members=[
    {**mk("Frodo", 50), "frame": 0},
    {**mk("Sam", 20), "frame": 3},
    {**mk("Gandalf", 10)},  # без кадра
])
fcmp = {m["nick"]: m for m in db.valor_compare_data("2026-W30")["members"]}
check("frame сохранился из снимка (Frodo=0)", fcmp.get("Frodo", {}).get("frame") == 0)
check("frame сохранился из снимка (Sam=3)", fcmp.get("Sam", {}).get("frame") == 3)
check("без кадра → frame=None (Gandalf)", fcmp.get("Gandalf", {}).get("frame") is None)
# Бэкфилл кадров по нику без пересохранения снимка.
rf = db.valor_set_frames("2026-W30", [
    {"nick": "Frodo", "frame": 5}, {"nick": "Никонет", "frame": 9}])
check("set_frames: updated=1, missing=1", rf.get("updated") == 1 and rf.get("missing") == 1)
fcmp2 = {m["nick"]: m for m in db.valor_compare_data("2026-W30")["members"]}
check("frame обновлён бэкфиллом (Frodo=5)", fcmp2.get("Frodo", {}).get("frame") == 5)
check("Sam не тронут бэкфиллом (=3)", fcmp2.get("Sam", {}).get("frame") == 3)
check("set_frames в несуществующую неделю → no_snapshot",
      db.valor_set_frames("2026-W99", []).get("reason") == "no_snapshot")

# ── 10) Порядок compare = порядок снимка (как на скринах), без пересортировки ──
# Кейс Silhead/Silhair/Лирия: сборщик присылает ников в порядке чтения со
# скринов; compare обязан сохранить ИМЕННО его (по id), а не сортировать по
# алфавиту/кадру. Тёзки одной доблести идут как на экране.
db.valor_save_snapshot(week="2026-W31", valor_norm=14, members=[
    {**mk("Top", 90), "frame": 0},     # высшая доблесть — сверху на скрине
    {**mk("Bravo", 62), "frame": 0},   # на скрине ВЫШE Alpha (хоть алфавитно ниже)
    {**mk("Alpha", 62), "frame": 1},   # на скрине ниже Bravo
])
order = [m["nick"] for m in db.valor_compare_data("2026-W31")["members"]]
check("compare сохраняет порядок снимка как на скринах: Top, Bravo, Alpha",
      order == ["Top", "Bravo", "Alpha"])

# ── 11) Подтверждение «верно» + авто-снятие сомнения при правке класса ──
db.valor_save_snapshot(week="2026-W32", valor_norm=14, members=[
    {**mk("Suspekt", 30), "flag_ocr_suspect": True},
    {**mk("Suspekt2", 28), "flag_ocr_suspect": True},
])
c32 = {m["nick"]: m for m in db.valor_compare_data("2026-W32")["members"]}
check("снимок сохранил flag_ocr_suspect", c32["Suspekt"]["flag_ocr_suspect"] is True)
# verify снимает оба флага сомнения
db.valor_verify_member(c32["Suspekt"]["id"], ACTOR)
c32b = {m["nick"]: m for m in db.valor_compare_data("2026-W32")["members"]}
check("verify снял flag_ocr_suspect", c32b["Suspekt"]["flag_ocr_suspect"] is False)
check("verify снял flag_new_nick", c32b["Suspekt"]["flag_new_nick"] is False)
# правка класса снимает flag_ocr_suspect автоматически
db.valor_update_member(c32["Suspekt2"]["id"], {"class": "Маг"}, ACTOR)
c32c = {m["nick"]: m for m in db.valor_compare_data("2026-W32")["members"]}
check("правка класса сняла flag_ocr_suspect", c32c["Suspekt2"]["flag_ocr_suspect"] is False)
check("verify несуществующего → not_found",
      db.valor_verify_member(999999, ACTOR).get("reason") == "not_found")

# ── 12) Ник в реестре → нет сомнения по нику (flag_new_nick подавлён) ──
# Кейс ЮКО: ник пометился новым ДО внесения в реестр; теперь он в реестре,
# написание авторитетно — сомнений быть не должно, даже если флаг «устарел».
db.create_acceptance(game_nick="RegNew", title="", accepted_date="2026-06-01",
                     note="", actor=ACTOR)
db.valor_save_snapshot(week="2026-W33", valor_norm=14, members=[
    {**mk("RegNew", 40), "flag_new_nick": True},   # стора флаг «новый», но в реестре
])
c33 = {m["nick"]: m for m in db.valor_compare_data("2026-W33")["members"]}
check("ник в реестре → in_registry True", c33["RegNew"]["in_registry"] is True)
check("ник в реестре → flag_new_nick подавлён (нет сомнения по нику)",
      c33["RegNew"]["flag_new_nick"] is False)
# И на странице Доблести: 🤖 (ai_nick) тоже подавлён для реестровых.
with db.connection() as conn:
    conn.execute(
        "INSERT OR IGNORE INTO valor_first_seen "
        "(nick_canon, first_nick, first_week, first_date, verified) VALUES (?,?,?,?,0)",
        (db._valor_canon("RegNew"), "RegNew", "2026-W33", "2026-06-01"))
rn = next((m for m in db.valor_get_current()["members"] if m["nick"] == "RegNew"), None)
check("в реестре + first_seen verified=0 → ai_nick False (страница Доблести)",
      rn is not None and rn["ai_nick"] is False)

# ── 13) Реестр — эталон написания: ник переписывается из реестра ──
# Кейс «Ананасик`»: в реестре с `, а OCR прочитал без `. canon совпадает
# (`, пробелы, гомоглифы срезаются), но показывать надо написание из реестра.
db.create_acceptance(game_nick="Ананасик`", title="", accepted_date="2026-06-02",
                     note="", actor=ACTOR)
db.valor_save_snapshot(week="2026-W36", valor_norm=14, members=[{**mk("Ананасик", 45)}])
acanon = db._valor_canon("Ананасик")
mm = next((m for m in db.valor_compare_data("2026-W36")["members"]
           if m["nick_canon"] == acanon), None)
check("compare: ник переписан из реестра (Ананасик`)", mm and mm["nick"] == "Ананасик`")
am = next((m for m in db.valor_get_current()["members"]
           if m["nick_canon"] == acanon), None)
check("Доблесть: ник из реестра (Ананасик`)", am and am["nick"] == "Ананасик`")

# ── 14) Сомнение спадает ТОЛЬКО при правке нужного поля ──
db.valor_save_snapshot(week="2026-W37", valor_norm=14, members=[
    {**mk("KeepSusp", 25), "class_": "Маг", "flag_ocr_suspect": True},
    {**mk("NewbieY", 20)},   # новичок → flag_new_nick=1, не в реестре
])
w37 = {m["nick"]: m for m in db.valor_compare_data("2026-W37")["members"]}
ks_id = w37["KeepSusp"]["id"]
ny_id = w37["NewbieY"]["id"]
# Правим ДРУГОЕ поле (класс не меняется «Маг»→«Маг», меняем доблесть):
db.valor_update_member(ks_id, {"class": "Маг", "valor": 30}, ACTOR)
w37b = {m["nick"]: m for m in db.valor_compare_data("2026-W37")["members"]}
check("правка другого поля (класс не менялся) НЕ снимает сомнение по классу",
      w37b["KeepSusp"]["flag_ocr_suspect"] is True)
# Реальная смена класса — снимает:
db.valor_update_member(ks_id, {"class": "Воин"}, ACTOR)
w37c = {m["nick"]: m for m in db.valor_compare_data("2026-W37")["members"]}
check("реальная смена класса снимает сомнение по классу",
      w37c["KeepSusp"]["flag_ocr_suspect"] is False)
# Ник: правка другого поля (ник тот же) НЕ снимает сомнение по нику:
db.valor_update_member(ny_id, {"nick": "NewbieY", "valor": 22}, ACTOR)
w37d = {m["nick"]: m for m in db.valor_compare_data("2026-W37")["members"]}
check("правка другого поля (ник тот же) НЕ снимает сомнение по нику",
      w37d.get("NewbieY", {}).get("flag_new_nick") is True)
# Реальная смена ника — снимает:
db.valor_update_member(ny_id, {"nick": "NewbieZ"}, ACTOR)
w37e = {m["nick"]: m for m in db.valor_compare_data("2026-W37")["members"]}
check("реальная смена ника снимает сомнение по нику",
      w37e.get("NewbieZ", {}).get("flag_new_nick") is False)

# ── 15) Класс из истории: пустой/сомнительный класс берём из прошлого сбора ──
db.valor_save_snapshot(week="2026-W40", valor_norm=14, members=[
    {**mk("Magix", 50), "class_": "Маг"},     # класс известен в прошлом сборе
    {**mk("Doubter", 48), "class_": "Маг"},
])
db.valor_save_snapshot(week="2026-W41", valor_norm=14, members=[
    {**mk("Magix", 55)},                                              # класс пустой
    {**mk("Doubter", 47), "class_": "Mar", "flag_ocr_suspect": True}, # сомнительный, история есть
    {**mk("Warry", 40), "class_": "Воен", "flag_ocr_suspect": True},  # сомнительный, истории НЕТ
])
pre = {m["nick"]: m for m in db.valor_compare_data("2026-W41")["members"]}
check("до заполнения: класс Magix пустой", (pre["Magix"]["class"] or "") == "")
db.valor_fill_class_from_history("2026-W41")
post = {m["nick"]: m for m in db.valor_compare_data("2026-W41")["members"]}
check("пустой класс заполнен из прошлого сбора (Magix → Маг)",
      post["Magix"]["class"] == "Маг")
check("сомнительный класс взят из истории (Doubter Mar → Маг) + сомнение снято",
      post["Doubter"]["class"] == "Маг" and post["Doubter"]["flag_ocr_suspect"] is False)
check("нет истории класса → не трогаем, сомнение остаётся (Warry)",
      post["Warry"]["flag_ocr_suspect"] is True and post["Warry"]["class"] == "Воен")

# ── 16) actual_members (реально людей в клане) + правка меты снимка ──
db.valor_save_snapshot(week="2026-W50", valor_norm=14, actual_members=200,
                       members=[mk("AAx", 10), mk("BBx", 5)])
sess = {s["week"]: s for s in db.valor_list_sessions()}
check("снимок хранит actual_members (реально в клане)",
      sess["2026-W50"].get("actual_members") == 200)
check("members_count = распознано Gemini (2)",
      sess["2026-W50"].get("members_count") == 2)
cmpW50 = db.valor_compare_data("2026-W50")
check("compare отдаёт snapshot.actual_members",
      cmpW50["snapshot"].get("actual_members") == 200)
rm = db.valor_update_snapshot_meta("2026-W50", {"actual_members": 198})
check("правка меты обновила actual_members (200→198)",
      rm.get("ok") and db.valor_compare_data("2026-W50")["snapshot"]["actual_members"] == 198)
check("правка меты несущ. недели → no_snapshot",
      db.valor_update_snapshot_meta("2026-W99", {"actual_members": 1}).get("reason") == "no_snapshot")

# ── 17) Сглаживание выбросов кадров (median-3 + интерполяция null) ──
db.valor_save_snapshot(week="2026-W60", valor_norm=14, members=[
    {**mk("Fa", 90), "frame": 5},
    {**mk("Fb", 80), "frame": 5},
    {**mk("Fc", 70), "frame": 35},   # выброс — соседи 5 и 6
    {**mk("Fd", 60), "frame": 6},
    {**mk("Fe", 50)},                # null → интерполяция
    {**mk("Ff", 40), "frame": 7},
])
db.valor_smooth_frames("2026-W60")
fr = {m["nick"]: m["frame"] for m in db.valor_compare_data("2026-W60")["members"]}
check("выброс кадра сглажен (Fc: 35→6 по медиане)", fr["Fc"] == 6)
check("пустой кадр заполнен интерполяцией (Fe в 6..7)",
      isinstance(fr["Fe"], int) and 6 <= fr["Fe"] <= 7)
check("монотонные кадры не тронуты (Fa=5, Fb=5)", fr["Fa"] == 5 and fr["Fb"] == 5)
check("smooth несущ. недели → no_snapshot",
      db.valor_smooth_frames("2026-W99").get("reason") == "no_snapshot")

# ── 18) Снятие (прощение) титульных и авто (норматив) предупреждений ──
# Титул: цифра в титуле → title_warn (не зависит от иммунитета).
db.valor_save_snapshot(week="2026-W72", valor_norm=14,
                       members=[{**mk("Titled", 50, title="3")}])
tc = next((m for m in db.valor_get_current()["members"] if m["nick"] == "Titled"), None)
check("есть титульное предупреждение (title_warn=3)", tc and tc["title_warn"] == 3)
db.valor_dismiss_warnings(tc["nick_canon"], "title", ACTOR)
tc2 = next((m for m in db.valor_get_current()["members"] if m["nick"] == "Titled"), None)
check("после dismiss title — предупреждение снято", tc2 and tc2["title_warn"] is None)
db.valor_restore_warnings(tc["nick_canon"], ACTOR)
tc3 = next((m for m in db.valor_get_current()["members"] if m["nick"] == "Titled"), None)
check("после restore — титульное вернулось (3)", tc3 and tc3["title_warn"] == 3)
# Норматив: берём любого, у кого реально есть авто-предупреждение в тест-данных.
aw = db.valor_active_warnings()
if aw:
    cn0 = next(iter(aw)); before_n = len(aw[cn0])
    db.valor_dismiss_warnings(cn0, "norm", ACTOR)
    check("dismiss norm убрал авто-предупреждения",
          len(db.valor_active_warnings().get(cn0, [])) == 0)
    db.valor_restore_warnings(cn0, ACTOR)
    check("restore вернул авто-предупреждения по нормативу",
          len(db.valor_active_warnings().get(cn0, [])) == before_n)
else:
    check("(в тест-данных нет авто-предупреждений — норм-кейс пропущен)", True)

# ── 19) История прощённых предупреждений (детали + счётчик) ──
db.valor_save_snapshot(week="2026-W73", valor_norm=14,
                       members=[{**mk("Histo", 50, title="5")}])
hc = next(m for m in db.valor_get_current()["members"] if m["nick"] == "Histo")
db.valor_dismiss_warnings(hc["nick_canon"], "title", ACTOR,
                          reason="был в отпуске, предупредил заранее")
hist = db.valor_dismissed_history(hc["nick_canon"])
check("история прощений: 1 запись", len(hist) == 1)
check("история: тип title + кто простил + деталь с цифрой 5",
      hist and hist[0]["kind"] == "title" and hist[0]["created_by"] == "Тест"
      and hist[0]["detail"].get("value") == 5)
check("история: сохранён комментарий-причина прощения",
      hist[0]["reason"] == "был в отпуске, предупредил заранее")
hc2 = next(m for m in db.valor_get_current()["members"] if m["nick"] == "Histo")
check("dismissed_count=1 у члена (для кнопки истории)", hc2.get("dismissed_count") == 1)
db.valor_restore_warnings(hc["nick_canon"], ACTOR)
check("после restore история пуста",
      len(db.valor_dismissed_history(hc["nick_canon"])) == 0)

# ── 20) Журнал правок Архива скринов + отмена (поштучно и пакетом) ──
db.valor_save_snapshot(week="2026-W80", valor_norm=14,
                       members=[{**mk("LogA", 30), "class_": "Маг"}])
la = next(m for m in db.valor_compare_data("2026-W80")["members"] if m["nick"] == "LogA")
db.valor_update_member(la["id"], {"class": "Воин"}, ACTOR)
db.valor_update_member(la["id"], {"valor": 99}, ACTOR)
log = db.valor_edit_log_for("2026-W80")
check("журнал: >=2 записи edit", sum(1 for e in log if e["action"] == "edit") >= 2)
check("журнал: записан автор (Тест) и before/after",
      log[0]["actor_name"] == "Тест" and log[0]["before"] is not None
      and log[0]["after"] is not None)
# отмена последней правки (valor 99 → 30)
db.valor_undo_edit(log[0]["id"], ACTOR)
c = next(m for m in db.valor_compare_data("2026-W80")["members"] if m["nick"] == "LogA")
check("отмена правки valor вернула 30", c["valor"] == 30)
check("класс при этом остался Воин (не трогали)", c["class"] == "Воин")
# add + отмена
db.valor_add_member("2026-W80", mk("LogB", 20), ACTOR)
addlog = next(e for e in db.valor_edit_log_for("2026-W80") if e["action"] == "add")
db.valor_undo_edit(addlog["id"], ACTOR)
check("отмена add убрала LogB",
      not any(m["nick"] == "LogB" for m in db.valor_compare_data("2026-W80")["members"]))
# delete + отмена (строка возвращается)
db.valor_delete_member(la["id"], ACTOR)
check("LogA удалён",
      not any(m["nick"] == "LogA" for m in db.valor_compare_data("2026-W80")["members"]))
dellog = next(e for e in db.valor_edit_log_for("2026-W80") if e["action"] == "delete")
db.valor_undo_edit(dellog["id"], ACTOR)
check("отмена delete вернула LogA",
      any(m["nick"] == "LogA" for m in db.valor_compare_data("2026-W80")["members"]))
# отмена ВСЕХ правок автора за неделю
ub = db.valor_undo_by_actor("2026-W80", "Тест", ACTOR)
check("undo-by-actor: ok", ub.get("ok"))
check("после undo-by-actor у «Тест» нет активных правок",
      not any(a["actor_name"] == "Тест" for a in db.valor_edit_log_actors("2026-W80")))
caf = next(m for m in db.valor_compare_data("2026-W80")["members"] if m["nick"] == "LogA")
check("после отмены всех правок класс вернулся к Маг", caf["class"] == "Маг")

print("\n=== ИТОГО:", "ВСЁ ОК" if ok else "ЕСТЬ ПРОВАЛЫ", "===")
os.remove(os.environ["DB_PATH"])
sys.exit(0 if ok else 1)
