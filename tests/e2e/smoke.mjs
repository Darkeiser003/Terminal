import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

// WebKitGTK puede intentar crear buffers GBM aunque la sesión gráfica de
// pruebas esté disponible. Desactivarlo hace que el smoke use el compositor
// normal y evita falsos fallos en máquinas virtuales o escritorios remotos.
process.env.WEBKIT_DISABLE_DMABUF_RENDERER ??= '1';
process.env.TAURI_WEBVIEW_AUTOMATION ??= '1';

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

// Límites de la ventana: 480x270 es el cuarto de una pantalla 1920x1080;
// 7680x4320 cubre 8K sin permitir que
// una petición de WebDriver cree un viewport que el layout nunca podrá medir.
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

// Cada ejecución deja una huella propia en el log acumulativo. Así el smoke
// no confunde un error antiguo con uno actual ni da por bueno un arranque que
// solo dejó vivo el proceso.
const smokeToken = process.env.LTERMINAL_SMOKE_TOKEN ?? `e2e-${process.pid}-${Date.now()}`;
process.env.LTERMINAL_SMOKE_TOKEN = smokeToken;

const driverArgs = ['--port', driverPort, '--native-port', nativePort];
if (nativeDriver) driverArgs.push('--native-driver', nativeDriver);
const driver = spawn(driverPath, driverArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
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
const smokeReport = {
    schemaVersion: 1,
    token: smokeToken,
    startedAt: new Date(smokeStartedAt).toISOString(),
    host: {
        platform: process.platform,
        desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
        session: process.env.DESKTOP_SESSION ?? null,
        hyprland: IS_HYPRLAND,
    },
    limits: { ...WINDOW_LIMITS, ratio: 0.25 },
    phases: phaseTimings,
    events: [],
    performance: {
        events: [],
        summary: {},
    },
    options: {
        forceShellRefresh: FORCE_SHELL_REFRESH,
        pollIntervalMs: POLL_INTERVAL_MS,
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

async function waitForDriver() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try { await request('/status'); return; } catch { await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)); }
    }
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

async function sendTerminalLine(line, pane = null) {
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
    const keyActions = [...`${line}\n`].flatMap((character) => {
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
            await request(`/session/${sessionId}/element/${input}/value`, 'POST', { text: `${line}\n` });
        } catch {
            try {
                await request(`/session/${sessionId}/element/${input}/value`, 'POST', { value: [...`${line}\n`] });
            } catch {
                throw firstError;
            }
        }
    }
    await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
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
    return /CPU|Procesador|Processor/i.test(text)
        && /Memoria|Memory|RAM/i.test(text)
        && /Sistema|System|Entorno|Environment|Sesion|Session|Uptime|Tiempo activo/i.test(text);
}

async function waitForBannerPanes(expected = 1, timeoutMs = 20000) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastSnapshot = [];
    while (Date.now() < deadline) {
        const panes = await visiblePanes();
        const rows = await findAll('.cell:not(.hidden) .xterm-rows');
        if (panes.length >= expected && rows.length >= expected) {
            const texts = await Promise.all(rows.map((row) => textOf(row[elementKey])));
            lastSnapshot = texts;
            const visibleTexts = texts.slice(0, expected);
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
            const tinyViewport = geometry.panes.slice(0, expected).every((pane) =>
                pane.screen?.height > 0 && pane.screen.height < 120
            );
            const tinyBanner = tinyViewport && visibleTexts.every((text) =>
                /LTerminal|WinSlim|Terminal/i.test(text)
                && /CPU|Procesador|Processor|Sistema|System/i.test(text)
            );
            const minimalBanner = visibleTexts.every((text) =>
                /LTerminal|WinSlim|Terminal/i.test(text)
                && /CPU|Procesador|Processor/i.test(text)
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
                return markers >= 2 && /❯|\$|#|>/.test(text);
            });
            const contentReady = visibleTexts.every(bannerLooksReady) || minimalBanner || partialBanner;
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
    throw new Error(`El banner no quedó listo en ${expected} panel(es) tras ${timeoutMs} ms: ${JSON.stringify({ lastSnapshot, geometry }).slice(0, 1800)}`);
}

function assertWindowBounds(rect, label) {
    if (!rect || rect.width < WINDOW_LIMITS.minWidth || rect.height < WINDOW_LIMITS.minHeight) {
        throw new Error(`${label} permitió una ventana menor que el mínimo: ${JSON.stringify(rect)}`);
    }
    if (rect.width > WINDOW_LIMITS.maxWidth || rect.height > WINDOW_LIMITS.maxHeight) {
        throw new Error(
            `${label} superó el máximo configurado ${WINDOW_LIMITS.maxWidth}x${WINDOW_LIMITS.maxHeight}: `
            + JSON.stringify(rect),
        );
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
        'Ventana inicial mostrada',
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
            || line.includes('Ventana inicial mostrada'))
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
    smokeReport.performance = { events: performanceEvents, summary: grouped };
    process.stdout.write(`E2E log OK: sesión=${session}, errores=0, métricas=${performanceEvents.length}, archivo=${path}\n`);
}

try {
    await waitForDriver();
    const created = await request('/session', 'POST', {
        capabilities: { alwaysMatch: { 'tauri:options': { application } } },
    });
    sessionId = created.sessionId;
    markPhase('arranque de interfaz');
    await findWhenReady('.toolbar');
    await findWhenReady('.cell:not(.hidden) .xterm');
    await waitForBannerPanes(1, 20000);
    await prepareWindowManagerForResize();
    markPhase('estados de ventana');
    await exerciseWindowManagerStates();

    // Intentar salir por ambos extremos verifica que el límite no dependa de
    // la decoración del escritorio. El tamaño máximo real puede ser menor si
    // la pantalla de CI no es 8K; esa dimensión real alimenta la matriz de
    // proporciones que viene después.
    const minimumRect = await resizeWindow(WINDOW_LIMITS.minWidth, WINDOW_LIMITS.minHeight, { waitForBanner: false });
    assertWindowBounds(minimumRect, 'El mínimo configurado');
    assertResponsiveMinimum(minimumRect, 'El mínimo configurado');
    const inspectorVerticalReserve = Math.max(0, WINDOW_LIMITS.minHeight - minimumRect.content.viewport.height);
    const inspectorHorizontalReserve = Math.max(0, WINDOW_LIMITS.minWidth - minimumRect.content.viewport.width);
    const effectiveMinWidth = Math.min(
        WINDOW_LIMITS.maxWidth,
        WINDOW_LIMITS.minWidth + inspectorHorizontalReserve,
    );
    const effectiveMinHeight = Math.min(
        WINDOW_LIMITS.maxHeight,
        WINDOW_LIMITS.minHeight + inspectorVerticalReserve
            + (inspectorVerticalReserve > 0 ? 120 : 0),
    );
    process.stdout.write(
        `E2E mínimo nativo: ${minimumRect.width}x${minimumRect.height}, `
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
    await waitForBannerPanes(1, 20000);
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
    const maximumRect = await resizeWindow(WINDOW_LIMITS.maxWidth, WINDOW_LIMITS.maxHeight);
    assertWindowBounds(maximumRect, 'El máximo configurado');
    await resizeWindow(980, 640);

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
            return (await attribute(currentTabs[index][elementKey], 'class'))?.split(/\s+/).includes('active');
        }, 5000, `activación de pestaña ${index + 1}`);
        await sendTerminalLine(`echo ${tabMarkers[index]}`);
        await waitUntil(async () => {
            const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
            return (await textOf(rows)).includes(tabMarkers[index]);
        }, 15000, `respuesta PTY de pestaña ${index + 1}`);
    }
    for (let index = 0; index < tabMarkers.length; index += 1) {
        const freshTabs = await findAll('.tab');
        await click(freshTabs[index][elementKey]);
        await waitUntil(async () => {
            const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
            const text = await textOf(rows);
            return text.includes(tabMarkers[index])
                && tabMarkers.every((marker, markerIndex) => markerIndex === index || !text.includes(marker));
        }, 10000, `aislamiento de salida en pestaña ${index + 1}`);
    }
    recordEvent('tab-isolation', { tabs: tabMarkers.length, passed: true });

    // Comandos seguros: no tocan archivos ni perfiles. :help y :alias pasan
    // por el parser interno de LTerminal; echo/pwd pasan por la shell real.
    markPhase('comandos internos y shell');
    await sendTerminalLine(':help');
    await sendTerminalLine(':alias');
    await sendTerminalLine('echo LTERMINAL_E2E_COMMAND_OK');
    await waitUntil(async () => {
        const rows = await findWhenReady('.cell:not(.hidden) .xterm-rows');
        return (await textOf(rows)).includes('LTERMINAL_E2E_COMMAND_OK');
    }, 15000, 'respuesta de la terminal');

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

    markPhase('ajustes');
    // En builds de depuración WebKit puede reservar unos 300 px para el
    // inspector. Con la ventana de trabajo anterior el banner completo no
    // cabe y CPU queda fuera de las filas visibles, aunque la preferencia se
    // haya aplicado. Esta fase necesita observar contenido, así que usa una
    // altura suficiente tanto con inspector como en release.
    await resizeWindow(1100, 900);
    await click(await findWhenReady('[data-testid="toolbar-settings"]'));
    const dialog = await findWhenReady('[role="dialog"]');
    const title = await textOf(dialog);
    if (!/Preferencias|Preferences|Settings|Ajustes|Appearance|Terminal/i.test(title)) {
        throw new Error(`El panel de Ajustes no se abrió; texto recibido: ${JSON.stringify(title)}`);
    }

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
    if (!/Una lista abierta por panel|One list open per panel/i.test(settingsText)) {
        throw new Error('Ajustes no muestra la preferencia de acordeones exclusivos');
    }
    if (!/Abrir la primera lista|Open the first list/i.test(settingsText)) {
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
        };`,
        args: [],
    });
    recordEvent('settings-banner-controls', bannerSettingsSnapshot);
    if (!bannerSettingsSnapshot.testIds?.includes('settings-banner-cpu')) {
        throw new Error(`Ajustes no renderizó el control funcional de CPU: ${JSON.stringify(bannerSettingsSnapshot)}`);
    }
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
    await sendTerminalLine('sysinfo');
    await waitUntil(async () => {
        const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return text.includes(cpuLabel) === !cpuWasVisible;
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
    await sendTerminalLine('sysinfo');
    await waitUntil(async () => {
        const text = await textOf(await findWhenReady('.cell:not(.hidden) .xterm-rows'));
        return text.includes(cpuLabel) === cpuWasVisible;
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
    if (!/Cortar|Cut/i.test(menuText) || !/Eliminar|papelera|Trash/i.test(menuText)) {
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
    // `load()` pinta primero el inventario rápido y lanza después una
    // re-detección lenta en segundo plano. Si se recorren los <details>
    // mientras esa respuesta sustituye `actions`, Svelte puede cerrar o
    // reconstruir el grupo que WebDriver iba a pulsar y WebKit responde
    // "element not interactable". Esperar a que el botón deje de estar
    // deshabilitado hace estable el DOM que se va a inspeccionar.
    await waitUntil(async () => {
        const refreshButton = await find('[data-testid="dependency-refresh"]');
        return (await attribute(refreshButton, 'disabled')) === null;
    }, 20000, 'fin de la re-detección de dependencias');
    await findWhenReady('.dependency-actions');
    await findWhenReady('.manual-hint');
    const dependencyGroups = await findAll('[data-testid="dependency-group"]');
    for (const group of dependencyGroups) {
        if ((await attribute(group[elementKey], 'open')) !== null) {
            throw new Error('Un grupo de dependencias aparece abierto antes de solicitarlo');
        }
    }
    const dependencyText = (await Promise.all(dependencyGroups.map((item) => textOf(item[elementKey])))).join('\n');
    // Linux ofrece compatibilidad Windows (Wine/Bottles/CrossOver), mientras
    // Windows ofrece virtualización nativa (Hyper-V/QEMU/VirtualBox/VMware).
    // El E2E debe comprobar el contrato de la plataforma, no una etiqueta fija.
    const nativeWindows = process.platform === 'win32';
    const platformGroupPattern = nativeWindows
        ? /Virtualización|Virtualisation|Virtualization/i
        : /Compatibilidad(?: con)? Windows|Windows compatibility/i;
    const platformGroupLabel = nativeWindows ? 'Virtualización' : 'Compatibilidad Windows';
    if (!platformGroupPattern.test(dependencyText)) {
        throw new Error(`No aparece ${platformGroupLabel} en Dependencias`);
    }
    // Array.find no espera promesas; localizarlo de forma explícita para que
    // el smoke no tenga una condición siempre verdadera.
    let compatibilityId;
    for (const item of dependencyGroups) {
        if (platformGroupPattern.test(await textOf(item[elementKey]))) {
            compatibilityId = item[elementKey];
            break;
        }
    }
    if (!compatibilityId) throw new Error(`No se pudo localizar el grupo de ${platformGroupLabel}`);
    await click(compatibilityId);
    const subgroupSummaries = await findAllWithin(compatibilityId, '[data-testid="dependency-subgroup"] > summary');
    const subgroupText = (await Promise.all(subgroupSummaries.map((item) => textOf(item[elementKey])))).join('\n');
    const hasNamedTool = nativeWindows
        ? /Hyper-V|Virtual Machine Platform|Windows Sandbox|QEMU|VirtualBox|VMware/i.test(subgroupText)
        : /Bottles|Steam|Lutris|QEMU|Wine|Proton|MinGW|CrossOver/i.test(subgroupText);
    const hasDescription = /Gestiona|Ejecuta|Instala|Organiza|Proporciona|Interfaz|Traduce|Compila|Alternativa|Manages|Runs|Installs|Organizes|Provides|Interface|Translates|Builds|Alternative/i.test(subgroupText);
    if (!hasNamedTool || !hasDescription) {
        throw new Error(`${platformGroupLabel} no muestra programa y descripción en sus submenús`);
    }
    if (subgroupSummaries.length === 0) throw new Error(`${platformGroupLabel} no contiene submenús`);
    if (!nativeWindows) {
        // Array.find no espera promesas: localizar CrossOver con el mismo patrón
        // explícito usado para el grupo evita que vuelva a degradarse a una fila
        // directa cuando solo queda una acción visible.
        let crossoverSummaryId;
        for (const summary of subgroupSummaries) {
            if (/CrossOver/i.test(await textOf(summary[elementKey]))) {
                crossoverSummaryId = summary[elementKey];
                break;
            }
        }
        if (!crossoverSummaryId) throw new Error('CrossOver no aparece como submenú propio');
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
    const subgroupNames = [];
    for (const subgroup of subgroupSummaries) subgroupNames.push(await textOf(subgroup[elementKey]));
    if (new Set(subgroupNames).size !== subgroupNames.length) throw new Error('La lista de compatibilidad contiene subgrupos repetidos');
    for (const name of subgroupNames) {
        // Abrir un details puede hacer que Svelte sustituya sus hermanos.
        // Volver a buscar el summary evita usar un identificador WebDriver
        // caducado en el siguiente ciclo.
        const freshSummaries = await findAllWithin(compatibilityId, '[data-testid="dependency-subgroup"] > summary');
        let subgroupId;
        for (const fresh of freshSummaries) {
            if ((await textOf(fresh[elementKey])) === name) {
                subgroupId = fresh[elementKey];
                break;
            }
        }
        if (!subgroupId) throw new Error(`No se pudo volver a localizar el subgrupo ${name}`);
        await scrollIntoView(subgroupId);
        await click(subgroupId);
        const subgroupDetails = await parentOf(subgroupId);
        const subgroupActions = await findAllWithin(subgroupDetails, '[data-testid="dependency-action"]');
        if (subgroupActions.length === 0) {
            const detail = await request(`/session/${sessionId}/execute/sync`, 'POST', {
                script: 'return { open: arguments[0].open, html: arguments[0].innerHTML };',
                args: [{ [elementKey]: subgroupDetails }],
            });
            throw new Error(`El subgrupo ${name} no muestra acciones (open=${detail.open}, html=${String(detail.html).slice(0, 500)})`);
        }
        for (const action of subgroupActions) {
            const actionId = await attribute(action[elementKey], 'data-action-id');
            if (!actionId) throw new Error(`La acción de ${name} no tiene identificador estable`);
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
        subgroups: subgroupNames.length,
        repeatedLoads: 3,
        platformGroup: platformGroupLabel,
    });

    markPhase('pestañas, división y redimensionado');
    await resizeWindow(1100, 720);
    // La división también tiene un control visible en la tira de pestañas.
    // El atajo sigue siendo una ruta de usuario válida, pero WebDriver no
    // representa de forma portable Ctrl+Shift+Backslash en WebKitGTK; probar
    // el control real evita que el smoke dependa de una codificación de tecla.
    const splitButton = await findWhenReady('.side-toggle.panes');
    await click(splitButton);
    const splitCount = await waitForPaneCount(2);
    if (splitCount < 2) throw new Error(`La división no creó dos paneles; encontró ${splitCount}`);
    await waitForBannerPanes(splitCount, 20000);

    // El clic de dividir es asíncrono porque puede tener que abrir pestañas.
    // Un burst de clics no debe saltar varios estados ni crear duplicados.
    for (let attempt = 0; attempt < 4; attempt += 1) await click(splitButton);
    const burstCount = await waitForPaneCount(splitCount, 10000);
    if (burstCount > splitCount + 1) {
        throw new Error(`Los clics concurrentes crearon demasiados paneles: ${splitCount} -> ${burstCount}`);
    }
    const stablePaneCount = Math.max(splitCount, burstCount);
    const burstBanner = await waitForBannerPanes(stablePaneCount, 20000);
    process.stdout.write(`E2E banner OK: ${stablePaneCount} panel(es) tras burst en ${burstBanner.elapsedMs}ms\n`);

    const finalCount = (await waitForPaneCount(stablePaneCount, 5000));
    if (finalCount !== stablePaneCount) {
        throw new Error(`El redimensionado alteró los paneles visibles: ${stablePaneCount} -> ${finalCount}`);
    }

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
    const expectedMatrixSizes = new Set(
        proportions.map(([, widthRatio, heightRatio]) =>
            `${Math.max(matrixMinimumWidth, Math.round(maximumRect.width * widthRatio))}x${Math.max(matrixMinimumHeight, Math.round(maximumRect.height * heightRatio))}`,
        ),
    );
    for (const [explorerLabel, explorerVisible] of [['sin-explorador', false], ['con-explorador', true]]) {
        await setExplorerVisible(explorerVisible);
        const matrixResults = [];
        const observedMatrixSizes = new Set();
        for (const [label, widthRatio, heightRatio] of proportions) {
            const requestedWidth = Math.max(matrixMinimumWidth, Math.round(maximumRect.width * widthRatio));
            const requestedHeight = Math.max(matrixMinimumHeight, Math.round(maximumRect.height * heightRatio));
            const actual = await resizeWindow(requestedWidth, requestedHeight, { waitForBanner: false });
            assertWindowBounds(actual, `Matriz ${explorerLabel} ${label}`);
            // El resize ya solicita el repintado en todos los paneles. La ruta
            // opcional por shell queda disponible para diagnósticos profundos,
            // pero no debe ralentizar cada combinación de la matriz.
            if (FORCE_SHELL_REFRESH) {
                for (const pane of await visiblePanes()) {
                    await sendTerminalLine('sysinfo', pane[elementKey]);
                }
            }
            const banner = await waitForBannerPanes(stablePaneCount, 20000);
            observedMatrixSizes.add(`${actual.width}x${actual.height}`);
            const paneSize = banner.geometry.panes
                .slice(0, stablePaneCount)
                .map((pane) => `${pane.cell.width}x${pane.cell.height}`)
                .join('|');
            matrixResults.push(`${label}=${actual.width}x${actual.height}->${paneSize}/${banner.elapsedMs}ms`);
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
        // El resize dispara el mismo repintado que usa la aplicación real.
        // Solo el modo forzado vuelve a escribir sysinfo por la shell.
        const actual = await resizeWindow(width, height, { waitForBanner: false });
        if (FORCE_SHELL_REFRESH) {
            for (const pane of await visiblePanes()) await sendTerminalLine('sysinfo', pane[elementKey]);
        }
        const banner = await waitForBannerPanes(stablePaneCount, 20000);
        lastRepeatedBanner = banner;
        const paneSize = banner.geometry.panes
            .slice(0, stablePaneCount)
            .map((pane) => `${pane.cell.width}x${pane.cell.height}`)
            .join('|');
        bannerSizes.push(`${actual.width}x${actual.height}->${paneSize}:${banner.elapsedMs}ms`);
    }
    // `xterm-rows` puede pertenecer a un panel que acaba de cambiar de scroll
    // y no es una evidencia estable. `waitForBannerPanes` ya ha validado cada
    // panel tras el último redimensionado; usamos esa captura sincronizada.
    const repeatedTerminal = lastRepeatedBanner?.texts?.join('\n') ?? '';
    if (!/LTerminal|WinSlim|Terminal/i.test(repeatedTerminal)) {
        throw new Error('El banner no dejó texto reconocible tras redimensionar varias veces');
    }
    process.stdout.write(`E2E banner tamaños OK: ${bannerSizes.join(', ')}\n`);

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
    throw error;
} finally {
    if (sessionId) await request(`/session/${sessionId}`, 'DELETE').catch(() => {});
    driver.kill('SIGTERM');
    smokeReport.finishedAt = new Date().toISOString();
    smokeReport.durationMs = Date.now() - smokeStartedAt;
    smokeReport.phases = phaseTimings;
    await writeFile(smokeReportPath, `${JSON.stringify(smokeReport, null, 2)}\n`).catch((error) => {
        process.stderr.write(`No se pudo escribir el informe de smoke ${smokeReportPath}: ${error}\n`);
    });
    process.stdout.write(`E2E informe: ${smokeReportPath}\n`);
}
