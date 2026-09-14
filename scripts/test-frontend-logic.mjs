import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function importTypeScript(relative) {
    const source = await readFile(relative, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: relative,
        reportDiagnostics: true,
    });
    const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `${relative} no se pudo transpilar`);
    return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
}

const localization = await importTypeScript('src/lib/localization.ts');
const shortcuts = await importTypeScript('src/lib/shortcuts.ts');
const terminalScroll = await importTypeScript('src/lib/terminal-scroll.ts');
const terminalColumns = await importTypeScript('src/lib/terminal-columns.ts');
const terminalReady = await importTypeScript('src/lib/terminal-ready.ts');
const terminalPrompt = await importTypeScript('src/lib/terminal-prompt.ts');
const keyedQueue = await importTypeScript('src/lib/keyed-serial-queue.ts');
const terminalRender = await importTypeScript('src/lib/terminal-render.ts');

assert.equal(localization.foldLocalized('İSTANBUL', 'tr'), 'istanbul');
assert(localization.includesLocalized('Überblick 12', 'ÜBER', 'de'));
assert(localization.compareLocalized('archivo 2', 'archivo 10', 'es') < 0);
assert.doesNotThrow(() => localization.compareLocalized('a', 'b', 'idioma_invalido'));
assert.equal(terminalScroll.normalizeWheelDelta(120, 0, 18, 600), 120, 'la rueda en píxeles conserva su magnitud');
assert.equal(terminalScroll.normalizeWheelDelta(3, 1, 18, 600), 54, 'la rueda en líneas se convierte según la altura de línea');
assert.equal(terminalScroll.normalizeWheelDelta(1, 2, 18, 600), 600, 'la rueda en páginas se convierte según el ancho visible');
assert.equal(terminalScroll.normalizeWheelDelta(-2, 1, Number.NaN, 600), -32, 'una altura de línea no disponible usa el respaldo');
assert.equal(terminalScroll.normalizeWheelDelta(Number.NaN, 0, 18, 600), 0, 'no propaga deltas no finitos');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~>                         09/14/2026 01:46 PM', 'nu'), true,
    'Nushell está listo aunque su prompt derecho aparezca tras el cursor');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('/home/romen/proyecto>  hora derecha', 'nu'), true,
    'Nushell reconoce una ruta de trabajo absoluta y su prompt derecho');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('C:\\Users\\Romen> hora derecha', 'nu'), true,
    'Nushell reconoce rutas Windows');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~> hora derecha', 'fish'), false,
    'el prompt especial de Nushell no altera la detección de otras shells');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('Welcome to Nushell', 'nu'), false,
    'el saludo del REPL no se confunde con un prompt');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('\u001b[38;5;167m~\u001b[0m Snailed it ~', 'xonsh'), true,
    'xonsh reconoce el prompt alternativo del backend dumb sin prompt_toolkit');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('romen@PC ~/proyecto main @', 'xonsh'), true,
    'xonsh reconoce su prompt normal terminado en @');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('C:\\Users\\Romen @#', 'xonsh'), true,
    'xonsh reconoce el prompt de administrador con ruta Windows');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('Welcome to the xonsh shell 0.24.2', 'xonsh'), false,
    'el banner de xonsh no se confunde con un prompt');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~ Snailed it ~', 'nu'), false,
    'el prompt de xonsh no cambia la detección de Nushell');

const columnRows = [
    { columns: 900, isWrapped: false }, // scrollback anterior: no debe gobernar el PTY
    { columns: 80, isWrapped: false },
    { columns: 35, isWrapped: true },
    { columns: 22, isWrapped: false },
];
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 1, 1, (index) => columnRows[index]), 115,
    'una continuación visible conserva el ancho completo de su línea lógica');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 3, 1, (index) => columnRows[index]), 22,
    'una línea antigua fuera de pantalla no fuerza columnas adicionales');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 2, 1, (index) => columnRows[index]), 115,
    'si el viewport empieza en una continuación se reconstruye desde el inicio');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 0, 4, (index) => columnRows[index]), 900,
    'una línea larga visible sigue teniendo acceso al scroll horizontal');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 3, 8, (index) => columnRows[index]), 22,
    'el rango visible se limita al número real de filas del buffer');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 1, 1, (index) => columnRows[index], 100), 100,
    'la reconstrucción de líneas queda limitada por el máximo de seguridad');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(0, 0, 1, () => undefined), 0,
    'un buffer vacío no genera dimensiones');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(Number.NaN, 0, 1, () => undefined), 0,
    'una longitud no finita no rompe el cálculo del viewport');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(1, 0, Number.NaN, () => ({ columns: 2, isWrapped: false })), 0,
    'un rango visible no finito se trata como vacío');

const renderFrames = [];
const renderErrors = [];
const renderCalls = [];
const renderCompletions = [];
const renderScheduler = terminalRender.createTerminalRefreshScheduler(
    (callback) => renderFrames.push(callback),
    (error) => renderErrors.push(error),
);
const renderTarget = {
    rows: 24,
    element: { isConnected: true },
    refresh: (start, end) => renderCalls.push([start, end]),
};
assert.equal(renderScheduler(renderTarget, () => renderCompletions.push('first')), true,
    'el primer repintado reserva un frame');
assert.equal(renderScheduler(renderTarget, () => renderCompletions.push('second')), false,
    'las salidas del mismo frame se agrupan por terminal');
assert.equal(renderFrames.length, 1);
assert.deepEqual(renderCalls, [], 'el repintado no se adelanta al frame pedido');
renderFrames.shift()();
assert.deepEqual(renderCalls, [[0, 23]], 'se refrescan explícitamente todas las filas visibles');
assert.deepEqual(renderCompletions, [], 'la finalización espera un frame de presentación');
assert.equal(renderFrames.length, 1);
renderFrames.shift()();
assert.deepEqual(renderCompletions, ['first', 'second'], 'se notifican todos los solicitantes agrupados');

const detachedTarget = {
    rows: 30,
    element: { isConnected: true },
    refresh: () => renderCalls.push('detached'),
};
let detachedCompletion = false;
renderScheduler(detachedTarget, () => { detachedCompletion = true; });
detachedTarget.element.isConnected = false;
renderFrames.shift()();
assert.equal(detachedCompletion, false, 'una terminal desmontada no recibe callbacks tardíos');
assert(!renderCalls.includes('detached'), 'una terminal desmontada no se refresca');

const closedDuringPaint = {
    rows: 4,
    element: { isConnected: true },
    refresh: () => renderCalls.push('closed-during-paint'),
};
let lateCompletion = false;
renderScheduler(closedDuringPaint, () => { lateCompletion = true; });
renderFrames.shift()();
closedDuringPaint.element.isConnected = false;
renderFrames.shift()();
assert(renderCalls.includes('closed-during-paint'));
assert.equal(lateCompletion, false, 'no se notifica como visible una terminal cerrada durante la presentación');

const brokenTarget = {
    rows: 1,
    element: { isConnected: true },
    refresh: () => { throw new Error('renderer unavailable'); },
};
renderScheduler(brokenTarget, () => renderCompletions.push('broken'));
renderFrames.shift()();
assert.equal(renderErrors.length, 1, 'un error del renderer se registra sin romper la cola');
assert.equal(renderCompletions.includes('broken'), false, 'no se anuncia un repintado que falló');

let retryClock = 0;
let retryCalls = 0;
const retryDelays = [];
assert.equal(await terminalReady.retryUntilReady(async () => ++retryCalls === 3, {
    intervalMs: 200,
    timeoutMs: 1000,
    now: () => retryClock,
    wait: async (delayMs) => { retryDelays.push(delayMs); retryClock += delayMs; },
}), true, 'el handshake reintenta hasta que la PTY está lista');
assert.equal(retryCalls, 3);
assert.deepEqual(retryDelays, [200, 200]);

retryClock = 0;
retryCalls = 0;
retryDelays.length = 0;
assert.equal(await terminalReady.retryUntilReady(async () => { retryCalls += 1; return false; }, {
    intervalMs: 200,
    timeoutMs: 450,
    now: () => retryClock,
    wait: async (delayMs) => { retryDelays.push(delayMs); retryClock += delayMs; },
}), false, 'el handshake tiene un límite total de espera');
assert.deepEqual(retryDelays, [200, 200, 50]);

let continueRetrying = true;
assert.equal(await terminalReady.retryUntilReady(async () => false, {
    shouldContinue: () => continueRetrying,
    wait: async () => { continueRetrying = false; },
}), false, 'el handshake se cancela al desmontar el panel');

const enqueueByTab = keyedQueue.createKeyedSerialQueue();
const switchOrder = [];
let releaseFirstSwitch;
const firstSwitchGate = new Promise((resolve) => { releaseFirstSwitch = resolve; });
const firstSwitch = enqueueByTab('tab-1', async () => {
    switchOrder.push('first');
    await firstSwitchGate;
    return 'first';
});
const secondSwitch = enqueueByTab('tab-1', async () => {
    switchOrder.push('second');
    return 'second';
});
const otherTabSwitch = enqueueByTab('tab-2', async () => {
    switchOrder.push('other-tab');
    return 'other-tab';
});
await otherTabSwitch;
assert.deepEqual(switchOrder, ['first', 'other-tab'], 'una pestaña espera su cambio anterior sin bloquear otras pestañas');
releaseFirstSwitch();
assert.deepEqual(await Promise.all([firstSwitch, secondSwitch]), ['first', 'second']);
assert.deepEqual(switchOrder, ['first', 'other-tab', 'second'], 'la misma pestaña conserva el orden de sus cambios');
await assert.rejects(enqueueByTab('tab-1', async () => { throw new Error('cambio rechazado'); }), /cambio rechazado/);
assert.equal(await enqueueByTab('tab-1', async () => 'recovered'), 'recovered', 'un rechazo no atasca la cola de esa pestaña');

assert.equal(
    localization.platformBrandText('Abrir LTerminal y LTerminal Projects', 'windows', 'WinSlim Terminal'),
    'Abrir WinSlim Terminal y WinSlim Projects',
);
assert.equal(
    localization.platformBrandText('Abrir WinSlim Terminal en WinSlim Projects', 'linux', 'LTerminal'),
    'Abrir LTerminal en LTerminal Projects',
);
assert(!localization.platformBrandText('WinSlim Projects', 'linux', 'LTerminal').includes('LTerminals'));
assert.equal(localization.platformBrandText('LTerminal', 'unknown', 'Otro'), 'LTerminal');

const defaults = await readFile('src-tauri/default_settings.toml', 'utf8');
const terminalPane = await readFile('src/components/TerminalPane.svelte', 'utf8');
const app = await readFile('src/App.svelte', 'utf8');
const aliases = await readFile('src-tauri/src/terminal/aliases.rs', 'utf8');
const duplicateSpaceKeypressGuard = terminalPane.match(/if \(now - lastExplicitSpaceKeydownAt < 100\) \{([^}]*)\}/)?.[1] ?? '';
assert(terminalPane.includes('function isDirectCreditAlias(line: string): boolean'),
    'TerminalPane debe preseleccionar los easter-eggs sin `:`');
assert(terminalPane.includes("candidate.trimStart().startsWith(':') || isDirectCreditAlias(candidate)"),
    'Las líneas de crédito deben interceptarse antes de enviarse a la shell');
assert(terminalPane.includes("ayuda creditos")
    && aliases.includes('terminal.creditDarkeiser')
    && aliases.includes('terminal.creditChristian'),
    'Los easter-eggs deben ejecutarse por la ayuda localizada del PTY');
const fitAndReportStart = terminalPane.indexOf('function fitAndReport()');
const paneResizeBlock = terminalPane.slice(fitAndReportStart);
assert(terminalPane.includes('term.open(terminalHost)')
    && terminalPane.includes('data-testid="terminal-host"')
    && terminalPane.includes('function requestBannerPrint'),
    'El banner y el código deben compartir el mismo xterm');
assert(terminalPane.includes('cursorInactiveStyle')
    && terminalPane.includes('xterm-cursor-layer'),
    'Cada panel debe conservar una capa de cursor visible aunque no tenga el foco');
assert(terminalPane.includes('function isSpaceKey(event: KeyboardEvent): boolean')
    && terminalPane.includes("white-space: pre !important")
    && terminalPane.includes('pendingExplicitSpaces === 0')
    && terminalPane.includes("exposeInputMirror(inputReady ? 'ascii' : 'startup-space')")
    && duplicateSpaceKeypressGuard.includes('event.preventDefault()')
    && duplicateSpaceKeypressGuard.includes('event.stopPropagation()')
    && duplicateSpaceKeypressGuard.includes('return;'),
    'Space debe conservar sus columnas y no activar el Enter de rescate durante la edición');
assert(terminalPane.includes('function onTerminalWheel(event: WheelEvent): void')
    && terminalPane.includes('if (!event.shiftKey')
    && terminalPane.includes('normalizeWheelDelta(')
    && terminalPane.includes("addEventListener('wheel', onTerminalWheel, { capture: true, passive: false })")
    && terminalPane.includes('viewport.scrollLeft + normalizedDelta'),
    'Shift+rueda debe desplazar horizontalmente sin quitar la rueda vertical de xterm');
assert(app.includes('scheduleTerminalRefresh(settled')
    && app.includes("'winslim:terminal-output-refreshed'")
    && !app.includes('settled.clearTextureAtlas()')
    && app.includes("window.dispatchEvent(new CustomEvent('winslim:terminal-output-idle'")
    && !app.includes('current.scrollToBottom()'),
    'la salida PTY debe solicitar un repintado explícito al vaciarse la cola sin mover el scrollback');
assert(terminalPane.includes('function refreshAfterWindowResume()')
    && terminalPane.includes("window.addEventListener('focus', onWindowFocus)")
    && terminalPane.includes("document.addEventListener('visibilitychange', onDocumentVisibilityChange)")
    && terminalPane.includes('term.refresh(0, Math.max(0, term.rows - 1))'),
    'al reactivar la ventana, la terminal activa debe recuperarse sin redimensionar');
const configuredShortcuts = [...defaults.matchAll(/^shortcut\w+\s*=\s*"([^"]*)"/gm)].map((match) => match[1]);
assert.equal(configuredShortcuts.length, shortcuts.SHORTCUT_PREFERENCE_KEYS.length);
const normalizedDefaults = configuredShortcuts.map(shortcuts.normalizeShortcut);
assert(normalizedDefaults.every((value, index) => value || configuredShortcuts[index] === ''), 'Todos los atajos de fábrica deben ser válidos o estar vacíos');
const assignedDefaults = normalizedDefaults.filter(Boolean);
assert.equal(new Set(assignedDefaults).size, assignedDefaults.length, 'Los atajos de fábrica no se pueden repetir');
assert.deepEqual(
    Object.fromEntries([
        ['shortcutPaneLeft', defaults.match(/^shortcutPaneLeft\s*=\s*"([^"]*)"$/m)?.[1]],
        ['shortcutPaneRight', defaults.match(/^shortcutPaneRight\s*=\s*"([^"]*)"$/m)?.[1]],
        ['shortcutPaneUp', defaults.match(/^shortcutPaneUp\s*=\s*"([^"]*)"$/m)?.[1]],
        ['shortcutPaneDown', defaults.match(/^shortcutPaneDown\s*=\s*"([^"]*)"$/m)?.[1]],
    ]),
    {
        shortcutPaneLeft: 'Ctrl+A',
        shortcutPaneRight: 'Ctrl+D',
        shortcutPaneUp: 'Ctrl+W',
        shortcutPaneDown: 'Ctrl+S',
    },
    'La navegación de fábrica debe conservar Ctrl izquierdo + W/A/S/D',
);

const event = (overrides = {}) => ({
    code: 'KeyT',
    key: 't',
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
    ...overrides,
});
assert(shortcuts.matchesShortcut(event(), 'Ctrl+Shift+T'));
assert(shortcuts.matchesShortcut(event({ code: 'Backslash', key: '|'}), 'Ctrl+Shift+Backslash'));
assert(!shortcuts.matchesShortcut(event({ altKey: true }), 'Ctrl+Shift+T'));
assert(shortcuts.matchesShortcut(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: false, shiftKey: false, altKey: true }), 'Alt+ArrowLeft'));
assert(shortcuts.matchesPaneShortcut(event({ code: 'KeyA', key: 'a', shiftKey: false }), 'Ctrl+A', true));
assert(!shortcuts.matchesPaneShortcut(event({ code: 'KeyA', key: 'a', shiftKey: false }), 'Ctrl+A', false));
assert(shortcuts.matchesPaneShortcut(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: false, shiftKey: false, altKey: true }), 'Alt+ArrowLeft', false));
assert.equal(shortcuts.shortcutFromEvent(event({ code: 'KeyH', key: 'h', ctrlKey: true, altKey: true, shiftKey: false })), 'ctrl+alt+h');
assert.equal(shortcuts.shortcutFromEvent(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true, altKey: false, shiftKey: false })), 'ctrl+arrowleft');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Ctrl+T'), '');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Shift+TeclaInventada'), '');

console.log(`Lógica frontend verificada: idioma, identidad y ${configuredShortcuts.length} atajos.`);
