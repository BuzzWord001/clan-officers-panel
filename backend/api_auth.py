"""Авторизация по паролю.

POST /auth/login        — общий вход офицеров (game_nick + общий пароль)
POST /auth/admin/login  — вход админа (username + admin password)
GET  /auth/me           — текущая сессия
POST /auth/logout       — выйти

Admin-only:
POST /auth/admin/officer-password   — сменить пароль офицеров
POST /auth/admin/credentials        — сменить admin username / password
GET  /admin/login-log               — журнал входов (IP, UA)
DELETE /admin/login-log             — очистить
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

import asyncio

import auth_pwd
import db
import publisher
from schemas import (
    OfficerLoginIn,
    AdminLoginIn,
    ChangeOfficerPasswordIn,
    ChangeAdminCredentialsIn,
    MeOut,
)
from session import (
    current_session, set_session, clear_session, require_admin,
    client_ip, client_user_agent,
)


router = APIRouter(prefix="/auth", tags=["auth"])
admin_router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login")
def login(payload: OfficerLoginIn, request: Request, response: Response) -> dict:
    name = payload.game_nick.strip()
    ip = client_ip(request)
    ua = client_user_agent(request)

    if not auth_pwd.verify_officer(payload.password):
        db.write_login(role="officer", name=name, success=False,
                       reason="wrong_password", ip=ip, user_agent=ua)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_password")

    db.write_login(role="officer", name=name, success=True, ip=ip, user_agent=ua)
    token = set_session(response, role="officer", name=name)
    # token в body — фолбэк для браузеров где cross-site cookie не доходит
    # (РФ Firefox с ETP / Brave / Yandex / Chrome с отключёнными 3p cookie).
    # Фронт сам решает: если cookie доехала — игнорит, иначе кладёт в localStorage.
    return {"role": "officer", "name": name, "login_at": "now", "token": token}


ADMIN_DEV_COOKIE = "admin_dev"


def _geo_str(ip: str) -> str:
    try:
        with db.connection() as conn:
            r = conn.execute("SELECT country, city, isp FROM geoip_cache WHERE ip=?", (ip,)).fetchone()
        if r:
            return "%s, %s [%s]" % (r["country"] or "?", r["city"] or "?", (r["isp"] or "")[:30])
    except Exception:
        pass
    return ""


@router.post("/admin/login")
def admin_login(payload: AdminLoginIn, request: Request, response: Response) -> dict:
    import secrets
    import bot_tg
    ip = client_ip(request)
    ua = client_user_agent(request)
    try:
        db.admin_seed_home_nets()   # разово: занести сети, откуда владелец входил ДО защиты
    except Exception:
        pass

    # 1) неверный пароль → алерт + отказ
    if not auth_pwd.verify_admin(payload.username, payload.password):
        db.write_login(role="admin", name=payload.username, success=False,
                       reason="wrong_credentials", ip=ip, user_agent=ua)
        try:
            bot_tg.send_admin_alert(
                "⚠️ ПОПЫТКА АДМИН-ВХОДА (неверный пароль)\n"
                "IP: %s\n%s\nУстройство: %s\nЛогин: %s" % (ip, _geo_str(ip), ua[:120], payload.username))
        except Exception:
            pass
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_credentials")

    # 2) пароль верный — проверяем УСТРОЙСТВО
    dev = request.cookies.get(ADMIN_DEV_COOKIE) or ""
    trusted = db.admin_device_trusted(dev)

    if not trusted:
        # Предохранитель от само-блокировки: если система пуста (нет ни сетей, ни устройств —
        # первый запуск/сбой сидирования) — НЕ блокируем, а заносим текущее как доверенное.
        try:
            with db.connection() as conn:
                empty = (conn.execute("SELECT COUNT(*) n FROM admin_home_net").fetchone()["n"] == 0
                         and conn.execute("SELECT COUNT(*) n FROM admin_device").fetchone()["n"] == 0)
        except Exception:
            empty = True
        if db.admin_is_home_ip(ip) or empty:
            # свой (домашняя сеть) — добавляем устройство в доверенные, пускаем, уведомляем
            dev = secrets.token_urlsafe(24)
            db.admin_enroll_device(dev, ip, ua)
            response.set_cookie(ADMIN_DEV_COOKIE, dev, max_age=400 * 86400,
                                httponly=True, secure=True, samesite="lax", path="/")
            try:
                bot_tg.send_admin_alert(
                    "✅ Новое доверенное устройство добавлено для админ-входа\n"
                    "IP: %s\n%s\nУстройство: %s\n\nЕсли это НЕ ты — смени пароль и напиши мне «отозвать устройства»."
                    % (ip, _geo_str(ip), ua[:120]))
            except Exception:
                pass
        else:
            # чужое устройство + чужая сеть → БЛОК + алерт
            db.write_login(role="admin", name=payload.username, success=False,
                           reason="untrusted_device", ip=ip, user_agent=ua)
            try:
                bot_tg.send_admin_alert(
                    "🚨 ЗАБЛОКИРОВАН ЧУЖОЙ АДМИН-ВХОД (пароль ВЕРНЫЙ, но устройство/сеть незнакомы!)\n"
                    "IP: %s\n%s\nУстройство: %s\n\n⚠️ Кто-то знает админ-пароль. Срочно смени его."
                    % (ip, _geo_str(ip), ua[:120]))
            except Exception:
                pass
            raise HTTPException(status.HTTP_403_FORBIDDEN, "untrusted_device")

    db.write_login(role="admin", name=payload.username, success=True, ip=ip, user_agent=ua)
    token = set_session(response, role="admin", name=payload.username)
    return {"role": "admin", "name": payload.username, "login_at": "now", "token": token}


@router.post("/guest")
def guest_login(request: Request, response: Response) -> dict:
    """ОТКЛЮЧЕНО 2026-07-20: гостевого входа больше нет — весь сайт только после
    личного входа (ник + личный пароль). Фронт больше сюда не ходит; на всякий
    случай отвечаем 403, чтобы никакой анонимный доступ не проходил."""
    raise HTTPException(status.HTTP_403_FORBIDDEN, "guest_disabled")


@router.get("/me", response_model=MeOut)
def me(s: dict = Depends(current_session)) -> dict:
    return s


@router.post("/logout")
def logout(response: Response) -> dict:
    clear_session(response)
    return {"ok": True}


# --- admin-only ----------------------------------------------------------

@router.get("/admin/devices")
def admin_devices(_: dict = Depends(require_admin)) -> dict:
    """Список доверенных админ-устройств + домашние сети (для управления)."""
    with db.connection() as conn:
        nets = [r["net"] for r in conn.execute("SELECT net FROM admin_home_net ORDER BY net")]
    return {"devices": db.admin_list_devices(), "home_nets": nets}


@router.post("/admin/devices/revoke")
def admin_devices_revoke(payload: dict, _: dict = Depends(require_admin)) -> dict:
    """Отозвать доверенное устройство (token) — или ВСЕ (all:true). После отзыва с
    этого устройства снова потребуется вход из домашней сети."""
    if payload.get("all"):
        with db.connection() as conn:
            n = conn.execute("DELETE FROM admin_device").rowcount
        return {"ok": True, "revoked": n}
    tok = (payload.get("token") or "").strip()
    return {"ok": True, "revoked": db.admin_revoke_device(tok) if tok else 0}


@router.post("/admin/home-net")
def admin_add_home_net(payload: dict, _: dict = Depends(require_admin)) -> dict:
    """Добавить домашнюю сеть вручную (напр. '37.99') — если сменишь провайдера/город."""
    net = (payload.get("net") or "").strip()
    if net:
        db.admin_add_home_net(net)
    return {"ok": True}


@router.post("/admin/officer-password")
async def set_officer_pwd(payload: ChangeOfficerPasswordIn, _: dict = Depends(require_admin)) -> dict:
    auth_pwd.set_officer_password(payload.new_password)
    # Обновляем подпись в TG/VK закрепе сразу — без 5-мин debounce.
    # Делаем edit (не force_repost), чтобы не спамить чат новым постом
    # при каждой смене пароля.
    asyncio.create_task(_republish_after_password_change())
    return {"ok": True}


async def _republish_after_password_change() -> None:
    try:
        await publisher.publish_now()
    except Exception:
        # publish уже логирует исключение, тут просто чтобы фоновая задача
        # не падала без обработки.
        pass


@router.post("/admin/credentials")
def update_admin(payload: ChangeAdminCredentialsIn, _: dict = Depends(require_admin)) -> dict:
    if not payload.new_username and not payload.new_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing_to_update")
    ok = auth_pwd.update_admin(
        current_password=payload.current_password,
        new_username=payload.new_username,
        new_password=payload.new_password,
    )
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "current_password_wrong")
    return {"ok": True}


# --- admin: login log ----------------------------------------------------

@admin_router.get("/login-log")
def login_log(limit: int = 200, _: dict = Depends(require_admin)) -> list[dict]:
    if limit < 1: limit = 1
    if limit > 1000: limit = 1000
    return db.list_logins(limit)


@admin_router.delete("/login-log", status_code=status.HTTP_204_NO_CONTENT)
def clear_login_log(_: dict = Depends(require_admin)) -> None:
    db.clear_logins()
