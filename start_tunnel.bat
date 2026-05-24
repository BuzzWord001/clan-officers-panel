@echo off
REM Поднимает quick Cloudflare Tunnel к локальному backend на порту 8765.
REM cloudflared должен быть установлен (winget install Cloudflare.cloudflared).
REM После запуска покажет URL вида https://something-random.trycloudflare.com
REM — вставь его в frontend/config.js как API_URL.

cloudflared tunnel --url http://127.0.0.1:8765
