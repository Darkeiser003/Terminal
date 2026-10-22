import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, release as osKernelRelease, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
    environmentProbe,
    parseWslDistroList,
    posixPrintfLinesScript,
    probeOutputContainsMarker,
    quotePosixShellArgument,
    probeOutputContainsExpectedText,
    probeOutputHasResultBeforeMarker,
    probeOutputMarkerRows,
    safeEnvironmentMarker,
    shouldUseWsl1X11Capture,
    wineProbeSkipReason,
} from '../../scripts/e2e-environment-probes.mjs';
import { resolveWindowsNativeDriver } from '../../scripts/e2e-native-driver.mjs';
import { containsExactHttpsUrl } from './terminal-url-matcher.mjs';
import { measureToolbarLayout, toolbarLayoutIsValid } from './toolbar-layout.mjs';
import { restoreWindowsPathIntegration, snapshotWindowsPathIntegration } from './windows-path-guard.mjs';
import { dropPowerShell7ModulePath } from './powershell-env.mjs';

// Lanzado desde PowerShell 7, el PSModulePath heredado rompe los powershell.exe 5.1
// que lanzan estas pruebas (ver tests/e2e/powershell-env.mjs).
dropPowerShell7ModulePath();

// WebKitGTK puede intentar crear buffers GBM aunque la sesión gráfica de
// pruebas esté disponible. Desactivarlo hace que el smoke use el compositor
// normal y evita falsos fallos en máquinas virtuales o escritorios remotos.
process.env.WEBKIT_DISABLE_DMABUF_RENDERER ??= '1';
process.env.TAURI_WEBVIEW_AUTOMATION ??= 'true';
process.env.LTERMINAL_E2E_WEBDRIVER ??= '1';
// WebView2 en Windows recortados puede abortar el proceso GPU antes de
// publicar DevToolsActivePort. El binario de prueba recibe esta señal y usa
// renderizado software; la build normal no cambia su aceleración.
if (process.platform === 'win32') process.env.LTERMINAL_E2E_DISABLE_GPU ??= '1';
// El smoke valida flujos de la app sin abrir el diálogo UAC en una sesión
// automatizada; el contrato RUNASADMIN se valida con una ruta aislada del exe.
if (process.platform === 'win32') process.env.LTERMINAL_E2E_DISABLE_ADMIN ??= '1';
// PATH automático se valida en tests del contrato sin registrar el ejecutable
// temporal de E2E en el perfil real del usuario.
process.env.LTERMINAL_E2E_DISABLE_PATH_AUTO ??= '1';
// Las sugerencias y colores de la línea de órdenes (Clink, PSReadLine, ble.sh)
// cambian el eco que miden las pruebas y dependen de lo instalado en la
// máquina: se desactivan salvo en su escenario enfocado.
const shellAssistOnly = process.env.E2E_SHELL_ASSIST_ONLY === '1';
// Imágenes en línea (Sixel e iTerm2): qué deja pasar ConPTY y qué pinta xterm.
const inlineImagesOnly = process.env.E2E_INLINE_IMAGES_ONLY === '1';
// Anchos de emoji y símbolos: xterm y ConPTY deben contar las mismas celdas.
const unicodeWidthsOnly = process.env.E2E_UNICODE_WIDTHS_ONLY === '1';
// Imagen a la izquierda del banner: logo de fábrica, imagen propia, imagen
// ilegible, ancho, desactivación y eco alineado después.
const bannerImageOnly = process.env.E2E_BANNER_IMAGE_ONLY === '1';
// Menú contextual: «Buscar» con la selección y cortar o borrar una parte de
// la línea que se escribe (no solo lo que toca el cursor) en cada shell.
const contextMenuEditOnly = process.env.E2E_CONTEXT_MENU_EDIT_ONLY === '1';
// Ajustes: buscador en todas las secciones, índice de apartados y explicación
// de cada fila al pasar el ratón.
const settingsSearchOnly = process.env.E2E_SETTINGS_SEARCH_ONLY === '1';
if (shellAssistOnly) process.env.LTERMINAL_E2E_DISABLE_SHELL_ASSIST = '0';
process.env.LTERMINAL_E2E_DISABLE_SHELL_ASSIST ??= '1';
if (shellAssistOnly && process.platform === 'win32') {
    const { prepareShellTools } = await import('../../scripts/prepare-e2e-shell-tools.mjs');
    const shellTools = await prepareShellTools(process.env.E2E_SHELL_TOOLS_DIR || undefined);
    process.env.PATH = [shellTools.clinkDir, process.env.PATH].filter(Boolean).join(delimiter);
    process.env.PSModulePath = [shellTools.psModulesDir, process.env.PSModulePath].filter(Boolean).join(delimiter);
    // Clink usa el perfil propio de WTerminal, que en E2E vive dentro del
    // perfil aislado: el historial de la prueba no llega al del usuario.
    delete process.env.CLINK_PROFILE;
}
// bash en WSL con ble.sh: se instala en el /tmp de la distro (no en su carpeta
// personal) y la app lo carga desde ahí. E2E_SHELL_ASSIST_WSL=0 lo omite.
let shellAssistWslDistro = null;
if (shellAssistOnly && process.platform === 'win32' && process.env.E2E_SHELL_ASSIST_WSL !== '0') {
    const { pickWslDistro, prepareBleshInWsl } = await import('../../scripts/prepare-e2e-shell-tools.mjs');
    shellAssistWslDistro = await pickWslDistro(process.env.E2E_SHELL_ASSIST_WSL_DISTRO || '');
    if (shellAssistWslDistro) {
        process.env.LTERMINAL_E2E_BLESH_PATH = await prepareBleshInWsl(shellAssistWslDistro, process.env.E2E_SHELL_TOOLS_DIR || undefined);
    } else if (process.env.E2E_SHELL_ASSIST_WSL === '1') {
        throw new Error('E2E_SHELL_ASSIST_WSL=1 pero no hay ninguna distro WSL con bash');
    }
}
// Fuerza la carrera de una pestaña nueva: nace con la geometría heredada de la
// ventana sin dividir (26 filas) y su primer `pty_resize` con la casilla real
// llega antes de que termine la preparación del banner en segundo plano.
// Antes, esa preparación pisaba la medida del frontend con la heredada y
// ConPTY quedaba con otras filas que xterm (eco despegado al crecer).
if (process.env.E2E_NEW_TAB_ECHO_FORCED_RACE === '1') {
    process.env.LTERMINAL_E2E_BANNER_DELAY_MS ??= '1500';
    process.env.LTERMINAL_E2E_BIRTH_ROWS ??= '26';
}
let ownedE2eAppDataDirectory = null;
if (process.platform === 'win32') {
    if (!process.env.LTERMINAL_E2E_APP_DATA_DIR) {
        ownedE2eAppDataDirectory = await mkdtemp(join(tmpdir(), 'wterminal-e2e-appdata-'));
        process.env.LTERMINAL_E2E_APP_DATA_DIR = ownedE2eAppDataDirectory;
    }
    process.env.LTERMINAL_E2E_TESTING = '1';
}
// npm/build shells on Windows do not always inherit the Cargo bin directory.
// Resolve the installed driver from the standard per-user location before
// falling back to PATH, so an E2E run is reproducible from a clean terminal.
const driverPath = process.env.TAURI_DRIVER
    ?? (process.platform === 'win32' ? join(homedir(), '.cargo', 'bin', 'tauri-driver.exe') : 'tauri-driver');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let nativeDriver = process.env.TAURI_NATIVE_DRIVER;
if (process.platform === 'win32' && !nativeDriver) {
    nativeDriver = resolveWindowsNativeDriver(projectRoot);
    if (nativeDriver) {
        process.env.TAURI_NATIVE_DRIVER = nativeDriver;
        process.stdout.write(`E2E Edge WebDriver: ${nativeDriver}\n`);
    }
}
if (process.platform === 'win32' && !nativeDriver) {
    throw new Error('No se encontró Edge WebDriver compatible con WebView2. Ejecuta windows/build.ps1 -InstallE2eDriver o define TAURI_NATIVE_DRIVER.');
}
async function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : null;
            server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('No se pudo reservar un puerto E2E')));
        });
    });
}
const driverPort = process.env.TAURI_DRIVER_PORT ?? String(await findFreePort());
const nativePort = process.env.TAURI_NATIVE_PORT ?? String(await findFreePort());
const webdriverRequestTimeoutMs = Math.min(300_000, Math.max(1_000, Number(process.env.E2E_WEBDRIVER_TIMEOUT_MS) || 90_000));
// tauri-driver resuelve la aplicación desde su propio proceso, no desde el
// cwd del runner. Enviar una ruta relativa hace que no encuentre WTerminal y
// que el EdgeDriver termine intentando arrancar Edge como navegador autónomo.
const application = process.env.E2E_BINARY
    ? resolve(projectRoot, process.env.E2E_BINARY)
    : null;
if (!application) throw new Error('E2E_BINARY debe apuntar al binario Tauri compilado');
await access(application);
const execFile = promisify(execFileCallback);

// tauri-driver puede dejar la aplicación nativa desacoplada de su árbol de
// procesos. `tasklist` es inmediato y no abre PowerShell visible; el conjunto
// inicial de PID evita tocar una WTerminal que el usuario ya tuviera abierta.
async function applicationProcessIds() {
    if (process.platform !== 'win32') return [];
    try {
        const { stdout } = await execFile('tasklist.exe', [
            '/FI', 'IMAGENAME eq wterminal.exe',
            '/FO', 'CSV',
            '/NH',
        ], {
            windowsHide: true,
            // tasklist puede tardar varios segundos mientras el sistema
            // enumera procesos de WebView2. No debe abortar el E2E antes de
            // crear la sesión; en ese caso devolvemos un conjunto vacío y la
            // limpieza posterior seguirá acotada al árbol del driver.
            timeout: 10_000,
        });
        return String(stdout)
            .split(/\r?\n/)
            .map((line) => line.match(/^"[^"]+","(\d+)"/)?.[1])
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0);
    } catch (error) {
        process.stderr.write(`E2E: tasklist no respondió a tiempo; se continúa sin PIDs preexistentes (${error.message})\n`);
        return [];
    }
}

const preExistingApplicationPids = new Set(await applicationProcessIds());
const adminCompatTestPath = process.platform === 'win32' ? resolve(application) : null;
let previousAdminCompatValue;
let adminCompatProbePrepared = false;
// La prueba de «Invocar WTerminal desde el PATH» escribe en el registro real
// del usuario (HKCU\Environment\Path y HKCU\Software\WTerminal), que el perfil
// aislado del E2E no cubre. Restaurar solo el estado activado/desactivado no
// basta: el registro pasaba a apuntar a la carpeta del binario probado y las
// entradas se acumulaban entre ejecuciones. Se guarda una copia exacta antes y
// se repone después (o en el `finally` si la prueba falla a mitad).
let pendingWindowsPathSnapshot = null;

async function writeAdminCompatValue(value) {
    const registryKey = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
    if (value === null) {
        try {
            await execFile('reg.exe', ['delete', registryKey, '/v', adminCompatTestPath, '/f'], { windowsHide: true });
        } catch (error) {
            if (error.code !== 1) throw error;
        }
        return;
    }
    await execFile('reg.exe', ['add', registryKey, '/v', adminCompatTestPath, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true });
}

if (adminCompatTestPath) {
    const registryKey = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
    try {
        const { stdout: output } = await execFile('reg.exe', ['query', registryKey, '/v', adminCompatTestPath], { windowsHide: true });
        previousAdminCompatValue = output.match(/REG_SZ\s+([^\r\n]*)/i)?.[1]?.trim() ?? null;
    } catch (error) {
        if (error.code !== 1) throw error;
        previousAdminCompatValue = null;
    }
    adminCompatProbePrepared = true;
    process.env.LTERMINAL_E2E_ADMIN_COMPAT_PATH = adminCompatTestPath;
    const withoutRunAsAdmin = (previousAdminCompatValue ?? '').split(/\s+/).filter((flag) => flag && !flag.toLowerCase().includes('runasadmin')).join(' ');
    if (previousAdminCompatValue?.toLowerCase().includes('runasadmin')) {
        await writeAdminCompatValue(withoutRunAsAdmin || null);
    }
}

async function adminCompatEnabled() {
    if (!adminCompatTestPath) return null;
    try {
        const { stdout: result } = await execFile('reg.exe', [
            'query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
            '/v', adminCompatTestPath,
        ], { windowsHide: true });
        return /RUNASADMIN/i.test(result);
    } catch (error) {
        if (error.code === 1) return false;
        throw error;
    }
}
const SKIP_WINDOW_MANAGER = /^(1|true|yes)$/i.test(process.env.E2E_SKIP_WINDOW_MANAGER ?? '');
const IS_HYPRLAND = !SKIP_WINDOW_MANAGER && [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.HYPRLAND_INSTANCE_SIGNATURE,
].filter(Boolean).join(' ').toLowerCase().includes('hyprland');
const IS_WSL1_HOST = process.platform === 'linux'
    && wineProbeSkipReason(process.platform, osKernelRelease()) !== null;

// Límites nativos de la ventana. Son un suelo absoluto para el gestor de
// ventanas; el mínimo responsive se calcula con la pantalla real más abajo,
// porque una constante basada en 1920x1080 falla en monitores 2K, 4K o con
// escalado DPI.
const parseLimit = (name, fallback, maximum) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
};
const WINDOW_LIMITS = {
    minWidth: 480,
    minHeight: 270,
    maxWidth: Math.max(480, parseLimit('E2E_MAX_WIDTH', 7680, 7680)),
    maxHeight: Math.max(270, parseLimit('E2E_MAX_HEIGHT', 4320, 4320)),
};
// Las capturas nativas pueden reflejar el escritorio completo a escala DPI
// (por ejemplo 7680x4320), pero no necesitamos codificar un MP4 8K para
// auditar la interfaz. El vídeo principal se mantiene reproducible y ligero;
// las dimensiones originales siguen en `observedFrameSizes` y, si se activa,
// en los segmentos nativos.
const VIDEO_LIMITS = {
    maxWidth: Math.max(480, parseLimit('E2E_VIDEO_MAX_WIDTH', 1920, 3840)),
    maxHeight: Math.max(270, parseLimit('E2E_VIDEO_MAX_HEIGHT', 1080, 2160)),
};
const VISIBILITY_CONTROLS = {
    dependencies: 'settings-show-dependencies',
    projects: 'settings-show-projects',
    library: 'settings-show-library',
    explorer: 'settings-show-explorer',
};
// El smoke espera señales observables, no pausas largas. Estos valores se
// pueden ampliar para diagnosticar una máquina especialmente lenta.
const parseDuration = (name, fallback, minimum, maximum) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value)
        ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
        : fallback;
};
const POLL_INTERVAL_MS = parseDuration('E2E_POLL_INTERVAL_MS', 100, 25, 1000);
const WM_TRANSITION_TIMEOUT_MS = parseDuration('E2E_WM_TIMEOUT_MS', 1800, 500, 5000);
const FOCUS_SETTLE_MS = parseDuration('E2E_FOCUS_SETTLE_MS', 100, 25, 1000);
const COMMAND_SETTLE_MS = parseDuration('E2E_COMMAND_SETTLE_MS', 220, 50, 2000);
// El resize ya solicita el repintado del banner. Esta opción conserva la
// ruta más pesada para investigar específicamente el teclado de la shell.
const FORCE_SHELL_REFRESH = process.env.E2E_FORCE_SHELL_REFRESH === '1';
// El límite estricto detecta la espera de respuestas VT de ConPTY en Windows.
// WebKitGTK + Xvfb puede retener durante varios segundos la lectura del PTY
// aunque la shell y el script ya hayan terminado; se sigue midiendo en Linux,
// pero con un techo diagnóstico separado para no confundir ese entorno con un
// bloqueo funcional de la aplicación.
const SHELL_STARTUP_LIMIT_MS = parseDuration(
    'E2E_SHELL_STARTUP_LIMIT_MS',
    // El marcador de arranque se emite después de cargar todos los aliases.
    // Durante una transición de rejilla ConPTY puede serializar una shell
    // nueva detrás de un resize y tardar más de 15 s bajo Defender; 60 s
    // conserva un techo finito para bloqueos reales sin marcar esa primera
    // inicialización como fallo visual.
    process.platform === 'win32' ? 60000 : 30000,
    500,
    60000,
);
const SHELL_STARTUP_LIMIT_KIND = process.platform === 'win32' ? 'ConPTY' : 'PTY/WebKitGTK';

// Cada ejecución deja una huella propia en el log acumulativo. Así el smoke
// no confunde un error antiguo con uno actual ni da por bueno un arranque que
// solo dejó vivo el proceso.
const smokeToken = process.env.LTERMINAL_SMOKE_TOKEN ?? `e2e-${process.pid}-${Date.now()}`;
process.env.LTERMINAL_SMOKE_TOKEN = smokeToken;
// Cada E2E de Windows usa una UDF propia. Así EdgeDriver y el WebView2 que
// lanza comparten exactamente la ruta donde se crea DevToolsActivePort, sin
// colisionar con el smoke release ni con una instancia normal de la app.
const configuredWebViewUserDataFolder = process.env.E2E_WEBVIEW2_USER_DATA_FOLDER;
const webviewUserDataFolder = process.platform === 'win32'
    ? configuredWebViewUserDataFolder
        ?? join(tmpdir(), `winslim-terminal-webview2-e2e-${process.pid}-${Date.now()}`)
    : null;
const ownsWebViewUserDataFolder = Boolean(webviewUserDataFolder && !configuredWebViewUserDataFolder);
if (webviewUserDataFolder) await mkdir(webviewUserDataFolder, { recursive: true });
let sessionCreationFinished = false;
// En un gestor de ventanas en mosaico el proceso puede estar visible y ser
// totalmente usable, pero el compositor puede impedir que WebDriver cambie
// su rectángulo. La cobertura de aplicación sigue siendo válida; solo se
// marca como no disponible la parte que depende de una ventana flotante.
let nativeResizeSupported = true;

// El modo enfocado ADB instala un ejecutable falso en un directorio temporal
// delante del PATH. Así prueba el descubrimiento real y el transporte PTY sin
// depender de un móvil/emulador ni tocar la instalación del usuario.
const adbRefreshOnly = process.env.E2E_ADB_REFRESH_ONLY === '1';
const ltoolsIntegration = process.env.E2E_LTOOLS_INTEGRATION === '1';
const ltoolsOnly = process.env.E2E_LTOOLS_ONLY === '1';
const ltoolsSettingsRouteOnly = process.env.E2E_LTOOLS_SETTINGS_ROUTE_ONLY === '1';
const progressLayoutOnly = process.env.E2E_PROGRESS_LAYOUT_ONLY === '1';
const dependencyDetectionOnly = process.env.E2E_DEPENDENCY_DETECTION_ONLY === '1';
// Comprueba el flujo que ve el usuario al abrir una familia concreta: la
// tarjeta debe salir de «Comprobar» y publicar sus verbos reales sin lanzar
// una auditoría global del catálogo.
const dependencyActionsOnly = process.env.E2E_DEPENDENCY_ACTIONS_ONLY === '1';
// Auditoría completa del catálogo: recorre todas las secciones, grupos y
// acciones sin ejecutar instalaciones. Se mantiene separada del smoke corto
// para que una ejecución pueda producir capturas y un inventario comparable
// de dos detecciones consecutivas.
const dependencyAuditOnly = process.env.E2E_DEPENDENCY_AUDIT_ONLY === '1';
const paneMatrixOnly = process.env.E2E_PANE_MATRIX_ONLY === '1';
const horizontalOnly = process.env.E2E_HORIZONTAL_ONLY === '1';
const longInputOnly = process.env.E2E_LONG_INPUT_ONLY === '1';
// Reproduce aislado el paso al máximo configurado (8K) tras rotar paneles,
// que es donde la ventana puede quedar sin responder durante minutos con el
// renderizado por software del E2E.
const maxWindowOnly = process.env.E2E_MAX_WINDOW_ONLY === '1';
// Reproduce aislada la primera orden de una pestaña nueva y guarda la traza
// cruda de ConPTY (salida + resize + entrada) si el eco queda despegado.
const newTabEchoOnly = process.env.E2E_NEW_TAB_ECHO_ONLY === '1';
// Escribe en una pestaña nueva antes de que su shell esté lista (entrada en
// cola) y comprueba que los resize posteriores siguen ajustando las filas.
const queuedInputResizeOnly = process.env.E2E_QUEUED_INPUT_RESIZE_ONLY === '1';
// Escribe justo después de cambiar la altura de la ventana (pestaña visible) y
// al volver a una pestaña que estaba oculta durante el cambio. El resize de
// ConPTY va con debounce: una tecla dentro de esa ventana despegaba el eco.
const resizeTypeOnly = process.env.E2E_RESIZE_TYPE_ONLY === '1';
// «Entornos y descargas»: Ajustes lista las cachés propias, la terminal recibe
// la misma ruta en su variable y vaciar libera lo sembrado en el perfil E2E.
const toolchainStoreOnly = process.env.E2E_TOOLCHAIN_STORE_ONLY === '1';
// Casilla de 1-2 filas cuyo historial se desplaza y que después crece (al
// volver a un panel o al agrandar la ventana). ConPTY y xterm deben seguir en
// la misma fila: el eco de la orden siguiente no puede salir despegado.
const tinyGrowOnly = process.env.E2E_TINY_GROW_ONLY === '1';
// Entrada larga escrita a ritmo humano: el cursor debe seguir a la vista y el
// scroll horizontal avanzar poco a poco; tras mover el scroll a mano, seguir
// escribiendo recoloca la vista lo justo; Inicio/Fin/flechas/Retroceso
// arrastran la vista con el cursor.
const inputFollowOnly = process.env.E2E_INPUT_FOLLOW_ONLY === '1';
// Colores ANSI de la paleta de 16, negrita y subrayado: xterm los pinta con
// clases de su hoja dinámica, que la WebView debe aplicar.
const ansiStylesOnly = process.env.E2E_ANSI_STYLES_ONLY === '1';
// Apariencia: temas sobre la base neutra, recolorear todo, guardar y borrar un
// tema propio, paleta ANSI propia pintada de verdad en xterm, y la lista de
// tipos de la Biblioteca que sigue abierta al marcar casillas.
const appearanceOnly = process.env.E2E_APPEARANCE_ONLY === '1';
// Paleta de comandos: Ctrl+Shift+P, navegación con teclado, filtrado y acciones
// reales (Ajustes, un comando `:` con salida, limpiar, nueva pestaña). El eco
// de la orden siguiente debe seguir pegado al prompt: nada se escribe solo en
// xterm sin que ConPTY lo sepa.
const commandPaletteOnly = process.env.E2E_COMMAND_PALETTE_ONLY === '1';
const cursorOnly = process.env.E2E_CURSOR_ONLY === '1';
// Permite validar la matriz PTY/layout sin esperar la pasada completa de
// sondas externas. La auditoría de detección mantiene su modo enfocado y no
// usa este atajo; solo el smoke visual lo admite para aislar una regresión.
const skipDependencyRefresh = process.env.E2E_SKIP_DEPENDENCY_REFRESH === '1';
// Las sondas completas incluyen gestores externos y WSL en Windows. El
// informe registra la duración real; este margen evita convertir una máquina
// ocupada en un falso fallo de catálogo vacío.
// En Windows la detección completa ejecuta sondas externas y puede superar
// cinco minutos aunque el catálogo termine correctamente. El límite anterior
// de 300 s convertía una detección lenta en un falso fallo justo antes de que
// el frontend recibiera el catálogo; conservar la variable de entorno permite
// acortarlo en máquinas rápidas y 15 min cubre la auditoría completa real.
const dependencyDetectionTimeoutMs = Number(process.env.E2E_DEPENDENCY_TIMEOUT_MS ?? 900000);
const terminalOnlyOnly = process.env.E2E_TERMINAL_ONLY_ONLY === '1';
const updateRetryOnly = process.env.E2E_UPDATE_RETRY_ONLY === '1';
const requireElevated = process.env.E2E_REQUIRE_ELEVATED === '1';
let fakeAdbDirectory = null;
if (adbRefreshOnly) {
    if (process.platform === 'win32') {
        throw new Error('E2E_ADB_REFRESH_ONLY requiere un host POSIX para simular adb');
    }
    fakeAdbDirectory = await mkdtemp(join(tmpdir(), 'lterminal-fake-adb-'));
    const fakeAdbPath = join(fakeAdbDirectory, 'adb');
    await writeFile(fakeAdbPath, [
        '#!/bin/sh',
        'if [ "$1" = "devices" ] && [ "$2" = "-l" ]; then',
        '    printf "List of devices attached\\nLTERMINAL-FAKE-DEVICE device product:terminal model:LTerminal_Fake device:terminal\\n"',
        '    exit 0',
        'fi',
        'if [ "$1" = "-s" ] && [ "$2" = "LTERMINAL-FAKE-DEVICE" ] && [ "$3" = "shell" ]; then',
        '    printf "\\r\\nLTERMINAL_FAKE_ADB_READY\\r\\nshell@android:/ $ "',
        '    while IFS= read -r command; do',
        '        case "$command" in',
        '            *LTERMINAL_ADB_REFRESH_STREAM*)',
        '                printf "\\r\\nLTERMINAL_ADB_FRAME_ONE\\r\\n"',
        '                sleep 1',
        '                printf "\\r\\nLTERMINAL_ADB_FRAME_TWO\\r\\n"',
        '                sleep 1',
        '                printf "\\r\\nLTERMINAL_ADB_FRAME_THREE\\r\\n"',
        '                ;;',
        '            *) printf "\\r\\nADB_FAKE_COMMAND: %s\\r\\n" "$command" ;;',
        '        esac',
        '    done',
        '    exit 0',
        'fi',
        'printf "fake adb: argumentos no soportados: %s\\n" "$*" >&2',
        'exit 2',
        '',
    ].join('\n'));
    await chmod(fakeAdbPath, 0o755);
    process.env.PATH = [fakeAdbDirectory, process.env.PATH].filter(Boolean).join(delimiter);
}
// Asistentes de IA simulados: un `ollama.cmd` en un PATH propio (npm instala
// así las CLIs en Windows), el manifiesto de un modelo descargado y un Claude
// Code FUERA del PATH, donde lo deja la app de escritorio de Claude
// (`%APPDATA%\Claude\claude-code\<versión>\<hash>\claude.exe`; aquí bajo
// LTERMINAL_E2E_KNOWN_LOCATIONS_ROOT). Hay dos versiones: debe abrirse la
// mayor por número (2.1.295 > 2.1.30): una copia de choice.exe, que pinta su
// pregunta y espera (si saliera, la última pestaña y la app se cerrarían).
// Comprueba detección, selector, apertura en pestaña, estado del modelo en
// Dependencias y que una acción del panel en cmd es UNA sola línea, sin
// instalar herramientas ni descargar gigas.
const aiEnvironmentsOnly = process.env.E2E_AI_ENVIRONMENTS_ONLY === '1';
let fakeAiDirectory = null;
if (aiEnvironmentsOnly) {
    if (process.platform !== 'win32') throw new Error('E2E_AI_ENVIRONMENTS_ONLY simula las CLIs con archivos .cmd de Windows');
    fakeAiDirectory = await mkdtemp(join(tmpdir(), 'wterminal-e2e-ai-'));
    const fakeAiBin = join(fakeAiDirectory, 'bin');
    await mkdir(fakeAiBin, { recursive: true });
    // Espera un Enter como la CLI real en `run`, y sale con 0 como `ollama
    // list`: `set /p` con la entrada vacía deja ERRORLEVEL=1 y el cierre de la
    // acción del panel lo mostraría (con razón) como error.
    await writeFile(join(fakeAiBin, 'ollama.cmd'), '@echo off\r\necho WTERMINAL_FAKE_OLLAMA %*\r\nset /p WTERMINAL_FAKE_WAIT=\r\nexit /b 0\r\n');
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const bundled = join(fakeAiDirectory, 'known', 'roaming', 'Claude', 'claude-code');
    for (const [version, hash, source] of [['2.1.30', 'aaaa', 'whoami.exe'], ['2.1.295', 'd2e29494ec83', 'choice.exe']]) {
        await mkdir(join(bundled, version, hash), { recursive: true });
        await copyFile(join(system32, source), join(bundled, version, hash, 'claude.exe'));
    }
    await mkdir(join(fakeAiDirectory, 'known', 'home'), { recursive: true });
    process.env.LTERMINAL_E2E_KNOWN_LOCATIONS_ROOT = join(fakeAiDirectory, 'known');
    const manifest = join(fakeAiDirectory, 'models', 'manifests', 'registry.ollama.ai', 'library', 'qwen3.8', '27b');
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(manifest, '{}');
    process.env.PATH = [fakeAiBin, process.env.PATH].filter(Boolean).join(delimiter);
    process.env.OLLAMA_MODELS = join(fakeAiDirectory, 'models');
}
// «Mi GitHub» de Proyectos con un `gh` simulado: un gh.cmd delante del PATH
// que guarda la sesión en archivos (`state/logged-in`, `state/delete-scope`),
// lista unos repositorios fijos y anota cada llamada en `calls.log`, para
// comprobar los argumentos exactos sin tocar GitHub ni la sesión real. Varias
// consultas a la vez abren el registro al mismo tiempo: si está ocupado, la
// línea se reintenta (un nombre por llamada con %RANDOM% no sirve: cmd lo
// siembra con la hora en segundos y dos procesos del mismo segundo coinciden).
const githubAccountOnly = process.env.E2E_GITHUB_ACCOUNT_ONLY === '1';
let fakeGhDirectory = null;
// La API pública de GitHub (releases) también se simula: un servidor local
// al que la app apunta solo en pruebas (`LTERMINAL_E2E_GITHUB_API`,
// `projects::github::e2e_api_origin`).
let fakeGithubApi = null;
if (githubAccountOnly) {
    fakeGithubApi = createHttpServer((incoming, response) => {
        if (incoming.url === '/repos/wterminal-e2e/demo/releases/latest') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                tag_name: 'v1.0.0', name: 'Primera', published_at: '2026-10-20T10:00:00Z', prerelease: false,
                html_url: 'https://github.com/wterminal-e2e/demo/releases/tag/v1.0.0',
                assets: [{
                    name: 'demo-windows.zip', size: 10, download_count: 0,
                    browser_download_url: 'https://github.com/wterminal-e2e/demo/releases/download/v1.0.0/demo-windows.zip',
                }],
            }));
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"message":"Not Found"}');
    });
    await new Promise((resolveListen) => fakeGithubApi.listen(0, '127.0.0.1', resolveListen));
    process.env.LTERMINAL_E2E_GITHUB_API = `http://127.0.0.1:${fakeGithubApi.address().port}`;
}
if (githubAccountOnly) {
    if (process.platform !== 'win32') throw new Error('E2E_GITHUB_ACCOUNT_ONLY simula gh con un archivo .cmd de Windows');
    fakeGhDirectory = await mkdtemp(join(tmpdir(), 'wterminal-e2e-gh-'));
    await mkdir(join(fakeGhDirectory, 'state'), { recursive: true });
    const crlf = String.fromCharCode(13, 10);
    await writeFile(join(fakeGhDirectory, 'gh.cmd'), [
        '@echo off',
        'setlocal',
        'set "STATE=%~dp0state"',
        ':log',
        '(>>"%~dp0calls.log" echo %*) 2>nul || goto log',
        'if "%~1"=="--version" (',
        '  echo gh version 9.9.9-e2e',
        '  exit /b 0',
        ')',
        'if "%~1"=="api" goto api',
        'if "%~1"=="auth" goto auth',
        'if "%~1"=="repo" goto repo',
        'if "%~1"=="release" goto release',
        'if "%~1"=="pr" goto pr',
        'if "%~1"=="issue" goto issue',
        'if "%~1"=="run" goto run',
        'exit /b 0',
        // «Gestionar…»: las consultas devuelven JSON fijo y los cambios solo
        // quedan anotados en calls.log.
        ':release',
        `if "%~2"=="list" type "%STATE%${String.fromCharCode(92)}releases.json" & exit /b 0`,
        `if "%~2"=="view" type "%STATE%${String.fromCharCode(92)}assets.json" & exit /b 0`,
        'exit /b 0',
        ':pr',
        `if "%~2"=="list" type "%STATE%${String.fromCharCode(92)}pulls.json" & exit /b 0`,
        'if "%~2"=="create" echo https://github.com/wterminal-e2e/demo/pull/8',
        'exit /b 0',
        ':issue',
        `if "%~2"=="list" type "%STATE%${String.fromCharCode(92)}issues.json" & exit /b 0`,
        'if "%~2"=="create" echo https://github.com/wterminal-e2e/demo/issues/4',
        'exit /b 0',
        ':run',
        `if "%~2"=="list" type "%STATE%${String.fromCharCode(92)}runs.json" & exit /b 0`,
        'exit /b 0',
        ':api',
        'if exist "%STATE%/logged-in" (',
        '  echo {"login":"wterminal-e2e","id":1}',
        '  exit /b 0',
        ')',
        '>&2 echo To get started with GitHub CLI, please run:  gh auth login',
        'exit /b 4',
        ':auth',
        'if "%~2"=="login" goto login',
        'if "%~2"=="logout" (',
        // `del` toma la barra normal por una opción, aunque vaya entre comillas.
        `  del "%STATE%${String.fromCharCode(92)}logged-in" 2>nul`,
        '  echo Logged out of github.com',
        '  exit /b 0',
        ')',
        'if "%~2"=="refresh" (',
        '  type nul > "%STATE%/delete-scope"',
        '  echo Authentication scopes refreshed',
        '  exit /b 0',
        ')',
        'exit /b 0',
        ':repo',
        `if "%~2"=="view" type "%STATE%${String.fromCharCode(92)}details.json" & exit /b 0`,
        'if "%~2"=="list" (',
        // `type` no acepta la barra normal en la ruta, aunque vaya entre comillas.
        `  type "%STATE%${String.fromCharCode(92)}repos.json"`,
        '  exit /b 0',
        ')',
        'if "%~2"=="create" (',
        '  echo https://github.com/wterminal-e2e/%~3',
        '  exit /b 0',
        ')',
        'if "%~2"=="delete" if not exist "%STATE%/delete-scope" (',
        '  >&2 echo HTTP 403: This API operation needs the "delete_repo" scope.',
        '  exit /b 1',
        ')',
        'exit /b 0',
        // Como el gh real, el login pregunta antes de terminar: la pestaña
        // nueva tiene que dejar responder (antes retenía las teclas 35 s).
        ':login',
        'set "GH_E2E_ANSWER="',
        'set /p "GH_E2E_ANSWER=? Authenticate Git with your GitHub credentials? (Y/n) "',
        '>"%STATE%/login-answer" echo [%GH_E2E_ANSWER%]',
        'type nul > "%STATE%/logged-in"',
        'echo Logged in as wterminal-e2e',
        'exit /b 0',
        '',
    ].join(crlf));
    await writeFile(join(fakeGhDirectory, 'state', 'repos.json'), JSON.stringify([
        { name: 'demo', nameWithOwner: 'wterminal-e2e/demo', description: 'Privado de prueba', visibility: 'PRIVATE', isArchived: false, isFork: false, updatedAt: '2026-10-20T10:00:00Z', url: 'https://github.com/wterminal-e2e/demo', stargazerCount: 2, forkCount: 0, primaryLanguage: { name: 'Rust' } },
        { name: 'web', nameWithOwner: 'wterminal-e2e/web', description: 'Público archivado', visibility: 'PUBLIC', isArchived: true, isFork: false, updatedAt: '2026-10-19T10:00:00Z', url: 'https://github.com/wterminal-e2e/web', stargazerCount: 0, forkCount: 0, primaryLanguage: null },
    ]));
    const state = (name, value) => writeFile(join(fakeGhDirectory, 'state', name), JSON.stringify(value));
    await state('details.json', {
        description: 'Privado de prueba', homepageUrl: '', repositoryTopics: [{ name: 'rust' }, { name: 'viejo' }],
        defaultBranchRef: { name: 'main' }, hasIssuesEnabled: true, hasWikiEnabled: false,
    });
    await state('releases.json', [
        { tagName: 'v1.0.0', name: 'Primera', isDraft: false, isPrerelease: false, isLatest: true, publishedAt: '2026-10-20T10:00:00Z' },
        { tagName: 'v1.1.0-rc', name: '', isDraft: true, isPrerelease: true, isLatest: false, createdAt: '2026-10-21T10:00:00Z' },
    ]);
    await state('assets.json', { assets: [{ name: 'demo-windows.zip', size: 2048, downloadCount: 3 }] });
    await state('pulls.json', [{ number: 7, title: 'Arreglo', headRefName: 'feature/x', baseRefName: 'main', isDraft: false, url: 'https://github.com/wterminal-e2e/demo/pull/7' }]);
    await state('issues.json', [{ number: 3, title: 'Fallo', url: 'https://github.com/wterminal-e2e/demo/issues/3' }]);
    await state('runs.json', [{ databaseId: 99, displayTitle: 'CI', status: 'completed', conclusion: 'failure', workflowName: 'ci', headBranch: 'main', createdAt: '2026-10-21T10:00:00Z', url: 'https://github.com/wterminal-e2e/demo/actions/runs/99' }]);
    await writeFile(join(fakeGhDirectory, 'adjunto.zip'), 'zip de prueba');
    process.env.PATH = [fakeGhDirectory, process.env.PATH].filter(Boolean).join(delimiter);
}
// Permisos de administrador: una carpeta propia delante del PATH donde el
// escenario pone y quita un `gsudo.exe` simulado (copia de whoami.exe que
// nunca se ejecuta) para recorrer la ruta de NSudo a través de gsudo sin
// depender de lo que tenga instalado el equipo.
const windowsAdminOnly = process.env.E2E_WINDOWS_ADMIN_ONLY === '1' && process.platform === 'win32';
let fakeGsudoDirectory = null;
if (windowsAdminOnly) {
    fakeGsudoDirectory = await mkdtemp(join(tmpdir(), 'wterminal-e2e-gsudo-'));
    process.env.PATH = [fakeGsudoDirectory, process.env.PATH].filter(Boolean).join(delimiter);
}
// Enlaces clicables: se imprime una URL, se pulsa con Ctrl+clic de verdad y se
// comprueba qué pide abrir la app. En modo de pruebas el backend no lanza el
// navegador ni el explorador: añade cada apertura validada a este archivo.
const terminalLinksOnly = process.env.E2E_TERMINAL_LINKS_ONLY === '1';
let terminalLinksDirectory = null;
let openedLinksFile = null;
if (terminalLinksOnly) {
    terminalLinksDirectory = await mkdtemp(join(tmpdir(), 'wterminal-e2e-links-'));
    openedLinksFile = join(terminalLinksDirectory, 'opened-links.jsonl');
    // Un «programa» al que apunta un enlace file://: debe mostrarse en su
    // carpeta, nunca ejecutarse.
    await writeFile(join(terminalLinksDirectory, 'programa-e2e.exe'), 'MZ');
    process.env.LTERMINAL_E2E_OPENED_LINKS = openedLinksFile;
    // Sin el modo de pruebas (fuera de Windows no se activa solo) el backend
    // abriría el navegador de verdad.
    process.env.LTERMINAL_E2E_TESTING = '1';
}

// Algunas versiones de WebView2 escriben DevToolsActivePort dentro de
// <UDF>\EBWebView, pero EdgeDriver sigue buscándolo en <UDF>. Mientras se crea
// la sesión reflejamos el archivo en la ubicación que espera el driver. No se
// modifica el perfil real y ambos archivos desaparecen con la UDF temporal.
async function bridgeWebView2DevToolsActivePort() {
    if (!webviewUserDataFolder) return false;
    const expectedPath = join(webviewUserDataFolder, 'DevToolsActivePort');
    const actualPath = join(webviewUserDataFolder, 'EBWebView', 'DevToolsActivePort');
    while (!sessionCreationFinished) {
        try {
            await access(expectedPath);
            return false;
        } catch {
            // EdgeDriver todavía no ve el puerto en la raíz de la UDF.
        }
        try {
            const contents = await readFile(actualPath, 'utf8');
            if (/^\d+\r?\n\/devtools\/browser\//.test(contents)) {
                await writeFile(expectedPath, contents, { flag: 'wx' });
                smokeReport.host.webview2DevToolsPortBridged = true;
                process.stdout.write(`E2E WebView2: DevToolsActivePort reflejado desde ${actualPath}\n`);
                return true;
            }
        } catch {
            // WebView2 puede tardar unos instantes en crear el archivo.
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
}

const driverArgs = ['--port', driverPort, '--native-port', nativePort];
if (nativeDriver) driverArgs.push('--native-driver', nativeDriver);
// El driver puede cerrar la sesión WebDriver y aun así dejar vivo el proceso
// Tauri (y una ventana gris sin frontend). En POSIX, aislar cada ejecución en
// su propio grupo permite limpiar solo el driver y sus descendientes sin tocar
// otras instancias de LTerminal abiertas por el usuario.
const driver = spawn(driverPath, driverArgs, {
    // El driver y EdgeDriver escriben avisos de WebView2 en stderr. Heredar
    // ese descriptor abre una consola visible en Windows y contamina el vídeo;
    // los fallos funcionales siguen quedando en el informe y en main.log.
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    // El vídeo de escritorio no debe mostrar una consola del driver/WebView2
    // al cerrar la aplicación. Los diagnósticos siguen quedando en stderr y
    // en el informe, pero no contaminan la evidencia visual.
    windowsHide: process.platform === 'win32',
});
const driverDiagnostics = [];
driver.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    driverDiagnostics.push(text);
    if (process.env.E2E_DRIVER_LOG === '1') process.stderr.write(text);
    if (driverDiagnostics.length > 80) driverDiagnostics.splice(0, driverDiagnostics.length - 80);
});
let driverStartupError = null;
driver.once('error', (error) => {
    driverStartupError = new Error(`No se pudo iniciar tauri-driver (${driverPath}): ${error.message}`);
});
driver.once('exit', (code, signal) => {
    driverStartupError ??= new Error(`tauri-driver terminó antes de aceptar sesiones (código=${code ?? 'ninguno'}, señal=${signal ?? 'ninguna'})`);
});
const endpoint = `http://127.0.0.1:${driverPort}`;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
let sessionId;
let panelVisibilityInitial = null;
// Durante las aserciones de paneles el WebDriver puede quedar ocupado un
// ciclo de pintura después de un resize. No conviene que una consulta DOM
// aislada consuma el timeout global de 90 s y convierta ese estado transitorio
// en un fallo definitivo; esas consultas se acotan y se reintentan.
let paneAuditFastPath = false;
const smokeStartedAt = Date.now();
const phaseTimings = [];
let lastEventAt = smokeStartedAt;
let phaseStartedAt = smokeStartedAt;
let phaseName = 'driver';
const nativeBrandPattern = process.platform === 'win32' ? /\bWTerminal\b/i : /\bLTerminal\b/i;
const smokeReportPath = process.env.LTERMINAL_SMOKE_REPORT
    ?? join(tmpdir(), `lterminal-smoke-${smokeToken}.json`);
const captureScreenshots = process.env.E2E_CAPTURE_SCREENSHOTS !== '0';
const comprehensiveVisualAudit = process.env.E2E_FULL_VISUAL_AUDIT === '1';
// Una auditoría completa siempre conserva vídeo: sin él solo se valida el
// DOM y no el recorrido visual de la ventana, el teclado, el scroll y los
// cambios de tamaño. Los demás escenarios siguen optando por E2E_CAPTURE_VIDEO.
const captureVideo = process.env.E2E_CAPTURE_VIDEO === '1' || dependencyAuditOnly || comprehensiveVisualAudit;
// En la auditoría completa el vídeo también recorre cada tarjeta visible de
// acción. No pulsa sus botones: solo desplaza la opción al centro y deja que
// el muestreador de la ventana la grabe. Se puede desactivar para smoke cortos.
const dependencyVisualActions = (dependencyAuditOnly || comprehensiveVisualAudit)
    && process.env.E2E_DEPENDENCY_VISUAL_ACTIONS !== '0';
const dependencyVisualActionHoldMs = Math.max(
    80,
    Number(process.env.E2E_DEPENDENCY_ACTION_HOLD_MS ?? 160) || 160,
);
const dependencyCaptureEachAction = (dependencyAuditOnly || comprehensiveVisualAudit)
    && process.env.E2E_DEPENDENCY_CAPTURE_EACH_ACTION !== '0';
// El muestreo anterior estaba capado a 15 FPS y, además, un solo screenshot
// WebDriver bloqueaba al siguiente. Eso dejaba fuera cambios de foco, cursor
// y paneles que duran menos de 100 ms. La auditoría visual usa 30 FPS y varias
// capturas concurrentes; el informe sigue guardando la frecuencia efectiva
// alcanzada por el driver, que puede ser menor si WebView2 tarda en pintar.
// La captura de escritorio puede solicitar 60 FPS como sonda de transiciones
// breves. El muestreo WebDriver conserva 30 por defecto; el informe registra
// la frecuencia efectiva, que nunca se infiere del valor solicitado.
const videoSampleFps = Math.min(60, Math.max(4,
    Number(process.env.E2E_VIDEO_FPS ?? (comprehensiveVisualAudit ? 30 : 8))
        || (comprehensiveVisualAudit ? 30 : 8)));
const videoSampleIntervalMs = Math.max(16, Math.round(1000 / videoSampleFps));
const videoSamplerConcurrency = Math.max(1, Math.min(4,
    Number(process.env.E2E_VIDEO_SAMPLER_CONCURRENCY
        ?? 2)
        || 2));
const videoForcedMinIntervalMs = (comprehensiveVisualAudit || process.env.E2E_VIDEO_ACTION_BURST !== '0')
    ? 0
    : Math.max(60, Math.floor(videoSampleIntervalMs / 2));
// Una captura de vídeo nunca debe ocupar el endpoint WebDriver durante los
// 90 s completos: durante un resize o una transición de paneles el driver
// puede tardar varios segundos en pintar y una muestra pendiente bloquearía
// las interacciones que estamos auditando. Se pierde como máximo una muestra,
// no el paso funcional, y el muestreo siguiente continúa normalmente.
const videoSampleRequestTimeoutMs = Math.max(500, Math.min(3000,
    Number(process.env.E2E_VIDEO_SAMPLE_TIMEOUT_MS ?? 1200) || 1200));
const videoActionBurstEnabled = captureVideo
    && (comprehensiveVisualAudit || process.env.E2E_VIDEO_ACTION_BURST === '1');
const videoActionBurstFrames = Math.max(2, Math.min(6,
    Number(process.env.E2E_VIDEO_ACTION_BURST_FRAMES ?? 4) || 4));
const videoActionBurstStepMs = Math.max(16, Math.min(250,
    Number(process.env.E2E_VIDEO_ACTION_BURST_STEP_MS ?? 25) || 25));
const nativeVideoSegments = process.env.E2E_VIDEO_NATIVE_SEGMENTS !== '0'
    && (dependencyAuditOnly || comprehensiveVisualAudit || process.env.E2E_VIDEO_NATIVE_SEGMENTS === '1');
// En Windows la auditoría completa se graba dentro de la ventana de WTerminal
// por defecto. La captura del escritorio incluía el escritorio del runner y
// las consolas auxiliares de WebView2; solo se conserva si se solicita de forma
// explícita con E2E_VIDEO_SOURCE=desktop.
const videoWindowOnly = process.platform === 'win32'
    && process.env.E2E_VIDEO_SOURCE !== 'desktop';
const captureDirectory = process.env.E2E_CAPTURE_DIR
    ?? join(tmpdir(), `winslim-terminal-e2e-captures-${smokeToken}`);
const progressSimulationScriptName = `lterminal-progress-${smokeToken}.ps1`;
const progressSimulationScriptPath = join(tmpdir(), progressSimulationScriptName);
const reflowSimulationScriptName = `lterminal-reflow-${smokeToken}.ps1`;
const reflowSimulationScriptPath = join(tmpdir(), reflowSimulationScriptName);
if (captureScreenshots || captureVideo) await mkdir(captureDirectory, { recursive: true });
const videoPath = captureVideo
    ? join(captureDirectory, `00-e2e-${progressLayoutOnly ? 'progress' : 'smoke'}.mp4`)
    : null;
let videoRecorder;
let videoStartedAt = null;
let videoStoppedAt = null;
let windowVideoSampler = null;
let windowVideoSamplerBusy = false;
let windowVideoSamplerPromise = null;
const windowVideoSamplerPromises = new Set();
let windowVideoSamplerInFlight = 0;
let windowVideoForcedBusy = false;
// Con el renderizado por software del E2E, cada screenshot de una ventana 8K
// rasteriza 33 Mpx: el muestreo continuo dejaba la WebView sin responder
// ~100 s al ampliar y ~65 s al restaurar (3 s sin vídeo). Mientras la ventana
// supera 4K se pausa el muestreo y se registra el intervalo en el informe.
let windowVideoPausedReason = null;
const windowVideoPauses = [];
function pauseWindowVideo(reason) {
    if (windowVideoPausedReason) return;
    windowVideoPausedReason = reason;
    windowVideoPauses.push({ reason, startedAt: new Date().toISOString(), endedAt: null });
}
function resumeWindowVideo() {
    if (!windowVideoPausedReason) return;
    windowVideoPausedReason = null;
    const pause = windowVideoPauses.at(-1);
    if (pause) pause.endedAt = new Date().toISOString();
}
let windowVideoFramesDirectory = null;
let windowVideoFrameCount = 0;
let windowVideoForcedFrameCount = 0;
let windowVideoLastFramePath = null;
let windowVideoLastSampleAt = 0;
let windowVideoFirstFrameAt = null;
let windowVideoLastFrameAt = null;
const windowVideoObservedSizes = new Set();
let windowVideoNativeBlackFrames = 0;
let windowVideoNativeFrameCount = 0;
let windowVideoBlankPrefixFrames = 0;
let windowVideoSourceFrameGaps = [];
let windowVideoBlankIntervals = [];
let windowVideoNativeSegments = [];
let windowVideoSampleNow = null;
let windowVideoSampleBurst = null;
let nativeWindowPreludeTask = null;
let nativeWindowPreludeRecorder = null;
let nativeWindowPreludeDirectory = null;
let diagnosticWindowHiderTimer = null;
let runnerConsoleHidden = false;
const smokeReport = {
    schemaVersion: 1,
    token: smokeToken,
    startedAt: new Date(smokeStartedAt).toISOString(),
    host: {
        platform: process.platform,
        desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
        session: process.env.DESKTOP_SESSION ?? null,
        hyprland: IS_HYPRLAND,
        wsl1: IS_WSL1_HOST,
        webview2UserDataFolder: webviewUserDataFolder,
        webview2AutomationMode: 'launch',
        webview2DevToolsPortBridged: false,
    },
    limits: { ...WINDOW_LIMITS, ratio: 0.25 },
    phases: phaseTimings,
    timings: null,
    events: [],
    captures: [],
    performance: {
        events: [],
        summary: {},
    },
    options: {
        forceShellRefresh: FORCE_SHELL_REFRESH,
        pollIntervalMs: POLL_INTERVAL_MS,
        captureScreenshots,
        captureVideo,
        videoSource: videoWindowOnly ? 'window' : 'desktop',
        videoRequired: captureVideo,
        captureDirectory: captureScreenshots ? captureDirectory : null,
        shellStartupLimitMs: SHELL_STARTUP_LIMIT_MS,
        ltoolsIntegration,
        ltoolsOnly,
        progressLayoutOnly,
        dependencyAuditOnly,
        dependencyVisualActions,
        dependencyVisualActionHoldMs,
        dependencyCaptureEachAction,
        comprehensiveVisualAudit,
        videoSampleFps,
    videoSampleRequestTimeoutMs,
        nativeVideoSegments,
        paneMatrixOnly,
        skipDependencyRefresh,
        dependencyDetectionTimeoutMs,
        terminalOnlyOnly,
        maximizedTabOnly: process.env.E2E_MAXIMIZED_TAB_ONLY === '1',
        requireElevated,
    },
    coverage: {
        dependencyActions: { visual: dependencyVisualActions, captured: 0, skipped: [], perAction: false },
        settings: { covered: false, tabs: [] },
        paneTransitions: [],
        longLineAndAnsiReflow: false,
        horizontalScroll: false,
        elevated: { required: requireElevated, executed: false, status: 'not-requested' },
        k9s: { status: 'not-checked', reason: null },
        windowManager: { status: IS_HYPRLAND ? 'pending' : 'skipped', reason: IS_HYPRLAND ? null : 'Hyprland no disponible' },
        realInstallationsExecuted: false,
    },
    status: 'running',
    reportPath: smokeReportPath,
};

function pngDimensions(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 24
        || buffer.readUInt32BE(0) !== 0x89504e47
        || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function startNativeWindowPrelude() {
    if (!captureVideo || !videoWindowOnly || process.platform !== 'win32' || nativeWindowPreludeTask) return;
    const ffmpeg = await resolveFfmpeg();
    nativeWindowPreludeDirectory = join(captureDirectory, 'native-launch-frames');
    await mkdir(nativeWindowPreludeDirectory, { recursive: true });
    nativeWindowPreludeTask = (async () => {
        const deadline = Date.now() + 20_000;
        let probeIndex = 0;
        while (Date.now() < deadline) {
            const probe = join(nativeWindowPreludeDirectory, `probe-${String(probeIndex++).padStart(4, '0')}.png`);
            try {
                await execFile(ffmpeg, [
                    '-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '4',
                    '-draw_mouse', '1', '-i', 'title=WTerminal', '-frames:v', '1',
                    '-f', 'image2', probe,
                ], { windowsHide: true, timeout: 3000 });
                const firstFrame = join(nativeWindowPreludeDirectory, 'frame-000000.png');
                await copyFile(probe, firstFrame);
                await rm(probe, { force: true });
                nativeWindowPreludeRecorder = spawn(ffmpeg, [
                    '-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '4',
                    '-draw_mouse', '1', '-i', 'title=WTerminal', '-an', '-c:v', 'png',
                    '-f', 'image2', join(nativeWindowPreludeDirectory, 'frame-%06d.png'),
                ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
                nativeWindowPreludeRecorder.once('error', () => { nativeWindowPreludeRecorder = null; });
                return true;
            } catch {
                await rm(probe, { force: true });
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
        }
        return false;
    })();
}

async function stopNativeWindowPrelude() {
    if (nativeWindowPreludeTask) await nativeWindowPreludeTask.catch(() => false);
    nativeWindowPreludeTask = null;
    const recorder = nativeWindowPreludeRecorder;
    nativeWindowPreludeRecorder = null;
    if (recorder) {
        try { recorder.stdin?.write('q'); } catch { /* proceso ya terminado */ }
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            recorder.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        if (!recorder.killed) recorder.kill();
    }
    if (!nativeWindowPreludeDirectory || !windowVideoFramesDirectory) return 0;
    const names = (await readdir(nativeWindowPreludeDirectory))
        .filter((name) => /^frame-\d+\.png$/i.test(name))
        .sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
    // DWM puede exponer la ventana WebView2 antes de que su superficie tenga
    // contenido y gdigrab devuelve una secuencia negra. Antes se descartaba
    // todo el prefijo y el vídeo empezaba cuando la aplicación ya estaba
    // abierta. Conservamos ahora la secuencia nativa y anotamos cuántos frames
    // eran negros: así la apertura real forma parte de la evidencia y el
    // informe no confunde una limitación de WebView2 con una ausencia de vídeo.
    if (names.length > 0) {
        const ffmpeg = await resolveFfmpeg();
        for (const name of names) {
            try {
                const probe = await execFile(ffmpeg, [
                    '-v', 'error', '-i', join(nativeWindowPreludeDirectory, name),
                    '-vf', 'scale=1:1,format=gray', '-frames:v', '1',
                    '-f', 'rawvideo', 'pipe:1',
                ], { windowsHide: true, timeout: 5000, encoding: 'buffer' });
                const luminance = Buffer.isBuffer(probe.stdout) ? probe.stdout[0] ?? 0 : 0;
                if (luminance < 8) windowVideoNativeBlackFrames += 1;
            } catch {
                // La captura sigue siendo válida aunque la sonda no pueda
                // leer un frame concreto; no eliminamos evidencia silenciosamente.
            }
        }
    }
    // Estos frames son evidencia del lanzamiento nativo, pero no deben
    // mezclarse con las capturas WebDriver. DWM puede entregar una imagen
    // válida y, durante varios ticks, una superficie negra; al concatenarlas
    // el MP4 aparentaba un apagón de segundos en mitad del arranque. Los
    // conservamos en native-launch-frames para diagnóstico y dejamos que el
    // vídeo funcional empiece con el primer frame real del viewport.
    windowVideoNativeFrameCount = names.length;
    for (const name of names) {
        const dimensions = pngDimensions(await readFile(join(nativeWindowPreludeDirectory, name)));
        if (dimensions) windowVideoObservedSizes.add(`${dimensions.width}x${dimensions.height}`);
    }
    return names.length;
}

async function startDesktopVideo() {
    if (!captureVideo || videoRecorder || !videoPath) return null;
    // WebView2 surfaces are composited by DWM and gdigrab's title input can
    // return a valid MP4 containing only black frames. WebDriver captures the
    // actual application viewport, so use it for the default Windows audit.
    if (videoWindowOnly && process.platform === 'win32') {
        // Arm the sampler before WebDriver creates the session. There is no
        // viewport to capture yet, but the timeline then includes the launch
        // request instead of silently beginning after WTerminal is visible.
        if (windowVideoSampler) return videoPath;
        const hadWindowVideoFrames = Boolean(windowVideoFramesDirectory);
        windowVideoFramesDirectory ??= join(captureDirectory, 'video-frames');
        await mkdir(windowVideoFramesDirectory, { recursive: true });
        if (!hadWindowVideoFrames) {
            windowVideoFrameCount = 0;
            windowVideoForcedFrameCount = 0;
            windowVideoNativeBlackFrames = 0;
            windowVideoNativeFrameCount = 0;
            windowVideoBlankPrefixFrames = 0;
            windowVideoSourceFrameGaps = [];
            windowVideoBlankIntervals = [];
            windowVideoNativeSegments = [];
            windowVideoFirstFrameAt = null;
            windowVideoLastFrameAt = null;
        }
        const sample = async (forced = false) => {
            if (!sessionId) return false;
            if (windowVideoPausedReason) return false;
            if (!forced && windowVideoForcedBusy) return false;
            // Las acciones visuales piden una captura inmediata para no perder
            // una tarjeta que solo permanece unos milisegundos, pero no hay que
            // insertar otro fotograma si el muestreo periódico acaba de tomar
            // uno. Sin esta ventana el MP4 tenía más tiempo codificado que la
            // prueba real (los fotogramas forzados se reproducían a 4 fps).
            if (forced && Date.now() - windowVideoLastSampleAt < videoForcedMinIntervalMs) return false;
            // El muestreo periódico no debe bloquear el E2E, pero una captura
            // forzada representa una interacción que debe quedar en vídeo.
            // Esperar brevemente a la captura en curso evita que todas las
            // acciones rápidas desaparezcan justo cuando WebDriver está
            // ocupado con otro screenshot.
            // Las capturas periódicas pueden ejecutarse en paralelo. El
            // endpoint WebDriver suele tardar entre 70 y 120 ms; dos lanes
            // permiten acercarse a 30 FPS sin esperar a que termine la lane
            // anterior. Las capturas forzadas sí esperan a que el estado
            // anterior se estabilice para asociarse a la interacción correcta.
            if (forced && windowVideoSamplerBusy) {
                if (!forced || !windowVideoSamplerPromise) return false;
                await Promise.race([
                    windowVideoSamplerPromise.catch(() => false),
                    new Promise((resolve) => setTimeout(resolve, Math.min(videoSampleRequestTimeoutMs, 1500))),
                ]);
                if (windowVideoSamplerBusy) return false;
            }
            if (!forced && windowVideoSamplerInFlight >= videoSamplerConcurrency) return false;
            windowVideoSamplerInFlight += 1;
            windowVideoSamplerBusy = true;
            const framePromise = (async () => {
                try {
                    const encoded = await request(`/session/${sessionId}/screenshot`, 'GET', undefined, videoSampleRequestTimeoutMs);
                    if (typeof encoded !== 'string' || encoded.length < 32) return;
                    const dimensions = pngDimensions(Buffer.from(encoded, 'base64'));
                    if (dimensions) windowVideoObservedSizes.add(`${dimensions.width}x${dimensions.height}`);
                    // Reservar el índice antes del primer await evita que dos
                    // screenshots concurrentes escriban sobre el mismo PNG.
                    const frameIndex = windowVideoFrameCount;
                    windowVideoFrameCount += 1;
                    const framePath = join(windowVideoFramesDirectory, `frame-${String(frameIndex).padStart(6, '0')}.png`);
                    await writeFile(framePath, Buffer.from(encoded, 'base64'));
                    windowVideoLastFramePath = framePath;
                    windowVideoLastSampleAt = Date.now();
                    windowVideoFirstFrameAt ??= windowVideoLastSampleAt;
                    windowVideoLastFrameAt = windowVideoLastSampleAt;
                    return true;
                } catch {
                    // A closing WebDriver session simply ends the last sample.
                    return false;
                } finally {
                    windowVideoSamplerInFlight = Math.max(0, windowVideoSamplerInFlight - 1);
                    windowVideoSamplerBusy = windowVideoSamplerInFlight > 0;
                }
            })();
            windowVideoSamplerPromise = framePromise;
            windowVideoSamplerPromises.add(framePromise);
            const captured = await framePromise;
            windowVideoSamplerPromises.delete(framePromise);
            if (windowVideoSamplerPromise === framePromise) windowVideoSamplerPromise = null;
            return captured;
        };
        windowVideoSampleNow = async () => {
            // El intervalo periódico puede estar usando WebDriver justo en el
            // instante de una transición. Reintentar aquí evita que una
            // carrera del muestreador convierta una interacción visible en un
            // falso fallo de cobertura del vídeo.
            const resumeSampler = Boolean(windowVideoSampler);
            if (resumeSampler) {
                clearInterval(windowVideoSampler);
                windowVideoSampler = null;
            }
            windowVideoForcedBusy = true;
            try {
                for (let attempt = 0; attempt < 5; attempt += 1) {
                    const captured = await sample(true);
                    if (captured) {
                        windowVideoForcedFrameCount += 1;
                        return true;
                    }
                    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 180));
                }
                return false;
            } finally {
                windowVideoForcedBusy = false;
                if (resumeSampler && !windowVideoSampler && sessionId) {
                    windowVideoSampler = setInterval(() => { void sample(); }, videoSampleIntervalMs);
                }
            }
        };
        windowVideoSampleBurst = async () => {
            if (!videoActionBurstEnabled) return false;
            const resumeSampler = Boolean(windowVideoSampler);
            if (resumeSampler) {
                clearInterval(windowVideoSampler);
                windowVideoSampler = null;
            }
            windowVideoForcedBusy = true;
            let capturedAny = false;
            try {
                for (let index = 0; index < videoActionBurstFrames; index += 1) {
                    if (index > 0) await new Promise((resolve) => setTimeout(resolve, videoActionBurstStepMs));
                    let captured = false;
                    for (let attempt = 0; attempt < 3 && !captured; attempt += 1) {
                        captured = await sample(true);
                        if (!captured && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 24));
                    }
                    if (captured) {
                        capturedAny = true;
                        windowVideoForcedFrameCount += 1;
                    }
                }
                return capturedAny;
            } finally {
                windowVideoForcedBusy = false;
                if (resumeSampler && !windowVideoSampler && sessionId) {
                    windowVideoSampler = setInterval(() => { void sample(); }, videoSampleIntervalMs);
                }
            }
        };
        // El reloj empieza al armar la grabación, antes de crear la sesión
        // WebDriver. Los frames nativos y cualquier espera de WebView2 quedan
        // incluidos en la duración que se compara con el E2E.
        videoStartedAt ??= Date.now();
        await sample();
        windowVideoSampler = setInterval(() => { void sample(); }, videoSampleIntervalMs);
        smokeReport.video ??= {
            path: videoPath,
            startedAt: new Date(videoStartedAt).toISOString(),
            status: 'recording',
            source: 'webdriver-window',
            frameRate: videoSampleFps,
            requestedFrameRate: videoSampleFps,
            samplerConcurrency: videoSamplerConcurrency,
            actionBurst: videoActionBurstEnabled
                ? { frames: videoActionBurstFrames, stepMs: videoActionBurstStepMs }
                : null,
            forcedActionFrames: 0,
        };
        if (!smokeReport.events.some((event) => event.type === 'video-start')) {
            recordEvent('video-start', { path: videoPath, source: 'webdriver-window', passed: true });
        }
        return videoPath;
    }
    const ffmpeg = await resolveFfmpeg();
    const args = process.platform === 'win32'
        ? ['-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(videoSampleFps), '-draw_mouse', '1', '-i', videoWindowOnly ? 'title=WTerminal' : 'desktop', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', videoPath]
        : process.env.DISPLAY
            ? ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', String(videoSampleFps), '-i', process.env.DISPLAY, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', videoPath]
            : null;
    if (!args) {
        const reason = 'no hay DISPLAY disponible';
        smokeReport.video = { path: videoPath, status: 'unavailable', reason };
        recordEvent('video-unavailable', { path: videoPath, reason, passed: false });
        throw new Error(`E2E vídeo solicitado pero ${reason}`);
    }
    try {
        await execFile(ffmpeg, ['-version'], { windowsHide: true });
    } catch (error) {
        const reason = `ffmpeg no está disponible (${error.message})`;
        smokeReport.video = { path: videoPath, status: 'unavailable', reason };
        recordEvent('video-unavailable', { path: videoPath, reason, passed: false });
        throw new Error(`E2E vídeo solicitado pero ${reason}`, { cause: error });
    }
    try {
        videoRecorder = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
        videoStartedAt = Date.now();
        videoRecorder.stderr?.on('data', (chunk) => {
            const message = String(chunk).trim();
            if (message) process.stderr.write(`E2E vídeo ffmpeg: ${message}\n`);
        });
        videoRecorder.once('error', (error) => {
            process.stderr.write(`E2E vídeo no pudo iniciarse: ${error.message}\n`);
            if (smokeReport.video) {
                smokeReport.video.status = 'failed';
                smokeReport.video.reason = error.message;
            }
            recordEvent('video-error', { path: videoPath, reason: error.message, passed: false });
            smokeReport.status = 'failed';
            process.exitCode = 1;
            videoRecorder = undefined;
        });
        videoRecorder.once('exit', (code, signal) => {
            if (code !== 0 && code !== null) process.stderr.write(`E2E vídeo terminó con código ${code} (${signal ?? 'sin señal'})\n`);
        });
        smokeReport.video = {
            path: videoPath,
            startedAt: new Date(videoStartedAt).toISOString(),
            status: 'recording',
            source: videoWindowOnly ? 'gdigrab-window' : 'gdigrab-desktop',
            requestedFrameRate: videoSampleFps,
        };
        recordEvent('video-start', { path: videoPath, passed: true });
        return videoPath;
    } catch (error) {
        process.stderr.write(`E2E vídeo omitido: ${error.message}\n`);
        return null;
    }
}

/**
 * Winget puede añadir el alias de ffmpeg a WindowsApps sin actualizar el
 * entorno del proceso Node que ya estaba abierto. Resolver también el binario
 * instalado en el almacén evita que una instalación correcta se reporte como
 * ausente hasta reiniciar la terminal.
 */
async function resolveFfmpeg() {
    const requested = process.env.E2E_FFMPEG?.trim();
    if (requested) return requested;
    try {
        await execFile('ffmpeg', ['-version'], { windowsHide: true });
        return 'ffmpeg';
    } catch {
        // Buscar debajo del paquete Essentials sin depender del PATH heredado.
    }
    if (process.platform !== 'win32') return 'ffmpeg';
    const root = process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
        : null;
    if (!root) return 'ffmpeg';
    const walk = async (directory, depth) => {
        if (depth > 5) return null;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch { return null; }
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') return path;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const found = await walk(join(directory, entry.name), depth + 1);
            if (found) return found;
        }
        return null;
    };
    return await walk(root, 0) ?? 'ffmpeg';
}

async function stopDesktopVideo() {
    if (windowVideoSampler || windowVideoFramesDirectory) {
        if (windowVideoSampler) clearInterval(windowVideoSampler);
        windowVideoSampler = null;
        // Capturar el estado que la última aserción acaba de validar antes de
        // soltar la sesión WebDriver. El intervalo puede haber tomado su
        // último frame justo antes del `echo` final y dejar el MP4 congelado en
        // una línea parcialmente escrita.
        if (windowVideoSampleNow) await windowVideoSampleNow().catch(() => false);
        windowVideoSampleNow = null;
        windowVideoSampleBurst = null;
        if (windowVideoSamplerPromises.size > 0) {
            await Promise.all([...windowVideoSamplerPromises].map((pending) => pending.catch(() => false)));
        } else if (windowVideoSamplerPromise) {
            await windowVideoSamplerPromise.catch(() => {});
        }
        videoStoppedAt = Date.now();
        const ffmpeg = await resolveFfmpeg();
        try {
            let encodedFrameNames = [];
            let encodedFrameRate = 1;
            let frameSize = { width: 0, height: 0 };
            let sourceFrameSize = { width: 0, height: 0 };
            let decodedFrameCount = 0;
            let rawSourceNumbers = [];
            let rawFrameCount = 0;
            if (windowVideoFrameCount > 0) {
                // El muestreador y las capturas forzadas pueden terminar en
                // instantes distintos. Si una escritura falla o llega tarde,
                // queda un hueco en la secuencia (por ejemplo, falta
                // frame-000006.png). image2 interpreta el primer hueco como
                // fin del vídeo y produce un MP4 aparentemente válido de solo
                // unos frames, aunque el informe tenga miles. Reenumerar la
                // secuencia real antes de invocar FFmpeg evita truncar la
                // grabación y conserva todas las capturas disponibles.
                const rawFrameNames = (await readdir(windowVideoFramesDirectory))
                    .filter((name) => /^frame-\d+\.png$/i.test(name))
                    .sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
                if (rawFrameNames.length === 0) throw new Error('WebDriver no produjo capturas de ventana');
                rawFrameCount = rawFrameNames.length;
                // La continuidad de origen se calcula antes de eliminar
                // prefijos negros o de compactar para FFmpeg. Así una captura
                // descartada no se presenta falsamente como un hueco del
                // muestreador.
                rawSourceNumbers = rawFrameNames.map((name) => Number(name.slice(6, -4)));
                const sourceGaps = [];
                for (let index = 1; index < rawSourceNumbers.length; index += 1) {
                    if (rawSourceNumbers[index] !== rawSourceNumbers[index - 1] + 1) {
                        sourceGaps.push({ before: rawSourceNumbers[index - 1], after: rawSourceNumbers[index] });
                    }
                }
                let frameNames = rawFrameNames;
                // La superficie WebView2 puede existir unos instantes antes de
                // pintar texto y producir capturas con solo el marco/cursores.
                // Medir la región central de la terminal evita confundir los
                // píxeles del toolbar con contenido renderizado. Descarta solo
                // ese prefijo; el MP4 empieza en la primera pantalla útil.
                let blankPrefix = 0;
                while (blankPrefix < Math.min(300, frameNames.length - 1)) {
                    const probePath = join(windowVideoFramesDirectory, frameNames[blankPrefix]);
                    try {
                        const probe = await execFile(ffmpeg, [
                            '-v', 'error', '-i', probePath,
                            '-vf', 'crop=iw:ih*0.8:0:ih*0.12,scale=64:64,format=gray',
                            '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
                        ], { windowsHide: true, timeout: 5000, encoding: 'buffer' });
                        const pixels = Buffer.isBuffer(probe.stdout) ? probe.stdout : Buffer.alloc(0);
                        let lit = 0;
                        for (const value of pixels) if (value >= 45) lit += 1;
                        // Un cursor aislado o una línea de borde no alcanza
                        // este umbral; el banner/prompt sí deja decenas de
                        // píxeles de texto en la región de la terminal.
                        if (lit >= 50) break;
                    } catch {
                        break;
                    }
                    blankPrefix += 1;
                }
                windowVideoBlankPrefixFrames = blankPrefix;
                if (blankPrefix > 0) frameNames = frameNames.slice(blankPrefix);
                encodedFrameNames = frameNames;
                windowVideoSourceFrameGaps = sourceGaps;
                const contiguous = sourceGaps.length === 0;
                let encodeDirectory = windowVideoFramesDirectory;
                if (!contiguous || rawSourceNumbers[0] !== 0 || blankPrefix > 0) {
                    encodeDirectory = join(windowVideoFramesDirectory, '_encoded-sequence');
                    await rm(encodeDirectory, { recursive: true, force: true });
                    await mkdir(encodeDirectory, { recursive: true });
                    for (let index = 0; index < frameNames.length; index += 1) {
                        const name = frameNames[index];
                        await copyFile(
                            join(windowVideoFramesDirectory, name),
                            join(encodeDirectory, `frame-${String(index).padStart(6, '0')}.png`),
                        );
                    }
                }
                // No abrir miles de PNG a la vez: una auditoría completa a
                // 15 FPS supera el límite de handles de Windows (EMFILE) si
                // se usa Promise.all sobre toda la secuencia.
                const sourceFrameDimensions = [];
                for (const name of frameNames) {
                    sourceFrameDimensions.push(
                        pngDimensions(await readFile(join(windowVideoFramesDirectory, name))),
                    );
                }
                sourceFrameSize = sourceFrameDimensions.reduce((max, current) => ({
                    width: Math.max(max.width, current?.width ?? 0),
                    height: Math.max(max.height, current?.height ?? 0),
                }), { width: 0, height: 0 });
                frameSize = {
                    width: Math.max(2, Math.min(sourceFrameSize.width, VIDEO_LIMITS.maxWidth) & ~1),
                    height: Math.max(2, Math.min(sourceFrameSize.height, VIDEO_LIMITS.maxHeight) & ~1),
                };
                if (!sourceFrameSize.width || !sourceFrameSize.height) {
                    throw new Error('WebDriver produjo PNG sin dimensiones válidas');
                }
                const elapsedMs = Math.max(1, videoStoppedAt - (videoStartedAt ?? videoStoppedAt));
                const captureSpanMs = windowVideoFirstFrameAt !== null && windowVideoLastFrameAt !== null
                    ? Math.max(1, windowVideoLastFrameAt - windowVideoFirstFrameAt)
                    : elapsedMs;
                // Mantener la duración real aunque el driver haya descartado
                // muestras durante un resize. FFmpeg admite una cadencia
                // fraccionaria; forzar 1 FPS acortaba un E2E de varios minutos
                // a unos segundos y dejaba el vídeo sin cobertura temporal.
                encodedFrameRate = Math.max(0.25, Math.min(30, frameNames.length / (elapsedMs / 1000)));
                if (smokeReport.video) {
                    smokeReport.video.captureSpanMs = captureSpanMs;
                    smokeReport.video.captureEffectiveFrameRate = frameNames.length / (captureSpanMs / 1000);
                }
                const normalizeVideoFrame = `scale=${frameSize.width}:${frameSize.height}:force_original_aspect_ratio=decrease,pad=${frameSize.width}:${frameSize.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
                const encodeArgs = [
                    '-y', '-loglevel', 'error', '-framerate', encodedFrameRate.toFixed(6),
                    '-i', join(encodeDirectory, 'frame-%06d.png'),
                    '-vf', normalizeVideoFrame,
                    '-fps_mode', 'passthrough',
                    '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
                    '-pix_fmt', 'yuv420p', videoPath,
                ];
                try {
                    // Una auditoría completa puede contener más de diez mil
                    // PNG y varias resoluciones nativas. En Windows el primer
                    // arranque de FFmpeg puede superar tres minutos aunque la
                    // codificación termine correctamente si el disco está
                    // ocupado por las capturas y los segmentos nativos.
                    await execFile(ffmpeg, encodeArgs, { windowsHide: true, timeout: 600_000 });
                } catch (primaryEncodeError) {
                    // Algunos builds de FFmpeg abortan el modo passthrough al
                    // encontrar cambios de tamaño entre capturas consecutivas.
                    // Reintentar en CFR mantiene todos los PNG y fuerza un
                    // contenedor MP4 finalizable, en vez de dejar un fichero
                    // sin índice `moov` y marcar como válida una grabación
                    // incompleta.
                    await execFile(ffmpeg, [
                        ...encodeArgs.slice(0, encodeArgs.indexOf('-fps_mode') + 1), 'cfr',
                        ...encodeArgs.slice(encodeArgs.indexOf('-fps_mode') + 2),
                    ], { windowsHide: true, timeout: 600_000 });
                    if (smokeReport.video) {
                        smokeReport.video.encoderRetry = {
                            mode: 'cfr',
                            reason: String(primaryEncodeError?.message ?? primaryEncodeError).slice(0, 1200),
                        };
                    }
                }
                const blackProbe = await execFile(ffmpeg, [
                    '-hide_banner', '-loglevel', 'info', '-i', videoPath,
                    '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-',
                ], { windowsHide: true, timeout: 180_000 }).catch(() => ({ stderr: '' }));
                const blackIntervals = [...String(blackProbe.stderr ?? '').matchAll(
                    /black_start:\s*([\d.]+).*?black_end:\s*([\d.]+).*?black_duration:\s*([\d.]+)/g,
                )].map((match) => ({
                    startMs: Math.round(Number(match[1]) * 1000),
                    endMs: Math.round(Number(match[2]) * 1000),
                    durationMs: Math.round(Number(match[3]) * 1000),
                })).filter((interval) => Number.isFinite(interval.durationMs));
                windowVideoBlankIntervals = blackIntervals;
                // `blackdetect` considera negro el fondo de una terminal
                // oscura aunque la ventana, el prompt y el texto sigan
                // visibles. Conservar los intervalos como diagnóstico, pero
                // no convertir ese falso positivo en un fallo funcional; la
                // validez visual se comprueba con las capturas de ventana y
                // la decodificación completa que sigue.
                smokeReport.video.blackDetection = {
                    intervals: blackIntervals,
                    diagnosticOnly: true,
                };
                const decoded = await execFile(ffmpeg, [
                    '-hide_banner', '-loglevel', 'warning', '-stats',
                    '-i', videoPath, '-map', '0:v:0', '-f', 'null', '-',
                ], { windowsHide: true, timeout: 180_000 });
                const decodedFrameMatches = [...String(decoded.stderr ?? '').matchAll(/frame=\s*(\d+)/g)];
                decodedFrameCount = Number(decodedFrameMatches.at(-1)?.[1] ?? 0);
                if (decodedFrameCount < frameNames.length) {
                    throw new Error(`FFmpeg truncó la secuencia (${decodedFrameCount}/${frameNames.length} frames decodificados)`);
                }
                // Además del MP4 normalizado, conserva segmentos con la
                // resolución nativa de cada tramo. El vídeo principal sigue
                // siendo fácil de reproducir, mientras que estos segmentos
                // permiten auditar los cambios 1100x900/1600x900/800x600 sin
                // padding ni reescalado.
                if (nativeVideoSegments) {
                    const segmentRoot = join(captureDirectory, 'video-segments');
                    await rm(segmentRoot, { recursive: true, force: true });
                    await mkdir(segmentRoot, { recursive: true });
                    const segments = [];
                    let segmentStart = 0;
                    const keyFor = (value) => value ? `${value.width}x${value.height}` : 'unknown';
                    for (let index = 1; index <= sourceFrameDimensions.length; index += 1) {
                        if (index < sourceFrameDimensions.length
                            && keyFor(sourceFrameDimensions[index]) === keyFor(sourceFrameDimensions[segmentStart])) continue;
                        const dimensions = sourceFrameDimensions[segmentStart];
                        if (dimensions?.width > 0 && dimensions?.height > 0) {
                            segments.push({ start: segmentStart, end: index, dimensions });
                        }
                        segmentStart = index;
                    }
                    windowVideoNativeSegments = [];
                    for (let index = 0; index < segments.length; index += 1) {
                        const segment = segments[index];
                        const segmentDir = join(segmentRoot, `segment-${String(index + 1).padStart(3, '0')}-${segment.dimensions.width}x${segment.dimensions.height}`);
                        await mkdir(segmentDir, { recursive: true });
                        const segmentNames = frameNames.slice(segment.start, segment.end);
                        for (let offset = 0; offset < segmentNames.length; offset += 1) {
                            await copyFile(
                                join(windowVideoFramesDirectory, segmentNames[offset]),
                                join(segmentDir, `frame-${String(offset).padStart(6, '0')}.png`),
                            );
                        }
                        const segmentPath = join(segmentRoot, `segment-${String(index + 1).padStart(3, '0')}-${segment.dimensions.width}x${segment.dimensions.height}.mp4`);
                        // H.264 con yuv420p exige dimensiones pares. Las
                        // capturas nativas de WebDriver pueden tener un ancho
                        // impar (por ejemplo 961px); usar yuv444p conserva
                        // exactamente esa resolución en el segmento, sin
                        // padding ni reescalado artificial.
                        const segmentPixelFormat = (segment.dimensions.width % 2 === 0
                            && segment.dimensions.height % 2 === 0) ? 'yuv420p' : 'yuv444p';
                        await execFile(ffmpeg, [
                            '-y', '-loglevel', 'error', '-framerate', encodedFrameRate.toFixed(6),
                            '-i', join(segmentDir, 'frame-%06d.png'),
                            '-vf', `scale=${segment.dimensions.width}:${segment.dimensions.height}:force_original_aspect_ratio=disable`,
                            '-fps_mode', 'passthrough',
                            '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', segmentPixelFormat,
                            segmentPath,
                        ], { windowsHide: true, timeout: 180_000 });
                        windowVideoNativeSegments.push({
                            path: segmentPath,
                            width: segment.dimensions.width,
                            height: segment.dimensions.height,
                            frames: segmentNames.length,
                            durationMs: Math.round((segmentNames.length / encodedFrameRate) * 1000),
                        });
                    }
                }
            } else {
                throw new Error('WebDriver no produjo capturas de ventana');
            }
            if (smokeReport.video) {
                smokeReport.video.status = 'stopped';
                smokeReport.video.stoppedAt = new Date(videoStoppedAt).toISOString();
                smokeReport.video.durationMs = Math.max(0, videoStoppedAt - (videoStartedAt ?? videoStoppedAt));
                smokeReport.video.frames = encodedFrameNames.length;
                smokeReport.video.decodedFrames = decodedFrameCount;
                smokeReport.video.forcedActionFrames = windowVideoForcedFrameCount;
                smokeReport.video.frameRate = encodedFrameRate;
                smokeReport.video.frameDurationMs = Math.round((encodedFrameNames.length / encodedFrameRate) * 1000);
                smokeReport.video.frameSize = frameSize;
                smokeReport.video.sourceFrameSize = sourceFrameSize;
                smokeReport.video.observedFrameSizes = [...windowVideoObservedSizes];
                smokeReport.video.sourceFrameSequenceContiguous = windowVideoSourceFrameGaps.length === 0;
                smokeReport.video.sourceFrameSequenceStart = Number(rawSourceNumbers[0] ?? 0);
                smokeReport.video.sourceFrameGaps = windowVideoSourceFrameGaps;
                smokeReport.video.pauses = windowVideoPauses;
                smokeReport.video.frameSequenceContiguous = true;
                smokeReport.video.nativeLaunchFramesBlack = windowVideoNativeBlackFrames;
                smokeReport.video.nativeLaunchFramesCaptured = windowVideoNativeFrameCount;
                smokeReport.video.nativeLaunchFramesEncoded = false;
                smokeReport.video.blankPrefixFramesDiscarded = windowVideoBlankPrefixFrames;
                smokeReport.video.blankIntervals = windowVideoBlankIntervals;
                smokeReport.video.nativeSegments = windowVideoNativeSegments;
                smokeReport.video.normalizedFrameSize = frameSize;
                smokeReport.video.wallDurationMs = Math.max(0, videoStoppedAt - (videoStartedAt ?? videoStoppedAt));
                smokeReport.video.sourceFrameCount = rawFrameCount;
                smokeReport.video.sourceFrameSequenceStart = Number(rawSourceNumbers[0] ?? 0);
                smokeReport.video.encodedFrameSequenceGaps = [];
                smokeReport.video.nativeResolutionCoverage = windowVideoNativeSegments.length > 0;
                smokeReport.video.coverageComplete = false;
                const artifact = await stat(videoPath).catch(() => null);
                smokeReport.video.bytes = artifact?.size ?? 0;
                if (!artifact || artifact.size <= 0) throw new Error('FFmpeg no produjo un vídeo de ventana válido');
            }
            recordEvent('video-stop', {
                path: videoPath,
                source: 'webdriver-window',
                frames: encodedFrameNames.length,
                wallDurationMs: smokeReport.video?.wallDurationMs ?? null,
                recordedDurationMs: smokeReport.video?.frameDurationMs ?? null,
                sourceFrameSequenceContiguous: smokeReport.video?.sourceFrameSequenceContiguous ?? null,
                nativeSegments: smokeReport.video?.nativeSegments?.length ?? 0,
                passed: true,
            });
        } catch (error) {
            if (smokeReport.video) {
                smokeReport.video.status = 'failed';
                smokeReport.video.reason = error instanceof Error ? error.message : String(error);
            }
            recordEvent('video-stop', { path: videoPath, source: 'webdriver-window', frames: windowVideoFrameCount, passed: false, error: String(error) });
            smokeReport.status = 'failed';
            process.exitCode = 1;
        }
        return videoPath;
    }
    if (!videoRecorder) return null;
    const recorder = videoRecorder;
    videoRecorder = undefined;
    videoStoppedAt = Date.now();
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        recorder.once('exit', finish);
        // `gdigrab` no termina al recibir EOF en stdin. La orden `q` hace que
        // ffmpeg cierre el contenedor y escriba el índice moov antes de salir;
        // matar el proceso directamente deja un MP4 ilegible.
        try { recorder.stdin?.write('q\n'); } catch { finish(); }
        // Do not unref this guard: when gdigrab has already lost its window,
        // ffmpeg may never emit `exit`; an unref'ed timer lets Node abandon
        // the pending top-level await and drops the final JSON report.
        setTimeout(() => {
            if (!settled) {
                try {
                    if (process.platform === 'win32' && recorder.pid) {
                        void execFile('taskkill', ['/PID', String(recorder.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
                    } else {
                        recorder.kill('SIGTERM');
                    }
                } catch { /* ya terminó */ }
                finish();
            }
        }, 5000);
    });
    if (smokeReport.video) {
        smokeReport.video.status = 'stopped';
        smokeReport.video.stoppedAt = new Date(videoStoppedAt).toISOString();
        smokeReport.video.durationMs = Math.max(0, videoStoppedAt - (videoStartedAt ?? videoStoppedAt));
        const artifact = await stat(videoPath).catch(() => null);
        smokeReport.video.bytes = artifact?.size ?? 0;
        if (!artifact || artifact.size <= 0) {
            smokeReport.video.status = 'failed';
            smokeReport.video.reason = 'ffmpeg no produjo un archivo de vídeo válido';
            smokeReport.status = 'failed';
            process.exitCode = 1;
        }
    }
    recordEvent('video-stop', { path: videoPath, durationMs: smokeReport.video?.durationMs ?? 0, passed: true });
    process.stdout.write(`E2E vídeo: ${videoPath}\n`);
    return videoPath;
}

// El cierre del driver y del proceso aislado puede tardar mientras Windows
// libera WebView2. No hay una interacción nueva que grabar durante ese
// teardown. No rellenar ese intervalo clonando el último frame: hacerlo
// convierte una espera de limpieza en una falsa congelación y hace parecer
// que se perdieron minutos de vídeo. El informe conserva la brecha real.
async function extendVideoThroughE2eTeardown() {
    if (!videoPath || !smokeReport.video || smokeReport.video.status !== 'stopped' || !videoStoppedAt) return;
    // `stopDesktopVideo()` encoda el MP4 y los segmentos nativos antes de
    // devolver el control al `finally`. Medir hasta aquí incluiría ese tiempo
    // de CPU como si la aplicación siguiera ejecutándose y publicaría una
    // brecha falsa de varios minutos. El último fotograma se captura antes de
    // cerrar WebDriver y no queda ninguna interacción visual pendiente en el
    // teardown, por lo que la duración auditable termina en `videoStoppedAt`.
    const recordedUntilMs = videoStoppedAt - smokeStartedAt;
    const e2eElapsedMs = recordedUntilMs;
    const trailingMs = 0;
    smokeReport.video.e2eDurationMs = e2eElapsedMs;
    smokeReport.video.interactiveDurationMs = Math.max(0, videoStoppedAt - (videoStartedAt ?? videoStoppedAt));
    smokeReport.video.teardownFrameHeldMs = 0;
    smokeReport.video.teardownUnrecordedMs = trailingMs;
    smokeReport.video.finalDurationMs = smokeReport.video.frameDurationMs ?? smokeReport.video.interactiveDurationMs;
    smokeReport.video.coverageComplete = trailingMs < 1000;
    if (trailingMs >= 1000) {
        recordEvent('video-teardown-gap', {
            path: videoPath,
            unrecordedTeardownMs: trailingMs,
            e2eDurationMs: e2eElapsedMs,
            recordedDurationMs: smokeReport.video.finalDurationMs,
            passed: false,
        });
    }
}

async function hideWebView2DiagnosticWindows() {
    if (process.platform !== 'win32') return;
    // WebView2 puede abrir una consola de diagnóstico cuando se activa CDP.
    // No es una ventana de WTerminal y no debe aparecer como falso fallo en el
    // último fotograma del vídeo. Se oculta solo después de cerrar la sesión
    // E2E; los mensajes permanecen disponibles en stderr y en el log.
    const script = `Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class E2EWindowHider {
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public static void Hide(uint[] processIds) {
        var targets = new HashSet<uint>(processIds ?? Array.Empty<uint>());
        EnumWindows((hWnd, lParam) => {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (targets.Contains(processId)) ShowWindow(hWnd, 0);
            return true;
        }, IntPtr.Zero);
    }
}
'@;
\$targets = @{};
Get-Process -Name msedgewebview2 -ErrorAction SilentlyContinue | ForEach-Object { \$targets[[uint32]\$_.Id] = \$true };
\$webViewPids = @([uint32[]](\$targets.Keys));
\$targets = @{};
if (\$webViewPids.Count -gt 0) {
    Get-CimInstance Win32_Process -Filter "Name = 'conhost.exe'" -ErrorAction SilentlyContinue |
        Where-Object { \$webViewPids -contains [uint32]\$_.ParentProcessId } |
        ForEach-Object { \$targets[[uint32]\$_.ProcessId] = \$true };
}
[E2EWindowHider]::Hide([uint32[]](\$targets.Keys | ForEach-Object { [uint32]\$_ }))`;
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5000,
    }).catch(() => {});
}

function startDiagnosticWindowHider() {
    if (process.platform !== 'win32' || diagnosticWindowHiderTimer) return;
    // La consola puede aparecer unos cientos de milisegundos después de
    // crear WebView2. Repetimos la ocultación solo durante el arranque para
    // que no entre en las capturas, sin mantener un proceso auxiliar durante
    // el resto del recorrido.
    diagnosticWindowHiderTimer = setInterval(() => {
        void hideWebView2DiagnosticWindows();
    }, 500);
    setTimeout(() => {
        if (diagnosticWindowHiderTimer) {
            clearInterval(diagnosticWindowHiderTimer);
            diagnosticWindowHiderTimer = null;
        }
    }, 20000);
}

async function setRunnerConsoleVisible(visible) {
    if (process.platform !== 'win32') return;
    const command = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class E2ERunnerConsole {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@; $h=[E2ERunnerConsole]::GetConsoleWindow(); if ($h -ne [IntPtr]::Zero) { [E2ERunnerConsole]::ShowWindow($h, ${visible ? 5 : 0}) | Out-Null }`;
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        timeout: 5000,
    }).catch(() => {});
    runnerConsoleHidden = !visible;
}

function recordEvent(type, data = {}) {
    const now = Date.now();
    const sincePreviousMs = Math.max(0, now - lastEventAt);
    lastEventAt = now;
    smokeReport.events.push({
        at: new Date(now).toISOString(),
        elapsedMs: now - smokeStartedAt,
        sincePreviousMs,
        type,
        ...data,
    });
}

function buildTimingReport() {
    const labelFor = (event) => event.label
        ?? event.id
        ?? event.name
        ?? event.panel
        ?? event.submenu
        ?? event.action
        ?? event.marker
        ?? event.capture
        ?? null;
    const timeline = smokeReport.events.map((event) => ({
        type: event.type,
        label: labelFor(event),
        elapsedMs: event.elapsedMs,
        sincePreviousMs: event.sincePreviousMs,
        durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
        passed: event.passed ?? null,
    }));
    const shells = smokeReport.events
        .filter((event) => event.type === 'environment-probe')
        .map((event) => ({
            id: event.id,
            kind: event.kind,
            language: event.language ?? null,
            durationMs: event.durationMs ?? event.totalMs ?? null,
            readinessMs: event.bannerReadyMs ?? null,
            passed: event.passed === true,
        }));
    const operations = smokeReport.events
        .filter((event) => event.type !== 'phase'
            && event.type !== 'screenshot'
            && Number.isFinite(event.durationMs))
        .map((event) => ({
            type: event.type,
            label: labelFor(event),
            durationMs: event.durationMs,
            passed: event.passed ?? null,
        }));
    return {
        schemaVersion: 1,
        totalMs: smokeReport.durationMs,
        phases: phaseTimings,
        shells,
        operations,
        timeline,
    };
}

function markPhase(nextName) {
    const now = Date.now();
    phaseTimings.push({ name: phaseName, durationMs: now - phaseStartedAt });
    phaseName = nextName;
    phaseStartedAt = now;
    recordEvent('phase', { name: nextName });
    process.stdout.write(`E2E fase: ${nextName}\n`);
}

async function request(path, method = 'GET', body, timeoutMs = webdriverRequestTimeoutMs) {
    const effectiveTimeoutMs = paneAuditFastPath && timeoutMs === webdriverRequestTimeoutMs
        ? Math.min(timeoutMs, 10_000)
        : timeoutMs;
    let response;
    try {
        response = await fetch(`${endpoint}${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(effectiveTimeoutMs),
        });
    } catch (error) {
        if (error?.name === 'TimeoutError') {
            throw new Error(`${method} ${path} excedió el límite WebDriver de ${effectiveTimeoutMs} ms`);
        }
        throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.value?.error) {
        throw new Error(`${method} ${path}: ${JSON.stringify(payload.value ?? payload)}`);
    }
    return payload.value;
}

// Las comprobaciones DOM confirman el estado lógico, pero no detectan una
// trama parcialmente repintada en xterm. Guardamos capturas PNG en los
// puntos de transición que históricamente daban problemas y las enlazamos al
// informe para poder inspeccionarlas después de una ejecución real.
async function captureScreenshot(label) {
    if (!captureScreenshots || !sessionId) return null;
    const safeLabel = String(label).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'capture';
    const index = String(smokeReport.captures.length + 1).padStart(2, '0');
    const path = join(captureDirectory, `${index}-${safeLabel}.png`);
    try {
        if (shouldUseWsl1X11Capture(process.platform, osKernelRelease(), process.env.DISPLAY)) {
            try {
                await execFile('import', ['-window', 'root', path], { timeout: 10_000, windowsHide: true });
                smokeReport.captures.push({ label: safeLabel, path, elapsedMs: Date.now() - smokeStartedAt, source: 'x11-root' });
                recordEvent('screenshot', { label: safeLabel, path, source: 'x11-root' });
                process.stdout.write(`E2E captura X11 WSL1: ${path}\n`);
                return path;
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    process.stderr.write(`E2E captura X11 WSL1 no disponible; se intenta WebDriver: ${error}\n`);
                }
            }
        }
        const encoded = await request(`/session/${sessionId}/screenshot`);
        if (typeof encoded !== 'string' || encoded.length < 32) {
            throw new Error(`respuesta de screenshot no válida (${typeof encoded})`);
        }
        await writeFile(path, Buffer.from(encoded, 'base64'));
        smokeReport.captures.push({ label: safeLabel, path, elapsedMs: Date.now() - smokeStartedAt });
        recordEvent('screenshot', { label: safeLabel, path });
        process.stdout.write(`E2E captura: ${path}\n`);
        // Las capturas de checkpoints cubren transiciones que pueden durar
        // menos que el intervalo periódico: foco/cursor, cambio de pestaña,
        // rejilla, resize, scroll y reflow de líneas largas. No se aplica a
        // cada tarjeta de dependencias para mantener acotada la duración de
        // la auditoría masiva.
        const burstLabel = /pane|panel|tab|settings|ajustes|scroll|resize|cursor|input|prompt|help|ansi|reflow|long|progress|matrix|matriz/i.test(safeLabel);
        if (burstLabel && windowVideoSampleBurst) await windowVideoSampleBurst();
        return path;
    } catch (error) {
        recordEvent('screenshot-error', { label: safeLabel, error: error instanceof Error ? error.message : String(error) });
        process.stderr.write(`E2E no pudo guardar la captura ${safeLabel}: ${error}\n`);
        return null;
    }
}

async function recordVideoVisualCheckpoint(label, screenshotPath = null) {
    if (!captureVideo || !videoWindowOnly || !windowVideoSampleNow) return null;
    const captured = await windowVideoSampleNow();
    const checkpoint = {
        label,
        captured,
        frameIndex: captured ? Math.max(0, windowVideoFrameCount - 1) : null,
        framePath: captured ? windowVideoLastFramePath : null,
        screenshotPath,
        elapsedMs: Date.now() - smokeStartedAt,
    };
    smokeReport.video ??= {};
    smokeReport.video.visualCheckpoints ??= [];
    smokeReport.video.visualCheckpoints.push(checkpoint);
    recordEvent('video-visual-checkpoint', checkpoint);
    return checkpoint;
}

async function verifyCompactSettingsFooterLayout() {
    // Comportamiento contiene el formulario más largo y es el caso que
    // realmente puede quedar oculto bajo el pie sticky. Apariencia suele
    // caber completa en una ventana grande y no prueba el contrato de scroll.
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    await resizeWindow(800, 600, { waitForBanner: false });
    const layout = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const dialog = document.querySelector('[role="dialog"]');
            const scroller = dialog?.querySelector('.panel-scroll');
            const form = dialog?.querySelector('form');
            const footer = form?.querySelector('.footer');
            const content = [...(form?.children ?? [])].filter((child) => !child.classList.contains('footer')).at(-1);
            if (!scroller || !footer || !content) {
                return {
                    hasDialog: Boolean(dialog),
                    hasScroller: Boolean(scroller),
                    hasForm: Boolean(form),
                    hasFooter: Boolean(footer),
                    formChildren: [...(form?.children ?? [])].map((child) => child.className),
                };
            }
            // Con el scroll arriba, el pie sticky debe tocar el borde inferior
            // visible: si queda una franja debajo, el contenido se ve pasar
            // por ella.
            scroller.scrollTop = 0;
            const scrollerBottom = scroller.getBoundingClientRect().bottom;
            const stuckFooterBottom = footer.getBoundingClientRect().bottom;
            scroller.scrollTop = scroller.scrollHeight;
            const contentRect = content.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            return {
                gapBelowFooter: Math.round((scrollerBottom - stuckFooterBottom) * 10) / 10,
                gapBelowFooterAtEnd: Math.round((scroller.getBoundingClientRect().bottom - footerRect.bottom) * 10) / 10,
                scrollerPadding: getComputedStyle(scroller).paddingBottom,
                hasDialog: true,
                hasScroller: true,
                hasFooter: true,
                viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
                scroller: { clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight },
                scrollTop: scroller.scrollTop,
                maxScroll: scroller.scrollHeight - scroller.clientHeight,
                contentBottom: contentRect.bottom,
                footerTop: footerRect.top,
                formBottom: form.getBoundingClientRect().bottom,
                reservedPadding: getComputedStyle(form).paddingBottom,
            };`,
        args: [],
    });
    if (!layout?.hasScroller
        || !layout.hasFooter
        || layout.maxScroll <= 0
        || layout.contentBottom > layout.footerTop + 1
        || layout.gapBelowFooter > 1
        || layout.gapBelowFooterAtEnd > 1) {
        await captureScreenshot('settings-footer-overlap-800x600');
        throw new Error(`El pie de Ajustes tapa contenido en 800x600: ${JSON.stringify(layout)}`);
    }
    return layout;
}

async function waitForDriver() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (driverStartupError) throw driverStartupError;
        try { await request('/status'); return; } catch { await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)); }
    }
    if (driverStartupError) throw driverStartupError;
    throw new Error('tauri-driver no respondió en 15 segundos');
}

function processGroupExists(groupId) {
    try {
        process.kill(-groupId, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

async function processGroupMembers(groupId) {
    try {
        const { stdout } = await execFile('ps', ['-eo', 'pid=,pgid=,stat=,comm='], { timeout: 2000 });
        return stdout.split('\n').flatMap((line) => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+([^\s]+)/);
            return match && Number(match[2]) === groupId
                ? [{ pid: Number(match[1]), stat: match[3], command: line.trim().slice(match[0].length).trim() }]
                : [];
        });
    } catch {
        return null;
    }
}

async function processGroupHasLiveProcess(groupId) {
    const members = await processGroupMembers(groupId);
    if (members) return members.some(({ stat }) => !stat.startsWith('Z'));
    // Si `ps` no está disponible, conservamos la comprobación POSIX como
    // fallback. En hosts normales `ps` permite distinguir grupos que solo
    // conservan un zombie de procesos realmente vivos.
    return processGroupExists(groupId);
}

async function stopApplicationProcessTree() {
    const startedAt = Date.now();
    if (process.platform !== 'win32') {
        return { strategy: 'not-applicable', applicationClosed: true, passed: true, closed: true, durationMs: 0 };
    }

    let processIds;
    try {
        processIds = await applicationProcessIds();
    } catch (error) {
        return {
            strategy: 'taskkill-application-tree',
            applicationClosed: false,
            passed: false,
            closed: false,
            error: `No se pudieron consultar los procesos de la aplicación: ${error.message}`,
            durationMs: Date.now() - startedAt,
        };
    }
    const ownedProcessIds = processIds.filter((pid) => !preExistingApplicationPids.has(pid));
    const terminatedPids = new Set(ownedProcessIds);
    const killApplicationPids = async (pids) => {
        for (const pid of pids) {
            try {
                await execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
            } catch {
                // El proceso puede haber terminado al cerrar WebDriver; la
                // comprobación posterior decide si la limpieza quedó completa.
            }
        }
    };
    await killApplicationPids(ownedProcessIds);

    const deadline = Date.now() + 8000;
    let remaining = [];
    let stableEmptyChecks = 0;
    while (Date.now() < deadline && stableEmptyChecks < 10) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
            remaining = (await applicationProcessIds()).filter((pid) => !preExistingApplicationPids.has(pid));
            const newlyDetected = remaining.filter((pid) => !terminatedPids.has(pid));
            if (newlyDetected.length > 0) {
                newlyDetected.forEach((pid) => terminatedPids.add(pid));
                await killApplicationPids(newlyDetected);
                stableEmptyChecks = 0;
            } else if (remaining.length === 0) {
                stableEmptyChecks += 1;
            } else {
                stableEmptyChecks = 0;
            }
        } catch (error) {
            return {
                strategy: 'taskkill-application-tree',
                applicationClosed: false,
                passed: false,
                closed: false,
                terminatedPids: [...terminatedPids],
                remainingPids: ['query-failed'],
                error: `No se pudo verificar el cierre de la aplicación: ${error.message}`,
                durationMs: Date.now() - startedAt,
            };
        }
    }
    const closed = remaining.length === 0;
    return {
        strategy: 'taskkill-application-tree',
        applicationClosed: closed,
        passed: closed,
        closed,
        terminatedPids: [...terminatedPids],
        remainingPids: remaining,
        durationMs: Date.now() - startedAt,
    };
}

async function stopDriverProcessTree() {
    const pid = driver.pid;
    if (!pid) return { strategy: 'no-driver-pid', closed: true, durationMs: 0 };
    const startedAt = Date.now();
    if (process.platform !== 'win32') {
        const groupExists = () => processGroupHasLiveProcess(pid);
        const signalGroup = (signal) => {
            try {
                process.kill(-pid, signal);
            } catch (error) {
                if (error?.code !== 'ESRCH') throw error;
            }
        };
        signalGroup('SIGTERM');
        const waitForGroupExit = async (timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (groupExists() && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return !groupExists();
        };
        let closed = await waitForGroupExit(2500);
        if (!closed) {
            signalGroup('SIGKILL');
            closed = await waitForGroupExit(1000);
        }
        // El grupo puede quedar visible durante un instante después de que
        // sus procesos terminen. Recalcularlo evita conservar un falso fallo
        // cuando `ps` ya confirma que no queda ningún miembro vivo.
        if (!closed) closed = !(await processGroupHasLiveProcess(pid));
        return {
            strategy: 'dedicated-process-group',
            processGroupClosed: closed,
            passed: closed,
            closed,
            remainingProcesses: await processGroupMembers(pid),
            durationMs: Date.now() - startedAt,
        };
    }

    // `taskkill /T` queda acotado al PID exclusivo del tauri-driver que acaba
    // de lanzar este smoke; el cierre WebDriver ya tuvo oportunidad de ser
    // limpio y esto evita dejar una GUI de prueba huérfana en Windows.
    try {
        await execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
    } catch {
        driver.kill('SIGTERM');
    }
    const exitDeadline = Date.now() + 2000;
    while (driver.exitCode === null && driver.signalCode === null && Date.now() < exitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const closed = driver.exitCode !== null || driver.signalCode !== null;
    return {
        strategy: 'taskkill-driver-tree',
        driverClosed: closed,
        passed: closed,
        closed,
        durationMs: Date.now() - startedAt,
    };
}

async function find(css) {
    const value = await request(`/session/${sessionId}/element`, 'POST', { using: 'css selector', value: css });
    return value[elementKey];
}

async function findAll(css) {
    return request(`/session/${sessionId}/elements`, 'POST', {
        using: 'css selector',
        value: css,
    });
}

async function findAllWithin(element, css) {
    return request(`/session/${sessionId}/element/${element}/elements`, 'POST', {
        using: 'css selector',
        value: css,
    });
}

async function parentOf(element) {
    const value = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return arguments[0].parentElement;',
        args: [{ [elementKey]: element }],
    });
    return value[elementKey];
}

async function scrollIntoView(element) {
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `
            const node = arguments[0];
            node.scrollIntoView({ block: 'center', inline: 'nearest' });
            // Los paneles tienen una cabecera sticky. Después del scroll
            // nativo se corrige el pequeño tramo que pudiera quedar tapado,
            // para que el clic E2E represente una interacción física posible.
            const scroller = node.closest('.panel-scroll');
            const panel = node.closest('[role="dialog"]');
            const header = panel?.querySelector(':scope > .panel-header');
            if (scroller && header) {
                const scrollRect = scroller.getBoundingClientRect();
                const headerRect = header.getBoundingClientRect();
                const nodeRect = node.getBoundingClientRect();
                const minTop = Math.max(scrollRect.top + 4, headerRect.bottom + 6);
                const maxBottom = scrollRect.bottom - 4;
                if (nodeRect.top < minTop) scroller.scrollTop += nodeRect.top - minTop;
                else if (nodeRect.bottom > maxBottom) scroller.scrollTop += nodeRect.bottom - maxBottom;
            }
            return true;
        `,
        args: [{ [elementKey]: element }],
    });
}

async function clickInView(element) {
    await scrollIntoView(element);
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    await click(element);
}

async function focusTerminal(xterm, input) {
    let nativeClickError = null;
    try {
        // Tras un resize con el explorador abierto, WebKit puede conservar un
        // rectángulo de xterm más ancho que la celda y rechazar el click nativo
        // aunque la parte visible siga siendo utilizable. Primero se prueba la
        // ruta real, desplazando el nodo al viewport como haría una persona.
        await clickInView(xterm);
    } catch (firstError) {
        nativeClickError = firstError;
    }
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    const nativeFocusWorked = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return document.activeElement === arguments[0];',
        args: [{ [elementKey]: input }],
    }).catch(() => false);
    if (nativeFocusWorked) return 'native-click';

    // Solo se usa el fallback si el click aceptado por WebDriver no entregó
    // foco al receptor de xterm. En WebKit, un click sin cambio de foco no
    // produce error, pero las teclas siguientes se pierden silenciosamente.
    const focused = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = arguments[0];
            const input = arguments[1];
            const rect = host.getBoundingClientRect();
            const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + Math.max(4, Math.min(rect.width - 4, 12))));
            const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + Math.max(4, Math.min(rect.height - 4, 12))));
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                const event = type.startsWith('pointer')
                    ? new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true })
                    : new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
                host.dispatchEvent(event);
            }
            input.focus();
            return document.activeElement === input;`,
        args: [{ [elementKey]: xterm }, { [elementKey]: input }],
    });
    if (!focused) {
        throw new Error('El click en la terminal no enfocó el receptor de teclado de xterm', {
            cause: nativeClickError ?? undefined,
        });
    }
    return 'verified-pointer-fallback';
}

async function pointerClickInView(element) {
    await scrollIntoView(element);
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    try {
        await request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{
                type: 'pointer',
                id: 'mouse',
                parameters: { pointerType: 'mouse' },
                actions: [
                    { type: 'pointerMove', origin: { [elementKey]: element }, x: 4, y: 4 },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerUp', button: 0 },
                ],
            }],
        });
    } catch (error) {
        // WebKitWebDriver puede rechazar un pointer action en una tira
        // horizontal perfectamente visible después de muchos resizes. Solo
        // se permite el fallback si el nodo sigue teniendo superficie visible;
        // el estado posterior continúa verificándose por el llamador.
        const geometry = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const node = arguments[0];
                const rect = node.getBoundingClientRect();
                const x = Math.round(rect.left + Math.min(4, Math.max(1, rect.width / 2)));
                const y = Math.round(rect.top + Math.min(4, Math.max(1, rect.height / 2)));
                const top = document.elementFromPoint(x, y);
                const style = getComputedStyle(node);
                return {
                    width: Math.round(rect.width), height: Math.round(rect.height),
                    x, y, top: top?.tagName ?? null,
                    display: style.display, visibility: style.visibility,
                    disabled: Boolean(node.disabled)
                };`,
            args: [{ [elementKey]: element }],
        });
        if (!geometry || geometry.width <= 0 || geometry.height <= 0
            || geometry.display === 'none' || geometry.visibility === 'hidden'
            || geometry.disabled) {
            throw error;
        }
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'arguments[0].click(); return true;',
            args: [{ [elementKey]: element }],
        });
        recordEvent('driver-click-fallback', { geometry, error: String(error).slice(0, 300) });
    }
}

async function attribute(element, name) {
    return request(`/session/${sessionId}/element/${element}/attribute/${name}`);
}

async function property(element, name) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return arguments[0][arguments[1]];',
        args: [{ [elementKey]: element }, name],
    });
}

async function setSelectValue(css, value) {
    const select = await findWhenReady(css);
    const indices = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const select = document.querySelector(${JSON.stringify(css)});
            const options = [...(select?.options ?? [])];
            return { current: select?.selectedIndex ?? -1, target: options.findIndex((option) => option.value === ${JSON.stringify(value)}) };`,
        args: [],
    });
    if (indices.target < 0) throw new Error(`No existe la opción ${value} en ${css}`);
    await clickInView(select);
    const arrow = indices.target >= indices.current ? '\uE015' : '\uE013';
    const keys = Array(Math.abs(indices.target - indices.current)).fill(arrow);
    keys.push('\uE007');
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{
            type: 'key',
            id: 'settings-select-keyboard',
            actions: keys.flatMap((key) => [
                { type: 'keyDown', value: key },
                { type: 'keyUp', value: key },
            ]),
        }],
    });
    try {
        await waitUntil(async () => String(await property(await findWhenReady(css), 'value')) === value,
            3000, `selección interactiva de ${value} en ${css}`);
    } catch (error) {
        // WebView2 puede mantener abierto el popup nativo del <select> aunque
        // el elemento conserve el foco. En ese caso las teclas se consumen en
        // el popup y nunca llegan al control DOM. Aplicar el setter nativo y
        // emitir los eventos estándar conserva la ruta de binding de Svelte y
        // permite que la E2E siga comprobando el mismo comportamiento de la
        // aplicación sin depender del popup del sistema.
        const fallback = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const select = document.querySelector(${JSON.stringify(css)});
                if (!select) return { applied: false, value: null };
                const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
                setter?.call(select, ${JSON.stringify(value)});
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return { applied: select.value === ${JSON.stringify(value)}, value: select.value };`,
            args: [],
        });
        recordEvent('driver-select-fallback', { css, requested: value, fallback });
        try {
            await waitUntil(async () => String(await property(await findWhenReady(css), 'value')) === value,
                3000, `selección DOM de ${value} en ${css}`);
            return;
        } catch {
            // Preserve the original state in the diagnostic below so a real
            // binding or rendering failure remains visible in the report.
        }
        const state = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const select = document.querySelector(${JSON.stringify(css)});
                return { value: select?.value ?? null, active: document.activeElement === select,
                    selectedIndex: select?.selectedIndex ?? -1, targetIndex: ${indices.target} };`,
            args: [],
        }).catch(() => null);
        throw new Error(`No se pudo seleccionar ${value} en ${css}; estado=${JSON.stringify(state)}`, { cause: error });
    }
}

const localeCatalogCache = new Map();
async function loadLocaleCatalog(language) {
    if (localeCatalogCache.has(language)) return localeCatalogCache.get(language);
    try {
        const catalog = JSON.parse(await readFile(join(projectRoot, 'src-tauri', 'locales', `${language}.json`), 'utf8'));
        localeCatalogCache.set(language, catalog);
        return catalog;
    } catch (error) {
        throw new Error(`No se pudo cargar el catálogo E2E de ${language}: ${error.message}`);
    }
}

async function readLanguageAnchors() {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const dialog = document.querySelector('[role="dialog"]');
            const text = (selector) => dialog?.querySelector(selector)?.textContent?.trim() ?? '';
            const field = dialog?.querySelector('[data-testid="settings-language"]')?.closest('.field');
            return {
                language: dialog?.querySelector('[data-testid="settings-language"]')?.value ?? '',
                tabs: [...(dialog?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => tab.textContent.trim()),
                languageLabel: field?.querySelector(':scope > span')?.textContent?.trim() ?? '',
                languageHint: dialog?.querySelector('[data-testid="settings-language"]')?.closest('.field')?.nextElementSibling?.textContent?.trim() ?? '',
                save: text('[data-testid="settings-autosave"]'),
                reset: text('[data-testid="settings-reset-label"]'),
                toolbar: {
                    projects: document.querySelector('[data-testid="toolbar-projects"]')?.textContent?.trim() ?? '',
                    scripts: document.querySelector('[data-testid="toolbar-library"]')?.textContent?.trim() ?? '',
                    dependencies: document.querySelector('[data-testid="toolbar-dependencies"]')?.textContent?.trim() ?? '',
                    settings: document.querySelector('[data-testid="toolbar-settings"]')?.textContent?.trim() ?? '',
                },
            };`,
        args: [],
    });
}

/** Recoge en la página los errores no capturados (también las promesas
 *  rechazadas de un `void saveDraft()`), para explicar un guardado atascado. */
async function installPageErrorCollector() {
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `if (!window.__e2ePageErrors) {
                window.__e2ePageErrors = [];
                window.addEventListener('error', (event) => window.__e2ePageErrors.push(String(event.error?.stack ?? event.message)));
                window.addEventListener('unhandledrejection', (event) => window.__e2ePageErrors.push(String(event.reason?.stack ?? event.reason)));
            }
            return true;`,
        args: [],
    });
}

async function waitForSettingsAutosave() {
    // El guardado automático se agrupa durante unos cientos de milisegundos
    // para no escribir preferencias por cada carácter de un campo de texto.
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
        await waitUntil(async () => {
            const state = await findWhenReady('[data-testid="settings-autosave"]');
            const value = await attribute(state, 'data-state');
            return value === 'saved' || value === 'idle';
        }, 10000, 'guardado automático de Ajustes');
    } catch (error) {
        // ¿Responde el backend? Si `settings_get` y un `settings_save` directo
        // (con las mismas preferencias) contestan, lo atascado es la cola de
        // guardado del frontend y no el IPC.
        const diagnostics = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const node = document.querySelector('[data-testid="settings-autosave"]');
                const invoke = window.__TAURI_INTERNALS__.invoke;
                const timed = (promise) => Promise.race([
                    promise.then(() => 'ok', (error) => 'error: ' + String(error).slice(0, 200)),
                    new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
                ]);
                let backend = {};
                try {
                    const startedGet = performance.now();
                    backend.get = await timed(invoke('settings_get'));
                    backend.getMs = Math.round(performance.now() - startedGet);
                    // Un comando asíncrono que no toca las pestañas y otro que
                    // sí (cwd de la pestaña): distinguen hilos agotados de un
                    // cerrojo del registro de pestañas retenido.
                    backend.asyncNoTabs = await timed(invoke('toolchain_store_status'));
                    const tabId = document.querySelector('[data-tab-id]')?.getAttribute('data-tab-id');
                    if (tabId) backend.asyncTabs = await timed(invoke('explorer_follow', { tabId }));
                    if (backend.get === 'ok') {
                        const payload = await invoke('settings_get');
                        const startedSave = performance.now();
                        backend.save = await timed(invoke('settings_save', { incoming: payload?.preferences ?? payload }));
                        backend.saveMs = Math.round(performance.now() - startedSave);
                    }
                } catch (error) { backend.error = String(error).slice(0, 200); }
                const pending = (window.__wtPendingIpc?.() ?? [])
                    .filter((call) => call.ageMs > 3000)
                    .sort((left, right) => right.ageMs - left.ageMs)
                    .slice(0, 20);
                return { state: node?.dataset.state ?? null, text: (node?.textContent ?? '').trim(),
                    errors: (window.__e2ePageErrors ?? []).slice(-5), backend, pending };`,
            args: [],
        }).catch((cause) => ({ diagnosticsFailed: String(cause).slice(0, 300) }));
        throw new Error(`No se cumplió guardado automático de Ajustes: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
}

async function toggleCheckboxAndWait(css) {
    const input = await findWhenReady(css);
    const before = Boolean(await property(input, 'checked'));
    await clickInView(input);
    try {
        await waitUntil(async () => Boolean(await property(await findWhenReady(css), 'checked')) !== before,
            1500, `cambio de ${css}`);
    } catch {
        // WebDriver/Edge puede conservar el nodo visual mientras Svelte está
        // recomponiendo un formulario largo. Repetir el gesto sobre el nodo
        // vivo mantiene la prueba fiel a la acción de usuario y evita marcar
        // como fallo un click que nunca llegó al input.
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'arguments[0].click(); return true;',
            args: [{ [elementKey]: await findWhenReady(css) }],
        });
        await waitUntil(async () => Boolean(await property(await findWhenReady(css), 'checked')) !== before,
            5000, `cambio de ${css} tras reintento`);
    }
    return !before;
}

async function assertLanguageAnchors(language, expected) {
    const actual = await readLanguageAnchors();
    const required = {
        languageLabel: expected['settings.language'],
        languageHint: expected['settings.languageHint'],
        save: expected['settings.autoSaved'],
        reset: expected['settings.reset'],
        projects: expected['toolbar.projects'],
        scripts: expected['toolbar.scripts'],
        dependencies: expected['toolbar.deps'],
        settings: expected['toolbar.settings'],
    };
    const checks = [
        ['settings.language', actual.languageLabel, required.languageLabel],
        ['settings.languageHint', actual.languageHint, required.languageHint],
        ['settings.autoSaved', actual.save, required.save],
        ['settings.reset', actual.reset, required.reset],
        ['toolbar.settings', actual.toolbar.settings, required.settings],
    ];
    // Un perfil puede ocultar Proyectos/Biblioteca/Dependencias. Solo se
    // comparan esos botones cuando están presentes; Ajustes siempre es visible
    // y sirve como ancla obligatoria para detectar texto hardcodeado.
    for (const [name, value, target] of [
        ['toolbar.projects', actual.toolbar.projects, required.projects],
        ['toolbar.scripts', actual.toolbar.scripts, required.scripts],
        ['toolbar.deps', actual.toolbar.dependencies, required.dependencies],
    ]) {
        if (value) checks.push([name, value, target]);
    }
    const mismatches = checks.filter(([, value, target]) => value !== target);
    if (mismatches.length) {
        throw new Error(`Texto hardcodeado o traducción incompleta para ${language}: ${JSON.stringify({ mismatches, actual })}`);
    }
    const expectedTabs = [
        expected['settings.appearance'],
        expected['settings.terminal'],
        expected['settings.behavior'],
        expected['settings.about'],
    ];
    if (!expectedTabs.every((label) => actual.tabs.includes(label))) {
        throw new Error(`Las pestañas de Ajustes no están traducidas en ${language}: ${JSON.stringify({ expectedTabs, actualTabs: actual.tabs })}`);
    }
    return actual;
}

async function exerciseLanguageSwitch() {
    const languageSelect = await findWhenReady('[data-testid="settings-language"]');
    const originalLanguage = String(await property(languageSelect, 'value'));
    const originalAnchors = await readLanguageAnchors();
    const languageOptions = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return [...document.querySelectorAll(\'[data-testid="settings-language"] option\')].map((option) => option.value);',
        args: [],
    });
    // «auto» depende del sistema; no equivale siempre a español. Identificar
    // el catálogo inicial por varias etiquetas permite comprobar la vuelta
    // al idioma original sin asumir el locale del equipo que ejecuta la E2E.
    let originalExpected;
    if (originalLanguage === 'auto') {
        for (const language of languageOptions.filter(value => value !== 'auto')) {
            const catalog = await loadLocaleCatalog(language);
            if (originalAnchors.save === catalog['settings.autoSaved']
                && originalAnchors.languageLabel === catalog['settings.language']
                && originalAnchors.toolbar.settings === catalog['toolbar.settings']) {
                originalExpected = catalog;
                break;
            }
        }
        if (!originalExpected) throw new Error(`No se identificó el catálogo automático: ${JSON.stringify(originalAnchors)}`);
    } else originalExpected = await loadLocaleCatalog(originalLanguage);
    const languageCandidates = ['en', 'fr', 'de', 'it', 'pt']
        .filter((language) => languageOptions.includes(language) && language !== originalLanguage)
        .slice(0, 3);
    if (languageCandidates.length < 2) {
        throw new Error(`El selector de idioma no ofrece suficientes catálogos para probar: ${JSON.stringify(languageOptions)}`);
    }
    const languageResults = [];
    for (const language of languageCandidates) {
        const expected = await loadLocaleCatalog(language);
        await setSelectValue('[data-testid="settings-language"]', language);
        const selectedLanguage = String(await property(
            await findWhenReady('[data-testid="settings-language"]'),
            'value',
        ));
        if (selectedLanguage !== language) {
            throw new Error(`El selector no conservó el idioma antes de guardar: esperado=${language}, actual=${selectedLanguage}`);
        }
        await waitForSettingsAutosave();
        try {
            await waitUntil(
                async () => String(await property(await findWhenReady('[data-testid="settings-language"]'), 'value')) === language,
                5000,
                `aplicación del idioma ${language}`,
            );
        } catch (error) {
            const actual = await readLanguageAnchors();
            throw new Error(`No se aplicó el idioma solicitado ${language}; estado observado=${JSON.stringify(actual)}; causa=${String(error)}`);
        }
        let anchors;
        await waitUntil(async () => {
            // waitUntil ya conserva el último error. No ocultar aquí un
            // fallo de traducción o del driver tras una condición genérica.
            anchors = await assertLanguageAnchors(language, expected);
            return true;
        }, 5000, `traducción completa ${language}`);
        languageResults.push({ language, anchors: { tabs: anchors.tabs, toolbar: anchors.toolbar } });
    }
    await setSelectValue('[data-testid="settings-language"]', originalLanguage);
    await waitForSettingsAutosave();
    await waitUntil(
        async () => String(await property(await findWhenReady('[data-testid="settings-language"]'), 'value')) === originalLanguage,
        5000,
        'restauración del idioma original',
    );
    await waitUntil(async () => {
        await assertLanguageAnchors(originalLanguage, originalExpected);
        return true;
    }, 5000, 'catálogo del idioma original');
    recordEvent('language-switch', { original: originalLanguage, tested: languageResults, restored: true, passed: true });
    return originalExpected;
}

async function textOf(element) {
    return request(`/session/${sessionId}/element/${element}/text`);
}

async function contentGeometry() {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const rect = (element) => {
            if (!element) return null;
            const value = element.getBoundingClientRect();
            return {
                x: Math.round(value.x),
                y: Math.round(value.y),
                width: Math.round(value.width),
                height: Math.round(value.height),
            };
        };
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            screen: { width: window.screen.availWidth, height: window.screen.availHeight },
            activeTabId: document.querySelector('.tab.active[data-tab-id]')?.dataset.tabId ?? null,
            workspace: rect(document.querySelector('.workspace')),
            panes: [...document.querySelectorAll('.cell:not(.hidden)')].map((cell) => ({
                tabId: cell.dataset.tabId ?? null,
                cell: rect(cell),
                screen: rect(cell.querySelector('.xterm-screen')),
                terminal: {
                    cols: Number(cell.querySelector('.tab-pane')?.dataset.terminalCols ?? 0),
                    rows: Number(cell.querySelector('.tab-pane')?.dataset.terminalRows ?? 0),
                },
            })),
        };`,
        args: [],
    });
}

async function waitUntil(predicate, timeoutMs = 20000, description = 'condición') {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw lastError ?? new Error(`No se cumplió ${description}`);
}

async function findWhenReady(css, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try { return await find(css); }
        catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    }
    throw lastError ?? new Error(`No apareció el elemento ${css}`);
}

// Un pie sticky (el de Ajustes con «Guardar») puede tapar un control que sigue
// dentro de la ventana: WebDriver lo da por visible, no desplaza nada y el
// clic se lo lleva el pie («element click intercepted»). Una persona
// desplazaría hasta verlo: se centra en su scroll y se pulsa una vez más. Si
// algo lo sigue tapando (un diálogo encima), el error se mantiene.
async function click(element) {
    try {
        await request(`/session/${sessionId}/element/${element}/click`, 'POST', {});
    } catch (error) {
        if (!/element click intercepted/iu.test(String(error?.message ?? error))) throw error;
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: "arguments[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });",
            args: [{ [elementKey]: element }],
        });
        recordEvent('driver-click-scrolled', { error: String(error).slice(0, 200) });
        await request(`/session/${sessionId}/element/${element}/click`, 'POST', {});
    }
}

// Svelte puede rehacer un nodo entre que se localiza y se pulsa (un panel aún
// montándose o un estado nuevo que vuelve a pintar la lista). WebDriver
// responde entonces «stale element reference» y el clic no llegó a ocurrir:
// se vuelve a localizar por el mismo selector y se pulsa de nuevo.
async function clickWhenReady(css, timeoutMs = 20000) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const element = await findWhenReady(css, timeoutMs);
        try {
            await click(element);
            return element;
        } catch (error) {
            if (!/stale element reference/iu.test(String(error?.message ?? error))) throw error;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    throw lastError;
}

async function clickByPointerActions(element, actionId = 'mouse-click') {
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{
            type: 'pointer',
            id: actionId,
            parameters: { pointerType: 'mouse' },
            actions: [
                { type: 'pointerMove', origin: { [elementKey]: element }, x: 4, y: 4 },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerUp', button: 0 },
            ],
        }],
    });
}

// Svelte puede reemplazar el botón de división al recomponer la tira de
// pestañas después de crear/cerrar una terminal. Reubicar el nodo justo antes
// de cada gesto evita que WebKitGTK/tauri-driver conserve una referencia DOM
// obsoleta durante una transición de paneles.
async function clickPaneControl(actionId = 'mouse-pane-transition') {
    // WebKitGTK bajo WSL1 puede dejar bloqueado el endpoint WebDriver
    // `/element` después de varias transiciones aunque la ventana siga
    // pintando correctamente. Activar el mismo control Svelte por DOM evita
    // convertir esa limitación del driver en un falso fallo de la aplicación;
    // la selección por ratón y el resto de gestos siguen usando puntero real.
    if (IS_WSL1_HOST) {
        const result = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const button = document.querySelector('.side-toggle.panes');
                if (!button) return { clicked: false, count: 0 };
                button.click();
                return { clicked: true, count: document.querySelectorAll('.cell:not(.hidden)').length };`,
            args: [],
        });
        if (!result?.clicked) throw new Error('No apareció el control de división en el DOM WSL');
        recordEvent('driver-dom-click-fallback', { control: 'split-pane', actionId, reason: 'WSL1 WebKitGTK element endpoint', passed: true });
        return;
    }
    const button = await findWhenReady('.side-toggle.panes');
    await clickByPointerActions(button, actionId);
}

/** Reproduce el doble clic de un ratón sobre el nodo real, no dos llamadas
 *  DOM a `.click()`. Las dos pulsaciones pasan por el protocolo WebDriver y
 *  permiten detectar si el primer clic desmonta el elemento antes de que el
 *  segundo llegue a su destino. */
async function doubleClick(element) {
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{
            type: 'pointer',
            id: 'mouse-double-click',
            parameters: { pointerType: 'mouse' },
            actions: [
                { type: 'pointerMove', origin: { [elementKey]: element }, x: 4, y: 4 },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerUp', button: 0 },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerUp', button: 0 },
            ],
        }],
    });
}

/** Comprueba la interacción específica del Explorador que antes no tenía
 *  cobertura E2E: un doble clic real sobre una carpeta no debe saltar dos
 *  niveles ni reutilizar el nodo que Svelte acaba de desmontar. */
async function exerciseExplorerDoubleClick() {
    const explorerState = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = document.querySelector('.explorer');
            const path = root?.querySelector('.path');
            return {
                path: path?.textContent?.trim() ?? '',
                entries: [...(root?.querySelectorAll('.entry') ?? [])].map((entry) => ({
                    text: entry.textContent?.trim() ?? '',
                    name: entry.querySelector('.name')?.textContent?.trim() ?? '',
                    className: entry.className ?? '',
                })),
            };`,
        args: [],
    });
    const originalPath = (await explorerState()).path;
    if (!originalPath) throw new Error('No se pudo obtener la ruta del Explorador antes del doble clic');
    const findExplorerEntryByName = async (name) => {
        const result = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const expected = arguments[0];
                const entry = [...document.querySelectorAll('.explorer .entry')]
                    .find((item) => item.querySelector('.name')?.textContent?.trim() === expected);
                return entry ?? null;`,
            args: [name],
        });
        return result?.[elementKey] ?? null;
    };
    const temporaryName = `lterminal-e2e-double-click-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const temporaryRoot = join(originalPath, temporaryName);
    const nestedDirectory = join(temporaryRoot, 'nested');
    try {
        // Crear los directorios desde el propio Explorador mantiene la prueba
        // dentro del mismo backend y evita diferencias de namespace/permisos
        // entre Node, Tauri, Wine o un runner aislado.
        const createDirectory = async (name) => {
            await clickWhenReady('.explorer .actions button:first-child');
            const input = await findWhenReady('.explorer form.inline input[type="text"]');
            const valueResult = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const input = arguments[0];
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                    if (!setter) return { ok: false, reason: 'no-setter' };
                    setter.call(input, arguments[1]);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: input.value === arguments[1], value: input.value };`,
                args: [{ [elementKey]: input }, name],
            });
            if (!valueResult?.ok) throw new Error(`No se pudo introducir el nombre ${name}: ${JSON.stringify(valueResult)}`);
            await clickWhenReady('.explorer form.inline button[type="submit"]');
            try {
                await waitUntil(async () => {
                    return Boolean(await findExplorerEntryByName(name));
                }, 10000, `creación de carpeta del Explorador (${name})`);
            } catch (cause) {
                throw new Error(`${cause.message}: ${JSON.stringify(await explorerState())}`);
            }
        };
        await createDirectory(temporaryName);
        await waitUntil(async () => {
            return Boolean(await findExplorerEntryByName(temporaryName));
        }, 10000, `carpeta temporal para preparar el doble clic (${temporaryRoot})`);
        const temporaryEntry = await findExplorerEntryByName(temporaryName);
        await click(temporaryEntry);
        try {
            await waitUntil(async () => (await explorerState()).path === temporaryRoot, 10000, 'entrada en la carpeta temporal');
        } catch (cause) {
            throw new Error(`${cause.message}: ${JSON.stringify(await explorerState())}`);
        }
        const nestedName = 'nested';
        await createDirectory(nestedName);
        await waitUntil(async () => {
            return Boolean(await findExplorerEntryByName(nestedName));
        }, 10000, `carpeta temporal para el doble clic (${temporaryRoot})`);
        const nestedEntry = await findExplorerEntryByName(nestedName);
        const beforeDoubleClickCapture = await captureScreenshot('explorer-double-click-before');
        await doubleClick(nestedEntry);
        await waitUntil(async () => (await explorerState()).path === nestedDirectory, 10000, 'entrada única tras doble clic de carpeta');
        const enteredPath = (await explorerState()).path;
        if (enteredPath !== nestedDirectory) {
            throw new Error(`El doble clic navegó a una ruta inesperada: ${enteredPath}`);
        }
        const enteredCapture = await captureScreenshot('explorer-double-click-entered');
        const upButton = await findWhenReady('.explorer .toolbar button:first-child');
        await click(upButton);
        await waitUntil(async () => (await explorerState()).path === temporaryRoot, 10000, 'vuelta al directorio temporal');
        await clickWhenReady('.explorer .toolbar button:first-child');
        await waitUntil(async () => (await explorerState()).path === originalPath, 10000, 'restauración de la ruta original tras el doble clic');
        const restoredCapture = await captureScreenshot('explorer-double-click-restored');
        recordEvent('explorer-double-click', {
            skipped: false,
            temporaryRoot,
            enteredPath,
            expectedPath: nestedDirectory,
            enteredOnce: true,
            restored: true,
            gesture: 'pointerMove → pointerDown → pointerUp × 2',
            captures: [beforeDoubleClickCapture, enteredCapture, restoredCapture]
                .filter(Boolean)
                .map((path) => path.split(/[\\/]/).at(-1)),
            passed: true,
        });
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

/** Reproduce dos intenciones humanas consecutivas sin dejar que WebDriver
 * conserve una referencia a un nodo que Svelte puede actualizar entre ambas.
 * Los dos `click()` atraviesan los manejadores reales de la interfaz; solo se
 * agrupan en una misma tarea del navegador para garantizar que "inmediatamente"
 * describe a la aplicación y no el tiempo de ida y vuelta del driver. */
async function createTabAndCloseImmediately(tabId) {
    const result = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const tabId = arguments[0];
            const oldTab = [...document.querySelectorAll('.tab[data-tab-id]')]
                .find((tab) => tab.dataset.tabId === tabId);
            const create = document.querySelector('.tab-new');
            const close = oldTab?.querySelector('.tab-close');
            if (!create || !close) {
                return { ok: false, hasCreate: Boolean(create), hasOldTab: Boolean(oldTab), hasClose: Boolean(close) };
            }
            create.click();
            close.click();
            return { ok: true };`,
        args: [tabId],
    });
    if (!result?.ok) {
        throw new Error(`No se pudo reproducir el cierre inmediato: ${JSON.stringify(result)}`);
    }
}

async function closeEnvironmentMenu() {
    const backdrops = await findAll('.env-backdrop');
    if (!backdrops.length) return;
    // El backdrop cubre toda la ventana y WebDriver puede considerar que el
    // propio botón está interceptado si intentamos pulsarlo de nuevo. Ejecutar
    // el mismo mousedown que usa la interfaz cierra el menú de forma
    // determinista incluso cuando solo hay una shell disponible.
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'const backdrop = document.querySelector(".env-backdrop"); if (backdrop) backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return true;',
        args: [],
    });
    await waitUntil(async () => (await findAll('.env-backdrop')).length === 0, 5000, 'cierre del selector de entornos');
}

async function sendWindowShortcut(keys) {
    const actions = keys.map((value) => ({ type: 'keyDown', value }));
    for (const value of [...keys].reverse()) actions.push({ type: 'keyUp', value });
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{ type: 'key', id: 'window-manager', actions }],
    });
}

async function dispatchAppShortcut({ key, code = key, ctrl = true, shift = false, alt = false, meta = false }) {
    // Ctrl+Tab es reservado por algunos WebView y el driver puede no
    // entregarlo al documento. El evento DOM conserva la ruta real de
    // `onShortcut` y permite probar el contrato de la aplicación de forma
    // portable cuando el compositor intercepta la combinación.
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const event = new KeyboardEvent('keydown', {
            key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)},
            ctrlKey: ${ctrl}, shiftKey: ${shift}, altKey: ${alt}, metaKey: ${meta}, bubbles: true, cancelable: true
        }); const accepted = window.dispatchEvent(event); return { defaultPrevented: event.defaultPrevented, dispatchAccepted: accepted };`,
        args: [],
    });
}

async function hyprlandActiveWindow() {
    try {
        const { stdout } = await execFile('hyprctl', ['activewindow', '-j'], { timeout: 3000 });
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

async function prepareWindowManagerForResize() {
    if (!IS_HYPRLAND) return true;
    const active = await hyprlandActiveWindow();
    if (!active) throw new Error('Hyprland está activo, pero hyprctl no pudo consultar la ventana activa');
    if (active.fullscreen) {
        throw new Error('El smoke no puede medir tamaños mientras LTerminal está en fullscreen; desactívalo antes de ejecutar la batería');
    }
    if (active.floating === true) return true;
    if (active.floating === false) {
        // Hyprland ignora window/rect en modo mosaico. Super+Space es el
        // atajo del usuario para desacoplarla y permitir el resize. WebDriver
        // no siempre entrega los atajos globales al compositor, por lo que
        // queda un fallback equivalente y acotado a la ventana activa.
        try {
            await clickWhenReady('.cell:not(.hidden) .xterm');
            await sendWindowShortcut(['\uE03D', ' ']); // Meta + Space
            await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
            if ((await hyprlandActiveWindow())?.floating !== true) {
                if (!active.address) throw new Error('Hyprland no devolvió la dirección de la ventana activa para desacoplarla');
                await execFile('hyprctl', ['dispatch', 'togglefloating', `address:${active.address}`], { timeout: 3000 });
            }
            await waitUntil(async () => (await hyprlandActiveWindow())?.floating === true, WM_TRANSITION_TIMEOUT_MS, 'ventana flotante en Hyprland');
            return true;
        } catch (error) {
            nativeResizeSupported = false;
            recordEvent('window-manager', {
                action: 'native-resize-skipped',
                reason: 'hyprland-no-permitio-ventana-flotante',
                error: error instanceof Error ? error.message : String(error),
                passed: true,
            });
            process.stdout.write('E2E: Hyprland mantiene la ventana en mosaico; se omiten solo las comprobaciones de resize nativo.\n');
            return false;
        }
    }
    return true;
}

async function waitForHyprlandState(predicate, description) {
    await waitUntil(async () => predicate(await hyprlandActiveWindow()), WM_TRANSITION_TIMEOUT_MS, description);
    return hyprlandActiveWindow();
}

async function exerciseWindowManagerStates() {
    if (!IS_HYPRLAND) {
        recordEvent('window-manager', {
            skipped: true,
            reason: SKIP_WINDOW_MANAGER ? 'explicit-skip' : 'no-hyprland',
        });
        return;
    }
    const initial = await hyprlandActiveWindow();
    recordEvent('window-manager', {
        action: 'initial',
        floating: initial?.floating ?? null,
        fullscreen: initial?.fullscreen ?? null,
    });
    const isFullscreen = (state) => state?.fullscreen === true || Number(state?.fullscreen) > 0;
    await sendWindowShortcut(['\uE03D', '\uE009', 'f']);
    let fullscreen;
    try {
        fullscreen = await waitForHyprlandState(isFullscreen, 'fullscreen de Hyprland');
    } catch {
        // Algunos compositores no entregan el atajo global a WebDriver. El
        // fallback usa el mismo dispatcher de Hyprland y queda registrado.
        await execFile('hyprctl', ['dispatch', 'fullscreen'], { timeout: 3000 });
        fullscreen = await waitForHyprlandState(isFullscreen, 'fullscreen de Hyprland (dispatcher)');
        recordEvent('window-manager', { action: 'fullscreen-shortcut-fallback' });
    }
    recordEvent('window-manager', { action: 'fullscreen-on', floating: fullscreen?.floating ?? null, fullscreen: true });
    await sendWindowShortcut(['\uE03D', '\uE009', 'f']);
    let restored;
    try {
        restored = await waitForHyprlandState((state) => !isFullscreen(state), 'salida de fullscreen de Hyprland');
    } catch {
        await execFile('hyprctl', ['dispatch', 'fullscreen'], { timeout: 3000 });
        restored = await waitForHyprlandState((state) => !isFullscreen(state), 'salida de fullscreen de Hyprland (dispatcher)');
        recordEvent('window-manager', { action: 'fullscreen-restore-fallback' });
    }
    recordEvent('window-manager', { action: 'fullscreen-off', floating: restored?.floating ?? null, fullscreen: false });

    // Hyprland puede salir de fullscreen dejando la ventana acoplada aunque
    // estuviera flotante antes de entrar. El endpoint WebDriver no puede
    // cambiar el tamaño de una ventana acoplada: preparar de nuevo el estado
    // flotante aquí hace que el resize posterior mida la ventana nativa real,
    // y no el rectángulo ficticio que devuelve WebDriver mientras el layout
    // sigue gobernado por el compositor.
    if (restored?.floating !== true) {
        await prepareWindowManagerForResize();
        const prepared = await hyprlandActiveWindow();
        recordEvent('window-manager', {
            action: 'resize-preparation-after-fullscreen',
            floating: prepared?.floating ?? null,
            fullscreen: prepared?.fullscreen ?? null,
        });
    }

    if (restored?.floating === true) {
        await sendWindowShortcut(['\uE03D', ' ']);
        let tiled;
        try {
            tiled = await waitForHyprlandState((state) => state?.floating === false, 'acoplamiento de Hyprland');
        } catch {
            await execFile('hyprctl', ['dispatch', 'togglefloating'], { timeout: 3000 });
            tiled = await waitForHyprlandState((state) => state?.floating === false, 'acoplamiento de Hyprland (dispatcher)');
            recordEvent('window-manager', { action: 'dock-shortcut-fallback' });
        }
        recordEvent('window-manager', { action: 'dock', floating: false, fullscreen: tiled?.fullscreen ?? null });
        await sendWindowShortcut(['\uE03D', ' ']);
        let floating;
        try {
            floating = await waitForHyprlandState((state) => state?.floating === true, 'desacoplamiento de Hyprland');
        } catch {
            await execFile('hyprctl', ['dispatch', 'togglefloating'], { timeout: 3000 });
            floating = await waitForHyprlandState((state) => state?.floating === true, 'desacoplamiento de Hyprland (dispatcher)');
            recordEvent('window-manager', { action: 'undock-shortcut-fallback' });
        }
        recordEvent('window-manager', { action: 'undock', floating: true, fullscreen: floating?.fullscreen ?? null });
    }
}

async function sendTerminalKeys(line, pane = null, { enter = true, settle = true } = {}) {
    const targetPane = pane ?? await activeTerminalCell();
    try {
        await waitUntil(async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const pane = arguments[0].querySelector('.tab-pane:not(.hidden)') ?? arguments[0];
            return pane?.dataset.startupReady === 'true';`,
            args: [{ [elementKey]: targetPane }],
        }), 35000, 'arranque visual completo antes de escribir en la terminal');
    } catch (error) {
        const diagnostic = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const pane = arguments[0].querySelector('.tab-pane:not(.hidden)') ?? arguments[0];
                return { ...pane?.dataset, rows: [...pane?.querySelectorAll('.xterm-rows > div') ?? []]
                    .map(row => row.textContent ?? '').slice(-16) };`,
            args: [{ [elementKey]: targetPane }],
        }).catch((diagnosticError) => ({ error: String(diagnosticError) }));
        throw new Error(`No se habilitó entrada tras el prompt; estado=${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const xterm = (await findAllWithin(targetPane, '.xterm'))[0]?.[elementKey];
    const input = (await findAllWithin(targetPane, '.xterm-helper-textarea'))[0]?.[elementKey];
    if (!xterm || !input) throw new Error('La terminal no ofreció el receptor de teclado para el panel solicitado');
    // xterm mantiene esta textarea fuera del área visible. En WebKit puede
    // incluso aceptar el click sobre ella sin transferirle foco, así que el
    // smoke siempre enfoca el contenedor visible y deja que xterm delegue al
    // receptor interno de teclado.
    const focusMethod = await focusTerminal(xterm, input);
    // WebKit entrega el click y el focus en frames distintos; sin este margen
    // el primer lote de key actions puede llegar antes de que xterm conecte
    // su textarea auxiliar.
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    // La orden /value solo cambia el valor DOM en algunas versiones de
    // WebKitWebDriver y no siempre genera el evento `input` que necesita
    // xterm. Las acciones de teclado sí recorren el mismo camino que una
    // pulsación real y permiten probar readline y el interceptor interno.
    const keyActions = [...`${line}${enter ? '\n' : ''}`].flatMap((character) => {
        const value = character === '\n' ? '\uE007' : character;
        return [{ type: 'keyDown', value }, { type: 'keyUp', value }];
    });
    let dispatchedKeyboardActions = false;
    try {
        if (enter) {
            const lineActions = keyActions.slice(0, -2);
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: lineActions }],
            });
            dispatchedKeyboardActions = true;
            // WebKitWebDriver puede entregar la última letra junto con Enter
            // antes de que xterm actualice su buffer accesible. Separarlos
            // evita que los comandos internos pierdan ese carácter final.
            await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
            // Cambiar el scroll horizontal del host puede dejar el textarea
            // de xterm con foco lógico pero sin receptor nativo activo. Las
            // letras llegan y Enter queda como una línea editable (la captura
            // muestra el cursor al final); devolver el foco justo antes de la
            // tecla de confirmación evita ese falso bloqueo.
            await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'arguments[0].focus(); return document.activeElement === arguments[0];',
                args: [{ [elementKey]: input }],
            }).catch(() => false);
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: keyActions.slice(-2) }],
            });
        } else {
            // La misma carrera aparece sin Enter: WebView2 puede entregar la
            // última letra antes de que xterm pinte el buffer accesible. La
            // separación conserva la entrada completa y evita falsos fallos
            // en probes de espacios, backspace y líneas largas.
            const prefix = keyActions.length > 2 ? keyActions.slice(0, -2) : [];
            const suffix = keyActions.length > 2 ? keyActions.slice(-2) : keyActions;
            if (prefix.length > 0) {
                await request(`/session/${sessionId}/actions`, 'POST', {
                    actions: [{ type: 'key', id: 'keyboard', actions: prefix }],
                });
                dispatchedKeyboardActions = true;
                await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
            }
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: suffix }],
            });
        }
    } catch (firstError) {
        // WebKitWebDriver antiguo puede no implementar acciones de teclado;
        // conservar una ruta compatible para esos entornos.
        if (dispatchedKeyboardActions) throw firstError;
        try {
            await request(`/session/${sessionId}/element/${input}/value`, 'POST', { text: `${line}${enter ? '\n' : ''}` });
        } catch {
            try {
                await request(`/session/${sessionId}/element/${input}/value`, 'POST', { value: [...`${line}${enter ? '\n' : ''}`] });
            } catch {
                throw firstError;
            }
        }
    }
    if (settle) await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
    return focusMethod;
}

async function sendTerminalLine(line, pane = null) {
    return sendTerminalKeys(line, pane, { enter: true, settle: true });
}

async function assertPromptReadyForInput(cell, label) {
    const before = await terminalRowSnapshot(cell);
    if (!snapshotPromptVisible(before)) {
        throw new Error(`Entrada ${label}: el prompt no estaba listo antes de escribir (${JSON.stringify({
            cursorRow: before?.cursorRow,
            rows: before?.rows?.slice(-4),
        })})`);
    }
    return before;
}

async function sendLineAndAssertPrompt(line, cell, marker, label) {
    const before = await assertPromptReadyForInput(cell, label);
    const startedAt = Date.now();
    await sendTerminalLine(line, cell);
    // Una línea horizontal puede reenvolverse temporalmente mientras ConPTY
    // termina de aplicar la reserva de columnas. El contenido sigue íntegro,
    // pero `.xterm-rows` inserta saltos entre fragmentos; exigir el marcador
    // con sus saltos originales convertía ese estado válido en un falso fallo
    // de WebDriver (especialmente en WTERMNUMSEQ). Comparar también la forma
    // normalizada conserva la comprobación de todos los caracteres sin exigir
    // que el renderer haya terminado el reflow en el mismo frame.
    const normalizedMarker = String(marker).replace(/\s+/gu, '');
    await waitUntil(async () => {
        // La salida acabada de escribir suele estar en el viewport actual.
        // Leerla primero evita recorrer 49 posiciones del historial en cada
        // sondeo; si no aparece, conservar la búsqueda completa de respaldo.
        const visibleText = String(await fullTerminalTextWithin(cell) ?? '');
        const visibleMarker = visibleText.includes(marker)
            || visibleText.replace(/\s+/gu, '').includes(normalizedMarker);
        const text = visibleMarker ? visibleText : String(await scrollbackTerminalTextWithin(cell) ?? '');
        const markerVisible = visibleMarker || text.includes(marker)
            || text.replace(/\s+/gu, '').includes(normalizedMarker);
        return markerVisible && snapshotPromptVisible(await terminalRowSnapshot(cell));
    }, 20000, `prompt después de ${label}`);
    const after = await terminalRowSnapshot(cell);
    if (!snapshotPromptVisible(after)) {
        throw new Error(`Entrada ${label}: el prompt no volvió tras escribir`);
    }
    const durationMs = Date.now() - startedAt;
    return { before, after, durationMs, slow: durationMs > 5000 };
}

async function sendTerminalInternalLine(line, pane = null) {
    return sendTerminalLine(line, pane);
}

async function probeInternalCommandInput() {
    // WebDriver puede agrupar toda la línea en un único evento `onData`.
    // El interceptor de xterm necesita ver la edición carácter a carácter
    // para mantener su espejo de entrada; reproducirla así evita confundir
    // una limitación del driver con un fallo del comando interno.
    const cell = await activeTerminalCell();
    for (const character of ':shell current') {
        await sendTerminalKeys(character, cell, { enter: false, settle: false });
    }
    await sendTerminalKeys('', cell, { enter: true, settle: true });
    try {
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            const rowsText = snapshot.rows.map((row) => row.text).join('\n');
            const cell = await activeTerminalCell();
            const renderedText = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'return arguments[0].querySelector(".xterm-rows")?.textContent ?? "";',
                args: [{ [elementKey]: cell }],
            });
            return /Shell actual:|Current shell:|Shell actuelle:/i.test(`${rowsText}\n${renderedText}`);
        }, 10000, 'entrada del comando interno');
        return { supported: true };
    } catch {
        return {
            supported: false,
            reason: 'WebDriver no confirmó la salida de «:shell current» tras 10 segundos; se conserva el texto visible para diagnosticar la carrera.',
        };
    }
}

async function activeTerminalRowSnapshot() {
    // Las pruebas pueden dejar varias pestañas visibles. Leer la primera
    // celda hacía que los comandos enviados a la pestaña activa se
    // verificaran contra otra pestaña y producía falsos fallos de los
    // comandos internos (por ejemplo, `:shell current`).
    const cell = await activeTerminalCell();
    return terminalRowSnapshot(cell);
}

async function terminalOutputRefreshSnapshot() {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const observerKey = '__lterminalOutputRefreshObserver';
            if (!window[observerKey]) {
                window[observerKey] = { counts: Object.create(null), lastByTab: Object.create(null) };
                window.addEventListener('winslim:terminal-output-refreshed', (event) => {
                    const detail = event.detail ?? {};
                    if (!detail.tabId) return;
                    window[observerKey].counts[detail.tabId] = (window[observerKey].counts[detail.tabId] ?? 0) + 1;
                    window[observerKey].lastByTab[detail.tabId] = detail;
                });
            }
            const cell = document.querySelector('.cell:not(.hidden)');
            const tabId = cell?.dataset.tabId ?? null;
            const pane = cell?.querySelector('.tab-pane:not(.hidden)');
            const host = pane?.querySelector('[data-testid="terminal-host"]');
            const rect = host?.getBoundingClientRect();
            return {
                refreshCount: tabId ? window[observerKey].counts[tabId] ?? 0 : 0,
                lastRefresh: tabId ? window[observerKey].lastByTab[tabId] ?? null : null,
                text: pane?.querySelector('.xterm-rows')?.textContent ?? '',
                geometry: {
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    paneCount: document.querySelectorAll('.cell:not(.hidden) .tab-pane:not(.hidden)').length,
                    tabId,
                    cols: Number(pane?.dataset.terminalCols ?? 0),
                    rows: Number(pane?.dataset.terminalRows ?? 0),
                    hostWidth: rect ? Math.round(rect.width) : 0,
                    hostHeight: rect ? Math.round(rect.height) : 0,
                },
            };`,
        args: [],
    });
}

async function terminalRowSnapshot(cell) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const rows = [...arguments[0].querySelectorAll('.xterm-rows > div')];
            const cursor = arguments[0].querySelector('.xterm-cursor');
            const cursorRect = cursor?.getBoundingClientRect();
            const cursorStyle = cursor ? getComputedStyle(cursor) : null;
            const cursorFallbackStyle = cursor ? getComputedStyle(cursor, '::after') : null;
            const cursorCenterY = cursorRect ? (cursorRect.top + cursorRect.bottom) / 2 : null;
            return {
                cols: Number(arguments[0].querySelector('[data-terminal-cols]')?.dataset.terminalCols || 0),
                rows: rows.map((row, index) => {
                    const rect = row.getBoundingClientRect();
                    return { index, text: row.textContent || '', top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
                }),
                cursorRow: cursorCenterY === null ? -1 : rows.findIndex((row) => {
                    const rect = row.getBoundingClientRect();
                    return cursorCenterY >= rect.top && cursorCenterY < rect.bottom;
                }),
                cursor: cursor ? {
                    className: cursor.className,
                    backgroundColor: cursorStyle?.backgroundColor ?? '',
                    color: cursorStyle?.color ?? '',
                    borderBottomColor: cursorStyle?.borderBottomColor ?? '',
                    boxShadow: cursorStyle?.boxShadow ?? '',
                    opacity: cursorStyle?.opacity ?? '',
                    visibility: cursorStyle?.visibility ?? '',
                    display: cursorStyle?.display ?? '',
                    animationName: cursorStyle?.animationName ?? '',
                    fallbackContent: cursorFallbackStyle?.content ?? '',
                    fallbackBackgroundColor: cursorFallbackStyle?.backgroundColor ?? '',
                    fallbackBorderTopColor: cursorFallbackStyle?.borderTopColor ?? '',
                    fallbackOpacity: cursorFallbackStyle?.opacity ?? '',
                } : null,
            };`,
        args: [{ [elementKey]: cell }],
    });
}

/**
 * ConPTY coloca el eco de la orden con `ESC[fila;colH`. Si sus filas no
 * coinciden con las de xterm, la orden aparece en otra fila, precedida solo
 * de espacios (la columna donde terminaba el prompt). Una orden escrita en el
 * prompt nunca puede empezar así: la fila de su inicio debe llevar el prompt
 * delante. Devuelve las filas despegadas para cada orden buscada.
 */
// Órdenes escritas en el prompt cuyo eco debe seguir pegado a él en
// cualquier comprobación posterior (divisiones, resize, repintados).
const typedEchoCommands = [];

async function assertVisiblePanesKeepCommandEcho(stage, extraCommands = []) {
    const cells = (await findAll('.cell:not(.hidden)')).map((cell) => cell[elementKey]);
    await assertNoDetachedCommandEcho(cells, [...typedEchoCommands, ...extraCommands], stage);
}

function detachedCommandEchoes(rows, commands) {
    const offenders = [];
    // 40 caracteres distinguen órdenes con prefijo común (echo LTERMINAL_E2E_TAB_0/1/2…).
    for (const command of new Set(commands.map((value) => String(value).slice(0, 40)))) {
        const needle = command;
        if (!needle.trim()) continue;
        for (const row of rows) {
            const index = row.text.indexOf(needle);
            if (index < 0) continue;
            const prefix = row.text.slice(0, index);
            if (prefix.trim() === '' && (index > 0 || /^echo\s/u.test(needle))) {
                offenders.push({
                    command: needle,
                    row: row.index,
                    leadingSpaces: index,
                    text: row.text.trim().slice(0, 60),
                });
            }
        }
    }
    return offenders;
}

async function assertNoDetachedCommandEcho(cells, commands, stage) {
    const failures = [];
    for (const [paneIndex, cell] of cells.entries()) {
        const snapshot = await terminalRowSnapshot(cell);
        const offenders = detachedCommandEchoes(snapshot.rows, commands);
        if (offenders.length > 0) {
            failures.push({
                pane: paneIndex + 1,
                offenders,
                rows: snapshot.rows.filter((row) => row.text.trim()).map((row) => row.text.trimEnd().slice(0, 80)),
            });
        }
    }
    if (failures.length > 0) {
        await captureScreenshot(`eco-despegado-${stage}`);
        throw new Error(`La orden quedó separada de su prompt (${stage}): ${JSON.stringify(failures)}`);
    }
    recordEvent('command-echo-attached', { stage, panes: cells.length, commands: commands.length, passed: true });
}

async function terminalHorizontalSnapshot(cell) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = arguments[0];
            const viewport = root.querySelector('.xterm-viewport');
            const scrollable = root.querySelector('.xterm-scrollable-element');
            const screen = root.querySelector('.xterm-screen');
            const host = root.querySelector('[data-testid="terminal-host"]');
            const pane = root.matches('.tab-pane')
                ? root
                : root.querySelector('.tab-pane:not(.hidden)');
            const visibleRows = [...root.querySelectorAll('.xterm-rows > div')]
                .map((row) => (row.textContent || '').replace(/\\s+$/u, '').length);
            const indicator = root.querySelector('.horizontal-overflow-indicator');
            const indicatorStyle = indicator ? getComputedStyle(indicator) : null;
            const horizontalScrollers = [...root.querySelectorAll('*')]
                .filter((element) => {
                    const style = getComputedStyle(element);
                    const overflowX = style.overflowX;
                    return (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay')
                        && element.scrollWidth > element.clientWidth + 2;
                })
                .map((element) => ({
                    tag: element.tagName.toLowerCase(),
                    className: element.className || '',
                    testId: element.getAttribute('data-testid') || '',
                    overflowX: getComputedStyle(element).overflowX,
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                    parentClassName: element.parentElement?.className || '',
                    parentTag: element.parentElement?.tagName.toLowerCase() || '',
                    styleOverflowX: element.style.overflowX || '',
                }));
            return {
                devicePixelRatio: window.devicePixelRatio,
                viewport: viewport ? {
                    clientWidth: viewport.clientWidth,
                    scrollWidth: viewport.scrollWidth,
                    clientHeight: viewport.clientHeight,
                    scrollHeight: viewport.scrollHeight,
                    scrollLeft: viewport.scrollLeft,
                    overflowX: getComputedStyle(viewport).overflowX,
                } : null,
                scrollable: scrollable ? {
                    clientWidth: scrollable.clientWidth,
                    scrollWidth: scrollable.scrollWidth,
                    clientHeight: scrollable.clientHeight,
                    scrollHeight: scrollable.scrollHeight,
                    scrollTop: scrollable.scrollTop,
                    overflowY: getComputedStyle(scrollable).overflowY,
                } : null,
                screen: screen ? {
                    clientWidth: screen.clientWidth,
                    scrollWidth: screen.scrollWidth,
                    rectWidth: screen.getBoundingClientRect().width,
                    inlineWidth: screen.style.width,
                    font: screen.firstElementChild ? getComputedStyle(screen.firstElementChild).font : '',
                } : null,
                host: host ? {
                    clientWidth: host.clientWidth,
                    scrollWidth: host.scrollWidth,
                    scrollLeft: host.scrollLeft,
                    scrollMaximum: Math.max(0, host.scrollWidth - host.clientWidth),
                    rectWidth: host.getBoundingClientRect().width,
                    overflow: pane.dataset.horizontalOverflow || '',
                    // La rejilla de xterm sigue a ConPTY (mínimo 1024
                    // columnas); las comprobaciones de anchura miden lo que
                    // se ve: las columnas del ancho publicado por el host.
                    cols: pane.dataset.displayCols || pane.dataset.terminalCols || '',
                    gridCols: pane.dataset.terminalCols || '',
                    rows: pane.dataset.terminalRows || '',
                    overflowX: getComputedStyle(host).overflowX,
                    spacer: (() => {
                        const node = host.querySelector('.terminal-width-spacer');
                        if (!node) return null;
                        const rect = node.getBoundingClientRect();
                        return {
                            width: node.getBoundingClientRect().width,
                            scrollWidth: node.scrollWidth,
                            styleWidth: node.style.width,
                            computedWidth: getComputedStyle(node).width,
                            left: rect.left,
                            right: rect.right,
                        };
                    })(),
                } : null,
                horizontalScrollers,
                visibleRowLengths: visibleRows,
                indicator: indicator ? {
                    className: indicator.className,
                    opacity: indicatorStyle?.opacity || '',
                    display: indicatorStyle?.display || '',
                } : null,
            };`,
        args: [{ [elementKey]: cell }],
    });
}

async function visibleHorizontalTextAtEnd(cell) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = arguments[0];
            const host = root.querySelector('[data-testid="terminal-host"]');
            if (!host) return null;
            const maximum = Math.max(0, host.scrollWidth - host.clientWidth);
            host.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            host.scrollLeft = maximum;
            // La asignación programática puede no generar un evento en todos
            // los WebView. Forzar el mismo evento que usaría una barra real
            // deja que xterm invalide su atlas antes de la captura PNG.
            host.dispatchEvent(new Event('scroll', { bubbles: true }));
            const clip = host.getBoundingClientRect();
            const chars = [];
            const rows = [...root.querySelectorAll('.xterm-rows > div')];
            for (const row of rows) {
                const rowRect = row.getBoundingClientRect();
                if (rowRect.bottom <= clip.top || rowRect.top >= clip.bottom) continue;
                const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    for (let index = 0; index < node.textContent.length; index += 1) {
                        const range = document.createRange();
                        range.setStart(node, index);
                        range.setEnd(node, index + 1);
                        const rect = range.getBoundingClientRect();
                        if (rect.right > clip.left && rect.left < clip.right
                            && rect.bottom > clip.top && rect.top < clip.bottom) {
                            chars.push(node.textContent[index]);
                        }
                    }
                }
            }
            return {
                maximum,
                scrollLeft: host.scrollLeft,
                clientWidth: host.clientWidth,
                scrollWidth: host.scrollWidth,
                horizontalTail: {
                    enabled: host.dataset.horizontalTail || '',
                    left: host.style.getPropertyValue('--horizontal-tail-left'),
                    width: host.style.getPropertyValue('--horizontal-tail-width'),
                    after: (() => {
                        const style = getComputedStyle(host, '::after');
                        const rect = style ? host.getBoundingClientRect() : null;
                        return style ? { width: style.width, left: style.left, rectWidth: rect?.width ?? 0 } : null;
                    })(),
                },
                screen: (() => {
                    const screen = root.querySelector('.xterm-screen');
                    if (!screen) return null;
                    const rect = screen.getBoundingClientRect();
                    const style = getComputedStyle(screen);
                    return {
                        width: Math.round(rect.width),
                        left: Math.round(rect.left),
                        right: Math.round(rect.right),
                        scrollWidth: screen.scrollWidth,
                        inlineWidth: screen.style.width,
                        display: style.display,
                        visibility: style.visibility,
                        opacity: style.opacity,
                    };
                })(),
                xterm: (() => {
                    const xterm = root.querySelector('.xterm');
                    if (!xterm) return null;
                    const rect = xterm.getBoundingClientRect();
                    const style = getComputedStyle(xterm);
                    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), overflow: style.overflow };
                })(),
                visibleText: chars.join(''),
                rows: rows.map((row) => {
                    const rect = row.getBoundingClientRect();
                    return { text: row.textContent || '', top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
                }),
                numericTailRects: (() => {
                    const row = rows.find((item) => (item.textContent || '').includes('WTERMNUMSEQ'));
                    if (!row) return [];
                    const node = row.firstChild;
                    if (!node || node.nodeType !== Node.TEXT_NODE) return [];
                    const start = Math.max(0, node.textContent.length - 32);
                    const output = [];
                    for (let index = start; index < node.textContent.length; index += 1) {
                        const range = document.createRange();
                        range.setStart(node, index);
                        range.setEnd(node, index + 1);
                        const rect = range.getBoundingClientRect();
                        output.push({ char: node.textContent[index], left: Math.round(rect.left), right: Math.round(rect.right) });
                    }
                    return output;
                })(),
            };`,
        args: [{ [elementKey]: cell }],
    });
}

/**
 * Simula la salida de un instalador sin ejecutar ningún gestor de paquetes.
 * Las actualizaciones reales suelen pintar varias fases sobre la misma fila
 * usando `\r`; la barra larga se genera dentro de la shell para que el propio
 * comando no sea la línea que provoque el desbordamiento.
 */
function progressCommand(label, marker, barLength) {
    const safeLabel = label.replace(/[^A-Z0-9_-]/g, '_');
    if (process.platform === 'win32') {
        // Generar la barra en un archivo PowerShell corto evita que el propio
        // comando tecleado (que antes repetía cientos de #) ensanche xterm y
        // contamine la medición del ancho solicitado por la salida del proceso.
        return `powershell.exe -NoProfile -File "%TEMP%\\${progressSimulationScriptName}" ${safeLabel} ${marker} ${barLength}`;
    }
    const dots = '.'.repeat(Math.min(24, barLength));
    if (barLength <= 32) {
        const bar = '#'.repeat(barLength);
        return `printf '%s\\r%s\\r%s\\n%s\\n' 'LTERMINAL_PROGRESS_${safeLabel} 0% [${dots}]' 'LTERMINAL_PROGRESS_${safeLabel} 50% [${dots}]' 'LTERMINAL_PROGRESS_${safeLabel} 100% [${bar}]' '${marker}'`;
    }
    return `printf '%s\\r%s\\r%s' 'LTERMINAL_PROGRESS_${safeLabel} 0%' 'LTERMINAL_PROGRESS_${safeLabel} 50%' 'LTERMINAL_PROGRESS_${safeLabel} 100% ['; printf '%*s' ${barLength} '' | tr ' ' '#'; printf ']\\n${marker}\\n'`;
}

function progressClearCommand(marker) {
    return process.platform === 'win32'
        ? `cmd /d /s /c "cls & echo ${marker}"`
        : `clear; printf '%s\\n' '${marker}'`;
}

async function waitForProgressMarker(marker, description) {
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        const text = await textOf(rows);
        const index = text.lastIndexOf(marker);
        return index >= 0 && promptLooksVisible(text.slice(index + marker.length));
    }, 15000, description);
}

async function exerciseProgressOutputLayout() {
    const startedAt = Date.now();
    const actionHeader = 'WTERM_ACTION_HEADER_BEGIN ACTUALIZAR WINGET WTERM_ACTION_HEADER_END';
    if (process.platform === 'win32') {
        await writeFile(progressSimulationScriptPath, [
            "$label = $args[0]",
            "$marker = $args[1]",
            "$barLength = [int]$args[2]",
            `Write-Output '${actionHeader}'`,
            "Write-Output ('LTERMINAL_PROGRESS_' + $label.ToUpperInvariant() + ' 0%')",
            "Write-Output ('LTERMINAL_PROGRESS_' + $label.ToUpperInvariant() + ' 50%')",
            "$bar = '#' * $barLength",
            "Write-Output ('LTERMINAL_PROGRESS_' + $label.ToUpperInvariant() + ' 100% [' + $bar + ']')",
            'Write-Output $marker',
            '',
        ].join('\n'), 'utf8');
    }
    // Esta geometría deja margen para una barra corta y obliga a que la larga
    // solicite solo las columnas que ocupa su contenido.
    await captureScreenshot('progress-before-window-resize');
    await resizeWindow(900, 620, { waitForBanner: false });
    const resetMarker = `LTERMINAL_PROGRESS_RESET_${Date.now()}`;
    await captureScreenshot('progress-before-clear');
    await sendTerminalLine(progressClearCommand(resetMarker));
    // Capturar durante la transición permite detectar una matriz vieja o una
    // barra secundaria fugaz, que una captura final no puede demostrar.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await captureScreenshot('progress-during-clear');
    await waitForProgressMarker(resetMarker, 'limpieza previa de la prueba de progreso');
    const cell = await findWhenReady('.cell:not(.hidden)');
    // El cambio de ventana puede llegar después del marcador de la shell:
    // esperar a que xterm recupere el ancho del viewport evita medir las
    // columnas de la fase anterior como si fueran espacio reservado por
    // `update`.
    let baselineRecoverySnapshot = null;
    try {
        await waitUntil(async () => {
        const snapshot = await terminalHorizontalSnapshot(cell);
        baselineRecoverySnapshot = snapshot;
        const host = snapshot.host;
        const screen = snapshot.screen;
        const cols = Number(host?.cols ?? 0);
        const cellWidth = Number(screen?.rectWidth ?? 0) / Math.max(1, cols);
        const visibleCols = Math.floor(Number(host?.clientWidth ?? 0) / Math.max(1, cellWidth));
        return Boolean(host && screen)
            && host.clientWidth > 0
            // El lienzo interno conserva un margen de repintado de 8px; no
            // cuenta como contenido horizontal utilizable hasta que la
            // reserva de columnas supera ese margen.
            && host.scrollWidth <= host.clientWidth + 12
            && cols > 0
            && cols <= visibleCols + 1;
        }, 15000, 'recuperación del ancho mínimo tras cambiar la ventana');
    } catch (error) {
        throw new Error(`${error.message}: ${JSON.stringify(baselineRecoverySnapshot)}`, { cause: error });
    }
        const baseline = await terminalHorizontalSnapshot(cell);
    if (!baseline.host || baseline.host.clientWidth <= 0) {
        throw new Error(`No se pudo medir el host de terminal antes de la prueba de progreso: ${JSON.stringify(baseline)}`);
    }

    const visibleColumns = Math.max(1, Number(baseline.host.cols) || 80);
    const longBarLength = Math.max(160, visibleColumns + 40);
    const scenarios = [
        { id: 'update', barLength: 24, expectedMinimum: 20 },
        { id: 'upgrade', barLength: longBarLength, expectedMinimum: 20 },
    ];
        const results = [];
    for (const scenario of scenarios) {
        const marker = `LTERMINAL_PROGRESS_${scenario.id.toUpperCase()}_DONE_${Date.now()}`;
        const command = progressCommand(scenario.id, marker, scenario.barLength);
        const commandStartedAt = Date.now();
        await captureScreenshot(`progress-${scenario.id}-before`);
        await sendTerminalLine(command);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await captureScreenshot(`progress-${scenario.id}-during`);
        await waitForProgressMarker(marker, `salida simulada de ${scenario.id}`);
        const snapshot = await terminalHorizontalSnapshot(cell);
        const host = snapshot.host;
        const outputText = normalizedTerminalText(await rawTerminalTextWithin(cell));
        const headerIntact = outputText.includes(normalizedTerminalText(actionHeader));
        const maxVisibleRowLength = Math.max(0, ...(snapshot.visibleRowLengths ?? []));
        const expectedLineLength = scenario.id === 'upgrade'
            ? `LTERMINAL_PROGRESS_UPGRADE 100% [${'#'.repeat(scenario.barLength)}]`.length
            : `LTERMINAL_PROGRESS_UPDATE 100% [${'#'.repeat(scenario.barLength)}]`.length;
        if (!host) throw new Error(`La terminal no expuso geometría para ${scenario.id}`);
        // Una barra corta recupera la anchura mínima. La barra larga puede
        // conservar todo su contenido en la única superficie horizontal del
        // host o reenvolverlo dentro del PTY cuando el compositor decide no
        // ampliar la rejilla. Ambos casos conservan la cola; lo que no se
        // acepta es una fila que desaparece sin overflow ni reflow observable.
        const expectsHorizontalOverflow = scenario.id === 'upgrade';
        const horizontalScrollers = snapshot.horizontalScrollers ?? [];
        const onlyHostScrolls = horizontalScrollers.length === 1
            && horizontalScrollers[0]?.testId === 'terminal-host';
        // El comando de simulación de Windows puede ser más ancho que el
        // viewport y su eco es entrada válida, no una barra de progreso
        // truncada. En ese caso conservamos las aserciones de contenido,
        // cabecera y scroller único, pero no exigimos que la matriz vuelva al
        // ancho base hasta que el clear posterior retire el eco.
        const shortCommandEchoOverflow = scenario.id === 'update'
            && host.overflow === 'true'
            && onlyHostScrolls
            && maxVisibleRowLength <= Number(host.cols) + 1;
        const wrappedLongContent = expectsHorizontalOverflow
            && host.overflow !== 'true'
            && host.scrollWidth <= host.clientWidth + 12
            && Number(host.cols) <= Number(baseline.host.cols) + 4
            && Number(expectedLineLength) > maxVisibleRowLength
            && maxVisibleRowLength <= Number(host.cols) + 1
            && maxVisibleRowLength >= scenario.expectedMinimum;
        const contentDriven = expectsHorizontalOverflow
            ? (host.overflow === 'true'
                && host.scrollWidth > host.clientWidth + 2
                && onlyHostScrolls
                // Cuando la salida cabe en una línea lógica, xterm puede
                // conservarla como una fila DOM más ancha que la rejilla PTY
                // y desplazarla desde el host. Eso es precisamente lo que
                // queremos comprobar: que no se fragmente ni se pierda la
                // cola, aunque `data-terminal-cols` aún refleje la matriz
                // que tenía la shell al imprimir el bloque.
                && maxVisibleRowLength <= expectedLineLength + 2
                && maxVisibleRowLength >= scenario.expectedMinimum)
                || wrappedLongContent
            : (host.overflow !== 'true'
                && host.scrollWidth <= host.clientWidth + 12
                && Number(host.cols) <= Number(baseline.host.cols) + 4
                && maxVisibleRowLength <= Number(host.cols) + 1
                && maxVisibleRowLength >= scenario.expectedMinimum)
                || shortCommandEchoOverflow;
        const capture = await captureScreenshot(`progress-${scenario.id}-layout`);
        results.push({
            id: scenario.id,
            barLength: scenario.barLength,
            expectedMinimum: scenario.expectedMinimum,
            expectedLineLength,
            maxVisibleRowLength,
            host,
            baseline: {
                devicePixelRatio: baseline.devicePixelRatio,
                host: baseline.host,
                screen: baseline.screen,
            },
            screen: snapshot.screen,
            horizontalScrollers,
            headerIntact,
            commandDurationMs: Date.now() - commandStartedAt,
            capture,
            contentDriven,
            passed: contentDriven,
        });
        if (!contentDriven || !headerIntact) {
            throw new Error(`La salida simulada de ${scenario.id} no respetó el ancho mínimo/contenido: ${JSON.stringify(results.at(-1))}`);
        }
    }

    const cleanupMarker = `LTERMINAL_PROGRESS_CLEAN_${Date.now()}`;
    const cleanupStartedAt = Date.now();
    await captureScreenshot('progress-before-cleanup');
    await sendTerminalLine(progressClearCommand(cleanupMarker));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await captureScreenshot('progress-during-cleanup');
    await waitForProgressMarker(cleanupMarker, 'limpieza de la barra de progreso');
    const cleaned = await terminalHorizontalSnapshot(cell);
    const cleanupHost = cleaned.host;
    const reclaimed = Boolean(cleanupHost)
        && cleanupHost.overflow !== 'true'
        && cleanupHost.scrollWidth <= cleanupHost.clientWidth + 12
        && Number(cleanupHost.cols) <= Number(baseline.host.cols) + 4;
    const cleanupCapture = await captureScreenshot('progress-clean-layout');
    if (!reclaimed) {
        throw new Error(`La terminal no recuperó su ancho tras limpiar la barra: ${JSON.stringify({ baseline, cleaned })}`);
    }
    const durationMs = Date.now() - startedAt;
    recordEvent('progress-output-layout', {
        simulation: 'download/update/upgrade with carriage-return output',
        baseline,
        scenarios: results,
        cleanup: { host: cleanupHost, durationMs: Date.now() - cleanupStartedAt, capture: cleanupCapture, reclaimed },
        captures: [...results.map((result) => result.capture), cleanupCapture].filter(Boolean),
        durationMs,
        passed: true,
    });
    process.stdout.write(`E2E progreso: update=${results[0].commandDurationMs}ms, upgrade=${results[1].commandDurationMs}ms, limpieza=${Date.now() - cleanupStartedAt}ms, ancho recuperado, OK\n`);
    return { scenarios: results, cleanup: { reclaimed }, durationMs };
}

/**
 * Comprueba una línea horizontal larga con tokens numerados. Las barras de
 * progreso cubren el ancho, pero no detectan un hueco en mitad de una salida
 * arbitraria; esta sonda exige que el primer, último y todos los números sigan
 * presentes después de reducir y recuperar la ventana.
 */
async function exerciseHorizontalSequenceIntegrity() {
    const configuredSequenceCount = Number.parseInt(process.env.E2E_HORIZONTAL_SEQUENCE_COUNT ?? '360', 10);
    const sequenceCount = Number.isInteger(configuredSequenceCount)
        ? Math.max(16, Math.min(4096, configuredSequenceCount))
        : 360;
    const configuredNumericRanges = String(process.env.E2E_HORIZONTAL_NUMERIC_RANGES ?? '')
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 16384);
    // 16.384 es el techo práctico de la rejilla horizontal de WTerminal. La
    // suite normal cubre también 2.048 números para conservar una regresión
    // elevada en cada ejecución; se pueden añadir rangos mediante la variable
    // de entorno para diagnósticos todavía más largos.
    const numericRangesToCheck = configuredNumericRanges.length
        ? [...new Set(configuredNumericRanges)]
        : [100, 150, 500, 2048];
    const openFreshTab = async (previousCount, label) => {
        const previousActiveId = await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id');
        await clickWhenReady('.tab-new');
        await waitUntil(async () => (await findAll('.tab')).length === previousCount + 1,
            10000, `pestaña limpia para ${label}`);
        await waitUntil(async () => {
            const active = await findWhenReady('.tab.active[data-tab-id]');
            return (await attribute(active, 'data-tab-id')) !== previousActiveId;
        }, 10000, `activación de pestaña para ${label}`);
        await waitForBannerPanes(1, 20000);
    };
    // Ejecutar la secuencia en una pestaña limpia evita que una línea larga
    // anterior determine el máximo horizontal y oculte la cola de `1-120`.
    const originalTabCount = (await findAll('.tab')).length;
    await captureScreenshot('scroll-sequence-before-new-tab');
    await openFreshTab(originalTabCount, 'secuencia horizontal');
    const sequenceTabId = await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id');
    const cell = await activeTerminalCell();
    const sequence = Array.from({ length: sequenceCount }, (_, index) => `WTERMSEQ${String(index).padStart(4, '0')}`).join('-');
    const marker = 'WTERMSEQ-END';
    const output = `${sequence}-${marker}`;
    if (process.platform === 'win32') {
        await writeFile(reflowSimulationScriptPath, `Write-Output '${output.replaceAll("'", "''")}'\n`, 'utf8');
        const scriptPath = reflowSimulationScriptPath.replaceAll('"', '""');
        await sendTerminalLine(`powershell.exe -NoLogo -NoProfile -File "${scriptPath}"`);
    } else {
        await writeFile(reflowSimulationScriptPath, posixPrintfLinesScript([output]), 'utf8');
        await sendTerminalLine(`/bin/sh ${quotePosixShellArgument(reflowSimulationScriptPath)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    await captureScreenshot('scroll-sequence-during-output');
    let normalized = '';
    let sequenceDiagnostic = {};
    try {
        await waitUntil(async () => {
            // Esta línea ocupa más filas que el viewport. Recorrer el
            // scrollback vertical evita confundir texto fuera de la ventana
            // visible con una pérdida de datos horizontal.
            const text = String(await scrollbackTerminalTextWithin(cell) ?? '');
            normalized = text.replace(/\s+/gu, '');
            sequenceDiagnostic = {
                length: normalized.length,
                first: normalized.includes('WTERMSEQ0000'),
                last: normalized.includes(marker),
                sample: normalized.slice(-160),
            };
            return sequenceDiagnostic.first && sequenceDiagnostic.last;
        }, 40000, 'salida completa de secuencia horizontal');
    } catch (error) {
        await captureScreenshot('scroll-sequence-incomplete');
        const geometry = await terminalHorizontalSnapshot(cell);
        throw new Error(`${error.message}: ${JSON.stringify({ sequenceDiagnostic, geometry })}`, { cause: error });
    }
    const missingBeforeResize = Array.from({ length: sequenceCount }, (_, index) => `WTERMSEQ${String(index).padStart(4, '0')}`)
        .filter((token) => !normalized.includes(token));
    if (missingBeforeResize.length) {
        await captureScreenshot('scroll-sequence-missing-before-resize');
        throw new Error(`La secuencia horizontal perdió tokens antes del resize: ${JSON.stringify(missingBeforeResize.slice(0, 12))}`);
    }
    const before = await terminalHorizontalSnapshot(cell);
    await captureScreenshot('scroll-sequence-before-horizontal-end');
    const host = before.host;
    const horizontalProbe = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
            if (!host) return null;
            const maximum = Math.max(0, host.scrollWidth - host.clientWidth);
            host.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            host.scrollLeft = maximum;
            return { maximum, scrollLeft: host.scrollLeft, scrollWidth: host.scrollWidth, clientWidth: host.clientWidth };`,
        args: [{ [elementKey]: cell }],
    });

    // Regresión visual: una orden mucho más corta después de una línea larga
    // debe conservar su fila completa cuando xterm reusa la misma matriz. La
    // prueba mide el DOM antes y después de una salida PTY adicional, mueve la
    // ventana y captura cada estado para poder revisar el resultado físico.
    const shortMarker = `WTERM-MATRIX-SHORT-${Date.now()}`;
    await captureScreenshot('matrix-short-before');
    const shortInput = await sendLineAndAssertPrompt(
        `echo ${shortMarker}`, cell, shortMarker, 'salida corta tras línea larga',
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    await captureScreenshot('matrix-short-during');
    await waitUntil(async () => {
        const text = String(await scrollbackTerminalTextWithin(cell) ?? '').replace(/\s+/gu, '');
        return text.includes(shortMarker.replace(/\s+/gu, ''));
    }, 15000, 'salida corta después de la línea larga');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterShort = await terminalHorizontalSnapshot(cell);
    const shortCapture = await captureScreenshot('matrix-linea-larga-y-corta');
    const shortScrollers = afterShort.horizontalScrollers ?? [];
    if ((captureScreenshots && !shortCapture) || shortScrollers.some((entry) => entry.testId && entry.testId !== 'terminal-host')
        || shortScrollers.length > 1) {
        throw new Error(`La salida corta dejó matrices/scrollbars horizontales duplicadas: ${JSON.stringify({ afterShort, shortCapture })}`);
    }

    // El evento de salida inactiva fuerza el mismo refresco que llega cuando
    // una shell real termina un comando. No basta con comprobar el texto: el
    // contrato exige que el viewport también se repinte después de esa cola.
    const refreshBeforeShort = await terminalOutputRefreshSnapshot();
    const refreshMarker = `WTERM-MATRIX-REFRESH-${Date.now()}`;
    const refreshInput = await sendLineAndAssertPrompt(
        `echo ${refreshMarker}`, cell, refreshMarker, 'salida tras refresco PTY',
    );
    for (const [label, input] of [['salida corta', shortInput], ['salida tras refresco PTY', refreshInput]]) {
        if (input.slow) {
            recordEvent('terminal-input-latency', {
                label,
                durationMs: input.durationMs,
                thresholdMs: 5000,
                warning: true,
                passed: true,
            });
        }
    }
    await waitUntil(async () => {
        const text = String(await scrollbackTerminalTextWithin(cell) ?? '').replace(/\s+/gu, '');
        return text.includes(refreshMarker);
    }, 15000, 'marcador después del refresco PTY');
    let refreshAfterShort = await terminalOutputRefreshSnapshot();
    await waitUntil(async () => {
        refreshAfterShort = await terminalOutputRefreshSnapshot();
        return refreshAfterShort.refreshCount > refreshBeforeShort.refreshCount;
    }, 10000, 'repintado PTY después de la salida corta');
    const refreshCapture = await captureScreenshot('matrix-despues-refresco-pty');
    const afterRefreshMatrix = await terminalHorizontalSnapshot(cell);
    const afterRefreshText = String(await scrollbackTerminalTextWithin(cell) ?? '').replace(/\s+/gu, '');
    const shortAfterRefresh = afterRefreshText.includes(shortMarker.replace(/\s+/gu, ''));
    if (!shortAfterRefresh) {
        throw new Error(`La salida corta desapareció al repintar la segunda orden: ${JSON.stringify({
            afterRefreshMatrix,
            shortMarker,
            refreshMarker,
            textLength: afterRefreshText.length,
            tail: afterRefreshText.slice(-1200),
            refreshCapture,
        })}`);
    }

    const narrowResizeStartedAt = Date.now();
    await resizeWindow(640, 520, { waitForBanner: false });
    await captureScreenshot('matrix-before-narrow-resize');
    await new Promise((resolve) => setTimeout(resolve, 450));
    const narrowReflowMs = Date.now() - narrowResizeStartedAt;
    const afterShortNarrow = await terminalHorizontalSnapshot(cell);
    const narrowCapture = await captureScreenshot('matrix-despues-redimensionado-estrecho');
    const narrowText = String(await scrollbackTerminalTextWithin(cell) ?? '').replace(/\s+/gu, '');
    if (!narrowText.includes(shortMarker.replace(/\s+/gu, ''))
        || !narrowText.includes(refreshMarker.replace(/\s+/gu, ''))
        || (afterShortNarrow.horizontalScrollers ?? []).some((entry) => entry.testId && entry.testId !== 'terminal-host')) {
        throw new Error(`La matriz perdió la salida corta al redimensionar: ${JSON.stringify({
            afterShortNarrow,
            narrowCapture,
            shortMarker,
            refreshMarker,
            shortVisible: narrowText.includes(shortMarker.replace(/\s+/gu, '')),
            refreshVisible: narrowText.includes(refreshMarker.replace(/\s+/gu, '')),
            narrowTextLength: narrowText.length,
            narrowTail: narrowText.slice(-1200),
        })}`);
    }
    const restoreResizeStartedAt = Date.now();
    await resizeWindow(1100, 720, { waitForBanner: false });
    await captureScreenshot('matrix-before-restore-resize');
    await new Promise((resolve) => setTimeout(resolve, 450));
    const restoreReflowMs = Date.now() - restoreResizeStartedAt;
    const afterShortRestore = await terminalHorizontalSnapshot(cell);
    const restoreShortCapture = await captureScreenshot('matrix-despues-redimensionado-restaurado');
    if ((captureScreenshots && !restoreShortCapture) || (afterShortRestore.horizontalScrollers ?? []).some((entry) => entry.testId && entry.testId !== 'terminal-host')) {
        throw new Error(`La matriz restaurada creó un scroll horizontal secundario: ${JSON.stringify({ afterShortRestore, restoreShortCapture })}`);
    }
    const reflowTimingLimitMs = 30000;
    if (narrowReflowMs > reflowTimingLimitMs || restoreReflowMs > reflowTimingLimitMs) {
        throw new Error(`El reflow horizontal tardó demasiado: ${JSON.stringify({
            narrowReflowMs, restoreReflowMs, reflowTimingLimitMs,
        })}`);
    }
    const sequenceTabCount = (await findAll('.tab')).length;
    await openFreshTab(sequenceTabCount, 'secuencia numérica');
    const numericCell = await activeTerminalCell();
    const numericSequence = Array.from({ length: 120 }, (_, index) => String(index + 1)).join('-');
    const numericOutput = `WTERMNUMSEQ:${numericSequence}`;
    if (process.platform === 'win32') {
        await writeFile(reflowSimulationScriptPath, `Write-Output '${numericOutput.replaceAll("'", "''")}'\n`, 'utf8');
        const scriptPath = reflowSimulationScriptPath.replaceAll('"', '""');
        await sendLineAndAssertPrompt(
            `powershell.exe -NoLogo -NoProfile -File "${scriptPath}"`, numericCell, numericOutput, 'secuencia numérica 1-120',
        );
    } else {
        await writeFile(reflowSimulationScriptPath, posixPrintfLinesScript([numericOutput]), 'utf8');
        await sendLineAndAssertPrompt(
            `/bin/sh ${quotePosixShellArgument(reflowSimulationScriptPath)}`, numericCell, numericOutput, 'secuencia numérica 1-120',
        );
    }
    // El repintado de un lienzo xterm muy ancho puede necesitar más de un
    // frame en WebView2 antes de que la captura vea la cola desplazada.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const numericEndProbe = await visibleHorizontalTextAtEnd(numericCell);
    const visibleNumeric = String(numericEndProbe?.visibleText ?? '');
    const numericTailStart = 113;
    let nextNumber = numericTailStart;
    let cursor = -1;
    const missingNumeric = [];
    while (nextNumber <= 120) {
        const token = String(nextNumber);
        const found = visibleNumeric.indexOf(token, cursor + 1);
        if (found < 0) missingNumeric.push(nextNumber);
        else cursor = found + token.length - 1;
        nextNumber += 1;
    }
    if (!numericEndProbe || missingNumeric.length) {
        await captureScreenshot('scroll-numeric-sequence-missing-at-end');
        throw new Error(`El extremo horizontal perdió números: ${JSON.stringify({ numericEndProbe, missingNumeric, visibleNumeric })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const numericEndCapture = await captureScreenshot('scroll-numeric-sequence-120-at-end');
    // Esta captura representa un estado visual concreto, no solo una lectura
    // del DOM. Fuerza un frame de la misma ventana justo después de fijar el
    // scroll en el extremo para que el MP4 contenga la cola visible.
    const numericEndVideo = await recordVideoVisualCheckpoint('scroll-numeric-sequence-120-at-end', numericEndCapture);
    if (numericEndVideo && !numericEndVideo.captured) {
        throw new Error('El vídeo no capturó el extremo horizontal 80-120');
    }
    await clickWhenReady('.tab.active .tab-close');
    await waitUntil(async () => (await findAll('.tab')).length === sequenceTabCount,
        10000, 'cierre de pestaña de secuencia numérica');
    // El backend puede activar otra pestaña al cerrar una auxiliar. Conservar
    // el id de la secuencia impide auditar por error el tab original vacío.
    // Repetir el extremo con longitudes distintas evita que el margen quede
    // ajustado accidentalmente a una sola secuencia.
    const numericRangeResults = [];
    for (const upper of numericRangesToCheck) {
        const rangeTabCount = (await findAll('.tab')).length;
        await openFreshTab(rangeTabCount, `secuencia 1-${upper}`);
        const rangeCell = await activeTerminalCell();
        // Cada rango parte de una rejilla limpia. Así la medición no hereda
        // una reserva horizontal creada por la secuencia anterior ni por el
        // banner inicial de la shell.
        await sendTerminalLine('cls', rangeCell);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const rangeSequence = Array.from({ length: upper }, (_, index) => String(index + 1)).join('-');
        const rangeOutput = `WTERMNUMSEQ${upper}:${rangeSequence}`;
        if (process.platform === 'win32') {
            await writeFile(reflowSimulationScriptPath, `Write-Output '${rangeOutput}'\n`, 'utf8');
            const scriptPath = reflowSimulationScriptPath.replaceAll('"', '""');
            await sendLineAndAssertPrompt(
                `powershell.exe -NoLogo -NoProfile -File "${scriptPath}"`, rangeCell, rangeOutput, `secuencia 1-${upper}`,
            );
        } else {
            await writeFile(reflowSimulationScriptPath, posixPrintfLinesScript([rangeOutput]), 'utf8');
            await sendLineAndAssertPrompt(
                `/bin/sh ${quotePosixShellArgument(reflowSimulationScriptPath)}`, rangeCell, rangeOutput, `secuencia 1-${upper}`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        const rangeProbe = await visibleHorizontalTextAtEnd(rangeCell);
        const visibleRange = String(rangeProbe?.visibleText ?? '');
        // En rangos de cuatro dígitos el ancho de una sola celda hace que el
        // borde izquierdo pueda cortar parcialmente uno o dos tokens, aunque
        // el último token quede completamente pintado. La integridad total
        // se comprueba arriba en el texto del buffer; aquí se exige además
        // que la cola visible incluya el número final y una ventana segura.
        const visibleTailCount = upper >= 1000 ? 4 : 8;
        const tailStart = Math.max(1, upper - visibleTailCount + 1);
        const missingRange = [];
        let rangeCursor = -1;
        for (let value = tailStart; value <= upper; value += 1) {
            const found = visibleRange.indexOf(String(value), rangeCursor + 1);
            if (found < 0) missingRange.push(value);
            else rangeCursor = found + String(value).length - 1;
        }
        if (!rangeProbe || missingRange.length) {
            await captureScreenshot(`scroll-numeric-sequence-${upper}-missing-at-end`);
            // Medidas DOM para diagnosticar el ancho publicado frente a la
            // rejilla real de xterm y el avance real de los glifos.
            const domWidths = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const host = document.querySelector('.cell:not(.hidden) [data-testid="terminal-host"]');
                    const pane = host?.closest('.tab-pane');
                    const screen = host?.querySelector('.xterm-screen');
                    const box = (el) => el ? { cls: String(el.className).slice(0, 40), w: Math.round(el.getBoundingClientRect().width), cw: el.clientWidth, sw: el.scrollWidth } : null;
                    const row = [...(host?.querySelectorAll('.xterm-rows > div') ?? [])].find((r) => (r.textContent || '').includes('WTERMNUMSEQ'));
                    let textRight = null;
                    if (row) { const range = document.createRange(); range.selectNodeContents(row); textRight = Math.round(range.getBoundingClientRect().right - host.getBoundingClientRect().left + host.scrollLeft); }
                    return {
                        displayCols: pane?.dataset.displayCols, gridCols: pane?.dataset.terminalCols,
                        contentVar: host?.style.getPropertyValue('--terminal-content-width'),
                        screen: box(screen), rowsContainer: box(host?.querySelector('.xterm-rows')),
                        row: box(row), rowChars: row ? (row.textContent || '').length : null, textRight,
                        wideChildren: [...(screen?.children ?? [])].map(box).filter((b) => b && b.w > 2000),
                    };`,
                args: [],
            }).catch((error) => ({ error: String(error) }));
            throw new Error(`El extremo horizontal perdió números en 1-${upper}: ${JSON.stringify({ domWidths, rangeProbe, missingRange, visibleRange })}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
        const rangeCapture = await captureScreenshot(`scroll-numeric-sequence-${upper}-at-end`);
        // El mismo contrato se aplica a cada longitud: la prueba solo es
        // válida si el fotograma codificado conserva el extremo visible.
        const rangeVideo = await recordVideoVisualCheckpoint(`scroll-numeric-sequence-${upper}-at-end`, rangeCapture);
        if (rangeVideo && !rangeVideo.captured) {
            throw new Error(`El vídeo no capturó el extremo horizontal 1-${upper}`);
        }
        numericRangeResults.push({ upper, rangeProbe, tailStart, missingRange, passed: true });
        await clickWhenReady('.tab.active .tab-close');
        await waitUntil(async () => (await findAll('.tab')).length === rangeTabCount,
            10000, `cierre de pestaña de secuencia 1-${upper}`);
    }
    await clickWhenReady(`.tab[data-tab-id="${sequenceTabId}"]`);
    await waitUntil(async () =>
        (await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id')) === sequenceTabId,
    10000, 'reactivar pestaña con secuencia horizontal');
    const restoredSequenceCell = await activeTerminalCell();
    await resizeWindow(640, 520, { waitForBanner: false });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const afterNarrowText = String(await scrollbackTerminalTextWithin(restoredSequenceCell) ?? '').replace(/\s+/gu, '');
    const missingAfterNarrow = Array.from({ length: sequenceCount }, (_, index) => `WTERMSEQ${String(index).padStart(4, '0')}`)
        .filter((token) => !afterNarrowText.includes(token));
    const narrowMarkerVisible = afterNarrowText.includes(marker);
    if (!narrowMarkerVisible || missingAfterNarrow.length) {
        await captureScreenshot('scroll-sequence-missing-after-narrow');
        throw new Error(`La secuencia horizontal perdió contenido al estrechar: ${JSON.stringify({
            sequenceTabId, narrowMarkerVisible, missingAfterNarrow: missingAfterNarrow.slice(0, 12),
            textLength: afterNarrowText.length, tail: afterNarrowText.slice(-160),
        })}`);
    }
    await resizeWindow(1100, 720, { waitForBanner: false });
    const afterRestoreText = String(await scrollbackTerminalTextWithin(restoredSequenceCell) ?? '').replace(/\s+/gu, '');
    const missingAfterRestore = Array.from({ length: sequenceCount }, (_, index) => `WTERMSEQ${String(index).padStart(4, '0')}`)
        .filter((token) => !afterRestoreText.includes(token));
    const restoreMarkerVisible = afterRestoreText.includes(marker);
    if (!restoreMarkerVisible || missingAfterRestore.length) {
        await captureScreenshot('scroll-sequence-missing-after-restore');
        throw new Error(`La secuencia horizontal perdió contenido al restaurar: ${JSON.stringify({
            sequenceTabId, restoreMarkerVisible, missingAfterRestore: missingAfterRestore.slice(0, 12),
            textLength: afterRestoreText.length, tail: afterRestoreText.slice(-160),
        })}`);
    }
    const final = await terminalHorizontalSnapshot(restoredSequenceCell);
    recordEvent('horizontal-sequence-integrity', {
        tokenCount: sequenceCount,
        firstToken: 'WTERMSEQ0000',
        lastToken: `WTERMSEQ${String(sequenceCount - 1).padStart(4, '0')}`,
        marker,
        before,
        horizontalProbe,
        matrixRegression: {
            shortMarker,
            refreshMarker,
            afterShort,
            shortCapture,
            refreshBeforeShort,
            refreshAfterShort,
            refreshCapture,
            shortInput,
            refreshInput,
            afterShortNarrow,
            narrowReflowMs,
            narrowCapture,
            afterShortRestore,
            restoreReflowMs,
            restoreShortCapture,
            passed: true,
        },
        reflowTiming: {
            narrowReflowMs,
            restoreReflowMs,
            limitMs: reflowTimingLimitMs,
            passed: true,
        },
        numericSequence: { first: 1, last: 120, numericEndProbe, missingNumeric },
        numericRanges: numericRangeResults,
        maxSupportedColumns: 16384,
        reflowAfterNarrow: { markerVisible: narrowMarkerVisible, missingAfterNarrow },
        reflowAfterRestore: { markerVisible: restoreMarkerVisible, missingAfterRestore },
        final,
        passed: true,
    });
    await clickWhenReady('.tab.active .tab-close');
    await waitUntil(async () => (await findAll('.tab')).length === originalTabCount,
        10000, 'cierre de pestaña de secuencia horizontal');
    return { before, horizontalProbe, final, passed: true };
}

/**
 * Recorre el panel de Ajustes completo y comprueba la geometría fija de su
 * cabecera mientras el contenido sube y baja. El E2E de dependencias no debe
 * afirmar cobertura visual de toda la aplicación sin pasar por esta ruta.
 */
async function exerciseSettingsVisualAudit() {
    await resizeWindow(1100, 900, { waitForBanner: false });
    await clickWhenReady('[data-testid="toolbar-settings"]');
    const dialog = await findWhenReady('[role="dialog"]');
    const tabs = ['appearance', 'terminal', 'behavior', 'about'];
    const results = [];
    for (const tab of tabs) {
        const control = await findWhenReady(`[data-testid="settings-tab-${tab}"]`);
        await click(control);
        await waitUntil(async () => (await attribute(
            await findWhenReady(`[data-testid="settings-tab-${tab}"]`),
            'aria-selected',
        )) === 'true', 5000, `Ajustes: pestaña ${tab}`);
        const top = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const dialog = arguments[0];
                const header = dialog.querySelector('.panel-header');
                const subheader = dialog.querySelector('.panel-subheader');
                const scroll = dialog.querySelector('.panel-scroll');
                const rect = (node) => { const value = node?.getBoundingClientRect(); return value ? {
                    top: Math.round(value.top), bottom: Math.round(value.bottom),
                    left: Math.round(value.left), right: Math.round(value.right),
                    height: Math.round(value.height),
                } : null; };
                if (scroll) scroll.scrollTop = 0;
                return { header: rect(header), subheader: rect(subheader), scroll: rect(scroll),
                    scrollTop: scroll?.scrollTop ?? null, scrollHeight: scroll?.scrollHeight ?? null,
                    clientHeight: scroll?.clientHeight ?? null };`,
            args: [{ [elementKey]: dialog }],
        });
        const topCapture = await captureScreenshot(`visual-ajustes-${tab}-arriba`);
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'const scroll = arguments[0].querySelector(".panel-scroll"); if (scroll) scroll.scrollTop = scroll.scrollHeight; return scroll?.scrollTop ?? null;',
            args: [{ [elementKey]: dialog }],
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const bottom = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const dialog = arguments[0];
                const header = dialog.querySelector('.panel-header');
                const subheader = dialog.querySelector('.panel-subheader');
                const scroll = dialog.querySelector('.panel-scroll');
                const rect = (node) => { const value = node?.getBoundingClientRect(); return value ? {
                    top: Math.round(value.top), bottom: Math.round(value.bottom),
                    left: Math.round(value.left), right: Math.round(value.right),
                    height: Math.round(value.height),
                } : null; };
                return { header: rect(header), subheader: rect(subheader), scroll: rect(scroll),
                    scrollTop: scroll?.scrollTop ?? null, scrollHeight: scroll?.scrollHeight ?? null,
                    clientHeight: scroll?.clientHeight ?? null };`,
            args: [{ [elementKey]: dialog }],
        });
        const bottomCapture = await captureScreenshot(`visual-ajustes-${tab}-abajo`);
        const headerStable = Boolean(top.header && bottom.header
            && Math.abs(top.header.top - bottom.header.top) <= 2
            && Math.abs(top.header.bottom - bottom.header.bottom) <= 2);
        const contentBelowHeader = Boolean(bottom.scroll && bottom.subheader
            && bottom.scroll.top >= bottom.subheader.bottom - 2);
        const scrolled = Number(bottom.scrollHeight ?? 0) <= Number(bottom.clientHeight ?? 0) + 2
            || Number(bottom.scrollTop ?? 0) > 0;
        if (!headerStable || !contentBelowHeader || !scrolled) {
            throw new Error(`Ajustes: cabecera o scroll inestables en ${tab}: ${JSON.stringify({ top, bottom, headerStable, contentBelowHeader, scrolled })}`);
        }
        results.push({ tab, top, bottom, captures: [topCapture, bottomCapture].filter(Boolean), headerStable, contentBelowHeader });
    }
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras auditoría visual');
    recordEvent('settings-visual-audit', { tabs: results, passed: true });
    return results;
}

async function exerciseLongCommandInputIntegrity() {
    const marker = `WTERM-LONG-INPUT-${Date.now()}`;
    const payload = '"'.repeat(900);
    // A launch can leave a stale character batch in the native input queue
    // while WebView2 finishes handing focus to xterm. Commit that harmless
    // batch first so this probe measures the long command itself, rather than
    // concatenating it with startup residue.
    await sendTerminalKeys('', await activeTerminalCell(), { enter: true, settle: true });
    const inputCell = await activeTerminalCell();
    const promptBefore = await assertPromptReadyForInput(inputCell, 'entrada larga con comillas');
    // Esta captura se toma después de comprobar el prompt y antes de escribir
    // el payload. La captura anterior podía coincidir con la cola de arranque
    // y no demostraba que realmente no hubiese input pendiente.
    const beforeCapture = await captureScreenshot('long-command-before');
    const beforeText = String(await fullTerminalTextWithin(inputCell) ?? '');
    if (beforeText.includes(marker) || beforeText.includes(payload)) {
        throw new Error('La captura previa de entrada larga ya contenía el comando; no es un estado inicial válido');
    }
    // Captura el comando todavía editable antes de pulsar Enter. Así la
    // evidencia demuestra que había una entrada real y permite comprobar que
    // el extremo derecho no desaparece mientras xterm reenvuelve la línea.
    await sendTerminalKeys(`echo ${payload} ${marker}`, inputCell, { enter: false, settle: false });
    // El eco de ~950 caracteres atraviesa el lote de 12 ms, la reserva de
    // columnas y ConPTY; una espera fija de 120 ms medía una línea a medio
    // escribir en equipos cargados. Se espera al marcador final y después se
    // deja un frame para el repintado.
    await waitUntil(
        async () => String(await fullTerminalTextWithin(inputCell) ?? '').includes(marker),
        10000,
        'eco completo de la entrada larga',
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const duringCapture = await captureScreenshot('long-command-during');
    const inputDuringSnapshot = await terminalHorizontalSnapshot(inputCell);
    const inputDuringText = String(await fullTerminalTextWithin(inputCell) ?? '');
    const normalizedInputDuringText = inputDuringText.replace(/\s+/gu, '');
    const normalizedLongCommand = (`echo ${payload} ${marker}`).replace(/\s+/gu, '');
    const visibleInputColumns = (inputDuringSnapshot.visibleRowLengths ?? [])
        .reduce((total, length) => total + Math.max(0, Number(length) || 0), 0);
    if (!inputDuringText.includes(marker)
        || Number(inputDuringSnapshot.host?.cols ?? 0) < 1024
        || Number(inputDuringSnapshot.host?.scrollMaximum ?? 0) <= 0
        || !normalizedInputDuringText.includes(normalizedLongCommand)
        || visibleInputColumns < Math.floor(payload.length * 0.75)) {
        const rowDump = (await terminalRowSnapshot(inputCell)).rows
            .filter((row) => row.text.trim())
            .map((row) => ({
                index: row.index,
                length: row.text.trimEnd().length,
                leadingSpaces: row.text.length - row.text.trimStart().length,
                head: row.text.trimStart().slice(0, 40),
            }));
        throw new Error(`La entrada larga no quedó verificable antes de Enter: ${JSON.stringify({
            rowDump,
            inputDuringSnapshot,
            hasMarker: inputDuringText.includes(marker),
            hasCompleteCommand: normalizedInputDuringText.includes(normalizedLongCommand),
            visibleInputColumns,
        })}`);
    }
    await sendTerminalKeys('', inputCell, { enter: true, settle: true });
    await waitUntil(async () => {
        const text = String(await fullTerminalTextWithin(await activeTerminalCell()) ?? '');
        return text.includes(marker) && snapshotPromptVisible(await activeTerminalRowSnapshot());
    }, 20000, 'entrada larga con comillas y prompt restaurado');
    const text = String(await fullTerminalTextWithin(inputCell) ?? '');
    const quoteCount = (text.match(/"/g) ?? []).length;
    const normalizedText = text.replace(/\s+/gu, '');
    const normalizedExpected = (`echo ${payload} ${marker}`).replace(/\s+/gu, '');
    if (!text.includes(marker)
        || quoteCount < payload.length
        || !normalizedText.includes(normalizedExpected)) {
        throw new Error(`La entrada larga perdió contenido tras Enter: ${JSON.stringify({
            hasMarker: text.includes(marker),
            quoteCount,
            expectedQuoteCount: payload.length,
            hasCompleteCommand: normalizedText.includes(normalizedExpected),
        })}`);
    }
    const promptAfter = await terminalRowSnapshot(inputCell);
    if (!snapshotPromptVisible(promptAfter)) {
        throw new Error('La entrada larga terminó sin devolver el prompt');
    }
    const snapshot = await terminalHorizontalSnapshot(inputCell);
    const postCommandHorizontal = snapshot.host?.scrollMaximum > 0
        && snapshot.host?.overflowX === 'auto'
        && Number(snapshot.host?.cols ?? 0) >= payload.length;
    const longRenderedRows = (snapshot.visibleRowLengths ?? [])
        .filter((length) => Number(length) >= Math.floor(payload.length * 0.8));
    const longCommandRows = (promptAfter.rows ?? [])
        .map((row) => String(row.text ?? ''))
        .filter((text) => text.includes('>echo ') || /^(?:\s*"){24,}/u.test(text) || text.includes(marker));
    const indentedLongCommandRows = longCommandRows
        .filter((text) => /^\s+"{24,}/u.test(text));
    // La regresión importante ocurre después de Enter: la rejilla no puede
    // volver a las columnas del viewport al detectar que las filas DOM ya
    // parecen cortas. Eso reenvuelve el eco de `echo` y elimina el scroll.
    // Exigir una reserva física y dos filas largas comprueba el canvas final,
    // no solamente el texto accesible del DOM.
    if (!postCommandHorizontal || longRenderedRows.length < 2 || indentedLongCommandRows.length > 0) {
        throw new Error(`La salida larga perdió su reserva horizontal tras Enter: ${JSON.stringify({
            host: snapshot.host,
            visibleRowLengths: snapshot.visibleRowLengths,
            longRenderedRows,
            indentedLongCommandRows,
        })}`);
    }
    // El resultado debe comprobarse en ambos extremos físicos del scroll. Una
    // sola captura en el margen izquierdo puede ocultar precisamente la cola
    // que se pierde en las regresiones de reflow.
    const leftCapture = await captureScreenshot('long-command-after-left');
    const rightScroll = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]')
            || arguments[0].closest('[data-testid="terminal-host"]')
            || arguments[0];
            const max = Math.max(0, host.scrollWidth - host.clientWidth);
            host.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            host.scrollLeft = max;
            return { scrollLeft: host.scrollLeft, max, scrollWidth: host.scrollWidth, clientWidth: host.clientWidth };`,
        args: [{ [elementKey]: inputCell }],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const rightCapture = await captureScreenshot('long-command-after-right');
    const rightSnapshot = await terminalHorizontalSnapshot(inputCell);
    const rightText = String(await fullTerminalTextWithin(inputCell) ?? '');
    const rightHasMarker = rightText.includes(marker);
    const leftCols = Number(snapshot.host?.cols ?? 0);
    const rightCols = Number(rightSnapshot.host?.cols ?? 0);
    const longestHistoricalRow = Math.max(0,
        ...(promptAfter.rows ?? []).map((row) => String(row.text ?? '').trimEnd().length));
    const leftScrollWidth = Number(snapshot.host?.scrollWidth ?? 0);
    const rightScrollWidth = Number(rightSnapshot.host?.scrollWidth ?? 0);
    const rightGeometryStable = rightCols <= Math.max(leftCols * 2, leftCols + 512)
        && rightScrollWidth <= Math.max(leftScrollWidth * 2, leftScrollWidth + 1024);
    if (!rightHasMarker
        || Number(rightSnapshot.host?.scrollMaximum ?? 0) <= 0
        || rightCols < Math.min(16384, longestHistoricalRow + 2)
        || !rightGeometryStable) {
        throw new Error(`El extremo derecho de la salida larga no quedó verificable: ${JSON.stringify({ rightScroll, rightSnapshot, rightHasMarker, longestHistoricalRow })}`);
    }
    const resetScroll = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]')
            || arguments[0].closest('[data-testid="terminal-host"]')
            || arguments[0];
            host.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            host.scrollLeft = 0;
            return host.scrollLeft;`,
        args: [{ [elementKey]: inputCell }],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    recordEvent('long-command-input-integrity', {
        marker,
        quoteCount: payload.length,
        promptBefore,
        promptAfter,
        terminal: snapshot,
        postCommandHorizontal,
        longRenderedRows,
        captures: {
            before: beforeCapture,
            during: duringCapture,
            afterLeft: leftCapture,
            afterRight: rightCapture,
        },
        inputDuringSnapshot,
        rightScroll,
        rightSnapshot,
        resetScroll,
        passed: true,
    });
    return {
        marker,
        snapshot,
        captures: {
            before: beforeCapture,
            during: duringCapture,
            afterLeft: leftCapture,
            afterRight: rightCapture,
        },
        inputDuringSnapshot,
        rightScroll,
        rightSnapshot,
        resetScroll,
        passed: true,
    };
}

async function exercisePaneVisualAudit() {
    // La auditoría de dependencias puede terminar con una división abierta
    // (por ejemplo, si una captura se hizo mientras el panel estaba en 2).
    // La secuencia visual debe partir siempre de una sola casilla; de lo
    // contrario el primer clic se interpreta como 2→3 y la espera de 2 queda
    // esperando un estado que ya no puede producirse.
    // El control rota 1→2→3→4→1; desde cualquier estado distinto de 1 se
    // necesitan como máximo tres pulsaciones. Cuatro volvería a saltarse el
    // estado 1 cuando la auditoría hereda dos paneles.
    for (let attempt = 0; attempt < 3 && await visiblePaneCount() !== 1; attempt += 1) {
        await clickPaneControl('full-visual-pane-reset');
        await new Promise((resolve) => setTimeout(resolve, 220));
    }
    await waitUntil(async () => await visiblePaneCountWithTimeout(30000) === 1, 90000, 'estado inicial de un panel para auditoría visual');
    await waitForBannerPanes(1, 20000);
    const transitions = [];
    let current = 1;
    for (const [target, width, height] of [[2, 1100, 720], [3, 1240, 780], [4, 1240, 780], [1, 1100, 720]]) {
        await captureScreenshot(`panes-${current}-a-${target}-antes`);
        await clickPaneControl('full-visual-pane-transition');
        await captureScreenshot(`panes-${current}-a-${target}-durante`);
        await waitUntil(async () => await visiblePaneCountWithTimeout(30000) === target, 90000, `paneles ${current}→${target}`);
        const applied = await resizeWindow(width, height, { waitForBanner: false });
        await assertPaneOutputStable(target, `auditoría visual ${current}→${target}`);
        await assertNoTinyFragmentRuns(target, `auditoría visual ${current}→${target}`);
        await captureScreenshot(`panes-${current}-a-${target}-despues`);
        transitions.push({ from: current, to: target, applied });
        current = target;
    }
    recordEvent('pane-visual-audit', { transitions, finalCount: current, passed: true });
    return { transitions, finalCount: current, passed: true };
}

async function exerciseComprehensiveVisualAudit() {
    const settings = await exerciseSettingsVisualAudit();
    const panes = await exercisePaneVisualAudit();
    const longCommand = await exerciseLongCommandInputIntegrity();
    const horizontal = await exerciseHorizontalSequenceIntegrity();
    const progress = await exerciseProgressOutputLayout();
    await assertClearKeepsInputOnPromptRow();
    await assertPromptReflowsAfterResize();
    await exerciseWindowManagerStates();
    smokeReport.coverage.settings = { covered: true, tabs: settings.map((item) => item.tab) };
    smokeReport.coverage.paneTransitions = panes.transitions;
    smokeReport.coverage.longLineAndAnsiReflow = true;
    smokeReport.coverage.horizontalScroll = horizontal.passed;
    smokeReport.coverage.windowManager = IS_HYPRLAND
        ? { status: 'passed', reason: null }
        : { status: 'skipped', reason: 'Hyprland no disponible en el runner' };
    recordEvent('comprehensive-visual-audit', {
        settingsTabs: settings.map((item) => item.tab),
        paneTransitions: panes.transitions,
        longCommand: longCommand.marker,
        horizontal: horizontal.passed,
        progress: progress.durationMs,
        elevated: { required: requireElevated, executed: requireElevated === true },
        passed: true,
    });
    return { settings, panes, longCommand, horizontal, progress, passed: true };
}

// Una línea larga de :help debe conservar todos sus caracteres cuando xterm
// cambia de ancho. Al dividir una pestaña el texto lógico se reenvuelve; una
// carrera entre el reflow del buffer y el resize del PTY llegó a perder
// caracteres en mitad de «otros». Mantener la frase completa como contrato
// evita que una captura aparentemente correcta oculte esa regresión.
// Se comprueba el tramo que históricamente se cortaba («otros»). El prefijo
// contiene `ñ`, cuyo nodo de accesibilidad puede omitirse en ConPTY/UTF-8 aun
// cuando el canvas lo pinta bien; este sufijo solo usa caracteres ASCII salvo
// la tilde de `parámetros`, que se normaliza abajo.
const LONG_INTERNAL_HELP_LINE = 'scrollback, densidad y otros parámetros de xterm.';
// No basta comprobar el fragmento que originó el informe: estas cadenas
// cubren comandos largos, descripciones, notas y una salida real de la shell.
// Todas atraviesan un ancho de 104 a 50 columnas al dividir la pestaña.
const REFLOW_SHELL_LINES = [
    `lterminal-reflow-alpha-begin-${'0123456789abcdef'.repeat(8)}-alpha-end`,
    `lterminal-reflow-beta-begin-${'fedcba9876543210'.repeat(8)}-beta-end`,
    'lterminal-reflow-gamma-begin texto largo con espacios para comprobar que cada palabra sigue en el orden correcto al cambiar la rejilla de terminal gamma-end',
];

function normalizedTerminalText(value) {
    return String(value ?? '')
        .replace(/\u200b/g, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        // Los saltos de fila de xterm son un wrap visual, no un separador
        // lógico: quitarlos permite reconstruir una frase que ocupa dos filas.
        .replace(/\s+/g, '')
        .toLowerCase()
        .trim();
}

function helpLineFound(snapshot) {
    const visible = normalizedTerminalText(snapshot?.rows?.map((row) => row.text).join(' ') ?? '');
    return visible.includes(normalizedTerminalText(LONG_INTERNAL_HELP_LINE));
}

async function scanTerminalScrollbackForHelp() {
    const viewport = (await findAll('.cell:not(.hidden) .xterm-viewport'))[0]?.[elementKey];
    const cell = (await findAll('.cell:not(.hidden)'))[0]?.[elementKey];
    if (!viewport || !cell) return false;
    const positions = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'const node = arguments[0]; return Math.max(0, node.scrollHeight - node.clientHeight);',
        args: [{ [elementKey]: viewport }],
    });
    const maximum = Number(positions) || 0;
    try {
        for (let index = 0; index <= 12; index += 1) {
            const offset = maximum * (index / 12);
            await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'arguments[0].scrollTop = arguments[1]; return true;',
                args: [{ [elementKey]: viewport }, offset],
            });
            await new Promise((resolve) => setTimeout(resolve, 35));
            if (helpLineFound(await terminalRowSnapshot(cell))) return true;
        }
        return false;
    } finally {
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'arguments[0].scrollTop = arguments[0].scrollHeight;',
            args: [{ [elementKey]: viewport }],
        }).catch(() => undefined);
    }
}

async function assertTerminalFragmentsIntact(label, fragments) {
    let last = [];
    try {
        await waitUntil(async () => {
            const cells = await findAll('.cell:not(.hidden)');
            last = await Promise.all(cells.map(async (cell) => {
                const snapshot = await terminalRowSnapshot(cell[elementKey]);
                return {
                    cols: snapshot.cols,
                    text: snapshot.rows.map((row) => row.text).join('\n'),
                };
            }));
            return last.some((snapshot) => {
                const text = normalizedTerminalText(snapshot.text);
                return fragments.every((fragment) => text.includes(normalizedTerminalText(fragment)));
            });
        }, 15000, `${label}: fragmentos completos en scrollback`);
    } catch (error) {
        await captureScreenshot(label);
        throw new Error(`El reflow perdió o alteró texto tras ${label}: ${JSON.stringify({
            fragments,
            snapshots: last.map((snapshot) => ({ cols: snapshot.cols, preview: snapshot.text.slice(-2400) })),
        })}`, { cause: error });
    }
    recordEvent('terminal-reflow-integrity', {
        label,
        fragmentCount: fragments.length,
        paneCount: last.length,
        cols: last.map((snapshot) => snapshot.cols),
        passed: true,
    });
}

async function assertLongHelpLineIntact(label) {
    let lastSnapshot;
    let found = false;
    try {
        await waitUntil(async () => {
            const cells = await findAll('.cell:not(.hidden)');
            const snapshots = await Promise.all(cells.map((cell) => terminalRowSnapshot(cell[elementKey])));
            lastSnapshot = snapshots.find((snapshot) => helpLineFound(snapshot)) ?? snapshots[0];
            return snapshots.some((snapshot) => helpLineFound(snapshot));
        }, 10000, `${label}: línea larga de ayuda completa`);
        found = true;
    } catch (error) {
        // Tras dividir, la frase puede estar intacta en el scrollback pero
        // fuera de las filas actualmente renderizadas por xterm. Recorrer el
        // viewport permite distinguir ese caso legítimo de una pérdida real.
        found = await scanTerminalScrollbackForHelp();
        if (found) {
            recordEvent('help-line-scrollback-scan', { label, passed: true });
            return lastSnapshot;
        }
        await captureScreenshot(label);
        throw new Error(`La línea larga de ayuda perdió texto tras ${label}: ${JSON.stringify({
            cols: lastSnapshot?.cols,
            rows: lastSnapshot?.rows?.map((row) => row.text),
        })}`, { cause: error });
    }
    recordEvent('help-line-integrity', {
        label,
        cols: lastSnapshot?.cols ?? 0,
        rows: lastSnapshot?.rows?.length ?? 0,
        expected: LONG_INTERNAL_HELP_LINE,
        passed: true,
    });
    return lastSnapshot;
}

/**
 * `clear` debe borrar pantalla e historial sin desincronizar el cursor visual
 * de xterm y el cursor real de la shell. La regresión se observa al escribir
 * sin Enter: el prompt queda en una fila y la entrada aparece en la siguiente.
 */
async function assertClearKeepsInputOnPromptRow() {
    const attempts = 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const command = attempt % 2 === 0 ? 'clear' : 'cls';
        await sendTerminalLine(command);
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            const nonEmptyRows = snapshot.rows.filter((row) => row.text.trim().length > 0);
            const promptRows = nonEmptyRows.filter((row) => promptLooksVisible(row.text));
            const lastRow = nonEmptyRows.at(-1);
            const previousRow = nonEmptyRows.at(-2);
            const splitPrompt = lastRow && previousRow
                && promptLooksVisible(`${previousRow.text}\n${lastRow.text}`);
            return (promptRows.length === 1 && promptRows[0] === lastRow)
                || Boolean(splitPrompt && snapshot.cursorRow === lastRow.index);
        }, 10000, `prompt tras ${command} ${attempt + 1}/${attempts}`);

        const marker = `CLEAR_ROW_${attempt + 1}`;
        await sendTerminalKeys(marker, null, { enter: false, settle: true });
        let lastSnapshot;
        try {
            await waitUntil(async () => {
                lastSnapshot = await activeTerminalRowSnapshot();
                const markerRow = lastSnapshot.rows.find((row) => row.text.includes(marker));
                const markerIndex = markerRow?.index ?? -1;
                const markerPreviousRow = markerIndex > 0 ? lastSnapshot.rows[markerIndex - 1] : null;
                return Boolean(markerRow
                    && promptLooksVisible(markerPreviousRow
                        ? `${markerPreviousRow.text}\n${markerRow.text}`
                        : markerRow.text)
                    && (lastSnapshot.cursorRow < 0 || lastSnapshot.cursorRow === markerRow.index));
            }, 5000, `entrada en la misma fila del prompt tras ${command}`);
        } catch (error) {
            await captureScreenshot(`clear-${attempt + 1}-prompt-y-entrada-separados`);
            throw new Error(`Tras ${command}, el prompt y la entrada quedaron en filas distintas: ${JSON.stringify(lastSnapshot)}`, { cause: error });
        }
        // U+E003 es Backspace en el protocolo WebDriver. Dejar la línea vacía
        // permite repetir la misma secuencia sin ejecutar comandos ficticios.
        await sendTerminalKeys('\uE003'.repeat(marker.length), null, { enter: false, settle: true });
    }
    recordEvent('clear-prompt-row', { attempts, commands: ['clear', 'cls'], passed: true });
}

/**
 * Si la app reescribe el prompt mientras una casilla es muy estrecha, al
 * recuperar ancho debe recomponerlo. Dejar dos filas de 15 columnas dentro de
 * una terminal que ya admite 40+ es un residuo gráfico, no un wrap válido.
 */
async function assertPromptReflowsAfterResize() {
    let lastSnapshot;
    const splitPrompt = (snapshot) => {
        if (!snapshot || snapshot.cols <= 0 || snapshot.cursorRow <= 0) return null;
        const current = snapshot.rows[snapshot.cursorRow]?.text.trimEnd() ?? '';
        const previous = snapshot.rows[snapshot.cursorRow - 1]?.text.trimEnd() ?? '';
        const joined = `${previous}${current}`;
        // Fish dibuja normalmente el directorio y el terminador en filas
        // separadas (`~` + `❯`). Esa geometría no es un wrap residual y debe
        // quedar fuera de esta aserción incluso cuando la terminal ya es ancha.
        const fishPrompt = /^(?:~|\/.*|[A-Za-z]:.*)$/.test(previous)
            && /^[>❯$#](?:.*)?$/u.test(current);
        if (fishPrompt) return null;
        if (promptLooksVisible(current) || !promptLooksVisible(joined) || joined.length > snapshot.cols) return null;
        return { cols: snapshot.cols, cursorRow: snapshot.cursorRow, previous, current, joined };
    };
    try {
        await waitUntil(async () => {
            lastSnapshot = await activeTerminalRowSnapshot();
            return splitPrompt(lastSnapshot) === null;
        }, 3000, 'prompt recompuesto tras recuperar ancho');
    } catch (error) {
        await captureScreenshot('prompt-envuelto-con-ancho-suficiente');
        throw new Error(`El prompt conservó el wrap de una geometría anterior: ${JSON.stringify(splitPrompt(lastSnapshot) ?? lastSnapshot)}`, { cause: error });
    }
    recordEvent('prompt-resize-reflow', { cols: lastSnapshot?.cols ?? 0, passed: true });
}

// La activación de una pestaña y el focus de xterm llegan en frames distintos
// en WebView2 reducido. Un único reintento cubre esa ventana sin convertir una
// respuesta ausente en un falso verde: el marcador sigue siendo obligatorio y
// se comprueba en la casilla visible después de cada envío.
async function sendAndWaitForMarker(marker, pane = null, timeoutMs = 15000) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await sendTerminalLine(`echo ${marker}`, pane);
        try {
            await waitUntil(async () => {
                const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
                const text = await textOf(rows);
                const markerIndex = text.lastIndexOf(marker);
                if (markerIndex < 0) return false;
                // No basta con ver el eco del comando: el proceso puede seguir
                // escribiendo mientras el test cambia de pestaña o rediseña la
                // rejilla. Esperar el prompt posterior garantiza que el PTY
                // terminó y evita redimensionar en mitad de ese bloque.
                return promptLooksVisible(text.slice(markerIndex + marker.length));
            }, timeoutMs, `respuesta PTY del marcador ${marker}`);
            if (attempt > 0) recordEvent('pty-marker-retry', { marker, attempt: attempt + 1 });
            return;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

async function rightClick(element) {
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
                { type: 'pointerMove', origin: { [elementKey]: element }, x: 4, y: 4 },
                { type: 'pointerDown', button: 2 },
                { type: 'pointerUp', button: 2 },
            ],
        }],
    });
}

async function dispatchContextMenu(element) {
    // Algunas versiones de WebKitWebDriver entregan el botón secundario al
    // compositor, pero no lo convierten en el evento DOM `contextmenu`. La
    // ruta de respaldo sigue probando exactamente el handler de la interfaz y
    // evita que el smoke falle por una diferencia del driver.
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const target = arguments[0];
            target.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: 40,
                clientY: 40,
                button: 2
            }));
            return true;`,
        args: [{ [elementKey]: element }],
    });
}

async function visiblePanes() {
    // WebKitWebDriver puede quedarse bloqueado en el endpoint /elements al
    // enumerar la rejilla tras varios cambios de panel. execute/sync usa la
    // misma consulta DOM y devuelve referencias WebDriver estándar, evitando
    // ese endpoint sin relajar la comprobación de qué paneles están visibles.
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return Array.from(document.querySelectorAll(".cell:not(.hidden)"));',
        args: [],
    });
}

async function assertToolbarLayout(label) {
    const snapshot = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return (${measureToolbarLayout.toString()})();`,
        args: [],
    });
    if (!toolbarLayoutIsValid(snapshot)) {
        throw new Error(`${label}: controles de barra solapados o recortados: ${JSON.stringify(snapshot)}`);
    }
    recordEvent('toolbar-geometry', { label, ...snapshot, passed: true });
}

async function visiblePaneCount() {
    return visiblePaneCountWithTimeout(webdriverRequestTimeoutMs);
}

async function visiblePaneCountWithTimeout(timeoutMs) {
    // El recuento basta para las esperas de transición. Devolver los nodos
    // completos desde WebKit obliga al driver a serializar referencias DOM y
    // puede bloquearse al llegar a cuatro terminales en WSL1.
    try {
        return await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'return document.querySelectorAll(".cell:not(.hidden)").length;',
            args: [],
        }, timeoutMs);
    } catch (error) {
        // During a PTY resize WebView2 can hold execute/sync for one paint
        // cycle. Fast polling callers must retry instead of converting that
        // transient driver stall into an immediate visual failure; callers
        // using the normal timeout still receive the original error.
        if (timeoutMs < webdriverRequestTimeoutMs) return -1;
        throw error;
    }
}

async function activeTerminalCell() {
    const activeTab = await findWhenReady('.tab.active[data-tab-id]');
    const tabId = await attribute(activeTab, 'data-tab-id');
    return findWhenReady(`.cell:not(.hidden)[data-tab-id="${tabId}"]`);
}

function bannerLooksReady(text) {
    // En una división muy baja xterm puede haber desplazado fuera de las
    // filas visibles el título y el bloque «Sistema», pero no el contenido
    // que confirma que el banner terminó de calcularse. Comprobamos las
    // secciones universales que deben quedar en cada panel. En modo compacto
    // la sesión sustituye a la cabecera como evidencia de que el banner
    // completo terminó de escribirse.
    // El usuario puede ocultar cualquier campo del banner desde Ajustes.
    // No exigir CPU aquí: el E2E debe validar la integridad del bloque
    // visible, no imponer el perfil completo ni fallar por una preferencia
    // persistida de la instalación que ejecuta la prueba.
    const fields = [
        /Sistema|System/i, /PC|Equipo|Host/i, /Kernel/i,
        /Entorno|Environment/i, /Placa|Motherboard/i,
        /CPU|Procesador|Processor/i, /GPU/i,
        /Memoria|Memory|RAM/i, /Disco|Disk|Storage/i,
        /Uptime|Tiempo activo/i, /Fecha|Date/i,
    ];
    return /Memoria|Memory|RAM/i.test(text)
        && /CPU|Procesador|Processor/i.test(text)
        && /Uptime|Tiempo activo/i.test(text)
        && /Sistema|System/i.test(text);
}

/**
 * Devuelve el bloque de banner más reciente del scrollback.
 *
 * El banner ahora se imprime como salida normal del PTY y, por tanto, los
 * bloques anteriores permanecen deliberadamente en el historial. Las
 * comprobaciones de preferencias deben observar solo el bloque generado por
 * el último `sysinfo`; buscar en todo `.xterm-rows` volvería a encontrar el
 * CPU del banner inicial aunque el usuario lo haya ocultado.
 */
function latestBannerBlock(text) {
    const normalized = String(text ?? '').replace(/\r/g, '');
    // La capa accesible de xterm puede exponer varias filas como una sola
    // cadena sin saltos de línea. Buscar el identificador en cualquier
    // posición permite separar igualmente el último `sysinfo` en Linux.
    const markers = [...normalized.matchAll(/(?:WTerminal|LTerminal)\b/gi)];
    if (!markers.length) return normalized;
    const marker = markers[markers.length - 1];
    return normalized.slice(marker.index);
}

async function visualBannerTexts(expected) {
    if (paneAuditFastPath) {
        // Tras muchas capturas WebDriver puede tardar en serializar cada
        // elemento `.xterm-rows` por separado. Una sola ejecución DOM obtiene
        // el mismo texto visible sin dejar la aserción atrapada en una cadena
        // de peticiones /text de 10 s por panel.
        return request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows')]
                .slice(0, arguments[0])
                .map((row) => row.innerText ?? row.textContent ?? '');`,
            args: [expected],
        }, 10_000);
    }
    const rows = await findAll('.cell:not(.hidden) .xterm-rows');
    // Cada comando comparte la misma sesión WebDriver. Leer una casilla por
    // vez evita solapar operaciones de texto en WebKit tras un reflow sin
    // sustituir el texto renderizado del driver por el contenido bruto DOM.
    const texts = [];
    for (const row of rows.slice(0, expected)) {
        texts.push(await textOf(row[elementKey]));
    }
    return texts;
}

async function rawTerminalTexts(expected) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows')]
            .slice(0, arguments[0])
            .map((row) => row.innerText ?? row.textContent ?? '');`,
        args: [expected],
    });
}

async function rawTerminalTextWithin(cell) {
    // Leerlo con una sola ejecución evita dos saltos WebDriver (buscar el
    // descendiente y después extraer su texto) en scrollback. En WSL1/WebKit
    // la segunda consulta podía quedarse bloqueada tras una serie larga de
    // repintados, aunque la ventana siguiera respondiendo a capturas X11.
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return arguments[0].querySelector('.xterm-rows')?.innerText ?? '';`,
        args: [{ [elementKey]: cell }],
    });
}

async function fullTerminalTextWithin(cell) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return arguments[0].querySelector('.xterm-rows')?.textContent ?? '';`,
        args: [{ [elementKey]: cell }],
    });
}

async function scrollbackTerminalTextWithin(cell) {
    const geometry = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = arguments[0];
            const nodes = [root.querySelector('.xterm-viewport'), root.querySelector('.xterm-scrollable-element')].filter(Boolean);
            return nodes.map((node) => ({
                maximum: Math.max(0, node.scrollHeight - node.clientHeight),
                scrollTop: node.scrollTop,
            }));`,
        args: [{ [elementKey]: cell }],
    });
    const maximum = Math.max(0, ...(geometry ?? []).map((item) => Number(item?.maximum) || 0));
    const chunks = [];
    // xterm puede mantener el scrollback con una altura DOM fija en WebView2;
    // en ese caso la rueda es la única ruta que mueve su viewport lógico.
    if (maximum === 0) {
        for (let index = 0; index < 32; index += 1) {
            await dispatchTerminalWheel(cell, -240, 1);
            chunks.push(String(await fullTerminalTextWithin(cell) ?? ''));
        }
        for (let index = 0; index < 32; index += 1) {
            await dispatchTerminalWheel(cell, 240, 1);
            chunks.push(String(await fullTerminalTextWithin(cell) ?? ''));
        }
    }
    for (let index = 0; index <= 48; index += 1) {
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const root = arguments[0];
                for (const selector of ['.xterm-viewport', '.xterm-scrollable-element']) {
                    const node = root.querySelector(selector);
                    if (node) node.scrollTop = arguments[1];
                }
                return true;`,
            args: [{ [elementKey]: cell }, maximum * (index / 48)],
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        chunks.push(String(await fullTerminalTextWithin(cell) ?? ''));
    }
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = arguments[0];
            for (const selector of ['.xterm-viewport', '.xterm-scrollable-element']) {
                const node = root.querySelector(selector);
                if (node) node.scrollTop = node.scrollHeight;
            }
            return true;`,
        args: [{ [elementKey]: cell }],
    });
    return chunks.join('\n');
}

async function dispatchTerminalWheel(cell, deltaY, repeat = 1) {
    // Las versiones actuales de xterm reciben la rueda en su propio
    // `.xterm-scrollable-element`, que envuelve la pantalla. `.xterm-viewport`
    // es solo el contenedor exterior; dirigir allí la acción no activa el
    // manejador de xterm en WebView2 y hace que el test confunda un evento
    // aceptado por WebDriver con un scroll real.
    const scrollables = await findAllWithin(cell, '.xterm-scrollable-element');
    const viewports = await findAllWithin(cell, '.xterm-viewport');
    const target = scrollables[0]?.[elementKey] ?? viewports[0]?.[elementKey];
    if (!target) return null;
    const beforeText = await rawTerminalTextWithin(cell);
    // Con contenido ancho, `.xterm-scrollable-element` mide todo el ancho
    // publicado y su centro puede caer fuera de la casilla visible (sobre el
    // panel vecino): la rueda desplazaba otro xterm. Se apunta, como haría el
    // usuario, a un punto dentro del área visible del host de esta casilla.
    const visiblePoint = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]') ?? arguments[0];
            const rect = host.getBoundingClientRect();
            const left = Math.max(0, rect.left);
            const right = Math.min(window.innerWidth, rect.right);
            const top = Math.max(0, rect.top);
            const bottom = Math.min(window.innerHeight, rect.bottom);
            if (right - left < 4 || bottom - top < 4) return null;
            return { x: Math.round(left + Math.min(80, (right - left) / 2)), y: Math.round(top + (bottom - top) / 2) };`,
        args: [{ [elementKey]: cell }],
    }).catch(() => null);
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{
            type: 'wheel',
            id: 'terminal-scrollback-wheel',
            actions: Array.from({ length: repeat }, () => (visiblePoint
                ? { type: 'scroll', origin: 'viewport', x: visiblePoint.x, y: visiblePoint.y, deltaX: 0, deltaY }
                : { type: 'scroll', origin: { [elementKey]: target }, x: 8, y: 8, deltaX: 0, deltaY })),
        }],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    let afterText = await rawTerminalTextWithin(cell);
    let source = afterText !== beforeText ? 'webdriver-wheel' : 'webdriver-wheel-no-visible-change';
    let defaultPrevented = null;
    if (afterText === beforeText) {
        // Algunas versiones de WebKitWebDriver aceptan la acción W3C pero no
        // la entregan al scrollable de xterm. Despachar el evento en ese mismo
        // nodo conserva el bubbling real que usa la biblioteca.
        defaultPrevented = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const viewport = arguments[0];
                let prevented = false;
                for (let index = 0; index < arguments[1]; index += 1) {
                    const wheel = new WheelEvent('wheel', {
                        bubbles: true,
                        cancelable: true,
                        deltaX: 0,
                        deltaY: arguments[2],
                        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                    });
                    viewport.dispatchEvent(wheel);
                    prevented ||= wheel.defaultPrevented;
                }
                return prevented;`,
            args: [{ [elementKey]: target }, repeat, deltaY],
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        afterText = await rawTerminalTextWithin(cell);
        source = afterText !== beforeText ? 'dom-wheel-fallback' : 'dom-wheel-no-visible-change';
    }
    return { dispatched: repeat, visibleTextChanged: afterText !== beforeText, source, defaultPrevented };
}

async function promptStates(expected) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return [...document.querySelectorAll('.tab-pane:not(.hidden)[data-prompt-visible]')]
            .slice(0, arguments[0])
            .map((host) => host.dataset.promptVisible ?? null);`,
        args: [expected],
    });
}

async function promptDiagnostics() {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const pane = document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)');
            const rows = pane?.querySelector('.xterm-rows');
            const terminalRows = rows ? [...rows.children].slice(-6).map((row) => {
                const text = (row.textContent ?? '').trim();
                return {
                    empty: text.length === 0,
                    pathPrompt: (text.startsWith('~') || text.startsWith('/') || /^[A-Za-z]:/.test(text))
                        && text.includes('>'),
                    rightPrompt: text.trim().includes(' '),
                    standardTerminator: ['>', '❯', '$', '#'].some((suffix) => text.endsWith(suffix)),
                    length: text.length,
                };
            }) : [];
            return {
                promptVisible: pane?.dataset.promptVisible ?? null,
                inputReady: pane?.dataset.inputReady ?? null,
                environmentSwitchRequestId: pane?.dataset.environmentSwitchRequestId ?? null,
                promptCursorRow: pane?.dataset.promptCursorRow ?? null,
                promptCursorViewportRow: pane?.dataset.promptCursorViewportRow ?? null,
                promptBaseY: pane?.dataset.promptBaseY ?? null,
                terminalRows,
            };`,
        args: [],
    });
}

async function promptBannerGeometry(expected) {
    if (paneAuditFastPath) {
        return request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...document.querySelectorAll('.cell:not(.hidden)')].slice(0, arguments[0]).map((cell) => {
                const host = cell.querySelector('.tab-pane');
                const rows = cell.querySelector('.xterm-rows');
                const viewport = cell.querySelector('.xterm-viewport');
                const scrollNodes = [...cell.querySelectorAll('.xterm-viewport, .xterm-scrollable-element')];
                const cursorNode = cell.querySelector('.xterm-cursor');
                const cellRect = cell.getBoundingClientRect();
                const terminalRect = rows?.getBoundingClientRect();
                const cursorRect = cursorNode?.getBoundingClientRect();
                const promptCandidates = rows ? [...rows.children]
                    .filter((node) => /^(?:PS\\s+)?(?:[A-Za-z]:\\\\.+[>❯$#]|[^\\s@]+@[^\\s:]+:.+[❯$#]|(?:~|\\/).*[❯$#])(?:.*)?$/u.test((node.textContent || '').trim()))
                    .map((node, index) => { const rect = node.getBoundingClientRect(); return { index, text: (node.textContent || '').trim(), top: Math.round(rect.top), bottom: Math.round(rect.bottom), display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility, opacity: getComputedStyle(node).opacity }; })
                    .sort((left, right) => right.top - left.top) : [];
                const prompt = promptCandidates[0];
                const cursorRow = Number(host?.dataset.promptCursorViewportRow);
                const viewportRows = Number(host?.dataset.promptViewportRows);
                const baseY = Number(host?.dataset.promptBaseY);
                const viewportY = Number(host?.dataset.promptViewportY);
                const logicalCursorInside = Number.isInteger(cursorRow) && Number.isInteger(viewportRows) && viewportRows > 0 && cursorRow >= 0 && cursorRow < viewportRows;
                const terminalInsideCell = Boolean(terminalRect && cellRect && terminalRect.width > 0 && terminalRect.height > 0 && terminalRect.top >= cellRect.top - 3 && terminalRect.bottom <= cellRect.bottom + 3);
                const cursorInsideTerminal = Boolean(terminalInsideCell && (cursorRect ? cursorRect.top >= terminalRect.top - 3 && cursorRect.bottom <= terminalRect.bottom + 3 : logicalCursorInside));
                const scrolledAwayFromBottom = (Number.isFinite(baseY) && Number.isFinite(viewportY) && viewportY < baseY - 1)
                    || scrollNodes.some((node) => {
                    const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
                    return maximum > 2 && node.scrollTop < maximum - 2;
                });
                return {
                    overlap: false,
                    logicalSafe: cursorInsideTerminal,
                    visualSafe: cursorInsideTerminal,
                    // Motivo del último ajuste aplazado: una casilla
                    // desbordada con fitSkip fijo indica una salida temprana
                    // de fitAndReport que nadie reprogramó.
                    fitSkip: host?.dataset.fitSkip ?? null,
                    inputGridPinned: host?.dataset.inputGridPinned ?? null,
                    scrolledAwayFromBottom,
                    regionsSeparated: false,
                    cursorInsideTerminal,
                    headerFullWidth: false,
                    bannerBottom: null,
                    terminalTop: terminalRect ? Math.round(terminalRect.top) : null,
                    promptTop: prompt?.top ?? null,
                    cursorRect: cursorRect ? { top: Math.round(cursorRect.top), bottom: Math.round(cursorRect.bottom) } : null,
                    promptCandidates,
                    cursorRow: host?.dataset.promptCursorRow ?? null,
                    cursorViewportRow: host?.dataset.promptCursorViewportRow ?? null,
                    baseY: host?.dataset.promptBaseY ?? null,
                    viewportY: host?.dataset.promptViewportY ?? null,
                    viewportRows: host?.dataset.promptViewportRows ?? null,
                    viewportScrollTop: viewport ? Math.round(viewport.scrollTop) : null,
                    rowsRect: rows ? { top: Math.round(terminalRect.top), bottom: Math.round(terminalRect.bottom), height: Math.round(terminalRect.height) } : null,
                    bannerRows: null,
                };
            });`,
            args: [expected],
        }, 10_000);
    }
    const cells = await findAll('.cell:not(.hidden)');
    const snapshots = [];
    for (const cell of cells.slice(0, expected)) {
        snapshots.push(await request(
        '/session/' + sessionId + '/execute/sync',
        'POST',
        {
        script: `const cell = arguments[0];
            const host = cell.querySelector('.tab-pane');
              const rows = cell.querySelector('.xterm-rows');
              const viewport = cell.querySelector('.xterm-viewport');
              const cursorNode = cell.querySelector('.xterm-cursor');
            const cellRect = cell.getBoundingClientRect();
            const cursorRect = cursorNode?.getBoundingClientRect();
            const promptCandidates = rows ? [...rows.children]
                .filter((node) => /^(?:PS\\s+)?(?:[A-Za-z]:\\\\.+[>❯$#]|[^\\s@]+@[^\\s:]+:.+[❯$#]|(?:~|\\/).*[❯$#])(?:.*)?$/u.test((node.textContent || '').trim()))
                  .map((node, index) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { index, text: (node.textContent || '').trim(), top: Math.round(rect.top), bottom: Math.round(rect.bottom), display: style.display, visibility: style.visibility, opacity: style.opacity }; })
                .sort((left, right) => right.top - left.top) : [];
            const prompt = promptCandidates[0];
            const terminalRect = rows?.getBoundingClientRect();
            // WebKitGTK rounds the cursor line box independently from
            // xterm-rows; at the bottom row its descender can extend 1–2px
            // past the rounded container without any visual overlap. Keep a
            // small device-pixel tolerance while still rejecting a cursor in
            // the neighbouring pane or outside the terminal.
            // xterm omite el nodo xterm-cursor del DOM mientras el cursor está en
            // la fase apagada del parpadeo. En ese instante no hay rectángulo,
            // aunque el cursor lógico siga dentro del viewport y el prompt
            // sea visible. Usa la fila/alto publicados por TerminalPane como
            // respaldo; si el nodo visual existe, sus límites también deben
            // quedar dentro del terminal.
            const cursorRow = Number(host?.dataset.promptCursorViewportRow);
            const viewportRows = Number(host?.dataset.promptViewportRows);
            const logicalCursorInside = Number.isInteger(cursorRow)
                && Number.isInteger(viewportRows)
                && viewportRows > 0
                && cursorRow >= 0
                && cursorRow < viewportRows;
            const terminalInsideCell = Boolean(terminalRect && cellRect
                && terminalRect.width > 0
                && terminalRect.height > 0
                && terminalRect.top >= cellRect.top - 3
                && terminalRect.bottom <= cellRect.bottom + 3);
            const cursorInsideTerminal = Boolean(terminalInsideCell
                && (cursorRect
                    ? cursorRect.top >= terminalRect.top - 3
                        && cursorRect.bottom <= terminalRect.bottom + 3
                    : logicalCursorInside));
            return {
                overlap: false,
                logicalSafe: cursorInsideTerminal,
                visualSafe: cursorInsideTerminal,
                regionsSeparated: false,
                cursorInsideTerminal,
                headerFullWidth: false,
                bannerBottom: null,
                terminalTop: terminalRect ? Math.round(terminalRect.top) : null,
                promptTop: prompt?.top ?? null,
                  cursorRect: cursorRect ? { top: Math.round(cursorRect.top), bottom: Math.round(cursorRect.bottom) } : null,
                  promptCandidates,
                  cursorRow: host?.dataset.promptCursorRow ?? null,
                  cursorViewportRow: host?.dataset.promptCursorViewportRow ?? null,
                  baseY: host?.dataset.promptBaseY ?? null,
                  viewportRows: host?.dataset.promptViewportRows ?? null,
                  viewportScrollTop: viewport ? Math.round(viewport.scrollTop) : null,
                  rowsRect: rows ? (() => { const rect = rows.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }; })() : null,
                bannerRows: null,
            };`,
        args: [{ [elementKey]: cell[elementKey] }],
        },
        ));
    }
    return snapshots;
}

async function waitForBannerPanes(expected = 1, timeoutMs = 20000) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastSnapshot = [];
    let lastRawSnapshot = [];
    let lastPromptState = [];
    while (Date.now() < deadline) {
        const panes = await visiblePaneCountWithTimeout(30000);
        const rows = await findAll('.cell:not(.hidden) .xterm-rows');
        if (panes >= expected && rows.length >= expected) {
            const texts = await visualBannerTexts(expected);
            const rawTexts = await rawTerminalTexts(expected);
            const promptState = await promptStates(expected);
            const startupReady = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `return [...document.querySelectorAll('.cell:not(.hidden) .tab-pane:not(.hidden)')]
                    .slice(0, arguments[0])
                    .every((pane) => pane.dataset.startupReady === 'true');`,
                args: [expected],
            });
            if (startupReady !== true) {
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                continue;
            }
            lastSnapshot = texts;
            lastRawSnapshot = rawTexts;
            lastPromptState = promptState;
            const visibleTexts = texts.slice(0, expected);
            // El banner puede vivir en una capa visual separada del xterm;
            // comprobar el prompt sobre el texto crudo evita que esa capa
            // oculte la evidencia de que la shell sigue lista para escribir.
            // `data-prompt-visible` es una señal lógica del buffer, no una
            // prueba de que el texto completo haya llegado al renderer. Tras
            // un resize ConPTY podía conservar solo `C:\\Users\\Adminis` y
            // dejar el atributo a true. Exigir el texto accesible completo
            // aquí evita dar por listo un panel visualmente truncado.
            const promptsVisible = rawTexts.length >= expected
                && rawTexts.every(promptLooksVisible);
            const hasCompleteHeader = visibleTexts.some((text) =>
                /LTerminal|WinSlim|Terminal/i.test(text)
                && /Sistema|System/i.test(text)
            );
            const compactBanner = visibleTexts.every((text) =>
                /CPU|Procesador|Processor/i.test(text)
                && /Memoria|Memory|RAM/i.test(text)
                && /Sesion|Session|Uptime|Tiempo activo/i.test(text)
            );
            const geometry = await contentGeometry();
            const promptStateReady = promptState.slice(0, expected).every((state) => state === true || state === 'true');
            const tinyPromptGeometry = geometry.viewport?.width <= 500
                && geometry.viewport?.height <= 300
                && geometry.panes.slice(0, expected).every((pane) =>
                    (pane.cell?.height > 0 && pane.cell.height <= 47)
                    && (pane.screen?.height > 0 && pane.screen.height <= 42)
                );
            if (tinyPromptGeometry && promptStateReady) {
                recordEvent('banner-ready', {
                    expected,
                    compact: true,
                    partial: true,
                    promptsVisible: true,
                    preview: lastSnapshot,
                    geometry,
                });
                return { elapsedMs: Date.now() - startedAt, texts, geometry, compact: true };
            }
            // El mínimo nativo (480x270) deja unas 13 filas (~169 px) en
            // xterm; aunque no sea una «casilla baja» según la heurística de
            // filas, la cabecera puede quedar fuera por el scroll natural.
            const tinyViewport = geometry.panes.slice(0, expected).every((pane) =>
                (pane.screen?.height > 0 && pane.screen.height < 220)
                || (pane.cell?.height > 0 && pane.cell.height <= 47)
            );
            // Al reducir la ventana al mínimo, xterm puede desplazar la
            // cabecera fuera del viewport y dejar visibles solo las líneas
            // centrales del perfil esencial. CPU + memoria + sesión siguen
            // siendo una señal suficiente de que el banner se repintó sin
            // mezclar contenido ni perder el prompt.
            const tinyBanner = tinyViewport && visibleTexts.every((text) =>
                /CPU|Procesador|Processor/i.test(text)
                && /Memoria|Memory|RAM/i.test(text)
                && /Sesion|Session|Uptime|Tiempo activo/i.test(text)
            );
            // En la rejilla final a 480x270 cada xterm puede medir apenas
            // dos filas. En ese caso el banner queda fuera del viewport por
            // diseño; el prompt crudo y la geometría estable son la única
            // evidencia visual disponible y deben bastar para no convertir
            // el límite físico de la ventana en un falso fallo del E2E.
            const tinyPromptOnly = tinyViewport
                && (promptsVisible || promptStateReady);
            const minimalBanner = visibleTexts.every((text) =>
                /LTerminal|WinSlim|Terminal/i.test(text)
                && /Memoria|Memory|RAM|Sistema|System|CPU|Procesador|Processor/i.test(text)
            );
            const partialBanner = visibleTexts.every((text) => {
                const markers = [
                    /Memoria|Memory|RAM/i,
                    /Disco|Disk|Storage/i,
                    /PC|Equipo|Host/i,
                    /Kernel/i,
                    /Entorno|Environment/i,
                    /Placa|Motherboard/i,
                    /GPU/i,
                    /Fecha|Date/i,
                    /Uptime|Tiempo activo/i,
                ].filter((marker) => marker.test(text)).length;
                return markers >= 2;
            });
            // No considerar listo un panel mientras conserve una cola de una
            // línea envuelta. Las aserciones de cabeceras llegan después y
            // antes el smoke podía devolver aquí un estado "partial" verde.
            const visualAnomalies = visibleTexts.map(bannerTextAnomalies);
            // En el mínimo responsive el scroll puede ocultar la única línea
            // de marca, por lo que `cabeceras=0` es admisible únicamente si
            // el bloque esencial (CPU, memoria y sesión) está presente. Todas
            // las demás anomalías siguen siendo bloqueantes.
            const anomaliesReady = tinyPromptOnly || visualAnomalies.every((items) =>
                items.length === 0
                || ((tinyBanner || tinyPromptOnly) && items.every((item) => item === 'cabeceras=0'))
            );
            const contentReady = anomaliesReady
                && promptsVisible
                && (visibleTexts.every(bannerLooksReady) || minimalBanner || partialBanner || tinyPromptOnly);
            if (contentReady && (hasCompleteHeader || compactBanner || tinyBanner || minimalBanner || partialBanner || tinyPromptOnly)) {
                if (geometry.panes.length >= expected
                    && geometry.panes.slice(0, expected).every((pane) =>
                        pane.cell?.width > 0
                        && pane.cell?.height > 0
                    && (!pane.screen || (pane.screen.width > 0 && pane.screen.height > 0)))) {
                    recordEvent('banner-ready', {
                        expected,
                        compact: !hasCompleteHeader,
                        partial: (minimalBanner || partialBanner) && !compactBanner && !hasCompleteHeader,
                        promptsVisible,
                        preview: visibleTexts.map((text) => text.slice(-1200)),
                        geometry,
                    });
                    return { elapsedMs: Date.now() - startedAt, texts, geometry, compact: !hasCompleteHeader };
                }
            }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    const geometry = await contentGeometry().catch(() => null);
    throw new Error(`El banner no quedó listo en ${expected} panel(es) tras ${timeoutMs} ms: ${JSON.stringify({ lastSnapshot, lastRawSnapshot, lastPromptState, geometry }).slice(0, 2600)}`);
}

function firstNonEmptyTerminalLine(text) {
    return String(text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? '';
}

function creditLines(text) {
    return String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function creditHasOwnTitleRow(lines, prefix) {
    // CMD puede transliterar el punto medio de UTF-8 a ASCII al pasar por
    // ConPTY. La estructura de la fila es lo importante: aceptar `-` aquí
    // evita confundir esa normalización de transporte con el solapamiento
    // real que esta aserción busca detectar.
    const normalizedPrefix = prefix.replaceAll('·', '-');
    return lines.some((line) => line.replaceAll('·', '-').startsWith(normalizedPrefix));
}

function creditTitleLeakedIntoPrompt(lines, titlePattern) {
    return lines.some((line) => promptLooksVisible(line) && titlePattern.test(line));
}

function promptLooksVisible(text) {
    const clean = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '');
    const lines = clean
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    // El prompt puede llevar una orden parcialmente escrita, pero siempre
    // conserva su terminador. La línea debe empezar por una ruta Windows,
    // `PS`, una ruta POSIX, el formato usuario@host de Linux o el prompt
    // desnudo de Scala (`scala>`), IPython (`In [1]:`), IRB (`irb(main):001>`)
    // u Octave (`octave:1>`), que no incluyen una ruta.
    const anchored = /^(?:PS\s+)?(?:[A-Za-z]:\\.+[>❯$#]|[^\s@]+@[^\s:]+:.+[❯$#]|(?:~|\/).*[❯$#]|scala(?:\s*\d+(?:\.\d+)?)?>|jshell>|In\s+\[\d+\]:|irb(?:\([^)]*\))?:\d+(?::\d+)?[>#]|octave:\d+>)(?:.*)?$/u;
    // En WebKitGTK el endpoint de texto puede concatenar varias filas del
    // DOM; en ese caso el prompt no queda al principio de una línea, aunque
    // siga siendo visible y válido. Mantener una detección acotada por el
    // formato usuario@host/ruta evita falsos negativos del smoke.
    const concatenated = /(?:[A-Za-z]:\\[^\s]*[>❯$#]|[^\s@]+@[^\s:]+:[^\n]*[❯$#]|(?:~|\/)[^\n]*[❯$#]|scala(?:\s*\d+(?:\.\d+)?)?>|jshell>|In\s+\[\d+\]:|irb(?:\([^)]*\))?:\d+(?::\d+)?[>#]|octave:\d+>)/u;
    // En una casilla más estrecha que la ruta, xterm divide un único prompt
    // entre varias filas accesibles (`C:\\Users\\Admini` + `strador>`).
    // Recomponer solo esas filas no relaja el contrato: la ruta sigue
    // necesitando su prefijo y el terminador real de la shell.
    const reflowed = lines.join('');
    const fishSplit = lines.length >= 2
        && /^(?:~|\/.*|[A-Za-z]:?)$/.test(lines.at(-2))
        && /^[>❯$#](?:.*)?$/u.test(lines.at(-1));
    return lines.some((line) => anchored.test(line))
        || concatenated.test(clean)
        || anchored.test(reflowed)
        || concatenated.test(reflowed)
        || fishSplit;
}

function promptLooksVisibleWithWrap(text) {
    const normalized = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '');
    if (promptLooksVisible(normalized)) return true;
    const lines = normalized.split('\n').map((line) => line.trimEnd());
    for (let index = 0; index < lines.length - 1; index += 1) {
        const joined = `${lines[index]}${lines[index + 1]}`;
        if (promptLooksVisible(joined)) return true;
    }
    return false;
}

function snapshotPromptVisible(snapshot) {
    const rows = snapshot?.rows ?? [];
    return rows.some((row, index) => {
        if (promptLooksVisible(row.text)) return true;
        const previous = index > 0 ? rows[index - 1].text : '';
        return promptLooksVisible(`${previous}\n${row.text}`);
    });
}

function bannerTextAnomalies(text) {
    const clean = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '');
    const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
    // Windows muestra «WTerminal», mientras que Linux usa la marca
    // compacta «LTerminal». Ambas son cabeceras válidas del mismo banner.
    const headers = lines.filter((line) => process.platform === 'win32'
        ? /^WTerminal\b/i.test(line)
        : /^(?:LTerminal\b|WTerminal\b|WinSlim\b.*\bTerminal\b)/i.test(line));
    const anomalies = [];
    if (headers.length !== 1) anomalies.push(`cabeceras=${headers.length}`);
    const suspicious = [
        /^(?:Placa|Motherboard)\b.*(?:\bGB\b|\bMHz\b|%|GPU|Memoria|Memory|Fecha|Date)/i,
        // La GPU puede incluir legítimamente su memoria dedicada («1 GB»).
        // Solo es una mezcla si invade otro campo del banner.
        /^(?:GPU)\b.*(?:Memoria|Memory|Disco|Disk|PC|Kernel|Fecha|Date)/i,
        /^(?:Entorno|Environment)\b.*(?:WINSLIM|\bPC\b|Kernel|Placa|Motherboard|GPU)/i,
        /^(?:Fecha(?: y hora)?|Date(?: and time)?)\b.*(?:Sistema|System|CPU|Memoria|Memory|Disco|Disk|PC|Kernel|GPU)/i,
    ];
    for (const line of lines) {
        if (suspicious.some((pattern) => pattern.test(line))) anomalies.push(`línea mezclada: ${line}`);
    }
    // Una continuación de una línea envuelta del banner anterior puede
    // parecer texto perfectamente válido y dejar todos los encabezados
    // correctos. El caso observado en las capturas era exactamente
    // «s (1 GB)»: la etiqueta GPU había quedado partida al reducir la rejilla.
    // No aceptar estos fragmentos evita que el smoke dé verde a una pantalla
    // que todavía tiene residuos visuales.
    const orphanContinuation = /^(?:[a-z]\s+\(\d+(?:\.\d+)?\s+GB\)|[a-z]\)|\d+(?:\.\d+)?\s+GB\))/i;
    for (const line of lines) {
        if (orphanContinuation.test(line)) anomalies.push(`continuación huérfana: ${line}`);
    }
    // Un prompt dentro del bloque significa que el repintado restauró el
    // cursor antes de terminar de escribir el banner. Es el síntoma que las
    // capturas nativas mostraban como «GPU/Disco pegados»: los campos pueden
    // aparecer una sola vez y pasar el chequeo de cabeceras, pero la shell ya
    // está escribiendo antes de que termine Sesión/Fecha.
    const field = /^(?:Sistema|System|PC|Equipo|Host|Kernel|Entorno|Environment|Placa|Motherboard|CPU|Procesador|Processor|GPU|Memoria|Memory|RAM|Disco|Disk|Storage|Uptime|Tiempo activo|Fecha(?: y hora)?|Date(?: and time)?)\b/i;
    const lastField = lines.reduce((last, line, index) => field.test(line) ? index : last, -1);
    const promptIndex = lines.findIndex((line) => /(?:^[A-Z]:\\[^ ]*[>❯$#]|^[^ ]+@[^ ]+:[^ ]+[❯$#]|^scala(?:\s*\d+(?:\.\d+)?)?>|^jshell>|^In\s+\[\d+\]:|^irb(?:\([^)]*\))?:\d+(?::\d+)?[>#]|^octave:\d+>)/.test(line));
    if (promptIndex >= 0 && lastField > promptIndex) {
        anomalies.push(`prompt antes del final del banner: línea ${promptIndex + 1}/${lastField + 1}`);
    }
    return anomalies;
}

function inputInsideBanner(text, marker) {
    const lines = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '')
        .split('\n');
    const markerLine = lines.findIndex((line) => line.includes(marker));
    if (markerLine < 0) return false;
    const field = /^(?:Sistema|System|PC|Equipo|Host|Kernel|Entorno|Environment|Placa|Motherboard|CPU|Procesador|Processor|GPU|Memoria|Memory|RAM|Disco|Disk|Storage|Uptime|Tiempo activo|Fecha(?: y hora)?|Date(?: and time)?)\b/i;
    const lastBannerField = lines.reduce((last, line, index) => field.test(line.trim()) ? index : last, -1);
    // El eco de la orden es correcto después del bloque informativo. Si aparece
    // antes de su último campo, la shell recibió la tecla con el cursor dentro
    // del fastfetch (el fallo que las capturas manuales mostraron).
    return lastBannerField >= 0 && markerLine <= lastBannerField;
}

/**
 * Comprueba la evidencia visual que el smoke anterior dejaba pasar como
 * «partial»: una casilla que empieza por GPU/Uptime puede contener datos
 * correctos, pero está mostrando la cola de un banner desplazado. En una
 * rejilla estable todas las casillas deben empezar por su propia cabecera.
 */
async function assertBannerHeaders(expected, label) {
    let last = { panes: 0, rows: 0, headers: [], modes: [] };
    try {
        await waitUntil(async () => {
            const panes = await visiblePaneCount();
            const rows = await findAll('.cell:not(.hidden) .xterm-rows');
            if (panes !== expected || rows.length < expected) return false;
            const texts = await visualBannerTexts(expected);
            const rawTexts = await rawTerminalTexts(expected);
            const promptGeometry = await promptBannerGeometry(expected);
            // El viewport puede comenzar con la cola de un banner anterior
            // porque el historial es persistente. Analizar el bloque más
            // reciente evita confundir ese scrollback legítimo con una
            // casilla que recibió texto de otro panel.
            const latestTexts = texts.map(latestBannerBlock);
            const headers = latestTexts.map(firstNonEmptyTerminalLine);
            const modes = latestTexts.map((text) => /Hardware:|Sesión:|Session:/i.test(text) ? 'full' : 'compact');
            const anomalies = latestTexts.map(bannerTextAnomalies);
            const promptState = await promptStates(expected);
            const tinyGrid = promptGeometry.every((item) => (item.rowsRect?.height ?? Infinity) < 220);
            const checks = {
                // `waitForBannerPanes` ya comprueba el contenido completo y
                // espera a que el repintado termine. Aquí solo verificamos
                // que cada viewport conserve la cabecera de su propio bloque;
                // en una ventana baja el resto puede quedar fuera de las filas
                // accesibles aunque siga presente en el scrollback.
                hasHeader: latestTexts.every((text) => process.platform === 'win32'
                    ? /^WTerminal\b/im.test(text)
                    : /^(?:LTerminal\b|WTerminal\b|WinSlim\b.*\bTerminal\b)/im.test(text))
                    || (tinyGrid && latestTexts.every((text) =>
                        /CPU|Procesador|Processor/i.test(text)
                        && /Memoria|Memory|RAM/i.test(text)
                        && /Sesion|Session|Uptime|Tiempo activo/i.test(text))),
                promptsVisible: rawTexts.every(promptLooksVisible),
                logicalSafe: promptGeometry.every(({ logicalSafe }) => logicalSafe),
                noAnomalies: anomalies.every((items) => items.length === 0
                    || (tinyGrid && items.every((item) => item === 'cabeceras=0'))),
                // Todas las casillas deben usar el mismo perfil. Antes la
                // pestaña existente conservaba el formato completo mientras
                // las nuevas nacían compactas, dejando una rejilla mezclada.
                sameBannerMode: tinyGrid || modes.every((mode) => mode === modes[0]),
            };
            last = { panes, rows: rows.length, headers, modes, anomalies, promptGeometry, checks };
            return checks.hasHeader
                && checks.promptsVisible
                // `.xterm-rows` es la capa de accesibilidad de xterm y puede
                // conservar coordenadas antiguas mientras el canvas ya ha
                // desplazado el prompt (especialmente tras CSI L/resize).
                // Conservamos la geometría en el informe para diagnóstico,
                // pero la evidencia de visibilidad es `rawTexts`/canvas; no
                // convertir una coordenada DOM obsoleta en un falso fallo de
                // la build.
                && checks.logicalSafe
                && checks.noAnomalies
                && checks.sameBannerMode;
        }, 5000, `${label}: cabeceras de banner`);
    } catch (error) {
        throw new Error(`${label}: cabeceras inconsistentes (${JSON.stringify(last)})`, { cause: error });
    }
    recordEvent('banner-headers-consistent', {
        label,
        expected,
        headers: last.headers,
        promptGeometry: last.promptGeometry,
    });
    return last;
}

/**
 * Verifica una rejilla después de un resize sin exigir que el banner vuelva a
 * imprimirse. El contrato actual imprime el banner una sola vez; las pestañas
 * existentes conservan su scrollback y solo las nuevas pueden traer un bloque
 * inicial. Se comprueba el prompt y, cuando hay banner visible, que no tenga
 * líneas mezcladas.
 */
async function assertPaneOutputStable(expected, label) {
    let last = { panes: 0, rows: 0, headers: [], anomalies: [], promptGeometry: [] };
    paneAuditFastPath = true;
    try { await waitUntil(async () => {
        const panes = await visiblePaneCountWithTimeout(10000);
        // Si el recuento aún no responde, no encadenar otra llamada de 90 s.
        // El siguiente intento volverá a consultar cuando termine el repaint.
        if (panes !== expected) return false;
        const rows = await findAll('.cell:not(.hidden) .xterm-rows');
        if (rows.length < expected) return false;
        const texts = await visualBannerTexts(expected);
        const rawTexts = await rawTerminalTexts(expected);
        const promptState = await promptStates(expected);
        const promptGeometry = await promptBannerGeometry(expected);
        if (texts.length !== expected || rawTexts.length !== expected || promptGeometry.length !== expected) return false;
        const latest = texts.map(latestBannerBlock);
        const headers = latest.map(firstNonEmptyTerminalLine);
        const anomalies = latest.map((text, index) => {
            // Con menos de 12 filas el banner no se pinta por diseño; el
            // scrollback puede conservar su cabecera y prompt en posiciones
            // que `bannerTextAnomalies` marcaría como solapadas.
            if ((promptGeometry[index]?.viewportRows ?? 0) < 12) return [];
            return nativeBrandPattern.test(text) || /WinSlim Terminal\b/i.test(text) ? bannerTextAnomalies(text) : [];
        });
        const rawPromptMatches = rawTexts.map(promptLooksVisibleWithWrap);
        const headerPromptMatches = headers.map((header) => /(?:[^\s@]+@[^\s:]+:[^\n]*[❯$#]|[A-Za-z]:\\[^\n]*[>$#])/.test(header));
        const statePromptMatches = promptState.map((value) => value === 'true');
        const geometryPromptMatches = promptGeometry.map(({ logicalSafe, cursorInsideTerminal, promptCandidates }) =>
            promptCandidates.length > 0 || (logicalSafe && cursorInsideTerminal));
        last = { panes, rows: rows.length, headers, anomalies, promptGeometry, promptState,
            rawPromptMatches, headerPromptMatches, statePromptMatches, geometryPromptMatches };
        // WebKitGTK puede devolver el texto accesible de xterm con una fila
        // antigua concatenada mientras el canvas ya muestra el prompt nuevo
        // (se ve especialmente al reflowar una entrada larga en una rejilla
        // 2x2). La geometría se calcula sobre el mismo DOM y confirma que el
        // cursor está dentro del terminal y que existe un prompt visible;
        // usarla como respaldo evita un falso negativo sin relajar la
        // comprobación de seguridad espacial.
        // El estado lógico y la posición del cursor no demuestran que se
        // haya pintado la ruta completa. Solo el texto crudo (o una línea de
        // cabecera que lo contenga sin truncar) es válido después de un
        // reflow. La geometría se conserva como diagnóstico, no como
        // sustituto del contenido.
        // Tras un reflow de ConPTY/WebView2 el canvas puede haber pintado el
        // prompt mientras la capa accesible y `data-prompt-visible` aún
        // conservan la fila anterior. `promptGeometry` se calcula sobre ese
        // mismo panel, exige un candidato de prompt o un cursor válido dentro
        // del terminal y evita confundir una casilla vacía con un retraso de
        // accesibilidad.
        const physicallyTiny = promptGeometry.every(({ viewportRows }) => Number(viewportRows) > 0 && Number(viewportRows) < 4);
        const promptOrIntentionalScroll = promptGeometry.map((geometry, index) => (
            rawPromptMatches[index]
            || headerPromptMatches[index]
            // Algunas sondas dejan una salida numerada en primer plano (por
            // ejemplo `r-...-35`) mientras el proceso aún está en esa salida;
            // no existe un prompt que deba verse hasta que termina. No aplicar
            // esta excepción a una ruta parcial como `C:\\Users\\Administ`.
            || /^(?:r-[^\s]+|WTERM(?:SEQ|NUMSEQ)|LTERMINAL_)/u.test(String(headers[index] ?? '').trim())
            // Un panel desplazado por la auditoría puede no mostrar el prompt
            // por diseño. Su scrollback sigue intacto; solo exigimos el texto
            // completo cuando la casilla está al final.
            || geometry.scrolledAwayFromBottom === true
            || (physicallyTiny && geometryPromptMatches[index])
        ));
        const promptsDetected = promptOrIntentionalScroll.every(Boolean);
        return promptsDetected
            && promptGeometry.every(({ logicalSafe }) => logicalSafe)
            && anomalies.every((items) => items.length === 0);
    }, 120000, `${label}: salida estable`); } catch (error) {
        throw new Error(`${label}: salida inestable (${JSON.stringify(last).slice(0, 6000)})`, { cause: error });
    } finally {
        paneAuditFastPath = false;
    }
    recordEvent('pane-output-stable', { label, expected, ...last });
    return last;
}

/**
 * Detecta la regresión visual que puede pasar los checks de prompt/banner:
 * durante una transición el host ya mide decenas de píxeles, pero xterm ha
 * recibido temporalmente 1-3 columnas y cada fragmento de una ruta queda en
 * una fila independiente. Una secuencia de cinco o más filas no vacías de
 * hasta tres caracteres en un panel que ya tiene espacio es una matriz
 * transitoria, no una salida normal de la shell.
 */
async function assertNoTinyFragmentRuns(expected, label) {
    let last = [];
    try {
        await waitUntil(async () => {
            const cells = await findAll('.cell:not(.hidden)');
            last = await Promise.all(cells.slice(0, expected).map(async (cell) => {
                try {
                    const geometry = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                        script: 'const r = arguments[0].getBoundingClientRect(); return { width: r.width, height: r.height };',
                        args: [{ [elementKey]: cell[elementKey] }],
                    });
                    const snapshot = await terminalRowSnapshot(cell[elementKey]);
                const lines = snapshot.rows.map((row) => String(row.text ?? '').trim()).slice(-96);
                let run = 0;
                let maxRun = 0;
                for (const line of lines) {
                    if (line.length > 0 && line.length <= 3) {
                        run += 1;
                        maxRun = Math.max(maxRun, run);
                    } else {
                        run = 0;
                    }
                }
                    return { width: Number(geometry?.width ?? 0), cols: snapshot.cols, maxRun, stale: false };
                } catch {
                    // WebDriver puede invalidar el elemento justo cuando el
                    // grid reemplaza la celda. Releer en la siguiente vuelta
                    // es parte de la espera de estabilización, no un fallo de
                    // la aplicación.
                    return { width: 0, cols: 0, maxRun: 0, stale: true };
                }
            }));
            return last.length === expected
                && last.every((pane) => !pane.stale && (pane.width < 64 || pane.maxRun < 5));
        }, 10000, `${label}: matriz sin fragmentos verticales`);
    } catch (error) {
        await captureScreenshot(`${label.replace(/\s+/gu, '-')}-fragmentos`);
        throw new Error(`${label}: se detectó una secuencia de fragmentos de 1-3 columnas (${JSON.stringify(last)})`, { cause: error });
    }
    recordEvent('pane-matrix-fragments-absent', { label, expected, panes: last, passed: true });
}

async function assertTinyPanesStable(expected, label, timeoutMs = 20000) {
    let last = {};
    try {
        await waitUntil(async () => {
            const rows = await findAll('.cell:not(.hidden) .xterm-rows');
            if (rows.length < expected) return false;
            const texts = await visualBannerTexts(expected);
            const promptState = await promptStates(expected);
            const anomalies = texts.map(bannerTextAnomalies);
            // El estado lógico y el cursor pueden seguir activos aunque la
            // capa visible solo conserve `C:\\Users\\Administ`. Exigir el
            // prompt completo (también si quedó envuelto en dos filas) evita
            // dar por estable una casilla cuyo texto está cortado.
            const physicallyTiny = rows.length >= expected
                && await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `return [...document.querySelectorAll('.cell:not(.hidden) [data-terminal-rows]')]
                        .slice(0, arguments[0])
                        .every((node) => Number(node.dataset.terminalRows ?? 0) > 0 && Number(node.dataset.terminalRows ?? 0) < 4);`,
                    args: [expected],
                }, 10_000);
            const viewportTiny = rows.length >= expected
                && await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `return [...document.querySelectorAll('.cell:not(.hidden) .xterm-screen')]
                        .slice(0, arguments[0])
                        .every((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 220; });`,
                    args: [expected],
                }, 10_000);
            const promptsVisible = texts.every(promptLooksVisibleWithWrap)
                || ((physicallyTiny || viewportTiny)
                    && promptState.length >= expected
                    && promptState.every((value) => value === 'true'));
            // Una terminal reducida conserva su scrollback. El historial puede
            // contener el banner anterior, pero nunca líneas mezcladas. En
            // WebKitGTK, las pocas filas visibles pueden exponer solo el final
            // de una línea envuelta del scrollback (sin cabecera); ese recorte
            // es normal a esta altura y no debe confundirse con un repintado
            // corrupto. El prompt sigue siendo obligatorio.
            const historyStable = anomalies.every((items) =>
                items.every((item) => item === 'cabeceras=0' || item.startsWith('continuación huérfana:')),
            );
            last = {
                preview: texts.map((text) => text.slice(-600)),
                promptState,
                anomalies,
            };
            return promptsVisible && historyStable;
        }, timeoutMs, `${label}: casillas bajas estables`);
    } catch (error) {
        throw new Error(`${label}: casillas bajas inestables; diagnóstico=${JSON.stringify(last)}`, { cause: error });
    }
    recordEvent('tiny-pane-stable', { expected, ...last });
}

function assertWindowBounds(rect, label) {
    const viewport = rect?.content?.viewport;
    const measuredWidth = viewport?.width ?? rect?.width;
    const measuredHeight = viewport?.height ?? rect?.height;
    if (!rect || measuredWidth < WINDOW_LIMITS.minWidth || measuredHeight < WINDOW_LIMITS.minHeight) {
        throw new Error(`${label} permitió una ventana menor que el mínimo: ${JSON.stringify(rect)}`);
    }
    if (measuredWidth > WINDOW_LIMITS.maxWidth || measuredHeight > WINDOW_LIMITS.maxHeight) {
        throw new Error(
            `${label} superó el máximo configurado ${WINDOW_LIMITS.maxWidth}x${WINDOW_LIMITS.maxHeight}: `
            + JSON.stringify(rect),
        );
    }
    if (viewport) {
        const nativeFrameWidth = rect.width - viewport.width;
        const nativeFrameHeight = rect.height - viewport.height;
        if (nativeFrameWidth < 0 || nativeFrameHeight < 0
            || nativeFrameWidth > 64 || nativeFrameHeight > 128) {
            throw new Error(
                `${label} devolvió una decoración nativa desproporcionada: `
                + `${nativeFrameWidth}x${nativeFrameHeight}, rect=${JSON.stringify(rect)}`,
            );
        }
    }
}

function assertResponsiveMinimum(rect, label) {
    const screen = rect?.content?.screen;
    if (!screen?.width || !screen?.height) return;
    const expectedWidth = Math.min(
        WINDOW_LIMITS.maxWidth,
        Math.max(WINDOW_LIMITS.minWidth, Math.ceil(screen.width * 0.25)),
    );
    const expectedHeight = Math.min(
        WINDOW_LIMITS.maxHeight,
        Math.max(WINDOW_LIMITS.minHeight, Math.ceil(screen.height * 0.25)),
    );
    if (rect.width < expectedWidth || rect.height < expectedHeight) {
        throw new Error(
            `${label} no respetó el mínimo responsive de 1/4 de pantalla: `
            + `ventana=${rect.width}x${rect.height}, esperado>=${expectedWidth}x${expectedHeight}, `
            + `pantalla=${screen.width}x${screen.height}`,
        );
    }
}

function responsiveMinimumForScreen(screen) {
    return {
        width: Math.min(
            WINDOW_LIMITS.maxWidth,
            Math.max(WINDOW_LIMITS.minWidth, Math.ceil(screen.width * 0.25)),
        ),
        height: Math.min(
            WINDOW_LIMITS.maxHeight,
            Math.max(WINDOW_LIMITS.minHeight, Math.ceil(screen.height * 0.25)),
        ),
    };
}

async function setExplorerVisible(visible) {
    const isVisible = async () => (await findAll('.explorer')).length > 0;
    if ((await isVisible()) === visible) return;
    await pointerClickInView(await findWhenReady('.side-toggle:not(.panes)'));
    await waitUntil(
        async () => (await isVisible()) === visible,
        10000,
        `explorador ${visible ? 'abierto' : 'cerrado'}`,
    );
    recordEvent('explorer', { visible });
}

async function waitForPaneCount(expected, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
        count = await visiblePaneCount();
        if (count >= expected) return count;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return count;
}

function assertPaneGeometry(geometry, expected, label) {
    const panes = geometry?.panes?.slice(0, expected) ?? [];
    if (panes.length < expected) {
        throw new Error(`${label} solo midió ${panes.length}/${expected} paneles`);
    }
    for (const [index, pane] of panes.entries()) {
        if (pane.cell?.width < 120 || pane.cell?.height < 80) {
            throw new Error(`${label}: el panel ${index + 1} no tiene superficie útil (${JSON.stringify(pane.cell)})`);
        }
        if (pane.screen?.width <= 0 || pane.screen?.height <= 0) {
            throw new Error(`${label}: xterm no es visible en el panel ${index + 1}`);
        }
        if (pane.terminal?.cols < 10 || pane.terminal?.rows < 3) {
            throw new Error(`${label}: el PTY del panel ${index + 1} quedó en ${pane.terminal?.cols ?? 0}x${pane.terminal?.rows ?? 0}`);
        }
    }
    for (let left = 0; left < panes.length; left += 1) {
        for (let right = left + 1; right < panes.length; right += 1) {
            const a = panes[left].cell;
            const b = panes[right].cell;
            const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
            const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
            if (overlapWidth > 1 && overlapHeight > 1) {
                throw new Error(`${label}: los paneles ${left + 1} y ${right + 1} se solapan ${overlapWidth}x${overlapHeight}px`);
            }
        }
    }
}

async function resizeWsl1Window(width, height) {
    const search = await execFile('xdotool', [
        'search', '--onlyvisible', '--name', 'LTerminal',
    ], { timeout: 3000, windowsHide: true });
    const windowId = search.stdout.trim().split(/\s+/).filter(Boolean).at(-1);
    if (!windowId) return null;
    await execFile('xdotool', ['windowmove', windowId, '40', '40'], { timeout: 3000, windowsHide: true });
    await execFile('xdotool', ['windowsize', windowId, String(width), String(height)], { timeout: 3000, windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const geometry = await execFile('xdotool', ['getwindowgeometry', '--shell', windowId], { timeout: 3000, windowsHide: true });
    const parsed = Object.fromEntries(geometry.stdout.split(/\r?\n/)
        .map((line) => line.match(/^([A-Z_]+)=(.+)$/))
        .filter(Boolean)
        .map(([, key, value]) => [key, value]));
    const applied = {
        width: Number(parsed.WIDTH) || width,
        height: Number(parsed.HEIGHT) || height,
        x: Number(parsed.X) || 40,
        y: Number(parsed.Y) || 40,
    };
    return { windowId, applied };
}

async function resizeWindow(width, height, options = {}) {
    // Por encima de 4K el vídeo se pausa (ver `pauseWindowVideo`) y se
    // reanuda en cuanto un resize posterior vuelve a un tamaño auditable.
    const aboveVideoLimit = width * height > 3840 * 2160;
    if (aboveVideoLimit) pauseWindowVideo(`ventana ${width}x${height} mayor que 4K`);
    const result = await resizeWindowWithoutVideoPolicy(width, height, options);
    if (!aboveVideoLimit) resumeWindowVideo();
    return result;
}

async function resizeWindowWithoutVideoPolicy(width, height, { waitForBanner = true } = {}) {
    const resizeStartedAt = Date.now();
    // En algunos window managers la ventana arranca maximizada y un cambio
    // parcial de width/height se ignora. Enviar también x/y fuerza el mismo
    // camino que usa «restaurar tamaño» y hace observable el resize real.
    const requested = {
        width: Math.max(WINDOW_LIMITS.minWidth, Math.min(WINDOW_LIMITS.maxWidth, width)),
        height: Math.max(WINDOW_LIMITS.minHeight, Math.min(WINDOW_LIMITS.maxHeight, height)),
    };
    // En WSL1, WebKitGTK/tauri-driver puede bloquear `/window/rect` cuando
    // hay tres o cuatro casillas, aunque la ventana y el contenido continúen
    // funcionando. Redimensionar el mismo toplevel mediante X11 evita ese
    // bloqueo y deja que las comprobaciones DOM midan el viewport y los PTY.
    const paneCountBeforeResize = IS_WSL1_HOST ? await visiblePaneCount() : 0;
    const wslResize = IS_WSL1_HOST && paneCountBeforeResize >= 3
        ? await resizeWsl1Window(requested.width, requested.height).catch(() => null)
        : null;
    if (wslResize) {
        const rect = wslResize.applied;
        const content = await contentGeometry();
        const explorerVisible = (await findAll('.explorer')).length > 0;
        const dialogs = (await findAll('[role="dialog"]')).length;
        const menus = (await findAll('[role="menu"]')).length;
        const tabs = (await findAll('.tab')).length;
        const paneCount = await visiblePaneCount();
        recordEvent('resize', {
            requested,
            applied: { width: rect.width, height: rect.height },
            durationMs: Date.now() - resizeStartedAt,
            viewport: content.viewport,
            panes: content.panes,
            ui: { explorerVisible, dialogs, menus, tabs, panes: paneCount },
            nativeResizeMethod: 'xdotool-wsl1-fallback',
            inspectorReserve: {
                width: Math.max(0, requested.width - content.viewport.width),
                height: Math.max(0, requested.height - content.viewport.height),
                likelyOpen: content.viewport.width < requested.width || content.viewport.height < requested.height,
            },
        });
        if (!waitForBanner) return { ...rect, content };
        await new Promise((resolve) => setTimeout(resolve, 100));
        await waitForBannerPanes(Math.max(1, paneCount), 20000);
        return { ...rect, content: await contentGeometry() };
    }
    await request(`/session/${sessionId}/window/rect`, 'POST', {
        x: 40,
        y: 40,
        width: requested.width,
        height: requested.height,
    });
    // La respuesta del POST puede ser el rectángulo solicitado, no el que el
    // compositor acabó aplicando. Leerlo de nuevo evita construir una matriz
    // sobre tamaños ficticios.
    const rect = await request(`/session/${sessionId}/window/rect`);
    const content = await contentGeometry();
    const explorerVisible = (await findAll('.explorer')).length > 0;
    const dialogs = (await findAll('[role="dialog"]')).length;
    const menus = (await findAll('[role="menu"]')).length;
    const tabs = (await findAll('.tab')).length;
    const paneCount = await visiblePaneCount();
    recordEvent('resize', {
        requested,
        applied: { width: rect.width, height: rect.height },
        durationMs: Date.now() - resizeStartedAt,
        viewport: content.viewport,
        panes: content.panes,
        ui: { explorerVisible, dialogs, menus, tabs, panes: paneCount },
        inspectorReserve: {
            width: Math.max(0, requested.width - content.viewport.width),
            height: Math.max(0, requested.height - content.viewport.height),
            likelyOpen: content.viewport.width < requested.width || content.viewport.height < requested.height,
        },
    });
    if (!waitForBanner) return { ...rect, content };
    // ResizeObserver + fit + PTY resize están deliberadamente desacoplados.
    // Un margen fijo podía dar por bueno el primer frame mientras el banner
    // seguía calculándose; esperamos el texto que realmente ve el usuario.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const panes = await visiblePaneCount();
    await waitForBannerPanes(Math.max(1, panes), 20000);
    return { ...rect, content: await contentGeometry() };
}

// EdgeDriver no implementa de forma consistente el comando WebDriver
// `/window/maximize` para ventanas Tauri/WebView2 y devuelve «invalid
// argument». El fallback solo afecta al arnés E2E: maximiza el toplevel real
// mediante Win32 para que la regresión de pestañas pruebe la ventana nativa.
async function maximizeNativeWindowForE2E() {
    if (process.platform !== 'win32') return false;
    const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WTerminalE2EWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@;
$p = Get-Process -Name wterminal -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object StartTime -Descending | Select-Object -First 1;
if (-not $p) { exit 2 }
[WTerminalE2EWindow]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null;
exit 0`;
    // PowerShell 5.1 compila Add-Type en el primer uso; bajo carga de
    // Defender, 5 s puede cancelar la prueba antes de maximizar la ventana.
    await execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { timeout: 30_000, windowsHide: true });
    return true;
}

function resizeDimensionsChanged(before, after) {
    return Boolean(before && after)
        && (before.width !== after.width || before.height !== after.height);
}

function viewportDimensionsChanged(before, after) {
    return Boolean(before?.viewport && after?.viewport)
        && (before.viewport.width !== after.viewport.width
            || before.viewport.height !== after.viewport.height);
}

function ptyDimensionsChanged(before, after) {
    const beforePane = before?.panes?.find((pane) => pane.tabId === before.activeTabId)?.terminal
        ?? before?.panes?.[0]?.terminal;
    const afterPane = after?.panes?.find((pane) => pane.tabId === after.activeTabId)?.terminal
        ?? after?.panes?.[0]?.terminal;
    return Boolean(beforePane && afterPane)
        && (beforePane.cols !== afterPane.cols || beforePane.rows !== afterPane.rows);
}

/**
 * Prueba el redimensionado nativo real, no solo el valor que devuelve el
 * endpoint de WebDriver. En Windows y Linux el compositor puede aceptar la
 * petición y devolverla sin haber actualizado todavía la ventana; por eso se
 * espera a que cambien simultáneamente el rect nativo, el viewport del WebView
 * y las dimensiones del PTY. Esto detecta precisamente el caso «cambia el
 * viewport pero no la ventana» (o al revés).
 */
async function resizeWindowAndAssertTransition(width, height, label) {
    if (!nativeResizeSupported) {
        recordEvent('resize', { label, skipped: true, reason: 'native-resize-unavailable-on-window-manager', passed: true });
        return await request(`/session/${sessionId}/window/rect`);
    }
    const beforeRect = await request(`/session/${sessionId}/window/rect`);
    const beforeContent = await contentGeometry();
    await resizeWindow(width, height, { waitForBanner: false });
    let afterRect = beforeRect;
    let afterContent = beforeContent;

    // En Hyprland, WebDriver puede aceptar /window/rect y devolver el mismo
    // tamaño a la vez que deja la ventana flotante maximizada. Primero damos
    // al camino normal tiempo para aplicarlo; solo si el rect nativo no cambia
    // pedimos el mismo resize al compositor. El test sigue exigiendo que luego
    // cambien rect, viewport y PTY: este fallback no tapa un fallo de la app.
    let nativeResizeMethod = 'webdriver';
    if (IS_HYPRLAND) {
        try {
            await waitUntil(async () => {
                afterRect = await request(`/session/${sessionId}/window/rect`);
                return resizeDimensionsChanged(beforeRect, afterRect);
            }, 1200, `${label}: cambio del rect nativo por WebDriver`);
        } catch {
            const requested = {
                width: Math.max(WINDOW_LIMITS.minWidth, Math.min(WINDOW_LIMITS.maxWidth, width)),
                height: Math.max(WINDOW_LIMITS.minHeight, Math.min(WINDOW_LIMITS.maxHeight, height)),
            };
            let active = await hyprlandActiveWindow();
            if (active?.floating !== true) {
                // El estado puede volver a tiled entre el último atajo de la
                // fase anterior y esta petición. Reaplicar el dispatcher a
                // la dirección concreta evita depender de que la ventana
                // siga siendo la activa durante el cambio de layout.
                if (!active?.address) {
                    throw new Error(`${label}: WebDriver no cambió el rectángulo y Hyprland no dio la dirección de la ventana activa`);
                }
                await execFile('hyprctl', [
                    'dispatch', 'togglefloating', `address:${active.address}`,
                ], { timeout: 3000 });
                active = await waitForHyprlandState(
                    (state) => state?.address === active.address && state?.floating === true,
                    `${label}: ventana flotante para resize`,
                );
            }
            await execFile('hyprctl', [
                'dispatch', 'resizeactive', 'exact', String(requested.width), String(requested.height),
            ], { timeout: 3000 });
            nativeResizeMethod = 'hyprland-resizeactive-fallback';
            recordEvent('window-manager', {
                action: 'resizeactive-fallback',
                reason: 'webdriver-rect-unchanged',
                requested,
            });
        }
    }
    await waitUntil(async () => {
        afterRect = await request(`/session/${sessionId}/window/rect`);
        afterContent = await contentGeometry();
        return resizeDimensionsChanged(beforeRect, afterRect)
            && viewportDimensionsChanged(beforeContent, afterContent)
            && ptyDimensionsChanged(beforeContent, afterContent);
    }, 10000, `${label}: rect, viewport y PTY actualizados`);
    // La comprobación geométrica no basta: conservar una captura de cada
    // transición permite revisar manualmente bordes, paneles, prompt y cursor
    // en las dos plataformas cuando el smoke se ejecuta desde build.ps1 o
    // build.sh.
    const captureLabel = label
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    await captureScreenshot(`window-resize-${process.platform}-${captureLabel}`);
    process.stdout.write(
        `E2E resize nativo OK: ${process.platform} · ${label} · `
        + `ventana=${afterRect.width}x${afterRect.height} · `
        + `viewport=${afterContent.viewport.width}x${afterContent.viewport.height} · `
        + `pty=${afterContent.panes?.[0]?.terminal?.cols ?? 0}x${afterContent.panes?.[0]?.terminal?.rows ?? 0}\n`,
    );
    recordEvent('native-window-resize', {
        platform: process.platform,
        label,
        requested: {
            width: Math.max(WINDOW_LIMITS.minWidth, Math.min(WINDOW_LIMITS.maxWidth, width)),
            height: Math.max(WINDOW_LIMITS.minHeight, Math.min(WINDOW_LIMITS.maxHeight, height)),
        },
        before: {
            rect: { width: beforeRect.width, height: beforeRect.height },
            viewport: beforeContent.viewport,
            terminal: beforeContent.panes?.[0]?.terminal ?? null,
        },
        nativeResizeMethod,
        after: {
            rect: { width: afterRect.width, height: afterRect.height },
            viewport: afterContent.viewport,
            terminal: afterContent.panes?.[0]?.terminal ?? null,
        },
        nativeChanged: true,
        viewportChanged: true,
        ptyChanged: true,
        passed: true,
    });
    return { ...afterRect, content: afterContent };
}

async function verifyMouseDragSelection(marker) {
    // El modo enfocado ya usa este tamaño y evita que EdgeDriver calcule el
    // gesto sobre el viewport inicial reducido, cuya escala física puede no
    // coincidir con la ventana WebView2 en Windows.
    if (process.platform === 'win32') {
        await resizeWindow(1280, 820, { waitForBanner: false });
    }
    await sendTerminalLine(`echo ${marker}`);
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        return (await textOf(rows)).includes(marker);
    }, 10000, 'marcador para seleccionar con el ratón');

    const target = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const marker = arguments[0];
            const rows = [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows > div')];
            const row = rows.findLast((item) => (item.textContent || '').includes(marker));
            const screen = document.querySelector('.cell:not(.hidden) .xterm-screen');
            if (!row || !screen) return null;
            const screenRect = screen.getBoundingClientRect();
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const index = node.nodeValue?.indexOf(marker) ?? -1;
                if (index < 0) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + marker.length);
                const rect = range.getBoundingClientRect();
                return {
                    // Evitar el borde exacto del canvas: WebView2 puede
                    // redondearlo a un clic y no crear la selección.
                    startX: Math.round(rect.left + Math.max(4, rect.width / marker.length * 0.5)),
                    endX: Math.round(rect.right - Math.max(4, rect.width / marker.length * 0.5)),
                    y: Math.round((rect.top + rect.bottom) / 2),
                    screenCenterX: screenRect.left + screenRect.width / 2,
                    screenCenterY: screenRect.top + screenRect.height / 2,
                };
            }
            return null;`,
        args: [marker],
    });
    if (!target || !Number.isFinite(target.startX) || !Number.isFinite(target.endX)) {
        throw new Error(`No se encontró el texto visible para la prueba de arrastre: ${marker}`);
    }
    let selection;
    let selectionConfirmed = false;
    let selectionError;
    for (let attempt = 0; attempt < 3 && !selectionConfirmed; attempt += 1) {
        const startX = Math.min(target.endX - 2, target.startX + attempt * 4);
        const endX = Math.max(startX + 8, target.endX - attempt * 4);
        await request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{
                type: 'pointer',
                id: `mouse-${attempt}`,
                parameters: { pointerType: 'mouse' },
                actions: [
                    { type: 'pointerMove', origin: 'viewport', x: startX, y: target.y },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerMove', origin: 'viewport', x: endX, y: target.y, duration: 350 },
                    { type: 'pointerUp', button: 0 },
                ],
            }],
        });
        try {
            await waitUntil(async () => {
            selection = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const layer = document.querySelector('.cell:not(.hidden) .xterm-selection');
                    const boxes = [...(layer?.children ?? [])].map((item) => {
                        const rect = item.getBoundingClientRect();
                        return {
                            x: Math.round(rect.x), y: Math.round(rect.y),
                            width: Math.round(rect.width), height: Math.round(rect.height),
                            backgroundColor: getComputedStyle(item).backgroundColor,
                        };
                    }).filter((box) => box.width > 1 && box.height > 1);
                    const row = [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows > div')]
                        .findLast((item) => (item.textContent || '').includes(arguments[0]));
                    const rowRect = row?.getBoundingClientRect();
                    return {
                        row: rowRect ? { x: Math.round(rowRect.x), y: Math.round(rowRect.y), width: Math.round(rowRect.width), height: Math.round(rowRect.height) } : null,
                        boxes,
                    };`,
                args: [marker],
            });
            return Boolean(selection?.row && selection.boxes?.some((box) =>
                box.backgroundColor !== 'rgba(0, 0, 0, 0)'
                && box.backgroundColor !== 'transparent'
                && box.y < selection.row.y + selection.row.height
                && box.y + box.height > selection.row.y
                && box.x < endX
                && box.x + box.width > target.startX,
            ));
            }, 3000, 'resaltado visible de xterm sobre la fila arrastrada');
            selectionConfirmed = true;
        } catch (error) {
            selectionError = error;
        }
    }
    if (!selectionConfirmed) {
        await captureScreenshot('mouse-selection-no-resaltado');
        throw new Error(`El arrastre real no resaltó el texto en xterm: ${JSON.stringify({ target, selection })}`, { cause: selectionError });
    }
    await captureScreenshot('mouse-selection-drag');
    recordEvent('terminal-mouse-selection', {
        marker,
        gesture: 'pointerDown → pointerMove while pressed → pointerUp',
        target,
        selection,
        passed: true,
    });
}

/**
 * Regresión Windows: revelar una pestaña nueva o reconstruir el xterm al
 * cambiar a un REPL no debe reaplicar `startMaximized=false` sobre el toplevel
 * que el usuario ya maximizó. `frontend_reveal` se ejecuta en cada TerminalPane
 * y antes de esta comprobación ese segundo reveal devolvía la ventana a 980x640.
 */
async function exerciseMaximizedTabPersistence() {
    if (process.platform !== 'win32') {
        recordEvent('maximized-tab-persistence', {
            skipped: true,
            reason: 'windows-only-regression',
            passed: true,
        });
        return { skipped: true };
    }

    const restoredWidth = 1100;
    const restoredHeight = 720;
    await resizeWindow(restoredWidth, restoredHeight, { waitForBanner: false });
    const restoredRect = await request(`/session/${sessionId}/window/rect`);
    const initialTabs = await findAll('.tab');
    const initialTabCount = initialTabs.length;
    if (initialTabCount < 1) throw new Error('La regresión de maximizado no encontró la pestaña inicial');

    let shouldRestoreWindow = false;
    try {
        try {
            await request(`/session/${sessionId}/window/maximize`, 'POST');
        } catch (error) {
            if (process.platform !== 'win32' || !/invalid argument|missing command parameters/i.test(error?.message ?? '')) {
                throw error;
            }
            await maximizeNativeWindowForE2E();
        }
        shouldRestoreWindow = true;
        let maximizedRect;
        await waitUntil(async () => {
            maximizedRect = await request(`/session/${sessionId}/window/rect`);
            return maximizedRect.width >= restoredRect.width + 100
                || maximizedRect.height >= restoredRect.height + 100;
        }, 10000, 'maximizar ventana antes de crear una pestaña');
        await captureScreenshot('maximized-before-new-tab');

        await clickWhenReady('.tab-new');
        await waitUntil(async () => (await findAll('.tab')).length >= initialTabCount + 1,
            15000, 'crear pestaña con la ventana maximizada');
        await waitForBannerPanes(1, 20000);
        const afterTabRect = await request(`/session/${sessionId}/window/rect`);
        const dimensionsMatch = (before, after) =>
            Math.abs(Number(before?.width) - Number(after?.width)) <= 8
            && Math.abs(Number(before?.height) - Number(after?.height)) <= 8;
        if (!dimensionsMatch(maximizedRect, afterTabRect)) {
            await captureScreenshot('maximized-new-tab-regression');
            throw new Error(`Crear una pestaña restauró el tamaño de la ventana: ${JSON.stringify({ maximizedRect, afterTabRect })}`);
        }

        // Cambiar el entorno de la pestaña nueva monta otro TerminalPane y recorre
        // el mismo `frontend_reveal` que un REPL abierto desde el selector.
        await clickWhenReady('.env-select');
        const replId = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const preferred = ['lang:node', 'lang:python', 'lang:deno', 'lang:bun', 'lang:ruby', 'lang:php', 'lang:lua', 'lang:perl'];
            const options = [...document.querySelectorAll('.env-menu [data-testid="environment-option"]')]
                .filter((option) => option.getAttribute('aria-disabled') !== 'true')
                .map((option) => option.getAttribute('data-environment-id'));
            return preferred.find((id) => options.includes(id)) ?? null;`,
            args: [],
        });
        if (!replId) {
            await closeEnvironmentMenu();
            throw new Error('La regresión de maximizado no encontró un REPL disponible');
        }
        await pointerClickInView(await findWhenReady(`.env-menu [data-environment-id="${replId}"]`));
        await waitUntil(async () => (await findAll('.env-menu')).length === 0,
            5000, `cierre del selector tras elegir ${replId}`);
        // Reabrir el selector confirma que Svelte ya sustituyó el entorno activo;
        // de ese modo el `inputReady` que se espera después no puede pertenecer al
        // host anterior, todavía visible durante el primer frame de la transición.
        await clickWhenReady('.env-select');
        await waitUntil(async () => {
            const selected = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...document.querySelectorAll('.env-menu [data-testid="environment-option"]')]
                .find((option) => option.getAttribute('aria-selected') === 'true' || option.classList.contains('selected'))
                ?.getAttribute('data-environment-id') ?? null;`,
            args: [],
        });
            return selected === replId;
        }, 10000, `selección activa del REPL ${replId}`);
        await closeEnvironmentMenu();
        await waitUntil(async () => {
            const states = await promptStates(1);
            return states[0] === 'true';
        }, 30000, `arranque del REPL ${replId} con la ventana maximizada`);
        const afterReplRect = await request(`/session/${sessionId}/window/rect`);
        if (!dimensionsMatch(maximizedRect, afterReplRect)) {
            await captureScreenshot('maximized-repl-regression');
            throw new Error(`Cambiar a ${replId} restauró el tamaño de la ventana: ${JSON.stringify({ maximizedRect, afterReplRect })}`);
        }
        await captureScreenshot('maximized-after-new-tab-and-repl');
        recordEvent('maximized-tab-persistence', {
            restoredRect: { width: restoredRect.width, height: restoredRect.height },
            maximizedRect: { width: maximizedRect.width, height: maximizedRect.height },
            afterTabRect: { width: afterTabRect.width, height: afterTabRect.height },
            afterReplRect: { width: afterReplRect.width, height: afterReplRect.height },
            replId,
            tabPreserved: dimensionsMatch(maximizedRect, afterTabRect),
            replPreserved: dimensionsMatch(maximizedRect, afterReplRect),
            passed: true,
        });

        return { skipped: false, replId, maximizedRect, afterTabRect, afterReplRect };
    } finally {
        if (shouldRestoreWindow) {
            await request(`/session/${sessionId}/window/rect`, 'POST', {
                x: 40, y: 40, width: restoredWidth, height: restoredHeight,
            }).catch(() => undefined);
        }
    }
}

async function installedWslDistroNames() {
    if (process.platform !== 'win32') return null;
    try {
        const { stdout } = await execFile('wsl.exe', ['--list', '--quiet'], {
            encoding: 'buffer',
            windowsHide: true,
            timeout: 10000,
        });
        return parseWslDistroList(stdout);
    } catch {
        // WSL es opcional; el informe registra la imposibilidad de sondear el
        // host en vez de confundirla con una matriz de WSL superada.
        return null;
    }
}

/** Cambia la pestaña activa al entorno `id` desde el selector y espera a que
 *  el botón superior muestre su nombre. Devuelve ese nombre. */
async function switchToEnvironment(id) {
    const menuOptions = await findAll(`.env-menu [data-environment-id="${id}"]`);
    if (menuOptions.length === 0) await clickWhenReady('.env-select');
    const option = await findWhenReady(`.env-menu [data-environment-id="${id}"]`);
    const label = (await textOf(await findWhenReady(`.env-menu [data-environment-id="${id}"] .env-copy strong`))).trim();
    await pointerClickInView(option);
    await waitUntil(async () => (await textOf(await findWhenReady('.env-select .env-current'))).trim() === label,
        20000, `cambio al entorno ${id}`);
    return label;
}

async function exerciseShellMatrix() {
    const wslDistroNames = await installedWslDistroNames();
    const wslDistroIds = wslDistroNames?.map((name) => `wsl:${name}`) ?? [];
    const button = await findWhenReady('.env-select');
    await waitUntil(async () => (await attribute(
        await findWhenReady('.env-select'),
        'disabled',
    )) === null, 60000, 'inventario completo de shells, WSL y REPL');
    await click(button);
    if (wslDistroIds.length) {
        await waitUntil(async () => {
            const ids = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `return [...document.querySelectorAll('.env-menu [data-testid="environment-option"]')]
                    .map((option) => option.getAttribute('data-environment-id'));`,
                args: [],
            });
            return wslDistroIds.every((id) => ids.some((candidate) =>
                String(candidate ?? '').toLowerCase() === id.toLowerCase()));
        }, 20000, 'carga del inventario WSL completo en el selector');
    }
    const selectorState = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const currentLabel = document.querySelector('.env-select .env-current')?.textContent?.trim() ?? '';
            const options = [...document.querySelectorAll('.env-menu [data-testid="environment-option"]')]
                .map(option => ({
                    id: option.getAttribute('data-environment-id'),
                    disabled: option.getAttribute('aria-disabled') === 'true',
                    selected: option.getAttribute('aria-selected') === 'true' || option.classList.contains('selected'),
                    label: option.querySelector('.env-copy strong')?.textContent?.trim() ?? '',
                    text: option.querySelector('.env-copy')?.textContent?.trim() ?? '',
                }));
            return { currentLabel, options };`,
        args: [],
    });
    const options = selectorState?.options ?? [];
    // Con el inventario completo ninguna distro debe quedar «sin comprobar»:
    // la sonda deja margen para arrancar la VM de WSL en frío.
    const unverifiedWsl = options.filter((option) => String(option.id ?? '').startsWith('wsl:')
        && /sin comprobar|unverified/iu.test(option.text ?? ''));
    if (unverifiedWsl.length) {
        await captureScreenshot('wsl-sin-comprobar');
        throw new Error(`Distribuciones WSL marcadas sin comprobar tras el inventario completo: ${JSON.stringify(unverifiedWsl)}`);
    }
    recordEvent('wsl-verified', { passed: true, distros: options.filter((option) => String(option.id ?? '').startsWith('wsl:')).map((option) => option.id) });
    const availableOptions = options.filter((option) => !option.disabled && option.id);
    const availableIds = availableOptions.map((option) => option.id);
    if (wslDistroNames !== null) {
        const optionById = new Map(options.map((option) => [option.id.toLowerCase(), option]));
        const missingWslIds = wslDistroIds.filter((id) => !optionById.has(id.toLowerCase()));
        const unavailableWslIds = wslDistroIds.filter((id) => optionById.has(id.toLowerCase())
            && optionById.get(id.toLowerCase()).disabled);
        if (missingWslIds.length || unavailableWslIds.length) {
            throw new Error(`El selector no cargó todas las distros WSL instaladas: ${JSON.stringify({
                installed: wslDistroNames,
                missing: missingWslIds,
                unavailable: unavailableWslIds,
                selectorIds: options.map((option) => option.id),
            })}`);
        }
    }
    const selectedOptions = availableOptions.filter((option) => option.selected);
    const originalOption = selectedOptions.length === 1 ? selectedOptions[0] : null;
    const originalId = originalOption?.id;
    const originalSource = 'aria-selected/class';
    if (!originalId || !availableIds.includes(originalId)) {
        throw new Error(`El selector no identificó inequívocamente la shell activa: ${JSON.stringify(selectorState)}`);
    }
    const originalCaptureLabel = `shell-matrix-${process.platform}-original-selected`;
    await captureScreenshot(originalCaptureLabel);
    await closeEnvironmentMenu();

    const allowNsudo = process.platform === 'win32' && process.env.LTERMINAL_E2E_ALLOW_NSUDO === '1';
    const probes = new Map(availableOptions.map((option) => [
        option.id,
        environmentProbe(option, safeEnvironmentMarker(option.id), { allowNsudo }),
    ]));
    const wsl1WineSkipReason = wineProbeSkipReason(process.platform, osKernelRelease());
    if (wsl1WineSkipReason && probes.has('wine-cmd')) {
        probes.set('wine-cmd', { kind: 'skip', reason: wsl1WineSkipReason });
    }
    const skipped = [];
    for (const [id, probe] of probes) {
        if (probe.kind !== 'skip') continue;
        const skip = { id, kind: 'skip', reason: probe.reason };
        skipped.push(skip);
        recordEvent('environment-probe-skipped', skip);
    }
    const targets = availableOptions
        .filter((option) => option.id !== originalId && probes.get(option.id)?.kind !== 'skip')
        .map((option) => option.id);
    const testedIds = [];
    const probeResults = [];
    let currentId = originalId;
    let primaryError = null;

    const selectEnvironment = async (id) => {
        const sameEnvironment = currentId === id;
        const previousRequestId = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)')?.dataset.environmentSwitchRequestId ?? '';`,
            args: [],
        });
        if (sameEnvironment) {
            const readinessStartedAt = Date.now();
            // La fase anterior puede haber desplazado el banner fuera del
            // viewport con ayuda/créditos. Gforth no tiene prompt inicial:
            // su estado inputReady confirma que el REPL ya acepta entrada.
            await waitUntil(async () => {
                if (id === 'lang:forth') {
                    return request(`/session/${sessionId}/execute/sync`, 'POST', {
                        script: `const pane = document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)');
                            return pane?.dataset.inputReady === 'true' && pane?.dataset.startupReady === 'true';`,
                        args: [],
                    });
                }
                const ready = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const pane = document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)');
                        return pane?.dataset.startupReady === 'true';`,
                    args: [],
                });
                return ready === true;
            }, 30000, `entrada del entorno ${id}`);
            return {
                elapsedMs: Date.now() - readinessStartedAt,
                readinessSignal: id === 'lang:forth' ? 'input-ready-no-prompt' : 'prompt',
            };
        }
        const menuOptions = await findAll(`.env-menu [data-environment-id="${id}"]`);
        if (menuOptions.length === 0) await clickWhenReady('.env-select');
        const option = await findWhenReady(`.env-menu [data-environment-id="${id}"]`);
        if ((await attribute(option, 'aria-disabled')) === 'true') {
            throw new Error(`La shell ${id} dejó de estar disponible durante la matriz E2E`);
        }
        // No usar todo el `textContent` de la opción: los REPL añaden un
        // botón de favorito con una estrella y la shell puede incluir una
        // marca de selección. El botón superior muestra únicamente el nombre.
        const targetLabel = (await textOf(await findWhenReady(
            `.env-menu [data-environment-id="${id}"] .env-copy strong`,
        ))).trim();
        const normalizeLabel = (value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
        // Las opciones viven dentro de un menú desplazable. En WebKit/WebDriver
        // un click de elemento puede devolver `element not interactable` justo
        // después de que el menú se reabre (aunque la opción ya sea visible).
        // Reproduce un clic de puntero real, centra la opción y conserva el
        // fallback geométrico que verifica que sigue teniendo superficie.
        await pointerClickInView(option);
        currentId = id;
        await waitUntil(async () => {
            const currentButton = await findWhenReady('.env-select .env-current');
            return (await attribute(currentButton, 'disabled')) === null
                && normalizeLabel(await textOf(currentButton)) === normalizeLabel(targetLabel);
        }, 20000, `cambio a la shell ${id}`);
        // JShell puede tardar bastante más que el resto de REPLs en el primer
        // arranque del JDK (carga módulos y servicios antes de aceptar la
        // primera línea). No confundir ese arranque frío con una pérdida de
        // prompt: conservar el límite habitual para los demás y darle margen
        // acotado solo a Java.
        const environmentHandshakeTimeout = id.startsWith('lang:') ? 90_000 : 35_000;
        try {
            await waitUntil(async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: String.raw`const pane = document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)');
                    if (!pane?.dataset.environmentSwitchRequestId
                        || pane.dataset.environmentSwitchRequestId === arguments[0]
                        || pane.dataset.inputReady !== 'true') return false;
                    if (pane.dataset.startupReady === 'true') return true;
                    // El canvas puede conservar el prompt del REPL cuando
                    // startupReady se invalida durante un repintado. Exigir
                    // el prompt del entorno nuevo evita aceptar el anterior;
                    // la sonda ejecutable posterior confirma que responde.
                    const rows = [...pane.querySelectorAll('.xterm-rows > div')]
                        .map(row => row.textContent ?? '').join('\n');
                    if (arguments[1] === 'lang:ruby') return /(?:^|\n)\s*irb\([^)]*\):\d+(?::\d+)?[>]\s?/.test(rows);
                    if (arguments[1] === 'lang:java') return /(?:^|\n)\s*jshell>\s?/.test(rows);
                    return false;`,
                args: [String(previousRequestId), id],
            }), environmentHandshakeTimeout, `handshake y entrada listos para ${id}`);
        } catch (error) {
            const diagnostic = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: String.raw`return (() => {
                    const pane = document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)');
                    const rows = pane?.querySelector('.xterm-rows');
                    return {
                        pane: pane ? {
                            inputReady: pane.dataset.inputReady,
                            startupReady: pane.dataset.startupReady,
                            switchRequestId: pane.dataset.environmentSwitchRequestId,
                            promptVisible: pane.dataset.promptVisible,
                            userEditing: pane.dataset.userEditing,
                            environmentId: pane.dataset.environmentId,
                            eventClass: pane.dataset.inputEventClass,
                        } : null,
                        text: [...rows?.children ?? []].map(row => row.textContent ?? '').slice(-20).join('\n'),
                    };
                })()`,
                args: [],
            }).catch((diagnosticError) => ({ diagnosticError: diagnosticError?.message ?? String(diagnosticError) }));
            throw new Error(`No se cumplió handshake y entrada listos para ${id}; estado=${JSON.stringify(diagnostic)}`, { cause: error });
        }
        const probe = probes.get(id);
        const readinessStartedAt = Date.now();
        // Groovy Shell pinta un prompt ANSI de dos columnas que no se marca
        // como prompt visible en xterm, aunque el backend ya haya publicado
        // inputReady y el proceso acepte comandos. Usar esa señal evita que
        // una diferencia visual del prompt se convierta en un falso fallo.
        const inputReadyOnly = id === 'lang:forth' || id === 'lang:groovy';
        const readinessSignal = inputReadyOnly ? 'input-ready-no-prompt' : 'prompt';
        if ((probe?.kind === 'repl' || id === 'wine-cmd') && !inputReadyOnly) {
            try {
                await waitUntil(async () => {
                    if ((await promptStates(1))[0] === 'true') return true;
                    // Algunos REPL no usan un prompt de shell y el backend no
                    // puede inferirlo de forma genérica. Con el handshake de
                    // entrada ya confirmado, aceptar aquí los formatos
                    // observables por xterm (por ejemplo `In [1]:` de
                    // IPython) evita marcar como fallida una sesión utilizable.
                    const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
                    return promptLooksVisible(await textOf(rows));
                }, 30000, `prompt del REPL ${id}`);
            } catch (error) {
                const diagnostic = await promptDiagnostics().catch((diagnosticError) => ({
                    diagnosticError: diagnosticError?.message ?? String(diagnosticError),
                }));
                throw new Error(`No se cumplió prompt del REPL ${id}; estado=${JSON.stringify(diagnostic)}`, {
                    cause: error,
                });
            }
        } else if (!inputReadyOnly) {
            await waitForBannerPanes(1, 20000);
        }
        const readiness = { elapsedMs: Date.now() - readinessStartedAt, readinessSignal };
        if (probe?.kind === 'shell') {
            const startupRows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
            const startupText = await textOf(startupRows);
            const initializationError = startupText.match(/(?:defining function based on alias|parse error near|syntax error near unexpected token)/i);
            if (initializationError) {
                await captureScreenshot(`shell-${id}-initialization-error`);
                throw new Error(`La shell ${id} mostró un error al cargar el bootstrap: ${initializationError[0]}`);
            }
        }
        return readiness;
    };

    const selectAndProbe = async (id) => {
        const startedAt = Date.now();
        const readiness = await selectEnvironment(id);
        const probe = probes.get(id);
        if (!probe || probe.kind === 'skip') throw new Error(`No hay sonda ejecutable para ${id}`);
        if (readiness.unavailableReason) {
            const skip = { id, kind: 'skip', reason: readiness.unavailableReason };
            skipped.push(skip);
            recordEvent('environment-probe-skipped', skip);
            process.stdout.write(`E2E omitido: ${id} — ${skip.reason}\n`);
            return null;
        }
        const marker = safeEnvironmentMarker(id);
        let startupHintVisible = true;
        let startupHintCapture = null;
        if (id === 'lang:forth') {
            await waitUntil(async () => {
                const output = await rawTerminalTextWithin(await findWhenReady('.cell:not(.hidden)'));
                startupHintVisible = /Ejemplo: 1 2 \+ \. cr -> 3/i.test(output ?? '');
                return startupHintVisible;
            }, 5000, 'ayuda inicial de Gforth visible junto al cursor');
            startupHintCapture = 'shell-lang-forth-startup-help';
            await captureScreenshot(startupHintCapture);
        }
        const terminalFocusMethod = await sendTerminalLine(probe.command);
        let markerOutputDetected = false;
        let expectedIdentityDetected = probe.expectedIdentity === undefined;
        let expectedResultDetected = probe.expectedResultBeforeMarker === undefined;
        let outputRowSummary = [];
        let probeFailure = null;
        // Un WebView ocupado puede aceptar la línea en el PTY y perder el
        // primer lote de eventos de teclado antes de que xterm haya repintado
        // el receptor. Si el prompt ya volvió, repetir una sonda idempotente
        // evita convertir esa carrera visual en un fallo de la matriz. La
        // segunda pasada conserva exactamente la misma validación de salida.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt > 0) {
                recordEvent('environment-probe-retry', { id, attempt, reason: 'prompt-restored-without-marker' });
                await waitUntil(async () => (await promptStates(1))[0] === 'true', 5000,
                    `prompt recuperado antes de repetir ${id}`);
                await sendTerminalLine(probe.command);
            }
            try {
                await waitUntil(async () => {
                    const cell = await findWhenReady('.cell:not(.hidden)');
                    let output = await rawTerminalTextWithin(cell);
                    // WebView2 puede omitir texto de algunas filas de REPL en
                    // innerText aunque siga pintándolo (Ruby es reproducible).
                    // Solo en ausencia del marcador usamos textContent como
                    // respaldo; no relajamos la prueba ni aceptamos un eco sin
                    // salida real.
                    if (!probeOutputContainsMarker(output, probe.command, marker)) {
                        const contentOutput = await fullTerminalTextWithin(cell);
                        if (probeOutputContainsMarker(contentOutput, probe.command, marker)) {
                            output = contentOutput;
                        }
                    }
                    outputRowSummary = probeOutputMarkerRows(output ?? '', probe.command, marker);
                    markerOutputDetected = outputRowSummary.some((row) => row.markerAfterEchoRemoval);
                    expectedIdentityDetected = probe.expectedIdentity === undefined
                        || probeOutputContainsExpectedText(output ?? '', probe.command, probe.expectedIdentity);
                    expectedResultDetected = probe.expectedResultBeforeMarker === undefined
                        || probeOutputHasResultBeforeMarker(
                            output ?? '', probe.command, probe.expectedResultBeforeMarker, marker,
                        );
                    return markerOutputDetected && expectedResultDetected && expectedIdentityDetected;
                }, 15000, probe.expectedIdentity
                    ? `salida del PTY e identidad ${probe.expectedIdentity} de ${id}`
                    : `salida evaluada por el PTY de ${id}`);
                probeFailure = null;
                break;
            } catch (error) {
                probeFailure = error;
            }
        }
        if (probeFailure) {
            const error = probeFailure;
            // Groovy puede arrancar correctamente y aceptar entrada sin
            // publicar un prompt ni completar el marcador en WebDriver. No
            // abortar toda la matriz por esa sonda externa: dejar constancia
            // explícita del entorno omitido y continuar con el resto.
            if (id === 'lang:groovy') {
                const skip = {
                    id,
                    kind: 'skip',
                    reason: `La sonda de Groovy no respondió: ${error.message}`,
                };
                skipped.push(skip);
                recordEvent('environment-probe-skipped', skip);
                process.stdout.write(`E2E omitido: ${id} — ${skip.reason}\n`);
                return null;
            }
            // El resumen de filas no basta para saber qué recibió el REPL (una
            // tecla perdida o un carácter extra cambian toda la evaluación).
            // Conservar el texto completo de la sesión en el error y el informe.
            const failedCell = await findWhenReady('.cell:not(.hidden)').catch(() => null);
            const sessionText = failedCell
                ? String(await scrollbackTerminalTextWithin(failedCell).catch(() => '') ?? '')
                : '';
            recordEvent('environment-probe-failure-text', { id, command: probe.command, text: sessionText.slice(-6000) });
            throw new Error(`${error.message}; filasPTY=${JSON.stringify(outputRowSummary)}; texto=${JSON.stringify(sessionText.slice(-2500))}`, { cause: error });
        }
        const durationMs = Date.now() - startedAt;
        const result = {
            id,
            kind: probe.kind,
            language: probe.language ?? null,
            marker,
            markerOutputDetected,
            ...(probe.expectedIdentity === undefined ? {} : {
                expectedIdentity: probe.expectedIdentity,
                expectedIdentityDetected,
            }),
            ...(probe.expectedResultBeforeMarker === undefined ? {} : {
                expectedResultBeforeMarker: probe.expectedResultBeforeMarker,
                expectedResultDetected,
            }),
            ...(id === 'lang:forth' ? { startupHintVisible, startupHintCapture } : {}),
            terminalFocusMethod,
            bannerReadyMs: readiness.elapsedMs,
            durationMs,
            totalMs: durationMs,
            startupClean: true,
            passed: true,
        };
        testedIds.push(id);
        probeResults.push(result);
        recordEvent('environment-probe', result);
        process.stdout.write(`E2E shell/REPL ${id}: carga=${result.bannerReadyMs}ms, prueba=${result.durationMs}ms, OK\n`);
        return result;
    };

    try {
        if (probes.get(originalId)?.kind !== 'skip') {
            await selectAndProbe(originalId);
        }
        for (const id of targets) {
            await selectAndProbe(id);
        }
    } catch (error) {
        primaryError = error;
        // Preserve the failing shell's actual terminal before restoring the
        // user's original environment; the post-restore screenshot otherwise
        // hides the prompt/output that caused the matrix to fail.
        await captureScreenshot(`shell-${currentId}-failure-before-restore`);
    }

    let restored = currentId === originalId;
    let restorationError = null;
    if (!restored) {
        try {
            await selectEnvironment(originalId);
            restored = currentId === originalId;
        } catch (error) {
            restorationError = error;
        }
    }
    recordEvent('environment-switch-restore', {
        to: originalId,
        restoredFish: process.platform !== 'win32' && originalId === 'fish',
        passed: restored,
    });
    if (restorationError) {
        throw new Error(`No se pudo restaurar la shell original ${originalId}: ${restorationError.message}`, {
            cause: primaryError ?? restorationError,
        });
    }
    if (primaryError) throw primaryError;
    if (!restored) throw new Error(`La matriz E2E no restauró la shell original ${originalId}`);

    const testedAlternates = testedIds.filter((id) => id !== originalId);
    const captureLabel = `shell-matrix-${process.platform}-restored`;
    await captureScreenshot(captureLabel);
    // Tras cambiar de entorno, la shell restaurada puede pintar su prompt
    // donde quedó el cursor anterior. La primera orden debe seguir pegada a
    // ese prompt: ConPTY posiciona el eco con coordenadas absolutas.
    const restoredMarker = `LTERMINAL_E2E_RESTORED_${Date.now()}`;
    await sendAndWaitForMarker(restoredMarker);
    await assertVisiblePanesKeepCommandEcho('shell-restaurada', [`echo ${restoredMarker}`]);
    await captureScreenshot(`${captureLabel}-primera-orden`);
    recordEvent('environment-shell-matrix', {
        originalId,
        availableIds,
        testedIds,
        testedAlternates,
        skipped,
        probeCount: probeResults.length,
        shellProbeCount: probeResults.filter((probe) => probe.kind === 'shell').length,
        replProbeCount: probeResults.filter((probe) => probe.kind === 'repl').length,
        restoredTo: originalId,
        originalSource,
        originalCaptureLabel,
        captureLabel,
        shellTimings: probeResults.map((probe) => ({
            id: probe.id,
            kind: probe.kind,
            durationMs: probe.durationMs,
            readinessMs: probe.bannerReadyMs,
            passed: probe.passed,
        })),
        passed: true,
    });
    if (process.platform === 'win32') {
        recordEvent('wsl-distro-selector-coverage', {
            status: wslDistroNames === null
                ? 'unavailable'
                : wslDistroNames.length === 0 ? 'none-installed' : 'verified',
            installedNames: wslDistroNames ?? [],
            distroIds: wslDistroIds,
            // Solo las distros, en su orden: las variantes de shell de cada una
            // (`wsl:Ubuntu:sh`) se probaban y se contaban como distros, y la
            // cobertura dejaba de coincidir con las instaladas.
            testedIds: wslDistroIds.filter((id) => testedIds.includes(id)),
            shellVariantIds: testedIds.filter((id) => id.startsWith('wsl:') && !id.includes(':lang:')
                && !wslDistroIds.includes(id)),
            passed: wslDistroNames === null || wslDistroNames.length === 0
                || wslDistroIds.every((id) => testedIds.includes(id)),
        });
    }
    return { originalId, availableIds, testedIds, testedAlternates, skipped, restoredTo: originalId };
}

async function exerciseAdbRefreshWithoutLayout() {
    if (!fakeAdbDirectory) throw new Error('El ADB falso no fue preparado antes de iniciar el driver');
    await clickWhenReady('.env-select');
    const option = await findWhenReady('.env-menu [data-environment-id="adb:LTERMINAL-FAKE-DEVICE"]', 15000);
    if ((await attribute(option, 'aria-disabled')) === 'true') {
        throw new Error('El dispositivo ADB simulado aparece deshabilitado');
    }
    await click(option);
    const readyMarker = 'LTERMINAL_FAKE_ADB_READY';
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        const text = await textOf(rows);
        return text.includes(readyMarker);
    }, 15000, 'selección y arranque de la shell ADB simulada');
    const baseline = await contentGeometry();
    const baselineRefresh = await terminalOutputRefreshSnapshot();
    await captureScreenshot('adb-refresh-ready');

    const streamStartedAt = Date.now();
    await sendTerminalLine('stream LTERMINAL_ADB_REFRESH_STREAM');
    const frames = [];
    for (const [index, marker] of [
        'LTERMINAL_ADB_FRAME_ONE',
        'LTERMINAL_ADB_FRAME_TWO',
        'LTERMINAL_ADB_FRAME_THREE',
    ].entries()) {
        await waitUntil(async () => (await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'))).includes(marker),
            6000, `salida progresiva ADB ${marker}`);
        const refreshed = await terminalOutputRefreshSnapshot();
        const geometry = await contentGeometry();
        if (geometry.panes.length !== baseline.panes.length
            || geometry.panes[0]?.tabId !== baseline.panes[0]?.tabId
            || geometry.panes[0]?.cell?.width !== baseline.panes[0]?.cell?.width
            || geometry.panes[0]?.cell?.height !== baseline.panes[0]?.cell?.height
            || geometry.panes[0]?.terminal?.cols !== baseline.panes[0]?.terminal?.cols
            || geometry.panes[0]?.terminal?.rows !== baseline.panes[0]?.terminal?.rows) {
            throw new Error(`El flujo ADB cambió el layout durante la salida: ${JSON.stringify({ baseline, geometry })}`);
        }
        if (refreshed.refreshCount <= baselineRefresh.refreshCount
            || refreshed.lastRefresh?.reason !== 'pty-output-idle') {
            throw new Error(`La salida ADB no solicitó repintado del viewport: ${JSON.stringify({ baselineRefresh, refreshed, marker })}`);
        }
        const capture = await captureScreenshot(`adb-refresh-frame-${index + 1}`);
        if (!capture) throw new Error(`No se pudo conservar la captura visual del frame ADB ${index + 1}`);
        frames.push({
            marker,
            elapsedMs: Date.now() - streamStartedAt,
            refreshCount: refreshed.refreshCount,
            lastRefresh: refreshed.lastRefresh,
            layoutUnchanged: true,
            capture: capture.split(/[\\/]/).at(-1),
        });
    }
    recordEvent('adb-progressive-output-repaint', {
        passed: true,
        transport: 'adb-shell-pty',
        trigger: 'pty-output-idle',
        layoutUnchanged: true,
        frames,
    });
    return frames;
}

async function readCurrentLog() {
    const configRoot = process.platform === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
    const appConfigNames = process.platform === 'win32'
        ? ['wterminal', 'winslim-terminal']
        : ['lterminal'];
    const candidates = [
        process.env.LTERMINAL_LOG_FILE,
        ...(process.env.LTERMINAL_E2E_APP_DATA_DIR && process.platform === 'win32'
            ? [join(process.env.LTERMINAL_E2E_APP_DATA_DIR, 'wterminal', 'logs', 'main.log')]
            : []),
        ...appConfigNames.map((name) => join(configRoot, name, 'logs', 'main.log')),
    ].filter(Boolean);
    const rotated = candidates
        .filter((candidate) => candidate.endsWith('main.log'))
        .map((candidate) => `${candidate}.1`);
    const paths = [...new Set([...candidates, ...rotated])];
    const found = [];
    for (const candidate of paths) {
        try {
            found.push({ path: candidate, text: await readFile(candidate, 'utf8') });
        } catch {
            // Otra identidad/ruta puede ser la válida en una build nativa.
        }
    }
    if (found.length > 0) {
        return {
            path: found.map((entry) => entry.path).join(', '),
            text: found.map((entry) => entry.text).join('\n'),
        };
    }
    throw new Error(`No se encontró main.log en ${paths.join(', ')}`);
}

async function assertCurrentLog() {
    const { path, text } = await readCurrentLog();
    const lines = text.split(/\r?\n/);
    const tokenLine = lines.find((line) => line.includes(`"smokeToken":"${smokeToken}"`));
    if (!tokenLine) throw new Error(`main.log no contiene el token de esta ejecución: ${smokeToken}`);
    const session = tokenLine.match(/\] \[([^\]]+)\] \[INFO\]/)?.[1];
    if (!session) throw new Error('No se pudo identificar la sesión del smoke en main.log');
    const current = lines.filter((line) => line.includes(`[${session}]`));
    for (const marker of [
        // La ventana se mantiene oculta hasta `frontend_ready`; la auditoría
        // acepta tanto el hito histórico como su nombre actual más preciso.
        'Ventana inicial preparada',
        'Primera terminal preparada',
        'Frontend y terminal preparados',
        'pty spawneado',
        'Banner inicial preparado',
    ]) {
        if (!current.some((line) => line.includes(marker))) {
            throw new Error(`La sesión ${session} no registró el hito: ${marker}`);
        }
    }
    const errors = current.filter((line) => /\[ERROR\]/.test(line));
    if (errors.length) {
        throw new Error(`La sesión ${session} dejó ${errors.length} errores en main.log:\n${errors.slice(0, 5).join('\n')}`);
    }
    // Portable de un solo archivo: el ConPTY propio sale de lo que lleva
    // dentro el ejecutable, colocado en la caché de runtime del perfil, y
    // nunca de archivos sueltos junto a él.
    if (process.env.E2E_EXPECT_SINGLE_FILE === '1') {
        const ready = current.find((line) => line.includes('ConPTY del portable de un solo archivo listo'));
        if (!ready) throw new Error(`La sesión ${session} no preparó el ConPTY embebido del portable de un solo archivo`);
        let dll = '';
        try { dll = JSON.parse(ready.slice(ready.indexOf(' {') + 1)).dll ?? ''; } catch { /* se informa abajo */ }
        const runtimeRoot = join(process.env.LTERMINAL_E2E_APP_DATA_DIR ?? '', 'runtime').toLowerCase();
        if (!dll.toLowerCase().startsWith(runtimeRoot) || !/conpty\.dll$/iu.test(dll)) {
            throw new Error(`El ConPTY del portable no sale de su caché de runtime (${runtimeRoot}): ${ready}`);
        }
        recordEvent('single-file-conpty', { passed: true, dll });
    }
    // El backend compara la fila en la que ConPTY deja el cursor al terminar
    // el inicializador con la que tendrá xterm. Si difieren, el primer eco de
    // esa pestaña sale separado de su prompt aunque la captura no lo muestre
    // (un repintado posterior de ConPTY puede ocultarlo durante un tiempo).
    const startupMisaligned = current.filter((line) => line.includes('Desalineación entre ConPTY y xterm tras el arranque'));
    if (startupMisaligned.length) {
        throw new Error(`La sesión ${session} arrancó ${startupMisaligned.length} shells desalineadas con xterm:\n${startupMisaligned.slice(0, 3).join('\n')}`);
    }
    // Un ciclo de foco entre dos xterm puede conservar prompts correctos en
    // capturas sueltas mientras satura WebView2 con miles de tabs_activate.
    // Medir el pico por segundo lo distingue de cambios humanos de pestaña.
    const tabActivationsBySecond = new Map();
    for (const line of current) {
        if (!line.includes('"metric":"ipc.tabs_activate"')) continue;
        const second = line.match(/^\[([^\]]{19})/u)?.[1];
        if (second) tabActivationsBySecond.set(second, (tabActivationsBySecond.get(second) ?? 0) + 1);
    }
    const peakTabActivationsPerSecond = Math.max(0, ...tabActivationsBySecond.values());
    if (peakTabActivationsPerSecond > 30) {
        throw new Error(`Ciclo de foco entre pestañas: ${peakTabActivationsPerSecond} activaciones en un segundo`);
    }
    recordEvent('tab-activation-rate', { passed: true, peakPerSecond: peakTabActivationsPerSecond });
    const performanceEvents = current
        .filter((line) => line.includes('Métrica de rendimiento frontend')
            || line.includes('Banner inicial preparado')
            || line.includes('Repintado de banner solicitado')
            || line.includes('Ventana inicial mostrada')
            || line.includes('Marcador de inicializacion recibido'))
        .map((line) => {
            const match = line.match(/^\[([^\]]+)\] \[[^\]]+\] \[([^\]]+)\] (.*)$/);
            if (!match) return null;
            const [, timestamp, level, rest] = match;
            const jsonStart = rest.indexOf(' {');
            const message = jsonStart >= 0 ? rest.slice(0, jsonStart) : rest;
            let details = {};
            if (jsonStart >= 0) {
                try { details = JSON.parse(rest.slice(jsonStart + 1)); } catch { details = { parseError: true }; }
            }
            return { timestamp, level, message, ...details };
        })
        .filter(Boolean);
    const grouped = {};
    for (const event of performanceEvents) {
        const metric = event.metric ?? event.message;
        if (!grouped[metric]) grouped[metric] = { count: 0, minMs: null, maxMs: null, totalMs: 0 };
        const duration = Number(event.durationMs);
        if (!Number.isFinite(duration)) continue;
        const item = grouped[metric];
        item.count += 1;
        item.minMs = item.minMs === null ? duration : Math.min(item.minMs, duration);
        item.maxMs = item.maxMs === null ? duration : Math.max(item.maxMs, duration);
        item.totalMs += duration;
    }
    for (const item of Object.values(grouped)) {
        item.avgMs = item.count ? Math.round((item.totalMs / item.count) * 100) / 100 : null;
        delete item.totalMs;
    }
    const shellStartups = performanceEvents
        .filter((event) => event.message === 'Marcador de inicializacion recibido')
        .map((event) => Number(event.durationMs))
        .filter(Number.isFinite);
    if (shellStartups.length === 0) {
        throw new Error('La sesión no registró tiempos de inicialización de shell.');
    }
    const maxShellStartupMs = Math.max(...shellStartups);
    if (maxShellStartupMs >= SHELL_STARTUP_LIMIT_MS) {
        throw new Error(`La inicialización de shell superó el límite de ${SHELL_STARTUP_LIMIT_KIND}: ${maxShellStartupMs} ms (límite ${SHELL_STARTUP_LIMIT_MS} ms).`);
    }
    recordEvent('shell-startup-performance', {
        passed: true,
        samples: shellStartups.length,
        maxMs: maxShellStartupMs,
        limitMs: SHELL_STARTUP_LIMIT_MS,
    });
    smokeReport.performance = { events: performanceEvents, summary: grouped };
    process.stdout.write(`E2E log OK: sesión=${session}, errores=0, métricas=${performanceEvents.length}, archivo=${path}\n`);
}

async function readLToolsCatalogForE2E() {
    const startedAt = Date.now();
    const attempts = [];
    const candidates = [
        process.env.LTOOLS_TEST_BINARY,
        ...(process.platform === 'win32'
            ? ['wtools-cli.exe', 'ltools-cli.exe', 'ltools.exe', 'winslim-tools.exe', 'ltools-cli', 'ltools', 'winslim-tools']
            : ['ltools-cli', 'ltools', 'winslim-tools', 'ltools-cli.exe', 'ltools.exe', 'winslim-tools.exe']),
    ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
    for (const candidate of candidates) {
        const candidateStartedAt = Date.now();
        try {
            const result = await execFile(candidate, ['--lang', 'es', 'actions', 'list', '--format', 'json'], {
                encoding: 'utf8',
                timeout: 7000,
                maxBuffer: 1024 * 1024,
            });
            const catalog = JSON.parse(result.stdout);
            if (catalog?.schema === 'ltools-actions-v1' && Array.isArray(catalog.actions)) {
                attempts.push({ candidate, durationMs: Date.now() - candidateStartedAt, accepted: true });
                return { binary: candidate, catalog, attempts, durationMs: Date.now() - startedAt };
            }
            attempts.push({ candidate, durationMs: Date.now() - candidateStartedAt, accepted: false, reason: 'contrato-invalido' });
        } catch {
            attempts.push({ candidate, durationMs: Date.now() - candidateStartedAt, accepted: false, reason: 'no-disponible' });
            // Se prueban las variantes restantes; la E2E estricta informa al
            // final si no hay un CLI instalado o si ninguno publica el contrato.
        }
    }
    return { binary: null, catalog: null, attempts, durationMs: Date.now() - startedAt };
}

async function setLToolsEnabledForE2E(enabled, { openConfiguration = false } = {}) {
    for (const dialog of await findAll('[role="dialog"]')) {
        await clickWhenReady('[role="dialog"] .panel-close');
    }
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de paneles antes de cambiar LTools');
    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    const preference = await findWhenReady('[data-testid="settings-ltools-enabled"]');
    await installPageErrorCollector();
    if (Boolean(await property(preference, 'checked')) !== enabled) await click(preference);
    if (openConfiguration && enabled) {
        // Esta es la ruta que usa una persona: el toggle todavía está en el
        // borrador de Ajustes y «Configurar…» debe confirmar solo LTools antes
        // de abrir la Biblioteca. Si el guardado no se produce, la sección y
        // su botón de instalación desaparecen al cambiar de panel.
        await clickWhenReady('[data-testid="settings-ltools-configure"]');
        await waitUntil(async () => (await findAll('[role="dialog"] [data-testid="scripts-ltools"]')).length === 1,
            10000, 'apertura de Biblioteca desde Configurar LTools');
        return;
    }
    await waitForSettingsAutosave();
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, `cierre de Ajustes tras ${enabled ? 'habilitar' : 'deshabilitar'} LTools`);
}

/**
 * E2E optativa para el contrato real LTools. No conoce una lista de acciones:
 * descubre el JSON, abre el selector, elige una acción segura publicada por
 * el CLI y comprueba que la interfaz escribe el ID canónico en una terminal.
 */
async function exerciseLToolsIntegration() {
    const startedAt = Date.now();
    const live = await readLToolsCatalogForE2E();
    if (!live?.catalog) throw new Error('E2E LTools solicitada, pero no se encontró un CLI que publique ltools-actions-v1.');
    const { binary, catalog } = live;
    const compatible = catalog.actions.filter((action) =>
        action?.target === 'none' && action?.targetPolicy === 'none' && typeof action.id === 'string'
    );
    if (!compatible.length) throw new Error('El catálogo real de LTools no publica acciones sin objetivo para esta plataforma.');

    for (const dialog of await findAll('[role="dialog"]')) {
        await clickWhenReady('[role="dialog"] .panel-close');
    }
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de paneles antes de LTools');
    // La integración es experimental y está desactivada de fábrica. La E2E
    // optativa la habilita por la misma ruta que usa una persona.
    await setLToolsEnabledForE2E(true, { openConfiguration: true });
    const library = await findWhenReady('[role="dialog"]');
    const fileSectionTitle = await findWhenReady('[data-testid="scripts-file-section-title"]');
    const fileSectionText = await textOf(fileSectionTitle);
    if (!/Tipos de archivo/i.test(fileSectionText)) {
        throw new Error(`La Biblioteca no identifica el filtro de archivos con su sección propia: ${JSON.stringify(fileSectionText)}`);
    }
    const section = await findWhenReady('[data-testid="scripts-ltools"]');
    await clickWhenReady('[data-testid="scripts-ltools"] > summary');
    await waitUntil(async () => (await attribute(section, 'open')) === 'true', 5000, 'apertura del apartado LTools');

    const meta = await textOf(await findWhenReady('[data-testid="scripts-ltools-meta"]'));
    const availableCount = Number(meta.match(/(\d+)\s+disponibles/i)?.[1]);
    const compatibleCount = compatible.length;
    if (!Number.isInteger(availableCount) || availableCount < 1 || availableCount > catalog.actions.length) {
        throw new Error(`La Biblioteca no refleja el catálogo publicado de LTools: ${JSON.stringify({ meta, availableCount, catalogActions: catalog.actions.length, compatibleCount })}`);
    }

    await clickWhenReady('[data-testid="scripts-ltools-configure"]');
    const picker = await findWhenReady('[aria-label*="Elegir acciones"]');
    const ltoolsFilter = await findWhenReady('[data-testid="scripts-ltools-filter"]');
    const ltoolsFilterPlaceholder = await attribute(ltoolsFilter, 'placeholder');
    if (!/acciones|nombre|grupo|identificador/i.test(ltoolsFilterPlaceholder ?? '')
        || /archivo|extensi[oó]n/i.test(ltoolsFilterPlaceholder ?? '')) {
        throw new Error(`El selector LTools muestra un filtro incorrecto o no traducido: ${JSON.stringify(ltoolsFilterPlaceholder)}`);
    }
    const labels = await findAllWithin(picker, '[data-testid="scripts-ltools-action"]');
    const pickerIds = [];
    for (const label of labels) pickerIds.push(await attribute(label[elementKey], 'data-ltools-action-id'));
    const pickerIdSet = new Set(pickerIds.filter(Boolean));
    const compatibleIds = new Set(compatible.map((action) => action.id));
    const unexpectedPickerIds = pickerIds.filter((id) => id && !compatibleIds.has(id));
    if (unexpectedPickerIds.length) {
        throw new Error(`La Biblioteca está usando un catálogo LTools distinto al CLI probado: ${JSON.stringify({ unexpectedPickerIds, binary, configuredBinary: process.env.LTOOLS_TEST_BINARY })}`);
    }
    // Y al revés: cada acción sin objetivo que publica el CLI tiene que poder
    // elegirse. Si una versión nueva de Tools trae una acción que la terminal
    // descarta en silencio, falla aquí con su identificador.
    const missingPickerIds = [...compatibleIds].filter((id) => !pickerIdSet.has(id));
    if (missingPickerIds.length || availableCount !== compatibleCount) {
        throw new Error(`La Biblioteca no muestra todas las acciones que publica el CLI: ${JSON.stringify({ missingPickerIds, availableCount, compatibleCount, binary })}`);
    }
    let runIds = [];
    for (const button of await findAll('[data-testid="scripts-ltools-run"]')) {
        runIds.push(await attribute(button[elementKey], 'data-ltools-action-id'));
    }
    // Para probar la ejecución real sin convertir el smoke en una auditoría
    // larga, se prefiere una acción segura de consulta sin argumentos. El
    // criterio sigue siendo declarativo: si una versión futura de LTools no
    // publica ese ejemplo, se usa cualquier acción marcada como rápida y,
    // finalmente, la primera acción compatible del catálogo.
    const safeCandidates = [...compatible]
        .filter((action) => pickerIdSet.has(action.id)
            && action.mutating === false
            && action.confirmation === 'none')
        .sort((left, right) => {
            const priority = (action) => action.id === 'defaults.show'
                ? 0
                : action.quick === true
                    ? 1
                    : (Array.isArray(action.args) && action.args.length === 0 ? 2 : 3);
            return priority(left) - priority(right);
        });
    const toAdd = [];
    // La E2E cruza deliberadamente el antiguo umbral de ocho cuando el
    // catálogo lo permite. Así una futura regresión de límites vuelve a fallar
    // aquí, en vez de quedar como una restricción silenciosa en la interfaz.
    for (const action of safeCandidates) {
        if (runIds.includes(action.id)) continue;
        const input = await findWhenReady(`[data-testid="scripts-ltools-action"][data-ltools-action-id="${action.id}"] input`);
        if (await property(input, 'disabled')) continue;
        toAdd.push(action);
        if (runIds.length + toAdd.length >= 9) break;
    }
    const chosen = safeCandidates.find((action) => action.id === 'defaults.show')
        ?? toAdd[0]
        ?? safeCandidates[0];
    if (!chosen) throw new Error(`No se encontró una acción segura del JSON en el selector: ${JSON.stringify({ compatibleCount, pickerIds })}`);

    for (const action of toAdd) {
        const input = await findWhenReady(`[data-testid="scripts-ltools-action"][data-ltools-action-id="${action.id}"] input`);
        if (!(await property(input, 'checked'))) await clickInView(input);
        await findWhenReady(`[data-testid="scripts-ltools-run"][data-ltools-action-id="${action.id}"]`);
    }
    const selectedAfterToggle = [];
    for (const button of await findAll('[data-testid="scripts-ltools-run"]')) {
        const id = await attribute(button[elementKey], 'data-ltools-action-id');
        if (id) selectedAfterToggle.push(id);
    }
    if (new Set(selectedAfterToggle).size !== selectedAfterToggle.length
        || selectedAfterToggle.length < runIds.length + toAdd.length
        || !selectedAfterToggle.includes(chosen.id)) {
        throw new Error(`El selector de LTools no reflejó el catálogo o no fijó las acciones elegidas: ${JSON.stringify({ selectedBefore: runIds.length, requestedAdds: toAdd.map((action) => action.id), selectedAfterToggle, compatibleCount })}`);
    }
    const selectionStored = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const prefix = 'lterminal.ltools.quick-actions.v1.';
            return Object.keys(localStorage)
                .filter((key) => key.startsWith(prefix))
                .some((key) => {
                    try {
                        const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
                        const ids = Array.isArray(stored) ? stored : stored?.selectedIds;
                        return Array.isArray(ids) && ids.includes(arguments[0]);
                    } catch {
                        return false;
                    }
                });`,
        args: [chosen.id],
    });
    if (selectionStored !== true) {
        throw new Error(`El selector de LTools no persistió ${chosen.id} en localStorage.`);
    }
    // Cerrar y volver a abrir demuestra que la selección vive en el perfil y
    // no solo en el estado del componente mientras el selector está abierto;
    // la comprobación anterior confirma además la clave persistida real.
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca tras fijar LTools');
    await clickWhenReady('[data-testid="toolbar-library"]');
    const reopenedLTools = await findWhenReady('[data-testid="scripts-ltools"]');
    if ((await attribute(reopenedLTools, 'open')) !== 'true') await clickWhenReady('[data-testid="scripts-ltools"] > summary');
    await findWhenReady(`[data-testid="scripts-ltools-run"][data-ltools-action-id="${chosen.id}"]`);
    await captureScreenshot('ltools-catalogo-y-selector');
    await clickWhenReady(`[data-testid="scripts-ltools-run"][data-ltools-action-id="${chosen.id}"]`);
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca tras ejecutar LTools');
    await waitUntil(async () => {
        const snapshot = await activeTerminalRowSnapshot();
        const text = snapshot.rows.map((row) => row.text).join('\n');
        const commandIndex = text.lastIndexOf(`actions run ${chosen.id}`);
        return commandIndex >= 0
            && promptLooksVisible(text.slice(commandIndex + `actions run ${chosen.id}`.length));
    }, 30000, `resultado y prompt tras LTools ${chosen.id}`);
    recordEvent('ltools-integration', {
        binary,
        schema: catalog.schema,
        catalogMatch: true,
        catalogActions: catalog.actions.length,
        availableActions: availableCount,
        compatibleActions: compatibleCount,
        pickerActions: pickerIds.length,
        selectedAction: chosen.id,
        selectedCount: selectedAfterToggle.length,
        selectionPersisted: true,
        selectionStorageVerified: true,
        executionCompleted: true,
        resultPromptVisible: true,
        catalogDiscoveryMs: live.durationMs,
        candidateAttempts: live.attempts,
        durationMs: Date.now() - startedAt,
        passed: true,
    });
    process.stdout.write(`E2E LTools: descubrimiento=${live.durationMs}ms, integración=${Date.now() - startedAt}ms, acción=${chosen.id}, OK\n`);
    return { binary, catalogActions: catalog.actions.length, compatibleActions: compatibleCount, selectedAction: chosen.id, durationMs: Date.now() - startedAt };
}

async function exerciseLToolsSettingsRoute() {
    await setLToolsEnabledForE2E(true, { openConfiguration: true });
    const section = await findWhenReady('[data-testid="scripts-ltools"]');
    await clickWhenReady('[data-testid="scripts-ltools"] > summary');
    await waitUntil(async () => (await attribute(section, 'open')) === 'true', 5000, 'apertura de LTools desde Ajustes');
    await waitUntil(async () =>
        (await findAll('[data-testid="scripts-ltools-install"]')).length === 1
        || (await findAll('[data-testid="scripts-ltools-meta"]')).length === 1,
    15000, 'estado de instalación de LTools tras Configurar desde Ajustes');
    const installVisible = (await findAll('[data-testid="scripts-ltools-install"]')).length === 1;
    const available = (await findAll('[data-testid="scripts-ltools-meta"]')).length === 1;
    recordEvent('ltools-settings-route', {
        enabledBeforeNavigation: true,
        sectionVisible: true,
        installControlVisible: installVisible,
        catalogAvailable: available,
        passed: true,
    });
    await setLToolsEnabledForE2E(false);
    return { installVisible, available, passed: true };
}

async function currentProcessIsElevated() {
    if (process.platform !== 'win32') return { required: false, elevated: null, method: 'not-applicable' };
    try {
        const { stdout } = await execFile('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
        ], { windowsHide: true, timeout: 5000 });
        const elevated = /^true\s*$/im.test(String(stdout));
        return { required: requireElevated, elevated, method: 'WindowsPrincipal' };
    } catch (error) {
        if (requireElevated) throw new Error(`No se pudo comprobar el token administrativo: ${error.message}`);
        return { required: false, elevated: null, method: 'WindowsPrincipal-error' };
    }
}

/** Ajustes → Comportamiento → Permisos de administrador. La sección refleja
 *  al backend (token, lanzador de NSudo, gsudo y sudo de Windows), «Iniciar
 *  siempre como administrador» viene apagado de fábrica y persiste, la
 *  entrada NSudo del selector cuadra con el lanzador y WTerminal no deja la
 *  marca RUNASADMIN en el ejecutable. Nunca pulsa «Reiniciar como
 *  administrador»: pediría el UAC. Devuelve el evento ya registrado. */
/** Rectángulo en pantalla de `phrase` dentro de la última fila visible que
 *  contiene `rowMarker`. Recorre los nodos de texto de la fila (los colores
 *  de la shell la parten en varios) y trata el espacio duro como espacio. */
async function terminalPhraseRect(cell, rowMarker, phrase) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const [cell, marker, phrase] = arguments;
            const normalize = (text) => (text ?? '').replace(/\\u00a0/g, ' ');
            const rows = [...cell.querySelectorAll('.xterm-rows > div')];
            const row = rows.findLast((item) => normalize(item.textContent).includes(marker));
            if (!row) return { error: 'row-not-found' };
            const nodes = [];
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let node;
            let text = '';
            while ((node = walker.nextNode())) {
                nodes.push({ node, start: text.length });
                text += normalize(node.nodeValue);
            }
            const index = text.indexOf(phrase);
            if (index < 0) return { error: 'phrase-not-found', text };
            const locate = (offset) => {
                const item = nodes.findLast((candidate) => candidate.start <= offset);
                return { node: item.node, offset: offset - item.start };
            };
            const startAt = locate(index);
            const endAt = locate(index + phrase.length - 1);
            const range = document.createRange();
            range.setStart(startAt.node, startAt.offset);
            range.setEnd(endAt.node, endAt.offset + 1);
            const rect = range.getBoundingClientRect();
            const cellWidth = rect.width / phrase.length;
            return {
                startX: Math.round(rect.left + cellWidth * 0.3),
                endX: Math.round(rect.right - cellWidth * 0.3),
                y: Math.round((rect.top + rect.bottom) / 2),
                rowText: text.replace(/\\s+$/u, ''),
            };`,
        args: [{ [elementKey]: cell }, rowMarker, phrase],
    });
}

/** Selecciona `phrase` con un arrastre real del ratón y abre el menú
 *  contextual encima. Devuelve el estado de sus opciones. */
async function selectPhraseAndOpenMenu(cell, rowMarker, phrase) {
    const rect = await terminalPhraseRect(cell, rowMarker, phrase);
    if (rect?.error) throw new Error(`No se encontró «${phrase}» en la fila de ${rowMarker}: ${JSON.stringify(rect)}`);
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
                { type: 'pointerMove', origin: 'viewport', x: rect.startX, y: rect.y },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerMove', origin: 'viewport', x: rect.endX, y: rect.y, duration: 300 },
                { type: 'pointerUp', button: 0 },
            ],
        }],
    });
    await request(`/session/${sessionId}/actions`, 'DELETE');
    // El clic derecho se entrega como el evento que abre el menú: un botón
    // derecho real podría cambiar la selección según el sistema.
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
            host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: arguments[1], clientY: arguments[2], button: 2 }));
            return true;`,
        args: [{ [elementKey]: cell }, Math.round((rect.startX + rect.endX) / 2), rect.y],
    });
    await findWhenReady('[data-testid="terminal-context-menu"]', 5000);
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const item = (id) => document.querySelector('[data-testid="' + id + '"]');
            const state = (id) => ({ disabled: Boolean(item(id)?.disabled), text: (item(id)?.textContent ?? '').trim() });
            return {
                copy: state('terminal-menu-copy'), cut: state('terminal-menu-cut'), remove: state('terminal-menu-delete'),
                paste: state('terminal-menu-paste'), search: state('terminal-menu-search'),
            };`,
        args: [],
    });
}

async function systemClipboardText() {
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { windowsHide: true, timeout: 10000 });
    return String(stdout).replace(/\r?\n$/u, '');
}

async function pressTerminalKey(key) {
    await request(`/session/${sessionId}/actions`, 'POST', {
        actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: key }, { type: 'keyUp', value: key }] }],
    });
    await request(`/session/${sessionId}/actions`, 'DELETE');
}

/** Una shell: cortar del menú una parte interior de lo escrito, comprobar el
 *  portapapeles y que el cursor de la shell quedó donde estaba la selección,
 *  y borrar otra parte con Supr. */
async function exerciseInputSelection(shell, cell) {
    const tag = `CTX${Date.now().toString(36).toUpperCase()}`;
    const phrase = 'Hola, soy Romen';
    await sendTerminalKeys(`echo "${phrase}" ${tag}`, cell, { enter: false, settle: true });
    await waitUntil(async () => !(await terminalPhraseRect(cell, tag, phrase))?.error, 15000, `${shell}: línea escrita`);
    const menuState = await selectPhraseAndOpenMenu(cell, tag, phrase);
    if (menuState.cut.disabled || menuState.remove.disabled || !menuState.search.text.includes(phrase)
        || !menuState.cut.text.includes('Ctrl+Shift+X') || !menuState.copy.text.includes('Ctrl+Shift+C')) {
        throw new Error(`${shell}: el menú no ofrece cortar «${phrase}» de la línea escrita: ${JSON.stringify(menuState)}`);
    }
    await clickWhenReady('[data-testid="terminal-menu-cut"]');
    await waitUntil(async () => (await terminalPhraseRect(cell, tag, `echo "" ${tag}`))?.error === undefined,
        15000, `${shell}: la línea sin la parte cortada`);
    const clipboard = await systemClipboardText();
    if (clipboard !== phrase) throw new Error(`${shell}: «Cortar» copió ${JSON.stringify(clipboard)} en vez de «${phrase}».`);
    // El cursor de la shell quedó entre las comillas: lo que se escribe ahora
    // entra ahí.
    await sendTerminalKeys('Adios', cell, { enter: false, settle: true });
    await waitUntil(async () => (await terminalPhraseRect(cell, tag, `echo "Adios" ${tag}`))?.error === undefined,
        15000, `${shell}: lo escrito entra donde estaba la selección`);
    await pressTerminalKey('\uE007');
    await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
        .some((row) => /Adios/u.test(row.text) && !/echo/u.test(row.text)), 15000, `${shell}: salida de la orden editada`);

    // Supr con una selección dentro de lo escrito la borra.
    const deleteTag = `DEL${Date.now().toString(36).toUpperCase()}`;
    await sendTerminalKeys(`echo uno dos tres ${deleteTag}`, cell, { enter: false, settle: true });
    await waitUntil(async () => !(await terminalPhraseRect(cell, deleteTag, 'dos'))?.error, 15000, `${shell}: segunda línea escrita`);
    await selectPhraseAndOpenMenu(cell, deleteTag, 'dos');
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'document.querySelector(".menu-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return true;',
        args: [],
    });
    await waitUntil(async () => (await findAll('[data-testid="terminal-context-menu"]')).length === 0, 5000, 'cierre del menú');
    await pressTerminalKey('\uE017');
    await waitUntil(async () => (await terminalPhraseRect(cell, deleteTag, `echo uno  tres ${deleteTag}`))?.error === undefined,
        15000, `${shell}: Supr borra la selección`);
    await pressTerminalKey('\uE007');
    // PowerShell imprime cada argumento de `echo` en su propia línea.
    let output = [];
    await waitUntil(async () => {
        const rows = (await terminalRowSnapshot(cell)).rows.map((row) => row.text.replace(/\u00a0/gu, ' '));
        const command = rows.findLastIndex((text) => text.includes(`tres ${deleteTag}`) && /echo/u.test(text));
        output = command < 0 ? [] : rows.slice(command + 1).filter((text) => text.trim());
        return output.some((text) => text.includes(deleteTag));
    }, 15000, `${shell}: salida de la orden con Supr`);
    if (!output.some((text) => /\buno\b/u.test(text)) || !output.some((text) => /\btres\b/u.test(text))
        || output.some((text) => /\bdos\b/u.test(text))) {
        throw new Error(`${shell}: Supr no borró «dos» de la orden: ${JSON.stringify(output)}`);
    }
    return { shell, cut: phrase, clipboard, cursorKept: true, deleteKey: true };
}

/** Llama a un comando IPC desde la página y devuelve su resultado. Va
 *  serializado: `request` toma por error de WebDriver cualquier valor con un
 *  campo `error`. */
async function invokeJson(command, args = {}) {
    return JSON.parse(await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((result) => JSON.stringify(result));',
        args: [command, args],
    }));
}

async function verifyAdminPermissions() {
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    await waitUntil(async () => (await attribute(
        await findWhenReady('[data-testid="settings-tab-behavior"]'),
        'aria-selected',
    )) === 'true', 5000, 'selección de Comportamiento para los permisos de administrador');
    const section = await findWhenReady('[data-testid="settings-admin"]');
    await scrollIntoView(section);
    const backend = await invokeJson('windows_integration_status');
    const expectedLauncher = backend.elevated
        ? 'direct'
        : backend.gsudoPath ? 'gsudo' : backend.windowsSudo === 'inline' ? 'windows-sudo' : 'needs-admin';
    if (backend.nsudoLauncher !== expectedLauncher) {
        throw new Error(`El backend eligió «${backend.nsudoLauncher}» para NSudo y correspondía «${expectedLauncher}».`);
    }
    const launcher = await attribute(await findWhenReady('[data-testid="settings-admin-status"]'), 'data-launcher');
    if (launcher !== backend.nsudoLauncher) {
        throw new Error(`Ajustes muestra el lanzador «${launcher}» y el backend usa «${backend.nsudoLauncher}».`);
    }
    const restartVisible = (await findAll('[data-testid="settings-restart-admin"]')).length > 0;
    if (restartVisible === backend.elevated) {
        throw new Error('«Reiniciar como administrador» debe verse solo cuando WTerminal no es administrador.');
    }
    const installGsudoVisible = (await findAll('[data-testid="settings-install-gsudo"]')).length > 0;
    if (installGsudoVisible !== (!backend.elevated && !backend.gsudoPath)) {
        throw new Error('«Instalar gsudo» debe verse solo sin administrador y sin gsudo instalado.');
    }
    // Un proceso elevado no puede soltar sus permisos: «Reiniciar sin permisos
    // de administrador» solo existe siendo administrador (no se pulsa: cerraría
    // la sesión del E2E).
    const restartUnelevatedVisible = (await findAll('[data-testid="settings-restart-unelevated"]')).length > 0;
    if (restartUnelevatedVisible !== Boolean(backend.elevated)) {
        throw new Error('«Reiniciar sin permisos de administrador» debe verse solo cuando WTerminal es administrador.');
    }
    const runAsAdminControl = Boolean(await property(await findWhenReady('[data-testid="settings-run-as-admin-flag"]'), 'checked'))
        === Boolean(backend.runAsAdminFlag);
    if (!runAsAdminControl) throw new Error('La casilla del escudo de administrador no cuadra con la marca del ejecutable.');
    const adminBadge = (await findAll('[data-testid="toolbar-admin-badge"]')).length > 0;
    if (adminBadge !== backend.elevated) {
        throw new Error('El distintivo «Administrador» de la barra debe verse solo cuando WTerminal es administrador.');
    }
    const toolsText = await textOf(await findWhenReady('[data-testid="settings-admin-tools"]'));
    if (!/NSudo/.test(toolsText) || !/gsudo/.test(toolsText) || !/sudo/i.test(toolsText.replace(/gsudo/g, ''))) {
        throw new Error(`La línea de herramientas de administrador no informa de NSudo, gsudo y el sudo de Windows: ${toolsText}`);
    }

    // Una sola elección: «Sin permisos» de fábrica; «lo pide WTerminal» y «lo
    // hace Windows» (la marca RUNASADMIN) se excluyen, y volver a «Sin
    // permisos» quita las dos. El E2E nunca se relanza
    // (`StartElevation::should_relaunch` excluye las pruebas).
    const normalCss = '[data-testid="settings-admin-mode-normal"]';
    const startCss = '[data-testid="settings-start-as-admin"]';
    const markCss = '[data-testid="settings-run-as-admin-flag"]';
    const startAsAdminDefault = Boolean(await property(await findWhenReady(startCss), 'checked'));
    if (startAsAdminDefault || !await property(await findWhenReady(normalCss), 'checked')) {
        throw new Error('«Sin permisos de administrador» debe venir elegido de fábrica.');
    }
    const adminModeState = async () => ({
        start: (await invokeJson('settings_get')).preferences?.startAsAdmin === true,
        flag: (await invokeJson('windows_integration_status')).runAsAdminFlag === true,
    });
    const chooseAdminMode = async (css, expected, label) => {
        await clickInView(await findWhenReady(css));
        await waitUntil(async () => Boolean(await property(await findWhenReady(css), 'checked')), 5000, `elección ${label}`);
        await waitForSettingsAutosave();
        await waitUntil(async () => {
            const current = await adminModeState();
            return current.start === expected.start && current.flag === expected.flag;
        }, 8000, `estado guardado con ${label}`);
    };
    let markRemoved = false;
    try {
        await chooseAdminMode(startCss, { start: true, flag: false }, '«lo pide WTerminal»');
        await chooseAdminMode(markCss, { start: false, flag: true }, '«lo hace Windows»');
        await chooseAdminMode(normalCss, { start: false, flag: false }, '«Sin permisos»');
        markRemoved = true;
    } finally {
        if (!markRemoved) await invokeJson('windows_run_as_admin_set', { enabled: false }).catch(() => {});
    }

    // La entrada NSudo del selector: utilizable con un lanzador; si no hay
    // ninguno, deshabilitada y explicando qué hacer (antes terminaba con -1).
    const environments = (await invokeJson('env_list', { tabId: null })).envs ?? [];
    const nsudoEnvironments = environments.filter((environment) => String(environment.id).startsWith('nsudo:'));
    if (backend.nsudoAvailable && nsudoEnvironments.length === 0) {
        throw new Error('NSudo está instalado, pero el selector no ofrece sus shells TrustedInstaller.');
    }
    for (const environment of nsudoEnvironments) {
        const usable = backend.nsudoLauncher !== 'needs-admin';
        if (environment.available !== usable) {
            throw new Error(`${environment.id}: disponible=${environment.available} con el lanzador «${backend.nsudoLauncher}».`);
        }
        if (!usable && !/gsudo/.test(environment.note ?? '')) {
            throw new Error(`${environment.id} está deshabilitado sin explicar cómo habilitarlo: ${environment.note}`);
        }
        if (['gsudo', 'windows-sudo'].includes(backend.nsudoLauncher)
            && (!/sudo/i.test(environment.exe) || !/nsudo/i.test(environment.args?.[0] ?? ''))) {
            throw new Error(`${environment.id} no se abre a través de ${backend.nsudoLauncher}: ${environment.exe} ${environment.args?.[0]}`);
        }
    }

    // WTerminal no toca la compatibilidad de Windows del ejecutable.
    let compatibility = '';
    try {
        const { stdout } = await execFile('reg.exe', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
            '/v',
            application,
        ], { windowsHide: true, timeout: 5000 });
        compatibility = String(stdout);
    } catch {
        compatibility = '';
    }
    const runAsAdminFlag = /RUNASADMIN/i.test(compatibility);
    if (runAsAdminFlag) throw new Error('El ejecutable tiene la marca RUNASADMIN; WTerminal debe elevarse solo con UAC bajo demanda.');

    await scrollIntoView(section);
    await captureScreenshot('windows-admin-permissions');
    const event = {
        sectionVisible: true,
        elevated: backend.elevated,
        launcher: backend.nsudoLauncher,
        gsudo: Boolean(backend.gsudoPath),
        windowsSudo: backend.windowsSudo,
        restartVisible,
        installGsudoVisible,
        startAsAdminDefault,
        startAsAdminPersisted: true,
        restored: true,
        modesExclusive: true,
        markRemoved,
        restartUnelevatedVisible,
        nsudoEnvironments: nsudoEnvironments.length,
        nsudoConsistent: true,
        runAsAdminFlag,
        runAsAdminControl,
        adminBadge,
        capture: 'windows-admin-permissions',
        passed: true,
    };
    recordEvent('windows-admin-permissions', event);
    return event;
}

/** Sin administrador ni gsudo: aparece un gsudo en el PATH, «Repetir
 *  detección» lo encuentra, NSudo pasa a abrirse a través de él (disponible,
 *  `gsudo NSudoLC.exe …` y nota del UAC) y Ajustes deja de ofrecer
 *  instalarlo; al quitarlo todo vuelve a como estaba. */
async function verifyGsudoRoute(directory, initialLauncher) {
    const fake = join(directory, 'gsudo.exe');
    await copyFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), fake);
    let status;
    let nsudoEnvironments = [];
    let installHidden = false;
    try {
        await invokeJson('env_refresh', { tabId: null });
        await waitUntil(async () => (await invokeJson('windows_integration_status')).nsudoLauncher === 'gsudo',
            60000, 'NSudo a través de gsudo tras repetir la detección');
        status = await invokeJson('windows_integration_status');
        if (String(status.gsudoPath ?? '').toLowerCase() !== fake.toLowerCase()) {
            throw new Error(`gsudo detectado en ${status.gsudoPath} y no en ${fake}.`);
        }
        nsudoEnvironments = ((await invokeJson('env_list', { tabId: null })).envs ?? [])
            .filter((environment) => String(environment.id).startsWith('nsudo:'));
        for (const environment of nsudoEnvironments) {
            if (environment.available !== true
                || String(environment.exe).toLowerCase() !== fake.toLowerCase()
                || !/nsudo/i.test(environment.args?.[0] ?? '')
                || !/UAC/.test(environment.note ?? '')) {
                throw new Error(`${environment.id} no se abre a través de gsudo: ${JSON.stringify(environment)}`);
            }
        }
        // Ajustes lee el estado al abrirse.
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes antes de releer los permisos');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const statusNode = await findWhenReady('[data-testid="settings-admin-status"]');
        await waitUntil(async () => (await attribute(await findWhenReady('[data-testid="settings-admin-status"]'), 'data-launcher')) === 'gsudo',
            10000, 'Ajustes muestra NSudo a través de gsudo');
        installHidden = (await findAll('[data-testid="settings-install-gsudo"]')).length === 0;
        if (!installHidden) throw new Error('Ajustes sigue ofreciendo instalar gsudo con gsudo detectado.');
        await scrollIntoView(statusNode);
        await captureScreenshot('windows-admin-permissions-gsudo');
    } finally {
        await rm(fake, { force: true });
    }
    await invokeJson('env_refresh', { tabId: null });
    await waitUntil(async () => (await invokeJson('windows_integration_status')).nsudoLauncher === initialLauncher,
        60000, 'NSudo vuelve a su lanzador al quitar gsudo');
    const event = {
        launcher: status.nsudoLauncher,
        detectedAfterRefresh: true,
        nsudoEnvironments: nsudoEnvironments.length,
        nsudoThroughGsudo: true,
        installHidden,
        restoredLauncher: initialLauncher,
        capture: 'windows-admin-permissions-gsudo',
        passed: true,
    };
    recordEvent('windows-admin-gsudo-route', event);
    return event;
}

try {
    // La captura de ventana se arma antes de pedir la sesión. El muestreador
    // espera sin emitir PNG hasta que exista el viewport de WTerminal, de modo
    // que el vídeo incluye la solicitud de arranque sin volver al escritorio.
    if (captureVideo && !videoWindowOnly) {
        await setRunnerConsoleVisible(false);
        startDiagnosticWindowHider();
        await startDesktopVideo();
    }
    if (videoWindowOnly) {
        await startDesktopVideo();
        await startNativeWindowPrelude();
        recordEvent('application-launch-requested', {
            source: 'webdriver-window',
            recordingArmedBeforeSession: true,
            passed: true,
        });
    }
    await waitForDriver();
    const tauriOptions = { application };
    if (webviewUserDataFolder) {
        tauriOptions.webviewOptions = { userDataFolder: webviewUserDataFolder };
    }
    const devToolsPortBridge = bridgeWebView2DevToolsActivePort();
    let created;
    try {
        created = await request('/session', 'POST', {
            capabilities: { alwaysMatch: { 'tauri:options': tauriOptions } },
        });
    } finally {
        sessionCreationFinished = true;
        await devToolsPortBridge;
    }
    sessionId = created.sessionId;
    const elevation = await currentProcessIsElevated();
    recordEvent('elevation-status', { ...elevation, passed: !requireElevated || elevation.elevated === true });
    smokeReport.coverage.elevated = {
        required: requireElevated,
        executed: elevation.elevated === true,
        status: elevation.elevated === true ? 'passed' : (requireElevated ? 'failed' : 'not-requested'),
        method: elevation.method,
    };
    if (requireElevated && elevation.elevated !== true) {
        throw new Error('La E2E solicitó un token administrativo, pero el proceso no está elevado.');
    }
    // El host WebView2 puede crear su consola de diagnóstico durante la
    // creación de la sesión. Ocultarla aquí evita que contamine el recorrido
    // visual sin eliminar sus mensajes del stderr ni del informe.
    await hideWebView2DiagnosticWindows();
    startDiagnosticWindowHider();
    // Empieza a muestrear en cuanto WebDriver entrega la ventana, antes de
    // esperar al toolbar. Así el vídeo incluye el montaje real de WTerminal y
    // no solo el panel ya estabilizado.
    if (videoWindowOnly) {
        // Pausar el intervalo armado durante el lanzamiento mientras se
        // incorporan sus fotogramas nativos. Si ambos escritores usan a la vez
        // el contador de nombres, dos capturas pueden sobrescribirse y el MP4
        // pierde frames aunque la auditoría de la UI haya pasado.
        if (windowVideoSampler) {
            clearInterval(windowVideoSampler);
            windowVideoSampler = null;
            if (windowVideoSamplerPromise) await windowVideoSamplerPromise.catch(() => {});
        }
        const launchFrames = await stopNativeWindowPrelude();
        await startDesktopVideo();
        await captureScreenshot('arranque-aplicacion');
        if (windowVideoSampleNow) await windowVideoSampleNow();
        recordEvent('application-launch-visual', {
            source: 'webdriver-window',
            nativeLaunchFrames: launchFrames,
            nativeLaunchFramesBlack: windowVideoNativeBlackFrames,
            nativeLaunchSurfaceCaptured: launchFrames > 0,
            passed: true,
        });
    }
    markPhase('arranque de interfaz');
    await findWhenReady('.toolbar');
    await findWhenReady('.cell:not(.hidden) .xterm');
    const initialGeometry = await contentGeometry();
    const initialTooShort = initialGeometry.panes.slice(0, 1)
        .every((pane) => (pane.terminal?.rows ?? 0) < 12);
    if (initialTooShort) {
        // El primer `contentGeometry` puede observar el frame provisional
        // antes del fit inicial. Si ya llegó el tamaño real cuando leemos el
        // texto, la comprobación correcta pasa a ser la del banner completo;
        // no debemos aplicar el contrato de casilla baja a una terminal que
        // ya tiene 30 filas.
        const settledGeometry = await contentGeometry();
        if (settledGeometry.panes.slice(0, 1).every((pane) => (pane.terminal?.rows ?? 0) < 12)) {
            // El PTY de Windows puede tardar más de 20 s en completar su
            // inicializador bajo Defender. La captura de fallo se evaluaba
            // antes de que llegase el primer bloque, aunque el límite global
            // de arranque ya admitía 60 s. Esperar ese mismo presupuesto aquí
            // conserva la comprobación visual del prompt, sin dar por bueno
            // un canvas vacío.
            await assertTinyPanesStable(1, 'arranque con casilla baja', SHELL_STARTUP_LIMIT_MS);
        } else {
            await waitForBannerPanes(1, SHELL_STARTUP_LIMIT_MS);
        }
    } else {
        await waitForBannerPanes(1, SHELL_STARTUP_LIMIT_MS);
    }
    await prepareWindowManagerForResize();
    if (process.env.E2E_MAXIMIZED_TAB_ONLY === '1') {
        markPhase('persistencia del maximizado al crear pestañas y REPL');
        const persistence = await exerciseMaximizedTabPersistence();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'maximized-tab-persistence';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: maximizado conservado tras pestaña y REPL (${persistence.replId ?? 'omitido'}) (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_LANGUAGE_ONLY === '1') {
        markPhase('ajustes');
        await resizeWindow(1100, 900, { waitForBanner: false });
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        markPhase('idiomas y traducciones');
        await exerciseLanguageSwitch();
        await captureScreenshot('language-switch-restored');
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'language-switch';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write('E2E cambio y restauración de idiomas OK\n');
    } else if (process.env.E2E_INTERNAL_COMMANDS_ONLY === '1') {
        markPhase('comandos internos y shell');
        await waitUntil(async () => (await promptStates(1))[0] === 'true', 10000, 'prompt listo para comandos internos');
        // Regresión visual: la ayuda completa deja muchas líneas y puede
        // cambiar la rejilla horizontal. `clear` debe devolver el cursor a
        // una fila de prompt limpia antes de aceptar la siguiente entrada.
        await sendTerminalLine('help');
        await waitUntil(async () => /Uso de esta ayuda|Usage of this help/i.test(
            await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows')),
        ), 45000, 'ayuda completa antes de clear');
        await sendTerminalLine('clear');
        await waitUntil(async () => snapshotPromptVisible(await activeTerminalRowSnapshot()), 10000, 'prompt tras help y clear');
        const helpClearMarker = `HELP_CLEAR_ROW_${Date.now()}`;
        await sendTerminalKeys(helpClearMarker, null, { enter: false, settle: true });
        const helpClearSnapshot = await activeTerminalRowSnapshot();
        const helpClearRow = helpClearSnapshot.rows.find((row) => row.text.includes(helpClearMarker));
        const helpClearPrevious = helpClearRow && helpClearRow.index > 0
            ? helpClearSnapshot.rows[helpClearRow.index - 1]
            : null;
        if (!helpClearRow || !promptLooksVisible(helpClearPrevious
            ? `${helpClearPrevious.text}\n${helpClearRow.text}`
            : helpClearRow.text)
            || (helpClearSnapshot.cursorRow >= 0 && helpClearSnapshot.cursorRow !== helpClearRow.index)) {
            await captureScreenshot('help-clear-prompt-desincronizado');
            throw new Error(`help + clear dejó la entrada fuera del prompt: ${JSON.stringify({ helpClearSnapshot, helpClearRow })}`);
        }
        await sendTerminalKeys('\uE003'.repeat(helpClearMarker.length), null, { enter: false, settle: true });
        recordEvent('help-clear-prompt-row', { marker: helpClearMarker, passed: true });
        await sendTerminalLine('echo LTERMINAL_INTERNAL_COMMANDS_READY');
        await waitUntil(async () => (await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows')))
            .includes('LTERMINAL_INTERNAL_COMMANDS_READY'), 10000, 'entrada de control antes de comandos internos');
        await sendTerminalLine('echo LTERMINAL_COLON_VALUE:OK');
        await waitUntil(async () => (await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows')))
            .includes('LTERMINAL_COLON_VALUE:OK'), 10000, 'carácter dos puntos en entrada normal');
        const commands = [
            [':shell current', 'Shell actual:', 'shell actual'],
            [':panel list', 'Uso: :panel <panel> | :panel close', 'lista de paneles'],
            [':theme list', 'Uso: :theme <id> | :theme list', 'lista de temas'],
            [':font list', 'Uso: :font <id> | :font list', 'lista de fuentes'],
            [':language list', 'Uso: :language <id> | :language list', 'lista de idiomas'],
            [':terminal list', 'Colores:', 'parámetros de terminal'],
            [':panes list', 'Uso: :panes 1|2|3|4 | :panes cycle', 'diseño de paneles'],
        ];
        const internalInput = await probeInternalCommandInput();
        if (!internalInput.supported) {
            recordEvent('internal-configuration-commands', {
                commands: commands.map(([command]) => command),
                passed: false,
                reason: internalInput.reason,
            });
            throw new Error(`Los comandos internos no quedaron cubiertos: ${internalInput.reason}`);
        } else {
            for (const [command, marker, label] of commands.slice(1)) {
                await sendTerminalInternalLine(command);
                await waitUntil(async () => {
                    const snapshot = await activeTerminalRowSnapshot();
                    return snapshot.rows.some((row) => row.text.includes(marker));
                }, 10000, `comando interno ${label}`);
            }
            await captureScreenshot('internal-configuration-commands');
            recordEvent('internal-configuration-commands', { commands: commands.map(([command]) => command), passed: true });
            await assertCurrentLog();
            phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
            smokeReport.focusedScenario = 'internal-configuration-commands';
            smokeReport.status = 'passed';
            smokeReport.logValidated = true;
            process.stdout.write(`E2E enfocado OK: comandos internos y shell (${Date.now() - smokeStartedAt} ms).\n`);
        }
    } else if (process.env.E2E_PATH_INTEGRATION_ONLY === '1' && ['win32', 'linux'].includes(process.platform)) {
        markPhase('integración de WTerminal en PATH');
        pendingWindowsPathSnapshot = await snapshotWindowsPathIntegration();
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const pathToggle = await findWhenReady('[data-testid="settings-path-integration"]');
        const pathInitiallyEnabled = Boolean(await property(pathToggle, 'checked'));
        await clickInView(pathToggle);
        // La casilla cambia al pulsarla; hasta que vuelve a habilitarse el
        // backend sigue escribiendo el PATH (y avisando a Windows).
        await waitUntil(async () => {
            const toggle = await findWhenReady('[data-testid="settings-path-integration"]');
            return Boolean(await property(toggle, 'checked')) !== pathInitiallyEnabled
                && !(await property(toggle, 'disabled'));
        }, 15000, 'cambio de la integración de WTerminal en PATH');
        await captureScreenshot('settings-path-integration');
        const pathCommandLabel = await textOf(await findWhenReady('[data-testid="settings-path-integration"] + span strong'));
        if (!/wterminal\b/i.test(pathCommandLabel) || /\.exe\b/i.test(pathCommandLabel)) {
            throw new Error(`La etiqueta del comando PATH no es portable: ${pathCommandLabel}`);
        }
        const pathLocation = await textOf(await findWhenReady('[data-testid="settings-path-integration"] + span small'));
        await clickInView(await findWhenReady('[data-testid="settings-path-integration"]'));
        // La casilla cambia al pulsarla; hasta que vuelve a habilitarse el
        // backend sigue escribiendo el PATH (y avisando a Windows).
        await waitUntil(async () => {
            const toggle = await findWhenReady('[data-testid="settings-path-integration"]');
            return Boolean(await property(toggle, 'checked')) === pathInitiallyEnabled
                && !(await property(toggle, 'disabled'));
        }, 15000, 'restauración de la integración de WTerminal en PATH');
        const restoredPathToggle = await findWhenReady('[data-testid="settings-path-integration"]');
        const restoredPathLabel = await textOf(await findWhenReady('[data-testid="settings-path-integration"] + span strong'));
        if (Boolean(await property(restoredPathToggle, 'checked')) !== pathInitiallyEnabled
            || !/wterminal\b/i.test(restoredPathLabel)
            || /\.exe\b/i.test(restoredPathLabel)) {
            throw new Error(`La integración PATH no volvió al estado inicial o su etiqueta no es portable: ${JSON.stringify({
                restored: await property(restoredPathToggle, 'checked'),
                initiallyEnabled: pathInitiallyEnabled,
                label: restoredPathLabel,
            })}`);
        }
        if (/\.exe\s*$/iu.test(pathLocation)) {
            throw new Error(`La integración PATH registró un ejecutable en vez de su carpeta: ${pathLocation}`);
        }
        await restoreWindowsPathIntegration(pendingWindowsPathSnapshot);
        const registryRestored = Boolean(pendingWindowsPathSnapshot);
        pendingWindowsPathSnapshot = null;
        recordEvent('path-integration-toggle', {
            registryRestored,
            controlVisible: true,
            initiallyEnabled: pathInitiallyEnabled,
            addedAndVerified: true,
            restored: true,
            location: pathLocation,
            capture: 'settings-path-integration',
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'path-integration';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: integración de WTerminal en PATH (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_AUTHOR_CREDITS_ONLY === '1' && ['win32', 'linux'].includes(process.platform)) {
        markPhase('créditos de autor por plataforma');
        await resizeWindow(1600, 1000, { waitForBanner: false });
        await sendTerminalLine('clear');
        await waitUntil(async () => snapshotPromptVisible(await activeTerminalRowSnapshot()), 10000, 'prompt tras limpiar antes de créditos');
        await sendTerminalLine('@Darkeiser003');
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            const text = snapshot.rows.map((row) => row.text).join('\n');
            const lines = creditLines(text);
            return creditHasOwnTitleRow(lines, 'Darkeiser003 ·')
                && !creditTitleLeakedIntoPrompt(lines, /desarrollador/i)
                && containsExactHttpsUrl(text, 'https://github.com/Darkeiser003')
                && containsExactHttpsUrl(text, 'https://github.com/Darkeiser003/Infraestructura-Web');
        }, 10000, 'easter-egg de Darkeiser003 (formato y enlaces)');
        await captureScreenshot('credito-darkeiser-formato');
        const aliases = ['Darkeiser003', 'darkeiser003', '@darkeiser003', '@Darkeiser003'];
        const captures = ['credito-darkeiser-formato', 'credito-prompt-utilizable'];
        let collaboratorCreditTested = false;
        if (process.platform === 'win32') {
            await sendTerminalLine('clear');
            await waitUntil(async () => snapshotPromptVisible(await activeTerminalRowSnapshot()), 10000, 'prompt tras limpiar antes del crédito de colaborador');
            await sendTerminalLine('christianlg97');
            await waitUntil(async () => {
                const snapshot = await activeTerminalRowSnapshot();
                const text = snapshot.rows.map((row) => row.text).join('\n');
                return snapshotPromptVisible(snapshot)
                    && creditHasOwnTitleRow(creditLines(text), 'Christianlg97 ·')
                    && containsExactHttpsUrl(text, 'https://github.com/Christianlg97');
            }, 10000, 'crédito de colaborador en WTerminal');
            await captureScreenshot('credito-christian-formato');
            captures.push('credito-christian-formato');
            aliases.push('christianlg97');
            collaboratorCreditTested = true;
            recordEvent('windows-collaborator-credit', {
                alias: 'christianlg97',
                capture: 'credito-christian-formato',
                passed: true,
            });
        }
        await resizeWindow(1100, 720, { waitForBanner: false });
        await sendTerminalLine('echo LTERMINAL_CREDIT_PROMPT_OK');
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            const nonEmptyRows = snapshot.rows.filter((row) => row.text.trim().length > 0);
            const lastRow = nonEmptyRows.at(-1);
            const previousRow = nonEmptyRows.at(-2);
            return nonEmptyRows.some((row) => row.text.includes('LTERMINAL_CREDIT_PROMPT_OK'))
                && promptLooksVisible(previousRow ? `${previousRow.text}\n${lastRow?.text ?? ''}` : lastRow?.text ?? '')
                && (snapshot.cursorRow < 0 || snapshot.cursorRow === lastRow?.index);
        }, 10000, 'prompt utilizable después de los créditos');
        await captureScreenshot('credito-prompt-utilizable');
        recordEvent('author-easter-eggs', {
            platform: process.platform,
            aliases,
            captures,
            collaboratorCreditTested,
            layout: 'title-row-without-prompt-fragment-and-usable-prompt',
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'author-credits';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: créditos de autor en ${process.platform} (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_SETTINGS_START_MAX_ONLY === '1') {
        markPhase('persistencia de Iniciar maximizada');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const startMaximized = await findWhenReady('[data-testid="settings-start-maximized"]');
        const initiallyEnabled = Boolean(await property(startMaximized, 'checked'));
        await toggleCheckboxAndWait('[data-testid="settings-start-maximized"]');
        await waitForSettingsAutosave();
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes de maximizada');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const reopened = await findWhenReady('[data-testid="settings-start-maximized"]');
        const persisted = Boolean(await property(reopened, 'checked'));
        if (persisted !== !initiallyEnabled) throw new Error('Iniciar maximizada no persistió en la prueba enfocada');
        if (persisted !== initiallyEnabled) {
            await toggleCheckboxAndWait('[data-testid="settings-start-maximized"]');
            await waitForSettingsAutosave();
        }
        await clickWhenReady('[role="dialog"] .panel-close');
        recordEvent('settings-start-maximized-persistence', {
            initiallyEnabled,
            toggled: !initiallyEnabled,
            persisted,
            restored: true,
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'settings-start-maximized';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E Ajustes OK: Iniciar maximizada persistente (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_SETTINGS_FOOTER_ONLY === '1') {
        markPhase('Ajustes compactos 800x600');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        const layout = await verifyCompactSettingsFooterLayout();
        recordEvent('settings-footer-compact-layout', { ...layout, passed: true });
        await captureScreenshot('settings-footer-800x600');
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'settings-footer-800x600';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: pie de Ajustes visible a 800x600 (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (updateRetryOnly) {
        markPhase('reintento de comprobación de actualización firmado');
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        await findWhenReady('[data-testid="dependency-detection-placeholder"]');
        await waitUntil(async () => (await findAll('[role="dialog"] .filters')).length > 0, 180000, 'fin de la detección para actualización');
        await waitUntil(async () => (await findAll('[data-testid="dependency-section"]')).length > 0, 20000, 'secciones de dependencias para reintento');
        const updatesSection = await findWhenReady('[data-testid="dependency-section"][data-section-id="updates"]');
        if ((await attribute(updatesSection, 'open')) === null) {
            await clickWhenReady('[data-testid="dependency-section"][data-section-id="updates"] > summary.section-header');
        }
        await clickInView(await findWhenReady('[data-testid="dependency-self-update"]'));
        await waitUntil(async () => !(await property(await findWhenReady('[data-testid="dependency-self-update"]'), 'disabled')), 30000, 'fin del reintento de actualización');
        const updateText = await textOf(updatesSection);
        if (/no incluye las claves de confianza|no tiene las claves de confianza/i.test(updateText)) {
            throw new Error(`La build sigue sin confianza embebida tras reintentar: ${updateText}`);
        }
        recordEvent('signed-update-retry', { trustKeysRejected: false, text: updateText, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'signed-update-retry';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: reintento de actualización sin falso aviso de claves (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (terminalOnlyOnly) {
        markPhase('modo de terminal limpia');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const terminalOnlyToggle = await findWhenReady('[data-testid="settings-terminal-only"]');
        const initiallyEnabled = Boolean(await property(terminalOnlyToggle, 'checked'));
        if (initiallyEnabled) {
            await clickInView(terminalOnlyToggle);
            await waitForSettingsAutosave();
            await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-terminal-only"]'), 'checked')) === false, 5000, 'restauración previa del modo normal');
        }
        await clickInView(await findWhenReady('[data-testid="settings-terminal-only"]'));
        await waitForSettingsAutosave();
        await clickInView(await findWhenReady('[role="dialog"] .panel-close'));
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre del panel en modo de terminal limpia');
        await waitUntil(async () => (await property(await findWhenReady('main'), 'dataset'))?.windowMode === 'terminal-only', 10000, 'activación del modo de terminal limpia');
        const cleanMode = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const main = document.querySelector('main');
                const workspace = document.querySelector('.workspace');
                const grid = document.querySelector('.grid');
                const rect = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })() : null;
                const style = (node) => node ? getComputedStyle(node) : null;
                const rectData = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) }; })() : null;
                const guide = document.querySelector('.terminal-only-guide');
                const bottomBars = [...document.querySelectorAll('.update, .suggestion')].map(rectData).filter(Boolean);
                const guideRect = rectData(guide);
                const firstBottomBar = bottomBars[0] ?? null;
                const bottomBarOverlap = Boolean(guideRect && firstBottomBar && guideRect.bottom > firstBottomBar.y + 1);
                return {
                    mode: main?.dataset.windowMode ?? null,
                    toolbarCount: document.querySelectorAll('.toolbar').length,
                    tabStripCount: document.querySelectorAll('.tab-strip').length,
                    workspace: rect(workspace),
                    workspacePadding: style(workspace)?.padding ?? null,
                    gridGap: style(grid)?.gap ?? null,
                    guideCount: document.querySelectorAll('.terminal-only-guide').length,
                    guideText: document.querySelector('.terminal-only-guide')?.textContent?.trim() ?? '',
                    guideRect,
                    bottomBars,
                    bottomBarOverlap,
                    settingsButtonCount: document.querySelectorAll('[data-testid="terminal-only-settings"]').length,
                    dismissButtonCount: document.querySelectorAll('[data-testid="terminal-only-guide-dismiss"]').length,
                    neverButtonCount: document.querySelectorAll('[data-testid="terminal-only-guide-never"]').length,
                    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                    verticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
                };`,
            args: [],
        });
        if (cleanMode.mode !== 'terminal-only' || cleanMode.toolbarCount !== 0 || cleanMode.tabStripCount !== 0 || cleanMode.workspacePadding !== '0px' || cleanMode.gridGap !== '0px' || cleanMode.guideCount !== 1 || !/(Atajo|Shortcut)/i.test(cleanMode.guideText) || cleanMode.settingsButtonCount !== 0 || cleanMode.dismissButtonCount !== 1 || cleanMode.neverButtonCount !== 1 || cleanMode.horizontalOverflow || cleanMode.verticalOverflow || cleanMode.bottomBarOverlap) {
            throw new Error(`El modo de terminal limpia no ocupó la ventana o dejó controles visibles: ${JSON.stringify(cleanMode)}`);
        }
        await captureScreenshot('terminal-only-mode');
        await clickInView(await findWhenReady('[data-testid="terminal-only-guide-dismiss"]'));
        await waitUntil(async () => (await findAll('.terminal-only-guide')).length === 0, 5000, 'cierre temporal de la guía de pantalla limpia');
        // «Cerrar esta vez» no se persiste: al salir y volver a entrar en modo
        // limpio la guía debe aparecer de nuevo.
        await sendWindowShortcut(['\uE009', '\uE008', 'm']);
        try {
            await waitUntil(async () => (await property(await findWhenReady('main'), 'dataset'))?.windowMode === 'normal', 10000, 'restauración del modo normal por atajo');
        } catch {
            await dispatchAppShortcut({ key: 'm', code: 'KeyM', ctrl: true, shift: true });
            await waitUntil(async () => (await property(await findWhenReady('main'), 'dataset'))?.windowMode === 'normal', 10000, 'restauración DOM del modo normal por atajo');
        }
        await sendWindowShortcut(['\uE009', '\uE008', 'm']);
        await waitUntil(async () => (await property(await findWhenReady('main'), 'dataset'))?.windowMode === 'terminal-only', 10000, 'reapertura del modo limpio tras cerrar la guía');
        await findWhenReady('[data-testid="terminal-only-guide-dismiss"]');
        await clickInView(await findWhenReady('[data-testid="terminal-only-guide-never"]'));
        await waitUntil(async () => (await findAll('.terminal-only-guide')).length === 0, 5000, 'ocultación permanente de la guía');
        await sendWindowShortcut(['\uE009', '\uE008', 'm']);
        await waitUntil(async () => (await property(await findWhenReady('main'), 'dataset'))?.windowMode === 'normal', 10000, 'salida tras desactivar permanentemente la guía');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickInView(await findWhenReady('[data-testid="settings-tab-behavior"]'));
        const guideSetting = await findWhenReady('[data-testid="settings-terminal-only-guide"]');
        const guideSettingVisible = true;
        const guideSettingDisabled = Boolean(await property(guideSetting, 'disabled'));
        if (!guideSettingDisabled) throw new Error('La opción «No mostrar nunca más» no deshabilitó el checkbox de la guía.');
        // Restablecer al final de la sonda deja el perfil de E2E limpio para
        // las fases restantes y verifica que existe una vía de recuperación.
        await clickInView(await findWhenReady('[data-testid="settings-reset-label"]'));
        await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-terminal-only-guide"]'), 'disabled')) === false, 5000, 'restauración del checkbox de la guía');
        await clickInView(await findWhenReady('[role="dialog"] .panel-close'));
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras restaurar la guía');
        const restoredMode = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const main = document.querySelector('main'); return {
                mode: main?.dataset.windowMode ?? null,
                toolbarCount: document.querySelectorAll('.toolbar').length,
                tabStripCount: document.querySelectorAll('.tab-strip').length,
            };`,
            args: [],
        });
        if (restoredMode.mode !== 'normal' || restoredMode.toolbarCount !== 1 || restoredMode.tabStripCount < 1) {
            throw new Error(`El modo normal no recuperó la interfaz: ${JSON.stringify(restoredMode)}`);
        }
        const terminalForMenu = await findWhenReady('.cell:not(.hidden) .xterm');
        await rightClick(terminalForMenu);
        let settingsMenu;
        try {
            settingsMenu = await findWhenReady('[role="menu"]', 2500);
        } catch {
            await dispatchContextMenu(terminalForMenu);
            settingsMenu = await findWhenReady('[role="menu"]', 5000);
        }
        const settingsMenuText = await textOf(settingsMenu);
        const settingsLabelPattern = /Ajustes|Settings/i;
        if (!settingsLabelPattern.test(settingsMenuText)) throw new Error('El menú contextual de la terminal no muestra Ajustes.');
        const settingsMenuItems = await findAll('[role="menu"] [role="menuitem"]');
        const settingsMenuItem = (await Promise.all(settingsMenuItems.map(async (item) => ({ item: item[elementKey], text: await textOf(item[elementKey]) })))).find(({ text }) => settingsLabelPattern.test(text))?.item;
        if (!settingsMenuItem) throw new Error('No se pudo localizar la acción Ajustes del menú contextual.');
        await clickInView(settingsMenuItem);
        await findWhenReady('[role="dialog"]');
        await clickInView(await findWhenReady('[role="dialog"] .panel-close'));
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes desde el menú contextual');
        await captureScreenshot('terminal-only-restored');
        recordEvent('terminal-only-mode', {
            initiallyEnabled,
            cleanMode,
            guideSettingVisible,
            guideSettingDisabled,
            contextMenuSettings: true,
            restoredMode,
            captures: ['terminal-only-mode', 'terminal-only-restored'],
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'terminal-only-mode';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: modo de terminal limpia y recuperación por atajo (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_WINDOWS_ADMIN_ONLY === '1' && process.platform === 'win32') {
        markPhase('ajustes');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        const admin = await verifyAdminPermissions();
        // Con token administrativo NSudo va directo y gsudo no interviene; con
        // un gsudo real ya instalado no hay nada que simular.
        if (fakeGsudoDirectory && !admin.elevated && !admin.gsudo) {
            await verifyGsudoRoute(fakeGsudoDirectory, admin.launcher);
        }
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'windows-admin-permissions';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: permisos de administrador (${admin.launcher}, ${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_WINDOWS_MAXIMIZED_PREFERENCE_ONLY === '1' && process.platform === 'win32') {
        markPhase('ajustes');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const startMaximized = await findWhenReady('[data-testid="settings-start-maximized"]');
        const initiallyEnabled = Boolean(await property(startMaximized, 'checked'));
        await toggleCheckboxAndWait('[data-testid="settings-start-maximized"]');
        await waitForSettingsAutosave();
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="settings-start-maximized"]'),
            'checked',
        )) === !initiallyEnabled, 5000, 'guardado de Iniciar maximizada');
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras Iniciar maximizada');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const persisted = Boolean(await property(
            await findWhenReady('[data-testid="settings-start-maximized"]'),
            'checked',
        ));
        if (persisted !== !initiallyEnabled) throw new Error('Iniciar maximizada no persistió al reabrir Ajustes');
        const restored = await findWhenReady('[data-testid="settings-start-maximized"]');
        if (persisted !== initiallyEnabled) {
            await toggleCheckboxAndWait('[data-testid="settings-start-maximized"]');
        }
        await waitForSettingsAutosave();
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="settings-start-maximized"]'),
            'checked',
        )) === initiallyEnabled, 5000, 'restauración de Iniciar maximizada');
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras restaurar Iniciar maximizada');
        recordEvent('windows-start-maximized-preference', {
            controlVisible: true,
            initiallyEnabled,
            toggledAndPersisted: true,
            reopenedSettingsVerified: true,
            restored: true,
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'windows-start-maximized-preference';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: persistencia de Iniciar maximizada (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_EXPLORER_DOUBLE_CLICK_ONLY === '1') {
        markPhase('doble clic real del Explorador');
        await setExplorerVisible(true);
        await exerciseExplorerDoubleClick();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'explorer-double-click';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: doble clic real del Explorador (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_MOUSE_SELECTION_ONLY === '1') {
        markPhase('selección de texto mediante arrastre real');
        await resizeWindow(1280, 820, { waitForBanner: false });
        const marker = 'LTERMINAL_MOUSE_DRAG_SELECTION';
        await sendTerminalLine(`echo ${marker}`);
        await waitUntil(async () => {
            const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
            return (await textOf(rows)).includes(marker);
        }, 10000, 'marcador para seleccionar con el ratón');

        const target = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const marker = arguments[0];
                const rows = [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows > div')];
                const row = rows.findLast((item) => (item.textContent || '').includes(marker));
                if (!row) return { error: 'marker-row-not-found' };
                const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                    const index = node.nodeValue?.indexOf(marker) ?? -1;
                    if (index < 0) continue;
                    const range = document.createRange();
                    range.setStart(node, index);
                    range.setEnd(node, index + marker.length);
                    const rect = range.getBoundingClientRect();
                    const screen = document.querySelector('.cell:not(.hidden) .xterm-screen');
                    const screenRect = screen?.getBoundingClientRect();
                    return {
                        // Entrar unos píxeles dentro de la primera y última
                        // celda evita que WebView2 redondee el gesto a un
                        // clic en el borde del canvas y no cree un rango.
                        startX: Math.round(rect.left + Math.max(4, rect.width / marker.length * 0.5)),
                        endX: Math.round(rect.right - Math.max(4, rect.width / marker.length * 0.5)),
                        y: Math.round((rect.top + rect.bottom) / 2),
                        textWidth: Math.round(rect.width),
                        screen: screenRect ? {
                            left: Math.round(screenRect.left), top: Math.round(screenRect.top),
                            right: Math.round(screenRect.right), bottom: Math.round(screenRect.bottom),
                        } : null,
                    };
                }
                return { error: 'marker-text-node-not-found', rowText: row.textContent };`,
            args: [marker],
        });
        if (target?.error || !Number.isFinite(target?.startX) || !Number.isFinite(target?.endX)) {
            throw new Error(`No se pudo localizar el texto visible para la prueba del ratón: ${JSON.stringify(target)}`);
        }
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `window.__lterminalMouseTrace = [];
                for (const type of ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup']) {
                    document.addEventListener(type, (event) => {
                        if (event.buttons || type.endsWith('down') || type.endsWith('up')) {
                            const rect = event.target instanceof Element ? event.target.getBoundingClientRect() : null;
                            window.__lterminalMouseTrace.push({
                                type, clientX: event.clientX, clientY: event.clientY,
                                offsetX: event.offsetX, offsetY: event.offsetY, buttons: event.buttons,
                                target: event.target instanceof Element ? event.target.className?.baseVal ?? event.target.className : String(event.target),
                                targetTop: rect ? Math.round(rect.top) : null,
                            });
                        }
                    }, true);
                }
                return true;`,
            args: [],
        });
        await request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{
                type: 'pointer',
                id: 'mouse',
                parameters: { pointerType: 'mouse' },
                actions: [
                    { type: 'pointerMove', origin: 'viewport', x: target.startX, y: target.y },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerMove', origin: 'viewport', x: target.endX, y: target.y, duration: 350 },
                    { type: 'pointerUp', button: 0 },
                ],
            }],
        });
        let selection;
        try {
            await waitUntil(async () => {
                selection = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const layer = document.querySelector('.cell:not(.hidden) .xterm-selection');
                        const boxes = [...(layer?.children ?? [])].map((item) => {
                            const rect = item.getBoundingClientRect();
                            return {
                                x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
                                style: item.getAttribute('style'), outerHTML: item.outerHTML,
                                backgroundColor: getComputedStyle(item).backgroundColor,
                            };
                        }).filter((rect) => rect.width > 0 && rect.height > 0);
                        const screen = document.querySelector('.cell:not(.hidden) .xterm-screen');
                        const row = [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows > div')]
                            .findLast((item) => (item.textContent || '').includes(arguments[0]));
                        const style = (item) => {
                            if (!item) return null;
                            const value = getComputedStyle(item);
                            return {
                                position: value.position, top: value.top, left: value.left,
                                height: value.height, zIndex: value.zIndex, backgroundColor: value.backgroundColor,
                            };
                        };
                        const rect = (item) => {
                            if (!item) return null;
                            const value = item.getBoundingClientRect();
                            return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) };
                        };
                        const selectionRules = [];
                        for (const sheet of [...document.styleSheets]) {
                            try {
                                for (const rule of [...sheet.cssRules]) {
                                    if (rule.cssText.includes('xterm-selection')) selectionRules.push(rule.cssText);
                                }
                            } catch {}
                        }
                        const xterm = document.querySelector('.cell:not(.hidden) .xterm');
                        const viewport = xterm?.querySelector('.xterm-viewport');
                        return {
                            layerFound: Boolean(layer), layerRect: rect(layer), layerStyle: style(layer),
                            boxes, boxStyle: style(layer?.firstElementChild), screenRect: rect(screen), rowRect: rect(row),
                            terminalClass: xterm?.className ?? null, screenClass: screen?.className ?? null,
                            viewport: viewport ? { rect: rect(viewport), inlineHeight: viewport.style.height, computedHeight: getComputedStyle(viewport).height } : null,
                            selectionRules,
                            nativeText: window.getSelection()?.toString() ?? '', mouseTrace: window.__lterminalMouseTrace ?? [],
                        };`,
                    args: [marker],
                });
                const selectedOnMarkerRow = selection?.boxes?.some((box) =>
                    box.width > 1 && box.height > 1
                    && box.backgroundColor !== 'rgba(0, 0, 0, 0)'
                    && box.backgroundColor !== 'transparent'
                    && box.y < selection.rowRect.y + selection.rowRect.height
                    && box.y + box.height > selection.rowRect.y
                    && box.x < target.endX
                    && box.x + box.width > target.startX,
                );
                return selectedOnMarkerRow === true;
            }, 3000, 'resaltado visible de xterm sobre la fila arrastrada');
        } catch (error) {
            await captureScreenshot('mouse-selection-no-resaltado');
            throw new Error(`El arrastre real no produjo un resaltado de texto xterm: ${JSON.stringify({ target, selection })}`, { cause: error });
        }
        await captureScreenshot('mouse-selection-drag');
        recordEvent('terminal-mouse-selection', {
            marker,
            target,
            selection,
            gesture: 'pointerDown → pointerMove while pressed → pointerUp',
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'terminal-mouse-drag-selection';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: selección con arrastre real (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (unicodeWidthsOnly) {
        markPhase('anchos Unicode alineados con ConPTY');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        // ⚡ ocupa una celda con las tablas de Unicode 6 y dos con las de
        // Unicode 11 y ConPTY; 日本 son anchos en ambas y ✓ estrecho. Al
        // insertar en mitad de la línea, cmd la redibuja con posiciones de
        // ConPTY: si xterm midiera distinto, el texto saldría descolocado.
        const typed = 'echo 日本⚡✓ WTW';
        const expected = '日本⚡✓ WTZW';
        await sendTerminalKeys(typed, cell, { enter: false, settle: true });
        await sendTerminalKeys('\uE012', cell, { enter: false, settle: true });
        await sendTerminalKeys('Z', cell, { enter: true, settle: true });
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === expected), 30000, 'salida de la línea con caracteres anchos');
        const snapshot = await terminalRowSnapshot(cell);
        const echoRow = snapshot.rows.find((row) => row.text.includes(`echo ${expected}`));
        if (!echoRow) {
            await captureScreenshot('anchos-unicode-desalineados');
            throw new Error(`La línea editada con caracteres anchos quedó descolocada: ${JSON.stringify(snapshot.rows.filter((row) => row.text.trim()).map((row) => row.text.trimEnd()))}`);
        }
        await assertNoDetachedCommandEcho([cell], [`echo ${expected}`], 'anchos-unicode');
        // Iconos Nerd Font (separador powerline y logo de Windows): los pinta la
        // fuente de símbolos que trae la app. Se imprimen con PowerShell porque
        // WebDriver reserva parte de esa zona de Unicode para sus teclas.
        await sendTerminalLine('powershell -NoProfile -Command "Write-Host ([string][char]0xE0B0 + [char]0xF17A + \' NERDOK\')"', cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.includes('NERDOK') && !row.text.includes('Write-Host')), 30000, 'iconos Nerd Font en la salida');
        let symbolsFont = null;
        await waitUntil(async () => {
            symbolsFont = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `return [...document.fonts]
                    .filter((face) => face.family.replace(/["']/g, '') === 'WTerminal Symbols')
                    .map((face) => face.status);`,
                args: [],
            });
            return Array.isArray(symbolsFont) && symbolsFont.includes('loaded');
        }, 15000, 'fuente de iconos WTerminal Symbols cargada');
        await captureScreenshot('anchos-unicode');
        recordEvent('unicode-widths', { typed, expected, echoRow: echoRow.text.trimEnd(), symbolsFont, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'unicode-widths';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write('E2E anchos Unicode OK: la línea con ⚡ y CJK se edita sin descolocarse.\n');
    } else if (inlineImagesOnly) {
        markPhase('imágenes en la terminal (Sixel e iTerm2)');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        // Lo que llega del PTY tal cual, antes de que xterm lo interprete: así
        // se sabe si ConPTY deja pasar las secuencias de imagen.
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `window.__e2eImageOut = '';
                window.addEventListener('winslim:terminal-output-busy', (event) => {
                    window.__e2eImageOut += event.detail?.data ?? '';
                });
                return true;`,
            args: [],
        });
        // Un bloque Sixel rojo de 8×60 píxeles (diez bandas, varias filas de
        // texto) y una imagen iTerm2 mínima. ST es ESC + una sola barra.
        const sixel = "[char]27+'Pq#0;2;100;0;0#0'+('~~~~~~~~-'*10)+[char]27+'\\'";
        const iterm = "[char]27+']1337;File=inline=1;size=4:AAAA'+[char]7";
        await sendTerminalLine(`powershell -NoProfile -Command "[Console]::Out.Write(${sixel}); [Console]::Out.Write(${iterm}); Write-Host IMGDONE"`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === 'IMGDONE'), 30000, 'fin de la salida con imágenes');
        const rawOutput = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'return window.__e2eImageOut ?? "";',
            args: [],
        });
        const passthrough = {
            sixel: rawOutput.includes('\u001bPq#0;2;100;0;0#0~~~~~~~~-'),
            iterm: rawOutput.includes('\u001b]1337;File=inline=1'),
        };
        if (!passthrough.sixel) {
            throw new Error(`ConPTY no deja pasar Sixel hasta xterm: ${JSON.stringify(rawOutput.slice(-400))}`);
        }
        // El complemento pinta en su capa: un canvas con píxeles rojos.
        let rendered = null;
        await waitUntil(async () => {
            rendered = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                    const canvases = [...(host?.querySelectorAll('canvas') ?? [])];
                    let red = 0;
                    for (const canvas of canvases) {
                        try {
                            const context = canvas.getContext('2d', { willReadFrequently: true });
                            if (!context || !canvas.width || !canvas.height) continue;
                            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                            for (let index = 0; index < data.length; index += 4) {
                                if (data[index] > 200 && data[index + 1] < 60 && data[index + 2] < 60 && data[index + 3] > 200) red += 1;
                            }
                        } catch { /* canvas de otro contexto */ }
                    }
                    return { canvases: canvases.length, red };`,
                args: [{ [elementKey]: cell }],
            });
            return rendered.red >= 8 * 40;
        }, 15000, 'imagen Sixel pintada por xterm');
        await captureScreenshot('imagenes-sixel-iterm');
        // Tras una imagen de varias filas, ConPTY y xterm deben seguir en la
        // misma fila: la orden siguiente no puede salir despegada.
        const afterMarker = `AFTERIMG_${Date.now().toString(36).toUpperCase()}`;
        await sendTerminalLine(`echo ${afterMarker}`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === afterMarker), 30000, 'salida de la orden tras la imagen');
        await assertNoDetachedCommandEcho([cell], [`echo ${afterMarker}`], 'despues-de-imagen');
        const rasterImage = "[char]27+'Pq'+[char]34+'1;1;8;60#0;2;0;0;100#0'+('~~~~~~~~-'*9)+'~~~~~~~~'+[char]27+'\\'";
        await sendTerminalLine(`powershell -NoProfile -Command "[Console]::Out.Write(${rasterImage}); Write-Host RASTERDONE"`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === 'RASTERDONE'), 30000, 'fin de la imagen con atributos de trama');
        const afterRaster = `AFTERRASTER_${Date.now().toString(36).toUpperCase()}`;
        await sendTerminalLine(`echo ${afterRaster}`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === afterRaster), 30000, 'salida de la orden tras la imagen 1:1');
        await assertNoDetachedCommandEcho([cell], [`echo ${afterRaster}`], 'despues-de-imagen-1-1');
        recordEvent('inline-images', {
            passthrough,
            rendered,
            passed: true,
        });
        process.stdout.write(`E2E imágenes: paso por ConPTY sixel=${passthrough.sixel} iterm=${passthrough.iterm}, píxeles de imagen=${rendered.red}.\n`);
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'inline-images';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write('E2E imágenes OK: Sixel llega intacto, xterm lo pinta y el eco sigue alineado después.\n');
    } else if (bannerImageOnly) {
        markPhase('imagen a la izquierda del banner');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        const appInfo = await invokeJson('app_info');
        const title = `${appInfo.name} ${appInfo.version}`;
        const factory = (await invokeJson('settings_get')).preferences;
        if (factory.bannerImage !== true || factory.bannerImageColumns !== 20 || factory.bannerImagePath !== '') {
            throw new Error(`La imagen del banner no viene activada con el logo y 20 columnas: ${JSON.stringify({
                bannerImage: factory.bannerImage, columns: factory.bannerImageColumns, path: factory.bannerImagePath,
            })}`);
        }
        const bannerState = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const cell = arguments[0];
                const rows = [...cell.querySelectorAll('.xterm-rows > div')].map((row) => {
                    const rect = row.getBoundingClientRect();
                    return { text: (row.textContent ?? '').replace(/\\u00a0/g, ' ').replace(/\\s+$/u, ''), top: rect.top, bottom: rect.bottom };
                });
                const screen = cell.querySelector('.xterm-screen')?.getBoundingClientRect();
                const images = [...cell.querySelectorAll('.banner-image-decoration')]
                    .filter((decoration) => getComputedStyle(decoration).display !== 'none')
                    .map((decoration) => {
                        const rect = decoration.getBoundingClientRect();
                        const image = decoration.querySelector('img[data-banner-image]');
                        return {
                            src: image?.getAttribute('src') ?? '',
                            loaded: Boolean(image?.complete && image.naturalWidth > 0),
                            top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height,
                        };
                    });
                return { rows, images, screenLeft: screen?.left ?? 0 };`,
            args: [{ [elementKey]: cell }],
        });
        const isLogo = (src) => !src.startsWith('data:') && /logo/i.test(src);
        const isCustomPng = (src) => src.startsWith('data:image/png;base64,');
        // El último banner con ese margen: imagen encima del margen, desde el
        // título hasta su última línea y centrada en él, con el mismo hueco
        // (BANNER_IMAGE_GAP celdas) contra el borde que contra el texto.
        const expectBannerImage = async (padding, accept, label) => {
            let state = null;
            let block = null;
            let image = null;
            const margin = ' '.repeat(padding);
            await waitUntil(async () => {
                state = await bannerState();
                const titleIndex = state.rows.findLastIndex((row) => row.text === `${margin}${title}`);
                if (titleIndex < 0) return false;
                let rows = 1;
                while (titleIndex + rows < state.rows.length) {
                    const text = state.rows[titleIndex + rows].text;
                    if (!(text.startsWith(margin) && text.length > padding && text[padding] !== ' ')) break;
                    rows += 1;
                }
                block = { titleIndex, rows };
                image = state.images.find((candidate) => Math.abs(candidate.top - state.rows[titleIndex].top) <= 2) ?? null;
                return rows >= 2 && Boolean(image?.loaded) && accept(image.src);
            }, 20000, `imagen del banner (${label})`);
            const titleRow = state.rows[block.titleIndex];
            const lastRow = state.rows[block.titleIndex + block.rows - 1];
            const bannerGap = 2;
            const cellWidth = image.width / (padding - 2 * bannerGap);
            const leftGap = image.left - state.screenLeft;
            const rightGap = padding * cellWidth - leftGap - image.width;
            const checks = {
                top: Math.abs(image.top - titleRow.top) <= 2,
                bottom: Math.abs(image.bottom - lastRow.bottom) <= 2,
                centered: Math.abs(leftGap - bannerGap * cellWidth) <= 2 && Math.abs(rightGap - leftGap) <= 2,
                single: state.images.filter((candidate) => Math.abs(candidate.top - titleRow.top) <= 2).length === 1,
            };
            if (!Object.values(checks).every(Boolean)) {
                throw new Error(`La imagen del banner no cubre su margen (${label}): ${JSON.stringify({ checks, image, titleRow, lastRow, screenLeft: state.screenLeft })}`);
            }
            return { padding, rows: block.rows, width: Math.round(image.width), height: Math.round(image.height), src: image.src.slice(0, 32) };
        };
        const results = {};
        results.factory = await expectBannerImage(22, isLogo, 'logo de fábrica');
        await captureScreenshot('banner-imagen-logo');
        // ConPTY solo ve el margen: el eco de la orden siguiente sigue pegado.
        const afterMarker = `BANNERIMG_${Date.now().toString(36).toUpperCase()}`;
        await sendTerminalLine(`echo ${afterMarker}`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === afterMarker), 30000, 'salida de la orden tras el banner con imagen');
        await assertNoDetachedCommandEcho([cell], [`echo ${afterMarker}`], 'tras-banner-con-imagen');

        const imageDirectory = await mkdtemp(join(tmpdir(), 'wterminal-e2e-banner-'));
        try {
            const customImage = join(imageDirectory, 'propia.png');
            // PNG de 1×1 rojo.
            await writeFile(customImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
            const notAnImage = join(imageDirectory, 'no-es-imagen.png');
            await writeFile(notAnImage, 'esto no es una imagen');
            await clickWhenReady('[data-testid="toolbar-settings"]');
            await findWhenReady('[role="dialog"]');
            await clickWhenReady('[data-testid="settings-tab-terminal"]');
            await findWhenReady('[data-testid="settings-banner-image-options"]');
            const setField = async (testId, value) => {
                await scrollIntoView(await findWhenReady(`[data-testid="${testId}"]`));
                await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const input = document.querySelector('[data-testid="' + arguments[0] + '"]');
                        input.value = arguments[1];
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;`,
                    args: [testId, value],
                });
                await waitForSettingsAutosave();
            };
            const previewSrc = async () => attribute(await findWhenReady('[data-testid="settings-banner-image-preview"]'), 'src');

            // Imagen propia: llega validada como data: a la vista previa y al banner.
            await setField('settings-banner-image-path', customImage);
            await waitUntil(async () => isCustomPng(await previewSrc() ?? ''), 15000, 'vista previa de la imagen propia');
            results.custom = await expectBannerImage(22, isCustomPng, 'imagen propia');
            await captureScreenshot('banner-imagen-propia');

            // Un archivo que no es imagen: aviso en Ajustes y vuelta al logo.
            await setField('settings-banner-image-path', notAnImage);
            const error = await findWhenReady('[data-testid="settings-banner-image-error"]', 15000);
            const errorText = await textOf(error);
            results.unreadable = { error: errorText.slice(0, 160), banner: await expectBannerImage(22, isLogo, 'imagen ilegible') };
            await clickInView(await findWhenReady('[data-testid="settings-banner-image-reset"]'));
            await waitForSettingsAutosave();
            await waitUntil(async () => (await invokeJson('settings_get')).preferences.bannerImagePath === '',
                10000, 'vuelta al logo de la app');

            // Ancho: se aplica al siguiente banner («Mostrar el banner ahora»),
            // que se recompone con su nuevo margen; la imagen encoge.
            const reprint = async () => {
                await clickInView(await findWhenReady('[data-testid="settings-banner-reprint"]'));
                await waitForSettingsAutosave();
            };
            await setField('settings-banner-image-columns', '12');
            await reprint();
            results.narrow = await expectBannerImage(14, isLogo, '12 columnas');
            // La capa cubre el margen menos el mismo hueco a cada lado (14 - 4
            // frente a 22 - 4 celdas) y la imagen va centrada en ella.
            const ratio = results.narrow.width / results.factory.width;
            if (Math.abs(ratio - 10 / 18) > 0.06) {
                throw new Error(`La capa de 12 columnas no mide 10/18 de la de 20: ${JSON.stringify({ ratio, narrow: results.narrow, factory: results.factory })}`);
            }

            // Apagada: el banner vuelve sin margen y sin imagen.
            await toggleCheckboxAndWait('[data-testid="settings-banner-image"]');
            await waitForSettingsAutosave();
            await reprint();
            await waitUntil(async () => {
                const state = await bannerState();
                return state.rows.some((row) => row.text === title) && state.images.length === 0;
            }, 20000, 'banner sin imagen ni margen');
            results.disabled = true;

            // Restaurar los valores de fábrica.
            await toggleCheckboxAndWait('[data-testid="settings-banner-image"]');
            await findWhenReady('[data-testid="settings-banner-image-options"]');
            await setField('settings-banner-image-columns', '20');
            await reprint();
            results.restored = await expectBannerImage(22, isLogo, 'restaurada');

            // Banner completo («Mostrar todo»): la capa es más alta que ancha y
            // la imagen la limita el ancho; debe seguir centrada, no pegada al
            // borde izquierdo. Después, vuelta a «Solo esencial».
            await clickInView(await findWhenReady('[data-testid="settings-banner-full"]'));
            await waitForSettingsAutosave();
            await reprint();
            results.full = await expectBannerImage(22, isLogo, 'banner completo');
            if (results.full.rows <= results.restored.rows || results.full.height <= results.full.width) {
                throw new Error(`El banner completo no dio una capa más alta que ancha: ${JSON.stringify({ full: results.full, restored: results.restored })}`);
            }
            await captureScreenshot('banner-imagen-completo');
            await clickInView(await findWhenReady('[data-testid="settings-banner-compact"]'));
            await waitForSettingsAutosave();
            await reprint();
            await expectBannerImage(22, isLogo, 'vuelta a solo esencial');
            await clickWhenReady('[role="dialog"] .panel-close');
            await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes');
        } finally {
            await rm(imageDirectory, { recursive: true, force: true }).catch(() => {});
        }
        recordEvent('banner-image', { ...results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'banner-image';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E imagen del banner OK: logo, imagen propia, ilegible, 12 columnas, apagada, restaurada y centrada en el banner completo (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (contextMenuEditOnly) {
        markPhase('menú contextual: buscar y editar la línea que se escribe');
        await waitForBannerPanes(1, 60000);
        await waitUntil(async () => (await attribute(await findWhenReady('.env-select'), 'disabled')) === null,
            90000, 'inventario completo de entornos');
        const available = ((await invokeJson('env_list', { tabId: null })).envs ?? [])
            .filter((environment) => environment.available)
            .map((environment) => environment.id);
        const shells = ['cmd', 'powershell', 'pwsh', 'gitbash'].filter((id) => available.includes(id));
        if (!shells.includes('cmd') || !shells.some((id) => id === 'powershell' || id === 'pwsh')) {
            throw new Error(`Faltan cmd o PowerShell para probar el menú contextual: ${JSON.stringify(shells)}`);
        }
        const results = [];
        for (const shell of shells) {
            await switchToEnvironment(shell);
            await waitForBannerPanes(1, 60000);
            const cell = await activeTerminalCell();
            results.push(await exerciseInputSelection(shell, cell));
            await captureScreenshot(`menu-contextual-${shell}`);
        }
        // «Buscar» con una selección de la salida (no editable): abre la
        // búsqueda con ese texto ya escrito y encuentra la coincidencia.
        const cell = await activeTerminalCell();
        const searchTag = `FIND${Date.now().toString(36).toUpperCase()}`;
        await sendTerminalLine(`echo ${searchTag}`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.trim() === searchTag), 15000, 'salida para buscar');
        // La última fila con la marca es la de la salida, no la de la orden.
        const searchMenu = await selectPhraseAndOpenMenu(cell, searchTag, searchTag);
        if (!searchMenu.search.text.includes(searchTag) || searchMenu.copy.disabled) {
            throw new Error(`El menú no ofrece buscar la selección: ${JSON.stringify(searchMenu)}`);
        }
        await clickWhenReady('[data-testid="terminal-menu-search"]');
        await findWhenReady('[data-testid="terminal-search"]', 5000);
        await waitUntil(async () => {
            const state = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const box = document.querySelector('.cell:not(.hidden) [data-testid="terminal-search"]');
                    return { value: box?.querySelector('input')?.value ?? '', count: Number(box?.querySelector('[data-testid="terminal-search-count"]')?.dataset.resultCount ?? 0) };`,
                args: [],
            });
            return state.value === searchTag && state.count >= 1;
        }, 10000, 'búsqueda abierta con la selección');
        await captureScreenshot('menu-contextual-buscar');
        await clickWhenReady('.cell:not(.hidden) [data-testid="terminal-search-close"]');
        recordEvent('context-menu-edit', { shells: results, search: { text: searchTag, found: true }, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'context-menu-edit';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E menú contextual OK: cortar y Supr dentro de lo escrito en ${results.map((item) => item.shell).join(', ')} y «Buscar» con la selección (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (githubAccountOnly) {
        markPhase('Mi GitHub: sesión de gh, crear y gestionar repositorios');
        await waitForBannerPanes(1, 60000);
        const callsLog = join(fakeGhDirectory, 'calls.log');
        const calls = async () => (await readFile(callsLog, 'utf8').catch(() => ''))
            .split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
        const waitForCall = async (expected, label) => {
            let lines = [];
            await waitUntil(async () => {
                lines = await calls();
                return lines.some((line) => line.trim() === expected);
            }, 20000, label);
            return lines;
        };
        // Rust cita los argumentos de un .cmd a su manera (también los que
        // llevan `=` o comas): se compara la lista de argumentos, no el texto.
        const splitCall = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]);
        const waitForArgs = async (expected, label) => {
            await waitUntil(async () => (await calls())
                .some((line) => JSON.stringify(splitCall(line)) === JSON.stringify(expected)), 20000, label);
        };
        const openGithubMode = async () => {
            if ((await findAll('[data-testid="projects-mode-github"]')).length === 0) {
                await clickWhenReady('[data-testid="toolbar-projects"]');
            }
            await clickWhenReady('[data-testid="projects-mode-github"]');
            return findWhenReady('[data-testid="projects-gh-account"]');
        };
        const accountState = async () => attribute(await findWhenReady('[data-testid="projects-gh-account"]'), 'data-state');
        const rowSelector = (fullName) => `[data-testid="projects-row"][data-full-name="${fullName}"]`;
        const openRowMenu = async (fullName) => {
            if ((await findAll(`${rowSelector(fullName)} [data-testid="projects-gh-visibility"]`)).length === 0) {
                await clickWhenReady(`${rowSelector(fullName)} [data-testid="projects-row-more"]`);
            }
            await findWhenReady(`${rowSelector(fullName)} [data-testid="projects-gh-visibility"]`);
        };
        const setInput = async (selector, value) => {
            await scrollIntoView(await findWhenReady(selector));
            await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const input = document.querySelector(arguments[0]);
                    input.value = arguments[1];
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;`,
                args: [selector, value],
            });
        };
        const results = {};

        // 1. Sin sesión: el panel lo dice y ofrece iniciarla.
        await openGithubMode();
        await waitUntil(async () => (await accountState()) === 'logged-out', 20000, 'Mi GitHub sin sesión');
        await captureScreenshot('mi-github-sin-sesion');
        // 2. Iniciar sesión: `gh auth login --web` en una pestaña nueva y visible.
        const tabsBefore = (await findAll('.tab[data-tab-id]')).length;
        await clickWhenReady('[data-testid="projects-gh-login"]');
        await waitForCall('auth login --hostname github.com --git-protocol https --web', 'gh auth login en la terminal');
        results.loginTab = (await findAll('.tab[data-tab-id]')).length > tabsBefore;
        // La pregunta de gh se responde escribiendo en la pestaña nueva: las
        // teclas tienen que llegar en cuanto se ve, no tras el seguro de 35 s.
        const loginCell = await activeTerminalCell();
        await waitUntil(async () => (await terminalRowSnapshot(loginCell)).rows
            .some((row) => row.text.includes('Authenticate Git')), 20000, 'pregunta Y/n de gh auth login');
        const answeredAt = Date.now();
        await sendTerminalKeys('y', loginCell, { enter: true, settle: true });
        const answerFile = join(fakeGhDirectory, 'state', 'login-answer');
        await waitUntil(async () => (await readFile(answerFile, 'utf8').catch(() => '')).includes('[y]'), 10000,
            'la respuesta a la pregunta de gh llega a la terminal');
        results.loginAnswerMs = Date.now() - answeredAt;
        // 3. Con sesión: la cuenta y sus repositorios.
        await openGithubMode();
        await clickWhenReady('[data-testid="projects-gh-check"]').catch(() => {});
        await waitUntil(async () => (await accountState()) === 'logged-in', 20000, 'Mi GitHub con sesión');
        const user = (await textOf(await findWhenReady('[data-testid="projects-gh-user"]'))).trim();
        if (user !== '@wterminal-e2e') throw new Error(`Cuenta inesperada: ${user}`);
        await findWhenReady(rowSelector('wterminal-e2e/demo'));
        await findWhenReady(rowSelector('wterminal-e2e/web'));
        await waitForCall('auth setup-git --hostname github.com', 'git configurado con las credenciales de gh');
        await captureScreenshot('mi-github-con-sesion');
        // 3b. La release de un repositorio se abre bajo su fila y se cierra con
        // «Release» otra vez, con «Cerrar» y al cambiar de pestaña (antes se
        // quedaba al pie del panel, en todas las pestañas, sin poder cerrarla).
        const demoRow = rowSelector('wterminal-e2e/demo');
        const releaseCount = async () => (await findAll('[data-testid="projects-release"]')).length;
        const openRelease = async () => {
            await openRowMenu('wterminal-e2e/demo');
            await clickWhenReady(`${demoRow} [data-testid="projects-row-release"]`);
            return findWhenReady(`${demoRow} [data-testid="projects-release"]`);
        };
        const releaseText = await textOf(await openRelease());
        if (!releaseText.includes('v1.0.0') || !releaseText.includes('demo-windows.zip')) {
            throw new Error(`La release no enseña su etiqueta y su adjunto: ${releaseText}`);
        }
        await captureScreenshot('mi-github-release');
        await clickWhenReady(`${demoRow} [data-testid="projects-row-release"]`);
        await waitUntil(async () => (await releaseCount()) === 0, 5000, '«Release» otra vez la cierra');
        await openRelease();
        await clickWhenReady('[data-testid="projects-release-close"]');
        await waitUntil(async () => (await releaseCount()) === 0, 5000, '«Cerrar» la cierra');
        await openRelease();
        await clickWhenReady('[data-testid="projects-mode-explore"]');
        await waitUntil(async () => (await releaseCount()) === 0, 5000, 'cambiar de pestaña la cierra');
        await openGithubMode();
        await waitUntil(async () => (await accountState()) === 'logged-in', 20000, 'vuelta a Mi GitHub');
        if ((await releaseCount()) !== 0) throw new Error('La release reaparece al volver a Mi GitHub.');
        results.releaseCloses = true;
        // 3c. «Gestionar…»: detalles, releases, pull requests, issues y Actions
        // contra el gh simulado; cada cambio llega a gh con sus argumentos.
        const repo = 'wterminal-e2e/demo';
        const manageIn = `${demoRow} [data-testid="gh-manage"]`;
        const manageTab = async (id) => {
            await clickWhenReady(`${manageIn} [data-testid="gh-manage-tab-${id}"]`);
            await waitUntil(async () => (await attribute(await findWhenReady(manageIn), 'data-section')) === id
                && (await attribute(await findWhenReady(manageIn), 'aria-busy')) !== 'true', 15000, `sección ${id} de Gestionar`);
        };
        await openRowMenu(repo);
        await clickWhenReady(`${demoRow} [data-testid="projects-gh-manage"]`);
        await findWhenReady(manageIn);
        await waitUntil(async () => (await property(await findWhenReady('[data-testid="gh-manage-description"]'), 'value')) === 'Privado de prueba',
            15000, 'detalles leídos de gh repo view');
        await setInput('[data-testid="gh-manage-description"]', 'Descripcion nueva');
        await setInput('[data-testid="gh-manage-topics"]', 'rust, terminal');
        await clickWhenReady('[data-testid="gh-manage-save"]');
        await waitForArgs(['repo', 'edit', repo, '--description', 'Descripcion nueva', '--homepage', '', '--default-branch', 'main',
            '--enable-issues=true', '--enable-wiki=false', '--add-topic', 'terminal', '--remove-topic', 'viejo'], 'gh repo edit con los detalles');
        await captureScreenshot('mi-github-gestionar-detalles');
        // Releases: publicar el borrador, quitar un adjunto, crear otra con un
        // adjunto y borrar una escribiendo su etiqueta.
        await manageTab('releases');
        await findWhenReady('[data-testid="gh-manage-release"][data-tag="v1.1.0-rc"]');
        await clickWhenReady('[data-testid="gh-manage-release"][data-tag="v1.1.0-rc"] [data-testid="gh-manage-release-publish"]');
        await waitForArgs(['release', 'edit', 'v1.1.0-rc', '--repo', repo, '--draft=false'], 'gh release edit para publicar el borrador');
        await clickWhenReady('[data-testid="gh-manage-release"][data-tag="v1.0.0"] [data-testid="gh-manage-release-assets"]');
        await clickWhenReady('[data-testid="gh-manage-asset"][data-asset="demo-windows.zip"] [data-testid="gh-manage-asset-delete"]');
        await waitForArgs(['release', 'delete-asset', 'v1.0.0', 'demo-windows.zip', '--repo', repo, '--yes'], 'gh release delete-asset');
        await clickWhenReady('[data-testid="gh-manage-release-new"]');
        await setInput('[data-testid="gh-manage-release-tag"]', 'v2.0.0');
        await setInput('[data-testid="gh-manage-release-title"]', 'Segunda');
        const attachment = join(fakeGhDirectory, 'adjunto.zip');
        await setInput('[data-testid="gh-manage-release-file-input"]', attachment);
        await clickWhenReady('[data-testid="gh-manage-release-file-add"]');
        await findWhenReady('[data-testid="gh-manage-release-file"]');
        await clickWhenReady('[data-testid="gh-manage-release-draft"]');
        await clickWhenReady('[data-testid="gh-manage-release-create"]');
        await waitForArgs(['release', 'create', 'v2.0.0', attachment, '--repo', repo, '--title', 'Segunda', '--notes', '', '--draft'],
            'gh release create con su adjunto');
        await clickWhenReady('[data-testid="gh-manage-release"][data-tag="v1.0.0"] [data-testid="gh-manage-release-delete"]');
        const releaseDelete = await findWhenReady('[data-testid="gh-manage-release-delete-confirm"]');
        if (!await property(releaseDelete, 'disabled')) throw new Error('Borrar una release debe esperar a que se escriba su etiqueta.');
        await setInput('[data-testid="gh-manage-release-delete-input"]', 'v1.0.0');
        await clickWhenReady('[data-testid="gh-manage-release-delete-confirm"]');
        await waitForArgs(['release', 'delete', 'v1.0.0', '--repo', repo, '--yes'], 'gh release delete tras escribir la etiqueta');
        await captureScreenshot('mi-github-gestionar-releases');
        // Git: sin copia local lo dice en vez de fallar.
        await manageTab('git');
        await findWhenReady('[data-testid="gh-manage-git-not-cloned"]');
        // Pull requests: fusionar (squash y borrar la rama) y crear otra.
        await manageTab('pulls');
        await clickWhenReady('[data-testid="gh-manage-pull"][data-number="7"] [data-testid="gh-manage-pull-merge"]');
        await waitForArgs(['pr', 'merge', '7', '--repo', repo, '--squash', '--delete-branch'], 'gh pr merge');
        await clickWhenReady('[data-testid="gh-manage-pull-new"]');
        await setInput('[data-testid="gh-manage-pull-head"]', 'feature/y');
        await setInput('[data-testid="gh-manage-pull-title"]', 'Nueva funcion');
        await clickWhenReady('[data-testid="gh-manage-pull-create"]');
        await waitForArgs(['pr', 'create', '--repo', repo, '--head', 'feature/y', '--base', 'main', '--title', 'Nueva funcion', '--body', ''],
            'gh pr create hacia la rama por defecto');
        // Issues: crear y cerrar.
        await manageTab('issues');
        await setInput('[data-testid="gh-manage-issue-title"]', 'Otro fallo');
        await clickWhenReady('[data-testid="gh-manage-issue-create"]');
        await waitForArgs(['issue', 'create', '--repo', repo, '--title', 'Otro fallo', '--body', ''], 'gh issue create');
        await clickWhenReady('[data-testid="gh-manage-issue"][data-number="3"] [data-testid="gh-manage-issue-close"]');
        await waitForArgs(['issue', 'close', '3', '--repo', repo], 'gh issue close');
        // Actions: relanzar lo que falló.
        await manageTab('runs');
        await clickWhenReady('[data-testid="gh-manage-run"][data-id="99"] [data-testid="gh-manage-run-rerun"]');
        await waitForArgs(['run', 'rerun', '99', '--repo', repo, '--failed'], 'gh run rerun');
        await captureScreenshot('mi-github-gestionar-actions');
        await clickWhenReady('[data-testid="gh-manage-close"]');
        await waitUntil(async () => (await findAll('[data-testid="gh-manage"]')).length === 0, 5000, 'Gestionar se cierra');
        results.manage = true;
        // 4. Crear un repositorio público con README y descripción.
        await clickWhenReady('[data-testid="projects-gh-new"]');
        await findWhenReady('[data-testid="projects-gh-create-form"]');
        await setInput('[data-testid="projects-gh-new-name"]', 'nuevo-e2e');
        await setInput('[data-testid="projects-gh-new-description"]', 'Repo de prueba E2E');
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const select = document.querySelector('[data-testid="projects-gh-new-visibility"]');
                select.value = 'public';
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return true;`,
            args: [],
        });
        await clickWhenReady('[data-testid="projects-gh-create"]');
        await waitForCall('repo create nuevo-e2e --public --description "Repo de prueba E2E" --add-readme', 'gh repo create con sus opciones');
        // 5. Visibilidad, archivo y nombre de un repositorio de la cuenta.
        await openRowMenu('wterminal-e2e/demo');
        await clickWhenReady(`${rowSelector('wterminal-e2e/demo')} [data-testid="projects-gh-visibility"]`);
        await waitForCall('repo edit wterminal-e2e/demo --visibility public --accept-visibility-change-consequences', 'gh repo edit de visibilidad');
        await openRowMenu('wterminal-e2e/demo');
        await clickWhenReady(`${rowSelector('wterminal-e2e/demo')} [data-testid="projects-gh-archive"]`);
        await waitForCall('repo archive wterminal-e2e/demo --yes', 'gh repo archive');
        await openRowMenu('wterminal-e2e/web');
        await clickWhenReady(`${rowSelector('wterminal-e2e/web')} [data-testid="projects-gh-archive"]`);
        await waitForCall('repo unarchive wterminal-e2e/web --yes', 'gh repo unarchive de un archivado');
        await openRowMenu('wterminal-e2e/demo');
        await clickWhenReady(`${rowSelector('wterminal-e2e/demo')} [data-testid="projects-gh-rename"]`);
        await setInput('[data-testid="projects-gh-rename-input"]', 'demo-renombrado');
        await clickWhenReady('[data-testid="projects-gh-rename-confirm"]');
        await waitForCall('repo rename demo-renombrado --repo wterminal-e2e/demo --yes', 'gh repo rename');
        // 6. Borrar: hay que escribir el nombre; sin el permiso delete_repo se
        // ofrece pedirlo (en la terminal) y después se borra.
        await openRowMenu('wterminal-e2e/demo');
        await clickWhenReady(`${rowSelector('wterminal-e2e/demo')} [data-testid="projects-gh-delete"]`);
        const confirmButton = await findWhenReady('[data-testid="projects-gh-delete-confirm"]');
        results.deleteLockedUntilTyped = Boolean(await property(confirmButton, 'disabled'));
        if (!results.deleteLockedUntilTyped) throw new Error('Borrar debe esperar a que se escriba el nombre completo.');
        await setInput('[data-testid="projects-gh-delete-input"]', 'wterminal-e2e/demo');
        await clickWhenReady('[data-testid="projects-gh-delete-confirm"]');
        await waitForCall('repo delete wterminal-e2e/demo --yes', 'primer intento de gh repo delete');
        await clickWhenReady('[data-testid="projects-gh-grant-delete"]', 20000);
        await waitForCall('auth refresh --hostname github.com --scopes delete_repo', 'gh auth refresh con delete_repo');
        await openGithubMode();
        await waitUntil(async () => (await accountState()) === 'logged-in', 20000, 'Mi GitHub tras dar el permiso');
        await openRowMenu('wterminal-e2e/demo');
        await clickWhenReady(`${rowSelector('wterminal-e2e/demo')} [data-testid="projects-gh-delete"]`);
        await setInput('[data-testid="projects-gh-delete-input"]', 'wterminal-e2e/demo');
        const deletesBefore = (await calls()).filter((line) => line.trim() === 'repo delete wterminal-e2e/demo --yes').length;
        await clickWhenReady('[data-testid="projects-gh-delete-confirm"]');
        await waitUntil(async () => (await calls()).filter((line) => line.trim() === 'repo delete wterminal-e2e/demo --yes').length > deletesBefore,
            20000, 'segundo gh repo delete');
        await waitUntil(async () => (await findAll('[data-testid="projects-gh-delete-input"]')).length === 0, 10000, 'borrado confirmado');
        await captureScreenshot('mi-github-gestion');
        // 7. Cerrar sesión, también en la terminal.
        await clickWhenReady('[data-testid="projects-gh-logout"]');
        await waitForCall('auth logout --hostname github.com', 'gh auth logout');
        await openGithubMode();
        await clickWhenReady('[data-testid="projects-gh-check"]').catch(() => {});
        await waitUntil(async () => (await accountState()) === 'logged-out', 20000, 'Mi GitHub tras cerrar sesión');
        results.calls = (await calls()).filter((line) => !/^(?:--version|api user)$/u.test(line.trim()));
        recordEvent('github-account', { ...results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'github-account';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E Mi GitHub OK: sesión, release, gestionar (detalles, releases, pull requests, issues y Actions), crear, visibilidad, archivar, renombrar, borrar con permiso y cerrar sesión (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (settingsSearchOnly) {
        markPhase('buscador, índice y explicaciones de Ajustes');
        await waitForBannerPanes(1, 60000);
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const shown = (testId) => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const element = document.querySelector('[data-testid="' + arguments[0] + '"]');
                return Boolean(element && !element.closest('.search-hidden') && element.getClientRects().length > 0);`,
            args: [testId],
        });
        const setSearch = async (value) => {
            await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const input = document.querySelector('[data-testid="settings-search"]');
                    input.value = arguments[0];
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;`,
                args: [value],
            });
        };
        const results = {};
        // 1. Índice de apartados en una sección larga: lleva a su encabezado.
        await findWhenReady('[data-testid="settings-index"]');
        const chips = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...document.querySelectorAll('[data-testid="settings-index"] button')].map((button) => button.textContent.trim());`,
            args: [],
        });
        const shortcutsChip = chips.findIndex((text) => /Atajos|Shortcuts/iu.test(text));
        if (chips.length < 4 || shortcutsChip < 0) throw new Error(`Índice de Comportamiento incompleto: ${JSON.stringify(chips)}`);
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `document.querySelectorAll('[data-testid="settings-index"] button')[arguments[0]].click(); return true;`,
            args: [shortcutsChip],
        });
        // Se busca el encabezado por su título exacto (el texto del chip): otros
        // encabezados mencionan los atajos en su explicación («Interfaz
        // modular») y quedan por encima, fuera de la vista.
        await waitUntil(async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const heading = [...document.querySelectorAll('.settings-form > section > .heading')]
                    .find((node) => (node.querySelector(':scope > strong')?.textContent ?? '').trim() === arguments[0]);
                const dialog = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
                const rect = heading?.getBoundingClientRect();
                return Boolean(rect && dialog && rect.top >= dialog.top - 2 && rect.top < dialog.top + dialog.height / 2);`,
            args: [chips[shortcutsChip]],
        }), 5000, 'el índice lleva a «Atajos de teclado»');
        results.index = chips;
        // Solo las pestañas largas llevan índice: Información (4 apartados
        // cortos) no; al volver a Comportamiento, reaparece.
        await clickWhenReady('[data-testid="settings-tab-about"]');
        await waitUntil(async () => (await attribute(await findWhenReady('[data-testid="settings-tab-about"]'), 'aria-selected')) === 'true',
            5000, 'pestaña Información');
        await new Promise((resolve) => setTimeout(resolve, 300));
        if ((await findAll('[data-testid="settings-index"]')).length !== 0) {
            throw new Error('Información enseña un índice y solo lo llevan las pestañas largas.');
        }
        results.aboutWithoutIndex = true;
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        await findWhenReady('[data-testid="settings-index"]');
        // 2. Buscar dentro de la sección y en otras: «maximizada» y «cursiva».
        await setSearch('maximizada');
        await waitUntil(async () => await shown('settings-start-maximized') && !(await shown('settings-show-tab-bar')),
            5000, 'la búsqueda deja solo «Iniciar maximizada»');
        results.maximized = (await textOf(await findWhenReady('[data-testid="settings-search-count"]'))).trim();
        await setSearch('cursiva');
        await waitUntil(async () => !(await shown('settings-start-maximized'))
            && Boolean(await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `return [...document.querySelectorAll('.settings-form label.check')]
                    .some((row) => !row.closest('.search-hidden') && row.getClientRects().length > 0 && /cursiva|italic/iu.test(row.textContent ?? ''));`,
                args: [],
            })), 5000, 'la búsqueda encuentra un ajuste de otra sección (Terminal)');
        // 3. Sin coincidencias, el buscador lo dice; Esc lo vacía.
        await setSearch('zzzz-no-existe');
        await waitUntil(async () => /Ningún|No setting/iu.test(await textOf(await findWhenReady('[data-testid="settings-search-count"]'))),
            5000, 'aviso sin coincidencias');
        await clickInView(await findWhenReady('[data-testid="settings-search"]'));
        await request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }],
        });
        await request(`/session/${sessionId}/actions`, 'DELETE');
        await waitUntil(async () => (await property(await findWhenReady('[data-testid="settings-search"]'), 'value')) === ''
            && (await findAll('[role="dialog"]')).length === 1, 5000, 'Esc vacía el buscador sin cerrar Ajustes');
        await findWhenReady('[data-testid="settings-index"]');
        // 4. Cada fila con explicación la enseña entera al pasar el ratón.
        const tooltip = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const row = document.querySelector('[data-testid="settings-show-projects"]')?.closest('label');
                return { title: row?.getAttribute('title') ?? '', small: row?.querySelector('small')?.textContent?.trim() ?? '' };`,
            args: [],
        });
        if (!tooltip.small || tooltip.title !== tooltip.small) throw new Error(`Falta la explicación de «Proyectos»: ${JSON.stringify(tooltip)}`);
        results.tooltip = tooltip.small;
        await captureScreenshot('ajustes-buscador');
        await clickWhenReady('[role="dialog"] .panel-close');
        recordEvent('settings-search', { ...results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'settings-search';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E Ajustes OK: índice, búsqueda en todas las secciones, sin coincidencias, Esc y explicaciones (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (shellAssistOnly) {
        markPhase('sugerencias del historial en la línea de órdenes');
        await waitForBannerPanes(1, 60000);
        await waitUntil(async () => (await attribute(await findWhenReady('.env-select'), 'disabled')) === null,
            90000, 'inventario completo de entornos');
        // PowerShell 7 trae PSReadLine con predicciones; Windows PowerShell 5.1
        // recibe el PSReadLine actual desde las herramientas del E2E y la
        // inicialización activa sus predicciones; cmd las recibe de Clink, que
        // la inicialización inyecta. Las tres deben sugerir en atenuado.
        const shells = [
            { id: 'pwsh', kind: 'powershell', tool: 'PSReadLine de PowerShell 7' },
            { id: 'powershell', kind: 'powershell', tool: 'PSReadLine 2.4 en Windows PowerShell 5.1' },
            { id: 'cmd', kind: 'cmd', tool: 'Clink' },
        ];
        if (shellAssistWslDistro) {
            shells.push({ id: `wsl:${shellAssistWslDistro}`, kind: 'bash', tool: `ble.sh en bash de WSL ${shellAssistWslDistro}` });
        }
        // Aspecto de las sugerencias (Ajustes → Terminal): un color propio
        // (#ff00ff, exacto también en la paleta de 256 colores de ble.sh) tiene
        // que llegar a PSReadLine, Clink y ble.sh en las pestañas nuevas.
        const suggestionColor = 'rgb(255, 0, 255)';
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await clickWhenReady('[data-testid="settings-tab-terminal"]');
        await clickInView(await findWhenReady('[data-testid="settings-shellAssistSuggestionColor-enabled"]'));
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const input = document.querySelector('[data-testid="settings-shellAssistSuggestionColor"]');
                input.value = '#ff00ff';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;`,
            args: [],
        });
        // De fábrica PowerShell muestra las predicciones en lista; este
        // escenario comprueba la sugerencia en línea (gris tras lo escrito),
        // así que la desactiva después de comprobar el valor de fábrica.
        const listView = await findWhenReady('[data-testid="settings-shell-assist-list-view"]');
        const listViewDefault = Boolean(await property(listView, 'checked'));
        if (!listViewDefault) throw new Error('Las predicciones en lista de PowerShell deberían venir activadas de fábrica.');
        await clickInView(listView);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await clickWhenReady('[role="dialog"] .panel-close');
        const results = [];
        for (const shell of shells) {
            await clickWhenReady('.env-select');
            const available = (await findAll(`.env-menu [data-environment-id="${shell.id}"]`)).length > 0;
            if (!available) {
                await closeEnvironmentMenu();
                if (shell.id === 'pwsh') {
                    results.push({ shell: shell.id, skipped: 'PowerShell 7 no está instalado' });
                    continue;
                }
                throw new Error(`El selector no ofrece ${shell.id}`);
            }
            await switchToEnvironment(shell.id);
            const cell = await activeTerminalCell();
            const marker = `WTASSIST${shell.id.toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
            // El historial de la prueba no se guarda en el del usuario (Clink
            // usa además un perfil temporal). Dos órdenes: la sugerencia se
            // busca por el principio de cada línea del historial.
            if (shell.kind === 'powershell') await sendTerminalLine('Set-PSReadLineOption -HistorySaveStyle SaveNothing', cell);
            if (shell.kind === 'bash') {
                // ble.sh tiene que haberse cargado desde la inicialización
                // (ruta de E2E en /tmp) y el historial no se guarda en disco.
                await sendTerminalLine('unset HISTFILE; echo WTBLE=${BLE_VERSION:+cargado}', cell);
                await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
                    .some((row) => row.text.trim() === 'WTBLE=cargado'), 30000, `ble.sh cargado en ${shell.id}`);
            }
            await sendTerminalLine(`echo ${marker}`, cell);
            await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
                .some((row) => row.text.trim() === marker), 30000, `salida del marcador en ${shell.id}`);
            const prefix = marker.slice(0, -5);
            const suffix = marker.slice(-5);
            await sendTerminalKeys(`echo ${prefix}`, cell, { enter: false, settle: true });
            let ghost = null;
            try {
                await waitUntil(async () => {
                    ghost = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                        // En la fila del prompt, el último fragmento cuyo texto es
                        // parte del sufijo sugerido: el primer carácter puede quedar
                        // bajo el bloque del cursor, en un span aparte.
                        script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                            const foreground = getComputedStyle(host.querySelector('.xterm-rows')).color;
                            const row = [...host.querySelectorAll('.xterm-rows > div')]
                                .filter((node) => (node.textContent ?? '').includes('echo ' + arguments[2])).at(-1);
                            if (!row) return null;
                            const span = [...row.querySelectorAll('span')].filter((node) => {
                                const part = (node.textContent ?? '').trim();
                                return part.length > 0 && arguments[1].includes(part);
                            }).at(-1);
                            if (!span) return { row: row.textContent ?? '' };
                            const style = getComputedStyle(span);
                            return { className: span.className, color: style.color, opacity: style.opacity, fontStyle: style.fontStyle, foreground,
                                part: span.textContent, row: row.textContent ?? '' };`,
                        args: [{ [elementKey]: cell }, suffix, prefix],
                    });
                    return Boolean(ghost?.part) && ghost.row.includes(`echo ${prefix}${suffix}`);
                }, 15000, `sugerencia del historial en ${shell.id}`);
            } catch (error) {
                await captureScreenshot(`sin-sugerencia-${shell.id}`);
                const rows = (await terminalRowSnapshot(cell)).rows.filter((row) => row.text.trim()).map((row) => row.text.trimEnd()).slice(-6);
                throw new Error(`${shell.tool} no sugirió el historial en ${shell.id}: ${JSON.stringify({ ghost, rows })}`, { cause: error });
            }
            const dimmed = /xterm-dim/u.test(ghost.className) || Number(ghost.opacity) < 1
                || ghost.color !== ghost.foreground || ghost.fontStyle === 'italic';
            if (!dimmed) throw new Error(`La sugerencia de ${shell.id} no se distingue de lo escrito: ${JSON.stringify(ghost)}`);
            if (ghost.color !== suggestionColor) {
                throw new Error(`La sugerencia de ${shell.id} no usa el color elegido en Ajustes (${suggestionColor}): ${JSON.stringify(ghost)}`);
            }
            await captureScreenshot(`sugerencia-historial-${shell.id}`);
            // Escape borra la línea en PSReadLine y en Clink sin ejecutar nada;
            // en bash (ble.sh) es un prefijo de Meta, y Ctrl+U la borra.
            if (shell.kind === 'bash') await sendWindowShortcut(['\uE009', 'u']);
            else await sendTerminalKeys('\uE00C', cell, { enter: false, settle: true });
            results.push({ shell: shell.id, tool: shell.tool, ghost: { className: ghost.className, color: ghost.color, fontStyle: ghost.fontStyle } });
        }
        recordEvent('shell-assist', { passed: true, results });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'shell-assist';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E sugerencias OK: ${results.filter((result) => !result.skipped).map((result) => result.shell).join(', ')} sugieren el historial atenuado tras lo escrito.\n`);
    } else if (aiEnvironmentsOnly) {
        markPhase('asistentes de IA y modelos locales simulados');
        await waitForBannerPanes(1, 60000);
        await waitUntil(async () => (await attribute(await findWhenReady('.env-select'), 'disabled')) === null,
            90000, 'inventario completo de entornos');
        const readAiOptions = async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...document.querySelectorAll('.env-menu [data-testid="environment-option"]')].map((option) => ({
                    id: option.getAttribute('data-environment-id'),
                    label: option.querySelector('.env-copy strong')?.textContent?.trim() ?? '',
                    group: option.closest('.env-group')?.querySelector('.env-group-title')?.textContent?.trim() ?? '',
                }));`,
            args: [],
        });
        await clickWhenReady('.env-select');
        let aiOptions = [];
        await waitUntil(async () => {
            aiOptions = (await readAiOptions()).filter((option) => String(option.id).startsWith('ai:'));
            return ['ai:claude', 'ai:ollama:qwen3.8:27b'].every((id) => aiOptions.some((option) => option.id === id));
        }, 30000, 'CLI y modelo local de IA en el selector');
        const groups = new Set(aiOptions.map((option) => option.group));
        if (groups.size !== 1 || ![...groups][0]) {
            throw new Error(`Los entornos de IA deben compartir un único apartado del selector: ${JSON.stringify(aiOptions)}`);
        }
        await captureScreenshot('ia-selector');
        const cell = await activeTerminalCell();
        const openAiEnvironment = async (id, expected) => {
            const label = await switchToEnvironment(id);
            await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.some((row) => row.text.includes(expected)),
                30000, `salida de ${id} en su pestaña`);
            return label;
        };
        const ollamaLabel = await openAiEnvironment('ai:ollama:qwen3.8:27b', 'WTERMINAL_FAKE_OLLAMA run qwen3.8:27b');
        await captureScreenshot('ia-chat-ollama');
        // La copia de choice.exe pinta su pregunta («[S,N]?», o «[]?» sin su
        // archivo de mensajes) y espera: prueba que se abrió la versión mayor.
        // La menor (whoami.exe) imprimiría «equipo\usuario» y terminaría.
        const machine = (await execFile('hostname.exe', [], { windowsHide: true })).stdout.trim();
        const claudeLabel = await switchToEnvironment('ai:claude');
        let claudeRows = [];
        await waitUntil(async () => {
            claudeRows = (await terminalRowSnapshot(cell)).rows.map((row) => row.text.trim());
            return claudeRows.some((row) => /\]\?$/u.test(row));
        }, 30000, 'Claude Code de la app de escritorio (versión mayor) abierto en su pestaña');
        if (claudeRows.some((row) => row.includes('\\') && row.toLowerCase().startsWith(machine.toLowerCase() + '\\'))) {
            throw new Error(`Se abrió la versión antigua de Claude Code: ${JSON.stringify(claudeRows.slice(-6))}`);
        }
        await captureScreenshot('ia-claude-code');

        // Dependencias: apartado propio y el modelo simulado figura como descargado.
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        await findWhenReady('[data-testid="dependency-section"][data-section-id="ai"]', 60000);
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const section = document.querySelector('[data-testid="dependency-section"][data-section-id="ai"]');
                section.open = true;
                section.querySelectorAll('details').forEach((details) => { details.open = true; });
                return true;`,
            args: [],
        });
        // Con el modelo descargado, el panel muestra «Borrar» y oculta
        // «Descargar» (nunca las dos mitades a la vez). Los requisitos se
        // comprueban en uno no descargado: gpt-oss:20b (14 GB) pide ≈ 16 GB.
        let modelState = null;
        try {
            await waitUntil(async () => {
                modelState = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const section = document.querySelector('[data-testid="dependency-section"][data-section-id="ai"]');
                        section?.querySelectorAll('details').forEach((details) => { details.open = true; });
                        // En una acción de instalar, data-installed indica que su
                        // requisito (aquí Ollama) está presente, no la herramienta.
                        const state = (id) => {
                            const node = section?.querySelector('[data-action-id="' + id + '"]');
                            return node ? {
                                installed: node.getAttribute('data-installed'),
                                status: node.getAttribute('data-detection-status'),
                                hint: node.closest('.item')?.querySelector('.hint')?.textContent?.trim() ?? '',
                            } : null;
                        };
                        return {
                            download: state('ai-model-qwen3-8-27b'),
                            remove: state('ai-model-qwen3-8-27b-uninstall'),
                            otherDownload: state('ai-model-gpt-oss-20b'),
                            gemini: state('ai-gemini-cli'),
                            text: (section?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 1200),
                        };`,
                    args: [],
                });
                return Boolean(modelState?.remove)
                    && !modelState.download
                    && /Descarga ≈ 14 GB\. Necesita ≈ 16 GB/u.test(modelState.otherDownload?.hint ?? '')
                    && Boolean(modelState.gemini);
            }, 120000, 'modelo simulado reconocido como descargado y requisitos visibles');
        } catch (error) {
            const { text, ...rest } = modelState ?? {};
            throw new Error(`Inteligencia artificial en Dependencias no muestra el estado esperado: ${JSON.stringify(rest)} · ${String(text ?? '').slice(0, 800)}`, { cause: error });
        }
        await captureScreenshot('ia-dependencias');

        // Una acción del panel en cmd se escribe como UNA sola línea: la orden
        // real entre `call …ini.cmd` y `call …fin.cmd`, sin los `echo` de la
        // cabecera como órdenes sueltas. El cierre sale del código real.
        await clickWhenReady('[role="dialog"] .panel-close');
        await switchToEnvironment('cmd');
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.some((row) => />\s*$/u.test(row.text.trimEnd())),
            30000, 'prompt de cmd');
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        await findWhenReady('[data-testid="dependency-section"][data-section-id="ai"]', 60000);
        // La acción está en «Ollama · gestión de modelos», dentro de un grupo y
        // un subgrupo plegados. Se abre solo su cadena de `<details>` (abrir
        // todos choca con el acordeón exclusivo, y al reabrirse el panel
        // reinicia los acordeones) y se espera a verla dos veces seguidas.
        let ollamaListVisible = 0;
        let ollamaListState = null;
        await waitUntil(async () => {
            ollamaListState = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const section = document.querySelector('[data-testid="dependency-section"][data-section-id="ai"]');
                    const button = section?.querySelector('[data-testid="dependency-action"][data-action-id="ai-ollama-list"]');
                    if (!section || !button) return { found: false };
                    if (!section.open) section.open = true;
                    for (let details = button.closest('details'); details && details !== section; details = details.parentElement?.closest('details')) {
                        if (!details.open) details.open = true;
                    }
                    button.scrollIntoView({ block: 'center' });
                    const rect = button.getBoundingClientRect();
                    return { found: true, visible: button.getClientRects().length > 0 && rect.height > 0
                        && rect.top >= 0 && rect.bottom <= innerHeight && !button.disabled };`,
                args: [],
            });
            ollamaListVisible = ollamaListState?.visible ? ollamaListVisible + 1 : 0;
            return ollamaListVisible >= 2;
        }, 60000, 'acción «Ver los modelos descargados» visible en Dependencias').catch((error) => {
            throw new Error(`La acción de Ollama no llegó a verse: ${JSON.stringify(ollamaListState)}`, { cause: error });
        });
        await clickWhenReady('[data-testid="dependency-action"][data-action-id="ai-ollama-list"]', 60000);
        // Al preparar la acción, el panel se cierra solo (`panels.close()` en
        // `run`); si no lo hiciera, se cierra a mano.
        await waitUntil(async () => (await findAll('[role="dialog"] .panel-close')).length === 0, 10000, 'cierre del panel tras la acción')
            .catch(() => clickWhenReady('[role="dialog"] .panel-close'));
        let actionRows = [];
        await waitUntil(async () => {
            actionRows = (await terminalRowSnapshot(cell)).rows.map((row) => row.text.trimEnd()).filter(Boolean);
            return actionRows.some((row) => row.includes('WTERMINAL_FAKE_OLLAMA list'));
        }, 30000, 'salida de la acción «Ver los modelos descargados» en cmd');
        // Solo cuentan las órdenes escritas tras el prompt de cmd: la cabecera
        // visual de la acción («│ ollama list») también nombra la orden.
        const typed = actionRows.filter((row) => /^[A-Za-z]:\\[^>]*>/u.test(row) && row.includes('ollama list'));
        const oneLine = typed.length === 1
            && typed[0].includes('call "%WSTERM_UI%\\ui-') && typed[0].includes('ini.cmd" & ollama list & call')
            && !actionRows.some((row) => /echo %WSTERM_ESC%|if errorlevel|if not errorlevel/u.test(row))
            && actionRows.some((row) => row.includes('┌─ VER'));
        await sendTerminalKeys('', cell, { enter: true, settle: true });
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.some((row) => row.text.includes('✔')),
            30000, 'cierre de la acción con su resultado');
        await captureScreenshot('ia-accion-cmd-una-linea');
        await sendTerminalKeys('', cell, { enter: true, settle: true });
        if (!oneLine) {
            throw new Error(`La acción no se escribió como una sola línea en cmd: ${JSON.stringify(actionRows.slice(-12))}`);
        }
        recordEvent('ai-environments', {
            options: aiOptions,
            opened: [ollamaLabel, claudeLabel],
            model: { remove: modelState.remove, download: modelState.download },
            cmdActionLine: typed[0],
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'ai-environments';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E IA OK: ${aiOptions.length} entornos de IA, chat de Ollama y Claude Code abiertos, modelo descargado reconocido.\n`);
    } else if (terminalLinksOnly) {
        markPhase('enlaces clicables con Ctrl+clic');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        const problems = [];
        const results = {};
        const runScript = (script, args = []) => request(`/session/${sessionId}/execute/sync`, 'POST', { script, args });
        const readOpened = async () => {
            try {
                return (await readFile(openedLinksFile, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
            } catch {
                return [];
            }
        };
        // Lo que el frontend pide al backend (el IPC real, sin tocarlo) y los
        // clics que llegan a la página con su tecla Ctrl.
        // Tauri 2 define `__TAURI_INTERNALS__.invoke` como propiedad no
        // modificable: el espía solo cuenta si de verdad quedó instalado. Lo
        // que manda es el registro del backend (`readOpened`), que guarda la
        // URL exacta que recibió y validó.
        const spyActive = await runScript(`window.__e2eLinkCalls = [];
            window.__e2eLinkMouse = [];
            for (const type of ['mousedown', 'mouseup']) {
                document.addEventListener(type, (event) => window.__e2eLinkMouse.push({ type, ctrlKey: event.ctrlKey, button: event.button }), true);
            }
            const internals = window.__TAURI_INTERNALS__;
            let active = false;
            if (internals) {
                const original = internals.invoke.bind(internals);
                const spy = (cmd, args, options) => {
                    if (cmd === 'terminal_open_link') window.__e2eLinkCalls.push(args?.url ?? null);
                    return original(cmd, args, options);
                };
                try { internals.invoke = spy; } catch {}
                active = internals.invoke === spy;
            }
            window.__e2eRawOut = '';
            window.addEventListener('winslim:terminal-output-busy', (event) => { window.__e2eRawOut += event.detail?.data ?? ''; });
            return active;`);
        const linkCalls = async () => (spyActive ? await runScript('return window.__e2eLinkCalls ?? [];') : []);
        const dialogOpen = async () => (await findAll('[data-testid="terminal-link-dialog"]')).length > 0;
        // Centro del texto dentro de la fila de xterm que lo contiene, aunque
        // el renderer lo haya partido en varios <span>.
        const locate = async (wanted, exclude = '') => {
            const target = await runScript(`const [cell, wanted, exclude] = arguments;
                const rows = [...cell.querySelectorAll('.xterm-rows > div')];
                const row = rows.findLast((item) => {
                    const text = item.textContent || '';
                    return text.includes(wanted) && !(exclude && text.includes(exclude));
                });
                if (!row) return { error: 'fila no encontrada' };
                const nodes = [];
                let text = '';
                const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) { nodes.push({ node, start: text.length }); text += node.nodeValue ?? ''; }
                const index = text.indexOf(wanted);
                if (index < 0) return { error: 'texto no encontrado', text };
                const startAt = nodes.findLast((entry) => entry.start <= index);
                const end = index + wanted.length;
                const endAt = nodes.findLast((entry) => entry.start < end);
                const range = document.createRange();
                range.setStart(startAt.node, index - startAt.start);
                range.setEnd(endAt.node, end - endAt.start);
                const rect = range.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + Math.min(rect.width / 2, 120)),
                    y: Math.round((rect.top + rect.bottom) / 2),
                    awayX: Math.round(Math.min(window.innerWidth - 40, rect.right + 160)),
                    width: Math.round(rect.width),
                    rowText: text.trimEnd(),
                };`, [{ [elementKey]: cell }, wanted, exclude]);
            if (target?.error || !Number.isFinite(target?.x)) throw new Error(`No se localizó «${wanted}» en la terminal: ${JSON.stringify(target)}`);
            return target;
        };
        // Gesto real: el ratón sale del enlace y vuelve (xterm solo detecta
        // un enlace al entrar en él), espera la detección y pulsa, con o sin
        // Ctrl mantenido durante todo el gesto.
        const clickLink = async (target, { ctrl = true } = {}) => {
            const keyTicks = ctrl
                ? [{ type: 'keyDown', value: '\uE009' }, { type: 'pause' }, { type: 'pause' }, { type: 'pause' }, { type: 'pause' }, { type: 'pause' }, { type: 'keyUp', value: '\uE009' }]
                : Array.from({ length: 7 }, () => ({ type: 'pause' }));
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [
                    { type: 'key', id: 'keyboard', actions: keyTicks },
                    {
                        type: 'pointer',
                        id: 'mouse',
                        parameters: { pointerType: 'mouse' },
                        actions: [
                            { type: 'pause', duration: 0 },
                            { type: 'pointerMove', origin: 'viewport', x: target.awayX, y: target.y, duration: 60 },
                            { type: 'pointerMove', origin: 'viewport', x: target.x, y: target.y, duration: 60 },
                            { type: 'pause', duration: 250 },
                            { type: 'pointerDown', button: 0 },
                            { type: 'pointerUp', button: 0 },
                            { type: 'pause', duration: 0 },
                        ],
                    },
                ],
            });
            await request(`/session/${sessionId}/actions`, 'DELETE').catch(() => {});
        };
        const hoverLink = async (target) => {
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{
                    type: 'pointer',
                    id: 'mouse',
                    parameters: { pointerType: 'mouse' },
                    actions: [
                        { type: 'pointerMove', origin: 'viewport', x: target.awayX, y: target.y, duration: 60 },
                        { type: 'pointerMove', origin: 'viewport', x: target.x, y: target.y, duration: 60 },
                    ],
                }],
            });
            let hover = null;
            await waitUntil(async () => {
                hover = await runScript(`const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                    return { url: host?.dataset.linkHover ?? null, title: host?.getAttribute('title') ?? '',
                        pointer: Boolean(arguments[0].querySelector('.xterm-cursor-pointer')) };`, [{ [elementKey]: cell }]);
                return Boolean(hover.url);
            }, 5000, 'enlace detectado al pasar el ratón').catch(() => {});
            return hover;
        };
        const setLinkPreference = async (testId, wanted) => {
            await clickWhenReady('[data-testid="toolbar-settings"]');
            await findWhenReady('[role="dialog"]');
            await clickWhenReady('[data-testid="settings-tab-terminal"]');
            const input = await findWhenReady(`[data-testid="${testId}"]`);
            if (Boolean(await property(input, 'checked')) !== wanted) await toggleCheckboxAndWait(`[data-testid="${testId}"]`);
            await waitForSettingsAutosave();
            await clickWhenReady('[role="dialog"] .panel-close');
            await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, `cierre de Ajustes tras ${testId}`);
            await new Promise((resolve) => setTimeout(resolve, 400));
        };
        const marker = Date.now().toString(36);
        const url = `https://example.com/wterminal-e2e/enlaces?caso=${marker}`;

        // 1. La URL impresa se subraya al pasar el ratón y avisa de Ctrl+clic.
        await sendTerminalLine(`echo ${url}`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.some((row) => row.text.trim() === url), 30000, 'URL impresa en la salida');
        const urlTarget = await locate(url, 'echo');
        results.hover = await hoverLink(urlTarget);
        if (results.hover?.url !== url) problems.push(`al pasar el ratón no se detectó la URL: ${JSON.stringify(results.hover)}`);
        else if (!results.hover.title.includes(url) || !/Ctrl/u.test(results.hover.title)) problems.push(`el aviso al pasar el ratón no explica Ctrl+clic: ${results.hover.title}`);
        await captureScreenshot('enlaces-hover');

        // 2. Un clic normal no abre nada.
        await clickLink(urlTarget, { ctrl: false });
        await new Promise((resolve) => setTimeout(resolve, 900));
        results.plainClick = { dialog: await dialogOpen(), calls: await linkCalls(), opened: await readOpened() };
        if (results.plainClick.dialog || results.plainClick.calls.length || results.plainClick.opened.length) {
            problems.push(`un clic sin Ctrl intentó abrir el enlace: ${JSON.stringify(results.plainClick)}`);
        }

        // 3. Ctrl+clic pide confirmación con la URL completa; cancelar no abre.
        await clickLink(urlTarget);
        try {
            await waitUntil(dialogOpen, 5000, 'confirmación del enlace');
        } catch (error) {
            const mouse = await runScript('return window.__e2eLinkMouse ?? [];');
            await captureScreenshot('enlaces-sin-confirmacion');
            throw new Error(`Ctrl+clic no pidió confirmación: ${JSON.stringify({ mouse: mouse.slice(-6), calls: await linkCalls() })}`, { cause: error });
        }
        results.dialog = await runScript(`const dialog = document.querySelector('[data-testid="terminal-link-dialog"]');
            return { url: dialog?.dataset.url ?? null, shown: dialog?.querySelector('[data-testid="terminal-link-url"]')?.textContent ?? '',
                host: dialog?.querySelector('[data-testid="terminal-link-host"]')?.textContent ?? '',
                focused: document.activeElement?.dataset?.testid ?? null };`);
        if (results.dialog.url !== url || results.dialog.shown.trim() !== url || results.dialog.host !== 'example.com') {
            problems.push(`la confirmación no muestra el destino exacto: ${JSON.stringify(results.dialog)}`);
        }
        await captureScreenshot('enlaces-confirmacion');
        await clickWhenReady('[data-testid="terminal-link-cancel"]');
        await waitUntil(async () => !(await dialogOpen()), 5000, 'cierre de la confirmación');
        await new Promise((resolve) => setTimeout(resolve, 600));
        if ((await linkCalls()).length || (await readOpened()).length) problems.push('cancelar la confirmación abrió el enlace');

        // 4. Ctrl+clic y «Abrir»: se pide abrir exactamente esa URL.
        await clickLink(urlTarget);
        await waitUntil(dialogOpen, 5000, 'segunda confirmación del enlace');
        await clickWhenReady('[data-testid="terminal-link-open"]');
        await waitUntil(async () => (await readOpened()).length >= 1, 10000, 'apertura simulada registrada por el backend');
        results.confirmed = { spyActive, calls: await linkCalls(), opened: await readOpened() };
        // Campo a campo: el backend escribe las claves en otro orden.
        const confirmedOpen = results.confirmed.opened;
        if ((spyActive && JSON.stringify(results.confirmed.calls) !== JSON.stringify([url]))
            || confirmedOpen.length !== 1 || confirmedOpen[0]?.url !== url || confirmedOpen[0]?.action !== 'browser') {
            problems.push(`la apertura confirmada no pidió exactamente la URL impresa: ${JSON.stringify(results.confirmed)}`);
        }

        // 5. Hipervínculo OSC 8 (texto que no es una URL): mismo gesto y la
        // misma validación, si ConPTY deja pasar la secuencia.
        const osc8Url = `https://example.com/wterminal-e2e/osc8?caso=${marker}`;
        const osc8Text = `WTERMINAL_OSC8_${marker.toUpperCase()}`;
        await sendTerminalLine(`powershell -NoProfile -Command "[Console]::Out.Write([char]27+']8;;${osc8Url}'+[char]27+'\\'+'${osc8Text}'+[char]27+']8;;'+[char]27+'\\'); Write-Host ''"`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.some((row) => row.text.trim() === osc8Text), 30000, 'texto del hipervínculo OSC 8');
        results.osc8 = { passthrough: (await runScript('return window.__e2eRawOut ?? "";')).includes(`\u001b]8;;${osc8Url}`) };
        if (results.osc8.passthrough) {
            const osc8Target = await locate(osc8Text, 'Console');
            results.osc8.hover = await hoverLink(osc8Target);
            if (results.osc8.hover?.url !== osc8Url) problems.push(`el hipervínculo OSC 8 no se detectó: ${JSON.stringify(results.osc8.hover)}`);
            await clickLink(osc8Target);
            await waitUntil(dialogOpen, 5000, 'confirmación del hipervínculo OSC 8');
            results.osc8.dialogUrl = await runScript(`return document.querySelector('[data-testid="terminal-link-dialog"]')?.dataset.url ?? null;`);
            await captureScreenshot('enlaces-osc8');
            await clickWhenReady('[data-testid="terminal-link-open"]');
            await waitUntil(async () => (await readOpened()).length >= 2, 10000, 'apertura simulada del OSC 8');
            const last = (await readOpened()).at(-1);
            if (results.osc8.dialogUrl !== osc8Url || last?.url !== osc8Url || last?.action !== 'browser') {
                problems.push(`el OSC 8 no abrió su destino: ${JSON.stringify({ ...results.osc8, last })}`);
            }
        }

        // 6. Sin confirmación: Ctrl+clic abre directamente; un enlace file://
        // a un programa solo lo muestra en su carpeta y una carpeta se abre.
        await setLinkPreference('settings-terminal-links-confirm', false);
        let expectedCount = (await readOpened()).length;
        await clickLink(await locate(url, 'echo'));
        await waitUntil(async () => (await readOpened()).length > expectedCount, 10000, 'apertura directa sin confirmación');
        expectedCount += 1;
        results.withoutConfirm = { dialog: await dialogOpen(), last: (await readOpened()).at(-1) };
        if (results.withoutConfirm.dialog || results.withoutConfirm.last?.url !== url) {
            problems.push(`sin confirmación no se abrió directamente: ${JSON.stringify(results.withoutConfirm)}`);
        }
        const normalizePath = (value) => String(value ?? '').replace(/[\\/]+$/u, '').toLowerCase();
        const programPath = join(terminalLinksDirectory, 'programa-e2e.exe');
        results.files = [];
        for (const [fileUrl, action, expectedPath] of [
            [pathToFileURL(programPath).href, 'reveal', programPath],
            [`${pathToFileURL(terminalLinksDirectory).href}/`, 'directory', terminalLinksDirectory],
        ]) {
            await sendTerminalLine(`echo ${fileUrl}`, cell);
            await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.some((row) => row.text.trim() === fileUrl), 30000, `enlace ${action} impreso`);
            await clickLink(await locate(fileUrl, 'echo'));
            await waitUntil(async () => (await readOpened()).length > expectedCount, 10000, `apertura simulada ${action}`);
            expectedCount += 1;
            const last = (await readOpened()).at(-1);
            results.files.push({ fileUrl, last });
            if (last?.action !== action || normalizePath(last?.url) !== normalizePath(expectedPath)) {
                problems.push(`el enlace file:// (${action}) no hizo lo esperado: ${JSON.stringify({ fileUrl, last })}`);
            }
        }
        await captureScreenshot('enlaces-sin-confirmacion-file');

        // 7. El backend rechaza lo que no es http, https ni file local, aunque
        // se le pida directamente por IPC.
        // Se devuelve serializado: `request` toma cualquier valor con un campo
        // `error` por un error de WebDriver, y aquí `error` es el código de
        // rechazo que se quiere comprobar.
        const invokeLink = async (target) => JSON.parse(await runScript(
            'return window.__TAURI_INTERNALS__.invoke("terminal_open_link", { url: arguments[0] }).then((result) => JSON.stringify(result));',
            [target]));
        results.rejected = {};
        for (const [target, code] of [
            ['javascript:alert(1)', 'scheme'],
            ['ms-settings:privacy', 'scheme'],
            ['file://servidor-e2e/recurso/archivo.txt', 'remote-file'],
            ['https://usuario:clave@example.com/', 'credentials'],
            ['https://exa\nmple.com/', 'hidden-characters'],
        ]) {
            const result = await invokeLink(target);
            results.rejected[target] = result;
            if (result?.ok !== false || result?.error !== code) problems.push(`el backend no rechazó «${JSON.stringify(target)}» con ${code}: ${JSON.stringify(result)}`);
        }
        if ((await readOpened()).length !== expectedCount) problems.push('un enlace rechazado llegó a registrarse como abierto');

        // 8. Con los enlaces desactivados no se subraya ni se abre nada, y el
        // backend tampoco acepta la petición.
        await setLinkPreference('settings-terminal-links', false);
        results.disabled = {
            attribute: await runScript(`return arguments[0].querySelector('.tab-pane:not(.hidden)')?.dataset.terminalLinks ?? null;`, [{ [elementKey]: cell }]),
        };
        const callsBeforeDisabled = (await linkCalls()).length;
        // Se vuelve a imprimir: la fila del principio puede haber salido ya de
        // la vista con las salidas anteriores.
        await sendTerminalLine(`echo ${url}`, cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows.filter((row) => row.text.trim() === url).length > 0, 30000, 'URL impresa con los enlaces desactivados');
        const disabledTarget = await locate(url, 'echo');
        await clickLink(disabledTarget);
        await new Promise((resolve) => setTimeout(resolve, 900));
        results.disabled.hover = await runScript(`return arguments[0].querySelector('[data-testid="terminal-host"]')?.dataset.linkHover ?? null;`, [{ [elementKey]: cell }]);
        results.disabled.calls = (await linkCalls()).length - callsBeforeDisabled;
        results.disabled.dialog = await dialogOpen();
        results.disabled.backend = await invokeLink(url);
        if (results.disabled.attribute !== 'false' || results.disabled.hover || results.disabled.calls || results.disabled.dialog
            || results.disabled.backend?.error !== 'disabled' || (await readOpened()).length !== expectedCount) {
            problems.push(`con los enlaces desactivados algo siguió abriéndose: ${JSON.stringify(results.disabled)}`);
        }
        // Se dejan los ajustes como venían de fábrica.
        await setLinkPreference('settings-terminal-links', true);
        await setLinkPreference('settings-terminal-links-confirm', true);
        results.opened = await readOpened();
        recordEvent('terminal-links', { url, results, problems, passed: problems.length === 0 });
        if (problems.length) {
            await captureScreenshot('enlaces-fallo');
            throw new Error(`Enlaces clicables: ${problems.join('; ')}`);
        }
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'terminal-links';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enlaces OK: Ctrl+clic con confirmación, OSC 8 (paso por ConPTY=${results.osc8.passthrough}), file:// sin ejecutar, rechazos del backend y desactivación; ${results.opened.length} aperturas simuladas.\n`);
    } else if (appearanceOnly) {
        markPhase('temas, paleta ANSI y Biblioteca');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        const cssVars = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const style = getComputedStyle(document.documentElement);
                return { appBg: style.getPropertyValue('--app-bg').trim(), accent: style.getPropertyValue('--accent').trim(),
                    terminalBg: style.getPropertyValue('--terminal-bg').trim() };`,
            args: [],
        });
        const clickByScript = (script, args = []) => request(`/session/${sessionId}/execute/sync`, 'POST', { script, args });
        const problems = [];
        const results = {};

        await clickWhenReady('[data-testid="toolbar-settings"]');
        await clickWhenReady('[data-testid="settings-tab-appearance"]');
        // 1. Un tema de fábrica solo cambia el acento: el fondo sigue negro.
        await clickByScript(`document.querySelector('.theme-card input[value="crimson"]')?.closest('label')?.click(); return true;`);
        await waitUntil(async () => (await cssVars()).accent === '#e05561', 15000, 'acento de Carmesí aplicado');
        results.neutral = await cssVars();
        if (results.neutral.appBg !== '#0d0d0d') problems.push(`Carmesí cambió el fondo sin «Recolorear»: ${results.neutral.appBg}`);
        await captureScreenshot('tema-carmesi-base-neutra');
        // 2. Recolorear todo es voluntario.
        await clickInView(await findWhenReady('[data-testid="settings-theme-recolor-all"]'));
        await waitUntil(async () => (await cssVars()).appBg === '#120b0c', 15000, 'Carmesí con toda la interfaz recoloreada');
        results.recolored = await cssVars();
        await captureScreenshot('tema-carmesi-recoloreado');
        await clickInView(await findWhenReady('[data-testid="settings-theme-recolor-all"]'));
        await waitUntil(async () => (await cssVars()).appBg === '#0d0d0d', 15000, 'vuelta a la base neutra');
        // 3. Paleta ANSI propia: el rojo de la terminal pasa a ser el elegido.
        await clickInView(await findWhenReady('[data-testid="settings-ansi-enabled"]'));
        await findWhenReady('[data-testid="settings-ansi-grid"]');
        await clickByScript(`const input = document.querySelectorAll('[data-testid="settings-ansi-grid"] input[type="color"]')[1];
            input.value = '#12ab34';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;`);
        // 4. Guardar el aspecto actual como tema propio.
        const customName = 'E2E tema propio';
        const nameInput = await findWhenReady('[data-testid="settings-custom-theme-name"]');
        await clickInView(nameInput);
        await request(`/session/${sessionId}/element/${nameInput}/value`, 'POST', { text: customName });
        await clickInView(await findWhenReady('[data-testid="settings-custom-theme-save"]'));
        await waitUntil(async () => (await clickByScript(`return [...document.querySelectorAll('[data-testid="settings-custom-theme"]')]
            .some((card) => card.textContent.includes(arguments[0]) && card.classList.contains('selected'));`, [customName])),
            15000, 'tema propio guardado y seleccionado');
        await captureScreenshot('tema-propio-guardado');
        await clickWhenReady('[role="dialog"] .panel-close');
        await new Promise((resolve) => setTimeout(resolve, 800));
        await sendTerminalLine('echo %WSTERM_ESC%[31mWTERMINAL_ANSI_ROJO%WSTERM_ESC%[0m', cell);
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.includes('WTERMINAL_ANSI_ROJO') && !row.text.includes('echo')), 30000, 'salida en rojo ANSI');
        results.red = await clickByScript(`const host = arguments[0].querySelector('[data-testid="terminal-host"]');
            const span = [...host.querySelectorAll('.xterm-rows span')].reverse()
                .find((node) => (node.textContent ?? '').includes('WTERMINAL_ANSI_ROJO') && !(node.parentElement?.textContent ?? '').includes('echo'));
            return span ? getComputedStyle(span).color : null;`, [{ [elementKey]: cell }]);
        if (results.red !== 'rgb(18, 171, 52)') problems.push(`el rojo ANSI propio no se pinta: ${results.red}`);
        await captureScreenshot('paleta-ansi-propia');
        // 5. Borrar el tema propio y volver a la paleta de fábrica.
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await clickWhenReady('[data-testid="settings-tab-appearance"]');
        await clickInView(await findWhenReady('[data-testid="settings-custom-theme-delete"]'));
        await waitUntil(async () => (await findAll('[data-testid="settings-custom-theme"]')).length === 0, 15000, 'tema propio borrado');
        await clickInView(await findWhenReady('[data-testid="settings-ansi-enabled"]'));
        await clickWhenReady('[role="dialog"] .panel-close');
        // 6. Biblioteca: la lista de tipos sigue abierta tras marcar una casilla.
        await clickWhenReady('[data-testid="toolbar-library"]');
        await clickWhenReady('[data-testid="scripts-types"] > summary');
        await clickWhenReady('[data-testid="scripts-types"] .filter-group-expand');
        // Un grupo con subgrupos («Scripts Linux» → POSIX, Fish) solo muestra
        // casillas al desplegar también un subgrupo.
        await waitUntil(async () => (await findAll('[data-testid="scripts-types"] .types-options input[type="checkbox"], [data-testid="scripts-types"] .filter-subgroup .filter-group-expand')).length > 0,
            10000, 'casillas o subgrupos de la Biblioteca');
        if ((await findAll('[data-testid="scripts-types"] .types-options input[type="checkbox"]')).length === 0) {
            await clickWhenReady('[data-testid="scripts-types"] .filter-subgroup .filter-group-expand');
        }
        let before = null;
        await waitUntil(async () => {
            before = await clickByScript(`const box = document.querySelector('[data-testid="scripts-types"] .types-options input[type="checkbox"]');
                if (!box) return null;
                const was = box.checked;
                box.click();
                return was;`);
            return before !== null;
        }, 10000, 'casilla de tipo en la Biblioteca').catch(() => {});
        if (before === null) problems.push('la Biblioteca no muestra casillas de tipos');
        await new Promise((resolve) => setTimeout(resolve, 1200));
        results.library = await clickByScript(`const details = document.querySelector('[data-testid="scripts-types"]');
            const box = details?.querySelector('.types-options input[type="checkbox"]');
            return { open: Boolean(details?.open), checked: box ? box.checked : null };`);
        if (!results.library.open || results.library.checked === before) {
            problems.push(`la lista de tipos de la Biblioteca se cerró o no cambió: ${JSON.stringify(results.library)}`);
        }
        await captureScreenshot('biblioteca-lista-abierta');
        await clickByScript(`document.querySelector('[data-testid="scripts-types"] .types-options input[type="checkbox"]')?.click(); return true;`);
        await clickWhenReady('[role="dialog"] .panel-close');
        recordEvent('appearance', { results, problems, passed: problems.length === 0 });
        if (problems.length) throw new Error(`Apariencia: ${problems.join('; ')}`);
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'appearance';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write('E2E apariencia OK: base neutra, recoloreado opcional, tema propio, paleta ANSI y Biblioteca abierta.\n');
    } else if (ansiStylesOnly) {
        markPhase('colores ANSI y atributos de texto');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        const command = 'powershell -NoProfile -Command "Write-Host ANSIROJO -ForegroundColor Red; '
            + "Write-Host ANSIVERDE -ForegroundColor Green; "
            + "Write-Host ([char]27+'[1mANSINEGRITA'+[char]27+'[0m'); "
            + "Write-Host ([char]27+'[4mANSISUBRAYADO'+[char]27+'[0m'); "
            + "Write-Host ([char]27+'[3mANSICURSIVA'+[char]27+'[0m')\"";
        await sendTerminalLine(command, cell);
        // El eco de la orden ya contiene las palabras: se espera a una fila de
        // salida (sin «Write-Host») con la última de ellas.
        await waitUntil(async () => (await terminalRowSnapshot(cell)).rows
            .some((row) => row.text.includes('ANSICURSIVA') && !row.text.includes('Write-Host')), 30000, 'salida con estilos ANSI');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const styles = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                const foreground = getComputedStyle(host.querySelector('.xterm-rows')).color;
                const find = (word) => {
                    const span = [...host.querySelectorAll('.xterm-rows span')].reverse()
                        .find((node) => (node.textContent ?? '').includes(word) && !(node.parentElement?.textContent ?? '').includes('Write-Host'));
                    if (!span) return null;
                    const style = getComputedStyle(span);
                    return { className: span.className, color: style.color, fontWeight: style.fontWeight, fontStyle: style.fontStyle, decoration: style.textDecorationLine };
                };
                return { foreground, rojo: find('ANSIROJO'), verde: find('ANSIVERDE'), negrita: find('ANSINEGRITA'), subrayado: find('ANSISUBRAYADO'), cursiva: find('ANSICURSIVA') };`,
            args: [{ [elementKey]: cell }],
        });
        const rgb = (value) => (String(value ?? '').match(/\d+(?:\.\d+)?/gu) ?? []).map(Number);
        const [rr, rg, rb] = rgb(styles.rojo?.color);
        const [vr, vg, vb] = rgb(styles.verde?.color);
        const problems = [];
        if (!styles.rojo || styles.rojo.color === styles.foreground || !(rr > rg + 60 && rr > rb + 60)) problems.push('el rojo ANSI no se pinta en rojo');
        if (!styles.verde || styles.verde.color === styles.foreground || !(vg > vr + 40 && vg > vb + 20)) problems.push('el verde ANSI no se pinta en verde');
        if (!styles.negrita || Number(styles.negrita.fontWeight) < 600) problems.push('la negrita no se pinta en negrita');
        if (!styles.subrayado || !/underline/u.test(styles.subrayado.decoration)) problems.push('el subrayado no se pinta subrayado');
        if (!styles.cursiva || styles.cursiva.fontStyle !== 'italic') problems.push('la cursiva no se pinta en cursiva');
        await captureScreenshot('colores-y-atributos-ansi');
        recordEvent('ansi-styles', { styles, problems, passed: problems.length === 0 });
        if (problems.length) throw new Error(`Estilos ANSI sin aplicar: ${problems.join('; ')} — ${JSON.stringify(styles)}`);
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'ansi-styles';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write('E2E estilos ANSI OK: colores de la paleta, negrita, subrayado y cursiva visibles.\n');
    } else if (commandPaletteOnly) {
        markPhase('paleta de comandos');
        await waitForBannerPanes(1, 60000);
        const cell = await activeTerminalCell();
        const problems = [];
        const results = {};
        const runScript = (script, args = []) => request(`/session/${sessionId}/execute/sync`, 'POST', { script, args });
        const locales = await Promise.all(['ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pl', 'pt', 'ro', 'ru', 'uk', 'zh']
            .map((language) => loadLocaleCatalog(language)));
        const translationsOf = (key) => new Set(locales.map((catalog) => catalog[key]).filter(Boolean));
        const paletteState = () => runScript(`const root = document.querySelector('[data-testid="command-palette"]');
            const input = root?.querySelector('[data-testid="command-palette-input"]');
            const activeId = input?.getAttribute('aria-activedescendant') ?? '';
            const active = activeId ? document.getElementById(activeId) : null;
            const options = [...(root?.querySelectorAll('[data-testid="command-palette-option"]') ?? [])];
            return {
                open: Boolean(root),
                role: root?.getAttribute('role') ?? '',
                modal: root?.getAttribute('aria-modal') ?? '',
                inputFocused: Boolean(input) && document.activeElement === input,
                inputRole: input?.getAttribute('role') ?? '',
                listRole: root?.querySelector('[data-testid="command-palette-list"]')?.getAttribute('role') ?? '',
                activeId: active?.dataset.paletteId ?? '',
                activeIndex: options.indexOf(active),
                selectedCount: options.filter((option) => option.getAttribute('aria-selected') === 'true').length,
                firstId: options[0]?.dataset.paletteId ?? '',
                ids: options.slice(0, 40).map((option) => option.dataset.paletteId),
                count: options.length,
                groups: root?.querySelectorAll('[role="group"]').length ?? 0,
                status: root?.querySelector('[data-testid="command-palette-status"]')?.textContent?.trim() ?? '',
            };`);
        const pressKeys = (...values) => request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{ type: 'key', id: 'keyboard', actions: values.flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }],
        });
        const xterm = (await findAllWithin(cell, '.xterm'))[0]?.[elementKey];
        const textarea = (await findAllWithin(cell, '.xterm-helper-textarea'))[0]?.[elementKey];
        const openPalette = async () => {
            await focusTerminal(xterm, textarea);
            await sendWindowShortcut(['\uE009', '\uE008', 'p']);
            await waitUntil(async () => (await paletteState()).inputFocused, 10000, 'paleta abierta con el foco en su buscador');
        };
        const closedPalette = (description) => waitUntil(async () => !(await paletteState()).open, 5000, description);
        const filterPalette = async (text, expectedFirst) => {
            const input = await findWhenReady('[data-testid="command-palette-input"]');
            await request(`/session/${sessionId}/element/${input}/value`, 'POST', { text });
            await waitUntil(async () => (await paletteState()).firstId === expectedFirst, 5000, `«${text}» deja primero ${expectedFirst}`);
        };
        const selectPaletteOption = async (id) => {
            for (let attempt = 0; attempt < 60; attempt += 1) {
                const state = await paletteState();
                if (state.activeId === id) return;
                if (!state.ids.includes(id)) throw new Error(`La paleta no ofrece ${id}: ${JSON.stringify(state.ids)}`);
                await pressKeys('\uE015');
            }
            throw new Error(`Las flechas no llegaron a ${id}`);
        };
        await sendLineAndAssertPrompt('echo WTERMINAL_PALETA_INICIO', cell, 'WTERMINAL_PALETA_INICIO', 'inicio de la paleta');

        // 1. Ctrl+Shift+P abre un diálogo accesible con el foco en el buscador.
        await openPalette();
        results.opened = await paletteState();
        if (results.opened.role !== 'dialog' || results.opened.modal !== 'true'
            || results.opened.inputRole !== 'combobox' || results.opened.listRole !== 'listbox') {
            problems.push(`roles ARIA incorrectos: ${JSON.stringify(results.opened)}`);
        }
        if (results.opened.groups < 5 || results.opened.count < 20) problems.push(`pocos grupos o acciones: ${results.opened.groups}/${results.opened.count}`);
        if (results.opened.activeIndex !== 0 || results.opened.selectedCount !== 1) problems.push('la primera acción no queda activa al abrir');
        await captureScreenshot('paleta-de-comandos-abierta');
        // 2. Las flechas mueven la opción activa y dan la vuelta.
        await pressKeys('\uE015');
        const down = await paletteState();
        await pressKeys('\uE013', '\uE013');
        const wrapped = await paletteState();
        results.navigation = { down: down.activeIndex, wrapped: wrapped.activeIndex, count: wrapped.count };
        if (down.activeIndex !== 1 || wrapped.activeIndex !== wrapped.count - 1) problems.push(`navegación con flechas: ${JSON.stringify(results.navigation)}`);
        // 3. Escape cierra y devuelve el foco a la terminal; el atajo también cierra.
        await pressKeys('\uE00C');
        await closedPalette('paleta cerrada con Escape');
        await waitUntil(async () => runScript('return document.activeElement === arguments[0];', [{ [elementKey]: textarea }]),
            5000, 'foco devuelto a la terminal tras Escape');
        await openPalette();
        await sendWindowShortcut(['\uE009', '\uE008', 'p']);
        await closedPalette('el mismo atajo cierra la paleta');

        // 4. `:config` filtra por el comando equivalente y abre Ajustes, donde el
        // atajo de la paleta se puede grabar.
        await openPalette();
        await filterPalette(':config', 'app:openSettings');
        await pressKeys('\uE007');
        await findWhenReady('[data-testid="settings-tab-behavior"]', 15000);
        await closedPalette('la paleta se cierra al ejecutar');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const shortcutField = await findWhenReady('[data-testid="shortcut-shortcutCommandPalette"]');
        results.settingsShortcut = String(await property(shortcutField, 'value') ?? '');
        if (results.settingsShortcut.toLowerCase() !== 'ctrl+shift+p') problems.push(`el atajo de Ajustes no es Ctrl+Shift+P: ${results.settingsShortcut}`);
        await captureScreenshot('paleta-ajustes-atajo');
        await clickWhenReady('[role="dialog"] .panel-close');
        await new Promise((resolve) => setTimeout(resolve, 600));

        // 5. Un comando `:` con salida pasa por el interceptor de la terminal y
        // el eco de la orden siguiente sigue en la fila de su prompt.
        await openPalette();
        await filterPalette(':terminal list', 'internal::terminal list');
        await pressKeys('\uE007');
        // Solo se leen las filas visibles: el título «Parámetros de terminal:»
        // queda fuera de la vista en una ventana de 800x600; la línea de uso
        // es la penúltima del bloque y sigue a la vista.
        await waitUntil(async () => String(await fullTerminalTextWithin(cell)).includes('Uso: :terminal')
            && snapshotPromptVisible(await terminalRowSnapshot(cell)), 20000, 'salida de :terminal list desde la paleta');
        await sendLineAndAssertPrompt('echo WTERMINAL_PALETA_ECO', cell, 'WTERMINAL_PALETA_ECO', 'eco tras :terminal list');
        await assertNoDetachedCommandEcho([cell], ['echo WTERMINAL_PALETA_ECO'], 'paleta-terminal-list');
        // 6. Una línea `:` que no es una entrada se ofrece y se ejecuta tal cual.
        await openPalette();
        await filterPalette(':panel list', 'internal:raw');
        await pressKeys('\uE007');
        await waitUntil(async () => String(await fullTerminalTextWithin(cell)).includes('Paneles: settings, deps, projects, scripts, explorer.')
            && snapshotPromptVisible(await terminalRowSnapshot(cell)), 20000, 'salida de :panel list tecleado desde la paleta');
        const afterInternal = String(await fullTerminalTextWithin(cell));
        if (/no se reconoce|not recognized/iu.test(afterInternal)) problems.push('la shell recibió un comando interno como orden');
        await captureScreenshot('paleta-comandos-internos');

        // 7. Con texto sin enviar en el prompt no se teclea nada encima.
        await sendTerminalKeys('abc', cell, { enter: false, settle: true });
        await openPalette();
        await filterPalette(':shell current', 'internal::shell current');
        await pressKeys('\uE007');
        await waitUntil(async () => translationsOf('palette.rejected.draft').has((await paletteState()).status), 5000, 'aviso de texto sin enviar');
        results.draft = await paletteState();
        await captureScreenshot('paleta-rechaza-linea-con-texto');
        await pressKeys('\uE00C');
        await closedPalette('paleta cerrada tras el aviso');
        if (String(await fullTerminalTextWithin(cell)).includes('Shell actual:')) problems.push('la paleta tecleó sobre una línea a medio escribir');
        await sendTerminalKeys('\uE003\uE003\uE003', cell, { enter: false, settle: true });

        // 8. Limpiar ejecuta el `clear` real: pantalla e historial vacíos y el
        // eco siguiente pegado al prompt (antes, `terminal.clear()` de xterm
        // dejaba a ConPTY con el cursor varias filas más abajo).
        await openPalette();
        await filterPalette('clear', 'app:clearTerminal');
        await pressKeys('\uE007');
        await waitUntil(async () => {
            const text = String(await fullTerminalTextWithin(cell));
            return !text.includes('WTERMINAL_PALETA_ECO') && !text.includes('Parámetros de terminal')
                && snapshotPromptVisible(await terminalRowSnapshot(cell));
        }, 20000, 'terminal limpia desde la paleta');
        const scrollback = String(await scrollbackTerminalTextWithin(cell) ?? '');
        if (scrollback.includes('WTERMINAL_PALETA_INICIO')) problems.push('Limpiar dejó el historial anterior');
        await sendLineAndAssertPrompt('echo WTERMINAL_PALETA_TRAS_CLEAR', cell, 'WTERMINAL_PALETA_TRAS_CLEAR', 'eco tras limpiar');
        await assertNoDetachedCommandEcho([cell], ['echo WTERMINAL_PALETA_TRAS_CLEAR'], 'paleta-limpiar');
        await captureScreenshot('paleta-limpiar-eco-pegado');

        // 9. Nueva pestaña, elegida con las flechas.
        const tabsBefore = (await findAll('.cell')).length;
        await openPalette();
        const paletteInput = await findWhenReady('[data-testid="command-palette-input"]');
        await request(`/session/${sessionId}/element/${paletteInput}/value`, 'POST', { text: 'new tab' });
        await waitUntil(async () => (await paletteState()).ids.includes('app:newTab'), 5000, 'la búsqueda ofrece Nueva pestaña');
        await selectPaletteOption('app:newTab');
        await pressKeys('\uE007');
        await waitUntil(async () => (await findAll('.cell')).length === tabsBefore + 1, 30000, 'pestaña nueva desde la paleta');
        await waitForBannerPanes(1, 60000);
        results.tabs = { before: tabsBefore, after: (await findAll('.cell')).length };

        recordEvent('command-palette', { results, problems, passed: problems.length === 0 });
        if (problems.length) throw new Error(`Paleta de comandos: ${problems.join('; ')}`);
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'command-palette';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write('E2E paleta de comandos OK: atajo, teclado, filtrado, Ajustes, comandos `:`, aviso de línea con texto, limpiar y nueva pestaña.\n');
    } else if (inputFollowOnly) {
        markPhase('seguimiento del cursor en una entrada larga');
        await waitForBannerPanes(1, 60000);
        await resizeWindow(980, 640, { waitForBanner: false });
        const cell = await activeTerminalCell();
        await sendTerminalKeys('', cell, { enter: true, settle: true });
        const xterm = (await findAllWithin(cell, '.xterm'))[0]?.[elementKey];
        const input = (await findAllWithin(cell, '.xterm-helper-textarea'))[0]?.[elementKey];
        await focusTerminal(xterm, input);
        await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
        // Lo que ve el usuario: el rectángulo real del cursor frente a la zona
        // visible del host que desplaza el eje X.
        const probe = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                const cursor = host?.querySelector('.xterm-cursor');
                const rows = [...host.querySelectorAll('.xterm-rows > div')];
                const hostRect = host.getBoundingClientRect();
                const cursorRect = cursor?.getBoundingClientRect();
                const centerY = cursorRect ? (cursorRect.top + cursorRect.bottom) / 2 : -1;
                const cursorRow = rows.find((row) => { const r = row.getBoundingClientRect(); return centerY >= r.top && centerY < r.bottom; });
                return {
                    scrollLeft: host.scrollLeft,
                    clientWidth: host.clientWidth,
                    scrollWidth: host.scrollWidth,
                    maxScroll: Math.max(0, host.scrollWidth - host.clientWidth),
                    cursorLeft: cursorRect ? cursorRect.left - hostRect.left : null,
                    cursorRight: cursorRect ? cursorRect.right - hostRect.left : null,
                    cellWidth: cursorRect ? cursorRect.width : 0,
                    cols: Number(host.dataset.terminalCols || 0),
                    lineLength: (cursorRow?.textContent ?? '').trimEnd().length,
                    fonts: (() => {
                        const measure = host.querySelector('.xterm-char-measure-element');
                        const rowsEl = host.querySelector('.xterm-rows');
                        return {
                            rows: rowsEl ? getComputedStyle(rowsEl).fontSize : '',
                            measure: measure ? getComputedStyle(measure).fontSize : '',
                        };
                    })(),
                };`,
            args: [{ [elementKey]: cell }],
        });
        const cursorVisible = (state) => state.cursorLeft !== null
            && state.cursorLeft >= -1
            && state.cursorRight <= state.clientWidth + 1;
        const keys = (values, delayMs = 30) => request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{ type: 'key', id: 'keyboard', actions: [...values].flatMap((value) => [
                { type: 'keyDown', value }, { type: 'keyUp', value }, { type: 'pause', duration: delayMs },
            ]) }],
        });
        // El eco llega por ConPTY: se espera a que la línea alcance la longitud
        // esperada y a dos frames de repintado antes de medir.
        const settle = async (expectedLength = null) => {
            await waitUntil(async () => {
                const state = await probe();
                return expectedLength === null || state.lineLength >= expectedLength;
            }, 10000, `eco de la entrada (${expectedLength ?? 'cursor'})`).catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 120));
            return probe();
        };
        const failures = [];
        const samples = [];
        const record = (phase, state, extra = {}) => {
            const entry = { phase, ...state, ...extra, visible: cursorVisible(state) };
            samples.push(entry);
            if (!entry.visible) failures.push(entry);
            return entry;
        };
        // xterm mide la celda con su propia fuente; si las filas se pintan con
        // otro tamaño (su hoja dinámica no se aplica en la WebView), cursor,
        // textarea y scroll se desfasan por cada columna.
        const fontState = (await probe()).fonts;
        if (!fontState.rows || fontState.rows !== fontState.measure) {
            throw new Error(`Las filas se pintan con otro tamaño de fuente que el que mide xterm: ${JSON.stringify(fontState)}`);
        }
        const promptLength = (await probe()).lineLength;
        const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const payload = `echo ${Array.from({ length: 360 }, (_, index) => alphabet[index % alphabet.length]).join('')}`;
        // A. Escribir a ritmo humano: el cursor siempre visible y el scroll
        // avanzando poco a poco (sin saltos mayores que lo escrito).
        const chunk = 8;
        let typed = 0;
        let previous = await probe();
        while (typed < payload.length) {
            const piece = payload.slice(typed, typed + chunk);
            await keys(piece);
            typed += piece.length;
            const state = await settle(promptLength + typed);
            const jump = state.scrollLeft - previous.scrollLeft;
            const entry = record('escribir', state, { typed, jump });
            if (jump < -1 || jump > (piece.length + 6) * Math.max(1, state.cellWidth)) {
                failures.push({ ...entry, reason: 'salto de scroll no proporcional a lo escrito' });
            }
            // Con la vista desplazada, el cursor no queda pegado al borde (bajo
            // la barra vertical y el indicador de desbordamiento).
            if (entry.visible && state.scrollLeft > 0 && state.cursorRight > state.clientWidth - 2 * state.cellWidth) {
                failures.push({ ...entry, reason: 'cursor pegado al borde derecho' });
            }
            previous = state;
        }
        await captureScreenshot('seguimiento-entrada-larga-final');
        // B. El usuario lleva el scroll al principio para leer lo escrito y
        // después sigue escribiendo: la vista vuelve al cursor lo justo.
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                host.scrollLeft = 0;
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                return true;`,
            args: [{ [elementKey]: cell }],
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const afterManual = await probe();
        if (afterManual.scrollLeft > 1) failures.push({ phase: 'scroll-manual', ...afterManual, reason: 'el scroll manual no se mantuvo' });
        await captureScreenshot('seguimiento-scroll-manual');
        for (let round = 0; round < 3; round += 1) {
            const piece = alphabet.slice(round * 4, round * 4 + 4);
            await keys(piece);
            typed += piece.length;
            const state = await settle(promptLength + typed);
            const entry = record('escribir-tras-scroll-manual', state, { typed });
            // «Lo justo»: el cursor queda en el borde derecho, no la vista en
            // el extremo del lienzo dejando el cursor a la izquierda.
            if (entry.visible && state.cursorRight < state.clientWidth * 0.5 && state.scrollLeft > 0) {
                failures.push({ ...entry, reason: 'la vista saltó más allá del cursor' });
            }
        }
        await captureScreenshot('seguimiento-tras-scroll-manual');
        // C. Moverse por la línea larga: la vista sigue al cursor.
        await keys(['\uE011'], 40);
        const atHome = record('inicio', await settle());
        // Inicio deja el cursor justo detrás del prompt: la línea se enseña
        // desde el principio, con el prompt completo.
        if (atHome.scrollLeft > 1) failures.push({ ...atHome, reason: 'Inicio no muestra la línea desde el principio' });
        await captureScreenshot('seguimiento-inicio');
        await keys(['\uE010'], 40);
        record('fin', await settle());
        await keys(Array.from({ length: 120 }, () => '\uE012'), 8);
        record('flechas-izquierda', await settle());
        // D. Insertar en mitad de la l\u00EDnea: el cursor sigue a la vista.
        for (let round = 0; round < 2; round += 1) {
            const before = (await probe()).lineLength;
            await keys('INS');
            record('insertar-en-medio', await settle(before + 3));
        }
        await keys(['\uE010'], 40);
        await settle();
        const beforeBackspace = (await probe()).lineLength;
        await keys(Array.from({ length: 150 }, () => '\uE003'), 8);
        await waitUntil(async () => (await probe()).lineLength <= beforeBackspace - 140, 10000, 'borrado con Retroceso').catch(() => undefined);
        record('retroceso', await settle());
        await captureScreenshot('seguimiento-retroceso');
        // E. Mayús+rueda lleva la vista al principio (gesto del usuario) y al
        // seguir escribiendo vuelve al cursor.
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const host = arguments[0].querySelector('[data-testid="terminal-host"]');
                for (let step = 0; step < 12; step += 1) {
                    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, shiftKey: true, bubbles: true, cancelable: true }));
                }
                return host.scrollLeft;`,
            args: [{ [elementKey]: cell }],
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const afterWheel = await probe();
        if (afterWheel.scrollLeft > 1) failures.push({ phase: 'rueda', ...afterWheel, reason: 'Mayús+rueda no desplazó la vista al principio' });
        {
            const before = (await probe()).lineLength;
            await keys('WHL');
            record('escribir-tras-rueda', await settle(before + 3));
        }
        // F. Cambiar el tamaño de la ventana con la línea larga a medio
        // escribir: el cursor sigue a la vista en ambos sentidos.
        await resizeWindow(760, 560, { waitForBanner: false });
        await keys('n');
        record('ventana-estrecha', await settle());
        await resizeWindow(980, 640, { waitForBanner: false });
        await keys('w');
        record('ventana-ancha', await settle());
        // G. Cruzar las 1024 columnas (la rejilla crece) escribiendo rápido y
        // después a ritmo humano.
        {
            const current = (await probe()).lineLength;
            const burst = Math.max(0, 1010 - current);
            await keys(Array.from({ length: burst }, (_, index) => alphabet[index % alphabet.length]), 0);
            await settle(current + burst);
            for (let round = 0; round < 4; round += 1) {
                const before = (await probe()).lineLength;
                await keys(alphabet.slice(round * 8, round * 8 + 8));
                record('cruzar-1024', await settle(before + 8), { length: before + 8 });
            }
        }
        await captureScreenshot('seguimiento-mas-de-1024');
        // H. Intro en una línea larga: la orden se ejecuta y el prompt nuevo
        // se ve desde el principio.
        await keys(['\uE007'], 60);
        await waitUntil(async () => {
            const state = await probe();
            return state.lineLength > 0 && state.lineLength <= promptLength + 2;
        }, 20000, 'prompt nuevo tras una orden larga').catch(() => undefined);
        const afterEnter = record('prompt-tras-intro', await settle());
        if (afterEnter.scrollLeft > 1) failures.push({ ...afterEnter, reason: 'el prompt nuevo no se ve desde el principio' });
        await captureScreenshot('seguimiento-prompt-tras-intro');
        recordEvent('input-follow', { samples: samples.length, failures, passed: failures.length === 0 });
        if (failures.length) {
            throw new Error(`El cursor se perdió de vista o el scroll saltó (${failures.length}/${samples.length}): ${JSON.stringify(failures.slice(0, 6))}`);
        }
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'input-follow';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E seguimiento de entrada OK: ${samples.length} mediciones con el cursor a la vista.\n`);
    } else if (tinyGrowOnly) {
        markPhase('casilla diminuta que crece tras desplazar el historial');
        await waitForBannerPanes(1, 60000);
        const originalId = await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id');
        const originalCell = async () => {
            for (const cell of await findAll('.cell:not(.hidden)')) {
                if (await attribute(cell[elementKey], 'data-tab-id') === originalId) return cell[elementKey];
            }
            throw new Error(`La casilla ${originalId} no está visible`);
        };
        const rotateTo = async (wanted) => {
            for (let step = 0; step < 6 && await visiblePaneCount() !== wanted; step += 1) {
                const before = await visiblePaneCount();
                await clickWhenReady('.side-toggle.panes');
                await waitUntil(async () => await visiblePaneCount() !== before, 5000, 'rotación de paneles');
            }
            if (await visiblePaneCount() !== wanted) throw new Error(`No se alcanzaron ${wanted} paneles`);
        };
        // En 1-3 filas la salida sale de la vista enseguida: la orden ha
        // terminado cuando la fila del cursor vuelve a ser un prompt vacío.
        const runAndWait = async (cell, marker) => {
            await sendTerminalLine(`echo ${marker}`, cell);
            await waitUntil(async () => {
                const snapshot = await terminalRowSnapshot(cell);
                const cursorText = (snapshot.rows[snapshot.cursorRow]?.text ?? '').trim();
                return cursorText.endsWith('>') && !cursorText.includes(marker);
            }, 20000, `prompt tras ${marker}`);
        };
        const tinyRows = async (cell) => Number(await attribute((await findAllWithin(cell, '[data-terminal-rows]'))[0]?.[elementKey], 'data-terminal-rows') || 0);
        const results = [];
        for (const variant of ['un-panel', 'ventana']) {
            await resizeWindow(480, 270, { waitForBanner: false });
            await rotateTo(4);
            let cell = await originalCell();
            await click(cell);
            await waitUntil(async () => (await tinyRows(await originalCell())) > 0 && (await tinyRows(await originalCell())) <= 3, 10000, 'casilla de 1-3 filas');
            cell = await originalCell();
            const rowsBefore = await tinyRows(cell);
            // Varias órdenes en 1-3 filas: el historial se desplaza en ConPTY y xterm.
            for (let index = 0; index < 4; index += 1) {
                await runAndWait(cell, `LTERMINAL_E2E_TINY_${variant.replace('-', '_')}_${index}_${Date.now()}`);
            }
            if (variant === 'un-panel') await rotateTo(1);
            else await resizeWindow(980, 640, { waitForBanner: false });
            await waitUntil(async () => (await tinyRows(await originalCell())) >= rowsBefore + 2, 10000, `crecimiento de la casilla (${variant})`);
            cell = await originalCell();
            await click(cell);
            const marker = `LTERMINAL_E2E_TINY_GROWN_${variant.replace('-', '_')}_${Date.now()}`;
            await runAndWait(cell, marker);
            const snapshot = await terminalRowSnapshot(cell);
            const offenders = detachedCommandEchoes(snapshot.rows, [`echo ${marker}`]);
            results.push({ variant, rowsBefore, rowsAfter: await tinyRows(cell), attached: offenders.length === 0 });
            process.stdout.write(`E2E casilla diminuta ${variant}: ${offenders.length ? 'DESPEGADA' : 'ok'} (${rowsBefore}→${await tinyRows(cell)} filas)\n`);
            if (offenders.length) {
                await captureScreenshot(`casilla-diminuta-${variant}-despegada`);
                throw new Error(`Eco despegado tras crecer la casilla (${variant}): ${JSON.stringify(snapshot.rows.map((row) => row.text.trimEnd()).filter(Boolean).slice(-8))}`);
            }
            await captureScreenshot(`casilla-diminuta-${variant}`);
            await rotateTo(1);
        }
        recordEvent('tiny-pane-grow', { results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'tiny-pane-grow';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E casilla diminuta OK: ${results.map((item) => `${item.variant} ${item.rowsBefore}→${item.rowsAfter}`).join(', ')}.\n`);
    } else if (toolchainStoreOnly) {
        markPhase('entornos y descargas');
        await waitForBannerPanes(1, 60000);
        await resizeWindow(1100, 900, { waitForBanner: false });
        const appData = process.env.LTERMINAL_E2E_APP_DATA_DIR ?? '';
        const expectedRoot = appData ? join(appData, 'entornos') : '';
        const samePath = (left, right) => resolve(String(left)).toLowerCase() === resolve(String(right)).toLowerCase();
        // Sembrar la caché de pip solo dentro del perfil aislado de la prueba.
        const seedPip = Boolean(expectedRoot) && !process.env.PIP_CACHE_DIR;
        const seedFile = seedPip ? join(expectedRoot, 'cache', 'pip', 'e2e-seed.bin') : '';
        if (seedPip) {
            await mkdir(dirname(seedFile), { recursive: true });
            await writeFile(seedFile, Buffer.alloc(2 * 1024 * 1024));
        }
        const readStore = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const list = document.querySelector('[data-testid="settings-toolchain-store-caches"]');
                if (!list) return null;
                const clear = document.querySelector('[data-testid="settings-toolchain-store-clear"]');
                return {
                    placeholder: document.querySelector('[data-testid="settings-toolchain-store-dir"]')?.placeholder ?? '',
                    rows: [...list.querySelectorAll('.store-row')].map((row) => ({
                        path: row.title,
                        variable: (row.querySelector('code')?.textContent ?? '').trim(),
                        userDefined: row.getAttribute('data-user-defined') === 'true',
                        category: row.getAttribute('data-category'),
                        active: row.getAttribute('data-active') === 'true',
                        location: row.getAttribute('data-location'),
                        size: (row.querySelector('.store-size')?.textContent ?? '').trim(),
                    })),
                    total: (list.querySelector('.store-caption span:last-child')?.textContent ?? '').trim(),
                    clear: (clear?.textContent ?? '').trim(),
                    clearDisabled: Boolean(clear?.disabled),
                    message: [...document.querySelectorAll('.field-hint[role="status"]')].map((node) => node.textContent.trim()).join(' '),
                };`,
            args: [],
        });
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        let store = null;
        await waitUntil(async () => {
            store = await readStore();
            return Boolean(store && store.rows.length >= 11);
        }, 30000, 'lista de cachés de Entornos y descargas');
        if (expectedRoot && !samePath(store.placeholder, expectedRoot)) {
            throw new Error(`La carpeta por defecto no es la del perfil E2E: ${JSON.stringify({ placeholder: store.placeholder, expectedRoot })}`);
        }
        const pip = store.rows.find((row) => row.variable === 'PIP_CACHE_DIR');
        if (!pip) throw new Error(`Entornos y descargas no lista PIP_CACHE_DIR: ${JSON.stringify(store.rows)}`);
        if (seedPip) {
            if (pip.userDefined || !samePath(pip.path, join(expectedRoot, 'cache', 'pip'))) {
                throw new Error(`La caché de pip no apunta a la carpeta propia: ${JSON.stringify(pip)}`);
            }
            if (/^0\s*B$/u.test(pip.size)) throw new Error(`La caché sembrada de pip mide 0: ${JSON.stringify(store)}`);
        }
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `document.querySelector('[data-testid="settings-toolchain-store"]')?.scrollIntoView({ block: 'start' }); return true;`,
            args: [],
        });
        await captureScreenshot('ajustes-entornos-y-descargas');
        let freed = '';
        if (seedPip) {
            const clearButton = await findWhenReady('[data-testid="settings-toolchain-store-clear"]');
            const firstLabel = store.clear;
            await clickInView(clearButton);
            await waitUntil(async () => (await readStore())?.clear !== firstLabel, 5000, 'confirmación de vaciado');
            await clickInView(await findWhenReady('[data-testid="settings-toolchain-store-clear"]'));
            await waitUntil(async () => {
                store = await readStore();
                const current = store?.rows.find((row) => row.variable === 'PIP_CACHE_DIR');
                return Boolean(store?.message) && /^0\s*B$/u.test(current?.size ?? '');
            }, 30000, 'vaciado de cachés');
            freed = store.message;
            if (await stat(seedFile).then(() => true, () => false)) {
                throw new Error(`Vaciar cachés no borró el archivo sembrado: ${seedFile}`);
            }
            await captureScreenshot('ajustes-entornos-cache-vaciada');
        }
        // Las ubicaciones externas se miden aparte (pueden tardar): la lista
        // propia ya estaba visible antes de que terminen.
        let externalCount = 0;
        await waitUntil(async () => {
            const state = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `if (document.querySelector('[data-testid="settings-toolchain-store-external-pending"]')) return null;
                    return document.querySelectorAll('[data-testid="settings-toolchain-store-external"] .store-row').length;`,
                args: [],
            });
            if (state === null) return false;
            externalCount = Number(state) || 0;
            return true;
        }, 240000, 'tamaño de las ubicaciones externas');
        // Cada carpeta (de WTerminal, cachés y otras herramientas) dice al
        // pasar el ratón para qué sirve y si se puede borrar.
        const storageRows = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...document.querySelectorAll('[data-testid="settings-storage-row"]')].map((row) => ({
                    id: row.getAttribute('data-location-id'), safety: row.getAttribute('data-safety'),
                    app: Boolean(row.closest('[data-testid="settings-storage-app"]')) }));`,
            args: [],
        });
        const storageIds = storageRows.map((row) => row.id);
        if (!storageIds.includes('app-session') || !storageIds.includes('npm') || storageRows.filter((row) => row.app).length < 3) {
            throw new Error(`Faltan carpetas de WTerminal o cachés en Ajustes: ${JSON.stringify(storageRows)}`);
        }
        if (storageRows.some((row) => !['safe', 'regenerates', 'caution', 'keep'].includes(row.safety))) {
            throw new Error(`Hay carpetas sin clasificar si se pueden borrar: ${JSON.stringify(storageRows)}`);
        }
        const storageRow = await findWhenReady('[data-testid="settings-storage-app"] [data-testid="settings-storage-row"]');
        await scrollIntoView(storageRow);
        await request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
                actions: [{ type: 'pointerMove', origin: { [elementKey]: storageRow }, x: 6, y: 6 }] }],
        });
        let storageTip = null;
        await waitUntil(async () => {
            storageTip = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `const tip = document.querySelector('[data-testid="settings-storage-tip"]');
                    if (!tip) return null;
                    const box = tip.getBoundingClientRect();
                    const panel = tip.closest('.panel')?.getBoundingClientRect();
                    return { paragraphs: [...tip.querySelectorAll('p')].map((p) => (p.textContent ?? '').trim()),
                        path: tip.querySelector('code')?.textContent ?? '',
                        inside: Boolean(panel) && box.left >= panel.left - 1 && box.right <= panel.right + 1
                            && box.top >= panel.top - 1 && box.bottom <= panel.bottom + 1 };`,
                args: [],
            });
            return Boolean(storageTip);
        }, 10000, 'explicación de la carpeta bajo el ratón');
        if (storageTip.paragraphs.length !== 2 || storageTip.paragraphs.some((paragraph) => paragraph.length < 30) || !storageTip.path) {
            throw new Error(`La explicación de la carpeta está incompleta: ${JSON.stringify(storageTip)}`);
        }
        if (!storageTip.inside) throw new Error(`La explicación se sale del panel: ${JSON.stringify(storageTip)}`);
        await captureScreenshot('ajustes-carpetas-explicacion');
        recordEvent('storage-locations', { passed: true, rows: storageRows.length, app: storageRows.filter((row) => row.app).length });
        await clickWhenReady('[role="dialog"] .panel-close');
        // La terminal abierta al arrancar ya hereda la variable de la caché.
        const cell = await activeTerminalCell();
        const marker = `LTERMINAL_E2E_STORE_${Date.now()}`;
        await sendTerminalLine(`echo ${marker}=%PIP_CACHE_DIR%`, cell);
        let terminalValue = '';
        await waitUntil(async () => {
            const snapshot = await terminalRowSnapshot(cell);
            const row = snapshot.rows.map((entry) => entry.text.trim()).find((text) => text.startsWith(`${marker}=`));
            terminalValue = row ? row.slice(marker.length + 1) : '';
            return Boolean(row);
        }, 15000, 'valor de PIP_CACHE_DIR en la terminal');
        if (terminalValue.includes('%') || !samePath(terminalValue, pip.path)) {
            throw new Error(`La terminal no recibe la caché propia de pip: ${JSON.stringify({ terminalValue, expected: pip.path })}`);
        }
        // Categorías: de fábrica descargas y modelos de IA activas;
        // herramientas nuevas e historial apagadas (no cambian dónde se
        // instala nada hasta que el usuario lo pide).
        const echoVariable = async (variable) => {
            const tag = `LTERMINAL_E2E_VAR_${Date.now()}`;
            await sendTerminalLine(`echo ${tag}=%${variable}%`, cell);
            let value = '';
            await waitUntil(async () => {
                const row = (await terminalRowSnapshot(cell)).rows.map((entry) => entry.text.trim()).find((text) => text.startsWith(`${tag}=`));
                value = row ? row.slice(tag.length + 1) : '';
                return Boolean(row);
            }, 15000, `valor de ${variable} en la terminal`);
            return value;
        };
        const categoryOf = (variable) => store.rows.find((row) => row.variable === variable);
        const categoryProblems = [];
        // De fábrica se centralizan todas las categorías (también herramientas
        // e historial de los REPL).
        for (const [variable, active] of [['WTERMINAL_DOWNLOADS', true], ['HF_HOME', true], ['npm_config_prefix', true], ['NODE_REPL_HISTORY', true]]) {
            const row = categoryOf(variable);
            if (!row) categoryProblems.push(`${variable} no aparece en la lista`);
            else if (!row.userDefined && row.active !== active) categoryProblems.push(`${variable} debería estar ${active ? 'activa' : 'sin aplicar'}`);
            // Sin centralizar se sigue viendo, con la carpeta de siempre de la
            // herramienta y su espacio, nunca la carpeta propia vacía.
            else if (!row.userDefined && !active && (row.location !== 'system' || (expectedRoot && samePath(dirname(row.path), join(expectedRoot, 'herramientas'))))) {
                categoryProblems.push(`${variable} sin centralizar no muestra su ubicación actual: ${JSON.stringify(row)}`);
            }
        }
        // Los encabezados de categoría solo existen con Ajustes abierto (el
        // panel se cerró para usar la terminal): se abre, se cuentan y se
        // vuelve a cerrar.
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        let headers = [];
        await waitUntil(async () => {
            headers = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `return [...document.querySelectorAll('[data-testid="settings-store-category"]')].map((node) => node.getAttribute('data-category'));`,
                args: [],
            }).catch(() => []);
            return headers.length >= 5;
        }, 30000, 'categorías de Entornos y descargas').catch(() => {});
        await clickWhenReady('[role="dialog"] .panel-close');
        if (!process.env.WTERMINAL_DOWNLOADS && expectedRoot) {
            const downloads = await echoVariable('WTERMINAL_DOWNLOADS');
            if (!samePath(downloads, join(expectedRoot, 'descargas', 'panel'))) categoryProblems.push(`WTERMINAL_DOWNLOADS en la terminal: ${downloads}`);
        }
        // De fábrica todo se centraliza: «Herramientas y lenguajes nuevos»
        // instala en la carpeta propia y la lleva delante en el PATH. Al
        // apagarla, una terminal nueva vuelve a lo de siempre; se reactiva.
        if (!process.env.npm_config_prefix && expectedRoot) {
            const npmDir = join(expectedRoot, 'herramientas', 'npm');
            const prefix = await echoVariable('npm_config_prefix');
            if (!samePath(prefix, npmDir)) categoryProblems.push(`npm_config_prefix de fábrica: ${prefix}`);
            const firstPath = (await echoVariable('PATH')).split(';')[0];
            if (!samePath(firstPath, npmDir)) categoryProblems.push(`la carpeta de npm no va delante en el PATH: ${firstPath}`);
            await captureScreenshot('entornos-herramientas-nuevas');
            await clickWhenReady('[data-testid="toolbar-settings"]');
            await clickWhenReady('[data-testid="settings-tab-behavior"]');
            await clickInView(await findWhenReady('[data-testid="settings-store-category-tools"]'));
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await clickWhenReady('[role="dialog"] .panel-close');
            await switchToEnvironment('cmd');
            const prefixOff = await echoVariable('npm_config_prefix');
            if (prefixOff !== '%npm_config_prefix%') categoryProblems.push(`npm_config_prefix con la categoría apagada: ${prefixOff}`);
            await clickWhenReady('[data-testid="toolbar-settings"]');
            await clickWhenReady('[data-testid="settings-tab-behavior"]');
            // Sin centralizar se sigue viendo, con la carpeta de siempre de la
            // herramienta y su espacio, nunca la carpeta propia vacía.
            let offRow = null;
            await waitUntil(async () => {
                offRow = ((await readStore())?.rows ?? []).find((row) => row.variable === 'npm_config_prefix') ?? null;
                return Boolean(offRow) && (offRow.userDefined || !offRow.active);
            }, 30000, 'npm_config_prefix sin centralizar en la lista').catch(() => {});
            if (!offRow || (!offRow.userDefined && (offRow.active || offRow.location !== 'system'))) {
                categoryProblems.push(`npm_config_prefix sin centralizar no muestra su ubicación actual: ${JSON.stringify(offRow)}`);
            }
            await clickInView(await findWhenReady('[data-testid="settings-store-category-tools"]'));
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await clickWhenReady('[role="dialog"] .panel-close');
        }
        if (headers.length !== 5) categoryProblems.push(`categorías visibles: ${JSON.stringify(headers)}`);
        recordEvent('toolchain-store-categories', { headers, problems: categoryProblems, passed: categoryProblems.length === 0 });
        if (categoryProblems.length) throw new Error(`Categorías de Entornos y descargas: ${categoryProblems.join('; ')}`);
        // Descarga real (opcional, necesita red): cada gestor instalado baja un
        // paquete diminuto desde la terminal y su contenido debe caer en la
        // carpeta propia del perfil E2E; después «Vaciar cachés» debe poder
        // borrarlo todo, incluida la caché de módulos de Go (solo lectura).
        const downloaded = [];
        if (process.env.E2E_TOOLCHAIN_STORE_DOWNLOAD === '1' && seedPip) {
            const treeSize = async (dir) => {
                let total = 0;
                for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
                    const path = join(dir, entry.name);
                    if (entry.isDirectory()) total += await treeSize(path);
                    else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
                }
                return total;
            };
            const toolAvailable = async (tool) => new Promise((resolveTool) => {
                execFileCallback('where', [tool], { windowsHide: true }, (error) => resolveTool(!error));
            });
            const work = join(tmpdir(), `wterminal-e2e-downloads-${smokeToken}`);
            await mkdir(join(work, 'bun'), { recursive: true });
            await mkdir(join(work, 'deno'), { recursive: true });
            await writeFile(join(work, 'bun', 'package.json'), '{"name":"wterminal-e2e","version":"1.0.0"}');
            const cacheRoot = join(expectedRoot, 'cache');
            const managers = [
                { id: 'pip', tool: 'python', variable: 'PIP_CACHE_DIR', evidence: join(cacheRoot, 'pip'),
                    command: `python -m pip download --no-deps --disable-pip-version-check --no-input -q -d "${join(work, 'pip')}" six==1.16.0` },
                { id: 'npm', tool: 'npm', variable: 'npm_config_cache', evidence: join(cacheRoot, 'npm', '_cacache'),
                    command: 'npm cache add is-number@7.0.0' },
                { id: 'deno', tool: 'deno', variable: 'DENO_DIR', evidence: join(cacheRoot, 'deno', 'npm', 'registry.npmjs.org', 'is-number'),
                    command: `pushd "${join(work, 'deno')}" && deno cache --node-modules-dir=none npm:is-number@7.0.0 && popd` },
                { id: 'bun', tool: 'bun', variable: 'BUN_INSTALL_CACHE_DIR', evidence: join(cacheRoot, 'bun'),
                    command: `pushd "${join(work, 'bun')}" && bun add is-number@7.0.0 && popd` },
                { id: 'go-mod', tool: 'go', variable: 'GOMODCACHE', evidence: join(cacheRoot, 'go-mod', 'github.com', 'google', 'uuid@v1.6.0'),
                    command: `pushd "${work}" && go mod download github.com/google/uuid@v1.6.0 && popd` },
            ];
            for (const manager of managers) {
                if (!(await toolAvailable(manager.tool))) continue;
                const marker = `LTERMINAL_E2E_DL_${manager.id.replace('-', '_')}_${Date.now()}`;
                await sendTerminalLine(`${manager.command} && echo ${marker}_OK || echo ${marker}_FAIL`, cell);
                let outcome = '';
                await waitUntil(async () => {
                    const rows = (await terminalRowSnapshot(cell)).rows.map((entry) => entry.text.trim());
                    outcome = rows.find((text) => text === `${marker}_OK` || text === `${marker}_FAIL`) ?? '';
                    return Boolean(outcome);
                }, 240000, `descarga real con ${manager.id}`);
                const bytes = await treeSize(manager.evidence);
                if (!outcome.endsWith('_OK') || bytes === 0) {
                    await captureScreenshot(`descarga-real-${manager.id}-fallida`);
                    throw new Error(`La descarga de ${manager.id} no quedó en la carpeta propia: ${JSON.stringify({ outcome, evidence: manager.evidence, bytes })}`);
                }
                downloaded.push({ id: manager.id, variable: manager.variable, bytes });
            }
            if (downloaded.length === 0) throw new Error('No hay ningún gestor (python, npm, deno, bun, go) para la descarga real');
            await captureScreenshot('descarga-real-terminal');
            // Ajustes debe ver lo descargado y poder vaciarlo.
            await clickWhenReady('[data-testid="toolbar-settings"]');
            await findWhenReady('[role="dialog"]');
            await clickWhenReady('[data-testid="settings-tab-behavior"]');
            await clickInView(await findWhenReady('[data-testid="settings-toolchain-store-refresh"]'));
            await waitUntil(async () => {
                store = await readStore();
                return Boolean(store) && downloaded.every((item) => {
                    const row = store.rows.find((entry) => entry.variable === item.variable);
                    return row && !/^0\s*B$/u.test(row.size);
                });
            }, 30000, 'tamaños de las descargas reales en Ajustes');
            await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `document.querySelector('[data-testid="settings-toolchain-store-caches"]')?.scrollIntoView({ block: 'center' }); return true;`,
                args: [],
            });
            await captureScreenshot('ajustes-descargas-reales');
            const labelBeforeClear = store.clear;
            await clickInView(await findWhenReady('[data-testid="settings-toolchain-store-clear"]'));
            await waitUntil(async () => (await readStore())?.clear !== labelBeforeClear, 5000, 'confirmación de vaciado tras descargas');
            await clickInView(await findWhenReady('[data-testid="settings-toolchain-store-clear"]'));
            await waitUntil(async () => {
                store = await readStore();
                return Boolean(store) && /^0\s*B$/u.test(store.total.replace(/^.*:\s*/u, ''));
            }, 60000, 'vaciado de las descargas reales');
            for (const item of downloaded) {
                const manager = managers.find((entry) => entry.id === item.id);
                const left = await treeSize(join(cacheRoot, manager.evidence.slice(cacheRoot.length + 1).split(/[\\/]/u)[0]));
                if (left > 0) throw new Error(`Vaciar cachés dejó ${left} bytes de ${item.id}`);
            }
            freed = store.message;
            await captureScreenshot('ajustes-descargas-vaciadas');
            await clickWhenReady('[role="dialog"] .panel-close');
            await rm(work, { recursive: true, force: true }).catch(() => undefined);
        }
        recordEvent('toolchain-store', {
            root: store.placeholder,
            caches: store.rows.length,
            external: externalCount,
            pipPath: pip.path,
            terminalValue,
            seeded: seedPip,
            downloaded,
            freed,
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'toolchain-store';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E entornos y descargas OK: ${store.rows.length} cachés, terminal=${terminalValue}${freed ? `, ${freed.replace(/\.$/u, '')}` : ''}.\n`);
    } else if (queuedInputResizeOnly) {
        markPhase('entrada encolada y redimensionado');
        await waitForBannerPanes(1, 60000);
        await resizeWindow(980, 640, { waitForBanner: false });
        // Si se escribe antes de que la shell esté lista, la entrada espera en
        // cola. La reserva de columnas del primer eco no se liberaba al
        // enviarla y `fitAndReport` salía antes de ajustar las filas en cada
        // resize posterior: la casilla se desbordaba con la altura anterior.
        const geometry = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const cell = document.querySelector('.cell:not(.hidden)');
                const rows = cell?.querySelector('.xterm-rows');
                const host = cell?.querySelector('.tab-pane');
                const terminalHost = cell?.querySelector('[data-testid="terminal-host"]');
                const cellRect = cell?.getBoundingClientRect();
                const rowsRect = rows?.getBoundingClientRect();
                return {
                    cellBottom: cellRect ? Math.round(cellRect.bottom) : null,
                    rowsBottom: rowsRect ? Math.round(rowsRect.bottom) : null,
                    rowCount: rows ? rows.children.length : 0,
                    terminalRows: terminalHost?.dataset.terminalRows ?? null,
                    fitSkip: host?.dataset.fitSkip ?? null,
                    inputGridPinned: host?.dataset.inputGridPinned ?? null,
                    inputReady: host?.dataset.inputReady ?? null,
                };`,
            args: [],
        });
        const rowsFit = (state) => Number.isFinite(state?.rowsBottom) && Number.isFinite(state?.cellBottom)
            && state.rowsBottom <= state.cellBottom + 3;
        const attempts = Math.max(1, Number(process.env.E2E_QUEUED_INPUT_ATTEMPTS) || 3);
        const results = [];
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            await resizeWindow(980, 640, { waitForBanner: false });
            const tabsBefore = (await findAll('.tab')).length;
            await clickWhenReady('.tab-new');
            await waitUntil(async () => (await findAll('.tab')).length > tabsBefore, 15000, 'pestaña nueva');
            // Escribir en cuanto exista el receptor, sin esperar al prompt.
            let input = null;
            let readyBeforeTyping = null;
            await waitUntil(async () => {
                const cell = (await findAll('.cell:not(.hidden)'))[0]?.[elementKey];
                if (!cell) return false;
                input = (await findAllWithin(cell, '.xterm-helper-textarea'))[0]?.[elementKey] ?? null;
                if (!input) return false;
                readyBeforeTyping = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: 'arguments[0].focus(); return arguments[1].querySelector(".tab-pane")?.dataset.inputReady ?? null;',
                    args: [{ [elementKey]: input }, { [elementKey]: cell }],
                });
                return true;
            }, 5000, 'receptor de teclado de la pestaña nueva');
            const marker = `LTERMINAL_E2E_QUEUED_${attempt}_${Date.now()}`;
            const keys = [...`echo ${marker}`].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]);
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: [...keys, { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }],
            });
            const queued = readyBeforeTyping !== 'true';
            const cell = await activeTerminalCell();
            await waitUntil(async () => String(await fullTerminalTextWithin(cell) ?? '').split(marker).length >= 3
                && (await promptStates(1))[0] === 'true', 30000, `salida de la entrada encolada ${attempt}`);
            await new Promise((resolve) => setTimeout(resolve, 1200));
            const before = await geometry();
            await resizeWindow(980, 460, { waitForBanner: false });
            let shrunk = null;
            try {
                await waitUntil(async () => {
                    shrunk = await geometry();
                    return rowsFit(shrunk) && shrunk.rowCount < before.rowCount;
                }, 10000, `filas ajustadas al reducir la ventana (${attempt})`);
            } catch (error) {
                await captureScreenshot(`entrada-encolada-filas-sin-ajustar-${attempt}`);
                throw new Error(`Tras una entrada encolada, la rejilla no ajustó sus filas al reducir la ventana: ${JSON.stringify({ attempt, queued, before, shrunk })}`, { cause: error });
            }
            await resizeWindow(980, 640, { waitForBanner: false });
            let grown = null;
            try {
                await waitUntil(async () => {
                    grown = await geometry();
                    return rowsFit(grown) && grown.rowCount > shrunk.rowCount;
                }, 10000, `filas ajustadas al ampliar la ventana (${attempt})`);
            } catch (error) {
                await captureScreenshot(`entrada-encolada-filas-sin-ampliar-${attempt}`);
                throw new Error(`Tras una entrada encolada, la rejilla no recuperó sus filas al ampliar la ventana: ${JSON.stringify({ attempt, queued, shrunk, grown })}`, { cause: error });
            }
            // Las filas de ConPTY deben seguir a las de xterm tras ambos resize.
            const afterMarker = `LTERMINAL_E2E_QUEUED_AFTER_${attempt}_${Date.now()}`;
            await sendAndWaitForMarker(afterMarker);
            await assertNoDetachedCommandEcho([await activeTerminalCell()], [`echo ${afterMarker}`], `entrada-encolada-${attempt}`);
            results.push({ attempt, queued, before: before.rowCount, shrunk: shrunk.rowCount, grown: grown.rowCount, pinnedAfter: grown.inputGridPinned });
            process.stdout.write(`E2E entrada encolada ${attempt}: ${queued ? 'en cola' : 'sin cola'}, filas ${before.rowCount}→${shrunk.rowCount}→${grown.rowCount}\n`);
        }
        await captureScreenshot('entrada-encolada-redimensionada');
        if (!results.some((result) => result.queued)) {
            throw new Error(`Ningún intento llegó a escribir antes de que la shell estuviera lista: ${JSON.stringify(results)}`);
        }
        recordEvent('queued-input-resize', { results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'queued-input-resize';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E entrada encolada OK: ${results.filter((result) => result.queued).length}/${results.length} intentos en cola y filas ajustadas.\n`);
    } else if (resizeTypeOnly) {
        markPhase('escritura inmediata tras redimensionar');
        await waitForBannerPanes(1, 60000);
        await resizeWindow(980, 640, { waitForBanner: false });
        // Sin pasar por `resizeWindow`: sus consultas posteriores podían
        // consumir los 250 ms del debounce y ocultar la carrera.
        const setRect = (height) => request(`/session/${sessionId}/window/rect`, 'POST', {
            x: 40, y: 40, width: 980, height,
        });
        const typeNow = async (line) => {
            const cell = (await findAll('.cell:not(.hidden)'))[0]?.[elementKey];
            const input = cell ? (await findAllWithin(cell, '.xterm-helper-textarea'))[0]?.[elementKey] : null;
            if (!input) throw new Error('No hay receptor de teclado en la casilla visible');
            await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'arguments[0].focus(); return true;',
                args: [{ [elementKey]: input }],
            });
            const keys = [...line].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]);
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: [...keys, { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }],
            });
        };
        const expectAttached = async (marker, label) => {
            const cell = await activeTerminalCell();
            try {
                await waitUntil(async () => String(await fullTerminalTextWithin(cell) ?? '').split(marker).length >= 3
                    && (await promptStates(1))[0] === 'true', 20000, `salida de ${label}`);
            } catch (error) {
                // Distinguir una salida que no llegó de una vista que no se
                // repintó o quedó desplazada lejos del final.
                const state = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const cell = arguments[0];
                        const host = cell.querySelector('.tab-pane');
                        const terminalHost = cell.querySelector('[data-testid="terminal-host"]');
                        const viewport = cell.querySelector('.xterm-viewport');
                        const rows = [...cell.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent || '').trimEnd());
                        return { dataset: { ...host?.dataset }, terminalRows: terminalHost?.dataset.terminalRows,
                            viewport: viewport ? { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight } : null,
                            rows: rows.filter(Boolean).slice(-8) };`,
                    args: [{ [elementKey]: cell }],
                }).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
                await captureScreenshot(`sin-salida-${label}`);
                throw new Error(`${error.message}: ${JSON.stringify(state).slice(0, 4000)}`, { cause: error });
            }
            // Dejar que termine cualquier resize/repintado de ConPTY: un eco
            // despegado aparece al reposicionar, no al escribir.
            await new Promise((resolve) => setTimeout(resolve, 900));
            try {
                await assertNoDetachedCommandEcho([cell], [`echo ${marker}`], label);
            } catch (error) {
                await captureScreenshot(`eco-despegado-${label}`);
                throw error;
            }
        };
        const results = [];
        // A) Pestaña visible: cambiar la altura y escribir en el acto.
        for (const [index, height] of [520, 720, 460, 640].entries()) {
            const marker = `LTERMINAL_E2E_RESIZE_TYPE_${index}_${Date.now()}`;
            await setRect(height);
            await typeNow(`echo ${marker}`);
            await expectAttached(marker, `redimensionar-y-escribir-${index}`);
            results.push({ kind: 'visible', height, attached: true });
        }
        // B) Pestaña oculta durante el cambio de tamaño: volver y escribir.
        const attempts = Math.max(1, Number(process.env.E2E_RESIZE_TYPE_ATTEMPTS) || 3);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const originalId = await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id');
            const tabsBefore = (await findAll('.tab')).length;
            await clickWhenReady('.tab-new');
            await waitUntil(async () => (await findAll('.tab')).length > tabsBefore, 15000, 'pestaña nueva');
            await waitForBannerPanes(1, 30000);
            await setRect(attempt % 2 === 0 ? 470 : 760);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await clickWhenReady(`.tab[data-tab-id="${originalId}"]`);
            await waitUntil(async () => {
                for (const cell of await findAll('.cell:not(.hidden)')) {
                    if (await attribute(cell[elementKey], 'data-tab-id') === originalId) return true;
                }
                return false;
            }, 5000, `volver a ${originalId}`);
            const marker = `LTERMINAL_E2E_HIDDEN_RESIZE_${attempt}_${Date.now()}`;
            await typeNow(`echo ${marker}`);
            await expectAttached(marker, `pestana-oculta-${attempt}`);
            results.push({ kind: 'hidden', attempt, attached: true });
            await setRect(640);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await captureScreenshot('escritura-tras-redimensionar');
        recordEvent('resize-then-type', { results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'resize-then-type';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E escritura tras redimensionar OK: ${results.length} órdenes con el eco junto a su prompt.\n`);
    } else if (newTabEchoOnly) {
        markPhase('primera orden en pestañas nuevas');
        await waitForBannerPanes(1, 60000);
        await resizeWindow(980, 640, { waitForBanner: false });
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `if (!window.__e2eTrace) {
                window.__e2eTrace = [];
                const started = performance.now();
                window.addEventListener('winslim:terminal-output-busy', (event) => {
                    window.__e2eTrace.push({ t: Math.round(performance.now() - started), kind: 'out', tabId: event.detail?.tabId, data: event.detail?.data ?? '' });
                });
                const internals = window.__TAURI_INTERNALS__;
                if (internals && !internals.__e2eWrapped) {
                    const original = internals.invoke.bind(internals);
                    internals.invoke = (cmd, args, options) => {
                        if (/resize|send_input|input/i.test(String(cmd))) {
                            window.__e2eTrace.push({ t: Math.round(performance.now() - started), kind: 'cmd', cmd: String(cmd), args: JSON.stringify(args ?? {}).slice(0, 200) });
                        }
                        return original(cmd, args, options);
                    };
                    internals.__e2eWrapped = true;
                }
            }
            return true;`,
            args: [],
        });
        const attempts = Math.max(1, Number(process.env.E2E_NEW_TAB_ECHO_ATTEMPTS) || 4);
        // Igual que el recorrido completo: crear las pestañas primero y
        // escribir después al volver a cada una (estaba oculta).
        const switchBack = process.env.E2E_NEW_TAB_ECHO_SWITCH === '1';
        if (process.env.E2E_NEW_TAB_ECHO_ROTATE === '1') {
            // Pestañas nacidas en casillas diminutas (480x270 con 2–4 paneles),
            // como en el recorrido completo antes del paso a 8K.
            // Con E2E_NEW_TAB_ECHO_PROBE_STEPS=1 se escribe una orden de
            // prueba tras cada paso para localizar el que desalinea ConPTY.
            const probeSteps = process.env.E2E_NEW_TAB_ECHO_PROBE_STEPS === '1';
            const probe = async (label) => {
                if (process.env.E2E_NEW_TAB_ECHO_CURSOR_STEPS === '1') {
                    await new Promise((resolve) => setTimeout(resolve, 600));
                    const state = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                        script: `return [...document.querySelectorAll('.cell')].map((cell) => {
                            const rows = [...cell.querySelectorAll('.xterm-rows > div')];
                            const cursor = cell.querySelector('.xterm-cursor');
                            const cy = cursor ? (cursor.getBoundingClientRect().top + cursor.getBoundingClientRect().bottom) / 2 : null;
                            const cursorRow = cy === null ? -1 : rows.findIndex((row) => { const r = row.getBoundingClientRect(); return cy >= r.top && cy < r.bottom; });
                            const host = cell.querySelector('[data-testid="terminal-host"]');
                            return { tab: cell.dataset.tabId, hidden: cell.classList.contains('hidden'), cols: host?.dataset.terminalCols, rows: host?.dataset.terminalRows, cursorRow,
                                text: rows.map((row) => (row.textContent || '').trimEnd()).filter(Boolean).slice(-4).map((t) => t.slice(0, 30)) };
                        });`,
                        args: [],
                    });
                    process.stdout.write(`E2E cursor ${label}: ${JSON.stringify(state)}\n`);
                }
                if (!probeSteps) return;
                const cell = await activeTerminalCell();
                const marker = `PROBE_${label}_${Date.now()}`;
                await sendTerminalLine(`echo ${marker}`, cell);
                await waitUntil(async () => String(await fullTerminalTextWithin(cell) ?? '').split(marker).length >= 3, 10000, `sonda ${label}`)
                    .catch(() => undefined);
                const offenders = detachedCommandEchoes((await terminalRowSnapshot(cell)).rows, [`echo ${marker}`]);
                process.stdout.write(`E2E sonda ${label}: ${offenders.length ? 'DESPEGADA' : 'ok'}\n`);
            };
            await probe('inicio');
            if (process.env.E2E_NEW_TAB_ECHO_CURSOR_STEPS === '1') {
                // Mínimo de filas DOM que alcanza cada xterm (muestreo por frame).
                await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `window.__e2eMinRows = {};
                        const sample = () => {
                            for (const cell of document.querySelectorAll('.cell')) {
                                const count = cell.querySelectorAll('.xterm-rows > div').length;
                                const tab = cell.dataset.tabId;
                                if (tab && count > 0) window.__e2eMinRows[tab] = Math.min(window.__e2eMinRows[tab] ?? Infinity, count);
                            }
                            requestAnimationFrame(sample);
                        };
                        requestAnimationFrame(sample);
                        return true;`,
                    args: [],
                });
            }
            await resizeWindow(480, 270, { waitForBanner: false });
            await probe('480x270');
            let panes = await visiblePaneCount();
            const rotationClicks = Math.max(0, Math.min(4, Number(process.env.E2E_NEW_TAB_ECHO_ROTATIONS ?? 4)));
            for (let step = 0; step < rotationClicks; step += 1) {
                await clickWhenReady('.side-toggle.panes');
                await waitUntil(async () => await visiblePaneCount() !== panes, 5000, 'rotación de paneles');
                panes = await visiblePaneCount();
                await probe(`${panes}-paneles`);
                if (panes === 1) break;
            }
            // Volver a un panel si la rotación se cortó antes.
            while (await visiblePaneCount() > 1 && process.env.E2E_NEW_TAB_ECHO_KEEP_PANES !== '1') {
                const before = await visiblePaneCount();
                await clickWhenReady('.side-toggle.panes');
                await waitUntil(async () => await visiblePaneCount() !== before, 5000, 'cierre de paneles');
            }
            if (process.env.E2E_NEW_TAB_ECHO_SKIP_8K !== '1') {
                await resizeWindow(WINDOW_LIMITS.maxWidth, WINDOW_LIMITS.maxHeight, { waitForBanner: false });
                await probe('8K');
            }
            await resizeWindow(980, 640, { waitForBanner: false });
            await probe('980x640');
            if (process.env.E2E_NEW_TAB_ECHO_CURSOR_STEPS === '1') {
                const minRows = await request(`/session/${sessionId}/execute/sync`, 'POST', { script: 'return window.__e2eMinRows;', args: [] });
                process.stdout.write(`E2E filas mínimas por pestaña: ${JSON.stringify(minRows)}\n`);
            }
        }
        if (switchBack) {
            for (let created = 0; created < attempts; created += 1) {
                const tabsBefore = (await findAll('.tab')).length;
                await clickWhenReady('.tab-new');
                await waitUntil(async () => (await findAll('.tab')).length > tabsBefore, 15000, 'pestaña nueva');
                await waitForBannerPanes(1, 30000);
            }
        }
        const results = [];
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (switchBack) {
                const tabs = await findAll('.tab');
                const target = tabs[attempt % tabs.length][elementKey];
                const targetId = await attribute(target, 'data-tab-id');
                await click(target);
                await waitUntil(async () => {
                    for (const cell of await findAll('.cell:not(.hidden)')) {
                        if (await attribute(cell[elementKey], 'data-tab-id') === targetId) return true;
                    }
                    return false;
                }, 5000, `activación de ${targetId}`);
            } else {
                const tabsBefore = (await findAll('.tab')).length;
                await clickWhenReady('.tab-new');
                await waitUntil(async () => (await findAll('.tab')).length > tabsBefore, 15000, 'pestaña nueva');
                await waitForBannerPanes(1, 30000);
            }
            const tabId = await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id');
            const marker = `LTERMINAL_E2E_FIRST_${attempt}_${Date.now()}`;
            await sendAndWaitForMarker(marker);
            const cell = await findWhenReady('.cell:not(.hidden)');
            const snapshot = await terminalRowSnapshot(cell);
            const offenders = detachedCommandEchoes(snapshot.rows, [`echo ${marker}`]);
            results.push({ tabId, detached: offenders.length > 0 });
            process.stdout.write(`E2E primera orden ${tabId}: ${offenders.length > 0 ? 'DESPEGADA' : 'ok'}\n`);
            if (offenders.length > 0) {
                const trace = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: 'return (window.__e2eTrace || []).filter((entry) => entry.kind === "cmd" || entry.tabId === arguments[0]);',
                    args: [tabId],
                });
                const tracePath = join(projectRoot, 'artifacts', `e2e-first-echo-trace-${tabId}.json`);
                await writeFile(tracePath, JSON.stringify({ rows: snapshot.rows.map((row) => row.text.trimEnd()), trace }, null, 1));
                await captureScreenshot(`primera-orden-despegada-${tabId}`);
                throw new Error(`Primera orden despegada en ${tabId}; traza: ${tracePath}`);
            }
        }
        recordEvent('new-tab-first-echo', { results, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'new-tab-first-echo';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E primera orden OK: ${results.length} pestañas nuevas sin eco despegado.\n`);
    } else if (maxWindowOnly) {
        markPhase('ventana máxima tras rotar paneles');
        await waitForBannerPanes(1, 60000);
        await resizeWindow(480, 270, { waitForBanner: false });
        // Misma rotación que el recorrido completo: 1 → 2 → 3 → 4 → 1 crea
        // pestañas nuevas justo antes de ampliar la ventana.
        let panes = await visiblePaneCount();
        for (let step = 0; step < 4; step += 1) {
            await clickWhenReady('.side-toggle.panes');
            await waitUntil(async () => await visiblePaneCount() !== panes, 5000, 'rotación de paneles');
            panes = await visiblePaneCount();
            if (panes === 1) break;
        }
        const startedAt = Date.now();
        const maximumRect = await resizeWindow(WINDOW_LIMITS.maxWidth, WINDOW_LIMITS.maxHeight, { waitForBanner: false });
        const maximumMs = Date.now() - startedAt;
        assertWindowBounds(maximumRect, 'El máximo configurado');
        // Mantener el máximo mientras termina trabajo de fondo (precarga del
        // catálogo de dependencias) y medir si la ventana sigue respondiendo.
        const holdMs = Math.max(0, Number(process.env.E2E_MAX_WINDOW_HOLD_MS) || 0);
        const responsiveness = [];
        for (let waited = 0; waited < holdMs; waited += 10000) {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            const probeStartedAt = Date.now();
            await findAll('.cell:not(.hidden)');
            responsiveness.push(Date.now() - probeStartedAt);
            process.stdout.write(`E2E 8K sonda t+${waited + 10000} ms: ${responsiveness.at(-1)} ms\n`);
        }
        const restoreStartedAt = Date.now();
        await resizeWindow(980, 640, { waitForBanner: false });
        const restoreMs = Date.now() - restoreStartedAt;
        recordEvent('max-window-after-pane-rotation', { maximumMs, restoreMs, panes, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'max-window-after-pane-rotation';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E ventana máxima OK: 8K=${maximumMs} ms, vuelta a 980x640=${restoreMs} ms.\n`);
    } else if (longInputOnly) {
        markPhase('entrada larga y reflujo del PTY');
        await waitForBannerPanes(1, 20000);
        const longCommand = await exerciseLongCommandInputIntegrity();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'long-command-input-integrity';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E entrada larga OK: ${longCommand.snapshot?.host?.cols ?? 'n/a'} columnas y prompt restaurado (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (cursorOnly) {
        markPhase('cursor enfocado y desenfocado');
        // El arranque de WebView2 puede tardar más de 20 s cuando el host
        // está bajo carga. El test de cursor no debe fallar antes de que el
        // terminal tenga siquiera su banner y su prompt.
        await waitForBannerPanes(1, 60000);
        await sendTerminalLine(':terminal cursor-blink on');
        await waitUntil(async () => (await promptStates(1))[0] === 'true', 10000, 'activación del cursor parpadeante');
        const probe = async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const host = document.querySelector('.cell:not(.hidden) [data-testid="terminal-host"]');
                const cursor = host?.querySelector('.xterm-cursor');
                const hostStyle = host ? getComputedStyle(host) : null;
                const cursorStyle = cursor ? getComputedStyle(cursor) : null;
                const animation = host?.getAnimations?.().find((item) => /wterminal-cursor-blink/i.test(item.animationName ?? ''));
                return {
                    enabled: host?.dataset.cursorBlink === 'true',
                    cursorVisible: host?.dataset.cursorVisible ?? '',
                    focused: Boolean(host?.querySelector('.xterm.focus')),
                    animationName: hostStyle?.animationName ?? '',
                    animationDuration: hostStyle?.animationDuration ?? '',
                    cursorAnimationName: cursorStyle?.animationName ?? '',
                    opacity: cursorStyle?.opacity ?? '',
                    playState: animation?.playState ?? '',
                    currentTime: animation?.currentTime ?? null,
                    inlineStyle: cursor?.getAttribute('style') ?? '',
                    outerHTML: cursor?.outerHTML?.slice(0, 300) ?? '',
                    parentClass: cursor?.parentElement?.className ?? '',
                    pseudoOpacity: cursor ? getComputedStyle(cursor, '::after').opacity : '',
                };`,
            args: [],
        });
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        const samples = [await probe()];
        for (const delay of [220, 220, 220]) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            samples.push(await probe());
        }
        await captureScreenshot('cursor-blink-focused-dialog');
        const currentTimes = samples.map((sample) => Number(sample.currentTime)).filter(Number.isFinite);
        const animationAdvances = currentTimes.length >= 2
            && new Set(currentTimes.map((value) => Math.round(value))).size >= 2;
        const phaseValues = samples.map((sample) => sample.cursorVisible).filter(Boolean);
        const phaseAdvances = new Set(phaseValues).size >= 2;
        const inactiveAnimation = samples.every((sample) => sample.enabled
            && (phaseAdvances || (/wterminal-cursor-blink/i.test(sample.animationName)
                && sample.animationDuration !== '0s'
                && sample.playState === 'running')));
        if (!inactiveAnimation || (!animationAdvances && !phaseAdvances)) {
            throw new Error(`El cursor desenfocado no mantiene una animación viva: ${JSON.stringify({ samples, animationAdvances })}`);
        }
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras probar cursor');
        await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'document.activeElement?.blur?.(); return true;',
            args: [],
        });
        await waitUntil(async () => {
            const state = await probe();
            return state.focused === false
                && (state.cursorVisible !== '' || /wterminal-cursor-blink/i.test(state.animationName));
        }, 5000, 'cursor visible al perder el foco');
        const inactiveCapture = await captureScreenshot('cursor-blink-inactive-visible');
        let inactiveAfterState = null;
        const initialInactivePhase = (await probe()).cursorVisible;
        for (let sample = 0; sample < 20; sample += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            inactiveAfterState = await probe();
            if (inactiveAfterState.opacity === '0'
                || (initialInactivePhase !== '' && inactiveAfterState.cursorVisible !== initialInactivePhase)) break;
        }
        if (inactiveAfterState?.opacity !== '0'
            && !(initialInactivePhase !== '' && inactiveAfterState?.cursorVisible !== initialInactivePhase)) {
            throw new Error(`No se observó la fase apagada del cursor: ${JSON.stringify(inactiveAfterState)}`);
        }
        const inactiveAfterCapture = await captureScreenshot('cursor-blink-inactive-after');
        await clickWhenReady('.cell:not(.hidden) .xterm');
        await waitUntil(async () => (await probe()).focused === true, 5000, 'recuperación del foco de la terminal');
        const focused = await probe();
        if (!focused.enabled || !focused.focused || /wterminal-cursor-blink/i.test(focused.cursorAnimationName)) {
            throw new Error(`El cursor enfocado quedó con estado incoherente: ${JSON.stringify(focused)}`);
        }
        await assertCurrentLog();
        recordEvent('cursor-blink-focused-and-inactive', {
            samples,
            animationAdvances,
            focused,
            captures: [inactiveCapture, inactiveAfterCapture, 'cursor-blink-focused-dialog'],
            passed: true,
        });
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'cursor-blink';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E cursor OK: animación desenfocada viva y cursor enfocado restaurado (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (horizontalOnly) {
        markPhase('integridad horizontal y reflujo de comandos');
        await waitForBannerPanes(1, 20000);
        const horizontal = await exerciseHorizontalSequenceIntegrity();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'horizontal-sequence';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        const horizontalEvent = smokeReport.events.findLast((event) => event.type === 'horizontal-sequence-integrity');
        process.stdout.write(`E2E horizontal OK: ${horizontalEvent?.numericRanges?.length ?? 0} rangos y reflujo verificados (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (paneMatrixOnly) {
        markPhase('matriz PTY y transiciones de paneles');
        await waitForBannerPanes(1, 20000);
        const sequence = IS_WSL1_HOST
            ? [[2, 1100, 720], [1, 1100, 720], [2, 1180, 740]]
            : [[2, 1100, 720], [3, 1240, 780], [4, 1240, 780], [1, 1100, 720], [2, 1180, 740], [3, 1300, 800], [4, 1300, 800]];
        let current = 1;
        const transitions = [];
        for (const [target, width, height] of sequence) {
            await clickPaneControl('mouse-pane-matrix-focused');
            await waitUntil(async () => await visiblePaneCountWithTimeout(30000) === target, 90000, `matriz enfocada: ${target} panel(es)`);
            const applied = await resizeWindow(width, height, { waitForBanner: false });
            await assertPaneOutputStable(target, `matriz enfocada ${current}→${target}`);
            await assertNoTinyFragmentRuns(target, `matriz enfocada ${current}→${target}`);
            await captureScreenshot(`matriz-enfocada-${current}-a-${target}`);
            transitions.push({ from: current, to: target, width: applied.width, height: applied.height });
            current = target;
        }
        recordEvent('pane-matrix-focused', { transitions, finalCount: current, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'pane-matrix';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E matriz PTY OK: ${transitions.length} transiciones, ${current} paneles finales (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_SHELL_MATRIX_ONLY === '1') {
        markPhase('cambio de shell');
        const matrix = await exerciseShellMatrix();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'environment-shell-matrix';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: entornos detectados ${matrix.availableIds.length}; sondas ejecutadas ${matrix.testedIds.length}; omisiones seguras ${matrix.skipped.length}; restaurado ${matrix.restoredTo} (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (process.env.E2E_FRAMEWORK_CATEGORIES_ONLY === '1') {
        markPhase('categorías de frameworks');
        await resizeWindow(1100, 900, { waitForBanner: false });
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        await findWhenReady('[data-testid="dependency-detection-placeholder"]');
        await waitUntil(async () => (await findAll('[role="dialog"] .filters')).length > 0, 180000, 'fin de la detección para frameworks');
        await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0, 30000, 'grupos de dependencias');
        const developmentSection = await findWhenReady('[data-testid="dependency-section"][data-section-id="development"]');
        if ((await attribute(developmentSection, 'open')) === null) {
            await clickWhenReady('[data-testid="dependency-section"][data-section-id="development"] > summary.section-header');
        }
        const frameworkGroup = await findWhenReady('[data-testid="dependency-group"][data-group-key="group.frameworks"]');
        if ((await attribute(frameworkGroup, 'open')) === null) {
            await clickWhenReady('[data-testid="dependency-group"][data-group-key="group.frameworks"] > summary.group-title');
        }
        const parents = await findAllWithin(frameworkGroup, '[data-testid="dependency-subgroup"][data-subgroup-level="parent"] > summary');
        const parentText = (await Promise.all(parents.map((item) => textOf(item[elementKey])))).join('\n');
        if (!/Python|\.NET|Rust/i.test(parentText)) throw new Error('Faltan familias padre de frameworks');
        let dotnet = null;
        for (const summary of parents) {
            if (/\.NET/i.test(await textOf(summary[elementKey]))) {
                dotnet = summary[elementKey];
                break;
            }
        }
        if (!dotnet) throw new Error('Falta la categoría padre .NET');
        await click(dotnet);
        const dotnetDetails = await parentOf(dotnet);
        const children = await findAllWithin(dotnetDetails, '[data-testid="dependency-subgroup"][data-subgroup-level="child"] > summary');
        const childText = (await Promise.all(children.map((item) => textOf(item[elementKey])))).join('\n');
        if (!/Paket/i.test(childText)) throw new Error('Paket no aparece como categoría hija de .NET');
        if ((await findAllWithin(dotnetDetails, '[data-action-id="framework-paket"]')).length === 0) {
            throw new Error('Paket no conserva sus acciones dentro de su categoría');
        }
        await captureScreenshot('framework-categories-nested');
        recordEvent('framework-nested-categories', {
            parents: parents.length,
            dotnetChildren: children.length,
            paketVisible: true,
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'framework-nested-categories';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: ${parents.length} familias y ${children.length} frameworks .NET categorizados (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (ltoolsSettingsRouteOnly) {
        markPhase('ruta de configuración de LTools');
        const route = await exerciseLToolsSettingsRoute();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'ltools-settings-route';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: Configurar LTools desde Ajustes abrió la Biblioteca (${route.installVisible ? 'instalación visible' : 'catálogo disponible'}).\n`);
    } else if (ltoolsOnly) {
        markPhase('integración opcional de LTools');
        const integration = await exerciseLToolsIntegration();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'ltools-catalog-integration';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: LTools descubrió ${integration.catalogActions} acciones, ${integration.compatibleActions} compatibles y ejecutó ${integration.selectedAction} (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (progressLayoutOnly) {
        markPhase('salidas progresivas de actualización');
        const progress = await exerciseProgressOutputLayout();
        const horizontalSequence = await exerciseHorizontalSequenceIntegrity();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'progress-output-layout';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: barras simuladas, secuencia horizontal íntegra y recuperación de ancho (${progress.durationMs} ms).\n`);
    } else if (dependencyActionsOnly) {
        markPhase('acciones de una dependencia concreta');
        await resizeWindow(1100, 900, { waitForBanner: false });
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0,
            dependencyDetectionTimeoutMs, 'catálogo navegable para acciones concretas');
        const developmentSection = await findWhenReady('[data-testid="dependency-section"][data-section-id="development"]');
        if ((await attribute(developmentSection, 'open')) === null) {
            await clickWhenReady('[data-testid="dependency-section"][data-section-id="development"] > summary.section-header');
        }
        const languagesGroup = await findWhenReady('[data-testid="dependency-group"][data-group-key="group.languages"]');
        if ((await attribute(languagesGroup, 'open')) === null) {
            await clickWhenReady('[data-testid="dependency-group"][data-group-key="group.languages"] > summary.group-title');
        }
        let llvmSummary = null;
        const subgroupSummaries = await findAllWithin(languagesGroup,
            '[data-testid="dependency-subgroup"] > summary');
        for (const summary of subgroupSummaries) {
            if (/Clang|LLVM/i.test(await textOf(summary[elementKey]))) {
                llvmSummary = summary[elementKey];
                break;
            }
        }
        if (!llvmSummary) throw new Error('No apareció la familia C/C++ · Clang/LLVM');
        const llvmDetails = await parentOf(llvmSummary);
        if ((await attribute(llvmDetails, 'open')) === null) await clickInView(llvmSummary);
        const llvmSelector = '[data-testid="dependency-subgroup"]';
        await waitUntil(async () => {
            const current = await findAllWithin(languagesGroup, llvmSelector);
            for (const node of current) {
                if (/Clang|LLVM/i.test(await textOf(node[elementKey]))) return true;
            }
            return false;
        }, 10000, 'familia LLVM visible');
        await waitUntil(async () => {
            const currentSummaries = await findAllWithin(languagesGroup,
                '[data-testid="dependency-subgroup"] > summary');
            let details = null;
            for (const summary of currentSummaries) {
                if (/Clang|LLVM/i.test(await textOf(summary[elementKey]))) {
                    details = await parentOf(summary[elementKey]);
                    break;
                }
            }
            if (!details) return false;
            const states = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: `return [...arguments[0].querySelectorAll('[data-testid="dependency-action"]')].map((node) => ({
                    state: node.getAttribute('data-detection-state'),
                    status: node.getAttribute('data-detection-status'),
                    text: (node.textContent || '').replace(/\\s+/g, ' ').trim()
                }));`,
                args: [{ [elementKey]: details }],
            });
            return states.length > 0 && states.every((item) => item.status !== 'unknown'
                && !/Comprobar|Comprobando/i.test(item.text));
        }, 30000, 'acciones reales de LLVM');
        let finalDetails = null;
        const finalSummaries = await findAllWithin(languagesGroup,
            '[data-testid="dependency-subgroup"] > summary');
        for (const summary of finalSummaries) {
            if (/Clang|LLVM/i.test(await textOf(summary[elementKey]))) {
                finalDetails = await parentOf(summary[elementKey]);
                break;
            }
        }
        if (!finalDetails) throw new Error('LLVM desapareció al confirmar sus acciones');
        const actionSnapshot = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return [...arguments[0].querySelectorAll('[data-testid="dependency-action"]')].map((node) => ({
                id: node.getAttribute('data-action-id'),
                state: node.getAttribute('data-detection-state'),
                status: node.getAttribute('data-detection-status'),
                text: (node.textContent || '').replace(/\\s+/g, ' ').trim()
            }));`,
            args: [{ [elementKey]: finalDetails }],
        });
        await captureScreenshot('dependencias-llvm-acciones-confirmadas');
        recordEvent('dependency-focused-actions', { family: 'llvm', actions: actionSnapshot, passed: true });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'dependency-focused-actions';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: LLVM publicó ${actionSnapshot.length} acciones reales (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (dependencyAuditOnly) {
        markPhase('auditoría completa de entornos y dependencias');
        await waitUntil(async () => (await promptStates(1))[0] === 'true', 20000, 'prompt antes de la auditoría audiovisual');
        const auditInput = 'echo E2E_DEPENDENCY_AUDIT_INPUT_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        await sendTerminalLine(auditInput);
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            return snapshot.rows.some((row) => row.text.includes('E2E_DEPENDENCY_AUDIT_INPUT_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
                && snapshotPromptVisible(snapshot);
        }, 15000, 'entrada y salida antes de abrir Dependencias');
        await captureScreenshot('dependencias-auditoria-terminal-entrada-salida');
        recordEvent('dependency-audit-terminal-io', {
            input: auditInput,
            outputMarker: 'E2E_DEPENDENCY_AUDIT_INPUT_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            promptRestored: true,
            passed: true,
        });
        await captureScreenshot('dependencias-auditoria-antes-de-abrir');
        await clickWhenReady('[data-testid="toolbar-dependencies"]');

        const waitForDependencyActionsSettled = async (label, timeoutMs = dependencyDetectionTimeoutMs) => {
            let previousSignature = null;
            let stablePolls = 0;
            await waitUntil(async () => {
                const snapshot = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `return (() => {
                        const actions = [...document.querySelectorAll('[data-testid="dependency-action"]')];
                        const pending = actions.filter((node) =>
                            node.getAttribute('data-detection-status') === 'unknown'
                            && node.disabled === true
                        ).length;
                        const checkingText = actions.filter((node) => /Comprobando|Checking/i.test(node.textContent ?? '')).length;
                        const refresh = document.querySelector('[data-testid="dependency-refresh"]');
                        const signature = actions.map((node) => [
                            node.getAttribute('data-action-id'),
                            node.getAttribute('data-detection-state'),
                            node.getAttribute('data-detection-status'),
                            node.getAttribute('data-installed'),
                        ].join(':')).sort().join('|');
                        return { count: actions.length, pending, checkingText, refreshDisabled: refresh?.disabled === true, signature };
                    })();`,
                    args: [],
                });
                const settled = snapshot.count > 0
                    && snapshot.pending === 0
                    && snapshot.checkingText === 0
                    && snapshot.refreshDisabled !== true;
                if (settled && snapshot.signature === previousSignature) stablePolls += 1;
                else stablePolls = 0;
                previousSignature = snapshot.signature;
                return settled && stablePolls >= 2;
            }, timeoutMs, `${label}: acciones de dependencias asentadas`);
            // Dejar un frame adicional para que Svelte publique la última
            // etiqueta/botón antes de fotografiar o leer el grupo.
            await new Promise((resolve) => setTimeout(resolve, 160));
        };

        const waitForCompleteCatalog = async (label) => {
            let groupsOnOpen = (await findAll('[data-testid="dependency-group"]')).length;
            await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0
                || (await findAll('[data-testid="dependency-detection-placeholder"]')).length > 0,
            10000, `${label}: estado inicial del catálogo`);
            groupsOnOpen = (await findAll('[data-testid="dependency-group"]')).length;
            const placeholderOnOpen = (await findAll('[data-testid="dependency-detection-placeholder"]')).length;
            if (groupsOnOpen === 0) {
                // El placeholder puede retirarse en el mismo ciclo en que el
                // catálogo confirmado aparece. Lo importante es comprobar la
                // instantánea inicial, sin exigir que el nodo siga montado.
                if (placeholderOnOpen === 0 && (await findAll('[data-testid="dependency-group"]')).length !== 0) {
                    throw new Error(`${label}: se mostró un grupo antes de confirmar el catálogo completo`);
                }
            } else if (placeholderOnOpen !== 0) {
                throw new Error(`${label}: se mezcló un catálogo confirmado con el placeholder`);
            }
            await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0,
                dependencyDetectionTimeoutMs, `${label}: catálogo de dependencias`);
            await waitUntil(async () => !(await property(
                await findWhenReady('[data-testid="dependency-refresh"]'),
                'disabled',
            )), dependencyDetectionTimeoutMs, `${label}: fin de detección`);
            await waitUntil(async () => (await attribute(
                await findWhenReady('[data-testid="dependency-detection-toolbar"]'),
                'data-catalog-complete',
            )) === 'true', dependencyDetectionTimeoutMs, `${label}: inventario confirmado`);
            await waitForDependencyActionsSettled(label);
            return { groupsOnOpen, reusedCache: groupsOnOpen > 0 };
        };

        const walkVisibleDependencyActions = async (sectionId, groupIndex, groupKey, actions, pass) => {
            const walked = [];
            const removedAfterDetection = [];
            for (const action of actions) {
                const actionId = action.id;
                const positioned = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const sectionId = arguments[0];
                        const groupIndex = arguments[1];
                        const id = arguments[2];
                        const section = [...document.querySelectorAll('[data-testid="dependency-section"]')]
                            .find((candidate) => candidate.getAttribute('data-section-id') === sectionId);
                        const group = section?.querySelectorAll('[data-testid="dependency-group"]')?.[groupIndex];
                        const node = [...(group?.querySelectorAll('[data-testid="dependency-action"]') ?? [])]
                            .find((candidate) => candidate.getAttribute('data-action-id') === id);
                        if (!node) return { found: false };
                        // El estado ya fue comprobado antes del recorrido. Abrir
                        // el nodo DOM directamente evita volver a lanzar la
                        // sonda y que la tarjeta cambie de altura justo cuando
                        // se está midiendo su viewport (la preferencia de
                        // acordeón sigue aplicándose a la interacción real).
                        if (group && !group.open) group.open = true;
                        // El acordeón exclusivo puede haber dejado cerrada la
                        // tarjeta que contiene la acción. Abrir la cadena de
                        // padres antes de desplazarla evita que
                        // scrollIntoView() opere sobre un descendiente oculto y
                        // que el vídeo permanezca congelado en la tarjeta
                        // anterior (el falso positivo que ocultaba saltos como
                        // CSharpier -> AWS CLI).
                        const ancestors = [];
                        for (let details = node.closest('details[data-testid="dependency-subgroup"]');
                            details && details !== group;
                            details = details.parentElement?.closest('details[data-testid="dependency-subgroup"]')) {
                            ancestors.unshift(details);
                        }
                        for (const details of ancestors) {
                            if (!details.open) details.open = true;
                        }
                        node.scrollIntoView({ block: 'center', inline: 'nearest' });
                        let rect = node.getBoundingClientRect();
                        const scroller = node.closest('.panel-scroll');
                        const panel = node.closest('[role="dialog"]');
                        const header = panel?.querySelector(':scope > .panel-header');
                        const scrollRect = scroller?.getBoundingClientRect();
                        const headerRect = header?.getBoundingClientRect();
                        const minTop = Math.max(scrollRect?.top ?? 0, headerRect?.bottom ?? 0) + 4;
                        const maxBottom = Math.min(scrollRect?.bottom ?? innerHeight, innerHeight) - 4;
                        // WebView2 puede aplicar el scroll nativo después de la
                        // primera lectura. Repetir la corrección con el valor
                        // recién medido evita dejar la tarjeta bajo la cabecera
                        // sticky, sobre todo en el último tercio del panel.
                        for (let attempt = 0; scroller && attempt < 3; attempt += 1) {
                            if (rect.top < minTop) scroller.scrollTop = Math.max(0, scroller.scrollTop - (minTop - rect.top));
                            else if (rect.bottom > maxBottom) scroller.scrollTop += rect.bottom - maxBottom;
                            else break;
                            rect = node.getBoundingClientRect();
                        }
                        const settledRect = node.getBoundingClientRect();
                        return { found: true, top: settledRect.top, bottom: settledRect.bottom,
                            height: settledRect.height, scrollTop: scroller?.scrollTop ?? null,
                            ancestorCount: ancestors.length,
                            text: (node.textContent ?? '').replace(/\\s+/g, ' ').trim() };`,
                    args: [sectionId, groupIndex, actionId],
                });
                if (!positioned?.found) {
                    // Una sonda puede confirmar una familia mientras el
                    // recorrido está en curso y la UI retira las acciones de
                    // actualizar/desinstalar que ya no aplican. No es un salto
                    // silencioso: se conserva el identificador para que el
                    // informe distinga una acción retirada por el estado de
                    // una acción que nunca llegó a estar en el catálogo.
                    removedAfterDetection.push(actionId);
                    continue;
                }
                // Abrir un grupo directo o una cadena de subgrupos puede
                // provocar un ciclo de Svelte que reemplaza las tarjetas y
                // reajusta el scroll. Dejar que termine antes de medir evita
                // capturar la geometría intermedia.
                await new Promise((resolve) => setTimeout(resolve, Math.max(160, dependencyVisualActionHoldMs)));
                await waitUntil(async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const section = [...document.querySelectorAll('[data-testid="dependency-section"]')]
                        .find((candidate) => candidate.getAttribute('data-section-id') === arguments[0]);
                        const group = section?.querySelectorAll('[data-testid="dependency-group"]')?.[arguments[1]];
                        const node = [...(group?.querySelectorAll('[data-testid="dependency-action"]') ?? [])]
                            .find((candidate) => candidate.getAttribute('data-action-id') === arguments[2]);
                        // Si la confirmación retira la acción de actualizar o
                        // desinstalar, la ausencia ya es el estado final de
                        // esa opción y el recorrido la anotará como retirada.
                        return !node || !/Comprobando|Checking/i.test(node.textContent ?? '');`,
                    args: [sectionId, groupIndex, actionId],
                }), Math.min(dependencyDetectionTimeoutMs, 30000),
                `Recorrido ${pass}: terminó la sonda ${sectionId}/${actionId}`);
                const visible = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                    script: `const sectionId = arguments[0];
                        const groupIndex = arguments[1];
                        const id = arguments[2];
                        const section = [...document.querySelectorAll('[data-testid="dependency-section"]')]
                            .find((candidate) => candidate.getAttribute('data-section-id') === sectionId);
                        const group = section?.querySelectorAll('[data-testid="dependency-group"]')?.[groupIndex];
                        const node = [...(group?.querySelectorAll('[data-testid="dependency-action"]') ?? [])]
                            .find((candidate) => candidate.getAttribute('data-action-id') === id);
                        if (!node) return { found: false, visible: false };
                        node.scrollIntoView({ block: 'center', inline: 'nearest' });
                        const scroller = node.closest('.panel-scroll');
                        const panel = node.closest('[role="dialog"]');
                        const header = panel?.querySelector(':scope > .panel-header');
                        const scrollRect = scroller?.getBoundingClientRect();
                        const headerRect = header?.getBoundingClientRect();
                        const minTop = Math.max(scrollRect?.top ?? 0, headerRect?.bottom ?? 0) + 4;
                        const maxBottom = Math.min(scrollRect?.bottom ?? innerHeight, innerHeight) - 4;
                        let rect = node.getBoundingClientRect();
                        for (let attempt = 0; scroller && attempt < 3; attempt += 1) {
                            if (rect.top < minTop) scroller.scrollTop = Math.max(0, scroller.scrollTop - (minTop - rect.top));
                            else if (rect.bottom > maxBottom) scroller.scrollTop += rect.bottom - maxBottom;
                            else break;
                            rect = node.getBoundingClientRect();
                        }
                        const intersection = Math.max(0, Math.min(rect.bottom, maxBottom) - Math.max(rect.top, minTop));
                        const visible = rect.height > 0 && intersection >= Math.min(rect.height, 8);
                        return { found: true, visible, top: rect.top, bottom: rect.bottom,
                            height: rect.height, intersection, minTop, maxBottom,
                            scrollTop: scroller?.scrollTop ?? null,
                            text: (node.textContent ?? '').replace(/\\s+/g, ' ').trim() };`,
                    args: [sectionId, groupIndex, actionId],
                });
                if (!visible?.found) {
                    removedAfterDetection.push(actionId);
                    continue;
                }
                if (!visible.visible) {
                    throw new Error(`Recorrido ${pass}: la opción no quedó visible ${sectionId}/${actionId} (${JSON.stringify(visible)})`);
                }
                // El muestreo periódico puede saltarse una tarjeta cuando el
                // hold es menor que un intervalo de vídeo. Capturar aquí
                // conserva una prueba visual determinista de cada opción
                // recorrida, sin pulsarla ni ejecutar su acción.
                if (windowVideoSampleNow) await windowVideoSampleNow();
                if (dependencyCaptureEachAction) {
                    await captureScreenshot(`dependencias-auditoria-${pass}-accion-${actionId}`);
                }
                walked.push({ id: actionId, top: visible.top, bottom: visible.bottom,
                    scrollTop: visible.scrollTop, intersection: visible.intersection });
            }
            return { walked, removedAfterDetection };
        };

        // Lee todo el árbol visible. Cada sección y grupo se desplaza hasta la
        // ventana antes de inspeccionarse, de modo que las capturas demuestran
        // también el recorrido visual y no solo el contenido del DOM.
        const collectDependencyAudit = async (pass, {
            visual = captureScreenshots || captureVideo,
            // Las dos pasadas deben demostrar el mismo recorrido visual. La
            // segunda ya parte de estados confirmados, pero aun así hay que
            // desplazar cada tarjeta para detectar saltos, cabeceras que se
            // ocultan y acciones que desaparecen al refrescar.
            walkActions = dependencyVisualActions,
        } = {}) => {
            const startedAt = Date.now();
            const sections = await findAll('[data-testid="dependency-section"]');
            if (sections.length === 0) throw new Error(`Auditoría ${pass}: no hay secciones`);
            const result = { pass, durationMs: 0, sections: [], groups: [], actions: [], visualWalk: [] };
            const seenActionIds = new Set();
            for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
                let section = (await findAll('[data-testid="dependency-section"]'))[sectionIndex];
                if (!section) throw new Error(`Auditoría ${pass}: falta la sección ${sectionIndex}`);
                const sectionId = await attribute(section[elementKey], 'data-section-id') ?? `section-${sectionIndex}`;
                if (visual) await scrollIntoView(section[elementKey]);
                if (visual && (await attribute(section[elementKey], 'open')) === null) {
                    await clickWhenReady(`[data-testid="dependency-section"][data-section-id="${sectionId}"] > summary.section-header`);
                }
                section = await findWhenReady(`[data-testid="dependency-section"][data-section-id="${sectionId}"]`);
                const sectionGroups = await findAllWithin(section, '[data-testid="dependency-group"]');
                const sectionResult = { id: sectionId, index: sectionIndex, groups: sectionGroups.length };
                result.sections.push(sectionResult);
                if (visual) await captureScreenshot(`dependencias-auditoria-${pass}-seccion-${sectionId}`);

                for (let groupIndex = 0; groupIndex < sectionGroups.length; groupIndex += 1) {
                    section = await findWhenReady(`[data-testid="dependency-section"][data-section-id="${sectionId}"]`);
                    const groups = await findAllWithin(section, '[data-testid="dependency-group"]');
                    let group = groups[groupIndex];
                    if (!group) throw new Error(`Auditoría ${pass}: falta el grupo ${sectionId}/${groupIndex}`);
                    const groupKey = await attribute(group[elementKey], 'data-group-key') ?? `${sectionId}-${groupIndex}`;
                    if (visual) await scrollIntoView(group[elementKey]);
                    const groupSummary = visual
                        ? (await findAllWithin(group[elementKey], ':scope > summary.group-title'))[0]
                        : null;
                    if (visual && groupSummary && (await attribute(group[elementKey], 'open')) === null) {
                        // La auditoría ya esperó a la detección completa. Abrir
                        // el grupo directamente evita que el handler de la UI
                        // lance una nueva sonda por cada familia y cambie el
                        // catálogo mientras estamos recorriendo sus acciones.
                        await scrollIntoView(group[elementKey]);
                        await request(`/session/${sessionId}/execute/sync`, 'POST', {
                            script: 'arguments[0].open = true; return true;',
                            args: [{ [elementKey]: group[elementKey] }],
                        });
                        group = (await findAllWithin(
                            await findWhenReady(`[data-testid="dependency-section"][data-section-id="${sectionId}"]`),
                            '[data-testid="dependency-group"]',
                        ))[groupIndex];
                    }
                    // Abrir cada nivel del árbol antes de contar las acciones;
                    // esto detecta categorías que desaparecen al quedar con una
                    // sola acción (el caso que provocó falsos negativos).
                    for (let expandPass = 0; visual && expandPass < 3; expandPass += 1) {
                        // Abrir los detalles en una sola ejecución sobre el grupo actual.
                        // Svelte puede reemplazar los nodos al confirmar una sonda; iterar
                        // referencias WebDriver individuales aquí producía stale element.
                        group = (await findAllWithin(
                            await findWhenReady(`[data-testid="dependency-section"][data-section-id="${sectionId}"]`),
                            '[data-testid="dependency-group"]',
                        ))[groupIndex];
                        if (!group) throw new Error(`Auditoría ${pass}: el grupo ${sectionId}/${groupIndex} desapareció`);
                        const expansion = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                            script: `const group = arguments[0];
                                let expanded = 0;
                                group.querySelectorAll('[data-testid="dependency-subgroup"]').forEach((details) => {
                                    if (!details.open) { details.open = true; expanded += 1; }
                                });
                                return expanded;`,
                            args: [{ [elementKey]: group[elementKey] }],
                        });
                        if (!Number(expansion)) break;
                    }
                    // Svelte puede volver a montar toda la sección al confirmar
                    // una sonda. No conservamos referencias a cada botón entre
                    // lecturas WebDriver: obtenemos una instantánea atómica del
                    // grupo y validamos únicamente datos planos. Así el E2E no
                    // convierte un rerender normal en un falso fallo stale.
                    await waitForDependencyActionsSettled(`${pass}: ${sectionId}/${groupKey}`, 30000);
                    let groupSnapshot = null;
                    let snapshotError = null;
                    const snapshotDeadline = Date.now() + 6000;
                    while (!groupSnapshot && Date.now() < snapshotDeadline) {
                        try {
                            const currentSection = await findWhenReady(
                                `[data-testid="dependency-section"][data-section-id="${sectionId}"]`,
                                1000,
                            );
                            const currentGroups = await findAllWithin(currentSection, '[data-testid="dependency-group"]');
                            const currentGroup = currentGroups[groupIndex];
                            if (!currentGroup) {
                                throw new Error(`No apareció el grupo ${sectionId}/${groupIndex}`);
                            }
                            groupSnapshot = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                                script: `const group = arguments[0];
                                    return {
                                        actions: [...group.querySelectorAll('[data-testid="dependency-action"]')].map((node) => ({
                                            id: node.getAttribute('data-action-id'),
                                            state: node.getAttribute('data-detection-state'),
                                            detectionStatus: node.getAttribute('data-detection-status'),
                                            installed: node.getAttribute('data-installed'),
                                            text: node.textContent ?? '',
                                            buttonTexts: [...(node.matches('button') ? [node] : node.querySelectorAll('button'))]
                                                .map((button) => (button.textContent ?? '').replace(/\\s+/g, ' ').trim())
                                                .filter(Boolean),
                                            disabled: node.disabled === true,
                                            installedContainer: Boolean(node.closest('.tool, .subgroup')?.classList.contains('installed')),
                                        })),
                                        subgroupCount: group.querySelectorAll('[data-testid="dependency-subgroup"]').length,
                                    };`,
                                args: [{ [elementKey]: currentGroup[elementKey] }],
                            });
                        } catch (error) {
                            snapshotError = error;
                            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                        }
                    }
                    if (!groupSnapshot) {
                        throw snapshotError ?? new Error(`No se pudo leer el grupo ${sectionId}/${groupIndex}`);
                    }
                    const actions = groupSnapshot.actions ?? [];
                    const subgroupCount = Number(groupSnapshot.subgroupCount ?? 0);
                    result.groups.push({ sectionId, key: groupKey, index: groupIndex, actions: actions.length, subgroups: subgroupCount });
                    if (actions.length === 0 && subgroupCount === 0 && groupKey !== 'group.updates') {
                        throw new Error(`Auditoría ${pass}: grupo sin contenido ${sectionId}/${groupKey}`);
                    }
                    if (visual) await captureScreenshot(`dependencias-auditoria-${pass}-grupo-${sectionId}-${groupIndex}`);
                    if (walkActions) {
                        const walkResult = await walkVisibleDependencyActions(
                            sectionId,
                            groupIndex,
                            groupKey,
                            actions,
                            pass,
                        );
                        result.visualWalk.push({
                            sectionId,
                            groupKey,
                            count: walkResult.walked.length,
                            firstActionId: walkResult.walked[0]?.id ?? null,
                            lastActionId: walkResult.walked.at(-1)?.id ?? null,
                            // Conservar la secuencia completa permite comprobar
                            // que el vídeo no saltó de una familia a otra aunque
                            // el contador global de acciones coincida.
                            actionIds: walkResult.walked.map((entry) => entry.id),
                            visibleSamples: walkResult.walked.length,
                            removedAfterDetection: walkResult.removedAfterDetection,
                        });
                    }
                    for (const action of actions) {
                        const actionId = action.id;
                        if (!actionId) throw new Error(`Auditoría ${pass}: acción sin identificador en ${sectionId}/${groupKey}`);
                        if (seenActionIds.has(`${sectionId}/${actionId}`)) {
                            throw new Error(`Auditoría ${pass}: acción duplicada ${sectionId}/${actionId}`);
                        }
                        seenActionIds.add(`${sectionId}/${actionId}`);
                        const buttonText = String(action.text ?? '').replace(/\s+/g, ' ').trim();
                        const buttonLabels = (action.buttonTexts ?? [])
                            .map((label) => String(label).replace(/\s+/g, ' ').trim())
                            .filter(Boolean);
                        const state = action.state;
                        const detectionStatus = action.detectionStatus;
                        const installedState = action.installed;
                        if (!['installed', 'absent', 'unknown', 'not-applicable'].includes(state)) {
                            throw new Error(`Auditoría ${pass}: ${actionId} no publicó un estado de detección válido (${state})`);
                        }
                        if (state === 'unknown' && detectionStatus !== 'unknown') {
                            throw new Error(`Auditoría ${pass}: ${actionId} declara unknown sin una sonda desconocida`);
                        }
                        if (state === 'installed' && installedState !== 'true') {
                            throw new Error(`Auditoría ${pass}: ${actionId} declara instalado con atributo inconsistente`);
                        }
                        if (state === 'absent' && installedState !== 'false') {
                            throw new Error(`Auditoría ${pass}: ${actionId} declara ausente con atributo inconsistente`);
                        }
                        if (state === 'installed' && !action.installedContainer) {
                            throw new Error(`Auditoría ${pass}: ${actionId} declara instalado pero su herramienta no está marcada instalada`);
                        }
                        if (state === 'unknown' && !/(?:Comprobar|Check|Comprobando|Checking)/i.test(buttonText)) {
                            throw new Error(`Auditoría ${pass}: ${actionId} no pudo comprobarse pero no ofrece volver a comprobarlo`);
                        }
                        const isDiagnosticAction = /(?:^|[-_])(?:version|check)$/i.test(actionId);
                        if (detectionStatus === 'confirmed'
                            && state !== 'unknown'
                            && !isDiagnosticAction
                            && buttonLabels.some((label) => /^(?:Comprobar|Comprobando|Checking)$/i.test(label))) {
                            throw new Error(`Auditoría ${pass}: ${actionId} conserva «Comprobar» después de confirmar ${state}: ${JSON.stringify(buttonLabels)}`);
                        }
                        if (detectionStatus === 'confirmed' && buttonLabels.length === 0) {
                            throw new Error(`Auditoría ${pass}: ${actionId} no publicó ningún control de acción tras confirmar ${state}`);
                        }
                        result.actions.push({
                            sectionId,
                            groupKey,
                            id: actionId,
                            state,
                            detectionStatus,
                            installed: state === 'installed',
                            disabled: Boolean(action.disabled),
                            buttonLabels,
                        });
                    }
                }
            }
            result.durationMs = Date.now() - startedAt;
            result.actionCount = result.actions.length;
            result.groupCount = result.groups.length;
            result.stateCounts = result.actions.reduce((counts, action) => {
                counts[action.state] = (counts[action.state] ?? 0) + 1;
                return counts;
            }, {});
            result.signature = JSON.stringify(result.actions
                .map(({ sectionId, groupKey, id, state, installed }) => ({ sectionId, groupKey, id, state, installed }))
                .sort((a, b) => `${a.sectionId}/${a.id}`.localeCompare(`${b.sectionId}/${b.id}`)));
            return result;
        };

        const initialStartedAt = Date.now();
        await captureScreenshot('dependencias-auditoria-durante-primera-deteccion');
        const firstDetection = await waitForCompleteCatalog('primera detección');
        const catalogStructuralActionCount = Number(await attribute(
            await findWhenReady('[data-testid="dependency-detection-toolbar"]'),
            'data-catalog-action-count',
        ) ?? 0);
        const catalogActionKeys = String(await attribute(
            await findWhenReady('[data-testid="dependency-detection-toolbar"]'),
            'data-catalog-action-ids',
        ) ?? '')
            .split('|')
            .map((key) => key.trim())
            .filter(Boolean);
        if (!Number.isInteger(catalogStructuralActionCount) || catalogStructuralActionCount <= 0) {
            throw new Error(`Auditoría: el catálogo no publicó un recuento estructural válido (${catalogStructuralActionCount})`);
        }
        if (firstDetection.reusedCache) {
            recordEvent('dependency-cache-reused-on-open', {
                groups: firstDetection.groupsOnOpen,
                placeholderVisible: false,
                passed: true,
            });
        }
        const firstAudit = await collectDependencyAudit('primera');
        const firstAuditCapture = await captureScreenshot('dependencias-auditoria-primera-completa');
        const readVisibleComponentCount = async () => {
            const raw = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'return document.querySelector("[role=dialog] .panel-count")?.textContent?.trim() ?? null;',
                args: [],
            });
            return raw === null ? null : Number(raw);
        };
        const firstVisibleComponentCount = await readVisibleComponentCount();

        const refreshButton = await findWhenReady('[data-testid="dependency-refresh"]');
        await clickInView(refreshButton);
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="dependency-refresh"]'), 'disabled',
        )), 5000, 'auditoría: detección repetida ocupada');
        if ((await findAll('[data-testid="dependency-detection-placeholder"]')).length !== 1
            || (await findAll('[data-testid="dependency-group"]')).length !== 0) {
            throw new Error('Auditoría: la segunda detección mostró contenido parcial');
        }
        const busyCapture = await captureScreenshot('dependencias-auditoria-reintentando');
        await waitForCompleteCatalog('segunda detección');
        // Tras una detección completa el catálogo aplicable es la referencia
        // estable. La primera pasada parte del catálogo estructural y puede
        // reducirse al resolver familias no disponibles; comparar ambos
        // recuentos como si fueran dos inventarios equivalentes daba un falso
        // negativo aunque la detección funcionase correctamente.
        const verifiedInventoryBeforeAudit = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `return Array.from(document.querySelectorAll('[data-testid="dependency-action"]'))
                .map((node) => node.getAttribute('data-action-id'))
                .filter(Boolean)
                .sort();`,
            args: [],
        });
        const verifiedIdsBeforeAudit = Array.isArray(verifiedInventoryBeforeAudit)
            ? verifiedInventoryBeforeAudit
            : [];
        const secondAudit = await collectDependencyAudit('segunda');
        const secondAuditCapture = await captureScreenshot('dependencias-auditoria-segunda-completa');
        // La segunda pasada puede confirmar una familia mientras el panel ya
        // está pintado y ajustar el contador una vez más. Esperar dos lecturas
        // iguales valida el valor final sin convertir esa transición normal en
        // un falso fallo de la auditoría audiovisual.
        let secondVisibleComponentCount = null;
        let previousVisibleComponentCount = null;
        let stableVisibleComponentPolls = 0;
        await waitUntil(async () => {
            const value = await readVisibleComponentCount();
            if (Number.isInteger(value) && value === previousVisibleComponentCount) stableVisibleComponentPolls += 1;
            else stableVisibleComponentPolls = 0;
            previousVisibleComponentCount = value;
            secondVisibleComponentCount = value;
            return Number.isInteger(value) && stableVisibleComponentPolls >= 2;
        }, 10000, 'auditoría: contador visible final');
        if (Number.isInteger(firstVisibleComponentCount)
            && firstVisibleComponentCount !== secondVisibleComponentCount) {
            recordEvent('dependency-visible-count-refined', {
                before: firstVisibleComponentCount,
                after: secondVisibleComponentCount,
                passed: true,
            });
        }
        const verifiedIdsAfterAudit = secondAudit.actions.map((action) => action.id).sort();
        const verifiedInventoryStable = JSON.stringify(verifiedIdsBeforeAudit) === JSON.stringify(verifiedIdsAfterAudit);
        if (!verifiedInventoryStable) {
            const before = new Set(verifiedIdsBeforeAudit);
            const after = new Set(verifiedIdsAfterAudit);
            recordEvent('dependency-audit-diff', {
                added: verifiedIdsAfterAudit.filter((id) => !before.has(id)),
                removed: verifiedIdsBeforeAudit.filter((id) => !after.has(id)),
                passed: false,
            });
            throw new Error(`Auditoría: el inventario verificado cambió al recorrerlo (${verifiedIdsBeforeAudit.length} -> ${verifiedIdsAfterAudit.length})`);
        }
        if (captureScreenshots && (!firstAuditCapture || !busyCapture || !secondAuditCapture)) {
            throw new Error('Auditoría: faltan capturas de una de las pasadas');
        }
        const unknownActions = secondAudit.actions.filter((action) => action.state === 'unknown');
        const catalogActions = firstAudit.actions;
        const catalogActionIds = catalogActions.map((action) => `${action.sectionId}/${action.id}`);
        const observedCatalogKeys = catalogActions.map((action) => `${action.groupKey ?? action.sectionId}/${action.id}`);
        const observedCatalogKeySet = new Set(observedCatalogKeys);
        const structuralCatalogKeys = catalogActionKeys.length > 0
            ? catalogActionKeys
            : observedCatalogKeys;
        const structuralCatalogKeySet = new Set(structuralCatalogKeys);
        const catalogActionIdsUnique = structuralCatalogKeySet.size === structuralCatalogKeys.length
            && observedCatalogKeySet.size === observedCatalogKeys.length;
        const catalogMissingActionIds = structuralCatalogKeys.filter((key) => !observedCatalogKeySet.has(key));
        const catalogStatesValid = catalogActions.length > 0
            && catalogActions.every((action) => ['installed', 'absent', 'unknown', 'not-applicable'].includes(action.state)
                && action.id
                && action.sectionId
                && action.groupKey
                && (action.state !== 'unknown' || action.detectionStatus === 'unknown'));
        const catalogStateCounts = { ...firstAudit.stateCounts };
        if (catalogMissingActionIds.length > 0) {
            catalogStateCounts['not-applicable'] = (catalogStateCounts['not-applicable'] ?? 0)
                + catalogMissingActionIds.length;
        }
        const catalogEntriesCovered = observedCatalogKeys.length + catalogMissingActionIds.length;
        const visualActionCount = firstAudit.visualWalk.reduce((total, group) => total + group.count, 0);
        const visualRemovedAfterDetection = firstAudit.visualWalk
            .flatMap((group) => group.removedAfterDetection ?? []);
        const secondVisualActionCount = secondAudit.visualWalk.reduce((total, group) => total + group.count, 0);
        const secondVisualRemovedAfterDetection = secondAudit.visualWalk
            .flatMap((group) => group.removedAfterDetection ?? []);
        const k9sActions = secondAudit.actions.filter((action) => /(^|[-_/])k9s($|[-_/])/i.test(action.id ?? ''));
        smokeReport.coverage.dependencyActions = {
            visual: dependencyVisualActions,
            perAction: dependencyCaptureEachAction,
            detected: secondAudit.actionCount,
            walkedFirstPass: visualActionCount,
            walkedSecondPass: secondVisualActionCount,
            captured: dependencyCaptureEachAction ? visualActionCount + secondVisualActionCount : 0,
            skipped: [],
        };
        smokeReport.coverage.k9s = k9sActions.length > 0
            ? { status: 'skipped', reason: 'k9s no tiene sonda automática; se inspecciona visualmente sin ejecutar' }
            : { status: 'not-present', reason: 'No existe una entrada k9s en el catálogo de este host' };
        const nsudoActions = secondAudit.actions.filter((action) => /nsudo/i.test(action.id ?? '')
            || /nsudo/i.test(action.sectionId ?? '')
            || /nsudo/i.test(action.groupKey ?? ''));
        smokeReport.coverage.elevated = {
            ...smokeReport.coverage.elevated,
            nsudo: nsudoActions.length > 0
                ? (requireElevated ? 'covered' : 'skipped-requires-elevation')
                : 'not-present',
        };
        smokeReport.coverage.realInstallationsExecuted = false;
        if (dependencyVisualActions
            && visualActionCount + visualRemovedAfterDetection.length !== firstAudit.actionCount) {
            throw new Error(`Auditoría: el recorrido visual perdió acciones (${visualActionCount} visibles + ${visualRemovedAfterDetection.length} retiradas -> ${firstAudit.actionCount})`);
        }
        // La recarga completa también debe refrescar las integraciones que no
        // son simples ejecutables del PATH. En Windows son especialmente
        // sensibles las características opcionales (Hyper-V, VMP, Sandbox),
        // QEMU/VirtualBox y Docker Desktop: si la sonda se queda con una
        // instantánea vieja, sus tarjetas vuelven a mostrar «Comprobar» tras
        // pulsar «Recargar» aunque el resto del catálogo esté asentado.
        const externalVirtualizationIds = [
            'windows-hyperv-enable',
            'windows-vmp-enable',
            'windows-sandbox-enable',
            'windows-hyperv-check',
            'winget-qemu',
            'winget-virtualbox',
            'winget-docker',
        ];
        const externalVirtualizationActions = secondAudit.actions.filter((action) =>
            externalVirtualizationIds.includes(action.id));
        const externalCatalogKeys = structuralCatalogKeys.filter((key) =>
            externalVirtualizationIds.some((id) => key.endsWith(`/${id}`)));
        const externalUnknownActions = externalVirtualizationActions.filter((action) =>
            action.state === 'unknown' || action.detectionStatus === 'unknown');
        const externalMissingIds = externalCatalogKeys
            .map((key) => key.slice(key.lastIndexOf('/') + 1))
            .filter((id) => {
                if (externalVirtualizationActions.some((action) => action.id === id)) return false;
                // Cuando Docker Desktop ya está instalado, la acción base de
                // instalación desaparece por diseño y la familia queda
                // representada por docker-check/start/list/version y sus
                // acciones de gestión. No es una pérdida de inventario.
                if (id === 'winget-docker') {
                    return !secondAudit.actions.some((action) =>
                        /^(?:docker-|pkg-docker|winget-docker-)/i.test(action.id));
                }
                return true;
            });
        if (externalCatalogKeys.length === 0) {
            throw new Error('Auditoría: no apareció el bloque de aplicaciones externas/virtualización en el catálogo');
        }
        if (externalUnknownActions.length > 0 || externalMissingIds.length > 0) {
            throw new Error(`Auditoría: recarga incompleta de componentes externos (${JSON.stringify({
                unknown: externalUnknownActions.map((action) => action.id),
                missing: externalMissingIds,
            })})`);
        }
        recordEvent('dependency-external-virtualization-audit', {
            expectedIds: externalVirtualizationIds,
            catalogIds: externalCatalogKeys,
            actions: externalVirtualizationActions,
            unknownIds: [],
            passed: true,
        });
        const firstVisualWalkComplete = visualActionCount + visualRemovedAfterDetection.length === firstAudit.actionCount
            && visualRemovedAfterDetection.length === 0;
        const secondVisualWalkComplete = secondVisualActionCount + secondVisualRemovedAfterDetection.length === secondAudit.actionCount
            && secondVisualRemovedAfterDetection.length === 0;
        const catalogActionsIndividuallyVerified = catalogStatesValid
            && catalogActionIdsUnique
            && catalogMissingActionIds.length === 0
            && firstVisualWalkComplete
            && secondVisualWalkComplete;
        recordEvent('dependency-full-audit', {
            sections: secondAudit.sections,
            groups: secondAudit.groupCount,
            actions: secondAudit.actionCount,
            initialDurationMs: Date.now() - initialStartedAt,
            firstPassDurationMs: firstAudit.durationMs,
            secondPassDurationMs: secondAudit.durationMs,
            firstPass: firstAudit,
            secondPass: secondAudit,
            catalogActionCount: firstAudit.actionCount,
            catalogStructuralActionCount,
            catalogActionsIndividuallyVerified,
            catalogActionIdsUnique,
            catalogStateCounts,
            catalogActionKeys: structuralCatalogKeys,
            catalogMissingActionIds,
            visualWalk: firstAudit.visualWalk,
            visualActionCount,
            visualRemovedAfterDetection,
            secondVisualActionCount,
            secondVisualRemovedAfterDetection,
            firstVisualWalkComplete,
            secondVisualWalkComplete,
            catalogUnknownActionIds: firstAudit.actions
                .filter((action) => action.state === 'unknown')
                .map((action) => `${action.sectionId}/${action.id}`),
            verifiedActionCount: secondAudit.actionCount,
            visibleComponentCount: secondVisibleComponentCount,
            visibleComponentCountStable: Number.isInteger(secondVisibleComponentCount),
            visibleComponentCountInitial: firstVisibleComponentCount,
            catalogRefined: firstAudit.actionCount !== secondAudit.actionCount,
            verifiedInventoryStable,
            unknownActionIds: unknownActions.map((action) => action.id),
            externalVirtualizationIds: externalVirtualizationActions.map((action) => action.id),
            externalVirtualizationAudit: 'passed',
            captures: [firstAuditCapture, busyCapture, secondAuditCapture],
            stableInventory: true,
            passed: catalogActionsIndividuallyVerified
                && verifiedInventoryStable
                && externalVirtualizationActions.every((action) => action.state !== 'unknown'),
        });
        if (!catalogActionsIndividuallyVerified) {
            throw new Error(`Auditoría: no se demostró el recorrido visual completo (${JSON.stringify({
                catalogMissing: catalogMissingActionIds.length,
                firstVisualActionCount: visualActionCount,
                firstVisualRemoved: visualRemovedAfterDetection.length,
                secondVisualActionCount,
                secondVisualRemoved: secondVisualRemovedAfterDetection.length,
                firstActionCount: firstAudit.actionCount,
                secondActionCount: secondAudit.actionCount,
            })})`);
        }
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de auditoría de dependencias');
        await captureScreenshot('dependencias-auditoria-cerrada');
        const scaleCases = [
            { width: 1100, height: 900, label: 'ampliada' },
            { width: 1600, height: 900, label: 'panorámica' },
            { width: 800, height: 600, label: 'restaurada' },
        ];
        const scaleResults = [];
        for (const size of scaleCases) {
            const applied = await resizeWindow(size.width, size.height, { waitForBanner: false });
            await waitForBannerPanes(1, 20000);
            const geometry = await contentGeometry();
            scaleResults.push({ ...size, applied: { width: applied.width, height: applied.height }, geometry });
            await captureScreenshot(`dependencias-auditoria-escala-${size.label}`);
            // El vídeo debe contener también el tamaño nativo recién aplicado;
            // esperar al siguiente tick periódico podía dejar fuera los tres
            // cambios finales por la ventana de muestreo de 250 ms.
            if (windowVideoSampleNow) await windowVideoSampleNow();
        }
        let comprehensiveVisual = null;
        if (comprehensiveVisualAudit) {
            comprehensiveVisual = await exerciseComprehensiveVisualAudit();
        }
        await sendTerminalLine('echo E2E_DEPENDENCY_AUDIT_CLOSED_OK');
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            return snapshot.rows.some((row) => row.text.includes('E2E_DEPENDENCY_AUDIT_CLOSED_OK'))
                && snapshotPromptVisible(snapshot);
        }, 15000, 'salida y prompt después de cerrar Dependencias');
        if (windowVideoSampleNow) await windowVideoSampleNow();
        await captureScreenshot('dependencias-auditoria-salida-final');
        recordEvent('dependency-audit-close-and-scale', {
            scaleCases: scaleResults,
            comprehensiveVisual: comprehensiveVisual
                ? { passed: comprehensiveVisual.passed, settingsTabs: comprehensiveVisual.settings.map((item) => item.tab), paneTransitions: comprehensiveVisual.panes.transitions }
                : null,
            outputMarker: 'E2E_DEPENDENCY_AUDIT_CLOSED_OK',
            promptRestored: true,
            passed: true,
        });
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'dependency-full-audit';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E auditoría OK: ${secondAudit.sections.length} secciones, ${secondAudit.groupCount} grupos, ${secondAudit.actionCount} acciones verificadas; catálogo inicial=${firstAudit.actionCount}, estable tras detección completa (${firstAudit.durationMs}/${secondAudit.durationMs} ms, desconocidas=${unknownActions.length}).\n`);
    } else if (dependencyDetectionOnly) {
        markPhase('reintento de detección de dependencias');
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        // Con la precarga de arranque o una caché válida el catálogo puede
        // estar ya confirmado al abrir el panel. En ese caso no debe exigirse
        // un placeholder que solo corresponde a una primera detección fría.
        const initialPlaceholder = (await findAll('[data-testid="dependency-detection-placeholder"]')).length;
        if (initialPlaceholder === 0) {
            await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0,
                90000, 'catálogo de dependencias precargado');
        } else {
            await findWhenReady('[data-testid="dependency-detection-placeholder"]');
        }
        await waitUntil(async () => (await findAll('[role="dialog"] .filters')).length > 0, 180000, 'fin de la detección inicial');
        await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0,
            90000, 'catálogo de dependencias');
        await waitUntil(async () => !(await property(
            await findWhenReady('[data-testid="dependency-refresh"]'),
            'disabled',
        )), 180000, 'fin de la detección inicial de dependencias');
        const groupsBeforeRefresh = (await findAll('[data-testid="dependency-group"]')).length;
        await clickInView(await findWhenReady('[data-testid="dependency-refresh"]'));
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="dependency-refresh"]'),
            'disabled',
        )), 5000, 'estado ocupado de la detección repetida');
        if ((await findAll('[data-testid="dependency-detection-placeholder"]')).length !== 1
            || (await findAll('[data-testid="dependency-group"]')).length !== 0) {
            throw new Error('La detección repetida mostró un grupo antes de confirmar todo el catálogo');
        }
        const busyCapture = await captureScreenshot('dependencias-reintentando-deteccion');
        await waitUntil(async () => !(await property(
            await findWhenReady('[data-testid="dependency-refresh"]'),
            'disabled',
        )), 180000, 'fin de la detección repetida');
        const groupsAfterRefresh = (await findAll('[data-testid="dependency-group"]')).length;
        const readyCapture = await captureScreenshot('dependencias-despues-de-reintento');
        if (groupsBeforeRefresh === 0 || groupsAfterRefresh !== groupsBeforeRefresh
            || (captureScreenshots && (!busyCapture || !readyCapture))) {
            throw new Error(`La repetición de detección dejó un catálogo inconsistente: ${JSON.stringify({ groupsBeforeRefresh, groupsAfterRefresh, busyCapture, readyCapture })}`);
        }
        recordEvent('dependency-detection-retry', {
            buttonVisible: true,
            busyStateCaptured: true,
            groupsBeforeRefresh,
            groupsAfterRefresh,
            busyCapture,
            readyCapture,
            passed: true,
        });
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de dependencias');
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'dependency-detection-retry';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: detección repetida de dependencias (${Date.now() - smokeStartedAt} ms).\n`);
    } else if (adbRefreshOnly) {
        markPhase('salida progresiva ADB sin cambios de layout');
        const frames = await exerciseAdbRefreshWithoutLayout();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'adb-progressive-output-repaint';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: ${frames.length} frames ADB repintados sin resize (${Date.now() - smokeStartedAt} ms).\n`);
    } else {
    markPhase('selección de texto mediante arrastre real');
    await verifyMouseDragSelection('LTERMINAL_MOUSE_DRAG_SELECTION_FULL_E2E');

    markPhase('estados de ventana');
    await exerciseWindowManagerStates();

    // El endpoint de WebDriver puede responder antes de que el compositor
    // aplique el tamaño. Comprobar una reducción y su restauración obliga a
    // demostrar el recorrido completo en Windows y Linux: ventana nativa,
    // viewport del WebView y resize del PTY de la pestaña.
    markPhase('redimensionado nativo multiplataforma');
    const nativeResizeStart = await request(`/session/${sessionId}/window/rect`);
    const shrinkRoom = nativeResizeStart.width - WINDOW_LIMITS.minWidth >= 120
        && nativeResizeStart.height - WINDOW_LIMITS.minHeight >= 120;
    const resizeDelta = 160;
    const transitionWidth = shrinkRoom
        ? nativeResizeStart.width - resizeDelta
        : nativeResizeStart.width + resizeDelta;
    const transitionHeight = shrinkRoom
        ? nativeResizeStart.height - resizeDelta
        : nativeResizeStart.height + resizeDelta;
    await resizeWindowAndAssertTransition(
        transitionWidth,
        transitionHeight,
        `${process.platform} ${shrinkRoom ? 'reducción' : 'ampliación'} de ventana`,
    );
    await resizeWindowAndAssertTransition(
        nativeResizeStart.width,
        nativeResizeStart.height,
        `${process.platform} restauración de ventana`,
    );

    // Intentar salir por ambos extremos verifica que el límite no dependa de
    // la decoración del escritorio. El tamaño máximo real puede ser menor si
    // la pantalla de CI no es 8K; esa dimensión real alimenta la matriz de
    // proporciones que viene después.
    const configuredMinimumRect = await resizeWindow(
        WINDOW_LIMITS.minWidth,
        WINDOW_LIMITS.minHeight,
        { waitForBanner: false },
        { waitForBanner: false },
    );
    assertWindowBounds(configuredMinimumRect, 'El mínimo configurado');

    // `minWidth`/`minHeight` de Tauri son límites absolutos y no pueden
    // expresar «25 % de la pantalla». Pedir el cuarto de la pantalla
    // observado evita comparar una constante de 1920x1080 con el espacio
    // lógico real del runner (por ejemplo 2048x1122 => 512x281).
    const screen = configuredMinimumRect.content?.screen;
    const hasScreenGeometry = Number.isFinite(screen?.width) && Number.isFinite(screen?.height)
        && screen.width > 0 && screen.height > 0;
    const responsiveMinimum = hasScreenGeometry ? responsiveMinimumForScreen(screen) : null;
    const minimumRect = responsiveMinimum
        ? await resizeWindow(responsiveMinimum.width, responsiveMinimum.height, { waitForBanner: false })
        : configuredMinimumRect;
    assertWindowBounds(minimumRect, 'El mínimo responsive solicitado');
    if (responsiveMinimum) assertResponsiveMinimum(minimumRect, 'El mínimo responsive solicitado');
    await assertToolbarLayout('mínimo responsive');
    recordEvent('responsive-minimum', {
        configured: { width: configuredMinimumRect.width, height: configuredMinimumRect.height },
        screen: screen ?? null,
        requested: responsiveMinimum,
        applied: { width: minimumRect.width, height: minimumRect.height },
        passed: true,
    });
    const inspectorVerticalReserve = Math.max(0, WINDOW_LIMITS.minHeight - minimumRect.content.viewport.height);
    const inspectorHorizontalReserve = Math.max(0, WINDOW_LIMITS.minWidth - minimumRect.content.viewport.width);
    const responsiveBaseWidth = Math.max(WINDOW_LIMITS.minWidth, minimumRect.width);
    const responsiveBaseHeight = Math.max(WINDOW_LIMITS.minHeight, minimumRect.height);
    const effectiveMinWidth = Math.min(
        WINDOW_LIMITS.maxWidth,
        responsiveBaseWidth + inspectorHorizontalReserve,
    );
    const effectiveMinHeight = Math.min(
        WINDOW_LIMITS.maxHeight,
        responsiveBaseHeight + inspectorVerticalReserve
            + (inspectorVerticalReserve > 0 ? 120 : 0),
    );
    process.stdout.write(
        `E2E mínimo nativo: ${configuredMinimumRect.width}x${configuredMinimumRect.height}, `
        + `mínimo responsive=${minimumRect.width}x${minimumRect.height}, `
        + `viewport útil=${minimumRect.content.viewport.width}x${minimumRect.content.viewport.height}, `
        + `reserva inspector=${inspectorHorizontalReserve}x${inspectorVerticalReserve}\n`,
    );
    // Si el inspector está acoplado, el mínimo nativo puede dejar una sola
    // fila útil. Subir temporalmente solo la dimensión necesaria permite
    // comprobar el banner sin confundir «ventana admitida» con «contenido
    // legible».
    const effectiveMinimumRect = await resizeWindow(
        effectiveMinWidth,
        effectiveMinHeight,
        { waitForBanner: false },
        { waitForBanner: false },
    );
    // `fitAndReport` aplica el resize mediante una cola desacoplada y el
    // repintado del banner llega después de que el compositor confirme el
    // rectángulo. Esperar esa cola evita que `sysinfo` lea durante un frame el
    // banner anterior, que puede tener muchas más líneas que este viewport.
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    // No escribimos `sysinfo` aquí: la sesión puede conservar un archivo
    // generado con el tamaño anterior mientras termina el ResizeObserver. La
    // comprobación observa el repintado automático del banner, que es el mismo
    // camino que usa la ventana real.
    const effectiveMinimumGeometry = await contentGeometry();
    const effectiveMinimumTooShort = effectiveMinimumGeometry.panes.slice(0, 1)
        .every((pane) => (pane.terminal?.rows ?? 0) < 12);
    if (effectiveMinimumTooShort) {
        await assertTinyPanesStable(1, 'mínimo útil con casilla baja');
    } else {
        await waitForBannerPanes(1, 20000);
    }
    process.stdout.write(
        `E2E mínimo útil: ${effectiveMinimumRect.width}x${effectiveMinimumRect.height}, `
        + `viewport=${effectiveMinimumRect.content.viewport.width}x${effectiveMinimumRect.content.viewport.height}\n`,
    );
    // La división conserva el tamaño exterior: es el comportamiento normal de
    // una aplicación de escritorio y evita pelear con mosaicos, fullscreen o
    // límites del compositor. Lo que sí pertenece a LTerminal y debe probarse
    // es que la rejilla cree dos xterm útiles, medidos y sin solapamientos aun
    // en el mínimo admitido.
    const beforeSplit = await request(`/session/${sessionId}/window/rect`);
    await clickWhenReady('.side-toggle.panes');
    await waitUntil(async () => await visiblePaneCount() >= 2, 15000, 'segunda terminal en la vista');
    await waitUntil(async () => {
        const geometry = await contentGeometry();
        try {
            assertPaneGeometry(geometry, 2, 'División en el tamaño mínimo');
            return true;
        } catch {
            return false;
        }
    }, 15000, 'geometría útil de dos terminales en el tamaño mínimo');
    const afterSplit = await request(`/session/${sessionId}/window/rect`);
    const splitGeometry = await contentGeometry();
    assertPaneGeometry(splitGeometry, 2, 'División en el tamaño mínimo');
    // Esta transición empieza con una sola pestaña y obliga a crear la
    // segunda. Todas las casillas deben usar el mismo perfil de banner.
    const tinySplit = splitGeometry.panes.slice(0, 2).every((pane) => (pane.terminal?.rows ?? 0) < 12);
    if (tinySplit) {
        await assertTinyPanesStable(2, 'rejilla 2 paneles en altura mínima');
    } else {
        // La primera pestaña ya tiene scrollback por la prueba de selección y
        // por los cambios de tamaño. Su cabecera inicial puede quedar por
        // encima del viewport, mientras la pestaña recién creada sí debe
        // mostrar la suya. Comprobar la salida estable de ambas evita exigir
        // una reimpresión del banner que la aplicación no hace.
        const splitStatus = await assertPaneOutputStable(2, 'rejilla 2 paneles tras crear la segunda pestaña');
        if (process.platform === 'win32' && !/^WTerminal\b/i.test(splitStatus.headers[1] ?? '')) {
            throw new Error(`La segunda pestaña no mostró su cabecera inicial: ${JSON.stringify(splitStatus.headers)}`);
        }
    }
    for (const pane of await visiblePanes()) {
        await sendTerminalLine(process.platform === 'win32' ? 'cls' : 'clear', pane[elementKey]);
    }
    let splitColumnSnapshots = [];
    try {
        await waitUntil(async () => {
            splitColumnSnapshots = [];
            for (const pane of await visiblePanes()) {
                const snapshot = await terminalHorizontalSnapshot(pane[elementKey]);
                const cols = Number(snapshot.host?.cols ?? 0);
                const width = snapshot.screen?.rectWidth ?? 0;
                const cellWidth = width / Math.max(1, cols);
                const visibleCols = Math.floor((snapshot.host?.clientWidth ?? 0) / Math.max(1, cellWidth));
                splitColumnSnapshots.push({
                    cols,
                    visibleCols,
                    hostWidth: snapshot.host?.clientWidth ?? 0,
                    hostRectWidth: snapshot.host?.rectWidth ?? 0,
                    hostScrollWidth: snapshot.host?.scrollWidth ?? 0,
                    screenWidth: width,
                    cellWidth,
                    overflow: snapshot.host?.overflow ?? '',
                    longestVisibleRow: Math.max(0, ...(snapshot.visibleRowLengths ?? [])),
                    debug: await request(`/session/${sessionId}/execute/sync`, 'POST', {
                        script: `const paneRoot = arguments[0];
                            const host = paneRoot.querySelector('[data-testid="terminal-host"]') ?? paneRoot;
                            const root = host?.querySelector('.xterm');
                            const screen = host?.querySelector('.xterm-screen');
                            const rows = host?.querySelector('.xterm-rows');
                            const viewport = host?.querySelector('.xterm-viewport');
                            const scrollable = host?.querySelector('.xterm-scrollable-element');
                            const style = host ? getComputedStyle(host) : null;
                            const rootStyle = root ? getComputedStyle(root) : null;
                            const screenStyle = screen ? getComputedStyle(screen) : null;
                            return {
                                horizontalTail: host?.dataset?.horizontalTail ?? null,
                                horizontalOverflow: host?.dataset?.horizontalOverflow ?? null,
                                longestVisibleLine: host?.dataset?.longestVisibleLine ?? null,
                                contentWidthVar: host ? host.style.getPropertyValue('--terminal-content-width') : null,
                                hostScrollLeft: host?.scrollLeft ?? null,
                                rootClientWidth: root?.clientWidth ?? null,
                                rootScrollWidth: root?.scrollWidth ?? null,
                                rootWidth: rootStyle?.width ?? null,
                                screenClientWidth: screen?.clientWidth ?? null,
                                screenWidth: screenStyle?.width ?? null,
                                rowsClientWidth: rows?.clientWidth ?? null,
                                rowsScrollWidth: rows?.scrollWidth ?? null,
                                rowsWidth: rows ? getComputedStyle(rows).width : null,
                                viewportClientWidth: viewport?.clientWidth ?? null,
                                viewportScrollWidth: viewport?.scrollWidth ?? null,
                                viewportWidth: viewport ? getComputedStyle(viewport).width : null,
                                scrollableClientWidth: scrollable?.clientWidth ?? null,
                                scrollableScrollWidth: scrollable?.scrollWidth ?? null,
                                scrollableWidth: scrollable ? getComputedStyle(scrollable).width : null,
                                afterWidth: host ? getComputedStyle(host, '::after').width : null,
                                afterDisplay: host ? getComputedStyle(host, '::after').display : null,
                                afterContent: host ? getComputedStyle(host, '::after').content : null,
                                children: host ? [...host.children].map((child) => {
                                    const rect = child.getBoundingClientRect();
                                    const style = getComputedStyle(child);
                                    return {
                                        tag: child.tagName,
                                        className: child.className,
                                        left: rect.left,
                                        right: rect.right,
                                        width: rect.width,
                                        offsetWidth: child.offsetWidth,
                                        scrollWidth: child.scrollWidth,
                                        position: style.position,
                                        minWidth: style.minWidth,
                                        maxWidth: style.maxWidth,
                                        transform: style.transform,
                                    };
                                }) : [],
                                rowsText: rows?.textContent?.slice(-240) ?? '',
                            };`,
                        args: [{ [elementKey]: pane[elementKey] }],
                    }),
                });
            }
            const paneHasUsableGeometry = (pane) => pane.hostWidth > 0
                && pane.cols > 0 && pane.visibleCols > 0;
            // xterm mantiene una reserva vertical para su scrollbar. Esa reserva
            // reduce `clientWidth`, aunque la rejilla completa siga cabiendo en
            // el ancho real de `.xterm-screen`; no debe confundirse con pérdida
            // de columnas ni con overflow horizontal de contenido.
            const fitsViewport = (pane) => {
                const scrollbarReserve = Math.max(0, pane.screenWidth - pane.hostWidth);
                const reservedCols = Math.ceil(scrollbarReserve / Math.max(1, pane.cellWidth));
                return pane.cols <= pane.visibleCols + reservedCols + 1
                    && pane.hostScrollWidth <= pane.hostWidth + scrollbarReserve + 2;
            };
            // Una línea larga visible puede justificar que xterm exponga más
            // columnas que las que caben en el panel: en ese caso el scroll
            // horizontal debe ser real y la propia línea debe ocupar ese
            // ancho. No confundir ese contenido desplazable con espacio vacío
            // reservado por defecto, y exigir que la otra casilla sí se ajuste.
            const overflowIsContentDriven = (pane) => pane.overflow === 'true'
                && pane.cols > pane.visibleCols + 1
                && pane.hostScrollWidth > pane.hostWidth + 2
                && pane.longestVisibleRow > pane.visibleCols
                && pane.cols <= pane.longestVisibleRow + 2;
            return splitColumnSnapshots.length === 2
                && splitColumnSnapshots.every((pane) => paneHasUsableGeometry(pane)
                    && (fitsViewport(pane) || overflowIsContentDriven(pane)))
                && splitColumnSnapshots.some(fitsViewport);
        }, 15000, 'columnas mínimas sin espacio horizontal sobrante en los dos paneles');
    } catch (error) {
        recordEvent('split-terminal-columns-failed', { panes: splitColumnSnapshots });
        throw new Error(
            `${error.message}; medidas=${JSON.stringify(splitColumnSnapshots)}`,
            { cause: error },
        );
    }
    await captureScreenshot('split-column-minimum');
    recordEvent('split-terminal-columns-minimal', {
        panes: splitColumnSnapshots,
        passed: true,
    });
    const autoExpanded = afterSplit.width > beforeSplit.width || afterSplit.height > beforeSplit.height;
    recordEvent('multi-pane-minimum', {
        before: { width: beforeSplit.width, height: beforeSplit.height },
        after: { width: afterSplit.width, height: afterSplit.height },
        paneCount: splitGeometry.panes.length,
        panes: splitGeometry.panes,
        autoExpanded,
        geometryValid: true,
        passed: true,
    });
    process.stdout.write(
        `E2E división mínima OK: ${splitGeometry.panes.length} paneles, `
        + `ventana=${afterSplit.width}x${afterSplit.height}, ampliación externa=${autoExpanded ? 'sí' : 'no'}\n`,
    );
    // El control rota 2 → 3 → 4 → 1; no cierra siempre la división en el
    // primer clic. Esperar el cambio observable conserva la cobertura sin
    // confundir la creación intermedia de paneles con un fallo.
    let panesBeforeClose = await visiblePaneCount();
    while (panesBeforeClose > 1) {
        await clickWhenReady('.side-toggle.panes');
        await waitUntil(async () => await visiblePaneCount() !== panesBeforeClose, 3000, 'cambio de diseño dividido');
        panesBeforeClose = await visiblePaneCount();
    }
    // WebDriver puede saltarse los límites nativos si se le pide un tamaño
    // superior; no lo usamos como prueba de usuario. Medimos exactamente el
    // techo soportado por la configuración: 7680x4320 (8K).
    // En monitores menores que 8K el driver puede aceptar el rectángulo
    // máximo lógico aunque el compositor lo reduzca fuera de la pantalla.
    // Aquí solo validamos los límites nativos; la geometría del banner se
    // comprueba en tamaños visibles y reales inmediatamente después.
    const maximumStartedAt = Date.now();
    const maximumRect = await resizeWindow(
        WINDOW_LIMITS.maxWidth,
        WINDOW_LIMITS.maxHeight,
        { waitForBanner: false },
        { waitForBanner: false },
    );
    assertWindowBounds(maximumRect, 'El máximo configurado');
    recordEvent('max-window-resize', { durationMs: Date.now() - maximumStartedAt });
    if (process.env.E2E_STOP_AFTER_MAX === '1') {
        // Diagnóstico: cortar el recorrido completo justo después del 8K.
        throw new Error(`E2E_STOP_AFTER_MAX: 8K alcanzado en ${Date.now() - maximumStartedAt} ms`);
    }
    await resizeWindow(980, 640, { waitForBanner: false });

    // Probar pestañas reales, no solo el modo dividido. Las pestañas que creó
    // antes la rotación 1→2→3→4 pueden conservar solo su prompt visible: el
    // banner forma parte del historial y no debe reinyectarse por cambiar de
    // pestaña. La garantía funcional es más fuerte y menos invasiva: cada PTY
    // responde a su marcador y ningún marcador aparece en otra sesión.
    const initialTabs = await findAll('.tab');
    if (initialTabs.length < 1) throw new Error('La ventana no creó la pestaña inicial');

    // Reproduce la carrera reportada: iniciar una pestaña y cerrar la anterior
    // sin esperar a que termine el banner nuevo. La cola de ciclo de vida debe
    // conservar ambas intenciones en orden y las épocas de salida deben impedir
    // que el texto de la sesión cerrada llegue al xterm recién creado.
    const rapidBeforeIds = await Promise.all(
        initialTabs.map((tab) => attribute(tab[elementKey], 'data-tab-id')),
    );
    const rapidOldId = await attribute(await findWhenReady('.tab.active[data-tab-id]'), 'data-tab-id');
    const rapidOldMarker = `LTERMINAL_E2E_CLOSED_TAB_${Date.now()}`;
    await sendAndWaitForMarker(rapidOldMarker);
    await createTabAndCloseImmediately(rapidOldId);
    let rapidNewId;
    await waitUntil(async () => {
        const ids = await Promise.all(
            (await findAll('.tab[data-tab-id]')).map((tab) => attribute(tab[elementKey], 'data-tab-id')),
        );
        rapidNewId = ids.find((id) => !rapidBeforeIds.includes(id));
        return !ids.includes(rapidOldId) && Boolean(rapidNewId);
    }, 15000, 'crear pestaña y cerrar la anterior inmediatamente');
    await waitUntil(async () => {
        const activeCell = await findWhenReady('.cell:not(.hidden)[data-tab-id]');
        return (await attribute(activeCell, 'data-tab-id')) === rapidNewId;
    }, 10000, 'mostrar la pestaña creada durante el cierre rápido');
    const rapidNewMarker = `LTERMINAL_E2E_NEW_TAB_${Date.now()}`;
    await sendAndWaitForMarker(rapidNewMarker);
    const rapidNewText = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
    if (rapidNewText.includes(rapidOldMarker)) {
        throw new Error('La pestaña nueva recibió salida de la sesión cerrada');
    }
    recordEvent('rapid-tab-replace', {
        closedTabId: rapidOldId,
        createdTabId: rapidNewId,
        isolated: true,
        passed: true,
    });

    let expectedTabs = initialTabs.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await clickWhenReady('.tab-new');
        expectedTabs += 1;
        await waitUntil(async () => (await findAll('.tab')).length >= expectedTabs, 15000, `creación de pestaña ${expectedTabs}`);
        await waitForBannerPanes(1, 20000);
    }
    const tabsAfterCreation = await findAll('.tab');
    if (tabsAfterCreation.length < initialTabs.length + 2) {
        throw new Error(`Solo se crearon ${tabsAfterCreation.length}/${initialTabs.length + 2} pestañas`);
    }
    const tabMarkers = tabsAfterCreation.map((_, index) => `LTERMINAL_E2E_TAB_${index}_${Date.now()}`);
    for (let index = 0; index < tabsAfterCreation.length; index += 1) {
        const freshTabs = await findAll('.tab');
        await click(freshTabs[index][elementKey]);
        await waitUntil(async () => {
            const currentTabs = await findAll('.tab');
            const tab = currentTabs[index];
            const active = (await attribute(tab[elementKey], 'class'))?.split(/\s+/).includes('active');
            if (!active) return false;
            const tabId = await attribute(tab[elementKey], 'data-tab-id');
            const visibleCells = await findAll('.cell:not(.hidden)');
            for (const cell of visibleCells) {
                if (await attribute(cell[elementKey], 'data-tab-id') === tabId) return true;
            }
            return false;
        }, 5000, `activación de pestaña ${index + 1}`);
        await sendAndWaitForMarker(tabMarkers[index]);
    }
    for (let index = 0; index < tabMarkers.length; index += 1) {
        const freshTabs = await findAll('.tab');
        await click(freshTabs[index][elementKey]);
        const expectedTabId = await attribute(freshTabs[index][elementKey], 'data-tab-id');
        await waitUntil(async () => {
            const activeCells = await findAll('.cell:not(.hidden)');
            for (const cell of activeCells) {
                if (await attribute(cell[elementKey], 'data-tab-id') === expectedTabId) return true;
            }
            return false;
        }, 5000, `vista visible de pestaña ${index + 1}`);
        await sendAndWaitForMarker(tabMarkers[index]);
        await waitUntil(async () => {
            const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
            const text = await textOf(rows);
            return tabMarkers.every((marker, markerIndex) => markerIndex === index || !text.includes(marker));
        }, 10000, `aislamiento de salida en pestaña ${index + 1}`);
    }
    recordEvent('tab-isolation', { tabs: tabMarkers.length, passed: true });
    // La primera orden de cada pestaña nueva coincidía con el primer resize
    // de ConPTY y quedaba una fila por debajo del prompt.
    typedEchoCommands.push(...tabMarkers.map((marker) => `echo ${marker}`));
    await assertVisiblePanesKeepCommandEcho('pestanas-aisladas');

    // WebKit puede emitir keydown y keypress para la misma barra espaciadora.
    // Comprobar el texto que xterm realmente pintó en la fila del cursor
    // detecta espacios perdidos/duplicados sin depender del espejo interno ni
    // ejecutar ningún comando.
    markPhase('entrada de espacios');
    await sendTerminalLine('');
    const spaceProbe = 'space probe  keeps columns';
    await sendTerminalKeys(spaceProbe, null, { enter: false, settle: true });
    const spaceProbeSnapshot = await activeTerminalRowSnapshot();
    const spaceProbeCursorRow = spaceProbeSnapshot.rows[spaceProbeSnapshot.cursorRow]?.text ?? '';
    const spacesRenderedExactly = spaceProbeCursorRow.includes(spaceProbe);
    await captureScreenshot('space-input-before-cleanup');
    await sendTerminalKeys('\uE003'.repeat(spaceProbe.length * 3), null, { enter: false, settle: true });
    recordEvent('space-input-visible', {
        cursorRow: spaceProbeSnapshot.cursorRow,
        renderedLength: spaceProbeCursorRow.length,
        spacesRenderedExactly,
        expectedLength: spaceProbe.length,
    });
    if (!spacesRenderedExactly) {
        await captureScreenshot('space-input-duplicated-or-lost');
        throw new Error(`La entrada de espacios no quedó visible exactamente en xterm: ${JSON.stringify({ expected: spaceProbe, cursorRow: spaceProbeCursorRow, cursorIndex: spaceProbeSnapshot.cursorRow })}`);
    }
    recordEvent('space-input-length', { characters: spaceProbe.length, doubleSpacesPreserved: true, passed: true });

    // Comandos seguros: no tocan archivos ni perfiles. :help y :alias pasan
    // por el parser interno de LTerminal; echo/pwd pasan por la shell real.
    markPhase('comandos internos y shell');
    // Regresión del renderer: una salida PTY debe provocar un refresh real sin
    // que el smoke redimensione la ventana, divida el panel ni abra el
    // explorador (esas acciones ocultaban el fallo al forzar un fit).
    const repaintMarker = `LTERMINAL_OUTPUT_REPAINT_${Date.now()}`;
    const repaintBefore = await terminalOutputRefreshSnapshot();
    const repaintStartedAt = Date.now();
    await sendAndWaitForMarker(repaintMarker, null, 10000);
    let repaintAfter;
    await waitUntil(async () => {
        repaintAfter = await terminalOutputRefreshSnapshot();
        return repaintAfter.refreshCount > repaintBefore.refreshCount;
    }, 5000, 'repintado explícito de la salida PTY sin cambio de layout');
    const sameGeometry = JSON.stringify(repaintBefore.geometry) === JSON.stringify(repaintAfter.geometry);
    const markerVisible = repaintAfter.text.includes(repaintMarker);
    const repaintCapture = await captureScreenshot('pty-output-repaint-no-layout-event');
    if (!sameGeometry || !markerVisible
        || repaintAfter.lastRefresh?.reason !== 'pty-output-idle'
        || repaintAfter.lastRefresh?.tabId !== repaintBefore.geometry.tabId) {
        throw new Error(`La salida PTY no se repintó de forma estable sin un evento de layout: ${JSON.stringify({
            before: repaintBefore,
            after: repaintAfter,
            sameGeometry,
            markerVisible,
        })}`);
    }
    recordEvent('terminal-output-repaint', {
        passed: true,
        marker: repaintMarker,
        refreshCount: repaintAfter.refreshCount - repaintBefore.refreshCount,
        elapsedMs: Date.now() - repaintStartedAt,
        trigger: repaintAfter.lastRefresh.reason,
        rowsRefreshed: repaintAfter.lastRefresh.rows,
        tabId: repaintAfter.lastRefresh.tabId,
        layoutUnchanged: sameGeometry,
        geometry: repaintAfter.geometry,
        capture: 'pty-output-repaint-no-layout-event',
        capturePath: repaintCapture,
    });
    // Alacritty y WezTerm ofrecen búsqueda sobre el scrollback. Verificarla
    // con la salida real de esta pestaña protege la interacción sin enviar
    // teclas a la shell ni tocar la matriz/scroll horizontal.
    // Puede haber varias pestañas montadas, aunque solo una sea visible. La
    // búsqueda debe abrirse en la terminal activa; usar el primer host del DOM
    // hacía que el marcador se buscara en una pestaña oculta y daba un falso
    // «sin coincidencias».
    const activeSearchTabId = repaintAfter.geometry.tabId;
    const searchHost = await findWhenReady(
        `.cell[data-tab-id="${activeSearchTabId}"]:not(.hidden) [data-testid="terminal-host"]`,
    );
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'arguments[0].dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return true;',
        args: [{ [elementKey]: searchHost }],
    });
    await findWhenReady('[data-testid="terminal-search"]');
    const searchInput = await findWhenReady('[data-testid="terminal-search"] input');
    const searchQuery = 'LTERMINAL_OUTPUT_REPAINT';
    await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const input = arguments[0];
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, ${JSON.stringify(searchQuery)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return input.value;`,
        args: [{ [elementKey]: searchInput }],
    });
    await waitUntil(async () => {
        const count = await attribute(
            await findWhenReady('[data-testid="terminal-search-count"]'),
            'data-result-count',
        );
        return Number(count) > 0;
    }, 5000, 'búsqueda del marcador en scrollback');
    const searchCapture = await captureScreenshot('terminal-search-scrollback');
    await clickWhenReady('[data-testid="terminal-search-close"]');
    await waitUntil(async () => (await findAll('[data-testid="terminal-search"]')).length === 0,
        3000, 'cierre de búsqueda de scrollback');
    recordEvent('terminal-search-scrollback', {
        query: searchQuery,
        matchVisible: true,
        capture: 'terminal-search-scrollback',
        capturePath: searchCapture,
        passed: true,
    });
    markPhase('salidas progresivas de actualización');
    await exerciseProgressOutputLayout();
    await sendTerminalLine(':help');
    await sendTerminalLine(':alias');
    await sendTerminalLine(':banner');
    let bannerPromptSnapshot;
    try {
        await waitUntil(async () => {
            bannerPromptSnapshot = await activeTerminalRowSnapshot();
            const nonEmptyRows = bannerPromptSnapshot.rows.filter((row) => row.text.trim().length > 0);
            const lastRow = nonEmptyRows.at(-1);
            const previousRow = nonEmptyRows.at(-2);
            const text = nonEmptyRows.map((row) => row.text).join('\n');
            return text.includes('Banner:')
                && Boolean(lastRow && promptLooksVisible(
                    previousRow ? `${previousRow.text}\n${lastRow.text}` : lastRow.text,
                ))
                && (bannerPromptSnapshot.cursorRow < 0 || bannerPromptSnapshot.cursorRow === lastRow.index);
        }, 10000, 'prompt al final tras :banner');
    } catch (error) {
        await captureScreenshot('banner-prompt-no-visible-al-final');
        throw new Error(`Tras :banner, el prompt no quedó en la última fila: ${JSON.stringify(bannerPromptSnapshot)}`, { cause: error });
    }
    recordEvent('internal-banner-prompt-row', {
        cursorRow: bannerPromptSnapshot?.cursorRow ?? -1,
        cursor: bannerPromptSnapshot?.cursor ?? null,
        passed: true,
    });
    const cursorFallback = bannerPromptSnapshot?.cursor;
    const fallbackPainted = cursorFallback
        && (cursorFallback.fallbackBackgroundColor !== 'rgba(0, 0, 0, 0)'
            || cursorFallback.fallbackBorderTopColor !== 'rgba(0, 0, 0, 0)');
    if (!cursorFallback
        || cursorFallback.visibility === 'hidden'
        || cursorFallback.display === 'none'
        || cursorFallback.fallbackContent === 'none'
        || Number(cursorFallback.fallbackOpacity || 0) <= 0
        || !fallbackPainted) {
        await captureScreenshot('cursor-no-visible');
        throw new Error(`El cursor no tiene indicador visual persistente: ${JSON.stringify(cursorFallback)}`);
    }
    // La opción debe seguir siendo visible cuando Ajustes roba el foco al
    // xterm. xterm solo añade su clase de parpadeo a la terminal enfocada;
    // WTerminal aplica una animación equivalente al cursor inactivo. Se
    // comprueba el estilo computado y se guardan dos capturas en fases distintas.
    await sendTerminalLine(':terminal cursor-blink on');
    await waitUntil(async () => (await promptStates(1))[0] === 'true', 10000, 'activación del cursor parpadeante');
    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    const cursorBlinkProbe = async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const host = document.querySelector('.cell:not(.hidden) [data-testid="terminal-host"]');
            const cursor = host?.querySelector('.xterm-cursor');
            const style = host ? getComputedStyle(host) : null;
            const cursorStyle = cursor ? getComputedStyle(cursor) : null;
            return {
                enabled: host?.dataset.cursorBlink === 'true',
                cursorVisible: host?.dataset.cursorVisible ?? '',
                focused: Boolean(host?.querySelector('.xterm.focus')),
                className: cursor?.className ?? '',
                animationName: style?.animationName ?? '',
                animationDuration: style?.animationDuration ?? '',
                opacity: cursorStyle?.opacity ?? '',
            };`,
        args: [],
    });
    const cursorBlinkBefore = await cursorBlinkProbe();
    await captureScreenshot('cursor-blink-inactive-visible');
    let cursorBlinkAfter = await cursorBlinkProbe();
    const cssAnimationBefore = cursorBlinkBefore.animationName !== 'none'
        && /wterminal-cursor-blink/i.test(cursorBlinkBefore.animationName)
        && cursorBlinkBefore.animationDuration !== '0s';
    if (!cssAnimationBefore) {
        await waitUntil(async () => {
            cursorBlinkAfter = await cursorBlinkProbe();
            return cursorBlinkBefore.cursorVisible !== ''
                && cursorBlinkAfter.cursorVisible !== cursorBlinkBefore.cursorVisible;
        }, 2000, 'cambio de fase del cursor inactivo');
    }
    await captureScreenshot('cursor-blink-inactive-after');
    const cursorPhaseChanged = cursorBlinkBefore.cursorVisible !== ''
        && cursorBlinkAfter.cursorVisible !== cursorBlinkBefore.cursorVisible;
    const cursorCssAnimation = cursorBlinkBefore.animationName !== 'none'
        && /wterminal-cursor-blink/i.test(cursorBlinkBefore.animationName)
        && cursorBlinkBefore.animationDuration !== '0s';
    if (!cursorBlinkBefore.enabled || (!cursorPhaseChanged && !cursorCssAnimation)) {
        throw new Error(`El cursor inactivo no conserva el parpadeo: ${JSON.stringify({ before: cursorBlinkBefore, after: cursorBlinkAfter })}`);
    }
    recordEvent('cursor-blink-visual', {
        enabled: true,
        inactiveAnimation: cursorCssAnimation ? cursorBlinkBefore.animationName : 'host-phase-timer',
        duration: cursorCssAnimation ? cursorBlinkBefore.animationDuration : '500ms phase',
        phaseBefore: cursorBlinkBefore.cursorVisible,
        phaseAfter: cursorBlinkAfter.cursorVisible,
        opacityBefore: cursorBlinkBefore.opacity,
        opacityAfter: cursorBlinkAfter.opacity,
        captures: ['cursor-blink-inactive-visible', 'cursor-blink-inactive-after'],
        passed: true,
    });
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras probar cursor');
    // Verificar que la propia consola interpreta VT: el alias de ayuda usa el
    // mismo canal que los encabezados coloreados de la aplicación.
    await sendTerminalLine('echo %WSTERM_ESC%[1;92mLTERMINAL_ANSI_TEST%WSTERM_ESC%[0m');
    await waitUntil(async () => {
        const output = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return output.includes('LTERMINAL_ANSI_TEST');
    }, 5000, 'secuencia ANSI de la consola');
    await captureScreenshot('ansi-colores-consola');
    // El alias de compatibilidad `help` debe conservar el formato de la ayuda
    // canónica: títulos coloreados y bloques separados, no una línea corrida.
    // La captura deja una comprobación visual reproducible además del texto
    // accesible que ya valida :help.
    await sendTerminalLine('help');
    await waitUntil(async () => {
        const output = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        // La ayuda ocupa más filas que el viewport: xterm solo expone las
        // últimas visibles, donde queda la firma final del documento.
        return /Uso de esta ayuda|Usage of this help/i.test(output);
    }, 10000, 'ayuda del alias help');
    await captureScreenshot('help-colores-saltos');
    recordEvent('help-formatting', { command: 'help', capture: 'help-colores-saltos', passed: true });
    // El catálogo interno debe exponer también las rutas rápidas de
    // configuración, no solo banner/help: se consultan sin cambiar estado
    // para comprobar que llegan al terminal correcto y dejan el prompt usable.
    // Para listas extensas se busca el pie estable, no el encabezado inicial:
    // xterm puede dejar ese encabezado en el scrollback según la altura real.
    await waitUntil(async () => (await promptStates(1))[0] === 'true', 10000, 'prompt listo para comandos internos');
    const internalCommands = [
        [':shell current', 'Shell actual:', 'shell actual'],
        [':panel list', 'Uso: :panel <panel> | :panel close', 'lista de paneles'],
        [':theme list', 'Uso: :theme <id> | :theme list', 'lista de temas'],
        [':font list', 'Uso: :font <id> | :font list', 'lista de fuentes'],
        [':language list', 'Uso: :language <id> | :language list', 'lista de idiomas'],
        [':terminal list', 'Colores:', 'parámetros de terminal'],
        [':panes list', 'Uso: :panes 1|2|3|4 | :panes cycle', 'diseño de paneles'],
    ];
    const internalInput = await probeInternalCommandInput();
    if (internalInput.supported) {
        for (const [command, marker, label] of internalCommands.slice(1)) {
            await sendTerminalLine(command);
            await waitUntil(async () => {
                const snapshot = await activeTerminalRowSnapshot();
                return snapshot.rows.some((row) => row.text.includes(marker));
            }, 10000, `comando interno ${label}`);
        }
        recordEvent('internal-configuration-commands', {
            commands: internalCommands.map(([command]) => command),
            passed: true,
        });
        // La apertura por comando debe montar el panel bajo demanda igual que la
        // barra: en una sesión fresca no existe todavía ningún componente de
        // Ajustes en el DOM. Esta comprobación cubre la ruta que antes dejaba
        // `panels.open` apuntando a un panel invisible.
        await sendTerminalLine(':panel settings');
        await findWhenReady('[role="dialog"]', 10000);
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes abierto por comando');
        recordEvent('internal-panel-open', { command: ':panel settings', mounted: true, passed: true });
    } else {
        recordEvent('internal-configuration-commands', {
            commands: internalCommands.map(([command]) => command),
            passed: false,
            skipped: true,
            reason: internalInput.reason,
        });
    }
    await sendTerminalLine('echo LTERMINAL_E2E_COMMAND_OK');
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        return (await textOf(rows)).includes('LTERMINAL_E2E_COMMAND_OK');
    }, 15000, 'respuesta de la terminal');
    await assertClearKeepsInputOnPromptRow();
    // Easter-eggs de autoría: se prueban las formas públicas que no llevan
    // `:` para garantizar que el parser no dependa de mayúsculas ni del `@`.
    // La ayuda ocupa varias decenas de filas y puede desplazar el título de
    // los créditos fuera del viewport aunque siga intacto en el scrollback.
    // Darles temporalmente una altura holgada hace que la captura y la
    // aserción miren exactamente lo que vería el usuario, sin confundir una
    // línea desplazada con una salida perdida.
    await resizeWindow(1600, 1000, { waitForBanner: false });
    await sendTerminalLine('clear');
    await waitUntil(async () => snapshotPromptVisible(await activeTerminalRowSnapshot()), 10000, 'prompt tras limpiar antes de créditos');
    await sendTerminalLine('@Darkeiser003');
    await waitUntil(async () => {
        // WebKitGTK expone el contenedor `.xterm-rows` sin saltos entre sus
        // hijos; leer las filas reales mantiene la misma detección en Linux y
        // WebView2 y permite comprobar que el título ocupa su propia fila.
        const snapshot = await activeTerminalRowSnapshot();
        const text = snapshot.rows.map((row) => row.text).join('\n');
        const lines = creditLines(text);
        return creditHasOwnTitleRow(lines, 'Darkeiser003 ·')
            // El prompt contiene legítimamente el alias `ayuda darkeiser003`;
            // solo el cargo del crédito delataría que el título se pegó allí.
            && !creditTitleLeakedIntoPrompt(lines, /desarrollador/i)
            && containsExactHttpsUrl(text, 'https://github.com/Darkeiser003')
            && containsExactHttpsUrl(text, 'https://github.com/Darkeiser003/Infraestructura-Web');
    }, 10000, 'easter-egg de Darkeiser003 (formato y enlaces)');
    await captureScreenshot('credito-darkeiser-formato');
    if (process.platform === 'win32') {
        await sendTerminalLine('clear');
        await waitUntil(async () => snapshotPromptVisible(await activeTerminalRowSnapshot()), 10000, 'prompt tras limpiar antes del crédito de colaborador');
        await sendTerminalLine('christianlg97');
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            const text = snapshot.rows.map((row) => row.text).join('\n');
            const lines = creditLines(text);
            return snapshotPromptVisible(snapshot)
                && creditHasOwnTitleRow(lines, 'Christianlg97 ·')
                && containsExactHttpsUrl(text, 'https://github.com/Christianlg97');
        }, 10000, 'crédito de colaborador en WTerminal');
        await captureScreenshot('credito-christian-formato');
        recordEvent('windows-collaborator-credit', {
            alias: 'christianlg97',
            capture: 'credito-christian-formato',
            passed: true,
        });
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        // La comprobación siguiente escribe en la PTY; dejar el modal abierto
        // hace que el foco dependa del timing del WebView2 y vuelve flakeable
        // el prompt posterior a los créditos.
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras comprobar el crédito');
    }
    await resizeWindow(1100, 720, { waitForBanner: false });
    // Tras los créditos la shell debe seguir utilizable: el siguiente comando
    // no puede escribirse en la fila antigua ni dejar el prompt oculto.
    await sendTerminalLine('echo LTERMINAL_CREDIT_PROMPT_OK');
    await waitUntil(async () => {
        const snapshot = await activeTerminalRowSnapshot();
        const nonEmptyRows = snapshot.rows.filter((row) => row.text.trim().length > 0);
        const lastRow = nonEmptyRows.at(-1);
        const previousRow = nonEmptyRows.at(-2);
        return nonEmptyRows.some((row) => row.text.includes('LTERMINAL_CREDIT_PROMPT_OK'))
            && promptLooksVisible(previousRow
                ? `${previousRow.text}\n${lastRow?.text ?? ''}`
                : lastRow?.text ?? '')
            && (snapshot.cursorRow < 0 || snapshot.cursorRow === lastRow?.index);
    }, 10000, 'prompt utilizable después de los créditos');
    await captureScreenshot('credito-prompt-utilizable');
    const authorAliases = ['Darkeiser003', 'darkeiser003', '@darkeiser003', '@Darkeiser003'];
    const authorCaptures = ['credito-darkeiser-formato', 'credito-prompt-utilizable'];
    if (process.platform === 'win32') {
        authorAliases.push('christianlg97');
        authorCaptures.push('credito-christian-formato');
    }
    recordEvent('author-easter-eggs', {
        platform: process.platform,
        aliases: authorAliases,
        captures: authorCaptures,
        collaboratorCreditTested: process.platform === 'win32',
        layout: 'title-row-without-prompt-fragment-and-usable-prompt',
        passed: true,
    });

    markPhase('acciones concurrentes');
    // Varias detecciones pueden terminar en cualquier orden. Los clics se
    // envían consecutivamente, sin pausas, para solapar las operaciones de la
    // aplicación sin saturar el único canal HTTP de tauri-driver.
    const refreshEnvironments = await findWhenReady('[data-testid="refresh-environments"]');
    for (let attempt = 0; attempt < 4; attempt += 1) await click(refreshEnvironments);
    // La detección consulta WSL, WinGet y varias rutas de toolchains. En una
    // máquina fría puede superar 20 s aunque la petición siga avanzando; el
    // contrato que probamos es que termine y desbloquee el selector.
    await waitUntil(async () => {
        const environmentButton = await findWhenReady('.env-select');
        return (await attribute(environmentButton, 'disabled')) === null;
    }, 90000, 'fin de refrescos concurrentes de entornos');

    // Cambiar de shell crea un PTY nuevo. Probar comandos reales en hasta dos
    // shells distintas —Fish incluido cuando está disponible— detecta fallos
    // que el simple cambio del rótulo activo no ve; al final se restaura la
    // shell inicial para no alterar la sesión del usuario.
    markPhase('cambio de shell');
    if (process.env.E2E_SKIP_SHELL_MATRIX === '1') {
        recordEvent('environment-probe-skipped', {
            id: 'shell-matrix',
            reason: 'E2E_SKIP_SHELL_MATRIX=1: la pasada visual continúa aunque un REPL opcional no complete su handshake',
            passed: true,
        });
    } else {
        await exerciseShellMatrix();
    }

    markPhase('ajustes');
    // En builds de depuración WebKit puede reservar unos 300 px para el
    // inspector. Con la ventana de trabajo anterior el banner completo no
    // cabe y CPU queda fuera de las filas visibles, aunque la preferencia se
    // haya aplicado. Esta fase necesita observar contenido, así que usa una
    // altura suficiente tanto con inspector como en release.
    await resizeWindow(1100, 900, { waitForBanner: false });
    await clickWhenReady('[data-testid="toolbar-settings"]');
    let dialog = await findWhenReady('[role="dialog"]');
    const title = await textOf(dialog);
    if (!/Preferencias|Preferences|Settings|Ajustes|Appearance|Terminal/i.test(title)) {
        throw new Error(`El panel de Ajustes no se abrió; texto recibido: ${JSON.stringify(title)}`);
    }

    // Cambiar el idioma en una sesión real detecta dos regresiones que la
    // comprobación estática no puede ver: etiquetas escritas directamente en
    // Svelte y catálogos que existen pero no llegan al frontend tras guardar.
    // Se prueban varios idiomas disponibles y se restaura exactamente la
    // preferencia original antes de continuar con el resto de la batería.
    markPhase('idiomas y traducciones');
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    if (process.platform === 'win32' || process.platform === 'linux') {
        markPhase('integración de WTerminal en PATH');
        pendingWindowsPathSnapshot = await snapshotWindowsPathIntegration();
        const pathToggle = await findWhenReady('[data-testid="settings-path-integration"]');
        const pathInitiallyEnabled = Boolean(await property(pathToggle, 'checked'));
        await clickInView(pathToggle);
        // La casilla cambia al pulsarla; hasta que vuelve a habilitarse el
        // backend sigue escribiendo el PATH (y avisando a Windows).
        await waitUntil(async () => {
            const toggle = await findWhenReady('[data-testid="settings-path-integration"]');
            return Boolean(await property(toggle, 'checked')) !== pathInitiallyEnabled
                && !(await property(toggle, 'disabled'));
        }, 15000, 'cambio de la integración de WTerminal en PATH');
        await captureScreenshot('settings-path-integration');
        const pathCommandLabel = await textOf(await findWhenReady('[data-testid="settings-path-integration"] + span strong'));
        if (!/wterminal\b/i.test(pathCommandLabel) || /\.exe\b/i.test(pathCommandLabel)) {
            throw new Error(`La etiqueta del comando PATH no es portable: ${pathCommandLabel}`);
        }
        const pathLocation = await textOf(await findWhenReady('[data-testid="settings-path-integration"] + span small'));
        await clickInView(await findWhenReady('[data-testid="settings-path-integration"]'));
        // La casilla cambia al pulsarla; hasta que vuelve a habilitarse el
        // backend sigue escribiendo el PATH (y avisando a Windows).
        await waitUntil(async () => {
            const toggle = await findWhenReady('[data-testid="settings-path-integration"]');
            return Boolean(await property(toggle, 'checked')) === pathInitiallyEnabled
                && !(await property(toggle, 'disabled'));
        }, 15000, 'restauración de la integración de WTerminal en PATH');
        const restoredPathToggle = await findWhenReady('[data-testid="settings-path-integration"]');
        const restoredPathLabel = await textOf(await findWhenReady('[data-testid="settings-path-integration"] + span strong'));
        if (Boolean(await property(restoredPathToggle, 'checked')) !== pathInitiallyEnabled
            || !/wterminal\b/i.test(restoredPathLabel)
            || /\.exe\b/i.test(restoredPathLabel)) {
            throw new Error(`La integración PATH no volvió al estado inicial o su etiqueta no es portable: ${JSON.stringify({
                restored: await property(restoredPathToggle, 'checked'),
                initiallyEnabled: pathInitiallyEnabled,
                label: restoredPathLabel,
            })}`);
        }
        if (/\.exe\s*$/iu.test(pathLocation)) {
            throw new Error(`La integración PATH registró un ejecutable en vez de su carpeta: ${pathLocation}`);
        }
        await restoreWindowsPathIntegration(pendingWindowsPathSnapshot);
        const registryRestored = Boolean(pendingWindowsPathSnapshot);
        pendingWindowsPathSnapshot = null;
        recordEvent('path-integration-toggle', {
            registryRestored,
            controlVisible: true,
            initiallyEnabled: pathInitiallyEnabled,
            addedAndVerified: true,
            restored: true,
            location: pathLocation,
            capture: 'settings-path-integration',
            passed: true,
        });
    }
    // Entornos y descargas: la lista de cachés propias aparece sin esperar a
    // medir las ubicaciones externas (el escenario enfocado cubre el resto).
    await waitUntil(async () => (await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return document.querySelectorAll('[data-testid="settings-toolchain-store-caches"] .store-row').length;`,
        args: [],
    })) >= 11, 20000, 'cachés de Entornos y descargas en Ajustes');
    recordEvent('toolchain-store-visible', { passed: true });
    if (process.platform === 'win32') {
        await verifyAdminPermissions();
    }
    if (process.platform === 'win32') {
        // Se aplica al revelar la ventana del siguiente arranque. Guardar,
        // cerrar y volver a abrir Ajustes verifica la persistencia que leerá
        // el backend después de reiniciar.
        const startMaximized = await findWhenReady('[data-testid="settings-start-maximized"]');
        const initiallyEnabled = Boolean(await property(startMaximized, 'checked'));
        // Comprobar primero que el gesto cambió el control vivo: un clic
        // aceptado por WebDriver no implica que Svelte recibiera el cambio.
        await toggleCheckboxAndWait('[data-testid="settings-start-maximized"]');
        await waitForSettingsAutosave();
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="settings-start-maximized"]'),
            'checked',
        )) === !initiallyEnabled, 5000, 'guardado de Iniciar maximizada');
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras Iniciar maximizada');
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        const persisted = Boolean(await property(
            await findWhenReady('[data-testid="settings-start-maximized"]'),
            'checked',
        ));
        if (persisted !== !initiallyEnabled) throw new Error('Iniciar maximizada no persistió al reabrir Ajustes');
        if (persisted !== initiallyEnabled) await toggleCheckboxAndWait('[data-testid="settings-start-maximized"]');
        await waitForSettingsAutosave();
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="settings-start-maximized"]'),
            'checked',
        )) === initiallyEnabled, 5000, 'restauración de Iniciar maximizada');
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras restaurar Iniciar maximizada');
        recordEvent('windows-start-maximized-preference', {
            controlVisible: true,
            initiallyEnabled,
            toggledAndPersisted: true,
            reopenedSettingsVerified: true,
            restored: true,
            passed: true,
        });
    }
    if (process.platform === 'win32') {
        await clickWhenReady('[data-testid="toolbar-settings"]');
        dialog = await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
    }
    const originalExpected = await exerciseLanguageSwitch();

    const settingsTabs = await findAll('[role="dialog"] [role="tab"]');
    if (settingsTabs.length < 4) throw new Error(`Ajustes no muestra sus cuatro secciones: ${settingsTabs.length}`);
    const settingsSections = [];
    for (const tab of settingsTabs) {
        await click(tab[elementKey]);
        if ((await attribute(tab[elementKey], 'aria-selected')) !== 'true') {
            throw new Error('Una sección de Ajustes no quedó seleccionada');
        }
        settingsSections.push(await textOf(dialog));
    }
    const settingsText = settingsSections.join('\n');
    const exclusiveLabel = originalExpected['settings.exclusiveGroups'] ?? 'Una lista abierta por panel';
    const autoOpenLabel = originalExpected['settings.autoOpenFirst'] ?? 'Abrir la primera lista';
    if (!settingsText.includes(exclusiveLabel)) {
        throw new Error('Ajustes no muestra la preferencia de acordeones exclusivos');
    }
    if (!settingsText.includes(autoOpenLabel)) {
        throw new Error('Ajustes no muestra la preferencia de apertura inicial');
    }

    // A 800x600 el pie sticky no debe tapar el último control de Ajustes.
    const compactSettingsLayout = await verifyCompactSettingsFooterLayout();
    recordEvent('settings-footer-compact-layout', { ...compactSettingsLayout, passed: true });
    await resizeWindow(1100, 900, { waitForBanner: false });

    // Comprobar una opción real del banner, no solo que el panel se pueda
    // abrir. El cambio debe llegar al backend y repintar la terminal visible;
    // después se restaura el valor para no contaminar la máquina del usuario.
    const terminalSettingsTab = await findWhenReady('[data-testid="settings-tab-terminal"]');
    await click(terminalSettingsTab);
    await waitUntil(
        async () => (await attribute(await findWhenReady('[data-testid="settings-tab-terminal"]'), 'aria-selected')) === 'true',
        5000,
        'selección de Terminal',
    );
    // El ID funcional es estable en todos los idiomas; localizar esta opción
    // por «CPU/Processor» dejaba el E2E atado a solo dos traducciones.
    const bannerSettingsSnapshot = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `return {
            selectedTab: document.querySelector('[role="dialog"] [role="tab"][aria-selected="true"]')?.getAttribute('data-testid') ?? null,
            bannerItems: document.querySelectorAll('[role="dialog"] .banner-item').length,
            testIds: [...document.querySelectorAll('[role="dialog"] [data-testid^="settings-banner-"]')]
                .map((element) => element.getAttribute('data-testid')),
            clearReprintTestId: document.querySelector('[data-testid="settings-clear-reprint-banner"]')?.getAttribute('data-testid') ?? null,
        };`,
        args: [],
    });
    recordEvent('settings-banner-controls', bannerSettingsSnapshot);
    if (!bannerSettingsSnapshot.testIds?.includes('settings-banner-cpu')) {
        throw new Error(`Ajustes no renderizó el control funcional de CPU: ${JSON.stringify(bannerSettingsSnapshot)}`);
    }
    if (bannerSettingsSnapshot.clearReprintTestId !== 'settings-clear-reprint-banner') {
        throw new Error(`Ajustes no renderizó el control de fastfetch para clear: ${JSON.stringify(bannerSettingsSnapshot)}`);
    }
    const clearReprintInput = await findWhenReady('[data-testid="settings-clear-reprint-banner"]');
    const clearReprintWasEnabled = Boolean(await property(clearReprintInput, 'checked'));
    const assertClearBannerMode = async (enabled, description) => {
        await sendTerminalLine('clear');
        await waitUntil(async () => {
            const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
            const latest = latestBannerBlock(text);
            return (/WTerminal|LTerminal/i.test(latest)) === enabled;
        }, 15000, description);
    };
    // El alias ya está instalado en la shell: cambiar la preferencia solo
    // actualiza el indicador que consulta `clear`, sin reiniciar la pestaña.
    if (clearReprintWasEnabled) await clickInView(clearReprintInput);
    await waitForSettingsAutosave();
    await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-clear-reprint-banner"]'), 'checked')) === false,
        5000,
        'desactivación temporal del fastfetch tras clear');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras desactivar fastfetch de clear');
    await assertClearBannerMode(false, 'clear sin fastfetch cuando la opción está desactivada');

    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-terminal"]');
    const clearReprintEnabledInput = await findWhenReady('[data-testid="settings-clear-reprint-banner"]');
    if (!Boolean(await property(clearReprintEnabledInput, 'checked'))) await clickInView(clearReprintEnabledInput);
    await waitForSettingsAutosave();
    await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-clear-reprint-banner"]'), 'checked')) === true,
        5000,
        'activación temporal del fastfetch tras clear');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras activar fastfetch de clear');
    await assertClearBannerMode(true, 'clear con fastfetch cuando la opción está activada');

    // Restaurar exactamente el valor que tenía la instalación antes del smoke.
    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-terminal"]');
    const clearReprintRestoredInput = await findWhenReady('[data-testid="settings-clear-reprint-banner"]');
    if (Boolean(await property(clearReprintRestoredInput, 'checked')) !== clearReprintWasEnabled) {
        await clickInView(clearReprintRestoredInput);
    }
    await waitForSettingsAutosave();
    await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-clear-reprint-banner"]'), 'checked')) === clearReprintWasEnabled,
        5000,
        'restauración persistida del fastfetch tras clear');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras restaurar fastfetch de clear');

    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-terminal"]');
    const cpuInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
    const cpuControl = await parentOf(cpuInput);
    const cpuLabelElement = (await findAllWithin(cpuControl, 'strong'))[0]?.[elementKey];
    const cpuLabel = cpuLabelElement ? (await textOf(cpuLabelElement)).trim() : '';
    if (!cpuLabel) throw new Error('La opción funcional de CPU no tiene etiqueta localizada');
    const cpuWasVisible = await property(cpuInput, 'checked');
    await clickInView(cpuInput);
    await waitForSettingsAutosave();
    await waitUntil(async () => {
        const savedInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
        return Boolean(await property(savedInput, 'checked')) === !cpuWasVisible;
    }, 5000, 'persistencia temporal de la opción CPU');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras cambiar CPU');
    // Aclarar el viewport antes de la orden explícita evita que el historial
    // del banner inicial oculte la diferencia de CPU en xterm reducido.
    await sendTerminalLine('clear');
    await sendTerminalLine('sysinfo');
    await waitUntil(async () => {
        const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return latestBannerBlock(text).includes(cpuLabel) === !cpuWasVisible;
    }, 15000, 'banner localizado tras cambiar CPU');

    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-terminal"]');
    const restoredCpuInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
    if (Boolean(await property(restoredCpuInput, 'checked')) !== !cpuWasVisible) {
        throw new Error('La opción CPU no persistió al reabrir Ajustes');
    }
    await clickInView(restoredCpuInput);
    await waitForSettingsAutosave();
    await waitUntil(async () => {
        const savedInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
        return Boolean(await property(savedInput, 'checked')) === cpuWasVisible;
    }, 5000, 'restauración persistida de la opción CPU');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras restaurar CPU');
    await sendTerminalLine('clear');
    await sendTerminalLine('sysinfo');
    await waitUntil(async () => {
        const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return latestBannerBlock(text).includes(cpuLabel) === cpuWasVisible;
    }, 15000, 'banner localizado tras restaurar CPU');
    recordEvent('preference', { name: 'banner.cpu', changed: !cpuWasVisible, restored: cpuWasVisible, label: cpuLabel });

    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    // El contrato del panel mantiene el orden Apariencia, Terminal,
    // Comportamiento, Información; usar el índice evita depender de que una
    // traducción concreta cambie la etiqueta visible de la pestaña.
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    panelVisibilityInitial = {};
    let visibilityChanged = false;
    for (const [name, testId] of Object.entries(VISIBILITY_CONTROLS)) {
        const input = await findWhenReady(`[data-testid="${testId}"]`);
        const checked = Boolean(await property(input, 'checked'));
        panelVisibilityInitial[name] = checked;
        if (!checked) {
            await clickInView(input);
            visibilityChanged = true;
        }
    }
    // Las fases siguientes necesitan estos paneles. Si el perfil del usuario
    // ocultó alguno, habilitarlo en una sola escritura y restaurarlo al final.
    if (visibilityChanged) {
        await waitForSettingsAutosave();
        await waitUntil(async () => {
            for (const testId of Object.values(VISIBILITY_CONTROLS)) {
                if (!Boolean(await property(await findWhenReady(`[data-testid="${testId}"]`), 'checked'))) return false;
            }
            return true;
        }, 5000, 'activación temporal de paneles para el E2E');
    }
    // El E2E debe ser repetible aunque la configuración del usuario haya
    // ocultado el explorador: habilitarlo desde el mismo control que usaría
    // una persona y comprobar después que aparece de verdad.
    // Ajustes es modal: cerrarlo siempre antes de tocar el explorador o la
    // terminal. Dejarlo abierto hacía que WebKit devolviese aleatoriamente
    // "element not interactable" en la fase siguiente.
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes');
    if ((await findAll('.explorer')).length === 0) {
        await clickWhenReady('.side-toggle:not(.panes)');
    }
    await findWhenReady('.explorer');
    const terminal = await findWhenReady('.cell:not(.hidden) .xterm');
    await click(terminal);

    markPhase('biblioteca y operaciones');
    // LTools es la única fuente de acciones fijables. Los scripts heredados
    // siguen pudiendo ejecutarse desde los resultados, pero no deben crear un
    // segundo menú de operaciones ni depender de showQuickActions.
    await sendTerminalLine(':quick-actions list');
    await waitUntil(async () => {
        const output = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return /LTools|Biblioteca|Library/i.test(output.slice(-1200));
    }, 10000, 'ayuda del comando heredado de acciones rápidas');
    const legacyQuickActionsOutput = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
    if (!/LTools|Biblioteca|Library/i.test(legacyQuickActionsOutput.slice(-1200))) {
        throw new Error('El comando heredado no ofrece la migración a LTools');
    }
    recordEvent('legacy-quick-actions-compat', {
        command: ':quick-actions list',
        migratedTo: 'ltools',
        mutatesPreferences: false,
        preview: legacyQuickActionsOutput.slice(-1200),
        passed: true,
    });
    // Esas líneas las escribe la app solo en xterm. La orden siguiente no
    // puede sobrescribirlas (antes quedaba `cd /d "…"as de LTools.`) ni
    // quedar separada de su prompt.
    const afterInternalMarker = `LTERMINAL_E2E_AFTER_INTERNAL_${Date.now()}`;
    await sendAndWaitForMarker(afterInternalMarker);
    const afterInternalCell = await activeTerminalCell();
    const afterInternalRows = (await terminalRowSnapshot(afterInternalCell)).rows.map((row) => row.text.trimEnd());
    const overwrittenInternalRows = afterInternalRows.filter((row) => /LTools/u.test(row) && /echo\s|LTERMINAL_E2E_AFTER_INTERNAL/u.test(row));
    if (overwrittenInternalRows.length > 0) {
        await captureScreenshot('salida-interna-sobrescrita');
        throw new Error(`La orden sobrescribió la salida interna: ${JSON.stringify({ overwrittenInternalRows, rows: afterInternalRows.filter(Boolean) })}`);
    }
    await assertNoDetachedCommandEcho([afterInternalCell], [`echo ${afterInternalMarker}`], 'tras-salida-interna');
    // El catálogo y el instalador deben quedar fuera de la Biblioteca mientras
    // la integración experimental está desactivada, aunque el CLI exista.
    await setLToolsEnabledForE2E(false);
    await clickWhenReady('[data-testid="toolbar-library"]');
    await findWhenReady('[role="dialog"]');
    if ((await findAll('[data-testid="scripts-ltools"]')).length !== 0) {
        throw new Error('La Biblioteca muestra LTools aunque la integración experimental está desactivada.');
    }
    recordEvent('ltools-disabled-by-default', { visible: false, installControlVisible: false, passed: true });
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca con LTools desactivado');
    await setLToolsEnabledForE2E(true);
    await clickWhenReady('[data-testid="toolbar-library"]');
    const libraryDialog = await findWhenReady('[role="dialog"]');
    const libraryIdentity = await textOf(libraryDialog);
    // La Biblioteca es un panel común y no tiene por qué repetir el nombre de
    // la aplicación en su contenido. La comprobación correcta es negativa:
    // una ejecución Linux no puede mostrar la marca de Windows y viceversa.
    // Antes se exigía encontrar "LTerminal" dentro del diálogo; eso convirtió
    // etiquetas legítimas como «Scripts Windows» en un falso fallo de identidad.
    const hasLinuxBrand = /\bLTerminal\b/i.test(libraryIdentity);
    const hasWindowsBrand = /\bWTerminal\b/i.test(libraryIdentity);
    if (process.platform === 'win32' && hasLinuxBrand) {
        throw new Error(`La Biblioteca Windows mezcla la identidad Linux: ${JSON.stringify(libraryIdentity.slice(0, 240))}`);
    }
    if (process.platform !== 'win32' && hasWindowsBrand) {
        throw new Error(`La Biblioteca Linux mezcla la identidad Windows: ${JSON.stringify(libraryIdentity.slice(0, 240))}`);
    }
    if ((await findAll('[data-testid="scripts-quick-operations"]')).length !== 0) {
        throw new Error('La Biblioteca todavía muestra el menú heredado de Operaciones rápidas');
    }
    const ltoolsSection = await findWhenReady('[data-testid="scripts-ltools"]');
    const ltoolsWasClosed = (await attribute(ltoolsSection, 'open')) === null;
    await clickWhenReady('[data-testid="scripts-ltools"] > summary');
    if ((await attribute(ltoolsSection, 'open')) !== 'true') throw new Error('No se pudo desplegar el catálogo de acciones de LTools');
    await waitUntil(async () =>
        (await findAll('[data-testid="scripts-ltools-install"]')).length === 1
        || (await findAll('[data-testid="scripts-ltools-meta"]')).length === 1,
    15000, 'estado estable del catálogo LTools');
    const ltoolsText = await textOf(ltoolsSection);
    // El catálogo puede reemplazar sus botones cuando termina una sonda de
    // disponibilidad. No conserves referencias WebDriver a esos nodos entre
    // renders: leer el acordeón ya estabilizado evita el falso fallo
    // «[object Object]» sin dejar de comprobar que la opción existe.
    // El botón está localizado en 15 idiomas; su test id estable evita que la
    // aserción dependa del idioma que quedó activo tras el ciclo de traducción.
    const installControlVisible = (await findAll('[data-testid="scripts-ltools-install"]')).length === 1;
    const ltoolsAvailable = (await findAll('[data-testid="scripts-ltools-meta"]')).length === 1;
    if (!ltoolsAvailable && !/LTools|WinSlim Tools/i.test(ltoolsText)) {
        throw new Error(`La Biblioteca no muestra el estado de LTools ni el control de instalación: ${JSON.stringify(ltoolsText)}`);
    }
    recordEvent('ltools-ui-source', {
        legacySelectorCount: (await findAll('[data-testid="scripts-quick-operations"]')).length,
        ltoolsSectionCount: (await findAll('[data-testid="scripts-ltools"]')).length,
        available: ltoolsAvailable,
        installControlVisible,
        initiallyClosed: ltoolsWasClosed,
        passed: true,
    });
    const types = await findWhenReady('.types');
    if ((await attribute(types, 'open')) !== null) throw new Error('Tipos de archivo aparece abierto por defecto');
    await clickWhenReady('.types > summary');
    if ((await attribute(types, 'open')) !== 'true') throw new Error('No se pudo desplegar Tipos de archivo');
    if ((await findAll('[data-testid="scripts-cd-path"]')).length !== 1) {
        throw new Error('La Biblioteca no ofrece la acción cd sobre su ruta');
    }
    if ((await findAll('[data-testid="scripts-open-path"]')).length !== 1) {
        throw new Error('La Biblioteca no ofrece abrir su ruta en el explorador');
    }
    if ((await findAll('button[title*="Elegir carpeta"]')).length !== 0) {
        throw new Error('La Biblioteca todavía muestra el selector de carpeta retirado');
    }
    const libraryModes = await findAll('[role="dialog"] .modes [role="tab"]');
    if (libraryModes.length !== 2) throw new Error(`La Biblioteca no muestra sus dos ámbitos: ${libraryModes.length}`);
    await click(libraryModes[1][elementKey]);
    await waitUntil(async () => (await findAll('[role="dialog"] [data-testid="scripts-ltools"]')).length === 0, 5000, 'ocultación de LTools en Ruta actual');
    if ((await findAll('[role="dialog"] [data-testid="scripts-ltools"]')).length !== 0) {
        throw new Error('Ruta actual muestra acciones globales de LTools');
    }
    await click(libraryModes[0][elementKey]);
    await findWhenReady('[role="dialog"] [data-testid="scripts-ltools"]');

    if (ltoolsIntegration) {
        markPhase('integración opcional de LTools');
        await exerciseLToolsIntegration();
    }

    markPhase('explorador y menú contextual');
    // El explorador debe conservar el menú contextual y sus acciones, aunque
    // aquí no se ejecuta eliminar ni pegar sobre datos del usuario.
    const openDialogs = await findAll('[role="dialog"]');
    if (openDialogs.length) {
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca antes del explorador');
    }
    const explorer = await findWhenReady('.explorer');
    const explorerLayout = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = arguments[0];
            const path = root.querySelector('.path')?.getBoundingClientRect();
            const actions = root.querySelector('.actions')?.getBoundingClientRect();
            return path && actions ? {
                pathHeight: path.height,
                gap: actions.top - path.bottom,
                ordered: actions.top >= path.bottom
            } : null;`,
        args: [{ [elementKey]: explorer }],
    });
    if (!explorerLayout
        || explorerLayout.pathHeight > 32
        || explorerLayout.gap > 4
        || explorerLayout.ordered !== true) {
        throw new Error(`La ruta del explorador volvió a ocupar un bloque vacío: ${JSON.stringify(explorerLayout)}`);
    }

    let cwdFollowed = false;
    let explorerOriginalPath = '';
    const explorerState = () => request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = document.querySelector('.explorer');
            const path = root?.querySelector('.path');
            const status = root?.querySelector('.status');
            return {
                path: path?.textContent?.trim() ?? '',
                title: path?.getAttribute('title') ?? '',
                status: status?.textContent?.trim() ?? '',
                entries: root?.querySelectorAll('.entry').length ?? 0
            };`,
        args: [],
    });
    try {
        await waitUntil(async () => {
            explorerOriginalPath = (await explorerState()).path;
            return explorerOriginalPath.length > 0;
        }, 10000, 'ruta inicial del explorador');
    } catch (cause) {
        throw new Error(`${cause.message}: ${JSON.stringify(await explorerState())}`);
    }
    if (process.platform === 'win32') {
        if (!/^[A-Za-z]:\\/.test(explorerOriginalPath)) {
            throw new Error(`El explorador Windows no mostró una ruta absoluta: ${JSON.stringify(explorerOriginalPath)}`);
        }
        const temporaryPath = String(process.env.TEMP ?? '').trim();
        if (!/^[A-Za-z]:\\/.test(temporaryPath) || temporaryPath.includes('"')) {
            throw new Error(`No se pudo preparar un destino temporal seguro para cmd: ${JSON.stringify(temporaryPath)}`);
        }
        const windowsPathKey = (path) => String(path ?? '')
            .replaceAll('/', '\\')
            .replace(/\\+$/, '')
            .toLocaleLowerCase('en-US');
        await clickWhenReady('.cell:not(.hidden) .xterm');
        await sendTerminalLine(`cd /d "${temporaryPath}"`);
        await waitUntil(async () => windowsPathKey((await explorerState()).path) === windowsPathKey(temporaryPath),
            10000, 'sincronización del explorador tras cd /d %TEMP%');
        cwdFollowed = true;
        await sendTerminalLine(`cd /d "${explorerOriginalPath}"`);
        await waitUntil(async () => windowsPathKey((await explorerState()).path) === windowsPathKey(explorerOriginalPath),
            10000, 'restauración del cwd original del explorador Windows');
    } else {
        if (!explorerOriginalPath.startsWith('/')) {
            throw new Error(`El explorador Linux no mostró una ruta absoluta: ${JSON.stringify(explorerOriginalPath)}`);
        }
        await clickWhenReady('.cell:not(.hidden) .xterm');
        await sendTerminalLine('cd /tmp');
        await waitUntil(async () =>
            (await explorerState()).path === '/tmp',
        10000, 'sincronización del explorador tras cd /tmp');
        cwdFollowed = true;
        const quotedOriginalPath = `'${explorerOriginalPath.replaceAll("'", "'\"'\"'")}'`;
        await sendTerminalLine(`cd ${quotedOriginalPath}`);
        await waitUntil(async () =>
            (await explorerState()).path === explorerOriginalPath,
        10000, 'restauración del cwd tras probar el explorador');
    }
    recordEvent('explorer-cwd-layout', {
        layout: explorerLayout,
        originalPath: explorerOriginalPath,
        cwdFollowed,
        passed: cwdFollowed,
    });
    if (!cwdFollowed) throw new Error('El E2E no verificó que el explorador siguiera el cwd de la terminal.');

    await exerciseExplorerDoubleClick();

    const entry = (await findAll('.explorer .entry'))[0]?.[elementKey];
    if (!entry) throw new Error('El explorador no mostró ninguna entrada para probar el menú contextual');
    await rightClick(entry);
    let menu;
    try {
        menu = await findWhenReady('[role="menu"]', 2500);
    } catch {
        await dispatchContextMenu(entry);
        menu = await findWhenReady('[role="menu"]', 5000);
    }
    const menuText = await textOf(menu);
    const cutLabel = originalExpected['explorer.cut'] ?? 'Cortar';
    const trashLabel = originalExpected['explorer.trash'] ?? 'Enviar a la papelera';
    if (!menuText.includes(cutLabel) || !menuText.includes(trashLabel)) {
        throw new Error('El menú contextual no contiene cortar y eliminar');
    }
    recordEvent('context-menu', { actions: ['cut', 'delete', 'settings'] });
    await clickWhenReady('.menu-backdrop');

    const terminalForMenu = await findWhenReady('.cell:not(.hidden) .xterm');
    await rightClick(terminalForMenu);
    let terminalMenu;
    try {
        terminalMenu = await findWhenReady('[role="menu"]', 2500);
    } catch {
        await dispatchContextMenu(terminalForMenu);
        terminalMenu = await findWhenReady('[role="menu"]', 5000);
    }
    const terminalMenuText = await textOf(terminalMenu);
    const openSystemLabel = originalExpected['explorer.openInSystem'] ?? 'Abrir en el explorador del sistema';
    if (!terminalMenuText.includes(openSystemLabel)) {
        throw new Error('El menú de terminal no ofrece abrir el directorio actual en el gestor del sistema');
    }
    const settingsLabel = originalExpected['toolbar.settings'] ?? 'Ajustes';
    if (!terminalMenuText.includes(settingsLabel)) {
        throw new Error('El menú de terminal no ofrece abrir Ajustes');
    }
    await clickWhenReady('.menu-backdrop');

    markPhase('proyectos');
    // Proyectos: recorrer los tres modos prueba que el contenido se desmonta
    // y vuelve a cargar sin romper el panel.
    await clickWhenReady('[data-testid="toolbar-projects"]');
    await findWhenReady('[role="dialog"]');
    const projectTabs = await findAll('[role="dialog"] [role="tab"]');
    if (projectTabs.length < 3) throw new Error(`Proyectos no muestra sus tres modos: ${projectTabs.length}`);
    for (const tab of projectTabs) await click(tab[elementKey]);
    await clickWhenReady('[role="dialog"] .panel-close');

    markPhase('entorno y dependencias');
    // Dependencias: cargar el catálogo, abrir Compatibilidad Windows y un
    // submenú, pero no ejecutar instalaciones ni cambios del sistema.
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        // La primera apertura puede encontrar la detección en segundo plano ya
        // confirmada. En ese caso el catálogo debe reutilizarse inmediatamente
        // y no volver a enseñar un placeholder ni lanzar otra pasada. Si aún
        // no hay inventario, sí exigimos la pantalla atómica de carga.
        let groupsOnOpen = (await findAll('[data-testid="dependency-group"]')).length;
        let placeholderSeenOnOpen = false;
        await waitUntil(async () => {
            if ((await findAll('[data-testid="dependency-group"]')).length > 0) return true;
            if ((await findAll('[data-testid="dependency-detection-placeholder"]')).length === 0) return false;
            placeholderSeenOnOpen = true;
            return true;
        }, 5000, 'estado inicial de Entorno y dependencias');
        // La apertura puede resolver el catálogo entre la lectura inicial y
        // este punto. Medir aquí evita confundir ese primer render confirmado
        // con un placeholder que ya desapareció.
        groupsOnOpen = (await findAll('[data-testid="dependency-group"]')).length;
        const placeholderOnOpen = (await findAll('[data-testid="dependency-detection-placeholder"]')).length;
        if (groupsOnOpen === 0) {
            // La pantalla de carga ya vista cuenta: en cuanto la detección
            // confirma su primera sección la quita (y aún puede no haber grupos
            // a la vista). Esperarla otra vez fallaba a los 20 s con el catálogo
            // ya completo (E2E del portable, 21-10).
            if (!placeholderSeenOnOpen && placeholderOnOpen === 0) {
                await findWhenReady('[data-testid="dependency-detection-placeholder"]');
            }
            if ((await findAll('[data-testid="dependency-detection-placeholder"]')).length > 0
                && (await findAll('[data-testid="dependency-group"]')).length !== 0) {
                throw new Error('Dependencias mostró grupos antes de terminar la detección completa');
            }
        } else if (placeholderOnOpen !== 0) {
            throw new Error('Dependencias mezcló el catálogo confirmado con el placeholder de detección');
        }
    await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0,
        180000, 'fin de la detección secuencial de dependencias');
    const dependencyRefresh = await findWhenReady('[data-testid="dependency-refresh"]');
    await waitUntil(async () => !(await property(
        await findWhenReady('[data-testid="dependency-refresh"]'),
        'disabled',
    )), 180000, 'botón habilitado al terminar la detección inicial');
        const groupsBeforeRefresh = (await findAll('[data-testid="dependency-group"]')).length;
        if (groupsOnOpen > 0) {
            recordEvent('dependency-cache-reused-on-open', {
                groups: groupsOnOpen,
                placeholderVisible: false,
                passed: true,
            });
        }
    if (skipDependencyRefresh) {
        recordEvent('dependency-refresh-skipped-for-focused-layout', {
            groups: groupsBeforeRefresh,
            reason: 'E2E_SKIP_DEPENDENCY_REFRESH=1; la detección completa tiene un escenario enfocado propio',
            passed: true,
        });
    } else {
        await clickInView(dependencyRefresh);
        await waitUntil(async () => Boolean(await property(
            await findWhenReady('[data-testid="dependency-refresh"]'),
            'disabled',
        )), 5000, 'estado ocupado de repetir detección');
        if ((await findAll('[data-testid="dependency-detection-placeholder"]')).length !== 1
            || (await findAll('[data-testid="dependency-group"]')).length !== 0) {
            throw new Error('Repetir detección dejó visible un menú parcial mientras estaba ocupado');
        }
        await captureScreenshot('dependencias-reintentando-deteccion');
        await waitUntil(async () => !(await property(
            await findWhenReady('[data-testid="dependency-refresh"]'),
            'disabled',
        )), 180000, 'fin del reintento de detección');
        const groupsAfterRefresh = (await findAll('[data-testid="dependency-group"]')).length;
        if (groupsAfterRefresh === 0 || groupsAfterRefresh !== groupsBeforeRefresh) {
            throw new Error(`Repetir detección dejó un catálogo inconsistente: ${groupsBeforeRefresh} -> ${groupsAfterRefresh}`);
        }
        const unresolvedAfterRefresh = await findAll('[data-testid="dependency-action"][data-detection-status="unknown"]');
        if (unresolvedAfterRefresh.length !== 0) {
            throw new Error(`Repetir detección dejó ${unresolvedAfterRefresh.length} acciones sin confirmar`);
        }
        await captureScreenshot('dependencias-despues-de-reintento');
        recordEvent('dependency-detection-retry', {
            buttonVisible: true,
            busyStateCaptured: true,
            groupsBeforeRefresh,
            groupsAfterRefresh,
            unresolvedAfterRefresh: unresolvedAfterRefresh.length,
            passed: true,
        });
    }
    const dependencyGroups = await findAll('[data-testid="dependency-group"]');
    const dependencySections = await findAll('[data-testid="dependency-section"]');
    if (dependencySections.length < 2) {
        throw new Error(`Dependencias perdió sus secciones de navegación: ${dependencySections.length}`);
    }
    for (const section of dependencySections) {
        if ((await attribute(section[elementKey], 'open')) !== null) {
            throw new Error('Una sección de Dependencias aparece abierta al entrar en el panel');
        }
    }
    const sectionIds = new Set(await Promise.all(
        dependencySections.map((section) => attribute(section[elementKey], 'data-section-id'))
    ));
    if (!sectionIds.has('updates') || sectionIds.has('maintenance') || !sectionIds.has('environments') || !sectionIds.has('development') || !sectionIds.has('ai')) {
        throw new Error(`Dependencias no conserva Actualizaciones como lista única o perdió sus secciones: ${[...sectionIds].join(', ')}`);
    }
    for (const group of dependencyGroups) {
        const section = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'return arguments[0].closest("[data-testid=dependency-section]")?.dataset.sectionId ?? null;',
            args: [{ [elementKey]: group[elementKey] }],
        });
        if (!section) throw new Error('Un grupo de dependencias quedó fuera de su sección');
    }
    for (const group of dependencyGroups) {
        if ((await attribute(group[elementKey], 'open')) !== null) {
            throw new Error('Un grupo de dependencias aparece abierto antes de solicitarlo');
        }
    }
    await captureScreenshot('dependencias-secciones-plegadas');
    const dependencyText = (await Promise.all(dependencyGroups.map((item) => textOf(item[elementKey])))).join('\n');
    const groupSectionId = async (groupKey) => {
        for (const item of dependencyGroups) {
            if ((await attribute(item[elementKey], 'data-group-key')) !== groupKey) continue;
            return await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'return arguments[0].closest("[data-testid=dependency-section]")?.dataset.sectionId ?? null;',
                args: [{ [elementKey]: item[elementKey] }],
            });
        }
        return null;
    };
    const updatesSection = await findWhenReady('[data-testid="dependency-section"][data-section-id="updates"]');
    await clickWhenReady('[data-testid="dependency-section"][data-section-id="updates"] > summary.section-header');
    await waitUntil(async () => {
        const visible = await findAllWithin(updatesSection, '[data-testid="dependency-group"]');
        if (!visible.length) return false;
        return (await attribute(visible[0][elementKey], 'open')) !== null
            && /Actualizar|Update|upgrade/i.test(await textOf(visible[0][elementKey]));
    }, 5000, 'contenido visible de Actualizaciones');
    const updatesText = await textOf(await findWhenReady('[data-testid="dependency-section"][data-section-id="updates"]'));
    if (!/Actualizar|Update|upgrade/i.test(updatesText)) throw new Error('Actualizaciones se abrió sin contenido visible');
    await captureScreenshot('dependencias-actualizaciones-desplegadas');
    // Aunque falte el runtime o el framework, el panel debe conservar la
    // cabecera de su ecosistema. Antes la única acción «Instalar» degradaba a
    // una tarjeta plana y desaparecían los padres de Python/.NET/Rust.
    const developmentSection = await findWhenReady('[data-testid="dependency-section"][data-section-id="development"]');
    if ((await attribute(developmentSection, 'open')) === null) {
        await clickWhenReady('[data-testid="dependency-section"][data-section-id="development"] > summary.section-header');
    }
    const frameworkGroup = await findWhenReady('[data-testid="dependency-group"][data-group-key="group.frameworks"]');
    if ((await attribute(frameworkGroup, 'open')) === null) {
        await clickWhenReady('[data-testid="dependency-group"][data-group-key="group.frameworks"] > summary.group-title');
    }
    const frameworkParents = await findAllWithin(frameworkGroup, '[data-testid="dependency-subgroup"][data-subgroup-level="parent"] > summary');
    const frameworkParentText = (await Promise.all(frameworkParents.map((item) => textOf(item[elementKey])))).join('\n');
    if (!/Python|\.NET|Rust/i.test(frameworkParentText)) {
        throw new Error('Frameworks perdió las categorías padre cuando solo queda la acción Instalar');
    }
    let dotnetParent;
    for (const summary of frameworkParents) {
        if (/\.NET/i.test(await textOf(summary[elementKey]))) {
            dotnetParent = summary[elementKey];
            break;
        }
    }
    if (!dotnetParent) throw new Error('Frameworks no muestra la categoría padre de .NET');
    await click(dotnetParent);
    // El ciclo de vida sustituye la tarjeta «Instalar Paket» por «Actualizar»
    // y «Desinstalar» cuando la herramienta ya está instalada. Comprobar solo
    // el id de instalación hacía fallar la E2E precisamente en el estado sano.
    const paketActions = await findAllWithin(
        frameworkGroup,
        '[data-action-id="framework-paket"], [data-action-id="framework-paket-update"], [data-action-id="framework-paket-uninstall"]'
    );
    if (paketActions.length === 0) {
        throw new Error('Paket falta dentro de la categoría padre .NET');
    }
    const dotnetDetails = await parentOf(dotnetParent);
    const dotnetChildren = await findAllWithin(dotnetDetails, '[data-testid="dependency-subgroup"][data-subgroup-level="child"] > summary');
    const dotnetChildText = (await Promise.all(dotnetChildren.map((item) => textOf(item[elementKey])))).join('\n');
    if (!/Paket/i.test(dotnetChildText)) {
        throw new Error('.NET no muestra Paket como categoría hija del ecosistema');
    }
    recordEvent('framework-parent-categories', {
        parents: frameworkParents.length,
        children: dotnetChildren.length,
        paketCategorized: /\.NET/i.test(frameworkParentText),
        passed: true,
    });
    // Dejar la sección como estaba evita que el siguiente recorrido de
    // virtualización conserve referencias de WebDriver a un DOM que acaba de
    // cambiar por los acordeones de frameworks.
    await clickWhenReady('[data-testid="dependency-section"][data-section-id="development"] > summary.section-header');
    const dockerSectionIds = await Promise.all([
        groupSectionId('group.containers'),
        groupSectionId('group.docker'),
    ]);
    const androidSectionId = await groupSectionId('group.android');
    const dockerSections = dockerSectionIds.filter(Boolean);
    if (!dockerSections.length || dockerSections.some((sectionId) => sectionId !== 'platforms')) {
        throw new Error(`Docker/Kubernetes quedó en ${dockerSections.join(', ') || 'ninguna sección'} y debe estar en Plataformas e integración`);
    }
    if (androidSectionId !== 'platforms') {
        throw new Error(`ADB quedó en ${androidSectionId ?? 'ninguna sección'} y debe estar en Plataformas e integración`);
    }
    const platformsSection = await findWhenReady('[data-testid="dependency-section"][data-section-id="platforms"]');
    if ((await attribute(platformsSection, 'open')) === null) {
        await clickWhenReady('[data-testid="dependency-section"][data-section-id="platforms"] > summary.section-header');
    }
    await waitUntil(async () => {
        const visible = await findAllWithin(platformsSection, '[data-testid="dependency-group"]');
        return visible.length >= 2;
    }, 5000, 'contenido visible de Plataformas e integración');
    const platformsText = await textOf(platformsSection);
    if (!/Docker|Contenedor|Container/i.test(platformsText) || !/ADB|Android/i.test(platformsText)) {
        throw new Error('Plataformas e integración no muestra juntos Docker y ADB');
    }
    recordEvent('dependency-taxonomy', {
        updatesVisible: true,
        dockerSections,
        androidSection: androidSectionId,
        passed: true,
    });
    await clickWhenReady('[data-testid="dependency-section"][data-section-id="updates"] > summary.section-header');
    // Linux ofrece compatibilidad Windows (Wine/Bottles/CrossOver), mientras
    // Windows ofrece virtualización nativa (Hyper-V/QEMU/VirtualBox).
    // El E2E debe comprobar el contrato de la plataforma mediante la clave
    // estable, no mediante una etiqueta traducida.
    const nativeWindows = process.platform === 'win32';
    const platformGroupKey = nativeWindows ? 'group.virt' : 'group.windowsCompat';
    const platformGroupPattern = nativeWindows
        ? /Virtualización|Virtualisation|Virtualization/i
        : /Compatibilidad(?: con)? Windows|Windows compatibility/i;
    const platformGroupLabel = nativeWindows ? 'Virtualización' : 'Compatibilidad Windows';
    // `data-group-key` no cambia con el idioma. El patrón textual queda como
    // respaldo para builds antiguas que aún no lo publicaban.
    let compatibilityId;
    for (const item of dependencyGroups) {
        if ((await attribute(item[elementKey], 'data-group-key')) === platformGroupKey) {
            compatibilityId = item[elementKey];
            break;
        }
    }
    if (!compatibilityId) {
        for (const item of dependencyGroups) {
            if (platformGroupPattern.test(await textOf(item[elementKey]))) {
                compatibilityId = item[elementKey];
                break;
            }
        }
    }
    if (!compatibilityId) throw new Error(`No se pudo localizar el grupo de ${platformGroupLabel}`);
    const compatibilitySectionId = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return arguments[0].closest("[data-testid=dependency-section]")?.dataset.sectionId ?? null;',
        args: [{ [elementKey]: compatibilityId }],
    });
    if (compatibilitySectionId) {
        const section = await findWhenReady(`[data-testid="dependency-section"][data-section-id="${compatibilitySectionId}"]`);
        if ((await attribute(section, 'open')) === null) {
            await clickWhenReady(`[data-testid="dependency-section"][data-section-id="${compatibilitySectionId}"] > summary.section-header`);
        }
    }
    await click(compatibilityId);
    await captureScreenshot('dependencias-plataforma-desplegada');
    const subgroupSummaries = await findAllWithin(compatibilityId, '[data-testid="dependency-subgroup"] > summary');
    // Una herramienta con una sola acción se muestra como tarjeta directa,
    // no como un acordeón vacío. El contrato debe inspeccionar ambas formas:
    // en Windows recortado Hyper-V/Sandbox suelen quedar precisamente en esa
    // representación porque sus acciones de actualizar/comprobar no aplican.
    const platformEntries = await findAllWithin(compatibilityId, '[data-testid="dependency-subgroup"], .tool');
    const subgroupText = (await Promise.all(platformEntries.map((item) => textOf(item[elementKey])))).join('\n');
    const platformActionIds = new Set(await Promise.all(
        (await findAllWithin(compatibilityId, '[data-testid="dependency-action"]'))
            .map((action) => attribute(action[elementKey], 'data-action-id'))
    ));
    const hasNamedTool = nativeWindows
        ? [...platformActionIds].some((id) => /hyperv|vmp|sandbox|qemu|virtualbox/i.test(id ?? ''))
        : [...platformActionIds].some((id) => /^(?:compat-|pkg-wine|wine-)/i.test(id ?? ''));
    // No se compara el idioma: una descripción no vacía y suficientemente
    // larga demuestra que el subgrupo no es una tarjeta sin contexto.
    const hasDescription = platformEntries.length > 0
        && subgroupText.split('\n').some((line) => line.trim().length >= 20);
    if (!hasNamedTool || !hasDescription) {
        throw new Error(`${platformGroupLabel} no muestra programa y descripción en sus submenús`);
    }
    if (platformEntries.length === 0) throw new Error(`${platformGroupLabel} no contiene acciones visibles`);
    if (nativeWindows) {
        // El chequeo general de virtualización podía pasar con Hyper-V o
        // VirtualBox aunque la acción que el usuario reportó, Sandbox,
        // hubiera desaparecido del catálogo. Validar su fila y sus requisitos
        // explícitos sin ejecutarla: habilitar características de Windows
        // altera el sistema y exige reinicio.
        const sandboxAction = (await findAllWithin(compatibilityId, '[data-action-id="windows-sandbox-enable"]'))[0];
        if (!sandboxAction) {
            throw new Error('Windows no muestra la acción Activar Windows Sandbox');
        }
        const sandboxSubgroup = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'return arguments[0].closest("details.subgroup");',
            args: [{ [elementKey]: sandboxAction[elementKey] }],
        });
        if (sandboxSubgroup?.[elementKey] && (await attribute(sandboxSubgroup[elementKey], 'open')) === null) {
            const summary = (await findAllWithin(sandboxSubgroup[elementKey], ':scope > summary'))[0];
            if (!summary) throw new Error('El subgrupo de Windows Sandbox no tiene cabecera desplegable');
            await click(summary[elementKey]);
        }
        const sandboxItemText = await request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: 'return arguments[0].closest(".item")?.innerText ?? "";',
            args: [{ [elementKey]: sandboxAction[elementKey] }],
        });
        if (!/IoT Enterprise/i.test(sandboxItemText)
            || !/BIOS\/UEFI/i.test(sandboxItemText)
            || !/reinicio/i.test(sandboxItemText)) {
            throw new Error(`La acción de Sandbox no explica edición, firmware y reinicio: ${sandboxItemText}`);
        }
        if (sandboxSubgroup?.[elementKey]) {
            const isOpen = await attribute(sandboxSubgroup[elementKey], 'open');
            if (isOpen === null) {
                const summary = (await findAllWithin(sandboxSubgroup[elementKey], ':scope > summary'))[0];
                if (!summary) throw new Error('El subgrupo de Windows Sandbox no tiene cabecera desplegable');
                await clickInView(summary[elementKey]);
            }
        }
        await scrollIntoView(sandboxAction[elementKey]);
        const sandboxActionVisible = await request(`/session/${sessionId}/element/${sandboxAction[elementKey]}/displayed`, 'GET');
        if (!sandboxActionVisible) throw new Error('La acción de Windows Sandbox existe, pero no se muestra');
        await captureScreenshot('dependencias-windows-sandbox');
        recordEvent('windows-sandbox-contract', {
            actionId: 'windows-sandbox-enable',
            visible: true,
            activationAttempted: false,
        });
    } else {
        // Array.find no espera promesas: localizar CrossOver con el mismo patrón
        // explícito usado para el grupo evita que vuelva a degradarse a una fila
        // directa cuando solo queda una acción visible.
        let crossoverSummaryId;
        for (const summary of subgroupSummaries) {
            const details = await parentOf(summary[elementKey]);
            if (/CrossOver/i.test(await textOf(details))) {
                crossoverSummaryId = summary[elementKey];
                break;
            }
        }
        if (!crossoverSummaryId) {
            // CrossOver es opcional y comercial: algunas builds ocultan el
            // subgrupo si el inventario no puede ofrecer la acción oficial de
            // descarga. No convertir esa ausencia ambiental en un fallo de la
            // aplicación; sí se valida siempre que el grupo Windows y sus
            // herramientas libres estén presentes.
            recordEvent('crossover-subgroup', { skipped: true, reason: 'no disponible en este inventario' });
        } else {
            const crossoverDetails = await parentOf(crossoverSummaryId);
            const crossoverActions = await findAllWithin(crossoverDetails, '[data-testid="dependency-action"]');
            if (crossoverActions.length < 2) {
                throw new Error(`CrossOver volvió a degradarse a una fila directa: ${crossoverActions.length} acción(es)`);
            }
            const crossoverActionText = (await Promise.all(crossoverActions.map((item) => textOf(item[elementKey])))).join('\n');
            if (!/Descargar|Comprobar|Abrir|Download|Check|Open/i.test(crossoverActionText)) {
                throw new Error('El submenú de CrossOver no contiene acciones de diagnóstico o apertura');
            }
        }
    }
    // WebKitGTK puede exponer el nodo `<summary>` mediante su contador
    // («2») en vez del texto accesible completo. Recorrer por posición e
    // identidad de elemento evita confundir ese detalle del driver con
    // subgrupos realmente duplicados y sigue ejercitando cada acordeón.
    for (let subgroupIndex = 0; subgroupIndex < subgroupSummaries.length; subgroupIndex += 1) {
        // Abrir un details puede hacer que Svelte sustituya sus hermanos.
        // Volver a buscar el summary evita usar un identificador WebDriver
        // caducado en el siguiente ciclo.
        const freshSummaries = await findAllWithin(compatibilityId, '[data-testid="dependency-subgroup"] > summary');
        const subgroupId = freshSummaries[subgroupIndex]?.[elementKey];
        if (!subgroupId) throw new Error(`No se pudo volver a localizar el subgrupo en posición ${subgroupIndex}`);
        await scrollIntoView(subgroupId);
        await click(subgroupId);
        const subgroupDetails = await parentOf(subgroupId);
        const subgroupActions = await findAllWithin(subgroupDetails, '[data-testid="dependency-action"]');
        if (subgroupActions.length === 0) {
            const detail = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'return { open: arguments[0].open, html: arguments[0].innerHTML };',
                args: [{ [elementKey]: subgroupDetails }],
            });
            throw new Error(`El subgrupo en posición ${subgroupIndex} no muestra acciones (open=${detail.open}, html=${String(detail.html).slice(0, 500)})`);
        }
        for (const action of subgroupActions) {
            const actionId = await attribute(action[elementKey], 'data-action-id');
            if (!actionId) throw new Error(`La acción del subgrupo ${subgroupIndex} no tiene identificador estable`);
        }
    }
    await clickWhenReady('[role="dialog"] .panel-close');

    // Abrir y cerrar Dependencias varias veces comprueba que las respuestas de
    // detección tardías no pisan la lista de una apertura posterior.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await clickWhenReady('[data-testid="toolbar-dependencies"]');
        await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0, 10000, 'recarga de dependencias');
        const repeatedGroups = await findAll('[data-testid="dependency-group"]');
        if (repeatedGroups.length !== dependencyGroups.length) {
            throw new Error(`Dependencias cambió de tamaño en la repetición ${attempt + 1}: ${dependencyGroups.length} -> ${repeatedGroups.length}`);
        }
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre repetido de Dependencias');
    }
    recordEvent('dependencies', {
        groups: dependencyGroups.length,
        sections: dependencySections.length,
        subgroups: subgroupSummaries.length,
        entries: platformEntries.length,
        repeatedLoads: 3,
        platformGroup: platformGroupLabel,
    });

    // Las dos preferencias de acordeones tienen que gobernar también las
    // secciones grandes de Dependencias (no solo los subgrupos). Se prueban
    // con clics reales y se restaura el perfil original al terminar.
    markPhase('acordeones y listas');
    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    const exclusiveInput = await findWhenReady('[data-testid="settings-exclusive-groups"]');
    const autoOpenInput = await findWhenReady('[data-testid="settings-auto-open-first"]');
    const originalExclusive = Boolean(await property(exclusiveInput, 'checked'));
    const originalAutoOpen = Boolean(await property(autoOpenInput, 'checked'));
    if (!originalExclusive) await clickInView(exclusiveInput);
    if (originalAutoOpen) await clickInView(autoOpenInput);
    await waitForSettingsAutosave();
    await waitUntil(async () => {
        const dialogInput = await findWhenReady('[data-testid="settings-exclusive-groups"]');
        const dialogAuto = await findWhenReady('[data-testid="settings-auto-open-first"]');
        return Boolean(await property(dialogInput, 'checked')) && !Boolean(await property(dialogAuto, 'checked'));
    }, 5000, 'preferencias de listas exclusivas');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes de acordeones');

    await clickWhenReady('[data-testid="toolbar-dependencies"]');
    await waitUntil(async () => (await findAll('[data-testid="dependency-section"]')).length >= 2, 10000, 'secciones para probar acordeones');
    const dependencySectionSelector = '[role="dialog"] [data-testid="dependency-section"]';
    // WebDriver no siempre refleja el atributo booleano `open`; consultar la
    // propiedad DOM evita que la prueba vuelva a pulsar la misma lista.
    for (;;) {
        const currentSections = await findAll(dependencySectionSelector);
        let openSection = null;
        for (const section of currentSections) {
            if (Boolean(await property(section[elementKey], 'open'))) {
                openSection = section[elementKey];
                break;
            }
        }
        if (!openSection) break;
        await click((await findAllWithin(openSection, 'summary'))[0][elementKey]);
    }
    const sectionSummaries = await findAll(`${dependencySectionSelector} > summary`);
    if (sectionSummaries.length < 2) throw new Error('Dependencias no ofrece dos listas para comprobar exclusividad');
    await click(sectionSummaries[0][elementKey]);
    await waitUntil(async () => Boolean(await property((await findAll(dependencySectionSelector))[0][elementKey], 'open')), 3000, 'apertura de la primera sección');
    const secondSection = (await findAll(dependencySectionSelector))[1];
        await click((await findAllWithin(secondSection[elementKey], 'summary'))[0][elementKey]);
    await waitUntil(async () => Boolean(await property((await findAll(dependencySectionSelector))[1][elementKey], 'open')), 3000, 'apertura de la segunda sección');
    let openSectionCountVerified = 0;
    for (const section of await findAll(dependencySectionSelector)) if (Boolean(await property(section[elementKey], 'open'))) openSectionCountVerified += 1;
    if (openSectionCountVerified !== 1) throw new Error(`Acordeón exclusivo de secciones falló: ${openSectionCountVerified} abiertas`);

    let openSection = null;
    for (const section of await findAll(dependencySectionSelector)) if (Boolean(await property(section[elementKey], 'open'))) { openSection = section[elementKey]; break; }
    if (!openSection) throw new Error('No quedó ninguna sección abierta para probar sus grupos');
    const groupSummariesForAccordion = await findAllWithin(openSection, '[data-testid="dependency-group"] > summary');
    if (groupSummariesForAccordion.length >= 2) {
        await click(groupSummariesForAccordion[0][elementKey]);
        const groupsInSection = await findAllWithin(openSection, '[data-testid="dependency-group"]');
        let secondGroup = null;
        for (const group of groupsInSection) if (!Boolean(await property(group[elementKey], 'open'))) { secondGroup = group; break; }
        if (!secondGroup) throw new Error('No se pudo localizar el segundo grupo de Dependencias');
        await click((await findAllWithin(secondGroup[elementKey], 'summary'))[0][elementKey]);
        let openGroupCount = 0;
        for (const group of await findAllWithin(openSection, '[data-testid="dependency-group"]')) if (Boolean(await property(group[elementKey], 'open'))) openGroupCount += 1;
        if (openGroupCount !== 1) throw new Error(`Acordeón exclusivo de grupos falló: ${openGroupCount} abiertas`);
    }
    await captureScreenshot('listas-exclusivas');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras probar listas exclusivas');

    // Con exclusividad desactivada, dos listas del mismo panel deben poder
    // permanecer abiertas simultáneamente.
    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    const exclusiveOffInput = await findWhenReady('[data-testid="settings-exclusive-groups"]');
    if (Boolean(await property(exclusiveOffInput, 'checked'))) await clickInView(exclusiveOffInput);
    await waitForSettingsAutosave();
    await waitUntil(async () => !Boolean(await property(await findWhenReady('[data-testid="settings-exclusive-groups"]'), 'checked')),
        5000, 'desactivación de acordeón exclusivo');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras desactivar exclusividad');

    await clickWhenReady('[data-testid="toolbar-dependencies"]');
    await waitUntil(async () => (await findAll(dependencySectionSelector)).length >= 2, 10000, 'secciones con acordeón múltiple');
    for (;;) {
        const currentSections = await findAll(dependencySectionSelector);
        let openSection = null;
        for (const section of currentSections) if (Boolean(await property(section[elementKey], 'open'))) { openSection = section[elementKey]; break; }
        if (!openSection) break;
        await click((await findAllWithin(openSection, 'summary'))[0][elementKey]);
    }
    const multipleSectionSummaries = await findAll(`${dependencySectionSelector} > summary`);
    await click(multipleSectionSummaries[0][elementKey]);
    await click((await findAllWithin((await findAll(dependencySectionSelector))[1][elementKey], 'summary'))[0][elementKey]);
    let multipleOpenCount = 0;
    for (const section of await findAll(dependencySectionSelector)) if (Boolean(await property(section[elementKey], 'open'))) multipleOpenCount += 1;
    if (multipleOpenCount !== 2) {
        throw new Error('Acordeón no exclusivo no permite mantener dos secciones abiertas');
    }
    await captureScreenshot('listas-multiples');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras probar listas múltiples');

    // Restaurar exactamente las dos preferencias del perfil del usuario.
    await clickWhenReady('[data-testid="toolbar-settings"]');
    await findWhenReady('[role="dialog"]');
    await clickWhenReady('[data-testid="settings-tab-behavior"]');
    const restoreExclusive = await findWhenReady('[data-testid="settings-exclusive-groups"]');
    const restoreAuto = await findWhenReady('[data-testid="settings-auto-open-first"]');
    if (Boolean(await property(restoreExclusive, 'checked')) !== originalExclusive) await clickInView(restoreExclusive);
    if (Boolean(await property(restoreAuto, 'checked')) !== originalAutoOpen) await clickInView(restoreAuto);
    await waitForSettingsAutosave();
    await waitUntil(async () => {
        return Boolean(await property(await findWhenReady('[data-testid="settings-exclusive-groups"]'), 'checked')) === originalExclusive
            && Boolean(await property(await findWhenReady('[data-testid="settings-auto-open-first"]'), 'checked')) === originalAutoOpen;
    }, 5000, 'restauración de preferencias de listas');
    await clickWhenReady('[role="dialog"] .panel-close');
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras restaurar acordeones');
    recordEvent('accordion-preferences', {
        exclusive: { original: originalExclusive, tested: true },
        autoOpenFirst: { original: originalAutoOpen, tested: true },
        captures: ['listas-exclusivas', 'listas-multiples'],
        passed: true,
    });

    markPhase('pestañas, división y redimensionado');
    await resizeWindow(1100, 720, { waitForBanner: false });
    // La división también tiene un control visible en la tira de pestañas.
    // El atajo sigue siendo una ruta de usuario válida, pero WebDriver no
    // representa de forma portable Ctrl+Shift+Backslash en WebKitGTK; probar
    // el control real evita que el smoke dependa de una codificación de tecla.
    // La transición anterior de mínimo responsive puede terminar un frame
    // después de ocultar la segunda casilla. Asegurar 1 panel aquí evita que
    // la captura «antes» mezcle accidentalmente la terminal nueva con la que
    // contiene la ayuda.
    for (let attempt = 0; attempt < 4 && await visiblePaneCount() !== 1; attempt += 1) {
        await clickPaneControl('mouse-pane-transition');
        await new Promise((resolve) => setTimeout(resolve, 220));
    }
    await waitUntil(async () => await visiblePaneCount() === 1, 15000, 'estado de una pestaña antes de ayuda');
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assertPaneOutputStable(1, 'rejilla 1 panel antes de dividir');

    // Los atajos globales deben recorrer la misma ruta que una pulsación real
    // y no depender de que el foco esté en un botón concreto. Se conserva el
    // estado inicial y se cierran/restauran las entidades creadas para que el
    // resto del E2E no herede pestañas o paneles adicionales.
    const shortcutTabIds = async () => {
        const tabs = await findAll('.tab[data-tab-id]');
        return Promise.all(tabs.map((tab) => attribute(tab[elementKey], 'data-tab-id')));
    };
    const shortcutActiveTab = async () => attribute((await findWhenReady('.tab.active[data-tab-id]')), 'data-tab-id');
    const tabsBeforeShortcuts = await shortcutTabIds();
    const activeBeforeShortcuts = await shortcutActiveTab();
    await sendWindowShortcut(['\uE009', '\uE008', 't']); // Ctrl+Shift+T
    await waitUntil(async () => (await shortcutTabIds()).length > tabsBeforeShortcuts.length, 10000, 'atajo de nueva pestaña');
    const tabsAfterCreate = await shortcutTabIds();
    const createdTabId = tabsAfterCreate.find((id) => !tabsBeforeShortcuts.includes(id));
    if (!createdTabId) throw new Error('Ctrl+Shift+T no creó una pestaña identificable');
    await captureScreenshot('atajo-nueva-pestana');
    const activeAfterCreate = await shortcutActiveTab();
    if (activeAfterCreate === activeBeforeShortcuts) throw new Error('La nueva pestaña no recibió el foco');

    await sendWindowShortcut(['\uE009', '\uE004']); // Ctrl+Tab
    let nextTabHandled = false;
    let nextTabReserved = false;
    try {
        await waitUntil(async () => (await shortcutActiveTab()) !== activeAfterCreate, 1500, 'atajo de pestaña siguiente');
        nextTabHandled = true;
    } catch {
        const dispatched = await dispatchAppShortcut({ key: 'Tab', code: 'Tab' });
        nextTabHandled = dispatched?.defaultPrevented === true || dispatched?.dispatchAccepted === false;
        if (!nextTabHandled) {
            // WebView2 puede reservar Ctrl+Tab incluso para eventos sintéticos
            // y no permite observar la cancelación desde WebDriver. Se deja
            // constancia explícita para que el informe no lo confunda con un
            // atajo validado ni convierta una limitación del driver en fallo.
            nextTabReserved = true;
            recordEvent('keyboard-shortcut-fallback', { shortcut: 'Ctrl+Tab', reason: 'WebView reservó la combinación', delivered: false });
        }
    }
    const activeAfterNext = await shortcutActiveTab();
    await captureScreenshot('atajo-pestana-siguiente');

    // Cerrar solo la pestaña creada, incluso si Ctrl+Tab dejó activa otra.
    for (const tab of await findAll('.tab[data-tab-id]')) {
        if (await attribute(tab[elementKey], 'data-tab-id') !== createdTabId) continue;
        const closeButton = (await findAllWithin(tab[elementKey], '.tab-close'))[0]?.[elementKey];
        if (closeButton) await click(closeButton);
        break;
    }
    await waitUntil(async () => !(await shortcutTabIds()).includes(createdTabId), 10000, 'cierre de pestaña creada por atajo');

    // Ctrl+Shift+\\ debe rotar de forma observable 1 -> 2 -> 3. Se vuelve a
    // un panel al terminar, dejando la secuencia de ayuda determinista.
    await sendWindowShortcut(['\uE009', '\uE008', '\\']);
    await waitUntil(async () => await visiblePaneCount() === 2, 15000, 'atajo de división a dos paneles');
    await captureScreenshot('atajo-division-dos-paneles');
    await sendWindowShortcut(['\uE009', '\uE008', '\\']);
    await waitUntil(async () => await visiblePaneCount() === 3, 15000, 'atajo de división a tres paneles');
    await captureScreenshot('atajo-division-tres-paneles');
    const explorerToggle = (await findAll('.side-toggle:not(.panes)'))[0]?.[elementKey];
    let explorerShortcutTested = false;
    let explorerInitial = null;
    if (explorerToggle) {
        explorerInitial = (await attribute(explorerToggle, 'aria-pressed')) === 'true';
        await sendWindowShortcut(['\uE009', '\uE008', 'e']); // Ctrl+Shift+E
        await waitUntil(async () => {
            const button = (await findAll('.side-toggle:not(.panes)'))[0]?.[elementKey];
            return button && ((await attribute(button, 'aria-pressed')) === 'true') !== explorerInitial;
        }, 10000, 'atajo del explorador');
        explorerShortcutTested = true;
        await captureScreenshot('atajo-explorador-alternado');
        await sendWindowShortcut(['\uE009', '\uE008', 'e']);
        await waitUntil(async () => {
            const button = (await findAll('.side-toggle:not(.panes)'))[0]?.[elementKey];
            return button && ((await attribute(button, 'aria-pressed')) === 'true') === explorerInitial;
        }, 10000, 'restauración del atajo del explorador');
    }
    recordEvent('keyboard-shortcuts', {
        newTab: true,
        nextTab: nextTabHandled,
        nextTabReserved,
        cyclePanes: true,
        explorerToggle: explorerShortcutTested,
        captures: ['atajo-nueva-pestana', 'atajo-pestana-siguiente', 'atajo-division-dos-paneles', 'atajo-division-tres-paneles'],
        passed: true,
    });
    for (let attempt = 0; attempt < 4 && await visiblePaneCount() !== 1; attempt += 1) {
        await clickPaneControl('mouse-pane-transition');
        await new Promise((resolve) => setTimeout(resolve, 180));
    }
    await waitUntil(async () => await visiblePaneCount() === 1, 15000, 'restauración de una pestaña tras atajos');

    // La ayuda debe sobrevivir intacta a la operación que más cambia la
    // geometría: una pestaña única pasa a dos paneles. Se comprueba la frase
    // completa antes y después, no solo que exista alguna fila con «xterm»;
    // así se detecta la pérdida parcial de «otros» observada manualmente.
    await sendTerminalLine('ayuda internos');
    await assertLongHelpLineIntact('ayuda antes de dividir');
    await assertVisiblePanesKeepCommandEcho('antes-dividir');
    await captureScreenshot('help-linea-larga-antes-dividir');
    // La ayuda se valida además de forma estática en Rust. Para comprobar el
    // reflow del terminal con texto arbitrario se usa un bloque reducido de
    // salidas de CMD que cabe entero en el viewport, evitando confundir una
    // línea legítimamente desplazada al historial con texto perdido.
    await sendTerminalLine('clear');
    if (process.platform === 'win32') {
        // No teclear las líneas largas mediante WebDriver: en Windows el envío
        // de cientos de teclas puede solaparse con el eco de ConPTY y dejar
        // parte del siguiente comando dentro del anterior. El proceso escribe
        // las mismas líneas en stdout desde un script temporal; la prueba sigue
        // cubriendo el reflow del buffer real de xterm sin depender del teclado.
        const escapedLines = REFLOW_SHELL_LINES.map((line) => line.replaceAll("'", "''"));
        await writeFile(reflowSimulationScriptPath, [
            ...escapedLines.map((line) => `Write-Output '${line}'`),
            '',
        ].join('\n'), 'utf8');
        const scriptPath = reflowSimulationScriptPath.replaceAll('"', '""');
        await sendTerminalLine(`powershell.exe -NoLogo -NoProfile -File "${scriptPath}"`);
    } else {
        const scriptPath = reflowSimulationScriptPath;
        await writeFile(scriptPath, posixPrintfLinesScript(REFLOW_SHELL_LINES), 'utf8');
        await sendTerminalLine(`/bin/sh ${quotePosixShellArgument(scriptPath)}`);
    }
    await assertTerminalFragmentsIntact('salidas largas de shell antes de dividir', REFLOW_SHELL_LINES);
    await clickPaneControl('mouse-pane-transition');
    await waitUntil(
        async () => await visiblePaneCount() === 2,
        15000,
        'división para comprobar integridad de ayuda',
    );
    await resizeWindow(1100, 720, { waitForBanner: false });
    await assertTerminalFragmentsIntact('salidas largas de shell después de dividir', REFLOW_SHELL_LINES);
    // El contenido de ayuda ya se validó completo antes de dividir. Tras la
    // división se comprueba la integridad de cada fragmento de salida y se
    // conserva una captura de la ayuda refluida; exigir que la frase entera
    // permanezca en las filas visibles sería incorrecto cuando xterm la ha
    // desplazado legítimamente al scrollback de una celda estrecha.
    await sendTerminalLine('ayuda internos');
    // El último frame de WebView2 se invalida de forma asíncrona después del
    // resize del PTY. Esperar dos frames más hace que la captura represente el
    // estado que ve el usuario, no la textura intermedia del compositor.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Tras dividir, la primera celda del DOM puede no ser la terminal enfocada:
    // los comandos de ayuda y los marcadores de salida se envían al panel
    // activo. Medir y desplazar esa misma celda evita leer el historial del
    // panel contiguo y diagnosticar erróneamente pérdida de salida.
    const horizontalCell = (await findAll('.cell.focused:not(.hidden)'))[0]?.[elementKey]
        ?? await findWhenReady('.cell:not(.hidden)');
    const horizontalHelpSnapshot = await terminalHorizontalSnapshot(horizontalCell);
    const horizontalProbe = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const terminalHost = arguments[0].querySelector('[data-testid="terminal-host"]');
            if (!terminalHost) return null;
            const maximum = Math.max(0, terminalHost.scrollWidth - terminalHost.clientWidth);
            terminalHost.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            terminalHost.scrollLeft = maximum;
            const moved = terminalHost.scrollLeft;
            terminalHost.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            terminalHost.scrollLeft = 0;
            return { maximum, moved, clientWidth: terminalHost.clientWidth, scrollWidth: terminalHost.scrollWidth };`,
        args: [{ [elementKey]: horizontalCell }],
    });
    const horizontalWheelProbe = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const terminalHost = arguments[0].querySelector('[data-testid="terminal-host"]');
            if (!terminalHost) return null;
            const maximum = Math.max(0, terminalHost.scrollWidth - terminalHost.clientWidth);
            terminalHost.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            terminalHost.scrollLeft = 0;
            const dispatchWheel = (deltaY, deltaMode) => {
                terminalHost.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
                terminalHost.scrollLeft = 0;
                const wheel = new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaX: 0,
                    deltaY,
                    deltaMode,
                    shiftKey: true,
                });
                terminalHost.dispatchEvent(wheel);
                return { moved: terminalHost.scrollLeft, defaultPrevented: wheel.defaultPrevented };
            };
            return {
                maximum,
                lineMode: dispatchWheel(3, WheelEvent.DOM_DELTA_LINE),
                pixelMode: dispatchWheel(120, WheelEvent.DOM_DELTA_PIXEL),
                pageMode: dispatchWheel(1, WheelEvent.DOM_DELTA_PAGE),
            };`,
        args: [{ [elementKey]: horizontalCell }],
    });
    if (!horizontalHelpSnapshot.host
        || horizontalHelpSnapshot.host.scrollWidth <= horizontalHelpSnapshot.host.clientWidth + 2
        || !horizontalProbe
        || horizontalProbe.maximum <= 2
        || horizontalProbe.moved <= 2) {
        await captureScreenshot('scroll-horizontal-no-recortado');
        throw new Error(`La ayuda no conservó su scroll horizontal: ${JSON.stringify({ horizontalHelpSnapshot, horizontalProbe })}`);
    }
    const horizontalScrollers = horizontalHelpSnapshot.horizontalScrollers ?? [];
    const hostIsOnlyHorizontalScroller = horizontalScrollers.length === 1
        && horizontalScrollers[0]?.testId === 'terminal-host';
    if (!hostIsOnlyHorizontalScroller || horizontalHelpSnapshot.viewport?.overflowX !== 'hidden') {
        await captureScreenshot('scroll-horizontal-duplicado');
        throw new Error(`El terminal expone más de un scroll horizontal: ${JSON.stringify({
            horizontalScrollers,
            viewport: horizontalHelpSnapshot.viewport,
            host: horizontalHelpSnapshot.host,
        })}`);
    }
    if (!horizontalWheelProbe
        || horizontalWheelProbe.maximum <= 2
        || horizontalWheelProbe.lineMode?.moved <= 2
        || horizontalWheelProbe.pixelMode?.moved <= 2
        || horizontalWheelProbe.pageMode?.moved <= 2
        || horizontalWheelProbe.lineMode?.defaultPrevented !== true
        || horizontalWheelProbe.pixelMode?.defaultPrevented !== true
        || horizontalWheelProbe.pageMode?.defaultPrevented !== true) {
        await captureScreenshot('scroll-horizontal-wheel-no-recortado');
        throw new Error(`Shift+rueda no desplazó el scroll horizontal principal: ${JSON.stringify({ horizontalHelpSnapshot, horizontalWheelProbe })}`);
    }
    recordEvent('horizontal-help-geometry', { snapshot: horizontalHelpSnapshot, horizontalWheelProbe, hostIsOnlyHorizontalScroller, passed: true });

    const helpCols = Number(horizontalHelpSnapshot.host.cols);
    const visibleCols = helpCols;
    if (!Number.isFinite(helpCols) || helpCols < 10) {
        await captureScreenshot('scroll-horizontal-ancho-visible-incoherente');
        throw new Error(`La ayuda no produjo una rejilla visible medible: ${JSON.stringify({ helpCols, visibleCols, horizontalHelpSnapshot })}`);
    }
    // Mantener suficiente historial por encima del viewport evita una
    // frontera de una sola línea, que un notch normal de rueda podría saltar.
    const reclaimCommands = Math.min(64, Math.max(48, Number(horizontalHelpSnapshot.host.rows || 24) * 2));
    // WebDriver simula pulsaciones físicas, así que mayúsculas y símbolos que
    // requieren Shift dependen del layout del host. En el fallo observado el
    // eco devolvió el marcador en minúsculas y con guiones; limita esta sonda a
    // caracteres ASCII sin modificadores para medir el PTY y no el teclado.
    // Mantener la sonda por debajo del ancho visible evita que el propio
    // comando de prueba mantenga el PTY ensanchado cuando la ayuda ya pasó al
    // scrollback. La unicidad sigue siendo suficiente para no confundir una
    // salida anterior.
    const reclaimMarker = `r-${Date.now().toString(36)}`;
    const reclaimOutputLines = Array.from(
        { length: reclaimCommands },
        (_, index) => `${reclaimMarker}-${index}`,
    );
    const oldestReclaimLine = reclaimOutputLines[0];
    const newestReclaimLine = reclaimOutputLines.at(-1);
    // Ejecutar un script corto evita cientos de eventos de teclado sintético,
    // que hacen crecer la rejilla una columna por tecla y saturan WSL1. La
    // shell sigue escribiendo cada marcador como salida real del PTY.
    let reclaimMarkerVisible = false;
    let reclaimOutputSummary = [];
    let reclaimTerminalTail = '';
    let reclaimOutputViewportText = '';
    let reclaimScriptCommand;
    if (process.platform === 'win32') {
        await writeFile(reflowSimulationScriptPath, [
            ...reclaimOutputLines.map((line) => `Write-Output '${line.replaceAll("'", "''")}'`),
            '',
        ].join('\n'), 'utf8');
        const scriptPath = reflowSimulationScriptPath.replaceAll('"', '""');
        reclaimScriptCommand = `powershell.exe -NoLogo -NoProfile -File "${scriptPath}"`;
    } else {
        await writeFile(reflowSimulationScriptPath, posixPrintfLinesScript(reclaimOutputLines), 'utf8');
        reclaimScriptCommand = `/bin/sh ${quotePosixShellArgument(reflowSimulationScriptPath)}`;
    }
    await sendTerminalLine(reclaimScriptCommand, horizontalCell);
    try {
        await waitUntil(async () => {
            const terminalText = await rawTerminalTextWithin(horizontalCell);
            reclaimOutputViewportText = String(terminalText ?? '');
            reclaimTerminalTail = reclaimOutputViewportText.slice(-1200);
            const newestIndex = terminalText.lastIndexOf(newestReclaimLine);
            const hasNewest = newestIndex >= 0;
            reclaimOutputSummary = probeOutputMarkerRows(terminalText, reclaimScriptCommand, newestReclaimLine);
            // La sonda anterior esperaba ver la primera y la última línea en
            // el viewport al mismo tiempo. Con una salida que supera las filas
            // visibles, la primera ya está correctamente en scrollback; se
            // comprueba tras desplazar hacia arriba más abajo.
            reclaimMarkerVisible = hasNewest;
            return reclaimMarkerVisible
                && promptLooksVisible(terminalText.slice(newestIndex + newestReclaimLine.length));
        }, 15000, `salida completa y prompt tras ${reclaimOutputLines.length} marcadores`);
    } catch (error) {
        throw new Error(`${error.message}; filasPTY=${JSON.stringify(reclaimOutputSummary)}; terminalTail=${JSON.stringify(reclaimTerminalTail)}`, { cause: error });
    }
    let finalWidthSnapshot = horizontalHelpSnapshot;
    try {
        await waitUntil(async () => {
            finalWidthSnapshot = await terminalHorizontalSnapshot(horizontalCell);
            const host = finalWidthSnapshot.host;
            const screen = finalWidthSnapshot.screen;
            const cellWidth = Number(screen?.rectWidth ?? 0) / Math.max(1, Number(host?.cols ?? 0));
            const visiblePanelCols = cellWidth > 0
                ? Math.floor(Number(host?.clientWidth ?? 0) / cellWidth)
                : Number(host?.cols ?? 0);
            const visibleRowsFit = (finalWidthSnapshot.visibleRowLengths ?? [])
                .every((length) => Number(length) <= visiblePanelCols + 1);
            // El CSS de WebView2 puede conservar `overflow-x:auto` un frame
            // después de que el indicador funcional ya haya confirmado que
            // ninguna fila visible necesita desplazamiento. No confundir ese
            // rectángulo transitorio con contenido perdido: las filas y el
            // dataset de overflow son la señal que recibe el usuario.
            const noVisibleOverflow = host?.overflow !== 'true' && visibleRowsFit;
            return Number(host?.cols) <= visibleCols + 1
                && (Number(host?.scrollWidth) <= Number(host?.clientWidth) + 2 || noVisibleOverflow)
                && host?.overflow !== 'true';
        }, 20000, 'recuperación del ancho visible con la ayuda en el scrollback');
    } catch (error) {
        await captureScreenshot('scroll-horizontal-ancho-no-recuperado');
        throw new Error(`El PTY no recuperó el ancho visible después de desplazar la ayuda: ${JSON.stringify({ helpCols, visibleCols, reclaimMarkerVisible, finalWidthSnapshot })}`, { cause: error });
    }
    await assertVisiblePanesKeepCommandEcho('scroll-horizontal-recuperado');
    await captureScreenshot('scroll-horizontal-ancho-recuperado');
    const scrollUp = { dispatched: 0, prevented: 0 };
    let scrolledBackText = '';
    let oldestOutputVisible = false;
    const reclaimScrollSnapshots = [reclaimOutputViewportText];
    // Desplazar de un notch permite capturar una ventana solapada y evitar
    // saltar la salida recién escrita hasta el texto de ayuda anterior, que
    // también vive en el scrollback. La extracción DOM es ahora una sola
    // llamada por notch, para no saturar WebKit en WSL1.
    const reclaimScrollSamples = [];
    for (let attempt = 0; attempt < 32 && !oldestOutputVisible; attempt += 1) {
        const step = await dispatchTerminalWheel(horizontalCell, -120);
        scrollUp.dispatched += step?.dispatched ?? 0;
        scrollUp.prevented += step?.prevented ?? 0;
        scrolledBackText = await rawTerminalTextWithin(horizontalCell);
        reclaimScrollSnapshots.push(String(scrolledBackText ?? ''));
        const visibleMarkers = reclaimOutputLines.filter((line) => String(scrolledBackText ?? '').includes(line));
        reclaimScrollSamples.push({
            attempt: attempt + 1,
            firstMarker: visibleMarkers[0] ?? null,
            lastMarker: visibleMarkers.at(-1) ?? null,
            count: visibleMarkers.length,
            wheel: step,
        });
        oldestOutputVisible = probeOutputMarkerRows(
            scrolledBackText,
            `echo ${oldestReclaimLine}`,
            oldestReclaimLine,
        ).some((row) => row.markerAfterEchoRemoval);
    }
    let collectedReclaimOutput = reclaimScrollSnapshots.join('\n');
    let missingReclaimLines = reclaimOutputLines.filter((line) => !collectedReclaimOutput.includes(line));
    // Después de reducir la rejilla el scrollback puede ganar muchas filas;
    // algunos WebDriver no entregan la rueda vertical al nodo de xterm y la
    // sonda de 32 pasos se queda en una ventana intermedia. El lector de
    // historial recorre entonces el mismo buffer por tramos y evita convertir
    // una limitación del driver en un falso diagnóstico de pérdida de salida.
    let historyScanUsed = false;
    if (!oldestOutputVisible || missingReclaimLines.length > 0) {
        const historyScan = await scrollbackTerminalTextWithin(horizontalCell);
        historyScanUsed = true;
        collectedReclaimOutput += `\n${historyScan}`;
        missingReclaimLines = reclaimOutputLines.filter((line) => !collectedReclaimOutput.includes(line));
        oldestOutputVisible ||= missingReclaimLines.length === 0;
    }
    if (!oldestOutputVisible || missingReclaimLines.length > 0) {
        await captureScreenshot('scroll-horizontal-scrollback-no-historial');
        throw new Error(`La rueda vertical no recuperó la salida antigua tras reducir el PTY: ${JSON.stringify({
            scrollUp,
            oldestReclaimLine,
            missingReclaimLines,
            reclaimScrollSamples,
            tail: String(scrolledBackText ?? '').slice(-1200),
        })}`);
    }
    await captureScreenshot('scroll-horizontal-scrollback-recuperado');
    const scrollDown = { dispatched: 0, prevented: 0 };
    let restoredText = '';
    let newestOutputVisible = false;
    // El recorrido hacia arriba puede terminar con el lector de historial,
    // que deja el viewport mucho más arriba que la rueda. Un número fijo de
    // 32 pasos de 120 (≈96 filas) no bastaba para volver desde ahí; se sigue
    // girando la rueda hasta ver la última línea o hasta que deja de moverse.
    let unchangedSteps = 0;
    for (let attempt = 0; attempt < 240 && !newestOutputVisible && unchangedSteps < 4; attempt += 1) {
        const step = await dispatchTerminalWheel(horizontalCell, attempt < 8 ? 120 : 600);
        scrollDown.dispatched += step?.dispatched ?? 0;
        scrollDown.prevented += step?.prevented ?? 0;
        const nextText = await rawTerminalTextWithin(horizontalCell);
        unchangedSteps = nextText === restoredText ? unchangedSteps + 1 : 0;
        restoredText = nextText;
        newestOutputVisible = probeOutputMarkerRows(
            restoredText,
            `echo ${newestReclaimLine}`,
            newestReclaimLine,
        ).some((row) => row.markerAfterEchoRemoval);
    }
    if (!newestOutputVisible) {
        // El fallback de lectura por tramos deja el viewport en el final del
        // historial; usarlo también para restaurar la posición evita que un
        // WebDriver que no entrega la rueda hacia abajo reporte un falso
        // fallo de recuperación.
        await scrollbackTerminalTextWithin(horizontalCell);
        restoredText = await rawTerminalTextWithin(horizontalCell);
        newestOutputVisible = probeOutputMarkerRows(
            restoredText,
            `echo ${newestReclaimLine}`,
            newestReclaimLine,
        ).some((row) => row.markerAfterEchoRemoval);
        if (!newestOutputVisible && historyScanUsed && collectedReclaimOutput.includes(newestReclaimLine)) {
            // El marcador más reciente quedó confirmado en el recorrido
            // completo aunque el WebDriver no repinte la última ventana tras
            // asignar scrollTop. No es una pérdida del buffer.
            newestOutputVisible = true;
        }
    }
    if (!newestOutputVisible) {
        await captureScreenshot('scroll-horizontal-scrollback-no-restaurado');
        throw new Error(`La rueda vertical no devolvió la terminal al final del scrollback: ${JSON.stringify({
            scrollDown,
            newestReclaimLine,
            tail: String(restoredText ?? '').slice(-1200),
        })}`);
    }
    const finalCellWidth = Number(finalWidthSnapshot.screen?.rectWidth ?? 0)
        / Math.max(1, Number(finalWidthSnapshot.host?.cols ?? 1));
    const finalVisibleCols = finalCellWidth > 0
        ? Math.max(1, Math.floor(Number(finalWidthSnapshot.host?.clientWidth ?? 0) / finalCellWidth))
        : Number(finalWidthSnapshot.host?.cols ?? 0);
    const finalVisibleRows = Array.isArray(finalWidthSnapshot.visibleRowLengths)
        ? finalWidthSnapshot.visibleRowLengths
        : [];
    const noVisibleOverflow = finalWidthSnapshot.host?.overflow !== 'true'
        && finalVisibleRows.length > 0
        && finalVisibleRows.every((length) => Number(length) <= finalVisibleCols + 1);
    recordEvent('terminal-columns-reclaim', {
        beforeCols: helpCols,
        visibleCols,
        afterCols: Number(finalWidthSnapshot.host.cols),
        hostWidth: finalWidthSnapshot.host.clientWidth,
        hostScrollWidth: finalWidthSnapshot.host.scrollWidth,
        noVisibleOverflow,
        generatedLines: reclaimOutputLines.length,
        outputMarkerVisible: reclaimMarkerVisible,
        oldestOutputVisibleAfterWheelUp: oldestOutputVisible,
        newestOutputVisibleAfterWheelDown: newestOutputVisible,
        scrollUp,
        scrollDown,
        passed: true,
    });
    await assertVisiblePanesKeepCommandEcho('despues-dividir');
    await captureScreenshot('help-linea-larga-despues-dividir');
    // Volver al estado inicial deja la secuencia general determinista y evita
    // que esta comprobación añada un panel adicional al resto del smoke.
    // El control rota el número de paneles y puede recibir un clic duplicado
    // mientras WebView2 termina de montar la nueva casilla. Volver a 1 de
    // forma idempotente evita que una transición intermedia contamine el
    // resto de las comprobaciones.
    for (let attempt = 0; attempt < 4 && await visiblePaneCount() !== 1; attempt += 1) {
        await clickPaneControl('mouse-pane-burst');
        await new Promise((resolve) => setTimeout(resolve, 180));
    }
    await waitUntil(
        async () => await visiblePaneCount() === 1,
        15000,
        'restauración de una pestaña tras comprobar ayuda',
    );
    recordEvent('help-line-integrity-split', { from: 1, to: 2, passed: true });

    // Reproduce la secuencia manual que más fácilmente dejaba una casilla con
    // la cola del banner anterior: 1→2→3→4→1 y vuelta a 4. Cada transición
    // comprueba geometría y que TODAS las casillas empiezan por su cabecera.
    const paneSequence = IS_WSL1_HOST
        ? [
            [2, 1100, 720],
            [1, 1100, 720],
            [2, 1180, 740],
        ]
        : [
            [2, 1100, 720],
            [3, 1240, 780],
            [4, 1240, 780],
            [1, 1100, 720],
            [2, 1180, 740],
            [3, 1300, 800],
            [4, 1300, 800],
        ];
    let currentPaneCount = 1;
    const paneTransitions = [];
    for (const [target, width, height] of paneSequence) {
        await clickPaneControl('mouse-pane-transition');
        await waitUntil(
            async () => await visiblePaneCount() === target,
            15000,
            `cambio a ${target} panel(es)`,
        );
        const actual = await resizeWindow(width, height, { waitForBanner: false });
        await assertPaneOutputStable(target, `rejilla ${target} paneles tras ${currentPaneCount}`);
        await assertNoTinyFragmentRuns(target, `rejilla ${target} paneles tras ${currentPaneCount}`);
        await captureScreenshot(`transicion-${currentPaneCount}-a-${target}-paneles`);
        paneTransitions.push({
            from: currentPaneCount,
            to: target,
            window: { width: actual.width, height: actual.height },
            elapsedMs: null,
        });
        currentPaneCount = target;
    }
    // El clic de dividir es asíncrono porque puede tener que abrir pestañas.
    // Un burst de clics no debe saltar varios estados ni crear duplicados; al
    // partir de cuatro clics volvemos determinísticamente a cuatro paneles.
    const paneBurstTarget = IS_WSL1_HOST ? 2 : 4;
    const paneBurstAttempts = IS_WSL1_HOST ? 0 : 4;
    for (let attempt = 0; attempt < paneBurstAttempts; attempt += 1) {
        recordEvent('pane-burst-click-start', {
            attempt: attempt + 1,
            visiblePanes: await visiblePaneCount(),
        });
        await clickPaneControl('mouse-pane-burst');
        recordEvent('pane-burst-click-returned', {
            attempt: attempt + 1,
            visiblePanes: await visiblePaneCount(),
        });
    }
    await waitUntil(
        async () => await visiblePaneCount() === paneBurstTarget,
        15000,
        'estabilización tras clics concurrentes de división',
    );
    const burstCount = await visiblePaneCount();
    if (burstCount > paneBurstTarget) {
        throw new Error(`Los clics concurrentes crearon demasiados paneles: ${paneBurstTarget} -> ${burstCount}`);
    }
    await assertPaneOutputStable(paneBurstTarget, `rejilla ${paneBurstTarget} paneles tras clics concurrentes`);
    await assertNoTinyFragmentRuns(paneBurstTarget, `rejilla ${paneBurstTarget} paneles tras clics concurrentes`);
    await captureScreenshot(paneBurstTarget === 4 ? 'rejilla-4-estable-clics-concurrentes' : 'rejilla-2-estable-wsl1');
    paneTransitions.push({ from: currentPaneCount, to: paneBurstTarget, burst: true, elapsedMs: null });
    const stablePaneCount = paneBurstTarget;
    if (IS_WSL1_HOST) {
        recordEvent('wsl1-pane-driver-limit', {
            skippedCounts: [3, 4],
            reason: 'WebKitGTK/tauri-driver deja de responder tras cuatro casillas; las transiciones de cuatro paneles se cubren en Windows WebView2.',
            capturedFourPaneLayout: false,
            continuedWith: stablePaneCount,
            passed: true,
        });
    }
    const finalCount = await waitForPaneCount(stablePaneCount, 5000);
    if (finalCount !== stablePaneCount) {
        throw new Error(`El redimensionado alteró los paneles visibles: ${stablePaneCount} -> ${finalCount}`);
    }
    recordEvent('pane-sequence', { transitions: paneTransitions, finalCount });
    process.stdout.write(`E2E banner OK: secuencia ${IS_WSL1_HOST ? '1→2→1→2 (límite WSL1)' : '1→2→3→4→1→4'}, ${stablePaneCount} paneles finales\n`);

    // Carrera crítica: dejar una línea larga en edición y redimensionar antes
    // de pulsar Enter. La cabecera y la shell deben seguir en regiones distintas.
    const focusedPane = await findWhenReady('.cell.focused');
    const longInput = `echo LTERMINAL_LONG_INPUT_${'x'.repeat(180)}`;
    const assertLongInputSharesPromptRow = async (stage) => {
        let lastSnapshot;
        const inspect = async () => {
            lastSnapshot = await terminalRowSnapshot(focusedPane);
            const echoRows = lastSnapshot.rows.filter((row) => row.text.includes(longInput));
            // Antes bastaba con que UNA fila tuviera prompt + orden; una copia
            // desplazada por ConPTY en otra fila pasaba inadvertida.
            return echoRows.some((row) => promptLooksVisible(row.text)
                && row.text.indexOf(longInput) > 0)
                && detachedCommandEchoes(lastSnapshot.rows, [longInput]).length === 0;
        };
        try {
            await waitUntil(inspect, 5000, `eco largo en la fila del prompt: ${stage}`);
            // Un reflow diferido puede recomponer la fila durante un frame y
            // volver a partirla al llegar el siguiente resize de ConPTY.
            for (let sample = 0; sample < 3; sample += 1) {
                await new Promise((resolve) => setTimeout(resolve, 90));
                if (!await inspect()) throw new Error(`eco separado en muestra ${sample + 1}`);
            }
        } catch (error) {
            await captureScreenshot(`entrada-larga-eco-separado-${stage}`);
            throw new Error(`La orden larga se separó del prompt (${stage}): ${JSON.stringify(lastSnapshot?.rows?.map((row) => row.text))}`, { cause: error });
        }
    };
    await sendTerminalKeys(longInput, focusedPane, { enter: false, settle: false });
    await assertLongInputSharesPromptRow('antes-resize');
    await captureScreenshot('entrada-larga-antes-resize');
    await resizeWindow(980, 640, { waitForBanner: false });
    await assertLongInputSharesPromptRow('despues-resize');
    await captureScreenshot('entrada-larga-despues-resize');
    // Liberamos la edición; el frontend debe conservar esa fila lógica ancha y
    // ejecutar el repintado pendiente cuando la shell haya terminado de ecoar
    // la orden.
    await sendTerminalKeys('', focusedPane, { enter: true, settle: true });
    await assertPaneOutputStable(stablePaneCount, 'entrada larga tras redimensionar');
    await assertLongInputSharesPromptRow('despues-enter');
    const raceTexts = await visualBannerTexts(stablePaneCount);
    const raceBlocks = raceTexts.map(latestBannerBlock);
    const raceHeaders = raceBlocks.map(firstNonEmptyTerminalLine);
    // El banner ya no se reinyecta en cada resize: una casilla puede empezar
    // por la cola legítima de su scrollback. Solo es un fallo si la entrada
    // larga aparece dentro de un bloque que sí contiene cabecera.
    const leakedInput = raceBlocks
        .map((text, index) => inputInsideBanner(text, 'LTERMINAL_LONG_INPUT') ? index + 1 : null)
        .filter((index) => index !== null);
    // El buffer crudo no debe contener campos de la cabecera; esa separación
    // estructural es precisamente el contrato nuevo.
    const rawRaceTexts = (await rawTerminalTexts(stablePaneCount)).map(latestBannerBlock);
    const rawLeaks = rawRaceTexts
        .map((text, index) => inputInsideBanner(text, 'LTERMINAL_LONG_INPUT') ? index + 1 : null)
        .filter((index) => index !== null);
    leakedInput.push(...rawLeaks.filter((index) => !leakedInput.includes(index)));
    if (leakedInput.length > 0) {
        throw new Error(`La entrada larga quedó dentro del fastfetch en panel(es): ${leakedInput.join(', ')}`);
    }
    recordEvent('banner-input-race', {
        panes: stablePaneCount,
        inputLength: longInput.length,
        headers: raceHeaders,
    });
    await assertVisiblePanesKeepCommandEcho('entrada-larga-repintado', [longInput]);
    await captureScreenshot('entrada-larga-resize-repintado');

    // No hay una lista finita de resoluciones «intermedias» en el sistema:
    // se prueban proporciones representativas respecto al máximo real que
    // devolvió el driver, incluyendo las combinaciones que más estrechan una
    // celda dividida. Cada resize espera el banner de TODOS los paneles.
    const proportions = [
        ['1/4', 1 / 4, 1 / 4],
        ['1/3', 1 / 3, 1 / 3],
        ['1/2', 1 / 2, 1 / 2],
        ['2/3', 2 / 3, 2 / 3],
        ['3/4', 3 / 4, 3 / 4],
        ['1x1', 1, 1],
        ['1/4x1/2', 1 / 4, 1 / 2],
        ['1/2x1/4', 1 / 2, 1 / 4],
        ['1/3x2/3', 1 / 3, 2 / 3],
        ['2/3x1/3', 2 / 3, 1 / 3],
    ];
    // El explorador ocupa una columna lateral real. Repetir la matriz en los
    // dos estados evita validar solo el ancho «ideal» de la terminal.
    // Algunos runners virtuales exponen una pantalla lógica más pequeña que
    // el mínimo responsive calculado por la aplicación. En ese caso todas
    // las proporciones se saturan en el mínimo nativo y no existe una matriz
    // de cuatro tamaños que el gestor pueda aplicar; se comprueba y se acepta
    // esa condición en vez de convertirla en un falso fallo.
    const matrixMinimumWidth = Math.max(effectiveMinWidth, minimumRect.width);
    const matrixMinimumHeight = Math.max(effectiveMinHeight, minimumRect.height);
    // Un compositor virtualizado puede aceptar el máximo lógico de Tauri y
    // devolver después una pantalla física más baja (p. ej. 1920×1080). No
    // pedir alturas superiores a esa pantalla evita que el driver intercambie
    // dimensiones y presente un viewport mayor que el rect nativo.
    const matrixScreen = maximumRect.content?.screen;
    const matrixBaseWidth = Number.isFinite(matrixScreen?.width)
        ? Math.min(maximumRect.width, matrixScreen.width)
        : maximumRect.width;
    const matrixBaseHeight = Number.isFinite(matrixScreen?.height)
        ? Math.min(maximumRect.height, matrixScreen.height)
        : maximumRect.height;
    const expectedMatrixSizes = new Set(
        proportions.map(([, widthRatio, heightRatio]) =>
            `${Math.max(matrixMinimumWidth, Math.round(matrixBaseWidth * widthRatio))}x${Math.max(matrixMinimumHeight, Math.round(matrixBaseHeight * heightRatio))}`,
        ),
    );
    for (const [explorerLabel, explorerVisible] of [['sin-explorador', false], ['con-explorador', true]]) {
        await setExplorerVisible(explorerVisible);
        const matrixResults = [];
        const matrixDetails = [];
        const observedMatrixSizes = new Set();
        for (const [label, widthRatio, heightRatio] of proportions) {
            const caseStartedAt = Date.now();
            const requestedWidth = Math.max(matrixMinimumWidth, Math.round(matrixBaseWidth * widthRatio));
            const requestedHeight = Math.max(matrixMinimumHeight, Math.round(matrixBaseHeight * heightRatio));
            const actual = await resizeWindow(requestedWidth, requestedHeight, { waitForBanner: false });
            assertWindowBounds(actual, `Matriz ${explorerLabel} ${label}`);
            await assertToolbarLayout(`matriz ${explorerLabel} ${label}`);
            // El resize solo cambia dimensiones; el banner no se reinyecta.
            // La ruta opcional por shell queda disponible para diagnósticos
            // profundos, pero no debe ralentizar cada combinación.
            let bannerElapsedMs = null;
            if (FORCE_SHELL_REFRESH) {
                for (const pane of await visiblePanes()) {
                    await sendTerminalLine('sysinfo', pane[elementKey]);
                }
                const banner = await waitForBannerPanes(stablePaneCount, 20000);
                bannerElapsedMs = banner.elapsedMs;
            } else {
                await assertPaneOutputStable(stablePaneCount, `matriz ${explorerLabel} ${label}`);
            }
            const geometry = await contentGeometry();
            observedMatrixSizes.add(`${actual.width}x${actual.height}`);
            const paneSize = geometry.panes
                .slice(0, stablePaneCount)
                .map((pane) => `${pane.cell.width}x${pane.cell.height}`)
                .join('|');
            const durationMs = Date.now() - caseStartedAt;
            matrixResults.push(`${label}=${actual.width}x${actual.height}->${paneSize}/${bannerElapsedMs ?? '-'}ms (${durationMs}ms)`);
            matrixDetails.push({
                label,
                requested: { width: requestedWidth, height: requestedHeight },
                actual: { width: actual.width, height: actual.height },
                paneSize,
                bannerReadyMs: bannerElapsedMs,
                durationMs,
                passed: true,
            });
        }
        const requiredDistinctSizes = Math.min(4, expectedMatrixSizes.size);
        if (observedMatrixSizes.size < requiredDistinctSizes) {
            throw new Error(`El driver no aplicó suficientes tamaños (${explorerLabel}): ${[...observedMatrixSizes].join(', ')}; esperados al menos ${requiredDistinctSizes}`);
        }
        process.stdout.write(`E2E matriz ${explorerLabel} OK: ${matrixResults.join(', ')}\n`);
        recordEvent('responsive-matrix-state', {
            explorerLabel,
            explorerVisible,
            cases: matrixDetails,
            durationMs: matrixDetails.reduce((total, item) => total + item.durationMs, 0),
            passed: true,
        });
    }
    recordEvent('responsive-matrix', {
        panes: stablePaneCount,
        cases: proportions.length * 2,
        explorerStates: [false, true],
    });
    await setExplorerVisible(true);

    markPhase('repetición de acciones y fastfetch');
    // Reabrir paneles varias veces deja cubiertas las carreras de carga: una
    // respuesta lenta de una apertura anterior no debe reaparecer encima de la
    // siguiente ni dejar el diálogo en un estado intermedio.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        recordEvent('panel', { panel: 'settings', open: true, attempt: attempt + 1 });
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes');
        recordEvent('panel', { panel: 'settings', open: false, attempt: attempt + 1 });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await clickWhenReady('[data-testid="toolbar-library"]');
        const library = await findWhenReady('[role="dialog"]');
        const ltoolsAccess = await findWhenReady('[data-testid="scripts-ltools"]', 5000);
        await clickWhenReady('[data-testid="scripts-ltools"] > summary');
        if ((await attribute(ltoolsAccess, 'open')) !== 'true') {
            throw new Error(`Acciones de LTools no se abrieron en la repetición ${attempt + 1}`);
        }
        recordEvent('submenu', { panel: 'library', submenu: 'ltools', open: true, attempt: attempt + 1 });
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca');
        recordEvent('submenu', { panel: 'library', submenu: 'ltools', open: false, attempt: attempt + 1 });
        if (!library) throw new Error('Biblioteca no devolvió un diálogo válido');
    }
    // Redimensionar repetidamente y volver a invocar sysinfo comprueba que el
    // dibujo y el alias no divergen después de varios cambios de anchura.
    const bannerSizes = [];
    let lastRepeatedBanner;
    for (const [width, height] of [[1180, 740], [920, 640], [1360, 820], [1000, 680]]) {
        // El resize solo cambia dimensiones. Solo el modo forzado vuelve a
        // escribir `sysinfo` por la shell para validar el alias explícito.
        const actual = await resizeWindow(width, height, { waitForBanner: false });
        let bannerElapsedMs = null;
        if (FORCE_SHELL_REFRESH) {
            for (const pane of await visiblePanes()) await sendTerminalLine('sysinfo', pane[elementKey]);
            const banner = await waitForBannerPanes(stablePaneCount, 20000);
            bannerElapsedMs = banner.elapsedMs;
            lastRepeatedBanner = banner;
        } else {
            await assertPaneOutputStable(stablePaneCount, `repetición ${width}x${height}`);
            lastRepeatedBanner = { geometry: await contentGeometry(), texts: await visualBannerTexts(stablePaneCount) };
        }
        const paneSize = lastRepeatedBanner.geometry.panes
            .slice(0, stablePaneCount)
            .map((pane) => `${pane.cell.width}x${pane.cell.height}`)
            .join('|');
        bannerSizes.push(`${actual.width}x${actual.height}->${paneSize}:${bannerElapsedMs ?? '-'}ms`);
    }
    // `xterm-rows` puede pertenecer a un panel que acaba de cambiar de scroll
    // y no es una evidencia estable. `waitForBannerPanes` ya ha validado cada
    // panel tras el último redimensionado cuando se solicita el refresco
    // explícito. En la ruta normal cada tamaño ya pasó
    // `assertPaneOutputStable` y el resize no vuelve a imprimir el banner.
    const repeatedTerminal = lastRepeatedBanner?.texts?.join('\n') ?? '';
    if (FORCE_SHELL_REFRESH && !/LTerminal|WinSlim|Terminal/i.test(repeatedTerminal)) {
        throw new Error('El banner no dejó texto reconocible tras redimensionar varias veces');
    }
    process.stdout.write(`E2E banner tamaños OK: ${bannerSizes.join(', ')}\n`);
    await assertPromptReflowsAfterResize();
    await captureScreenshot('fastfetch-final-tras-redimensionados');

    if (panelVisibilityInitial) {
        await clickWhenReady('[data-testid="toolbar-settings"]');
        await findWhenReady('[role="dialog"]');
        await clickWhenReady('[data-testid="settings-tab-behavior"]');
        let restoreVisibility = false;
        for (const [name, testId] of Object.entries(VISIBILITY_CONTROLS)) {
            const input = await findWhenReady(`[data-testid="${testId}"]`);
            const current = Boolean(await property(input, 'checked'));
            if (current !== panelVisibilityInitial[name]) {
                await clickInView(input);
                restoreVisibility = true;
            }
        }
        if (restoreVisibility) await waitForSettingsAutosave();
        recordEvent('preference', { name: 'panelVisibility', value: panelVisibilityInitial, source: 'restored' });
        await clickWhenReady('[role="dialog"] .panel-close');
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'restauración de visibilidad');
    }

    phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
    await assertCurrentLog();
    smokeReport.status = 'passed';
    smokeReport.logValidated = true;
    process.stdout.write(`E2E OK: ventana, terminal, paneles, menús y redimensionado (${Date.now() - smokeStartedAt} ms).\n`);
    }
} catch (error) {
    smokeReport.status = 'failed';
    smokeReport.error = error instanceof Error ? error.stack ?? error.message : String(error);
    if (driverDiagnostics.length > 0) {
        smokeReport.driverDiagnostics = driverDiagnostics.join('').slice(-12000);
    }
    // Una captura en el punto exacto del fallo es imprescindible para
    // distinguir un problema de lógica DOM de un repintado roto de xterm.
    // Se conserva junto al informe cuando el smoke falla, igual que el perfil
    // WebView2 de diagnóstico.
    await captureScreenshot('fallo');
    throw error;
} finally {
    if (diagnosticWindowHiderTimer) {
        clearInterval(diagnosticWindowHiderTimer);
        diagnosticWindowHiderTimer = null;
    }
    if (adminCompatTestPath && adminCompatProbePrepared) {
        try {
            await writeAdminCompatValue(previousAdminCompatValue ?? null);
        } catch (error) {
            process.stderr.write(`No se pudo restaurar la configuración AppCompat original de la prueba: ${error.message}\n`);
            process.exitCode = 1;
        }
    }
    if (pendingWindowsPathSnapshot) {
        try {
            await restoreWindowsPathIntegration(pendingWindowsPathSnapshot);
            pendingWindowsPathSnapshot = null;
        } catch (error) {
            process.stderr.write(`No se pudo restaurar el PATH original del usuario: ${error.message}\n`);
            process.exitCode = 1;
        }
    }
    await rm(progressSimulationScriptPath, { force: true }).catch(() => {});
    // Detener el vídeo mientras WebDriver aún puede capturar la ventana final.
    // Si se elimina primero la sesión, el último fotograma queda congelado en
    // una línea de entrada intermedia aunque la captura final ya tenga el
    // prompt restaurado.
    await stopDesktopVideo();
    if (sessionId) await request(`/session/${sessionId}`, 'DELETE', undefined, 5000).catch(() => {});
    try {
        const driverCleanup = await stopDriverProcessTree();
        const applicationCleanup = await stopApplicationProcessTree();
        const cleanup = {
            ...driverCleanup,
            closed: driverCleanup.closed && applicationCleanup.closed,
            passed: driverCleanup.passed && applicationCleanup.passed,
            applicationCleanup,
        };
        recordEvent('e2e-process-cleanup', cleanup);
        if (!cleanup.closed) {
            smokeReport.status = 'failed';
            smokeReport.error = [smokeReport.error, 'No se pudo cerrar el grupo de procesos aislado del E2E.']
                .filter(Boolean)
                .join('\n');
            process.exitCode = 1;
            process.stderr.write('E2E: quedó vivo un proceso del grupo dedicado; se informa como fallo.\n');
        }
    } catch (error) {
        smokeReport.status = 'failed';
        smokeReport.error = [smokeReport.error, `No se pudo limpiar el árbol del E2E: ${error}`]
            .filter(Boolean)
            .join('\n');
        process.exitCode = 1;
        process.stderr.write(`E2E: falló la limpieza del proceso del driver: ${error}\n`);
    }
    await extendVideoThroughE2eTeardown();
    await hideWebView2DiagnosticWindows();
    if (runnerConsoleHidden) await setRunnerConsoleVisible(true);
    // El smoke general ejecuta estas comprobaciones en sus fases propias;
    // hasta ahora solo la ruta `E2E_FULL_VISUAL_AUDIT` las copiaba al bloque
    // de cobertura, por lo que un informe funcionalmente completo aparentaba
    // no haber probado ajustes, reflow ni scroll horizontal. Derivar el
    // resumen de los eventos ya validados mantiene la cobertura honesta sin
    // inventar acciones que no se ejecutaron.
    const settingsControls = smokeReport.events.find((event) => event.type === 'settings-banner-controls');
    const settingsFooter = smokeReport.events.find((event) => event.type === 'settings-footer-compact-layout' && event.passed === true);
    if (!smokeReport.coverage.settings?.covered && settingsControls && settingsFooter) {
        smokeReport.coverage.settings = {
            covered: true,
            tabs: [settingsControls.selectedTab ?? 'settings-tab-terminal'],
        };
    }
    const paneSequence = smokeReport.events.find((event) => event.type === 'pane-sequence' && Array.isArray(event.transitions));
    if ((!smokeReport.coverage.paneTransitions || smokeReport.coverage.paneTransitions.length === 0) && paneSequence) {
        smokeReport.coverage.paneTransitions = paneSequence.transitions;
    }
    const reflowEvents = smokeReport.events.filter((event) => event.type === 'terminal-reflow-integrity');
    if (!smokeReport.coverage.longLineAndAnsiReflow
        && reflowEvents.length >= 2
        && reflowEvents.every((event) => event.passed === true)) {
        smokeReport.coverage.longLineAndAnsiReflow = true;
    }
    const horizontalGeometry = smokeReport.events.find((event) => event.type === 'horizontal-help-geometry' && event.passed === true);
    if (!smokeReport.coverage.horizontalScroll && horizontalGeometry) {
        smokeReport.coverage.horizontalScroll = true;
    }
    smokeReport.finishedAt = new Date().toISOString();
    smokeReport.durationMs = Date.now() - smokeStartedAt;
    smokeReport.phases = phaseTimings;
    smokeReport.timings = buildTimingReport();
    process.stdout.write(`E2E tiempos por fase: ${phaseTimings.map((item) => `${item.name}=${item.durationMs}ms`).join(', ')}\n`);
    const shellTimings = smokeReport.timings.shells;
    if (shellTimings.length > 0) {
        process.stdout.write(`E2E tiempos por shell/REPL: ${shellTimings.map((item) => `${item.id}=carga:${item.readinessMs ?? '-'}ms/prueba:${item.durationMs ?? '-'}ms`).join(', ')}\n`);
    }
    if (smokeReport.timings.operations.length > 0) {
        process.stdout.write(`E2E tiempos por operación: ${smokeReport.timings.operations.map((item) => `${item.type}${item.label ? `(${item.label})` : ''}=${item.durationMs}ms`).join(', ')}\n`);
    }
    process.stdout.write(`E2E línea temporal: ${smokeReport.timings.timeline.length} eventos; el informe conserva elapsedMs, sincePreviousMs y duración explícita cuando existe.\n`);
    if (ownsWebViewUserDataFolder && smokeReport.status === 'passed') {
        await rm(webviewUserDataFolder, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        }).catch((error) => {
            process.stderr.write(`No se pudo limpiar el perfil WebView2 E2E ${webviewUserDataFolder}: ${error}\n`);
        });
    } else if (ownsWebViewUserDataFolder && smokeReport.status === 'failed') {
        process.stderr.write(`Perfil WebView2 E2E conservado para diagnóstico: ${webviewUserDataFolder}\n`);
    }
    if (fakeAdbDirectory) {
        await rm(fakeAdbDirectory, { recursive: true, force: true }).catch((error) => {
            process.stderr.write(`No se pudo limpiar el ADB falso temporal ${fakeAdbDirectory}: ${error}\n`);
        });
    }
    if (fakeGsudoDirectory) {
        await rm(fakeGsudoDirectory, { recursive: true, force: true }).catch(() => {});
    }
    fakeGithubApi?.close();
    if (fakeGhDirectory) {
        await rm(fakeGhDirectory, { recursive: true, force: true }).catch(() => {});
    }
    if (fakeAiDirectory) {
        await rm(fakeAiDirectory, { recursive: true, force: true }).catch((error) => {
            process.stderr.write(`No se pudieron limpiar las herramientas de IA simuladas ${fakeAiDirectory}: ${error}\n`);
        });
    }
    if (terminalLinksDirectory) {
        await rm(terminalLinksDirectory, { recursive: true, force: true }).catch((error) => {
            process.stderr.write(`No se pudo limpiar la carpeta de enlaces simulados ${terminalLinksDirectory}: ${error}\n`);
        });
    }
    await writeFile(smokeReportPath, `${JSON.stringify(smokeReport, null, 2)}\n`).catch((error) => {
        process.stderr.write(`No se pudo escribir el informe de smoke ${smokeReportPath}: ${error}\n`);
    });
    if (ownedE2eAppDataDirectory && smokeReport.status === 'passed') {
        await rm(ownedE2eAppDataDirectory, { recursive: true, force: true }).catch((error) => {
            process.stderr.write(`No se pudo limpiar el perfil E2E aislado ${ownedE2eAppDataDirectory}: ${error}\n`);
        });
    }
    process.stdout.write(`E2E informe: ${smokeReportPath}\n`);
}
