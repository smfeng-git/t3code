@echo off
cd /d "%~dp0"
python run.py run-app-owned
if errorlevel 1 pause
