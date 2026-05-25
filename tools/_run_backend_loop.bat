@echo off
REM Бесконечный цикл backend с перезапуском при exit code 42 (restore-rerun).
REM Вызывается из tools\start_all.bat — отдельный батник нужен потому что
REM метки :loop / goto НЕ работают внутри `cmd /c "..."` одной строкой.
cd /d "%~dp0\..\backend"
:loop
python launcher.py
REM if errorlevel 42 — ИСТИНА при exit code >= 42, а нам надо РОВНО 42.
REM Используем %ERRORLEVEL% (доступен после процесса).
if "%ERRORLEVEL%" == "42" goto loop
REM Другие коды выхода — НЕ рестартим, чтобы lock-конфликт (exit 2) или
REM штатный shutdown не зацикливали процесс.
exit /b %ERRORLEVEL%
