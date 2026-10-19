@echo off
title Arachne
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
