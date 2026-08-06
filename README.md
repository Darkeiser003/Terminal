# WinSlim Terminal · LTerminal

Terminal multipestaña de escritorio construida sobre Electron, `node-pty` y
xterm.js. Detecta las shells, distribuciones WSL, contenedores Docker y
dispositivos Android disponibles en la máquina y los ofrece como entornos
intercambiables dentro de la misma ventana. Desde la versión 1.3 funciona
además como hub local de proyectos GitHub y como lanzador de scripts.

La aplicación se llama **WinSlim Terminal** en Windows y **LTerminal** en
Linux y macOS. No es una marca distinta: es la misma base con identidad,
`appId` y rutas de datos propias por plataforma (`main/appIdentity.js`).

| | |
|---|---|
| Versión | 1.4.1 |
| Plataformas | Windows 10/11, Linux (x64), macOS (parcial) |
| Runtime | Electron 43 · Node.js ≥ 22.12.0 |
| Licencia | UNLICENSED (privado) |
| Repositorio | https://github.com/Darkeiser003/Terminal |
| Idiomas | Español, inglés |

---

## Índice

- [Requisitos](#requisitos)
- [Instalación para usar la aplicación](#instalación-para-usar-la-aplicación)
- [Entorno de desarrollo](#entorno-de-desarrollo)
- [Scripts npm](#scripts-npm)
- [Compilación y distribución](#compilación-y-distribución)
- [Arquitectura](#arquitectura)
- [Contrato IPC](#contrato-ipc)
- [Seguridad](#seguridad)
- [Entornos y shells](#entornos-y-shells)
- [Alias y comandos integrados](#alias-y-comandos-integrados)
- [Panel de entorno y dependencias](#panel-de-entorno-y-dependencias)
- [Proyectos y GitHub](#proyectos-y-github)
- [Panel de scripts](#panel-de-scripts)
- [Explorador de archivos](#explorador-de-archivos)
- [Pestañas, división y ciclo de vida](#pestañas-división-y-ciclo-de-vida)
- [Atajos de teclado](#atajos-de-teclado)
- [Configuración](#configuración)
- [Internacionalización](#internacionalización)
- [Datos, logs y diagnóstico](#datos-logs-y-diagnóstico)
- [Pruebas](#pruebas)
- [Convenciones del código](#convenciones-del-código)
- [Problemas conocidos](#problemas-conocidos)

---

## Requisitos

**Para compilar:**

- Node.js `>=22.12.0` y npm.
- Git (para clonar).
- `node-pty` distribuye binarios precompilados; Python y las herramientas
  C/C++ solo hacen falta si npm informa de que debe compilar el módulo nativo
  en esa plataforma concreta.
- El paquete **no** incluye `node_modules/node-pty/prebuilds`: sería una
  segunda copia de los mismos binarios, porque node-pty carga primero desde
  `build/Release`, que es donde `electron-builder install-app-deps` deja el
  módulo recompilado contra el ABI de Electron. Por eso `beforePack` aborta si
  `build/Release/pty.node` no existe, en vez de producir un ejecutable que
  arranca y solo falla al abrir la primera pestaña.

**Para ejecutar:** nada más. WSL, Docker, ADB, Git, PowerShell 7, los
intérpretes de lenguajes y los visores de archivos **no forman parte del
build**: se detectan en tiempo de ejecución y, si faltan, el panel de
dependencias ofrece el comando de instalación que corresponde a ese sistema.

---

## Instalación para usar la aplicación

### Windows

Descomprimir `WinSlimTerminal-Unpacked-<versión>.zip` y ejecutar
`WinSlim Terminal.exe`. No hay instalador ni escritura en el registro.

### Linux

```bash
chmod +x LTerminal-<versión>-x86_64.AppImage
./LTerminal-<versión>-x86_64.AppImage
```

El AppImage usa runtime estático, así que no requiere FUSE 2. Sí necesita las
bibliotecas gráficas base de un escritorio Linux, como cualquier aplicación
Electron; el script de build las detecta y ofrece instalarlas si faltan.

---

## Entorno de desarrollo

```bash
git clone https://github.com/Darkeiser003/Terminal.git
cd Terminal/electron
npm ci
npm run check
npm start
```

`npm ci` dispara el `postinstall`, que reconstruye `node-pty` contra el ABI de
Electron (`electron-builder install-app-deps`) y deja la DLL de ConPTY junto al
módulo (`scripts/prepare-node-pty.js`).

Las pruebas puras no necesitan Electron y se pueden ejecutar en Linux sin
instalar dependencias en el host, con el código en solo lectura:

```bash
docker run --rm -v "${PWD}:/workspace:ro" -w /workspace/electron node:22-bookworm npm test
```

---

## Scripts npm

Todos se ejecutan desde `electron/`.

| Script | Qué hace |
|---|---|
| `npm start` | Arranca la aplicación en desarrollo (`electron .`). |
| `npm test` | Pruebas unitarias con el runner de Node (`node --test`). No necesita Electron. |
| `npm run check` | Ciclo completo de verificación: pruebas, sintaxis, traducciones, metadatos de release y configuración de build. **Es lo que hay que pasar antes de compilar.** |
| `npm run test:integration` | Arranque real de Electron sin ventana visible; comprueba que preload, renderer y PTY se inicializan y que se puede crear una segunda pestaña con otro entorno. |
| `npm run dist:win` | Empaqueta la versión desempaquetada de Windows. |
| `npm run dist:linux` | Empaqueta el AppImage de Linux. |
| `npm run postinstall` | Automático tras `npm install`/`npm ci`. |

### Qué comprueba `npm run check`

| Paso | Script | Comprueba |
|---|---|---|
| 1 | `node --test` | Las 131 pruebas unitarias. |
| 2 | `scripts/check-syntax.js` | Que todos los `.js` del proyecto parsean. |
| 3 | `scripts/validate-i18n.js` | Que no hay claves de traducción sin traducir, sobrantes, ni con parámetros descuadrados. |
| 4 | `scripts/validate-release-metadata.js` | Que los archivos publicados no filtran rutas de perfiles de Windows ni correos personales, y que la marca Linux es coherente. |
| 5 | `scripts/validate-build-config.js` | Que la configuración de empaquetado no se desvía: locales, runtime AppImage, exclusiones de `node-pty`, identidad Linux y un solo formato de salida por sistema. |

---

## Compilación y distribución

Un formato por sistema: **carpeta desempaquetada en Windows**, **AppImage en
Linux**. El portable de Windows y el `linux-unpacked` publicado se retiraron
porque duplicaban cada release sin aportar nada, y el portable bloqueaba la
carpeta de salida mientras estuviera en ejecución.

### Windows

```powershell
npm run dist:win
```

Genera en `electron/dist/`:

- `win-unpacked/WinSlim Terminal.exe`
- ZIP versionado en `dist/release/`
- `SHA256SUMS.txt`

El script `windows\build.bat -Yes -NoRun` envuelve el proceso completo:
comprueba dependencias, ejecuta `npm run check`, empaqueta, valida la
aplicación empaquetada con un arranque invisible, genera los ZIP y las huellas,
y crea los accesos directos.

> **Antes de compilar, cerrar las instancias abiertas desde
> `electron\dist\win-unpacked`**: electron-builder reemplaza esa carpeta y no
> puede sobrescribir un ejecutable en uso.

### Linux

```bash
./linux/build.sh --yes --no-run
```

Genera el AppImage, su release `.tar.gz`, las huellas SHA-256 y el acceso
`.desktop`. Ejecuta las pruebas antes de empaquetar y hace un arranque de
integración cuando dispone de servidor gráfico o `xvfb-run`. `linux-unpacked`
sigue existiendo como directorio intermedio de electron-builder y el script lo
usa para ese arranque, pero no se distribuye.

Compilar el AppImage desde Windows requiere una copia nativa dentro de WSL,
nunca sobre `/mnt/c`: `linux/build.sh` hace `npm ci` sobre `electron/`, lo que
reemplazaría el `node_modules` compilado para Windows.

### Garantías que aplican los dos scripts

Ambos comparten las mismas reglas, y cada una aborta el build si no se cumple:

| Regla | Por qué |
|---|---|
| `npm run check` **antes** de empaquetar | Comprobar después no impide publicar una build rota; solo lo cuenta más tarde. |
| Un solo formato por sistema | Si reaparece un `.exe`/`.msi` en Windows o un `.deb`/`.rpm`/`.snap` en Linux, el build falla en vez de publicarlo callando. |
| Se retiran las releases de versiones anteriores | `SHA256SUMS.txt` conserva las líneas cuyo archivo sigue existiendo. Sin limpiar, acababa describiendo varias versiones a la vez. |
| El AppImage se localiza **por versión** | Tras subir de versión, `dist/` conserva el anterior y el orden de `find` no está definido: se llegó a empaquetar el binario viejo. |
| Las huellas se verifican tras escribirlas | Windows recalcula cada hash y Linux ejecuta `sha256sum -c --strict`, lo mismo que hará quien descargue la release. |
| Compilar una plataforma **no borra** las huellas de la otra | Las dos publican en la misma `dist/release/`. Cada script conserva las líneas ajenas cuyo archivo sigue existiendo y solo regenera las propias. |
| Se mide el peso y se compara con un tope | No es para adelgazar Electron (no se puede): detecta que una exclusión se caiga de `package.json` y el paquete recupere los `.pdb`, los prebuilds duplicados o `node_modules` entero. |
| Se comprueba que Electron y `node-pty` están de verdad | npm puede dejar sin ejecutar los scripts de instalación de las dependencias. Con Electron sin binario, el fallo salía mucho después; ahora se detecta y se repone. |
| `npm` se invoca sin que un aviso lo aborte | Windows PowerShell 5.1 convierte cada línea de *stderr* en error terminante cuando la salida se redirige. Un `npm warn deprecated` dejaba `node_modules` a medias; ahora decide el código de salida. |

`electron/test/buildScripts.test.js` comprueba que estas garantías siguen en
los scripts, de modo que quitarlas rompe `npm run check`.

Windows y Linux publican en la **misma** carpeta `dist/release/`, y cada script
solo reescribe sus propias líneas de `SHA256SUMS.txt`: compilar uno no borra las
huellas del otro.

---

## Arquitectura

Dos procesos, como cualquier aplicación Electron, con una separación estricta:
**todo lo privilegiado vive en el proceso principal** y el renderer solo recibe
datos ya reducidos.

```
electron/
├── main.js                  Ciclo de vida, pestañas/PTY, ~46 handlers IPC
├── preload.js               contextBridge: única superficie renderer ↔ main
├── main/                    Lógica del proceso principal (sin DOM)
├── renderer/                Interfaz (xterm, paneles, ajustes)
├── config/
│   └── project-catalog.json Perfiles y repositorios anclados de fábrica
├── scripts/                 Validadores y preparación de node-pty
├── test/                    25 archivos de pruebas
├── build/                   Iconos (icon.ico, icon.png)
├── electron-builder.linux.js Identidad Linux, separada de la de Windows
└── package.json
```

### Modelo de estado

```
windows: Map<windowId, WindowState>
  WindowState = { win, tabs: Map<tabId, TabState>, activeTabId, envs,
                  pkgManager, viewport, installActions,
                  allowedFileItems, allowedGithubRepos, lastRelease }
  TabState   = { id, ptyProcess, ptyGeneration, envId, label, cwd,
                 outputBuffer, markerCarry, ready, pendingOutput,
                 awaitingPause, explorerPinned }
```

Cada pestaña tiene su propio PTY, pero **todas comparten un único renderer**
por ventana. Por eso casi todos los canales IPC llevan `tabId` como primer
argumento.

`ptyGeneration` resuelve las carreras al cambiar de entorno: el PTY anterior
puede seguir emitiendo eventos después de que se le mate, así que cada callback
comprueba que sigue siendo el actual antes de tocar nada.

### Módulos del proceso principal

| Módulo | Responsabilidad |
|---|---|
| `appIdentity.js` | Nombre, slug y rutas por plataforma. |
| `userDataMigration.js` | Unifica datos de rutas antiguas al arrancar. |
| `shellDetect.js` | Detección de shells, WSL, Docker, ADB, lenguajes y gestor de paquetes. |
| `wslEnv.js` | Inventario de distribuciones WSL y sus shells. |
| `dockerEnv.js` | Daemon, contenedores en ejecución e imágenes. |
| `androidEnv.js` | Dispositivos ADB y su estado de autorización. |
| `languageEnv.js` | REPL de los lenguajes instalados (Python, Node, Ruby, `jshell`, PHP, Lua, R, Groovy, Deno, Perl). |
| `aliasProfiles.js` | Genera el archivo de inicialización de cada shell: alias, marcador de limpieza, banner. |
| `packageAliases.js` | Traduce `install`/`update`/`upgrade`/`uninstall`/`remove` al gestor real. |
| `installActions.js` | Catálogo de acciones del panel de dependencias por sistema. |
| `commandNotFound.js` | Detecta «comando no encontrado» en la salida y propone la instalación. |
| `scriptLauncher.js` | Escaneo de scripts, filtros por tipo y construcción del comando de lanzamiento. |
| `fileExplorer.js` | Listado, creación, renombrado y pegado para el panel lateral. |
| `fileViewers.js` | Visor recomendado por tipo de archivo y gestores de archivos por escritorio. |
| `githubProjects.js` | API pública de GitHub, anclados, comandos git y releases. |
| `currentDir.js` | Deduce el directorio actual de cada shell a partir del prompt. |
| `spawnCwd.js` | Con qué directorio arranca cada pestaña. |
| `pathEnv.js` | Resincroniza el `PATH` del proceso y cachea `which`/`where`. |
| `systemInfo.js` | Banner de sesión estilo fastfetch, sin binarios externos. |
| `preferences.js` | Valores por defecto, temas, fuentes y validación de preferencias. |
| `settings.js` | Lectura y escritura de `settings.json`. |
| `i18n.js` | Catálogo de traducciones y resolución de idioma. |
| `logger.js` | Log rotativo a `logs/main.log`. |

### Detalles de implementación que conviene conocer

**El marcador de limpieza.** `cls` bajo ConPTY no emite ninguna secuencia de
borrado: emite un repintado línea a línea que empuja lo anterior al historial
de xterm en vez de tirarlo. Por eso la shell avisa de cada limpieza con un
cambio de título OSC 0 con sufijo aleatorio, que viaja fuera del contenido de
la pantalla y sí llega siempre. `main.js` lo intercepta, lo saca del flujo y
ordena al renderer vaciar pantalla e historial. Ver `CLEAR_MARKER` en
`aliasProfiles.js` y `splitOnClearMarker()` en `main.js`.

**Los archivos de sesión.** Los alias no se teclean en la shell: se escriben en
`%TEMP%/<slug>/<pid>/` y la shell los carga con una sola línea (`call`,
dot-source o `source`). Así no se ve la parrafada de alias al abrir la pestaña,
no queda un comando gigante en el historial y no hay límite práctico de
longitud. En cmd.exe el banner se reduce a ASCII porque la consola lo lee en su
página de códigos OEM, donde un UTF-8 se vería como galimatías.

**El tamaño inicial.** El PTY nace con el tamaño real de la ventana, no con el
80×24 de manual, y la salida pendiente no se entrega al renderer hasta que el
xterm ha medido de verdad. Sin esto, el banner y el primer prompt se escribían
con un ancho que no era el suyo y había que reflujarlos, que era de donde
salían las líneas partidas y el prompt colgado a media pantalla.

---

## Contrato IPC

El renderer **nunca** habla con Node directamente: `preload.js` expone
`window.terminalAPI` como única superficie. `test/ipcContract.test.js`
comprueba que cada canal expuesto tiene su handler.

### Invocaciones renderer → main

| Grupo | Canales |
|---|---|
| Pestañas | `tabs:list`, `tabs:create`, `tabs:close`, `tabs:activate`, `tabs:ready` |
| PTY | `pty-input`, `pty-resize` |
| Entornos | `env:list`, `env:refresh`, `env:switch` |
| Dependencias | `install:list`, `install:run` |
| Preferencias | `settings:get`, `settings:save`, `settings:reset` |
| Proyectos | `projects:state`, `projects:lookup`, `projects:pin`, `projects:chooseFolder`, `projects:openGithub`, `projects:run`, `projects:release`, `projects:downloadRelease` |
| Scripts | `scripts:list`, `scripts:listHere`, `scripts:chooseFolder`, `scripts:chooseHereFolder`, `scripts:run`, `scripts:cd`, `scripts:open`, `scripts:pickTarget` |
| Explorador | `explorer:list`, `explorer:follow`, `explorer:create`, `explorer:open`, `explorer:openDirectory`, `explorer:openDirectoryWith`, `explorer:rename`, `explorer:clip`, `explorer:paste`, `explorer:trash`, `explorer:cd` |
| Otros | `clipboard:read`, `clipboard:write`, `log:renderer-error`, `log:open-folder`, `app:renderer-ready` |

### Eventos main → renderer

| Canal | Cuándo |
|---|---|
| `pty-data` | Salida del PTY de una pestaña. |
| `pty-clear` | La shell ha ejecutado `clear`/`cls`. |
| `pty-exit` | El proceso terminó y la pestaña **no** se cierra (fallo temprano). |
| `tab-closed` | Una pestaña se cerró; incluye cuál pasa a estar activa. |
| `env-changed` | La pestaña cambió de entorno. Se emite **antes** de arrancar la sesión nueva. |
| `envs-updated` | La lista de entornos creció (Docker terminó de arrancar, se conectó un móvil). |
| `command-not-found` | La shell no encontró una herramienta conocida. |

---

## Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Fuses de Electron: `runAsNode: false`, `onlyLoadAppFromAsar`,
  `enableCookieEncryption`, sin `NODE_OPTIONS` ni argumentos de inspección.
- Navegación bloqueada salvo a la URL exacta del renderer; ventanas nuevas
  denegadas; `webview` denegado.
- Todos los permisos de Chromium denegados por política explícita.
- `stateFromEvent()` exige que el emisor sea el frame principal con la URL
  exacta antes de conceder cualquier privilegio: un iframe inyectado dentro de
  la misma ventana no hereda IPC.
- **El renderer nunca envía rutas de origen.** Las operaciones destructivas del
  explorador (renombrar, mover, borrar) parten de un identificador que el
  proceso principal valida contra el listado real de la carpeta que se está
  mostrando ahora mismo.
- Los scripts solo se pueden lanzar si pertenecen al último escaneo visible de
  esa ventana.
- Nada se ejecuta oculto: cada acción del panel **escribe su comando en la
  terminal visible**, donde el usuario lo ve y puede cancelarlo con Ctrl+C.
- Sin tokens ni credenciales. La exploración de GitHub usa la API pública
  anónima y queda sujeta a su límite de consultas.
- Las descargas de release solo aceptan `https` de una lista cerrada de hosts
  de GitHub; una redirección fuera de ellos aborta la descarga.
- Borrar va siempre a la papelera del sistema (`shell.trashItem`), nunca a un
  borrado directo, y aun así pide confirmación.

---

## Entornos y shells

El selector agrupa los entornos por familia:

| Grupo | Contenido |
|---|---|
| Shells del sistema | cmd, PowerShell, PowerShell 7, Git Bash, bash, zsh, fish, sh, distribuciones WSL y sus shells, `cmd.exe · Wine` |
| Lenguajes · intérprete interactivo | REPL de los lenguajes instalados |
| Docker · contenedores en ejecución | Entrar en un contenedor vivo |
| Docker · imágenes | Crear un contenedor nuevo y efímero |
| Android (ADB) | Un entorno por dispositivo conectado |

Cambiar de entorno **conserva la carpeta**: si en cmd estás en `C:\proyecto` y
abres WSL, la sesión empieza en `/mnt/c/proyecto`; en Git Bash, en
`/c/proyecto`. La traducción la hace cada shell a partir del directorio con el
que se lanza su proceso, sin escribir ningún `cd`. No se hereda donde no puede
funcionar: contenedores Docker (montan una carpeta fija en `/workspace`),
dispositivos ADB, y rutas UNC como `\\wsl$\...`, que cmd.exe no admite como
directorio actual.

Un **REPL no es una shell**: no recibe alias, y las acciones que escriben
comandos se enrutan a una pestaña con una shell real, abriéndola si hace falta.

---

## Alias y comandos integrados

Se inyectan al crear una pestaña, solo en shells reales.

| Alias | Qué hace |
|---|---|
| `edit`, `ip`, `ll`, `ls`, `pwd` | Vocabulario de Windows traducido a cada familia de shell. En shells Unix solo se traduce lo que no es nativo. |
| `clear`, `cls` | Limpieza real de pantalla e historial, más el banner. |
| `sysinfo` | Reimprime el banner del sistema. |
| `ayuda` | Ayuda explicada: qué hace cada alias, qué gestor los atiende y qué scripts se han registrado. Se lee de un archivo generado por sesión, así que ocupa varias líneas y va traducida. |
| `nsudo` | Solo si el ejecutable existe en la máquina. |
| `install`, `update`, `upgrade`, `uninstall`, `remove`, `search` | Se traducen al gestor de paquetes real del entorno. |
| *(uno por script)* | Cada script de la **Biblioteca** registra su propio alias. |

Los alias de gestor de paquetes se resuelven según el entorno: Windows elige
entre winget, Chocolatey o Scoop al crear la pestaña; las shells Unix eligen
entre apt, dnf, pacman, zypper, apk y brew **en el momento de invocar el
alias**, de modo que dentro de WSL manda el gestor de la distribución. `update`
sin argumentos actualiza todo el sistema; con argumentos, solo lo indicado. Se
usa `sudo` solo cuando hace falta (nunca con Homebrew, nunca si ya se es root,
y **nunca para `search`**: consultar el catálogo es de solo lectura). Si el
primer argumento es una opción (`install -m 755 origen destino`), se delega en
el programa real de coreutils.

La idea es que el vocabulario sea el mismo en todas las shells: `install git`
funciona igual en cmd, PowerShell, Git Bash, una distro WSL o un contenedor, y
quien lo escribe no necesita saber si detrás hay winget, apt o pacman. `ayuda`
lo explica en la propia sesión, diciendo además cuál le ha tocado.

---

## Panel de entorno y dependencias

Dos niveles: grupos temáticos y, dentro, un subgrupo plegable por herramienta.
De cada herramienta se ve **o** «instalar» (si falta) **o**
actualizar/desinstalar/ver versión (si está), nunca las dos mitades a la vez.

El panel solo ofrece caminos que existen de verdad en ese sistema. El caso
representativo es PowerShell en Linux: Microsoft no lo publica en los
repositorios oficiales de ninguna distribución grande, así que se instala desde
el AUR (`powershell-bin`, con `paru` o `yay`) o desde Snap, y cuando no hay
ninguna de las dos vías se ofrece antes su requisito en lugar de un comando que
se sabe que va a responder «no se ha encontrado el paquete». Wine en Arch avisa
de que vive en el repositorio `multilib`, desactivado de fábrica.

Al terminar, cada acción espera a que se pulse Enter para que su salida se
pueda leer. El siguiente comando que escriba un panel cierra esa pausa antes de
ejecutarse, para que no se consuma como respuesta.

---

## Proyectos y GitHub

**Anclados** combina el catálogo fijo de la build con los perfiles y
repositorios que cada usuario ancle. `Christianlg97` y `Darkeiser003` figuran
como perfiles fijos y no se pueden desanclar; los anclados personales sí. Los
créditos de **Ajustes › Información** salen de una lista distinta
(`developers`), de modo que un perfil puede seguir anclado con sus
repositorios sin aparecer en los créditos.

Cada panel tiene un **buscador con lupa** que filtra sin volver a consultar
nada: en **Anclados** acota perfiles y repositorios, y en **Explorar GitHub**
acota el resultado ya descargado, para no gastar peticiones de la API pública
por teclear una letra. Ignora mayúsculas y tildes y admite varios términos en
cualquier orden. `Esc` vacía el filtro sin cerrar el panel.

**Explorar GitHub** acepta un usuario, `propietario/repositorio` o una URL
HTTPS exacta de `github.com`. Se rechazan SSH, `git://`, hosts alternativos,
credenciales embebidas, puertos y segmentos adicionales.

### Dos formas de actualizar un repositorio

Cada tarjeta de repositorio ofrece las dos, y cada botón dice en su título
exactamente qué va a hacer:

| Botón | Qué actualiza | Para quién |
|---|---|---|
| **Actualizar release** | Descarga el archivo de la última release que corresponde a este sistema y lo extrae. No toca git. | Quien solo quiere **usar** la herramienta. |
| **Clonar** / **Actualizar fuente** | `git clone` la primera vez y `git pull --ff-only` después. | Quien quiere el **código**. |

**Actualizar release** elige el adjunto por él: no hay que abrir la lista y
reconocer cuál de los archivos es el propio. La elección es por puntos, no por
una regla rígida, porque cada proyecto nombra sus adjuntos a su manera
(`WinSlimTerminal-Latest.zip`, `LTerminal-AppImage-Latest-x64.x86.tar.gz`…), y
descarta de entrada los que llevan el nombre de otro sistema: un `.zip` que
diga `linux` no se ofrece en Windows. Si nada encaja **no se descarga nada a
ciegas**: se avisa de que hay que elegir a mano en **Release**.

### Clonar y actualizar el código

La primera acción ejecuta `git clone`; si el destino ya contiene el mismo
repositorio, las siguientes usan `git pull --ff-only`. Ambos comandos se
escriben y ejecutan en una pestaña visible. La estructura local es
`<carpeta>/<propietario>/<repositorio>`. Un directorio existente que no sea un
repositorio se trata como conflicto y **nunca** se sobrescribe.

### Releases

El botón **Release** consulta la última versión publicada y lista sus archivos
con tamaño, para elegir uno a mano. Descargar uno no requiere clonar ni
compilar nada.

- La descarga la hace la aplicación con el `net` de Electron (es tráfico de
  red, no un comando) y respeta el proxy del sistema.
- Destino: `<carpeta>/_releases/<propietario>/<repositorio>/<etiqueta>/`,
  separado de los clones para no mezclar un árbol de git con un ZIP
  desempaquetado.
- Si el archivo es un comprimido, el comando para extraerlo se escribe en la
  terminal visible con la herramienta que entiende ese formato en cada sistema:
  `tar`, `unzip`, `Expand-Archive` o `7z`.
- El renderer manda el **nombre** del archivo, no su URL: la descarga solo
  acepta adjuntos de la release que el proceso principal acaba de devolver.

---

## Panel de scripts

Dos ámbitos:

- **Biblioteca**: carpeta persistente elegida por el usuario, más las
  utilidades WinSlim detectadas en el sistema. Solo estos se registran como
  alias.
- **Aquí**: directorio actual de la pestaña y hasta tres niveles de
  subdirectorios por defecto, configurable entre 0 y 10. **No** crea alias ni
  modifica la shell.

El escáner mantiene topes de tiempo, carpetas y resultados (máximo 500) para no
bloquear la terminal, y omite dependencias, VCS, cachés y artefactos
(`node_modules`, `dist`, `build`, virtualenvs…).

Reconoce `.cmd`, `.bat`, `.ps1`, `.vbs`, `.sh`, `.bash`, `.zsh`, `.ksh`,
`.fish` y scripts sin extensión con shebang. Los runtimes (`.py`, `.js`,
`.mjs`, `.rb`, `.php`, `.pl`, `.lua`, `.r`, `.groovy`) solo aparecen cuando
declaran intención de ejecución: shebang, `package.json#bin`, bit ejecutable o
carpeta `scripts`/`bin`/`tools`/`cli`.

El panel tiene el mismo **buscador con lupa** que Proyectos, y actúa sobre el
último escaneo: filtra por nombre, subcarpeta o extensión sin volver a recorrer
el disco, que en **Aquí** puede costar segundos.

El filtro de tipos es una selección múltiple —CMD/BAT, PowerShell, SH/Bash/Zsh,
Fish, Python, Node.js, VBScript, otros runtimes, programas, HTML, imágenes,
audio y vídeo—. Por defecto solo están marcados los scripts: programas y
multimedia son opt-in, así que activar la vista nunca convierte **Aquí** en un
explorador de todos los archivos.

Al ejecutar un script, la aplicación reutiliza una pestaña compatible o abre
una nueva (PowerShell para `.ps1`, cmd/PowerShell para `.cmd`, la shell
correspondiente para Bash, zsh o fish). Las rutas se traducen para Git Bash,
WSL y los montajes Docker. HTML y multimedia se abren con la aplicación externa
predeterminada y nunca dentro del renderer de Electron.

---

## Explorador de archivos

`🗀` en la barra de pestañas (o `Ctrl+Shift+E`) abre un panel lateral con el
contenido del directorio actual de la pestaña, que sigue al `cd` de la terminal
hasta que se navega a mano.

Permite subir de directorio, entrar en subcarpetas, crear carpetas y archivos
vacíos, renombrar, copiar, cortar, pegar, enviar a la papelera, copiar la ruta,
abrir un archivo con la aplicación predeterminada y llevar la terminal a la
carpeta que se está viendo.

Crear algo solo se admite dentro de la carpeta mostrada: el nombre no puede
contener separadores, `..`, caracteres de control ni los nombres reservados de
Windows, y nunca se sobrescribe nada existente.

**Abrir carpeta** (menú contextual) lanza el explorador del sistema, que es
distinto de entrar en ella dentro del panel. En Linux se lanza el gestor del
escritorio en uso, deducido de `XDG_CURRENT_DESKTOP`: Dolphin en KDE, Archivos
en GNOME, Thunar en Xfce, Nemo, Caja o PCManFM según el caso. **No se delega en
`xdg-open`** porque la asociación de `inode/directory` apunta en muchos
escritorios a un emulador de terminal, y pedir «abrir carpeta» acababa abriendo
una terminal. Si no se puede deducir el escritorio y hay varios gestores, se
pregunta; si no hay ninguno, se ofrece instalar uno.

### Visores de archivos

Si al abrir un archivo el sistema no tiene ninguna aplicación asociada, la
aplicación propone instalar un visor adecuado al tipo de contenido y **espera
confirmación**. En Windows se usan ImageGlass, VLC, SumatraPDF, 7-Zip y Visual
Studio Code; en Linux sus equivalentes del gestor de paquetes; en macOS solo
los que el sistema no cubre ya con Vista Previa. Los mismos visores están en el
panel de dependencias para instalarlos sin esperar a que algo falle.

---

## Pestañas, división y ciclo de vida

`+` crea otra sesión del entorno activo. `▥` (o `Ctrl+Shift+\`) va añadiendo
sesiones a la vista: dos en columnas, tres con la tercera ocupando la fila
inferior, cuatro en cuadrantes. Al llegar a cuatro, el botón vuelve a dejar
una sola. Cada panel sigue siendo una pestaña normal; la que tiene el foco se
distingue por un borde de acento.

Cambiar de entorno no es instantáneo (una distro WSL en frío o una imagen
Docker tardan segundos), así que el panel muestra un aviso **Cargando a:
_entorno_** con un indicador en movimiento, y lo retira en cuanto la sesión
nueva da señales de vida. Si el sistema pide reducir el movimiento, el aviso
late en vez de desplazarse.

Al terminar la shell (`exit`, Ctrl+D) **la pestaña se cierra sola**, y con la
última se cierra la aplicación. La excepción es una sesión que muere en los
primeros 3 segundos con código distinto de cero: eso no es haber terminado sino
no haber podido arrancar, así que la pestaña se queda con el motivo a la vista.

El menú contextual de la terminal ofrece copiar, pegar, cortar entrada y borrar
entrada. Por seguridad, cortar y borrar solo actúan sobre una selección de una
línea que termine exactamente en el cursor de la orden actual: la salida
histórica no se puede reescribir, solo copiar.

---

## Atajos de teclado

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+T` | Nueva pestaña del entorno actual |
| `Ctrl+Shift+E` | Mostrar u ocultar el explorador de archivos |
| `Ctrl+Shift+\` | Añadir una sesión a la vista dividida (o volver a una) |
| `Ctrl+Shift+C` | Copiar la selección |
| `Ctrl+Shift+V` | Pegar |
| `Ctrl+Shift+X` | Cortar la entrada seleccionada |

---

## Configuración

Todo se edita desde **Ajustes** y persiste validado en `settings.json`; el
propio panel muestra su ruta. También se puede distribuir preconfigurado
modificando ese JSON: cualquier valor fuera de rango se recorta o se sustituye
por el predeterminado, nunca rompe la aplicación.

| Clave | Tipo · rango | Por defecto |
|---|---|---|
| `language` | `auto` \| `es` \| `en` | `auto` |
| `defaultEnvironmentId` | id de entorno | `""` (automático) |
| `themeId` | `silver`, `winslim`, `ocean`, `forest`, `amber`, `violet`, `nordic`, `crimson`, `matrix`, `contrast`, `slate`, `plum`, `teal` | `silver` |
| `accentColor` | `#rrggbb` | `#b8bec6` |
| `terminalBackground` | `#rrggbb` | `#080808` |
| `terminalForeground` | `#rrggbb` | `#d7d7d7` |
| `terminalFontFamily` | `system-mono`, `jetbrains`, `fira`, `monospace` | `system-mono` |
| `terminalFontSize` | 10–24 | `14` |
| `terminalLineHeight` | 0.9–1.8 | `1.1` |
| `terminalLetterSpacing` | −1–3 | `0` |
| `terminalCursorStyle` | `block`, `bar`, `underline` | `block` |
| `terminalFontWeight` | `normal`, `bold` | `normal` |
| `terminalCursorBlink` | booleano | `true` |
| `terminalScrollSensitivity` | 1–10 | `3` |
| `copyOnSelect` | booleano | `false` |
| `terminalPadding` | 4–24 | `10` |
| `terminalScrollback` | 1000–100000 | `5000` |
| `uiDensity` | `comfortable`, `compact` | `comfortable` |
| `showSystemBanner` | booleano | `true` |
| `scriptsHereDepth` | 0–10 | `3` |
| `autoStartDocker` | booleano | `true` |
| `exclusiveAccordionGroups` | booleano | `true` |
| `autoOpenFirstGroup` | booleano | `false` |
| `fileManagerId` | id de gestor | `""` |
| `viewportCols` | 20–1000 | `80` |
| `viewportRows` | 5–500 | `24` |

`fileManagerId`, `viewportCols` y `viewportRows` no se editan desde la interfaz:
los escribe la aplicación. Los dos últimos guardan el tamaño medido de la
terminal para que la primera sesión de la próxima ejecución nazca ya con él.

Si el entorno inicial guardado deja de existir, se usa el entorno automático
del sistema.

---

## Internacionalización

La interfaz está en español e inglés. Por defecto sigue al idioma del sistema
(`auto`); el desplegable de Ajustes permite fijar uno, y el cambio se aplica al
instante sin reiniciar. Alcanza a los paneles, el menú contextual, el
explorador, los mensajes de error y el banner de cada sesión.

**No se traduce, a propósito:** nombres propios (Docker, PowerShell, Nautilus),
rutas, comandos y su salida. Traducir un comando lo rompería, y la salida es de
los programas que ejecuta el usuario.

El catálogo vive en `main/i18n.js`. El español es el idioma de referencia: sus
cadenas están escritas en el propio código y sirven de respaldo, de modo que
una clave sin traducir se ve en español y nunca como un identificador.

### Añadir un idioma

1. Añadir una entrada a `CATALOGS` en `main/i18n.js` con las mismas claves.
2. Añadir el idioma a `LANGUAGES` para que aparezca en Ajustes.
3. `npm run check` avisa de las claves que falten, de las que sobren y de las
   que no usen los mismos parámetros que el original.

Las etiquetas del panel de dependencias se traducen por dos vías: las generadas
por molde (`action.install`, `action.updateShort`…), que cubren la mayor parte
del catálogo, y las sueltas, por el identificador estable de cada acción
(`action.<id>.label`). Las notas explicativas largas (`hint`) del catálogo de
dependencias siguen mostrándose en español mientras no se traduzcan; el
mecanismo y el validador ya las contemplan.

---

## Datos, logs y diagnóstico

| | Windows | Linux |
|---|---|---|
| `userData` | `%APPDATA%\winslim-terminal\` | `~/.config/lterminal/` |
| Configuración | `settings.json` | `settings.json` |
| Biblioteca de scripts | `scripts\` | `scripts/` |
| Logs | `logs\main.log` (rota a `main.log.1` al superar 2 MB) | ídem |
| Variable de depuración | `WINSLIM_LOG_LEVEL=debug` | `LTERMINAL_LOG_LEVEL=debug` |

El botón **Logs** abre la ruta real. Los archivos de inicialización y banner de
cada sesión van a una carpeta temporal por PID, de modo que dos instancias
abiertas a la vez no se pisan ni se borran los archivos al salir.

---

## Pruebas

131 pruebas en 25 archivos, todas con el runner de Node. Ninguna necesita
Electron ni red.

| Archivo | Cubre |
|---|---|
| `appIdentity.test.js` | Identidad y rutas por plataforma. |
| `buildScripts.test.js` | Que los scripts de build siguen aplicando sus garantías: un formato por sistema, huellas verificadas y pruebas antes de empaquetar. |
| `clearMarker.test.js` | Marcador de limpieza y su detección. |
| `currentDir.test.js` | Deducción del cwd desde el prompt. |
| `dockerEnv.test.js` | Parseo de contenedores e imágenes. |
| `fileExplorer.test.js` | Listado, creación, renombrado, pegado y validación de nombres. |
| `fileViewers.test.js` | Visores por tipo y gestores de archivos por escritorio. |
| `githubProjects.test.js` | Validación de URLs, perfiles y comandos git. |
| `i18n.test.js` | Resolución de idioma, parámetros, banner y traducción de acciones. |
| `installActions.test.js` | Catálogo por sistema, orden de apartados y vías de PowerShell. |
| `integrationLogic.test.js` | Alias, traducción de rutas y lanzamiento de scripts. |
| `ipcContract.test.js` | Que cada canal expuesto en preload tiene handler. |
| `languageEnv.test.js` | Detección de REPL. |
| `packageAliases.test.js` | Traducción de `install`/`update`/`search`/… por gestor, y el texto de `ayuda`. |
| `pathEnv.test.js` | Resincronización del PATH. |
| `pendingPause.test.js` | Que un comando de panel cierra la pausa pendiente. |
| `preferences.test.js` | Validación y recorte de preferencias, y que cada tema trae la paleta completa. |
| `releases.test.js` | Saneado de releases, hosts permitidos y comandos de extracción. |
| `rendererStability.test.js` | Menú contextual, acordeones, aviso de carga y ajustes visuales. |
| `scriptScanner.test.js` | Escaneo, filtros opt-in y profundidad. |
| `sessionBanner.test.js` | Que el banner llega también a Docker, ADB y Wine. |
| `spawnCwd.test.js` | Herencia de directorio y sus excepciones. |
| `tabLifecycle.test.js` | Cierre por `exit`, fallo temprano y tamaño inicial. |
| `userDataMigration.test.js` | Fusión de datos de rutas antiguas. |

Ejecutar un archivo suelto:

```bash
node --test test/releases.test.js
```

---

## Convenciones del código

- **JavaScript sin transpilar ni bundler.** El renderer usa `var` y `function`
  porque se carga directamente en el navegador de Electron sin paso de build.
- **Saltos de línea LF** en todo el proyecto, incluidos los `.ps1`. Un `.sh`
  con CRLF no arranca en Linux: el shebang se lee como `bash\r`. Lo garantiza
  `.gitattributes` con `* text=auto eol=lf`, que también fuerza LF al hacer
  checkout: sin él, un clon en Windows con `core.autocrlf=true` convertía
  `linux/build.sh` a CRLF y dejaba de compilar el AppImage desde WSL.
- **Comentarios en español y explicando el porqué**, no el qué. Los comentarios
  largos del código documentan decisiones no evidentes (por qué el marcador de
  limpieza viaja como título, por qué el AUR no se invoca con sudo, por qué el
  aviso de cambio de entorno va antes de arrancar la sesión).
- **Sin dependencias de runtime más allá de xterm y node-pty.** Todo lo demás
  se resuelve con el módulo estándar de Node o con herramientas del sistema.
- **Nada se ejecuta a espaldas del usuario.** Si una acción toca el sistema, su
  comando se escribe en la terminal visible.
- Antes de dar por buena una tarea: `npm run check`.

---

## Problemas conocidos

**El binario de Electron no se descarga.** Si `npm start` o
`npm run test:integration` fallan con «electron no se reconoce como un
comando», falta el binario en `node_modules/electron/dist`. Las versiones
recientes de npm dejan los scripts de instalación de las dependencias tras una
aprobación explícita (`packages have install scripts not yet covered by
allowScripts`), y cuando eso le toca a Electron `node_modules` parece completo
pero no hay binario. Los scripts de build lo detectan y lo reponen solos; a
mano:

```bash
node node_modules/electron/install.js
```

**Compilar node-pty falla con «no se reconoce como un comando interno o
externo».** El paso gyp de winpty ejecuta `cmd /c "cd shared &&
GetCommitHash.bat"`, que necesita encontrar ejecutables en el directorio
actual. Si el proceso hereda `NoDefaultCurrentDirectoryInExePath=1`, ese paso
falla y deja `node_modules/node-pty` sin `build/Release`.

`windows\build.ps1` ya neutraliza esa variable en los procesos que lanza, así
que el build automático no se topa con esto. Haciendo `npm ci` a mano sí, y la
solución es la misma:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null; npm install
```

Si node-pty ya quedó roto, borrar `node_modules\node-pty` (saliendo antes de
esa carpeta, o dará EBUSY) y reinstalar.

**electron-builder se queda esperando con «output file is locked for
writing».** Hay una instancia de la aplicación en ejecución desde
`electron\dist\win-unpacked`. Cerrarla y repetir.

**Wine no aparece como entorno en Arch.** El paquete está en el repositorio
`multilib`, desactivado en una instalación estándar. Descomentar la sección
`[multilib]` de `/etc/pacman.conf`, ejecutar `sudo pacman -Sy` y reintentar.

---

## Créditos

Desarrollado por [Christianlg97](https://github.com/Christianlg97) y
[Darkeiser003](https://github.com/Darkeiser003) para **WinSlim Project**.
