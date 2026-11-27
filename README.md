# WTerminal / LTerminal (1.0.0)

---

Terminal multipestaña de escritorio construida sobre Tauri 2, Rust y xterm.js.
Detecta las shells, distribuciones WSL, contenedores Docker y dispositivos
Android disponibles en la máquina y los ofrece como entornos intercambiables
dentro de la misma ventana. Funciona además como hub local de proyectos GitHub
y como lanzador de scripts.

La aplicación se llama **WTerminal** en Windows y **LTerminal** en
Linux. No es una marca distinta: es la misma base con identidad,
identificador y rutas de datos propias por plataforma (`src-tauri/src/config/identity.rs`).

Este README explica el uso, la arquitectura y los procedimientos de
validación. El [mapa técnico de archivos y llamadas](#mapa-de-archivos-llamadas-y-mantenimiento)
completa cada ruta de `src/` y `src-tauri/src/`, las llamadas entre
Svelte, Tauri y Rust y los diagramas Mermaid de los flujos principales. Si
modificas uno de esos flujos, actualiza ambos documentos junto al código.
Para proponer cambios, consulta [CONTRIBUTING.md](CONTRIBUTING.md); los reportes
de seguridad se reciben por el canal privado de [SECURITY.md](SECURITY.md).

| | |
|---|---|
| Versión | 1.0.0 |
| Plataformas | Windows 10/11 (x64), Linux (x64) |
| Runtime | Tauri 2 · Rust 1.77+ · Node.js ≥ 22.12.0 (solo para compilar) |
| Licencia | AGPL-3.0-only, y licencia comercial para empresas ([Licencia](#licencia)) |
| Idiomas | Español, inglés, francés, alemán, italiano, portugués, rumano, ruso, ucraniano, polaco, chino, japonés, coreano, hindi y árabe |

## Índice

- [Requisitos](#requisitos)
- [Instalación para usar la aplicación](#instalación-para-usar-la-aplicación)
- [Entorno de desarrollo](#entorno-de-desarrollo)
- [Limpieza del repositorio](#limpieza-del-repositorio)
- [Scripts npm](#scripts-npm)
- [Compilación y distribución](#compilación-y-distribución)
- [Arquitectura](#arquitectura)
- [Tecnologías y por qué se eligieron](#tecnologías-y-por-qué-se-eligieron)
- [Diagramas de flujo detallados](#diagramas-de-flujo-detallados)
- [Mapa de archivos, llamadas y mantenimiento](#mapa-de-archivos-llamadas-y-mantenimiento)
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
- [Marcas de orden](#marcas-de-orden)
- [Inteligencia artificial en la terminal](#inteligencia-artificial-en-la-terminal)
- [Paleta de comandos](#paleta-de-comandos)
- [Configuración](#configuración)
- [Internacionalización](#internacionalización)
- [Datos, logs y diagnóstico](#datos-logs-y-diagnóstico)
- [Perfiles portables y plugins](#perfiles-portables-y-plugins)
- [Pruebas](#pruebas)
- [Convenciones del código](#convenciones-del-código)
- [Comparativa con Alacritty y WezTerm](#comparativa-con-alacritty-y-wezterm)
- [Problemas conocidos](#problemas-conocidos)
- [Licencia](#licencia)
- [Créditos](#créditos)

---

## Requisitos

### 1. Para usar la aplicación

No hace falta nada adicional en la distribución
instalable. En Windows la interfaz usa el runtime WebView2 de Microsoft, que
Windows 11 y los Windows 10 al día ya traen. Las releases no llevan su
instalador dentro (son unos 215 MB de los ~223 de cada paquete): si falta, el
arranque lo detecta antes de crear la ventana y lo instala desde Microsoft, o
desde un instalador puesto junto al ejecutable, sin necesitar nada más (ver
[WebView2: si falta el runtime](#8-webview2-si-falta-el-runtime)). Para equipos
sin Internet existe la variante `-WebView2 Offline` de la build. En Linux,
el AppImage necesita las bibliotecas de escritorio habituales (WebKitGTK 2.40
o posterior), que cualquier distribución mantenida ya trae. El JavaScript se
compila para un único estándar, ES2023, igual en Windows (WebView2) y Linux
(`vite.config.ts`).

### 2. Para compilarla

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

Los chequeos de Rust lanzados desde npm usan `scripts/run-rust-tool.mjs`: si la
sesión ya estaba abierta cuando se instaló Rust, buscan también en
`%USERPROFILE%\\.cargo\\bin` y no exigen reiniciar la terminal para que `cargo
fmt`, `clippy` o los tests estén disponibles.

### 3. Para las pruebas E2E

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

### 4. Wine para la validación cruzada

Para compilar el ejecutable Windows desde Arch/CachyOS e inspeccionarlo bajo
Wine, instala las herramientas de la cadena cruzada y del entorno gráfico:

```bash
sudo pacman -S --needed mingw-w64-gcc zip wine winetricks cabextract unzip xdotool xorg-server-xvfb openbox
rustup target add x86_64-pc-windows-gnu
```

La batería Rust no necesita WebView2. El smoke predeterminado es headless:
ejecuta el PE Windows real bajo Wine, envía `echo` por stdin, comprueba que el
marcador vuelve por stdout/stderr y exige que la shell termine con código cero.
Usa pipes solo para esta validación; no prueba la GUI ni el ConPTY real. Windows
nativo sigue necesitando su validación propia. La batería y el smoke headless
comparten `WINE_SMOKE_PREFIX` o `WINEPREFIX`; si no se indica ninguno, usan
`~/.cache/lterminal/wine-smoke-prefix`, sin recurrir por defecto a `~/.wine`.

Después ejecuta:

```bash
LTERMINAL_REQUIRE_SIGNING=0 \
bash linux/build-windows.sh --fast --no-install --skip-checks --wine-smoke
```

También se puede fijar un prefijo concreto con `WINE_SMOKE_PREFIX=/ruta/al/prefijo`.
El backend temporal de pipes se activa solo con `LTERMINAL_TEST_UNDER_WINE=1`,
porque Wine no implementa `CreatePseudoConsole` con fidelidad suficiente.
`LTERMINAL_WINE_GUI_SMOKE=1` activa, como diagnóstico opcional, el smoke GUI:
localiza/instala WebView2 en `WINE_SMOKE_PREFIX`, `WINEPREFIX`, `~/.wine`, Lutris
o Steam. `LTERMINAL_WINE_XVFB=auto` (predeterminado) primero comprueba que el
display heredado responde a `xdpyinfo` y, si está roto o ausente, usa un Xvfb
privado. `=1` fuerza Xvfb y `=0` exige el display actual. El smoke busca la
ventana visible, espera a que WebView2 y el PTY estén preparados y guarda una
captura; falla si la imagen sigue negra o vacía. Esto valida la presentación
bajo Wine, no sustituye una prueba nativa de Windows ni demuestra ConPTY real.
La captura puede guardarse fuera de temporales mediante
`LTERMINAL_WINE_GUI_CAPTURE_DIR`. La instalación automática del Runtime GUI se
puede desactivar con `LTERMINAL_WINE_WEBVIEW2_AUTO_INSTALL=0`.

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

### 5. conpty.dll

En Windows la app **necesita** `conpty.dll`, `OpenConsole.exe` y
`WebView2Loader.dll` junto al ejecutable. Los dos recursos ConPTY se obtienen
durante el build desde el paquete oficial de Microsoft
`Microsoft.Windows.Console.ConPTY` (`1.24.260710001`), y se extraen solo tras
verificar el SHA-512 publicado por NuGet, las rutas exactas del ZIP, sus CRC,
los tamaños y la arquitectura PE x64. Se guardan en `src-tauri/vendor/conpty/`, una carpeta ignorada y
generada; no se versionan binarios PE en el repositorio. El tercero lo aporta
la dependencia de WebView2 al compilar para Windows. El ConPTY del sistema falla en algunos Windows
recortados con `STATUS_DLL_INIT_FAILED`, y el error tarda más de dos minutos en
aparecer: las pestañas se quedan en blanco sin decir por qué. `build.rs` copia
ConPTY en cada compilación y los scripts de build descargan/preparan la pareja
si no está presente o no coincide con la versión fijada. El instalador/portable
incluye los recursos junto al ejecutable.

## Instalación para usar la aplicación

### 1. Windows portable

La release nativa publica la carpeta desempaquetada,
su ZIP y un único `WTerminal-<versión>-Portable.exe`. La carpeta y el ZIP
traen `wterminal.exe`, `conpty.dll`, `OpenConsole.exe` y
`WebView2Loader.dll`. El
`-Portable.exe` es la misma aplicación en un solo archivo: se abre con doble
clic, sin diálogo de extracción ni archivos a su lado. Lleva dentro
`conpty.dll`, `OpenConsole.exe` y los avisos de
terceros, añadidos al final del ejecutable y fuera de la imagen PE, así que
Windows no los carga al arrancar. La app coloca en silencio su ConPTY en
`%LOCALAPPDATA%\WTerminal\runtime\<huella>`, verificado por SHA-256 y
reutilizado mientras no cambie. El cargador de
WebView2 va enlazado en el ejecutable. Se actualiza solo descargando el
`-Portable.exe` nuevo, que reemplaza al que corre, como un AppImage. En
cualquiera de las tres formas, si falta el runtime de WebView2, el arranque lo
resuelve antes de crear la ventana (ver
[WebView2: si falta el runtime](#8-webview2-si-falta-el-runtime)). No crea accesos
directos. Las operaciones de sistema se descubren desde
LTools / WTools.

### 2. Windows instalable

La release completa (`npm run dist:win`) y su alias
explícito `npm run dist:win:installer` generan un NSIS y lo publican como
`release/WTerminal-<versión>-x64-setup.exe`. De serie usa el
`downloadBootstrapper` de Tauri: si al instalar falta WebView2, el asistente
lo descarga de Microsoft; si ya está, no descarga nada. Con
`windows\build.ps1 -WebView2 Offline` el NSIS lleva el instalador offline
completo (pasa de unos 8 a unos 220 MB), y la carpeta y el portable reutilizan
ese mismo instalador: es la variante para equipos recortados o despliegues sin
Internet.
El asistente lleva el icono y las imágenes de WTerminal (barra lateral de
bienvenida y final, cabeceras del instalador y del desinstalador, en
`src-tauri/windows/installer/`, generadas con
`scripts/generate-installer-art.ps1`) y pregunta el idioma al empezar, en los
mismos 15 de la app: español, inglés, francés, alemán, italiano, portugués,
ruso, ucraniano, polaco, rumano, árabe, japonés, coreano, chino e hindi. La CLI
de Tauri no trae polaco, rumano ni hindi: sus textos van en
`src-tauri/windows/installer/{Polish,Romanian,Hindi}.nsh`
(`customLanguageFiles`).

### 3. Instalador modular

El asistente usa una plantilla propia,
`src-tauri/windows/installer/installer.nsi`: la de Tauri 2.11.5 con tres
cambios marcados con «WTerminal:» (al actualizar la CLI de Tauri hay que volver
a partir de la suya).

- Tras elegir la carpeta, una página de **componentes** deja elegir **WTerminal
  en el PATH** y **«Abrir con WTerminal» en el Explorador con los enlaces
  `wterminal://`**, las dos marcadas. Lo elegido queda en `first-run.json`
  junto al ejecutable (`hooks.nsh`), y cada usuario lo aplica una vez en su
  primer arranque (`platform::first_run::apply`, antes de añadirse al PATH de
  fábrica).
- Shells, sugerencias, paquetes y LTools no van en el instalador: se instalan
  desde la propia WTerminal, en una pestaña visible.
- En silencio (`/S`), en pasivo (`/P`) o al actualizar no hay página ni
  `first-run.json`: queda lo de fábrica de siempre (el PATH sí, el menú del
  Explorador no) y la suite del instalador no cambia.
- El **desinstalador** pregunta antes a `wterminal.exe
  --wterminal-uninstall-report` cuánto ocupan los datos y la carpeta propia.
  Ofrece dos casillas con su tamaño: **Borrar los datos de la aplicación** y
  **Borrar la carpeta propia** (cachés, herramientas y programas instalados
  desde WTerminal).
- La segunda casilla solo sale si la carpeta propia es la de fábrica o lleva
  la marca `LEEME-carpeta-propia-WTerminal.txt`, que WTerminal deja solo en
  una raíz que crea él (no existía o estaba vacía) y nunca en una raíz de
  disco (`toolchain_store::prepare_root`).
  Una carpeta elegida a mano que no sea suya (una raíz de disco, una carpeta
  con otras cosas) nunca se ofrece borrar.
- Lo que ocupa la carpeta propia solo se mide si sale su casilla
  (`first_run::measure_plan`): en la VM, una carpeta propia de 185 GB que no
  se podía borrar (llevaba `docker` y `wsl`) dejaba el desinstalador sin
  enseñar nada durante minutos mientras la medía. Aun saliendo, la medida se
  corta a los 15 s (`MEASURE_BUDGET`). Entonces la casilla dice lo contado
  como mínimo, «≥ 120.3 GB», sin palabras para que valga en cualquier idioma,
  y el informe lleva `partial=1`.
- `scripts/capture-installer-pages.ps1` recorre de forma visible el
  instalador y el desinstalador, y comprueba entre medias `first-run.json`,
  la línea del primer arranque en el registro, las casillas del
  desinstalador con los tamaños del informe y que al desinstalar se va
  `first-run.json`.

Al desinstalar, el propio `wterminal.exe`
(`--wterminal-uninstall-cleanup`, `platform::uninstall_cleanup`) deshace lo que
registró en el perfil del usuario: su carpeta y las `bin` de herramientas que
añadió al PATH de HKCU, los menús «Abrir con WTerminal», App Paths, el
protocolo `wterminal://` y la marca RUNASADMIN; antes quedaban apuntando a un
ejecutable borrado. Lo que registró otra copia que sigue existiendo (un portable
junto a la instalada) se queda como está. La casilla **Borrar los datos de la aplicación** borra
además `%APPDATA%\wterminal` (ajustes y registros) y `%LOCALAPPDATA%\WTerminal`
(perfil de Clink y caché del portable) **menos** la carpeta propia de fábrica
(`entornos`), que solo se borra con su propia casilla. En una actualización (`/UPDATE`) no se
deshace nada (`src-tauri/windows/installer/hooks.nsh`).
`scripts/capture-installer-pages.ps1` recorre el asistente de forma visible y
captura cada página del instalador y del desinstalador.

### 4. Linux

Un AppImage: `chmod +x LTerminal-*.AppImage` y se ejecuta. Lleva
todo dentro, funciona en cualquier distribución con WebKitGTK y se actualiza
solo, como el portable de Windows. Además están preparados tres formatos más,
que saldrán en la misma release que Windows cuando `linux/build.sh` los genere
y valide en Linux nativo (hoy solo genera el AppImage):

| Formato | Para quién | Cómo se instala | Cómo se actualiza |
|---|---|---|---|
| `LTerminal-<versión>-x86_64.AppImage` | Cualquier distribución, sin instalar | `chmod +x` y doble clic | Sola: el AppImage nuevo sustituye al que corre |
| `LTerminal_<versión>_amd64.deb` | Debian, Ubuntu, Mint, Pop!_OS, Kali… | `sudo apt install ./LTerminal_<versión>_amd64.deb` | Desde la app, con `pkexec` + `apt-get` (pide la contraseña con el diálogo del escritorio) |
| `LTerminal-<versión>-1.x86_64.rpm` | Fedora, RHEL, openSUSE… | `sudo dnf install ./LTerminal-<versión>-1.x86_64.rpm` (o `zypper install`) | Desde la app, con `pkexec` + `dnf`, `zypper` o `rpm -U` |
| `LTerminal-Unpacked-<versión>-x86_64.tar.gz` | Quien prefiere una carpeta, como la unpacked de Windows | Descomprimir y ejecutar `lterminal` | Sola, copiando encima, como la carpeta de Windows |

Con `.deb` o `.rpm` la app queda en el menú del escritorio, con su icono y sus
metadatos AppStream (también en los centros de software), y el gestor del
sistema sabe qué versión hay y qué archivos son suyos: se desinstala desde el
gestor de paquetes o el centro de software sin dejar restos. El
AppImage es el formato obligatorio de cada release; los demás son opcionales.
No hay Flatpak ni Snap: su aislamiento impide que una terminal vea las shells,
toolchains y archivos del sistema. AUR queda para más adelante.

#### 4.1 Lo de Windows que también tiene Linux (17-11)

La interfaz es la misma en las dos plataformas: avisos, chat de IA, paleta,
marcas de orden, Biblioteca, perfiles portables y casi todos los ajustes. Lo
que en Windows depende del sistema tiene en Linux su equivalente:

| En Windows | En Linux |
|---|---|
| Guardar la clave de API de una IA cifrada con DPAPI | En el llavero del escritorio (Secret Service: GNOME Keyring, KWallet…) con `secret-tool` de libsecret. En `ai-keys.json` solo queda la marca `secret-service`; borrarla en Ajustes la quita también del llavero. Sin `secret-tool` no se ofrece, como antes (`environments/ai_keys.rs`) |
| «Abrir con WTerminal» en el Explorador | «Abrir con LTerminal» en «Abrir con» de las carpetas: una entrada de escritorio del usuario, `~/.local/share/applications/lterminal-open-here.desktop` con `MimeType=inode/directory`, que lanza la AppImage (`APPIMAGE`) y no su montaje temporal. Casilla en Ajustes › General (`platform/desktop_entry.rs`) |
| Perfiles portables en `%LOCALAPPDATA%\WTerminal\entornos\configuracion\perfiles` | En `~/.local/share/LTerminal/entornos/configuracion/perfiles`, como `.sh` |
| Acciones en `ui-N.ps1` / `ui-N.cmd` | En `ui-N.sh` (o `.fish`) de la carpeta de sesión, como en Git Bash y WSL |

Lo que no tiene equivalente, porque en Linux no existe el problema: WebView2,
NSudo y gsudo (y su aviso), el ancho visible de Python (es de ConPTY), la
página de componentes del instalador y el informe del desinstalador (la
AppImage no se instala).

Estas dos piezas de Linux están escritas para compilar también en Windows, así
que clippy y las pruebas de Windows revisan su lógica (los argumentos de
`secret-tool` y el texto de la entrada de escritorio). Lo que no se ha podido
comprobar todavía es su funcionamiento en un Linux de verdad: la VM se quedó
sin hipervisor el 17-11 y sin WSL no se puede compilar ni probar la AppImage.

### 5. Carpeta propia: cachés, descargas, modelos, herramientas e historial

Lo que descargan y crean desde WTerminal los gestores de paquetes, las
herramientas y los REPL se guarda en `%LOCALAPPDATA%\WTerminal\entornos` (en
Linux, bajo `~/.local/share/LTerminal/entornos`), por categorías:

| Categoría | Subcarpeta | Variables | De fábrica |
|---|---|---|---|
| Cachés | `cache\` | `npm_config_cache`, `YARN_CACHE_FOLDER`, `BUN_INSTALL_CACHE_DIR`, `DENO_DIR`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GOMODCACHE`, `GOCACHE`, `NUGET_PACKAGES`, `COURSIER_CACHE`, `COMPOSER_CACHE_DIR`, `PUB_CACHE` | activa (con el interruptor general) |
| Descargas del panel | `descargas\panel` | `WTERMINAL_DOWNLOADS` (lo usan las acciones que descargan antes de instalar, como ADB) | activa |
| Modelos de IA | `ia\` | `HF_HOME`; `OLLAMA_MODELS` solo si aún no hay modelos en la carpeta de siempre de Ollama | activa |
| Herramientas y lenguajes nuevos | `herramientas\` | `npm_config_prefix`, `CARGO_INSTALL_ROOT`, `GOBIN`, `PYTHONUSERBASE`, y su carpeta de programas delante en el PATH de WTerminal y, con la integración con el PATH, también en el del usuario | activa |
| Historial de los REPL | `historial\` | `NODE_REPL_HISTORY`, `PYTHON_HISTORY` (3.13+), `SQLITE_HISTORY`, `PSQL_HISTORY` | activa |
| Toolchains completas | `toolchains\` | `RUSTUP_HOME`, `CARGO_HOME` (con su `bin`), `GOPATH` (con su `bin`), `GRADLE_USER_HOME`, `DOTNET_CLI_HOME`, `ANDROID_USER_HOME`, `CABAL_DIR`, `STACK_ROOT`, `MIX_HOME`; cada una solo si no existe ya su carpeta de siempre (`~\.rustup`, `~\.cargo`, `~\go`…) o si la trajiste con «Traer lo ya instalado» | activa |
| Configuración de los REPL | `configuracion\` | `IPYTHONDIR`, `JUPYTER_CONFIG_DIR`; como las toolchains, solo si aún no existía la de siempre o si la trajiste | activa |
| Plugins de las shells | `plugins\` | `STARSHIP_CACHE`, y el perfil de Clink que WTerminal pasa a cmd con `--profile` (`plugins\clink`; no se usa `CLINK_PROFILE`, que lo anularía) | activa |
| Proyectos de GitHub | `proyectos\<propietario>\<repositorio>` | Carpeta de Proyectos de fábrica (`projects::github::projects_folder`) si no elegiste otra en Ajustes; los que ya tenías en Documentos no se mueven | apagada |
| Programas (WinGet y Chocolatey) | `programas\<id>` | `WTERMINAL_PROGRAMS`: las acciones «Instalar» de WinGet añaden `--location`; Chocolatey va a `programas\chocolatey` (sus paquetes, en su `lib\`) y sus herramientas sueltas a `programas\chocolatey-tools` | activa |

WTerminal exporta esas variables estándar solo a los procesos que lanza
(pestañas y sondas de detección): no toca las variables del sistema, respeta
las que el usuario ya tenga definidas y **nunca mueve nada ya instalado**. De
fábrica se centralizan todas menos «Proyectos de GitHub», que siguen en
Documentos:

- **Herramientas y lenguajes nuevos** cambia dónde se instala lo nuevo. Lo que
  ya tenías sigue donde estaba y se sigue detectando. Las carpetas `bin`
  nuevas van delante en el PATH de WTerminal (`process::set_extra_path`) y,
  mientras «Invocar WTerminal desde el PATH» esté activa (lo está de fábrica),
  también al **final** del PATH del usuario (`path_integration::sync_tool_bins`,
  solo `HKCU`): así lo instalado desde WTerminal se ve en cualquier terminal
  sin tapar lo que ya tenías. WTerminal apunta en
  `HKCU\Software\WTerminal\PathIntegration` (`ToolBinDirs`) cuáles añadió él y
  solo quita esas al apagar la categoría o la integración; una carpeta que ya
  estaba en tu PATH no se toca nunca (`path_with_tool_bins`). Se sincroniza al
  arrancar, al guardar Ajustes y al activar o desactivar la integración; en
  Linux, por ahora, solo dentro de WTerminal. Actualizar con la categoría
  activa una herramienta instalada antes deja una segunda copia en la carpeta
  propia, que es la que se usa dentro de WTerminal.
- **Historial de los REPL** separa el historial de los intérpretes abiertos
  desde WTerminal del que tengas fuera.
- **Toolchains completas** instala rustup, cargo, Go, Gradle, .NET o el perfil
  de Android en la carpeta propia, pero solo los que aún no tenías en su sitio
  de siempre (`toolchain_preinstalled`): con la variable apuntando a una
  carpeta vacía, lo ya instalado dejaría de verse. Con la integración con el PATH, las
  carpetas `bin` de cargo y Go se publican en el PATH del usuario junto a
  `CARGO_HOME` y `RUSTUP_HOME` (`BIN_REQUIRES`), así que Rust y Go también
  funcionan fuera de WTerminal.
- **Programas (WinGet y Chocolatey)**, activa de fábrica, lleva también los
  programas a la carpeta propia: cada acción «Instalar» del catálogo pasa por
  `centralized_install`, que añade `--location <carpeta>\programas\<id>` a
  WinGet (Git, Node, Python, los editores…). Chocolatey se instala en
  `programas\chocolatey` (`ChocolateyInstall`), donde quedan sus paquetes
  portables, y sus herramientas sueltas en `programas\chocolatey-tools`
  (`ChocolateyToolsLocation`), salvo que ya tengas esas variables. A sus
  paquetes no se les pasa `--install-directory`: es una opción de las
  ediciones de pago y la libre rechaza la orden entera (comprobado en la VM);
  si uno trae un instalador que va a Program Files, se ofrece moverlo como con
  WinGet.
  Muchos instaladores lo respetan; los que no (en la VM con todo el catálogo:
  Octave, el SDK de .NET, Julia, Swift, MySQL, mongosh o la caché de paquetes
  de LM Studio) acaban en Program Files o en `%LOCALAPPDATA%\Programs`. La
  acción compara esas carpetas antes y después, dice dónde quedó y pregunta si
  moverlo a la carpeta propia: con «s» lo mueve con `robocopy /MOVE` en una
  PowerShell elevada (un aviso de UAC) y deja una **unión** en su sitio, así
  que las rutas, los accesos directos, los servicios y «Aplicaciones
  instaladas» siguen funcionando; si algo está en uso, lo devuelve a su sitio
  en vez de dejarlo partido. Lo ya instalado no se mueve, y la detección
  encuentra estos programas por WinGet y por la carpeta que registran en
  «Aplicaciones instaladas». Sin la categoría, la orden es la de siempre.
- **Instaladores que rechazan la carpeta propia** (21-11, VirtualBox): el de
  VirtualBox se niega a instalarse en una carpeta donde un usuario normal puede
  escribir («Invalid installation directory specified!», error 1603 en el
  Visor de eventos), y su protección solo carga sus controladores desde una
  carpeta segura, así que moverlo tampoco vale. Los paquetes así
  (`WINGET_SYSTEM_LOCATION`) van directos a su carpeta de siempre, sin
  `--location` y sin ofrecer moverlos. Para los que no se conocen: si WinGet
  dice que el instalador falló (`0x8A150006`) con la carpeta propia, la acción
  lo avisa y repite la instalación **una vez** sin ella.
- **La cabecera enseña solo la orden que instala**
  (`winget install --id … -e --source winget …`), no el guion entero de la
  carpeta propia, que en cmd ocupaba decenas de líneas (`command_preview`).
- **Cuando una instalación falla, se dice por qué** (22-11): el marco ya
  avisaba «terminó con error», pero con VirtualBox la salida solo decía
  «código de salida: 1». Ahora, si la orden falla, la acción busca lo que
  Windows Installer apuntó desde que empezó (Visor de eventos, `MsiInstaller`)
  y lo enseña debajo («Windows Installer explica el fallo: …»); si no hay
  nada y WinGet dice que falló el instalador, dice dónde está su registro.
- **El catálogo guardado lleva el sello de la build** (22-11): la app guarda el
  catálogo entero en `install-actions-snapshot.json`, órdenes incluidas, para
  pintarlo al momento al abrir. Antes valía para cualquier build, así que una
  build nueva seguía ejecutando las órdenes de la anterior: la 82 instaló
  VirtualBox con la orden vieja (con la carpeta propia) aunque llevaba el
  arreglo. Ahora el archivo lleva el tamaño y la fecha del programa que lo
  escribió y otra build lo tira y lo rehace (`install_snapshot_build`).

### 6. Gestionar la carpeta propia

Se abre en Ajustes → Comportamiento → «Gestionar la carpeta propia…» (vista
propia `StorePanel.svelte`). Desde ahí se decide dónde va cada categoría, se
apaga lo que no se quiera centralizar, se trae lo que ya estaba instalado
fuera y se exporta la lista para repetirla en otro equipo.

#### 6.1 La carpeta de cada categoría

De fábrica todas van dentro de la carpeta
propia; cualquiera puede ir a otro sitio (por ejemplo los modelos de IA a
otro disco). Se guarda en `toolchainStoreCategoryDirs` (`categoría=carpeta`
por línea) y lo aplica `toolchain_store::category_base`. Lo que ya estaba en
la carpeta anterior no se mueve. No se admiten raíces de disco ni carpetas
que pisen la de otra categoría (`safe_category_dirs`), y «Vaciar cachés»
vacía la carpeta de la categoría Cachés solo si no es una raíz de disco, la
carpeta personal ni la de otra categoría.

#### 6.2 Apagar un elemento suelto

Cada entrada de una categoría activa se puede
apagar sola (`toolchainStoreDisabled`): las terminales nuevas vuelven a su
sitio de siempre.

#### 6.3 Traer lo ya instalado

`config::store_adopt` busca lo que tienes fuera
de la carpeta propia (cachés, herramientas, toolchains, configuración de los
REPL, el perfil de Clink y los programas de «Aplicaciones instaladas» en
Program Files o `%LOCALAPPDATA%\Programs`) y enseña su espacio y qué se haría.
Al traerlo, primero **copia** sin tocar el original y comprueba que cada
archivo está en la copia; después la variable apunta a la copia (la entrada
queda «traída» en `store-journal.json` y se reubica aunque ya existiera) o,
para un programa, el original pasa a `<carpeta>.wterminal-antes` y en su
sitio queda una unión hacia la copia (si el programa está abierto, no se
toca nada; si falla algo después de copiar, el original recupera su nombre y
la copia se borra). Los programas de **Program Files no se traen**: su copia
quedaría en una carpeta en la que el usuario puede escribir, y un servicio o
una tarea elevada cargaría de ahí sus EXE y DLL; dos programas que irían a
la misma carpeta tampoco se traen juntos.
**Confirmar** borra el original; hasta entonces **Deshacer** lo deja todo
como estaba. Si Confirmar se queda a medias (un archivo en uso), el elemento
queda «confirmando»: ya no se puede deshacer, porque la copia es la única
completa, y se ofrece **Volver a confirmar**. Deshacer tampoco borra la copia
si el original ya no está.
Cada archivo se copia con el nombre `<archivo>.wterminal-parcial` y se
renombra al terminar, y la comprobación mira también el tamaño en lo que no
se mezcla; los enlaces y uniones del original (`npm link`, `rustup toolchain
link`) se vuelven a crear en la copia. El diario se apunta antes de copiar:
una copia cortada (WTerminal cerrado, equipo apagado) sale como fallida y se
repite desde el principio, y lo que dejó el script de un programa que siguió
solo se concilia con el disco al abrir la lista. El diario se escribe en un
temporal que se renombra encima (la versión anterior queda en
`store-journal.json.bak`); si no se puede leer, la vista lo dice y no se
cambia nada. Las cachés y las herramientas se mezclan con lo que ya hubiera
en la carpeta propia; lo demás exige que el destino esté vacío. No se ofrece
traer lo que se pisa (`AdoptConflict`): un origen que es su propio destino,
lo contiene o está dentro de él, que está dentro de la carpeta propia o la
contiene, o que comparte carpeta con otro elemento. «cargo install» no se
trae por separado (su `bin` lleva los proxies de rustup y su registro vive
en CARGO_HOME: va con «Rust (cargo)»), y en Linux `pip --user` tampoco
(su ubicación de siempre es `~/.local`, que es de todo el usuario). Los
programas instalados con **MSI no se traen**: sus actualizaciones fallan si
su carpeta es una unión (mongosh dio el error 1603 al poner permisos); para
ellos, desinstalar e instalar desde Dependencias, que ya los pone en
`programas\<id>`. Con la integración con el PATH activa, las variables de lo
traído se publican también en el usuario (`published_variables`), así que
rustup, cargo o IPython lo siguen encontrando fuera de WTerminal tras borrar
el original; si está apagada, la vista lo avisa.

#### 6.4 Exportar e importar la lista

(`wterminal-store-v1`): la configuración
de la carpeta propia y las acciones «Instalar» del catálogo que ya están
hechas. Lo hecho se saca de la comprobación completa de Dependencias, que
quita las instalaciones que su sonda da por hechas: son las del catálogo sin
filtrar (`probed_install_ids`) que no salen en ella. Sin esa comprobación
(Dependencias sin abrir, justo después de instalar algo, bajo consumo),
exportar e importar esperan a la de fondo y, si no hay, piden abrir
Dependencias. Al importar se aplican los ajustes y la vista enseña lo que
falta, cada cosa con su botón «Instalar» (en una pestaña visible, como desde
Dependencias); lo que ya está instalado aquí no se cuenta, y lo que este
catálogo no conoce se lista aparte.

#### 6.5 Los modelos de Ollama

Con Ollama hay un matiz: los modelos los guarda su servidor, que suele
arrancar la aplicación de Ollama fuera de WTerminal con su propia carpeta. Por
eso `OLLAMA_MODELS` solo se fija si todavía no tienes modelos; entonces es la
carpeta que usa «Arrancar el servidor de Ollama» desde el panel, y la detección
de modelos del selector la lee también. Los modelos que ya tienes no se tocan.

#### 6.6 «Entornos y descargas» en Ajustes

Ajustes → Comportamiento → «Entornos y descargas» tiene el interruptor general,
uno por categoría (con lo que cambia cada una), la carpeta, el tamaño de cada
entrada y dónde está: con su categoría apagada (o el interruptor general
apagado) cada entrada sigue apareciendo con la **ubicación de siempre** de la
herramienta y su espacio (`%LOCALAPPDATA%\npm-cache`, `%APPDATA%\npm`,
`~\.cargo`, `~\go\bin`, `%APPDATA%\Python`, `~\.node_repl_history`…, marcada
«sin centralizar · ubicación actual»; `system_location` en
`config/toolchain_store.rs`), y con una variable tuya, tu carpeta. Además hay
otras ubicaciones conocidas (solo lectura) y «Vaciar cachés», que solo borra
las cachés que están en la carpeta propia. El espacio de las ubicaciones de
siempre se mide una vez y se reutiliza 10 minutos (`cached_system_size`), igual
que el de las ubicaciones externas: recorrer `~\.cargo` o el npm global
tardaba de 7 a 11 s en cada apertura de Ajustes y, como el comando retiene su
hilo mientras mide, varias aperturas seguidas dejaban el guardado automático
esperando. Las carpetas que define el usuario con su variable siguen la misma
regla. Las cachés de la carpeta propia se miden siempre en el momento. Ajustes
espera como mucho 3 s a todas esas mediciones (`STATUS_MEASURE_BUDGET`): con
las variables apuntando a carpetas grandes (en la VM con todo el catálogo,
GOPATH, `pip --user` con PyTorch y TensorFlow o el npm global) medirlas pasaba
de 20 s y la lista no salía; lo que no termina se ve como «…» (`measuring`) y
la medición sigue en segundo plano para la siguiente apertura o «Recalcular».
Los tres comandos de esta sección (`toolchain_store_status`,
`toolchain_store_external_sizes` y `toolchain_store_clear_caches`) son `async`
y miden en `spawn_blocking`: la primera medición externa pasa del minuto en
frío y cada apertura de Ajustes pedía otra que esperaba a la anterior dentro
de un hilo del runtime; con ocho aperturas la app dejaba de responder.

#### 6.6.1 Limpiar lo que se puede volver a generar

Debajo de «Vaciar cachés», **«Limpiar archivos que se pueden volver a
generar»** (`config/regenerable.rs`, 24-11) junta en una sola limpieza, que se
elige por partes, todo lo que WTerminal puede volver a crear:

| Parte | Qué borra | Qué pasa después |
|---|---|---|
| Cachés de la carpeta propia | npm, pip, Go… (lo mismo que «Vaciar cachés») | Se vuelven a descargar al hacer falta |
| Descargas del panel | Instaladores y archivos que bajan las acciones (`entornos\descargas`) | Se vuelven a bajar si se repite la acción |
| Caché de detección | Entornos, discos, hardware y programas | La próxima detección tarda algo más |
| Copia antigua del registro | `main.log.1` | Nada: el registro actual se queda |

- Cada parte enseña lo que ocupa; «Limpiar lo marcado» pide confirmación con
  el total.
- Nunca toca programas instalados, ajustes, chats ni proyectos. Las descargas
  solo se vacían si su carpeta no es la raíz de un disco, no contiene tu
  carpeta personal y no se cruza con otra categoría.
- Los temporales de sesión no hace falta: se borran solos al arrancar.
- **Limpieza automática** (`regenerableAutoClean`, **apagada** de fábrica): al
  abrir WTerminal, si pasaron `regenerableAutoCleanDays` días (30 de fábrica)
  desde la última, limpia las partes marcadas. Las casillas son los mismos
  ajustes para la limpieza a mano y la automática (`regenerableCleanCaches`,
  `…Downloads`, `…Detection` y `…Logs`, encendidos).

#### 6.7 Todas las carpetas que usa WTerminal

En esa misma sección están **todas las carpetas que usa WTerminal** y las de
otras herramientas, con su tamaño. Al pasar el ratón (o el foco del teclado)
por cualquiera, una tarjeta explica para qué sirve, quién la crea y si se puede
borrar, con un punto de color: verde, se puede borrar (temporales, registros o
cachés que se vuelven a generar); ámbar, con cuidado (contiene programas
instalados o configuración); rojo, no se borra a mano (se gestiona con su
propia herramienta). La tarjeta se coloca siempre dentro del panel de Ajustes,
debajo de la fila o encima si no cabe, y se recoloca tras medirse si la ruta
o el texto la hacen más alta (`src/lib/floating-tip.ts`).

| Carpeta | Qué es | ¿Se puede borrar? |
|---|---|---|
| Ajustes (`%APPDATA%\wterminal\settings.json`) | Tus preferencias | No: volverías a la configuración de fábrica (usa «Exportar perfil») |
| Biblioteca de scripts | Los scripts que guardas | Solo si ya no los quieres |
| Plugins | Plugins instalados y sus copias de seguridad | Mejor desde Ajustes → Plugins |
| Registros (`logs`) | Diagnóstico (`main.log`, rota solo) | Sí, se vuelve a crear |
| Caché de detección | Resultados de Entorno y dependencias, discos, hardware y programas | Sí, la próxima detección tarda algo más |
| Chats con IA (`agent-chats`) | Tus conversaciones del chat, los abiertos y los fijados | Solo si ya no las quieres; mejor desde el historial del chat |
| Datos de la interfaz (WebView2/WebKitGTK) | Caché y almacenamiento del motor de la interfaz | Sí, con la app cerrada |
| Temporales de sesión (`%TEMP%\wterminal`) | Scripts de inicio y banners, una carpeta por proceso | Sí; WTerminal borra al arrancar las de procesos que ya no existen |
| Proyectos | Tus repositorios clonados | No: es tu trabajo |
| Componentes del portable (`runtime`) | ConPTY que extrae el portable de un solo archivo | Sí, con la app cerrada; se vuelve a extraer |
| Perfil de Clink | Historial y ajustes de Clink en cmd | Sí, pero pierdes el historial de cmd |
| Cachés centralizadas (npm, pip, Go…) | Descargas de cada gestor | Sí, «Vaciar cachés» |
| Descargas del panel (`entornos\descargas`) | Archivos que bajan las acciones antes de instalar | Sí |
| Modelos de IA (`entornos\ia`) | Hugging Face y, si los había, modelos de Ollama | Sí, pero hay que volver a descargarlos (mejor «Borrar» cada modelo) |
| Herramientas nuevas (`entornos\herramientas`) | Lo instalado con npm -g, cargo, go o pip --user con la categoría activa | No a mano: desinstálalas desde el panel |
| Historial de los REPL (`entornos\historial`) | Historial de Node, Python, SQLite y psql | Sí, se pierde ese historial |
| Cargo, rustup, Go, Bun, npm global | Herramientas y compiladores instalados | Con cuidado: usa su desinstalador |
| Cachés de npm, pip, pnpm, Yarn, uv, Deno, NuGet | Descargas de cada gestor | Sí, con su orden de limpieza |
| Gradle, Maven | Dependencias y configuración (con credenciales) | Conserva `gradle.properties` y `settings.xml` |
| Modelos de Ollama | Modelos de IA locales | Con `ollama rm` o desde el panel |
| WinGet, Chocolatey, Scoop, Docker, distros WSL | Programas, contenedores o sistemas completos | No a mano: con su propia herramienta (`wsl --unregister`, `docker system prune`…) |

### 7. Cómo se actualiza cada forma de distribución

#### 7.1 Cuándo busca actualizaciones

La aplicación consulta sus actualizaciones en su repositorio propio, que se
mantiene separado de los proyectos anclados: no aparece en la biblioteca ni se
puede clonar desde el panel como proyecto. El porqué de cada paso está en
`src-tauri/src/updater/self_update.rs`.

La comprobación se inicia en segundo plano después de montar la interfaz. Si
encuentra una release estable, el aviso inferior solo aparece tras autenticar
con Ed25519 el manifiesto y confirmar que este declara el SHA-256 del artefacto
de la plataforma. El paquete completo se descarga y vuelve a verificarse solo
si se pulsa «Actualizar y reiniciar». También se consulta el gestor nativo de
paquetes (WinGet en Windows; apt, dnf, pacman, zypper o apk en Linux); ese aviso
solo informa y abre Entorno y dependencias. No instala aplicaciones en segundo
plano. El gestor puede refrescar su propia caché durante la consulta, que tiene
un timeout y nunca bloquea la interfaz. Las dos consultas al arrancar se pueden
apagar por separado en Ajustes › Privacidad y red (ver
[Privacidad y red](#11-privacidad-y-red)); el panel de Dependencias sigue pudiendo
buscar actualizaciones a mano.

#### 7.2 Cómo se aplica en cada forma de distribución

Cada copia sabe cómo se instaló (`self_update::PackageKind`) y solo acepta su
propio adjunto de la release (`asset_for_package`, por el final del nombre y,
en Linux, descartando otras arquitecturas):

| Copia | Cómo se reconoce | Adjunto | Cómo se aplica |
|---|---|---|---|
| Portable de un solo archivo | Lleva la cola `WTPORT01` | `-Portable.exe` | El archivo nuevo sustituye al que corre (renombrado a `.old`) y la app se reinicia |
| Carpeta desempaquetada | Ni portable ni `uninstall.exe` | `.zip` | Se extrae, se copia a `<nombre>.new` y, solo si todo copió bien, se renombra; si algo falla se deshace |
| Instalada con el NSIS | `uninstall.exe` junto al ejecutable | `-setup.exe` | Se baja a `%LOCALAPPDATA%\WTerminal\update`, un aviso de UAC y el instalador en modo pasivo (`/P /UPDATE /R`), que mantiene desinstalador, registro y accesos directos |
| AppImage | `$APPIMAGE`, que exporta su runtime | `.AppImage` | Como el portable: el archivo nuevo, con permiso de ejecución, sustituye al que corre |
| `.deb` | Binario bajo `/usr` que `dpkg-query -S` reclama | `.deb` | Se baja a `~/.cache/lterminal/update` y se instala con `pkexec apt-get install -y` (o `dpkg -i`); cancelar la contraseña no cambia nada |
| `.rpm` | Binario bajo `/usr` que `rpm -qf` reclama | `.rpm` (nunca el `.src.rpm`) | Igual, con `pkexec` y `dnf`, `zypper` o `rpm -U` |
| Carpeta del `.tar.gz` | Lo demás (home, `/opt`, `/usr/local`) | `.tar.gz` | Como la carpeta de Windows, con el binario comprobado como ELF |

A `dpkg` y `rpm` solo se les pregunta por un binario bajo `/usr` (y no
`/usr/local`), una vez por arranque. En todos los casos el paquete se verifica
contra el `SHA256SUMS.txt` firmado antes de tocar nada. Sin `pkexec` o sin
gestor, la app dice dónde dejó el paquete verificado para instalarlo a mano.

### 8. WebView2: si falta el runtime

Antes de crear la ventana, `platform/windows/webview2.rs` (`ensure_runtime`)
comprueba si el runtime está instalado. Si falta:

1. Usa un instalador puesto **junto al ejecutable**
   (`MicrosoftEdgeWebView2Setup.exe`,
   `MicrosoftEdgeWebView2RuntimeInstallerX64.exe`, que es el offline de
   Microsoft, o `WebView2Bootstrapper.exe`) o el que lleva dentro el portable
   de una build `-WebView2 Offline` (la carpeta de esa build lo trae a su lado
   como `MicrosoftEdgeWebView2Setup.exe`).
2. Si no hay ninguno, descarga el bootstrapper oficial
   (`go.microsoft.com/fwlink/p/?LinkId=2124703`, como mucho 20 MB).
3. Antes de ejecutar cualquiera, comprueba su firma Authenticode con
   `WinVerifyTrust`: tiene que estar firmado por Microsoft Corporation con una
   CA de Microsoft. Un archivo con otro firmante o sin firma no se ejecuta.
4. Si nada funciona, un diálogo de Windows (sin la interfaz web, que es lo que
   falta) ofrece reintentar la descarga, elegir un instalador del disco, abrir
   la página de Microsoft o salir.

Ajustes › Privacidad y red › «Si falta WebView2» decide qué hace el arranque:
**preguntar** (de fábrica: el diálogo, antes de descargar nada),
**descargar sin preguntar** o **no descargar nunca** (solo un instalador
local; si no hay, el diálogo sin la opción de descarga). La misma lógica se
puede lanzar a mano, por ejemplo para preparar un equipo sin Internet con el
instalador offline de Microsoft. `wterminal.exe` es una aplicación de ventana:
lanzado tal cual, PowerShell y cmd no esperan a que termine. Con
`Start-Process -Wait` (o `start /wait` en cmd) se espera y se lee el código de
salida, y los mensajes salen en la misma consola:

```powershell
# Busca un instalador junto al .exe o lo descarga
(Start-Process wterminal.exe -ArgumentList '--install-webview2' -NoNewWindow -Wait -PassThru).ExitCode
# Con un instalador concreto
(Start-Process wterminal.exe -ArgumentList '--install-webview2', 'D:\MicrosoftEdgeWebView2RuntimeInstallerX64.exe' -NoNewWindow -Wait -PassThru).ExitCode
```

Termina con código 0 si el runtime queda instalado (o ya lo estaba), 1 si falla
y 2 si la firma del instalador no es de Microsoft. Para despliegues automatizados,
`LTERMINAL_WEBVIEW2_AUTO_INSTALL=0` desactiva todo el preflight y
`LTERMINAL_WEBVIEW2_NO_DIALOG=1` lo deja sin diálogo (si no se resuelve solo,
la app sigue y Tauri informa al crear la ventana). Todo queda en el log de
arranque («WebView2 Runtime ausente», con la opción elegida y cada intento).

### 9. Licencias de lo que se instala

El código fuente es AGPL-3.0-only, con licencia comercial aparte
([Licencia](#licencia)). Las dependencias y recursos de terceros conservan sus
licencias originales; el instalador incluye `THIRD-PARTY-NOTICES.txt`.

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

Los limpiadores eliminan únicamente salidas reproducibles, artefactos de
auditoría visual, cachés e informes conocidos, incluidos los Markdown que tienen
nombre de informe generado. No tocan documentación mantenida. En `%TEMP%` (o
`/tmp`) solo consideran nombres reservados por LTerminal para backups de versión,
descargas de herramientas, logs de build, Wine, smoke y E2E. Las extracciones
AppImage —que usan un nombre genérico con hash— solo se limpian si contienen el
ejecutable y el desktop de LTerminal; se conservan si algún proceso las está
usando o no se puede comprobar su actividad. No se borran temporales genéricos
de otras aplicaciones. El builder Windows guarda los instaladores temporales en
`winslim-terminal-build-*`, que elimina al terminar o el limpiador recoge si el
proceso se interrumpe. También retiran logs de build en AppData y cachés privadas
de LTerminal. `release/` y todo su contenido están protegidos y nunca se borran.
Por seguridad, la vista previa es el comportamiento predeterminado; el borrado
requiere una opción explícita.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1
powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1 -Apply
powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1 -Light -Apply
```

```bash
scripts/clean-repository.sh
scripts/clean-repository.sh --apply
scripts/clean-repository.sh --light --apply
```

**Modo ligero** (`-Light` / `--light`): quita solo los restos y conserva
`node_modules`, `target` y los logs de la app, así que el siguiente build sigue
siendo rápido. Su vista previa termina sugiriendo la orden ligera completa
(`-Light -KeepDays N -Apply`); antes sugería solo `-Apply`, que es la limpieza
completa. Restos que recoge:

- logs sueltos de la raíz (`build-*.log`…) y `dist/`;
- las releases anteriores que la build completa aparta en
  `src-tauri/target/dist/release-anterior`;
- las evidencias de `artifacts/` con más de `-KeepDays`/`--keep-days` días (3
  de fábrica);
- los temporales de pruebas con nombre propio (`wterminal-e2e-*`,
  `winslim-terminal-webview2-e2e-*`, `wtools-path-repro*`…) y las sesiones
  `%TEMP%\wterminal\<pid>` de procesos que ya no existen.

En Windows también retira del PATH de usuario las entradas que apuntan a
carpetas que ya no existen dentro de `%TEMP%` o del `release\` del repositorio
(restos de pruebas y de builds anteriores); las demás entradas, aunque no
existan, son del usuario y no se tocan. El PATH se lee y se reescribe sin
expandir, conservando las `%VARIABLES%`. Todo sale en la vista previa antes de
borrar nada.

No usa `git clean`: no borra `.git`, código fuente ni configuraciones locales.
Tampoco atraviesa enlaces simbólicos o junctions: conserva una salida raíz
enlazada y evita borrar logs/cachés a través de carpetas padre enlazadas; dentro
de una carpeta generada, quita el enlace sin tocar su destino.
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

Los scripts del repositorio en `scripts/` sirven para desarrollo, pruebas y
empaquetado; no se instalan ni se muestran como operaciones integradas de la
aplicación. Las operaciones de sistema reutilizables las publica LTools como
catálogo versionado y LTerminal las descubre y ejecuta de forma segura.

| Script | Qué hace |
|---|---|
| `npm start` | Arranca la aplicación en desarrollo (Vite + `cargo run`). |
| `npm run check` | Ciclo completo: versión, metadatos, recursos, arquitectura, documentación, enlaces, fuentes de instalación, catálogo WinGet cuando se ejecuta en Windows, `svelte-check`, formato, análisis estático y pruebas Rust. **Es lo que hay que pasar antes de compilar.** |
| `npm run check:local` | Validación sin red: contratos, documentación, i18n, lógica frontend, restauración de versión tras fallos y pruebas locales. |
| `npm run check:workspace` | Comprueba que las cachés, salidas y directorio temporal se puedan leer y escribir; detecta un `chown`/`chmod` pendiente antes de una build. |
| `npm run check:install-sources` | Sondea 16 fuentes que usa el catálogo (WinGet, Chocolatey, Flathub y los registros de los principales ecosistemas) y distingue una caída de red de un error del código. |
| `npm run check:i18n` | Comprueba la paridad de los 15 catálogos, textos visibles, marcadores dinámicos y fugas de idioma en búsquedas y comandos internos. |
| `npm run check:docs` | Valida los Markdown publicados (README, SECURITY, CONTRIBUTING): enlaces locales, anclas `#…` con el mismo criterio que GitHub y que ninguno enlace carpetas que no se publican (`docs-ia/`, `artifacts/`, `release/`, `dist/`). |
| `npm run check:flows` | Comprueba que el mapa técnico del README nombra cada archivo de código y script, y que los diagramas citan funciones que siguen existiendo. |
| `npm run check:contracts` | Cruza las preferencias Rust/TOML/TypeScript, los comandos internos Rust/Svelte y los recursos nativos Linux/Windows. |
| `npm run test:frontend-logic` | Ejecuta la lógica pura de idioma, identidad, scroll de terminal y los 20 atajos sin necesitar una ventana. |
| `npm run test:toolbar-layout` | Monta la barra real en Chromium sin ventana y prueba 504 combinaciones de ancho, idioma, controles y favoritos, y que el menú de idioma quepa en la ventana y llegue a su último idioma con scroll (980×640, 980×480 y 1366×768 al 100, 150 y 200 % de interfaz, y 480×270). Preparar el navegador una vez con `npx playwright install chromium --only-shell` (en Linux, añadir `--with-deps`). Guarda mediciones y capturas en un temporal, o en `E2E_CAPTURE_DIR` si se define. |
| `npm run test:ltools-contract` | Comprueba el contrato `ltools-actions-v1`, la validación de plataforma y la integración opcional de LTools; con `LTOOLS_TEST_BINARY` también prueba el CLI real. |
| `npm run test:e2e:ltools` | Ejecuta, contra un binario ya compilado, la E2E optativa de LTools: descubre el catálogo JSON real, abre el selector, fija una acción segura, cierra/reabre la Biblioteca para probar persistencia y verifica el comando canónico. Autodetecta el binario de la release más reciente; `E2E_BINARY` y `LTOOLS_TEST_BINARY` permiten fijarlos explícitamente. Si no hay release de LTools, lo informa como prueba omitida, nunca como éxito falso. |
| `npm run test:cleaner` | Prueba los limpiadores Bash y PowerShell en proyectos temporales; verifica los enlaces, conserva `release/` y descargas externas genéricas, y elimina solo temporales identificados de LTerminal. |
| `npm run test:version-restore` | Fuerza fallos de build y una copia de seguridad ausente; comprueba que no se anuncia éxito y que los cuatro manifiestos quedan byte a byte como estaban al terminar la prueba. |
| `npm run test:e2e-report` | Prueba que el validador acepta una batería E2E completa y rechaza estados fallidos, fases ausentes o una Biblioteca sin el contrato único de LTools. |
| `npm run test:e2e-native-driver` | Comprueba la detección de versión WebView2 y la selección de un Edge WebDriver compatible por build. |
| `npm run e2e` | Ejecuta el smoke WebDriver contra el binario existente indicado por `E2E_BINARY`; no compila. En Windows encuentra el Edge WebDriver compatible con WebView2 en PATH o en la caché de `src-tauri/target/e2e-driver/`; se puede fijar con `TAURI_NATIVE_DRIVER`. `E2E_CAPTURE_VIDEO=1` exige que `ffmpeg` esté disponible y hace fallar la pasada si no produce un MP4 válido. `E2E_SKIP_DEPENDENCY_REFRESH=1` omite solo el refresco completo para aislar pruebas visuales de matriz; la detección se valida aparte con `E2E_DEPENDENCY_AUDIT_ONLY=1`. Esa auditoría y el resto de esperas del E2E a una detección completa llegan hasta quince minutos (180 s fijos se quedaban justos con el anfitrión ocupado; el informe guarda `detectionRetryMs` para ver si empeora); se puede ajustar con `E2E_DEPENDENCY_TIMEOUT_MS` sin cambiar el comportamiento de la aplicación. `E2E_MOUSE_SELECTION_ONLY=1` prueba el arrastre real para seleccionar texto; `E2E_SHELL_MATRIX_ONLY=1` detecta y prueba todos los shells/REPL seguros disponibles; `E2E_DEPENDENCY_AUDIT_ONLY=1` recorre todas las secciones, grupos y acciones y verifica el estado individual `installed`, `absent`, `unknown` o `not-applicable`; desplaza cada tarjeta visible al centro del panel sin pulsar operaciones destructivas. `E2E_FULL_VISUAL_AUDIT=1` añade Ajustes, transiciones 1→2→3→4→1, entradas largas con comillas, `clear`, reflow, barras de progreso y scroll horizontal; `npm run e2e:dependencies` activa esta cobertura, captura cada acción y genera segmentos de vídeo con la resolución nativa de cada cambio de ventana. La captura solicita 30 FPS por defecto en la auditoría completa (8 FPS en smoke); `E2E_VIDEO_FPS` admite hasta 60 para diagnósticos. El informe distingue la frecuencia solicitada de la efectiva, que puede ser menor bajo carga: para auditar parpadeos breves se debe medir la frecuencia real del MP4 y revisar frames contiguos. Los frames nativos de arranque se conservan como evidencia separada sin mezclarlos en el MP4; también se valida continuidad de origen y se publica la cobertura real, incluida la omisión de NSudo/k9s/Hyprland cuando el host no puede ejecutarlos. `E2E_DEPENDENCY_VISUAL_ACTIONS=0` desactiva solo ese recorrido y `E2E_DEPENDENCY_ACTION_HOLD_MS` ajusta la permanencia de cada tarjeta en el vídeo; `E2E_LANGUAGE_ONLY=1` cambia varios catálogos, valida las anclas traducidas y restaura el idioma automático del sistema; `E2E_PROGRESS_LAYOUT_ONLY=1` simula barras de `update`/`upgrade`, mide el overflow y verifica que el ancho se recupera; `E2E_ADB_REFRESH_ONLY=1` crea un dispositivo ADB falso temporal y valida tres salidas visibles sin resize ni cambios de panel; `E2E_TERMINAL_ONLY_ONLY=1` activa el modo de terminal limpia, comprueba que ocupa la ventana sin overflow, captura el estado y lo recupera con `Ctrl+Shift+M`. `E2E_HORIZONTAL_SEQUENCE_COUNT` permite acotar la sonda de secuencia para diagnósticos locales sin reducir la cobertura por defecto. |
| `npm run e2e:admin` | Ejecuta `windows/e2e-elevated.ps1` desde una PowerShell elevada contra `release\WTerminal-1.0.0\wterminal.exe`. Usa un perfil aislado, comprueba el token administrativo efectivo, el escenario `windows-admin-permissions` (`E2E_WINDOWS_ADMIN_ONLY=1`) con NSudo abierto directo y sin «Reiniciar como administrador», que el ejecutable no lleva `RUNASADMIN` y que AppCompat queda exactamente como estaba. |
| `npm run metadata:sync` | Propaga los datos editados en `src-tauri/config/package-metadata.json` a npm, Cargo y Tauri. |
| `npm run build` | Solo el frontend, con precomprobación de permisos y sincronización de metadatos. `LTERMINAL_SKIP_CHECKS=1` conserva Vite pero omite las sondas externas y `svelte-check`. |
| `npm run build:preview` | Genera un frontend navegable en `dist-preview/` con un backend simulado; no usa Tauri, no abre PTY y no modifica el equipo. |
| `npm run preview` | Sirve `dist-preview/` en `http://127.0.0.1:4173`; si no existe, lo genera automáticamente. Acepta `--port 4174` y `--build` para regenerar antes de servir. Es el preview web funcional, separado de `dist/`. |
| `npm run build:fast` | Atajo multiplataforma para `build` con `LTERMINAL_SKIP_CHECKS=1`; útil durante el desarrollo, no sustituye una release completa. |
| `npm run dist:win` | Ejecuta la release completa de Windows, incluida la batería de herramientas y el E2E WebDriver; comprueba recursos, valida y genera carpeta desempaquetada, ZIP, portable de un solo EXE e instalador NSIS. Ninguno lleva el instalador de WebView2: si falta, lo instala el arranque o el NSIS (para la variante offline, `windows\build.ps1 -WebView2 Offline`). |
| `npm run dist:win:fast` | Build de desarrollo rápida de Windows: usa compilación incremental, omite LTO y conserva símbolos; ejecuta solo el smoke mínimo y salta las comprobaciones previas. No es una release. |
| `npm run dist:win:installer` | Genera el instalador NSIS de Windows (descarga WebView2 solo si falta) y ejecuta la batería ampliada/E2E. |
| `npm run dist:win:validate` | Release completa con `-ReleaseValidation`: además de la batería, vídeo, descargas reales, auditoría del catálogo e instalación real del NSIS (pide UAC y lo desinstala). |
| `npm run dist:win:quick` | La misma release con `-QuickValidation`: prueba lo mismo sin repetirlo (un solo recorrido completo con vídeo, y prueba corta del portable y de lo instalado). |
| `npm run e2e:suite` | Ejecuta suites E2E estandarizadas (`focused`, `full`, `video`, `downloads`, `dependency-audit`, `installer` y, desde el 12-11, `components`: eco, entrada larga, reflujo y marcas con Clink y PSReadLine encendidos, como los tiene el usuario; aún fuera de la release) contra un binario existente y escribe `summary.json`/`summary.md`. |
| `npm run e2e:installer` | Instala de verdad el NSIS indicado (un UAC), lo verifica, ejecuta el E2E sobre lo instalado y lo desinstala. |
| `npm run e2e:suite -- --suite real-install --binary <exe>` | **Instalación real del catálogo** (22-11; CAMBIA EL EQUIPO, fuera de toda validación automática): en la app de verdad y con la carpeta propia (`E2E_REAL_INSTALL_STORE`, por defecto `E:\WTerminal\entornos`) pulsa Instalar en todo lo que la detección da por no instalado y Actualizar en lo pendiente, una a una; espera el ✔ o el ✘, guarda la salida y una captura de cada fallo, mira que cada fallo traiga una explicación además de «código de salida» y, al final, que lo instalado se vea instalado en una detección nueva. `E2E_REAL_INSTALL_DRY=1` solo lista, `E2E_REAL_INSTALL_IDS` limita, `E2E_REAL_INSTALL_SKIP` excluye (Visual Studio y el `git pull` de proyectos ya lo están) y se para si C: baja de `E2E_REAL_INSTALL_MIN_FREE_GB` (1,5). Deja `instalacion-real.json`. |
| `npm run dev:test` | Bucle rápido para desarrollo: compila con el perfil de Cargo `fast` (release sin LTO e incremental; `target/fast/`) y ejecuta solo lo pedido: `--only` escenarios del catálogo, `--matrix` la matriz de shells con unos entornos, `--rust` tests filtrados, `--js` scripts sueltos, con `--video`, `--repeat N` y `--env CLAVE=valor`. Apaga WSL al empezar y al terminar la tanda (no entre escenarios: cada arranque de WTerminal sondea las distros y forzaría un arranque en frío) y deja `summary.md` en `artifacts/dev-test/`. Con la misma regla que `windows/build.ps1`, si la unidad del temporal tiene menos de 5 GB libres y la de `target` 10 o más, los resultados y el temporal de esa ejecución van junto a `target` (25-11: las capturas de la auditoría del catálogo dejaron C: a 0 MB). `--list` enseña los escenarios. Lo que compila lleva dentro las claves públicas del actualizador, como una release, y deja en `firma/` el manifiesto del binario con sus firmas Ed25519 y SSHSIG verificadas (claves de `--keys-dir` o de la carpeta que recuerda `windows/build.ps1`; sin claves completas avisa y sigue sin firmar, y `--no-sign` lo omite). No sustituye a la build completa. |
| `npm run test:e2e-suite` | Comprueba sin abrir la app el catálogo de suites, el ejecutor, su resumen y la comparación de binarios del instalador. |
| `npm run test:dev-test` | Comprueba sin compilar los argumentos de `dev:test`, la búsqueda de escenarios, el binario de cada perfil, que el perfil `fast` sigue siendo release sin LTO, la unidad de los resultados cuando falta sitio y la firma, con claves de usar y tirar. |
| `npm run test:e2e-shell-tools` | Comprueba sin WSL cómo `prepareWslBashWithBlesh` elige la distro del E2E de bash. |
| `npm run dist:win:linux` | Compila desde Linux el ejecutable Windows GNU x64, verifica los binarios nativos y ejecuta el smoke headless de Wine; el smoke GUI/WebView2 es optativo. |
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

Para repetir solo la prueba visual de selección en Linux sin recompilar, usa una
release existente y un perfil XDG temporal, para que el smoke no lea ni cambie
las preferencias o el portapapeles de tu sesión habitual:

```bash
e2e_profile="$(mktemp -d /tmp/lterminal-e2e.XXXXXX)"
mkdir -p "$e2e_profile/config" "$e2e_profile/data" "$e2e_profile/state" "$e2e_profile/cache"
XDG_CONFIG_HOME="$e2e_profile/config" \
XDG_DATA_HOME="$e2e_profile/data" \
XDG_STATE_HOME="$e2e_profile/state" \
XDG_CACHE_HOME="$e2e_profile/cache" \
E2E_BINARY="$PWD/release/dev/LTerminal-1.0.0-x86_64-dev.AppImage" \
E2E_MOUSE_SELECTION_ONLY=1 npm run e2e
```

Para probar shells y REPL sin ejecutar el resto de la batería, se puede usar el
mismo perfil temporal con `E2E_SHELL_MATRIX_ONLY=1 npm run e2e`. La prueba
descubre las opciones habilitadas en el selector y ejecuta una sonda inocua en
cada shell/REPL con sonda segura disponible; exige ver el eco y el resultado
evaluado en el PTY, registra las herramientas omitidas con su motivo, rechaza
errores del inicializador y restaura el entorno original. No inicia servicios
de bases de datos, contenedores, elevaciones ni dispositivos ADB reales.
`E2E_SHELL_MATRIX_IDS=lang:haskell,lang:scala,lang:haskell,lang:scala` limita
la matriz a esos entornos, en ese orden y con repeticiones, para repetir un
REPL intermitente. `E2E_SKIP_WSL=1` deja fuera todas las distros de WSL en
todas las pruebas, como en un equipo sin WSL, y el informe apunta cada una como
omitida con su motivo (`environment-probe-skipped`). Se usó en la build 68,
cuando la VM se quedó sin hipervisor (17-11). Los REPL de lenguajes tienen 60 s para enseñar su prompt
tras el arranque: los de JVM, .NET, GHC o Julia no pintan nada hasta su banner
y, con la máquina cargada, Scala pasó de 30 s. Un REPL que se cierra solo se
relanza hasta dos veces (otra shell y vuelta, como haría el usuario) y, si
sigue cayéndose, se omite con el motivo. Hay dos casos:
- Elm, con `resource busy (file is locked)` en su caché (antes de abrirlo, la
  prueba quita su caché del REPL si quedó rota: ver
  [Problemas conocidos](#9-el-repl-de-elm-no-contesta-y-se-queda-al-100--de-cpu));
- cualquiera que termine con un código de fallo de Windows: 0xC0000374
  (corrupción del heap), 0xC0000005, 0xC00000FD o 0xC0000409. En la larga
  53, `php.exe` 8.5 terminó con 0xC0000374 a mitad de escribir la sonda, con
  la pestaña mostrando bien el aviso.

La terminal no puede corromper la memoria de otro proceso: es un fallo del
programa. El informe lo apunta como `environment-probe-relaunch` con su
`exitCode`.
`npm run test:e2e-environment-probes` comprueba localmente que los 89 REPL
declarados entre el código y el catálogo tienen una sonda o una omisión segura.

La integración con LTools también se puede probar sin recompilar:

```bash
E2E_BINARY="$PWD/release/dev/LTerminal-1.0.0-x86_64-dev.AppImage" \
LTOOLS_TEST_BINARY="$PWD/../Tools/release/ltools-1.0.0-linux-x86_64-cli.AppImage" \
npm run test:e2e:ltools
```

Esta prueba es optativa porque LTools no es una dependencia de LTerminal. La
release Linux se puede probar aunque el equipo no tenga FUSE montado: el
contrato establece automáticamente `APPIMAGE_EXTRACT_AND_RUN=1` al invocar el
AppImage. En Windows, usa el ejecutable CLI equivalente de la carpeta
`release/`. Si no se indica `E2E_BINARY`, la prueba busca automáticamente una
build local conocida; si no encuentra ninguna, termina como `SKIP` explícito.
Los puertos del driver y de la sonda nativa se reservan dinámicamente para no
colisionar con otra ejecución.
Si se ejecuta dentro de `xvfb-run` desde un escritorio Hyprland, usa
`E2E_SKIP_WINDOW_MANAGER=1`: así se omiten únicamente las comprobaciones del
dispatcher del compositor anfitrión, que no puede controlar la ventana del
display virtual; el resto del smoke sigue siendo obligatorio.

La interfaz no mantiene una lista cerrada: vuelve a leer `ltools-actions-v1`,
acepta los metadatos opcionales `label`, `shortLabel`, `description` y `quick`,
y muestra automáticamente cualquier acción nueva que cumpla las reglas de
seguridad. El usuario puede fijar todas las acciones compatibles que quiera;
no hay un límite artificial de ocho botones y la botonera mantiene su propio
scroll vertical. Las acciones nuevas no rompen la selección guardada y aparecen
en **Configurar…**. Las acciones que requieren un objetivo siguen fuera de esos
botones hasta que exista una interfaz explícita para pedirlo.

Para revisar exclusivamente el espacio horizontal que ocupan las salidas de
instaladores y actualizadores, reutiliza una build existente:

```bash
E2E_BINARY="$PWD/release/dev/LTerminal-1.0.0-x86_64-dev.AppImage" \
E2E_PROGRESS_LAYOUT_ONLY=1 npm run e2e
```

Este escenario no instala ni actualiza nada. Genera una barra corta de
`update`, una barra larga de `upgrade` con retorno de carro, toma capturas de
ambas y limpia después la pantalla. El informe falla si la barra corta crea
overflow, si la larga no lo crea solo por su contenido, o si la terminal no
recupera sus columnas mínimas al terminar.

Para comprobar el refresco de pantalla por el transporte ADB sin conectar un
dispositivo, usa ese mismo perfil con `E2E_ADB_REFRESH_ONLY=1 npm run e2e`. El
smoke antepone un `adb` simulado y aislado al `PATH`, selecciona su dispositivo,
emite tres frames separados y conserva capturas. La prueba falla si no se
repinta la salida o si cambia la geometría del panel durante el flujo.

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

### 1. El menú de `build-tools/`

Para no tener que recordar las combinaciones de argumentos, el punto de entrada
recomendado es el menú de `build-tools/`:

```bash
bash build-tools/build.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File build-tools/build.ps1
```

Desde el 22-11 (Romen: «modularizar el script: builds de este sistema, del
otro, test y firma») el menú principal va por pasos:

| Opción | Qué hace |
|---|---|
| 1. Compilar para este sistema | Asistente: **tipo** (depuración, rápida, portable, completa, completa por etapas y reanudable, completa + «Latest»; en Linux, depuración, rápida y AppImage rápida, sin pruebas ampliadas o completa), **etiqueta**, **pruebas** (ninguna, básicas, completas, completas + suites de release, reducida, o elegir suites o escenarios para después), **firma** (sí/no y carpeta de claves, que recuerda), **copia adicional** (carpeta, que recuerda, y subcarpeta) y un resumen antes de empezar |
| 2. Compilar para el otro sistema | Linux desde Windows (WSL) o Windows desde Linux (MinGW, Wine) |
| 3. Probar una build ya compilada | Sin recompilar: elige la build (depuración, rápida, release desempaquetada u otra ruta, con su fecha) y las pruebas (focused, full, `intermitentes`, `nuevas`, escenarios concretos N veces, las de release, el instalador o la instalación real del catálogo) |
| 4. Firmar una build ya compilada | `scripts/sign-build.mjs`: `SHA256SUMS.txt` de release\, de otra carpeta o de archivos concretos, firmado con Ed25519 y SSH y verificado |
| 5–7 | Pruebas del código, desarrollo y preview, y limpieza, como antes |
| 8. Todas las opciones de compilar de antes | El submenú de siempre, por si se busca una combinación concreta |

Piezas nuevas que usa:

- `windows/build-stages.ps1`: la larga por etapas (comprobación previa
  opcional, compilar, una suite cada vez y veredicto). Cada etapa se apunta en
  `artifacts\build-stages\<etiqueta>\estado.txt`: relanzarla con la misma
  `-Label` repite solo lo que faltaba, y también la comprobación o la
  compilación si fallaron (las suites que fallaron no: quedan para el
  veredicto). Con `-ResumeAfterReboot` y
  `-InstallResumeAtLogon`, `windows/build-stages-resume.ps1` la relanza al
  iniciar sesión tras un reinicio (como mucho dos veces seguidas; para
  cancelarlo, borrar `artifacts\build-stages\pendiente.txt`).
- `scripts/dev-test.mjs --suite <suites>`: una suite entera con sus
  repeticiones; la suite `intermitentes` repite cinco veces cada prueba que
  alguna vez falló.
- `scripts/sign-build.mjs`: firmar lo ya compilado.

El menú organiza las tareas por resultado: desarrollo y preview, compilación,
pruebas/smoke sin recompilar y limpieza. Permite compilar frontend, backend,
Linux y Windows de forma individual, combinar frontend/backend o las dos
plataformas, elegir release completa, rápida o sin pruebas ampliadas, ejecutar
la E2E sobre un ejecutable ya existente y levantar el preview web funcional sin
Tauri. Este último usa `dist-preview/`, muestra una terminal simulada con
pestañas y comandos de demostración (`help`, `update`, `upgrade`, `clear`) y no
debe confundirse con una validación del backend real. En Linux pregunta antes
de instalar dependencias del sistema; en Windows avisa antes de iniciar el
builder, que puede preparar Node.js, Rust o herramientas de Visual Studio si
faltan. `release/` se conserva al limpiar; `dist-preview/` es
salida temporal ignorada.

La opción **Scripts npm** enumera dinámicamente todas las acciones declaradas en
`package.json`, permite buscarlas y ejecutarlas con sus argumentos. Usa `npm`
cuando está disponible y `pnpm` como alternativa, por lo que también funciona
en instalaciones Windows sin `npm` global. El comando equivalente para una
terminal es `node scripts/package-scripts.mjs list` o
`node scripts/package-scripts.mjs run <script> [argumentos]`.

### 2. Permisos de administrador al arrancar

En Windows, WTerminal arranca **sin** permisos de administrador y no escribe
por su cuenta la marca de compatibilidad `RUNASADMIN`. Quien los necesite tiene
en Ajustes → Comportamiento → Permisos de administrador «Reiniciar como
administrador», «Reiniciar sin permisos de administrador» y una sola elección
«Al abrir WTerminal»: sin permisos (de fábrica), «Iniciar siempre como
administrador» (lo pide WTerminal) o la marca de Windows en WTerminal.exe; el
detalle, junto con NSudo y gsudo, está en
[Permisos de administrador y NSudo](#9-permisos-de-administrador-y-nsudo).

### 3. WTerminal en el `PATH`

En el primer inicio, WTerminal se añade automáticamente al `PATH` del usuario
para poder invocarse como `wterminal`. En **Ajustes > Comportamiento** puedes
desactivar o volver a activar esa integración; la elección se conserva entre
inicios. Windows actualiza el `Path` de HKCU y notifica el cambio; las consolas
abiertas deben reiniciarse para recibir el entorno actualizado. Linux crea un
lanzador en `~/.local/bin` y administra un bloque reversible en los perfiles de
Bash, Zsh y Fish. Solo se registra WTerminal; cada tool gestiona las aplicaciones
que instala.

### 4. Firma de los commits de Git

La firma de commits Git es independiente de la compilación y de la firma
Ed25519 de las releases. No se solicita al buildear. Para activar la firma SSH
automática solo en este checkout, ejecuta
`bash build-tools/build.sh --setup-git-signing`. También puedes elegir la
opción 5 del menú. El asistente usa una clave SSH existente, configura Git
localmente y muestra la clave pública que debes añadir en GitHub como
**Signing key**; nunca sube la clave ni muestra la privada.

### 5. Los builders directos

Los menús llaman a los builders mantenidos que siguen debajo de `linux/` y
`windows/`; esos puntos directos se conservan para CI y automatización avanzada.
Así, el flujo habitual queda en un solo menú `.sh` o `.ps1` por plataforma sin
perder las opciones especializadas de release, Wine, E2E y WSL.

```powershell
windows\build.ps1          # ruta directa: EXE + NSIS + checks + smoke + E2E
windows\build.ps1 -Fast -NoExtendedTests -SkipChecks  # iteración rápida de desarrollo
windows\build.ps1 -NoInstaller -NoRun  # solo portable, si se necesita explícitamente
windows\build.ps1 -NoRun -NonInteractive -ReleaseValidation  # validación completa para dar una release por buena
windows\build.ps1 -NoRun -NonInteractive -QuickValidation    # la misma validación sin repetir el recorrido completo
windows\build.ps1 -WebView2 Offline  # variante sin Internet: NSIS, carpeta y portable con el instalador offline de WebView2
```

#### 5.1 WebView2: Download u Offline

`-WebView2 Download` (de serie) deja los tres paquetes en unos pocos MB más
la aplicación: el NSIS usa el `downloadBootstrapper` de Tauri y la carpeta y el
portable no llevan instalador, porque el arranque lo resuelve si falta (ver
[WebView2: si falta el runtime](#8-webview2-si-falta-el-runtime)).
`-WebView2 Offline` escribe una configuración temporal con
`webviewInstallMode = offlineInstaller`, saca con 7-Zip el instalador offline
de ese NSIS y lo reutiliza en la carpeta (como `MicrosoftEdgeWebView2Setup.exe`)
y dentro del portable. La build comprueba el tamaño según el modo: un NSIS
Offline de menos de 100 MB o uno Download de 100 MB o más la paran, porque
significa que el modo no se aplicó.

#### 5.2 Linux

```bash
linux/build.sh
linux/build.sh --fast --no-extended-tests --skip-checks  # iteración rápida de desarrollo
```

#### 5.3 El selector interactivo

Al ejecutar `windows\build.ps1` o `linux/build.sh` sin argumentos desde una
consola interactiva aparece un selector previo. Sus valores predeterminados son
la release más completa: perfil optimizado, checks estrictos, artefacto final,
smoke, batería ampliada y E2E; en Windows incluye EXE y NSIS, y en
Linux incluye el AppImage. Enter conserva esos valores. Las ejecuciones con
argumentos explícitos, `-NonInteractive`/`--non-interactive` o entrada
redirigida no preguntan nada y mantienen igualmente la ruta completa, salvo que
se solicite una excepción (`-NoInstaller`, `-NoExtendedTests`, `-SkipChecks`,
`--fast`, etc.).

### 6. Validar Windows desde Linux (Wine)

Para validar la compatibilidad Windows desde Linux:

```bash
linux/build-windows.sh --version 1.0.0 --wine-smoke
```

Esta ruta compila en `src-tauri/target/windows-cross/x86_64-pc-windows-gnu/release/`
por defecto y, al terminar, publica una carpeta portable y un ZIP en la raíz
del proyecto: `release/WTerminal-<versión>/` y
`release/WTerminal-Unpacked-<versión>.zip`. Con `--fast`, ambos quedan
bajo `release/dev/` y llevan el sufijo `-dev`. También actualiza el
`SHA256SUMS.txt` de esa variante. El target conserva la salida técnica y la
caché de Cargo; el paquete limpio para probar o compartir queda en `release/`,
sin tener que rebuscar entre los intermedios. Esta es una compilación GNU x64
útil para compatibilidad y Wine,
no genera el instalador NSIS; la release oficial con MSVC sigue produciéndose
en Windows mediante `windows/build.ps1`. `--skip-checks` y `--no-install`
tienen el mismo sentido que en la build Linux; `--clean` elimina únicamente la
salida Windows cruzada. `LTERMINAL_WINDOWS_TARGET_DIR` permite cambiar esa
carpeta sin compartir locks con otra compilación. `--version X.Y.Z` fija la
versión antes de validar dependencias; si se omite en una consola interactiva,
se pregunta al principio y Enter conserva la versión actual. `--fast` usa el
perfil incremental. `--wine-smoke` ejecuta el smoke headless por defecto;
`LTERMINAL_WINE_GUI_SMOKE=1` solicita el smoke gráfico opcional. `--full-tests`
añade la batería Rust y `--wine-repeats N` repite el smoke (1–10). Las opciones
desconocidas y los valores ausentes se rechazan antes de empezar.
La cross-build usa un job de Cargo por defecto para no agotar la memoria durante
LTO y los tests PE bajo Wine; `CARGO_BUILD_JOBS=2` o superior queda como ajuste
explícito para máquinas con memoria suficiente. La batería PE bajo Wine dispone
de 1800 segundos para incluir una compilación de tests fría; se puede ajustar con
`LTERMINAL_WINE_TEST_TIMEOUT`.

Para hacer la validación cruzada completa desde Linux, incluyendo la batería
Rust compilada como PE Windows y tres arranques aislados bajo Wine:

```bash
linux/build.sh --full-tests --cross-windows
```

### 7. Validar Linux desde Windows (WSL)

En Windows, `-CrossLinux` utiliza WSL. Si no existe WSL o no hay una
distribución instalada, intenta instalar WSL y Ubuntu con `winget`/`wsl.exe`;
después ejecuta dentro de WSL `linux/build.sh --full-tests
--install-e2e-driver --no-run`. Para que el E2E gráfico Linux funcione, Windows
debe disponer de WSLg:

```powershell
windows\build.ps1 -NonInteractive -FullTests -CrossLinux
```

### 8. Argumentos y combinaciones

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

### 9. La batería ampliada, y los fallos que no paran la release

En Windows, la batería ampliada se ejecuta automáticamente tanto en modo
interactivo como no interactivo; solo `-NoExtendedTests` la omite. Las sondas de shells y herramientas se
acumulan aunque alguna falle, de modo que el E2E no se pierde por un único
runtime averiado. Un fallo de sonda, WebDriver, E2E o WSL cruzado ya no impide
comprimir ni publicar la release: se muestra junto al resumen final y el
proceso termina con código 1 para que CI lo detecte. `-StrictTests` sigue
convirtiendo también las ausencias opcionales en ese diagnóstico final. El
informe E2E se conserva en `%TEMP%\wterminal-e2e-<id>.json` cuando falla.

### 10. Niveles de validación (Windows)

#### 10.1 Los niveles

Todas las pruebas E2E salen de un catálogo único, `tests/e2e/suites.mjs`, y
pasan por el mismo ejecutor, `scripts/run-e2e-suite.mjs`, que deja un resumen
comparable (`summary.md`) con el resultado, la duración y el detalle de cada
escenario.

| Nivel | Qué ejecuta |
|---|---|
| `-NoExtendedTests` | Solo el smoke mínimo de arranque (iteración de desarrollo). |
| Por defecto o `-FullTests` | Checks, sondas de shells/herramientas, recorrido E2E completo sobre el ejecutable y sobre el portable de un solo archivo (copiado solo a una carpeta vacía), y la suite `focused` de regresiones (pie de Ajustes, Entornos y descargas, PATH, escribir tras redimensionar, entrada en cola, primera orden en pestañas nuevas ×3 y con la carrera forzada, casilla diminuta que crece, seguimiento del cursor en entradas largas, integridad horizontal, estilos ANSI, parpadeo del cursor, selección con el ratón, anchos Unicode, imágenes Sixel, sugerencias con el color elegido en Ajustes en cada shell, asistentes de IA con Claude Code de la app de escritorio y una acción de cmd en una sola línea, y apariencia: temas sobre la base neutra, recolorear todo, tema propio, paleta ANSI propia y Biblioteca abierta al marcar). |
| `-ReleaseValidation` | Todo lo anterior más el recorrido completo con vídeo, descargas reales con pip/npm/Deno/Bun/Go (necesita red), la auditoría completa del catálogo de dependencias y una instalación real del NSIS: un único aviso de UAC, comprobación de archivos, registro, accesos directos y binario, E2E sobre lo instalado y desinstalación verificada. Es el nivel que permite dar una release por buena. |
| `-QuickValidation` | Las mismas comprobaciones sin repetirlas: un solo recorrido completo, con vídeo y sobre la carpeta desempaquetada; la suite `distribution` (shells, un REPL, paneles y PATH) sobre el portable y sobre lo instalado, que llevan los mismos archivos comprobados por hash; `focused`, descargas e instalador igual; y la auditoría solo recorre acción por acción en su segunda pasada, con menos fotogramas por segundo y sin segmentos nativos. Tarda alrededor de un tercio menos. |

#### 10.2 Piezas sueltas y suites sin recompilar

Las piezas de `-ReleaseValidation` también se pueden pedir sueltas con
`-VideoTest`, `-DownloadTests`, `-DependencyAudit` e `-InstallerTest`, y
`-NoFocusedTests` omite la suite de regresiones. Las suites se ejecutan al
final, contra los artefactos ya firmados, y su resumen queda en
`artifacts/release-validation/WTerminal-<versión>-<fecha>/summary.md`. La
prueba del instalador se niega a actuar si ya hay un WTerminal instalado (no
toca la instalación del usuario) y deja el equipo como estaba. Las suites
avisan si el procesador está cargado al empezar, porque los E2E dependen de
tiempos, y comprueban que el PATH del usuario queda idéntico.

Sin recompilar: `npm run e2e:suite -- --binary <wterminal.exe> --suite focused,video`
(`--list` muestra el catálogo, `--level release` lo selecciona todo y `--only appearance,shell-assist` repite solo esos escenarios) y
`npm run e2e:installer -- --installer release\WTerminal-<versión>-x64-setup.exe`.

#### 10.3 La versión y los pasos de cada build

Al comenzar, los scripts de empaquetado preguntan la versión a generar y
proponen la actual; pulsar Enter la conserva. Se puede evitar el diálogo con
`-Version 1.0.0 -NonInteractive` en Windows o `--version 1.0.0` en Linux.

Cada script comprueba los requisitos, instala dependencias, pasa `npm run check`,
compila, monta el artefacto, hace una comprobación de humo (abre la app y mira
que no se cierre sola) y publica la release con su SHA-256 en `release/`.
Por defecto los builders publican ahí. `LTERMINAL_RELEASE_DIR` permite elegir
otra carpeta; las rutas relativas se resuelven desde la raíz del proyecto. Para
mantener la estructura estándar, usa `LTERMINAL_RELEASE_DIR="$PWD/release"`:
Linux y Windows cruzado publicarán en la única carpeta de artefactos del
proyecto.

#### 10.4 El manifiesto y el volcado a disco

El manifiesto `SHA256SUMS.txt` se actualiza por artefacto y de forma atómica:
conserva los hashes de las demás arquitecturas, plataformas y perfiles de la
misma versión, y solo sustituye la entrada del archivo que se acaba de generar.
Las builds tampoco eliminan AppImage/ZIP anteriores del directorio de release.
En Windows, tras firmar, `Sync-PublishedFiles` vuelca a disco cada archivo de
`release\` (`FlushFileBuffers`): un apagado brusco a los pocos minutos de un
build dejó el instalador con su final a ceros y `SHA256SUMS.txt`, `.sig` y
`.sshsig` llenos de ceros porque Windows aún no los había escrito.

#### 10.5 La comprobación de enlaces

La comprobación estricta de enlaces distingue HTTP de repositorios Git: las
URLs normales usan el timeout corto configurado y `git ls-remote` dispone de
hasta 30 segundos y reintentos propios, para no rechazar una build porque la
negociación de un repositorio grande tarde más que una petición web.
`git ls-remote` se lanza sin ayudantes de credenciales ni preguntas
(`credential.helper=`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`): un
repositorio inexistente o privado falla al instante como enlace roto en vez de
abrir Git Credential Manager y su inicio de sesión en el navegador en mitad del
build. Los tests de «Mi GitHub» usan la cuenta fixture `owner`.
También respeta la plataforma: las fuentes AUR no bloquean una build nativa de
Windows y sí se comprueban en Linux o dentro de WSL; las URLs fijas de fixtures
de tests y el esquema remoto de Tauri no se consideran dependencias de red del
build.
Los enlaces que solo son destinos informativos de una acción de usuario se
comprueban igualmente, pero están marcados como no bloqueantes: por ejemplo,
`www.codeweavers.com` se abre en el navegador y no aporta ningún archivo al
binario, y `ffmpeg.org` solo aparece en el mensaje que pide instalar ffmpeg a
mano (el builder lo instala con WinGet). Si ese tercero responde con timeout/5xx, el informe muestra un aviso y
la build estricta continúa; una URL que sí sea fuente o dependencia de build
sigue siendo un fallo estricto.

No se descargan las URL que no pueden ser destinos reales: hosts locales, los
dominios reservados para ejemplos y pruebas (`example.com`, `example.net`,
`example.org`, `.example`, `.test` e `.invalid`, RFC 2606 y 6761) y los
fragmentos sin dominio completo (`https://ex`, `https://xn--`) con los que los
tests de enlaces clicables trocean una URL. `scripts/verify-links.mjs`
comprueba esas reglas al arrancar.

Cada URL HTTP se prueba con HEAD y GET en dos intentos de 8 s
(`LTERMINAL_LINK_CHECK_TIMEOUT_MS`, `LTERMINAL_LINK_CHECK_RETRIES`). Si todos
agotan el plazo, un último GET con el triple de plazo decide antes de dar la
URL por caída: un servidor lento (ffmpeg.org tardó más de 8 s una vez y paró
una build de release en la VM) ya no detiene la build, y una URL caída de
verdad sigue fallando.

Si el equipo está temporalmente sin DNS o sin acceso a Internet, se puede
comprobar y compilar con `LTERMINAL_LINK_CHECK=warn npm run check` o anteponer
`LTERMINAL_LINK_CHECK=warn` a `npm run build`, `npm run dist:linux` o
`npm run dist:win:linux`. En ese modo las URLs y los registros externos quedan
marcados como avisos y no se consideran validados; para publicar una release
conviene repetir después el ciclo estricto con red disponible. En Windows
nativo, `windows\build.ps1 -AllowOfflineChecks` aplica este modo a toda la
build, incluidas las comprobaciones que lanza `prebuild`.

### 11. Resumen al final de la build

`windows/build.ps1` termina con **Resumen de la build** (`Write-BuildSummary`):
los archivos de `release/` con su tamaño, la carpeta desempaquetada, cada
prueba ejecutada con su resultado y su duración (comprobaciones, smoke, E2E del
desempaquetado y del portable y cada escenario de las suites) y las evidencias:
informes E2E, vídeos, carpetas de capturas y logs. Las evidencias de la build
quedan en `artifacts/builds/WTerminal-<versión>-<fecha>/` (`e2e-desempaquetado`,
`e2e-portable` y `wterminal-main.log`, que antes se borraba con el temporal de
la build) y las de las suites en `artifacts/release-validation/…`, cada
escenario con su carpeta `<id>-captures`. Con `-VideoTest` las tres formas de
distribución dejan vídeo: el desempaquetado en la suite `video`, el portable en
su E2E y lo instalado en la suite `installer`.

Si la compilación falla («La compilacion del binario fallo»), la build escribe
antes las últimas 80 líneas de lo que dijo Tauri o Cargo
(`Write-NativeOutputTail`). Esa salida se enseña con `Out-Host`, que va a la
consola y no a los flujos de PowerShell. La build larga por etapas, que
redirige `*>&1` a su registro con la consola oculta, la perdía: la 59 (13-11)
cayó ahí sin una sola línea del compilador y, repetida a mano, compiló.

### 12. Qué produce cada build

| Plataforma | Artefacto |
|---|---|
| Windows | `WTerminal-<versión>-x64-setup.exe` (NSIS; WebView2 solo si falta) + `WTerminal-<versión>-Portable.exe` (un solo archivo) + `WTerminal-Unpacked-<versión>.zip` + `SHA256SUMS.txt`, `.sig` y `.sshsig` |
| Linux | `LTerminal-<versión>-<arch>.AppImage` (y, cuando `linux/build.sh` los genere, `.deb`, `.rpm` y `LTerminal-Unpacked-<versión>-<arch>.tar.gz`) |

En Windows, `release/` contiene **exactamente lo que se sube a GitHub**: esos
seis archivos. El ZIP no es opcional: la actualización automática de las copias
instaladas o desempaquetadas lo descarga, y el actualizador solo ofrece una
release que publique el manifiesto con sus dos firmas (`.sig` y `.sshsig` son
firmas, no claves: las privadas nunca salen de tu perfil). La carpeta
desempaquetada y todo lo de las builds rápidas (`-dev`) son salidas intermedias
y viven en `src-tauri/target/dist/`. Antes de publicar, la build completa
aparta lo que no sea de esa versión a `src-tauri/target/dist/release-anterior/`
sin borrarlo. Si la build termina con validaciones pendientes (una suite en rojo,
una prueba omitida), deja además `release/NO-PUBLICAR.txt` con la lista: los
artefactos y sus firmas son correctos, pero esa build no se publica ni se
reparte. `target/` sigue siendo la salida interna de Tauri/Cargo. `-NoInstaller` omite explícitamente ese artefacto. La
build portable no genera instalador ni accesos directos.

#### 12.1 La versión «Latest» (21-11)

Además de la versionada, la release se ofrece como **«Latest»**: los mismos
archivos con «Latest» en lugar del número, para enlaces y automatizaciones que
siempre quieren la última:

| Versionada | Latest |
|---|---|
| `WTerminal-1.0.0-x64-setup.exe` | `WTerminal-Latest-x64-setup.exe` |
| `WTerminal-1.0.0-Portable.exe` | `WTerminal-Latest-Portable.exe` |
| `WTerminal-Unpacked-1.0.0.zip` | `WTerminal-Unpacked-Latest.zip` |

`windows\make-latest.ps1` la crea en `release-latest\`:

1. Toma una release ya hecha (`release\` por defecto, o `-From <carpeta>`, por
   ejemplo `E:\WTerminal\releases\77`). Se niega si lleva `NO-PUBLICAR.txt`.
2. Comprueba que cada archivo coincide con su suma de `SHA256SUMS.txt`.
3. Si la Latest que ya hay salió de esos mismos archivos (`LATEST-ORIGEN.txt`),
   no hace nada: **no hay cambios** (`-Force` la rehace).
4. Copia con los nombres nuevos, calcula su `SHA256SUMS.txt` y lo firma igual
   que la build (Ed25519 y SSHSIG, con `-KeysDir` o la última carpeta de claves
   que usó la build; sin claves sale sin firmar, con aviso).
5. Deja en `LATEST-ORIGEN.txt` de qué versión y carpeta salió.

No compila nada. Para una Latest de código nuevo, la build la crea sola al
terminar en verde con **`-Latest`** (en modo interactivo lo pregunta: «Crear
también la versión Latest al terminar en verde»). Si la build acaba con
validaciones pendientes, no se crea.

La comprobación automática solo ofrece una release estable que tenga un
artefacto compatible con `self_update::asset_for_platform`, un manifiesto
SHA-256 y sus firmas verificables. Antes de mostrar el aviso autentica el
manifiesto y comprueba que contiene el hash del artefacto; al instalar vuelve a
validar las firmas y calcula el SHA-256 del paquete descargado.

### 13. Seguridad de las releases

Las actualizaciones exigen `SHA256SUMS.txt`, la firma Ed25519 detached
`SHA256SUMS.txt.sig` y una segunda firma OpenSSH/SSHSIG
`SHA256SUMS.txt.sshsig`. El binario se compila con
`LTERMINAL_UPDATE_PUBLIC_KEY` (clave pública Ed25519 en hexadecimal),
`LTERMINAL_SSH_UPDATE_PUBLIC_KEY` y `LTERMINAL_SSH_UPDATE_IDENTITY`; la
comprobación automática verifica las dos firmas y el hash declarado antes de
mostrar el aviso, y la instalación vuelve a comprobarlas, descarga el paquete
y exige una coincidencia exacta de SHA-256 antes de extraer o aplicar el
payload. Si una build no fue autorizada con ambas claves, queda bloqueada para
autoactualizaciones.
Una release oficial falla si no recibe
`LTERMINAL_SIGNING_PRIVATE_KEY` en el entorno de CI. La clave privada nunca se
guarda en el repositorio ni se entrega a los jobs que compilan los binarios.

El workflow de publicación (`.github/workflows/release.yml`) solo se lanza a
mano, con el tag como parámetro: antes también saltaba al subir una etiqueta,
compilaba otros binarios (sin la validación larga ni el vídeo) y reemplazaba
los validados que ya estuvieran subidos. Compila Linux y Windows sin permisos
de escritura ni acceso a la clave privada. Después de que ambos builds suban
sus artefactos, un único job reúne los archivos, genera un manifiesto SHA-256
común y lo firma con Ed25519 y OpenSSH. Así se evita que dos jobs
reemplacen entre sí el manifiesto o su firma; solo el job final recibe
`contents: write` y la clave privada. Si la release de ese tag ya tiene
adjuntos, se detiene sin tocarlos; si no existe, la crea como **borrador**
(`--draft`) y sube sin `--clobber`, para revisarla antes de publicarla. La
clave pública se pasa también a los builds para incrustarlas en el
actualizador. Los builders locales aceptan
`LTERMINAL_SSH_SIGNING_KEY_FILE`, `LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE` y
`LTERMINAL_SSH_SIGNING_IDENTITY`; también reutilizan
`~/.ssh/lterminal-release-signing` y, por compatibilidad con `Tools`,
`~/.ssh/ltools-release-signing`.

En Windows las claves de una build local están en **una sola carpeta**, que
se indica en cada build: `windows/build.ps1 -KeysDir <carpeta>` o, sin él,
la pregunta del principio (Enter acepta la última usada, guardada en
`%LOCALAPPDATA%\WTerminalBuild\keys-dir.txt`, fuera de la carpeta que borra el desinstalador, o `Escritorio\Claves SSH`; `-`
genera la release sin firmar). Como el menú `build-tools/build.ps1` lanza el
builder con `-NonInteractive`, la pregunta la hace el menú y le pasa
`-KeysDir`. Dentro de la carpeta, y de su subcarpeta `.ssh`, se buscan
`release-signing-private.pem`, `release-signing-public.hex` y
`lterminal-release-signing` / `ltools-release-signing` (con su `.pub`), y la
build dice cuáles encontró. El builder ya no rebusca claves por su cuenta en
el perfil, el Escritorio o Documentos, donde podía recoger una clave antigua
sin avisar. Con `-NonInteractive` y sin `-KeysDir` la release sale sin firmar
(o falla si `LTERMINAL_REQUIRE_SIGNING=1`). `npm run dev:test` busca las
mismas claves con los mismos nombres, en `--keys-dir <carpeta>` o en la que
recuerda ese archivo, y firma lo que compila. `linux/build.sh` acepta igual
`--keys-dir <carpeta>`; sin él sigue cargando las claves desde
`~/.config/lterminal/` y `~/.ssh/`. Las variables
`LTERMINAL_SIGNING_PRIVATE_KEY_FILE`, `LTERMINAL_UPDATE_PUBLIC_KEY_FILE` y
`LTERMINAL_SSH_SIGNING_*` mandan siempre sobre la carpeta. En CI no se usa este fallback local: el
workflow debe entregar los secretos mediante Actions. La build no afirma que
una firma es válida hasta verificarla con la clave pública, y elimina una firma
antigua si se intenta generar una build sin material de firma.

Los payloads comprimidos se inspeccionan antes de extraerse: se rechazan rutas
absolutas, `..`, `./`, separadores Windows, enlaces simbólicos, archivos especiales,
archivos excesivos y expansiones superiores a 512 MiB. Por eso el `.tar.gz` de
Linux tiene que empaquetarse con los nombres sin `./` delante (`tar -czf
<salida> -C <padre> LTerminal-<versión>/`) y con el binario `lterminal` en la
raíz de esa carpeta. El bootstrap de perfil
también exige el checksum del ZIP y limita sus hosts de descarga a GitHub.

### 14. Publicar una release

Windows y Linux salen **juntos**, en una sola release con un solo
`SHA256SUMS.txt`: el actualizador de cada copia busca en ese manifiesto el hash
de su propio adjunto. Lo que se sube es exactamente lo que pasó la validación
larga, sin recompilar. Se prepara así:

1. Una build larga firmada de cada sistema, en verde y sin
   `release/NO-PUBLICAR.txt`. Cada una deja su carpeta con sus binarios, su
   `SHA256SUMS.txt` y las dos firmas.
2. Se ensamblan con `scripts/assemble-release.mjs`:

   ```bash
   node scripts/assemble-release.mjs --from <release-windows> --from <release-linux> --out <carpeta-vacía>/v1.0.0
   ```

   Se niega si un origen tiene `NO-PUBLICAR.txt`, si un archivo no coincide
   con el hash de su manifiesto o si el manifiesto no lleva sus dos firmas
   válidas (los bytes son los validados). Copia solo lo publicable a una
   carpeta nueva y vacía, vuelve a calcular cada hash tras copiar, crea el
   manifiesto común con `create-release-manifest.mjs`, lo firma con Ed25519 y
   SSH y verifica las dos firmas. Deja un informe **al lado** de la carpeta
   (`v1.0.0.informe.txt`, con tamaño, hash y origen de cada archivo), no dentro,
   para que no se suba. Las claves se buscan como en `dev:test`
   (`--keys-dir <carpeta>`, de serie `Escritorio\Claves SSH`) y nunca se
   imprimen. `--platforms windows` permite, solo si se pide, una release sin
   Linux; `--no-sign` es para las pruebas.
3. Se crea y sube la etiqueta firmada (`git tag -s v1.0.0 -m "…"` y
   `git push origin v1.0.0`), y se sube la carpeta con
   `scripts/publish-github-release.mjs`:

   ```bash
   npm run release:github -- --dir <carpeta-vacía>/v1.0.0 --tag v1.0.0 --dry-run
   npm run release:github -- --dir <carpeta-vacía>/v1.0.0 --tag v1.0.0
   ```

   Primero `--dry-run`: comprueba todo y enseña las órdenes de `gh` sin
   ejecutarlas. Sin él vuelve a comprobar la carpeta (sin `NO-PUBLICAR.txt`,
   cada archivo con su hash, nada fuera del manifiesto, los adjuntos
   obligatorios de la versión de la etiqueta y las dos firmas, solo con las
   claves públicas de `--keys-dir`), exige sesión de `gh` (`gh auth login`, la
   inicia quien publica) y la etiqueta ya subida, crea la release **en
   borrador** con una tabla de hashes en las notas (o `--notes <archivo>`), sube
   los archivos y comprueba en GitHub que están todos con su tamaño. Nunca
   reemplaza adjuntos: si la release ya los tiene, se niega. Se revisa el
   borrador en GitHub y se publica allí, o se repite con `--publish`. Se suben
   **todos** los archivos de la carpeta, tal cual:

| Sistema | Archivos | ¿Obligatorio? |
|---|---|---|
| Windows | `WTerminal-<versión>-x64-setup.exe`, `WTerminal-<versión>-Portable.exe`, `WTerminal-Unpacked-<versión>.zip` | Sí, los tres: cada uno es el adjunto que actualiza una forma de distribución |
| Linux | `LTerminal-<versión>-x86_64.AppImage` | Sí |
| Linux | `LTerminal_<versión>_amd64.deb`, `LTerminal-<versión>-1.x86_64.rpm`, `LTerminal-Unpacked-<versión>-x86_64.tar.gz` | Si existen |
| Común | `SHA256SUMS.txt`, `SHA256SUMS.txt.sig`, `SHA256SUMS.txt.sshsig` | Sí: sin el manifiesto y sus dos firmas, ninguna copia ofrece la actualización |

El workflow `release.yml` sigue disponible a mano para compilar en CI, pero
solo crea borradores y nunca toca una release con adjuntos.

El workflow `Wine` ejecuta la batería Rust Windows con Wine sin requerir
WebView2. El smoke headless se lanza con `--wine-smoke` y
`--full-tests`; el smoke GUI/WebView2 se puede solicitar con
`LTERMINAL_WINE_GUI_SMOKE=1` y localiza o instala automáticamente el Runtime en
un prefijo privado. También admite `WINE_SMOKE_PREFIX` para fijar uno concreto y
`LTERMINAL_WINE_RUNNER=proton` junto con `LTERMINAL_PROTON=/ruta/al/proton`.
En Linux, Wine 11 y Proton 11 están instrumentados y aislados. El smoke headless
confirma entrada, salida y cierre del backend temporal de pipes; no equivale a
probar ConPTY. El GUI smoke de Wine prueba una ventana/captura visible y el
handshake JavaScript/PTY, pero no activa EdgeDriver/CDP ni certifica Windows
nativo. WineHQ recoge un reporte de
ventanas WebView2 negras/blancas que relaciona el síntoma con D3D11 y
DirectComposition ([WineHQ 59370](https://bugs.winehq.org/show_bug.cgi?id=59370),
cerrado como duplicado de [WineHQ 58921](https://bugs.winehq.org/show_bug.cgi?id=58921));
los argumentos de renderizado alternativos probados aquí no lo resuelven de
forma fiable. No es una validación gráfica ni una confirmación de un defecto de
LTerminal: la presentación visual y ConPTY real deben confirmarse en Windows
nativo.

### 15. Comprobaciones que hacen los scripts, y por qué

| Comprobación | Por qué está |
|---|---|
| Nada en marcha (puerto 1420, proceso de la app) | Windows no deja borrar un archivo en uso y `npm ci` empieza vaciando `node_modules`: con un servidor de desarrollo abierto falla con un `EPERM` sobre `esbuild.exe` que no dice cuál es la causa. De la app solo frena las copias que la build va a reemplazar, las abiertas desde el repositorio o desde `target`: una copia de otra carpeta (por ejemplo `releases\…`) puede seguir abierta mientras se compila (25-11). |
| Recursos ConPTY oficiales verificados | El build los descarga si faltan y aborta si no puede verificar el paquete o la pareja DLL/host. |
| WebKitGTK (Linux) | Su ausencia son cientos de líneas de error de enlazado a mitad de la compilación. |
| Solo el artefacto esperado | Un `.deb` o `.rpm` que se cuele acabaría publicado en una release sin que nadie lo haya probado. Hasta que `linux/build.sh` los valide, `tauri.linux.conf.json` deja `targets: ["appimage"]`, aunque ya lleva la configuración de los dos paquetes (sección `utils`, metadatos AppStream). |
| Comprobación de humo | Que compile no significa que arranque. |
| `release\NO-PUBLICAR.txt` mientras corre | Desde que prepara `release\` hasta que termina, la build deja el aviso «Build en curso» y solo lo quita si todo salió en verde (si no, lo cambia por la lista de lo pendiente). Una build cortada a mitad, como la 52 cuando la VM cayó, dejaba binarios firmados sin validar y sin ninguna marca. `assemble-release.mjs` y `publish-github-release.mjs` se niegan a usar una carpeta con el aviso. |
| Release al día (menú `build-tools/build.ps1`) | Al abrir el menú se compara `release\SHA256SUMS.txt` con los archivos de la app (`src`, `src-tauri`, configuración): si hay alguno más nuevo, avisa de que la release es anterior a los cambios y conviene recompilar antes de probarla o publicarla. |
| Espacio libre en la unidad del repositorio (Windows) | Por debajo de 5 GB la build se detiene con un mensaje claro; por debajo de 12 GB avisa. Antes se quedaba sin disco a mitad y fallaba con un `os error 112` que no decía la causa. |
| Pruebas con depuración ligera (Windows) | Durante `npm run check` se compila con `CARGO_PROFILE_DEV_DEBUG=line-tables-only` y `CARGO_INCREMENTAL=0` (salvo que ya vengan definidas): los pánicos siguen dando archivo y línea, y `target\debug` ocupa unos pocos GB en vez de más de 8. |
| Linker, 7-Zip y ffmpeg (Windows) | `rust-lld` solo se usa si hay bibliotecas del SDK y del CRT; si no, se instalan las Build Tools. 7-Zip (solo con `-WebView2 Offline`, para sacar WebView2 del NSIS) y ffmpeg (vídeo del E2E) se instalan al principio si faltan, no a mitad de build. |

## Arquitectura

Dos lados con una separación estricta: un backend en Rust que es el único que
toca el sistema, y un frontend en Svelte que solo pinta.

El banner se imprime una sola vez como salida normal del PTY dentro de
`terminal-host`, por lo que comparte scrollback, cursor y selección con la
shell sin superponerse a ellos. Este README concentra la documentación
mantenida del repositorio.

El recorrido operativo, con el orden de arranque, el ciclo de vida de una
pestaña, la frontera IPC, los procesos, el actualizador y los límites de
confianza está desarrollado en este README. El
[mapa de arquitectura](#mapa-de-archivos-llamadas-y-mantenimiento) permite seguir esos recorridos
por archivos y funciones concretos.

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

### Diagrama de flujo integral

Este diagrama es compatible con [mermaid.live](https://mermaid.live) y resume
el arranque, el ciclo PTY, el renderizado, las acciones, la detección de
dependencias y la verificación de una release.

```mermaid
flowchart TD
  A[Arranque Tauri] --> B[App.svelte onMount]
  B --> C[Cargar ajustes, pestañas y app_info]
  B --> D[Precalentar caché de detección]
  C --> E[Crear TerminalPane, xterm y FitAddon]
  E --> F[Registrar terminal y ajustar matriz inicial]
  F --> G[frontend_ready y tabs_ready]
  G --> H[Crear portable-pty]
  H --> I[Lector de salida PTY]
  I --> J[Utf8Decoder y ClearSplitter]
  J --> K{Data, clear o exit}
  K -->|Data| L[Cola de salida por tabId]
  L --> M[xterm.write con callback]
  M --> N[Medir, reflow, refresh y repaint]
  N --> O[Un scroll horizontal del host y viewport vertical de xterm]
  K -->|clear| P[Invalidar época y limpiar scrollback]
  K -->|exit| Q[pty-exit y estado de la pestaña]
  R[Teclado y ratón] --> S[Captura de atajos]
  S --> T[xterm.onData]
  T --> U[Cola de entrada por tabId]
  U --> V[pty_input]
  V --> H
  W[Acción de la interfaz] --> X[Validar alcance en backend]
  X --> Y[Escribir cabecera y comando visible]
  Y --> V
  D --> AA[Escaneo secuencial por sección]
  AA --> AB[Inventario WinGet y probes del ecosistema]
  AB --> AC[Caché instalado, ausente o desconocido]
  AC --> AD[Panel Entorno y dependencias]
  AD --> AE[Reintento explícito]
  AE --> AA
  AF[ResizeObserver, zoom o cambio de ventana] --> AG[Calcular columnas sin perder contenido]
  AG --> N
  AH[Checks y build] --> AI[Validar Rust, Svelte y contratos]
  AI --> AJ[Generar NSIS, ZIP y portable]
  AJ --> AK[SHA-256 y firmas]
  AK --> AL[E2E WebDriver]
  AL --> AM[Capturas, vídeo y revisión visual]
```

## Tecnologías y por qué se eligieron

Cada pieza de WTerminal, con cinco preguntas: qué es, por qué la usamos, para qué
sirve aquí, qué alternativas había y qué permite a futuro. Los detalles técnicos
de cada una están en su apartado (enlazado al final de cada pieza); aquí va el
porqué.

### 1. xterm.js: el emulador de terminal

#### 1.1 ¿Qué es?

Una biblioteca que convierte una página web en una terminal: interpreta las
secuencias de escape VT/ANSI (colores, cursor, borrados, pantalla alternativa),
guarda la rejilla y el historial, y pinta el resultado. Es la misma que usa el
terminal integrado de VS Code. WTerminal usa la versión 6 (`@xterm/xterm`) y
cinco complementos:

| Complemento | Para qué |
|---|---|
| `@xterm/addon-fit` | Calcular filas y columnas a partir del tamaño de la casilla |
| `@xterm/addon-image` | Imágenes Sixel dentro de la terminal |
| `@xterm/addon-search` | Buscar en el historial (`Ctrl+Shift+F`) |
| `@xterm/addon-unicode11` | Anchos correctos de emojis y caracteres de Asia oriental |
| `@xterm/addon-web-links` | Enlaces `http`, `https` y `file://` con Ctrl+clic |

#### 1.2 ¿Por qué la usamos?

La interfaz de WTerminal es web (Tauri con WebView2), y una interfaz web
necesita un emulador escrito para la web. xterm.js es el estándar de hecho:
maduro, mantenido y probado a diario por millones de personas a través de VS
Code. Escribir un emulador propio sería otro producto entero.

#### 1.3 ¿Para qué sirve en WTerminal?

- Pinta lo que entrega ConPTY, con la rejilla del mismo tamaño que la de la
  PTY. Si no coincidieran, los `ESC[fila;colH` caerían en otro sitio
  ([Flujo de salida PTY](#2-flujo-de-salida-pty)).
- Recibe el teclado (`onData`) y lo pasa a la cola de entrada
  ([Flujo de entrada, cursor y teclado](#3-flujo-de-entrada-cursor-y-teclado)).
- Sus manejadores OSC dan las [marcas de orden](#marcas-de-orden) (OSC 133),
  el directorio actual (OSC 7) y los hipervínculos (OSC 8).

#### 1.4 Alternativas, y por qué esta

- **Un renderer propio** (como Alacritty con OpenGL o WezTerm con el suyo): da
  más control y rendimiento, pero obliga a reescribir la interfaz entera fuera
  de la web. Está descartado en la
  [comparativa con Alacritty y WezTerm](#comparativa-con-alacritty-y-wezterm).
- **Otros emuladores web**, como hterm, el de ChromeOS: menos complementos y
  mucho menos uso fuera de su proyecto.

#### 1.5 Ventajas, futuro y curiosidades

- **Desplazamiento horizontal:** xterm.js no lo tiene. WTerminal lo hace en el
  contenedor (`terminal-host`) con una rejilla de al menos 1024 columnas, para
  que una línea larga no se parta ([Diagrama de entrada, salida y
  reflow](#diagrama-de-entrada-salida-y-reflow)).
- **xterm 6 no desplaza su elemento en el DOM:** por eso el E2E lee el texto
  con `window.__wtTerminalText` en vez de recorrer la pantalla.
- **A futuro:** hay complementos que aún no se usan, como el renderer WebGL
  (más rápido con mucha salida) o el que serializa la pantalla (guardar y
  restaurar una sesión con colores).

### 2. Tauri 2 y WebView2: la aplicación de escritorio

#### 2.1 ¿Qué es?

Tauri es un marco para hacer aplicaciones de escritorio con una interfaz web y
un backend en Rust. A diferencia de Electron, no lleva un Chromium dentro: usa
el navegador del sistema. En Windows es WebView2, el motor de Edge; en Linux,
WebKitGTK.

#### 2.2 ¿Por qué la usamos?

- **Sustituye a Electron:** WTerminal empezó en Electron. La migración a Tauri
  se cerró y el árbol de Electron sigue en el historial de git
  ([Convenciones del código](#convenciones-del-código)).
- **Tamaño:** el portable de un solo archivo de la build 57 ocupa 13,6 MB y el
  instalador, 5,5 MB.
- **Separación:** todo lo que toca el sistema está en Rust y el frontend solo
  pinta ([Arquitectura](#arquitectura)). Tauri hace de frontera con su IPC
  ([Contrato IPC](#contrato-ipc)).

#### 2.3 ¿Para qué sirve en WTerminal?

- La ventana, el IPC entre Svelte y Rust y los complementos oficiales de
  diálogos, portapapeles y abrir enlaces o carpetas.
- El instalador NSIS y el empaquetado ([Compilación y
  distribución](#compilación-y-distribución)).
- Si falta WebView2, la app lo detecta antes de abrir la ventana y ofrece
  instalarlo ([WebView2: si falta el runtime](#8-webview2-si-falta-el-runtime)).

#### 2.4 Alternativas, y por qué esta

- **Electron:** más fácil de empezar, pero cada copia lleva su Chromium (decenas
  de MB más) y el backend es Node. Fue la primera versión.
- **Interfaz nativa** (Win32, WinUI, Qt): sin web, pero sin xterm.js; habría que
  escribir el emulador y repetir la interfaz por sistema.

#### 2.5 Ventajas, futuro y curiosidades

- **Una base, dos sistemas:** la misma interfaz sirve para Windows (WTerminal)
  y Linux (LTerminal); solo cambian los adaptadores de `platform/`.
- **Tauri 2 también compila para Android e iOS:** no está en los planes, pero
  la base lo permitiría.
- **Curiosidad:** WebView2 puede dejar de pintar una ventana que no se ve, y la
  app repinta al volver (`refreshAfterWindowResume`). No pasa siempre: en el
  experimento del 13-11, con la ventana minimizada, siguió pintando.

### 3. ConPTY y portable-pty: hablar con las shells

#### 3.1 ¿Qué es?

- **ConPTY** es la pseudoconsola de Windows, desde Windows 10 1809. Una shell
  (cmd, PowerShell, WSL…) cree que escribe en una consola de verdad y ConPTY lo
  traduce a un flujo de texto con secuencias VT, que es lo que entiende
  xterm.js.
- **portable-pty** es la biblioteca de Rust, del proyecto WezTerm, que da la
  misma API sobre ConPTY en Windows y sobre `forkpty` en Unix.

#### 3.2 ¿Por qué la usamos?

Es la única forma moderna de alojar una shell de Windows dentro de otra app sin
perder colores, cursor ni programas a pantalla completa. portable-pty sustituye
a `node-pty`, que usaba la versión de Electron.

#### 3.3 ¿Para qué sirve en WTerminal?

- Cada pestaña es un proceso en su ConPTY; `terminal/pty.rs` lee su salida y
  escribe la entrada ([Arranque, ciclo de una pestaña y
  PTY/ConPTY](#arranque-ciclo-de-una-pestaña-y-ptyconpty)).
- **WTerminal lleva su propio ConPTY:** `conpty.dll` y `OpenConsole.exe` del
  paquete oficial de Microsoft (`Microsoft.Windows.Console.ConPTY`
  1.24.260710001), verificados por SHA-512. El del sistema falla en algunos
  Windows recortados con `STATUS_DLL_INIT_FAILED`, y tarda más de dos minutos
  en dar el error: las pestañas se quedaban en blanco sin decir por qué
  ([conpty.dll](#5-conptydll)).

#### 3.4 Alternativas, y por qué esta

- **winpty:** la solución de antes de que existiera ConPTY. Hoy está
  superada.
- **Un bucle de PTY propio**, como el de Alacritty: más trabajo sin ganar nada
  en una app local.
- **El ConPTY del sistema a secas:** es lo más sencillo, pero falla en los
  Windows recortados, que es justo donde corre la VM de pruebas.

#### 3.5 Ventajas, futuro y curiosidades

- **El portable de un solo archivo** lleva el ConPTY dentro y lo coloca en
  `%LOCALAPPDATA%\WTerminal\runtime\<huella>` al arrancar ([Portable de un solo
  archivo](#portable-de-un-solo-archivo)).
- **Curiosidad medida:** el OpenConsole 1.24 de la app repinta todas las filas
  de debajo del cursor por las columnas de la PTY. Con Python y pyreadline3
  eran 84 KB por tecla a 1024 columnas, frente a 279 bytes con el del sistema.
  De ahí el modo «Python con el ancho visible» ([Problemas
  conocidos](#problemas-conocidos)).

### 4. Svelte 5, Vite y TypeScript: el frontend

#### 4.1 ¿Qué es?

- **Svelte** es un marco de interfaz que se compila: el navegador recibe
  JavaScript ya resuelto, sin una biblioteca grande en tiempo de ejecución.
  La versión 5 usa «runas» (`$state`, `$derived`, `$effect`) para el estado.
- **Vite** compila y sirve el frontend.
- **TypeScript** añade tipos al JavaScript.

#### 4.2 ¿Por qué la usamos?

Para una interfaz que «solo pinta», Svelte da componentes pequeños y rápidos
con muy poco código de pegamento. Los tipos de TypeScript son los mismos que
devuelve el backend (`src/lib/types.ts`), y `svelte-check` los valida en cada
build.

#### 4.3 ¿Para qué sirve en WTerminal?

- Los componentes: la terminal (`TerminalPane.svelte`), la barra, los paneles,
  Ajustes, la paleta y el chat de agentes.
- El estado compartido: `appState.svelte.ts`.
- La lógica pura, sin interfaz, en `src/lib/*.ts`, que se prueba en Node con
  `scripts/test-frontend-logic.mjs`.

#### 4.4 Alternativas, y por qué esta

React y Vue también servirían. Llevan más código en tiempo de ejecución y no
aportan nada que aquí haga falta.

#### 4.5 Ventajas, futuro y curiosidades

- **El frontend nunca llama a `invoke` directamente:** todo pasa por
  `src/lib/api.ts`, el único sitio que conoce los nombres de los comandos.
- **El E2E lee estados internos** por funciones de diagnóstico de solo
  lectura (`__wtTerminalState`, `__wtInputState`, `__wtPendingIpc`), sin
  tocar nada ([Datos, logs y diagnóstico](#datos-logs-y-diagnóstico)).

### 5. Rust: el backend

#### 5.1 ¿Qué es?

Un lenguaje compilado, rápido y con memoria segura sin recolector de basura.

#### 5.2 ¿Por qué la usamos?

Tauri lo pide para el backend. Además, es el lado que toca el sistema
(procesos, Registro, archivos, red y firmas), y ahí conviene un lenguaje que
evite toda una clase de errores de memoria.

#### 5.3 ¿Para qué sirve en WTerminal?

Algunas piezas, por crate:

| Crate | Para qué |
|---|---|
| `portable-pty` | Las pestañas sobre ConPTY o `forkpty` |
| `tokio` | Un runtime con más hilos que el de fábrica, para que los comandos que esperan no dejen sin hilos al resto |
| `reqwest` con `rustls` | Descargas (WebView2, actualizaciones) |
| `ring` | Comprobar las firmas Ed25519 de las releases |
| `windows` | Win32: firmas Authenticode, DPAPI para las claves de IA, los mensajes de `cmd.exe`, la consola |
| `winreg` | Leer el Registro sin lanzar `reg.exe` decenas de veces |
| `sysinfo` | El banner del sistema: CPU, memoria y discos |

#### 5.4 Alternativas, y por qué esta

Con Electron el backend era Node. Tres crates sustituyen lo que Node traía de
serie (`sysinfo`, `reqwest` y `portable-pty`), y el resto se escribe con lo
mínimo.

#### 5.5 Ventajas, futuro y curiosidades

- **Las pruebas de Rust** (más de mil) corren en cada build con `cargo test`, y
  clippy con `-D warnings`.
- **Cada módulo abre diciendo de dónde viene** (`//! Port de
  electron/main/…`) y explica el porqué en español.

### 6. NSIS y el portable: cómo se entrega

#### 6.1 ¿Qué es?

- **NSIS** es el sistema de instaladores para Windows que usa Tauri.
- **El portable** es la app en un solo `.exe` que no se instala.

#### 6.2 ¿Por qué la usamos?

Para que cada cual elija: instalarla (accesos directos, PATH, desinstalador) o
llevarla en una carpeta o un USB sin tocar el sistema.

#### 6.3 ¿Para qué sirve en WTerminal?

- **El instalador:** `windows/installer/installer.nsi` y `hooks.nsh`, con sus
  traducciones.
- **Tres formas de distribución:** el portable de un solo archivo
  (`create-single-file-portable.mjs`, con su índice y la marca `WTPORT01` al
  final), la carpeta desempaquetada y su ZIP ([Instalación para usar la
  aplicación](#instalación-para-usar-la-aplicación)).

#### 6.4 Alternativas, y por qué esta

MSI o MSIX son más corporativos y más rígidos para una app que también se usa
portable. NSIS es el que trae Tauri y permite ganchos propios.

#### 6.5 Ventajas, futuro y curiosidades

- **El portable se actualiza solo,** reemplazando el `.exe` que corre, como un
  AppImage de Linux.
- **La build larga lo prueba todo:** instala con un solo UAC, recorre lo
  instalado y desinstala comprobando que no queda nada.

### 7. Doble firma: Ed25519 y OpenSSH

#### 7.1 ¿Qué es?

Cada release publica `SHA256SUMS.txt` con la huella de cada archivo, firmado
dos veces: con Ed25519 (`.sig`) y con OpenSSH/SSHSIG (`.sshsig`).

#### 7.2 ¿Por qué la usamos?

El actualizador solo instala lo firmado con las dos claves. Si alguien
cambiara un archivo de la release, la huella no coincidiría. Si cambiara
también la huella, faltarían las firmas.

#### 7.3 ¿Para qué sirve en WTerminal?

- Antes de avisar de una versión nueva y otra vez antes de instalarla.
- Una build no autorizada con las dos claves no se autoactualiza ([Seguridad de
  las releases](#13-seguridad-de-las-releases)).

#### 7.4 Alternativas, y por qué esta

La firma de código de Windows (Authenticode) necesita un certificado de pago.
Una sola firma sería un único punto de fallo. Dos firmas independientes, con
formatos distintos, cuestan poco.

#### 7.5 Ventajas, futuro y curiosidades

La clave privada nunca está en el repositorio ni en los jobs que compilan. En
local se pasa la carpeta con `-KeysDir`.

La firma OpenSSH se comprueba con `ssh-keygen -Y verify`, así que el equipo
necesita `ssh-keygen`. Viene con Git para Windows y con el cliente OpenSSH de
Windows, que Windows 11 trae de serie pero las ediciones LTSC no. WTerminal lo
busca en el `PATH`, en `System32\OpenSSH`, en `Program Files\OpenSSH` y en las
carpetas de siempre de Git (`updater/security.rs`, `ssh_keygen_path`).

#### 7.6 «No incluye las claves de confianza», cuando sí las incluye

La 63 decía «Esta compilación no incluye las claves de confianza» en un equipo
sin `ssh-keygen`, aunque las claves sí venían dentro: el mensaje no distinguía
los dos casos. Las builds 62, 63, 65 y 67 llevan la clave pública SSH (se
comprobó buscándola dentro de cada portable). Desde el 17-11 cada caso tiene su
mensaje (`release_signing_problem`):

- **Faltan las claves en la build:** «Esta compilación no incluye las claves de
  confianza…». Una build así no se ofrece actualizar nunca.
- **Faltan las herramientas en el equipo:** «Las claves de confianza vienen
  dentro, pero falta ssh-keygen…», y dice de dónde sacarlo.

### 8. Pruebas E2E con WebDriver: comprobar lo que se ve

#### 8.1 ¿Qué es?

Pruebas de punta a punta: un programa abre la app de verdad, teclea y hace clic
como una persona, y comprueba lo que sale en pantalla.

#### 8.2 ¿Por qué la usamos?

Casi todos los fallos de una terminal son de tiempos y de pantalla: un eco que
llega tarde, una línea partida o un Intro que no llega. Eso solo se ve con la
app de verdad, una shell de verdad y su ConPTY.

#### 8.3 ¿Para qué sirve en WTerminal?

- WebDriver con el driver de Edge y el protocolo de depuración de WebView2
  (`scripts/e2e-native-driver.mjs`).
- Capturas y vídeo de cada escenario.
- Suites `focused`, `video`, `downloads`, `dependency-audit`, `installer` y
  `components` ([E2E](#e2e), [Pruebas](#pruebas)).

#### 8.4 Alternativas, y por qué esta

- **Playwright** se usa para algo concreto: la barra montada en un Chromium
  sin ventana, con 504 combinaciones de ancho, idioma y controles
  (`npm run test:toolbar-layout`).
- **La app entera** necesita su ventana real de WebView2 con su ConPTY detrás,
  y eso lo gobierna el driver de Edge (WebDriver) con el protocolo de
  depuración de WebView2.
- **Las pruebas unitarias** no ven ConPTY ni la pantalla.

#### 8.5 Ventajas, futuro y curiosidades

El fallo intermitente de `tab-tools` (builds 56 y 58) se encontró así:
- un escenario que lo reproduce (`hidden-enter`);
- un diagnóstico de la cola de entrada (`__wtInputState`);
- y la cola de entrada arreglada ([Flujo de entrada, cursor y
  teclado](#3-flujo-de-entrada-cursor-y-teclado)).

### 9. Clink, PSReadLine y ble.sh: la línea de órdenes

#### 9.1 ¿Qué es?

Editores de línea de cada shell, que dan sugerencias del historial en gris,
colores de sintaxis y mejor completado:
- Clink para cmd;
- PSReadLine para PowerShell;
- ble.sh para bash;
- los plugins de zsh.

#### 9.2 ¿Por qué la usamos?

Son las herramientas que la gente ya conoce y usa. WTerminal no reinventa la
línea de órdenes: las integra, las configura desde Ajustes y respeta lo que
cada cual haya configurado.

#### 9.3 ¿Para qué sirve en WTerminal?

- `terminal/shell_assist.rs` inyecta Clink con un perfil propio y activa las
  predicciones de PSReadLine si nadie las configuró.
- Carga ble.sh o los plugins de zsh si existen.
- Se instalan desde [Entorno y dependencias](#panel-de-entorno-y-dependencias).

#### 9.4 Alternativas, y por qué esta

Escribir un editor de línea propio dentro de la terminal rompería el contrato
con la shell, porque lo que se teclea dejaría de ser lo que recibe.

#### 9.5 Ventajas, futuro y curiosidades

- **La suite `components`** repite las pruebas de eco con Clink y PSReadLine
  encendidos, como los tiene la gente.
- **pyreadline3** hace lo mismo para el REPL de Python 3.12 o anterior, y se
  instala desde Entorno y dependencias.

## Diagramas de flujo detallados

Un diagrama por flujo, con los **archivos y funciones reales** en cada nodo.
Todos se pueden pegar tal cual en [mermaid.live](https://mermaid.live).
`npm run check:flows` (`scripts/verify-flow-documentation.mjs`) comprueba que
cada función citada aquí sigue existiendo en el archivo indicado: si se
renombra o se mueve, el contrato falla y obliga a actualizar el diagrama.

### Arranque, ciclo de una pestaña y PTY/ConPTY

La rejilla de xterm nunca baja de 1024 columnas (la geometría de ConPTY) y la
shell no arranca hasta la primera medición real (`viewport_confirmed`).

```mermaid
sequenceDiagram
    autonumber
    participant Lib as lib.rs run/setup
    participant State as app/state.rs
    participant App as App.svelte + appState.load
    participant Pane as TerminalPane.svelte
    participant Cmd as app/commands.rs
    participant Tabs as terminal/tabs.rs TabManager
    participant Files as terminal/session_files.rs
    participant PTY as terminal/pty.rs spawn_pty
    Lib->>State: migrate_local_data y estado compartido
    Lib->>Tabs: create_tab con el entorno por defecto
    App->>Cmd: tabs_list + settings_get + app_info
    App->>Pane: un TerminalPane por pestaña
    Pane->>Pane: xterm + FitAddon y fitAndReport
    Pane->>Cmd: pty_resize con la medida real
    Cmd->>Tabs: resize_from_frontend marca viewport_confirmed
    Tabs->>Tabs: effective_startup_viewport
    Tabs->>Files: write_session_files banner + init + assist_lines
    Tabs->>PTY: spawn_pty con WSTERM_UI y TERM
    PTY-->>Tabs: bytes de ConPTY o de la PTY
    Tabs-->>App: evento pty-data con tabId y generación
    App->>Pane: xterm.write en la cola del tab
    Pane->>Cmd: tabs_ready y frontend_ready
    Pane->>Pane: releaseInput libera la entrada en cola
```

### IPC por dominio

```mermaid
flowchart LR
  subgraph Frontend["src/ (Svelte 5)"]
    API["lib/api.ts tauriInvoke + listen"]
  end
  subgraph Backend["src-tauri/src/ (generate_handler! en lib.rs)"]
    AppCmd["app/commands.rs<br/>pty_input, pty_resize, tabs_ready,<br/>frontend_ready, settings_get, settings_save,<br/>profile_export"]
    PkgCmd["packages/commands.rs<br/>install_list, install_check, install_run"]
    ProjCmd["projects/commands.rs<br/>proyectos, git y releases"]
    UpdCmd["updater/commands.rs<br/>update_check, update_check_on_startup"]
    Store["config/toolchain_store.rs<br/>toolchain_store_status,<br/>toolchain_store_external_sizes"]
    Assist["terminal/shell_assist.rs<br/>shell_assist_status"]
  end
  API --> AppCmd
  API --> PkgCmd
  API --> ProjCmd
  API --> UpdCmd
  API --> Store
  API --> Assist
  AppCmd -. "pty-data, pty-exit, pty-clear, tab-closed" .-> API
  UpdCmd -. "update-progress" .-> API
```

### Detección de entornos y WSL

```mermaid
flowchart TD
  A["environments/mod.rs detect_environments"] --> B["detect_system_shells<br/>cmd, PowerShell, pwsh, Git Bash, MSYS2"]
  A --> C["environments/wsl.rs get_wsl_context"]
  C --> C1["parse_installed_distros<br/>wsl.exe --list"]
  C1 --> C2["probe_distro por distro<br/>wsl.exe -d X --exec sh LISTING_SCRIPT"]
  C2 --> C3{"¿respondió?"}
  C3 -->|sí| C4["shells, gestor de paquetes y marcadores<br/>de ble.sh y plugins de zsh"]
  C3 -->|no, en frío| C5["«sin comprobar»: tabs.rs heal_unverified_wsl<br/>reintenta al abrir la pestaña"]
  A --> D["languages: REPL por lenguaje"]
  A --> E["environments/ai.rs detect_ai_environments<br/>CLIs de IA y un chat por modelo de Ollama"]
  E --> E1["infrastructure/path_env.rs which<br/>PATH o known_install_location"]
  E1 --> E2["Claude Code: ~/.local/bin, npm o<br/>%APPDATA%/Claude/claude-code/versión/hash"]
  E --> E3["installed_ollama_models<br/>manifiestos en OLLAMA_MODELS o ~/.ollama"]
  B --> F["Inventory: selector de pestañas y default_env_id"]
  C4 --> F
  D --> F
  E --> F
```

### Entorno y dependencias, con sus sondas

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DependenciesPanel.svelte
    participant Cmd as packages/commands.rs
    participant Cat as packages/actions.rs get_install_actions
    participant Probe as sondas (path_env, winget_probe, ecosystem_probe)
    participant Tabs as terminal/tabs.rs
    participant UI as terminal/console_ui.rs decorate
    Panel->>Cmd: install_list
    Cmd->>Cat: install_context + get_install_actions
    Cat-->>Cmd: catálogo con check_cmd y requires_cmd
    Cmd->>Probe: filter_available_actions_with_depth Fast y luego Full
    Probe-->>Cmd: instalado, ausente o desconocido
    Cmd-->>Panel: InstallList (build_list)
    Panel->>Cmd: install_run(tabId, actionId)
    Cmd->>Cmd: shell_tab elige una shell real
    Cmd->>Cmd: wrap_powershell_command si la acción es un script
    Cmd->>UI: decorate con la cabecera y el cierre
    UI-->>Cmd: cmd: una sola línea con cmd_framed
    Cmd->>Tabs: write_command en la pestaña visible
```

En cmd la orden visible es una sola línea:
`call "%WSTERM_UI%\ui-N-ini.cmd" & <orden real> & call "%WSTERM_UI%\ui-N-fin.cmd"`.
La cabecera y el cierre (con `if errorlevel`) viven en esos dos archivos de la
carpeta de sesión; `WSTERM_UI` la pone `spawn_pty` en el entorno de cada
pestaña.

**Sin barra de progreso (21-11).** La barra de progreso de PowerShell
(`Add-WindowsCapability`, `Invoke-WebRequest`, `Install-Module`…) se dibuja
arriba de la ventana, encima del banner, y al borrarse descolocaba el marco: la
cabecera salía después de la barra y el prompt antes de «completado» (captura
de Romen con «Instalar cliente SSH» desde cmd). `wrap_powershell_command` pone
`$ProgressPreference = 'SilentlyContinue'` delante de **todas** las acciones de
PowerShell; en una pestaña de PowerShell la preferencia del usuario se le
devuelve al acabar (`finally`). Las acciones de administrador (Permisos de
administrador y NSudo, 9.6) hacen lo mismo en su PowerShell elevado.

### Sugerencias, colores y temas

```mermaid
flowchart TD
  P["config/preferences.rs sanitize_preferences"] --> S["shell_assist.rs AssistStyle::from_preferences"]
  S --> I["init_lines por shell"]
  I --> CMD["cmd: clink_default_settings +<br/>ensure_clink_profile_with + call clink inject"]
  I --> PS["PowerShell: psreadline_style_lines<br/>Set-PSReadLineOption -Colors"]
  I --> BA["bash: ble.sh + blesh_style_commands<br/>ble-face y bleopt"]
  I --> ZS["zsh: ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE +<br/>zsh_highlight_styles"]
  CMD --> F["session_files.rs write_session_files<br/>InitOptions.assist_lines"]
  PS --> F
  BA --> F
  ZS --> F
  P --> T["preferences.rs effective_palette<br/>base neutra NEUTRAL_THEME_ID"]
  T --> TS["src/lib/theme.ts effectivePalette<br/>themePreferencePatch"]
  TS --> AT["applyTheme: variables CSS"]
  TS --> TT["terminalTheme: xterm + 16 colores ANSI"]
  TS --> TF["terminalFont: fuente propia + familia + símbolos"]
```

### Imágenes Sixel y símbolos

```mermaid
flowchart LR
  APP["fastfetch, chafa, img2sixel"] -->|"DCS Sixel"| CON["ConPTY pasa la secuencia"]
  CON --> X["xterm.js + @xterm/addon-image"]
  X --> AL["src/lib/sixel-conpty.ts alignSixelWithConpty"]
  AL --> AS["sixelPixelAspect + conptySixelBox<br/>caja VT340 de 10x20 por celda"]
  AS --> EC["el eco siguiente queda en la fila de ConPTY"]
  U["@xterm/addon-unicode11"] --> W["anchos de emoji y CJK iguales a ConPTY"]
  FN["preferences.rs SYMBOL_FALLBACKS"] --> SY["'WTerminal Symbols' (Nerd Font incluida)<br/>emoji del sistema y monospace"]
```

### Enlaces de la salida

```mermaid
flowchart TD
  OUT["salida PTY en xterm"] --> WL["@xterm/addon-web-links<br/>TERMINAL_LINK_REGEX: http, https, file://"]
  OUT --> O8["hipervínculo OSC 8<br/>linkHandler = osc8LinkHandler"]
  PREF["terminalLinks (Ajustes → Terminal)"] --> SYNC["TerminalPane.svelte syncTerminalLinks<br/>carga o retira el addon y el manejador"]
  SYNC --> WL
  SYNC --> O8
  WL --> ACT["activateTerminalLink"]
  O8 --> ACT
  ACT -->|"sin Ctrl"| NOOP["clic normal de la terminal"]
  ACT -->|"Ctrl+clic"| CHK["terminal-links.ts checkTerminalLink<br/>esquema, longitud, ocultos, credenciales"]
  CHK -->|"rechazo"| NOTE["terminal-link-notice"]
  CHK --> CONF{"terminalLinksConfirm"}
  CONF -->|"sí"| DLG["terminal-link-dialog<br/>URL completa y host"]
  DLG -->|"Abrir"| IPC["api.openTerminalLink → terminal_open_link"]
  CONF -->|"no"| IPC
  IPC --> VAL["terminal/links.rs validate_link<br/>ALLOWED_SCHEMES, file local y existente"]
  VAL -->|"Web"| BR["opener: navegador"]
  VAL -->|"Directory"| DIR["platform::open_directory"]
  VAL -->|"File"| REV["reveal_item_in_dir: nunca ejecuta"]
  VAL -->|"LTERMINAL_E2E_TESTING"| REC["record_e2e_open → LTERMINAL_E2E_OPENED_LINKS"]
```

### Almacenamiento y cachés

```mermaid
flowchart TD
  ST["config/toolchain_store.rs status"] --> AL["app_locations: ajustes, logs,<br/>WebView2, runtime del portable, Clink"]
  ST --> CA["cachés propias bajo effective_root"]
  ST --> EX["external_locations + external_sizes<br/>cargo, rustup, npm, pip, winget, Ollama, discos WSL"]
  CA --> OV["overrides_for por Category: cachés, descargas, IA,<br/>herramientas e historial, sin pisar las del usuario"]
  OV --> XP["extra_path_dirs + process::set_extra_path:<br/>bin de las herramientas nuevas delante en el PATH"]
  OV --> RE["refresh_environment: solo procesos de WTerminal"]
  ST --> UI["SettingsPanel.svelte: tarjeta settings-storage-tip<br/>para qué sirve, si se puede borrar y qué pasa"]
  UI --> FT["floating-tip.ts placeFloatingTip + fitFloatingTip<br/>coordenadas de ventana, siempre dentro del panel"]
  ST --> CL["clear_caches: vacía solo las cachés propias"]
  BOOT["arranque"] --> PR["session_files.rs prune_orphaned_sessions<br/>%TEMP%/wterminal/PID huérfanos"]
```

### Paleta de comandos

```mermaid
flowchart TD
  KEY["Ctrl+Shift+P (shortcutCommandPalette)"] --> SC["App.svelte onShortcut<br/>paletteOpen = !paletteOpen"]
  SC --> CP["CommandPalette.svelte<br/>combobox + listbox, aria-activedescendant"]
  ST["app: preferencias, entornos, temas, fuentes, idiomas"] --> REG["command-palette.ts buildPaletteEntries"]
  LT["api.listLToolsActions (caché 60 s)"] --> PIN["ltools-selection.ts pinnedLToolsActions<br/>misma selección que la Biblioteca"]
  PIN --> REG
  REG --> CP
  CP --> FIL["paletteResults + filterPaletteEntries<br/>sin tildes, comando : y subsecuencia"]
  CP -->|"Intro"| RUN["App.svelte runPaletteEntry"]
  RUN -->|"panel, pestaña, división, explorador"| ACT["runAppAction<br/>el mismo manejador que los atajos"]
  RUN -->|"entorno, REPL, tema, fuente, idioma"| SAME["switchEnvironment, createTab,<br/>themePreferencePatch, savePreferences"]
  RUN -->|"comando :"| PARSE["api.parseInternalCommand<br/>(internal_command_parse en Rust)"]
  PARSE --> SUB["submitToActiveTerminal"]
  ACT -->|"Limpiar"| SUB
  SUB --> CTRL["terminalRegistry getTerminalControls<br/>submitLine"]
  CTRL -->|"prompt vacío"| INPUT["TerminalPane submitLineFromApp<br/>term.input: la misma ruta que el teclado"]
  CTRL -->|"no lista, ocupada o con texto"| REJ["motivo en la paleta, nada escrito"]
  INPUT --> INT["interceptor de : → runInternal + writeInternal<br/>o alias clear de la shell"]
  INT --> CON["el eco y el prompt los pinta ConPTY"]
  RUN -->|"acción fijada"| LRUN["api.runLToolsAction<br/>confirmación si modifica el sistema"]
```

### Actualizador

```mermaid
flowchart TD
  A["update_check_on_startup / update_check"] --> B["release estable de GitHub"]
  B --> C["verified_release_manifest"]
  C --> D["security::verify_signature (Ed25519)"]
  D --> E["security::verify_ssh_signature (OpenSSH)"]
  E --> F["security::verify_checksum del adjunto"]
  F --> H{"PackageKind"}
  H -->|"WindowsInstalled, LinuxDeb, LinuxRpm"| S["installer_staging + launch_installer:<br/>NSIS con UAC o pkexec + apt-get/dnf/zypper/rpm"]
  H -->|"WindowsSingleFile o LinuxAppImage"| G["self_update::validate_payload_tree"]
  H -->|"WindowsFolder (.zip) o LinuxFolder (.tar.gz)"| X["extract + payload_root"]
  X --> G
  G -->|"un solo archivo"| I["sustituir solo el ejecutable"]
  G -->|"carpeta"| J["self_update::apply sobre la carpeta"]
```

### Portable de un solo archivo

```mermaid
flowchart LR
  B["scripts/create-single-file-portable.mjs"] --> P["wterminal.exe + conpty.dll + OpenConsole.exe +<br/>WebView2 solo en la variante Offline + índice JSON + trailer WTPORT01"]
  P --> R["config/single_file.rs current / is_single_file"]
  R --> M["Payload::materialize en runtime_cache_root"]
  M --> S["terminal/pty.rs sideloaded_conpty<br/>LoadLibraryExW del conpty.dll extraído"]
  M --> K["prune_runtime_cache conserva el que está en uso"]
```

### Build y release

```mermaid
flowchart TD
  A["windows/build.ps1"] --> B["npm run check: tipos, formato, clippy, tests"]
  B --> C["Invoke-TauriBuild: release, NSIS y desempaquetado"]
  C --> D["create-single-file-portable.mjs + --verify"]
  D --> E["smoke mínimo: frontend, xterm y PTY"]
  E --> F["E2E completo del desempaquetado y del portable<br/>artifacts/builds/.../e2e-*"]
  F --> G["release/: zip, setup, Portable y SHA256SUMS.txt"]
  G --> H["sign-release-manifest.mjs (.sig) +<br/>sign-release-ssh.mjs (.sshsig)"]
  H --> I["test-install-actions-preventive.mjs"]
  I --> J["run-e2e-suite.mjs: focused, video,<br/>downloads, dependency-audit, installer"]
  J --> K["Write-BuildSummary: release, pruebas,<br/>informes, vídeos, capturas y logs"]
```

### E2E

```mermaid
sequenceDiagram
    autonumber
    participant Run as scripts/run-e2e-suite.mjs
    participant Plan as tests/e2e/suites.mjs planSuites
    participant Sc as tests/e2e/run-scenario.mjs runSmokeScenario
    participant Smoke as tests/e2e/smoke.mjs
    participant Drv as scripts/e2e-native-driver.mjs
    participant Inst as scripts/test-installer.mjs runInstallerTest
    Run->>Plan: suites pedidas y repeticiones
    loop cada escenario
        Run->>Sc: env E2E_* y límite de tiempo
        Sc->>Smoke: E2E_CAPTURE_DIR por escenario
        Smoke->>Drv: WebDriver + CDP de WebView2
        Smoke-->>Sc: informe JSON, capturas y vídeo
    end
    Run->>Inst: instalar con un UAC, E2E sobre lo instalado y desinstalar
    Run-->>Run: summary.md y summary.json
```

## Mapa de archivos, llamadas y mantenimiento

Esta sección es el mapa técnico completo del código: **cada archivo de
`src/` y `src-tauri/src/`** y cada script de `scripts/`, `windows/`,
`linux/`, `tests/` y `build-tools/`, quién llama a quién, dónde se
transforma un dato entre Svelte, IPC, Rust, la PTY y el sistema, el origen
de los datos y diagramas que se pueden pegar en
[mermaid.live](https://mermaid.live). Las flechas indican llamadas o eventos
reales; una respuesta asíncrona no garantiza que otra solicitud haya
terminado. Para orientarse sin leerla entera:

| Si necesitas cambiar… | Empieza aquí | Continúa por… |
|---|---|---|
| Arranque, primera ventana o PTY | [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) (`run`, `setup`) | [`app/state.rs`](src-tauri/src/app/state.rs) → [`terminal/tabs.rs`](src-tauri/src/terminal/tabs.rs) → [`src/App.svelte`](src/App.svelte) |
| Entrada, prompt, cursor y scroll | [`TerminalPane.svelte`](src/components/TerminalPane.svelte) (`releaseInput`, `fitAndReport`) | [`api.ts`](src/lib/api.ts) → [`app/commands.rs`](src-tauri/src/app/commands.rs) → [`terminal/tabs.rs`](src-tauri/src/terminal/tabs.rs) → [`terminal/pty.rs`](src-tauri/src/terminal/pty.rs) |
| Salida PTY o `cls` | [`terminal/pty.rs`](src-tauri/src/terminal/pty.rs) | [`terminal/stream.rs`](src-tauri/src/terminal/stream.rs) → [`terminal/tabs.rs`](src-tauri/src/terminal/tabs.rs) → [`src/App.svelte`](src/App.svelte) → xterm |
| Dependencias y detección | [`DependenciesPanel.svelte`](src/components/DependenciesPanel.svelte) | [`api.ts`](src/lib/api.ts) → [`packages/commands.rs`](src-tauri/src/packages/commands.rs) → [`packages/actions.rs`](src-tauri/src/packages/actions.rs) y [`environments/mod.rs`](src-tauri/src/environments/mod.rs) |
| Ajustes, idioma y tema | [`SettingsPanel.svelte`](src/components/SettingsPanel.svelte) | [`appState.svelte.ts`](src/lib/appState.svelte.ts) → [`api.ts`](src/lib/api.ts) → [`app/commands.rs`](src-tauri/src/app/commands.rs) → [`config/preferences.rs`](src-tauri/src/config/preferences.rs) |
| Releases y vídeo E2E | [`windows/build.ps1`](windows/build.ps1) | [`tests/e2e/smoke.mjs`](tests/e2e/smoke.mjs) → [`e2e-native-driver.mjs`](scripts/e2e-native-driver.mjs) → [`audit-video-frames.py`](scripts/audit-video-frames.py) |

Una ruta común de entrada y salida se lee así:

```mermaid
sequenceDiagram
    autonumber
    participant User as Usuario
    participant Pane as TerminalPane.svelte
    participant API as src/lib/api.ts
    participant Cmd as app/commands.rs
    participant Tabs as terminal/tabs.rs
    participant PTY as terminal/pty.rs + shell
    participant App as App.svelte
    User->>Pane: tecla, pegado o Enter
    Pane->>Pane: reservar columnas y mantener el cursor visible
    Pane->>API: sendInput(tabId, bytes)
    API->>Cmd: invoke pty_input
    Cmd->>Tabs: note_user_input + write
    Tabs->>PTY: bytes a la shell
    PTY-->>Tabs: eco y resultado
    Tabs-->>App: pty-data(tabId, data)
    App->>App: cola de salida y época del tab
    App->>Pane: xterm.write(data, callback)
    Pane->>API: resize(tabId, cols, rows) si cambia la matriz
    API->>Cmd: invoke pty_resize
    Cmd->>Tabs: resize de la PTY
```

### Fronteras y fuentes de verdad

| Dato | Dueño | Consumidores | Cómo cambia |
|---|---|---|---|
| Pestañas y sesión de shell | `TabManager` en `terminal/tabs.rs` | `AppStore`, `TerminalPane` | IPC `tabs_*`, eventos `tab-closed` y `env-changed` |
| Bytes de salida | PTY y su lector en `terminal/pty.rs` | cola de `App.svelte`, xterm | `pty-data` o `pty-clear` con `tabId` |
| Cursor y edición | shell conectada a la PTY | xterm refleja lo recibido | `onData` → `pty_input` → eco de la shell |
| Geometría visible | `TerminalPane.svelte` | xterm y PTY | `fitAndReport` → `pty_resize`; el host posee el scroll horizontal |
| Preferencias persistentes | `config/preferences.rs` | `AppStore` y componentes | `settings_get/save/reset` |
| Catálogo de instalación | `packages/actions.rs` y `packages/commands.rs` | `DependenciesPanel` | `install_catalog/list/check/refresh` |
| Inventario de entornos | `environments/mod.rs` y `AppState` | selector, dependencias | `env_list/refresh`, evento `envs-updated` |
| Archivos y proyectos | backend `explorer`, `scripts`, `projects` | paneles | comandos de cada dominio; el backend revalida las rutas |

`src/lib/api.ts` es el puente único: encapsula `invoke` y `listen`. El
nombre de cada comando se registra en `src-tauri/src/lib.rs` mediante
`generate_handler!`. Un componente no debe construir un nombre IPC propio.
Las funciones del backend comprueban los datos recibidos: que una tarjeta o
una ruta exista en el frontend no constituye autorización.

### Mapa de directorios

| Ruta | Contenido y punto de entrada |
|---|---|
| `src/` | Interfaz Svelte 5, xterm.js, estilos y tipos. `main.ts` monta `App.svelte`. |
| `src/components/` | Cada región visual de la ventana. `TerminalPane.svelte` posee la instancia xterm de una pestaña. |
| `src/lib/` | Estado compartido, puente IPC y algoritmos puros de teclado, columnas, tema y render. |
| `src/styles/` | CSS general, paneles y geometría de la terminal. |
| `src-tauri/src/app/` | Estado Rust compartido y funciones Tauri invocables. |
| `src-tauri/src/terminal/` | Pestañas, PTY, shell, protocolos de salida y archivos de sesión. |
| `src-tauri/src/config/` | Preferencias, identidad, rutas, migración, traducción y plugins. |
| `src-tauri/src/environments/` | Detección de shells y sistemas externos. |
| `src-tauri/src/packages/` | Definición, estado y ejecución visible de acciones de instalación. |
| `src-tauri/src/explorer/` | Operaciones y visores de archivos. |
| `src-tauri/src/scripts/` | Escaneo, favoritos y ejecución de scripts. |
| `src-tauri/src/projects/` | Estado de proyectos, repositorios y cliente GitHub. |
| `src-tauri/src/updater/` | Comprobación, autenticación y aplicación de releases. |
| `src-tauri/src/platform/` | Adaptadores Windows/Linux; WebView2, elevación e integración de rutas. |
| `src-tauri/src/infrastructure/` | Ejecución de procesos, PATH y logging. |
| `src-tauri/src/system/` | Información de hardware y virtualización. |
| `src-tauri/locales/` | Un JSON por idioma; mismas claves en todos los catálogos. |
| `windows/`, `linux/` | Construcción y validación nativa o cruzada por sistema. |
| `scripts/` | Utilidades de build, firma, auditoría, contratos y pruebas. |
| `tests/e2e/` | Driver WebView2, escenarios observables y layout. |
| `tests/ui/` | Superficie aislada de la barra de herramientas. |
| `docs/` | Este mapa y auditorías de diseño comparativas. |
| `release/`, `artifacts/` | Salidas de trabajo; no son fuente de verdad del código. |

#### Rutas creadas durante la ejecución

Estas rutas salen de `config/paths.rs`; no debe codificarse su valor absoluto
en la UI. El slug cambia entre Windows (`wterminal`) y Linux
(`lterminal`). El E2E usa un directorio de datos aislado solo cuando se
activa `LTERMINAL_E2E_TESTING` con una ruta absoluta.

En ese modo, las pestañas de PowerShell guardan además su historial de
PSReadLine en `e2e-psreadline-history.txt`, dentro de esa carpeta. La orden la
da `session_files::e2e_powershell_history_line` y se aplica dos veces:

- **al arrancar PowerShell**, delante del lector de la primera línea
  (`powershell::prepare_spawn_args`), antes de leer ni teclear nada;
- **al final del inicializador**, para las shells que arrancan con su propio
  `-Command` y no llevan ese lector.

- **Por qué:** con el historial real del usuario, cada prueba lo llenaba de
  órdenes de test. En la build 56 `tab-tools` cayó con la línea muy larga sin
  ejecutar y pasó en cuanto se apartó el historial, así que se le echó la
  culpa. **No era toda la causa:** en la build 58 volvió a caer igual con el
  historial ya aislado (3 líneas). Ver `hidden-enter` y `__wtInputState`.
- **Por qué también al arrancar:** con el desvío solo al final del
  inicializador se colaba la línea `. "init-tab-N.ps1"` que lo carga. Normalmente
  la lee el lector del arranque y no se apunta, pero al cambiar de shell con
  `:shell` a veces la recibía PSReadLine, que la apunta antes de ejecutarla: la
  `focused` de la build 57 dejó una en el historial real.

| Ruta lógica | Contenido | Productor / consumidor |
|---|---|---|
| `USER_DATA_DIR = appData/<slug>` | Raíz persistente de la instalación del usuario | `paths.rs`, todos los módulos de configuración |
| `USER_DATA_DIR/settings.json` | Preferencias y ajustes guardados | `config/preferences.rs`, `settings_get/save/reset` |
| `USER_DATA_DIR/scripts/` | Biblioteca de scripts por defecto | `scripts/scan.rs`, `ScriptsPanel` |
| `USER_DATA_DIR/logs/main.log` | Arranque, PTY, errores y métricas | `infrastructure/logger.rs`, E2E |
| `USER_DATA_DIR/install-actions-cache.json` | Estado conocido por ID de acción | `packages/commands.rs` |
| `USER_DATA_DIR/install-actions-snapshot.json` | Catálogo entero (órdenes incluidas) con esquema, idioma y sello de la build que lo escribió | `packages/commands.rs`; se descarta si cambia el esquema, el idioma o la build (22-11) |
| `LEGACY_USER_DATA_DIR` | Datos antiguos bajo el nombre visible | `config/migration.rs` los migra al slug estable |
| `documents/<nombre de proyectos>` | Carpeta inicial de repositorios descargados | `projects/commands.rs`, ajustable por usuario |
| `temp/<slug>/<pid>/` | Archivos de inicialización, banner y ayuda de esta sesión | `terminal/session_files.rs`; cada proceso usa su PID |
| `release/` | Solo lo que se sube a GitHub: instalador, portable de un solo archivo, ZIP desempaquetado y `SHA256SUMS.txt` con sus firmas `.sig`/`.sshsig`; con validaciones pendientes, también `NO-PUBLICAR.txt` | `windows/build.ps1`; la build completa aparta lo demás a `src-tauri/target/dist/release-anterior/` |
| `src-tauri/target/dist/` | Carpeta desempaquetada (`WTerminal-<versión>`), salidas de las builds rápidas (`dev/`, `-dev`) y release anterior apartada | `windows/build.ps1`; ignorada por git |
| Directorio `E2E_CAPTURE_DIR` | Capturas, vídeo, segmentos nativos y frames de checkpoints | `tests/e2e/smoke.mjs` |
| `tests/e2e/fake-ai-tui.mjs` | Simulador de una IA de terminal (como `gh.cmd` para GitHub): caja del ancho que anuncia la PTY, spinner redibujado unas 20 veces por segundo con salida sincronizada, modo en línea o `--alt`, eco de lo escrito y respuesta; anota en `FAKE_AI_REPORT` las columnas y filas que vio. Lo usa el escenario `E2E_AI_TUI_ONLY`. |

La caché de detección acelera la primera pintura, pero `install_refresh`
ejecuta sondas reales y actualiza el estado. Un valor cacheado debe etiquetarse
como tal; que una acción figure en `install-actions-snapshot.json` no demuestra
que el programa siga instalado ni que la tarjeta haya sido vista en vídeo.
`install_refresh` solo se une a una precarga que siga en vuelo; si ya terminó,
detecta de nuevo.

WinGet falla al instante (sin salida) cuando se le lanzan varias consultas a la
vez, así que todas las de la app pasan por `process::winget_probe` /
`winget_run_env`, que las serializan y reintentan una vez ese fallo. El
inventario consulta primero `winget list` y solo si falla los orígenes
`winget`/`msstore`; lo que encuentra cada lista se suma, y la segunda no borra
lo que marcó la primera. Las comprobaciones de familia (`install_check`) reutilizan
durante 60 s las listas de WinGet y los inventarios de ecosistemas (pip, npm,
gem…) de la última pasada; instalar desde el panel o repetir la detección los
invalida. En la pasada completa, un inventario de ecosistema que agota su plazo
se repite una vez. El log registra `Inventario de WinGet`, `Inventario de
ecosistemas`, las acciones sin confirmar por origen (`Catalogo de acciones
preparado`, `Catálogo de Dependencias entregado`) y las familias lentas.

Las sondas `powershell:` del catálogo (AutoHotkey, MSYS2, GHCup, Clink,
PSReadLine, QEMU, VirtualBox, Hyper-V, Virtual Machine Platform y Windows
Sandbox) se resuelven en la pasada completa con **un único**
`powershell.exe` (`batch_powershell_probes`): cada sonda corre en su propio
bloque, su `exit 0`/`exit 1` se convierte en `return` y el proceso escribe
`__wterminal_probe_<n>=<código>`; un error dentro de una sonda cuenta como
`1`, igual que con la sonda suelta. Antes era un proceso por sonda y el mayor
gasto de CPU de la detección al arrancar. Solo se agrupan las sondas cuyo
`exit` es de primer nivel (`powershell_batchable`; un test exige que todas las
del catálogo lo cumplan); si el proceso único falla o agota sus 20 s, cada
sonda vuelve a su proceso individual. Las comprobaciones de familia, que traen
pocas acciones, siguen usando la sonda suelta. El log registra `Sondas de
PowerShell agrupadas` con el número de sondas, las resueltas y los ms.

AutoHotkey, Clink, QEMU, VirtualBox y MSYS2 se pueden instalar en cualquier
carpeta (`winget --location`, o la que se elija en su instalador) y entonces
no están en `Program Files` ni en el PATH. Sus sondas, sus órdenes de versión
y las acciones de MSYS2 (pacman, GCC, OCaml) buscan también la carpeta que el
instalador registró en «Aplicaciones instaladas»: las claves `Uninstall` de
HKLM, de su vista de 32 bits y de HKCU, con `InstallLocation` o, si falta, la
carpeta de `DisplayIcon` (macro `registered_install_dirs!` en
`packages/actions.rs`; las claves se leen una vez por proceso y en el proceso
único de sondas las comparten todas). Las pestañas de cmd aplican la misma
regla para encontrar `clink.bat` (`shell_assist::registered_install_dirs`).
Se comprobó en la VM con todo el catálogo instalado en `E:\`: sin esto, las
cinco herramientas salían como no instaladas.

### Inventario del frontend

| Archivo | Responsabilidad y conexiones |
|---|---|
| `src/main.ts` | Decide entre interfaz normal y preview; monta Svelte sobre `#app` e instala el filtro del menú del navegador. |
| `src/App.svelte` | Raíz y composición; registra una vez listeners PTY, colas de salida, atajos, avisos de actualización y carga inicial. Monta los paneles bajo demanda. `runAppAction` es el único manejador de las acciones de la aplicación (lo usan los atajos y la paleta de comandos); `runPaletteEntry` ejecuta cada entrada de la paleta con el manejador que ya tenía y `submitToActiveTerminal` teclea `clear` o un comando `:` en la pestaña activa por la ruta del teclado. |
| `src/PreviewApp.svelte` | Vista aislada para la comprobación de estilos sin arrancar Tauri. |
| `src/styles/app.css` | Layout global, superficies, paneles, scrollbar y variables de tema. |
| `src/components/Toolbar.svelte` | Selector de entorno y navegación principal. Nombra grupos y entornos con `environmentGroupLabel`/`environmentLabel` de `command-palette.ts`, igual que la paleta. |
| `src/components/TabBar.svelte` | Activación, creación, cierre y orden de pestañas. |
| `src/components/TerminalPane.svelte` | Crea xterm/FitAddon/SearchAddon, enruta entrada, mide y redimensiona rejilla, conserva scrollback, foco y cursor. La liberación del ancho horizontal usa `wideReleaseTimer`; el ajuste tardío usa `fitQuietTimer`, de modo que el segundo no cancele al primero tras una salida corta. Carga `@xterm/addon-web-links` y el `linkHandler` de los OSC 8 según `terminalLinks` (`syncTerminalLinks`), abre solo con Ctrl+clic, enseña la confirmación `terminal-link-dialog` y delega en `api.openTerminalLink`. Registra `openSearch` y `submitLineFromApp` en `terminalRegistry.ts` para la paleta de comandos: la línea se teclea con `term.input`, de modo que el interceptor de `:` (`runInternal` + `writeInternal`, que resincroniza su salida con ConPTY) o la shell la reciben como una orden escrita a mano. |
| `src/components/Panel.svelte` | Contenedor común de los paneles, cabecera y cierre. |
| `src/components/CommandPalette.svelte` | Paleta de comandos (`Ctrl+Shift+P`): diálogo modal con un `combobox` que controla un `listbox` agrupado (`role="group"` por sección) y anuncia la opción activa con `aria-activedescendant`, así el foco no sale del buscador. Flechas, RePág/AvPág, Intro y Escape (que no cierra el panel de detrás); Tab no escapa del diálogo. Pide el catálogo de LTools con una caché de 60 s (`LTOOLS_CACHE_MS`) y resuelve las fijadas con los helpers de `ltools-selection.ts`. Al cerrar devuelve el foco a donde estaba (cancelar) o a la terminal activa (ejecutar), salvo que la acción se lo haya llevado a un panel o al buscador. |
| `src/components/HistorySearch.svelte` | Búsqueda en las órdenes escritas (`Ctrl+Shift+R`): diálogo como la paleta (`combobox` + `listbox`) sobre `app.commandHistory`; Intro deja la orden escrita sin ejecutarla con `insertLine` y un rechazo (`draft`, `busy`) se enseña sin cerrar. |
| `src/components/FirstSteps.svelte` | La guía de primeros pasos (21-11): diálogo con los pasos de `first-steps.ts`, el resaltado del botón del que habla cada uno (`first-steps-highlight`), «Siguiente», «Atrás», «Saltar» y «Empezar»; terminarla o saltarla (también con Esc) apaga `showFirstSteps`. App la monta y esconde los avisos de abajo mientras se ve (`first-steps-active`). |
| `src/components/SettingsPanel.svelte` | Edita tema, terminal, atajos, idioma, integración, perfiles y plugins; guarda el borrador por `app.savePreferences`. |
| `src/components/SettingsResetDialog.svelte` | Diálogo de «Restablecer» (13-11): casillas por pestaña y por apartado, cada una con lo que hace y su riesgo; nada marcado de entrada, el foco en «Cancelar» y un resumen en rojo si se marca algo que borra cosas tuyas. Confirma con las preferencias de esos apartados. |
| `src/components/StorePanel.svelte` | Vista propia de la carpeta propia (panel `store`, se abre desde Ajustes con «Gestionar la carpeta propia…»): carpeta de cada categoría, interruptor por elemento, «Traer lo ya instalado» con progreso, confirmar y deshacer, y exportar o importar la lista con «Instalar» para lo que falte. |
| `src/components/DependenciesPanel.svelte` | Muestra secciones y acciones, combina catálogo con estado cacheado, consulta acciones pendientes y solicita refresco o ejecución. |
| `src/components/ProjectsPanel.svelte` | Busca repositorios, gestiona favoritos, releases y acciones de proyecto. |
| `src/components/GithubRepoManager.svelte` | «Gestionar…» de un repositorio de «Mi GitHub»: detalles, releases (crear con adjuntos, subir, publicar, borrar), git local (commit, ramas, push/pull en la terminal), pull requests, issues y Actions. |
| `src/components/GithubAdmin.svelte` | Las áreas de `gh_admin.rs` dentro de «Gestionar…» (Actions: más, Configuración, Seguridad, Comunidad y Cuenta): lista de cada área con sus acciones, formularios, borrar con dos pulsaciones y «Pedir permisos». |
| `src/components/ScriptsPanel.svelte` | Biblioteca de scripts, filtros, LTools, argumentos y ejecución opcional elevada. La selección, el nombre y la confirmación de las acciones de LTools salen de `ltools-selection.ts`, igual que en la paleta de comandos. La lista de tipos usa `bind:open` (`typesOpen`): con `open={…}` Svelte reescribía `open` en el mismo efecto que el contador del resumen y la lista se cerraba tras cada casilla. |
| `src/components/ExplorerSidebar.svelte` | Lista y manipula archivos; sigue el cwd del tab activo y descarta respuestas antiguas. |
| `src/components/AgentChats.svelte` | El panel lateral del chat con varios chats a la vez (14-11): las pestañas de chat (cada una con su agente y un punto que late si trabaja), «+» para otro chat en paralelo (hasta 6), «×» para cerrar uno (corta su pregunta) y el cierre del panel. Lleva el ancho (se arrastra por su borde, 300–900 px, se recuerda). Cada pestaña es un `AgentChat` entero, metido con `embedded`; el que no se ve sigue vivo con su pregunta en curso. |
| `src/components/AgentChat.svelte` | Un chat con los agentes de IA (`:chat`, paleta, atajo `shortcutToggleAgentChat`, botón ✦ de la fila de pestañas). Va dentro de `AgentChats.svelte`, uno por pestaña de chat (`embedded`: sin borde, ancho ni cierre propios; `active`: el que se ve; `onstatus`: le dice al contenedor si trabaja y con qué agente). Se ve a la derecha si `agentChatVisible` y `agentChat` están activos. **Cada pregunta:** va al backend con `agentChatAsk`, con el modelo, la intensidad, el modo de permisos y el modo rápido elegidos para ese agente (se recuerdan por agente; los modos que editan siguen `agentChatCanEdit` y «Omitir permisos», `agentChatAllowBypass`), los adjuntos de texto (`agentChatReadAttachment`, hasta 5), la conversación anterior si `agentChatRemember` y, si se marca, la última orden y su salida (`TerminalControls.lastCommandContext`); la monta `buildChatPrompt` y el mensaje enseña qué se mandó. **La respuesta:** llega a trozos (`agent-chat-data`/`agent-chat-done`), sin colores ANSI, con Markdown sencillo (títulos, listas, citas, negrita, cursiva y código, sin HTML) y los bloques de código con su lenguaje. **Qué permite:** «Insertar» escribe un bloque de una línea con `insertLine`, SIN Intro, y solo sobre un prompt vacío; «Copiar» lo copia; copiar la respuesta entera, repetir la pregunta, «Nueva conversación» y sugerencias para empezar. Nunca ejecuta nada. |
| `src/lib/api.ts` | Envoltorios tipados de todos los comandos y eventos; cola y época de entrada por pestaña; APIs de ventana, diálogos y portapapeles. |
| `src/lib/appState.svelte.ts` | `AppStore`: pestañas, paneles, inventario, preferencias y serialización de operaciones de ciclo de vida. |
| `src/lib/types.ts` | Tipos compartidos de respuestas IPC, acciones, preferencias, inventarios y eventos. |
| `src/lib/panels.svelte.ts` | Panel activo y navegación entre superficies. |
| `src/lib/terminalRegistry.ts` | Relación `tabId → Terminal` que usa el listener único de `App.svelte`, y `tabId → TerminalControls` (`openSearch`, `saveOutput`, `copyLastOutput`, `jumpToCommand`, `submitLine`, `insertLine`) que cada `TerminalPane` registra para la paleta de comandos y la búsqueda en las órdenes escritas. `submitLine` teclea con `term.input` (la ruta de `onData`, nunca escribe en xterm) y rechaza sin tocar nada si la shell no está lista (`not-ready`), hay un programa a pantalla completa o ningún prompt (`busy`) o la línea tiene texto sin enviar (`draft`). |
| `src/lib/command-palette.ts` | Registro y filtrado de la paleta, puro para probarlo en Node: `PALETTE_APP_ACTIONS` (acciones de `runAppAction` con su atajo y su comando `:` equivalente), `PALETTE_INTERNAL_COMMANDS` (los `:` que informan en la terminal), `buildPaletteEntries` (entradas a partir de preferencias, entornos, temas, fuentes, idiomas y acciones fijadas de LTools, con el motivo si están deshabilitadas), `filterPaletteEntries` (sin tildes, por palabras, comando y sinónimos; subsecuencia como último recurso; deshabilitadas detrás), `paletteResults` (ofrece una línea `:` nueva tal cual), `nextPaletteIndex`, `formatShortcut` y la traducción de grupos de entornos que comparte con `Toolbar.svelte`. |
| `src/lib/agent-chat.ts` | Lógica pura del chat de agentes: `splitAgentAnswer` (texto y bloques ```código```, también un bloque sin cerrar mientras llega) y `stripAnsi`. La prueba `scripts/test-frontend-logic.mjs`. |
| `src/lib/agent-chat-history.ts` | Lógica pura del historial de los chats (23-11): `newChatId`, el título automático (`autoTitle`), lo que se guarda de cada mensaje (`toStoredMessages`: una respuesta a medias queda como cortada; sin borradores de clave), la búsqueda sin tildes (`searchChats`), los grupos por fecha (`groupChatsByDate`) y la sesión limpia (`sanitizeSession`), cuándo se retoma la sesión propia de Claude Code o Codex (`canResumeNative`, `nativeAfterAnswer`, 24-11) y el chat de ayuda guardado más reciente (`latestHelpChat`). La prueba `scripts/test-frontend-logic.mjs`. |
| `src/lib/busy-tabs.ts` | Pestañas ocupadas (26-11), puro para probarlo en Node: `commandLabel` (el nombre de la orden para la pestaña), `classifyCommand` (registros, servidores, compilaciones, instalaciones o red), `chooseBusyColor` (regla propia, color del tipo o por turno, sin rojo), `isExcludedCommand` (editores, monitores y shells solo cambian el nombre), `busyDelayMs` (el tiempo según el bajo consumo) y `watchPanes` (las casillas de la vista de las que siguen en marcha). |
| `src/lib/command-marks.ts` | Marcas OSC 133, puro para probarlo en Node: `CommandTracker` (qué es una orden, cómo acabó y cuánto tardó; `appCommand` apunta la orden que escribe un botón, que la pestaña no ve teclear, y si no hay prompt libre la ata al siguiente, como mucho 15 s después), `outputRange`, `formatDuration` e `inferCmdExitCode` (en cmd, 9009 si la salida lleva el mensaje de Windows de orden que no existe). |
| `src/lib/command-history.ts` | Órdenes escritas, puro para probarlo en Node: `rememberCommand` (sin vacías, sin duplicados, sin pegados de varias líneas, hasta 1000) y `searchCommands` (palabras en cualquier orden, la más reciente primero). Solo recibe lo escrito sobre un prompt marcado con OSC 133. |
| `src/lib/terminal-columns.ts` | Cálculo de columnas de reserva, entrada y salida visible. |
| `src/lib/floating-tip.ts` | Posición de tarjetas flotantes (`position: fixed`) dentro de un panel: `placeFloatingTip` calcula en coordenadas de la ventana junto a la fila (debajo, o encima si no caben unos 170 px) y `fitFloatingTip` devuelve el desplazamiento que mete la tarjeta ya medida dentro del panel por los cuatro lados, sin bucle si es más grande que él. La usa la tarjeta de carpetas de Ajustes. |
| `src/lib/terminal-links.ts` | Enlaces de la salida: `TERMINAL_LINK_REGEX` (la expresión estricta de `@xterm/addon-web-links` ampliada a `file://`; las rutas sueltas no se detectan para no subrayar cada prompt), `isLinkActivation` (solo Ctrl + botón principal), `checkTerminalLink` (espejo de `validate_link` sin la parte del disco: esquemas `TERMINAL_LINK_SCHEMES`, longitud, caracteres ocultos, credenciales; devuelve la URL normalizada y el host que enseña la confirmación) y `linkRejectionMessageKey` (aviso por código de rechazo). |
| `src/lib/settings-search.ts` | Buscador de Ajustes: `foldSearchText` (sin mayúsculas ni tildes), `settingsSearchVisibility` (qué títulos de sección, encabezados, filas y notas se ven para una búsqueda) y `visibleSettingsRows` (el recuento). `SettingsPanel` recorre su formulario como bloques y solo esconde lo que esta función diga; también construye el índice de apartados y pone a cada fila su explicación como `title`. |
| `src/lib/notices.ts` | Los avisos que la app saca por su cuenta (`NOTICE_SETTINGS`, 17-11): cada uno con el ajuste que apaga su «No volver a mostrar» y dónde está su única casilla en Ajustes (`section`, `target`), para que Ajustes › Avisos lleve a ella, y `restoreAllNotices`, que los vuelve a encender todos y olvida lo dejado «para luego» (`DISMISSED_UPDATE_KEY`, `DISMISSED_PACKAGE_UPDATE_KEY`). |
| `src/lib/first-steps.ts` | Los pasos de la guía de primeros pasos (`FIRST_STEPS`, con el selector del botón que resalta cada uno), `shouldAutoShowFirstSteps` (sale sola hasta apagarla, nunca en E2E) y `openFirstSteps`, que la abre desde Ajustes o la paleta. |
| `src/lib/profile-update.ts` | El aviso de guardar en el perfil los ajustes cambiados (21-11): `preferencesFingerprint` (huella sin lo que la app escribe sola), `latestProfile` y `shouldOfferProfileUpdate`. App compara la huella al abrir y al cerrar Ajustes. |
| `src/lib/settings-reset.ts` | Reparto de las preferencias en los apartados de «Restablecer» (`RESET_GROUPS`, con su riesgo: `safe`, `caution` o `danger`), `keysForGroups`, `dangerousGroups` y `tabState`. Puro: una prueba exige que cada preferencia de fábrica esté en exactamente un apartado. |
| `src/lib/input-selection.ts` | Cortar o borrar una selección de la línea que se escribe: `promptInputStart` (dónde acaba el prompt), `columnAtTextIndex`/`contentEndColumn` (texto a celdas, caracteres anchos), `inputSelectionEdit` (flechas hasta el final de la selección y un DEL por carácter, solo dentro de lo escrito o tocando el cursor) y `selectionSearchText` (texto para «Buscar» del menú). |
| `src/lib/browser-context-menu.ts` | Quita el menú del clic derecho del navegador interno («Atrás», «Actualizar», «Imprimir») donde la app no pone uno suyo; lo deja en campos de texto y sobre texto seleccionado (`keepsBrowserContextMenu`, `installBrowserContextMenuFilter`). |
| `src/lib/banner-image.ts` | Imagen a la izquierda del banner: `findBannerBlocks` reconoce cada banner por su título tras un margen de 10 a 42 espacios, el que dejó el backend al imprimirlo (`bannerImagePadding`, `BANNER_IMAGE_GAP` igual que en Rust) y `attachBannerImages` coloca una decoración de xterm anclada a ese título (encima del margen y centrada en él con el mismo hueco a cada lado, `bannerImageBox`, y también debajo, `bannerImageHeight`, para que un prompt pegado al banner no toque la imagen; sin pasar por ConPTY), la retira si el texto cambia y sigue a la configuración y a la imagen elegida. |
| `src/lib/link-cache.ts` | `invalidateLinkCache`: xterm guarda por fila los enlaces bajo el ratón y no los vuelve a pedir mientras el ratón siga en esa fila; tras cada escritura se olvida esa fila para que un enlace (URL u OSC 8) escrito bajo el ratón se detecte y abra con Ctrl+clic. Toca dos campos internos del `Linkifier`; `test:frontend-logic` comprueba que la versión de xterm los mantiene. |
| `src/lib/full-screen-app.ts` | Modo pantalla completa de una pestaña: `fullScreenTransition` decide, a partir de los DECSET/DECRST que pasan por xterm, cuándo un programa usa la pantalla alternativa (`?1049`: Amp, OpenCode, vim) o la salida sincronizada en línea (`?2026`: Ink, es decir Claude Code o Gemini) y cuándo termina; las pestañas `ai:*` lo están siempre. En ese modo `TerminalPane` da a la PTY el ancho visible exacto (`pty_resize` con `exact`) en vez de la reserva de 1024 columnas de las shells, que hacía dibujar a esas IA fuera de la vista. En Windows también el REPL de Python (`environmentFullScreenReason`: la pestaña `lang:python` es `python-environment`; `isInteractivePythonCommandLine`: `python` o `py` sin script tecleado en el prompt de una shell es `python-command`, que termina al volver el prompt como `ai-command`), salvo que se apague `pythonReplVisibleWidth`; ver [Problemas conocidos](#problemas-conocidos). El backend deja que esos entornos hereden el ancho exacto al sustituir a otro (`tabs.rs` `keeps_exact_width`). |
| `src/lib/sixel-conpty.ts` | Imágenes Sixel alineadas con ConPTY: ConPTY las mide como un VT340 (celda virtual de 10×20 y píxel 2:1 salvo atributos de trama) y baja `floor(alto·aspecto/20)` filas; antes de que `@xterm/addon-image` coloque la imagen se encaja, sin deformarla, en esa caja de celdas para que el cursor de xterm acabe en la misma fila. Solo en Windows. |
| `src/lib/terminal-prompt.ts` | Reconocimiento de prompt y señales de disponibilidad de REPL. |
| `src/lib/terminal-ready.ts` | Reintento acotado del handshake de disponibilidad. |
| `src/lib/terminal-render.ts` | Planificación y refresco final del renderer xterm. |
| `src/lib/terminal-scroll.ts` | Normalización de delta de rueda y desplazamiento. |
| `src/lib/shortcuts.ts` | Normalización, comparación y defaults de atajos, incluido `shortcutCommandPalette` (`Ctrl+Shift+P`). |
| `src/lib/keyed-serial-queue.ts` | Cola serial por clave para operaciones concurrentes. |
| `src/lib/theme.ts` | Conversión de preferencias a tema, fuente y cursor xterm. `effectivePalette` (base neutra de «Cian técnico» salvo `themeRecolorAll`, mismas reglas que `effective_palette` en Rust), `themePreferencePatch` (lo que cambia elegir un tema, en Ajustes y en `:theme`), los 16 colores ANSI (`ANSI_COLOR_KEYS`, `DEFAULT_ANSI_COLORS`) y la fuente escrita a mano delante de la familia. |
| `src/lib/localization.ts` | Comparación y búsqueda localizada; texto de marca por plataforma. |
| `src/lib/ltools-selection.ts` | Reconciliación de selección de acciones LTools guardada, y lo que comparten la Biblioteca y la paleta de comandos: clave de almacenamiento por sistema (`ltoolsSelectionStorageKey`), acciones fijadas en su orden (`pinnedLToolsActions`), nombre desambiguado (`ltoolsActionLabel`, `ltoolsActionMeta`) y si piden confirmación (`ltoolsActionNeedsConfirmation`). |
| `src/lib/performance.ts` | Marcas de tiempo y métricas `frontend.performance`. |

### Inventario del backend Rust

#### Entrada, configuración y plataforma

| Archivo | Responsabilidad y conexiones |
|---|---|
| `src-tauri/src/main.rs` | Llama a `lib::run()`. |
| `src-tauri/src/lib.rs` | Migra datos, prepara PATH/estado, construye Tauri, registra IPC y crea la primera pestaña en `setup`. Antes de todo instala un runtime asíncrono propio (`install_async_runtime`, `async_worker_threads`: 4 hilos por núcleo, entre 16 y 64): Tauri ejecuta los comandos síncronos `#[tauri::command(async)]` dentro de esos hilos, y con los de fábrica (uno por núcleo) ocho comandos esperando dejaban la app sin atender ningún otro comando asíncrono, guardar las preferencias incluido. |
| `src-tauri/src/app/mod.rs` | Declara módulos de aplicación. |
| `src-tauri/src/app/state.rs` | `AppState`, `TabManager`, inventario de entornos y caché de catálogo; arranca detección completa en segundo plano. |
| `src-tauri/src/app/commands.rs` | IPC de pestañas, PTY, entorno, ajustes, perfil, información y telemetría. |
| `src-tauri/src/app/panel_commands.rs` | IPC de Biblioteca y Explorador; valida rutas visibles y escribe comandos en la pestaña. |
| `src-tauri/src/config/mod.rs` | Reexporta módulos de configuración. |
| `src-tauri/src/config/identity.rs` | Nombre WTerminal/LTerminal y metadatos por plataforma. |
| `src-tauri/src/config/paths.rs` | Directorios de datos, caché, logs y perfiles. |
| `src-tauri/src/config/settings.rs` | Lectura/escritura de configuración de aplicación. |
| `src-tauri/src/config/preferences.rs` | Esquema, defaults, validación y persistencia de preferencias. Temas: `effective_palette` y `NEUTRAL_THEME_ID`, temas propios (`CustomTheme`, como mucho 24, ids `custom-…`), paleta ANSI de 16 colores y fuente propia validada; aspecto de las sugerencias (`shellAssistSuggestionColor`…`shellAssistListView`). Atajos: `safe_shortcut` normaliza cada `shortcut*`, conserva `""` como «sin asignar» y devuelve el de fábrica si falta o no es un atajo válido. |
| `src-tauri/src/config/migration.rs` | Traslada datos de ubicaciones anteriores al slug estable. |
| `src-tauri/src/config/install_dir.rs` | Determina ubicación instalada y portable. |
| `src-tauri/src/config/single_file.rs` | Portable de un solo `.exe`: lee los archivos añadidos tras la imagen PE (respetando una firma Authenticode posterior), coloca `conpty.dll`/`OpenConsole.exe` en `%LOCALAPPDATA%\WTerminal\runtime\<huella>` verificados por SHA-256, saca el instalador de WebView2 (solo lo lleva la variante Offline) si falta el runtime y valida el `-Portable.exe` que descarga el actualizador. |
| `src-tauri/src/config/i18n.rs` | Catálogos y traductor backend. |
| `src-tauri/src/config/plugins.rs` | Inventario y operaciones del sistema de plugins. |
| `src-tauri/src/config/regenerable.rs` | Limpieza de lo que se puede volver a generar (24-11): cachés de la carpeta propia (`clearable_cache_paths`), descargas del panel (`clearable_category_dir`, solo si la carpeta no es peligrosa), caché de detección y copia rotada del registro. **`regenerable_sizes`** y **`regenerable_clean`** (en `spawn_blocking`) y **`auto_clean_if_due`**, que con `regenerableAutoClean` limpia al arrancar cada `regenerableAutoCleanDays` días (apunta la última vez en `regenerable-last-clean.txt`). |
| `src-tauri/src/config/toolchain_store.rs` | Carpeta propia (`%LOCALAPPDATA%\WTerminal\entornos`) por categorías (`Category`: cachés, descargas del panel, modelos de IA, herramientas nuevas, historial de los REPL; `Categories::from_preferences`): variables estándar inyectadas solo en procesos de WTerminal (`overrides_for`), carpetas `bin` de las herramientas nuevas delante del PATH de WTerminal (`extra_path_dirs` → `process::set_extra_path`, que aplican `child_environment`, `hidden_command` y `path_env::which`), `OLLAMA_MODELS` solo si no había modelos, tamaños y vaciado (solo la categoría de cachés); las ubicaciones de siempre de las categorías apagadas se miden con `cached_system_size` y se reutilizan 10 min, las propias se miden siempre. Además mide y explica cada ubicación: `app_locations` (ajustes, scripts, plugins, registros, caché de detección, datos del WebView, temporales de sesión, proyectos, runtime del portable, perfil de Clink) y `external_locations` (Cargo, rustup, Go, Bun, Ollama, cachés de npm/pip/pnpm/Yarn/uv/Deno, WinGet, Docker, Chocolatey, Scoop y el disco de cada distro WSL leído de `HKCU\…\Lxss`). Cada una lleva `LocationInfo` (para qué sirve, si se puede borrar y `Safety`: `safe`/`regenerates`/`caution`/`keep`), que Ajustes enseña en una tarjeta al pasar el ratón. |
| `src-tauri/src/config/programs.rs` | Pestaña Programas (22-11): cmd (`PROMPT`, `Command Processor`), PowerShell 5 y 7 (bloque «WTerminal» en `profile.ps1`) y Git (`git config --global`); `programs_list`/`programs_set`/`programs_undo`, validación de cada valor y deshacer en `programas/deshacer.json`. |
| `src-tauri/src/config/programs_more.rs` | Más programas de esa pestaña: Git Bash (`.bashrc`/`.inputrc`), npm, pip, WinGet (`settings.json` con copia), Python y Node (variables de usuario), Claude Code (`settings.json`) y Codex (`config.toml`), cada uno solo con sus claves. |
| `src/components/ProgramsSettings.svelte` | La pestaña Programas de Ajustes: una tarjeta por programa instalado, el control de cada ajuste, «Deshacer el último cambio» y los no instalados. |
| `src-tauri/src/config/store_adopt.rs` | «Traer lo ya instalado» a la carpeta propia: vista previa con el espacio de cada cosa, copia sin tocar el original (`copy_tree` + `verify_copy`), diario en `store-journal.json` para confirmar (borra el original) o deshacer, programas con unión y el original en `<carpeta>.wterminal-antes` (los MSI se bloquean: sus actualizaciones fallan en una unión), perfil de Clink propio, y exportar o importar la lista (`wterminal-store-v1`: ajustes de la carpeta propia y acciones «Instalar» ya hechas). |
| `src-tauri/src/platform/mod.rs` | Selección de implementación de host por sistema. |
| `src-tauri/src/platform/traits.rs` | Contratos de operaciones dependientes de plataforma. |
| `src-tauri/src/platform/system_info.rs` | Datos de sistema y hardware para banner e información. `build_banner`/`build_banner_with` componen el banner; con la imagen activada lo hacen en lo que queda tras el margen de `banner_image_padding` y desplazan cada línea con espacios. |
| `src-tauri/src/terminal/banner_image.rs` | Imagen propia del banner: `banner_image_read` la valida por su firma (`image_mime`: PNG, JPEG, GIF, WebP, BMP, ICO, SVG con `<svg`) y tamaño (`MAX_BANNER_IMAGE_BYTES`, 8 MB) y la devuelve como `data:`. |
| `src-tauri/src/platform/recycle.rs` | Envío a papelera del sistema. |
| `src-tauri/src/platform/desktop_entry.rs` | Linux (17-11): «Abrir con LTerminal» en el gestor de archivos, una entrada de escritorio del usuario con `MimeType=inode/directory` en `~/.local/share/applications` que lanza la AppImage (`APPIMAGE`). IPC `desktop_integration_status/set`. Compila en todas las plataformas para que las pruebas de Windows revisen el texto de la entrada. |
| `src-tauri/src/platform/first_run.rs` | Une el instalador modular con la app: aplica una vez por usuario lo elegido en la página de componentes (`first-run.json`: PATH y menú del Explorador con `wterminal://`) y escribe para el desinstalador el informe `--wterminal-uninstall-report` (INI en UTF-16 con lo que ocupan los datos y la carpeta propia, y si esta es de WTerminal). |
| `src-tauri/src/platform/path_integration.rs` | Integración del ejecutable en PATH (HKCU). Ajustes bloquea la casilla mientras se aplica: dos escrituras cruzadas dejaban entradas sueltas. El E2E guarda y repone una copia exacta de `HKCU\Environment\Path` y `HKCU\Software\WTerminal\PathIntegration`, porque el perfil aislado no cubre el registro. |
| `src-tauri/src/platform/windows_integration.rs` | Estado y activación de integración Windows (menús, App Paths, `wterminal://`) y de los permisos de administrador: `WindowsIntegrationStatus` lleva `elevated`, `nsudoLauncher`, `gsudoPath` y `windowsSudo`; `StartElevation::should_relaunch` decide «Iniciar siempre como administrador»; `relaunch_elevated` y el IPC `app_restart_as_admin` relanzan con `--elevated-relaunch`; `relaunch_unelevated` y el IPC `app_restart_unelevated` vuelven sin permisos (con `unelevated_restart_blocker` como guarda). |
| `src-tauri/src/platform/windows/mod.rs` | Adaptador Windows. |
| `src-tauri/src/platform/windows/webview2.rs` | Preflight de WebView2 antes de la ventana: instalador local, embebido (variante Offline) o descargado de Microsoft, siempre tras comprobar con `WinVerifyTrust` que lo firma Microsoft; diálogo nativo (`TaskDialogIndirect`) si nada funciona; `--install-webview2 [ruta]`. Ver [WebView2: si falta el runtime](#8-webview2-si-falta-el-runtime). |
| `src-tauri/src/platform/windows/path.rs` | Rutas y localización de herramientas en Windows. |
| `src-tauri/src/platform/windows/elevation.rs` | Token efectivo (`is_process_elevated`), modo del sudo de Windows leído del registro (`WindowsSudo`), ruta de gsudo, citado de argumentos con las reglas de `CommandLineToArgvW` y `run_elevated` (ShellExecuteW «runas»; el código 5 es el UAC cancelado). |
| `src-tauri/src/platform/linux/mod.rs` | Adaptador Linux. |
| `src-tauri/src/platform/linux/path.rs` | Rutas y herramientas en Linux. |
| `src-tauri/src/infrastructure/mod.rs` | Módulos de infraestructura compartida. |
| `src-tauri/src/infrastructure/logger.rs` | Eventos y métricas estructurados en `main.log`. |
| `src-tauri/src/infrastructure/process.rs` | Lanzamiento, captura y timeout de procesos externos. `run_with_timeout_env` vacía stdout/stderr en hilos aparte (`drain_in_background`) mientras espera: leer solo al terminar bloqueaba a cualquier hijo cuya salida no cabía en la tubería (catálogo de WTools, listados largos) hasta el timeout. Tras salir el proceso espera la salida como mucho lo que queda de plazo, para que un nieto con la tubería heredada no la cuelgue. `hidden_command` y las pestañas dan a Windows PowerShell 5.1 un `PSModulePath` depurado (`is_windows_powershell`, `windows_powershell_module_path`): sin las carpetas de PowerShell 7 heredadas y con la de usuario de 5.1 delante. |
| `src-tauri/src/infrastructure/path_env.rs` | PATH combinado y refresco desde el sistema. `is_tool_installed` descarta los lanzadores `.bat`/`.cmd` sencillos cuyo intérprete ya no existe (p. ej. los de RubyGems tras desinstalar Ruby). `which` busca además fuera del PATH las herramientas que se instalan sin tocarlo (`known_install_location`): Claude Code en `~/.local/bin`, npm o la CLI de la app de escritorio (`%APPDATA%\Claude\claude-code\<versión>\<hash>\claude.exe`, gana la versión más alta). |
| `src-tauri/src/system/mod.rs` | Reexporta información y virtualización. |
| `src-tauri/src/system/virtualization.rs` | Sondas de capacidades de virtualización. |

#### Terminal y entornos

| Archivo | Responsabilidad y conexiones |
|---|---|
| `src-tauri/src/terminal/mod.rs` | Declara los submódulos de terminal. |
| `src-tauri/src/terminal/tabs.rs` | `TabManager`: ciclo de vida, generación de sesión, orden de eventos, comandos pendientes, banner y resize. `write_command_shown` escribe la orden de un panel y, antes, avisa a la pestaña con `pty-command-written` y la orden de verdad (sin el marco), para que cuente como orden. |
| `src-tauri/src/terminal/pty.rs` | Crea `portable-pty`, reader/waiter, fallback de pipes y tamaño físico. **Orden de la salida y el fin:** el hilo que espera al proceso no avisa del fin hasta que el lector ha entregado todo lo leído y la salida lleva 100 ms callada (como mucho 1,5 s; `OutputActivity::wait_drained`). En ConPTY las últimas líneas llegan después de que el proceso sale: sin esto, «Proceso finalizado» podía salir encima del último mensaje y la pestaña de una IA no veía que pedía su clave (larga 60). |
| `src-tauri/src/terminal/stream.rs` | Decodificación UTF-8 incremental, separación de clear y eventos PTY. |
| `src-tauri/src/terminal/semantic_zones.rs` | Separa marcadores semánticos de acciones/progreso de los bytes visibles. |
| `src-tauri/src/terminal/aliases.rs` | Alias de shell configurados y de scripts. En Windows, `ls`/`ll` entienden opciones de Unix: en cmd con `wt-ls.cmd` (`CMD_LS_SCRIPT`, `CMD_LS_HELPER`), en PowerShell con la función `POWERSHELL_LS_BODY`, tras quitar el alias integrado `ls` (`POWERSHELL_FREE_LS_ALIAS`), que si no ganaba a la función. |
| `src-tauri/src/terminal/cmd_failure.rs` | Órdenes fallidas en cmd, que no da código en su marca `D`: `cmd_not_found_text` lee una vez de `cmd.exe` (como datos, `FormatMessageW`) el mensaje 9009, «… no se reconoce como un comando interno o externo» en el idioma de Windows, y devuelve su parte fija. El frontend la busca en la salida (`inferCmdExitCode` de `command-marks.ts`). |
| `src-tauri/src/terminal/console_ui.rs` | Texto, cabeceras y avisos de acciones imprimibles en terminal. En cmd cada acción es una sola línea (`cmd_framed`/`cmd_one_line`): la cabecera y el cierre se escriben en `ui-N-ini.cmd`/`ui-N-fin.cmd` de la carpeta de sesión (`CMD_FRAME_DIR_VAR` = `WSTERM_UI`, que `terminal/pty.rs` pone en cada pestaña) y se llaman con `call` alrededor de la orden real. **Código de salida:** el cierre lo guarda en `WSTERM_RC` antes que nada, decide bien o mal con «distinto de 0» (con `if errorlevel 1` los códigos negativos de winget pasaban por buenos), escribe la marca `D` con ese código (el prompt de cmd no puede) y lo deja en `ERRORLEVEL` con `exit /b`. En PowerShell y en bash, zsh, sh y fish la acción va entera en `ui-N.ps1`, `ui-N.sh` o `ui-N.fish` (`ps_framed`, `sh_framed`) y solo se teclea su carga, con la ruta traducida para WSL o Git Bash (`path_in_shell`); en Docker, ADB o Wine va encadenada (`uses_session_files`). En PowerShell el marco lo deja en `$global:wtActionCode`, que el prompt con marcas lee una vez; en bash, zsh y sh termina con `(exit $__wsterm_rc)`. Así una acción que falla se pinta en rojo y despierta al consejero. |
| `src-tauri/src/terminal/internal_commands.rs` | Analiza comandos internos de la aplicación. |
| `src-tauri/src/terminal/links.rs` | Enlaces de la salida (Ctrl+clic). IPC `terminal_open_link`: comprueba que `terminalLinks` sigue activo y vuelve a validar el texto con `validate_link` (`ALLOWED_SCHEMES` = `http`, `https`, `file`; hasta `MAX_LINK_LENGTH` = 2048 caracteres; rechaza controles, espacios y marcas invisibles como los controles bidireccionales, credenciales `usuario:contraseña@`, `file://` de otro equipo, rutas UNC y rutas que no existen). Las URL salen normalizadas por `tauri::Url` (dominios internacionales en punycode) y se abren con el opener de Tauri; una carpeta `file:` se abre con `platform::open_directory` y un archivo solo se muestra seleccionado en su carpeta (`reveal_item_in_dir`), nunca se ejecuta. El log guarda la acción y el host, nunca la URL entera. Con `LTERMINAL_E2E_TESTING=1` no abre nada y añade `{url, action}` a `LTERMINAL_E2E_OPENED_LINKS`. |
| `src-tauri/src/terminal/current_dir.rs` | Extrae cwd de OSC 7 y prompts de respaldo. |
| `src-tauri/src/terminal/powershell.rs` | Adaptación de comandos a PowerShell. |
| `src-tauri/src/terminal/session_files.rs` | Archivos temporales de inicialización, ayuda y banner, y el `wt-ls.cmd` de las pestañas de cmd (se reescribe solo si cambió). |
| `src-tauri/src/terminal/shell_assist.rs` | Sugerencias del historial y colores en la línea de órdenes con la herramienta de cada shell: inyecta Clink en cmd con un perfil propio (`default_settings` con sugerencias en línea y colores; las pestañas arrancan con `/d` y no pasan por su AutoRun), activa las predicciones de PSReadLine si nadie las configuró y carga ble.sh o los plugins de zsh si existen. `UNIX_PLUGINS` es la única tabla de rutas y marcadores de ble.sh y los plugins de zsh: de ella salen la línea de bash/zsh, la detección del catálogo en Linux (`packages::commands`, por marcador) y el fragmento que imprime el marcador en la sonda de WSL. Preferencias `shellAssist` y, por shell, `shellAssistCmd`/`shellAssistPowershell`/`shellAssistBash`/`shellAssistZsh`. `AssistStyle` traduce el aspecto elegido en Ajustes a cada herramienta (`clink_default_settings`, `psreadline_style_lines`, `blesh_style_commands`, `zsh_highlight_styles`); sin cambios produce exactamente los valores de fábrica. IPC `shell_assist_status` (estado por shell para Ajustes; con `refresh` hace el inventario detallado de WSL). En E2E se desactiva con `LTERMINAL_E2E_DISABLE_SHELL_ASSIST` salvo en `E2E_SHELL_ASSIST_ONLY`, que además elige en Ajustes un color de sugerencia (#ff00ff) y exige verlo en PSReadLine, Clink y ble.sh, y `LTERMINAL_E2E_BLESH_PATH` (solo con `LTERMINAL_E2E_TESTING=1`, ruta absoluta sin caracteres de shell) carga un ble.sh instalado en el `/tmp` de la distro de pruebas. En E2E el perfil de Clink lleva además `clink.autoupdate = off` (`with_e2e_clink_settings`): sin él, Clink pintaba al arrancar «Clink vX is available» y ensuciaba capturas y medidas; al usuario no se le cambia. |
| `src-tauri/src/terminal/shell_paths.rs` | Ubicación de ejecutables de shells. |
| `src-tauri/src/terminal/spawn_cwd.rs` | Selección segura del cwd de una sesión nueva. |
| `src-tauri/src/environments/ai_cli_defaults.rs` | (Llegan también a lo que lanza el chat: `hidden_command` añade el entorno base desde el 13-11.) Valores por defecto de sistema para Gemini CLI y Qwen Code (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, `QWEN_CODE_SYSTEM_DEFAULTS_PATH`, `general.enableAutoUpdate: false`): sin ellos, al arrancar lanzaban `npm install -g` en una consola aparte que Windows abría en otra ventana o pestaña de Windows Terminal. Siguen avisando de la versión nueva; los ajustes del usuario y sus variables mandan (`process::set_base_environment`). |
| `src-tauri/src/environments/mod.rs` | Modelo `Environment`/inventario; detección rápida y completa; selección por defecto. **Lanzadores de pip** (`broken_python_launchers`): IPython, Jupyter y cualquier REPL o IA cuyo `.exe` esté en una carpeta `Scripts` (aider, llm, ShellGPT) solo se ofrecen si `--version` arranca; sin `PYTHONUSERBASE` su `.exe` sigue en el PATH pero Python no encuentra el módulo y la pestaña se cerraba al abrirse. |
| `src-tauri/src/environments/wsl.rs` | Estado de WSL y distribuciones: sonda rápida (`printenv SHELL`, 15 s y un reintento para la VM en frío) y, al abrir Dependencias, inventario detallado con `LISTING_SCRIPT` (sin un `basename` por archivo ni el PATH de Windows en `/mnt/<unidad>`) más los marcadores de `shell_assist::plugin_probe_script`. Todo con `wsl.exe --exec`: con `--` la login shell de la distro expande `$1`/`$HOME` antes que `sh` y el inventario salía con error. Comprueba que cada intérprete ELF se ejecuta (`runnable_probe_script`, marca `wterminal-unrunnable:`; los que dan 126 van a `unrunnable`) y lanza los REPL con `repl_launch_args` (shell de login + `USER_BIN_DIRS`, las mismas carpetas que recorre la sonda). `cached_installed` devuelve la última detección sin arrancar nada. |
| `src-tauri/src/environments/docker.rs` | Contenedores y disponibilidad de Docker. |
| `src-tauri/src/environments/android.rs` | Dispositivos y transporte ADB. |
| `src-tauri/src/environments/languages.rs` | REPL y herramientas de lenguajes. Los de WSL (`detect_wsl_language_environments`) se lanzan con `wsl::repl_launch_args` y solo con las herramientas que se pueden ejecutar (`InstalledDistro::runnable_tools`). |
| `src-tauri/src/environments/ai.rs` | Entornos de IA: CLIs de asistentes detectadas en el PATH (y Claude Code fuera de él, ver `path_env`), con `cli_args` para abrir en modo chat las que lo necesitan (`llm chat`, `sgpt --repl temp`), y un chat por cada modelo local de Ollama leído de sus manifiestos (sin arrancar `ollama list`); catálogo curado de modelos con tamaños y cálculo de memoria frente a la RAM del equipo; sonda `ollama-model:` del panel. |
| `src-tauri/src/app/agent_control.rs` | `wterminal --ctl <orden>` (14-11): las IA que lanza WTerminal lo manejan. **`start`:** servidor en 127.0.0.1 con una llave aleatoria por arranque, solo con `agentControl`. **`spawn_env`:** `WTERMINAL_CTL`, `WTERMINAL_CTL_TOKEN` y `WTERMINAL_TAB_ID` para los procesos de las IA (pestañas `ai:*` en `tabs.rs`, preguntas del chat en `agent_chat.rs`). **`classify`:** orden interna, búsqueda (`acciones`, contestada con `packages::commands::search_actions`) o acción (`accion <id>`); `:set` que cambia y las acciones piden permiso; `BLOCKED_SETTINGS` nunca. Lo demás lo hace el frontend (evento `agent-control`, respuesta con `agent_control_reply`). **`run_cli`:** el lado de la IA, atendido en `run` antes de abrir ventana. |
| `src-tauri/src/environments/agent_guide.rs` | La guía de WTerminal para los agentes de IA (14-11), solo en el código: los principios («primero WTerminal», con su porqué), cómo proponer desde el chat, la tabla de tareas y los límites, más la ayuda interna entera (`build_help_topic_text`) y cada ajuste con su explicación (`default_settings.toml`). **`chat_preamble`:** el resumen oculto que va delante de cada pregunta del chat (`agentChatGuide`). **`guide`:** la guía entera o un tema, para `wterminal --agent-guide [tema]` (`AGENT_GUIDE_ARG`, que `run` atiende antes de abrir ventana). **`tab_args`:** la guía al abrir la pestaña de una IA (`agentTabGuide`): `--append-system-prompt` en Claude Code, `developer_instructions` en Codex, `-i` en Gemini y Qwen. |
| `src-tauri/src/environments/agent_chat.rs` | Backend del chat lateral con los agentes. **Sesiones propias (24-11):** `with_native_session` añade a Claude Code `--session-id`/`--resume` y pasa Codex a `exec resume <id> -` (con `-c sandbox_mode`, porque ahí no hay `-s`); el id solo vale si es un UUID (`valid_session_id`), la sesión que abre Codex se lee de su cabecera (`reported_session`, en `agent-chat-status`) y una sesión perdida acaba en `session-missing` (`session_missing`) para que el panel repita con la conversación entera. **`agent_chat_agents`:** los agentes instalados con modo de una pregunta (`ONE_SHOT`): `claude -p`, `codex exec -`, `gemini`, `qwen`, `copilot -p` (lanzado con node, sin cmd), `crush run`, `llm`, `sgpt`, `mods`, `aichat` y `ollama run <modelo>`, con la opción de modelo de cada uno, sus modelos sugeridos, sus niveles de intensidad, sus modos de permisos (`Mode`) y si tiene modo rápido (`Fast`). Los demás salen con su motivo (`unavailable_reason`): Amp no tiene modo de una pregunta y aider edita archivos. **`one_shot_args_with`:** añade el modelo (`valid_model`: letras, números y `. _ : / @ -`, hasta 80), la intensidad (Claude `--effort`, también `ultracode`; Codex `-c model_reasoning_effort=`), el modo (el de fábrica solo lee; los que editan piden `agentChatCanEdit` y «Omitir permisos», además `agentChatAllowBypass`, con `Allowed`) y el modo rápido (Claude `--settings` con un archivo, Codex `-c service_tier=fast`); lo que ese agente no admite o no está permitido se rechaza, no se ignora. **`agent_chat_models`:** el modelo de fábrica de su configuración y la lista de cada agente (el catálogo de Codex con su intensidad y su «Fast» por modelo, los nombres del paquete de Gemini y Qwen…), sin preguntar nada a la IA. **`agent_chat_read_attachment`:** lee un adjunto de texto (como mucho 5 MB; se mandan los primeros 100 KB, cortados sin partir un carácter; uno binario se rechaza). **`agent_chat_ask`:** abre la CLI una vez, en la carpeta de la pestaña activa, con su clave de `ai_keys` si la hay; la pregunta va por la **entrada estándar** y nunca como argumento (ni cmd ni un `.cmd` la interpretan). Emite `agent-chat-data`/`agent-chat-done`, corta a los 5 min (30 con Ultracode, `answer_timeout`), y el log apunta el agente, el largo, el modelo, la intensidad, el modo y el modo rápido, no el texto. **`agent_chat_cancel`:** mata el árbol (`taskkill /T`). Se apaga con `agentChat`. |
| `src-tauri/src/environments/agent_chat_history.rs` | Historial de los chats (23-11). Un archivo por conversación en `agent-chats/<id>.json` dentro de la carpeta de datos, y `agent-chats/session.json` con los chats abiertos y el activo. **`agent_chat_history_list`/`load`/`save`/`delete`/`clear`** y **`agent_chat_session_load`/`save`**: el id hace de nombre de archivo (`valid_chat_id`: letras, números y guiones), un chat no pasa de 4 MB, se escribe en un temporal y se renombra, y al pasar de 300 chats se borran los más antiguos que no estén abiertos (`prune_in`). Cada resumen dice si es el chat de ayuda (`help`) y si está fijado (`pinned`, de `agent-chats/pins.json`, aparte del chat para que fijar no choque con su guardado). **24-11:** `agent_chat_history_pin` (`help` = el chat de ayuda más reciente), `cleanup_older_in` con `agentChatCleanup` (salvo abiertos y fijados), `agent_chat_export` (solo `.md`) y `agent_chat_native_forget`, que borra la sesión de Claude Code (`~/.claude/projects/*/<uuid>.jsonl`) o de Codex (`~/.codex/sessions/**/rollout-…-<uuid>.jsonl`) solo si es un UUID. Lo usa `AgentChats.svelte` con `agentChatHistory` y `agentChatRestore`. |
| `src-tauri/src/environments/ai_keys.rs` | Clave de API de las IA que leen su clave de una variable de entorno: Grok (`GROK_API_KEY`), Codex, mods, ShellGPT, llm y aider (`OPENAI_API_KEY`), Gemini (`GEMINI_API_KEY`) y Claude Code (`ANTHROPIC_API_KEY`). **Cuándo se ofrece:** si la pestaña de una de ellas acaba con un código distinto de 0 y lo último que dijo nombra su variable o una «API key», `ai_key_offer` pide al frontend que ofrezca meterla (`data-testid="ai-key-offer"`). **Cómo se guarda:** `ai_key_save` la cifra con DPAPI (solo la descifra ese usuario de Windows) en `ai-keys.json`, junto a los ajustes. **Cómo se usa:** `spawn_env` la pasa como variable al abrir las pestañas de esa IA, salvo que el usuario ya tenga la variable puesta. **Garantías:** la clave no vuelve al frontend ni va al log (`invokeLogged` no registra argumentos), y fuera de Windows no se ofrece. Se apaga con `aiKeyOffer`. |

#### Paneles y servicios

| Archivo | Responsabilidad y conexiones |
|---|---|
| `src-tauri/src/packages/mod.rs` | Declara módulos de paquetes. |
| `src-tauri/src/packages/actions.rs` | Construye el catálogo de acciones por plataforma, familia, gestor y comando. |
| `src-tauri/src/packages/commands.rs` | IPC de catálogo/sondas/refresco/ejecución, instantáneas y caché de estados. `install_run` ejecuta la acción de la última lista del panel y, si una comprobación posterior la sacó de ella, la busca en el catálogo (`DetectionDepth::Catalog`) antes de responder que ya no existe. |
| `src-tauri/src/packages/descriptions.rs` | Descripciones legibles de acciones. |
| `src-tauri/src/packages/aliases.rs` | Nombres equivalentes de herramientas/paquetes. |
| `src-tauri/src/packages/command_not_found.rs` | Sugiere herramienta al fallar un comando. |
| `src-tauri/src/packages/ltools.rs` | Catálogo y ejecución de acciones LTools (`ltools-actions-v1` de `wtools-cli.exe actions list --format json`). Tolerante a versiones nuevas de Tools: ignora campos desconocidos, descarta solo las acciones mal formadas o inseguras y recorta (no rechaza) por encima de `MAX_ACTIONS` (1000); hasta 4 MB y 15 s (`CATALOG_TIMEOUT`). `order_candidates`: `LTOOLS_PATH`, después el PATH y, entre las copias descubiertas, primero los CLI y después la más reciente por fecha de modificación. |
| `src-tauri/src/explorer/mod.rs` | Declara explorador y reexporta papelera. |
| `src-tauri/src/explorer/files.rs` | Listado y operaciones de archivo con validación. |
| `src-tauri/src/explorer/viewers.rs` | Selección de visores para abrir un archivo. |
| `src-tauri/src/scripts/mod.rs` | API interna de Biblioteca. |
| `src-tauri/src/scripts/types.rs` | Tipos de scripts, filtros y contexto de ejecución. |
| `src-tauri/src/scripts/scan.rs` | Descubrimiento de scripts desde carpetas permitidas. |
| `src-tauri/src/scripts/pins.rs` | Favoritos persistentes de scripts. |
| `src-tauri/src/scripts/launch.rs` | Planificación de comando de ejecución y elevación. |
| `src-tauri/src/projects/mod.rs` | Declara proyectos y GitHub. |
| `src-tauri/src/projects/commands.rs` | IPC de proyectos, favoritos, descarga, CD y ejecución. |
| `src-tauri/src/projects/github.rs` | Cliente HTTP, catálogos y metadatos GitHub. |
| `src-tauri/src/projects/gh_cli.rs` | «Mi GitHub»: sesión y repositorios de la cuenta con GitHub CLI (`gh api user`, `gh repo list/create/edit/archive/unarchive/rename/delete`) con argumentos fijos y validados (`valid_new_repo_name`, `create_args`, `change_args`…), solo sobre repositorios del último listado (`OWN_REPOSITORIES`); `gh auth setup-git` una vez con sesión. Login, logout y el permiso `delete_repo` van a una pestaña visible (`projects::commands::github_cli_terminal`). |
| `src-tauri/src/projects/gh_code.rs` | «Gestionar…» → Código de «Mi GitHub» con `gh api`: archivos y carpetas por rama (`contents`), commits con sus cambios, comparar ramas o etiquetas, y listar, crear y borrar ramas (nunca la rama por defecto, confirmando el nombre). Rutas fijas con parámetros validados (`encode_repo_path`, `valid_ref_name`), respuestas saneadas y recortadas (`parse_*`) y solo repositorios del listado (`gh_cli::own`). |
| `src-tauri/src/projects/gh_work.rs` | «Gestionar…» de «Mi GitHub», fase de trabajo diario: ver una issue o PR con descripción, etiquetas, comentarios y archivos (`gh issue|pr view --json`), comentar, cerrar y reabrir, PR de borrador a lista (`gh pr ready`) y revisiones (`gh pr review --approve|--request-changes`), issues por estado y el log de lo que falló en Actions (`gh run view --log-failed`, sin colores y recortado por el final) o cancelar una ejecución. Argumentos fijos y validados, solo repositorios de la cuenta. |
| `src-tauri/src/projects/gh_manage.rs` | «Gestionar…» de «Mi GitHub» con `gh`: detalles (`gh repo view/edit`), releases (`gh release list/view/create/upload/edit/delete/delete-asset`), pull requests (`gh pr list/create/merge`), issues (`gh issue list/create/close`) y Actions (`gh run list/rerun`). Argumentos fijos y validados (`valid_ref_name`, `valid_topic`, `valid_homepage`, `valid_files`…), JSON saneado (`parse_*`) y solo repositorios del listado (`gh_cli::own`). |
| `src-tauri/src/projects/gh_admin.rs` | «Gestionar…» de «Mi GitHub», áreas de administración: artefactos, workflows con entradas, secretos (valor por la entrada estándar de `gh secret set`), variables, entornos, colaboradores, webhooks, claves de despliegue, Pages, protección de ramas, alertas de seguridad, comunidad y cuenta (perfil, claves SSH y GPG). `list_args` y `action_plan` traducen cada operación a una orden `gh` fija; lo que necesita permisos extra devuelve `needs_admin_scope`. |
| `src-tauri/src/projects/git_local.rs` | Git en la copia local de un repositorio de la cuenta (`local_clone`: la carpeta la calcula el backend): estado (`parse_status`), commit de todo y ramas (`branch_args`: `switch -c`, `switch`, `branch -d`), sin preguntas (`GIT_TERMINAL_PROMPT=0`). Push, pull y publicar rama van a una pestaña visible (`commands::github_git_terminal` con `github::build_git_sync_command`). |
| `src-tauri/src/updater/mod.rs` | Declara actualizador. |
| `src-tauri/src/updater/commands.rs` | Consulta release, manifiesto, estado y aplicación. |
| `src-tauri/src/updater/security.rs` | Verificación de firma Ed25519/OpenSSH y checksum. |
| `src-tauri/src/updater/self_update.rs` | Validación del árbol y sustitución del binario. |
| `src-tauri/src/updater/package_updates.rs` | Sondeos de actualizaciones de gestores, solo lectura. |

#### Configuración de build y recursos

| Archivo o ruta | Para qué sirve |
|---|---|
| `src-tauri/Cargo.toml`, `Cargo.lock` | Dependencias Rust y versiones cerradas. |
| `src-tauri/build.rs` | Recursos/manifest de Windows para el ejecutable y tests. |
| `src-tauri/tauri.conf.json` | Configuración común de Tauri y ventana. |
| `src-tauri/tauri.windows.conf.json`, `tauri.windows.installer.conf.json`, `tauri.linux.conf.json` | Diferencias de plataforma y empaquetado. |
| `src-tauri/capabilities/default.json` | Permisos de comandos/plugins del WebView. |
| `src-tauri/default_settings.toml` | Valores de fábrica. |
| `src-tauri/locales/*.json` | Mensajes localizados. |
| `src-tauri/icons/` | Iconos de ejecutable, instalador y tienda. |
| `src-tauri/windows-test.manifest`, `.rc` | Manifest Windows enlazado al ejecutable de test del host. |
| `package.json`, `package-lock.json` | Comandos npm y versiones de frontend. |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Instalación alternativa de workspace. |
| `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `index.html` | Bundling, compilación de Svelte/TS y HTML de entrada. |

#### Raíz del repositorio y automatización

| Archivo o ruta | Función y relación con el resto |
|---|---|
| `README.md` | Guía del producto, instalación, build, validación y flujos operativos; enlaza este mapa. |
| `CONTRIBUTING.md` | Reglas para cambios, pruebas y actualización conjunta de documentación. |
| `SECURITY.md` | Política de reporte de vulnerabilidades. |
| `LICENSE`, `THIRD-PARTY-NOTICES.txt` | Licencia del proyecto y atribuciones de terceros; se revisan al distribuir. |
| `deny.toml` | Política de dependencias Rust utilizada por `cargo deny`. |
| `docs/audits/alacritty-wezterm-wterminal.md` | Comparación de terminales y observaciones de auditoría; no define el comportamiento ejecutable. |
| `tests/e2e/smoke.mjs` | Orquestador WebDriver sobre el binario indicado por `E2E_BINARY`; produce JSON, capturas y vídeo. |
| `tests/e2e/toolbar-layout.mjs`, `terminal-url-matcher.mjs` | Reglas puras que reutilizan el E2E y sus pruebas unitarias. |
| `tests/ui/toolbar.html`, `toolbar.js` | Fixture pequeño para revisar la barra de herramientas sin lanzar la aplicación completa. |
| `build-tools/` | Entradas auxiliares para build por host y configuración local de firma Git. |
| `fuzz/` | Crate separado y target de fuzzing para destinos GitHub. |
| `.github/ISSUE_TEMPLATE/` | Formularios de incidencias y propuestas; orientan qué evidencia adjuntar. |
| `.github/dependabot.yml` | Programación de actualizaciones de dependencias. |
| `.github/workflows/ci.yml`, `workflow-security.yml` | Validación de cambios y guardas de workflows. |
| `.github/workflows/release.yml` | Empaquetado en CI, solo a mano (`workflow_dispatch`): sube a un borrador y nunca reemplaza adjuntos ya publicados. |
| `.github/workflows/wine.yml`, `fuzz.yml` | Smoke bajo Wine y fuzzing automatizado. |
| `.github/workflows/codeql.yml`, `dependency-review.yml`, `scorecard.yml` | Análisis estático, revisión de dependencias y prácticas de seguridad del repositorio. |

Los archivos de `release/`, `artifacts/` y `src-tauri/target/` son salidas
generadas. Para depurar un fallo de distribución, anotar el ejecutable exacto,
su hash y el informe E2E correspondiente; el nombre de la carpeta por sí solo
no demuestra que el vídeo y el código fuente sean de la misma build.

### Diagrama de arranque y terminal

```mermaid
sequenceDiagram
    autonumber
    participant OS as Proceso/Windows
    participant Rust as lib.rs run()
    participant State as AppState
    participant Tabs as TabManager
    participant UI as App.svelte
    participant Store as AppStore
    participant Pane as TerminalPane
    participant API as api.ts
    participant PTY as portable-pty/shell
    OS->>Rust: main.rs → run()
    Rust->>Rust: migrate_local_data, PATH, WebView2, logger
    Rust->>State: AppState::new()
    Rust->>Rust: Builder.manage + generate_handler!
    Rust->>Tabs: setup → create_tab()
    Tabs->>PTY: spawn_pty() en segundo plano
    UI->>Store: onMount → load()
    par carga inicial
        Store->>API: listTabs()
        Store->>API: getPreferences()
        Store->>API: getAppInfo()
    end
    API->>Rust: invoke tabs_list/settings_get/app_info
    Store-->>UI: tabs y preferencias
    UI->>Pane: montar TerminalPane(tabId)
    Pane->>Pane: Terminal + FitAddon + fitAndReport()
    Pane->>API: markTabReady → tabs_ready
    Pane->>API: markFrontendReady → frontend_ready
    PTY-->>Tabs: bytes del banner y prompt
    Tabs-->>UI: evento pty-data(tabId, data)
    UI->>Pane: cola por tabId → xterm.write(callback)
    Pane-->>OS: primer frame visible y cursor
```

El orden exacto de `tabs_ready`, `frontend_ready` y la salida de la shell
depende de la latencia del proceso. Las barreras impiden que se pierdan bytes
cuando la PTY se adelanta al montaje de xterm. `App.svelte` registra listeners
una sola vez; `TerminalPane` se mantiene montado al cambiar de pestaña.

### Diagrama de entrada, salida y reflow

```mermaid
flowchart LR
    K[Tecla o pegado] --> X[xterm.onData]
    X --> P[TerminalPane: espejo y reserva de columnas]
    P --> A[api.sendInput: cola y época por tabId]
    A --> C[commands::pty_input]
    C --> T[TabManager::write / note_user_input]
    T --> S[Shell por portable-pty]
    S --> R[pty.rs: reader]
    R --> D[stream.rs: UTF-8 y clear]
    D --> Z[semantic_zones.rs]
    Z --> E[TabManager::on_pty_event]
    E --> Q[Evento Tauri pty-data/clear/exit]
    Q --> O[App.svelte: outputQueues y outputEpochs]
    O --> W[xterm.write con callback]
    W --> M[TerminalPane: medir filas y scroll]
    M --> F[fitAndReport: columnas/filas]
    F --> V[api.resize → commands::pty_resize]
    V --> T
    M --> H[Host: scroll horizontal único]
```

Para una entrada larga, `reserveCurrentInputColumns` y
`queueInputPtyResize` preparan la matriz antes de entregar bytes a la shell.
Para salida larga, `onTerminalOutputBusy` y `onTerminalOutputIdle` delimitan
la ráfaga y `fitAndReport` compara contenido visible, viewport y reserva.
`pty_resize` comunica el mismo tamaño a la PTY; xterm y ConPTY deben coincidir.
ConPTY coloca el eco con coordenadas absolutas (`ESC[fila;colH`), así que
cualquier diferencia de filas o columnas hace aparecer la orden debajo de su
prompt. Por eso:

- La rejilla de xterm nunca baja de `CONPTY_MIN_COLS` (= `MIN_INTERACTIVE_COLS`
  del backend, 1024). Lo que la vista pide se publica aparte como
  `data-display-cols` y es lo que miden las comprobaciones de anchura.
- Las filas siempre se envían a ConPTY, aunque una reserva de entrada proteja
  las columnas; un resize aplazado por salida se reenvía al quedar inactiva.
- Si xterm pasa por un tamaño transitorio (p. ej. 1 fila al dividir), esa
  reducción se reproduce en ConPTY antes de la geometría final.
- Una pestaña nueva no arranca la shell hasta su primer `pty_resize` medido.

- El resize de ConPTY lleva 250 ms de debounce, pero xterm cambia sus filas al
  instante: la entrada adelanta ese resize pendiente (`flushPendingPtyResize`)
  y, en una casilla que vuelve a ser visible, espera su primera medida
  (`activationGeometryReady`, máx. 250 ms) antes de enviar teclas.
- Una casilla oculta (`display: none`) pausa el renderer de xterm. Si se
  reajusta antes de que su IntersectionObserver la vuelva a ver, xterm aplaza
  el resize hasta que la página queda inactiva y, mientras tanto, su área de
  scroll tiene rango 0: la vista caía a la cima del historial y no seguía la
  salida. Al volver de oculta, el reajuste espera esa visibilidad
  (`openVisibilityGate`, máx. 200 ms); además la posición guardada al ocultarse
  se reaplica en los renders durante 4 s (`restoreScrollAfterRender`, como
  mucho cada 80 ms; la rueda o la barra de scroll la cancelan).
  `data-scroll-restore-*` y `data-scroll-guard-applied` lo registran.
- La reserva de columnas del primer eco (`localInputGridPinned`) solo dura
  mientras hay entrada en cola; mantenerla bloqueaba el ajuste de filas en los
  resize siguientes. `data-fit-skip` publica por qué se aplazó un ajuste.
- El scroll horizontal es solo del host. Al cruzar las 1024 columnas, el
  navegador desplazaba `.xterm-scrollable-element` (con overflow oculto) para
  enseñar el textarea de xterm: el texto se movía sin cambiar el scroll del
  host y el prompt siguiente quedaba fuera de la vista.
  `onInnerHorizontalScroll` (en captura) devuelve a 0 cualquier desplazamiento
  horizontal interior, salvo el del propio textarea, y el E2E `input-follow`
  lo vigila (`innerScroll`). Tras un reajuste, la posición horizontal
  restaurada ya no pisa el eco de una tecla escrita mientras tanto.
  Si el cursor cabe en la primera pantalla, la línea se enseña desde el
  principio (`keepCursorHorizontallyVisible`): un resto de scroll cortaba la
  primera columna.
- Ningún ancho publicado deja texto pintado fuera del alcance de la barra
  (18-11). Una salida más ancha que la rejilla sale primero partida en filas
  y, a los pocos segundos, `fitAndReport` la vuelve a medir y la pone en una
  sola fila. Durante esos segundos, el ancho que se publicaba podía quedarse
  por debajo de la primera fila (6680 px con filas de 7200), y su final no se
  alcanzaba. Ahora `ensureVisibleTextReachable`, llamada desde
  `updateHorizontalScrollState` en cada fotograma pintado, lee en el buffer de
  xterm las filas a la vista (el DOM puede ir un fotograma por detrás tras un
  reajuste), mide la más larga sin los espacios finales (el relleno de
  `PROMPT_SP` de zsh o una fila con fondo de color no son texto) y amplía
  `--terminal-content-width` si no llega. Solo amplía, nunca encoge, y no
  actúa en pantalla completa, que va siempre al ancho de la vista. El E2E
  `horizontal` lo vigila justo después de la salida y 5 s más tarde
  (`widestReachable`).

- La salida del inicializador no llega a xterm: el backend la sustituye por
  `banner_text` tras el marcador. El archivo que la shell imprime con `type`
  (`refresh_banner_files`) debe producir exactamente las mismas filas; sin
  banner (casilla diminuta) queda vacío. Antes conservaba un `\r\n` y ConPTY
  acababa una fila por debajo de xterm: el eco de la primera orden salía
  separado del prompt cuando ningún repintado posterior lo disimulaba. El
  backend compara la fila que deja ConPTY (`startup_cursor_hint`) con la que
  tendrá xterm y registra «Desalineación entre ConPTY y xterm tras el
  arranque»; `assertCurrentLog` falla si aparece. Además lo corrige:
  `startup_alignment` añade al banner sustituto `\r\n` (bajar, con el mismo
  scroll que hizo ConPTY) o `CUU` (subir) y, si ConPTY quedó a mitad de
  línea, `CHA` a su columna. Solo se corrige si la salida de arranque no se
  recortó (`OUTPUT_BUFFER_CHARS`): sin el borrado inicial la fila calculada no
  es fiable. El aviso queda en el registro con `corrected` para el
  diagnóstico.
- Las líneas de sugerencias (`InitOptions.assist_lines`) van antes del
  borrado y el banner iniciales, no justo antes del marcador: ble.sh imprime
  «updating tput cache» la primera vez que se carga con un `TERM` nuevo y
  movía ConPTY una fila por debajo de xterm (E2E `shell-assist` en WSL). Su
  salida no se puede redirigir porque ble.sh guarda los descriptores que
  tenga al cargarse para pintar la línea de órdenes; cargado antes del
  borrado, el aviso desaparece con él.
- La sonda de recuperación del primer prompt (`recoverInitialPrompt`) solo
  envía Enter cuando la casilla ya recibió salida de la shell y el prompt
  sigue sin aparecer 2 s después. Con un inicializador lento, el Enter
  quedaba en cola y duplicaba el prompt; en una casilla de 1-2 filas ese salto
  desplazaba el historial y, al crecer la casilla, ConPTY recuperaba la fila
  oculta mientras xterm (`windowsPty`) no lo hace.
- Una pestaña nace con la geometría guardada de la ventana. Al dividir, el
  panel anterior puede no haber informado aún de su nuevo alto, así que la
  geometría heredada (26 filas) no coincide con la casilla real (4). La
  preparación del banner corre en segundo plano y, si terminaba después del
  primer `pty_resize`, pisaba esa medida: la shell arrancaba con ConPTY a 26
  filas y xterm a 4, y el eco de la primera orden salía despegado al crecer la
  casilla. `effective_startup_viewport` conserva la medida confirmada por el
  frontend. El escenario `new-tab-echo-forced-race`
  (`E2E_NEW_TAB_ECHO_FORCED_RACE`) fuerza ambas condiciones con
  `LTERMINAL_E2E_BIRTH_ROWS` y `LTERMINAL_E2E_BANNER_DELAY_MS`, que solo se
  respetan con `LTERMINAL_E2E_TESTING=1`: falla con el código anterior y pasa
  con la corrección.
- xterm pinta colores de la paleta, negrita, cursiva, alto de fila y
  parpadeo con hojas `<style>` que crea en tiempo de ejecución. Tauri añade
  nonces a `style-src` y con ellos el navegador ignora `'unsafe-inline'` (la
  `sheet` quedaba en null): la salida ANSI salía gris y sin atributos. Por
  eso `tauri.conf.json` declara
  `dangerousDisableAssetCspModification: ["style-src"]`; `script-src` sigue
  con nonces y sin `'unsafe-inline'` ni `'unsafe-eval'`; solo añade
  `'wasm-unsafe-eval'` para el decodificador Sixel (WebAssembly) del
  complemento de imágenes. `@xterm/addon-unicode11` alinea los anchos de
  emoji y símbolos con los de ConPTY; el E2E `inline-images` comprueba que
  ConPTY deja pasar Sixel e iTerm2, que xterm los pinta y que el eco sigue
  alineado después de una imagen. El E2E `ansi-styles` lo comprueba
  midiendo el estilo calculado. `TerminalPane` repite en CSS estático la
  fuente y el tamaño de `.xterm-rows` (`--wt-xterm-font-*`) como red de
  seguridad: sin las hojas, las filas heredaban 13 px mientras xterm mide con
  su `fontSize` y cursor, textarea y scroll se desfasaban un 8 % por columna.
- Seguimiento horizontal al escribir: `keepCursorHorizontallyVisible` deja
  tres celdas de margen, vuelve al principio si el cursor cabe en el primer
  tercio y amplía el ancho desplazable (`ensureHorizontalRoom`) si el cursor
  no cabe. La reserva de entrada mide prompt + tecleado (`inputStartColumn`).
  Solo un gesto real (puntero pulsado o rueda) bloquea el seguimiento; el
  desplazamiento nativo que provoca el textarea de xterm no, y teclear cierra
  la ventana del gesto. Escenario: `E2E_INPUT_FOLLOW_ONLY` (tecleo a ritmo
  humano, scroll manual, Mayús+rueda, Inicio/Fin/flechas/Retroceso, inserción,
  ventana, más de 1024 columnas e Intro).

El E2E lo vigila con `assertNoDetachedCommandEcho` y los escenarios enfocados
`E2E_NEW_TAB_ECHO_ONLY` (con `E2E_NEW_TAB_ECHO_ROTATE=1 E2E_NEW_TAB_ECHO_SWITCH=1`),
`E2E_QUEUED_INPUT_RESIZE_ONLY` (entrada escrita antes del prompt y resize) y
`E2E_RESIZE_TYPE_ONLY` (escribir justo tras cambiar la altura, también al
volver a una pestaña que estaba oculta; `E2E_RESIZE_TYPE_ATTEMPTS` repite la
parte oculta) y `E2E_TINY_GROW_ONLY` (casilla de 1-2 filas
cuyo historial se desplaza y que después crece, al volver a un panel o al
agrandar la ventana).
El buffer de xterm conserva el historial. El tamaño de la barra horizontal por
sí solo no prueba que el final esté pintado: el E2E debe inspeccionar tanto
buffer/DOM como píxeles del extremo y los frames intermedios. Cambiar esta
cadena obliga a revisar el escenario de input largo, scroll, `cls`, resize y
división de paneles.

### Diagrama de paneles e IPC

```mermaid
flowchart TD
    UI[Toolbar / TabBar / Paneles] --> Store[AppStore y panels.svelte.ts]
    UI --> API[api.ts: invoke/listen]
    Palette[CommandPalette + command-palette.ts] --> Run[App.svelte: runPaletteEntry / runAppAction]
    Keys[Atajos globales: onShortcut] --> Run
    Run --> Store
    Run --> Controls[terminalRegistry: submitLine / openSearch]
    Controls --> Term[TerminalPane: term.input → interceptor de : / shell]
    Store --> API
    API --> Handler[lib.rs: generate_handler!]
    Handler --> Core[app/commands.rs: pestañas, PTY, ajustes, entornos]
    Handler --> Panel[app/panel_commands.rs: scripts y explorador]
    Handler --> Pack[packages/commands.rs: dependencias]
    Handler --> Proj[projects/commands.rs]
    Handler --> Up[updater/commands.rs]
    Core --> State[AppState y TabManager]
    Panel --> State
    Pack --> Catalog[packages/actions.rs + caché/sondas]
    Pack --> State
    Proj --> Git[projects/github.rs]
    Up --> Sig[updater/security.rs → self_update.rs]
    State --> Events[Eventos Tauri: PTY, cwd, envs, tabs]
    Events --> API
    API --> UI
```

#### Contrato IPC por dominio

El identificador entre paréntesis es el nombre que `api.ts` entrega a
`invoke`. `lib.rs::generate_handler!` registra la función Rust del mismo
nombre; los métodos de `AppStore` coordinan las respuestas cuando hay estado
que puede quedar obsoleto. Esta tabla localiza la llamada antes de entrar a
depurar un handler.

| Productor frontend | Comandos IPC | Implementación y siguiente paso |
|---|---|---|
| `app.load/createTab/activateTab/closeTab`, `TabBar` | `tabs_list`, `tabs_create`, `tabs_activate`, `tabs_close` | `app/commands.rs` → `TabManager::{list,create_tab,activate,close_tab}` |
| `TerminalPane` durante montaje | `tabs_ready`, `frontend_ready`, `frontend_reveal` | `app/commands.rs` → `TabManager::mark_ready`; el reveal muestra la ventana |
| `TerminalPane` con teclado o cambio de matriz | `pty_input`, `pty_resize`, `pty_print_banner`, `internal_command_parse` | `app/commands.rs` → `TabManager::{write,resize,print_banner}` y analizador interno |
| `TerminalPane` al confirmar un Ctrl+clic sobre un enlace | `terminal_open_link` | `terminal/links.rs` → `validate_link` y opener de Tauri (navegador, carpeta o archivo mostrado en su carpeta) |
| Selector y `AppStore` | `env_list`, `env_refresh`, `env_switch` | `app/commands.rs` → `AppState::refresh_environments` o `TabManager` con nueva generación |
| `SettingsPanel` y `AppStore` | `settings_get`, `settings_save`, `settings_reset`, `profile_export`, `profile_import`, `profile_status`, `profile_save_now` | `app/commands.rs` → `config/preferences.rs`, `settings.rs` |
| `SettingsPanel` | `plugins_list`, `plugins_set_enabled`, `plugins_install`, `plugins_remove` | `config/plugins.rs` |
| Integración de escritorio | `windows_integration_status/set`, `desktop_integration_status/set`, `app_restart_as_admin`, `path_integration_status/set` | `platform/windows_integration.rs`, `platform/desktop_entry.rs`, `platform/path_integration.rs` |
| `ScriptsPanel` | `scripts_list`, `scripts_list_here`, `scripts_pick_target`, `scripts_open`, `scripts_cd`, `scripts_cd_directory`, `scripts_run`, `scripts_pin` | `app/panel_commands.rs` → `scripts/{scan,launch,pins}.rs` |
| `ExplorerSidebar` | `explorer_list`, `explorer_follow`, `explorer_create`, `explorer_open`, `explorer_rename`, `explorer_clip`, `explorer_paste`, `explorer_trash`, `explorer_cd`, `explorer_open_directory`, `explorer_open_directory_with` | `app/panel_commands.rs` → `explorer/files.rs`, `viewers.rs` y adaptador de plataforma |
| `DependenciesPanel` | `install_list`, `install_catalog`, `install_check`, `install_refresh`, `install_run` | `packages/commands.rs` → `actions.rs`, sondas y `TabManager::write_command` |
| `ScriptsPanel` para LTools | `ltools_actions_list`, `ltools_action_run` | `packages/ltools.rs` |
| `ProjectsPanel` | `projects_state_get`, `projects_downloaded`, `projects_cd`, `projects_lookup`, `projects_release`, `projects_download_release`, `projects_pin`, `projects_choose_folder`, `projects_open_github`, `projects_run` | `projects/commands.rs` → `projects/github.rs`, rutas y terminal |
| Aviso de versión y `SettingsPanel` | `update_check`, `update_check_on_startup`, `package_updates_check`, `update_install` | `updater/commands.rs` → `security.rs`, `self_update.rs` y `package_updates.rs` |
| Telemetría de frontend | `app_info`, `log_frontend_error`, `log_frontend_performance` | `app/commands.rs` → identidad, log estructurado |

Los eventos tienen dirección inversa; se registran con `listen` en
`api.ts` y se procesan en `App.svelte` o en un componente dueño del estado:

| Evento | Emisor | Consumidor y efecto |
|---|---|---|
| `pty-data`, `pty-clear`, `pty-exit` | `TabManager` | `App.svelte`: cola xterm, invalidación del clear, aviso de salida |
| `pty-command-resize` | `TabManager` | `TerminalPane`: sincroniza tamaño antes del comando de panel |
| `pty-command-written` | `TabManager::write_command_shown` | `TerminalPane`: la orden de un panel cuenta como orden (`CommandTracker.appCommand`), con su texto para el chat y el consejero |
| `tab-closed`, `env-changed`, `envs-updated` | `TabManager` / `AppState` | `AppStore`: actualiza identidad, tab activo e inventario |
| `terminal-cwd-changed` | Inspector de salida de `TabManager` | `ExplorerSidebar`: seguimiento condicionado al tab y solicitud actual |
| `command-not-found` | Inspector de salida | `AppStore`: sugerencia contextual |
| `terminal-semantic-zone` | `semantic_zones.rs` | `api.onSemanticZone` expone la suscripción; la interfaz actual no la registra de forma permanente |
| `update-progress` | `updater/commands.rs` | `SettingsPanel`: estado visible de descarga/aplicación |

Las funciones de ventana, portapapeles, diálogo y abrir con el sistema en
`api.ts` usan los plugins oficiales de Tauri; no pasan por un handler Rust
propio de `generate_handler!`. La excepción son las URL: el WebView no tiene el
permiso `opener:allow-open-url` y solo puede pedir abrir un enlace a través de
`terminal_open_link`, que lo valida en Rust.

#### Ejemplos de llamadas completas

| Intención | Cadena desde la UI | Confirmación / riesgo de carrera |
|---|---|---|
| Abrir pestaña | `TabBar` o `Toolbar` → `app.createTab` → `api.createTab` → `tabs_create` → `TabManager::create_tab`/`spawn_pty` | `TerminalPane` confirma ready; el PTY puede crearse después de la respuesta inicial. |
| Activar una casilla | puntero/teclado → `TerminalPane.tomarElFoco` → `app.activateTab` → `tabs_activate` | El foco programático de xterm se distingue del foco del usuario. Un frame de resize solo puede enfocar la pestaña que sigue activa y se cancela al cambiar la activación; así se evita un ciclo de activaciones entre paneles. |
| Cambiar shell | selector → `app.switchEnvironment` → `api.switchEnvironment` → `env_switch` → reemplazo de generación en `TabManager` | `pty-clear` y `env-changed`; invalidar colas anteriores. |
| Repetir detección | `DependenciesPanel.repeatDetection` → `refresh` → `api.refreshInstallActions` → `install_refresh` → `build_list` | `envs-updated`, estados de cada sonda; distinguir caché, desconocido y comprobación real. |
| Ejecutar acción | tarjeta → `DependenciesPanel.run` → `api.runInstallAction` → `install_run` → `TabManager::write_command` | Comando visible, salida PTY y sonda posterior; no inferir instalación por salida solamente. |
| Guardar ajuste | control → `SettingsPanel.scheduleAutoSave/saveDraft` → `app.savePreferences` → `api.savePreferences` → `settings_save` | `AppStore` serializa los IPC; `SettingsPanel` compara la revisión del borrador antes de aplicar la respuesta. Si hubo otra edición mientras guardaba, conserva el borrador vivo y programa otro guardado. |
| Seguir cwd | salida shell → `current_dir.rs` → `terminal-cwd-changed` → `ExplorerSidebar.follow` → `explorer_follow` | Número de petición y tab activo; se descartan respuestas obsoletas. |
| Actualizar app | aviso/ajustes → `checkForUpdate`/`installUpdate` → `update_check`/`update_install` | Firma, checksum y árbol de payload antes de aplicar; progreso por evento. |
| Abrir un enlace de la salida | `@xterm/addon-web-links` (URL `http`/`https`/`file`) u OSC 8 (`linkHandler`) → `TerminalPane.activateTerminalLink` (Ctrl+clic, `isLinkActivation`) → `checkTerminalLink` → confirmación `terminal-link-dialog` si `terminalLinksConfirm` → `api.openTerminalLink` → `terminal_open_link` → `terminal::links::validate_link` → opener de Tauri | El backend revalida y no confía en el frontend: con `terminalLinks` desactivado responde `disabled`; `javascript:`, `ms-settings:`, credenciales, caracteres ocultos o un `file://` de otro equipo se rechazan con su código y el frontend muestra `terminal-link-notice`. Un `file:` a un archivo solo se muestra en su carpeta. E2E enfocado: `E2E_TERMINAL_LINKS_ONLY` imprime una URL, comprueba el subrayado y el aviso al pasar el ratón, que un clic sin Ctrl no hace nada, que Ctrl+clic pide confirmación con la URL y el host exactos, que cancelar no abre y que «Abrir» pide exactamente esa URL (registro del backend en `LTERMINAL_E2E_OPENED_LINKS`, sin lanzar el navegador; la llamada IPC solo se espía si el WebView deja reemplazar `__TAURI_INTERNALS__.invoke`, que Tauri 2 declara no modificable); repite con un hipervínculo OSC 8 si ConPTY lo deja pasar, sin confirmación, con un `file://` a un `.exe` (acción `reveal`) y a una carpeta (`directory`), pide al backend por IPC `javascript:`, `ms-settings:`, un `file://` remoto, credenciales y un salto de línea escondido (todos rechazados) y, con los enlaces desactivados, comprueba que no se subraya ni se abre nada. |
| Paleta de comandos | `Ctrl+Shift+P` → `App.svelte` `onShortcut` (también desde un campo de formulario, salvo los de grabar atajos) → `CommandPalette.svelte` → `buildPaletteEntries`/`paletteResults` → Intro → `runPaletteEntry` → `runAppAction` (paneles, explorador, pestañas, división, buscar, limpiar, modo limpio, refrescar entornos), `app.switchEnvironment`, `app.createTab(envId)` (REPL), `themePreferencePatch` + `app.savePreferences` (tema, fuente, idioma), `api.parseInternalCommand` → `submitToActiveTerminal` → `TerminalPane.submitLineFromApp` (comandos `:`), o `api.runLToolsAction` (acciones fijadas) | La paleta no tiene manejadores propios: cada entrada llama al mismo código que su atajo, botón o comando. Lo que se escribe en la terminal pasa por `term.input` y lo pinta ConPTY, y solo sobre un prompt vacío; si hay texto sin enviar, la shell no está lista o hay un programa a pantalla completa, la paleta muestra el motivo y no teclea nada. «Limpiar» ejecuta el alias `clear` de la shell (antes `terminal.clear()` vaciaba solo xterm y separaba su cursor del de ConPTY) y se deshabilita en REPL y asistentes, igual que los comandos `:`. E2E enfocado: `E2E_COMMAND_PALETTE_ONLY` abre con `Ctrl+Shift+P`, comprueba roles ARIA, flechas con vuelta, Escape (foco devuelto a la terminal) y el atajo como cierre, abre Ajustes filtrando `:config` y lee el atajo grabado, ejecuta `:terminal list` y una línea nueva `:panel list` con el eco de la orden siguiente pegado a su prompt, comprueba el aviso con texto a medio escribir, limpia con historial vacío y eco pegado, y abre una pestaña eligiéndola con las flechas. |
| Apariencia | `SettingsPanel` (temas, «Recolorear toda la interfaz», «Guardar como tema», colores ANSI) → `settings_save` → `config/preferences.rs` (`effective_palette`, `customThemes`, `terminalAnsiColors`) → `src/lib/theme.ts` (`applyTheme`, `terminalTheme`) | `E2E_APPEARANCE_ONLY` comprueba que Carmesí solo cambia el acento, que recolorear cambia el fondo, que un tema propio se guarda, se selecciona y se borra, que el rojo ANSI propio se pinta en xterm y que la lista de tipos de la Biblioteca sigue abierta tras marcar una casilla. |
| Inteligencia artificial | `DependenciesPanel` (sección `ai`) → `ai_actions` en `packages/actions.rs` (CLIs por npm/pip con su ciclo instalar/actualizar/desinstalar, Ollama, Claude Code y LM Studio por WinGet, modelos `ollama pull`/`ollama rm` con la sonda `ollama-model:`) → `environments::ai::detect_ai_environments` añade al selector `ai:<cli>` y `ai:ollama:<modelo>` | Son interfaces, no shells: `repl: true`, sin alias, `no_auto_select`. La matriz de shells del E2E las omite; las cubre `E2E_AI_ENVIRONMENTS_ONLY`, con `ollama.cmd` simulado en el PATH, un manifiesto falso en `OLLAMA_MODELS` y Claude Code FUERA del PATH, donde lo deja la app de escritorio, bajo `LTERMINAL_E2E_KNOWN_LOCATIONS_ROOT` (`roaming/Claude/claude-code/<versión>/<hash>/claude.exe`, dos versiones: debe abrirse la mayor, una copia de `choice.exe`, que pinta su pregunta y espera). El mismo escenario ejecuta «Ver los modelos descargados» en una pestaña de cmd y exige que sea una sola línea `call …ini.cmd & ollama list & call …fin.cmd`, sin `echo` sueltos, con su cierre ✔. Cualquier modelo descargado por nombre aparece en el selector. |
| Entornos y descargas | `SettingsPanel` (Comportamiento) → `api.getToolchainStore`/`api.getToolchainExternalSizes`/`api.clearToolchainCaches` → `toolchain_store_status`/`toolchain_store_external_sizes`/`toolchain_store_clear_caches` (las ubicaciones externas se miden aparte y se reutilizan 10 min: `~/.rustup` o WinGet tardan decenas de segundos); guardar `toolchainStoreEnabled`/`toolchainStoreDir` → `settings_save` → `toolchain_store::refresh_environment` | Las variables de caché (`npm_config_cache`, `PIP_CACHE_DIR`, `GOMODCACHE`…) se publican en `process::set_extra_environment` y solo llegan a los PTY y sondas que se lancen después; una variable ya definida por el usuario manda. Vaciar borra únicamente las subcarpetas conocidas de `<raíz>/cache`. `toolchain_store_external_sizes` devuelve también las carpetas de WTerminal (`group: "app"`) y cada fila trae su `info`; `SettingsPanel` coloca una sola tarjeta flotante (`settings-storage-tip`, `position: fixed`) en coordenadas de la ventana con `placeFloatingTip` y, tras pintarla, la mide y la mete en el panel por los cuatro lados con `fitFloatingTip` (`src/lib/floating-tip.ts`): el `container-type` del panel no crea bloque contenedor para elementos fijos, y unas coordenadas relativas al panel la dibujaban a su izquierda. Las carpetas de sesión huérfanas (`<temp>/<slug>/<pid>` de procesos que ya no existen) se borran al arrancar con `session_files::prune_orphaned_sessions`. E2E enfocado: `E2E_TOOLCHAIN_STORE_ONLY` (lista, carpetas de WTerminal clasificadas, tarjeta al pasar el ratón dentro del panel, variable en la terminal y vaciado en el perfil aislado); con `E2E_TOOLCHAIN_STORE_DOWNLOAD=1` además descarga de verdad con pip, npm, Deno, Bun y Go y comprueba que todo cae en la carpeta propia y se vacía (incluida la caché de módulos de Go, de solo lectura). |

### Builds, E2E y evidencia

```mermaid
flowchart LR
    SRC[Código fuente] --> PRE[scripts/prebuild.mjs]
    PRE --> FRONT[scripts/build-frontend.mjs → Vite]
    FRONT --> WIN[windows/build.ps1 → cargo/Tauri]
    WIN --> UN[src-tauri/target/dist/.../wterminal.exe unpacked]
    WIN --> INS[Instalador NSIS]
    WIN --> ZIP[ZIP portable]
    WIN --> ONE[create-single-file-portable.mjs → EXE único]
    UN --> E2E[tests/e2e/smoke.mjs]
    ONE --> E2E
    INS --> E2E
    E2E --> REPORT[Informe JSON y main.log]
    E2E --> MEDIA[Capturas, segmentos y MP4]
    MEDIA --> FRAMES[audit-video-frames.py / extract-video-frames.py]
    REPORT --> VERIFY[verify-e2e-report.mjs]
    FRAMES --> REVIEW[Comparar fotogramas y contenido visible]
```

`scripts/run-dependency-audit.mjs` ejecuta la variante de Dependencias;
`scripts/e2e-native-driver.mjs` conecta el WebView2 y controla captura nativa.
El informe funcional y las capturas son evidencias complementarias: el estado
`passed` de un JSON no certifica continuidad del MP4 ni ausencia de clipping,
saltos del cursor o parpadeos. La aprobación visual exige auditar el vídeo
completo de la misma build, con duración y segmentos correspondientes al E2E.

#### Validación estandarizada

Los E2E no dependen de lo que tenga instalado el equipo. Se comprobó en la VM
con todo el catálogo instalado (75 programas de WinGet y más de 200
herramientas de pip, npm, cargo, go, dotnet, gem y cabal):

- el aviso «Hay actualizaciones disponibles… WinGet» no se consulta en pruebas
  (`package_updates_check` con `LTERMINAL_E2E_TESTING=1`; una prueba que lo
  necesite pone `LTERMINAL_E2E_PACKAGE_UPDATES=1`): en ventanas pequeñas
  tapaba las casillas que mide `tiny-grow`;
- `ai-environments` quita de su PATH las carpetas con un Claude Code u Ollama
  reales, que si no ganaban a los simulados, y se las oculta también al PATH
  persistente que la app vuelve a leer del registro
  (`LTERMINAL_E2E_HIDDEN_PATH_DIRS`, solo con `LTERMINAL_E2E_TESTING=1`);
  `ai-tui` hace lo mismo con Amp y Claude Code para usar el simulador, y
  `ai-real` usa precisamente las reales (una que no esté instalada se omite);
- la descarga real (`downloads`) se salta los gestores cuya variable de caché
  ya define el usuario (`userDefinedSkipped` en el informe): WTerminal respeta
  su carpeta y no hay nada que comprobar en la propia;
- los tests de Rust no suponen que falte una herramienta concreta (uno daba por
  hecho que Busted no estaba instalado).

`tests/e2e/suites.mjs` es el catálogo único de suites: `focused` (regresiones
enfocadas: pie de Ajustes, Entornos y descargas, PATH, escribir tras
redimensionar, entrada en cola, primera orden en pestañas nuevas ×3 y con la
carrera forzada, casilla diminuta que crece, seguimiento del cursor en
entradas largas, integridad horizontal, estilos ANSI, parpadeo del cursor,
selección con el ratón y enlaces clicables con Ctrl+clic, `terminal-links`, que
comprueba qué se pide abrir sin lanzar el navegador, y la paleta de comandos,
`command-palette`, que la maneja con el teclado y comprueba el efecto de cada
acción, las marcas de orden en cmd, PowerShell y Git Bash, `command-marks`,
renombrar pestañas y guardar la salida, `tab-tools`, el Intro con la ventana
minimizada, `hidden-enter` (una orden larga y una corta de PowerShell se tienen
que ejecutar aunque la ventana no se vea), y los permisos de administrador, `admin-permissions`, que recorre
también la ruta de NSudo a través de un gsudo simulado sin pedir nunca el
UAC; las shells de administrador DE VERDAD, `admin-real` (22-11): abre las de
gsudo y NSudo (cmd y PowerShell), pregunta a Windows si de verdad son
administrador (`net session` / `IsInRole`) y comprueba que empiezan en la
carpeta del usuario, con el prompt `C:\…#` que pone gsudo (en un equipo sin
UAC que pregunte; gsudo tarda hasta un minuto en abrir); el catálogo guardado
por otra build, `stale-catalog` (22-11): antes de abrir la app planta un
`install-actions-snapshot.json` «de otra build» con una orden falsa y exige
que la app lo tire, lo diga en el registro y no ofrezca esa orden (así se
coló la orden vieja de VirtualBox en la 82); además la sugerencia de importar repositorios al hacer `cd`,
`import-suggestion`; el tamaño de la interfaz escrito a mano (80, 137, 150,
200, 300 y 500 %, con el tope por el ancho de la ventana) y sus atajos,
`ui-scale`; las IA de terminal a pantalla completa con un simulador
(`tests/e2e/fake-ai-tui.mjs`): ancho visible en su pestaña y al redimensionar,
lanzadas desde cmd en pantalla alternativa y en línea, sin parpadeo ni
bloqueo, y la shell intacta al salir, `ai-tui`; las IA reales que haya
instaladas (Claude Code, Gemini, Codex, OpenCode, Qwen, Amp) sin teclear
nada que inicie sesión, escribiendo sin enviar en las que ya enseñan su caja,
`ai-real`; la sugerencia del modo de bajo consumo en un equipo de 2 hilos
simulado, `low-power`; `python` tecleado en cmd, que pasa al ancho visible
mientras corre, vuelve a la reserva al salir y respeta la opción de Ajustes,
con el tiempo de una línea en cada modo registrado en el informe,
`python-width`; y el banner con fastfetch en cmd, PowerShell y Git Bash
a varios tamaños, `fastfetch-matrix`), `full`, `video`, `downloads` (descarga real,
necesita red), `dependency-audit`, `distribution` (prueba corta de una forma de
distribución) e `installer`. Un escenario puede llevar un bloque `quick` con las
variables y el límite del modo reducido (`--quick` o `--level quick`), que se
suman a las suyas sin cambiar el modo largo. `scripts/run-e2e-suite.mjs` las ejecuta
contra cualquier binario mediante `tests/e2e/run-scenario.mjs` (salida, informe
y log por escenario, límite de tiempo que mata el árbol de procesos) y escribe
`summary.json` y `summary.md`. No se detiene en el primer fallo, avisa si el
procesador está cargado y comprueba con `tests/e2e/windows-path-guard.mjs` que
el PATH del usuario (HKCU) queda idéntico. Si se lanza desde PowerShell 7, el
ejecutor, el smoke y la preparación de herramientas quitan el `PSModulePath`
heredado (`tests/e2e/powershell-env.mjs`): con él, el Windows PowerShell 5.1
que lanzan no podía cargar ni `Get-AuthenticodeSignature`.

`scripts/test-installer.mjs` prueba el NSIS de verdad con un único UAC: se
niega si ya hay un WTerminal instalado; si hay un `SHA256SUMS.txt` junto al
instalador, su huella debe coincidir antes de pedir el UAC (`installerIntegrity`:
un instalador dañado solo hacía que NSIS devolviera «código 2»);
`windows/test-installer-elevated.ps1`
instala en silencio y espera, se comprueban archivos, entrada de
desinstalación, accesos directos y que el ejecutable instalado es el de la
release salvo la marca `__TAURI_BUNDLE_TYPE_VAR_` que escribe el empaquetador,
se ejecuta el recorrido completo sobre lo instalado y se desinstala
verificando que no queda nada. Suelto, `node scripts/test-installer.mjs
--installer <setup.exe> --release-dir <carpeta desempaquetada> --video` graba
además ese recorrido sin repetir la suite `video`.

`windows/build.ps1` añade `focused` a la batería ampliada (salvo
`-NoFocusedTests`) y con `-ReleaseValidation` o `-QuickValidation` (o
`-VideoTest`, `-DownloadTests`, `-DependencyAudit`, `-InstallerTest`) el resto,
siempre contra los artefactos ya firmados. El resumen queda en
`artifacts/release-validation/WTerminal-<versión>-<fecha>/summary.md`; un
fallo o una validación omitida se listan al final y el código de salida es 1.
`scripts/test-e2e-suite.mjs` comprueba sin abrir la app el catálogo, los
niveles, los argumentos, el resumen y la comparación de binarios del
instalador.

### Mapa de scripts y pruebas

| Archivos | Función |
|---|---|
| `windows/build.ps1`, `windows/build.bat` | Pipeline Windows: comprobaciones, build, instalador y artefactos portables. Termina con `Write-BuildSummary` (release, pruebas, informes, vídeos, capturas y logs) y guarda las evidencias en `artifacts/builds/`. |
| `windows/build-stages.ps1` | Larga por etapas y reanudable (22-11): comprobación previa opcional, `build.ps1 -FullTests -NoFocusedTests`, una suite cada vez con `run-e2e-suite.mjs` y veredicto; estado en `artifacts\build-stages\<etiqueta>`; reanudación tras reinicio con `-ResumeAfterReboot`. |
| `windows/build-stages-resume.ps1` | Al iniciar sesión, relanza la build por etapas que un reinicio dejó a medias (`pendiente.txt`), como mucho dos veces seguidas. |
| `scripts/sign-build.mjs` | Firma una build ya compilada: `SHA256SUMS.txt` de una carpeta o de archivos concretos, con Ed25519 y SSH, verificados; claves como en `dev-test` (`--dir`, `--files`, `--out`, `--keys-dir`). |
| `windows/make-latest.ps1` | La versión «Latest» (21-11): copia una release ya hecha con «Latest» en lugar del número, comprueba antes sus sumas, calcula `SHA256SUMS.txt`, lo firma como la build y deja `LATEST-ORIGEN.txt`; sin cambios no hace nada. `windows/build.ps1 -Latest` la llama al terminar en verde. |
| `tests/e2e/suites.mjs` | Catálogo único de suites E2E y niveles de validación (`-FullTests`, `-ReleaseValidation`). |
| `scripts/run-e2e-suite.mjs` | Ejecuta suites contra un binario y escribe `summary.json`/`summary.md`. |
| `tests/e2e/run-scenario.mjs` | Lanza un escenario del smoke con informe, log y límite de tiempo; sus capturas y vídeo van a `<id>-captures` junto al informe (`E2E_CAPTURE_DIR`). |
| `tests/e2e/windows-path-guard.mjs` | Copia y restauración exacta del PATH del usuario y del estado de la integración (HKCU). |
| `tests/e2e/powershell-env.mjs` | Quita el `PSModulePath` heredado de PowerShell 7 (`dropPowerShell7ModulePath`, `windowsPowerShellEnvironment`) para que los `powershell.exe` 5.1 que lanzan las pruebas carguen sus propios módulos. |
| `scripts/test-installer.mjs`, `windows/test-installer-elevated.ps1` | Prueba real del instalador NSIS: instala con un UAC, verifica, E2E sobre lo instalado (con vídeo si la suite `video` va en la misma ejecución) y desinstala. |
| `scripts/capture-installer-pages.ps1` | Pasada visible del instalador y del desinstalador NSIS: se eleva si hace falta, avanza cada página con su botón por defecto (id 1) y guarda una captura PNG por página en la carpeta indicada, más `pages.json`. Complementa la instalación silenciosa de `test-installer.mjs`. |
| `scripts/generate-installer-art.ps1` | Genera `src-tauri/windows/installer/*.bmp` (barra lateral y cabeceras del asistente NSIS) a partir del icono y los colores del tema de fábrica. Se ejecuta a mano si cambian. |
| `scripts/test-e2e-suite.mjs` | Prueba sin app del catálogo de suites, el ejecutor y la comparación de binarios del instalador. |
| `scripts/dev-test.mjs` | `npm run dev:test`: compila con el perfil `fast` (release sin LTO e incremental) y ejecuta solo los escenarios, la matriz limitada, los tests de Rust o los scripts pedidos, con vídeo y repeticiones si se piden; firma lo que compila y resume en `artifacts/dev-test/`. |
| `scripts/test-dev-test.mjs` | Prueba sin compilar los argumentos de `dev:test`, la búsqueda de escenarios, el binario de cada perfil, que `fast` hereda de release y la firma. |
| `scripts/test-e2e-shell-tools.mjs` | Prueba sin WSL la elección de distro del E2E de bash: orden de preferencia, reintentos, distros sin las órdenes de ble.sh y fallos de instalación. |
| `scripts/prepare-e2e-shell-tools.mjs` | Solo para `E2E_SHELL_ASSIST_ONLY`: descarga a `artifacts/e2e-tools` (ignorado por git) Clink portable y el PSReadLine actual con versión y SHA-256 fijados, comprueba la firma de Microsoft de PSReadLine y los reutiliza; el smoke los pone delante en `PATH` y `PSModulePath`. No instala nada. |
| `scripts/test-single-file-portable.mjs` | Prueba sin app del empaquetador del portable de un solo `.exe`: formato, contenido, alteraciones y contrato con `single_file.rs`. |
| `windows/e2e-elevated.ps1` | E2E elevado con UAC en host Windows. |
| `linux/build.sh`, `linux/build-windows.sh` | Build Linux y build cruzada de Windows. |
| `linux/validate-release.sh`, `linux/exercise-host.sh` | Integridad de release y ejercicio del host Linux. |
| `scripts/prebuild.mjs`, `build-frontend.mjs`, `build-fast.mjs` | Precondiciones, bundle UI y ruta rápida de desarrollo. |
| `scripts/create-single-file-portable.mjs`, `finalize-offline-webview2.ps1`, `prepare-conpty.mjs` | Portable EXE único y recursos Windows necesarios. |
| `scripts/create-release-manifest.mjs`, `assemble-release.mjs`, `publish-github-release.mjs`, `sign-release-manifest.mjs`, `sign-release-ssh.mjs`, `update-release-hash.mjs`, `verify-release-artifacts.mjs` | Manifiesto, ensamblado de la release conjunta, subida a GitHub, hash, firmas y verificación de artefactos. |
| `scripts/e2e-native-driver.mjs`, `e2e-environment-probes.mjs`, `run-dependency-audit.mjs` | Driver, sondeos seguros y variante de dependencias. |
| `scripts/audit-video-frames.py`, `extract-video-frames.py`, `create-e2e-contact-sheet.py` | Decodificación de todos los frames, extracción precisa e índice visual de capturas. |
| `tests/e2e/smoke.mjs` | Escenarios E2E, acciones UI, vídeo, capturas e informe estructurado. |
| `tests/e2e/toolbar-layout.mjs`, `tests/e2e/terminal-url-matcher.mjs` | Contratos de geometría y resolución de URL del driver. |
| `tests/ui/toolbar.js`, `tests/ui/toolbar.html` | Caso aislado de barra de herramientas y su página de prueba. |
| `scripts/verify-*.mjs` | Contratos estáticos de arquitectura, build, documentación, enlaces, i18n, fuente y reportes. |
| `scripts/test-*.mjs` | Pruebas preventivas y de lógica/build/firmas sin abrir toda la aplicación. |
| `scripts/clean-repository.ps1`, `clean-repository.sh` | Limpieza controlada de salidas. |
| `scripts/preview.mjs`, `build-preview.mjs`, `package-manager.mjs`, `package-scripts.mjs`, `run-rust-tool.mjs` | Preview y ejecución compatible de herramientas. |
| `scripts/probe-windows-tools.ps1`, `wine-gui-smoke.sh`, `patch-appimage-gtk-hook.mjs`, `package-windows-cross.mjs` | Herramientas y adaptaciones de empaquetado por host. |
| `scripts/publish-release-artifact.mjs`, `set-package-version.mjs`, `sync-package-metadata.mjs`, `verify-version.mjs` | Publicación y sincronía de metadatos. |
| `build-tools/build.ps1`, `build-tools/build.sh`, `build-tools/configure-git-signing.sh` | Atajos auxiliares de build y configuración de firma Git. |
| `fuzz/Cargo.toml`, `fuzz/Cargo.lock`, `fuzz/fuzz_targets/github_target.rs` | Crate y caso de fuzzing de destinos GitHub. |

#### Índice individual de `scripts/`

Los nombres `verify-*` inspeccionan contratos sin ejecutar la app; los
`test-*` ejercitan lógica o fixtures. Para localizar una condición precisa,
buscar el nombre de la comprobación que imprime cada archivo y luego su
entrada en `package.json`.

| Archivo | Qué examina o produce |
|---|---|
| `scripts/prebuild.mjs` | Precondiciones antes del bundle frontend. |
| `scripts/build-frontend.mjs` | Bundle Vite de la interfaz. |
| `scripts/build-fast.mjs` | Ruta de compilación rápida. |
| `scripts/build-preview.mjs` | Construcción de la vista previa sin backend. |
| `scripts/preview.mjs` | Arranque de la vista previa ya construida. |
| `scripts/package-manager.mjs` | Selección del gestor de paquetes disponible. |
| `scripts/package-scripts.mjs` | Lanzamiento portátil de los scripts de `package.json`. |
| `scripts/run-rust-tool.mjs` | Invocación de Cargo/herramientas Rust con entorno del proyecto. |
| `scripts/prepare-conpty.mjs` | Preparación y verificación del recurso ConPTY. |
| `scripts/probe-windows-tools.ps1` | Disponibilidad de herramientas Windows para build y prueba. |
| `scripts/create-single-file-portable.mjs` | Crea el portable de un solo `.exe` (`wterminal.exe` + `conpty.dll`, `OpenConsole.exe`, los avisos y, solo en la variante `-WebView2 Offline`, el instalador de WebView2, tras la imagen PE, con índice JSON y cola `WTPORT01`); `--verify` lo compara con la carpeta unpacked. No es un autoextraíble: arranca con doble clic. La build lo copia solo a una carpeta vacía, pasa el E2E completo con `E2E_EXPECT_SINGLE_FILE=1` (ConPTY desde la caché de runtime) y exige que no deje nada a su lado. |
| `scripts/finalize-offline-webview2.ps1` | Completa recursos offline WebView2 en un artefacto Windows. |
| `scripts/create-release-manifest.mjs` | Inventario de artefactos y hashes de release. `--platforms windows,linux` (de serie los dos) decide qué es obligatorio: zip, setup y Portable de Windows y el AppImage de Linux; `.deb`, `.rpm` y `.tar.gz` entran si están. |
| `scripts/assemble-release.mjs` | Prepara la carpeta que se sube a GitHub a partir de builds ya validadas: comprueba hashes y firmas de cada origen, rechaza `NO-PUBLICAR.txt`, copia a una carpeta vacía, crea el manifiesto común y lo firma. Ver [Publicar una release](#14-publicar-una-release). |
| `scripts/publish-github-release.mjs` (`npm run release:github`) | Sube a GitHub la carpeta ensamblada: vuelve a comprobar hashes, extras, adjuntos obligatorios de la versión de la etiqueta y las dos firmas (solo con las claves públicas); exige sesión de `gh` y la etiqueta en GitHub; crea la release en borrador, sube y comprueba en GitHub nombres y tamaños; nunca reemplaza adjuntos. `--dry-run` no llama a `gh`; `--publish` la publica. |
| `scripts/sign-release-manifest.mjs` | Firma Ed25519 del manifiesto. |
| `scripts/sign-release-ssh.mjs` | Firma OpenSSH del manifiesto. |
| `scripts/lib/ssh-signing.mjs` | Funciones compartidas del formato de firma SSH. |
| `scripts/update-release-hash.mjs` | Actualiza suma publicada tras empaquetado. |
| `scripts/publish-release-artifact.mjs` | Coloca un artefacto verificado en el destino de publicación. |
| `scripts/set-package-version.mjs` | Cambia la versión declarada de los paquetes. |
| `scripts/sync-package-metadata.mjs` | Sincroniza metadatos entre manifiestos. |
| `scripts/patch-appimage-gtk-hook.mjs` | Ajusta integración GTK del AppImage. |
| `scripts/package-windows-cross.mjs` | Empaqueta una build Windows hecha desde otro host. |
| `scripts/wine-gui-smoke.sh` | Prueba de ventana Windows bajo Wine. |
| `scripts/clean-repository.ps1`, `scripts/clean-repository.sh` | Limpieza de salidas de trabajo por host. |
| `scripts/e2e-native-driver.mjs` | Descubre/conecta WebDriver a WebView2 y coordina control nativo. |
| `scripts/e2e-environment-probes.mjs` | Clasifica entornos/acciones que pueden probarse sin efectos reales. |
| `scripts/run-dependency-audit.mjs` | Lanza la auditoría E2E de dependencias. |
| `scripts/audit-video-frames.py` | Decodifica todos los frames y mide negro, quietud y cambios. |
| `scripts/extract-video-frames.py` | Extrae fotogramas concretos de un MP4. |
| `scripts/create-e2e-contact-sheet.py` | Monta una hoja de contacto de capturas E2E. |
| `scripts/verify-architecture.mjs` | Comprueba módulos, recursos y adaptadores de plataforma. |
| `scripts/verify-build-scripts.mjs` | Contratos de los scripts de empaquetado. |
| `scripts/verify-contracts.mjs` | Fronteras y nombres de comandos entre capas. |
| `scripts/verify-docs.mjs` | Existencia de enlaces y rutas locales documentadas. |
| `scripts/verify-flow-documentation.mjs` | Anclas de flujos y cobertura individual de archivos fuente en este mapa. |
| `scripts/verify-encoding.mjs` | Codificación uniforme de archivos de texto. |
| `scripts/verify-e2e-report.mjs` | Estructura y coherencia del informe E2E. |
| `scripts/verify-fuzzing.mjs` | Configuración de fuzzing. |
| `scripts/verify-github-security.mjs` | Seguridad de workflows y referencias fijadas. |
| `scripts/verify-i18n.mjs` | Claves y catálogos traducidos, textos que siguen en español y textos copiados del inglés. |
| `scripts/i18n-identical-allowlist.json` | Textos revisados que coinciden con el español de verdad, por idioma, y cuántos siguen copiados del inglés en cada uno (esa cifra puede bajar, no subir). |
| `scripts/verify-install-sources.mjs` | Fuentes permitidas de instalación. |
| `scripts/verify-links.mjs` | Destinos HTTP/Git citados por código y docs. |
| `scripts/verify-logic-surface.mjs` | Presencia de guardas de lógica de frontend/backend. |
| `scripts/verify-release-artifacts.mjs` | Estructura, contenido y arquitectura de distribución. |
| `scripts/verify-runtime-assets.mjs` | Recursos que necesita una app compilada. |
| `scripts/verify-test-surface.mjs` | Contratos y escenarios que no deben desaparecer del E2E. |
| `scripts/verify-version.mjs` | Consistencia de versión entre paquetes. |
| `scripts/verify-winget-catalog.mjs` | IDs WinGet del catálogo. |
| `scripts/verify-workspace.mjs` | Rutas y estado mínimo del workspace. |
| `scripts/test-build-menu.mjs` | Opciones del menú de build. |
| `scripts/test-clean-repository.mjs` | Guardas de la limpieza de salidas. |
| `scripts/test-e2e-environment-probes.mjs` | Sondas y clasificación de entornos E2E. |
| `scripts/test-e2e-native-driver.mjs` | Conexión y control del driver nativo. |
| `scripts/test-e2e-report.mjs` | Fixtures válidos e inválidos de informe. |
| `scripts/test-e2e-url-matcher.mjs` | Resolución de URL/puerto de WebView2. |
| `scripts/test-frontend-logic.mjs` | Idioma, identidad y atajos. |
| `scripts/test-install-actions-preventive.mjs` | Acciones y sondeos de catálogo. |
| `scripts/test-ltools-contract.mjs` | Contrato de acciones LTools. |
| `scripts/test-ltools-e2e.mjs` | Ejercicio E2E de LTools. |
| `scripts/test-prepare-conpty.mjs` | Integridad del recurso ConPTY preparado. |
| `scripts/test-preventive.mjs` | Guardas de UI/layout y rutas históricas. |
| `scripts/test-preview.mjs` | Generación y arranque de preview. |
| `scripts/test-release-hash.mjs` | Hashes de artefactos. |
| `scripts/test-release-manifest.mjs` | Construcción de manifiesto: los dos sistemas, los paquetes Linux opcionales y los obligatorios que faltan. |
| `scripts/test-assemble-release.mjs` | Ensamblado de la release conjunta con builds de prueba: carpeta limpia, hashes de origen, salida no vacía, `NO-PUBLICAR.txt` y sistemas obligatorios. |
| `scripts/test-publish-github-release.mjs` | Subida a GitHub con un `gh` falso (estado en un JSON, sin red): `--dry-run` sin llamadas, borrador con los 7 adjuntos comprobados, release con adjuntos intacta, `--publish`, sin sesión, sin etiqueta, versión equivocada, hash cambiado, archivo de más, `NO-PUBLICAR.txt` y solo Windows. |
| `scripts/test-release-publish.mjs` | Publicación local de artefactos. |
| `scripts/test-release-signature.mjs` | Firma Ed25519. |
| `scripts/test-release-ssh-signature.mjs` | Firma OpenSSH. |
| `scripts/test-toolbar-layout.mjs` | Geometría de barra y pestañas. |
| `scripts/test-version-restore.mjs` | Restauración de metadatos de versión. |
| `scripts/test-windows-cross-release.mjs` | Estructura de la build Windows cruzada. |

### Dónde empezar al investigar un síntoma

| Síntoma | Leer en este orden |
|---|---|
| Texto tecleado fuera del prompt | `TerminalPane.svelte` (`onData`, `releaseInput`, reserva) → `api.ts` (`sendInput`) → `commands.rs` (`pty_input`) → `tabs.rs` (`write`) → frames de vídeo. |
| Scroll horizontal que aparece/desaparece | `TerminalPane.svelte` (`fitAndReport`, `updateHorizontalScrollState`, `onHorizontalViewportScroll`) → `terminal-columns.ts` → `app.css` → `tabs.rs::resize` → captura de extremo derecho. |
| Cursor sin parpadeo | `TerminalPane.svelte::startCursorBlinkTimer` → `theme.ts` → CSS de cursor → foco del tab y serie temporal de frames. |
| Catálogo cambia entre pasadas | `DependenciesPanel.refresh/repeatDetection` → `packages/commands.rs::install_refresh/build_list` → `environments/mod.rs::detect_environments` → snapshot y log. |
| Un panel pierde datos | `App.svelte::loadDeps/loadSettings/loadScripts/loadProjects` → estado de petición del panel → IPC específico → backend del dominio. |
| Un ajuste vuelve al valor anterior | `SettingsPanel.svelte::scheduleAutoSave/saveDraft` → revisión del borrador y `loadSerial` → `AppStore::savePreferences` → `settings_save`; comprobar clic real, estado `data-state` y persistencia tras reabrir. |
| Build portable no arranca | `windows/build.ps1` → `create-single-file-portable.mjs --verify` → `config/single_file.rs` (log «ConPTY del portable de un solo archivo listo» o el error de la caché de runtime) → `platform/windows/webview2.rs` → log de arranque y E2E del EXE concreto. |

### Mantener este mapa al cambiar código

1. Al mover o crear un archivo fuente, actualizar su entrada en el inventario
   de esta sección (el contrato `check:flows` exige que esté cada archivo). Al cambiar un comando IPC, actualizar la cadena de la
   tabla y el diagrama afectado junto con `api.ts` y `generate_handler!`.
2. Al cambiar geometría, readiness o colas PTY, actualizar el diagrama de
   entrada/salida y explicar qué barrera evita la carrera. Indicar también el
   escenario E2E y la evidencia visual que lo comprueba.
3. Al cambiar empaquetado, actualizar el diagrama de artefactos y qué variante
   se ejecutó. Un vídeo de una build anterior no valida el binario nuevo.
4. Ejecutar `npm run check:docs`, `npm run check:flows` y
   `npm run check:architecture` para comprobar rutas y anclas. Estas
   comprobaciones detectan documentación desactualizada estructuralmente;
   hay que revisar el contenido técnico junto al cambio de código.

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
  │   ├─ frontend_reveal: muestra la interfaz mientras arranca la PTY
  │   └─ frontend_ready: libera la entrada cuando existe sesión; el smoke reintenta
  ├─ TabManager solicita la PTY en segundo plano y devuelve la pestaña
  │   └─ hilo de conexión: adjunta la sesión cuando portable-pty responde
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
  → portable-pty (hilo pty-read-raw, lecturas de hasta 64 KiB)
  → a pantalla completa, agrupación de lo que llega seguido (huecos < 3 ms, como mucho 16 ms)
  → Utf8Decoder + ClearSplitter
  → Outbound::{Data, Clear, Exit}
  → outbound_lock de TabManager
  → evento Tauri: pty-data / pty-clear / pty-exit
  → listener único de App.svelte
  → outputQueues[tabId]
  → xterm.write(data, callback)
  → scroll, idle, fit y repintado
```

En una shell, cada lectura es un evento: la lógica de la reserva horizontal
mide la salida trozo a trozo (`estimateOutputChunkColumns`, la reserva
temprana), y agruparla para todas las pestañas rompió la suite `horizontal`
(10-11: «El extremo horizontal perdió números»). Con el ancho exacto (una IA,
Python en Windows, vim) no hay reserva que proteger, y ahí sí se agrupa
(`PtySession::set_coalesce`, que `tabs.rs` enciende con `pty_resize` exacto y al
crear una sesión que lo hereda). Un hilo `pty-read-raw` solo lee y pasa los
trozos por un canal acotado (64 trozos: si la pestaña va lenta, la PTY espera).
El lector de la pestaña entrega cada trozo por separado o, en ese modo, junta lo
que sigue llegando con huecos de menos de 3 ms, hasta 16 ms o 256 KiB. Con
pyreadline3 cada tecla son 63-127 lecturas en 13-26 ms. Ver «El REPL de Python
con `pyreadline3`» en [Problemas conocidos](#problemas-conocidos).

`Utf8Decoder` es incremental: una secuencia UTF-8 partida entre dos lecturas
no se convierte en caracteres corruptos. `ClearSplitter` reconoce el marcador
de limpieza sin destruir el orden de los datos que lo rodean. El backend
serializa la emisión con `outbound_lock`; el frontend serializa las escrituras
con una cola por pestaña; xterm mantiene su propio parser y renderizador. Estas
tres fronteras son necesarias porque `AppHandle::emit` no proporciona un orden
total entre hilos y una impresión del banner puede competir con el lector de la
PTY.

**Lo que espera turno se escribe junto (26-11).** Romen vio que la salida de
`ping` salía letra a letra. `ping` escribe su salida carácter a carácter y
ConPTY la entrega igual, un trozo por letra; un bucle de `echo` llega en unos
tres trozos por línea. La cola escribía cada trozo esperando a que xterm
terminara el anterior, a unos 80 trozos por segundo: cmd sacaba 20 líneas por
segundo (2000 líneas en 100 s) y cada línea de `ping` se veía teclear. Ahora,
lo que llega mientras se pinta un trozo se junta (`outputBatches`, hasta
256 KB) y va en la siguiente escritura, en el mismo orden. Un borrado o el fin
del proceso cierran el grupo, para que nada posterior se cuele delante de
ellos. Con eso cmd pasa a unas 75 líneas por segundo y PowerShell a 125-165.
La prueba `output-speed` (focused) lo mide: 2000 líneas en cmd y PowerShell
y un `ping`, con su tiempo, sus trozos y lo que cuesta atenderlos.

Queda un freno aparte: la consola de Windows sola (`cargo test
medir_velocidad_de_conpty -- --ignored --nocapture`) saca esas 2000 líneas en
unos 5 s, a 120 o a 1024 columnas, y dentro de WTerminal tarda 25-33 s. No es
la interfaz (atender los 6000 trozos le cuesta 0,4 s), ni el ancho, ni el paso
de mensajes al backend (juntar ahí lo acumulado no cambió nada). Está en
investigación.

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

Las pulsaciones se agrupan en lotes de 12 ms (`TERMINAL_INPUT_BATCH_MS`) y cada
lote espera sus barreras antes de llegar a la shell: la reserva de columnas, que
la salida anterior haya quedado en reposo (`outputInputReady`) y asentada
(`outputGeometryReady`), la geometría de una casilla recién activada y la cola
de resizes. **Mientras un lote espera, lo que se teclea se junta en el
siguiente** (`terminalInputInFlight`, `scheduleTerminalInputFlush`) y sale de una
vez cuando aquel se entrega.

- **Por qué (13-11):** cada lote espera un ciclo de salida entero (eco y
  asentado). PowerShell repinta la línea completa a cada tecla, y con una línea
  larga ese ciclo es de 50-700 ms.
  - Antes, lo tecleado rápido (WebDriver, un pegado de letras sueltas o
    alguien que escribe deprisa) hacía cola de 12 en 12 ms y salía a unos
    5 lotes por segundo. Al pulsar Intro aún quedaban 34-56 lotes de la línea
    y el Intro iba detrás.
  - `tab-tools` agotaba así sus 15 s en las builds 56 y 58. En la captura de la
    56 el cursor está a mitad de la línea: aún se estaba escribiendo.
  - Lo midió el escenario `hidden-enter` con `__wtInputState`:
    - **antes:** la línea larga se ejecutó a los 5,0 s o no se ejecutó en 6 s;
    - **con el arreglo** (5 pasadas): 1,1-4,9 s, con 0-1 lotes pendientes al
      pulsar Intro.
- **Lo que no cambia:**
  - el orden de las teclas y las barreras de geometría;
  - cambiar de shell descarta lo pendiente (`terminalInputEpoch`);
  - un comando interno (`:…`) vacía también lo que se estuviera juntando
    (`flushTerminalInputBeforeInternal`).
- **Lo que queda:** el Intro sigue esperando a que termine el eco del lote
  anterior. Con una línea muy larga, ese último ciclo puede llevar unos
  segundos.

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
  → generación nueva + solicitud de spawn de PTY (sin bloquear tabs:create)
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

`TabManager::write_command` escribe la orden de una acción (instalar,
actualizar, Proyectos, LTools…) entera y de una vez en la PTY. Aun así, se
ve escribirse letra a letra: Clink, PSReadLine y ble.sh procesan cada tecla
y repintan la línea, y cada repintado llega como una lectura aparte.

- **Opción `actionCommandsAtOnce`** (encendida de fábrica desde el 15-11): pide a la sesión
  `PtySession::hold_echo`. Si la shell empieza a repintar en menos de 5 s, el
  hilo lector junta todo lo que llegue hasta ver tantos saltos de línea como
  Intro se escribieron (el de una pausa anterior y el de la orden), mientras
  siga llegando eco (huecos de menos de 1,5 s, como mucho 8 s), y lo entrega
  en una sola escritura. La orden aparece entera. El plazo cuenta desde el
  primer repintado: eran 2 s desde que se pedía, y con el equipo cargado
  Clink tardaba más en empezar y se veía letra a letra (15-11).
- **Pestaña recién abierta** (un `.ps1` de la Biblioteca lanzado desde cmd
  abre una de PowerShell): la orden espera en `pending_commands` al marcador
  del inicializador y, con la opción encendida, no se escribe justo ahí, sino
  desde otro hilo cuando la shell lleva 250 ms callada (como mucho 3 s,
  `PtySession::wait_output_quiet`). Justo tras el marcador la shell aún pinta
  su prompt: ese salto de línea soltaba la retención antes de tiempo y
  PSReadLine, que aún no leía, repintaba la orden tecla a tecla. Lo que escriba
  un panel mientras tanto se pone detrás (`flushing_commands`). Al salir de la
  cola, la orden avisa a la pestaña (`pty-command-written`) como las demás.
- **La línea tiene que ser corta:** en PowerShell la acción va en un archivo
  (ver [Cómo se escribe cada acción en la terminal](#8-cómo-se-escribe-cada-acción-en-la-terminal));
  encadenada, PSReadLine repintaba mil caracteres a cada tecla y la retención
  se rendía. La suite `components` lo comprueba con un `.bat` y un `.ps1` de
  la Biblioteca (`components-library-at-once`).
- **Seguridad:** no se pierde nada. Si la shell tarda más del plazo, se ve
  como siempre.
- **Qué no cambia:** la pestaña, el foco y el scroll del usuario son los de
  siempre.

Orden del inicializador de cada pestaña: primero las sugerencias de la línea
de órdenes (Clink, PSReadLine, ble.sh o los plugins de zsh), después el
borrado y el banner, los alias y, al final, el marcador. xterm no ve nada de
esa salida: tras el marcador recibe el banner sustituto, así que lo que se
imprima entre el banner y el marcador deja a ConPTY más abajo que xterm y el
eco de la primera orden sale despegado del prompt. Por eso las sugerencias se
cargan antes del borrado: ble.sh, por ejemplo, avisa «updating tput cache» la
primera vez que se carga con un `TERM` nuevo (tras instalarlo o actualizarlo),
y no se le puede redirigir la salida porque guarda esos descriptores para
pintar. Si aun así ConPTY acaba en otra fila (un `.bashrc` o un alias que
imprima algo), el backend añade al banner los saltos de línea o el `CUU` que
igualan las dos filas (`startup_alignment` en `terminal/tabs.rs`) y deja el
aviso «Desalineación entre ConPTY y xterm tras el arranque» en el registro.

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

Hay veintidós acciones mapeables en `src/lib/shortcuts.ts`: paleta de
comandos, buscar en el historial, pestaña nueva, siguiente/anterior, división,
explorador, terminal limpia, cuatro direcciones, Ajustes, Proyectos,
Biblioteca, Dependencias, cerrar panel, refrescar entornos, seguir ruta, llevar
la terminal a la carpeta, limpiar terminal y abrir el explorador del sistema.
Las diez últimas de utilidad no tienen asignación de fábrica; una cadena vacía
significa “disponible para grabar”, no “fallo”. Los valores se normalizan y
comparan por código físico cuando procede.

Todas las acciones con atajo, salvo las cuatro direcciones y la propia paleta,
acaban en `runAppAction` (`App.svelte`), el mismo manejador que usa la paleta de
comandos: una acción hace lo mismo se pida con el teclado, con un botón o desde
la paleta. `scripts/test-frontend-logic.mjs` lo comprueba en las dos
direcciones (cada entrada de `PALETTE_APP_ACTIONS` tiene su `case` en
`runAppAction` y cada atajo con acción tiene su entrada en la paleta). La paleta
añade lo que ya existía sin atajo —cambiar de entorno, abrir un REPL, tema,
fuente, idioma, los comandos `:` y las acciones fijadas de LTools— llamando a
los mismos manejadores que el selector, `:repl`, `:theme`/Ajustes, el
interceptor de `:` y la Biblioteca.

Los defaults direccionales son `Ctrl+Alt+flechas` (22-11; antes `Ctrl
izquierdo+A/D/W/S`, que se comía esas teclas de las shells) y solo actúan con
la pantalla partida: con una sola terminal la tecla llega a la shell. Un atajo
de Ctrl + letra puesto a mano sigue pidiendo el Ctrl izquierdo, para que el
derecho llegue a la shell. Si
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

Los procedimientos, los contratos de producto y el inventario de archivos y
llamadas ([mapa técnico](#mapa-de-archivos-llamadas-y-mantenimiento)) se mantienen en este README: el
código y su descripción deben cambiar en el mismo commit cuando un flujo
descrito se modifique.

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

WTerminal ejecuta lo que escribes en tus shells, así que lo que protege no es
la shell: es que **nada que llegue de fuera** (la salida de un programa, una
página de GitHub, la respuesta de una IA, un archivo arrastrado) pueda hacer
algo por su cuenta, y que tus claves no salgan de donde las pusiste.

### 1. El puente entre la ventana y Rust

- **Sin `withGlobalTauri`.** El frontend no tiene acceso global al puente: solo
  a los comandos que `api.ts` importa explícitamente.
- **`freezePrototype` desactivado a propósito.** Congelar `Object.prototype`
  deja la ventana en negro: el frontend no llega a montarse.
- **`dragDropEnabled: false`**: arrastrar un archivo sobre la ventana no
  reemplaza la interfaz por él.

### 2. Lo que puede cargar la ventana (CSP)

#### 2.1 Qué se permite

**CSP estricta**: `default-src 'none'`, sin `connect-src` a nada que no sea el
propio IPC. El frontend no puede hacer peticiones de red por su cuenta. Los
scripts solo pueden venir de la propia app.

#### 2.2 Las dos excepciones, y por qué

- `'wasm-unsafe-eval'` permite compilar el WebAssembly del decodificador de
  imágenes Sixel de xterm, sin admitir `eval` de JavaScript ni scripts en línea.
- Los estilos en línea sí se permiten (`style-src 'unsafe-inline'`) y Tauri no
  añade nonces a `style-src` (`dangerousDisableAssetCspModification: ["style-src"]`):
  con un nonce el navegador ignora `'unsafe-inline'` y bloqueaba las hojas que
  xterm crea al arrancar, con lo que los 16 colores ANSI, la negrita y la
  cursiva salían en gris normal.

### 3. Red y descargas

- **Descargas acotadas.** Solo se descargan adjuntos de una release que se acaba
  de consultar, comprobando cada redirección contra los hosts de GitHub, con
  tope de tamaño aplicado mientras se escribe.
- **Sin tokens.** La integración con GitHub usa solo la API pública.

### 4. Enlaces de la salida de la terminal

#### 4.1 El riesgo

Cualquier programa puede escribir texto o un hipervínculo OSC 8 en la salida,
así que nada de eso se abre por sí solo.

#### 4.2 Qué hace falta para abrir uno

Ctrl+clic, de fábrica una confirmación que enseña la URL completa y su host (en
punycode si el dominio es internacional), y que
`terminal::links::validate_link` lo acepte.

#### 4.3 Qué se rechaza

- Solo `http`, `https` y `file`; se rechazan `javascript:`, `data:` y
  protocolos de aplicaciones como `ms-settings:`.
- Credenciales `usuario:contraseña@`, caracteres de control o invisibles
  (controles bidireccionales, anchos cero).
- Los `file://` de otro equipo, que en Windows se convertirían en una ruta UNC
  y una conexión SMB. Un `file:` a un archivo solo lo muestra en su carpeta;
  nunca lo ejecuta.

#### 4.4 Por qué siempre hay un manejador propio

El WebView no tiene `opener:allow-open-url`, y sin `linkHandler` xterm abriría
los OSC 8 con `window.open`: WTerminal siempre instala el suyo, también con los
enlaces desactivados (no hace nada).

### 5. Claves, secretos y la IA

- **Claves de API:** cifradas con DPAPI para tu usuario de Windows
  (`ai-keys.json`); no vuelven al frontend ni van al log. Ver
  [Clave de API cuando falta](#clave-de-api-cuando-falta-aikeyoffer-solo-windows).
- **Lo que se manda a un agente:** antes de mandar la salida de la terminal al
  chat se ocultan los secretos que se reconocen (`redactSecrets`), y el mensaje
  enseña qué se mandó. La pregunta va por la entrada estándar, nunca como
  argumento, y el modelo elegido solo admite letras, números y `. _ : / @ -`:
  nada de eso lo interpreta un `.cmd`.
- **Nada se ejecuta solo:** ni el chat ni el consejero escriben un Intro.
  «Insertar» deja la orden escrita, sin ejecutar.

### 6. Escaneos del repositorio

#### 6.1 Código y workflows

Los workflows de GitHub Actions separan las comprobaciones por superficie:
CodeQL analiza el código Rust, TypeScript/JavaScript y los workflows; Gitleaks
busca secretos; `actionlint` y zizmor revisan sintaxis y seguridad de Actions.

#### 6.2 El preflight local

Comprueba que cada acción esté fijada a un SHA, que checkout no conserve
credenciales, que los permisos de publicación sean mínimos y que no se restaure
caché en la publicación.

- `npm run check:github-security` ejecuta estas reglas y vuelve a lanzar
  `actionlint`/zizmor si están instalados; las builds rápidas mantienen esta
  comprobación aunque se omita el resto de tests.
- Es de solo lectura: no reescribe workflows ni cierra avisos remotos. Tras
  corregirlos, la ejecución de CI vuelve a analizar y subir SARIF, y GitHub
  actualiza el estado de Code Scanning.
- Define `LTERMINAL_REQUIRE_GITHUB_SECURITY_TOOLS=1` para hacer fallar también
  el control local si falta alguno de esos dos escáneres.

#### 6.3 Dependencias

- CI ejecuta `npm audit`, `cargo audit` y `cargo deny`.
- Dependency Review compara los cambios de dependencias de cada PR con el aviso
  de vulnerabilidades y la política de licencias.
- Dependabot agrupa actualizaciones minor/patch por ecosistema y aplica un
  periodo explícito de siete días antes de las actualizaciones de versión; las
  versiones major quedan separadas para poder revisarlas antes de integrarlas.
- Los binarios ConPTY ya no se versionan: las builds obtienen la pareja desde el
  paquete de Microsoft fijado y verifican su SHA-512 de NuGet, los miembros ZIP
  y los CRC antes de instalarlos.

#### 6.4 OpenSSF

OpenSSF Scorecard revisa semanalmente las prácticas de seguridad del
repositorio. El workflow da al análisis permisos de lectura para consultar
commits, issues, pull requests y checks; conserva el SARIF cinco días para
diagnosticar fallos y publica los resultados en Code Scanning.

- Los avisos de `Code-Review`, `Branch-Protection` y `Maintained` dependen
  también de la actividad y de reglas configuradas en GitHub, no solo del
  workflow. `Maintained` depende de actividad real sostenida y no se puede
  corregir con un cambio de configuración.
- La evaluación OpenSSF Best Practices es una autoevaluación externa: no se
  marcará como aprobada ni se añadirá un distintivo hasta completar sus
  preguntas con evidencia.

#### 6.5 Licencia

El proyecto publica la licencia AGPL-3.0-only en `LICENSE` y en los metadatos
de paquete (`check:metadata` y `check:github-security` comprueban que el texto
y los manifiestos coinciden). `License` se publica como AGPL-3.0-only y los
notices de Microsoft se incluyen en los paquetes.

### 7. Riesgos conocidos y lo descartado

#### 7.1 `glib`

El aviso de vulnerabilidad de `glib` requiere una actualización compatible de
la pila GTK3/WebKit/Tauri: la versión usada por `webkit2gtk` aún pertenece al
rango afectado y no se ocultará mediante una supresión de auditoría. Mientras
el ecosistema no publique una ruta compatible corregida, CI debe seguir
mostrando ese riesgo. El parser de destinos GitHub ya tiene tests y fuzzing
continuo de ClusterFuzzLite.

#### 7.2 APIsec

No se conserva el workflow de ejemplo de APIsec: apuntaba al proyecto de
prueba `VAmPI`, mientras que LTerminal es una aplicación de escritorio y no
expone la API HTTP que ese escáner necesita. Si se incorpora una API real en el
futuro, se podrá añadir un escaneo DAST específico para ese servicio.

## Entornos y shells

### 1. Cómo se agrupan los entornos

El selector agrupa los entornos por familia:

| Grupo | Contenido |
|---|---|
| Shells del sistema | cmd, PowerShell, PowerShell 7, Git Bash, bash, zsh, fish, sh, distribuciones WSL y sus shells, `cmd.exe · Wine` |
| Lenguajes · intérprete interactivo | REPL detectados bajo demanda: Python, Node.js, Ruby, Java, PHP, Lua, R, Groovy, Deno, Bun, Perl, Julia, C#/F#, Haskell, Scala, Clojure, Elixir, Erlang, OCaml, Racket, Forth y Rust mediante evcxr |
| Docker · contenedores en ejecución | Entrar en un contenedor vivo |
| Docker · imágenes | Crear un contenedor nuevo y efímero |
| Android (ADB) | Un entorno por dispositivo conectado |
| Inteligencia artificial | Claude Code, Gemini CLI, Codex CLI, GitHub Copilot CLI, Qwen Code, opencode, aider, Amp, Crush, Continue CLI (`cn`), Grok CLI, AIChat, mods, llm (en modo `chat`) y ShellGPT (`sgpt --repl`) si están instalados, y un chat por cada modelo local de Ollama. Claude Code se detecta también fuera del PATH: instalador nativo (`~/.local/bin`), npm y la CLI que trae la app de escritorio de Claude (`%APPDATA%\Claude\claude-code\<versión>\<hash>\claude.exe`, la versión más alta) |

### 2. El inventario detallado

Al abrir Entorno y dependencias se hace además el inventario detallado de cada
distro (shells, gestor de paquetes, herramientas, lenguajes y complementos de
la línea de órdenes): tarda menos de un segundo por distro porque no lanza un
proceso por archivo ni recorre el PATH de Windows que WSL añade (`/mnt/c/...`).
Las órdenes que la app ejecuta dentro de una distro usan `wsl.exe --exec`, que
entrega los argumentos tal cual; con `--` pasarían por la shell de login de la
distro, que expandiría `$variables` antes de tiempo.

### 3. Los REPL de cada distro

Los REPL de una distro se abren con el mismo PATH con el que se detectaron:
`wsl.exe --exec sh -lc '<PATH de login + carpetas de usuario>; exec "$0" "$@"'
<intérprete>` (`wsl::repl_launch_args`). Las carpetas de usuario
(`USER_BIN_DIRS`: `~/.local/bin`, `~/.cargo/bin`, nvm, asdf, mise, volta, bun,
deno…) son las mismas que recorre la sonda y se añaden al final del PATH, así
que lo que configura el usuario manda. Antes el REPL se lanzaba con
`wsl -- <intérprete>` (sin login): en Ubuntu sobre WSL 1 la sonda encontraba
el `node` de `~/.local/bin`, pero el REPL arrancaba el `/usr/bin/node` del
sistema, que WSL 1 no puede ejecutar («Exec format error»), y la pestaña se
quedaba sin prompt. Además, el inventario prueba en paralelo cada intérprete
ELF presente (`timeout 3 sh -c 'exec <ruta> --version'`; solo el código 126,
«no se puede ejecutar», cuenta como roto) y los que no arrancan quedan en
`unrunnable` y no se ofrecen como REPL.

### 4. Cómo se comprueba cada distro WSL

Las distribuciones WSL se comprueban entrando en cada una. La primera orden
arranca la máquina virtual de WSL si estaba parada, así que esa sonda espera
hasta 15 s (y reintenta) antes de marcar una distro «sin comprobar». Si aun así
queda marcada y su pestaña arranca bien, la app vuelve a detectar en segundo
plano y la etiqueta se corrige sola.

### 5. Cambiar de entorno conserva la carpeta

Cambiar de entorno **conserva la carpeta**: si en cmd estás en `C:\proyecto` y
abres WSL, la sesión empieza en `/mnt/c/proyecto`; en Git Bash, en
`/c/proyecto`. La traducción la hace cada shell a partir del directorio con el
que se lanza su proceso, sin escribir ningún `cd`. No se hereda donde no puede
funcionar: contenedores Docker (montan una carpeta fija en `/workspace`),
dispositivos ADB, y rutas UNC como `\\wsl$\...`, que cmd.exe no admite como
directorio actual.

### 6. Kotlin

Kotlin sigue disponible como herramienta instalable y se puede iniciar desde
una shell, pero por ahora no aparece como REPL dedicado: algunos paquetes de
`kotlinc` no cargan el plugin de scripting que necesita `-Xrepl`. Se volverá a
ofrecer en el selector cuando la detección pueda confirmar que ese plugin está
realmente disponible.

### 7. Imágenes, iconos y emoji

La terminal pinta imágenes **Sixel** en línea
(el logo de `fastfetch --logo-type sixel`, `chafa -f sixel`, `img2sixel`…). En
Windows, ConPTY las mide como un VT340 (celda virtual de 10×20 píxeles); cada
imagen se encaja, sin deformarse, en las filas que ha contado ConPTY para que
el texto siguiente no salga desplazado (`src/lib/sixel-conpty.ts`). Las
imágenes iTerm2 no se pintan: ConPTY no las interpreta y desalinearían la
pantalla. Los iconos de Nerd Font que usan fastfetch, starship, oh-my-posh o
eza se ven con cualquier fuente: la app trae la fuente de símbolos de Nerd
Fonts como respaldo y prueba antes la variante Nerd Font de la fuente elegida
si está instalada (también hay «Meslo (Nerd Font)», la de powerlevel10k). Los
emoji usan la fuente de color del sistema y los anchos de Unicode 11, los
mismos que ConPTY, para que una línea con emoji o caracteres CJK se edite sin
descolocarse.

### 8. Un REPL no es una shell

Un **REPL no es una shell**: no recibe alias, y las acciones que escriben
comandos se enrutan a una pestaña con una shell real, abriéndola si hace falta.
Gforth no muestra un prompt inicial por diseño. La terminal conserva su banner y
añade justo debajo una ayuda visible: escribe `1 2 + . cr` y debe mostrar `3`, o
`bye` para salir; responde `ok` después de procesar cada línea. El E2E comprueba
tanto que esa ayuda aparece antes de escribir como el resultado calculado, no
solo que el proceso haya arrancado.

Al abrir cualquier programa, ConPTY pregunta antes dónde está el cursor y qué
sabe hacer la terminal, y espera unos 3 segundos la respuesta. En las shells
contesta la app durante el arranque. En los REPL, desde el 24-11, también: la
app quita esas dos preguntas hasta la primera salida del programa y las
contesta ella (`take_startup_probes` en `terminal/tabs.rs`). La ventana se cierra con lo primero que pase: la pregunta de atributos (la última de ConPTY), la primera salida del programa o 1,5 segundos. Si se cerrara solo con la salida, se comería la pregunta del propio Gemini CLI, que la hace antes de dibujar y se quedaba en negro (build 87). Antes las
contestaba la terminal visible. Si la interfaz iba cargada y tardaba más de
esos 3 segundos, la respuesta le llegaba a Node como texto tecleado
(`> 62;4;9;22c`, build 86). Lo que pregunte después el propio programa lo
sigue contestando la terminal visible.

### 9. Permisos de administrador y NSudo

WTerminal no necesita ser administrador. Las shells **TrustedInstaller de
NSudo** («CMD · TrustedInstaller (NSudo)» y «PowerShell · TrustedInstaller
(NSudo)») sí: NSudo pasa de administrador a TrustedInstaller con todos los
privilegios, pero no sabe pasar de usuario normal a administrador, y sin un
proceso padre elevado termina con `-1`. Para el primer paso hay tres opciones,
y la app usa sola la que haya:

| Opción | Qué hace | Se queda en la pestaña | Qué necesita |
|---|---|---|---|
| Reiniciar como administrador / Iniciar siempre como administrador | Toda la app pasa a administrador y NSudo se abre directo | Sí | Nada; se acepta el UAC |
| gsudo + NSudo | Solo esa pestaña pide el UAC (`gsudo NSudoLC.exe -U:T …`) | Sí | gsudo (Entorno y dependencias → Shells → gsudo, `winget install gerardog.gsudo`) |
| sudo de Windows + NSudo | Lo mismo que gsudo, con el sudo de Windows 11 24H2 | Solo en modo «En línea» | Activarlo en Configuración → Sistema → Para programadores |

#### 9.1 Orden de elección

Orden de elección (`environments::nsudo_launcher`): si WTerminal ya es
administrador, NSudo directo; si no, gsudo si está instalado; si no, el sudo de
Windows en modo «En línea» (los modos «ventana nueva» y «entrada deshabilitada»
no sirven para una pestaña); si no hay ninguno, las entradas de NSudo salen
**deshabilitadas con una nota que explica qué hacer**, en vez de fallar con
`-1`. Un `runas` normal no sirve de puente: Windows abriría el proceso elevado
en una ventana aparte, fuera de WTerminal; gsudo y el sudo «En línea» lo dejan
en la misma consola.

#### 9.2 En Ajustes

En **Ajustes → Comportamiento → Permisos de administrador** se ve el estado
(si WTerminal es administrador, por dónde se abre NSudo y qué hay de NSudo,
gsudo y el sudo de Windows), con:

- **Reiniciar como administrador**: guarda lo pendiente, pide el UAC y abre
  otra copia elevada con los mismos argumentos más `--elevated-relaunch`; si
  se acepta, esta copia se cierra; si se cancela, todo sigue igual.
- **Instalar gsudo**: abre Entorno y dependencias ya filtrado por gsudo.
- **Ofrecer gsudo** (`offerGsudo`, encendido; 14-11, Romen): si NSudo está
  instalado y esta copia no puede abrirlo (no es administrador, ni hay gsudo ni
  el sudo de Windows en línea, `offer_gsudo`), sale abajo la misma barra que
  la de las actualizaciones de WinGet (desde el 17-11), con **«Instalar
  gsudo»** (lanza la acción `winget-gsudo` de WTerminal en una pestaña, a la
  vista), **«Ahora no»** (esta sesión) y **«No volver a mostrar»** (apaga el
  ajuste; se recupera en su casilla o en Ajustes › General › Avisos).
  Nunca sale en las pruebas E2E, donde un aviso que no esperan movería la
  terminal.
- **Reiniciar sin permisos de administrador** (solo siendo administrador): un
  proceso elevado no puede soltar sus permisos y todo lo que lanza los hereda,
  así que `run_unelevated` copia el token del Explorador (la shell del
  escritorio, sin elevar), abre con él otra copia (`CreateProcessWithTokenW`,
  mismos argumentos sin `--elevated-relaunch`) y esta se cierra. Solo se
  habilita con «Sin permisos de administrador» elegido
  (`unelevated_restart_blocker`): con las otras formas la copia nueva se
  volvería a elevar. Si el Explorador también está elevado, lo explica y no
  cierra nada.

#### 9.3 Al abrir WTerminal

**Al abrir WTerminal** es una sola elección con tres formas, excluyentes entre
sí (elegir una quita la otra):

- **Sin permisos de administrador** (de fábrica).
- **Iniciar siempre como administrador** (`startAsAdmin`; lo pide WTerminal):
  al arrancar sin ser administrador se relanza con UAC
  (`StartElevation::should_relaunch`); con el UAC cancelado, se abre sin
  elevar. No se relanza nunca si ya es el relanzamiento (evita bucles), si ya
  es administrador ni en pruebas automáticas (`LTERMINAL_E2E_TESTING` o
  `LTERMINAL_E2E_DISABLE_ADMIN`). Vale para cualquier copia que use esos
  ajustes. Probado en Windows con una cuenta que eleva sin preguntar: la copia
  relanzada tiene token elevado y la primera se cierra.
- **Marcar WTerminal.exe como «ejecutar como administrador»** (lo hace
  Windows): pone la marca de compatibilidad `RUNASADMIN` en este ejecutable,
  solo para el usuario actual (`HKCU\…\AppCompatFlags\Layers`, conservando las
  demás marcas: `layers_with_run_as_admin`). El Explorador muestra el escudo en
  su icono y Windows pide el UAC antes de abrirlo; si se cancela, no se abre.

Las dos formas de abrirlo como administrador elevan lo mismo (toda la app);
cambia quién pide el UAC y qué pasa si se cancela. Volver a «Sin permisos» las
quita las dos, pero la copia en marcha sigue elevada hasta reiniciarla: para
eso está «Reiniciar sin permisos de administrador».

#### 9.4 La carpeta al entrar y salir de NSudo (21-11)

NSudo no hereda la carpeta del proceso que lo lanza: la shell TrustedInstaller
empezaba en la suya y, al volver después a una shell normal, esta heredaba
esa carpeta de sistema. La shell nueva **nunca** heredaba los permisos (se abre
siempre con los de WTerminal), pero sí quedaba en un sitio que no era el del
usuario. Ahora:

- al entrar, WTerminal le pasa a NSudo `-CurrentDirectory:<carpeta>` con la
  carpeta en la que estaba la pestaña (`insert_nsudo_current_directory`);
- la pestaña recuerda la carpeta de antes de elevarse
  (`cwd_before_elevated`) y, al cambiar de NSudo a cualquier shell o REPL,
  vuelve a ella (`cwd_for_switch`);
- una pestaña nueva abierta mientras la activa es NSudo tampoco hereda la
  carpeta elevada (`active_cwd`).

#### 9.5 Shells de administrador con gsudo (21-11)

Con gsudo instalado y WTerminal sin ser administrador, el selector ofrece
además **«CMD · administrador (gsudo)»** y **«PowerShell · administrador
(gsudo)»** (grupo «Shells elevadas · gsudo»): una shell de administrador con la
cuenta del usuario, sin TrustedInstaller. Windows pide el UAC al abrirla y
solo esa pestaña es administrador. Si WTerminal ya lo es, no salen: cualquier
shell normal ya lo es. Si se cancela el UAC, la pestaña lo explica en una
frase («Lo más habitual es que se cancelara el permiso de Windows…») en vez de
cerrarse sin decir nada.

#### 9.6 Acciones del catálogo que necesitan administrador (21-11)

Algunas acciones solo funcionan como administrador: añadir o quitar
capacidades de Windows (OpenSSH), activar características opcionales,
`dism`, instalar o actualizar WSL (`wsl --install --no-distribution`,
`wsl --update`) y las instalaciones para todos los usuarios. El catálogo las
reconoce por su orden (`windows_command_needs_admin`), sin marcarlas a mano,
para que ninguna nueva se quede fuera; la tarjeta lo avisa antes de pulsar
(«Necesita administrador…»). Al lanzarla (`install_run`):

1. si WTerminal ya es administrador, se ejecuta tal cual;
2. si no, se lanza con **gsudo**, o con el **sudo de Windows** en modo «En
   línea»: Windows pide el UAC solo para esa acción y la salida se ve en la
   misma pestaña. Una acción de PowerShell va en un PowerShell aparte (el
   script codificado, con el mismo veredicto de salida que desde cmd);
3. si no hay ninguno, no se escribe nada que vaya a fallar a medias: sale la
   barra **«Esta acción necesita permisos de administrador»** con **«Instalar
   gsudo»**, **«Reiniciar como administrador»** y **«Cerrar»**. No tiene «No
   volver a mostrar» porque responde a algo que el usuario acaba de pedir.

#### 9.7 Cómo se ve que es administrador

Cuando WTerminal se ejecuta como administrador, la barra superior muestra un
escudo pequeño junto al botón de volver a detectar entornos (fuera de los
botones de paneles, que antes desplazaba) y el título de la ventana empieza
por «Administrador:», como en Windows Terminal; el log de arranque lo anota
(`"elevated": true`).

Con toda la app como administrador, **todas** las pestañas lo son y Windows
(UIPI) no deja arrastrar archivos desde el Explorador a una ventana elevada;
por eso la opción viene apagada y gsudo o el sudo «En línea» son la forma de
elevar solo una pestaña. WTerminal solo escribe la marca `RUNASADMIN` de
compatibilidad si se marca su casilla. NSudo se busca en `C:\WSCore\Components\Hooks\NSudo`, en
Program Files, en `C:\Tools\NSudo` y subiendo desde la carpeta de la propia
copia (`platform::windows::nsudo_path`).

#### 9.8 Pruebas

Pruebas: unidad de la elección del lanzador, de los argumentos del
relanzamiento, de la decisión de arranque, del modo del sudo y del citado de
argumentos; el E2E `windows-admin-permissions` (en el recorrido completo y
enfocado con `E2E_WINDOWS_ADMIN_ONLY=1`) compara la sección con el backend,
recorre las tres formas de abrirlo y exige que se excluyan y que volver a «Sin
permisos» quite la preferencia y la marca, que «Reiniciar sin permisos» solo
aparezca siendo administrador, que las entradas de NSudo cuadren con el
lanzador y que el ejecutable acabe sin `RUNASADMIN`, sin pulsar nunca
«Reiniciar» (cerraría la sesión o pediría el UAC); `npm run
e2e:admin` repite el escenario con un token administrativo.

---

## Alias y comandos integrados

### 1. Alias que se inyectan

Se inyectan al crear una pestaña, solo en shells reales.

| Alias | Qué hace |
|---|---|
| `edit`, `ip`, `ll`, `ls`, `pwd` | Vocabulario común a todas las shells reales. El nombre y la intención son iguales; cambia únicamente el comando nativo que hay detrás. |
| `clear`, `cls` | Limpieza real de pantalla e historial; por defecto vuelve a mostrar el fastfetch esencial. Se puede desactivar en Ajustes (`Reimprimir fastfetch al ejecutar clear`). En cmd es una macro de `doskey` con sus órdenes unidas con `&` (escrito `^&` en el `.cmd`, `&` en el archivo de macros): con `$T` cmd pintaba un prompt entre cada orden y se veían un instante antes del banner. |
| `sysinfo` | Reimprime el banner del sistema. |
| `ayuda` | Ayuda explicada: qué hace cada alias, qué gestor los atiende y qué scripts se han registrado. Se lee de un archivo generado por sesión, así que ocupa varias líneas y va traducida. |
| `nsudo` | Solo si el ejecutable existe en la máquina. |
| `install`, `update`, `upgrade`, `uninstall`, `remove`, `search` | Se traducen al gestor de paquetes real del entorno. |
| `:ltools` / `:tools` | Abre la Biblioteca y su catálogo de LTools para descubrir y configurar las acciones fijadas. Las acciones se ejecutan mediante el CLI validado, no como scripts copiados por LTerminal. |

### 2. `ls` y `ll` en Windows

En Windows, `ls` y `ll` entienden las opciones de Unix más habituales, en
cualquier combinación (`ls -la`, `ls -ltr`, `ls -1`): `-a` enseña los ocultos,
`-R` entra en subcarpetas, `-t` y `-S` ordenan por fecha y por tamaño (`-r`
invierte el orden), `-1` da solo los nombres, y `-l`, `-h` y `-d` no cambian
nada porque el listado ya es largo. `ll` es `ls -la`.

- **cmd**: `doskey` no puede leer argumentos, así que `ls` llama a
  `wt-ls.cmd` en la carpeta de sesión (`aliases::CMD_LS_SCRIPT`), que traduce
  las opciones a `dir` (`/a`, `/s`, `/o:-d`, `/o:-s`, `/b`), deja pasar los
  modificadores propios de `dir` (`/w`, `/o:n`…) y cambia `/` por `\` en las
  rutas. Antes `ls -l .cargo` era `dir -l .cargo` y `dir` decía «No se
  encuentra el archivo» por `-l` antes de listar la carpeta.
- **PowerShell**: `ls` es una función (`aliases::POWERSHELL_LS_BODY`); sin
  opciones de Unix es `Get-ChildItem` tal cual, con sus parámetros (`-Force`,
  `-Name`…). La inicialización quita antes el alias integrado `ls` de
  PowerShell: un alias gana a una función con el mismo nombre, y la función
  de WTerminal nunca llegaba a ejecutarse (`ls -la` fallaba con «No se
  encuentra ningún parámetro que coincida con 'la'»).

### 3. Los scripts personales

Los scripts personales detectados siguen apareciendo con sus nombres concretos
en la ayuda de cada sesión; las operaciones de sistema de LTerminal se
mantienen en LTools para evitar duplicados y permitir que el catálogo crezca
sin modificar este proyecto.

### 4. Comandos internos de la aplicación (`:`)

Una línea que empieza por `:` no se entrega a la shell: la interpreta WinSlim
Terminal para consultar o cambiar su propia configuración. Se pueden escribir
en cualquier terminal real; en un REPL se muestran como ayuda y no se inyectan
como código. Los argumentos se separan por espacios y los identificadores no
distinguen mayúsculas de minúsculas.

La [paleta de comandos](#paleta-de-comandos) (`Ctrl+Shift+P`) los ofrece con
búsqueda: los que equivalen a una acción de la aplicación (`:config`, `:panel`,
`:panes`, `:shell <id>`, `:repl`, `:theme`, `:font`, `:language`, `:reload`,
`:explorer-here`) aparecen como esa acción con el comando de pista, y los que
responden en la terminal se teclean en la pestaña activa como si se escribieran.

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
| `:chat` | Muestra u oculta el **chat lateral con los agentes de IA**, una barra a la derecha. `:agentes` es equivalente; también está en la paleta y en su atajo `shortcutToggleAgentChat`. **Cómo funciona:** eliges un agente instalado (Claude Code, Codex, Gemini, Qwen, Copilot, Crush, llm, ShellGPT, mods, AIChat o un modelo de Ollama) y, si quieres, su modelo de una lista que empieza por el que usa de verdad, su intensidad, sus permisos (de fábrica, solo leer) y el modo rápido; escribes y pulsas Intro. Puedes adjuntar archivos de texto y el chat recuerda la conversación (`agentChatRemember`). La CLI se abre una vez, en la carpeta de la pestaña, y recibe la pregunta por su entrada estándar. **Contexto:** con «Incluir la última orden y su salida», el mensaje lleva lo último que pasó en la pestaña (si su shell marca las órdenes con OSC 133) y enseña lo que se mandó. **Respuestas:** cada bloque de código de una línea se puede insertar en la terminal **sin Intro**; los de varias líneas solo se copian. Nada se ejecuta solo. **Cortar:** con el botón, y a los 5 min (30 con Ultracode) se corta solo. **Apagarlo:** `agentChat` en Ajustes. Con las CLI reales está sin probar: las pruebas usan un agente simulado, porque no se mandan mensajes a IA reales. |
| `:set [list [texto]]` | Lista **todos** los ajustes sencillos (sí/no, números y textos) con su valor actual. Con un texto, solo los que lo contienen: `:set list python`. `:ajuste` y `:pref` son equivalentes. |
| `:set <ajuste> [valor]` | Sin valor, enseña el ajuste; con valor, lo cambia. El nombre vale en camelCase o con guiones: `:set actionCommandsAtOnce on` o `:set action-commands-at-once on`. Valores: `on`/`off` (o `sí`/`no`), números y textos. El backend lo valida igual que Ajustes: si no lo acepta, el ajuste se queda como estaba y se dice. Las listas y los objetos (temas, perfiles…) se cambian en Ajustes. Así, cada ajuste, también los nuevos, se puede usar sin ratón. |
| `:panes 1\|2\|3\|4` / `:panes cycle` | Fija o rota el número de terminales visibles en la rejilla, sin cerrar pestañas; `:panes <n>` va directo y solo abre las que falten para llegar a `n`. Con la vista dividida, el botón «Separar» de la tira de pestañas hace lo mismo que `:panes 1`. `:layout` y `:grid` son equivalentes. |
| `:explorer-here` | Abre el gestor de archivos del sistema en la ruta actual de la terminal en Windows o Linux. `:open-here` y `:reveal-here` son equivalentes. |
| `:banner list` / `:banner hide|show|toggle <campo>` / `:banner preset compact\|full` | Consulta o cambia los campos del fastfetch. Los campos son `system`, `host`, `kernel`, `environment`, `motherboard`, `cpu`, `gpu`, `memory`, `storage`, `uptime` y `datetime`. El campo `storage` resume cada unidad en una línea: `Disco  2 unidades - (C:) 250 GB (99%) / (D:) 450 GB (70%)` (letra o ruta de montaje, tamaño y porcentaje de uso; una ruta de más de 20 caracteres se acorta a `…/<carpeta final>`; `system_info::storage_rows`). |
| `:quick-actions list` | Comando heredado: informa de que las acciones fijadas se gestionan desde el catálogo de LTools. `on`, `off` y `toggle` ya no cambian la interfaz. |

### 5. Modo de terminal limpia

`terminalOnlyMode` oculta la barra superior, las pestañas, el explorador visible
y el marco nativo de la ventana. El área de xterm ocupa entonces todo el
espacio disponible, también cuando hay varias terminales divididas. Se activa o
desactiva con `Ctrl+Shift+M` de fábrica (el atajo se puede cambiar en Ajustes),
se guarda en `settings.json` y se reaplica al iniciar, guardar, recargar o
restablecer preferencias. Si una plataforma no permite cambiar sus
decoraciones en caliente, la terminal continúa funcionando y el estado queda
registrado en el log; no se oculta el acceso de recuperación.

La guía inferior del modo limpio muestra el atajo vigente y un botón `Ajustes`
que abre directamente Preferencias aunque la barra superior esté oculta. Se
puede desactivar desde `Ajustes → Comportamiento → Guía visible en pantalla
limpia`; el atajo de recuperación sigue funcionando aunque la guía esté oculta.

Los parámetros de `:terminal` usan valores sencillos: colores `#rrggbb`,
booleanos `on/off`, cursor `block|underline|bar|beam|underline-thick`, peso
`light|normal|medium|semibold|bold` y densidad `compact|comfortable`. Los
valores numéricos se validan y acotan igual que en Ajustes; `settings.json`
sigue siendo la fuente persistente. `:terminal list` y `:help internos` son la
forma más rápida de consultar el estado sin abrir un panel.

### 6. Qué va a la shell y qué no

Todo lo que **no** empieza por `:` sigue siendo una orden de la shell actual.
Ahí entran los alias `clear`, `cls`, `sysinfo`, `edit`, `ll`, `install`, los
alias de scripts y cualquier comando nativo (`git`, `python`, `docker`, etc.).
WinSlim solo los prepara al crear la pestaña y conserva su sintaxis; la shell
decide cómo ejecutarlos y devuelve su salida y código de salida. Por eso
`install git` ejecuta el gestor real del entorno, mientras que `:panel deps`
abre un panel de la aplicación sin escribir nada en cmd o PowerShell.

#### 6.1 El banner inicial

El banner inicial usa **Solo esencial** (5–8 líneas) y se imprime como salida
normal del terminal. `clear/cls` vuelve a mostrar ese fastfetch por defecto; la
preferencia `clearReprintBanner` permite dejar la pantalla limpia sin banner.
Para solicitar todos los campos usa Ajustes o `:banner preset full`; el cambio
se añade al scrollback sin mover la selección ni superponerse al código.

#### 6.2 Imagen a la izquierda del banner

En Ajustes → Terminal, activada de fábrica:
como el logo de fastfetch, a la izquierda del resumen aparece el logo de la app
o una imagen propia (PNG, JPEG, GIF, WebP, BMP, ICO o SVG de hasta 8 MB),
elegida con «Elegir imagen…» o escribiendo su ruta; «Usar el logo de la app» la
quita. El ancho se ajusta entre 8 y 40 columnas (20 de fábrica) y la imagen se
encaja sin deformarse en las filas que ocupe el banner. Cómo funciona sin
desalinear ConPTY:

- El backend compone el banner en lo que queda tras un margen de
  `columnas + 2` espacios (`system_info::banner_image_padding`); esos espacios
  llegan igual a ConPTY y a xterm, así que los cursores siguen en la misma
  fila. Si el panel es tan estrecho que al texto le quedarían menos de 40
  columnas, no hay margen ni imagen.
- La imagen no pasa por ConPTY: es una decoración de xterm
  (`src/lib/banner-image.ts`, `attachBannerImages`) anclada a la línea del
  título, que cubre el margen menos 2 celdas a cada lado (`bannerImageBox`): la
  imagen queda centrada, con el mismo hueco hacia el borde de la ventana que
  hacia el texto, tanto si la limita el alto (banner «Solo esencial») como el
  ancho (banner «Mostrar todo», más alto que ancho, donde antes se pegaba al
  borde izquierdo). El frontend reconoce el banner por su título (`<app> <versión>`)
  precedido de un margen de 10 a 42 espacios (8 a 40 columnas más la
  separación), así que vale igual para el banner inicial, `:banner`, `clear`,
  `sysinfo` y los repintados de ConPTY, y cada banner recibe una imagen del
  ancho de su propio margen. Se desplaza con el texto y desaparece con él (al
  limpiar, al salir del historial o si otra salida lo sobrescribe). No
  intercepta clics ni la selección.
- La imagen propia la lee el backend (`banner_image_read`): solo archivos con
  la firma de un formato de imagen y como mucho 8 MB, entregados como `data:`.
  Si no se puede leer, el banner usa el logo y Ajustes muestra el motivo.
  Una imagen nueva se ve al momento en los banners abiertos; el ancho y
  activarla o desactivarla cambian el margen, así que se aplican al siguiente
  banner (`clear`, `sysinfo`, una pestaña nueva o **Mostrar el banner ahora**,
  que lo reimprime en la pestaña activa), como el resto de ajustes del banner.

#### 6.3 Los alias de gestor de paquetes

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

### 7. Créditos y easter-eggs

En una línea propia de la terminal, `Darkeiser003`, `darkeiser003`,
`@darkeiser003` y `@Darkeiser003` muestran una presentación del desarrollo,
el perfil público y los proyectos [WTerminal](https://github.com/Darkeiser003/Terminal)
y [Infraestructura-Web](https://github.com/Darkeiser003/Infraestructura-Web).
El crédito de colaboradores no se expone como comando ni como easter egg: se
mantiene únicamente en `Ajustes › Información`. No se interceptan órdenes que
contengan nombres de personas como parte de otra línea.

---

## Panel de entorno y dependencias

### 1. Cómo se organiza

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

### 2. Carga por partes y caché de estados

La navegación es modular y no bloquea la ventana: al abrir el panel se carga
únicamente el catálogo de menús y opciones. Cada herramienta se comprueba al
desplegarla; la sonda cubre su familia de acciones y actualiza instalar,
actualizar, comprobar y desinstalar sin recorrer el resto del sistema. Los
estados confirmados se guardan en `install-actions-cache.json` dentro de los
datos de usuario para que la siguiente sesión pueda pintar el estado conocido
de inmediato. **Repetir detección** invalida esa caché y ejecuta la pasada
completa de verificación.

### 3. Solo caminos que existen de verdad

El panel solo ofrece caminos que existen de verdad en ese sistema. El caso
representativo es PowerShell en Linux: Microsoft no lo publica en los
repositorios oficiales de ninguna distribución grande, así que se instala desde
el AUR (`powershell-bin`, con `paru` o `yay`) o desde Snap, y cuando no hay
ninguna de las dos vías se ofrece antes su requisito en lugar de un comando que
se sabe que va a responder «no se ha encontrado el paquete». Wine en Arch avisa
de que vive en el repositorio `multilib`, desactivado de fábrica.

### 4. gsudo en Windows

En Windows, **gsudo** (Shells → gsudo, `gerardog.gsudo`) es opcional: sirve
de puente para abrir las shells de NSudo sin reiniciar WTerminal como
administrador y para `gsudo <orden>` en cualquier shell. Su nota explica que
hace lo mismo que el sudo de Windows en modo «En línea»; ver
[Permisos de administrador y NSudo](#9-permisos-de-administrador-y-nsudo).

### 5. Sugerencias y colores en la línea de órdenes

#### 5.1 Qué herramienta carga cada shell

Se activa en Ajustes → Terminal (activado de fábrica). Como fish o los plugins de zsh en Konsole, la terminal sugiere en
gris lo que ya escribiste (→ para aceptarlo) y colorea órdenes y argumentos.
No lo reimplementa encima de xterm, que chocaría con lo que redibuja la shell:
carga la herramienta de cada una si está instalada. En cmd es **Clink**
(Shells → Clink), que se inyecta en las pestañas de cmd porque arrancan con
`/d` y no pasan por su AutoRun, con un perfil propio de WTerminal
(`%LOCALAPPDATA%` → WTerminal → clink) cuyos valores de fábrica activan las
sugerencias en línea (Clink las trae en una lista con F2) y sus colores
recomendados, sin cambiar el Clink que uses fuera. En PowerShell 7 ya viene de serie
(PSReadLine); Windows PowerShell 5.1 trae PSReadLine 2.0 sin predicciones y
«PSReadLine con predicciones» lo actualiza para tu usuario. En bash se carga
ble.sh (`~/.local/share/blesh`) y en zsh zsh-autosuggestions y
zsh-syntax-highlighting. fish lo trae de serie. Antes de instalar ble.sh en
una distro WSL se comprueban, además del descargador y del extractor, las 18
órdenes que ble.sh exige al cargarse (`BLESH_REQUIRED_COMMANDS`): sin `awk`,
que falta en FedoraLinux-44 recién instalada, `ble.sh --install` no termina
nunca. Si falta algo, la acción lo instala antes con el gestor de la distro
(`apt-get`, `dnf`, `zypper --non-interactive`, `pacman -Syu --needed` o `apk`),
como root o con `sudo`, que pide la contraseña en la propia pestaña, y vuelve a
comprobar (`blesh_prerequisites`). Antes se detenía diciendo qué instalar, y en
Debian, Fedora y openSUSE de WSL recién instaladas no se llegaba a instalar
(13-11). Sin gestor conocido, sigue deteniéndose con lo que falta. Desactivado, no se añade nada
y cada shell conserva su configuración.

**Si falta, se ofrece** (`offerShellAssist`, encendido; 14-11, Romen): cuando la
pestaña activa es de cmd, PowerShell, bash o zsh y a su shell (en WSL, a su
distro) le falta su ayudante según `shell_assist_status`, sale abajo la misma
barra que la de las actualizaciones de WinGet (desde el 17-11): «Esta pestaña
de … no tiene sugerencias ni colores al escribir: falta …», con **«Instalar
…»** (abre Entorno y dependencias ya filtrado, como en Ajustes, para ver y
confirmar lo que se instala), **«Ahora no»** (por shell y distro) y **«No
volver a mostrar»** (apaga el ajuste; se recupera en su casilla o en Ajustes ›
General › Avisos). Si coincide con el de gsudo o con el de WinGet, se
apilan: los que ofrecen instalar algo van encima. Nunca sale en las pruebas
E2E (`e2eTesting` en la información de la app).

#### 5.2 El `PSModulePath` de Windows PowerShell 5.1

Todo Windows PowerShell 5.1 que lanza WTerminal (pestañas y sondas) recibe un
`PSModulePath` depurado (`process::windows_powershell_module_path`): sin las
carpetas de PowerShell 7 y con la de usuario de 5.1
(`Documentos\WindowsPowerShell\Modules`) delante, conservando las rutas
personalizadas. Si WTerminal se abría desde PowerShell 7, heredaba su
`PSModulePath`: la sonda no veía el PSReadLine ya instalado y lo seguía
ofreciendo, y las pestañas de 5.1 cargaban el 2.0 del sistema. Además, si al
pulsar una acción ya no está en la última lista del panel (otra comprobación
la dio por instalada), se busca en el catálogo y se ejecuta igual en vez de
responder «La acción seleccionada ya no existe».

#### 5.3 Aspecto de las sugerencias

Bajo los interruptores: color del texto
sugerido, cursiva, colorear o no órdenes y argumentos, colores de órdenes, de
opciones y argumentos y de una orden que no existe, y predicciones en lista
(solo PowerShell, PSReadLine 2.2+; activadas de fábrica: sin esa versión no
hacen nada y con ella se ven solas). Cada color sin marcar deja el de la
herramienta. `terminal::shell_assist::AssistStyle` lo traduce a cada una: los
`color.*` del perfil de Clink, `Set-PSReadLineOption -Colors` (una clave por
llamada, porque PSReadLine 2.0 de Windows PowerShell 5.1 no conoce las de
predicción), `ble-face`/`bleopt` de ble.sh, `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE` y
`ZSH_HIGHLIGHT_STYLES`. Sin coloreado, zsh-syntax-highlighting no se carga y en
las demás los tokens usan el color normal. Se aplica a las pestañas nuevas.

#### 5.4 Un interruptor por shell, e instalar lo que falta

Bajo esa opción hay un interruptor por shell (cmd, PowerShell, bash y zsh) con
el estado de su herramienta: instalada, no instalada o sin comprobar, en este
sistema o en cada distro WSL. «Instalar» abre Entorno y dependencias ya
filtrado por esa herramienta y «Comprobar de nuevo» repite la detección
(incluido el inventario de WSL). Todo se instala desde el panel:

- **ble.sh** (bash): no está en los repositorios de las distribuciones, así que
  se instala para tu usuario, sin sudo, en `~/.local/share/blesh`, desde una
  versión fijada de su repositorio oficial y comprobando su SHA-256. En Linux
  está en Shells → ble.sh; en Windows, en WSL → ble.sh, una entrada por distro.
  «Actualizar» reinstala la versión verificada de esta versión de WTerminal y
  «Desinstalar» borra la instalación, su caché y su estado. Necesita curl o
  wget y tar con xz, o Python 3: el tar de Ubuntu no puede crear carpetas en
  WSL 1 y entonces se extrae con Python. Dentro de bash, `ble-update` sigue
  disponible para pasar a la última versión nocturna.
- **zsh-autosuggestions** y **zsh-syntax-highlighting** (zsh): con el gestor de
  paquetes de la distribución. Dentro de WSL solo se ofrecen en las distros que
  tienen zsh.

WTerminal los carga desde sus pestañas: no toca tu `.bashrc` ni tu `.zshrc`, y
si ya los cargas tú no se cargan dos veces. La detección del panel, la de
Ajustes y la línea que los carga leen la misma lista de rutas (las de Debian,
Ubuntu, Fedora y openSUSE; las de Arch y Alpine; Homebrew; y `~/.zsh` si los
clonaste a mano), así que lo que se instala es lo que se detecta y lo que se
carga.

### 6. Inteligencia artificial

Tiene su propia sección en el panel:

- **Asistentes en la terminal**: Claude Code (instalador nativo en Windows, npm en
  Linux), Gemini CLI, Codex CLI, GitHub Copilot CLI, Qwen Code, opencode, Amp,
  Continue CLI y Grok CLI (npm), Crush (WinGet en Windows, npm en el resto),
  mods, AIChat y llama.cpp (WinGet), y aider, llm con su complemento de Ollama
  y ShellGPT (pip). Los paquetes se comprobaron en npm, PyPI y en los
  manifiestos de winget-pkgs. Cada uno se abre como una pestaña y usa la sesión
  o los tokens de quien lo ejecuta; la app no llama a ninguna API. Si una IA
  acaba al abrirse pidiendo su clave, la pestaña ofrece guardarla cifrada y
  solo para ella ([Inteligencia artificial en la
  terminal](#inteligencia-artificial-en-la-terminal)). Las vías gratuitas reales son Gemini CLI y Qwen Code (nivel gratuito con
  límites al iniciar sesión), Amp (modo gratuito con anuncios) y los modelos
  locales; Claude no tiene nivel gratuito por API.
- **Modelos locales**: Ollama y LM Studio, y una selección de modelos (Qwen 3.8
  27B, Qwen 3.6, Qwen 3.5, Qwen 3, Qwen3 Coder, Qwen 2.5 Coder, Qwen3 VL, las
  variantes «abliterated» de Qwen 3 de huihui_ai, Gemma 4 y 3, gpt-oss,
  DeepSeek-R1, Llama 3.1/3.2/3.3, Phi-4 y Phi-4 mini, Mistral, Mistral Small y
  Granite 4) que se descargan con `ollama pull`, con los tamaños de
  ollama.com/library. Cada uno indica lo que
  descarga y la memoria que necesita, comparada con la RAM de este equipo. Para
  cualquier otro modelo, incluidas las variantes de la comunidad, basta
  `ollama pull <nombre>` en una pestaña: todo modelo descargado aparece en el
  selector como un chat (`ollama run`). La detección lee los manifiestos de
  Ollama en disco (`OLLAMA_MODELS` o `~/.ollama/models`), sin arrancar nada.
- **Ollama · gestión de modelos**: descargar un modelo por su nombre o abrir su
  chat (la pestaña pregunta el nombre: biblioteca, comunidad o `hf.co/…`), ver
  los descargados (`ollama list`) y los cargados en memoria (`ollama ps`),
  actualizar todos los descargados y arrancar el servidor (`ollama serve`).

### 7. Python: pyreadline3

En Windows, Lenguajes → Python ofrece `pyreadline3 (Python 3.12 o anterior)`:
Tab, historial con Ctrl+R y edición de línea en el REPL. Solo se instala en
Python 3.12 o anterior (pip lo salta en 3.13 o posterior, que ya trae su propio
REPL) y su texto avisa del coste en WTerminal. Los detalles, en [Problemas
conocidos](#problemas-conocidos).

### 8. Cómo se escribe cada acción en la terminal

Cada acción se escribe como **una sola línea** en la terminal. De fábrica aparece
entera de golpe («Escribir de golpe la orden de los botones (no la salida)»,
`actionCommandsAtOnce`, encendido de fábrica desde el 15-11); apagado, se ve
escribir como la repinta la shell. Solo toca **la línea de la orden** que
escribe el botón, nunca la salida de los programas, y solo se nota con Clink
(cmd) o PSReadLine (PowerShell), que repintan esa línea letra a letra; sin
ellos ya sale de golpe. El texto de la casilla lo dice desde el 26-11, porque
Romen la buscaba para que la salida llegara línea a línea. En PowerShell
(desde el 14-11) toda la acción va en `ui-N.ps1` de la carpeta de sesión, en
UTF-8 con BOM, y solo se teclea `. '<carpeta de sesión>\ui-N.ps1'`: el archivo
borra esa línea, pinta la cabecera, ejecuta la orden en la misma sesión (lo que
cambie se queda, como si se hubiera tecleado) y cierra con el veredicto de `$?`
y `$LASTEXITCODE`. Encadenada medía unos mil caracteres y PSReadLine la
repintaba entera a cada tecla: se veía escribir letra a letra aunque la opción
de escribir de una vez estuviera encendida, también al lanzar un `.ps1` de la
Biblioteca, que siempre va a una pestaña de PowerShell. La ruta va entera (no
`$env:WSTERM_UI`) porque una pestaña elevada con NSudo puede no heredar la
variable. En bash, zsh, sh y fish (desde el 16-11) es igual: la acción va en
`ui-N.sh` (`ui-N.fish` en fish), con fin de línea LF y sin BOM, y solo se
teclea `. '<ruta>'` (`source '<ruta>'` en fish), con la ruta como la ve esa
shell: `/mnt/c/…` dentro de WSL y `/c/…` en Git Bash, la misma con la que cargó
su inicializador (`console_ui::sh_framed`, `path_in_shell`). Encadenada, la
línea medía cientos de caracteres y la shell la repetía entera. En bash, zsh y
sh el archivo acaba en `(exit $__wsterm_rc)`, así que el prompt lee el código
de la orden y no el del cierre. En Docker, ADB o Wine la shell no ve la carpeta
de sesión del equipo (`Transport::loads_host_files`) y la acción se sigue
tecleando encadenada. En cmd, donde un `echo` por mensaje dejaba varias órdenes en pantalla, la línea es
`call "%WSTERM_UI%\ui-N-ini.cmd" & <orden real> & call "%WSTERM_UI%\ui-N-fin.cmd"`:
la cabecera y el cierre están en dos archivos de la carpeta de sesión
(`console_ui::cmd_framed`) y el cierre guarda el código real de la orden en
`WSTERM_RC` (también los negativos de WinGet). `&&` y `||` atan más que `&`,
así que una orden compuesta sigue siendo un solo bloque. Si esos archivos no se
pueden escribir, cmd vuelve al formato de varias líneas y las demás shells a la
línea encadenada (`console_ui::ps_framed`, `sh_framed`).

El marco es el mismo en todas: `┌─ VERBO ────…`, el asunto, la orden y
`└────…`, a 60 columnas. En cmd la orden y el asunto van enteros, sin recortar,
porque la línea tecleada se borra y la cabecera es el único sitio donde se lee
la orden; desde el 16-11 lleva también las dos reglas (antes solo «┌─ VER» y
«└»). La forma de reserva de cmd, la tecleada, conserva el marco corto para no
alargar la línea que repite cmd.

### 9. Los scripts de PowerShell lanzados desde cmd

Las acciones que son scripts de PowerShell (las instalaciones con WinGet, por
ejemplo) no viajan dentro de la línea de cmd: cmd no sabe escapar comillas
dentro de comillas, y un `|` o un `>` del script partía la orden («"Out-Null"
no se reconoce» al instalar GitHub CLI desde una pestaña cmd). El script se
escribe en `ps-N.ps1` de la misma carpeta de sesión, en UTF-8 con BOM, y la
orden real es `powershell -NoProfile -ExecutionPolicy Bypass -File
"%WSTERM_UI%\ps-N.ps1"`. El archivo termina con el mismo veredicto que en una
pestaña PowerShell (`$?` y `$LASTEXITCODE` a 0) y sale con un código positivo
si falla, para que `if errorlevel 1` vea también los códigos negativos de
WinGet. Sin carpeta de sesión, el script va en `-EncodedCommand`.

### 10. La pausa al terminar

Al terminar, cada acción espera a que se pulse Enter para que su salida se
pueda leer. «Pulsa Enter…» sale una sola vez: en el pie, y la espera es muda
(`pause >nul` en cmd, `$null = Read-Host` en PowerShell, `read` en bash, zsh y
sh); en fish lo dice su propio `read -P`. Hasta el 16-11 salía dos veces en
todas menos en cmd. El siguiente comando que escriba un panel cierra esa pausa antes de
ejecutarse, para que no se consuma como respuesta.

---

## Proyectos y GitHub

### 1. Anclados

**Anclados** incluye únicamente el perfil fijo
[`Darkeiser003`](https://github.com/Darkeiser003), como referencia del proyecto.
No importa scripts ni repositorios externos de la aplicación y el repositorio interno
de actualización no forma parte de esta lista. Cada persona puede anclar sus
propios perfiles y repositorios, y quitarlos después sin restricciones. Los
créditos de **Ajustes › Información** se configuran por separado del listado de
proyectos.

### 2. El buscador de cada panel

Cada panel tiene un **buscador con lupa** que filtra sin volver a consultar
nada: en **Anclados** acota perfiles y repositorios, y en **Explorar GitHub**
acota el resultado ya descargado, para no gastar peticiones de la API pública
por teclear una letra. Ignora mayúsculas y tildes y admite varios términos en
cualquier orden. `Esc` vacía el filtro sin cerrar el panel.

### 3. Explorar GitHub

**Explorar GitHub** acepta un usuario, `propietario/repositorio` o una URL
HTTPS exacta de `github.com`. Se rechazan SSH, `git://`, hosts alternativos,
credenciales embebidas, puertos y segmentos adicionales.

#### 3.1 El límite de consultas de la API

Las consultas son las públicas de la API (60 por hora). Cuando se agotan
(GitHub responde 403 con el contador a cero, o 429) y `gh` tiene sesión,
WTerminal repite la misma ruta con `gh api --include` y la cabecera dice
«con tu sesión de GitHub: quedan N» (5.000 por hora; las búsquedas, 30 por
minuto). WTerminal nunca lee ni guarda el token: la consulta la hace `gh`
(`github::request_via_gh`). **Ajustes › General › Secciones visibles ›
Consultas de Explorar GitHub** elige *al agotarse* (de fábrica), *siempre* o
*nunca* (`githubSessionMode`). En los E2E, que apuntan a una API local, nunca
se usa `gh`.

### 4. Descargados

**Descargados** lista lo clonado en la carpeta de proyectos y, además, los
repositorios **importados**: **Importar…** acepta la carpeta de un repositorio
(o su `.git`) que ya tengas clonado en otro sitio, sube hasta encontrar `.git`
(también un worktree, donde `.git` es un archivo), lee `origin` y lo enlaza
como `propietario/nombre`. No copia ni mueve nada: se guarda la ruta en
`importedRepositories` y **Quitar de la lista** solo la olvida. Las acciones
(`cd`, actualizar, Gestionar…) resuelven la carpeta en el backend a partir de
lo guardado (`github::local_repository_state`), nunca de una ruta que mande el
panel. Si una pestaña entra (`cd`) en un repositorio de GitHub que no está ni
clonado ni importado, abajo aparece «¿Añadirlo a Proyectos?» con **Importar…**
y **No volver a sugerir** (`dismissedRepositories`); sale solo cuando no hay
otro aviso abajo y se apaga en **Ajustes › General › Sugerir importar
repositorios** (`suggestRepositoryImport`). Hoy solo se importan repositorios
con un `origin` de GitHub.

#### 4.1 Estado de Git

**Estado de Git** (en Descargados) enseña bajo cada repositorio su rama, los
cambios sin confirmar y los commits por delante (↑) o por detrás (↓) según el
último `fetch`. Solo lee (`git status` y la lista de ramas), no consulta la red
y va de tres en tres repositorios. Como las demás acciones, el panel manda el
nombre y el backend saca la carpeta de la misma lista de Descargados
(`git_downloaded_status`).

#### 4.2 Release de cada repositorio

**Release** (en «⋯» de cada repositorio) abre la última release y sus adjuntos
bajo la fila de ese repositorio. Se cierra con «✕», pulsando **Release** otra
vez, al plegar la fila, al abrir la de otro repositorio, al buscar o al
cambiar de pestaña; antes se quedaba al pie del panel en todas las pestañas y
no había forma de cerrarla. El E2E `github-account` lo comprueba contra una API
de GitHub simulada en `127.0.0.1`, a la que la app solo apunta en pruebas
(`LTERMINAL_E2E_GITHUB_API` con `LTERMINAL_E2E_TESTING=1`;
`projects::github::e2e_api_origin` rechaza cualquier otro host).

### 5. Mi GitHub (con GitHub CLI)

La cuarta pestaña del panel trabaja con tu cuenta a través de **GitHub CLI**
(`gh`). WTerminal no guarda tokens ni contraseñas: la sesión es la de `gh`.

#### 5.1 La cuenta, sesión y repositorios nuevos

- **Sin `gh`**, ofrece instalarlo (Entorno y dependencias → GitHub CLI).
- **Iniciar sesión** escribe `gh auth login --hostname github.com
  --git-protocol https --web` en una pestaña nueva y visible: `gh` abre el
  navegador con un código y sus preguntas (`Y/n`) se responden en esa pestaña.
  Una pestaña nueva da la shell por lista en cuanto ve, tras el banner, una
  línea de prompt aunque lleve una orden detrás (`shellPromptAfterBanner`): sin
  eso, un programa que pregunta nada más arrancar dejaba las teclas retenidas
  hasta el seguro de 35 s. **Comprobar de nuevo** lee la sesión
  (`gh api user`); con ella, WTerminal ejecuta una vez `gh auth setup-git` para
  que git use esas credenciales al clonar o actualizar repositorios privados.
- Con sesión se ven la cuenta y sus repositorios (`gh repo list --json …`),
  con las acciones de siempre (clonar, actualizar, `cd`, release, anclar) y,
  en «⋯», **hacer público/privado**, **archivar/desarchivar**, **renombrar** y
  **borrar**. Borrar exige escribir el nombre completo (`propietario/nombre`);
  si falta el permiso `delete_repo`, ofrece **Dar permiso para borrar**
  (`gh auth refresh --scopes delete_repo`, en la terminal).
- **Nuevo repositorio**: nombre, descripción, privado o público, README
  inicial y, si se quiere, clonarlo en la carpeta de proyectos.
- **Cerrar sesión** (`gh auth logout`) también va a la terminal, porque `gh`
  pide confirmación.

#### 5.2 La ficha «Gestionar…»

**Gestionar…** (en «⋯» de cada repositorio de la cuenta) abre bajo su fila
una ficha con doce secciones (`GithubRepoManager.svelte`):

##### 5.2.1 Detalles

Descripción, web, temas, rama por defecto, issues y wiki
(`gh repo view` para leerlos, `gh repo edit` para guardarlos; solo se
añaden y quitan los temas que cambian).

##### 5.2.2 Código

Con `gh api` (`projects/gh_code.rs`): **Archivos** de
cualquier rama o etiqueta (carpetas primero, abrir un archivo de texto;
los binarios se abren en GitHub y los grandes se recortan a 512 KB),
**Commits** de la rama con los cambios de cada uno y **Comparar** dos
ramas o etiquetas, **Ramas** (crear desde la actual u otra, borrar
escribiendo su nombre; nunca la rama por defecto) y **Etiquetas**. Las
rutas del repositorio se validan y se codifican segmento a segmento
(`encode_repo_path`: sin `..`, sin segmentos vacíos ni caracteres de
control).

##### 5.2.3 Releases

La lista (`gh release list`), **Nueva release** con
etiqueta, título, notas o notas automáticas, borrador, prerelease, rama de
destino y **adjuntos** elegidos con el selector o pegando su ruta (`gh
release create … archivos`); **Subir adjuntos…** a una existente (`gh
release upload --clobber`), ver y quitar adjuntos, **Publicar** un
borrador y **Borrar…** escribiendo la etiqueta (con la opción de borrar
también la etiqueta).

##### 5.2.4 Git

(si está clonado): rama, seguimiento (↑ por subir, ↓ por traer),
archivos cambiados, **commit de todo** con mensaje, ramas locales (crear,
cambiar, borrar solo si está fusionada: `git branch -d`). **Subir (push)**,
**Traer (pull)** y **Publicar rama** (`push -u origin <rama>`) van a una
pestaña visible porque pueden pedir credenciales
(`commands::github_git_terminal`).

##### 5.2.5 Pull requests

Las abiertas, **Fusionar** (squash, merge o rebase, y
borrar la rama) y **Nueva pull request** hacia la rama por defecto.
**Ver** despliega la descripción, las etiquetas, los comentarios y los
archivos que cambia; desde ahí se comenta, se cierra o reabre, se pasa
de borrador a **lista para revisar** y se **aprueba** o se **piden
cambios** (con texto obligatorio) (`projects/gh_work.rs`).

##### 5.2.6 Issues

Abiertas, cerradas o todas; crear, cerrar y, con **Ver**,
leer los comentarios, comentar y reabrir.

##### 5.2.7 Actions

Las últimas ejecuciones, **Relanzar lo que falló** (`gh run
rerun --failed`), **Ver log** de los pasos que fallaron (sin colores y
recortado a los últimos 60 000 caracteres, que es donde está el error) y
**Cancelar** las que siguen en cola o en marcha.

##### 5.2.8 Actions: más

En `projects/gh_admin.rs` y `GithubAdmin.svelte`:
**Workflows** (lanzar en una rama con entradas `nombre=valor`, que es `gh
workflow run -f`, y activar o desactivar), **Artefactos** (descargar a
una carpeta con `gh run download` y borrar), **Secretos** (el valor va por
la entrada estándar de `gh secret set`: nunca en los argumentos, la lista
de procesos ni el registro, y no se vuelve a mostrar; se escribe en un
cuadro de varias líneas, tapado salvo con «Mostrar el valor», para que una
clave PEM u OpenSSH conserve sus saltos de línea), **Variables** (con
campos propios: lo escrito en Secretos nunca pasa a Variables) y
**Entornos**.

##### 5.2.9 Configuración

**Colaboradores** (invitar y quitar; en un repositorio
de la cuenta personal GitHub da siempre lectura y escritura, así que no se
ofrecen permisos más finos y el panel lo dice),
**Webhooks** (crear uno https para push, ping y borrar), **Claves de
despliegue** (solo claves públicas SSH, de solo lectura o no), **Pages**
(activar desde una rama y `/` o `/docs`, desactivar; sin activar se
explica en vez de fallar) y **Protección de ramas** (exigir pull request
con N revisiones, también para administradores, historial lineal;
quitarla). Al leer una rama el formulario se rellena con lo que tiene, y
«Proteger» lee antes la protección actual y conserva lo que el panel no
gestiona (comprobaciones obligatorias, CODEOWNERS, restricciones, force
push, borrado…): el PUT de GitHub sustituye la protección entera.

##### 5.2.10 Seguridad

Alertas abiertas de Dependabot, code scanning y secret
scanning, y activar o desactivar las alertas de vulnerabilidades. Si un
tipo de alerta no está activado, se dice en vez de fallar.

##### 5.2.11 Comunidad

El perfil de comunidad (porcentaje de salud, README,
licencia, CONTRIBUTING, código de conducta y plantillas).

##### 5.2.12 Cuenta

El perfil, las claves SSH (añadir y borrar) y las GPG de la
cuenta.

##### 5.2.13 Vista grande

Con el botón ⤢, la ficha deja el panel estrecho y ocupa la ventana
bajo la barra, con cualquier tamaño de interfaz.

##### 5.2.14 Permisos que pide y lo que se valida

Lo que pide un permiso que `gh auth login` no concede (claves de la cuenta,
webhooks, lanzar workflows) avisa con «Pedir permisos», que abre `gh auth
refresh --scopes admin:public_key,admin:gpg_key,admin:repo_hook,workflow` en
una pestaña visible (`TerminalAction::GrantAdmin`). Cada operación es una
orden `gh` con método y ruta fijos (`list_args` y `action_plan`), con el
repositorio del listado de la cuenta y cada campo validado: nombres de
secretos sin `GITHUB_`, usuarios de GitHub, webhooks solo https, claves
públicas en una línea (nunca una privada), ramas con las reglas de git.

#### 5.3 Reglas comunes de «Gestionar…»

En «Gestionar…» rigen las mismas reglas (`projects/gh_manage.rs`,
`projects/git_local.rs`): argumentos fijos y validados (ramas y etiquetas con
las reglas de git y sin guion delante, temas en minúsculas, web http(s),
adjuntos con ruta absoluta, existentes y sin `#`), lo que se lee de `gh` se
sanea (una URL que no es de github.com no llega al panel) y solo se actúa sobre
repositorios del listado de la cuenta. La carpeta de la copia local la calcula
el backend (`<proyectos>/<propietario>/<nombre>`), nunca el panel. Crear una
release con adjuntos o subirlos tiene 30 minutos de margen; lo demás, 45 s.

#### 5.4 Seguridad

Seguridad (`projects/gh_cli.rs`): las órdenes son `gh` con argumentos fijos,
sin shell de por medio; los nombres nuevos siguen las reglas de GitHub y no
pueden empezar por guion (`gh` lo tomaría como una opción); solo se cambia,
renombra o borra un repositorio que haya salido del listado de la propia
cuenta en esta sesión. `gh` se busca en el PATH, que se resincroniza con el
del sistema, así que se encuentra nada más instalarlo. Pruebas: unidad del
parseo, la validación y los argumentos (también de cada orden de
«Gestionar…»), git de verdad en una carpeta temporal (commit, estado y ramas)
y el E2E `github-account` con un `gh` simulado que anota cada llamada; las de
«Gestionar…» se comparan argumento a argumento, porque Rust cita a su manera
los argumentos de un `.cmd`.

### 6. Dos formas de actualizar un repositorio

Cada tarjeta de repositorio ofrece las dos, y cada botón dice en su título
exactamente qué va a hacer:

| Botón | Qué actualiza | Para quién |
|---|---|---|
| **Actualizar release** | Descarga el archivo de la última release que corresponde a este sistema y lo extrae. No toca git. | Quien solo quiere **usar** la herramienta. |
| **Clonar** / **Actualizar fuente** | `git clone` la primera vez y `git pull --ff-only` después. | Quien quiere el **código**. |

**Actualizar release** elige el adjunto por él: no hay que abrir la lista y
reconocer cuál de los archivos es el propio. La elección es por puntos, no por
una regla rígida, porque cada proyecto nombra sus adjuntos a su manera
(`WTerminal-Latest.zip`, `LTerminal-AppImage-Latest-x64.x86.tar.gz`…), y
descarta de entrada los que llevan el nombre de otro sistema: un `.zip` que
diga `linux` no se ofrece en Windows. Si nada encaja **no se descarga nada a
ciegas**: se avisa de que hay que elegir a mano en **Release**.

### 7. Clonar y actualizar el código

La primera acción ejecuta `git clone`; si el destino ya contiene el mismo
repositorio, las siguientes usan `git pull --ff-only`. Ambos comandos se
escriben y ejecutan en una pestaña visible. La estructura local es
`<carpeta>/<propietario>/<repositorio>`. Un directorio existente que no sea un
repositorio se trata como conflicto y **nunca** se sobrescribe.

### 8. Releases

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

### 1. Dos ámbitos

Dos ámbitos:

- **Biblioteca**: carpeta persistente elegida por el usuario. Las acciones de
  sistema de LTools aparecen en su apartado independiente y no se mezclan con
  los archivos personales.
- **Aquí**: directorio actual de la pestaña y hasta tres niveles de
  subdirectorios por defecto, configurable entre 0 y 10. **No** crea alias ni
  modifica la shell.

### 2. Topes del escáner

El escáner mantiene topes de tiempo, carpetas y resultados (máximo 500) para no
bloquear la terminal, y omite dependencias, VCS, cachés y artefactos
(`node_modules`, `dist`, `build`, virtualenvs…).

### 3. Qué tipos de script reconoce

Reconoce `.cmd`, `.bat`, `.ps1`, `.vbs`, `.sh`, `.bash`, `.zsh`, `.ksh`,
`.fish` y scripts sin extensión con shebang. Los runtimes (`.py`, `.js`,
`.mjs`, `.rb`, `.php`, `.pl`, `.lua`, `.r`, `.groovy`) solo aparecen cuando
declaran intención de ejecución: shebang, `package.json#bin`, bit ejecutable o
carpeta `scripts`/`bin`/`tools`/`cli`.

### 4. El buscador

El panel tiene el mismo **buscador con lupa** que Proyectos, y actúa sobre el
último escaneo: filtra por nombre, subcarpeta o extensión sin volver a recorrer
el disco, que en **Aquí** puede costar segundos.

### 5. Acceso rápido

La sección **Acceso rápido** aparece encima de los resultados de la Biblioteca
y de **Aquí**. La estrella conserva hasta 50 scripts, aunque estén en otra
carpeta o el filtro de tipos actual no los incluya; los que ya no existen se
retiran automáticamente. Así las herramientas de uso diario siguen a un clic
sin convertir la Biblioteca en un segundo explorador.

#### 5.1 Lo que pasó con las Operaciones rápidas

Las antiguas **Operaciones rápidas** basadas en nombres de scripts ya no se
muestran como un segundo menú. Los scripts siguen disponibles individualmente
en la Biblioteca y el comando heredado `:quick-actions` solo muestra una ayuda
de migración; no modifica preferencias ni oculta controles.

### 6. Acciones de LTools

Si encuentra `ltools-cli`, `ltools`, `winslim-tools`, una AppImage/EXE versionada
de Tools o su variante Windows en el `PATH`, en las carpetas de instalación
convencionales (`~/.local/bin`, `~/.local/share/ltools`) o en el checkout/release
local de `Darkeiser003/Tools`, la Biblioteca muestra un único apartado de
**Acciones fijadas de LTools**. También admite `LTOOLS_PATH` para una instalación en
otra ubicación. Solo inspecciona carpetas candidatas y nombres conocidos; no
recorre el HOME completo ni ejecuta archivos encontrados sin validar su
catálogo.
En Windows busca `wtools-cli.exe` (el nombre que publica la release de
WTools), en `Program Files\WTools` (instalador) y en carpetas portables
`WTools-<versión>`; la GUI `wtools.exe` no se usa porque exige elevación y no
puede consultarse desde una terminal no elevada.
Si hay varias copias, manda `LTOOLS_PATH`, después el `PATH` y, entre las
encontradas en carpetas conocidas (incluido el `Tools-main` que deja el
«Download ZIP» de GitHub), la más reciente: al actualizar Tools la Biblioteca
no se queda con una release antigua descargada antes.

#### 6.1 Preparada para que Tools cambie

La terminal está preparada para que Tools cambie sin tocarla: los campos
nuevos del catálogo se ignoran, una acción que esta versión no entiende se
descarta sola (queda anotada en el registro) sin vaciar las demás, y un
catálogo de más de 1000 acciones se recorta en vez de rechazarse. El catálogo
se lee entero aunque ocupe decenas de KB (el de WTools 1.0.0 son 72 KB y 75
acciones): `process::run_with_timeout` vacía la salida mientras el proceso
corre. Antes solo la leía al terminar, el CLI se quedaba bloqueado escribiendo
en la tubería llena y la Biblioteca decía «LTools no respondió». El plazo es de
15 s porque la primera ejecución de un `.exe` recién actualizado puede esperar
al antivirus.
Lee el catálogo versionado `ltools-actions-v1` mediante
`actions list --format json` y transmite el idioma activo como `--lang <idioma>`;
el CLI publica `id`, `actionKey`, `scope`, `operation`, `category`, `group`,
`command`, `args`, `target`, `mutating`, `profile`, confirmación y alias.
También puede publicar `label`, `shortLabel`, `description` y `quick`; son
metadatos de presentación opcionales, con fallback seguro si faltan o no son
válidos. `actionKey` identifica la acción de forma estable, mientras `scope` y
`operation` permiten presentar nombres claros aunque varias acciones compartan
un título. LTerminal no duplica nombres ni separa cadenas de comandos a mano. El usuario puede elegir
tantas acciones sin objetivo obligatorio como quiera y la selección se guarda
por perfil y sistema. Las acciones nuevas compatibles aparecen sin modificar
LTerminal; las que tienen un objetivo (disco, servicio, usuario,
etc.), una shell distinta o argumentos no compatibles se excluyen del panel de
botones seguros para no inventar parámetros; las que modifican el sistema piden
confirmación. La E2E optativa comprueba también
que la selección sobrevive a cerrar y reabrir la Biblioteca. También puedes
abrir esta misma configuración desde **Ajustes → Comportamiento** o escribiendo
`:ltools` / `:tools`; ambos accesos llevan al único selector compartido.

#### 6.2 Al pulsar una acción

Al pulsar una acción, LTerminal vuelve a consultar el catálogo, valida el ID y
escribe `ltools actions run <id>` con argumentos separados en una shell visible.
No ejecuta comandos arbitrarios recibidos desde la interfaz ni oculta la salida.
La orden lleva el mismo marco que el resto de acciones (cabecera «Ejecutar ·
LTools · …» y cierre con cómo acabó, ver [Cómo se escribe cada acción en la
terminal](#8-cómo-se-escribe-cada-acción-en-la-terminal)) y respeta «Escribir de
una vez las órdenes de las acciones». En PowerShell la ruta va con el operador
de llamada (`& 'C:\…\ltools.exe' actions run <id>`): entre comillas y sin él,
PowerShell la tomaba por un texto y daba «token inesperado».
Si LTools no está instalado, **Obtener LTools** consulta la última release
estable de `Darkeiser003/Tools`, elige el paquete CLI de la plataforma, lo
descarga mediante los hosts permitidos y deja la AppImage ejecutable cuando
corresponde. Después vuelve a escanear las rutas locales. Si GitHub todavía no
ha publicado ninguna release o no hay un paquete compatible, abre el repositorio
para que la instalación manual sea explícita; mientras tanto, la Biblioteca
mantiene visible el estado y el botón de obtención para que el usuario sepa qué
falta, sin ejecutar descargas silenciosas.

### 7. El filtro de tipos

El filtro de tipos se adapta al sistema. En Linux aparecen primero
SH/Bash/Zsh, Fish y paquetes Linux, que son los tres valores de fábrica; en
Windows, CMD/BAT, PowerShell y VBScript ocupan esas posiciones. Python,
Node.js, otros runtimes, programas, HTML, imágenes, audio y vídeo siguen
siendo opt-in, así que activar la vista nunca convierte **Aquí** en un
explorador de todos los archivos.

En el panel, la sección se titula **Archivos** (el buscador por nombre, el
filtro y la lista) y el filtro es el desplegable **Tipos de archivo** de
debajo. Hasta el 16-11 el título de la sección también decía «Tipos de
archivo» y salía dos veces seguidas.

### 8. Dónde se ejecuta un script

Al ejecutar un script, la aplicación reutiliza una pestaña compatible o abre
una nueva (PowerShell para `.ps1`, cmd/PowerShell para `.cmd`, la shell
correspondiente para Bash, zsh o fish). Las rutas se traducen para Git Bash,
WSL y los montajes Docker. HTML y multimedia se abren con la aplicación externa
predeterminada y nunca dentro de la ventana de la aplicación.

---

## Explorador de archivos

### 1. Qué es

`🗀` en la barra de pestañas (o `Ctrl+Shift+E`) abre un panel lateral con el
contenido del directorio actual de la pestaña, que sigue al `cd` de la terminal
hasta que se navega a mano.

### 2. Qué permite

Permite subir de directorio, entrar en subcarpetas, crear carpetas y archivos
vacíos, renombrar, copiar, cortar, pegar, enviar a la papelera, copiar la ruta,
abrir un archivo con la aplicación predeterminada y llevar la terminal a la
carpeta que se está viendo.

### 3. Calcular tamaño

**Calcular tamaño** (menú de una carpeta) suma lo que hay dentro, subcarpetas
incluidas, y lo enseña en su fila y con el número de archivos. No sigue enlaces
ni uniones (apuntan a otra parte del disco y una unión puede formar un ciclo),
salta lo que no se puede leer y se para a los 15 s o a las 300 000 entradas:
entonces sale «≥», porque es un mínimo.

### 4. Crear, con límites

Crear algo solo se admite dentro de la carpeta mostrada: el nombre no puede
contener separadores, `..`, caracteres de control ni los nombres reservados de
Windows, y nunca se sobrescribe nada existente.

### 5. Abrir en el explorador del sistema

**Abrir en el explorador del sistema** (menú contextual de la terminal o
`:explorer-here`) lanza el explorador del sistema en la ruta actual, que es
distinto de entrar en ella dentro del panel. En Linux se lanza el gestor del
escritorio en uso, deducido de `XDG_CURRENT_DESKTOP`: Dolphin en KDE, Archivos
en GNOME, Thunar en Xfce, Nemo, Caja o PCManFM según el caso. **No se delega en
`xdg-open`** porque la asociación de `inode/directory` apunta en muchos
escritorios a un emulador de terminal, y pedir «abrir carpeta» acababa abriendo
una terminal. Si no se puede deducir el escritorio y hay varios gestores, se
pregunta; si no hay ninguno, se ofrece instalar uno.

### 6. Sigue a la pestaña activa

El panel sigue automáticamente a la pestaña activa y a los cambios de carpeta
detectados en su prompt (`cd`, `Set-Location`, etc.). Si se navega manualmente
por otra carpeta, esa vista se conserva hasta volver a enfocar la terminal o
pulsar «Seguir»; al cambiar de pestaña siempre se carga su directorio real.

### 7. Visores de archivos

Si al abrir un archivo el sistema no tiene ninguna aplicación asociada, la
aplicación propone instalar un visor adecuado al tipo de contenido y **espera
confirmación**. En Windows se usan ImageGlass, VLC, SumatraPDF, 7-Zip y Visual
Studio Code; en Linux sus equivalentes del gestor de paquetes. Los mismos visores están en el
panel de dependencias para instalarlos sin esperar a que algo falle.

---

## Pestañas, división y ciclo de vida

### 1. Pestañas nuevas y división

`+` crea otra sesión del entorno activo. `▥` (o `Ctrl+Shift+\`) va añadiendo
sesiones a la vista: dos en columnas, tres con la tercera ocupando la fila
inferior, cuatro en cuadrantes. Al llegar a cuatro, el botón vuelve a dejar
una sola. Cada panel sigue siendo una pestaña normal; la que tiene el foco se
distingue por un borde de acento.

El **clic central** (la rueda) sobre una pestaña la cierra, igual que en los
navegadores. Funciona igual en las pestañas del chat con IA (21-11).

### 2. Renombrar una pestaña

Para **renombrar una pestaña**: doble clic sobre ella, `F2` con la pestaña
enfocada o la paleta de comandos. Intro guarda, `Esc` cancela y un nombre vacío
devuelve el del entorno. El nombre sigue ahí al cambiar de shell, pero solo dura
mientras la pestaña está abierta.

### 3. El menú de la pestaña

El **menú de la pestaña** (clic derecho, tecla de menú o `Mayús+F10` con la
pestaña enfocada) reúne renombrar, un **color** que marca su borde izquierdo
(ocho colores o ninguno), **sacarla de la vista dividida** sin cerrarla ni tocar
las demás, o **verla junto a la pestaña activa** si no se ve, y cerrarla. Las
flechas recorren el menú y `Esc` lo cierra sin cambiar nada. Como el nombre, el
color dura mientras la pestaña está abierta.

Cada opción lee qué pestaña es **antes** de cerrar el menú: «Renombrar» y
«Cerrar pestaña» lo hacían después, cuando la pestaña del menú ya no existía, y
no hacían nada (14-11, Romen: «la función de renombrar pestañas no funciona»).
La prueba `tab-tools` renombra también desde el menú.

### 3.1 Pestañas ocupadas: nombre, color y aviso al terminar (26-11)

**Qué es.** Cuando lanzas algo que tarda (`journalctl -f`, `npm run dev`,
`ping -t`, `cargo build`…), lo normal es irse a otra pestaña. Para no perder
la de la orden, WTerminal le pone sola **el nombre de la orden** y **un
color** mientras corre, y **avisa al terminar** diciendo de qué pestaña viene.

**Cómo funciona.**

- **Cuándo:** si la orden lleva más de 5 segundos (10 con el modo de bajo
  consumo, que va más lento). Los dos tiempos se cambian en Ajustes > Terminal.
  Necesita las marcas de órdenes (cmd, PowerShell, bash, zsh y fish).
- **El nombre:** el programa y, si solo no dice nada, lo que hace:
  «journalctl», «npm dev», «docker logs», «cargo build». Sin rutas ni `.exe`;
  `sudo`, `time` o `VAR=x` delante no cuentan. Al terminar vuelve el nombre de
  siempre y queda unos segundos una marca: ✓ si salió bien, ✕ si falló.
- **El color:** primero tus reglas («principio de la orden=color», por ejemplo
  `kubectl logs=pink; ping=yellow`), luego el color de su tipo y, si no se
  reconoce, uno por turno (nunca el rojo, que es el de los fallos). Los tipos
  de fábrica: registros que no paran en azul, servidores y modo desarrollo en
  verde, compilaciones y pruebas en naranja, instalaciones en morado y red en
  cian. Cada tipo tiene su desplegable en Ajustes.
- **Lo puesto a mano manda:** un nombre o un color elegidos en el menú de la
  pestaña nunca se tocan.
- **Excepciones:** editores, paginadores, monitores, otras shells, sesiones
  remotas e IA (`vim`, `less`, `htop`, `ssh`, `claude`…) duran pero se están
  usando: solo cambian el nombre, sin color, sin aviso y sin vigilancia. La
  lista se edita en Ajustes.
- **El aviso al terminar:** si la orden tardó al menos 10 segundos (20 en bajo
  consumo). Si la pestaña se ve, sale dentro de ella, como siempre. Si no, sale
  abajo en la ventana: «journalctl terminó en 3 min · pestaña 2 (cmd)», con
  **Ir a la pestaña**, **Cerrar** y **No volver a mostrar** (se recupera en
  Ajustes > Avisos). Si WTerminal no está delante, además parpadea en la barra
  de tareas.
- **Vigilar las que siguen en marcha:** con dos o más, la barra de pestañas
  enseña el botón **En marcha · N**, y la paleta tiene «Ver juntas las órdenes
  en marcha»: las junta en la vista dividida, hasta cuatro, la más reciente
  primero. Con «Al entrar en una pestaña ocupada, verla junto a las demás»
  (apagado de fábrica, porque cambia lo que ves) basta con pulsar una.
- **Separarse al terminar:** la que termina sale de esa vista a los 5
  segundos, salvo la que estás mirando, para no quitarte el resultado de
  delante. Una vista dividida hecha a mano no se toca.

**Dónde vive.** La parte pura (nombre, tipo, color, casillas) está en
`src/lib/busy-tabs.ts`, con sus pruebas en `scripts/test-frontend-logic.mjs`.
El estado vive en `appState` (`busyTabs`, `startBusyTab`, `finishBusyTab`,
`watchRunningTabs`). `TerminalPane` arranca la cuenta al pulsar Intro sobre un
prompt marcado, o cuando un botón escribe una orden, y la cierra con la marca
`D` de fin de orden. Todo tiene su ajuste en el grupo «Pestañas ocupadas y
avisos al terminar» de Ajustes > Terminal.

**Límites.** Dentro de WSL o SSH solo se sabe el nombre si esa shell tiene la
integración de WTerminal. El aviso de la ventana no es una notificación de
Windows: para eso haría falta registrar la app en el sistema.

### 4. Órdenes escritas (buscar en lo tecleado)

**Órdenes escritas** (`Ctrl+Shift+R`, se cambia en Ajustes, o la paleta): un
buscador con lo que se ha escrito en todas las pestañas, la última primero, que
acepta varias palabras en cualquier orden. Intro deja la orden escrita en el
prompt de la pestaña activa **sin ejecutarla**; solo lo hace si la línea está
vacía, como la paleta. Solo se guarda lo tecleado sobre un prompt que la shell
marca con OSC 133 (cmd, PowerShell y bash, con «Marcar dónde empieza y acaba
cada orden» activado): lo que se escribe mientras corre una orden, como la
contraseña de `sudo` o un `Read-Host`, no llega con prompt y nunca entra. Vive
en memoria y se pierde al cerrar WTerminal; cada shell sigue guardando su
propio historial.

### 5. Cambiar de entorno

Cambiar de entorno no es instantáneo (una distro WSL en frío o una imagen
Docker tardan segundos), así que el panel muestra un aviso **Cargando a:
_entorno_** con un indicador en movimiento, y lo retira en cuanto la sesión
nueva da señales de vida. Si el sistema pide reducir el movimiento, el aviso
late en vez de desplazarse.

### 6. Al terminar la shell

Al terminar la shell (`exit`, Ctrl+D) **la pestaña se cierra sola**, y con la
última se cierra la aplicación. Las excepciones son las sesiones que acaban con
un código distinto de cero sin haber llegado a arrancar; ahí la pestaña se queda
con el motivo a la vista:

- una shell que muere en los primeros 3 segundos;
- un REPL (Python, Node, Elm…) que muere en los primeros 15 segundos (dentro de
  WSL, en el primer minuto, lo que tarda WSL en rendirse);
- una IA de terminal (`ai:*`), tarde lo que tarde. Casi siempre sale así porque
  le falta la clave o la sesión, y antes de decirlo puede tardar mucho mirando
  actualizaciones o la red (Grok tardó 16 s con el equipo cargado). Con la
  pestaña abierta se ve su mensaje y el aviso para meter la clave
  (`aiKeyOffer`).

### 7. Desplazarse: vertical y horizontal

La rueda del ratón desplaza verticalmente el scrollback de xterm. Para recorrer
una línea larga sin partirla, mantener pulsado `Shift` mientras se gira la rueda
desplaza horizontalmente el panel; el indicador `›` avisa cuando todavía hay
contenido hacia la derecha. Al escribir o recibir salida, el cursor vuelve a
mantenerse visible automáticamente.

### 8. El menú contextual de la terminal

El menú contextual de la terminal (clic derecho) ofrece copiar, cortar
entrada, borrar entrada, pegar, **buscar**, **guardar la salida**, **copiar la
salida de la última orden** y Ajustes, cada uno con su atajo a la vista
(Ctrl+Shift+C, Ctrl+Shift+X, Supr, Ctrl+Shift+V, el de buscar de Ajustes), para
que nadie tenga que sabérselos:

- **Guardar la salida…** escribe todo el historial de la pestaña en el archivo
  que se elija en el diálogo del sistema, con las líneas partidas unidas. Con
  una IA o un editor a pantalla completa se guarda la terminal normal, no esa
  pantalla.
- **Copiar la salida de la última orden** copia solo lo que escribió, sin el
  prompt ni la orden. Hace falta que la shell marque sus órdenes (ver
  [Marcas de orden](#marcas-de-orden)).

- **Buscar «…»**: con texto seleccionado abre la búsqueda de la terminal con
  esa selección ya escrita (la primera línea con texto, hasta 200 caracteres)
  y resalta las coincidencias; sin selección abre la búsqueda vacía.
- **Cortar / borrar entrada** actúan sobre cualquier parte de lo que se está
  escribiendo, no solo sobre lo que toca el cursor: en `echo "Hola, soy Romen"`
  se puede seleccionar `Hola, soy Romen` y cortarlo. La app reconoce dónde
  acaba el prompt (cmd, PowerShell, bash/zsh, starship…; si no, desde donde
  empezó a teclearse), lleva el cursor de la shell al final de la selección
  con flechas y manda un retroceso por carácter (`src/lib/input-selection.ts`,
  `inputSelectionEdit`): cuenta caracteres, no celdas, para que un emoji o un
  carácter CJK no descoloquen la edición. El cursor de la shell queda donde
  estaba la selección, así que lo que se escriba después entra ahí. Con una
  selección así, **Retroceso** y **Supr** también la borran, como en un
  editor. En programas sin prompt reconocible (nano, un REPL) basta con que la
  selección toque el cursor. La salida histórica no se puede reescribir, solo
  copiar o buscar.

### 9. Sin el menú del navegador

Donde la app no pone un menú suyo (la barra de pestañas vacía, la cabecera,
los márgenes de los paneles), el clic derecho ya no saca el menú del navegador
interno («Atrás», «Actualizar», «Guardar como», «Imprimir»): no sirve en una
aplicación de escritorio y «Atrás» o «Actualizar» podían recargar la
interfaz. Se deja solo donde ayuda: en un campo de texto (cortar, copiar,
pegar) y sobre texto seleccionado (copiar). Lo decide
`src/lib/browser-context-menu.ts` (`keepsBrowserContextMenu`), que `main.ts`
instala al arrancar; los menús propios (terminal, pestañas, explorador) deciden
antes y no pasan por ahí.

---

## Atajos de teclado

### 1. Cómo se resuelven

Los atajos se resuelven en una única captura global, antes de que el textarea
oculto de xterm reciba la tecla. Hay treinta y cinco acciones configurables en
Ajustes (`Ajustes › Atajos`); las acciones sin valor
se muestran como disponibles pero no secuestran ninguna tecla. Los valores se
guardan normalizados y se comparan por `KeyboardEvent.code` cuando la tecla
tiene una representación física ambigua.

### 2. Cambiar o quitar un atajo

Para desasignar un atajo, también uno de fábrica como `Ctrl+Shift+T` o
`Ctrl+Shift+P`, pulsa «×» junto a su campo (o `Retroceso`/`Supr` con el campo
enfocado). El campo vacío se guarda tal cual en `settings.json`
(`"shortcutNewTab": ""`) y sigue vacío tras reiniciar; la acción sigue a mano
por sus otras vías si las tiene (botón, paleta de comandos o comando `:`). La
paleta solo se abre con su atajo: sin él no aparece hasta que se le asigne
otro. En cambio, un valor que no forma un atajo (una tecla sin modificador, un modificador
repetido, una tecla desconocida) o que no es texto vuelve al de fábrica al
cargarse, igual que una clave que falte en un perfil antiguo. Si «Modo
terminal limpia» se queda sin atajo, la guía de ese modo indica `:settings`
como salida en lugar de anunciar un atajo que ya no existe.

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+P` | Abrir o cerrar la [paleta de comandos](#paleta-de-comandos) (también desde un campo de texto) |
| `Ctrl+Shift+F` | Buscar en el historial de la terminal |
| `Ctrl+Shift+R` | Buscar en las órdenes escritas y volver a escribir una sin ejecutarla |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down` | Ir a la orden anterior o siguiente ([marcas de orden](#marcas-de-orden)) |
| `Ctrl+Shift+T` | Nueva pestaña del entorno actual |
| `Ctrl+Shift+E` | Mostrar u ocultar el explorador de archivos |
| `Ctrl+Shift+Backslash` | Añadir una sesión a la vista dividida (o volver a una) |
| `Ctrl+Shift+C` | Copiar la selección |
| `Ctrl+Shift+V` | Pegar |
| `Ctrl+Shift+X` | Cortar la entrada seleccionada |

### 3. Moverse entre paneles

Los defaults de navegación de panel son `Ctrl+Alt+←` (izquierda),
`Ctrl+Alt+→` (derecha), `Ctrl+Alt+↑` (arriba) y `Ctrl+Alt+↓` (abajo), y solo
actúan con la pantalla partida (22-11). Quien tuviera de fábrica
`Ctrl+A/D/W/S`, `Alt+flechas` o `Ctrl+Alt+H/J/K/L` pasa a estos al abrir la
app; un juego propio se respeta. También se pueden asignar acciones
sin default: abrir un panel concreto, cerrar panel, refrescar entornos, seguir
la ruta de la terminal, llevar la terminal a la carpeta del explorador, limpiar
terminal y abrir el explorador del sistema.

### 4. Los atajos sin tecla de fábrica

Desde el 12-11 también se pueden asignar, sin tecla de fábrica para no chocar
con las shells:
- cerrar la pestaña;
- renombrarla;
- copiar la salida de la última orden;
- guardar la salida en un archivo;
- agrandar, achicar o devolver a su tamaño de fábrica la letra de la terminal.
  Va de 10 a 24 px, igual que `:terminal font-size +|-`.

Todas están también en la paleta. «Limpiar terminal» escribe `clear`
en la shell activa, como si se tecleara, solo si el prompt está vacío; no actúa
en un REPL ni en un asistente. Un cambio de atajos debe probarse
con foco en terminal, input de ajustes y panel lateral: cada contexto tiene que
conservar su propia edición.

### 5. Enlaces en la salida

Las direcciones `http://`, `https://` y `file://` que aparecen en la salida, y
los hipervínculos OSC 8 que escriben programas como `ls --hyperlink`, `gcc` o
`gh`, se subrayan al pasar el ratón y el aviso dice «Ctrl+clic para abrir».
Un clic normal sigue siendo un clic de la terminal (foco, selección); solo
**Ctrl+clic** abre el enlace:

- Las páginas web se abren en el navegador predeterminado.
- Un `file://` a una carpeta la abre en el gestor de archivos; a un archivo lo
  muestra seleccionado en su carpeta. Nunca se ejecuta nada, aunque el enlace
  apunte a un `.exe`.
- Antes de abrir, una confirmación enseña la dirección completa y su destino
  (el host en negrita y en punycode si el dominio es internacional). `Intro`
  abre y `Esc` cancela.

En **Ajustes → Terminal** se desactivan los enlaces («Enlaces clicables en la
salida») o solo la confirmación («Pedir confirmación antes de abrir un
enlace»). Las rutas sueltas como `C:\Users\…` no se detectan: el prompt de cmd
y PowerShell es una ruta y quedaría subrayado en cada línea. Un enlace con otro
esquema (`javascript:`, `mailto:`, `ms-settings:`…), con contraseña, con
caracteres invisibles o un `file://` de otro equipo no se abre y se avisa en la
esquina de la terminal.

---

## Marcas de orden

### 1. Qué son y qué permiten

cmd, PowerShell y bash (Git Bash y WSL) marcan en su prompt dónde empieza y
acaba cada orden con las secuencias OSC 133. Las marcas no ocupan columnas ni se
ven; con ellas la terminal puede:

- **Saltar entre órdenes** con `Ctrl+Shift+Up` y `Ctrl+Shift+Down`.
- **Señalar las que fallan** con una barra roja junto a su prompt. Al pasar el
  ratón por encima enseña el código de salida y lo que tardó. cmd no da el código
  de salida en su prompt. Solo se reconoce una orden que no existe: su salida
  lleva el mensaje 9009 de `cmd.exe` («… no se reconoce como un comando interno
  o externo»), que `terminal/cmd_failure.rs` lee del propio Windows en su idioma
  (`cmd_not_found_text`). Esa orden cuenta como fallida con 9009, su
  `ERRORLEVEL`: barra roja y, con el modo consejero, el aviso. Los demás fallos
  de cmd no se ven.
- **Copiar la salida de la última orden** desde el menú contextual o la paleta.
- **Avisar al acabar una orden de 10 segundos o más**: enseña lo que tardó y, si
  la ventana no tiene el foco, parpadea en la barra de tareas.

### 2. Cómo se apagan

Se apagan en `Ajustes › Terminal` con «Marcar dónde empieza y acaba cada orden»,
y el cambio vale para las pestañas nuevas. El prompt propio de la persona se
respeta: las marcas lo envuelven sin cambiarlo. En zsh, fish y las demás shells
no se añaden, pero si la shell las emite por su cuenta, la terminal las aprovecha.

### 3. Dónde funcionan

Las órdenes que lanza un botón de un panel (instalar, Git, Biblioteca…) cuentan
igual que las tecleadas: la pestaña recibe la orden de verdad
(`pty-command-written`) y el marco de la acción deja su código real para la
marca de fin. Antes no contaban, y el chat hablaba de la orden tecleada antes.

Por eso la barra roja y el modo consejero (`agentChatAdvisor`) no valen en todas
partes:

| Dónde | Órdenes fallidas |
|---|---|
| PowerShell (Windows PowerShell y pwsh) | Todas, con su código |
| bash: Git Bash, MSYS2, WSL con bash | Todas, con su código |
| cmd | La orden que no existe (9009) y las acciones de los botones, con su código |
| zsh, fish, sh (por ejemplo WSL con zsh, como Kali) | Ninguna, salvo que la shell emita las marcas |
| Dentro de un REPL (Python, Node…) o de una IA de terminal | Ninguna: no hay prompt de shell que marcar |

## Inteligencia artificial en la terminal

Las IA de terminal (Claude Code, Gemini, Codex, Qwen, Amp, Grok…) se abren como
cualquier otro entorno (`ai:*`), en su propia pestaña y al ancho visible. Además
de eso, WTerminal tiene tres ayudas. Cada una con su opción en Ajustes (el
buscador de Ajustes las encuentra por su nombre).

### Clave de API cuando falta (`aiKeyOffer`, solo Windows)

Si una IA acaba al abrirse pidiendo su clave (Grok: «API key required.
Set GROK_API_KEY…»), la pestaña ofrece «Introducir la clave…». Da igual lo que
tarde en decirlo: la pestaña de una IA que acaba con error no se cierra sola.

- **Dónde se guarda:** cifrada con DPAPI para tu usuario de Windows, en
  `ai-keys.json` junto a los ajustes (`environments/ai_keys.rs`). Ni la app ni
  los registros la guardan en claro.
- **A quién llega:** solo a esa IA, como variable de entorno al abrirla, y solo
  si esa variable no está ya puesta:

  | IA | Variable |
  |---|---|
  | Grok | `GROK_API_KEY` |
  | Codex, mods, ShellGPT, llm, aider | `OPENAI_API_KEY` |
  | Gemini | `GEMINI_API_KEY` |
  | Claude Code | `ANTHROPIC_API_KEY` |

- **Borrarla:** en Ajustes, bajo la opción, sale la lista de claves guardadas
  con su botón «Borrar».

### Chat con los agentes (`agentChat`)

Una barra a la derecha para preguntar a un agente sin entrar en su CLI. Se
apaga entera con `agentChat` en Ajustes.

#### 1. Cómo se abre

- el botón **✦** al final de la fila de pestañas, justo encima de donde se abre
  el chat, con el mismo aspecto que los de carpetas y vista dividida (14-11,
  Romen: «en vez de palabras, un símbolo fácil de identificar con una IA»;
  antes era «Chat IA» en la barra de arriba). Se queda a la derecha aunque haya
  muchas pestañas, y se oculta con `showAgentChatButton`;
- `:chat` en la terminal o la paleta;
- su atajo, `shortcutToggleAgentChat`, vacío de fábrica.

El ancho se cambia arrastrando su borde izquierdo y se recuerda.

#### 1.1 Varios chats a la vez

Arriba del panel van las **pestañas de chat** (`AgentChats.svelte`, 14-11,
Romen: «varios chats con IA, en paralelo, en la barra lateral»):

- «+» abre otro chat **en paralelo**, con su propio agente, modelo, permisos y
  conversación. Hasta 6.
- Cada pestaña dice el agente de ese chat, y un punto que late marca los que
  están trabajando, aunque no se vean: un chat escondido sigue con su
  pregunta.
- «×» o el **clic central** sobre su pestaña (21-11, como en las pestañas de
  las shells) cierra ese chat y corta su pregunta si la tiene; cerrar el panel
  las corta todas. Con un solo chat no hay nada que cerrar: ni sale la × ni
  hace nada el clic central.
- La pregunta que prepara el consejero va al chat que se ve.
- En cada chat, el botón de volver a empezar (junto a ↗) borra solo su
  conversación.

El backend ya admitía varias preguntas a la vez (cada una con su id), así que
cada chat lanza la suya sin esperar a los demás.

#### 2. Qué agentes y qué se puede elegir

##### 2.1 El desplegable, y los que no entran

En el desplegable salen arriba los instalados que admiten una pregunta suelta.
Al final, separadas bajo «Solo en su pestaña (se abre aparte)», las que algo
puede dejar entrar en el chat, con el motivo al pasar el ratón: un ajuste de
WTerminal (Amp con «Dejar editar», Grok con «Omitir permisos») o su propia
configuración (Continue sin `~/.continue/config.yaml`, `needs-config`). Elegir
una la abre en una pestaña y el chat sigue con el agente que tenía (14-11,
Romen: el renglón «En su pestaña:» de antes no se entendía). Las que nunca
contestan en el chat (aider, que edita archivos por su cuenta, o las que no
tienen modo de una pregunta) no se ofrecen ahí: se abren desde el selector de
entornos (15-11, Romen: «no vale de nada en la barra»). Tampoco se ofrece una
que no se pueda lanzar sin cmd (`needs-cmd`): antes salía y luego fallaba. El botón ↗ junto al desplegable abre el agente elegido
en una pestaña, para iniciar sesión o configurarlo. Para cada agente se recuerda
lo último que elegiste.

La lista sale de la detección de entornos. Si el chat se abre antes de que
acabe, dice «Buscando agentes…» y se rellena sola al llegar (14-11: antes se
quedaba vacía hasta cerrarlo y abrirlo).

##### 2.2 Cómo se le pregunta a cada agente

| Agente | Cómo se le pregunta | Modelo | Intensidad |
|---|---|---|---|
| Claude Code | `claude -p` | `--model` (sugiere fable, opus y sonnet) | `--effort`: baja, media, alta, muy alta, máxima y Ultracode |
| Codex | `codex exec --skip-git-repo-check -s read-only -` | `-m` (de su catálogo) | `-c model_reasoning_effort=`: la que admita cada modelo, de baja a extrema |
| Gemini CLI | `gemini --skip-trust --approval-mode plan` | `-m` | no tiene |
| Qwen Code | `qwen --approval-mode plan` | `-m` | no tiene |
| GitHub Copilot CLI | `copilot --allow-all-tools --deny-tool shell --deny-tool write -p …` | `--model` | `--reasoning-effort` |
| Crush | `crush run --quiet` | `-m` (14-11: `crush run` ya lo tiene) | `--reasoning-effort` |
| llm, mods, AIChat | tal cual | `-m` | no tiene |
| ShellGPT | tal cual | `--model` | no tiene |
| Grok CLI | `grok -p …` (node directo, sin cmd), solo con «Omitir permisos» (apartado 9) | `-m` (sugiere grok-code-fast-1 y grok-4-latest) | no tiene |
| Continue CLI | `cn --silent --readonly -p …` (node directo, sin cmd) | `--model` | no tiene |
| opencode | `opencode run --agent plan …` (la pregunta detrás, con el `.exe` del paquete directamente, sin cmd) | `-m proveedor/modelo` | no tiene |
| Amp | `amp -x`, pregunta por la entrada estándar; solo con «Dejar editar» (apartado 9) | no tiene (`-m` es su modo de agente) | no tiene |
| Modelos de Ollama | `ollama run <modelo>` | es el de la pestaña | no tiene |

##### 2.3 El modelo

- **Modelo:** se elige de una lista. La primera opción dice **el que usa el
  agente de verdad**, leído de su configuración (`agent_chat_models`):
  - Claude Code: `~/.claude/settings.json`;
  - Codex: `~/.codex/config.toml`;
  - Gemini y Qwen: `~/.gemini` y `~/.qwen`, `settings.json`;
  - Copilot: `~/.copilot/config.json`;
  - ShellGPT: `.sgptrc`;
  - mods y AIChat: su YAML;
  - llm: `llm models default`.

  Si no lo dice en ningún sitio, la opción es «El que decida <agente>» (su valor
  de fábrica o el de tu cuenta). Los demás modelos salen de lo que trae el
  propio agente instalado, así que la lista es la de esa versión (14-11, Romen:
  «solo Claude muestra la lista de modelos»):

  | Agente | De dónde sale la lista |
  |---|---|
  | Codex | su catálogo, `codex debug models`: los visibles, en su orden, y con la intensidad que admite cada uno (de `low` a `ultra`; el panel enseña solo esos) |
  | Gemini CLI, Qwen Code | los nombres de modelo de su paquete instalado (`gemini-3-pro-preview`, `qwen3.8-max`…), con un filtro estricto y del más nuevo al más viejo (`installed_models`, guardados por versión) |
  | llm, AIChat | `llm models list`, `aichat --list-models` |
  | Claude Code, Copilot | sus alias conocidos (`fable`, `opus`, `sonnet`; `auto`) |

  «Otro…» abre un campo para escribir uno exacto, y **solo sale donde la
  lista puede estar incompleta** (`custom_model_allowed`): Copilot, Crush, mods y
  ShellGPT, que no saben listar los suyos (`crush models` da los 1779 de todos
  los proveedores conocidos, tengas o no alguno), o cuando la lista sale vacía.
  Con Codex, Gemini, Qwen, llm, AIChat y Claude Code no hace falta (14-11, Romen:
  «¿por qué muestran Otro… y te pide escribirlo a mano?»); un modelo guardado
  que ya no está en su lista vuelve al de fábrica. Solo se aceptan letras,
  números y `. _ : / @ -`, también los leídos de un archivo o de un paquete,
  para que nada lo interprete un `.cmd`. Para listar nunca se le pregunta nada a
  la IA.

##### 2.4 Intensidad, Ultracode y modo rápido

- **Intensidad:** «Por defecto» no manda nada. Si un agente no admite lo
  elegido, el chat lo dice; no lo ignora en silencio.
- **Ultracode** (Claude Code, `--effort ultracode`; 14-11, Romen: «claude
  tiene ultracode»): Claude Code reparte el trabajo en varios agentes. Tarda y
  gasta más, así que con él el plazo de la pregunta sube de 5 a 30 minutos
  (`answer_timeout`). Codex no lo tiene: su nivel más alto es `ultra`
  («Extrema»), y solo en los modelos que lo admiten.
- **Modo rápido** (casilla «Modo rápido · gasta más»): responde antes a cambio
  de gastar más de tu cuenta. Sale solo donde existe:

  | Agente | Cómo se pide | Cuándo sale |
  |---|---|---|
  | Claude Code | `--settings` con un archivo `{"fastMode": true}` (`wterminal-claude-fast.json` en la carpeta temporal: así ninguna comilla pasa por un `.cmd`) | siempre; en las cuentas que lo piden, gasta créditos de uso |
  | Codex | `-c service_tier=fast` | solo con los modelos que traen `service_tiers` en su catálogo («Fast», «2x speed, increased usage») |

##### 2.5 Lo particular de cada agente

- **Fuera del chat, en su pestaña:**
  - Grok, mientras «Omitir permisos» no esté habilitado, y Amp, mientras no
    esté «Dejar editar» (apartado 9);
  - aider: la primera vez abre un asistente que pregunta (en el chat se
    quedaría colgado) y deja sus archivos de historial en la carpeta; su modo
    que solo contesta (`--chat-mode ask`) queda para más adelante.
- **Continue y opencode, dentro** (14-11, Romen: «faltan otras IA en el
  lateral»): antes no se podían dejar en solo lectura y solo aceptaban la
  pregunta como argumento. Ahora van con node directo (sin cmd) y en su modo
  de solo leer: Continue con `--readonly` (su modo plan), opencode con su
  agente `plan`.
- **Gemini, de vuelta (13-11):** con la pregunta por la entrada estándar
  funciona, como Qwen, que es el mismo código. Con una cuenta personal de Google
  contesta `UNSUPPORTED_CLIENT`; con `GEMINI_API_KEY` sí contesta, y el chat
  ofrece meterla (apartado 8).
- **Gemini confía en la carpeta de la pestaña** (`--skip-trust`, 14-11): en una
  carpeta que no conoce pasaba a «default» y, sin pantalla, se negaba («Gemini
  CLI is not running in a trusted directory»), aunque tuviera clave. Confiar
  solo vale para esa pregunta, y es lo mismo que hace Claude Code con `-p`:
  lee también la configuración propia de la carpeta (`.gemini`).

#### 3. Cómo pregunta

- Cada pregunta abre la CLI una vez, en la carpeta de la pestaña, y le pasa el
  texto **por la entrada estándar**, no por la línea de órdenes: ni cmd ni un
  `.cmd` lo interpretan.
- **Copilot**, que solo la acepta como argumento (`-p`), se lanza con
  **node directamente**, con el script que nombra su `.cmd`, nunca con el
  `.cmd` (`direct_launcher`, `npm_shim`). Así tampoco pasa por cmd.
  Para él la pregunta tiene que caber en una orden de Windows: unos 30 000
  caracteres con adjuntos y conversación. **opencode** (y Amp o pnpm) trae su
  programa ya compilado y su `.cmd` lanza ese `.exe` sin node: se lanza el
  `.exe` directamente (15-11: se ofrecía y luego decía «no se pudo lanzar sin
  pasar por cmd»).
- Tiene un tope de 400 000 caracteres y de 5 minutos (30 con Ultracode);
  «Cortar» la corta.
- **Reintentos silenciosos:** Gemini CLI y Qwen Code, con el modelo saturado
  (503) o sin cupo (429), reintentan hasta 10 veces con esperas de hasta 30 s
  sin escribir nada por la salida normal. El chat lee su salida de error
  («Attempt N failed with status 503…», `RetryWatch`) y al tercero la corta y
  lo dice: «El modelo está saturado ahora mismo… elige otro modelo» (15-11:
  Gemini se quedaba 5 minutos callado con su modelo por defecto saturado).
  Desde el 16-11 cada reintento se ve en cuanto pasa, en lugar de
  «Pensando…»: «Modelo saturado (error 503). Reintentando… (1 de 3)»
  (evento `agent-chat-status`).
- **Qué modelo contestó:** la cabecera de cada respuesta lo dice. Si la CLI lo
  escribe (Codex pone `model: …` al empezar), ese; si no, el elegido en el
  panel; sin elegir, «modelo por defecto» (`answerModel`). Ollama ya lleva el
  modelo en el nombre del agente.
- **La caja de escribir** dice solo «Pregunta a {agente}…»: las teclas (Intro
  envía, Mayús+Intro salta de línea) van en su ayuda al pasar el ratón. Con el
  texto largo no cabía en su fila y salía cortado (16-11).
- **Sin respuesta:** si acaba bien sin escribir nada (Amp con su conexión a
  ChatGPT caducada, 15-11), el chat dice «El agente terminó sin contestar
  nada», enseña lo que dijo por la salida de error y ofrece su pestaña. Al
  cortarse por tiempo también se puede ver lo que dijo.
- **La respuesta acaba cuando sale la CLI** (`wait_for_answer`), aunque su
  salida siga abierta: `ollama run` arranca el programa de Ollama si no estaba
  abierto, y ese programa hereda la salida y no la cierra. La respuesta salía
  entera y el chat seguía en «Pensando…» hasta el plazo (14-11, Romen). Ahora,
  en cuanto sale la CLI y no llega nada más en 300 ms (como mucho 1,5 s), está
  entera; lo que escriba después ese proceso ya no se añade.
- **ShellGPT sin clave no se lanza:** la primera vez, sin su `.sgptrc` y sin
  `OPENAI_API_KEY` (ni en el entorno ni guardada), pide la clave por consola
  (`getpass`, que en Windows lee la consola y no la entrada estándar) y el chat
  se quedaba colgado (14-11, Romen). Ahora lo comprueba antes
  (`asks_key_on_console`), no lo lanza y ofrece meter la clave.
- Gemini y Qwen reciben, como en sus pestañas, los ajustes de sistema que
  apagan su autoactualización (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`). Antes no les
  llegaban desde el chat: se autoactualizaban con `npm install -g` en una
  consola aparte que abría Windows Terminal («error 0x800700e8 al iniciar … npm
  install -g @google/gemini-cli», 13-11).

#### 4. Adjuntos

Con el clip (abajo, junto a «contexto») se añaden hasta 5 archivos de texto por
pregunta. Cada uno va en su propio bloque, con su nombre.

- Un archivo de más de 100 KB se manda cortado (se avisa: «solo el principio»).
- Uno de más de 5 MB o que no sea texto no se adjunta.

#### 5. Memoria de la conversación (`agentChatRemember`)

Encendida de fábrica. Con cada pregunta se mandan las últimas 6 vueltas de la
conversación (como mucho 24 000 caracteres; se quitan antes las más viejas), y
el agente la recuerda aunque su CLI no guarde nada entre preguntas. «Nueva
conversación» la borra. Apagada, cada pregunta va sola.

##### 5.1 Historial de chats (`agentChatHistory` y `agentChatRestore`, encendidos)

Cada conversación se guarda sola en este equipo, en `agent-chats` dentro de la
carpeta de datos (un archivo por chat). Nada sale del ordenador.

- **Cerrar no borra:** cerrar una pestaña de chat, el panel o WTerminal deja la
  conversación guardada. Si se cierra mientras contesta, queda lo que llegó,
  marcado como cortado.
- **Al reabrir el chat** vuelven las pestañas que había, con su conversación
  (`agentChatRestore`).
- **El botón del reloj** abre el historial: chats agrupados por Hoy, Ayer,
  Últimos 7 días, Últimos 30 días y Anteriores; búsqueda sin tildes; abrir,
  renombrar y borrar (con confirmación), y «Borrar todo el historial».
- **«Nueva conversación»** deja la anterior en el historial.
- Como mucho 300 chats: al pasar, se borran los más antiguos que no estén
  abiertos.

##### 5.1.1 Fijar, exportar, títulos y limpieza del historial (24-11)

- **Fijar:** el botón de la chincheta deja un chat arriba, en «Fijados». El
  chat de ayuda va fijado de fábrica (`agentChatPinHelp`). También con
  `:chat pin <help|id>` y `:chat unpin <help|id>`, que puede usar una IA con
  `wterminal --ctl`. Los fijados no se borran al pasar de 300 ni con la
  limpieza de viejos.
- **Exportar:** el botón de la flecha guarda el chat en Markdown donde elijas:
  título, agente, fechas y cada mensaje con quién lo dijo; el código, tal cual.
- **Título por la IA** (`agentChatAutoTitle`, apagado): tras la primera
  respuesta, el agente propone un título corto. Gasta una pregunta más de su
  cuenta; apagado, el título es la primera pregunta.
- **Borrar los viejos** (`agentChatCleanup`, apagado): borra los chats que
  lleven `agentChatCleanupDays` días (90 de fábrica) sin usarse, salvo los
  abiertos y los fijados.
- **La sesión del agente al borrar** (`agentChatForgetNative`, apagado): de
  fábrica, borrar un chat deja la sesión de Claude Code o Codex en su carpeta,
  porque es suya. Encendido, la borra también (solo archivos con ese UUID).

##### 5.2 Sesiones propias de Claude Code y Codex (`agentChatNativeSessions`, encendido)

Claude Code y Codex guardan sus propias sesiones. Con este ajuste, la primera
pregunta de una conversación abre una (Claude Code con `--session-id`; Codex
abre la suya y dice su id al empezar) y las siguientes la retoman
(`claude -p --resume <id>` y `codex exec resume <id> -`) mandando **solo lo
nuevo**, no la conversación entera. Así gastan menos y recuerdan también lo
que leyeron o hicieron.

- Solo se retoma si la última respuesta fue de ese mismo agente y salió bien;
  si no (se cambió de agente, hubo un fallo), se abre una sesión nueva con la
  conversación entera.
- Si la sesión ya no está (Claude Code las guarda por carpeta, y se pueden
  borrar), se repite la pregunta en una sesión nueva con la conversación entera,
  sin avisar de error.
- El modo automático de Codex no se puede retomar (`codex exec resume` no lo
  admite): con él va siempre la conversación entera.
- Pide «recordar la conversación». Apagado, siempre va la conversación entera.
- Las respuestas que retomaron la sesión llevan una marca discreta, «sesión
  retomada» (`agentChatShowResumed`, encendido).

#### 6. Contexto de la terminal (opcional)

Con la casilla marcada, la pregunta lleva la última orden y su salida, también
si la lanzó un botón de un panel (ver [Marcas de orden](#marcas-de-orden)).
Antes se ocultan los secretos que se reconocen (`redactSecrets` en
`src/lib/agent-chat.ts`), que pasan a «oculto»:

- claves `sk-`, `xai-`, `ghp_`, `AKIA` y `AIza`, JWT, `Bearer …` y bloques de
  clave privada;
- el valor de cualquier `nombre = valor` o `nombre: valor` cuyo nombre lleve
  `api_key`, `token`, `secret`, `password` o `pwd`.

El mensaje enseña qué se mandó.

#### 7. Lo que hace con la respuesta

- Se pinta con Markdown sencillo: títulos, listas, citas, negrita, cursiva y
  código. Sin HTML: nada de lo que conteste un agente se interpreta como marcado.
- Cada bloque de código lleva su lenguaje, «Copiar» e «Insertar». «Insertar»
  escribe un bloque de una línea **sin Intro**, y solo sobre un prompt vacío.
- Encima de cada respuesta: el agente, el modelo y la intensidad usados, el
  modo si es uno que edita, «Modo rápido» si se pidió y lo que tardó; debajo,
  copiar la respuesta entera y «Repetir» (con lo mismo).
- El panel tiene el aspecto de la terminal: su letra y sus colores, la
  pregunta con `›` y la respuesta con un filete a la izquierda (rojo si
  falló), sin burbujas ni avatares (13-11, Romen: «muy plástica, muy hecha por
  una IA»).
- Está ordenado de arriba abajo (14-11): el agente en su fila, con ↗ para
  abrirlo en su pestaña; debajo, modelo, intensidad y permisos juntos; después
  el modo rápido y el aviso de «Omitir permisos» si toca. Abajo, el campo de la
  pregunta y, en su barra, el clip, «contexto», «memoria» y «Enviar».
- **Nunca ejecuta nada por su cuenta.**
- Los avisos (no se pudo insertar, contexto, adjuntos, copiado) salen abajo con
  el color de aviso y un filete, para que se vean (14-11: en gris pasaban
  desapercibidos).

#### 8. Cuando un agente falla

El error se dice en **una línea**: el código y la frase que lo explica, sacada de
lo que escribió el agente (`errorHeadline` en `src/lib/agent-chat.ts`: la
primera que suena a error, sin pilas de llamadas ni avisos). Lo demás va plegado
en «Ver lo que dijo el agente» (14-11, Romen: el muro rojo de Gemini o de Codex
no se entendía). Debajo, el chat ofrece lo que lo arregla
(`agent_chat_failure_help`, `classify_failure`, probado con los mensajes reales
que vio Romen el 13-11 y el 14-11):

| Lo que dice el agente | Lo que ofrece el chat |
|---|---|
| `ModuleNotFoundError: No module named …` (llm, ShellGPT) | Explica que a su Python le falta `PYTHONUSERBASE` y abre Ajustes |
| Una clave que falta o no vale (mods: «OpenAI authentication failed … api-keys»; Gemini: `UNSUPPORTED_CLIENT`) | Un campo para la clave, que se guarda cifrada (como en las pestañas, `aiKeyOffer`), y «Guardar y repetir» |
| Que hay que iniciar sesión (Qwen: «No auth type is selected»; Claude Code: «Please run /login»; Codex: «401 Unauthorized»; Copilot: «No authentication information found») | «Abrir <agente> en una pestaña», para iniciar sesión en su pantalla |
| Que falta su configuración (AIChat: «Failed to load config … config.yaml»; Crush: «No providers configured») | «Abrir <agente> en una pestaña», que la crea la primera vez |
| ShellGPT sin clave (antes de lanzarlo, ver el apartado 3) | El campo para la clave, sin lanzarlo |

La clave de OpenAI (`OPENAI_API_KEY`) se guarda una vez y la usan llm, mods,
ShellGPT, Codex y aider.

**Gemini con su clave** (14-11, Romen: «no acepta mi clave y sigue diciendo que
el cliente no está soportado»): Gemini CLI se autentica como diga su
`~/.gemini/settings.json`, y quien entró alguna vez con Google tiene ahí
`oauth-personal`: la clave se ignoraba y seguía con la cuenta gratuita. Con la
clave guardada en WTerminal, al lanzarlo (chat y pestaña) se le pasa
`GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key`, que la usa solo en esa ejecución sin
tocar su archivo (`use_stored_key_env` en `ai_keys.rs`). Con la clave solo en el
entorno de Windows no se fuerza.

**Un agente que escribe su error en la salida normal** (Grok): si la salida de
errores llega vacía, el error es el final de lo que escribió, y con él se
decide la ayuda (`keep_tail`).

Codex daba «Not inside a trusted directory» fuera de un repositorio git: no era
de sesión, y ahora se le pasa `--skip-git-repo-check`.

#### 9. Lo que pueden tocar: los permisos

##### 9.1 Los modos

El selector «Permisos» ofrece los modos de cada agente, como el menú de Claude
(14-11, Romen: «los permisos tmb»). Cada uno va con la opción que entiende su
CLI (`Mode` en `agent_chat.rs`):

| Modo | Qué hace | Claude Code | Codex | Gemini | Qwen | Copilot |
|---|---|---|---|---|---|---|
| Manual | lo que pida permiso se le niega (el chat no puede preguntarte): lee, no cambia nada | de serie con `-p` | `-s read-only` | — | — | `--deny-tool shell --deny-tool write` |
| Plan | solo lee y propone | `--permission-mode plan` | — | `--approval-mode plan` | `--approval-mode plan` | — |
| Aceptar ediciones | cambia archivos de la carpeta de la pestaña sin preguntarte | `--permission-mode acceptEdits` | `-s workspace-write` | `--approval-mode auto_edit` | `--approval-mode auto-edit` | `--deny-tool shell` |
| Auto | el propio agente decide qué es seguro y lo hace; lo arriesgado lo frena | `--permission-mode auto` | `--approve-for-me` | — | `--approval-mode auto` | — |
| Omitir permisos | hace todo sin preguntarte, también ejecutar órdenes y borrar archivos | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--approval-mode yolo` | `--approval-mode yolo` | sin denegar nada |

- El de fábrica de cada agente es el primero de su fila (Manual o Plan): **solo
  lee**.
- Crush (`crush run` no tiene `--yolo`) y los que solo contestan texto (llm,
  ShellGPT, mods, AIChat, Ollama) no tienen modos: el selector no sale.
- **Continue y opencode:** Plan (de fábrica: `--readonly` y `--agent plan`) y
  Omitir permisos (`--auto` en los dos).
- **Amp solo tiene «Aceptar ediciones»** (14-11): en `-x` edita archivos sin
  preguntar y deniega las órdenes que no tenga permitidas; no tiene modo de
  solo leer. Sin `agentChatCanEdit` no se lanza y sale en «Solo en su
  pestaña» con ese motivo.
- **Grok solo tiene «Omitir permisos»** (14-11): con `-p` aprueba él solo todas
  sus operaciones (`allOperations`: órdenes y cambios de archivos) y no puede
  quedarse en solo leer (`--max-tool-rounds 0` vale 400 en su código). Sin los
  dos ajustes no se lanza aunque no se elija nada, y sale en «Solo en su
  pestaña» con ese motivo. Contesta con un mensaje JSON por línea; el chat
  enseña su respuesta y, de sus herramientas, solo cuáles usó
  (`grok_answer_line`).
- En Copilot, denegar manda siempre, también sobre `--allow-all-tools`.
- Las órdenes que Codex ejecuta en su sandbox con «Aceptar ediciones» también
  pueden escribir en la carpeta.

##### 9.2 Lo que piden los ajustes

| Ajuste | Apagado (de fábrica) | Encendido |
|---|---|---|
| `agentChatCanEdit`, «Dejar que los agentes del chat editen archivos» | solo Manual y Plan; los demás salen en gris con «actívalo en Ajustes» | también «Aceptar ediciones» (pasa a ser el de fábrica) y «Auto» |
| `agentChatAllowBypass`, «Dejar elegir «Omitir permisos» en el chat» | «Omitir permisos» en gris | se puede elegir a mano; pide también el de arriba |

- **Lo comprueba también el backend:** un modo que edita sin el ajuste da
  `mode-needs-edit`, y «Omitir permisos» sin los dos, `mode-needs-bypass`.
  Nunca se cambia por otro en silencio.
- «Omitir permisos» **nunca es el de fábrica**, con ningún ajuste; una prueba
  comprueba que `yolo`, `bypass` y `dangerously…` solo están en ese modo.
- La cabecera del chat enseña el modo cuando edita (en rojo si es «Omitir
  permisos»), y con «Omitir permisos» sale además un aviso debajo de los
  selectores.
- Si apagas un ajuste, el modo elegido que ya no vale vuelve al de fábrica.

#### 10. La guía de WTerminal para los agentes (`agentChatGuide`, encendido)

Para que las IA, sin que el usuario se lo diga, propongan **las funciones de
WTerminal antes que órdenes del sistema**: instalar, actualizar y desinstalar
con Entorno y dependencias y no con winget, apt o pip a pelo; cambiar de shell,
abrir un REPL o una pestaña, ajustar la terminal o cambiar un ajuste con las
órdenes internas (14-11, Romen: «una especie de SKILL.md… que no sea visible
para el usuario ni un archivo en su PC: solo en el código»).

##### 10.1 Qué lleva y de dónde sale

`src-tauri/src/environments/agent_guide.rs`, sin archivos en disco:

| Parte | De dónde sale |
|---|---|
| Dónde está el agente y el principio «primero WTerminal», con su porqué (carpeta propia y variables, comprobaciones previas, progreso y log, desinstalar sin restos) | escrito en el módulo |
| Cómo proponer desde el chat (bloques de una línea para «Insertar», órdenes `:`, caminos exactos de los paneles) | escrito en el módulo |
| Cada tarea habitual → cómo se hace en WTerminal → por qué | escrito en el módulo |
| Lo que no debe hacer (no encender por su cuenta los permisos del chat, no tocar a mano configuración, registro ni PATH, no pedir claves) | escrito en el módulo |
| La ayuda interna entera: órdenes `:`, paquetes, sesión, alias, Biblioteca, menús y soporte | generada con `build_help_topic_text`, la misma que `ayuda`, sin colores |
| Cada ajuste con su valor de fábrica y su explicación | generada de `default_settings.toml` y sus comentarios |

Como la mitad se genera del código, no se queda vieja: una prueba exige que
salga cada ajuste de fábrica.

##### 10.2 Cómo llega a los agentes

- **En el chat:** delante de cada pregunta va, oculto, un resumen corto
  (`chat_preamble`, menos de 2 400 caracteres: lo paga cada pregunta). No sale
  en el mensaje ni en el log. Los modelos locales de Ollama no lo reciben: son
  pequeños y la pregunta se les perdería.
- **Entera, a demanda:** `wterminal --agent-guide [tema]` la imprime y sale,
  sin abrir ventana ni tocar ajustes (`run` en `lib.rs`). El resumen le dice al
  agente la ruta exacta del ejecutable. Temas: `temas` los lista; `todo` (de
  fábrica), `principios`, `chat`, `tareas`, `limites`, `internos`,
  `paquetes`, `sesion`, `alias`, `biblioteca`, `menus`, `soporte` y `ajustes`.
- Apagado (`agentChatGuide = false`), la pregunta va sola.
- **En las pestañas de las IA** (`agentTabGuide`, encendido; 14-11, Romen: «al
  abrir la sesión con la IA… que le mande esa ayuda»): una vez, al abrir su
  pestaña (`tab_args`, añadido en `tabs.rs` después del log). Claude Code la
  recibe con `--append-system-prompt` y Codex con
  `-c developer_instructions='…'`: instrucciones de arranque que no salen en la
  conversación. Gemini y Qwen solo leen instrucciones de archivos: va como su
  primer mensaje con `-i` («Ahora contesta solo con la palabra Listo»), que se
  ve en su pantalla. Es una sola línea sin `"`, `'`, `%`, `&`, `|`, `<`, `>`,
  `^` ni `!` (`tab_preamble`): si la CLI es un `.cmd` de npm, pasa por cmd.

##### 10.3 Que la IA maneje WTerminal: `wterminal --ctl` (`agentControl`, encendido)

Con esto la IA no solo propone: lo hace (14-11, Romen: «que permita que
gestione la terminal lo máximo posible»). `src-tauri/src/app/agent_control.rs`.

| Orden | Qué hace | ¿Pide permiso? |
|---|---|---|
| `wterminal --ctl :panes 2`, `:panel deps`, `:theme …`, `:terminal font-size 14` | cualquier orden interna | no |
| `wterminal --ctl :shell pwsh`, `:repl python` | cambia la shell de una pestaña o abre un REPL | no |
| `wterminal --ctl :set list`, `:set <ajuste>` | enseña ajustes | no |
| `wterminal --ctl :set <ajuste> <valor>` | cambia un ajuste | sí |
| `wterminal --ctl acciones <texto>` | busca en el catálogo de Entorno y dependencias (id y nombre, sin tildes) | no, solo lee |
| `wterminal --ctl accion <id>` | lanza esa acción (instalar, actualizar, desinstalar) | sí |

- **Quién puede:** al arrancar, WTerminal abre un servidor en `127.0.0.1`
  (puerto libre) con una llave aleatoria de 24 bytes (`BCryptGenRandom`). Solo
  los procesos que lanza para una IA (sus pestañas `ai:*` y las preguntas del
  chat) reciben `WTERMINAL_CTL`, `WTERMINAL_CTL_TOKEN` y, en una pestaña,
  `WTERMINAL_TAB_ID`. Sin la llave no se atiende nada; la llave se compara
  entera, sin atajos. Con `agentControl` apagado ni se abre ni se publica.
- **Cómo:** `wterminal --ctl …` (`run_cli`, atendido en `run` antes de abrir
  ventana) manda la orden y escribe la respuesta: código 0 si se hizo, 1 si no,
  con el motivo. El frontend la hace en una pestaña de shell libre (la activa
  si lo es; si no, la última), escribiéndola como si la tecleara el usuario
  (`submitLine`): se ve lo que hizo la IA. Nunca en la pestaña de la propia IA
  ni en un REPL.
- **Permiso:** las acciones y `:set` que cambia salen en un aviso con
  «Permitir», «Permitir en esta sesión» y «Denegar»; la IA espera la respuesta
  hasta 3 minutos.
- **Nunca** (`BLOCKED_SETTINGS`): `agentChat`, `agentChatCanEdit`,
  `agentChatAllowBypass`, `agentChatGuide`, `agentTabGuide`, `agentControl`,
  `aiKeyOffer`, `startAsAdmin`, `terminalAdminByDefault`,
  `terminalLinksConfirm` y `offerGsudo`: una IA no puede darse más permisos ni
  bajar la seguridad.
- La guía lo explica (`--agent-guide control`), y el resumen del chat y el de
  las pestañas se lo dicen a la IA cuando está encendido.

### Modo consejero (`agentChatAdvisor`, encendido de fábrica)

Cuando una orden acaba con error, la pestaña enseña «La orden falló (código N).
¿Preguntas al agente?».

- «Preguntar» abre el chat con la pregunta escrita y la orden con su salida como
  contexto. **No manda nada hasta que pulsas enviar**, salvo con
  `agentChatAdvisorSend` (apagado de fábrica), que la manda sola.
- **Siempre en el mismo chat:** estas preguntas van al chat «Ayuda de
  WTerminal». Si está abierto, se va a él; si está en el historial, se reabre;
  si no, se crea. Así no se llena el historial de chats sueltos. Los chats que
  abres tú siguen siendo nuevos y normales.
- De fábrica es uno solo para siempre. Con `agentChatHelpMaxDays` o
  `agentChatHelpMaxMessages` (0 = nunca) empieza otro al pasar esos días o
  mensajes; el anterior queda en el historial y deja de estar fijado.
- El aviso se va solo a los 15 s o con la siguiente orden que salga bien.
- Solo sale si hay algún agente instalado al que preguntar.
- También vale para las acciones de los botones (instalar, Git, scripts…): su
  orden cuenta como una orden más y lleva su código real.
- Depende de las marcas de orden, así que **no vale en todas las shells**: ver la
  tabla de [Marcas de orden](#marcas-de-orden). En cmd solo avisa cuando la orden
  no existe.

## Paleta de comandos

### 1. Qué es

`Ctrl+Shift+P` (se cambia en `Ajustes › Atajos`,
«Abrir la paleta de comandos») abre un buscador con todo lo que la aplicación
ya sabe hacer. No es un lenguaje nuevo ni guarda configuración propia: cada
entrada ejecuta exactamente lo mismo que su atajo, botón, selector o comando
`:`, y el mismo atajo (o `Esc`) la cierra.

| Grupo | Qué contiene |
|---|---|
| Paneles | Ajustes, Biblioteca, Proyectos, Entorno y dependencias, mostrar u ocultar el explorador, seguir la carpeta de la terminal, llevar la terminal a la carpeta del explorador, abrir la carpeta actual en el explorador del sistema y cerrar los paneles. Un panel oculto en Ajustes aparece deshabilitado con el motivo. |
| Terminal | Buscar en el historial, guardar la salida, copiar la salida de la última orden, ir a la orden anterior o siguiente, limpiar (`clear`) y alternar el modo de terminal limpia. |
| Pestañas y división | Nueva pestaña, renombrar la pestaña, dividir (añadir una terminal), ver 1, 2, 3 o 4 terminales (`:panes`), pestaña siguiente y anterior. |
| Shells y entornos | Cambiar la pestaña activa a cualquier entorno del selector (shells, WSL, Docker, Android, REPL, asistentes de IA), abrir un REPL en una pestaña nueva (`:repl`) y volver a detectar entornos (`:reload`). El entorno actual y los no disponibles se ven deshabilitados con su motivo. |
| Apariencia e idioma | Cada tema (también los propios), fuente de terminal e idioma, con el vigente marcado (`:theme`, `:font`, `:language`). |
| Comandos internos (`:`) | `:help`, `:help internos`, `:alias`, `:shell list`, `:shell current`, `:theme list`, `:font list`, `:language list`, `:terminal list`, `:banner list` y `:banner preset compact\|full`: los que responden dentro de la terminal. |
| Acciones fijadas de LTools | Las que se han elegido en la Biblioteca, solo si LTools está activado y encontrado; las que modifican el sistema piden confirmación igual que allí. |

### 2. Buscar

Se escribe para filtrar: no distingue mayúsculas ni tildes («pestana» encuentra
«Nueva pestaña»), busca también por el comando `:` equivalente (`:config`
encuentra «Abrir Ajustes»), por el nombre del grupo y por identificadores
(`pwsh`, `wsl`, `python`), y si ninguna palabra coincide admite las iniciales
en orden («nvpst»). Cada fila enseña su atajo vigente y su comando `:` cuando
lo tiene. Si lo escrito es una línea `:` que no está en la lista (por ejemplo
`:terminal font-size 14`), la primera fila ofrece ejecutarla tal cual; antes de
teclearla, el parser de comandos internos confirma que lo es, así que una
línea que la shell ejecutaría nunca se envía.

### 3. Con el teclado

Con el teclado: `↑`/`↓` (dan la vuelta), `RePág`/`AvPág`, `Intro` ejecuta y
`Esc` cierra y devuelve el foco a donde estaba. Tab no sale del diálogo. Es un
`combobox` que controla un `listbox` con `aria-activedescendant`, de modo que
el lector de pantalla anuncia la opción activa sin que el foco salga del
buscador.

### 4. Lo que va a la terminal

Los comandos `:` y «Limpiar» se teclean en la pestaña activa por la misma ruta
que el teclado (`term.input`): el interceptor de `:` y la shell los reciben como
una orden escrita a mano y el eco y el prompt los sigue pintando ConPTY, así
que xterm y ConPTY no se separan. Por eso solo se ejecutan sobre un prompt
vacío: si la línea tiene texto sin enviar, la shell todavía arranca o hay un
programa a pantalla completa, la paleta lo dice y no escribe nada; en un REPL o
un asistente aparecen deshabilitados. El resto de acciones no tocan la
terminal.

---

## Configuración

### 1. Dónde se guarda

Todo se edita desde **Ajustes** y persiste validado en `settings.json`; el
propio panel muestra su ruta. También se puede distribuir preconfigurado
modificando ese JSON: cualquier valor fuera de rango se recorta o se sustituye
por el predeterminado, nunca rompe la aplicación.

### 2. Restablecer

«Restablecer», al pie de Ajustes, abre un diálogo; antes, un clic lo devolvía
todo a fábrica sin preguntar. El 13-11 eso devolvió la carpeta propia a la de
fábrica y dejó sin `PYTHONUSERBASE` a aider, llm e IPython.

- **Qué se elige:** casillas por pestaña (Apariencia, Terminal, IA, General, Atajos y Sistema)
  y por apartado, 18 en total. Cada apartado dice qué hace y su riesgo:
  - «Solo el aspecto»;
  - «Cambia cómo funciona»;
  - «Borra cosas tuyas»: los temas propios, los atajos, los alias y la
    carpeta propia.
- **Nada viene marcado**, el foco va a «Cancelar», y si se marca algo de lo que
  borra cosas tuyas, el diálogo lo resume en rojo antes de confirmar.
- **Qué hace:** `settings_reset` recibe las preferencias de esos apartados y
  solo devuelve a fábrica esas (`reset_patch`).
- **El reparto** está en `src/lib/settings-reset.ts`, y una prueba exige que
  cada preferencia de `default_settings.toml` esté en exactamente un apartado:
  una preferencia nueva no puede quedarse fuera.
- **Los perfiles portables** (17-11): arriba de las casillas, el diálogo dice
  cuántos hay y en qué carpeta, que restablecer no los toca, y ofrece «Guardar
  perfil ahora» antes de confirmar ([Perfiles portables](#1-perfiles-portables)).

### 3. Buscar un ajuste

Para encontrar un ajuste sin recorrer las pestañas:

- **Buscar un ajuste…** (bajo las pestañas de Ajustes) enseña a la vez las
  pestañas (Apariencia, Terminal, IA, General, Atajos y Sistema), cada una con su título, y
  solo lo que contiene el texto, sin distinguir mayúsculas ni tildes
  («maximizada», «cursiva», «gsudo»…): la fila que coincide, su encabezado y la
  nota que la acompaña; si coincide un encabezado, todo su grupo. Dice cuántos
  ajustes hay o que no hay ninguno, y `Esc` lo vacía sin cerrar Ajustes
  (`src/lib/settings-search.ts`, `settingsSearchVisibility`).
- Las pestañas largas tienen un **índice** de chips con sus apartados que
  lleva a cada uno: desde 6 apartados (`showSettingsIndex`), que hoy solo
  cumple Comportamiento. Información (4 apartados cortos) lo enseñaba y
  Apariencia y Terminal no, sin un criterio claro.
- Cada ajuste lleva una explicación breve debajo, y al pasar el ratón por la
  fila se ve entera (también cuando el panel estrecho la recorta).
- El pie con «Guardar» va fijo abajo, y los controles llevan un margen de
  desplazamiento (`scroll-margin-bottom`): uno al que se llega con `Tab` queda
  por encima del pie y no debajo. En el E2E, si un clic lo intercepta el pie
  (el control está en la ventana pero tapado), `click` centra el control en su
  scroll y pulsa una vez más; el evento `driver-click-scrolled` lo registra.

### 4. El orden de Comportamiento

**Comportamiento** va ordenado por frecuencia de uso: inicio y paneles,
secciones visibles e interfaz, atajos de teclado, alias, entornos habilitados,
entornos y descargas, PATH, integración de Windows y permisos de
administrador, perfiles, plugins y, al final, LTools (experimental).

### 5. Valores de fábrica

Los valores de fábrica viven en `src-tauri/default_settings.toml`; Cargo los
incluye en el binario y los valida al iniciar. La versión se sincroniza entre
`package.json`, `package-lock.json`, `Cargo.toml` y `Cargo.lock`; los scripts
de empaquetado la solicitan y `npm run check:version` evita divergencias.

### 6. Metadatos del paquete

Los metadatos editables del paquete viven en
`src-tauri/config/package-metadata.json`: nombre, binario, identificador,
descripciones, marca, autor, licencia, copyright, repositorio, web, correo de
soporte y créditos. La web puede quedar vacía si no se usa. Los créditos que
deban aparecer dentro de la app se indican como usuarios de GitHub. Tras
editarlos, ejecutar
`npm run metadata:sync`.

### 7. Todos los ajustes, con su tipo y su valor de fábrica

| Clave | Tipo · rango | Por defecto |
|---|---|---|
| `language` | `auto` \| 15 idiomas disponibles | `auto` |
| `defaultEnvironmentId` | id de entorno | `""` (automático) |
| `themeId` | `silver`, `winslim`, `ocean`, `forest`, `amber`, `violet`, `nordic`, `crimson`, `matrix`, `contrast`, `slate`, `plum`, `teal` o el id `custom-…` de un tema propio | `silver` |
| `themeRecolorAll` | booleano: el tema recolorea fondos, superficies y texto y no solo el acento | `false` |
| `customThemes` | hasta 24 temas propios (`id`, `label`, `palette` con los 11 colores, `ansi` opcional) | `[]` |
| `accentColor` | `#rrggbb` | `#b8bec6` |
| `terminalBackground` | `#rrggbb` | `#0d0d0d` |
| `terminalForeground` | `#rrggbb` | `#d4d4d4` |
| `terminalAnsiColors` | 16 colores `#rrggbb` (negro… blanco brillante) o vacío para los de xterm | `[]` |
| `terminalFontCustom` | nombre de una fuente instalada (letras, números, espacios y `-_.`), delante de la familia elegida | `""` |
| `terminalFontFamily` | Sistema, JetBrains Mono, Fira Code, Hack, Source Code Pro, IBM Plex Mono, Iosevka, Victor Mono, Ubuntu Mono, Inconsolata, Monaspace, Meslo o monoespaciada genérica | `ubuntu-mono` |
| `terminalFontSize` | 10–24 | `12` |
| `terminalLineHeight` | 0.9–5 | `1.2` |
| `terminalLetterSpacing` | −1–3 | `0` |
| `terminalCursorStyle` | `block`, `bar`, `underline`, `beam`, `underline-thick` | `block` |
| `terminalFontWeight` | `light`, `normal`, `medium`, `semibold`, `bold` | `normal` |
| `terminalCursorBlink` | booleano | `true` |
| `terminalLinks` | booleano: URL y OSC 8 clicables con Ctrl+clic | `true` |
| `terminalLinksConfirm` | booleano: confirmar con el destino a la vista antes de abrir | `true` |
| `pythonReplVisibleWidth` | booleano, solo Windows: el REPL de Python (su pestaña o `python`/`py` tecleado en la shell) usa el ancho visible y no la reserva de 1024 columnas. Se nota siempre: sus líneas largas (`print`, `help()`) se parten en el borde en vez de seguir hacia la derecha. Con `pyreadline3` además evita que teclear vaya a 2-3 letras por segundo ([Problemas conocidos](#problemas-conocidos)) | `true` |
| `actionCommandsAtOnce` | booleano: la orden de una acción (instalar, actualizar…) aparece entera de una vez, en vez de verse escribir como la repinta la shell | `true` |
| `keepActionCommandLine` | booleano: la línea que teclea una acción se queda a la vista (de fábrica se borra porque la orden ya sale en la cabecera; 22-11) | `false` |
| `aiKeyOffer` | booleano, en Windows y en Linux con `secret-tool`: si una IA (Grok, Codex…) acaba al abrirse pidiendo su clave de API, la pestaña ofrece meterla y la guarda cifrada (`environments/ai_keys.rs`) | `true` |
| `agentChat` | booleano: el chat lateral con los agentes de IA (`:chat`, paleta, atajo) | `true` |
| `agentChatAdvisor` | booleano, modo consejero: al fallar una orden, la pestaña ofrece preguntar al agente con la orden y su salida; solo deja la pregunta escrita en el chat, nunca la manda sola. No vale en todas las shells, porque depende de las marcas OSC 133 (`terminalCommandMarks`): sí en PowerShell y bash (Git Bash, WSL con bash); en cmd solo cuando la orden no existe (mensaje 9009 de Windows, `terminal/cmd_failure.rs`); no en zsh, fish ni sh (WSL con zsh, como Kali) salvo que la shell emita las marcas por su cuenta, ni dentro de un REPL (Python, Node…) o una IA de terminal | `true` |
| `agentChatCanEdit` | booleano: el chat deja elegir los modos que editan («Aceptar ediciones», que pasa a ser el de fábrica, y «Auto»). Apagado, solo leen (Manual y Plan) | `false` |
| `agentTabGuide` | booleano: al abrir la pestaña de una IA, su guía de WTerminal, una vez (Claude Code y Codex como instrucciones de arranque; Gemini y Qwen como primer mensaje) | `true` |
| `agentControl` | booleano: las IA que lanza WTerminal pueden manejarlo con `wterminal --ctl` (órdenes internas y acciones del catálogo; lo que cambia el equipo o los ajustes pide permiso; nunca los permisos del chat ni la seguridad). Se aplica al reiniciar | `true` |
| `offerGsudo` | booleano: si hay NSudo y WTerminal no puede abrirlo, un aviso ofrece instalar gsudo | `true` |
| `offerShellAssist` | booleano: si a la pestaña activa le falta su ayudante de sugerencias (Clink, PSReadLine, ble.sh), un aviso ofrece instalarlo | `true` |
| `agentChatGuide` | booleano: con cada pregunta del chat va, oculta, la guía corta de WTerminal para el agente (que proponga sus funciones antes que winget, apt o pip a pelo, y cómo pedir la guía entera con `wterminal --agent-guide`). Ollama no la recibe | `true` |
| `agentChatAllowBypass` | booleano: el chat deja elegir «Omitir permisos» (el agente hace todo sin preguntar, órdenes incluidas). Pide también `agentChatCanEdit`; nunca es el modo de fábrica | `false` |
| `agentChatRemember` | booleano: el chat manda con cada pregunta las últimas 6 vueltas de la conversación, para que el agente la recuerde; «Nueva conversación» la borra | `true` |
| `showAgentChatButton` | booleano: el botón ✦ al final de la fila de pestañas, que abre y cierra el chat de agentes (sin él, `:chat`, la paleta o su atajo) | `true` |
| `terminalScrollSensitivity` | 1–10 | `3` |
| `copyOnSelect` | booleano | `true` |
| `terminalPadding` | 4–24 | `10` |
| `terminalScrollback` | 1000–100000 | `10000` |
| `fastfetchColor` | `#rrggbb` | color del banner de información del sistema |
| `terminalCursorColor` | `#rrggbb` | color del cursor |
| `uiDensity` | `comfortable`, `compact`: separaciones y margen mínimo de cada control respecto al borde de su panel (`--space-min`: 8 px en cómoda, 4 px en compacta, nunca 0) | `comfortable` |
| `uiScale` | 80–500 (%), escrito en un cuadro numérico (se aplica con Intro o al salir de él): tamaño de barra, pestañas, explorador, avisos, paleta y contenido de los paneles; las casillas de terminal no se escalan. Por encima del 200 % se aplica como mucho lo que deja la interfaz en 480 px de ancho (`effectiveUiScale`) y Ajustes lo avisa. Con la barra estrecha (640 px de CSS o menos: una ventana pequeña o el 137 % en una de 800), Proyectos, Biblioteca, Dependencias y Ajustes pasan a icono, con su nombre en un aviso propio que sale enseguida bajo el botón al pasar el ratón o llegar con el teclado (`data-tip`; el `title` nativo de WebView2 tardaba, a veces no salía y se perdía entre botones pegados, 14-11; lo llevan también ⟳ y el de idioma), y el selector de entorno recupera el sitio (antes se quedaba en «(»). Lo comprueba `test:toolbar-layout`. Atajos `Ctrl+Alt+=`, `Ctrl+Alt+-` (pasos de 10), `Ctrl+Alt+0` y paleta | `100` |
| `githubSessionMode` | `onExhausted`, `always`, `never`: cuándo usar la sesión de `gh` en Explorar GitHub | `onExhausted` |
| `suggestRepositoryImport` | booleano: sugerir importar el repositorio de GitHub de la carpeta de una pestaña | `true` |
| `lowPowerMode` | booleano: modo de bajo consumo. La precarga del catálogo de Dependencias no se hace al arrancar (se construye al abrir el panel), la comprobación de actualizaciones de WinGet espera dos minutos y las sondas de ecosistema van de una en una. Se aplica en el siguiente arranque | `false` |
| `probeLowPriority` | booleano: las sondas de detección (versiones de lenguajes, IA, gestores de paquetes, WinGet) corren con prioridad baja para ceder el paso a las pestañas. 26-11: con todas a la vez y prioridad normal, cmd sacaba 49 líneas por segundo durante la detección del arranque y 153 después. Solo las sondas (`run_with_timeout` y `output_text_probe`), nunca los programas que abre el usuario. Casilla: General › «Detectar entornos con prioridad baja» | `true` |
| `probeMaxParallel` | número de 0 a 64: cuántas sondas corren a la vez. 0 es automático (`process::probe_parallel_limit`): una con el modo de bajo consumo y, si no, la mitad de los hilos de la CPU. El límite se lee en cada sonda: un cambio vale sin reiniciar. Su plazo cuenta desde que le toca, no desde la cola. Va con la prioridad baja: sola, con la CPU ocupada en un equipo de 2 núcleos, la detección casi no avanzaba (por eso `configure_background_command` deja la prioridad normal al resto de procesos ocultos) | `0` |
| `lowPowerSuggest` | booleano: sugerir abajo el modo de bajo consumo cuando el equipo tiene 2 hilos de CPU o menos, menos de 8 GB de memoria, o la primera pestaña tarda más de 8 s en dar el prompt (una vez por sesión; «No volver a sugerir» lo apaga). Casilla: General › «Sugerir el modo de bajo consumo» | `true` |
| `checkUpdatesOnStartup` | booleano: buscar una versión nueva de WTerminal en GitHub al arrancar ([Privacidad y red](#11-privacidad-y-red)) | `true` |
| `checkPackageUpdatesOnStartup` | booleano: preguntar al gestor de paquetes por actualizaciones al arrancar | `true` |
| `webview2Missing` | `ask`, `download`, `never`: qué hace el arranque de Windows si falta WebView2 | `ask` |
| `showSystemBanner` | booleano | `true` |
| `bannerHiddenItems` | lista de campos | `host,kernel,environment,motherboard,gpu,storage,datetime` (**Solo esencial**, 5–8 líneas) |
| `bannerImage` | booleano: imagen a la izquierda del banner | `true` |
| `bannerImageColumns` | 8–40: columnas de la imagen (más 2 de separación) | `20` |
| `bannerImagePath` | ruta absoluta de una imagen propia; vacío = logo de la app | `""` |
| `scriptsHereDepth` | 0–10 | `3` |
| `autoStartDocker` | booleano | `true` |
| `exclusiveAccordionGroups` | booleano | `true` |
| `autoOpenFirstGroup` | booleano | `false` |
| `fileManagerId` | id de gestor | `""` |
| `viewportCols` | 20–1000 | `80` |
| `viewportRows` | 5–500 | `24` |
| `defaultScriptEnvironmentId` | id de entorno | `""` (automático) |
| `shellAssistSuggestionColor`, `shellAssistCommandColor`, `shellAssistArgumentColor`, `shellAssistErrorColor` | `#rrggbb` o vacío (el de cada herramienta) | `""` |
| `shellAssistSuggestionItalic` | booleano | `false` |
| `shellAssistSyntax` | booleano: colorear órdenes y argumentos | `true` |
| `shellAssistListView` | booleano: predicciones en lista en PowerShell (sin PSReadLine 2.2+ no hace nada) | `true` |
| `toolchainStoreEnabled` | booleano: carpeta propia `entornos` | `true` |
| `toolchainStoreDir` | ruta absoluta o vacía (la de fábrica) | `""` |
| `toolchainStoreDownloads`, `toolchainStoreAiModels` | booleanos: categorías activas de la carpeta propia | `true` |
| `toolchainStoreTools`, `toolchainStoreReplHistory` | booleanos: herramientas nuevas (con sus `bin` en el PATH) e historial de los REPL en la carpeta propia | `true` |
| `toolchainStoreToolchains` | booleano: toolchains completas (rustup, cargo, GOPATH, Gradle, .NET, Android) en la carpeta propia, solo si no estaban instaladas | `true` |
| `clearReprintBanner` | booleano: `clear`/`cls` vuelve a pintar el mismo banner (fastfetch) tras limpiar la pantalla | `true` |
| `showDependenciesPanel` | booleano: botón de Entorno y dependencias en la barra | `true` |
| `showProjectsPanel` | booleano: botón de Proyectos en la barra | `true` |
| `showScriptsPanel` | booleano: botón de la Biblioteca en la barra | `true` |
| `showQuickActions` | booleano: acciones rápidas bajo el banner | `true` |
| `ltoolsEnabled` | booleano: integración experimental de LTools en la Biblioteca | `false` |
| `showExplorerPanel` | booleano: explorador de archivos lateral | `true` |
| `showTabBar` | booleano: fila de pestañas | `true` |
| `showEnvironmentSelector` | booleano: selector de entorno de la barra | `true` |
| `showRefreshButton` | booleano: botón ⟳ de volver a detectar entornos | `true` |
| `showLanguageButton` | booleano: botón de idioma de la barra | `true` |
| `terminalOnlyMode` | booleano: modo de pantalla limpia: solo la terminal, sin barras (se sale con su atajo o `:settings`) | `false` |
| `showTerminalOnlyGuide` | booleano: la guía del modo de pantalla limpia con su atajo de salida; su «No volver a mostrar» la apaga y se vuelve a encender con su casilla («Guía visible en pantalla limpia») o desde Ajustes › Avisos | `true` |
| `startMaximized` | booleano: la ventana arranca maximizada | `false` |
| `startAsAdmin` | booleano: solo Windows: al arrancar sin permisos de administrador, se relanza con el UAC; si se cancela, sigue sin elevar | `false` |
| `manualAliasesText` | texto: alias propios, uno por línea (`nombre=orden`) | `""` |
| `favoriteReplIds` | ids de REPL separados por comas que salen arriba en el selector | `""` |
| `hiddenEnvironmentIds` | ids de entorno separados por comas que no salen en el selector | `""` |
| `shortcutCommandPalette` | atajo: Abrir la paleta de comandos (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+P` |
| `shortcutNewTab` | atajo: Nueva pestaña (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+T` |
| `shortcutNextTab` | atajo: Pestaña siguiente (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Tab` |
| `shortcutPreviousTab` | atajo: Pestaña anterior (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+Tab` |
| `shortcutCyclePanes` | atajo: Dividir terminales (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+Backslash` |
| `shortcutToggleExplorer` | atajo: Mostrar explorador (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+E` |
| `shortcutToggleTerminalOnly` | atajo: Modo terminal limpia (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+M` |
| `shortcutPaneLeft` | atajo: Foco a la izquierda (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+ArrowLeft` |
| `shortcutPaneRight` | atajo: Foco a la derecha (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+ArrowRight` |
| `shortcutPaneUp` | atajo: Foco arriba (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+ArrowUp` |
| `shortcutPaneDown` | atajo: Foco abajo (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+ArrowDown` |
| `shortcutOpenSettings` | atajo: Abrir ajustes (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Comma` |
| `shortcutOpenProjects` | atajo: Abrir proyectos (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutOpenScripts` | atajo: Abrir biblioteca (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutOpenDependencies` | atajo: Abrir entorno y dependencias (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutClosePanel` | atajo: Cerrar panel (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutRefreshEnvironments` | atajo: Volver a detectar entornos (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutExplorerFollow` | atajo: Seguir la ruta de la terminal (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutExplorerCd` | atajo: Llevar la terminal a esta carpeta (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutClearTerminal` | atajo: Limpiar terminal (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutSearchTerminal` | atajo: Buscar en el historial de la terminal (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+F` |
| `shortcutSearchHistory` | atajo: Buscar en las órdenes escritas (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+R` |
| `shortcutPreviousCommand` | atajo: Ir a la orden anterior (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+ArrowUp` |
| `shortcutNextCommand` | atajo: Ir a la orden siguiente (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+ArrowDown` |
| `shortcutUiScaleUp` | atajo: Aumentar el tamaño de la interfaz (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+Equal` |
| `shortcutUiScaleDown` | atajo: Reducir el tamaño de la interfaz (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+Minus` |
| `shortcutUiScaleReset` | atajo: Tamaño de la interfaz al 100 % (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Alt+0` |
| `shortcutOpenSystemExplorer` | atajo: Abrir en el explorador del sistema (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutCloseTab` | atajo: Cerrar la pestaña (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+W` |
| `shortcutRenameTab` | atajo: Renombrar la pestaña (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutCopyLastOutput` | atajo: Copiar la salida de la última orden (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutSaveTerminalOutput` | atajo: Guardar la salida en un archivo (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `""` |
| `shortcutTerminalFontUp` | atajo: Agrandar la letra de la terminal (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Equal` |
| `shortcutTerminalFontDown` | atajo: Achicar la letra de la terminal (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Minus` |
| `shortcutTerminalFontReset` | atajo: Letra de la terminal a su tamaño de fábrica (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+0` |
| `shortcutToggleAgentChat` | atajo: Mostrar u ocultar el chat de agentes (vacío = sin tecla; ver [Atajos de teclado](#atajos-de-teclado)) | `Ctrl+Shift+A` |
| `shortcutGoToTab` | atajo: Ir a la pestaña 1; con los mismos modificadores, 2…9 van a las pestañas 2 a 9 y 0 a la 10 (vacío = sin tecla) | `Ctrl+Shift+1` |
| `uiBackgroundColor` | `#rrggbb`: fondo de la interfaz (lo rellena el tema; se puede retocar) | `#0d0d0d` |
| `uiSurfaceColor` | `#rrggbb`: superficie de paneles y barras | `#1e1e1e` |
| `uiSurfaceAltColor` | `#rrggbb`: superficie alternativa (filas, cajas) | `#161616` |
| `uiBorderColor` | `#rrggbb`: bordes | `#333333` |
| `uiTextColor` | `#rrggbb`: texto | `#d4d4d4` |
| `uiMutedColor` | `#rrggbb`: texto secundario | `#888888` |
| `terminalSelectionColor` | `#rrggbb`: fondo de la selección en la terminal | `#4b5056` |
| `suggestMissingTools` | booleano: si una orden no existe y WTerminal sabe instalarla, un aviso abajo lo ofrece (nunca instala solo); su «No volver a mostrar» lo apaga. Casilla: Terminal › «Ofrecer instalar las órdenes que faltan» | `true` |
| `offerPortableProfile` | booleano: si hay ajustes propios y ningún perfil en `<carpeta propia>/configuracion/perfiles`, un aviso sugiere guardar uno ([Perfiles portables](#1-perfiles-portables)) | `true` |
| `terminalAdminByDefault` | booleano: solo Windows: pide el UAC al iniciar para que las shells, intérpretes y herramientas hereden permisos de administrador | `false` |
| `toolchainStorePrograms` | booleano: categoría «Programas» (WinGet con `--location`) dentro de la carpeta propia | `true` |
| `toolchainStoreProjects` | booleano: categoría «Proyectos de GitHub» dentro de la carpeta propia | `false` |
| `toolchainStoreConfig` | booleano: categoría «Configuración» (REPL como IPython y Jupyter, y los perfiles portables en `configuracion/perfiles`) | `true` |
| `toolchainStorePlugins` | booleano: categoría «Plugins» de las shells (caché de starship y el perfil de Clink propio) | `true` |
| `toolchainStoreCategoryDirs` | texto: carpeta propia de cada categoría, `categoría=carpeta` por línea; las que no salen van en la carpeta propia | `""` |
| `toolchainStoreDisabled` | ids de entradas apagadas una a una (separados por comas) aunque su categoría siga activa | `""` |
| `shellAssist` | booleano: sugerencias del historial y colores en la línea de órdenes (Clink, PSReadLine, ble.sh o plugins de zsh) si están instalados | `true` |
| `shellAssistCmd` | booleano: lo mismo, solo en cmd (Clink) | `true` |
| `shellAssistPowershell` | booleano: lo mismo, solo en PowerShell (PSReadLine) | `true` |
| `shellAssistBash` | booleano: lo mismo, solo en bash (ble.sh) | `true` |
| `shellAssistZsh` | booleano: lo mismo, solo en zsh (sus plugins) | `true` |

### 8. Temas

Hay 15, agrupados por color y con al menos dos variantes cada uno
(`THEME_FAMILIES` en `config/preferences.rs`, que un test mantiene: cada tema
en una sola familia, cada familia con dos o más y un total múltiplo de cinco):

| Familia | Temas |
|---|---|
| Neutro | Negro y plata, Pizarra |
| Azul | Cian técnico, Océano, Nórdico |
| Turquesa | Turquesa, Menta |
| Verde | Bosque, Fósforo verde |
| Amarillo | Ámbar, Alto contraste |
| Rojo | Carmesí, Rubí |
| Violeta | Violeta, Ciruela |

De fábrica todos comparten la base negra de «Cian técnico» (fondo,
superficies, bordes y texto) y solo cambian el acento, su versión suave y la
selección (`effective_palette` en `config/preferences.rs` y `effectivePalette`
en `src/lib/theme.ts`, con las mismas reglas). «Recolorear toda la interfaz con
el tema» (`themeRecolorAll`) aplica la paleta completa de cada tema; el de alto
contraste la conserva siempre, porque existe por su texto blanco puro. «Guardar
como tema» guarda los colores actuales y la paleta ANSI con un nombre; los
temas propios aparecen junto a los de fábrica, se borran con su ×, la orden
`:theme <id>` también los aplica y, como viven en las preferencias, viajan con
«Exportar perfil». En Apariencia están además los 16 colores ANSI (con su
muestra) y en Terminal la fuente escrita a mano (`terminalFontCustom`), que va
delante de la familia elegida y de los respaldos de símbolos.

### 9. Ajustes que no se editan desde la interfaz

`fileManagerId`, `viewportCols` y `viewportRows` no se editan desde la interfaz:
los escribe la aplicación. Los dos últimos guardan el tamaño medido de la
terminal para que la primera sesión de la próxima ejecución nazca ya con él.

### 10. Si el entorno inicial ya no existe

Si el entorno inicial guardado deja de existir, se usa el entorno automático
del sistema.

### 11. Privacidad y red

WTerminal no envía telemetría. Lo único que hace por su cuenta contra la red
o contra el sistema al arrancar tiene su propia opción en Ajustes ›
General › **Privacidad y red** (`data-testid="settings-privacy-network"`),
porque cada comportamiento automático de la app se tiene que poder apagar:

| Opción | Clave | De fábrica | Qué hace al apagarla |
|---|---|---|---|
| Buscar actualizaciones de WTerminal al arrancar | `checkUpdatesOnStartup` | `true` | `update_check_on_startup` no consulta GitHub: no hay aviso de versión nueva. Ajustes y el panel de Dependencias pueden seguir buscándola a mano |
| Buscar actualizaciones de programas al arrancar | `checkPackageUpdatesOnStartup` | `true` | `package_updates_check` no pregunta a WinGet ni al gestor de la distribución (lo deja en el log); en Dependencias se sigue pudiendo actualizar |
| Si falta WebView2 (solo Windows) | `webview2Missing` | `ask` | `ask` pregunta antes de descargar nada, `download` lo descarga de Microsoft sin preguntar y `never` solo usa un instalador local (ver [WebView2: si falta el runtime](#8-webview2-si-falta-el-runtime)) |

Lo demás que toca la red lo pide siempre el usuario: clonar o explorar en
GitHub, instalar desde Dependencias, descargar modelos o abrir enlaces. El
modo de bajo consumo (`lowPowerMode`) además retrasa dos minutos la consulta de
actualizaciones de programas.

### 12. Avisos

#### 12.1 Qué son

Los avisos son las barras que WTerminal saca por su cuenta para ofrecer algo:
una actualización, instalar lo que falta, guardar un perfil… Nunca hacen nada
solos: el botón principal lleva a donde se ve y se confirma lo que se va a
hacer.

#### 12.2 Cómo se ven

Desde el 17-11 todos los avisos de abajo usan la misma barra que el de las
actualizaciones de WinGet. Antes, el que ofrecía instalar Clink, PSReadLine o
ble.sh (y el de gsudo) era una caja flotante arriba a la derecha.

- **Orden:** los que ofrecen instalar algo (gsudo y el ayudante de la shell) van
  encima del de WinGet; si coinciden, se apilan.
- **Uno cada vez:** los que solo sugieren algo (bajo consumo, importar un
  repositorio, guardar un perfil) esperan a que no haya otro abajo.

#### 12.2 bis Mismos botones en todos (22-11)

Todos los avisos llevan, por este orden, su botón principal, **Ahora no** (`…-dismiss`)
y **No volver a mostrar** (`…-never`). La guía de la terminal limpia decía «Cerrar
esta vez» y «No mostrar nunca más», y el de guardar en el perfil, «Cerrar»: ya
no. «No sugerir este» del de importar se queda, porque solo apaga ese
repositorio. La prueba `notices` (suite `nuevas`) saca a la fuerza los que en
las pruebas no salen solos (`window.__wtE2eForceNotice`, solo con
`e2eTesting`) y pulsa sus botones.

#### 12.3 «No volver a mostrar»

Cada aviso tiene su botón «No volver a mostrar», que apaga su ajuste:

| Aviso | Ajuste |
|---|---|
| Falta el ayudante de la shell (Clink, PSReadLine, ble.sh) | `offerShellAssist` |
| Actualizaciones de las aplicaciones (WinGet o el gestor del sistema) | `checkPackageUpdatesOnStartup` |
| Versión nueva de WTerminal | `checkUpdatesOnStartup` |
| Una orden necesita una herramienta que no está instalada | `suggestMissingTools` |
| Preguntar a la IA cuando falla una orden (en la pestaña) | `agentChatAdvisor` |
| Una IA pide su clave de API (en la pestaña) | `aiKeyOffer` |
| No tienes ningún perfil portable guardado | `offerPortableProfile` |
| Añadir a Proyectos el repositorio de la carpeta | `suggestRepositoryImport` |
| Modo de bajo consumo en equipos modestos | `lowPowerSuggest` |
| gsudo para abrir las pestañas de NSudo (solo Windows) | `offerGsudo` |
| Guía del modo de pantalla limpia | `showTerminalOnlyGuide` |
| Guardar los ajustes cambiados en tu perfil | `offerProfileUpdate` |
| Guía de primeros pasos (no tiene el botón: terminarla o saltarla lo apaga) | `showFirstSteps` |

«Ahora no» (o «Descartar») solo lo cierra esa vez. Importar un repositorio
tiene además «No sugerir este», que olvida solo ese repositorio.

La petición de permiso de una IA (`wterminal --ctl`) no está en la lista a
propósito: no es un aviso, es una pregunta que la IA espera, y apagarla sería
conceder o negar sin preguntar.

#### 12.4 Recuperarlos

Cada aviso tiene **una sola casilla** en Ajustes, en su sitio:

| Aviso | Dónde está su casilla |
|---|---|
| Ayudante de la shell | Terminal › «Ofrecer instalarlo si falta», bajo el ayudante |
| Herramienta que falta | Terminal › «Ofrecer instalar las órdenes que faltan» |
| Preguntar a la IA | Terminal › «Modo consejero» |
| Clave de API de una IA | Terminal › «Ofrecer la clave de API cuando una IA la pida» |
| Actualizaciones de las aplicaciones y versión nueva | General › Privacidad y red |
| Bajo consumo | General › «Sugerir el modo de bajo consumo» |
| Importar un repositorio | General › «Sugerir importar repositorios» |
| Guía de pantalla limpia | General › «Guía visible en pantalla limpia» |
| gsudo | Sistema › Permisos de administrador |
| Perfil portable y guardar los ajustes cambiados | Sistema › Perfiles portables |
| Primeros pasos | General › «Guía de primeros pasos al arrancar» |

Ajustes › General › **Avisos** (`data-testid="settings-notices"`) no
repite esas casillas:

- **Lista los apagados:** solo los que están apagados ahora, cada uno como un
  botón (`settings-notice-<id>`). Al pulsarlo, Ajustes cambia de pestaña,
  baja hasta su casilla y la resalta un momento.
- **«Volver a mostrar todos los avisos»:** los enciende todos y además olvida lo
  que se dejó «para luego»: la versión de WTerminal descartada y el
  recordatorio de 24 h de WinGet.

La lista sale de `src/lib/notices.ts`, la misma que usan los botones de los
avisos. Allí cada aviso dice en qué pestaña y en qué casilla está su ajuste.

#### 12.5 Primeros pasos (21-11)

Romen, 21-11: «al abrir la app por primera vez, el usuario va a tener que ver
todos los popup, ¿por qué no hacer un tour?». La **guía de primeros pasos**
(`FirstSteps.svelte`, pasos en `src/lib/first-steps.ts`) sale sola al arrancar
mientras `showFirstSteps` esté encendido:

- **Siete pasos:** bienvenida, pestañas, shells y REPL, paleta de comandos,
  Entorno y dependencias, chat con IA, y Ajustes y avisos. Cada uno resalta el
  botón del que habla si está a la vista.
- **Botones:** «Siguiente» (o Intro/→), «Atrás» (←), «Saltar» (o Esc) y
  «Empezar» en el último. Sin «No volver a mostrar» (21-11, Romen: «mejor
  quedarse solo con siguiente, atrás y saltar»): **terminarla o saltarla apaga
  sola `showFirstSteps`**, y vuelve a salir al arrancar solo si se enciende otra
  vez su casilla.
- **Los avisos esperan:** mientras se ve, las barras de abajo no se muestran
  (siguen en su estado) y salen al cerrarla.
- **Volver a verla:** Ajustes › General › «Ver los primeros pasos
  ahora», o «Ver los primeros pasos» en la paleta de comandos. Su casilla
  («Guía de primeros pasos al arrancar») también está en Avisos.
- **Nunca en E2E** salvo que la prueba la abra: un aviso que no esperan
  movería la terminal.

---

### 13. Las pestañas de Ajustes (22-11)

Romen, 22-11: «reorganiza un poco los ajustes». Comportamiento tenía once
bloques y los ajustes de IA estaban dentro de Terminal, mezclados con la
fuente y el cursor. Ahora:

| Pestaña | Qué tiene |
|---|---|
| Apariencia | Tema y colores |
| Terminal | Texto y cursor, enlaces, marcas de orden, acciones, sugerencias de la shell y banner |
| IA | Chat de agentes, consejero, permisos, guía y control de WTerminal por las IA, clave de API |
| General (antes Comportamiento) | Inicio y paneles, secciones visibles, interfaz modular, entornos, carpeta propia, avisos, privacidad y red |
| Atajos | Atajos de teclado y alias manuales |
| Sistema | PATH, integración de Windows y permisos de administrador, perfiles portables, plugins y LTools |
| Programas | cmd, PowerShell y Git (apartado 14) |
| Información | Versión, actualización y créditos |

El id interno de General sigue siendo `behavior` (`settings-tab-behavior`)
para no romper los enlaces de Avisos ni las pruebas. Las pruebas E2E buscan
un control de Ajustes en todas las pestañas si no está en la abierta
(`showSettingsTabContaining` en `smoke.mjs`), así una reorganización no las
rompe.

### 14. Programas (cmd, PowerShell y Git)

Desde el 22-11 Ajustes tiene la pestaña **Programas**: ajustes de los
programas que se usan en la terminal, no de la terminal. Romen: «se podrían
añadir ajustes para las aplicaciones de la terminal y no solo para la
terminal».

#### 13.1 Qué hay

| Programa | Ajustes | Dónde se guarda |
|---|---|---|
| cmd | Texto del prompt (con plantillas: normal, en dos líneas, con la hora), expansión retardada de variables, extensiones de órdenes | La variable `PROMPT` del usuario y `HKCU\Software\Microsoft\Command Processor` |
| Windows PowerShell 5 y PowerShell 7 | Modo de edición (Windows, Emacs, Vi), sin órdenes repetidas en el historial, tamaño del historial, pitido, salida en UTF-8 | Un bloque marcado «WTerminal» al final de `Documentos\WindowsPowerShell\profile.ps1` o `Documentos\PowerShell\profile.ps1`; lo de fuera del bloque no se toca |
| Git | Nombre, correo, rama inicial, finales de línea, editor, pull con rebase, subir ramas nuevas sin más, limpiar ramas borradas, rutas largas, colores | `git config --global` |
| Git Bash | Tamaño del historial, no guardar repetidas, modo de edición (Emacs/Vi), pitido, completar sin mayúsculas | Bloque «WTerminal» en `~\.bashrc` (historial) y `~\.inputrc` (línea) |
| npm | Mensajes de financiación, auditoría al instalar, aviso de versiones nuevas, registro | `npm config --location=user` |
| pip | Aviso de versiones nuevas, tiempo de descarga, índice | `pip config --user` |
| WinGet | Barra de progreso, telemetría, instalar para el usuario o el equipo | Su `settings.json` (copia `settings.json.wterminal-bak` antes del primer cambio; se leen sus comentarios `//`) |
| Python | Modo UTF-8 (`PYTHONUTF8`), sin `__pycache__` | Variables de usuario |
| Node.js | Historial del REPL (`NODE_REPL_HISTORY_SIZE`) | Variable de usuario |
| Claude Code | Modelo, modo de permisos (sin «Omitir permisos»), firmar commits, días de conversaciones | `~\.claude\settings.json` (solo esas claves) |
| Codex | Modelo, intensidad, cuándo pide permiso, qué puede tocar (sin acceso total) | `~\.codex\config.toml` (solo esas claves de primer nivel) |

#### 14.2 Por qué solo esos

Están los que **se notan dentro de WTerminal**. Los de la ventana clásica de
cmd (fuente, tamaño, colores del clic derecho › Propiedades) no: WTerminal
pinta su propia terminal y esos se ajustan en Apariencia y Terminal. Tampoco el
«AutoRun» de cmd (WTerminal abre cmd con `/d`) ni la directiva de ejecución de
PowerShell (WTerminal abre PowerShell con `-ExecutionPolicy Bypass`): solo se
notarían fuera. El prompt de cmd se respeta (WTerminal solo le añade las marcas
de orden) y WTerminal ya pone UTF-8 en cmd.

#### 14.3 Seguridad y deshacer

- Cada valor se valida antes de guardarlo (opciones cerradas, números en su
  rango, sin saltos de línea; un valor no puede colar una orden en el perfil).
- Antes de cada cambio se apunta el valor anterior en
  `USER_DATA_DIR/programas/deshacer.json`; **Deshacer el último cambio**
  devuelve, programa a programa, el anterior.
- El prompt de cmd vale en las pestañas nuevas sin reiniciar: además de
  guardarse, se pone en el entorno de WTerminal, del que nacen las pestañas.
- Solo salen los programas instalados; Linux, por ahora, sin esta pestaña.
- **Valores recomendados** (`applyProgramDefaults`, encendido de fábrica,
  23-11): a cada programa instalado, también si se instala después, WTerminal
  le pone UNA vez y sin pisar lo que tuviera el usuario: Git Bash completa sin
  distinguir mayúsculas, npm sin mensajes de financiación y WinGet sin
  telemetría (`RECOMMENDED`; lo ya mirado en `programas/recomendados.json`). Se
  hace al arrancar (en segundo plano, 45 s después) y al abrir la pestaña.
- **Caché** (23-11): lo último leído se guarda en `programas/cache.json`; la
  pestaña lo enseña al momento y lo de ahora llega detrás («Comprobando los
  valores actuales…»). Los programas se leen a la vez, cada uno en su hilo, y
  tras un cambio solo se relee ese programa (antes la casilla quedaba
  deshabilitada varios segundos mientras se releían npm y pip).
- **Aspecto:** cada programa en su desplegable, con cuántos ajustes has
  cambiado; los desplegables enseñan el valor que rige (por ejemplo «master»)
  y «Lo que trae el programa» solo cuando no se sabe cuál es.

#### 14.4 Lo que falta

Falta: bash y zsh dentro de WSL (sin hipervisor en la VM no se pueden probar),
Gemini y Qwen (sus ajustes cambian mucho entre versiones) y Docker. WTools y
LTools no tienen un archivo de ajustes propio: su integración está en Sistema y
sus acciones fijadas en la Biblioteca (`config/programs_more.rs`).

## Internacionalización

### 1. Idiomas

La interfaz está disponible en 15 idiomas. Por defecto sigue al idioma del sistema
(`auto`); el desplegable de Ajustes permite fijar uno, y el cambio se aplica al
instante sin reiniciar. Alcanza a los paneles, el menú contextual, el
explorador, los mensajes de error y el banner de cada sesión.

### 2. Lo que no se traduce, a propósito

Nombres propios (Docker, PowerShell, Nautilus),
rutas, comandos y su salida. Traducir un comando lo rompería, y la salida es de
los programas que ejecuta el usuario.

### 3. Los catálogos

Los catálogos viven en `src-tauri/locales/*.json`. El español es el idioma de
referencia y sirve de respaldo, de modo que una clave sin traducir se ve en
español y nunca como un identificador.

### 4. Añadir un idioma

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
| `userData` | `%APPDATA%\wterminal\` | `~/.config/lterminal/` |
| Configuración | `settings.json` | `settings.json` |
| Biblioteca de scripts | `scripts\` | `scripts/` |
| Logs | `logs\main.log` (rota a `main.log.1` al superar 2 MB) | ídem |
| Variable de depuración | `WINSLIM_LOG_LEVEL=debug` | `LTERMINAL_LOG_LEVEL=debug` |

### 1. Dónde están los registros

La interfaz no muestra un botón **Logs**: fue retirado para que la barra no
acumule superficies fijas. Los logs siguen disponibles en la ruta real indicada
arriba. Los archivos de inicialización y banner de cada sesión van a una carpeta
temporal por PID, de modo que dos instancias abiertas a la vez no se pisan ni se
borran los archivos al salir.

### 2. Qué lleva cada línea

Los registros llevan hora UTC con milisegundos, identificador de sesión y
metadatos JSON. Se anotan la migración, el arranque, cada PTY, duración de
procesos y cierre. Para investigar una sesión concreta se puede usar
`LTERMINAL_LOG_LEVEL=debug` en Linux o `WINSLIM_LOG_LEVEL=debug` en Windows
(en ese nivel `settings_save` anota también cada fase del guardado).

### 3. Diagnóstico desde la página: `__wtPendingIpc`, `__wtTerminalState` y `__wtInputState`

Una llamada IPC que no vuelve no deja rastro en el log, porque su métrica se
escribe al terminar. `window.__wtPendingIpc()` (desde las herramientas de
desarrollo del WebView) devuelve las llamadas en vuelo con su antigüedad
(`api::pendingIpcCalls`); el E2E la vuelca cuando un guardado de Ajustes no
termina. Así se encontró que nueve `toolchain_store_external_sizes`
esperando a la misma medición dejaban sin hilos el runtime asíncrono.
`window.__wtTerminalState(tabId)` devuelve, solo para leerlo, el estado de un
xterm: filas, desplazamiento (`viewportY`/`baseY`), si su renderer está en
pausa y las dimensiones del área de scroll de su Viewport. Con él se vio que,
al volver a una pestaña oculta, el reajuste llegaba con el renderer aún en
pausa si el aviso de visibilidad de xterm tardaba más que el plazo de reserva
de 200 ms: el Viewport recortaba el scroll con el alto viejo y la vista dejaba
de seguir la salida. `fitAndReport` reanuda antes el renderer si la casilla ya
tiene tamaño (`resumeRendererIfVisible`).
`window.__wtInputState(tabId)` devuelve el estado de la cola de entrada de una
pestaña: la barrera en la que espera el lote de teclas que va primero
(`inputBarrier`, `outputInputReady`, `outputGeometryReady`,
`activationGeometryReady`, `resizeQueue` o `sendInput`) y desde cuándo, cuántos
lotes con Intro se encolaron y cuántos se enviaron, y si la ventana se ve y
tiene el foco. Lo usan `tab-tools` (al fallar la línea larga) y `hidden-enter`
para separar un Intro que no llegó a la terminal, uno retenido en la app y una
shell que no lo procesa.

### 4. Métricas de rendimiento

También se registran métricas segmentadas del WebView: `sinceStartMs` es el
tiempo desde que cargó el frontend y `durationMs` la operación concreta.
Incluyen `app.initial-load`, `app.ui-shell-visible`, disponibilidad para
escribir, `fastfetch.banner-visible`, montaje y resize de cada terminal,
impresión explícita del banner, `ui.panel.visible` para cada menú/panel e `ipc.*` para
cada llamada relevante al backend. Las entradas de teclado, parseo de cada
tecla y cada píxel de resize se agrupan para no inundar el archivo.

### 5. El informe del smoke

El smoke guarda además un informe JSON en `/tmp/lterminal-smoke-<token>.json`
con las métricas agrupadas por operación: repeticiones, mínimo, máximo y
media. Así se puede distinguir, por ejemplo, cuánto tardó en aparecer la
ventana, cuánto tardó el banner de una pestaña concreta y cuánto tardó una
descarga o un panel, sin mezclarlo con la duración total de las pruebas.
El informe incluye además `timings`: `phases` desglosa cada fase, `shells`
registra la carga y la sonda de cada shell/REPL, `operations` conserva las
acciones con duración explícita y `timeline` anota todos los eventos con su
tiempo acumulado (`elapsedMs`) y el tiempo desde el punto de control anterior
(`sincePreviousMs`). La salida del smoke muestra el mismo resumen mientras
termina, por lo que una shell lenta o una operación concreta se puede localizar
sin esperar a analizar el JSON.

El smoke espera eventos reales de WebDriver, del compositor y del repintado
del banner, sin repetir comandos de shell después de cada resize. Esto reduce
el tiempo de la batería sin quitar tamaños, paneles ni estados de ventana.
Para investigar específicamente la ruta de teclado de `sysinfo` se puede usar
`E2E_FORCE_SHELL_REFRESH=1 npm run e2e`; también admite `E2E_WM_TIMEOUT_MS`,
`E2E_POLL_INTERVAL_MS`, `E2E_FOCUS_SETTLE_MS` y `E2E_COMMAND_SETTLE_MS` para
diagnosticar máquinas especialmente lentas.

## Perfiles portables y plugins

### 1. Perfiles portables

Desde Ajustes se puede exportar un perfil `.lterminal-profile` en Linux,
`.winslim-profile` en Windows o un instalador
reproducible `.sh`/`.ps1`. El script explica lo que guarda, no incluye
contraseñas, tokens, claves privadas ni binarios, comprueba el sistema y la
arquitectura, verifica la descarga cuando GitHub publica `SHA256SUMS.txt` y
busca una instalación existente antes de instalar la aplicación. Después
importa la configuración y los manifests de plugins declarativos.

#### 1.1 Su carpeta

Desde el 17-11 los perfiles tienen una carpeta fija: `perfiles`, dentro de la
configuración de la carpeta propia.

- **Windows:** `%LOCALAPPDATA%\WTerminal\entornos\configuracion\perfiles`.
- **Linux:** `~/.local/share/LTerminal/entornos/configuracion/perfiles`.
- **Si se cambia:** sigue a la carpeta propia (`toolchainStoreDir`) y a la de la
  categoría Configuración si tiene una aparte (`toolchainStoreCategoryDirs`).

Es la misma ruta para todo, y sale de una sola función
(`commands::profiles_dir`):

- **la sugerencia** (abajo);
- **«Exportar perfil» e «Importar perfil»**, que abren el diálogo en ella;
- **«Guardar perfil ahora»**, que guarda sin diálogo como
  `WTerminal-Perfil-AAAA-MM-DD.ps1` (`.sh` en Linux) sin pisar otro del mismo
  día;
- **el diálogo de restablecer;**
- **el desinstalador.**

#### 1.2 La sugerencia

Si has cambiado algún ajuste (o tienes plugins) y en la carpeta no hay ningún
perfil, unos 45 s después de arrancar sale un aviso abajo: «Guardar perfil»,
«Ahora no» y «No volver a mostrar» (`offerPortableProfile`). No sale en las
pruebas E2E: el perfil de la prueba siempre trae ajustes propios.

#### 1.3 Guardar los ajustes que cambias (21-11)

Romen, 21-11: «cuando cambias algún ajuste, no ofrece guardarlo». Si ya hay
algún perfil en su carpeta, al **cerrar Ajustes con cambios** sale abajo:

- **«Guardar en el perfil actual»**: reescribe el perfil más reciente de la
  carpeta (`profile_update`, que solo acepta un archivo que ya existe dentro de
  la carpeta de perfiles: `profile_inside`);
- **«Crear otro perfil»**: lo mismo que «Guardar perfil ahora»;
- **«Cerrar»** y **«No volver a mostrar»** (`offerProfileUpdate`, encendido de
  fábrica; casilla en Sistema › Perfiles portables, y recuperable en
  Avisos).

Se compara la huella de los ajustes al abrir y al cerrar Ajustes
(`src/lib/profile-update.ts`), sin contar lo que la app escribe sola (tamaño de
la terminal y gestor de archivos). Sin ningún perfil sigue mandando la
sugerencia de 1.2.

La comparación se hace cuando ha terminado de guardarse el último cambio
(`app.preferencesSettled()`), no a un tiempo fijo: con el equipo cargado,
guardar llegó a tardar 6,6 s y el aviso no salía (build 81, 22-11).

#### 1.4 Al restablecer y al desinstalar

- **Restablecer:** el diálogo dice cuántos perfiles hay y dónde, recuerda que
  restablecer no los toca y ofrece «Guardar perfil ahora» antes de confirmar.
- **Desinstalar:** los perfiles se conservan siempre. La configuración es de lo
  que «Borrar la carpeta propia» nunca borra, y «Borrar los datos» no toca la
  carpeta propia. El informe del desinstalador (`[profiles]`, con la ruta y
  cuántos hay) hace que la página de confirmación lo diga en la misma casilla
  de la carpeta propia, o en una nota aparte si esa casilla no sale. Al
  reinstalar, «Importar perfil» abre ya en esa carpeta.

### 2. Plugins

Los plugins actuales son una base segura para ampliar la terminal: solo
declaran intérpretes y tecnologías, no cargan código nativo. El formato se
valida al instalar `plugin.json` y sus límites están implementados en
`src-tauri/src/config/plugins.rs`; se pueden instalar desde Ajustes ›
Comportamiento.

---

## Pruebas

Qué se prueba, con qué y qué no demuestra cada prueba. Las órdenes y los
scripts concretos están en [Mapa de scripts y pruebas](#mapa-de-scripts-y-pruebas).

### 1. Los tests de Rust

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

### 2. Lo que tiene que pasar antes de compilar

```bash
npm run check
```

Pasa la verificación de versión, recursos, arquitectura, scripts de build,
enlaces locales de documentación, traducciones, contratos cruzados,
lógica ejecutable del frontend, superficie de tests y superficie lógica,
`svelte-check`, `cargo fmt --check`, `cargo clippy -D warnings` y los tests de
Rust. Es lo que tiene que estar en verde antes de compilar.

### 3. Auditoría de release y comportamiento observable

Una build correcta no basta: hay que abrir el artefacto que se va a entregar y
comprobar la ruta que recorrerá el usuario. La batería oficial hace lo siguiente:

#### 3.1 Qué recorre

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

#### 3.2 Límites de confianza

Cada informe explicita sus límites de confianza: una prueba headless no acredita
la presentación gráfica y Wine no acredita Windows nativo. Si una plataforma o
una fase no se pudo ejecutar, no se declara aprobado ese alcance.

### 4. La batería ampliada de las builds

#### 4.1 Cuándo corre y cómo se omite

La build Linux ejecuta por defecto la batería ampliada. Además del smoke test
de ventana/frontend/PTY, comprueba shells y herramientas instaladas y ejecuta
E2E con `tauri-driver`; si falta una precondición, el AppImage se publica y el
build informa el diagnóstico al final con código 1. Se puede omitir con `linux/build.sh --no-extended-tests` o
`windows/build.ps1 -NoExtendedTests`; en Windows `-FullTests` la selecciona
explícitamente. La falta del driver E2E se registra como diagnóstico y no
oculta el artefacto ya generado.

#### 4.2 Qué recorre el smoke

El smoke recorre
Ajustes, Biblioteca, Proyectos, Entorno y dependencias, acordeones, explorador
y menú contextual, comandos internos, respuesta de la shell, división y
varios tamaños de ventana. También ejecuta los atajos globales de nueva pestaña,
navegación entre pestañas, división y explorador, conservando capturas antes y
después. Repite refrescos de entornos, clics de
división y aperturas de paneles para detectar carreras y estados residuales.

#### 4.3 El informe y sus fases

El informe JSON se vuelve a validar al terminar y debe contener catorce fases,
incluido el arrastre real de ratón y la matriz de shells con comandos en PTY y
restauración de la shell inicial, las salidas simuladas de actualización y evidencias de menú contextual,
grupos/submenús de dependencias y la matriz responsive con dos paneles y el
explorador visible y oculto. Una ventana que solo arranca y se cierra ya no
puede contarse como E2E superado.

#### 4.4 Cobertura de WSL

En Windows, el evento `wsl-distro-selector-coverage` exige que cada distro
instalada (`wsl:<distro>`) se haya probado; su `testedIds` lleva solo las
distros, en su orden, y las variantes de shell de cada una (`wsl:Ubuntu:sh`) van
aparte en `shellVariantIds`, para que probarlas no descuadre la cobertura.

#### 4.5 Validación cruzada: Wine, WSLg y WSL1

La ruta Linux→Windows repite el arranque Wine con prefijos independientes; la
ruta Windows→Linux repite el mismo build y E2E dentro de WSLg.
Si la distribución instalada es WSL1, no hay WSLg ni un compositor Linux: se
pueden ejecutar la build, los scripts y la matriz de shells, pero la fase
gráfica completa del AppImage queda condicionada al driver WebKitGTK/X11 y a
que el empaquetador `linuxdeploy` termine sobre `/mnt/c`. El informe conserva
esa limitación como diagnóstico y no la cuenta como una E2E gráfica Linux
aprobada.

### 5. La IA en las pruebas

No se mandan mensajes a IA reales. El chat lateral se prueba con un agente
simulado (`llm.cmd`, en `tests/e2e/smoke.mjs`) que contesta con lo que recibió:

- la pregunta llega entera por la entrada estándar, aunque lleve `& | %`,
  comillas y `<`;
- el modelo elegido llega como opción (`-m`);
- la segunda pregunta lleva la conversación anterior (memoria);
- «Insertar» escribe la orden en el prompt sin ejecutarla.

Con las CLI reales (Claude Code, Codex…) está sin probar por esa misma razón.

### 6. Idioma

#### 6.1 Idioma de los scripts

Cuando la Biblioteca escribe un script en la pestaña activa, WinSlim conserva
su intérprete y argumentos originales, pero añade la variable de entorno
`LTERMINAL_LANGUAGE` (`es`, `en`, etc.) al proceso. Así, los scripts propios o
integrados pueden seleccionar sus textos según el idioma elegido en Ajustes;
la aplicación no traduce código arbitrario ni cambia la sintaxis de PowerShell,
CMD, Bash, Python o Node.

#### 6.2 Cambiar de idioma con las pestañas abiertas

Al cambiar el idioma desde Ajustes o `:language`, la interfaz se actualiza y el
backend regenera en ese mismo momento los archivos `help-<pestaña>.txt`, sus
secciones y el runner de cada pestaña existente. No hace falta cerrar ni volver
a crear la shell. Si el arranque falla antes de montar xterm, el error se
presenta en la ventana mediante la ruta de recuperación `frontend_reveal`.

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
- **Una sola documentación: este README.** Junto a él solo se publican
  `SECURITY.md` y `CONTRIBUTING.md`. Lo que escriben los asistentes de IA para
  trabajar (traspasos entre sesiones, auditorías, borradores) va a `docs-ia/`,
  que está en `.gitignore` y no se enlaza desde aquí; lo que tenga valor para
  quien use o mantenga el proyecto se integra en este README.
  `npm run check:docs` y `npm run check:flows` lo hacen cumplir.

## Comparativa con Alacritty y WezTerm

Alacritty y WezTerm se estudiaron leyendo su código y su documentación (no se
ejecutaron sus binarios) para decidir qué ideas encajan en WTerminal y cuáles
no. Las cifras no comparan calidad ni rendimiento: WezTerm es un producto mucho
mayor (unos 1.850 archivos y 450 de Rust frente a los 340 y 88 de Alacritty), y
su tamaño explica parte de sus funciones pero también el coste de adoptar sus
modelos.

- **Alacritty** separa el emulador (`alacritty_terminal`: rejilla, historial y
  bucle de la PTY) de la ventana, la entrada y la configuración TOML. No tiene
  pestañas ni divisiones (recomienda un multiplexor externo); sí modo vi,
  búsqueda, selección semántica, *hints* por expresiones regulares y URLs. Sus
  fixtures de rejilla (`alacritty_terminal/tests/ref`) son el modelo de pruebas
  deterministas de VT, reflow, scroll y borrado.
- **WezTerm** separa escapes (`termwiz`), estado del terminal, procesos (`pty`),
  multiplexor (`mux`: pestañas, paneles, dominios locales, WSL, SSH y TLS) y la
  interfaz. Su configuración es Lua y se recarga sola; usa OSC 7 (cwd), OSC 133
  (zonas de prompt, entrada y salida) y OSC 1337 (variables de usuario).

| Capacidad | Alacritty | WezTerm | WTerminal | Decisión |
|---|---|---|---|---|
| PTY ConPTY/Unix | Bucle propio | `pty` multiplataforma | `portable-pty` y ConPTY propio | Mantener la API de WTerminal; comparar invariantes, no portar bucles |
| Reflow y scrollback | Rejilla y fixtures | Superficie estable | xterm.js con la rejilla igual a ConPTY | Verificado con salida larga, clear, resize, divisiones y scrollback |
| Búsqueda en el historial | Sí | Sí, incremental y regex | `@xterm/addon-search` (`Ctrl+Shift+F`) | Regex y búsquedas guardadas, más adelante |
| Borrado explícito del historial | Sí | Sí | Parcial: `clear` interno | Separar «limpiar» de «borrar historial» |
| cwd por OSC 7 | Sí | Sí | Sí, y además prompts de cmd, PowerShell, WSL, MSYS, Wine, Docker y Starship | — |
| Zonas OSC 133 | No | Sí | Parser pasivo (`terminal/semantic_zones.rs`) | Usarlas para seleccionar salidas solo cuando el flujo esté verificado; nunca cambiar lo que recibe la shell |
| Variables OSC 1337 | No | Sí | No | Pospuesto hasta tener un modelo de seguridad y un uso concreto |
| Selección por línea o bloque | Sí | Sí | Selección de xterm y menú contextual | Tras estabilizar el scroll |
| Enlaces y *hints* | Regex y URLs | Hipervínculos y *quick select* | URL `http`/`https`/`file://` (`@xterm/addon-web-links`) e hipervínculos OSC 8 con Ctrl+clic, confirmación opcional con el destino a la vista y validación en Rust (`terminal/links.rs`); un `file:` solo se muestra en su carpeta | Hecho. Sin *hints* por teclado ni *quick select*, y sin detectar rutas sueltas (subrayarían cada prompt de cmd y PowerShell); nunca se abre texto arbitrario |
| Modo vi / copia | Sí | Sí | No | No se porta el modo vi completo |
| Atajos editables | Configuración declarativa | Tablas de teclas | Sí, con grabación en Ajustes | — |
| Paleta de comandos | No | Sí | Sí (`Ctrl+Shift+P`, editable): paneles, buscar, limpiar, pestañas y división, entornos y REPL, tema, fuente e idioma, comandos `:` y acciones fijadas de LTools, con búsqueda sin tildes y manejo completo con teclado | Hecho sin lenguaje de configuración: cada entrada reutiliza el manejador de su atajo, botón o comando, y lo que va a la terminal se teclea por la ruta normal para no separar xterm de ConPTY |
| Configuración externa | TOML e IPC | Lua con recarga | Preferencias en Ajustes y «Exportar/Importar perfil» | Sin recarga automática de un archivo externo |
| Pestañas y divisiones | Ventanas, sin multiplexor | Multiplexor y dominios remotos | Pestañas y hasta 4 paneles locales | Mantener el modelo local; sin multiplexor SSH |
| WSL, contenedores y otros sistemas | Externo | Dominios integrados (WSL, SSH, TLS) | Entornos detectados: distros WSL, contenedores Docker, móviles por ADB y cmd de Wine | Mantener la integración de entornos; sin dominios remotos |
| Imágenes en línea | No | iTerm2, Kitty y Sixel | Sixel, ajustado a la caja que reserva ConPTY | iTerm2 desactivado: ConPTY no lo sigue |
| Sugerencias y colores de la línea de órdenes | De la shell | De la shell | Integra Clink, PSReadLine, ble.sh y los plugins de zsh, configurables en Ajustes | — |
| Herramientas, IA y modelos locales | Fuera del producto | Fuera del producto | Núcleo diferencial: catálogo, detección, CLIs de IA y Ollama | Mejorar evidencia, alcance y caché |
| Pruebas | Fixtures VT | Tests por crate | Unitarias, contratos y E2E visual con capturas y vídeo | Añadir fixtures de secuencias |

Qué no se porta, y por qué:

- El renderer OpenGL/winit de Alacritty: WTerminal usa Tauri, WebView2 y
  xterm.js.
- El multiplexor remoto de WezTerm (dominios SSH/TLS, demonio y protocolo
  persistente): es otro producto, no una mejora de la PTY local.
- La configuración Lua y la recarga automática sin un modelo de permisos y de
  migración de preferencias.
- Cualquier cambio que esconda el desbordamiento horizontal o convierta texto en
  saltos de línea solo para que una captura parezca correcta.
- Reintentos de detección que lancen WinGet o Chocolatey cada vez que se abre un
  panel: el refresco es explícito y la caché se reutiliza.

Con los tres proyectos, compilar, probar, empaquetar y publicar son pasos
separados. En WTerminal, `-Fast` es una build de desarrollo y no valida una
release: la validación completa es `-ReleaseValidation`, que usa el binario
recién generado (ver [Compilación y distribución](#compilación-y-distribución)).

## Problemas conocidos

### 1. Las pestañas se quedan en blanco en Windows

Falta `conpty.dll` o
`WebView2Loader.dll` junto al ejecutable. El ConPTY del sistema falla en algunos
Windows recortados y tarda más de dos minutos en devolver el error. Los cuatro
archivos de la carpeta desempaquetada tienen que ir juntos.

### 2. El REPL de Python con `pyreadline3` en Windows, y por qué va con el ancho visible

`pyreadline3` llega como dependencia de muchos paquetes en Windows
(humanfriendly, coloredlogs…) y, si está, el REPL de Python lo carga solo. Edita
la línea con la API de consola y a cada tecla borra el resto de la ventana; el
OpenConsole 1.24 que va junto a la app lo convierte en un repintado de todas las
filas de abajo por las columnas de la PTY. Medido en la VM con la `conpty.dll`
de la release (arnés propio con `CreatePseudoConsole`), por cada letra:

| ConPTY | 1024 columnas | 120 columnas |
|---|---|---|
| OpenConsole 1.24 de la app | 84 KB | 16 KB |
| El del sistema | 279 bytes | 279 bytes |

Sin `pyreadline3` (Python 3.9 o 3.10 de la misma VM), cmd sin Clink, Lua o
sqlite3 son 17-19 bytes. Con la reserva de 1024 columnas el eco iba a 2-3 letras
por segundo (build 51: la sonda de `lang:python` no acababa de escribirse en 15 s
y lo pendiente se coló en el REPL siguiente). Lo medido el 10-11, uno a uno:

1. **El ancho visible (se queda).** En Windows, el REPL de Python, en su
   pestaña o tecleado en una shell, usa el ancho visible
   ([`full-screen-app.ts`](#mapa-de-archivos-llamadas-y-mantenimiento)): menos
   bytes por tecla. La sonda bajó de 15-21 s a 10-14 s. El E2E comprueba ese
   modo antes de escribir (`lang:python` y `python-width`). Si se apaga
   `pythonReplVisibleWidth`, vuelve la reserva.
2. **Lo que sigue pesando.** No son los bytes, sino el número de trozos: con
   pyreadline3 cada tecla llega en 63-127 lecturas de ConPTY en 13-26 ms
   (huecos de 0,2 ms de media), frente a 1-3 de Node y 1 de Python sin
   pyreadline3. Cada lectura es un evento para el frontend, con su escritura
   en xterm y su repintado. En el E2E eso son unos 250 ms por letra: la sonda
   de `lang:python` de Windows tiene 45 s de plazo, y lo tecleado no se pierde.
3. **Probado y retirado:**
   - que las teclas no esperasen a la ráfaga anterior a pantalla completa no
     cambió nada (13,3/9,5/9,4 s frente a 14,1/11,4/9,6 s);
   - agrupar la salida para todas las pestañas rompió la suite `horizontal`.
4. **La agrupación solo a pantalla completa (11-11).** La salida se agrupa
   solo con el ancho exacto, donde no hay reserva horizontal
   ([Flujo de salida PTY](#2-flujo-de-salida-pty)): un bloque por tecla en vez
   de 63-127. Los 250 ms por letra del punto 2 son de antes de este cambio y
   no se han vuelto a medir.
5. **Instalarlo a propósito (12-11).** «Entorno y dependencias › Lenguajes ›
   Python» ofrece `pyreadline3 (Python 3.12 o anterior)` (`tool-pyreadline3`,
   solo en Windows; en Linux y macOS Python ya usa GNU readline). Da Tab,
   historial con Ctrl+R y edición de línea en el REPL. La orden es
   `python -m pip install --user "pyreadline3; python_version < '3.13'"`:
   - el marcador hace que pip no lo instale en Python 3.13 o posterior, que ya
     trae su propio REPL con todo eso (pip avisa de que no aplica);
   - con `--user` va a la carpeta de paquetes de esa versión de Python
     (`%APPDATA%\Python\Python312\site-packages`, por ejemplo), así que las
     demás versiones ni lo ven;
   - su texto lo recomienda solo hasta 3.12 y avisa del coste: el repintado a
     cada tecla, peor con `pythonReplVisibleWidth` apagado;
   - comprobar si está instalado, actualizarlo y desinstalarlo salen de la orden
     simple, como cualquier librería de Python (`ecosystem_lifecycle_actions`).

### 3. El inventario de WSL sale incompleto

La sonda rápida solo identifica la
distro; al abrir Dependencias se enumeran también `/usr/local/bin`, las rutas de
usuario, `~/.cargo/bin`, `~/.local/bin`, npm global, nvm, asdf/mise, Volta, Bun y
Deno. Así los lenguajes instalados con gestores de versiones no vuelven a
aparecer como faltantes. Si `wsl.exe -d <distro> -- printenv SHELL` no responde,
la distro aparece igualmente en el selector como «(sin comprobar)».

Si una distro que ya se inventarió bien en esta sesión falla después (no
responde o su inventario no llega a tiempo), conserva su última detección
buena (`wsl.rs` `apply_last_good`, `previous_inventory`): el catálogo y el
estado de Ajustes siguen mostrando sus acciones y herramientas en vez de
vaciarse hasta el siguiente refresco (en la auditoría, las 79 de Alpine). El
selector sigue avisando «(sin comprobar)» y se reintenta pronto; refrescar no
borra esa última detección.

### 4. Virtualización en Windows

KVM, libvirt y virt-manager son componentes de
Linux y, cuando procede, se ofrecen dentro de WSL. Windows nativo dispone de
acciones separadas para Hyper-V, Virtual Machine Platform y Windows Sandbox,
además de QEMU, VirtualBox y VMware Workstation Pro. No se presentan como si
fueran KVM nativo: cada opción indica sus requisitos, edición de Windows y
reinicio necesario.
Cuando la activación de una característica devuelve `EnablePending`, Windows
ya ha instalado el paquete pero todavía no publica su ejecutable; el reinicio
del sistema es obligatorio antes de abrir Windows Sandbox. La acción elevada
de WTerminal conserva ese estado, muestra el requisito de reinicio y no vuelve
a ejecutar la instalación como si estuviera ausente.

### 5. Catálogo WinGet

En Windows `npm run check:winget` consulta todos los
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

### 6. El panel de dependencias abre con el catálogo estructural sin esperar a las sondas

Tras preparar la primera terminal, la detección completa se calienta
en segundo plano; al desplegar una herramienta se reutiliza el estado confirmado
o se comprueba solo su familia si todavía no está en caché. **Repetir detección**
fuerza una pasada nueva de PATH, WinGet, WSL y gestores de paquetes; su duración
depende de las sondas disponibles en el equipo y se registra en
`ipc.install_refresh`.

El resultado confirmado se conserva también entre arranques en
`install-actions-cache.json`. Al abrir la aplicación se usa como base inmediata
para que las herramientas ya conocidas no vuelvan a aparecer como «Comprobar»;
las comprobaciones de una herramienta concreta y **Repetir detección** actualizan
esa base cuando el sistema ha cambiado. El archivo solo contiene estados por
identificador de acción, nunca comandos ejecutables.

### 7. El primer arranque tras compilar puede tardar

El antivirus inspecciona un
ejecutable recién creado. Si el primer prompt tarda varios segundos con la
interfaz ya visible, hay que revisar el log de rendimiento y distinguir la
inicialización de la shell de la creación de la PTY. `PTY creado` registra el
PID y la duración de esa creación; si el proceso tarda más de 30 segundos, el
log marca el límite alcanzado y la pestaña muestra el error de arranque.

### 8. Wine puede ejecutar el frontend y aun así mostrar una ventana negra

En la
auditoría, WebView2 llegó a `frontend.mounted` y `app.ready-for-input`, creó
`cmd.exe` y respondió al handshake, pero la superficie visible siguió negra,
también con Wine-Staging 11.17 y un prefijo limpio. Es un límite de presentación
de WebView2/DirectComposition en Wine, no una prueba de que Windows nativo falle.
El smoke headless valida entrada/salida de comandos mediante pipes. La ventana
visible y ConPTY real deben validarse en Windows nativo.

### 9. El REPL de Elm no contesta y se queda al 100 % de CPU

#### 9.1 Qué se ve

Escribes una expresión en el REPL de Elm (`lang:elm`), pulsas Intro y no sale
nada: ni el resultado ni un prompt nuevo. `elm.exe` gasta un núcleo entero sin
parar y nunca lanza `node` para evaluar.

#### 9.2 Por qué pasa

Elm guarda el borrador de su REPL en
`%APPDATA%\elm\<versión>\repl\tmp\elm-stuff` y no lo escribe de forma atómica.
Si el REPL se cierra justo mientras lo escribe (por ejemplo, al cambiar de
entorno en la pestaña), `d.dat` queda con 0 bytes y, desde entonces, Elm se
atasca al leerlo. Es un fallo de Elm, no de la terminal: el 13-11 le pasó igual
al binario de la 58, que el día antes había pasado la prueba.

#### 9.3 Cómo se arregla

Borra esa carpeta `elm-stuff` (solo el borrador del REPL; tus paquetes y tus
proyectos no están ahí). Elm la rehace en menos de un segundo. Las pruebas E2E
lo hacen solas antes de abrir Elm si encuentran `d.dat` vacío, y lo apuntan en
el informe (`elm-repl-cache-repaired`).

### 10. Un agente del chat no contesta, tarda o contesta vacío

El chat lateral solo lanza la CLI del agente y enseña lo que escribe: casi
siempre la causa está en el agente (su versión, su cuenta o su configuración),
no en WTerminal. Debajo de cada respuesta fallida, «Ver lo que dijo el agente»
enseña su salida de error. Estos son los casos vistos el 15-11.

#### 10.1 «El modelo está saturado ahora mismo» (Gemini, Qwen)

- **Qué se ve:** tras unos 30-60 s, «El modelo está saturado ahora mismo
  (error 503 del servicio)…» o «Sin cupo para ese modelo (error 429)…».
- **Por qué:** Gemini CLI y Qwen Code reintentan solos hasta 10 veces, con
  esperas de hasta 30 s, sin escribir nada por la salida normal. El chat lee
  esos «Attempt N failed with status 503», enseña cada reintento según pasa
  («Reintentando… (1 de 3)») y lo corta al tercero. Antes se quedaba 5 minutos
  callado y acababa en «tardó demasiado».
- **Qué hacer:** probar más tarde (Google dice que los picos de demanda son
  pasajeros) o elegir otro modelo en el desplegable del chat.

#### 10.2 Gemini con la CLI antigua

- **Qué se ve:** el modelo por defecto da 503, uno conocido da 404 («This
  model … is no longer available to new users») o no contesta nada.
- **Por qué:** cada versión de Gemini CLI trae su lista de modelos, y Google
  retira o renombra los suyos. El 15-11, Gemini CLI 0.65 pedía modelos ya
  retirados o saturados; la clave de API era válida.
- **Qué hacer:** actualizar Gemini CLI desde Entorno y dependencias →
  Inteligencia artificial → Gemini CLI («Actualizar»), o con
  `npm install --global @google/gemini-cli` en una pestaña de WTerminal (se
  instala en la carpeta propia, `entornos\herramientas\npm`). La clave que
  guardaste en WTerminal se le pasa con `GEMINI_API_KEY` y
  `GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key`, así que no hace falta tocar su
  `settings.json`.

#### 10.3 «El agente terminó sin contestar nada» (Amp)

- **Qué se ve:** la respuesta llega vacía en unos segundos.
- **Por qué:** el agente acabó «bien» (código 0) sin escribir nada. En Amp, su
  propio registro (`%LOCALAPPDATA%\amp\logs\cli.log`) decía «Reconnect
  ChatGPT before using OpenAI models»: estaba configurado con modelos de
  OpenAI a través de una cuenta de ChatGPT cuya conexión había caducado.
- **Qué hacer:** abrir Amp en su pestaña (el chat ofrece el botón) y volver a
  conectar la cuenta, o elegir allí otro modelo. «Couldn't connect to the Amp
  server» suelto es un corte de red pasajero.

#### 10.4 Continue no sale en el chat

- **Qué se ve:** Continue CLI aparece en «Solo en su pestaña», con el motivo
  «Le falta su config.yaml con algún modelo».
- **Por qué:** sin `~/.continue/config.yaml` (o la carpeta de
  `CONTINUE_GLOBAL_DIR`), Continue intenta bajarse la configuración de su
  servicio, que ya no existe («Hub integration has been removed»), y falla con
  «The request failed and the interceptors did not return an alternative
  response».
- **Qué hacer:** crear `~/.continue/config.yaml` con al menos un modelo. Por
  ejemplo, con un modelo local de Ollama:

  ```yaml
  name: Local
  version: 1.0.0
  schema: v1
  models:
    - name: Qwen local
      provider: ollama
      model: qwen3:8b
      roles:
        - chat
  ```

  Al volver a abrir el chat, Continue ya sale arriba, con los demás.

#### 10.5 Un agente que no sale en el desplegable

El grupo «Solo en su pestaña» solo enseña los que algo puede dejar entrar en el
chat (un ajuste o su configuración). Los que nunca contestan ahí, como aider,
que edita archivos por su cuenta, no se ofrecen: se abren desde el selector de
entornos de arriba. Ver [Chat con los agentes](#chat-con-los-agentes-agentchat).

## Licencia

WTerminal / LTerminal es software libre. Se distribuye con la **GNU Affero
General Public License, versión 3 únicamente** (`AGPL-3.0-only`, texto completo
en `LICENSE`). Copyright © 2026 Darkeiser003.

En la práctica:

- **Uso:** cualquiera puede usarlo, estudiarlo, modificarlo y redistribuirlo, también
  dentro de una empresa, sin pagar nada.
- **Obligación:** quien distribuya una versión modificada, o la ofrezca a otros a
  través de la red, tiene que publicar todo su código con la misma AGPL-3.0.
- **Garantía:** no la hay (secciones 15 y 16 de la licencia).

**Licencia comercial, soporte y servicios.** El titular de los derechos ofrece
la misma aplicación con licencia comercial, para quien quiera usarla o
integrarla sin las obligaciones de la AGPL: por ejemplo, dentro de un producto
cerrado o en un servicio sin publicar sus cambios. También ofrece soporte,
servicio, builds a medida y garantías por contrato. Contacto:
<tebarcascallarromen@gmail.com> (el `supportEmail` de
`src-tauri/config/package-metadata.json`); las condiciones se fijan en un
contrato aparte.

**Contribuciones.** Para poder ofrecer las dos licencias, cada contribución
externa necesita el CLA de [CONTRIBUTING.md](CONTRIBUTING.md). Las
actualizaciones automáticas de versiones (Dependabot) no lo necesitan. Para que
GitHub lo exija, se instala en el repositorio la app CLA Assistant
(cla-assistant.io) con el texto del CLA en un gist; el bot pide aceptarlo en el
primer pull request de cada persona. No se usa un workflow propio: necesitaría
`pull_request_target` con permisos de escritura, que el análisis de zizmor de
`workflow-security.yml` marca como peligroso.

**Permiso adicional (sección 7 de la AGPL-3.0).** En Windows la aplicación se
distribuye con `WebView2Loader.dll`, un redistribuible de Microsoft que no es
software libre, y usa el runtime de WebView2 del sistema. Como permiso
adicional, el titular permite combinar WTerminal con esas bibliotecas de
Microsoft y distribuirlo junto a ellas sin que ellas queden sujetas a la AGPL.
Todo lo demás sigue con la AGPL. ConPTY y OpenConsole son MIT y no lo
necesitan.

**Marca.** «WTerminal», «LTerminal», «WTerminal Project» y su logotipo
identifican al proyecto de Darkeiser003. La AGPL no da permiso para usarlos
(sección 7 e).

- **Referirse al proyecto:** se pueden usar para eso («basado en WTerminal»,
  «compatible con LTerminal»).
- **Versiones modificadas:** una versión modificada o redistribuida por otros
  cambia el nombre y el icono, y no se presenta como oficial ni insinúa el
  respaldo del proyecto.
- **Productos y servicios:** un producto o servicio no lleva el nombre ni el
  logotipo sin permiso escrito.
- **Builds oficiales:** son las de las releases de `Darkeiser003/Terminal`,
  con el manifiesto firmado con Ed25519 y SSH ([Seguridad de las
  releases](#13-seguridad-de-las-releases)).

**Código anterior.** Lo que se publicó con licencia MIT antes de este cambio
(10-11-2026) sigue siendo MIT para quien lo obtuvo; lo nuevo es AGPL-3.0-only.
Las dependencias y los recursos de terceros conservan sus licencias
(`THIRD-PARTY-NOTICES.txt`). Las de producción del frontend (Tauri y xterm.js)
son MIT o MIT/Apache-2.0. Las de Rust las limita `deny.toml` a licencias
permisivas, MPL-2.0 y LGPL-2.1, todas compatibles con la AGPL-3.0.

Este apartado y el CLA son borradores del titular, sin revisión legal; el
contrato de la licencia comercial conviene redactarlo con un abogado.

## Créditos

Desarrollado por [Darkeiser003](https://github.com/Darkeiser003). Las acciones
operativas se publican y mantienen en
[LTools / WTools](https://github.com/Darkeiser003/Tools).

En colaboración con [Christianlg97](https://github.com/Christianlg97),
desarrollador del proyecto WinSlim, que ha aportado a WTerminal sus ideas, sus
conocimientos de Windows y su tiempo.
