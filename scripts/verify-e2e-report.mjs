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
if (!dependencies || dependencies.groups < 1 || dependencies.subgroups < 1 || dependencies.repeatedLoads < 3) {
    throw new Error('El E2E no recorrió grupos, submenús y recargas de Entorno y dependencias.');
}

const minimumSplit = events.find((event) => event?.type === 'multi-pane-minimum');
if (!minimumSplit || minimumSplit.passed !== true || minimumSplit.geometryValid !== true
    || minimumSplit.paneCount < 2 || minimumSplit.panes?.length < 2) {
    throw new Error('El E2E no demostró una división útil y sin solapamientos en el tamaño mínimo.');
}

const tabIsolation = events.find((event) => event?.type === 'tab-isolation');
if (!tabIsolation || tabIsolation.passed !== true || tabIsolation.tabs < 3) {
    throw new Error('El E2E no demostró sesiones PTY independientes entre pestañas.');
}

const responsive = events.find((event) => event?.type === 'responsive-matrix');
if (!responsive || responsive.panes < 2 || responsive.cases < 20
    || !responsive.explorerStates?.includes(false) || !responsive.explorerStates?.includes(true)) {
    throw new Error('El E2E no completó la matriz de redimensionado con dos paneles y los dos estados del explorador.');
}

console.log(`Informe E2E verificado: ${requiredPhases.length} fases, ${events.length} eventos, ${report.durationMs} ms.`);
