# WinSlim Terminal / LTerminal (1.4.4)

---

Terminal multipestaña de escritorio construida sobre Tauri 2, Rust y xterm.js.
Detecta las shells, distribuciones WSL, contenedores Docker y dispositivos
Android disponibles en la máquina y los ofrece como entornos intercambiables
dentro de la misma ventana. Funciona además como hub local de proyectos GitHub
y como lanzador de scripts.

La aplicación se llama **WinSlim Terminal** en Windows y **LTerminal** en
Linux y macOS. No es una marca distinta: es la misma base con identidad,
identificador y rutas de datos propias por plataforma (`src-tauri/src/config/identity.rs`).

| | |
|---|---|
| Versión | 1.4.4 |
| Plataformas | Windows 10/11, Linux (x64), macOS (parcial) |
| Runtime | Tauri 2 · Rust 1.77+ · Node.js ≥ 22.12.0 (solo para compilar) |
| Licencia | UNLICENSED (privado) |
| Idiomas | Español, inglés, francés, alemán, italiano, portugués, rumano, ruso, ucraniano, polaco, chino, japonés, coreano, hindi y árabe |

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

**Para usar la aplicación** no hace falta nada adicional en la distribución
instalable. En Windows, WebView2 viene con el sistema desde Windows 10; la
carpeta portable necesita que ese runtime ya exista. En Linux,
el AppImage necesita las bibliotecas de escritorio habituales (WebKitGTK), que
cualquier entorno gráfico ya tiene.

**Para compilarla**:

- **Node.js ≥ 22.12** — solo construye el frontend; la app final no lleva Node.
- **Rust ≥ 1.77** (`rustup`). Es la MSRV declarada: no se usan APIs más nuevas.
- **Linux**: las bibliotecas de desarrollo de WebKitGTK. `linux/build.sh` las
  comprueba antes de compilar y dice el comando de instalación de apt, dnf y
  pacman si falta alguna.
- **Windows**: Node.js, Rust mediante `rustup` y Visual Studio Build Tools con
  la carga de trabajo C++ y el Windows SDK. `windows/build.ps1` comprueba e
  importa automáticamente el entorno de MSVC; si falta, intenta instalarlo
  mediante WinGet y deja un mensaje claro si hay que hacerlo manualmente.
- **Compilar Windows desde Linux**: además de lo anterior, MinGW x64
  (`x86_64-w64-mingw32-gcc`) y, para el smoke opcional, Wine. El script puede
  instalar esos paquetes con el gestor de la distribución.

Para seleccionar la batería E2E al final del build hace falta además
`tauri-driver`, `WebKitWebDriver` y una sesión gráfica. El builder ofrece
`--install-e2e-driver` para instalar ambos controladores cuando sea posible
(en Windows se usa `-InstallE2eDriver`), y el paquete nativo disponible en la distribución,
o `--e2e-driver /ruta/WebKitWebDriver` para indicar un ejecutable compatible
cuando el paquete de WebKitGTK no lo incluye. Si falta cualquiera de ellos, el
script lo indica y no marca la release como verificada.

### conpty.dll

En Windows la app **necesita** `conpty.dll`, `OpenConsole.exe` y
`WebView2Loader.dll` junto al ejecutable. Los dos primeros van vendorizados en
`src-tauri/vendor/conpty/`; el tercero lo aporta la dependencia de WebView2 al
compilar para Windows. El ConPTY del sistema falla en algunos Windows
recortados con `STATUS_DLL_INIT_FAILED`, y el error tarda más de dos minutos en
aparecer: las pestañas se quedan en blanco sin decir por qué. `build.rs` copia
ConPTY en cada compilación y `windows/build.ps1` aborta si falta cualquiera de
los cuatro archivos. El detalle completo, en
`src-tauri/vendor/conpty/README.md`.

## Instalación para usar la aplicación

**Windows portable.** Se distribuye como carpeta desempaquetada: se descomprime
donde se quiera y se ejecuta `winslim-terminal.exe`. No instala WebView2, no
toca el registro y no crea accesos directos. Los binarios y la carpeta
`scripts/` tienen que ir juntos: además de `winslim-terminal.exe`,
`conpty.dll`, `OpenConsole.exe` y `WebView2Loader.dll`, esa carpeta contiene
los gestores integrados que muestra la Biblioteca.

**Windows instalable.** `npm run dist:win:installer` genera un NSIS con el
instalador offline de WebView2 incluido. Es la opción recomendada para equipos
recortados, instalaciones limpias o despliegues sin Internet.

**Linux.** Un AppImage: `chmod +x LTerminal-*.AppImage` y se ejecuta.

La aplicación consulta sus actualizaciones en su repositorio propio, que se
mantiene separado de los proyectos anclados: no aparece en la biblioteca ni se
puede clonar desde el panel como proyecto. El porqué de cada paso está en
`src-tauri/src/updater/self_update.rs`.

## Entorno de desarrollo

Desde una copia local del código:

```bash
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

Las herramientas operativas reutilizables para Docker Compose y Kubernetes viven
en `scripts/containers/`; las de red, SSH y servicios están en
`scripts/operations/`. El panel **Scripts** puede descubrirlas y ejecutarlas
directamente en la terminal.

| Script | Qué hace |
|---|---|
| `npm start` | Arranca la aplicación en desarrollo (Vite + `cargo run`). |
| `npm run check` | Ciclo completo: versión, metadatos, recursos, arquitectura, documentación, enlaces, fuentes de instalación, catálogo WinGet cuando se ejecuta en Windows, `svelte-check`, formato, análisis estático y pruebas Rust. **Es lo que hay que pasar antes de compilar.** |
| `npm run check:workspace` | Comprueba que las cachés, salidas y directorio temporal se puedan leer y escribir; detecta un `chown`/`chmod` pendiente antes de una build. |
| `npm run metadata:sync` | Propaga los datos editados en `src-tauri/config/package-metadata.json` a npm, Cargo y Tauri. |
| `npm run build` | Solo el frontend, con precomprobación de permisos y sincronización de metadatos. `LTERMINAL_SKIP_CHECKS=1` conserva Vite pero omite las sondas externas y `svelte-check`. |
| `npm run dist:win` | Ejecuta la build completa de Windows, incluida la batería de herramientas y el E2E WebDriver; comprueba recursos, valida y genera la carpeta desempaquetada y su ZIP. |
| `npm run dist:win:fast` | Compila y valida Windows sin la batería ampliada ni el E2E; sirve solo para iteraciones rápidas. |
| `npm run dist:win:installer` | Genera el instalador NSIS de Windows con WebView2 offline incluido y ejecuta la batería ampliada/E2E. |
| `npm run dist:win:linux` | Compila desde Linux el ejecutable Windows GNU x64 y verifica los binarios nativos y los scripts integrados. `--wine-smoke` requiere `WINE_SMOKE_PREFIX` apuntando a un prefijo que ya tenga WebView2 Runtime. |
| `npm run dist:linux` | Ejecuta la build Linux completa: solicita la versión, valida y genera el AppImage. |

Para una build completa y verificada, con sus comprobaciones previas y su
release comprimida, usar los scripts de `windows/` y `linux/` en vez de estos.

## Compilación y distribución

```powershell
windows\build.ps1          # o build.bat, para doble clic
```

```bash
linux/build.sh
```

Para validar la compatibilidad Windows desde Linux:

```bash
linux/build-windows.sh --wine-smoke
```

Esta ruta genera `src-tauri/target/windows-cross/x86_64-pc-windows-gnu/release/`
por defecto y usa el enlazador MinGW en un target aislado de la build Linux.
Es una comprobación reproducible de la aplicación y de sus recursos junto a
Wine; la release oficial sigue siendo la carpeta producida por
`windows/build.ps1` en Windows con MSVC. `--skip-checks` y `--no-install`
tienen el mismo sentido que en la build Linux; `--clean` elimina únicamente la
salida Windows cruzada. `LTERMINAL_WINDOWS_TARGET_DIR` permite cambiar esa
carpeta sin compartir locks con otra compilación.

Para hacer la validación cruzada completa desde Linux, incluyendo tres
arranques aislados bajo Wine:

```bash
linux/build.sh --full-tests --cross-windows
```

En Windows, `-CrossLinux` utiliza WSL. Si no existe WSL o no hay una
distribución instalada, intenta instalar WSL y Ubuntu con `winget`/`wsl.exe`;
después ejecuta dentro de WSL `linux/build.sh --full-tests
--install-e2e-driver --no-run`. Para que el E2E gráfico Linux funcione, Windows
debe disponer de WSLg:

```powershell
windows\build.ps1 -NonInteractive -FullTests -CrossLinux
```

Argumentos: `-Clean`/`--clean` borra `node_modules` y `target` antes,
`-SkipChecks`/`--skip-checks` salta todas las comprobaciones, incluidas las que
Tauri dispara dentro de `prebuild`, `-NoRun`/`--no-run` no lanza la app al
terminar. Si Windows no tiene DNS o acceso temporal a Internet, usa
`-AllowOfflineChecks`: convierte en avisos los enlaces, fuentes externas,
catálogo WinGet y registros externos, pero conserva
`svelte-check`, clippy y las pruebas Rust. Para la batería completa usa `-FullTests` en Windows
o `--full-tests`/`--extended-tests` en Linux; `--install-e2e-driver` permite
que Linux intente instalar el driver nativo de WebKitGTK cuando la distribución
lo ofrece. `-FullTests` y `-StrictTests` convierten las ausencias de herramientas
de Windows en un fallo explícito, en vez de ocultarlas como omisiones. La build Linux ejecuta por defecto la batería ampliada y prepara
automáticamente `dash`, PostgreSQL cliente, Fortran y Bottles (Flatpak); usa
`--no-extended-tests` para una compilación rápida o `--no-install` para impedir
instalaciones automáticas. En Arch/CachyOS instala solo esos paquetes y no
actualiza todo el sistema; `LTERMINAL_ALLOW_SYSTEM_UPGRADE=1` habilita la
actualización completa de `pacman` de forma explícita.

En Windows, si se ejecuta en modo interactivo sin `-FullTests`, la build pregunta
antes de lanzar la batería ampliada. Las sondas de shells y herramientas se
acumulan aunque alguna falle, de modo que el E2E no se pierde por un único
`cmd.exe` o runtime ausente; en modo estricto la build informa el fallo después
del E2E. El informe E2E se guarda en `%TEMP%\winslim-terminal-e2e-<id>.json`.

Al comenzar, los scripts de empaquetado preguntan la versión a generar y
proponen la actual; pulsar Enter la conserva. Se puede evitar el diálogo con
`-Version 1.4.4 -NonInteractive` en Windows o `--version 1.4.4` en Linux.

Cada script comprueba los requisitos, instala dependencias, pasa `npm run check`,
compila, monta el artefacto, hace una comprobación de humo (abre la app y mira
que no se cierre sola) y publica la release con su SHA-256 en `release/`.
La comprobación estricta de enlaces distingue HTTP de repositorios Git: las
URLs normales usan el timeout corto configurado y `git ls-remote` dispone de
hasta 30 segundos y reintentos propios, para no rechazar una build porque la
negociación de un repositorio grande tarde más que una petición web.
También respeta la plataforma: las fuentes AUR no bloquean una build nativa de
Windows y sí se comprueban en Linux o dentro de WSL; las URLs fijas de fixtures
de tests y el esquema remoto de Tauri no se consideran dependencias de red del
build.

Si el equipo está temporalmente sin DNS o sin acceso a Internet, se puede
comprobar y compilar con `LTERMINAL_LINK_CHECK=warn npm run check` o anteponer
`LTERMINAL_LINK_CHECK=warn` a `npm run build`, `npm run dist:linux` o
`npm run dist:win:linux`. En ese modo las URLs y los registros externos quedan
marcados como avisos y no se consideran validados; para publicar una release
conviene repetir después el ciclo estricto con red disponible. En Windows
nativo, `windows\build.ps1 -AllowOfflineChecks` aplica este modo a toda la
build, incluidas las comprobaciones que lanza `prebuild`.

### Qué produce cada build

| Plataforma | Artefacto |
|---|---|
| Windows | Carpeta desempaquetada + `WinSlimTerminal-Unpacked-<versión>.zip`; opcionalmente instalador NSIS offline |
| Linux | `LTerminal-<versión>-<arch>.AppImage` |

La build portable no genera instalador ni accesos directos. La build explícita
`dist:win:installer` sí genera NSIS porque es la que garantiza la instalación
del WebView2 Runtime.

Si se configura actualización automática más adelante, el nombre del artefacto
debe coincidir con `self_update::asset_for_platform`; de otro modo una release
no tendrá un adjunto compatible.

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
├── app/                     Arranque, estado y comandos Tauri
├── config/                  Identidad, rutas, preferencias, migración e i18n
├── environments/            Shells, WSL, Docker, Android y lenguajes
├── explorer/                Explorador y catálogo de visores
├── infrastructure/          Procesos y caché de PATH compartidos
├── packages/                Catálogo y acciones de instalación
├── platform/                Adaptadores compilados de Windows y Linux
├── projects/                GitHub y panel de proyectos
├── scripts/                 Escaneo, favoritos y lanzamiento de scripts
├── system/                  Modelos y políticas del sistema
├── terminal/                PTY, pestañas, flujo y sesiones
├── updater/                 Actualización de la aplicación
├── default_settings.toml    Valores de fábrica auditables
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
| Lenguajes · intérprete interactivo | REPL detectados bajo demanda: Python, Node.js, Ruby, Java, PHP, Lua, R, Groovy, Deno, Bun, Perl, Julia, Kotlin, C#/F#, Haskell, Scala, Clojure, Elixir, Erlang, OCaml, Racket y Rust mediante evcxr |
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
| `edit`, `ip`, `ll`, `ls`, `pwd` | Vocabulario común a todas las shells reales. El nombre y la intención son iguales; cambia únicamente el comando nativo que hay detrás. |
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

**Anclados** incluye únicamente el perfil fijo
[`Darkeiser003`](https://github.com/Darkeiser003), como referencia del proyecto.
No importa scripts ni repositorios externos de la aplicación y el repositorio interno
de actualización no forma parte de esta lista. Cada persona puede anclar sus
propios perfiles y repositorios, y quitarlos después sin restricciones. Los
créditos de **Ajustes › Información** se configuran por separado del listado de
proyectos.

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
  utilidades de la aplicación detectadas en el sistema. Solo estos se registran como
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

La sección **Acceso rápido** aparece encima de los resultados de la Biblioteca
y de **Aquí**. La estrella conserva hasta 50 scripts, aunque estén en otra
carpeta o el filtro de tipos actual no los incluya; los que ya no existen se
retiran automáticamente. Así las herramientas de uso diario siguen a un clic
sin convertir la Biblioteca en un segundo explorador.

El filtro de tipos se adapta al sistema. En Linux aparecen primero
SH/Bash/Zsh, Fish y paquetes Linux, que son los tres valores de fábrica; en
Windows, CMD/BAT, PowerShell y VBScript ocupan esas posiciones. Python,
Node.js, otros runtimes, programas, HTML, imágenes, audio y vídeo siguen
siendo opt-in, así que activar la vista nunca convierte **Aquí** en un
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

Los valores de fábrica viven en `src-tauri/default_settings.toml`; Cargo los
incluye en el binario y los valida al iniciar. La versión se sincroniza entre
`package.json`, `package-lock.json`, `Cargo.toml` y `Cargo.lock`; los scripts
de empaquetado la solicitan y `npm run check:version` evita divergencias.

Los metadatos editables del paquete viven en
`src-tauri/config/package-metadata.json`: nombre, binario, identificador,
descripciones, marca, autor, licencia, copyright, repositorio, web, correo de
soporte y créditos. La web puede quedar vacía si no se usa. Los créditos que
deban aparecer dentro de la app se indican como usuarios de GitHub. Tras
editarlos, ejecutar
`npm run metadata:sync`.

| Clave | Tipo · rango | Por defecto |
|---|---|---|
| `language` | `auto` \| 15 idiomas disponibles | `auto` |
| `defaultEnvironmentId` | id de entorno | `""` (automático) |
| `themeId` | `silver`, `winslim`, `ocean`, `forest`, `amber`, `violet`, `nordic`, `crimson`, `matrix`, `contrast`, `slate`, `plum`, `teal` | `silver` |
| `accentColor` | `#rrggbb` | `#b8bec6` |
| `terminalBackground` | `#rrggbb` | `#080808` |
| `terminalForeground` | `#rrggbb` | `#d7d7d7` |
| `terminalFontFamily` | Sistema, JetBrains Mono, Fira Code, Hack, Source Code Pro, IBM Plex Mono, Iosevka, Victor Mono, Ubuntu Mono, Inconsolata, Monaspace o monoespaciada genérica | `system-mono` |
| `terminalFontSize` | 10–24 | `13` |
| `terminalLineHeight` | 0.9–1.8 | `1.1` |
| `terminalLetterSpacing` | −1–3 | `0` |
| `terminalCursorStyle` | `block`, `bar`, `underline`, `beam`, `underline-thick` | `block` |
| `terminalFontWeight` | `light`, `normal`, `medium`, `semibold`, `bold` | `normal` |
| `terminalCursorBlink` | booleano | `true` |
| `terminalScrollSensitivity` | 1–10 | `3` |
| `copyOnSelect` | booleano | `true` |
| `terminalPadding` | 4–24 | `10` |
| `terminalScrollback` | 1000–100000 | `5000` |
| `fastfetchColor` | `#rrggbb` | color del banner de información del sistema |
| `terminalCursorColor` | `#rrggbb` | color del cursor |
| `uiDensity` | `comfortable`, `compact` | `comfortable` |
| `showSystemBanner` | booleano | `true` |
| `scriptsHereDepth` | 0–10 | `3` |
| `autoStartDocker` | booleano | `true` |
| `exclusiveAccordionGroups` | booleano | `true` |
| `autoOpenFirstGroup` | booleano | `false` |
| `fileManagerId` | id de gestor | `""` |
| `viewportCols` | 20–1000 | `80` |
| `viewportRows` | 5–500 | `24` |
| `defaultScriptEnvironmentId` | id de entorno | `""` (automático) |

`fileManagerId`, `viewportCols` y `viewportRows` no se editan desde la interfaz:
los escribe la aplicación. Los dos últimos guardan el tamaño medido de la
terminal para que la primera sesión de la próxima ejecución nazca ya con él.

Si el entorno inicial guardado deja de existir, se usa el entorno automático
del sistema.

---

## Internacionalización

La interfaz está disponible en 15 idiomas. Por defecto sigue al idioma del sistema
(`auto`); el desplegable de Ajustes permite fijar uno, y el cambio se aplica al
instante sin reiniciar. Alcanza a los paneles, el menú contextual, el
explorador, los mensajes de error y el banner de cada sesión.

**No se traduce, a propósito:** nombres propios (Docker, PowerShell, Nautilus),
rutas, comandos y su salida. Traducir un comando lo rompería, y la salida es de
los programas que ejecuta el usuario.

Los catálogos viven en `src-tauri/locales/*.json`. El español es el idioma de
referencia y sirve de respaldo, de modo que una clave sin traducir se ve en
español y nunca como un identificador.

### Añadir un idioma

1. Añadir un catálogo JSON a `src-tauri/locales/` con las mismas claves.
2. Añadir el idioma a `LANGUAGES` en `src-tauri/src/config/i18n.rs` para que
   aparezca en Ajustes.
3. Ejecutar `npm run check:i18n`; avisa de las claves que falten, de las que
   sobren y de los usos de interfaz sin respaldo en el catálogo español.

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

Los registros llevan hora UTC con milisegundos, identificador de sesión y
metadatos JSON. Se anotan la migración, el arranque, cada PTY, duración de
procesos y cierre. Para investigar una sesión concreta se puede usar
`LTERMINAL_LOG_LEVEL=debug` en Linux o `WINSLIM_LOG_LEVEL=debug` en Windows.

También se registran métricas segmentadas del WebView: `sinceStartMs` es el
tiempo desde que cargó el frontend y `durationMs` la operación concreta.
Incluyen `app.initial-load`, `app.ui-shell-visible`, disponibilidad para
escribir, `fastfetch.banner-visible` y
`fastfetch.banner-visible-after-terminal`, montaje y resize de cada terminal,
repintado del banner, `ui.panel.visible` para cada menú/panel e `ipc.*` para
cada llamada relevante al backend. Las entradas de teclado, parseo de cada
tecla y cada píxel de resize se agrupan para no inundar el archivo.

El smoke guarda además un informe JSON en `/tmp/lterminal-smoke-<token>.json`
con las métricas agrupadas por operación: repeticiones, mínimo, máximo y
media. Así se puede distinguir, por ejemplo, cuánto tardó en aparecer la
ventana, cuánto tardó el banner de una pestaña concreta y cuánto tardó una
descarga o un panel, sin mezclarlo con la duración total de las pruebas.

El smoke espera eventos reales de WebDriver, del compositor y del repintado
del banner, sin repetir comandos de shell después de cada resize. Esto reduce
el tiempo de la batería sin quitar tamaños, paneles ni estados de ventana.
Para investigar específicamente la ruta de teclado de `sysinfo` se puede usar
`E2E_FORCE_SHELL_REFRESH=1 npm run e2e`; también admite `E2E_WM_TIMEOUT_MS`,
`E2E_POLL_INTERVAL_MS`, `E2E_FOCUS_SETTLE_MS` y `E2E_COMMAND_SETTLE_MS` para
diagnosticar máquinas especialmente lentas.

## Perfiles portables y plugins

Desde Ajustes se puede exportar un perfil `.lterminal-profile` en Linux,
`.winslim-profile` en Windows o un instalador
reproducible `.sh`/`.ps1`. El script explica lo que guarda, no incluye
contraseñas, tokens, claves privadas ni binarios, comprueba el sistema y la
arquitectura, verifica la descarga cuando GitHub publica `SHA256SUMS.txt` y
busca una instalación existente antes de instalar la aplicación. Después
importa la configuración y los manifests de plugins declarativos.

Los plugins actuales son una base segura para ampliar la terminal: solo
declaran intérpretes y tecnologías, no cargan código nativo. El formato se
valida al instalar `plugin.json` y sus límites están implementados en
`src-tauri/src/config/plugins.rs`; se pueden instalar desde Ajustes ›
Comportamiento.

---

## Pruebas

```bash
npm run check
```

Pasa la verificación de versión, recursos, arquitectura, scripts de build,
enlaces locales de documentación, traducciones, superficie de tests y
superficie lógica, `svelte-check`, `cargo fmt --check`, `cargo clippy -D warnings`
y los tests de Rust. Es lo que tiene que estar en verde antes de compilar.

La build Linux ejecuta por defecto la batería ampliada. Además del smoke test
de ventana/frontend/PTY, comprueba shells y herramientas instaladas y ejecuta
E2E con `tauri-driver`; si falta una precondición, el build falla indicando
cuál es. Se puede omitir con `linux/build.sh --no-extended-tests`; en Windows
se fuerza con `windows/build.ps1 -FullTests`. La falta del driver E2E sí detiene
la batería gráfica. El smoke recorre
Ajustes, Biblioteca, Proyectos, Entorno y dependencias, acordeones, explorador
y menú contextual, comandos internos, respuesta de la shell, división y
varios tamaños de ventana. También repite refrescos de entornos, clics de
división y aperturas de paneles para detectar carreras y estados residuales.
La ruta Linux→Windows repite el arranque Wine con prefijos independientes; la
ruta Windows→Linux repite el mismo build y E2E dentro de WSLg.

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

**Las pestañas se quedan en blanco en Windows.** Falta `conpty.dll` o
`WebView2Loader.dll` junto al ejecutable. El ConPTY del sistema falla en algunos
Windows recortados y tarda más de dos minutos en devolver el error. Los cuatro
archivos de la carpeta desempaquetada tienen que ir juntos.

**El inventario de WSL sale incompleto.** La sonda rápida solo identifica la
distro; al abrir Dependencias se enumeran también `/usr/local/bin`, las rutas de
usuario, `~/.cargo/bin`, `~/.local/bin`, npm global, nvm, asdf/mise, Volta, Bun y
Deno. Así los lenguajes instalados con gestores de versiones no vuelven a
aparecer como faltantes. Si `wsl.exe -d <distro> -- printenv SHELL` no responde,
la distro aparece igualmente en el selector como «(sin comprobar)».

**Virtualización en Windows.** KVM, libvirt y virt-manager son componentes de
Linux y, cuando procede, se ofrecen dentro de WSL. Windows nativo dispone de
acciones separadas para Hyper-V, Virtual Machine Platform y Windows Sandbox,
además de QEMU, VirtualBox y VMware Workstation Pro. No se presentan como si
fueran KVM nativo: cada opción indica sus requisitos, edición de Windows y
reinicio necesario.

**Catálogo WinGet.** En Windows `npm run check:winget` consulta todos los
identificadores del catálogo con `winget show --exact` antes de compilar. Esto
detecta IDs retirados o mal escritos; la descarga real sigue dependiendo de que
el manifiesto del editor esté vigente, por lo que un error HTTP del proveedor
queda registrado por WinGet y no se confunde con un fallo de la aplicación. Las
consultas se hacen en serie para evitar locks de la caché de WinGet y, si alguna
falla, se actualiza la fuente una vez y se reintenta antes de detener la build.
Si también falla esa actualización, la comprobación no inventa un diagnóstico:
en Windows hay que revisar `winget source list` y, si la fuente está dañada,
ejecutar `winget source reset --force` seguido de `winget source update`. El
reset devuelve las fuentes a las predeterminadas y puede quitar fuentes
personalizadas.
Maven, Gradle, Ant, Dart y el compilador de Kotlin no se anuncian con esos IDs
fiables en WinGet; sus acciones de Windows usan Chocolatey como vía alternativa
y preparan el gestor si todavía no está instalado. Dart documenta oficialmente
ese procedimiento. PostgreSQL usa el ID versionado `PostgreSQL.PostgreSQL.18`
que publica la fuente actual y, si WinGet no puede instalarlo, prueba el paquete
`postgresql` de Chocolatey. El panel indica expresamente cuándo interviene
Chocolatey porque es una fuente comunitaria, no un manifiesto de WinGet.
VMware Workstation Pro tampoco se intenta buscar con WinGet: se abre su descarga
oficial en el portal de Broadcom, que requiere iniciar sesión y completar la
descarga manualmente.

Para ampliar el catálogo de lenguajes de Windows sin fingir que existe un
instalador nativo para cada ecosistema, también se ofrecen Haxe, Octave, Racket,
SBCL, SWI-Prolog y SQLite mediante WinGet. OCaml se ofrece como paquete UCRT64
independiente de MSYS2. GCC, GFortran y GDB se instalan como
toolchain UCRT64 de MSYS2 y se añade su `ucrt64\\bin` al PATH del usuario; la
acción busca la raíz real de MSYS2 en vez de asumir una única carpeta. Haskell
usa GHCup y su bootstrap oficial de PowerShell, que puede instalar GHC, Cabal,
Stack y HLS. AutoHotkey v2 también tiene instalador WinGet y una detección que
contempla instalaciones fuera del PATH. Las fuentes alternativas solo se
ofrecen cuando tienen una sonda posterior verificable, y no se convierten en
instaladores Linux ni en acciones de WSL por accidente.

**El panel de dependencias tarda un par de segundos en abrir.** Refleja el
estado actual del sistema, no el del arranque: consulta el PATH y comprueba unas
treinta herramientas. La detección de virtualización y el inventario de WSL sí
están cacheados.

**El primer arranque tras compilar puede tardar.** El antivirus inspecciona un
ejecutable recién creado.

## Créditos

Desarrollado por [Darkeiser003](https://github.com/Darkeiser003).
