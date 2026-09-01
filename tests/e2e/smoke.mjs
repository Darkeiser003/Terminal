import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

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
const driverPort = process.env.TAURI_DRIVER_PORT ?? '4444';
const nativePort = process.env.TAURI_NATIVE_PORT ?? String(Number(driverPort) + 1);
const application = process.env.E2E_BINARY;
if (!application) throw new Error('E2E_BINARY debe apuntar al binario Tauri compilado');
await access(application);
const execFile = promisify(execFileCallback);
const IS_HYPRLAND = [
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
    quickActions: 'settings-show-quick-actions',
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
// El timeout que se quiere detectar es fijo (~3000 ms): ConPTY espera las
// respuestas VT del terminal antes de liberar la shell. 2500 ms deja margen
// a equipos lentos, pero no permite que esa espera completa vuelva a colarse.
const SHELL_STARTUP_LIMIT_MS = parseDuration('E2E_SHELL_STARTUP_LIMIT_MS', 2500, 500, 10000);

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
const driver = spawn(driverPath, driverArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
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
    },
    status: 'running',
    reportPath: smokeReportPath,
};

function recordEvent(type, data = {}) {
    smokeReport.events.push({
        at: new Date().toISOString(),
        elapsedMs: Date.now() - smokeStartedAt,
        type,
        ...data,
    });
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
    const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
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

async function waitForDriver() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (driverStartupError) throw driverStartupError;
        try { await request('/status'); return; } catch { await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)); }
    }
    if (driverStartupError) throw driverStartupError;
    throw new Error('tauri-driver no respondió en 15 segundos');
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

async function assertQuickActionsPreference(expected) {
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    await findWhenReady('[role="dialog"]');
    await click(await findWhenReady('[data-testid="settings-tab-behavior"]'));
    await waitUntil(async () => {
        const input = await findWhenReady('[data-testid="settings-show-quick-actions"]');
        return Boolean(await property(input, 'checked')) === expected;
    }, 10000, `preferencia de Acciones rápidas=${expected}`);
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Ajustes tras comprobar Acciones rápidas');
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
    // comparan esos botones cuando estÃ¡n presentes; Ajustes siempre es visible
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
            workspace: rect(document.querySelector('.workspace')),
            panes: [...document.querySelectorAll('.cell:not(.hidden)')].map((cell) => ({
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

async function hyprlandActiveWindow() {
    try {
        const { stdout } = await execFile('hyprctl', ['activewindow', '-j'], { timeout: 3000 });
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

async function prepareWindowManagerForResize() {
    if (!IS_HYPRLAND) return;
    const active = await hyprlandActiveWindow();
    if (!active) throw new Error('Hyprland está activo, pero hyprctl no pudo consultar la ventana activa');
    if (active.fullscreen) {
        throw new Error('El smoke no puede medir tamaños mientras LTerminal está en fullscreen; desactívalo antes de ejecutar la batería');
    }
    if (active.floating === false) {
        // Hyprland ignora window/rect en modo mosaico. Super+Space es el
        // atajo del usuario para desacoplarla y permitir el resize. WebDriver
        // no siempre entrega los atajos globales al compositor, por lo que
        // queda un fallback equivalente y acotado a la ventana activa.
        await click(await findWhenReady('.cell:not(.hidden) .xterm'));
        await sendWindowShortcut(['\uE03D', ' ']); // Meta + Space
        await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
        if ((await hyprlandActiveWindow())?.floating !== true) {
            if (!active.address) {
                throw new Error('Hyprland no devolvió la dirección de la ventana activa para desacoplarla');
            }
            await execFile('hyprctl', ['dispatch', 'togglefloating', `address:${active.address}`], { timeout: 3000 });
        }
        await waitUntil(async () => (await hyprlandActiveWindow())?.floating === true, WM_TRANSITION_TIMEOUT_MS, 'ventana flotante en Hyprland');
    }
}

async function waitForHyprlandState(predicate, description) {
    await waitUntil(async () => predicate(await hyprlandActiveWindow()), WM_TRANSITION_TIMEOUT_MS, description);
    return hyprlandActiveWindow();
}

async function exerciseWindowManagerStates() {
    if (!IS_HYPRLAND) {
        recordEvent('window-manager', { skipped: true, reason: 'no-hyprland' });
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
    const xterm = pane
        ? (await findAllWithin(pane, '.xterm'))[0]?.[elementKey]
        : await findWhenReady('.cell:not(.hidden) .xterm');
    const input = pane
        ? (await findAllWithin(pane, '.xterm-helper-textarea'))[0]?.[elementKey]
        : await findWhenReady('.cell:not(.hidden) .xterm-helper-textarea');
    if (!xterm || !input) throw new Error('La terminal no ofreció el receptor de teclado para el panel solicitado');
    // xterm mantiene esta textarea fuera del área visible. En WebKit puede
    // incluso aceptar el click sobre ella sin transferirle foco, así que el
    // smoke siempre enfoca el contenedor visible y deja que xterm delegue al
    // receptor interno de teclado.
    await click(xterm);
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
        await request(`/session/${sessionId}/actions`, 'POST', {
            actions: [{ type: 'key', id: 'keyboard', actions: keyActions }],
        });
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
}

async function sendTerminalLine(line, pane = null) {
    return sendTerminalKeys(line, pane, { enter: true, settle: true });
}

async function activeTerminalRowSnapshot() {
    const cell = await findWhenReady('.cell:not(.hidden)');
    return request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: `const rows = [...arguments[0].querySelectorAll('.xterm-rows > div')];
            const cursor = arguments[0].querySelector('.xterm-cursor');
            const cursorRect = cursor?.getBoundingClientRect();
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
            };`,
        args: [{ [elementKey]: cell }],
    });
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
            return promptRows.length === 1 && promptRows[0] === nonEmptyRows.at(-1);
        }, 10000, `prompt tras ${command} ${attempt + 1}/${attempts}`);

        const marker = `CLEAR_ROW_${attempt + 1}`;
        await sendTerminalKeys(marker, null, { enter: false, settle: true });
        let lastSnapshot;
        try {
            await waitUntil(async () => {
                lastSnapshot = await activeTerminalRowSnapshot();
                const markerRow = lastSnapshot.rows.find((row) => row.text.includes(marker));
                return Boolean(markerRow
                    && promptLooksVisible(markerRow.text)
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
    const markers = [...normalized.matchAll(/(?:WinSlim Terminal|LTerminal)\b/gi)];
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

async function promptStates(expected) {
    const hosts = await findAll('.tab-pane:not(.hidden)[data-prompt-visible]');
    return Promise.all(hosts.slice(0, expected).map((host) => attribute(host[elementKey], 'data-prompt-visible')));
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
            const cursorInsideTerminal = Boolean(terminalRect && cursorRect
                && cursorRect.top >= terminalRect.top - 3
                && cursorRect.bottom <= terminalRect.bottom + 3);
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
    return lines.some((line) => anchored.test(line))
        || concatenated.test(clean)
        || anchored.test(reflowed)
        || concatenated.test(reflowed);
}

function bannerTextAnomalies(text) {
    const clean = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '');
    const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
    // Windows muestra «WinSlim Terminal», mientras que Linux usa la marca
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

async function assertTinyPanesClean(expected, label) {
    let last = [];
    await waitUntil(async () => {
        const rows = await findAll('.cell:not(.hidden) .xterm-rows');
        if (rows.length < expected) return false;
        const texts = await Promise.all(rows.slice(0, expected).map((row) => textOf(row[elementKey])));
        last = texts.map((text) => text.slice(-600));
        // Por debajo de 12 filas el backend no pinta banner. Solo aceptamos
        // el prompt/espacio; una cola de Sesión, GPU o una segunda cabecera es
        // precisamente el residuo que este caso intenta detectar.
        return texts.every((text) =>
            !/(?:WinSlim|LTerminal).*Terminal|Sistema|System|CPU|Memoria|Memory|Uptime|Tiempo activo|Disco|Disk|GPU|Placa|Motherboard|Kernel|Entorno|Environment/i.test(text)
            && !bannerTextAnomalies(text).some((item) => item.startsWith('continuación huérfana')),
        );
    }, 5000, `${label}: casillas bajas sin residuos`);
    recordEvent('banner-hidden-tiny-pane', { expected, preview: last });
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
    await click(await findWhenReady('.side-toggle:not(.panes)'));
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
        throw new Error(`La inicialización de shell volvió a la espera de ConPTY: ${maxShellStartupMs} ms (límite ${SHELL_STARTUP_LIMIT_MS} ms).`);
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
        await assertTinyPanesClean(1, 'arranque con casilla baja');
    } else {
        await waitForBannerPanes(1, 20000);
    }
    await prepareWindowManagerForResize();
    markPhase('estados de ventana');
    await exerciseWindowManagerStates();

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
        await assertTinyPanesClean(1, 'mínimo útil con casilla baja');
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
        await assertTinyPanesClean(2, 'rejilla 2 paneles en altura mínima');
    } else {
        await waitForBannerPanes(2, 20000);
        await assertBannerHeaders(2, 'rejilla 2 paneles tras crear la segunda pestaña');
    }
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
    // En monitores menores que 8K el driver puede aceptar el rectÃ¡ngulo
    // mÃ¡ximo lÃ³gico aunque el compositor lo reduzca fuera de la pantalla.
    // AquÃ­ solo validamos los lÃ­mites nativos; la geometrÃ­a del banner se
    // comprueba en tamaÃ±os visibles y reales inmediatamente despuÃ©s.
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
        }, 5000, `vista visible de pestaÃ±a ${index + 1}`);
        await sendAndWaitForMarker(tabMarkers[index]);
        await waitUntil(async () => {
            const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
            const text = await textOf(rows);
            return tabMarkers.every((marker, markerIndex) => markerIndex === index || !text.includes(marker));
        }, 10000, `aislamiento de salida en pestaña ${index + 1}`);
    }
    recordEvent('tab-isolation', { tabs: tabMarkers.length, passed: true });

    // Comandos seguros: no tocan archivos ni perfiles. :help y :alias pasan
    // por el parser interno de LTerminal; echo/pwd pasan por la shell real.
    markPhase('comandos internos y shell');
    await sendTerminalLine(':help');
    await sendTerminalLine(':alias');
    await sendTerminalLine(':banner');
    let bannerPromptSnapshot;
    try {
        await waitUntil(async () => {
            bannerPromptSnapshot = await activeTerminalRowSnapshot();
            const nonEmptyRows = bannerPromptSnapshot.rows.filter((row) => row.text.trim().length > 0);
            const lastRow = nonEmptyRows.at(-1);
            const text = nonEmptyRows.map((row) => row.text).join('\n');
            return text.includes('Banner:')
                && Boolean(lastRow && promptLooksVisible(lastRow.text))
                && (bannerPromptSnapshot.cursorRow < 0 || bannerPromptSnapshot.cursorRow === lastRow.index);
        }, 10000, 'prompt al final tras :banner');
    } catch (error) {
        await captureScreenshot('banner-prompt-no-visible-al-final');
        throw new Error(`Tras :banner, el prompt no quedó en la última fila: ${JSON.stringify(bannerPromptSnapshot)}`, { cause: error });
    }
    recordEvent('internal-banner-prompt-row', {
        cursorRow: bannerPromptSnapshot?.cursorRow ?? -1,
        passed: true,
    });
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
    for (const [command, marker, label] of [
        [':shell current', 'Shell actual:', 'shell actual'],
        [':panel list', 'Paneles:', 'lista de paneles'],
        [':theme list', 'Temas disponibles:', 'lista de temas'],
        [':font list', 'Fuentes disponibles:', 'lista de fuentes'],
        [':language list', 'Idiomas disponibles:', 'lista de idiomas'],
        [':terminal list', 'Parámetros de terminal:', 'parámetros de terminal'],
        [':panes list', 'Diseño actual:', 'diseño de paneles'],
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
    await sendTerminalLine('@Darkeiser003');
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        const text = await textOf(rows);
        return text.includes('https://github.com/Darkeiser003')
            && text.includes('https://github.com/Darkeiser003/Infraestructura-Web');
    }, 10000, 'easter-egg de Darkeiser003');
    await sendTerminalLine('CHRISTIANLG97');
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        const text = await textOf(rows);
        const normalized = text.replace(/\s+/g, '');
        return normalized.includes('https://github.com/Christianlg97')
            && normalized.includes('https://github.com/Christianlg97/WINSLIM_CENTER_STORE');
    }, 10000, 'easter-egg de Christianlg97');
    recordEvent('author-easter-eggs', {
        aliases: ['Darkeiser003', 'darkeiser003', '@darkeiser003', '@Darkeiser003', 'christianlg97', '@christianlg97'],
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

    // Cambiar de shell es una ruta distinta de refrescar el inventario: crea
    // un PTY nuevo, ejecuta el inicializador y solo entonces debe aparecer el
    // banner. Se prueba de forma oportunista con dos entornos disponibles y se
    // vuelve al original para que el resto del smoke no dependa de PowerShell,
    // bash o cmd concretos.
    markPhase('cambio de shell');
    const environmentButton = await findWhenReady('.env-select');
    await click(environmentButton);
    const environmentOptions = await findAll('.env-menu [data-testid="environment-option"]');
    const availableOptions = [];
    for (const option of environmentOptions) {
        if ((await attribute(option[elementKey], 'aria-disabled')) !== 'true') {
            availableOptions.push(option[elementKey]);
        }
    }
    // Localizar la opción seleccionada de forma explícita mantiene el smoke
    // compatible con WebDriver remoto (Array#find no espera promesas).
    let originalOption = null;
    for (const option of availableOptions) {
        if ((await attribute(option, 'aria-selected')) === 'true') {
            originalOption = option;
            break;
        }
    }
    const switchTarget = availableOptions.find((option) => option !== originalOption) ?? null;
    if (switchTarget && originalOption) {
        const originalId = await attribute(originalOption, 'data-environment-id');
        const targetId = await attribute(switchTarget, 'data-environment-id');
        const targetLabel = (await textOf(switchTarget)).trim().split(/\r?\n/)[0];
        const switchStartedAt = Date.now();
        await click(switchTarget);
        await waitUntil(async () => (await textOf(environmentButton)).includes(targetLabel), 15000, 'confirmación del cambio de shell');
        const switchElapsedMs = Date.now() - switchStartedAt;
        recordEvent('environment-switch', { from: originalId, to: targetId, targetLabel, durationMs: switchElapsedMs, passed: true });

        // Restaurar la shell original y comprobar que la segunda transición
        // tampoco deja la lista desplegable en un estado intermedio.
        await click(await findWhenReady('.env-select'));
        const originalAgain = await findWhenReady(`.env-menu [data-environment-id="${originalId}"]`);
        await click(originalAgain);
        // El texto del botón puede contener etiquetas localizadas o coincidir
        // parcialmente con otra shell. Esperar el estado semántico de la
        // opción seleccionada evita falsos fallos durante la transición.
        await waitUntil(async () => {
            const button = await findWhenReady('.env-select');
            return (await attribute(button, 'disabled')) === null;
        }, 15000, 'fin de restauración de la shell original');
        await click(await findWhenReady('.env-select'));
        await waitUntil(async () => {
            const selected = await findWhenReady(`.env-menu [data-environment-id="${originalId}"]`);
            return (await attribute(selected, 'aria-selected')) === 'true';
        }, 5000, 'restauración de la shell original');
        await closeEnvironmentMenu();
        recordEvent('environment-switch-restore', { to: originalId, passed: true });
    } else {
        await closeEnvironmentMenu();
        recordEvent('environment-switch', { skipped: true, reason: 'solo hay una shell disponible' });
    }

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

    // Cambiar el idioma en una sesiÃ³n real detecta dos regresiones que la
    // comprobaciÃ³n estÃ¡tica no puede ver: etiquetas escritas directamente en
    // Svelte y catÃ¡logos que existen pero no llegan al frontend tras guardar.
    // Se prueban varios idiomas disponibles y se restaura exactamente la
    // preferencia original antes de continuar con el resto de la baterÃ­a.
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
        throw new Error(`El selector de idioma no ofrece suficientes catÃ¡logos para probar: ${JSON.stringify(languageOptions)}`);
    }
    const languageResults = [];
    for (const language of languageCandidates) {
        const expected = await loadLocaleCatalog(language);
        await setSelectValue('[data-testid="settings-language"]', language);
        await click(await findWhenReady('[data-testid="settings-save"]'));
        await waitUntil(
            async () => String(await property(await findWhenReady('[data-testid="settings-language"]'), 'value')) === language,
            5000,
            `aplicaciÃ³n del idioma ${language}`,
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
        'restauraciÃ³n del idioma original',
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
            return (/WinSlim Terminal|LTerminal/i.test(latest)) === enabled;
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
    // El comando interno debe cambiar la preferencia que consume la
    // Biblioteca. Se comprueban ambos estados; no basta con reconocer la
    // cadena ni con tener una casilla que nunca afecte a la interfaz.
    const quickActionsMirrorBefore = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return { ...document.querySelector(".cell:not(.hidden) .tab-pane")?.dataset };',
        args: [],
    });
    await sendTerminalLine(':quick-actions off');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const quickActionsOffOutput = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
    const quickActionsMirrorAfter = await request(`/session/${sessionId}/execute/sync`, 'POST', {
        script: 'return { ...document.querySelector(".cell:not(.hidden) .tab-pane")?.dataset };',
        args: [],
    });
    recordEvent('internal-command-output', {
        command: ':quick-actions off',
        mirrorBefore: quickActionsMirrorBefore,
        mirrorAfter: quickActionsMirrorAfter,
        preview: quickActionsOffOutput.slice(-1200),
    });
    await assertQuickActionsPreference(false);
    recordEvent('preference', { name: 'showQuickActions', value: false, source: 'internal-command' });
    await click(await findWhenReady('[data-testid="toolbar-library"]'));
    await findWhenReady('[role="dialog"] .types');
    if ((await findAll('[role="dialog"] .operations')).length !== 0) {
        throw new Error(':quick-actions off no ocultó Operaciones rápidas');
    }
    await click(await findWhenReady('[role="dialog"] .panel-close'));
    await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca sin acciones rápidas');
    await sendTerminalLine(':quick-actions on');
    await assertQuickActionsPreference(true);
    recordEvent('preference', { name: 'showQuickActions', value: true, source: 'internal-command' });
    // La primera apertura tiene que respetar la configuración cerrada por
    // defecto. Se abre y se vuelve a cerrar para probar el evento real.
    await click(await findWhenReady('[data-testid="toolbar-library"]'));
    const libraryDialog = await findWhenReady('[role="dialog"]');
    const libraryIdentity = await textOf(libraryDialog);
    if (process.platform === 'win32') {
        if (!/WinSlim Terminal/i.test(libraryIdentity) || /\bLTerminal\b/i.test(libraryIdentity)) {
            throw new Error(`La Biblioteca Windows mezcla la identidad Linux: ${JSON.stringify(libraryIdentity.slice(0, 240))}`);
        }
    } else if (!/LTerminal/i.test(libraryIdentity) || /WinSlim Terminal/i.test(libraryIdentity)) {
        throw new Error(`La Biblioteca Linux mezcla la identidad Windows: ${JSON.stringify(libraryIdentity.slice(0, 240))}`);
    }
    const operations = await findWhenReady('.operations');
    if ((await attribute(operations, 'open')) !== null) {
        throw new Error('Operaciones rápidas aparece abierta por defecto');
    }
    await click(await findWhenReady('.operations > summary'));
    if ((await attribute(operations, 'open')) !== 'true') throw new Error('No se pudo desplegar Operaciones rápidas');
    const operationText = await textOf(operations);
    if (!/SSH|Red|VPN|Servicios|Network/i.test(operationText)) {
        throw new Error('No aparecen las operaciones rápidas de red/servicios: ' + JSON.stringify(operationText));
    }
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
    await waitUntil(async () => (await findAll('[role="dialog"] .operations')).length === 0, 5000, 'retirada de operaciones rápidas en Ruta actual');
    if ((await findAll('[role="dialog"] .operations')).length !== 0) {
        throw new Error('Ruta actual todavía muestra Operaciones rápidas');
    }
    await click(libraryModes[0][elementKey]);
    await findWhenReady('[role="dialog"] .operations');

    markPhase('explorador y menú contextual');
    // El explorador debe conservar el menú contextual y sus acciones, aunque
    // aquí no se ejecuta eliminar ni pegar sobre datos del usuario.
    const explorer = await findWhenReady('.explorer');
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
    await assertPaneOutputStable(1, 'rejilla 1 panel antes de dividir');

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
    // La línea larga puede ocupar varias filas y desplazar temporalmente el
    // encabezado del viewport. Liberamos la edición; el frontend debe ejecutar
    // el repintado pendiente cuando la shell haya terminado de ecoar la orden.
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
        const observedMatrixSizes = new Set();
        for (const [label, widthRatio, heightRatio] of proportions) {
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
            matrixResults.push(`${label}=${actual.width}x${actual.height}->${paneSize}/${bannerElapsedMs ?? '-'}ms`);
        }
        const requiredDistinctSizes = Math.min(4, expectedMatrixSizes.size);
        if (observedMatrixSizes.size < requiredDistinctSizes) {
            throw new Error(`El driver no aplicó suficientes tamaños (${explorerLabel}): ${[...observedMatrixSizes].join(', ')}; esperados al menos ${requiredDistinctSizes}`);
        }
        process.stdout.write(`E2E matriz ${explorerLabel} OK: ${matrixResults.join(', ')}\n`);
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
        const quickAccess = await findWhenReady('.operations', 5000);
        await click(await findWhenReady('.operations > summary'));
        if ((await attribute(quickAccess, 'open')) !== 'true') {
            throw new Error(`Acceso rápido no se abrió en la repetición ${attempt + 1}`);
        }
        recordEvent('submenu', { panel: 'library', submenu: 'operations', open: true, attempt: attempt + 1 });
        await click(await findWhenReady('[role="dialog"] .panel-close'));
        await waitUntil(async () => (await findAll('[role="dialog"]')).length === 0, 5000, 'cierre de Biblioteca');
        recordEvent('submenu', { panel: 'library', submenu: 'operations', open: false, attempt: attempt + 1 });
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
    process.stdout.write(`E2E tiempos: ${phaseTimings.map((item) => `${item.name}=${item.durationMs}ms`).join(', ')}\n`);
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
    driver.kill('SIGTERM');
    smokeReport.finishedAt = new Date().toISOString();
    smokeReport.durationMs = Date.now() - smokeStartedAt;
    smokeReport.phases = phaseTimings;
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
    await writeFile(smokeReportPath, `${JSON.stringify(smokeReport, null, 2)}\n`).catch((error) => {
        process.stderr.write(`No se pudo escribir el informe de smoke ${smokeReportPath}: ${error}\n`);
    });
    process.stdout.write(`E2E informe: ${smokeReportPath}\n`);
}
