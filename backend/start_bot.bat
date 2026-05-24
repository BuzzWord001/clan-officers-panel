@echo off
cd /d "%~dp0"
:loop
python launcher.py
REM код выхода 42 → restore-перезапуск
if %errorlevel% equ 42 goto loop

