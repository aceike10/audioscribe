@echo off
rem AudioScribe installer for Windows: runs windows\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1"
pause
