import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import process from 'node:process';

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

const driverArgs = ['--port', driverPort, '--native-port', nativePort];
if (nativeDriver) driverArgs.push('--native-driver', nativeDriver);
const driver = spawn(driverPath, driverArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
const endpoint = `http://127.0.0.1:${driverPort}`;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
let sessionId;
const smokeStartedAt = Date.now();
const phaseTimings = [];
let phaseStartedAt = smokeStartedAt;
let phaseName = 'driver';

function markPhase(nextName) {
    const now = Date.now();
    phaseTimings.push({ name: phaseName, durationMs: now - phaseStartedAt });
    phaseName = nextName;
    phaseStartedAt = now;
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
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try { await request('/status'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
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

async function attribute(element, name) {
    return request(`/session/${sessionId}/element/${element}/attribute/${name}`);
}

async function textOf(element) {
    return request(`/session/${sessionId}/element/${element}/text`);
}

async function buttonWithText(pattern, selector = 'button') {
    for (const item of await findAll(selector)) {
        const id = item[elementKey];
        if (pattern.test(await textOf(id))) return id;
    }
    throw new Error(`No se encontró un botón con texto ${pattern}`);
}

async function clickButton(pattern, selector = 'button') {
    await click(await buttonWithText(pattern, selector));
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
        await new Promise((resolve) => setTimeout(resolve, 250));
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
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw lastError ?? new Error(`No apareció el elemento ${css}`);
}

async function click(element) {
    await request(`/session/${sessionId}/element/${element}/click`, 'POST', {});
}

async function sendTerminalLine(line) {
    const input = await findWhenReady('.xterm-helper-textarea');
    // xterm mantiene esta textarea fuera del área visible. En WebKit puede
    // incluso aceptar el click sobre ella sin transferirle foco, así que el
    // smoke siempre enfoca el contenedor visible y deja que xterm delegue al
    // receptor interno de teclado.
    await click(await findWhenReady('.xterm'));
    // WebKit entrega el click y el focus en frames distintos; sin este margen
    // el primer lote de key actions puede llegar antes de que xterm conecte
    // su textarea auxiliar.
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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

async function visiblePanes() {
    return request(`/session/${sessionId}/elements`, 'POST', {
        using: 'css selector', value: '.cell:not(.hidden)'
    });
}

async function waitForPaneCount(expected, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
        count = (await visiblePanes()).length;
        if (count >= expected) return count;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return count;
}

async function resizeWindow(width, height) {
    await request(`/session/${sessionId}/window/rect`, 'POST', { width, height });
    // ResizeObserver + fit + PTY resize están deliberadamente desacoplados;
    // esperar a que aparezca el segundo panel evita medir solo el primer frame.
    await new Promise((resolve) => setTimeout(resolve, 350));
}

try {
    await waitForDriver();
    const created = await request('/session', 'POST', {
        capabilities: { alwaysMatch: { 'tauri:options': { application } } },
    });
    sessionId = created.sessionId;
    markPhase('arranque de interfaz');
    await findWhenReady('.toolbar');
    await findWhenReady('.xterm');

    // Comandos seguros: no tocan archivos ni perfiles. :help y :alias pasan
    // por el parser interno de LTerminal; echo/pwd pasan por la shell real.
    markPhase('comandos internos y shell');
    await sendTerminalLine(':help');
    await sendTerminalLine(':alias');
    await sendTerminalLine('echo LTERMINAL_E2E_COMMAND_OK');
    await waitUntil(async () => {
        const rows = await findWhenReady('.xterm-rows');
        return (await textOf(rows)).includes('LTERMINAL_E2E_COMMAND_OK');
    }, 15000, 'respuesta de la terminal');

    markPhase('ajustes');
    await clickButton(/Ajustes|Settings/i, 'button[data-panel-toggle]');
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
    // El contrato del panel mantiene el orden Apariencia, Terminal,
    // Comportamiento, Información; usar el índice evita depender de que una
    // traducción concreta cambie la etiqueta visible de la pestaña.
    await click(settingsTabs[2][elementKey]);
    // El E2E debe ser repetible aunque la configuración del usuario haya
    // ocultado el explorador: habilitarlo desde el mismo control que usaría
    // una persona y comprobar después que aparece de verdad.
    if ((await findAll('.explorer')).length === 0) {
        await click(await findWhenReady('[role="dialog"] .panel-close'));
        await click(await findWhenReady('.side-toggle:not(.panes)'));
    }
    if ((await findAll('.explorer')).length === 0) {
        // Si la sección completa estaba deshabilitada, habilitarla desde
        // Ajustes. El diálogo se reabre después de cerrar el anterior para
        // que WebKit no intente pulsar controles que están bajo una modal.
        await clickButton(/Ajustes|Settings/i, 'button[data-panel-toggle]');
        await findWhenReady('[role="dialog"]');
        const visibilityTabs = await findAll('[role="dialog"] [role="tab"]');
        await click(visibilityTabs[2][elementKey]);
        // La casilla está dentro de una etiqueta estilizada; WebKit puede
        // marcar el input como cubierto aunque el control sea visible. Pulsar
        // la etiqueta reproduce el click de usuario y evita esa falsa alarma.
        await click(await findWhenReady('[role="dialog"] label:has([data-testid="settings-show-explorer"])'));
        await click(await buttonWithText(/Guardar|Save/i, '[role="dialog"] button'));
        await click(await findWhenReady('[role="dialog"] .panel-close'));
        await findWhenReady('.explorer');
    }
    const terminal = await findWhenReady('.xterm');
    await click(terminal);

    markPhase('biblioteca y operaciones');
    // La primera apertura tiene que respetar la configuración cerrada por
    // defecto. Se abre y se vuelve a cerrar para probar el evento real.
    await clickButton(/Biblioteca|Library/i, 'button[data-panel-toggle]');
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

    markPhase('explorador y menú contextual');
    // El explorador debe conservar el menú contextual y sus acciones, aunque
    // aquí no se ejecuta eliminar ni pegar sobre datos del usuario.
    const explorer = await findWhenReady('.explorer');
    const entry = (await findAll('.explorer .entry'))[0]?.[elementKey];
    if (!entry) throw new Error('El explorador no mostró ninguna entrada para probar el menú contextual');
    await rightClick(entry);
    const menu = await findWhenReady('[role="menu"]');
    const menuText = await textOf(menu);
    if (!/Cortar|Cut/i.test(menuText) || !/Eliminar|papelera|Trash/i.test(menuText)) {
        throw new Error('El menú contextual no contiene cortar y eliminar');
    }
    await click(await findWhenReady('.menu-backdrop'));

    markPhase('proyectos');
    // Proyectos: recorrer los tres modos prueba que el contenido se desmonta
    // y vuelve a cargar sin romper el panel.
    await clickButton(/Proyectos|Projects/i, 'button[data-panel-toggle]');
    await findWhenReady('[role="dialog"]');
    const projectTabs = await findAll('[role="dialog"] [role="tab"]');
    if (projectTabs.length < 3) throw new Error(`Proyectos no muestra sus tres modos: ${projectTabs.length}`);
    for (const tab of projectTabs) await click(tab[elementKey]);
    await click(await findWhenReady('[role="dialog"] .panel-close'));

    markPhase('entorno y dependencias');
    // Dependencias: cargar el catálogo, abrir Compatibilidad Windows y un
    // submenú, pero no ejecutar instalaciones ni cambios del sistema.
    await clickButton(/Entorno y dependencias|Dependencies/i, 'button[data-panel-toggle]');
    await findWhenReady('[role="dialog"] .filters');
    await waitUntil(async () => (await findAll('[data-testid="dependency-group"]')).length > 0, 20000, 'grupos de dependencias');
    const dependencyGroups = await findAll('[data-testid="dependency-group"]');
    for (const group of dependencyGroups) {
        if ((await attribute(group[elementKey], 'open')) !== null) {
            throw new Error('Un grupo de dependencias aparece abierto antes de solicitarlo');
        }
    }
    const dependencyText = (await Promise.all(dependencyGroups.map((item) => textOf(item[elementKey])))).join('\n');
    if (!/Compatibilidad(?: con)? Windows|Windows compatibility/i.test(dependencyText)) {
        throw new Error('No aparece Compatibilidad Windows en Dependencias');
    }
    // Array.find no espera promesas; localizarlo de forma explícita para que
    // el smoke no tenga una condición siempre verdadera.
    let compatibilityId;
    for (const item of dependencyGroups) {
        if (/Compatibilidad(?: con)? Windows|Windows compatibility/i.test(await textOf(item[elementKey]))) {
            compatibilityId = item[elementKey];
            break;
        }
    }
    if (!compatibilityId) throw new Error('No se pudo localizar el grupo de Compatibilidad Windows');
    await click(compatibilityId);
    const subgroups = await findAllWithin(compatibilityId, '[data-testid="dependency-subgroup"] > summary');
    if (subgroups.length === 0) throw new Error('Compatibilidad Windows no contiene submenús');
    await click(subgroups[0][elementKey]);
    const actions = await findAll('[data-testid="dependency-action"]');
    if (actions.length === 0) throw new Error('Dependencias no muestra acciones ejecutables');
    await click(await findWhenReady('[role="dialog"] .panel-close'));

    markPhase('división y redimensionado');
    await resizeWindow(1100, 720);
    // La división también tiene un control visible en la tira de pestañas.
    // El atajo sigue siendo una ruta de usuario válida, pero WebDriver no
    // representa de forma portable Ctrl+Shift+Backslash en WebKitGTK; probar
    // el control real evita que el smoke dependa de una codificación de tecla.
    const splitButton = await findWhenReady('.side-toggle.panes');
    await click(splitButton);
    const splitCount = await waitForPaneCount(2);
    if (splitCount < 2) throw new Error(`La división no creó dos paneles; encontró ${splitCount}`);

    await resizeWindow(1500, 900);
    await resizeWindow(900, 620);
    const finalCount = (await waitForPaneCount(splitCount, 5000));
    if (finalCount !== splitCount) {
        throw new Error(`El redimensionado alteró los paneles visibles: ${splitCount} -> ${finalCount}`);
    }
    phaseTimings.push({ name: phaseName, durationMs: Date.now() - phaseStartedAt });
    process.stdout.write(`E2E OK: ventana, terminal, paneles, menús y redimensionado (${Date.now() - smokeStartedAt} ms).\n`);
    process.stdout.write(`E2E tiempos: ${phaseTimings.map((item) => `${item.name}=${item.durationMs}ms`).join(', ')}\n`);
} finally {
    if (sessionId) await request(`/session/${sessionId}`, 'DELETE').catch(() => {});
    driver.kill('SIGTERM');
}
