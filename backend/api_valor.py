"""Endpoint'ы для pw-valor-tracker.

POST /valor/snapshot — приём недельного снимка от десктоп-приложения
                       (auth: bot-token, тот же что у clan-bridge-bot и
                       clan-reg-bot)
GET  /valor/current  — самый свежий снимок (для UI «Доблесть»)
GET  /valor/sessions — список всех снимков (для «Архив доблести»)
GET  /valor/history  — история по нику (rank/title/level/class)
GET  /valor/timeline — timeline доблести по неделям (тренды)
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

import db
from api_chat import require_bot_token, require_officer, require_viewer
from session import require_admin, current_actor

log = logging.getLogger("api.valor")
router = APIRouter(prefix="/valor", tags=["valor"])


# ── Pydantic ────────────────────────────────────────────────────────────
class ValorMemberIn(BaseModel):
    nick:             str
    true_name:        str | None = ""
    rank:             str | None = ""
    title:            str | None = ""
    level:            int | None = None
    class_:           str | None = Field(default="", alias="class")
    valor:            int | None = None
    is_afk:           bool | None = False
    norm_met:         bool | None = None
    flag_new_nick:    bool | None = False
    flag_ocr_suspect: bool | None = False
    frame:            int | None = None   # номер кадра (idx), где распознан ник

    class Config:
        populate_by_name = True


class ValorSnapshotIn(BaseModel):
    week:           str   # 2026-W22
    valor_norm:     int
    screens_count:  int = 0
    notes:          str = ""
    actual_members: int | None = None   # реально людей в клане на момент сбора
    members:        list[ValorMemberIn]
    grid:           dict | None = None   # сетка колонок/строк с десктопа (доли):
    #                                      {x,y,w,h,rh,cols:[{x,key}]} → калибровка недели


# ── Endpoints ───────────────────────────────────────────────────────────
@router.post("/snapshot")
def valor_snapshot(payload: ValorSnapshotIn,
                   _=Depends(require_bot_token)) -> dict:
    """Сохраняет недельный снапшот. Если на эту неделю уже был — REPLACE.
    История полей (rank/title/level/class) дописывается только при смене
    значения относительно предыдущего снимка.
    """
    members = []
    for m in payload.members:
        d = m.model_dump(by_alias=False)
        # FastAPI кладёт class_ как ключ — db.py его так и хочет.
        members.append(d)
    res = db.valor_save_snapshot(
        week=payload.week,
        valor_norm=payload.valor_norm,
        members=members,
        screens_count=payload.screens_count,
        notes=payload.notes,
        actual_members=payload.actual_members,
    )
    # Точная сетка колонок/строк с десктопа → калибровка недели (frame=-1).
    # Строки/столбцы источника в «Скринах» лягут по реальной калибровке сбора,
    # а не по оценке. off не шлём — перекрытие сайт считает из данных (autoOverlap).
    if payload.grid and payload.grid.get("cols"):
        try:
            db.valor_calib_set(payload.week, -1, payload.grid)
            res["grid_saved"] = True
        except Exception as e:
            log.warning("grid calib save failed: %s", e)
    # АВТО-снятие ложных «ИИ-ник» (flag_new_nick) у игроков, уже известных сайту
    # (история Доблести др. недель ∪ реестр приёма ∪ архив ушедших). Раньше это
    # была ручная кнопка «Авто-проверка» — теперь известные ники (напр. Лисси!)
    # исправляются САМИ при загрузке снимка, а не висят «требуют проверки».
    try:
        av = db.valor_auto_verify(payload.week)
        res["auto_verified"] = av.get("cleared", 0)
    except Exception as e:
        log.warning("auto-verify on snapshot failed: %s", e)
    # Класс не меняется — пустой/сомнительный класс заполняем из прошлых сборов
    # и снимаем сомнение. Делается ПОСЛЕ коммита снапшота (отдельная транзакция).
    try:
        cf = db.valor_fill_class_from_history(payload.week)
        res["class_filled"] = cf.get("filled", 0)
        res["class_cleared"] = cf.get("cleared", 0)
        # Сгладить выбросы номеров кадров (кадр не убывает по списку).
        res["frames_fixed"] = db.valor_smooth_frames(payload.week).get("fixed", 0)
    except Exception as e:
        log.warning("class fill from history failed: %s", e)
    log.info("valor snapshot saved: week=%s members=%d history_added=%d",
             payload.week, res["members"], res["history_added"])
    return res


@router.get("/current")
def valor_current(s: dict = Depends(require_viewer)) -> dict:
    """Самый свежий снимок + все участники. Примечание из реестра (reg_note)
    и данные VK/Telegram (socials) — только офицерам/админу, гость их не
    получает (ни в UI, ни в ответе API)."""
    is_officer = s.get("role") in ("officer", "admin")
    # Авто-снятие АФК с истёкшим сроком — ТОЛЬКО на привилегированном чтении
    # (гость не должен инициировать запись в БД). Плюс ежедневно в планировщике.
    if is_officer:
        try:
            db.valor_expire_afk()
        except Exception as e:
            log.warning("afk expire failed: %s", e)
    return db.valor_get_current(with_reg_notes=is_officer,
                                with_socials=is_officer)


@router.get("/known-nicks")
def known_nicks(_=Depends(require_bot_token)) -> dict:
    """Список известных ников клана (снимки доблести + override + активный
    реестр/новенькие) — десктоп-сборщик шлёт его в Gemini как подсказку,
    чтобы правильно распознавать и писать ники."""
    return {"nicks": db.valor_known_nicks()}


# ── Архив скриншотов сбора (по неделям) ──
class ScreenshotsIn(BaseModel):
    week:  str
    shots: list[dict]   # [{idx, url, key}]


@router.post("/screenshots")
def valor_screenshots_save(payload: ScreenshotsIn,
                           _=Depends(require_bot_token)) -> dict:
    """Сохранить ссылки на скрины недели (заливает pw-valor-tracker в R2)."""
    return db.valor_screenshots_set(payload.week, payload.shots)


# ── Триггер авто-публикации топа кнопкой «Готово» ──
@router.post("/request-publish")
def valor_request_publish_ep(actor: dict = Depends(require_officer)) -> dict:
    """Кнопка «Готово — обновить доблесть»: заявка на публикацию топа + начисление
    жетонов ТОП-3 по доблести. Локальный поллер через 5 минут опубликует пост во все
    соцсети. Жетоны ТОП-3 начисляются здесь ИДЕМПОТЕНТНО (за неделю — один раз), чтобы
    они гарантированно выдавались при обновлении доблести, а не только при финализации
    очереди."""
    week = db.valor_latest_week()
    if not week:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no_snapshot")
    res = db.valor_request_publish(week)
    # ТОП-3 доблести → +1 жетон суперспособности (идемпотентно за неделю). Ошибку тут
    # не превращаем в отказ публикации — публикация важнее, жетоны довыдаст финализация.
    try:
        import api_queue
        with db.connection() as conn:
            gt = api_queue.grant_top3_valor_tokens(
                conn, week=week,
                actor_name=(actor.get("name") or actor.get("role") or "офицер"))
        res["top3_tokens"] = gt.get("granted", [])
        res["top3_tokens_already"] = gt.get("already", False)
    except Exception as e:
        res["top3_tokens_error"] = str(e)
    return res


@router.get("/publish-request")
def valor_publish_request_get(_=Depends(require_bot_token)) -> dict:
    """Статус заявки на публикацию (для локального поллера weekly_top)."""
    return db.valor_get_publish_request()


class PublishDoneIn(BaseModel):
    week: str


@router.post("/publish-done")
def valor_publish_done_ep(payload: PublishDoneIn,
                          _=Depends(require_bot_token)) -> dict:
    """Поллер отметил, что топ за неделю опубликован (чтобы не постить дважды)."""
    return db.valor_mark_published(payload.week)


class FramesIn(BaseModel):
    week:   str
    frames: list[dict]   # [{nick, frame}]


@router.post("/frames")
def valor_frames_set(payload: FramesIn,
                     _=Depends(require_bot_token)) -> dict:
    """Проставить номер кадра (idx скрина) каждому нику недели — для точной
    подсветки скрина при клике. Бэкфилл/обновление без пересохранения снимка."""
    return db.valor_set_frames(payload.week, payload.frames)


@router.get("/screenshots/weeks")
def valor_screenshot_weeks(_: dict = Depends(require_officer)) -> list[dict]:
    """Список недель со скринами (папки) — офицеру/админу."""
    return db.valor_screenshot_weeks()


@router.get("/screenshots")
def valor_screenshots_list(week: str = Query(..., min_length=1),
                           _: dict = Depends(require_officer)) -> dict:
    """Скрины конкретной недели — офицеру/админу."""
    return {"week": week, "shots": db.valor_screenshots_for(week)}


@router.get("/compare")
def valor_compare(week: str = Query(..., min_length=1),
                  _: dict = Depends(require_officer)) -> dict:
    """Сравнение скринов недели с распознанными данными (офицеру/админу)."""
    return db.valor_compare_data(week)


class CalibIn(BaseModel):
    """Ручная калибровка раскладки строк кадра (доли 0..1).
    frame=-1 — дефолт на все кадры недели; rect=None — удалить калибровку."""
    week:  str = Field(..., min_length=1)
    frame: int = -1
    rect:  dict | None = None


@router.post("/calib")
def valor_calib_post(payload: CalibIn,
                     _: dict = Depends(require_admin)) -> dict:
    """Задать/сбросить ручную калибровку строк на кадре (ТОЛЬКО админ). Для
    старых сборов, где десктоп ещё не присылал координаты строк."""
    res = db.valor_calib_set(payload.week, payload.frame, payload.rect)
    if not res.get("ok"):
        reason = res.get("reason", "failed")
        code = (status.HTTP_404_NOT_FOUND if reason == "no_snapshot"
                else status.HTTP_400_BAD_REQUEST)
        raise HTTPException(code, reason)
    return res


@router.delete("/calib")
def valor_calib_delete(week: str = Query(..., min_length=1),
                       _: dict = Depends(require_admin)) -> dict:
    """Сбросить всю калибровку строк недели (ТОЛЬКО админ)."""
    res = db.valor_calib_clear(week)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "failed"))
    return res


class CalibAutoIn(BaseModel):
    week: str = Field(..., min_length=1)


@router.post("/calib/auto")
def valor_calib_auto(payload: CalibAutoIn,
                     _: dict = Depends(require_admin)) -> dict:
    """Авто-разметка сетки строк/колонок по скрину недели (БЕЗ AI, классическое
    image-processing). Возвращает предложенную калибровку — админ проверяет/правит.
    ТОЛЬКО админ."""
    import urllib.request
    import calib_detect
    url = db.valor_first_screenshot_url(payload.week)
    if not url:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no_screenshots")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "calib-detect"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except Exception as e:
        log.warning("auto-calib download failed: %s", e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "download_failed")
    try:
        res = calib_detect.detect_from_bytes(data)
    except Exception as e:
        log.warning("auto-calib detect error: %s", e)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "detect_error")
    if not res:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "detect_failed")
    return {"calib": res}


@router.get("/sessions")
def valor_sessions(_: dict = Depends(require_officer)) -> list[dict]:
    """Все снапшоты — для «Архив доблести»."""
    return db.valor_list_sessions()


@router.get("/missing-weeks")
def valor_missing_weeks(_: dict = Depends(require_officer)) -> list[dict]:
    """Недели без снимка (кандидаты на пометку «не собрано»)."""
    return db.valor_missing_weeks()


class SkipWeekIn(BaseModel):
    week: str
    skipped: bool = True
    norm: int | None = Field(default=None, ge=0)


@router.post("/skip-week")
def valor_skip_week(payload: SkipWeekIn,
                    actor: dict = Depends(require_officer)) -> dict:
    """Пометить неделю как «данные не собирались» (или снять пометку)."""
    res = db.valor_skip_week(payload.week, skipped=payload.skipped,
                             norm=payload.norm, actor=actor)
    if not res.get("ok"):
        reason = res.get("reason", "failed")
        code = (status.HTTP_404_NOT_FOUND if reason == "no_snapshot"
                else status.HTTP_400_BAD_REQUEST)
        raise HTTPException(code, reason)
    return res


@router.get("/departed")
def valor_departed(_: dict = Depends(require_viewer)) -> list[dict]:
    """Ушедшие из клана с последними известными данными."""
    return db.valor_get_departed()


@router.get("/global-search")
def valor_global_search(q: str = Query(..., min_length=2),
                        _: dict = Depends(require_officer)) -> dict:
    """Единый поиск по всем разделам сайта: реестр, Доблесть (сейчас/был),
    архив «Покинули клан», кики, чаты, роли. Показывает, есть ли человек на
    сайте вообще и в каких разделах он сейчас."""
    return {"results": db.global_search(q)}


@router.get("/departed-check")
def valor_departed_check(nick: str = Query(..., min_length=1),
                         _: dict = Depends(require_officer)) -> dict:
    """Проверка вводимого в реестр ника: есть ли он в архиве «Покинули клан»
    / среди кикнутых (с причиной). Офицеру/админу — предупреждение при приёме."""
    return {"matches": db.valor_departed_match(nick)}


class ReturnFromArchiveIn(BaseModel):
    game_nick:     str = Field(..., min_length=1)
    title:         str = ""
    note:          str = ""
    accepted_date: str = Field(..., min_length=1)   # 'YYYY-MM-DD'
    veteran:       bool = False
    elite:         bool = False


@router.post("/return-from-archive")
def valor_return_from_archive(payload: ReturnFromArchiveIn,
                              _: dict = Depends(require_officer),
                              actor: dict = Depends(current_actor)) -> dict:
    """Повторный приём из архива (офицер/админ) одним действием: регистрирует в
    реестре (свежий недельный иммун новичка), возвращает из архива доблести и
    убирает ВСЕ предупреждения (чистый лист)."""
    return db.valor_return_from_archive(
        game_nick=payload.game_nick, title=payload.title, note=payload.note,
        accepted_date=payload.accepted_date, veteran=payload.veteran,
        elite=payload.elite, actor=actor)


@router.get("/by-canon")
def valor_by_canon(weeks: int = Query(default=0, ge=0, le=52),
                   _: dict = Depends(require_officer)) -> dict:
    """Map canon_nick → доблесть для совмещения с chat-активностью.
    weeks=0 — по всем неделям. >0 — последние N недель."""
    return db.valor_by_canon_map(weeks=weeks)


class TagsBulkIn(BaseModel):
    tag:    str = Field(..., min_length=1, max_length=32)
    nicks:  list[str]
    source: str = "manual"


class TagOne(BaseModel):
    nick: str
    tag:  str


@router.post("/tags/bulk")
def valor_tags_bulk(payload: TagsBulkIn,
                    _=Depends(require_bot_token)) -> dict:
    """Помечает множество ников одним тегом. Используется для разового
    заливки «ветеранов» из clan-checklist. Auth — bot-token (тот же
    что у других ботов клана)."""
    return db.valor_add_tags(payload.tag, payload.nicks, payload.source)


@router.post("/tags")
def valor_tag_one(payload: TagOne,
                  _: dict = Depends(require_officer)) -> dict:
    """Добавить один тег одному нику."""
    return db.valor_add_tags(payload.tag, [payload.nick], source="manual")


@router.delete("/tags")
def valor_tag_delete(nick: str = Query(..., min_length=1),
                     tag: str = Query(..., min_length=1),
                     _: dict = Depends(require_officer)) -> dict:
    """Удалить тег с ника."""
    ok = db.valor_remove_tag(nick, tag)
    return {"ok": ok}


class ManualWarnIn(BaseModel):
    nick:     str
    severity: str = "mid"   # ok|mid|low|bad|crit
    reason:   str = ""


@router.post("/warning")
def valor_warning_add(payload: ManualWarnIn,
                      _: dict = Depends(require_officer),
                      actor: dict = Depends(current_actor)) -> dict:
    """Добавить предупреждение (офицер/админ). Пишется в журнал действий."""
    return db.valor_add_manual_warning(
        payload.nick, payload.severity, payload.reason, actor)


@router.delete("/warning")
def valor_warning_delete(id: int = Query(..., ge=1),
                         _: dict = Depends(require_officer),
                         actor: dict = Depends(current_actor)) -> dict:
    """Удалить предупреждение (офицер/админ). Пишется в журнал действий."""
    return {"ok": db.valor_remove_manual_warning(id, actor)}


class WarnDismissIn(BaseModel):
    canon:  str = Field(..., min_length=1)
    kind:   str   # norm | title
    reason: str = ""   # комментарий: почему простили
    ref:    str | None = None  # норматив: конкретная неделя (снять по одной); None = все


class WarnCanonIn(BaseModel):
    canon: str = Field(..., min_length=1)


@router.post("/warning/dismiss")
def valor_warning_dismiss(payload: WarnDismissIn,
                          _: dict = Depends(require_officer),
                          actor: dict = Depends(current_actor)) -> dict:
    """«Простить» вычисляемое предупреждение: норматив (конкретная неделя ref
    или все текущие) либо титул (текущая цифра). Офицер/админ."""
    res = db.valor_dismiss_warnings(payload.canon, payload.kind, actor,
                                    payload.reason, ref=payload.ref)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("reason", "failed"))
    return res


@router.post("/warning/restore")
def valor_warning_restore(payload: WarnCanonIn,
                          _: dict = Depends(require_officer),
                          actor: dict = Depends(current_actor)) -> dict:
    """Вернуть прощённые предупреждения (норматив+титул) для канона."""
    return db.valor_restore_warnings(payload.canon, actor)


@router.get("/warning/dismissed")
def valor_warning_dismissed(canon: str = Query(..., min_length=1),
                            _: dict = Depends(require_officer)) -> dict:
    """История прощённых предупреждений игрока (кто/когда/тип/что было)."""
    return {"canon": canon, "items": db.valor_dismissed_history(canon)}


class ValorAfkIn(BaseModel):
    is_afk:    bool
    afk_note:  str | None = None
    afk_until: str | None = None   # 'YYYY-MM-DD' — срок, после которого АФК снимется сам


@router.post("/afk/{member_id}")
def valor_afk_set(member_id: int, payload: ValorAfkIn,
                  _: dict = Depends(require_officer),
                  actor: dict = Depends(current_actor)) -> dict:
    """Дать/снять статус АФК + комментарий + СРОК (офицер/админ). Лог действий.
    afk_until — дата, после которой статус АФК снимется автоматически."""
    res = db.valor_set_afk(member_id, payload.is_afk, payload.afk_note, actor,
                           afk_until=payload.afk_until)
    if res is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member_not_found")
    return res


class ValorManualImmunityIn(BaseModel):
    nick:   str = Field(..., min_length=1)
    week:   str | None = None       # 'YYYY-Wnn'; пусто → текущая ISO-неделя
    reason: str | None = None
    on:     bool = True             # True — дать, False — снять


@router.post("/manual-immunity")
def valor_manual_immunity(payload: ValorManualImmunityIn,
                          _: dict = Depends(require_officer),
                          actor: dict = Depends(current_actor)) -> dict:
    """Дать/снять РУЧНОЙ иммунитет на неделю (офицер/админ) + причина.
    Освобождает от нормы на эту неделю (как иммунитет новичка). Пустая week →
    текущая ISO-неделя (та, что играется сейчас)."""
    week = (payload.week or "").strip()
    if not week:
        import datetime as _dt
        y, w, _wd = _dt.datetime.utcnow().isocalendar()
        week = f"{y}-W{w:02d}"
    if payload.on:
        return db.valor_manual_immunity_set(payload.nick, week, payload.reason or "", actor)
    return db.valor_manual_immunity_remove(payload.nick, week, actor)


# ── Примечания-«свиток» (история заметок о человеке) ──────────────────────
class ValorNoteIn(BaseModel):
    canon: str = Field(..., min_length=1)   # nick_canon участника
    text:  str = Field(..., min_length=1, max_length=2000)


@router.get("/notes")
def valor_notes_get(canon: str = Query(..., min_length=1),
                    _: dict = Depends(require_officer)) -> dict:
    """История примечаний о человеке (офицер/админ). Ленивый seed из реестра."""
    return db.valor_note_history(canon)


@router.post("/notes")
def valor_notes_add(payload: ValorNoteIn,
                    _: dict = Depends(require_officer),
                    actor: dict = Depends(current_actor)) -> dict:
    """Добавить примечание в «свиток» (офицер/админ). Синхронизируется с
    примечанием реестра (последняя версия). Возвращает историю целиком."""
    res = db.valor_note_add(payload.canon, payload.text, actor)
    if res is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "empty_note_or_canon")
    return res


@router.delete("/notes/{entry_id}")
def valor_notes_delete(entry_id: int,
                       canon: str = Query(..., min_length=1),
                       _: dict = Depends(require_admin)) -> dict:
    """Удалить одну запись «свитка» (только админ — правка ошибок).
    Реестр пересинхронизируется на новую последнюю запись."""
    res = db.valor_note_delete(entry_id, canon)
    if res is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "note_not_found")
    return res


class ValorMemberEdit(BaseModel):
    """Админ-правка строки доблести. Любое подмножество полей."""
    nick:      str | None = None
    true_name: str | None = None
    rank:      str | None = None
    title:     str | None = None
    level:     int | None = None
    class_:    str | None = Field(default=None, alias="class")
    valor:     int | None = None
    is_afk:    bool | None = None
    afk_note:  str | None = None

    class Config:
        populate_by_name = True


class ValorMemberAdd(BaseModel):
    """Админ-добавление пропущенной строки (OCR не распознал игрока)."""
    week:      str | None = None   # пусто → последний снимок
    nick:      str = Field(..., min_length=1)
    true_name: str | None = ""
    rank:      str | None = ""
    title:     str | None = ""
    level:     int | None = None
    class_:    str | None = Field(default="", alias="class")
    valor:     int | None = None
    is_afk:    bool | None = False
    after_id:  int | None = None   # вставить ПОСЛЕ этой строки (иначе — в конец)
    frame:     int | None = None   # кадр (idx скрина); пусто → возьмём у соседа
    break_alias: bool | None = False  # разорвать авто-связь ников (другой игрок)

    class Config:
        populate_by_name = True


@router.post("/member")
def valor_member_add(payload: ValorMemberAdd,
                     actor: dict = Depends(require_admin)) -> dict:
    """Добавить пропущенную строку в снимок недели (ТОЛЬКО админ).
    Дубликат по canon в этом снимке → 409."""
    fields = payload.model_dump(by_alias=True)
    week = fields.pop("week", None)
    res = db.valor_add_member(week, fields, actor)
    if not res.get("ok"):
        reason = res.get("reason", "add_failed")
        if reason == "exists":
            # detail — объект: фронт покажет конфликтную строку и даст её исправить.
            raise HTTPException(status.HTTP_409_CONFLICT,
                                detail={"reason": "exists",
                                        "conflict": res.get("conflict")})
        code = (status.HTTP_404_NOT_FOUND if reason == "no_snapshot"
                else status.HTTP_400_BAD_REQUEST)
        raise HTTPException(code, reason)
    return res


@router.patch("/member/{member_id}")
def valor_member_edit(member_id: int, payload: ValorMemberEdit,
                      actor: dict = Depends(require_admin)) -> dict:
    """Редактирование строки доблести (написание ника и любые данные).
    ТОЛЬКО админ. Коррекция ника держится между неделями (override по canon)."""
    fields = payload.model_dump(by_alias=True, exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing_to_update")
    out = db.valor_update_member(member_id, fields, actor)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member_not_found")
    return out


class ValorMemberMove(BaseModel):
    after_id: int | None = None   # поставить строку ПОСЛЕ этой; пусто → в начало списка


@router.post("/member/{member_id}/move")
def valor_member_move(member_id: int, payload: ValorMemberMove,
                      actor: dict = Depends(require_admin)) -> dict:
    """Переместить строку в списке (после after_id или в начало). ТОЛЬКО админ. Меняет
    только порядок (sort_key), кадр не трогает — подсветка источника на скрине остаётся верной."""
    res = db.valor_move_member(member_id, payload.after_id, actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "move_failed"))
    return res


class SnapshotMetaIn(BaseModel):
    week:           str = Field(..., min_length=1)
    actual_members: int | None = None
    valor_norm:     int | None = None
    notes:          str | None = None


@router.patch("/snapshot-meta")
def valor_snapshot_meta(payload: SnapshotMetaIn,
                        actor: dict = Depends(require_admin)) -> dict:
    """Правка метаданных снимка недели (Архив скринов): реально людей в клане,
    норматив, заметки. ТОЛЬКО админ."""
    fields = payload.model_dump(exclude_unset=True)
    fields.pop("week", None)
    res = db.valor_update_snapshot_meta(payload.week, fields, actor)
    if not res.get("ok"):
        code = (status.HTTP_404_NOT_FOUND if res.get("reason") == "no_snapshot"
                else status.HTTP_400_BAD_REQUEST)
        raise HTTPException(code, res.get("reason", "update_failed"))
    return res


@router.post("/verify/{member_id}")
def valor_member_verify(member_id: int,
                        actor: dict = Depends(require_admin)) -> dict:
    """Подтвердить, что строка распознана верно — снять флаги сомнений
    (ИИ-ник / сомнение OCR). ТОЛЬКО админ."""
    res = db.valor_verify_member(member_id, actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "not_found"))
    return res


class AutoVerifyIn(BaseModel):
    week: str = Field(..., min_length=1)


@router.post("/auto-verify")
def valor_auto_verify_ep(payload: AutoVerifyIn,
                         actor: dict = Depends(require_admin)) -> dict:
    """Авто-проверка скринов (без AI): ШАГ 1 — снять ложные флаги «ИИ-ник» у
    известных игроков (canon в истории Доблести/реестре/архиве); ШАГ 2 — резолв
    по похожести: удалить фантомные дубли (двойник в том же кадре с идентичными
    стат). Всё с логом (откатываемо). ТОЛЬКО админ."""
    s1 = db.valor_auto_verify(payload.week, actor)
    if not s1.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, s1.get("reason", "failed"))
    s2 = db.valor_auto_fuzzy(payload.week, actor)
    return {
        "ok": True,
        "checked": s1.get("checked", 0),
        "cleared": s1.get("cleared", 0),          # снято ложных флагов (Шаг 1)
        "deduped": s2.get("deduped", 0),          # удалено фантомных дублей (Шаг 2)
        "deleted": s2.get("deleted", []),
        "remaining": s2.get("remaining", s1.get("remaining", [])),
    }


# ── Веса (проценты) категорий ценности ───────────────────────────────────
class ValorWeightsIn(BaseModel):
    base:    float = Field(..., ge=0, le=100)
    streak:  float = Field(..., ge=0, le=100)
    officer: float = Field(..., ge=0, le=100)
    veteran: float = Field(..., ge=0, le=100)
    social:  float = Field(..., ge=0, le=100)


@router.get("/weights")
def valor_weights_get(_: dict = Depends(require_viewer)) -> dict:
    """Текущие веса категорий (видно всем — для пояснений; правка — админ)."""
    return db.get_valor_weights()


@router.put("/weights")
def valor_weights_set(payload: ValorWeightsIn,
                      actor: dict = Depends(require_admin)) -> dict:
    """Сохранить веса. Сумма не должна превышать 100% (проверяет и сервер)."""
    res = db.set_valor_weights(payload.model_dump(), actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            res.get("error", "invalid_weights"))
    return res


class MergeIn(BaseModel):
    source_canon: str = Field(..., min_length=1)
    target_nick:  str = Field(..., min_length=1)


class CanonIn(BaseModel):
    canon:  str = Field(..., min_length=1)
    reason: str | None = ""


@router.post("/merge")
def valor_merge_ep(payload: MergeIn, actor: dict = Depends(require_admin)) -> dict:
    """«Это он и есть»: слить неверно распознанного в существующего (admin)."""
    res = db.valor_merge(payload.source_canon, payload.target_nick, actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("reason", "merge_failed"))
    return res


@router.post("/archive")
def valor_archive_ep(payload: CanonIn,
                     _: dict = Depends(require_officer),
                     actor: dict = Depends(current_actor)) -> dict:
    """Ручной кик: убрать человека в архив доблести (офицер/админ).
    Пометка (причина) сохраняется и видна в «Покинули клан»."""
    res = db.valor_archive_member(payload.canon, actor, payload.reason or "")
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "not_found"))
    return res


@router.post("/restore")
def valor_restore_ep(payload: CanonIn,
                     _: dict = Depends(require_officer),
                     actor: dict = Depends(current_actor)) -> dict:
    """Вернуть человека из архива в основной список (офицер/админ).
    Пометка (причина возврата) пишется в журнал действий."""
    return db.valor_restore(payload.canon, actor, payload.reason or "")


@router.delete("/member/{member_id}")
def valor_delete_ep(member_id: int, actor: dict = Depends(require_admin)) -> dict:
    """Удалить ошибочную строку/фантом OCR из текущего снимка (admin)."""
    res = db.valor_delete_member(member_id, actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("reason", "not_found"))
    return res


# ── Журнал правок Архива скринов (ТОЛЬКО админ) ──
@router.get("/editlog")
def valor_editlog(week: str = Query(..., min_length=1),
                  _: dict = Depends(require_admin)) -> dict:
    """Журнал правок недели + список редакторов (для просмотра/отмены)."""
    return {"week": week,
            "items": db.valor_edit_log_for(week),
            "actors": db.valor_edit_log_actors(week)}


class EditUndoIn(BaseModel):
    id: int


@router.post("/editlog/undo")
def valor_editlog_undo(payload: EditUndoIn,
                       actor: dict = Depends(require_admin)) -> dict:
    """Отменить одно действие из журнала (admin)."""
    res = db.valor_undo_edit(payload.id, actor)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("reason", "failed"))
    return res


class EditUndoActorIn(BaseModel):
    week:  str = Field(..., min_length=1)
    actor: str = Field(..., min_length=1)


@router.post("/editlog/undo-actor")
def valor_editlog_undo_actor(payload: EditUndoActorIn,
                             actor: dict = Depends(require_admin)) -> dict:
    """Отменить ВСЕ правки одного редактора за неделю (admin)."""
    return db.valor_undo_by_actor(payload.week, payload.actor, actor)


@router.get("/history")
def valor_history(nick: str = Query(..., min_length=1),
                  field: str | None = Query(default=None,
                                             pattern="^(rank|title|level|class|valor)$"),
                  _: dict = Depends(require_viewer)) -> dict:
    """История изменений полей для одного ника. Если field=None — все
    отслеживаемые поля."""
    return db.valor_get_history(nick, field)


@router.get("/timeline")
def valor_timeline(weeks: int = Query(default=12, ge=1, le=52),
                   _: dict = Depends(require_viewer)) -> dict:
    """Timeline доблести за последние N недель."""
    return db.valor_timeline(weeks=weeks)
