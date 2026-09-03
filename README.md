# WinSlim Terminal / LTerminal (1.4.4)

---

Terminal multipestaña de escritorio construida sobre Tauri 2, Rust y xterm.js.
Detecta las shells, distribuciones WSL, contenedores Docker y dispositivos
Android disponibles en la máquina y los ofrece como entornos intercambiables
dentro de la misma ventana. Funciona además como hub local de proyectos GitHub
y como lanzador de scripts.

La aplicación se llama **WinSlim Terminal** en Windows y **LTerminal** en
Linux. No es una marca distinta: es la misma base con identidad,
identificador y rutas de datos propias por plataforma (`src-tauri/src/config/identity.rs`).

Este README concentra la documentación técnica, el flujo de ejecución, los
contratos de seguridad y la matriz de pruebas mantenida del repositorio.

| | |
|---|---|
| Versión | 1.4.4 |
| Plataformas | Windows 10/11 (x64), Linux (x64) |
| Runtime | Tauri 2 · Rust 1.77+ · Node.js ≥ 22.12.0 (solo para compilar) |
| Licencia | UNLICENSED (privado) |
| Idiomas | Español, inglés, francés, alemán, italiano, portugués, rumano, ruso, ucraniano, polaco, chino, japonés, coreano, hindi y árabe |

## Índice

- [Requisitos](#requisitos)
- [Instalación para usar la aplicación](#instalación-para-usar-la-aplicación)
- [Entorno de desarrollo](#entorno-de-desarrollo)
- [Limpieza del repositorio](#limpieza-del-repositorio)
- [Scripts npm](#scripts-npm)
- [Compilación y distribución](#compilación-y-distribución)
- [Arquitectura](#arquitectura)
- [Flujos de ejecución y diagnóstico](#flujos-de-ejecución-y-diagnóstico)
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
- **Windows**: Node.js y Rust mediante `rustup`. Visual Studio Build Tools con
  la carga de trabajo C++ y el Windows SDK son la ruta recomendada. `windows/build.ps1`
  importa automáticamente el entorno de MSVC y, si no está disponible, acepta el
  `rust-lld.exe` incluido en el toolchain para la build portable `--no-bundle`.
  El instalador NSIS puede seguir necesitando las herramientas de Visual Studio
  según los recursos nativos que se empaqueten.
- **Compilar Windows desde Linux**: además de lo anterior, MinGW x64
  (`x86_64-w64-mingw32-gcc`) y, para el smoke opcional, Wine. El script puede
  instalar esos paquetes con el gestor de la distribución.

Para ejecutar la batería E2E al final del build hace falta además
`tauri-driver`, un controlador nativo compatible y una sesión gráfica. En
Windows no hace falta instalar el navegador Microsoft Edge: el builder instala
`tauri-driver` con Cargo si falta, detecta la versión registrada de WebView2
Runtime y descarga en `src-tauri/target/e2e-driver/` el `msedgedriver.exe`
compatible. Se puede usar un driver preparado manualmente mediante
`TAURI_NATIVE_DRIVER=C:\ruta\msedgedriver.exe`; `-InstallE2eDriver` sigue
aceptándose por compatibilidad, pero ya no es necesario. En Linux, `--install-e2e-driver`
instala los controladores cuando sea posible y `--e2e-driver
/ruta/WebKitWebDriver` permite indicar el ejecutable nativo si la distribución
no lo incluye. Si una precondición no puede prepararse, el script lo indica y
no marca la release como verificada.

### Wine para la validación cruzada

Para compilar el ejecutable Windows desde Arch/CachyOS e inspeccionarlo bajo
Wine, instala las herramientas de la cadena cruzada y del entorno gráfico:

```bash
sudo pacman -S --needed mingw-w64-gcc wine winetricks cabextract unzip xdotool xorg-server-xvfb openbox
rustup target add x86_64-pc-windows-gnu
```

La batería Rust no necesita WebView2. El smoke gráfico sí: crea un prefijo
aislado (`WINE_SMOKE_PREFIX`) e instala dentro el WebView2 Fixed Runtime x64
desde la [página oficial de WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2).
Extrae el CAB con `cabextract`, conserva la carpeta de versión y apunta
`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` a esa carpeta usando una ruta Wine, por
ejemplo `Z:\tmp\webview2-fixed`. Después ejecuta:

```bash
WINE_SMOKE_PREFIX=/ruta/al/prefijo \
WEBVIEW2_BROWSER_EXECUTABLE_FOLDER='Z:\tmp\webview2-fixed' \
LTERMINAL_REQUIRE_SIGNING=0 \
bash linux/build-windows.sh --fast --no-install --skip-checks --wine-smoke
```

El prefijo no debe compartirse con una instalación normal de Wine ni incluirse
en Git. El resultado Rust bajo Wine es válido para la lógica Windows; la
creación gráfica completa de PTY/ConPTY debe confirmarse además en Windows
nativo, porque Wine puede ejecutar WebView2 y la interfaz pero no implementar
ConPTY con fidelidad suficiente.

Cada E2E de Windows crea además un perfil WebView2 temporal y exclusivo, que
EdgeDriver recibe mediante `webviewOptions`. Algunas combinaciones de WebView2
y EdgeDriver crean `DevToolsActivePort` dentro del subdirectorio `EBWebView`,
aunque el driver lo busca en la raíz del perfil; durante la creación de sesión
el smoke activa un puerto de depuración dinámico y refleja ese archivo en la
ubicación esperada. Así se automatiza la propia release, sin recompilar un
segundo perfil debug. El protocolo se activa en segundo plano únicamente cuando
el smoke define `LTERMINAL_E2E_WEBDRIVER=1`, incluso si el build está elevado;
el inspector visual solo se muestra al definir
`LTERMINAL_OPEN_DEVTOOLS`, para que no robe el foco de EdgeDriver. El perfil se
elimina al pasar; si falla, su ruta queda en el informe y en la salida para
diagnóstico.
`E2E_WEBVIEW2_USER_DATA_FOLDER` permite fijar una ruta escribible propia cuando
sea necesario.

### conpty.dll

En Windows la app **necesita** `conpty.dll`, `OpenConsole.exe` y
`WebView2Loader.dll` junto al ejecutable. Los dos primeros van vendorizados en
`src-tauri/vendor/conpty/`; el tercero lo aporta la dependencia de WebView2 al
compilar para Windows. El ConPTY del sistema falla en algunos Windows
recortados con `STATUS_DLL_INIT_FAILED`, y el error tarda más de dos minutos en
aparecer: las pestañas se quedan en blanco sin decir por qué. `build.rs` copia
ConPTY en cada compilación y `windows/build.ps1` aborta si falta cualquiera de
los cuatro archivos. El detalle completo, en
Esta misma sección documenta la razón y los archivos que se comprueban.

## Instalación para usar la aplicación

**Windows portable.** Se distribuye como carpeta desempaquetada: se descomprime
donde se quiera y se ejecuta `winslim-terminal.exe`. No instala WebView2, no
toca el registro y no crea accesos directos. Los binarios y la carpeta
`scripts/` tienen que ir juntos: además de `winslim-terminal.exe`,
`conpty.dll`, `OpenConsole.exe` y `WebView2Loader.dll`, esa carpeta contiene
los gestores integrados que muestra la Biblioteca.

**Windows instalable.** La release completa (`npm run dist:win`) y su alias
explícito `npm run dist:win:installer` generan un NSIS con el instalador
offline de WebView2 incluido y lo publican como
`release/WinSlimTerminal-<versión>-x64-setup.exe`. Es la opción recomendada
para equipos recortados, instalaciones limpias o despliegues sin Internet.

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

## Limpieza del repositorio

Los limpiadores eliminan únicamente salidas reproducibles, cachés e informes
conocidos, y todos los Markdown salvo este README. También retiran los rastros
de smoke/E2E en `%TEMP%` (o `/tmp`), los logs de build en AppData y las cachés
privadas de LTerminal. `release/` y todo su contenido están protegidos y nunca
se borran. Por seguridad, la vista previa es el comportamiento predeterminado;
el borrado requiere una opción explícita.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1
powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1 -Apply
```

```bash
scripts/clean-repository.sh
scripts/clean-repository.sh --apply
```

No usa `git clean`: no borra `.git`, código fuente ni configuraciones locales.
Los datos de usuario (`settings.json`, scripts, plugins y proyectos) se
conservan; solo se elimina la carpeta `logs` y las sesiones temporales antiguas.
Si Windows mantiene un artefacto abierto, elimina lo que esté libre y termina
con error indicando la ruta exacta que queda por cerrar. Las sesiones temporales
de procesos activos se conservan para no interrumpir una terminal en uso.

### Codificación

El repositorio no usa ANSI. Rust, Svelte, JSON, Bash, Node (`.mjs` incluidos),
tests y archivos de configuración son **UTF-8 sin BOM**. Los `.ps1` y
`.ps1.in` usan **UTF-8 con BOM** para que Windows PowerShell 5 lea correctamente
`ñ`, tildes y el resto de Unicode. Los `.cmd`/`.bat` se mantienen ASCII por
compatibilidad con `cmd.exe`; al abrir una sesión CMD, `init.cmd` activa
`chcp 65001` antes de leer banner y ayuda UTF-8. `npm run check:encoding`
verifica esta política y rechaza ANSI, BOM indebidos o una regresión que vuelva
a degradar Unicode a ASCII.

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
| `npm run check:local` | Validación rápida sin red: contratos, documentación, i18n, lógica frontend y pruebas locales. |
| `npm run check:workspace` | Comprueba que las cachés, salidas y directorio temporal se puedan leer y escribir; detecta un `chown`/`chmod` pendiente antes de una build. |
| `npm run check:install-sources` | Sondea 16 fuentes que usa el catálogo (WinGet, Chocolatey, Flathub y los registros de los principales ecosistemas) y distingue una caída de red de un error del código. |
| `npm run check:i18n` | Comprueba la paridad de los 15 catálogos, textos visibles, marcadores dinámicos y fugas de idioma en búsquedas y comandos internos. |
| `npm run check:contracts` | Cruza las preferencias Rust/TOML/TypeScript, los comandos internos Rust/Svelte y los recursos nativos Linux/Windows. |
| `npm run test:frontend-logic` | Ejecuta la lógica pura de idioma, identidad de plataforma y los nueve atajos sin necesitar una ventana. |
| `npm run test:e2e-report` | Prueba que el validador acepta una batería E2E completa y rechaza estados fallidos, fases ausentes o Acciones rápidas sin comprobar. |
| `npm run metadata:sync` | Propaga los datos editados en `src-tauri/config/package-metadata.json` a npm, Cargo y Tauri. |
| `npm run build` | Solo el frontend, con precomprobación de permisos y sincronización de metadatos. `LTERMINAL_SKIP_CHECKS=1` conserva Vite pero omite las sondas externas y `svelte-check`. |
| `npm run build:fast` | Atajo multiplataforma para `build` con `LTERMINAL_SKIP_CHECKS=1`; útil durante el desarrollo, no sustituye una release completa. |
| `npm run dist:win` | Ejecuta la release completa de Windows, incluida la batería de herramientas y el E2E WebDriver; comprueba recursos, valida y genera EXE, carpeta desempaquetada, ZIP e instalador NSIS offline. |
| `npm run dist:win:fast` | Build de desarrollo rápida de Windows: usa compilación incremental, omite LTO y conserva símbolos; ejecuta solo el smoke mínimo y salta las comprobaciones previas. No es una release. |
| `npm run dist:win:installer` | Genera el instalador NSIS de Windows con WebView2 offline incluido y ejecuta la batería ampliada/E2E. |
| `npm run dist:win:linux` | Compila desde Linux el ejecutable Windows GNU x64 y verifica los binarios nativos y los scripts integrados. `--wine-smoke` requiere `WINE_SMOKE_PREFIX` apuntando a un prefijo que ya tenga WebView2 Runtime. |
| `npm run dist:win:linux:fast` | Build cruzada Windows GNU x64 rápida para desarrollo; omite las comprobaciones previas y conserva la salida portable para probarla en Wine/Windows. |
| `npm run dist:linux` | Ejecuta la build Linux completa: solicita la versión, valida y genera el AppImage. |
| `npm run dist:linux:fast` | Build de desarrollo rápida de Linux: compilación incremental sin LTO, smoke mínimo y sin comprobaciones previas. No es una release. |

Para una build completa y verificada, con sus comprobaciones previas y su
release comprimida, usar los scripts de `windows/` y `linux/` en vez de estos.
Tauri incrusta `dist/index.html` en el binario; por eso `src-tauri/build.rs`
declara ese archivo como entrada de Cargo. Sin ese enlace, una modificación
exclusivamente Svelte/CSS podía regenerar `dist/` y aun así reutilizar un
ejecutable incremental con el frontend anterior. La comprobación de scripts de
build exige esta dependencia y evita que una prueba aparentemente correcta se
ejecute contra una interfaz desactualizada.

Las builds normales (`dist:win`, `dist:win:installer` y `dist:linux`) usan el
perfil release comprimido: LTO completo, una unidad de generación y símbolos
eliminados. Para iteraciones de desarrollo están disponibles `-Fast` en
`windows/build.ps1`, `--fast` en `linux/build.sh` y `linux/build-windows.sh`, o
los comandos npm `*:fast`. Ese perfil conserva símbolos, activa compilación
incremental, reduce la optimización y desactiva LTO; por eso termina antes y
pesa más. `--fast` solo cambia la compilación: las pruebas se controlan aparte,
pero los comandos npm rápidos omiten deliberadamente las comprobaciones
previas y la batería ampliada. Antes de publicar hay que ejecutar la build
normal. Los artefactos rápidos quedan en `release/dev/` y llevan el sufijo
`-dev`, para que no se confundan con los publicables.

## Compilación y distribución

```powershell
windows\build.ps1          # o build.bat: EXE + NSIS + checks + smoke + E2E
windows\build.ps1 -Fast -NoExtendedTests -SkipChecks  # iteración rápida de desarrollo
windows\build.ps1 -NoInstaller -NoRun  # solo portable, si se necesita explícitamente
```

```bash
linux/build.sh
linux/build.sh --fast --no-extended-tests --skip-checks  # iteración rápida de desarrollo
```

Al ejecutar `windows\build.ps1` o `linux/build.sh` sin argumentos desde una
consola interactiva aparece un selector previo. Sus valores predeterminados son
la release más completa: perfil optimizado, checks estrictos, artefacto final,
smoke, batería ampliada y E2E; en Windows incluye EXE y NSIS offline, y en
Linux incluye el AppImage. Enter conserva esos valores. Las ejecuciones con
argumentos explícitos, `-NonInteractive`/`--non-interactive` o entrada
redirigida no preguntan nada y mantienen igualmente la ruta completa, salvo que
se solicite una excepción (`-NoInstaller`, `-NoExtendedTests`, `-SkipChecks`,
`--fast`, etc.).

Para validar la compatibilidad Windows desde Linux:

```bash
linux/build-windows.sh --version 1.4.4 --wine-smoke
```

Esta ruta genera `src-tauri/target/windows-cross/x86_64-pc-windows-gnu/release/`
por defecto y usa el enlazador MinGW en un target aislado de la build Linux.
Es una comprobación reproducible de la aplicación y de sus recursos junto a
Wine; la release oficial sigue siendo la carpeta producida por
`windows/build.ps1` en Windows con MSVC. `--skip-checks` y `--no-install`
tienen el mismo sentido que en la build Linux; `--clean` elimina únicamente la
salida Windows cruzada. `LTERMINAL_WINDOWS_TARGET_DIR` permite cambiar esa
carpeta sin compartir locks con otra compilación. `--version X.Y.Z` fija la
versión antes de validar dependencias; si se omite en una consola interactiva,
se pregunta al principio y Enter conserva la versión actual. `--fast` usa el
perfil incremental. `--wine-smoke` ejecuta el smoke gráfico, `--full-tests`
añade la batería Rust y `--wine-repeats N` repite el smoke (1–10). Las opciones
desconocidas y los valores ausentes se rechazan antes de empezar.

Para hacer la validación cruzada completa desde Linux, incluyendo la batería
Rust compilada como PE Windows y tres arranques aislados bajo Wine:

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
`svelte-check`, clippy y las pruebas Rust. La batería completa se ejecuta por
defecto; `-FullTests` en Windows o `--full-tests`/`--extended-tests` en Linux
la fuerzan explícitamente. Linux intenta instalar automáticamente el driver
nativo de WebKitGTK si falta; `--no-install` impide instalaciones automáticas.
En Windows, `-FullTests` ejecuta toda la batería y exige que las
herramientas instaladas respondan, pero conserva como diagnóstico las opcionales
que falten; `-StrictTests` convierte también esas ausencias en fallo. La build Linux ejecuta por defecto la batería ampliada y prepara
automáticamente `dash`, PostgreSQL cliente, Fortran y Bottles (Flatpak); usa
`--no-extended-tests` para una compilación rápida o `--no-install` para impedir
instalaciones automáticas. En Arch/CachyOS instala solo esos paquetes y no
actualiza todo el sistema; `LTERMINAL_ALLOW_SYSTEM_UPGRADE=1` habilita la
actualización completa de `pacman` de forma explícita.

Los tres lanzadores rechazan opciones desconocidas y valores ausentes antes de
instalar dependencias. En Windows tampoco se permiten combinaciones
contradictorias como `-Installer` con `-NoInstaller` o
`-FullTests`/`-StrictTests` con `-NoExtendedTests`; en Linux,
`--full-tests`/`--extended-tests` y `--no-extended-tests` siguen la misma regla.

En Windows, la batería ampliada se ejecuta automáticamente tanto en modo
interactivo como no interactivo; solo `-NoExtendedTests` la omite. Las sondas de shells y herramientas se
acumulan aunque alguna falle, de modo que el E2E no se pierde por un único
runtime averiado. Un fallo de sonda, WebDriver, E2E o WSL cruzado ya no impide
comprimir ni publicar la release: se muestra junto al resumen final y el
proceso termina con código 1 para que CI lo detecte. `-StrictTests` sigue
convirtiendo también las ausencias opcionales en ese diagnóstico final. El
informe E2E se conserva en `%TEMP%\winslim-terminal-e2e-<id>.json` cuando falla.

Al comenzar, los scripts de empaquetado preguntan la versión a generar y
proponen la actual; pulsar Enter la conserva. Se puede evitar el diálogo con
`-Version 1.4.4 -NonInteractive` en Windows o `--version 1.4.4` en Linux.

Cada script comprueba los requisitos, instala dependencias, pasa `npm run check`,
compila, monta el artefacto, hace una comprobación de humo (abre la app y mira
que no se cierre sola) y publica la release con su SHA-256 en `release/`.
El manifiesto `SHA256SUMS.txt` se actualiza por artefacto y de forma atómica:
conserva los hashes de las demás arquitecturas, plataformas y perfiles de la
misma versión, y solo sustituye la entrada del archivo que se acaba de generar.
Las builds tampoco eliminan AppImage/ZIP anteriores del directorio de release.
La comprobación estricta de enlaces distingue HTTP de repositorios Git: las
URLs normales usan el timeout corto configurado y `git ls-remote` dispone de
hasta 30 segundos y reintentos propios, para no rechazar una build porque la
negociación de un repositorio grande tarde más que una petición web.
También respeta la plataforma: las fuentes AUR no bloquean una build nativa de
Windows y sí se comprueban en Linux o dentro de WSL; las URLs fijas de fixtures
de tests y el esquema remoto de Tauri no se consideran dependencias de red del
build.
Los enlaces que solo son destinos informativos de una acción de usuario se
comprueban igualmente, pero están marcados como no bloqueantes: por ejemplo,
`www.codeweavers.com` se abre en el navegador y no aporta ningún archivo al
binario. Si ese tercero responde con timeout/5xx, el informe muestra un aviso y
la build estricta continúa; una URL que sí sea fuente o dependencia de build
sigue siendo un fallo estricto.

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
| Windows | Carpeta desempaquetada + `WinSlimTerminal-Unpacked-<versión>.zip` + `WinSlimTerminal-<versión>-x64-setup.exe` (NSIS offline) |
| Linux | `LTerminal-<versión>-<arch>.AppImage` |

La build con instalador publica el NSIS en `release/`, junto al ZIP, y registra
su SHA-256 en `release/SHA256SUMS.txt`; `target/` sigue siendo solo la salida
interna de Tauri/Cargo. `-NoInstaller` omite explícitamente ese artefacto. La
build portable no genera instalador ni accesos directos.

Si se configura actualización automática más adelante, el nombre del artefacto
debe coincidir con `self_update::asset_for_platform`; de otro modo una release
no tendrá un adjunto compatible.

### Seguridad de las releases

Las actualizaciones exigen `SHA256SUMS.txt` y su firma detached
`SHA256SUMS.txt.sig`. El binario se compila con
`LTERMINAL_UPDATE_PUBLIC_KEY` (clave pública Ed25519 en hexadecimal) y verifica
la firma antes de descargar, extraer o instalar el payload; después exige una
coincidencia exacta de SHA-256. Una release oficial falla si no recibe
`LTERMINAL_SIGNING_PRIVATE_KEY` en el entorno de CI. La clave privada nunca se
guarda en el repositorio.

En una máquina de desarrollo, `linux/build.sh` carga automáticamente esas dos
claves desde `~/.config/lterminal/release-signing-private.pem` y
`~/.config/lterminal/release-signing-public.hex`, siempre que no se hayan
proporcionado ya mediante variables de entorno. Se puede cambiar la ubicación
con `LTERMINAL_SIGNING_PRIVATE_KEY_FILE` y
`LTERMINAL_UPDATE_PUBLIC_KEY_FILE`. En CI no se usa este fallback local: el
workflow debe entregar los secretos mediante Actions. La build no afirma que
una firma es válida hasta verificarla con la clave pública, y elimina una firma
antigua si se intenta generar una build sin material de firma.

Los payloads comprimidos se inspeccionan antes de extraerse: se rechazan rutas
absolutas, `..`, separadores Windows, enlaces simbólicos, archivos especiales,
archivos excesivos y expansiones superiores a 512 MiB. El bootstrap de perfil
también exige el checksum del ZIP y limita sus hosts de descarga a GitHub.

El workflow `Wine` ejecuta la batería Rust Windows con Wine sin requerir
WebView2. El smoke gráfico se puede lanzar con `--wine-smoke`/`--full-tests`
cuando `WINE_SMOKE_PREFIX` apunta a un prefijo con WebView2 Runtime; también
admite `LTERMINAL_WINE_RUNNER=proton` y `LTERMINAL_PROTON=/ruta/al/proton`.
En Linux, Wine 11 y Proton 11 han quedado instrumentados y aislados, pero el
GUI smoke actual termina en timeout después de arrancar WebView2; no se declara
aprobado hasta repetirlo en Windows nativo, donde ConPTY y WebView2 sí tienen
la implementación objetivo.

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

El banner se imprime una sola vez como salida normal del PTY dentro de
`terminal-host`, por lo que comparte scrollback, cursor y selección con la
shell sin superponerse a ellos. Este README concentra la documentación
mantenida del repositorio.

El recorrido completo, con el orden de arranque, el ciclo de vida de una
pestaña, la frontera IPC, los procesos, el actualizador y los límites de
confianza está desarrollado en este README junto con la estrategia de pruebas,
la matriz Linux/Wine/Windows y la evidencia visual E2E.

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

- **Las operaciones sensibles validan las rutas en el backend.** Scripts,
  repositorios y entradas de archivos pasan por listas blancas o por una
  comprobación contra la vista actual. La interfaz no debe considerarse una
  frontera de seguridad contra el propio usuario: una terminal permite
  comandos explícitos arbitrarios y las rutas recibidas deben seguir
  revalidándose antes de cada operación.
- **Nada se ejecuta a escondidas.** Lo que un panel «hace» es escribir un
  comando en la terminal visible, con su cabecera y su resultado. El usuario lo
  lee entero antes de que pase nada y puede cancelarlo con Ctrl+C.
- **Los comandos lentos no bloquean la ventana.** En Tauri un comando síncrono
  se ejecuta en el hilo principal, que es el que pinta. Los 40 que tocan disco,
  red o lanzan procesos llevan `#[tauri::command(async)]`. Se quedan en el hilo
  principal los rápidos y **`pty_input`**, que además tiene que conservar el
  orden de las pulsaciones.

## Flujos de ejecución y diagnóstico

La terminal no es una única llamada ni una única pantalla: es una cadena de
flujos concurrentes que comparten estado. Una regresión visible (un cursor
extraño, un espacio que parece desaparecer, parte del `fastfetch` de otra
pestaña o un explorador atrasado) puede nacer en cualquiera de estas fronteras.
La regla para depurarla es seguir el dato desde su origen hasta el píxel, y
correlacionarlo siempre por `tabId`, generación de PTY y época de entrada o
salida.

### 1. Flujo global: de la ventana al prompt

```text
proceso Tauri
  ├─ configuración, rutas y estado compartido del backend
  ├─ App.svelte:onMount
  │   ├─ registra una sola vez los listeners Tauri
  │   └─ app.load()
  │       ├─ tabs_list + settings_get + app_info en paralelo
  │       ├─ aplica preferencias, tema y modo de ventana
  │       └─ inicia la detección de entornos sin bloquear la primera terminal
  ├─ un TerminalPane por pestaña
  │   ├─ crea xterm.js + FitAddon y lo monta
  │   ├─ registra el terminal en terminalRegistry
  │   ├─ mide columnas/filas reales
  │   ├─ tabs_ready: libera la salida retenida por el backend
  │   └─ frontend_ready: permite completar la preparación global
  ├─ TabManager crea la PTY y su sesión temporal
  │   ├─ lector: bytes de la shell → salida incremental
  │   └─ waiter: final de proceso → pty-exit
  └─ inicializador, banner y prompt visible
```

Hay paralelismo intencional entre cargar ajustes, información de aplicación y
la detección de entornos. No lo hay entre “xterm existe” y “vaciar la salida
pendiente”: `tabs_ready` es la barrera que evita enviar bytes a un terminal que
aún no tiene consumidor. La detección completa se retrasa hasta que la primera
sesión puede responder para que un escaneo de PATH o de WSL no congele la
interfaz ni retrase innecesariamente el prompt.

Cada etapa tiene una condición observable. Si falla antes de `app.load()`, hay
que mirar configuración y backend; si falla entre `tabs_ready` y el primer
`pty-data`, hay que separar creación de PTY, inicializador y shell; si el evento
llega pero no se ve, el problema está en la cola del frontend, xterm, el tamaño
del viewport o el repintado.

### 2. Flujo de salida PTY

La salida de una pestaña sigue este recorrido, en este orden:

```text
shell / proceso hijo
  → portable-pty (lector por bloques de hasta 64 KiB)
  → Utf8Decoder + ClearSplitter
  → Outbound::{Data, Clear, Exit}
  → outbound_lock de TabManager
  → evento Tauri: pty-data / pty-clear / pty-exit
  → listener único de App.svelte
  → outputQueues[tabId]
  → xterm.write(data, callback)
  → scroll, idle, fit y repintado
```

`Utf8Decoder` es incremental: una secuencia UTF-8 partida entre dos lecturas
no se convierte en caracteres corruptos. `ClearSplitter` reconoce el marcador
de limpieza sin destruir el orden de los datos que lo rodean. El backend
serializa la emisión con `outbound_lock`; el frontend serializa las escrituras
con una cola por pestaña; xterm mantiene su propio parser y renderizador. Estas
tres fronteras son necesarias porque `AppHandle::emit` no proporciona un orden
total entre hilos y una impresión del banner puede competir con el lector de la
PTY.

Un `pty-clear` no es “borrar un poco de texto”: es una transición de sesión. El
frontend invalida la cola pendiente, limpia la pantalla y el scrollback de
xterm con las secuencias apropiadas, y solo después deja pasar la salida nueva.
`outputEpochs[tabId]` descarta una escritura que se hubiera quedado esperando en
una promesa de una época anterior. Por eso no basta con emitir `\x1b[2J` desde
un sitio cualquiera: limpiar sin invalidar la cola permite que el bloque viejo
aparezca después del nuevo.

Los campos mínimos para seguir una salida son `tabId`, `generation`, entorno,
columnas/filas y marca temporal. La generación vive en el backend; la época es
la barrera local del frontend. La primera descarta callbacks de una PTY
reemplazada y la segunda descarta promesas de renderizado ya obsoletas.

### 3. Flujo de entrada, cursor y teclado

```text
tecla física
  ├─ captura global de App.svelte, fase capture
  │   ├─ si coincide con un atajo: preventDefault + stopPropagation + acción
  │   └─ si no coincide: continúa hacia el textarea oculto de xterm
  └─ xterm.onData
      → TerminalPane (mirror, comandos internos y preparación)
      → api.sendInput(tabId, data)
      → inputQueues[tabId]
      → pty_input
      → note_user_input + escritura en portable-pty
      → eco de la shell / salida normal
```

El textarea oculto de xterm es el dueño de la edición de línea. La aplicación
no debe reconstruir el cursor a partir de cada tecla ni capturar flechas,
espacios, Backspace o Enter como si fueran atajos normales. `shortcutFromEvent`
exige al menos un modificador, compara también `KeyboardEvent.code` y permite
que la distribución del teclado no cambie el significado de Backslash. Así
`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown` y el espacio siguen llegando
a la shell salvo que el usuario les asigne explícitamente una combinación con
modificadores.

La cola de entrada es por pestaña y conserva el orden de las pulsaciones. Cada
envío captura una época; al cerrar o reemplazar una sesión,
`api.invalidateInput(tabId)` incrementa esa época y elimina la cola pendiente.
Una promesa de la sesión anterior no puede escribir en la nueva PTY. El estado
visual de la línea (`mirroredLine`) solo sirve para selección contextual y
acciones de cortar/borrar; no es una segunda terminal ni una fuente de verdad
para el cursor. Los espacios son ASCII ordinario (`0x20`) y se preservan en
`sendInput`.

Durante el arranque o un cambio de shell, `queuedInput` retiene temporalmente
las pulsaciones hasta que el banner y el prompt están completos. Toda salida de
ese estado pasa por una única función: marca la terminal disponible y vacía la
cola en el mismo orden. El camino normal espera solo un frame breve después de
`term.write`; el límite de seguridad cubre prompts no reconocibles y también
vacía la cola, por lo que nunca puede dejar espacios o texto retenidos.

Los comandos internos se interceptan únicamente cuando hay una línea completa
con el prefijo `:`. Todo lo demás se entrega a la shell, incluido un comando
que tenga espacios. El comportamiento correcto se comprueba en tres niveles:
que el evento no sea consumido por un atajo, que `pty_input` reciba la misma
secuencia y que la shell la refleje con el cursor en la posición esperada.

### 4. Flujo de una pestaña y las carreras de cierre

```text
crear
  → TabManager asigna tab-<contador>, entorno y cwd heredado
  → generación nueva + spawn de PTY
  → TerminalPane keyed por tab.id
  → xterm abre, hace fit y llama tabs_ready
  → inicializador/banner/prompt
  → pestaña lista

cerrar
  → tabLifecycleQueue serializa la intención
  → backend toma outbound_lock, mata/libera la sesión
  → emite tab-closed con el siguiente tab activo
  → frontend invalida entrada y salida
  → actualiza estado; la última pestaña cierra la ventana
```

El `id` de la pestaña no se reutiliza durante la vida del proceso. El `{#each}`
del frontend está keyed por ese id y cada `TerminalPane` permanece montado,
aunque se oculte al cambiar de panel o de distribución. Esto conserva scrollback,
selección, foco y callbacks de xterm; reciclar el nodo DOM para otra pestaña
mezclaría estado visual aunque el backend estuviera correcto.

El cierre, la creación y el ciclo de paneles pasan por colas/guardas porque el
usuario puede abrir, dividir y cerrar casi en el mismo instante. Un evento
tardío de `pty-exit`, `pty-data` o `tab-closed` se ignora si su pestaña ya no
existe. Una sesión sustituida se identifica además por `generation`, por lo
que un callback de la shell antigua no puede cerrar ni contaminar la nueva.

### 5. Flujo de cambio de entorno

```text
selector / acción de entorno
  → winslim:environment-switch-started(tabId)
  → frontend invalida input/output y reinicia mirror/readiness
  → env_switch IPC valida entorno y pestaña
  → conserva cwd cuando es compatible
  → incrementa generation y detiene la PTY anterior
  → pty-clear ordenado
  → crea la nueva PTY y sus archivos temporales
  → responde consultas VT de arranque si ConPTY las hace
  → inicializador + marcador de limpieza + banner/prompt
  → environment-changed + terminal-cwd-changed
  → interfaz, explorador y sugerencias reciben el nuevo entorno
```

La limpieza se ejecuta dentro de `spawn_pty`, después de invalidar la generación
anterior y antes de que la shell nueva pueda imprimir. No se debe añadir otra
limpieza en la capa de UI: dos clears en sitios distintos producen parpadeo,
pueden borrar el prompt nuevo o reabrir una carrera de orden. La cola de
`pending_commands` retiene acciones de panel que llegaron durante la
inicialización y las libera tras el marcador de limpieza.

El redimensionado solo cambia filas/columnas, mantiene el anclaje inferior y
refresca la textura de xterm. Nunca ejecuta `term.clear()` ni reescribe un prompt
local con secuencias CSI: lo primero destruiría el scrollback y lo segundo
separaría el cursor visual del cursor que realmente posee la shell.

Síntomas de una ruptura en este flujo: `fastfetch` antiguo después del cambio,
prompt doble, cursor que reaparece en una posición vieja, el comando del panel
que se pierde o la etiqueta que cambia antes de que exista una shell utilizable.
La evidencia decisiva es comparar `tabId` y `generation` en el log con el orden
`switch-started → clear → primer output nuevo → environment-changed`.

### 6. Flujo de directorio de trabajo y explorador

```text
prompt / salida de la shell
  → inspector prioriza OSC 7 y usa el prompt como respaldo
  → TabManager actualiza cwd de la pestaña
  → terminal-cwd-changed(tabId, cwd, envId)
  → ExplorerSidebar decide si sigue a la terminal
  → agrupa ráfagas de foco y conserva la última solicitud pendiente
  → explorer_follow / lectura del backend
  → solo la respuesta cuyo request y tabId siguen vigentes se pinta
```

El explorador sigue al tab activo cuando está en modo automático. Una carpeta
que el usuario haya elegido manualmente no se pisa hasta que se solicite seguir
la terminal, se cambie el foco o se use el botón correspondiente. Cada lectura
tiene un número de solicitud: si el usuario navega de `A` a `B` y la respuesta
de `A` llega tarde, se descarta en vez de sobrescribir `B`.

Fish y otras shells modernas publican el directorio mediante OSC 7
(`file://host/ruta`); se decodifican también rutas con espacios escapados. Esa
señal no depende del aspecto del prompt y es la fuente preferida. Los patrones
de cmd, PowerShell, MSYS, Bash, zsh, fish/Pure y Starship siguen siendo el
respaldo para sesiones que no emiten OSC 7. Las llamadas repetidas por mostrar
el panel, cambiar de pestaña y enfocar xterm se coalescen: se hace una lectura
y, si durante ella llega otra solicitud, una sola lectura final. Así se evita
que una ráfaga invalide todas las respuestas antes de pintar siquiera la ruta
inicial.

Llevar el explorador a una ruta (`cd` desde el explorador) debe pasar por la
ruta validada y el comando de cambio de directorio del backend; la UI no debe
componer una orden con texto sin validar. El flujo inverso, seguir la terminal,
usa el `cwd` detectado, no una segunda copia del estado mantenida por el panel.

### 7. Flujo de paneles, ajustes y acciones configurables

`appState.svelte.ts` es el estado compartido. Los paneles no deben mantener una
versión paralela de pestañas, entorno o cwd: reciben el estado, solicitan una
operación y esperan la confirmación del backend. La carga de preferencias se
serializa con `preferencesReloadRequest`; los guardados se encadenan en
`preferencesSaveQueue`. De este modo cambiar idioma, tema, densidad o varios
interruptores rápidamente no restaura un JSON antiguo por una respuesta tardía.

La UI se construye a partir de capacidades configurables: selector de entorno,
refresco, idioma, barra de pestañas, explorador, paneles de Dependencias,
Proyectos y Biblioteca, acciones rápidas, modo de terminal limpia y controles
de ventana. El botón **Logs** no forma parte de esa superficie: fue retirado.
Los logs siguen existiendo como dato de diagnóstico, pero no como botón fijo
que el usuario tenga que conservar.

Hay veinte acciones mapeables en `src/lib/shortcuts.ts`: pestaña nueva,
siguiente/anterior, división, explorador, terminal limpia, cuatro direcciones,
Ajustes, Proyectos, Biblioteca, Dependencias, cerrar panel, refrescar entornos,
seguir ruta, llevar la terminal a la carpeta, limpiar terminal y abrir el
explorador del sistema. Las diez últimas de utilidad no tienen asignación de
fábrica; una cadena vacía significa “disponible para grabar”, no “fallo”. Los
valores se normalizan y comparan por código físico cuando procede.

Los defaults direccionales son `Ctrl+Alt+H/J/K/L` (izquierda/abajo/arriba/
derecha), no flechas. Es una decisión de frontera: la terminal conserva las
flechas para la shell y el usuario puede elegir otra combinación explícita. Si
un atajo no funciona, revisar primero el valor normalizado en Ajustes y luego
si el evento fue consumido por un input con `data-shortcut-input`; no añadir un
segundo listener local al componente de terminal.

Los perfiles que aún contengan exactamente el conjunto heredado
`Alt+ArrowLeft/Right/Up/Down` se migran al leerlos. La migración solo actúa si
coinciden las cuatro asignaciones antiguas; una configuración parcial o
personalizada se conserva.

### 8. Flujo de instaladores, inventario y dependencias

```text
abrir Dependencias
  → install_list devuelve el catálogo conocido/caché rápidamente
  → install_refresh ejecuta detección completa por entorno
      (PATH, WSL, Docker, ADB y gestores aplicables)
  → envs-updated actualiza el inventario
  → se construye el catálogo de acciones por plataforma y gestor
  → install_run escribe el comando visible en la terminal
  → pausa / resultado / salida de la herramienta
  → nueva detección verifica el estado real
```

Una acción de instalación no es solo una etiqueta: tiene id estable, plataforma,
gestor, comando visible, sonda posterior y estado (`instalado`, `actualizable`,
`faltante`, `no aplicable` o `no verificable`). El backend no debe reutilizar el
nombre del paquete de una distribución en otra solo para que los contadores
coincidan.

Para GitHub CLI (`gh`), el id estable es `pkg-gh`: WinGet usa `GitHub.cli`;
Linux usa `gh` en apt/dnf/zypper y `github-cli` en pacman/apk. Un HTTP 404 de un
mirror de CachyOS/Arch después de que el índice anuncie el paquete apunta a
sincronización o contenido del mirror, no necesariamente a un id incorrecto.
La secuencia de diagnóstico es comparar `pacman -Si github-cli`, el repositorio
que lo anuncia y la URL del mirror con la salida de `pacman`; la acción solo debe
marcar éxito cuando la sonda `gh --version` confirma el binario.

Los instaladores comparten la misma frontera de visibilidad que los paneles:
el usuario ve el comando, puede cancelarlo con Ctrl+C y la terminal conserva el
resultado. Las fuentes externas, DNS, índices, mirrors, permisos y reinicios
son dependencias del sistema y se deben distinguir de un error de catálogo o
de IPC en los diagnósticos.

### 9. Errores, rendimiento y correlación

Los errores de JavaScript y las promesas rechazadas se envían mediante
`log_frontend_error` al mismo `main.log` que el backend. Cada registro útil debe
permitir responder: qué pestaña, qué entorno, qué generación, qué viewport y
qué operación estaban activos. Nunca basta con “falló el terminal” sin esos
campos.

Las métricas de rendimiento no significan lo mismo:

| Métrica | Qué mide | Frontera que ayuda a localizar |
|---|---|---|
| `app.initial-load` | carga completa de estado inicial | app/configuración/IPC |
| `app.ui-shell-visible` | primera UI visible | ventana/WebView/UI |
| `app.ready-for-input` | terminal apta para escribir | xterm/PTY/handshake |
| `terminal.xterm-mount` | montaje del componente | DOM/xterm |
| `terminal.ready-handshake` | tabs_ready/frontend_ready | barrera frontend/backend |
| `terminal.initial-fit` | primer tamaño real | viewport/FitAddon/resize |
| `terminal.environment-switch-first-output` | cambio hasta primer output nuevo | generación/spawn/shell |
| `fastfetch.banner-visible` | banner realmente pintado | PTY/cola/xterm |
| `terminal.resize` | ajuste de una terminal | layout/PTY resize |
| `ipc.*` | llamada individual | contrato y backend |
| `ui.panel.visible` | panel abierto y visible | estado/render |

`sinceStartMs` responde “cuánto desde que empezó la interfaz” y `durationMs`
responde “cuánto duró esta operación”; mezclarlos hace parecer lento un panel
que solo se abrió después de un arranque largo. Para comparar pestañas hay que
agrupar por `tabId` y no por el orden de líneas del log.

### 10. Máquina de estados y reglas de validez

| Estado | Entrada | Permitido | Invalida |
|---|---|---|---|
| `created` | tab summary | montar xterm, preparar PTY | nada aún |
| `spawning` | spawn solicitado | esperar sesión y resize | callbacks de otra generación |
| `initializing` | PTY viva | acumular salida/comandos, responder VT | entrada prematura no encolada |
| `ready` | `tabs_ready` + prompt | entrada, resize, paneles | salida sin `tabId` |
| `switching` | cambio de entorno | clear, invalidar épocas, nueva PTY | output/click de la sesión vieja |
| `closing` | cierre o exit | liberar PTY y notificar | nuevas escrituras |
| `closed` | `tab-closed` | retirar estado y DOM | cualquier evento tardío |

Las invariantes que deben mantenerse al modificar el código son:

- Una pestaña tiene un único dueño de estado y una única PTY activa.
- Un flujo reemplazable tiene una generación backend y una época frontend.
- La salida se ordena antes de emitirse y antes de escribirse en xterm.
- La entrada se ordena por pestaña y se invalida al reemplazar o cerrar.
- El shell posee el cursor; el mirror nunca lo sustituye.
- Una respuesta asíncrona solo puede aplicar si conserva su tab, solicitud y
  contexto.
- La UI no valida por sí sola rutas, gestores, fuentes ni permisos.

### 11. Matriz de síntomas y primera evidencia

| Síntoma | Primera evidencia | Frontera probable | Siguiente comprobación |
|---|---|---|---|
| Cursor, espacios o flechas raros | secuencia en `onData` y `pty_input` | atajo/textarea/cola de entrada | revisar capture, `inputEpochs` y eco de shell |
| Fastfetch antiguo tras abrir/cerrar/cambiar | `tabId`, generación, orden de `pty-clear`/`pty-data` | PTY sustituida o cola de salida | buscar generación vieja y época incrementada |
| Banner encima del prompt | `tabs_ready`, `initializing`, primer resize | handshake/inicializador | comprobar `pending` y marcador de limpieza |
| Explorador muestra carpeta anterior | cwd event y `listingRequest` | evento tardío o navegación manual | comparar request, tab activo y cwd |
| Atajo con flecha no actúa | valor normalizado + fase del keydown | captura o terminal que lo consume | probar el default H/J/K/L o asignar modificador |
| `gh` falla con 404 | gestor, repo, mirror y URL | fuente externa/índice | `pacman -Si`, estado del mirror y `gh --version` |
| Pestaña Windows en blanco | presencia de ConPTY/WebView2 + log de spawn | runtime del sistema | validar DLL, arquitectura y respuesta de ConPTY |
| Panel repone datos antiguos | request/cola de preferencias | async sin serializar | revisar `preferencesSaveQueue`/`preferencesReloadRequest` |
| Primera escritura se pierde | `ready-for-input`, `queuedInput` | xterm aún no listo | comprobar liberación por output idle/timeout |

### 12. Cómo mejorar sin reintroducir carreras

Antes de cambiar un flujo, documentar su productor, consumidor, estado, barrera
y evento de finalización. Después:

1. Dibujar la cadena concreta (por ejemplo `tecla → xterm → IPC → PTY → eco`)
   y decidir cuál es la única fuente de verdad.
2. Añadir una guardia de generación, época o número de solicitud si el flujo
   puede ser reemplazado mientras hay trabajo pendiente.
3. Mantener la operación observable: comando visible, evento con campos de
   correlación y métrica de inicio/fin.
4. Probar la transición y la carrera, no solo el caso feliz: abrir/cerrar
   rápidamente, cambiar de entorno mientras sale el banner, escribir antes del
   prompt, navegar A→B, guardar dos preferencias seguidas y fallar un mirror.
5. Ejecutar las comprobaciones de contratos, lógica, flujos, compilación y
   smoke; si la limitación es externa (DNS, WebDriver, mirror), registrarla
   separada del resultado de la aplicación.

Toda la documentación técnica mantenida del proyecto vive en este README. Los
flujos pueden crecer aquí sin crear READMEs paralelos que se contradigan.

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
| `clear`, `cls` | Limpieza real de pantalla e historial; por defecto vuelve a mostrar el fastfetch esencial. Se puede desactivar en Ajustes (`Reimprimir fastfetch al ejecutar clear`). |
| `sysinfo` | Reimprime el banner del sistema. |
| `ayuda` | Ayuda explicada: qué hace cada alias, qué gestor los atiende y qué scripts se han registrado. Se lee de un archivo generado por sesión, así que ocupa varias líneas y va traducida. |
| `nsudo` | Solo si el ejecutable existe en la máquina. |
| `install`, `update`, `upgrade`, `uninstall`, `remove`, `search` | Se traducen al gestor de paquetes real del entorno. |
| `adb-manager`, `docker-manager`, `kubernetes-manager`, `network-manager`, `service-manager`, `ssh-manager` | Scripts integrados de la **Biblioteca**; se selecciona la variante PowerShell o Shell según el entorno. Los scripts personales detectados se muestran con sus nombres concretos en la ayuda de cada sesión. |

Los scripts integrados que se pueden registrar como alias son `adb-manager`,
`docker-manager`, `kubernetes-manager`, `network-manager`, `service-manager` y
`ssh-manager` (se elige la variante PowerShell o Shell según el entorno). La
ayuda de cada sesión añade también los scripts personales detectados y muestra
sus nombres concretos.

### Comandos internos de la aplicación (`:`)

Una línea que empieza por `:` no se entrega a la shell: la interpreta WinSlim
Terminal para consultar o cambiar su propia configuración. Se pueden escribir
en cualquier terminal real; en un REPL se muestran como ayuda y no se inyectan
como código. Los argumentos se separan por espacios y los identificadores no
distinguen mayúsculas de minúsculas.

| Comando | Función |
|---|---|
| `:help [sección]` / `:alias` | Ayuda completa o una sección: `paquetes`, `sesion`, `internos`, `alias`, `biblioteca`, `menus`, `plugins`, `soporte` y `creditos`. |
| `:config` / `:settings` | Abre Ajustes. |
| `:reload` | Vuelve a detectar shells, WSL, Docker, ADB y herramientas. |
| `:shell list` / `:shell current` / `:shell <id o nombre>` | Enumera, muestra o cambia la shell/entorno de la pestaña actual. También se aceptan `:env` y `:environment`. El resto de pestañas no cambia. |
| `:repl <nombre>` | Abre una pestaña nueva con un intérprete interactivo detectado, por ejemplo `:repl python`. |
| `:panel list` / `:panel <panel>` / `:panel close` | Abre o cierra `settings`, `deps`, `projects`, `scripts` y `explorer`. `:open` es equivalente a `:panel`. |
| `:theme list` / `:theme <id>` | Enumera o aplica un tema disponible, como `ocean` o `nordic`. |
| `:font list` / `:font <id>` | Enumera o aplica una fuente de terminal, como `jetbrains`. `:fuente` es equivalente. |
| `:language list` / `:language <id>` | Enumera o cambia el idioma (`es`, `en`, `auto`, etc.). También acepta `:lang` y `:idioma`. |
| `:terminal list` | Muestra todos los parámetros editables de xterm y sus valores actuales. |
| `:terminal <parámetro> <valor>` | Cambia tamaño/familia/peso de fuente, interlineado, espaciado, padding, scrollback, sensibilidad, cursor, parpadeo, selección, densidad y colores. Ejemplos: `:terminal font-size 14`, `:terminal cursor beam`, `:terminal cursor-blink off`, `:terminal background #080808`. `:term` es equivalente. |
| `:panes 1\|2\|3\|4` / `:panes cycle` | Fija o rota el número de terminales visibles en la rejilla. `:layout` y `:grid` son equivalentes. |
| `:explorer-here` | Abre el gestor de archivos del sistema en la ruta actual de la terminal en Windows o Linux. `:open-here` y `:reveal-here` son equivalentes. |
| `:banner list` / `:banner hide|show|toggle <campo>` / `:banner preset compact\|full` | Consulta o cambia los campos del fastfetch. Los campos son `system`, `host`, `kernel`, `environment`, `motherboard`, `cpu`, `gpu`, `memory`, `storage`, `uptime` y `datetime`. |
| `:quick-actions list` / `on` / `off` / `toggle` | Consulta o cambia la visibilidad de las acciones rápidas de Biblioteca. |

Los parámetros de `:terminal` usan valores sencillos: colores `#rrggbb`,
booleanos `on/off`, cursor `block|underline|bar|beam|underline-thick`, peso
`light|normal|medium|semibold|bold` y densidad `compact|comfortable`. Los
valores numéricos se validan y acotan igual que en Ajustes; `settings.json`
sigue siendo la fuente persistente. `:terminal list` y `:help internos` son la
forma más rápida de consultar el estado sin abrir un panel.

### Qué va a la shell y qué no

Todo lo que **no** empieza por `:` sigue siendo una orden de la shell actual.
Ahí entran los alias `clear`, `cls`, `sysinfo`, `edit`, `ll`, `install`, los
alias de scripts y cualquier comando nativo (`git`, `python`, `docker`, etc.).
WinSlim solo los prepara al crear la pestaña y conserva su sintaxis; la shell
decide cómo ejecutarlos y devuelve su salida y código de salida. Por eso
`install git` ejecuta el gestor real del entorno, mientras que `:panel deps`
abre un panel de la aplicación sin escribir nada en cmd o PowerShell.

El banner inicial usa **Solo esencial** (5–8 líneas) y se imprime como salida
normal del terminal. `clear/cls` vuelve a mostrar ese fastfetch por defecto; la
preferencia `clearReprintBanner` permite dejar la pantalla limpia sin banner.
Para solicitar todos los campos usa Ajustes o `:banner preset full`; el cambio
se añade al scrollback sin mover la selección ni superponerse al código.

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

### Créditos y easter-eggs

En una línea propia de la terminal, `Darkeiser003`, `darkeiser003`,
`@darkeiser003` y `@Darkeiser003` muestran una presentación del desarrollo,
el perfil público y los proyectos [WinSlim Terminal](https://github.com/Darkeiser003/Terminal)
y [Infraestructura-Web](https://github.com/Darkeiser003/Infraestructura-Web).
Del mismo modo, `christianlg97` y `@christianlg97` muestran un agradecimiento
por la colaboración y enlazan el [perfil de Christianlg97](https://github.com/Christianlg97),
[WinSlim Center Store](https://github.com/Christianlg97/WINSLIM_CENTER_STORE) y
[WinSlim Update](https://github.com/Christianlg97/WinSlim-Update). Se aceptan
también las formas con `:` por coherencia con los comandos internos; no se
interceptan órdenes que contengan esos nombres como parte de otra línea.

---

## Panel de entorno y dependencias

Dos niveles: grupos temáticos y, dentro, un subgrupo plegable por herramienta.
De cada herramienta se ve **o** «instalar» (si falta) **o**
actualizar/desinstalar/ver versión (si está), nunca las dos mitades a la vez.
Cada componente separa una descripción concisa de su finalidad de la nota
operativa: la descripción explica para qué sirve; `hint` reserva requisitos,
permisos, reinicios y procedencia. El buscador consulta ambos textos y los tests
rechazan componentes agrupados sin descripción o descripciones que solo hablen
del instalador.
La instalación y la desinstalación se seleccionan componente a componente: la
build no genera ni ejecuta un script masivo de entorno. Los scripts de desarrollo
para preparar el proyecto siguen en `scripts/` y se usan desde el código fuente.

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

Las **Operaciones rápidas** de la Biblioteca se pueden ocultar desde Ajustes
(`Acciones rápidas`) o desde cualquier terminal con `:quick-actions off`; se
recuperan con `:quick-actions on` y también admiten `toggle` y `list`. La opción
queda activada de fábrica y solo oculta el submenú: los scripts integrados
siguen disponibles en la Biblioteca.

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

**Abrir en el explorador del sistema** (menú contextual de la terminal o
`:explorer-here`) lanza el explorador del sistema en la ruta actual, que es
distinto de entrar en ella dentro del panel. En Linux se lanza el gestor del
escritorio en uso, deducido de `XDG_CURRENT_DESKTOP`: Dolphin en KDE, Archivos
en GNOME, Thunar en Xfce, Nemo, Caja o PCManFM según el caso. **No se delega en
`xdg-open`** porque la asociación de `inode/directory` apunta en muchos
escritorios a un emulador de terminal, y pedir «abrir carpeta» acababa abriendo
una terminal. Si no se puede deducir el escritorio y hay varios gestores, se
pregunta; si no hay ninguno, se ofrece instalar uno.

El panel sigue automáticamente a la pestaña activa y a los cambios de carpeta
detectados en su prompt (`cd`, `Set-Location`, etc.). Si se navega manualmente
por otra carpeta, esa vista se conserva hasta volver a enfocar la terminal o
pulsar «Seguir»; al cambiar de pestaña siempre se carga su directorio real.

### Visores de archivos

Si al abrir un archivo el sistema no tiene ninguna aplicación asociada, la
aplicación propone instalar un visor adecuado al tipo de contenido y **espera
confirmación**. En Windows se usan ImageGlass, VLC, SumatraPDF, 7-Zip y Visual
Studio Code; en Linux sus equivalentes del gestor de paquetes. Los mismos visores están en el
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

Los atajos se resuelven en una única captura global, antes de que el textarea
oculto de xterm reciba la tecla. Hay veinte acciones configurables en Ajustes;
las acciones sin valor se muestran como disponibles pero no secuestran ninguna
tecla. Los valores se guardan normalizados y se comparan por `KeyboardEvent.code`
cuando la tecla tiene una representación física ambigua.

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+T` | Nueva pestaña del entorno actual |
| `Ctrl+Shift+E` | Mostrar u ocultar el explorador de archivos |
| `Ctrl+Shift+Backslash` | Añadir una sesión a la vista dividida (o volver a una) |
| `Ctrl+Shift+C` | Copiar la selección |
| `Ctrl+Shift+V` | Pegar |
| `Ctrl+Shift+X` | Cortar la entrada seleccionada |

Los defaults de navegación de panel son `Ctrl+Alt+H` (izquierda), `Ctrl+Alt+J`
(abajo), `Ctrl+Alt+K` (arriba) y `Ctrl+Alt+L` (derecha), precisamente para no
capturar las flechas que necesita la shell. También se pueden asignar acciones
sin default: abrir un panel concreto, cerrar panel, refrescar entornos, seguir
la ruta de la terminal, llevar la terminal a la carpeta del explorador, limpiar
terminal y abrir el explorador del sistema. Un cambio de atajos debe probarse
con foco en terminal, input de ajustes y panel lateral: cada contexto tiene que
conservar su propia edición.

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
| `bannerHiddenItems` | lista de campos | `host,kernel,environment,motherboard,gpu,storage,datetime` (**Solo esencial**, 5–8 líneas) |
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
(`action.<id>.label`). La finalidad usa `action.<id>.description`; si encabeza
un acordeón, cabecera y tarjeta reutilizan esa misma traducción. Las notas
operativas largas (`hint`) y las finalidades que aún no tengan entrada propia
siguen el respaldo español en vez de mezclar una clave interna con el texto
visible; el mecanismo y el validador ya las contemplan.

---

## Datos, logs y diagnóstico

| | Windows | Linux |
|---|---|---|
| `userData` | `%APPDATA%\winslim-terminal\` | `~/.config/lterminal/` |
| Configuración | `settings.json` | `settings.json` |
| Biblioteca de scripts | `scripts\` | `scripts/` |
| Logs | `logs\main.log` (rota a `main.log.1` al superar 2 MB) | ídem |
| Variable de depuración | `WINSLIM_LOG_LEVEL=debug` | `LTERMINAL_LOG_LEVEL=debug` |

La interfaz no muestra un botón **Logs**: fue retirado para que la barra no
acumule superficies fijas. Los logs siguen disponibles en la ruta real indicada
arriba. Los archivos de inicialización y banner de cada sesión van a una carpeta
temporal por PID, de modo que dos instancias abiertas a la vez no se pisan ni se
borran los archivos al salir.

Los registros llevan hora UTC con milisegundos, identificador de sesión y
metadatos JSON. Se anotan la migración, el arranque, cada PTY, duración de
procesos y cierre. Para investigar una sesión concreta se puede usar
`LTERMINAL_LOG_LEVEL=debug` en Linux o `WINSLIM_LOG_LEVEL=debug` en Windows.

También se registran métricas segmentadas del WebView: `sinceStartMs` es el
tiempo desde que cargó el frontend y `durationMs` la operación concreta.
Incluyen `app.initial-load`, `app.ui-shell-visible`, disponibilidad para
escribir, `fastfetch.banner-visible`, montaje y resize de cada terminal,
impresión explícita del banner, `ui.panel.visible` para cada menú/panel e `ipc.*` para
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

### Idioma de los scripts

Cuando la Biblioteca escribe un script en la pestaña activa, WinSlim conserva
su intérprete y argumentos originales, pero añade la variable de entorno
`LTERMINAL_LANGUAGE` (`es`, `en`, etc.) al proceso. Así, los scripts propios o
integrados pueden seleccionar sus textos según el idioma elegido en Ajustes;
la aplicación no traduce código arbitrario ni cambia la sintaxis de PowerShell,
CMD, Bash, Python o Node.

### Auditoría de release y comportamiento observable

Una build correcta no basta: hay que abrir el artefacto que se va a entregar y
comprobar la ruta que recorrerá el usuario. La batería oficial hace lo siguiente:

1. Arranca el ejecutable desempaquetado de Windows y espera la confirmación de
   ventana, frontend, IPC, xterm y primera PTY; si falla `app.load()`, la ventana
   se revela para mostrar el error en vez de quedarse oculta.
2. Ejecuta el AppImage con su runtime normal y con extracción controlada, valida
   ELF/AppDir, y comprueba que termina sin procesos residuales.
3. Recorre comandos internos (`:help`, `:panel`, `:shell`, `:terminal`,
   `:language`, `:banner`, `:panes`), alias de shell, cambio de entorno,
   preferencias, paneles, acordeones, explorador, menús contextuales,
   pestañas, división, redimensionado y fastfetch.
4. Conserva capturas y un informe JSON fuera del repositorio. Los logs y
   capturas temporales se ignoran mediante `.gitignore`; la documentación
   mantenida se concentra en este README.

Al cambiar el idioma desde Ajustes o `:language`, la interfaz se actualiza y el
backend regenera en ese mismo momento los archivos `help-<pestaña>.txt`, sus
secciones y el runner de cada pestaña existente. No hace falta cerrar ni volver
a crear la shell. Si el arranque falla antes de montar xterm, el error se
presenta en la ventana mediante la ruta de recuperación `frontend_reveal`.

```bash
npm run check
```

Pasa la verificación de versión, recursos, arquitectura, scripts de build,
enlaces locales de documentación, traducciones, contratos cruzados,
lógica ejecutable del frontend, superficie de tests y superficie lógica,
`svelte-check`, `cargo fmt --check`, `cargo clippy -D warnings` y los tests de
Rust. Es lo que tiene que estar en verde antes de compilar.

La build Linux ejecuta por defecto la batería ampliada. Además del smoke test
de ventana/frontend/PTY, comprueba shells y herramientas instaladas y ejecuta
E2E con `tauri-driver`; si falta una precondición, el AppImage se publica y el
build informa el diagnóstico al final con código 1. Se puede omitir con `linux/build.sh --no-extended-tests` o
`windows/build.ps1 -NoExtendedTests`; en Windows `-FullTests` la selecciona
explícitamente. La falta del driver E2E se registra como diagnóstico y no
oculta el artefacto ya generado. El smoke recorre
Ajustes, Biblioteca, Proyectos, Entorno y dependencias, acordeones, explorador
y menú contextual, comandos internos, respuesta de la shell, división y
varios tamaños de ventana. También ejecuta los atajos globales de nueva pestaña,
navegación entre pestañas, división y explorador, conservando capturas antes y
después. Repite refrescos de entornos, clics de
división y aperturas de paneles para detectar carreras y estados residuales.
El informe JSON se vuelve a validar al terminar y debe contener las once fases,
los dos estados de `:quick-actions` y evidencias de menú contextual,
grupos/submenús de dependencias y la matriz responsive con dos paneles y el
explorador visible y oculto. Una ventana que solo arranca y se cierra ya no
puede contarse como E2E superado.
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
Maven, Gradle, Ant, Dart, Kotlin, Elixir, Nim y Scala no se anuncian con IDs
fiables de WinGet para este catálogo; sus acciones de Windows usan Chocolatey
como vía alternativa y preparan el gestor si todavía no está instalado. Elixir
documenta oficialmente ese procedimiento y su paquete incorpora Erlang como
dependencia. PostgreSQL usa el ID versionado `PostgreSQL.PostgreSQL.18`
que publica la fuente actual y, si WinGet no puede instalarlo, prueba el paquete
`postgresql` de Chocolatey. El panel indica expresamente cuándo interviene
Chocolatey porque es una fuente comunitaria, no un manifiesto de WinGet.
VMware Workstation Pro tampoco se intenta buscar con WinGet: se abre su descarga
oficial en el portal de Broadcom, que requiere iniciar sesión y completar la
descarga manualmente.

Para ampliar el catálogo de lenguajes de Windows sin fingir que existe un
instalador nativo para cada ecosistema, también se ofrecen Haxe, Octave, Racket,
Maxima, SBCL, SWI-Prolog, Erlang y SQLite mediante WinGet. OCaml se ofrece como paquete UCRT64
independiente de MSYS2. GCC, GFortran y GDB se instalan como
toolchain UCRT64 de MSYS2 y se añade su `ucrt64\\bin` al PATH del usuario; la
acción busca la raíz real de MSYS2 en vez de asumir una única carpeta. Haskell
usa GHCup y su bootstrap oficial de PowerShell, que puede instalar GHC, Cabal,
Stack y HLS. AutoHotkey v2 también tiene instalador WinGet y una detección que
contempla instalaciones fuera del PATH. Las fuentes alternativas solo se
ofrecen cuando tienen una sonda posterior verificable, y no se convierten en
instaladores Linux ni en acciones de WSL por accidente.

El bloque de herramientas de desarrollo incluye GitHub CLI, Git LFS, ripgrep,
fd, fzf, bat, eza y just; Windows añade Terraform, OpenTofu, AWS CLI y Azure CLI.
Contenedores y Kubernetes incluye Docker, Podman, kubectl, Helm y k9s, y en
Windows también minikube, kind y Kustomize. Linux solo presenta una entrada
cuando el gestor detectado tiene un nombre de paquete conocido; no se fuerza un
paquete de otra distribución para igualar contadores.

**El panel de dependencias tarda un par de segundos en abrir.** Refleja el
estado actual del sistema, no el del arranque: consulta el PATH y comprueba por
lotes las herramientas aplicables. La detección de virtualización y el inventario de WSL sí
están cacheados.

**El primer arranque tras compilar puede tardar.** El antivirus inspecciona un
ejecutable recién creado.

## Créditos

Desarrollado por [Darkeiser003](https://github.com/Darkeiser003), con la
colaboración de [Christianlg97](https://github.com/Christianlg97). Sus proyectos
relacionados son [WinSlim Center Store](https://github.com/Christianlg97/WINSLIM_CENTER_STORE)
y [WinSlim Update](https://github.com/Christianlg97/WinSlim-Update).
