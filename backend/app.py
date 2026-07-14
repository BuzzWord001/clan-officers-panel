"""FastAPI приложение clan-officers-panel.

Запуск:
    cd backend
    python -m uvicorn app:app --host 0.0.0.0 --port 8765
"""

import asyncio
import logging
import mimetypes
import os
import sys
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import db
import publisher
import scheduler
import api_auth
import api_acceptances
import api_audit
import api_admin_logs
import api_snapshots
import api_chat
import auth_pwd
import bot_tg_listener
import bot_vk_listener
from middleware import GuardAndLogMiddleware
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

    # Listener'ы новых участников: при входе нового члена в TG/VK офицерский
    # чат вызывают publisher.publish_force_repost, чтобы новичок увидел
    # манифест среди недавних сообщений (закреп он не видит до прокрутки).
    tg_task = asyncio.create_task(bot_tg_listener.run(), name="tg_listener")
    vk_task = asyncio.create_task(bot_vk_listener.run(), name="vk_listener")
    log.info("Member listeners started (TG + VK)")

    # TS3-клиент: при старте докачиваем актуальные установщики в фоне (не
    # блокируя запуск). Дальше — раз в сутки через scheduler.
    import ts3
    asyncio.create_task(asyncio.to_thread(ts3.refresh), name="ts3_initial")
    log.info("TS3 initial refresh scheduled")

    try:
        yield
    finally:
        for t in (tg_task, vk_task):
            t.cancel()
        await asyncio.gather(tg_task, vk_task, return_exceptions=True)
        log.info("Listeners stopped")
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
    # Явный список вместо "*" — при credentials=True Chrome/Firefox обязаны
    # видеть точное имя header'а в Access-Control-Allow-Headers, "*" не
    # принимается. Без Authorization в списке Bearer-fallback ломается preflight'ом.
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
)

# GuardAndLog после CORS — Starlette стек идёт снизу вверх: первая
# добавленная middleware оборачивает запрос ПОСЛЕДНЕЙ. То есть CORS
# отрабатывает на outermost level (правильно для preflight), а guard/log
# уже видит preflight как OPTIONS и пропускает.
app.add_middleware(GuardAndLogMiddleware)


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
app.include_router(api_admin_logs.router)
app.include_router(api_admin_logs.telemetry_router)
app.include_router(api_chat.router)
import api_valor
app.include_router(api_valor.router)
import api_chamber
app.include_router(api_chamber.router)
import api_ts3
app.include_router(api_ts3.router)
import api_queue
app.include_router(api_queue.router)


# --- Frontend (single-origin) --------------------------------------------
# Отдаём статику фронта с того же домена, что и API. Тогда cookie сессии
# становится first-party (Secure; SameSite=Lax) и доезжает во ВСЕХ браузерах
# — включая Safari/iOS и встроенные браузеры Telegram/VK, которые режут
# cross-site (SameSite=None) cookie. Без этого «некоторых людей» выкидывало после входа.
#
# Монтируем ПОСЛЕДНИМ: явные API-роуты (/auth, /valor, /chat, /health, …)
# зарегистрированы выше и матчатся раньше, статика ловит всё остальное.
# В контейнере фронт лежит в /app/frontend; локально — ../frontend от backend/.
_FRONTEND_DIR = os.environ.get("FRONTEND_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend"
)
# В контейнере mimetypes может не знать современные типы (напр. .webp) → отдаёт
# text/plain, и браузер НЕ рисует их как картинку/шрифт (пропала эмблема Элиты).
# Правим Content-Type по расширению.
_EXT_MIME = {
    ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
}
for _ext, _mt in _EXT_MIME.items():
    mimetypes.add_type(_mt, _ext)


class _RevalidateHTMLStatic(StaticFiles):
    """StaticFiles, но HTML отдаёт с Cache-Control: no-cache — браузер всегда
    ревалидирует страницу по ETag (дешёвый 304, если не менялась; свежая
    версия, если менялась). Иначе браузеры эвристически кэшируют HTML без
    Cache-Control и показывают устаревшее меню/разметку до ручного Ctrl+F5.
    Версионные js/css/img (?v=) кэшируем НАВСЕГДА (immutable, год) — их URL
    меняется при правке (bump ?v=), поэтому браузер вернувшегося юзера НЕ
    перекачивает их (раньше Cloudflare ставил дефолт 4ч → клан качал ~всё
    заново каждые 4 часа = «долго грузится»). Не-версионные статики — 1 день."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        ct = resp.headers.get("content-type", "")
        # если тип не распознан (text/plain) — правим по расширению файла
        if (not ct) or ct.startswith("text/plain"):
            low = (path or "").lower()
            for ext, mt in _EXT_MIME.items():
                if low.endswith(ext):
                    resp.headers["content-type"] = mt
                    ct = mt
                    break
        if ct.startswith("text/html"):
            resp.headers["Cache-Control"] = "no-cache"
        else:
            qs = scope.get("query_string", b"") or b""
            if b"v=" in qs:   # версионный ассет (?v=…) → кэш на год, immutable
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            elif "assets/ts3/" in (path or ""):
                # Иконки TS3 раздаём по СТАБИЛЬНОму имени (windows/macos/linux.png),
                # содержимое меняем при замене иконок. Новый код всегда грузит их
                # с ?v= (immutable выше). Но СТАРЫЙ закэшированный ts3.js просит
                # голый URL — если бы он кэшировался на сутки, после замены клан
                # видел бы старую иконку ~24ч до ручного Ctrl+F5. no-cache →
                # браузер ревалидирует по ETag (дешёвый 304 / свежий 200).
                resp.headers["Cache-Control"] = "no-cache"
            else:             # не-версионный (logo.png, market.jpg…) → 1 день
                resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp


if os.path.isdir(_FRONTEND_DIR):
    app.mount("/", _RevalidateHTMLStatic(directory=_FRONTEND_DIR, html=True), name="frontend")
    log.info("Frontend static mounted from %s", _FRONTEND_DIR)
else:
    log.warning("Frontend dir not found (%s) — статика не смонтирована", _FRONTEND_DIR)
