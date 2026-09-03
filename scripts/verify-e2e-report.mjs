import { readFile } from 'node:fs/promises';
import process from 'node:process';

const reportPath = process.argv[2];
if (!reportPath) throw new Error('Uso: node scripts/verify-e2e-report.mjs RUTA_INFORME.json');

let report;
try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch (error) {
    throw new Error(`El informe E2E no existe o no es JSON válido: ${reportPath} (${error})`);
}

if (report.status !== 'passed') {
    throw new Error(`El E2E no terminó correctamente: ${report.status ?? 'sin estado'} (${report.error ?? 'sin detalle'})`);
}
if (report.logValidated !== true) throw new Error('El E2E no validó el log de su propia ejecución.');
if (!Number.isFinite(report.durationMs) || report.durationMs <= 0) throw new Error('El E2E no registró una duración válida.');

const requiredPhases = [
    'arranque de interfaz',
    'estados de ventana',
    'comandos internos y shell',
    'acciones concurrentes',
    'ajustes',
    'biblioteca y operaciones',
    'explorador y menú contextual',
    'proyectos',
    'entorno y dependencias',
    'pestañas, división y redimensionado',
    'repetición de acciones y fastfetch',
];
const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
const missing = requiredPhases.filter((phase) => !phases.has(phase));
if (missing.length) throw new Error(`El E2E terminó sin ejecutar estas fases: ${missing.join(', ')}`);

const events = Array.isArray(report.events) ? report.events : [];
if (events.length < requiredPhases.length) throw new Error(`El E2E solo registró ${events.length} eventos.`);
if (!events.some((event) => event?.type === 'preference' && event?.name === 'showQuickActions' && event?.value === false)) {
    throw new Error('El E2E no comprobó que el comando interno ocultase Acciones rápidas.');
}
if (!events.some((event) => event?.type === 'preference' && event?.name === 'showQuickActions' && event?.value === true)) {
    throw new Error('El E2E no comprobó que el comando interno mostrase Acciones rápidas.');
}

const contextMenu = events.find((event) => event?.type === 'context-menu');
if (!contextMenu || !contextMenu.actions?.includes('cut') || !contextMenu.actions?.includes('delete')) {
    throw new Error('El E2E no demostró que el menú contextual contuviese cortar y eliminar.');
}

const dependencies = events.find((event) => event?.type === 'dependencies');
// Algunos grupos de Windows quedan con una sola acción aplicable y se
// representan como tarjetas directas, sin <details>/<summary>. En ese caso
// `subgroups` es 0 pero `entries` demuestra que el contenido se inspeccionó.
if (!dependencies || dependencies.groups < 1
    || (dependencies.subgroups < 1 && dependencies.entries < 1)
    || dependencies.repeatedLoads < 3) {
    throw new Error('El E2E no recorrió grupos, acciones/submenús y recargas de Entorno y dependencias.');
}

const minimumSplit = events.find((event) => event?.type === 'multi-pane-minimum');
if (!minimumSplit || minimumSplit.passed !== true || minimumSplit.geometryValid !== true
    || minimumSplit.paneCount < 2 || minimumSplit.panes?.length < 2) {
    throw new Error('El E2E no demostró una división útil y sin solapamientos en el tamaño mínimo.');
}

const responsiveMinimum = events.find((event) => event?.type === 'responsive-minimum');
const responsiveDimensionsValid = (value) => Number.isFinite(value?.width)
    && Number.isFinite(value?.height) && value.width > 0 && value.height > 0;
if (!responsiveMinimum || responsiveMinimum.passed !== true
    || !responsiveDimensionsValid(responsiveMinimum.configured)
    || (responsiveMinimum.requested !== null && !responsiveDimensionsValid(responsiveMinimum.requested))
    || !responsiveDimensionsValid(responsiveMinimum.applied)) {
    throw new Error('El E2E no registró el mínimo responsive calculado y aplicado.');
}

const nativeResizes = events.filter((event) => event?.type === 'native-window-resize');
const nativePlatform = report.host?.platform;
if (nativeResizes.length < 2
    || nativeResizes.some((event) => event.passed !== true
        || event.nativeChanged !== true
        || event.viewportChanged !== true
        || event.ptyChanged !== true
        || (nativePlatform && event.platform !== nativePlatform))) {
    throw new Error('El E2E no demostró dos redimensionados nativos con viewport y PTY sincronizados.');
}
const resizeCaptures = (report.captures ?? [])
    .filter((capture) => String(capture?.label ?? '').startsWith('window-resize-'));
if (resizeCaptures.length < 2) {
    throw new Error('El E2E no conservó las capturas visuales de las transiciones de ventana.');
}

const tabIsolation = events.find((event) => event?.type === 'tab-isolation');
if (!tabIsolation || tabIsolation.passed !== true || tabIsolation.tabs < 3) {
    throw new Error('El E2E no demostró sesiones PTY independientes entre pestañas.');
}

const rapidTabReplace = events.find((event) => event?.type === 'rapid-tab-replace');
if (!rapidTabReplace || rapidTabReplace.passed !== true || rapidTabReplace.isolated !== true
    || !rapidTabReplace.closedTabId || !rapidTabReplace.createdTabId
    || rapidTabReplace.closedTabId === rapidTabReplace.createdTabId) {
    throw new Error('El E2E no reprodujo el cierre inmediato de una pestaña durante la creación de otra.');
}

const explorerCwd = events.find((event) => event?.type === 'explorer-cwd-layout');
if (!explorerCwd || explorerCwd.passed !== true || explorerCwd.cwdFollowed !== true
    || !Number.isFinite(explorerCwd.layout?.pathHeight) || explorerCwd.layout.pathHeight > 32
    || !Number.isFinite(explorerCwd.layout?.gap) || explorerCwd.layout.gap > 4
    || explorerCwd.layout?.ordered !== true) {
    throw new Error('El E2E no demostró que el explorador siguiera el cwd sin crear un bloque vacío.');
}

const keyboardShortcuts = events.find((event) => event?.type === 'keyboard-shortcuts');
if (!keyboardShortcuts || keyboardShortcuts.passed !== true
    || keyboardShortcuts.newTab !== true
    || (keyboardShortcuts.nextTab !== true && keyboardShortcuts.nextTabReserved !== true)
    || keyboardShortcuts.cyclePanes !== true) {
    throw new Error('El E2E no demostró los atajos de nueva pestaña, navegación y división.');
}
const keyboardCaptures = new Set((report.captures ?? [])
    .filter((capture) => String(capture?.label ?? '').startsWith('atajo-'))
    .map((capture) => capture.label));
for (const label of ['atajo-nueva-pestana', 'atajo-pestana-siguiente', 'atajo-division-dos-paneles', 'atajo-division-tres-paneles']) {
    if (!keyboardCaptures.has(label)) throw new Error(`Falta la captura del atajo ${label}.`);
}

const shellStartup = events.find((event) => event?.type === 'shell-startup-performance');
if (!shellStartup || shellStartup.passed !== true || shellStartup.samples < 1
    || !Number.isFinite(shellStartup.maxMs) || !Number.isFinite(shellStartup.limitMs)
    || shellStartup.maxMs >= shellStartup.limitMs) {
    throw new Error('El E2E no demostró que la shell evitase el timeout inicial de ConPTY.');
}

const responsive = events.find((event) => event?.type === 'responsive-matrix');
if (!responsive || responsive.panes < 2 || responsive.cases < 20
    || !responsive.explorerStates?.includes(false) || !responsive.explorerStates?.includes(true)) {
    throw new Error('El E2E no completó la matriz de redimensionado con dos paneles y los dos estados del explorador.');
}

// Un informe podía quedar en estado «passed» aunque el texto capturado del
// xterm ya contuviera dos banners o una línea de hardware pegada a la
// siguiente. La geometría sigue siendo válida en ese caso, por eso se valida
// también la evidencia textual que dejó cada pane.
const bannerReady = events.filter((event) => event?.type === 'banner-ready');
if (bannerReady.length === 0) throw new Error('El E2E no dejó evidencia textual del banner.');
// Linux usa la cabecera compacta «LTerminal 1.4.4»; Windows mantiene
// «WinSlim Terminal». Ambas representan un único bloque válido.
const bannerHeader = /^(?:LTerminal\b|WinSlim\b.*\bTerminal\b)/i;
// La GPU puede incluir legítimamente memoria dedicada («1 GB»). Solo es una
// mezcla si invade otro campo del banner; tratar GB como corrupción hacía
// fallar informes válidos de Windows.
const mixedBannerLine = /^(?:Placa|Motherboard)\b.*(?:\bGB\b|\bMHz\b|%|GPU|Memoria|Memory|Fecha|Date)|^(?:GPU)\b.*(?:Memoria|Memory|Disco|Disk|PC|Kernel|Fecha|Date)|^(?:Entorno|Environment)\b.*(?:WINSLIM|\bPC\b|Kernel|Placa|Motherboard|GPU)/i;
for (const event of bannerReady) {
    if (event.promptsVisible !== true) {
        throw new Error('El E2E confirmó el banner pero no dejó visible el prompt de la shell en todos los paneles.');
    }
    const previews = Array.isArray(event.preview) ? event.preview : [];
    if (previews.length === 0) throw new Error('El E2E registró un banner sin contenido visible.');
    for (const preview of previews) {
        const lines = String(preview ?? '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
        const headers = lines.filter((line) => bannerHeader.test(line));
        // En el mínimo responsive la marca puede quedar fuera del viewport y
        // el preview empieza por Sistema/CPU. Aceptar esa forma solo cuando
        // conserva CPU, memoria, uptime y un prompt; cualquier mezcla sigue
        // siendo un fallo real.
        const compactWithoutHeader = headers.length === 0
            && /CPU|Procesador|Processor/i.test(preview)
            && /Memoria|Memory|RAM/i.test(preview)
            && /Uptime|Tiempo activo|Sesion|Session/i.test(preview)
            && /(?:@[^\s:]+:.*[>$#]|[A-Za-z]:\\.*[>$#])/i.test(preview);
        if ((!compactWithoutHeader && headers.length !== 1) || lines.some((line) => mixedBannerLine.test(line))) {
            throw new Error(`El E2E detectó un banner duplicado o mezclado: ${JSON.stringify(preview).slice(0, 1200)}`);
        }
    }
}

console.log(`Informe E2E verificado: ${requiredPhases.length} fases, ${events.length} eventos, ${report.durationMs} ms.`);
