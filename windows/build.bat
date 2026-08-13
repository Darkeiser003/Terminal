@echo off
setlocal
title LTerminal - Build

REM Envoltorio para poder compilar con doble clic desde el explorador.
REM Todo el trabajo lo hace build.ps1; aqui solo se comprueba que PowerShell
REM este disponible y se le pasan los argumentos tal cual:
REM
REM   build.bat                lo normal
REM   build.bat -Clean         borra node_modules y target antes
REM   build.bat -SkipChecks    salta pruebas, clippy y svelte-check
REM   build.bat -NoRun         no lanza la app al terminar

set "SCRIPT_DIR=%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
    echo ERROR: no se encontro PowerShell en el PATH.
    echo        build.ps1 lo necesita para compilar.
    echo.
    pause >nul
    exit /b 1
)

echo Compilando LTerminal (Tauri + Rust)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build.ps1" %*
set "BUILD_CODE=%ERRORLEVEL%"

echo.
if "%BUILD_CODE%"=="0" (
    echo Build completada.
) else (
    echo La build fallo con codigo %BUILD_CODE%. Revisa los mensajes de arriba.
)

echo (Puedes cerrar esta ventana)
pause >nul
REM El codigo de salida se propaga: asi un lanzador o una tarea programada
REM pueden distinguir una build correcta de una fallida.
exit /b %BUILD_CODE%
