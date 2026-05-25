# clan-officers-panel — backend на Fly.io.
# FastAPI + Selenium + Chromium для рендера манифеста в PNG.

FROM python:3.12-slim-bookworm

# Chromium + chromedriver совместимы из коробки в Debian 12.
# Шрифты Noto нужны для кириллицы и стрелок в template.html
# (без них рендер показывает "тофу" квадратики).
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        chromium-driver \
        fonts-dejavu \
        fonts-liberation \
        fonts-noto-core \
        fonts-noto-color-emoji \
        ca-certificates \
        tzdata \
        curl \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium \
    TZ=Europe/Moscow \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # /data — volume, переживает рестарт контейнера.
    DB_PATH=/data/officers.db \
    BOT_LOCK_PATH=/data/.bot.lock

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install -r /app/backend/requirements.txt

COPY backend/ /app/backend/
COPY render/  /app/render/

# /data создаётся mount'ом тома, но папка нужна до маунта тоже
# (для пути SNAPSHOT_DIR при первом запуске без тома).
RUN mkdir -p /data/snapshots

EXPOSE 8765

# launcher.py берёт lock и стартует uvicorn.
CMD ["python", "/app/backend/launcher.py"]
