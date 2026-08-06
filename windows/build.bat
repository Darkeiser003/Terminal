@echo off
setlocal
title WinSlim Terminal - Build

set "SCRIPT_DIR=%~dp0"

echo Iniciando build de WinSlim Terminal...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build.ps1" %*

echo.
echo (Puedes cerrar esta ventana)
pause >nul
