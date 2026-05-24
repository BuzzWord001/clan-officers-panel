"""Pydantic-схемы для запросов и ответов."""

from datetime import date
from pydantic import BaseModel, Field


class AcceptanceIn(BaseModel):
    game_nick: str = Field(min_length=1, max_length=64)
    accepted_date: date
    note: str = Field(default="", max_length=200)


class AcceptanceUpdate(BaseModel):
    game_nick: str | None = Field(default=None, min_length=1, max_length=64)
    accepted_date: date | None = None
    note: str | None = Field(default=None, max_length=200)


class AcceptanceOut(BaseModel):
    id: int
    game_nick: str
    accepted_date: date
    immune_until: date
    immune_active: bool
    note: str
    created_at: str
    updated_at: str
    created_by_platform: str
    created_by_id: str
    created_by_name: str


class AuditOut(BaseModel):
    id: int
    timestamp: str
    action: str
    acceptance_id: int | None
    game_nick: str | None
    before: dict | None
    after: dict | None
    actor_platform: str
    actor_id: str
    actor_name: str


class MeOut(BaseModel):
    platform: str
    user_id: str
    name: str
    username: str | None = None


class TgLoginPayload(BaseModel):
    """Поля, которые отдаёт Telegram Login Widget."""
    id: int
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None
    photo_url: str | None = None
    auth_date: int
    hash: str


class VkLoginPayload(BaseModel):
    """access_token + user info, который пришёл от VK Implicit Flow."""
    user_id: int
    access_token: str
    expires_in: int | None = None
