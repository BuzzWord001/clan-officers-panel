"""Endpoints авторизации: /auth/tg, /auth/vk, /auth/me, /auth/logout."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

import auth_tg
import auth_vk
import whitelist
from schemas import TgLoginPayload, MeOut
from session import current_actor, set_session, clear_session


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/tg")
def login_tg(payload: TgLoginPayload, response: Response) -> MeOut:
    auth_tg.verify_tg_payload(payload)

    if not whitelist.is_tg_allowed(payload.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not_in_whitelist")

    name = whitelist.tg_name_for(payload.id, payload.username or payload.first_name or "")
    session_data = {"platform": "tg", "id": payload.id, "name": name}
    set_session(response, session_data)
    return MeOut(platform="tg", user_id=str(payload.id), name=name, username=payload.username)


class VkCodeIn(BaseModel):
    code: str
    redirect_uri: str


@router.post("/vk")
async def login_vk(payload: VkCodeIn, response: Response) -> MeOut:
    tok = await auth_vk.exchange_code(payload.code, payload.redirect_uri)
    user_id = int(tok["user_id"])

    if not whitelist.is_vk_allowed(user_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not_in_whitelist")

    user = await auth_vk.fetch_user(tok["access_token"], user_id)
    display = f"{user.get('first_name', '')} {user.get('last_name', '')}".strip()
    name = whitelist.vk_name_for(user_id, display)

    session_data = {"platform": "vk", "id": user_id, "name": name}
    set_session(response, session_data)
    return MeOut(
        platform="vk",
        user_id=str(user_id),
        name=name,
        username=user.get("screen_name"),
    )


@router.get("/me")
def me(actor: dict = Depends(current_actor)) -> MeOut:
    return MeOut(platform=actor["platform"], user_id=actor["id"], name=actor["name"])


@router.post("/logout")
def logout(response: Response) -> dict:
    clear_session(response)
    return {"ok": True}
