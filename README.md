# WinSlim Terminal · LTerminal

---

<img width="1226" height="833" alt="image" src="https://github.com/user-attachments/assets/ff5f6674-d2ce-4aaa-859d-2644b392f930" />

---

Terminal multipestaña de escritorio construida sobre Tauri 2, Rust y xterm.js.
Detecta las shells, distribuciones WSL, contenedores Docker y dispositivos
Android disponibles en la máquina y los ofrece como entornos intercambiables
dentro de la misma ventana. Funciona además como hub local de proyectos GitHub
y como lanzador de scripts.

La aplicación se llama **WinSlim Terminal** en Windows y **LTerminal** en
Linux y macOS. No es una marca distinta: es la misma base con identidad,
identificador y rutas de datos propias por plataforma (`src-tauri/src/identity.rs`).

| | |
|---|---|
| Versión | 1.4.2 |
| Plataformas | Windows 10/11, Linux (x64), macOS (parcial) |
| Runtime | Tauri 2 · Rust 1.77+ · Node.js ≥ 22.12.0 (solo para compilar) |
| Licencia | UNLICENSED (privado) |
| Repositorio | https://github.com/Darkeiser003/Terminal |
| Idiomas | Español, inglés |

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

**Para usar la aplicación** no hace falta nada: el paquete trae todo lo que
necesita. En Windows, WebView2 viene con el sistema desde Windows 10; en Linux,
el AppImage necesita las bibliotecas de escritorio habituales (WebKitGTK), que
cualquier entorno gráfico ya tiene.

**Para compilarla**:

- **Node.js ≥ 22.12** — solo construye el frontend; la app final no lleva Node.
- **Rust ≥ 1.77** (`rustup`). Es la MSRV declarada: no se usan APIs más nuevas.
- **Linux**: las bibliotecas de desarrollo de WebKitGTK. `linux/build.sh` las
  comprueba antes de compilar y dice el comando de instalación de apt, dnf y
  pacman si falta alguna.
- **Windows**: nada más. El toolchain MSVC lo instala `rustup`.

### conpty.dll

En Windows la app **necesita** `conpty.dll` y `OpenConsole.exe` junto al
ejecutable, y van vendorizados en `src-tauri/vendor/conpty/`. El ConPTY del
sistema falla en algunos Windows recortados con `STATUS_DLL_INIT_FAILED`, y el
error tarda más de dos minutos en aparecer: las pestañas se quedan en blanco sin
decir por qué. `build.rs` las copia en cada compilación y `windows/build.ps1`
aborta si no están. El detalle completo, en `src-tauri/vendor/conpty/README.md`.

## Instalación para usar la aplicación

**Windows.** Se distribuye como carpeta desempaquetada: se descomprime donde se
quiera y se ejecuta `winslim-terminal.exe`. No hay instalador, no toca el
registro y no crea accesos directos. Los tres archivos de la carpeta
(`winslim-terminal.exe`, `conpty.dll`, `OpenConsole.exe`) tienen que ir juntos.

**Linux.** Un AppImage: `chmod +x LTerminal-*.AppImage` y se ejecuta.

La aplicación se actualiza sola. Al arrancar comprueba si hay una versión más
reciente publicada y, si la hay, la descarga **donde ya está instalada**, la
aplica y se reinicia. También se puede buscar a mano desde
**Ajustes › Información**. El porqué de cada paso está en
`src-tauri/src/self_update.rs`.

## Entorno de desarrollo

```bash
git clone https://github.com/Darkeiser003/Terminal.git
cd Terminal
npm ci
npm start
```

`npm start` levanta Vite y compila el backend con `cargo`, y abre la ventana con
recarga en caliente del frontend. La primera compilación de Rust tarda varios
minutos; las siguientes son incrementales.

El puerto de Vite es fijo (1420) y `strictPort` está activo a propósito:
`tauri.conf.json` apunta a esa URL, y que Vite se moviera solo a otro puerto
dejaría la ventana en blanco sin decir por qué. Si queda ocupado de una
ejecución anterior, hay que liberarlo antes.

## Scripts npm

Todos se ejecutan desde la raíz del repositorio.

| Script | Qué hace |
|---|---|
| `npm start` | Arranca la aplicación en desarrollo (Vite + `cargo run`). |
| `npm run check` | Ciclo completo de verificación: `svelte-check`, `cargo fmt --check`, `cargo clippy -D warnings` y `cargo test`. **Es lo que hay que pasar antes de compilar.** |
| `npm run build` | Solo el frontend (`svelte-check` + `vite build`). |
| `npm run dist:win` | Compila la versión de Windows sin empaquetar. |
| `npm run dist:linux` | Compila el AppImage. |

Para una build completa y verificada, con sus comprobaciones previas y su
release comprimida, usar los scripts de `windows/` y `linux/` en vez de estos.

## Compilación y distribución

```powershell
windows\build.ps1          # o build.bat, para doble clic
```

```bash
linux/build.sh
```

Argumentos: `-Clean`/`--clean` borra `node_modules` y `target` antes,
`-SkipChecks`/`--skip-checks` salta las comprobaciones, `-NoRun`/`--no-run` no
lanza la app al terminar.

Cada script comprueba los requisitos, instala dependencias, pasa `npm run check`,
compila, monta el artefacto, hace una comprobación de humo (abre la app y mira
que no se cierre sola) y publica la release con su SHA-256 en `release/`.

### Qué produce cada build

| Plataforma | Artefacto |
|---|---|
| Windows | Carpeta desempaquetada + `WinSlimTerminal-Unpacked-<versión>.zip` |
| Linux | `LTerminal-<versión>-<arch>.AppImage` |

Una sola cosa por plataforma, a propósito. **No** se genera instalador NSIS, ni
MSI, ni portable, ni `.deb`, ni `.rpm`, ni accesos directos. El razonamiento
está en `src-tauri/BUNDLE.md`.

El nombre del artefacto no es libre: es el que busca el actualizador de la
propia app al elegir el adjunto de una release
(`self_update::asset_for_platform`). Publicar con otro nombre deja la
actualización automática sin nada que descargar.

### Comprobaciones que hacen los scripts, y por qué

| Comprobación | Por qué está |
|---|---|
| Nada en marcha (puerto 1420, proceso de la app) | Windows no deja borrar un archivo en uso y `npm ci` empieza vaciando `node_modules`: con un servidor de desarrollo abierto falla con un `EPERM` sobre `esbuild.exe` que no dice cuál es la causa. |
| `conpty.dll` presente en `vendor/` | Sin ella la app compila igual y luego no abre ni una pestaña. |
| WebKitGTK (Linux) | Su ausencia son cientos de líneas de error de enlazado a mitad de la compilación. |
| Solo el artefacto esperado | Un `.deb` que se cuele acabaría publicado en una release sin que nadie lo haya probado. |
| Comprobación de humo | Que compile no significa que arranque. |

## Arquitectura

Dos lados con una separación estricta: un backend en Rust que es el único que
toca el sistema, y un frontend en Svelte que solo pinta.

```
src-tauri/src/
├── lib.rs                   Arranque, ventana y registro de comandos
├── commands*.rs             Los comandos que el frontend puede invocar
├── tabs.rs · pty.rs         Pestañas y su pty (portable-pty)
├── environments.rs          Detección de shells, WSL, Docker, ADB, lenguajes
├── install_actions.rs       Catálogo de dependencias instalables
├── scripts/ · file_explorer.rs · github.rs
├── console_ui.rs            Cómo se ve en la terminal lo que ejecuta la app
├── self_update.rs           Actualización de la propia aplicación
└── locales/                 Catálogos de traducción

src/
├── lib/api.ts               Único punto que conoce los nombres de los comandos
├── lib/appState.svelte.ts   Estado compartido de la interfaz
└── components/              Terminal, barra, y los cinco paneles
```

### Reglas que atraviesan todo el backend

- **El frontend nunca manda una ruta que el backend no le haya dado antes.** Lo
  que se ejecuta, se abre o se borra tiene que estar en la lista blanca del
  último escaneo. Una ruta suelta se rechaza.
- **Nada se ejecuta a escondidas.** Lo que un panel «hace» es escribir un
  comando en la terminal visible, con su cabecera y su resultado. El usuario lo
  lee entero antes de que pase nada y puede cancelarlo con Ctrl+C.
- **Los comandos lentos no bloquean la ventana.** En Tauri un comando síncrono
  se ejecuta en el hilo principal, que es el que pinta. Los 40 que tocan disco,
  red o lanzan procesos llevan `#[tauri::command(async)]`. Se quedan en el hilo
  principal los rápidos y **`pty_input`**, que además tiene que conservar el
  orden de las pulsaciones.

## Contrato IPC

`src/lib/api.ts` ocupa el sitio que tenía `preload.js`: es el único punto del
frontend que conoce los nombres de los comandos y la forma de sus cargas. El
resto de la interfaz no llama nunca a `invoke` ni a `listen` directamente.

Ese acuerdo es por convención de nombres, no por tipos, así que hay **dos
pruebas en `lib.rs`** que leen el bloque `generate_handler!` y `api.ts` y los
cotejan en las dos direcciones: un comando registrado sin función que lo llame,
o una función que invoque un comando inexistente, rompen la suite. Sin ellas, el
fallo no se vería hasta escribir el panel que lo necesitaba.

## Seguridad

- **Sin `withGlobalTauri`.** El frontend no tiene acceso global al puente: solo
  a los comandos que `api.ts` importa explícitamente.
- **CSP estricta**: `default-src 'none'`, sin `connect-src` a nada que no sea el
  propio IPC. El frontend no puede hacer peticiones de red por su cuenta.
- **`dragDropEnabled: false`**: arrastrar un archivo sobre la ventana no
  reemplaza la interfaz por él.
- **`freezePrototype` desactivado a propósito.** Congelar `Object.prototype`
  deja la ventana en negro: el frontend no llega a montarse.
- **Descargas acotadas.** Solo se descargan adjuntos de una release que se acaba
  de consultar, comprobando cada redirección contra los hosts de GitHub, con
  tope de tamaño aplicado mientras se escribe.
- **Sin tokens.** La integración con GitHub usa solo la API pública.

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
repositorios que cada usuario ancle. En Windows (WinSlim Terminal) figuran como
perfiles fijos `Darkeiser003`, `Christianlg97` y `tiranosaurio73`; en Linux y
macOS (LTerminal) solo `Darkeiser003`. Los fijos no se pueden desanclar; los
anclados personales sí. Los
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

- La descarga la hace la aplicación con `reqwest` (es tráfico de
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
predeterminada y nunca dentro de la ventana de la aplicación.

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

```bash
npm run check
```

Pasa `svelte-check`, `cargo fmt --check`, `cargo clippy -D warnings` y los tests
de Rust. Es lo que tiene que estar en verde antes de compilar.

Los tests viven junto al módulo que prueban, en su `mod tests`. Están escritos
en español y sus nombres son frases que dicen qué garantiza cada uno, no qué
función llaman:

```rust
fn instalar_y_actualizar_nunca_se_ofrecen_a_la_vez_para_la_misma_herramienta()
fn el_archivo_descargado_no_puede_acabar_junto_al_ejecutable()
fn con_hipervisor_en_marcha_no_se_manda_a_nadie_a_la_bios()
```

Varios documentan un fallo real que se encontró probando contra el sistema, para
que no vuelva. No dependen de lo que haya instalado en la máquina: lo que
consulta al sistema se inyecta para poder simularlo.

## Convenciones del código

- **Comentarios y nombres de test en español**, y explican el *porqué*, no el
  qué. Un comentario que repite lo que hace la línea siguiente sobra.
- **Cada módulo de Rust abre diciendo de dónde viene.** Los `//! Port de
  electron/main/<archivo>.js` se refieren al árbol de Electron que se retiró al
  cerrar la migración; sigue estando en el historial de git.
- **Tablas de datos alineadas** con `#[rustfmt::skip]`: son datos, y se leen
  mejor en columnas.
- **El frontend no llama a `invoke` directamente**: todo pasa por `api.ts`.
- **Sin dependencias de runtime más allá de las imprescindibles.** Tres crates
  sustituyen algo que Node traía de serie: `sysinfo`, `reqwest` y
  `portable-pty`.

## Problemas conocidos

**Las pestañas se quedan en blanco en Windows.** Falta `conpty.dll` junto al
ejecutable. El ConPTY del sistema falla en algunos Windows recortados y tarda
más de dos minutos en devolver el error. Los tres archivos de la carpeta
desempaquetada tienen que ir juntos.

**El inventario de WSL sale incompleto.** Sondear cada distro tiene un plazo de
3 segundos, y en algunas máquinas `wsl.exe -d <distro> -- printenv SHELL` tarda
más. La distro aparece igualmente en el selector, con la etiqueta «(sin
comprobar)» y su shell por defecto, y se abre con normalidad.

**El panel de dependencias tarda un par de segundos en abrir.** Refleja el
estado actual del sistema, no el del arranque: consulta el PATH y comprueba unas
treinta herramientas. La detección de virtualización y el inventario de WSL sí
están cacheados.

**El primer arranque tras compilar puede tardar.** El antivirus inspecciona un
ejecutable recién creado.

## Créditos

Desarrollado por [Christianlg97](https://github.com/Christianlg97) y
[Darkeiser003](https://github.com/Darkeiser003) para **WinSlim Project**.
