@echo off
setlocal
title WinSlim Terminal - Build

REM Envoltorio para poder compilar con doble clic desde el explorador.
REM Todo el trabajo lo hace build.ps1; aqui solo se comprueba que PowerShell
REM este disponible y se le pasan los argumentos tal cual:
REM
REM   build.bat                lo normal
REM   build.bat -Installer     genera NSIS e incluye WebView2 offline
REM   build.bat -Clean         borra node_modules y target antes
REM   build.bat -SkipChecks    salta pruebas, clippy y svelte-check
REM   build.bat -AllowOfflineChecks  mantiene los tests locales sin bloquear por red
REM   build.bat -NoRun         no lanza la app al terminar
REM   build.bat -NoExtendedTests  solo ejecuta el smoke minimo de arranque
REM   build.bat -Version X.Y.Z   selecciona la version antes de compilar
REM   build.bat -Fast           build de desarrollo rapida, mas grande y con simbolos
REM   build.bat -CrossLinux     compila y prueba tambien la release Linux en WSL
REM   build.bat -Help           muestra las opciones y no modifica nada

set "SCRIPT_DIR=%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
    echo ERROR: no se encontro PowerShell en el PATH.
    echo        build.ps1 lo necesita para compilar.
    echo.
    pause >nul
    exit /b 1
)

set "HELP_MODE=0"
for %%A in (%*) do (
    if /I "%%~A"=="-Help" set "HELP_MODE=1"
    if /I "%%~A"=="-h" set "HELP_MODE=1"
)
if "%HELP_MODE%"=="1" goto invoke_build
echo Compilando WinSlim Terminal (Tauri + Rust)...
echo.

:invoke_build

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build.ps1" %*
set "BUILD_CODE=%ERRORLEVEL%"

echo.
if "%HELP_MODE%"=="1" if "%BUILD_CODE%"=="0" (
    echo Ayuda mostrada; no se ejecuto ninguna compilacion.
    echo (Puedes cerrar esta ventana^)
    pause >nul
    exit /b 0
)
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
