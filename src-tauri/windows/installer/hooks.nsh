; Ganchos del instalador NSIS de WTerminal (bundle > windows > nsis >
; installerHooks). La plantilla de Tauri los inserta en su sitio; aquí solo
; va lo que Tauri no sabe de esta aplicación.

; Antes de borrar el programa, el propio ejecutable deshace lo que registró en
; el perfil del usuario: su carpeta y las `bin` de herramientas en el PATH de
; HKCU (solo las que añadió él), los menús «Abrir con WTerminal», App Paths, el
; protocolo wterminal:// y la marca RUNASADMIN (`platform::uninstall_cleanup`).
; En una actualización (/UPDATE) no se deshace nada: la versión nueva lo usa.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --wterminal-uninstall-cleanup'
    ${EndIf}
  ${EndIf}
!macroend

; Con la casilla «Borrar los datos de la aplicación», Tauri borra las carpetas
; con el identificador del paquete, pero WTerminal guarda lo suyo por nombre:
; ajustes y registros en %APPDATA%\wterminal, y la carpeta propia de fábrica,
; el perfil de Clink y la caché del portable en %LOCALAPPDATA%\WTerminal. Una
; carpeta propia movida a otra ruta en Ajustes no se toca nunca.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\wterminal"
    RmDir /r "$LOCALAPPDATA\WTerminal"
  ${EndIf}
!macroend
