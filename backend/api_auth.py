"""Авторизация по паролю.

POST /auth/login        — общий вход офицеров (game_nick + общий пароль)
POST /auth/admin/login  — вход админа (username + admin password)
GET  /auth/me           — текущая сессия
POST /auth/logout       — выйти

Admin-only:
POST /auth/admin/officer-password   — сменить пароль офицеров
POST /auth/admin/credentials        — сменить admin username / password
"""

from fastapi import APIRouter, Depends, HTTPException, Response, status

import auth_pwd
from schemas import (
    OfficerLoginIn,
    AdminLoginIn,
    ChangeOfficerPasswordIn,
    ChangeAdminCredentialsIn,
    MeOut,
)
from session import current_session, set_session, clear_session, require_admin


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=MeOut)
def login(payload: OfficerLoginIn, response: Response) -> dict:
    if not auth_pwd.verify_officer(payload.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_password")
    name = payload.game_nick.strip()
    set_session(response, role="officer", name=name)
    return {"role": "officer", "name": name, "login_at": "now"}


@router.post("/admin/login", response_model=MeOut)
def admin_login(payload: AdminLoginIn, response: Response) -> dict:
    if not auth_pwd.verify_admin(payload.username, payload.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_credentials")
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
