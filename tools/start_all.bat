@echo off
REM Автозапуск офицерской панели. Запускается из shell:startup через start_all.vbs.
REM Параллельно держит backend (Python) и Cloudflare tunnel.
REM При смене URL туннеля сам пушит обновлённый config.js на GitHub.

cd /d "%~dp0\.."

REM Backend: бесконечный цикл с перезапуском (для exit 42 после restore).
REM ВНИМАНИЕ: метки goto работают ТОЛЬКО в .bat файлах, не в `cmd /c "..."`.
REM Поэтому отдельный батник tools\_run_backend_loop.bat.
start "" /B cmd /c "tools\_run_backend_loop.bat"

REM Cloudflare tunnel с авто-обновлением config.js.
start "" /B cmd /c "python tools\sync_tunnel.py"
