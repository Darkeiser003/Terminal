import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:net';
import process from 'node:process';
import { promisify } from 'node:util';
import {
    environmentProbe,
    probeOutputHasResultBeforeMarker,
    probeOutputMarkerRows,
    safeEnvironmentMarker,
} from '../../scripts/e2e-environment-probes.mjs';
import { containsExactHttpsUrl } from './terminal-url-matcher.mjs';

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

const driverPath = process.env.TAURI_DRIVER ?? 'tauri-driver';
const nativeDriver = process.env.TAURI_NATIVE_DRIVER;
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
const application = process.env.E2E_BINARY;
if (!application) throw new Error('E2E_BINARY debe apuntar al binario Tauri compilado');
await access(application);
const execFile = promisify(execFileCallback);
const SKIP_WINDOW_MANAGER = /^(1|true|yes)$/i.test(process.env.E2E_SKIP_WINDOW_MANAGER ?? '');
const IS_HYPRLAND = !SKIP_WINDOW_MANAGER && [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.HYPRLAND_INSTANCE_SIGNATURE,
].filter(Boolean).join(' ').toLowerCase().includes('hyprland');

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
    process.platform === 'win32' ? 2500 : 30000,
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
const progressLayoutOnly = process.env.E2E_PROGRESS_LAYOUT_ONLY === '1';
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
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
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
const smokeStartedAt = Date.now();
const phaseTimings = [];
let lastEventAt = smokeStartedAt;
let phaseStartedAt = smokeStartedAt;
let phaseName = 'driver';
const smokeReportPath = process.env.LTERMINAL_SMOKE_REPORT
    ?? join(tmpdir(), `lterminal-smoke-${smokeToken}.json`);
const captureScreenshots = process.env.E2E_CAPTURE_SCREENSHOTS !== '0';
const captureDirectory = process.env.E2E_CAPTURE_DIR
    ?? join(tmpdir(), `winslim-terminal-e2e-captures-${smokeToken}`);
if (captureScreenshots) await mkdir(captureDirectory, { recursive: true });
const smokeReport = {
    schemaVersion: 1,
    token: smokeToken,
    startedAt: new Date(smokeStartedAt).toISOString(),
    host: {
        platform: process.platform,
        desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
        session: process.env.DESKTOP_SESSION ?? null,
        hyprland: IS_HYPRLAND,
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
        captureDirectory: captureScreenshots ? captureDirectory : null,
        shellStartupLimitMs: SHELL_STARTUP_LIMIT_MS,
        ltoolsIntegration,
        ltoolsOnly,
        progressLayoutOnly,
    },
    status: 'running',
    reportPath: smokeReportPath,
};

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

async function request(path, method = 'GET', body) {
    let response;
    try {
        response = await fetch(`${endpoint}${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(webdriverRequestTimeoutMs),
        });
    } catch (error) {
        if (error?.name === 'TimeoutError') {
            throw new Error(`${method} ${path} excedió el límite WebDriver de ${webdriverRequestTimeoutMs} ms`);
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
        const encoded = await request(`/session/${sessionId}/screenshot`);
        if (typeof encoded !== 'string' || encoded.length < 32) {
            throw new Error(`respuesta de screenshot no válida (${typeof encoded})`);
        }
        await writeFile(path, Buffer.from(encoded, 'base64'));
        smokeReport.captures.push({ label: safeLabel, path, elapsedMs: Date.now() - smokeStartedAt });
        recordEvent('screenshot', { label: safeLabel, path });
        process.stdout.write(`E2E captura: ${path}\n`);
        return path;
    } catch (error) {
        recordEvent('screenshot-error', { label: safeLabel, error: error instanceof Error ? error.message : String(error) });
        process.stderr.write(`E2E no pudo guardar la captura ${safeLabel}: ${error}\n`);
        return null;
    }
}

async function verifyCompactSettingsFooterLayout() {
    // Comportamiento contiene el formulario más largo y es el caso que
    // realmente puede quedar oculto bajo el pie sticky. Apariencia suele
    // caber completa en una ventana grande y no prueba el contrato de scroll.
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
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
            scroller.scrollTop = scroller.scrollHeight;
            const contentRect = content.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            return {
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
        || layout.contentBottom > layout.footerTop + 1) {
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
        script: 'arguments[0].scrollIntoView({ block: "center", inline: "nearest" }); return true;',
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
    const result = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const select = document.querySelector(${JSON.stringify(css)});
            if (!select) return { ok: false, reason: 'missing' };
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (!setter) return { ok: false, reason: 'no-setter' };
            setter.call(select, ${JSON.stringify(value)});
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: select.value === ${JSON.stringify(value)}, value: select.value };`,
        args: [],
    });
    if (!result?.ok) throw new Error(`No se pudo seleccionar ${value} en ${css}: ${JSON.stringify(result)}`);
}

const localeCatalogCache = new Map();
async function loadLocaleCatalog(language) {
    if (localeCatalogCache.has(language)) return localeCatalogCache.get(language);
    try {
        // «auto» es una preferencia, no un archivo de catálogo. El backend ya
        // resuelve sistemas no reconocidos al idioma de reserva español; el
        // E2E debe aplicar la misma resolución al validar las etiquetas.
        const resolvedLanguage = language === 'auto' ? 'es' : language;
        const catalog = JSON.parse(await readFile(join(process.cwd(), 'src-tauri', 'locales', `${resolvedLanguage}.json`), 'utf8'));
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
                save: text('[data-testid="settings-save"]'),
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

async function assertLanguageAnchors(language, expected) {
    const actual = await readLanguageAnchors();
    const required = {
        languageLabel: expected['settings.language'],
        languageHint: expected['settings.languageHint'],
        save: expected['settings.save'],
        reset: expected['settings.reset'],
        projects: expected['toolbar.projects'],
        scripts: expected['toolbar.scripts'],
        dependencies: expected['toolbar.deps'],
        settings: expected['toolbar.settings'],
    };
    const checks = [
        ['settings.language', actual.languageLabel, required.languageLabel],
        ['settings.languageHint', actual.languageHint, required.languageHint],
        ['settings.save', actual.save, required.save],
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

async function click(element) {
    await request(`/session/${sessionId}/element/${element}/click`, 'POST', {});
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
            await click(await findWhenReady('.explorer .actions button:first-child'));
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
            await click(await findWhenReady('.explorer form.inline button[type="submit"]'));
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
        await click(await findWhenReady('.explorer .toolbar button:first-child'));
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
            await click(await findWhenReady('.cell:not(.hidden) .xterm'));
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
    try {
        if (enter) {
            const lineActions = keyActions.slice(0, -2);
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: lineActions }],
            });
            // WebKitWebDriver puede entregar la última letra junto con Enter
            // antes de que xterm actualice su buffer accesible. Separarlos
            // evita que los comandos internos pierdan ese carácter final.
            await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: keyActions.slice(-2) }],
            });
        } else {
            await request(`/session/${sessionId}/actions`, 'POST', {
                actions: [{ type: 'key', id: 'keyboard', actions: keyActions }],
            });
        }
    } catch (firstError) {
        // WebKitWebDriver antiguo puede no implementar acciones de teclado;
        // conservar una ruta compatible para esos entornos.
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

async function activeTerminalRowSnapshot() {
    const cell = await findWhenReady('.cell:not(.hidden)');
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

async function terminalHorizontalSnapshot(cell) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const root = arguments[0];
            const viewport = root.querySelector('.xterm-viewport');
            const screen = root.querySelector('.xterm-screen');
            const host = root.querySelector('[data-testid="terminal-host"]');
            const pane = root.matches('.tab-pane')
                ? root
                : root.querySelector('.tab-pane:not(.hidden)');
            const visibleRows = [...root.querySelectorAll('.xterm-rows > div')]
                .map((row) => (row.textContent || '').replace(/\\s+$/u, '').length);
            const indicator = root.querySelector('.horizontal-overflow-indicator');
            const indicatorStyle = indicator ? getComputedStyle(indicator) : null;
            return {
                viewport: viewport ? {
                    clientWidth: viewport.clientWidth,
                    scrollWidth: viewport.scrollWidth,
                    clientHeight: viewport.clientHeight,
                    scrollHeight: viewport.scrollHeight,
                    scrollLeft: viewport.scrollLeft,
                } : null,
                screen: screen ? {
                    clientWidth: screen.clientWidth,
                    scrollWidth: screen.scrollWidth,
                    rectWidth: screen.getBoundingClientRect().width,
                    inlineWidth: screen.style.width,
                } : null,
                host: host ? {
                    clientWidth: host.clientWidth,
                    scrollWidth: host.scrollWidth,
                    rectWidth: host.getBoundingClientRect().width,
                    overflow: pane.dataset.horizontalOverflow || '',
                    cols: pane.dataset.terminalCols || '',
                    rows: pane.dataset.terminalRows || '',
                } : null,
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

/**
 * Simula la salida de un instalador sin ejecutar ningún gestor de paquetes.
 * Las actualizaciones reales suelen pintar varias fases sobre la misma fila
 * usando `\r`; la barra larga se genera dentro de la shell para que el propio
 * comando no sea la línea que provoque el desbordamiento.
 */
function progressCommand(label, marker, barLength) {
    const safeLabel = label.replace(/[^A-Z0-9_-]/g, '_');
    const dots = '.'.repeat(Math.min(24, barLength));
    if (process.platform === 'win32') {
        const bar = '#'.repeat(barLength);
        return `cmd /d /s /c "echo LTERMINAL_PROGRESS_${safeLabel} 0% [${dots}] & echo LTERMINAL_PROGRESS_${safeLabel} 50% [${dots}] & echo LTERMINAL_PROGRESS_${safeLabel} 100% [${bar}] & echo ${marker}"`;
    }
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
    // Esta geometría deja margen para una barra corta y obliga a que la larga
    // solicite solo las columnas que ocupa su contenido.
    await resizeWindow(900, 620, { waitForBanner: false });
    const resetMarker = `LTERMINAL_PROGRESS_RESET_${Date.now()}`;
    await sendTerminalLine(progressClearCommand(resetMarker));
    await waitForProgressMarker(resetMarker, 'limpieza previa de la prueba de progreso');
    const cell = await findWhenReady('.cell:not(.hidden)');
    // El cambio de ventana puede llegar después del marcador de la shell:
    // esperar a que xterm recupere el ancho del viewport evita medir las
    // columnas de la fase anterior como si fueran espacio reservado por
    // `update`.
    await waitUntil(async () => {
        const snapshot = await terminalHorizontalSnapshot(cell);
        const host = snapshot.host;
        const screen = snapshot.screen;
        const cols = Number(host?.cols ?? 0);
        const cellWidth = Number(screen?.rectWidth ?? 0) / Math.max(1, cols);
        const visibleCols = Math.floor(Number(host?.clientWidth ?? 0) / Math.max(1, cellWidth));
        return Boolean(host && screen)
            && host.clientWidth > 0
            && host.overflow !== 'true'
            && host.scrollWidth <= host.clientWidth + 2
            && cols > 0
            && cols <= visibleCols + 1;
    }, 15000, 'recuperación del ancho mínimo tras cambiar la ventana');
    const baseline = await terminalHorizontalSnapshot(cell);
    if (!baseline.host || baseline.host.clientWidth <= 0) {
        throw new Error(`No se pudo medir el host de terminal antes de la prueba de progreso: ${JSON.stringify(baseline)}`);
    }

    const visibleColumns = Math.max(1, Number(baseline.host.cols) || 80);
    const longBarLength = Math.max(160, visibleColumns + 40);
    const scenarios = [
        { id: 'update', barLength: 24, expectedMinimum: 60 },
        { id: 'upgrade', barLength: longBarLength, expectedMinimum: visibleColumns + 30 },
    ];
    const results = [];
    for (const scenario of scenarios) {
        const marker = `LTERMINAL_PROGRESS_${scenario.id.toUpperCase()}_DONE_${Date.now()}`;
        const command = progressCommand(scenario.id, marker, scenario.barLength);
        const commandStartedAt = Date.now();
        await sendTerminalLine(command);
        await waitForProgressMarker(marker, `salida simulada de ${scenario.id}`);
        const snapshot = await terminalHorizontalSnapshot(cell);
        const host = snapshot.host;
        const maxVisibleRowLength = Math.max(0, ...(snapshot.visibleRowLengths ?? []));
        const expectedLineLength = scenario.id === 'upgrade'
            ? `LTERMINAL_PROGRESS_UPGRADE 100% [${'#'.repeat(scenario.barLength)}]`.length
            : `LTERMINAL_PROGRESS_UPDATE 100% [${'#'.repeat(scenario.barLength)}]`.length;
        if (!host) throw new Error(`La terminal no expuso geometría para ${scenario.id}`);
        const contentDriven = scenario.id === 'upgrade'
            ? host.overflow === 'true'
                && host.scrollWidth > host.clientWidth + 2
                && Number(host.cols) >= expectedLineLength - 4
                && Number(host.cols) <= expectedLineLength + 8
                && maxVisibleRowLength >= scenario.expectedMinimum
            : host.overflow !== 'true'
                && host.scrollWidth <= host.clientWidth + 2
                && Number(host.cols) <= Number(baseline.host.cols) + 4
                && maxVisibleRowLength >= scenario.expectedMinimum;
        const capture = await captureScreenshot(`progress-${scenario.id}-layout`);
        results.push({
            id: scenario.id,
            barLength: scenario.barLength,
            expectedLineLength,
            maxVisibleRowLength,
            host,
            commandDurationMs: Date.now() - commandStartedAt,
            capture,
            contentDriven,
            passed: contentDriven,
        });
        if (!contentDriven) {
            throw new Error(`La salida simulada de ${scenario.id} no respetó el ancho mínimo/contenido: ${JSON.stringify(results.at(-1))}`);
        }
    }

    const cleanupMarker = `LTERMINAL_PROGRESS_CLEAN_${Date.now()}`;
    const cleanupStartedAt = Date.now();
    await sendTerminalLine(progressClearCommand(cleanupMarker));
    await waitForProgressMarker(cleanupMarker, 'limpieza de la barra de progreso');
    const cleaned = await terminalHorizontalSnapshot(cell);
    const cleanupHost = cleaned.host;
    const reclaimed = Boolean(cleanupHost)
        && cleanupHost.overflow !== 'true'
        && cleanupHost.scrollWidth <= cleanupHost.clientWidth + 2
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
    return request(`/session/${sessionId}/elements`, 'POST', {
        using: 'css selector', value: '.cell:not(.hidden)'
    });
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
    const rows = await findAll('.cell:not(.hidden) .xterm-rows');
    const texts = await Promise.all(rows.map((row) => textOf(row[elementKey])));
    return texts.slice(0, expected);
}

async function rawTerminalTexts(expected) {
    const rows = await findAll('.cell:not(.hidden) .xterm-rows');
    const texts = await Promise.all(rows.map((row) => textOf(row[elementKey])));
    return texts.slice(0, expected);
}

async function rawTerminalTextWithin(cell) {
    const rows = await findAllWithin(cell, '.xterm-rows');
    return rows.length ? textOf(rows[0][elementKey]) : '';
}

async function dispatchTerminalWheel(cell, deltaY, repeat = 1) {
    const result = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const screen = arguments[0].querySelector('.xterm-screen');
            if (!screen) return null;
            let prevented = 0;
            for (let index = 0; index < arguments[2]; index += 1) {
                const wheel = new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaX: 0,
                    deltaY: arguments[1],
                    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                    shiftKey: false,
                });
                // xterm escucha la rueda en la superficie de pantalla; el
                // viewport es una capa separada usada para el scrollbar.
                screen.dispatchEvent(wheel);
                if (wheel.defaultPrevented) prevented += 1;
            }
            return { dispatched: arguments[2], prevented };`,
        args: [{ [elementKey]: cell }, deltaY, repeat],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    return result;
}

async function promptStates(expected) {
    const hosts = await findAll('.tab-pane:not(.hidden)[data-prompt-visible]');
    return Promise.all(hosts.slice(0, expected).map((host) => attribute(host[elementKey], 'data-prompt-visible')));
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
    const cells = await findAll('.cell:not(.hidden)');
    return Promise.all(cells.slice(0, expected).map((cell) => request(
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
    )));
}

async function waitForBannerPanes(expected = 1, timeoutMs = 20000) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastSnapshot = [];
    let lastRawSnapshot = [];
    let lastPromptState = [];
    while (Date.now() < deadline) {
        const panes = await visiblePanes();
        const rows = await findAll('.cell:not(.hidden) .xterm-rows');
        if (panes.length >= expected && rows.length >= expected) {
            const texts = await visualBannerTexts(expected);
            const rawTexts = await rawTerminalTexts(expected);
            const promptState = await promptStates(expected);
            lastSnapshot = texts;
            lastRawSnapshot = rawTexts;
            lastPromptState = promptState;
            const visibleTexts = texts.slice(0, expected);
            // El banner puede vivir en una capa visual separada del xterm;
            // comprobar el prompt sobre el texto crudo evita que esa capa
            // oculte la evidencia de que la shell sigue lista para escribir.
            const promptsVisible = rawTexts.length >= expected
                && (rawTexts.every(promptLooksVisible)
                    || (promptState.length >= expected
                        && promptState.every((value) => value === 'true')));
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
            // El mínimo nativo (480x270) deja unas 13 filas (~169 px) en
            // xterm; aunque no sea una «casilla baja» según la heurística de
            // filas, la cabecera puede quedar fuera por el scroll natural.
            const tinyViewport = geometry.panes.slice(0, expected).every((pane) =>
                pane.screen?.height > 0 && pane.screen.height < 220
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
            const anomaliesReady = visualAnomalies.every((items) =>
                items.length === 0
                || (tinyBanner && items.every((item) => item === 'cabeceras=0'))
            );
            const contentReady = anomaliesReady
                && promptsVisible
                && (visibleTexts.every(bannerLooksReady) || minimalBanner || partialBanner);
            if (contentReady && (hasCompleteHeader || compactBanner || tinyBanner || minimalBanner || partialBanner)) {
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
    // `PS`, una ruta POSIX o el formato usuario@host de Linux.
    const anchored = /^(?:PS\s+)?(?:[A-Za-z]:\\.+[>❯$#]|[^\s@]+@[^\s:]+:.+[❯$#]|(?:~|\/).*[❯$#])(?:.*)?$/u;
    // En WebKitGTK el endpoint de texto puede concatenar varias filas del
    // DOM; en ese caso el prompt no queda al principio de una línea, aunque
    // siga siendo visible y válido. Mantener una detección acotada por el
    // formato usuario@host/ruta evita falsos negativos del smoke.
    const concatenated = /(?:[A-Za-z]:\\[^\s]*[>❯$#]|[^\s@]+@[^\s:]+:[^\n]*[❯$#]|(?:~|\/)[^\n]*[❯$#])/u;
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
    const headers = lines.filter((line) => /^(?:LTerminal\b|WinSlim\b.*\bTerminal\b)/i.test(line));
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
    const promptIndex = lines.findIndex((line) => /(?:^[A-Z]:\\[^ ]*[>❯$#]|^[^ ]+@[^ ]+:[^ ]+[❯$#])/.test(line));
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
            const panes = await visiblePanes();
            const rows = await findAll('.cell:not(.hidden) .xterm-rows');
            if (panes.length !== expected || rows.length < expected) return false;
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
                hasHeader: latestTexts.every((text) => /^(?:LTerminal\b|WinSlim\b.*\bTerminal\b)/im.test(text))
                    || (tinyGrid && latestTexts.every((text) =>
                        /CPU|Procesador|Processor/i.test(text)
                        && /Memoria|Memory|RAM/i.test(text)
                        && /Sesion|Session|Uptime|Tiempo activo/i.test(text))),
                promptsVisible: rawTexts.every(promptLooksVisible)
                    || (promptState.length >= expected && promptState.every((value) => value === 'true')),
                logicalSafe: promptGeometry.every(({ logicalSafe }) => logicalSafe),
                noAnomalies: anomalies.every((items) => items.length === 0
                    || (tinyGrid && items.every((item) => item === 'cabeceras=0'))),
                // Todas las casillas deben usar el mismo perfil. Antes la
                // pestaña existente conservaba el formato completo mientras
                // las nuevas nacían compactas, dejando una rejilla mezclada.
                sameBannerMode: tinyGrid || modes.every((mode) => mode === modes[0]),
            };
            last = { panes: panes.length, rows: rows.length, headers, modes, anomalies, promptGeometry, checks };
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
    try { await waitUntil(async () => {
        const panes = await visiblePanes();
        const rows = await findAll('.cell:not(.hidden) .xterm-rows');
        if (panes.length !== expected || rows.length < expected) return false;
        const texts = await visualBannerTexts(expected);
        const rawTexts = await rawTerminalTexts(expected);
        const promptState = await promptStates(expected);
        const promptGeometry = await promptBannerGeometry(expected);
        const latest = texts.map(latestBannerBlock);
        const headers = latest.map(firstNonEmptyTerminalLine);
        const anomalies = latest.map((text, index) => {
            // Con menos de 12 filas el banner no se pinta por diseño; el
            // scrollback puede conservar su cabecera y prompt en posiciones
            // que `bannerTextAnomalies` marcaría como solapadas.
            if ((promptGeometry[index]?.viewportRows ?? 0) < 12) return [];
            return /(?:WinSlim|LTerminal) Terminal\b/i.test(text) ? bannerTextAnomalies(text) : [];
        });
        const rawPromptMatches = rawTexts.map(promptLooksVisible);
        const headerPromptMatches = headers.map((header) => /(?:[^\s@]+@[^\s:]+:[^\n]*[❯$#]|[A-Za-z]:\\[^\n]*[>$#])/.test(header));
        const statePromptMatches = promptState.map((value) => value === 'true');
        const geometryPromptMatches = promptGeometry.map(({ logicalSafe, cursorInsideTerminal, promptCandidates }) =>
            promptCandidates.length > 0 || (logicalSafe && cursorInsideTerminal));
        last = { panes: panes.length, rows: rows.length, headers, anomalies, promptGeometry, promptState,
            rawPromptMatches, headerPromptMatches, statePromptMatches, geometryPromptMatches };
        // WebKitGTK puede devolver el texto accesible de xterm con una fila
        // antigua concatenada mientras el canvas ya muestra el prompt nuevo
        // (se ve especialmente al reflowar una entrada larga en una rejilla
        // 2x2). La geometría se calcula sobre el mismo DOM y confirma que el
        // cursor está dentro del terminal y que existe un prompt visible;
        // usarla como respaldo evita un falso negativo sin relajar la
        // comprobación de seguridad espacial.
        const promptsDetected = rawPromptMatches.every(Boolean)
            || (statePromptMatches.length >= expected && statePromptMatches.every(Boolean))
            // En Linux/WebKitGTK el endpoint accesible puede devolver una
            // casilla sin sus saltos de línea justo durante el reflow. El
            // texto visual ya agregado por `latestBannerBlock` conserva el
            // prompt; exigirlo en las cuatro cabeceras evita aceptar una
            // casilla vacía y cubre esa ventana de sincronización.
            || headerPromptMatches.every(Boolean)
            || geometryPromptMatches.every(Boolean);
        return promptsDetected
            && promptGeometry.every(({ logicalSafe }) => logicalSafe)
            && anomalies.every((items) => items.length === 0);
    }, 10000, `${label}: salida estable`); } catch (error) {
        throw new Error(`${label}: salida inestable (${JSON.stringify(last).slice(0, 6000)})`, { cause: error });
    }
    recordEvent('pane-output-stable', { label, expected, ...last });
    return last;
}

async function assertTinyPanesStable(expected, label) {
    let last = {};
    try {
        await waitUntil(async () => {
            const rows = await findAll('.cell:not(.hidden) .xterm-rows');
            if (rows.length < expected) return false;
            const texts = await Promise.all(rows.slice(0, expected).map((row) => textOf(row[elementKey])));
            const promptState = await promptStates(expected);
            const anomalies = texts.map(bannerTextAnomalies);
            const promptsVisible = texts.every(promptLooksVisible)
                || (promptState.length >= expected && promptState.every((value) => value === 'true'));
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
        }, 20000, `${label}: casillas bajas estables`);
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
        count = (await visiblePanes()).length;
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

async function resizeWindow(width, height, { waitForBanner = true } = {}) {
    // En algunos window managers la ventana arranca maximizada y un cambio
    // parcial de width/height se ignora. Enviar también x/y fuerza el mismo
    // camino que usa «restaurar tamaño» y hace observable el resize real.
    const requested = {
        width: Math.max(WINDOW_LIMITS.minWidth, Math.min(WINDOW_LIMITS.maxWidth, width)),
        height: Math.max(WINDOW_LIMITS.minHeight, Math.min(WINDOW_LIMITS.maxHeight, height)),
    };
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
    const paneCount = (await visiblePanes()).length;
    recordEvent('resize', {
        requested,
        applied: { width: rect.width, height: rect.height },
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
    const panes = (await visiblePanes()).length;
    await waitForBannerPanes(Math.max(1, panes), 20000);
    return { ...rect, content: await contentGeometry() };
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
    await sendTerminalLine(`echo ${marker}`);
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        return (await textOf(rows)).includes(marker);
    }, 10000, 'marcador para seleccionar con el ratón');

    const target = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const marker = arguments[0];
            const rows = [...document.querySelectorAll('.cell:not(.hidden) .xterm-rows > div')];
            const row = rows.findLast((item) => (item.textContent || '').includes(marker));
            if (!row) return null;
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
                    startX: Math.round(rect.left + Math.max(1, rect.width / marker.length * 0.2)),
                    endX: Math.round(rect.right - Math.max(1, rect.width / marker.length * 0.2)),
                    y: Math.round((rect.top + rect.bottom) / 2),
                };
            }
            return null;`,
        args: [marker],
    });
    if (!target || !Number.isFinite(target.startX) || !Number.isFinite(target.endX)) {
        throw new Error(`No se encontró el texto visible para la prueba de arrastre: ${marker}`);
    }
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
                && box.x < target.endX
                && box.x + box.width > target.startX,
            ));
        }, 3000, 'resaltado visible de xterm sobre la fila arrastrada');
    } catch (error) {
        await captureScreenshot('mouse-selection-no-resaltado');
        throw new Error(`El arrastre real no resaltó el texto en xterm: ${JSON.stringify({ target, selection })}`, { cause: error });
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

async function exerciseShellMatrix() {
    const button = await findWhenReady('.env-select');
    await click(button);
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
    const availableOptions = options.filter((option) => !option.disabled && option.id);
    const availableIds = availableOptions.map((option) => option.id);
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

    const probes = new Map(availableOptions.map((option) => [
        option.id,
        environmentProbe(option, safeEnvironmentMarker(option.id)),
    ]));
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
                        script: `return document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)')?.dataset.inputReady === 'true';`,
                        args: [],
                    });
                }
                return (await promptStates(1))[0] === 'true';
            }, 30000, `entrada del entorno ${id}`);
            return {
                elapsedMs: Date.now() - readinessStartedAt,
                readinessSignal: id === 'lang:forth' ? 'input-ready-no-prompt' : 'prompt',
            };
        }
        const menuOptions = await findAll(`.env-menu [data-environment-id="${id}"]`);
        if (menuOptions.length === 0) await click(await findWhenReady('.env-select'));
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
        await waitUntil(async () => request(`/session/${sessionId}/execute/sync`, 'POST', {
            script: `const pane = document.querySelector('.cell:not(.hidden) .tab-pane:not(.hidden)');
                return Boolean(pane?.dataset.inputReady === 'true'
                    && pane.dataset.environmentSwitchRequestId
                    && pane.dataset.environmentSwitchRequestId !== arguments[0]);`,
            args: [String(previousRequestId)],
        }), 35000, `handshake y entrada listos para ${id}`);
        const probe = probes.get(id);
        const readinessStartedAt = Date.now();
        const readinessSignal = id === 'lang:forth' ? 'input-ready-no-prompt' : 'prompt';
        if ((probe?.kind === 'repl' || id === 'wine-cmd') && id !== 'lang:forth') {
            try {
                await waitUntil(async () => {
                    if ((await promptStates(1))[0] === 'true') return true;
                    return false;
                }, 30000, `prompt del REPL ${id}`);
            } catch (error) {
                const diagnostic = await promptDiagnostics().catch((diagnosticError) => ({
                    diagnosticError: diagnosticError?.message ?? String(diagnosticError),
                }));
                throw new Error(`No se cumplió prompt del REPL ${id}; estado=${JSON.stringify(diagnostic)}`, {
                    cause: error,
                });
            }
        } else if (id !== 'lang:forth') {
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
        let expectedResultDetected = probe.expectedResultBeforeMarker === undefined;
        let outputRowSummary = [];
        try {
            await waitUntil(async () => {
                const output = await rawTerminalTextWithin(await findWhenReady('.cell:not(.hidden)'));
                outputRowSummary = probeOutputMarkerRows(output ?? '', probe.command, marker);
                markerOutputDetected = outputRowSummary.some((row) => row.markerAfterEchoRemoval);
                expectedResultDetected = probe.expectedResultBeforeMarker === undefined
                    || probeOutputHasResultBeforeMarker(
                        output ?? '', probe.command, probe.expectedResultBeforeMarker, marker,
                    );
                return markerOutputDetected && expectedResultDetected;
            }, 15000, `salida evaluada por el PTY de ${id}`);
        } catch (error) {
            throw new Error(`${error.message}; filasPTY=${JSON.stringify(outputRowSummary)}`, { cause: error });
        }
        const durationMs = Date.now() - startedAt;
        const result = {
            id,
            kind: probe.kind,
            language: probe.language ?? null,
            marker,
            markerOutputDetected,
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
    return { originalId, availableIds, testedIds, testedAlternates, skipped, restoredTo: originalId };
}

async function exerciseAdbRefreshWithoutLayout() {
    if (!fakeAdbDirectory) throw new Error('El ADB falso no fue preparado antes de iniciar el driver');
    await click(await findWhenReady('.env-select'));
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
    const candidates = [
        process.env.LTERMINAL_LOG_FILE,
        join(configRoot, process.platform === 'win32' ? 'winslim-terminal' : 'lterminal', 'logs', 'main.log'),
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
            ? ['ltools-cli.exe', 'ltools.exe', 'winslim-tools.exe', 'ltools-cli', 'ltools', 'winslim-tools']
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
        await click(await findWhenReady('[role="dialog"] .panel-close'));
    }
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de paneles antes de LTools');
    await click(await findWhenReady('[data-testid="toolbar-library"]'));
    const library = await findWhenReady('[role="dialog"]');
    const fileSectionTitle = await findWhenReady('[data-testid="scripts-file-section-title"]');
    const fileSectionText = await textOf(fileSectionTitle);
    if (!/Tipos de archivo/i.test(fileSectionText)) {
        throw new Error(`La Biblioteca no identifica el filtro de archivos con su sección propia: ${JSON.stringify(fileSectionText)}`);
    }
    const section = await findWhenReady('[data-testid="scripts-ltools"]');
    await click(await findWhenReady('[data-testid="scripts-ltools"] > summary'));
    await waitUntil(async () => (await attribute(section, 'open')) === 'true', 5000, 'apertura del apartado LTools');

    const meta = await textOf(await findWhenReady('[data-testid="scripts-ltools-meta"]'));
    const availableCount = Number(meta.match(/(\d+)\s+disponibles/i)?.[1]);
    const compatibleCount = compatible.length;
    if (!Number.isInteger(availableCount) || availableCount < 1 || availableCount > catalog.actions.length) {
        throw new Error(`La Biblioteca no refleja el catálogo publicado de LTools: ${JSON.stringify({ meta, availableCount, catalogActions: catalog.actions.length, compatibleCount })}`);
    }

    await click(await findWhenReady('[data-testid="scripts-ltools-configure"]'));
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
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca tras fijar LTools');
    await click(await findWhenReady('[data-testid="toolbar-library"]'));
    const reopenedLTools = await findWhenReady('[data-testid="scripts-ltools"]');
    if ((await attribute(reopenedLTools, 'open')) !== 'true') await click(await findWhenReady('[data-testid="scripts-ltools"] > summary'));
    await findWhenReady(`[data-testid="scripts-ltools-run"][data-ltools-action-id="${chosen.id}"]`);
    await captureScreenshot('ltools-catalogo-y-selector');
    await click(await findWhenReady(`[data-testid="scripts-ltools-run"][data-ltools-action-id="${chosen.id}"]`));
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

try {
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
            await assertTinyPanesStable(1, 'arranque con casilla baja');
        } else {
            await waitForBannerPanes(1, 20000);
        }
    } else {
        await waitForBannerPanes(1, 20000);
    }
    await prepareWindowManagerForResize();
    if (process.env.E2E_SETTINGS_FOOTER_ONLY === '1') {
        markPhase('Ajustes compactos 800x600');
        await click(await findWhenReady('[data-testid="toolbar-settings"]'));
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
                        startX: Math.round(rect.left + Math.max(1, rect.width / marker.length * 0.2)),
                        endX: Math.round(rect.right - Math.max(1, rect.width / marker.length * 0.2)),
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
    } else if (process.env.E2E_SHELL_MATRIX_ONLY === '1') {
        markPhase('cambio de shell');
        const matrix = await exerciseShellMatrix();
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'environment-shell-matrix';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: entornos detectados ${matrix.availableIds.length}; sondas ejecutadas ${matrix.testedIds.length}; omisiones seguras ${matrix.skipped.length}; restaurado ${matrix.restoredTo} (${Date.now() - smokeStartedAt} ms).\n`);
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
        await assertCurrentLog();
        phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
        smokeReport.focusedScenario = 'progress-output-layout';
        smokeReport.status = 'passed';
        smokeReport.logValidated = true;
        process.stdout.write(`E2E enfocado OK: barras simuladas de update/upgrade y recuperación de ancho (${progress.durationMs} ms).\n`);
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
    await click(await findWhenReady('.side-toggle.panes'));
    await waitUntil(async () => (await visiblePanes()).length >= 2, 15000, 'segunda terminal en la vista');
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
        await waitForBannerPanes(2, 20000);
        await assertBannerHeaders(2, 'rejilla 2 paneles tras crear la segunda pestaña');
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
                });
            }
            const paneHasUsableGeometry = (pane) => pane.hostWidth > 0
                && pane.cols > 0 && pane.visibleCols > 0;
            const fitsViewport = (pane) => pane.cols <= pane.visibleCols + 1
                && pane.hostScrollWidth <= pane.hostWidth + 2;
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
    let panesBeforeClose = (await visiblePanes()).length;
    while (panesBeforeClose > 1) {
        await click(await findWhenReady('.side-toggle.panes'));
        await waitUntil(async () => (await visiblePanes()).length !== panesBeforeClose, 3000, 'cambio de diseño dividido');
        panesBeforeClose = (await visiblePanes()).length;
    }
    // WebDriver puede saltarse los límites nativos si se le pide un tamaño
    // superior; no lo usamos como prueba de usuario. Medimos exactamente el
    // techo soportado por la configuración: 7680x4320 (8K).
    // En monitores menores que 8K el driver puede aceptar el rectángulo
    // máximo lógico aunque el compositor lo reduzca fuera de la pantalla.
    // Aquí solo validamos los límites nativos; la geometría del banner se
    // comprueba en tamaños visibles y reales inmediatamente después.
    const maximumRect = await resizeWindow(
        WINDOW_LIMITS.maxWidth,
        WINDOW_LIMITS.maxHeight,
        { waitForBanner: false },
        { waitForBanner: false },
    );
    assertWindowBounds(maximumRect, 'El máximo configurado');
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
        await click(await findWhenReady('.tab-new'));
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
    for (const [command, marker, label] of [
        [':shell current', 'Shell actual:', 'shell actual'],
        [':panel list', 'Uso: :panel <panel> | :panel close', 'lista de paneles'],
        [':theme list', 'Uso: :theme <id> | :theme list', 'lista de temas'],
        [':font list', 'Uso: :font <id> | :font list', 'lista de fuentes'],
        [':language list', 'Uso: :language <id> | :language list', 'lista de idiomas'],
        [':terminal list', 'Colores:', 'parámetros de terminal'],
        [':panes list', 'Uso: :panes 1|2|3|4 | :panes cycle', 'diseño de paneles'],
    ]) {
        await sendTerminalLine(command);
        await waitUntil(async () => {
            const snapshot = await activeTerminalRowSnapshot();
            return snapshot.rows.some((row) => row.text.includes(marker));
        }, 10000, `comando interno ${label}`);
    }
    recordEvent('internal-configuration-commands', {
        commands: [':shell current', ':panel list', ':theme list', ':font list', ':language list', ':terminal list', ':panes list'],
        passed: true,
    });
    // La apertura por comando debe montar el panel bajo demanda igual que la
    // barra: en una sesión fresca no existe todavía ningún componente de
    // Ajustes en el DOM. Esta comprobación cubre la ruta que antes dejaba
    // `panels.open` apuntando a un panel invisible.
    await sendTerminalLine(':panel settings');
    await findWhenReady('[role="dialog"]', 10000);
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes abierto por comando');
    recordEvent('internal-panel-open', { command: ':panel settings', mounted: true, passed: true });
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
            && !creditTitleLeakedIntoPrompt(lines, /Darkeiser003|desarrollador/i)
            && containsExactHttpsUrl(text, 'https://github.com/Darkeiser003')
            && containsExactHttpsUrl(text, 'https://github.com/Darkeiser003/Infraestructura-Web');
    }, 10000, 'easter-egg de Darkeiser003 (formato y enlaces)');
    await captureScreenshot('credito-darkeiser-formato');
    await sendTerminalLine('clear');
    await waitUntil(async () => snapshotPromptVisible(await activeTerminalRowSnapshot()), 10000, 'prompt tras limpiar antes de alias de colaborador');
    await sendTerminalLine('christianlg97');
    await waitUntil(async () => {
        const snapshot = await activeTerminalRowSnapshot();
        const text = snapshot.rows.map((row) => row.text).join('\n');
        const lines = creditLines(text);
        // El nombre puede aparecer como eco de la orden o como error de la
        // shell; lo que no puede aparecer es una fila de crédito ni sus URLs.
        return snapshotPromptVisible(snapshot)
            && !creditHasOwnTitleRow(lines, 'Christianlg97 ·')
            && !containsExactHttpsUrl(text, 'https://github.com/Christianlg97');
    }, 10000, 'alias de colaborador no expuesto como easter-egg');
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
    recordEvent('author-easter-eggs', {
        aliases: ['Darkeiser003', 'darkeiser003', '@darkeiser003', '@Darkeiser003'],
        rejectedAliases: ['christianlg97', ':christianlg97', '@christianlg97'],
        captures: ['credito-darkeiser-formato', 'credito-prompt-utilizable'],
        layout: 'title-row-without-prompt-fragment-and-usable-prompt',
        passed: true,
    });

    markPhase('acciones concurrentes');
    // Varias detecciones pueden terminar en cualquier orden. Los clics se
    // envían consecutivamente, sin pausas, para solapar las operaciones de la
    // aplicación sin saturar el único canal HTTP de tauri-driver.
    const refreshEnvironments = await findWhenReady('[data-testid="refresh-environments"]');
    for (let attempt = 0; attempt < 4; attempt += 1) await click(refreshEnvironments);
    await waitUntil(async () => {
        const environmentButton = await findWhenReady('.env-select');
        return (await attribute(environmentButton, 'disabled')) === null;
    }, 20000, 'fin de refrescos concurrentes de entornos');

    // Cambiar de shell crea un PTY nuevo. Probar comandos reales en hasta dos
    // shells distintas —Fish incluido cuando está disponible— detecta fallos
    // que el simple cambio del rótulo activo no ve; al final se restaura la
    // shell inicial para no alterar la sesión del usuario.
    markPhase('cambio de shell');
    await exerciseShellMatrix();

    markPhase('ajustes');
    // En builds de depuración WebKit puede reservar unos 300 px para el
    // inspector. Con la ventana de trabajo anterior el banner completo no
    // cabe y CPU queda fuera de las filas visibles, aunque la preferencia se
    // haya aplicado. Esta fase necesita observar contenido, así que usa una
    // altura suficiente tanto con inspector como en release.
    await resizeWindow(1100, 900, { waitForBanner: false });
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    const dialog = await findWhenReady('[role="dialog"]');
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
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
    const languageSelect = await findWhenReady('[data-testid="settings-language"]');
    const originalLanguage = String(await property(languageSelect, 'value'));
    const languageOptions = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return [...document.querySelectorAll(\'[data-testid="settings-language"] option\')].map((option) => option.value);',
        args: [],
    });
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
        await click(await findWhenReady('[data-testid="settings-save"]'));
        await waitUntil(
            async () => String(await property(await findWhenReady('[data-testid="settings-language"]'), 'value')) === language,
            5000,
            `aplicación del idioma ${language}`,
        );
        let anchors;
        await waitUntil(async () => {
            try {
                anchors = await assertLanguageAnchors(language, expected);
                return true;
            } catch {
                return false;
            }
        }, 5000, `traducción completa ${language}`);
        languageResults.push({ language, anchors: { tabs: anchors.tabs, toolbar: anchors.toolbar } });
    }
    await setSelectValue('[data-testid="settings-language"]', originalLanguage);
    await click(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(
        async () => String(await property(await findWhenReady('[data-testid="settings-language"]'), 'value')) === originalLanguage,
        5000,
        'restauración del idioma original',
    );
    const originalExpected = await loadLocaleCatalog(originalLanguage);
    await waitUntil(async () => {
        try {
            await assertLanguageAnchors(originalLanguage, originalExpected);
            return true;
        } catch {
            return false;
        }
    }, 5000, 'catálogo del idioma original');
    recordEvent('language-switch', { original: originalLanguage, tested: languageResults, passed: true });

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
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-clear-reprint-banner"]'), 'checked')) === false,
        5000,
        'desactivación temporal del fastfetch tras clear');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras desactivar fastfetch de clear');
    await assertClearBannerMode(false, 'clear sin fastfetch cuando la opción está desactivada');

    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-terminal"]'));
    const clearReprintEnabledInput = await findWhenReady('[data-testid="settings-clear-reprint-banner"]');
    if (!Boolean(await property(clearReprintEnabledInput, 'checked'))) await clickInView(clearReprintEnabledInput);
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-clear-reprint-banner"]'), 'checked')) === true,
        5000,
        'activación temporal del fastfetch tras clear');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras activar fastfetch de clear');
    await assertClearBannerMode(true, 'clear con fastfetch cuando la opción está activada');

    // Restaurar exactamente el valor que tenía la instalación antes del smoke.
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-terminal"]'));
    const clearReprintRestoredInput = await findWhenReady('[data-testid="settings-clear-reprint-banner"]');
    if (Boolean(await property(clearReprintRestoredInput, 'checked')) !== clearReprintWasEnabled) {
        await clickInView(clearReprintRestoredInput);
    }
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => Boolean(await property(await findWhenReady('[data-testid="settings-clear-reprint-banner"]'), 'checked')) === clearReprintWasEnabled,
        5000,
        'restauración persistida del fastfetch tras clear');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras restaurar fastfetch de clear');

    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-terminal"]'));
    const cpuInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
    const cpuControl = await parentOf(cpuInput);
    const cpuLabelElement = (await findAllWithin(cpuControl, 'strong'))[0]?.[elementKey];
    const cpuLabel = cpuLabelElement ? (await textOf(cpuLabelElement)).trim() : '';
    if (!cpuLabel) throw new Error('La opción funcional de CPU no tiene etiqueta localizada');
    const cpuWasVisible = await property(cpuInput, 'checked');
    await clickInView(cpuInput);
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => {
        const savedInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
        return Boolean(await property(savedInput, 'checked')) === !cpuWasVisible;
    }, 5000, 'persistencia temporal de la opción CPU');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras cambiar CPU');
    // Aclarar el viewport antes de la orden explícita evita que el historial
    // del banner inicial oculte la diferencia de CPU en xterm reducido.
    await sendTerminalLine('clear');
    await sendTerminalLine('sysinfo');
    await waitUntil(async () => {
        const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return latestBannerBlock(text).includes(cpuLabel) === !cpuWasVisible;
    }, 15000, 'banner localizado tras cambiar CPU');

    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-terminal"]'));
    const restoredCpuInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
    if (Boolean(await property(restoredCpuInput, 'checked')) !== !cpuWasVisible) {
        throw new Error('La opción CPU no persistió al reabrir Ajustes');
    }
    await clickInView(restoredCpuInput);
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => {
        const savedInput = await findWhenReady('[data-testid="settings-banner-cpu"]');
        return Boolean(await property(savedInput, 'checked')) === cpuWasVisible;
    }, 5000, 'restauración persistida de la opción CPU');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras restaurar CPU');
    await sendTerminalLine('clear');
    await sendTerminalLine('sysinfo');
    await waitUntil(async () => {
        const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return latestBannerBlock(text).includes(cpuLabel) === cpuWasVisible;
    }, 15000, 'banner localizado tras restaurar CPU');
    recordEvent('preference', { name: 'banner.cpu', changed: !cpuWasVisible, restored: cpuWasVisible, label: cpuLabel });

    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    // El contrato del panel mantiene el orden Apariencia, Terminal,
    // Comportamiento, Información; usar el índice evita depender de que una
    // traducción concreta cambie la etiqueta visible de la pestaña.
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
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
        await clickInView(await findWhenReady('[data-testid="settings-save"]'));
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
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes');
    if ((await findAll('.explorer')).length === 0) {
        await click(await findWhenReady('.side-toggle:not(.panes)'));
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
    await click(await findWhenReady('[data-testid="toolbar-library"]'));
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
    await click(await findWhenReady('[data-testid="scripts-ltools"] > summary'));
    if ((await attribute(ltoolsSection, 'open')) !== 'true') throw new Error('No se pudo desplegar el catálogo de acciones de LTools');
    const ltoolsText = await textOf(ltoolsSection);
    // El catálogo puede reemplazar sus botones cuando termina una sonda de
    // disponibilidad. No conserves referencias WebDriver a esos nodos entre
    // renders: leer el acordeón ya estabilizado evita el falso fallo
    // «[object Object]» sin dejar de comprobar que la opción existe.
    const installControlVisible = /Obtener LTools|Get LTools/i.test(ltoolsText);
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
    await click(await findWhenReady('.types > summary'));
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
        await click(await findWhenReady('[role="dialog"] .panel-close'));
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
    if (process.platform !== 'win32') {
        if (!explorerOriginalPath.startsWith('/')) {
            throw new Error(`El explorador Linux no mostró una ruta absoluta: ${JSON.stringify(explorerOriginalPath)}`);
        }
        await click(await findWhenReady('.cell:not(.hidden) .xterm'));
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
        passed: true,
    });

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
    recordEvent('context-menu', { actions: ['cut', 'delete'] });
    await click(await findWhenReady('.menu-backdrop'));

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
    await click(await findWhenReady('.menu-backdrop'));

    markPhase('proyectos');
    // Proyectos: recorrer los tres modos prueba que el contenido se desmonta
    // y vuelve a cargar sin romper el panel.
    await click(await findWhenReady('[data-testid="toolbar-projects"]'));
    await findWhenReady('[role="dialog"]');
    const projectTabs = await findAll('[role="dialog"] [role="tab"]');
    if (projectTabs.length < 3) throw new Error(`Proyectos no muestra sus tres modos: ${projectTabs.length}`);
    for (const tab of projectTabs) await click(tab[elementKey]);
    await click(await findWhenReady('[role="dialog"] .panel-close'));

    markPhase('entorno y dependencias');
    // Dependencias: cargar el catálogo, abrir Compatibilidad Windows y un
    // submenú, pero no ejecutar instalaciones ni cambios del sistema.
    await click(await findWhenReady('[data-testid="toolbar-dependencies"]'));
    await findWhenReady('[role="dialog"] .filters');
    await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0, 20000, 'grupos de dependencias');
    // `load()` pinta primero el inventario rápido y completa la detección en
    // segundo plano. La actualización ya no se expone como botón: evitar una
    // segunda acción que hacía competir a WebDriver con la sustitución de la
    // lista también elimina un estado visual sin utilidad para el usuario.
    await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0,
        90000, 'fin de la detección de dependencias');
    if ((await findAll('[data-testid="dependency-refresh"]')).length > 0) {
        throw new Error('Dependencias todavía expone el botón de actualización eliminado');
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
    if (!sectionIds.has('environments') || !sectionIds.has('development')) {
        throw new Error(`Dependencias no separa entornos y desarrollo: ${[...sectionIds].join(', ')}`);
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
            await click(await findWhenReady(`[data-testid="dependency-section"][data-section-id="${compatibilitySectionId}"] > summary.section-header`));
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
    if (!nativeWindows) {
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
    await click(await findWhenReady('[role="dialog"] .panel-close'));

    // Abrir y cerrar Dependencias varias veces comprueba que las respuestas de
    // detección tardías no pisan la lista de una apertura posterior.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await click(await findWhenReady('[data-testid="toolbar-dependencies"]'));
        await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0, 10000, 'recarga de dependencias');
        const repeatedGroups = await findAll('[data-testid="dependency-group"]');
        if (repeatedGroups.length !== dependencyGroups.length) {
            throw new Error(`Dependencias cambió de tamaño en la repetición ${attempt + 1}: ${dependencyGroups.length} -> ${repeatedGroups.length}`);
        }
        await click(await findWhenReady('[role="dialog"] .panel-close'));
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
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
    const exclusiveInput = await findWhenReady('[data-testid="settings-exclusive-groups"]');
    const autoOpenInput = await findWhenReady('[data-testid="settings-auto-open-first"]');
    const originalExclusive = Boolean(await property(exclusiveInput, 'checked'));
    const originalAutoOpen = Boolean(await property(autoOpenInput, 'checked'));
    if (!originalExclusive) await clickInView(exclusiveInput);
    if (originalAutoOpen) await clickInView(autoOpenInput);
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => {
        const dialogInput = await findWhenReady('[data-testid="settings-exclusive-groups"]');
        const dialogAuto = await findWhenReady('[data-testid="settings-auto-open-first"]');
        return Boolean(await property(dialogInput, 'checked')) && !Boolean(await property(dialogAuto, 'checked'));
    }, 5000, 'preferencias de listas exclusivas');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes de acordeones');

    await click(await findWhenReady('[data-testid="toolbar-dependencies"]'));
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
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras probar listas exclusivas');

    // Con exclusividad desactivada, dos listas del mismo panel deben poder
    // permanecer abiertas simultáneamente.
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
    const exclusiveOffInput = await findWhenReady('[data-testid="settings-exclusive-groups"]');
    if (Boolean(await property(exclusiveOffInput, 'checked'))) await clickInView(exclusiveOffInput);
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => !Boolean(await property(await findWhenReady('[data-testid="settings-exclusive-groups"]'), 'checked')),
        5000, 'desactivación de acordeón exclusivo');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras desactivar exclusividad');

    await click(await findWhenReady('[data-testid="toolbar-dependencies"]'));
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
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre tras probar listas múltiples');

    // Restaurar exactamente las dos preferencias del perfil del usuario.
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
    const restoreExclusive = await findWhenReady('[data-testid="settings-exclusive-groups"]');
    const restoreAuto = await findWhenReady('[data-testid="settings-auto-open-first"]');
    if (Boolean(await property(restoreExclusive, 'checked')) !== originalExclusive) await clickInView(restoreExclusive);
    if (Boolean(await property(restoreAuto, 'checked')) !== originalAutoOpen) await clickInView(restoreAuto);
    await clickInView(await findWhenReady('[data-testid="settings-save"]'));
    await waitUntil(async () => {
        return Boolean(await property(await findWhenReady('[data-testid="settings-exclusive-groups"]'), 'checked')) === originalExclusive
            && Boolean(await property(await findWhenReady('[data-testid="settings-auto-open-first"]'), 'checked')) === originalAutoOpen;
    }, 5000, 'restauración de preferencias de listas');
    await click(await findWhenReady('[role="dialog"] .panel-close'));
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
    const splitButton = await findWhenReady('.side-toggle.panes');
    // La transición anterior de mínimo responsive puede terminar un frame
    // después de ocultar la segunda casilla. Asegurar 1 panel aquí evita que
    // la captura «antes» mezcle accidentalmente la terminal nueva con la que
    // contiene la ayuda.
    for (let attempt = 0; attempt < 4 && (await visiblePanes()).length !== 1; attempt += 1) {
        await click(splitButton);
        await new Promise((resolve) => setTimeout(resolve, 220));
    }
    await waitUntil(async () => (await visiblePanes()).length === 1, 15000, 'estado de una pestaña antes de ayuda');
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
    await waitUntil(async () => (await visiblePanes()).length === 2, 15000, 'atajo de división a dos paneles');
    await captureScreenshot('atajo-division-dos-paneles');
    await sendWindowShortcut(['\uE009', '\uE008', '\\']);
    await waitUntil(async () => (await visiblePanes()).length === 3, 15000, 'atajo de división a tres paneles');
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
    for (let attempt = 0; attempt < 4 && (await visiblePanes()).length !== 1; attempt += 1) {
        await click(splitButton);
        await new Promise((resolve) => setTimeout(resolve, 180));
    }
    await waitUntil(async () => (await visiblePanes()).length === 1, 15000, 'restauración de una pestaña tras atajos');

    // La ayuda debe sobrevivir intacta a la operación que más cambia la
    // geometría: una pestaña única pasa a dos paneles. Se comprueba la frase
    // completa antes y después, no solo que exista alguna fila con «xterm»;
    // así se detecta la pérdida parcial de «otros» observada manualmente.
    await sendTerminalLine('ayuda internos');
    await assertLongHelpLineIntact('ayuda antes de dividir');
    await captureScreenshot('help-linea-larga-antes-dividir');
    // La ayuda se valida además de forma estática en Rust. Para comprobar el
    // reflow del terminal con texto arbitrario se usa un bloque reducido de
    // salidas de CMD que cabe entero en el viewport, evitando confundir una
    // línea legítimamente desplazada al historial con texto perdido.
    await sendTerminalLine('clear');
    for (const line of REFLOW_SHELL_LINES) await sendTerminalLine(`echo ${line}`);
    await assertTerminalFragmentsIntact('salidas largas de shell antes de dividir', REFLOW_SHELL_LINES);
    await click(splitButton);
    await waitUntil(
        async () => (await visiblePanes()).length === 2,
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
    const horizontalHelpSnapshot = await terminalHorizontalSnapshot(await findWhenReady('.cell:not(.hidden)'));
    const horizontalCell = await findWhenReady('.cell:not(.hidden)');
    const horizontalProbe = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const terminalHost = arguments[0].querySelector('[data-testid="terminal-host"]');
            if (!terminalHost) return null;
            const maximum = Math.max(0, terminalHost.scrollWidth - terminalHost.clientWidth);
            terminalHost.scrollLeft = maximum;
            const moved = terminalHost.scrollLeft;
            terminalHost.scrollLeft = 0;
            return { maximum, moved, clientWidth: terminalHost.clientWidth, scrollWidth: terminalHost.scrollWidth };`,
        args: [{ [elementKey]: horizontalCell }],
    });
    const horizontalWheelProbe = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const terminalHost = arguments[0].querySelector('[data-testid="terminal-host"]');
            if (!terminalHost) return null;
            const maximum = Math.max(0, terminalHost.scrollWidth - terminalHost.clientWidth);
            terminalHost.scrollLeft = 0;
            const dispatchWheel = (deltaY, deltaMode) => {
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
        || horizontalHelpSnapshot.host.scrollWidth <= horizontalHelpSnapshot.host.clientWidth
        || horizontalHelpSnapshot.indicator?.opacity !== '1'
        || !horizontalProbe
        || horizontalProbe.maximum <= 0
        || horizontalProbe.moved <= 0) {
        await captureScreenshot('scroll-horizontal-no-visible');
        throw new Error(`El scroll horizontal no quedó disponible en la ayuda: ${JSON.stringify({ horizontalHelpSnapshot, horizontalProbe })}`);
    }
    if (!horizontalWheelProbe
        || horizontalWheelProbe.maximum <= 0
        || horizontalWheelProbe.lineMode?.moved <= 0
        || !horizontalWheelProbe.lineMode?.defaultPrevented
        || horizontalWheelProbe.pixelMode?.moved <= 0
        || !horizontalWheelProbe.pixelMode?.defaultPrevented
        || horizontalWheelProbe.pageMode?.moved <= 0
        || !horizontalWheelProbe.pageMode?.defaultPrevented) {
        await captureScreenshot('scroll-horizontal-wheel-no-visible');
        throw new Error(`Shift+rueda no desplazó horizontalmente la ayuda: ${JSON.stringify({ horizontalHelpSnapshot, horizontalWheelProbe })}`);
    }
    recordEvent('horizontal-help-geometry', { snapshot: horizontalHelpSnapshot, horizontalWheelProbe, passed: true });

    const helpCols = Number(horizontalHelpSnapshot.host.cols);
    const helpContentWidth = Math.max(
        horizontalHelpSnapshot.screen?.rectWidth ?? 0,
        horizontalHelpSnapshot.screen?.scrollWidth ?? 0,
        horizontalHelpSnapshot.host.scrollWidth,
    );
    const cellWidth = helpContentWidth / Math.max(1, helpCols);
    const visibleCols = Math.floor(horizontalHelpSnapshot.host.clientWidth / Math.max(1, cellWidth));
    if (!Number.isFinite(helpCols) || helpCols <= visibleCols || visibleCols < 10) {
        await captureScreenshot('scroll-horizontal-ancho-inicial-incoherente');
        throw new Error(`La ayuda no produjo una rejilla horizontal medible: ${JSON.stringify({ helpCols, visibleCols, horizontalHelpSnapshot })}`);
    }
    const reclaimCommands = Math.min(64, Math.max(24, Number(horizontalHelpSnapshot.host.rows || 24) + 4));
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
    // Mantener cada orden corta: WebDriver/xterm puede perder caracteres al
    // inyectar una línea de cientos de caracteres. Esperar cada resultado
    // evita medir el texto ecoado de readline como si fuera salida del PTY.
    let reclaimMarkerVisible = false;
    let reclaimOutputSummary = [];
    let reclaimTerminalTail = '';
    for (const [index, line] of reclaimOutputLines.entries()) {
        await sendTerminalLine(`echo ${line}`, horizontalCell);
        try {
            await waitUntil(async () => {
                const terminalText = await rawTerminalTextWithin(horizontalCell);
                reclaimTerminalTail = String(terminalText ?? '').slice(-1200);
                reclaimOutputSummary = probeOutputMarkerRows(terminalText, `echo ${line}`, line);
                reclaimMarkerVisible = reclaimOutputSummary.some((row) => row.markerAfterEchoRemoval);
                return reclaimMarkerVisible;
            }, 8000, `salida PTY del marcador ${index + 1}/${reclaimOutputLines.length}`);
        } catch (error) {
            throw new Error(`${error.message}; filasPTY=${JSON.stringify(reclaimOutputSummary)}; terminalTail=${JSON.stringify(reclaimTerminalTail)}`, { cause: error });
        }
    }
    let finalWidthSnapshot = horizontalHelpSnapshot;
    try {
        await waitUntil(async () => {
            finalWidthSnapshot = await terminalHorizontalSnapshot(horizontalCell);
            return Number(finalWidthSnapshot.host?.cols) <= visibleCols + 1
                && finalWidthSnapshot.host.scrollWidth <= finalWidthSnapshot.host.clientWidth + 2
                && finalWidthSnapshot.host.overflow !== 'true';
        }, 20000, 'recuperación del ancho visible con la ayuda en el scrollback');
    } catch (error) {
        await captureScreenshot('scroll-horizontal-ancho-no-recuperado');
        throw new Error(`El PTY no recuperó el ancho visible después de desplazar la ayuda: ${JSON.stringify({ helpCols, visibleCols, reclaimMarkerVisible, finalWidthSnapshot })}`, { cause: error });
    }
    await captureScreenshot('scroll-horizontal-ancho-recuperado');
    const oldestReclaimLine = reclaimOutputLines[0];
    const newestReclaimLine = reclaimOutputLines.at(-1);
    const scrollUp = { dispatched: 0, prevented: 0 };
    let scrolledBackText = '';
    let oldestOutputVisible = false;
    // Encontrar la primera salida con incrementos pequeños evita saltar por
    // encima de ella hasta el texto de ayuda anterior, que también vive en el
    // scrollback y podría ocultar una pérdida parcial de líneas recientes.
    for (let attempt = 0; attempt < reclaimOutputLines.length * 2 && !oldestOutputVisible; attempt += 1) {
        const step = await dispatchTerminalWheel(horizontalCell, -120);
        scrollUp.dispatched += step?.dispatched ?? 0;
        scrollUp.prevented += step?.prevented ?? 0;
        scrolledBackText = await rawTerminalTextWithin(horizontalCell);
        oldestOutputVisible = probeOutputMarkerRows(
            scrolledBackText,
            `echo ${oldestReclaimLine}`,
            oldestReclaimLine,
        ).some((row) => row.markerAfterEchoRemoval);
    }
    if (!oldestOutputVisible) {
        await captureScreenshot('scroll-horizontal-scrollback-no-historial');
        throw new Error(`La rueda vertical no recuperó la salida antigua tras reducir el PTY: ${JSON.stringify({
            scrollUp,
            oldestReclaimLine,
            tail: String(scrolledBackText ?? '').slice(-1200),
        })}`);
    }
    await captureScreenshot('scroll-horizontal-scrollback-recuperado');
    const scrollDown = { dispatched: 0, prevented: 0 };
    let restoredText = '';
    let newestOutputVisible = false;
    for (let attempt = 0; attempt < reclaimOutputLines.length * 2 && !newestOutputVisible; attempt += 1) {
        const step = await dispatchTerminalWheel(horizontalCell, 120);
        scrollDown.dispatched += step?.dispatched ?? 0;
        scrollDown.prevented += step?.prevented ?? 0;
        restoredText = await rawTerminalTextWithin(horizontalCell);
        newestOutputVisible = probeOutputMarkerRows(
            restoredText,
            `echo ${newestReclaimLine}`,
            newestReclaimLine,
        ).some((row) => row.markerAfterEchoRemoval);
    }
    if (!newestOutputVisible) {
        await captureScreenshot('scroll-horizontal-scrollback-no-restaurado');
        throw new Error(`La rueda vertical no devolvió la terminal al final del scrollback: ${JSON.stringify({
            scrollDown,
            newestReclaimLine,
            tail: String(restoredText ?? '').slice(-1200),
        })}`);
    }
    recordEvent('terminal-columns-reclaim', {
        beforeCols: helpCols,
        visibleCols,
        afterCols: Number(finalWidthSnapshot.host.cols),
        hostWidth: finalWidthSnapshot.host.clientWidth,
        hostScrollWidth: finalWidthSnapshot.host.scrollWidth,
        generatedLines: reclaimOutputLines.length,
        outputMarkerVisible: reclaimMarkerVisible,
        oldestOutputVisibleAfterWheelUp: oldestOutputVisible,
        newestOutputVisibleAfterWheelDown: newestOutputVisible,
        scrollUp,
        scrollDown,
        passed: true,
    });
    await captureScreenshot('help-linea-larga-despues-dividir');
    // Volver al estado inicial deja la secuencia general determinista y evita
    // que esta comprobación añada un panel adicional al resto del smoke.
    // El control rota el número de paneles y puede recibir un clic duplicado
    // mientras WebView2 termina de montar la nueva casilla. Volver a 1 de
    // forma idempotente evita que una transición intermedia contamine el
    // resto de las comprobaciones.
    for (let attempt = 0; attempt < 4 && (await visiblePanes()).length !== 1; attempt += 1) {
        await click(splitButton);
        await new Promise((resolve) => setTimeout(resolve, 180));
    }
    await waitUntil(
        async () => (await visiblePanes()).length === 1,
        15000,
        'restauración de una pestaña tras comprobar ayuda',
    );
    recordEvent('help-line-integrity-split', { from: 1, to: 2, passed: true });

    // Reproduce la secuencia manual que más fácilmente dejaba una casilla con
    // la cola del banner anterior: 1→2→3→4→1 y vuelta a 4. Cada transición
    // comprueba geometría y que TODAS las casillas empiezan por su cabecera.
    const paneSequence = [
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
        await click(splitButton);
        await waitUntil(
            async () => (await visiblePanes()).length === target,
            15000,
            `cambio a ${target} panel(es)`,
        );
        const actual = await resizeWindow(width, height, { waitForBanner: false });
        await assertPaneOutputStable(target, `rejilla ${target} paneles tras ${currentPaneCount}`);
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
    for (let attempt = 0; attempt < 4; attempt += 1) await click(splitButton);
    await waitUntil(
        async () => (await visiblePanes()).length === 4,
        15000,
        'estabilización tras clics concurrentes de división',
    );
    const burstCount = (await visiblePanes()).length;
    if (burstCount > 4) {
        throw new Error(`Los clics concurrentes crearon demasiados paneles: 4 -> ${burstCount}`);
    }
    await assertPaneOutputStable(4, 'rejilla 4 paneles tras clics concurrentes');
    await captureScreenshot('rejilla-4-estable-clics-concurrentes');
    paneTransitions.push({ from: 4, to: 4, burst: true, elapsedMs: null });
    const stablePaneCount = currentPaneCount;
    const finalCount = await waitForPaneCount(stablePaneCount, 5000);
    if (finalCount !== stablePaneCount) {
        throw new Error(`El redimensionado alteró los paneles visibles: ${stablePaneCount} -> ${finalCount}`);
    }
    recordEvent('pane-sequence', { transitions: paneTransitions, finalCount });
    process.stdout.write(`E2E banner OK: secuencia 1→2→3→4→1→4, ${stablePaneCount} paneles finales\n`);

    // Carrera crítica: dejar una línea larga en edición y redimensionar antes
    // de pulsar Enter. La cabecera y la shell deben seguir en regiones distintas.
    const focusedPane = await findWhenReady('.cell.focused');
    const longInput = `echo LTERMINAL_LONG_INPUT_${'x'.repeat(180)}`;
    await sendTerminalKeys(longInput, focusedPane, { enter: false, settle: false });
    await resizeWindow(980, 640, { waitForBanner: false });
    // Liberamos la edición; el frontend debe conservar esa fila lógica ancha y
    // ejecutar el repintado pendiente cuando la shell haya terminado de ecoar
    // la orden.
    await sendTerminalKeys('', focusedPane, { enter: true, settle: true });
    await assertPaneOutputStable(stablePaneCount, 'entrada larga tras redimensionar');
    const raceTexts = await visualBannerTexts(stablePaneCount);
    const raceBlocks = raceTexts.map(latestBannerBlock);
    const raceHeaders = raceBlocks.map(firstNonEmptyTerminalLine);
    // El banner ya no se reinyecta en cada resize: una casilla puede empezar
    // por la cola legítima de su scrollback. Solo es un fallo si la entrada
    // larga aparece dentro de un bloque que sí contiene cabecera.
    if (raceHeaders.some((header) => header.includes('LTERMINAL_LONG_INPUT'))) {
        throw new Error(`La entrada de la shell atravesó el fastfetch: ${JSON.stringify(raceHeaders)}`);
    }
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
        await click(await findWhenReady('[data-testid="toolbar-settings"]'));
        await findWhenReady('[role="dialog"]');
        recordEvent('panel', { panel: 'settings', open: true, attempt: attempt + 1 });
        await click(await findWhenReady('[role="dialog"] .panel-close'));
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes');
        recordEvent('panel', { panel: 'settings', open: false, attempt: attempt + 1 });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await click(await findWhenReady('[data-testid="toolbar-library"]'));
        const library = await findWhenReady('[role="dialog"]');
        const ltoolsAccess = await findWhenReady('[data-testid="scripts-ltools"]', 5000);
        await click(await findWhenReady('[data-testid="scripts-ltools"] > summary'));
        if ((await attribute(ltoolsAccess, 'open')) !== 'true') {
            throw new Error(`Acciones de LTools no se abrieron en la repetición ${attempt + 1}`);
        }
        recordEvent('submenu', { panel: 'library', submenu: 'ltools', open: true, attempt: attempt + 1 });
        await click(await findWhenReady('[role="dialog"] .panel-close'));
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
        await click(await findWhenReady('[data-testid="toolbar-settings"]'));
        await findWhenReady('[role="dialog"]');
        await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
        let restoreVisibility = false;
        for (const [name, testId] of Object.entries(VISIBILITY_CONTROLS)) {
            const input = await findWhenReady(`[data-testid="${testId}"]`);
            const current = Boolean(await property(input, 'checked'));
            if (current !== panelVisibilityInitial[name]) {
                await clickInView(input);
                restoreVisibility = true;
            }
        }
        if (restoreVisibility) await clickInView(await findWhenReady('[data-testid="settings-save"]'));
        recordEvent('preference', { name: 'panelVisibility', value: panelVisibilityInitial, source: 'restored' });
        await click(await findWhenReady('[role="dialog"] .panel-close'));
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
    // Una captura en el punto exacto del fallo es imprescindible para
    // distinguir un problema de lógica DOM de un repintado roto de xterm.
    // Se conserva junto al informe cuando el smoke falla, igual que el perfil
    // WebView2 de diagnóstico.
    await captureScreenshot('fallo');
    throw error;
} finally {
    if (sessionId) await request(`/session/${sessionId}`, 'DELETE').catch(() => {});
    try {
        const cleanup = await stopDriverProcessTree();
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
    await writeFile(smokeReportPath, `${JSON.stringify(smokeReport, null, 2)}\n`).catch((error) => {
        process.stderr.write(`No se pudo escribir el informe de smoke ${smokeReportPath}: ${error}\n`);
    });
    process.stdout.write(`E2E informe: ${smokeReportPath}\n`);
}
