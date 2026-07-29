"""Шедулер: каждую минуту проверяет dirty-флаг и публикует если прошло
RENDER_DEBOUNCE_MINUTES с последнего изменения.

Это даёт окно для серии правок — например офицер вписал три ника подряд,
бот опубликует один раз спустя 5 минут.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import auth_pwd
import db
import publisher
import snapshots
import ts3
from config import settings

log = logging.getLogger("officers.scheduler")


async def _tick() -> None:
    state = db.get_render_state()
    if not state.get("dirty"):
        return
    last_change = state.get("last_change_at")
    if not last_change:
        return
    try:
        last_dt = datetime.fromisoformat(last_change)
    except ValueError:
        log.warning("bad last_change_at: %s", last_change)
        return
    delta = datetime.utcnow() - last_dt
    if delta < timedelta(minutes=settings.render_debounce_minutes):
        return
    log.info("Debounce passed (%s), publishing", delta)
    result = await publisher.publish_now()
    log.info("Publish result: %s", result)


def _periodic_snapshot() -> None:
    # Перед snapshot — подрезаем логи (TTL 30 дней) и пытаемся VACUUM
    # раз в неделю. Так снапшот сразу меньше: не тащит уже удалённые
    # страницы в backup.
    try:
        removed = db.trim_old_logs()
        if any(v > 0 for v in removed.values()):
            log.info("log trim removed: %s", removed)
    except Exception:
        log.exception("log trim failed")

    # VACUUM запускается только в понедельник в 06:00 UTC — иначе каждые 6
    # часов держал бы лишнюю нагрузку. На маленькой БД он мгновенный, но
    # лишний раз не нужен.
    now = datetime.utcnow()
    if now.weekday() == 0 and now.hour == 6:
        try:
            saved = db.vacuum()
            log.info("VACUUM done, reclaimed %d bytes", saved)
        except Exception:
            log.exception("VACUUM failed")

    try:
        path = snapshots.create_auto()
        log.info("auto snapshot: %s", path.name)
    except Exception as exc:
        log.exception("auto snapshot failed: %s", exc)
    # Подрезаем старые auto-снапшоты: 4 в день × 30 дней = 120 макс.
    # Manual и pre_restore — НЕ трогаем (это явные точки восстановления Лира).
    try:
        removed = snapshots.trim_auto(keep_last=120)
        if removed:
            log.info("auto snapshot trim: removed %d old", removed)
    except Exception:
        log.exception("snapshot trim failed")


def make_scheduler() -> AsyncIOScheduler:
    sched = AsyncIOScheduler(timezone="UTC")
    sched.add_job(_tick, "interval", minutes=1, id="publish_tick",
                  max_instances=1, coalesce=True)
    # Снапшоты 4 раза в сутки: 00/06/12/18 UTC = 03/09/15/21 МСК.
    # Точки восстановления привязаны к деловому циклу (утро/обед/вечер/ночь).
    # Размер БД ~50КБ × 120 retention ≈ 6МБ, volume 3ГБ выдержит.
    sched.add_job(_periodic_snapshot, CronTrigger(hour="0,6,12,18", minute=0),
                  id="periodic_snapshot", max_instances=1, coalesce=True)
    # TS3-клиент: раз в сутки в 05:00 UTC (08:00 МСК) проверяем новую версию
    # и докачиваем установщики. Сама refresh не качает, если версия та же.
    sched.add_job(ts3.refresh, CronTrigger(hour=5, minute=0),
                  id="ts3_refresh", max_instances=1, coalesce=True)
    # АФК со сроком: ежедневно в 00:05 UTC снимаем истёкшие (на случай, если
    # страницу никто не открывал; при открытии снимается и лениво в current).
    sched.add_job(db.valor_expire_afk, CronTrigger(hour=0, minute=5),
                  id="afk_expire", max_instances=1, coalesce=True)
    # Система возврата состава: ежедневный датированный снимок ростера чатов
    # (00:15 UTC = 03:15 МСК). Фиксирует, кто был у нас в этот день, + метит
    # last_active_day. Так при удалении/чистке чатов владельцем можно позвать
    # назад именно недавних участников.
    sched.add_job(_member_snapshot_job, CronTrigger(hour=0, minute=15),
                  id="member_snapshot", max_instances=1, coalesce=True)
    # Еженедельная авто-ротация офицерского пароля: понедельник 07:00 UTC (10:00 МСК),
    # начало новой недели доблести. Генерит новый читаемый пароль, обновляет
    # закреплённое сообщение в офиц. чатах TG/VK. Вошедшие офицеры (с личным паролём)
    # НЕ разлогиниваются — новый пароль требуется только новым офицерам.
    sched.add_job(_rotate_officer_pw_job, CronTrigger(day_of_week="mon", hour=7, minute=0),
                  id="officer_pw_rotate", max_instances=1, coalesce=True)
    # Материализованный ростер клана + синхронизация очереди — КАЖДЫЕ 5 МИНУТ, автономно на
    # сервере (работает, даже когда ПК владельца выключен). Пересобирает актуальный список
    # состава (снимок доблести + принятые после) и убирает из очереди ушедших (запоминая место).
    sched.add_job(_refresh_membership_job, "interval", minutes=5,
                  id="clan_roster_rebuild", max_instances=1, coalesce=True)
    return sched


def _refresh_membership_job() -> None:
    try:
        import api_queue
        r = api_queue.refresh_membership_and_queue()
        q = r.get("queue") or {}
        if (q.get("removed_count") or q.get("restored_count")):
            log.info("membership refresh: %s", r)
    except Exception:
        log.exception("membership refresh failed")


async def _rotate_officer_pw_job() -> None:
    try:
        new = auth_pwd.rotate_officer_password()
        db.kv_set("officer_pw_rotated_at",
                  datetime.utcnow().isoformat(timespec="seconds"))
        res = await publisher.publish_officer_password()
        log.info("officer password auto-rotated (weekly); pinned updated: %s", res)
    except Exception:
        log.exception("weekly officer password rotation failed")


def _member_snapshot_job() -> None:
    try:
        r = db.capture_member_snapshot()
        log.info("member snapshot: %s участников (%s активных) на %s",
                 r.get("members"), r.get("active"), r.get("day"))
    except Exception:
        log.exception("member snapshot failed")
