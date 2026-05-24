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

import auth_pwd
import db
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


@router.post("/login", response_model=MeOut)
def login(payload: OfficerLoginIn, request: Request, response: Response) -> dict:
    name = payload.game_nick.strip()
    ip = client_ip(request)
    ua = client_user_agent(request)

    if not auth_pwd.verify_officer(payload.password):
        db.write_login(role="officer", name=name, success=False,
                       reason="wrong_password", ip=ip, user_agent=ua)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_password")

    db.write_login(role="officer", name=name, success=True, ip=ip, user_agent=ua)
    set_session(response, role="officer", name=name)
    return {"role": "officer", "name": name, "login_at": "now"}


@router.post("/admin/login", response_model=MeOut)
def admin_login(payload: AdminLoginIn, request: Request, response: Response) -> dict:
    ip = client_ip(request)
    ua = client_user_agent(request)

    if not auth_pwd.verify_admin(payload.username, payload.password):
        db.write_login(role="admin", name=payload.username, success=False,
                       reason="wrong_credentials", ip=ip, user_agent=ua)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_credentials")

    db.write_login(role="admin", name=payload.username, success=True, ip=ip, user_agent=ua)
    set_session(response, role="admin", name=payload.username)
    return {"role": "admin", "name": payload.username, "login_at": "now"}


@router.get("/me", response_model=MeOut)
def me(s: dict = Depends(current_session)) -> dict:
    return s


@router.post("/logout")
def logout(response: Response) -> dict:
    clear_session(response)
    return {"ok": True}


# --- admin-only ----------------------------------------------------------

@router.post("/admin/officer-password")
def set_officer_pwd(payload: ChangeOfficerPasswordIn, _: dict = Depends(require_admin)) -> dict:
    auth_pwd.set_officer_password(payload.new_password)
    return {"ok": True}


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
