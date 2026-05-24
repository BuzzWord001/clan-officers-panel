"""Шедулер: каждую минуту проверяет dirty-флаг и публикует если прошло
RENDER_DEBOUNCE_MINUTES с последнего изменения.

Это даёт окно для серии правок — например офицер вписал три ника подряд,
бот опубликует один раз спустя 5 минут.
"""

import asyncio
import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler

import db
import publisher
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


def make_scheduler() -> AsyncIOScheduler:
    sched = AsyncIOScheduler(timezone="UTC")
    sched.add_job(_tick, "interval", minutes=1, id="publish_tick",
                  max_instances=1, coalesce=True)
    return sched
