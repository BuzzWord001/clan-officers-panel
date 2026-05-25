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
import api_snapshots
import auth_pwd
from config import settings
from session import current_actor, require_admin
from urllib.parse import urlparse


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("officers.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    auth_pwd.ensure_initialised()
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


def _origin_of(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else url


def _allowed_origins() -> list[str]:
    """CORS-белый список: основной FRONTEND_URL + EXTRA_ORIGINS (через запятую).
    Дубли и пустые значения отбрасываются."""
    seen: list[str] = []
    for raw in [settings.frontend_url, *settings.extra_origins.split(",")]:
        o = _origin_of(raw.strip())
        if o and o not in seen:
            seen.append(o)
    return seen


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/admin/republish")
async def republish(_: dict = Depends(require_admin)) -> dict:
    """Принудительная публикация в TG/VK (без ожидания 5-мин дебаунса). Только admin."""
    return await publisher.publish_now()


app.include_router(api_auth.router)
app.include_router(api_auth.admin_router)
app.include_router(api_acceptances.router)
app.include_router(api_audit.router)
app.include_router(api_snapshots.router)
