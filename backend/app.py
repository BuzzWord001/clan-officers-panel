"""FastAPI приложение clan-officers-panel.

Запуск:
    cd backend
    python -m uvicorn app:app --host 0.0.0.0 --port 8765
"""

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db
import publisher
import scheduler
import api_auth
import api_acceptances
import api_audit
from config import settings
from session import current_actor


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("officers.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    log.info("DB initialised: %s", settings.db_path)
    log.info("Frontend: %s", settings.frontend_url)
    sched = scheduler.make_scheduler()
    sched.start()
    app.state.scheduler = sched
    log.info("Scheduler started, debounce=%s min", settings.render_debounce_minutes)
    try:
        yield
    finally:
        sched.shutdown(wait=False)
        log.info("Scheduler stopped")


app = FastAPI(title="SanTDeviL Officer Panel", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/admin/republish")
async def republish(_: dict = Depends(current_actor)) -> dict:
    """Принудительная публикация (без ожидания дебаунса). Требует авторизации офицера."""
    return await publisher.publish_now()


app.include_router(api_auth.router)
app.include_router(api_acceptances.router)
app.include_router(api_audit.router)
