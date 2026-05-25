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
    # Дополнительные origin'ы через запятую (CORS). На Fly сюда передаётся
    # `https://buzzword001.github.io`, чтобы GitHub Pages мог стучаться.
    extra_origins: str = ""
    session_secret: str = "dev-secret-change-me"

    tg_bot_token: str = ""
    tg_officer_chat_id: str = ""
    tg_login_bot_token: str = ""

    vk_group_token: str = ""
    vk_officer_peer_id: str = ""

    db_path: str = str(_PROJECT_DIR / "data" / "officers.db")

    render_debounce_minutes: int = 5

    # Дефолты для первого запуска — потом меняются только через UI.
    default_admin_username: str = "buzzword001"
    default_admin_password: str = "SanTDeviL_admin_change_me"
    default_officer_password: str = "santdevil2026"

    # Plaintext офицерский пароль для подписи закрепа в TG/VK
    # (хранится отдельно от bcrypt-хэша — при смене пароля офицеров
    # обнови и тут, иначе в закрепе будет старое значение).
    caption_officer_password: str = "santdevil2026"

    @property
    def project_dir(self) -> Path:
        return _PROJECT_DIR

    @property
    def render_dir(self) -> Path:
        return _PROJECT_DIR / "render"


settings = Settings()
