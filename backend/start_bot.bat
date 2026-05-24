@echo off
REM Одинокий запуск backend — без while-loop, чтобы bot-monitor мог
REM штатно остановить процесс. Restore-цикл (exit 42) живёт в
REM tools/start_all.bat для autostart-сценария.
cd /d "%~dp0"
python launcher.py

