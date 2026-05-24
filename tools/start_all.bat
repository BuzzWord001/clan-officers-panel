@echo off
REM Автозапуск офицерской панели. Запускается из shell:startup через start_all.vbs.
REM Параллельно держит backend (Python) и Cloudflare tunnel.
REM При смене URL туннеля сам пушит обновлённый config.js на GitHub.

cd /d "%~dp0\.."

REM Backend: бесконечный цикл (cycle on exit code 42 для restore-перезапуска).
start "" /B cmd /c "cd /d backend && :loop && python launcher.py && if errorlevel 42 goto loop"

REM Cloudflare tunnel с авто-обновлением config.js.
start "" /B cmd /c "python tools\sync_tunnel.py"
