# ConPTY para Windows

`conpty.dll` y `OpenConsole.exe` son el host de pseudoconsola de
[OpenConsole / Windows Terminal](https://github.com/microsoft/terminal)
(licencia MIT, Microsoft Corporation). Estas dos copias vienen del paquete
`node-pty`, que las redistribuye en
`prebuilds/win32-x64/conpty/`, y son las mismas que empaquetaba la versión
Electron de esta app.

## Por qué se cargan aparte y no se usa el ConPTY del sistema

`portable-pty` prueba primero a cargar un `conpty.dll` que esté junto al
ejecutable y solo cae a las funciones de `kernel32.dll` si no lo encuentra
(ver `load_conpty()` en `portable-pty/src/win/psuedocon.rs`).

El backend del sistema no sirve aquí. En Windows 10 IoT Enterprise LTSC 2021
—la clase de sistema recortado para el que está pensada esta terminal— el
proceso hijo muere nada más nacer con `STATUS_DLL_INIT_FAILED`
(`0xC0000142`): la pseudoconsola llega a crearse y emite su sonda `ESC[6n`,
pero la shell no consigue inicializarse, y `wait()` se queda bloqueado
minutos antes de devolver el error. Con estas dos copias al lado, la misma
shell arranca y termina con código 0 en unos segundos.

Es el mismo motivo por el que la versión Electron pasaba
`useConpty: true, useConptyDll: true` a node-pty en vez de dejarle usar el
backend del sistema.

## Cómo llegan hasta el ejecutable

- En desarrollo, `build.rs` las copia a `target/<perfil>/`, que es donde
  `cargo run` y `tauri dev` dejan el binario.
- En la build portable, `windows/build.ps1` y `linux/build-windows.sh` las
  copian junto al `.exe`; en el instalador NSIS, `bundle.resources` de
  `tauri.windows.conf.json` las instala junto a la aplicación.

En los dos casos acaban en la carpeta del ejecutable, que es donde
`LoadLibrary("conpty.dll")` mira primero.

## Cómo actualizarlas

Descargar una versión nueva de `Microsoft.Windows.Console.ConPTY` (o copiarla
de un `node-pty` reciente) y sustituir los dos archivos. Deben ir siempre en
pareja y de la misma versión: `conpty.dll` lanza a `OpenConsole.exe` como host.
