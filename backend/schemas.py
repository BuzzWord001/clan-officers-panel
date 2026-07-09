"""Pydantic-схемы для запросов и ответов."""

from datetime import date
from pydantic import BaseModel, Field, field_validator


class AcceptanceIn(BaseModel):
    game_nick: str = Field(min_length=1, max_length=64)
    title: str = Field(default="", max_length=100)
    accepted_date: date
    note: str = Field(default="", max_length=200)
    veteran: bool = False   # сразу пометить ролью «Ветеран» (твин старичка)
    elite: bool = False     # сразу пометить ролью «Элита» (Топ по урону)


class AcceptanceUpdate(BaseModel):
    game_nick: str | None = Field(default=None, min_length=1, max_length=64)
    title: str | None = Field(default=None, max_length=100)
    accepted_date: date | None = None
    note: str | None = Field(default=None, max_length=200)
    veteran: bool | None = None   # None=не менять, True/False=поставить/снять роль
    elite: bool | None = None     # None=не менять, True/False=поставить/снять «Элита»


class AcceptanceOut(BaseModel):
    id: int
    game_nick: str
    title: str
    accepted_date: date
    immune_until: date
    immune_active: bool
    note: str
    created_at: str
    updated_at: str
    created_by_platform: str
    created_by_id: str
    created_by_name: str
    archived: bool = False
    veteran: bool = False
    elite: bool = False
    archived_at: str = ""
    archived_by: str = ""
    archived_reason: str = ""
    nick_canon: str = ""      # канон-ник — для «свитка» примечаний (общий с Доблестью)
    note_count: int = 0       # число записей в истории примечаний (для бейджа)


class ArchiveIn(BaseModel):
    reason: str = Field(default="", max_length=200)


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
    actor_ip: str = ""
    actor_user_agent: str = ""


class LoginLogOut(BaseModel):
    id: int
    timestamp: str
    role: str
    name: str
    success: bool
    reason: str
    ip: str
    user_agent: str


class MeOut(BaseModel):
    role: str         # "officer" | "admin"
    name: str         # game nick для officer, admin username для admin
    login_at: str


class OfficerLoginIn(BaseModel):
    # Никакой регулярки — игровые ники могут быть на любом языке, с !, @, # и т.п.
    game_nick: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=200)

    @field_validator("game_nick")
    @classmethod
    def _strip_and_check(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("game_nick is required")
        return s


class AdminLoginIn(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=1, max_length=200)


class ChangeOfficerPasswordIn(BaseModel):
    new_password: str = Field(min_length=6, max_length=200)

    @field_validator("new_password")
    @classmethod
    def _no_spaces(cls, v: str) -> str:
        if v != v.strip():
            raise ValueError("password must not have leading/trailing spaces")
        return v


class ChangeAdminCredentialsIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_username: str | None = Field(default=None, min_length=2, max_length=32)
    new_password: str | None = Field(default=None, min_length=6, max_length=200)
