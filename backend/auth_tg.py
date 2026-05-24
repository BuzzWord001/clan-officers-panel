"""Telegram Login Widget — верификация подписи.

https://core.telegram.org/widgets/login#checking-authorization
"""

import hashlib
import hmac
import time
from fastapi import HTTPException, status

from config import settings
from schemas import TgLoginPayload


_MAX_AGE_SEC = 24 * 60 * 60


def verify_tg_payload(payload: TgLoginPayload) -> None:
    token = settings.tg_login_bot_token or settings.tg_bot_token
    if not token:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "tg_login_not_configured")

    data = payload.model_dump(exclude_none=True)
    received_hash = data.pop("hash")

    check_string = "\n".join(f"{k}={data[k]}" for k in sorted(data))
    secret_key = hashlib.sha256(token.encode()).digest()
    expected = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, received_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "tg_bad_signature")

    if time.time() - payload.auth_date > _MAX_AGE_SEC:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "tg_payload_expired")
