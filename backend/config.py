"""Настройки приложения. Читаются из .env."""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent
_PROJECT_DIR = _BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "0.0.0.0"
    port: int = 8765
    public_url: str = "http://localhost:8765"
    frontend_url: str = "http://localhost:5500"
    session_secret: str = "dev-secret-change-me"

    tg_bot_token: str = ""
    tg_officer_chat_id: str = ""
    tg_login_bot_token: str = ""

    vk_group_token: str = ""
    vk_officer_peer_id: str = ""
    vk_app_id: str = ""
    vk_app_secret: str = ""

    whitelist_tg_path: str = str(_PROJECT_DIR.parent / "clan-bridge-admin-bot" / "tg_users.json")
    whitelist_vk_path: str = str(_PROJECT_DIR.parent / "clan-bridge-admin-bot" / "vk_users.json")

    db_path: str = str(_PROJECT_DIR / "data" / "officers.db")

    render_debounce_minutes: int = 5

    @property
    def project_dir(self) -> Path:
        return _PROJECT_DIR

    @property
    def render_dir(self) -> Path:
        return _PROJECT_DIR / "render"


settings = Settings()
