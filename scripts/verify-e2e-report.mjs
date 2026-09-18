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

const reportEvents = Array.isArray(report.events) ? report.events : [];
const captureNames = new Set((report.captures ?? []).flatMap((capture) => [
    capture?.label,
    typeof capture?.path === 'string' ? capture.path.split(/[\\/]/).at(-1) : null,
].filter(Boolean)));
const processCleanup = reportEvents.find((event) => event?.type === 'e2e-process-cleanup');
if (!processCleanup || processCleanup.passed !== true || processCleanup.closed !== true
    || (report.host?.platform !== 'win32' && processCleanup.processGroupClosed !== true)) {
    throw new Error('El E2E no cerró su árbol de procesos ni confirmó que no deja una ventana de prueba huérfana.');
}

if (report.status !== 'passed') {
    throw new Error(`El E2E no terminó correctamente: ${report.status ?? 'sin estado'} (${report.error ?? 'sin detalle'})`);
}
if (report.logValidated !== true) throw new Error('El E2E no validó el log de su propia ejecución.');
if (!Number.isFinite(report.durationMs) || report.durationMs <= 0) throw new Error('El E2E no registró una duración válida.');
const timings = report.timings;
if (!timings || timings.schemaVersion !== 1
    || !Number.isFinite(timings.totalMs) || timings.totalMs <= 0
    || !Array.isArray(timings.phases) || timings.phases.length === 0
    || !Array.isArray(timings.shells)
    || !Array.isArray(timings.operations)
    || !Array.isArray(timings.timeline)
    || timings.timeline.length !== reportEvents.length
    || timings.timeline.some((entry) => !entry?.type
        || !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0
        || !Number.isFinite(entry.sincePreviousMs) || entry.sincePreviousMs < 0)) {
    throw new Error('El informe E2E no contiene el desglose temporal completo de sus eventos y operaciones.');
}
if (timings.totalMs !== report.durationMs
    || timings.phases.some((phase) => !phase?.name || !Number.isFinite(phase.durationMs) || phase.durationMs < 0)) {
    throw new Error('El desglose temporal del E2E no coincide con la duración total o contiene fases inválidas.');
}

if (report.focusedScenario === 'environment-shell-matrix') {
    const events = Array.isArray(report.events) ? report.events : [];
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const matrix = events.find((event) => event?.type === 'environment-shell-matrix');
    const availableIds = Array.isArray(matrix?.availableIds) ? matrix.availableIds : [];
    const testedIds = Array.isArray(matrix?.testedIds) ? matrix.testedIds : [];
    const skipped = Array.isArray(matrix?.skipped) ? matrix.skipped : [];
    const probes = events.filter((event) => event?.type === 'environment-probe');
    const probeSkips = events.filter((event) => event?.type === 'environment-probe-skipped');
    const restore = events.find((event) => event?.type === 'environment-switch-restore');
    const successfulIds = new Set(probes.filter((event) => event.passed === true
        && event.startupClean === true
        && event.markerOutputDetected === true
        && (event.id !== 'lang:forth'
            || (event.expectedResultBeforeMarker === '3' && event.expectedResultDetected === true
                && event.startupHintVisible === true
                && event.startupHintCapture === 'shell-lang-forth-startup-help'))
        && ['native-click', 'verified-pointer-fallback'].includes(event.terminalFocusMethod)
        && ['shell', 'repl'].includes(event.kind)).map((event) => event.id));
    const skippedIds = skipped.map((entry) => entry?.id);
    const accountedIds = [...testedIds, ...skippedIds];
    const expectedAlternates = testedIds.filter((id) => id !== matrix?.originalId);
    const captures = new Set((report.captures ?? []).map((capture) => capture?.label));

    if (!phases.has('arranque de interfaz') || !phases.has('cambio de shell')
        || !matrix || matrix.passed !== true
        || !Array.isArray(matrix.availableIds) || availableIds.length === 0
        || !Array.isArray(matrix.testedIds) || !Array.isArray(matrix.skipped)
        || matrix.originalSource !== 'aria-selected/class'
        || matrix.restoredTo !== matrix.originalId
        || new Set(availableIds).size !== availableIds.length
        || new Set(testedIds).size !== testedIds.length
        || new Set(skippedIds).size !== skippedIds.length
        || new Set(accountedIds).size !== accountedIds.length
        || accountedIds.length !== availableIds.length
        || availableIds.some((id) => !accountedIds.includes(id))
        || testedIds.length !== probes.length
        || testedIds.some((id) => !successfulIds.has(id))
        || skipped.length !== probeSkips.length
        || skipped.some((entry) => !entry?.reason?.trim()
            || !probeSkips.some((event) => event.id === entry.id && event.reason === entry.reason))
        || JSON.stringify(matrix.testedAlternates) !== JSON.stringify(expectedAlternates)
        || matrix.probeCount !== probes.length
        || matrix.shellProbeCount !== probes.filter((event) => event.kind === 'shell').length
        || matrix.replProbeCount !== probes.filter((event) => event.kind === 'repl').length
        || !restore || restore.passed !== true || restore.to !== matrix.originalId
        || (matrix.originalId === 'fish' && restore.restoredFish !== true)
        || !captures.has(matrix.originalCaptureLabel) || !captures.has(matrix.captureLabel)
        || (testedIds.includes('lang:forth') && !captures.has('shell-lang-forth-startup-help'))
        || probes.some((event) => !Number.isFinite(event.durationMs) || event.durationMs < 0)
        || probes.some((event) => !Number.isFinite(event.bannerReadyMs) || event.bannerReadyMs < 0)
        || !Array.isArray(matrix.shellTimings)
        || matrix.shellTimings.length !== probes.length
        || matrix.shellTimings.some((entry) => !entry?.id || !Number.isFinite(entry.durationMs)
            || !Number.isFinite(entry.readinessMs))) {
        throw new Error('El E2E enfocado de shells no probó/restauró todos los entornos o carece de capturas verificables.');
    }
    await new Promise((resolve) => process.stdout.write(
        `Informe E2E enfocado validado: ${probes.length} shells/REPLs probados, ${skipped.length} omisiones explicadas y shell original restaurada.\n`,
        resolve,
    ));
    process.exit(0);
}

if (report.focusedScenario === 'ltools-catalog-integration') {
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const integration = reportEvents.find((event) => event?.type === 'ltools-integration');
    const captures = new Set((report.captures ?? []).map((capture) => capture?.label));
    if (!phases.has('arranque de interfaz') || !phases.has('integración opcional de LTools')
        || !integration || integration.passed !== true
        || integration.schema !== 'ltools-actions-v1'
        || integration.catalogMatch !== true
        || typeof integration.binary !== 'string' || !integration.binary
        || !Number.isInteger(integration.catalogActions) || integration.catalogActions < 1
        || !Number.isInteger(integration.compatibleActions) || integration.compatibleActions < 1
        || integration.compatibleActions > integration.catalogActions
        || !Number.isInteger(integration.availableActions) || integration.availableActions < 1
        || integration.availableActions > integration.catalogActions
        || !Number.isInteger(integration.pickerActions) || integration.pickerActions < 1
        || integration.pickerActions > integration.compatibleActions
        || typeof integration.selectedAction !== 'string' || !integration.selectedAction
        || !Number.isInteger(integration.selectedCount) || integration.selectedCount < 1
        || integration.selectedCount > integration.pickerActions
        || integration.selectionPersisted !== true
        || integration.selectionStorageVerified !== true
        || integration.executionCompleted !== true
        || integration.resultPromptVisible !== true
        || !Number.isFinite(integration.durationMs) || integration.durationMs < 0
        || !Number.isFinite(integration.catalogDiscoveryMs) || integration.catalogDiscoveryMs < 0
        || !Array.isArray(integration.candidateAttempts)
        || integration.candidateAttempts.length < 1
        || integration.candidateAttempts.some((attempt) => !attempt?.candidate
            || !Number.isFinite(attempt.durationMs) || attempt.durationMs < 0)
        || !captures.has('ltools-catalogo-y-selector')) {
        throw new Error('El E2E enfocado de LTools no validó descubrimiento, selección y ejecución del catálogo real.');
    }
    await new Promise((resolve) => process.stdout.write(
        `Informe E2E enfocado de LTools validado: ${integration.catalogActions} acciones descubiertas y ${integration.selectedAction} ejecutada.\n`,
        resolve,
    ));
    process.exit(0);
}

if (report.focusedScenario === 'progress-output-layout') {
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const progress = reportEvents.find((event) => event?.type === 'progress-output-layout');
    const scenarios = Array.isArray(progress?.scenarios) ? progress.scenarios : [];
    const update = scenarios.find((scenario) => scenario?.id === 'update');
    const upgrade = scenarios.find((scenario) => scenario?.id === 'upgrade');
    if (!phases.has('arranque de interfaz') || !phases.has('salidas progresivas de actualización')
        || !progress || progress.passed !== true
        || !update?.passed || !upgrade?.passed
        || !Number.isFinite(update.commandDurationMs) || update.commandDurationMs < 0
        || !Number.isFinite(upgrade.commandDurationMs) || upgrade.commandDurationMs < 0
        || update.host?.overflow === 'true'
        || update.host?.scrollWidth > update.host?.clientWidth + 2
        || !Number.isFinite(update.maxVisibleRowLength)
        || Number(update.host?.cols) > Math.max(Number(update.maxVisibleRowLength), Number(update.host?.clientWidth) || 0) + 8
        || upgrade.host?.overflow !== 'true'
        || upgrade.host?.scrollWidth <= upgrade.host?.clientWidth + 2
        || !Number.isFinite(upgrade.maxVisibleRowLength)
        || Number(upgrade.host?.cols) > Number(upgrade.maxVisibleRowLength) + 8
        || progress.cleanup?.reclaimed !== true
        || !Number.isFinite(progress.cleanup?.durationMs) || progress.cleanup.durationMs < 0
        || !Number.isFinite(progress.durationMs) || progress.durationMs < 0
        || !['progress-update-layout', 'progress-upgrade-layout', 'progress-clean-layout']
            .every((label) => (report.captures ?? []).some((capture) => capture?.label === label))) {
        throw new Error('El E2E enfocado de progreso no verificó barras corta/larga, desbordamiento controlado, limpieza y recuperación del ancho.');
    }
    await new Promise((resolve) => process.stdout.write(
        `Informe E2E enfocado de progreso validado: update sin overflow, upgrade con overflow por contenido y ancho recuperado (${progress.durationMs} ms).\n`,
        resolve,
    ));
    process.exit(0);
}

if (report.focusedScenario === 'settings-footer-800x600') {
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const layout = reportEvents.find((event) => event?.type === 'settings-footer-compact-layout');
    if (!phases.has('arranque de interfaz') || !phases.has('Ajustes compactos 800x600')
        || !layout || layout.passed !== true
        || layout.viewport?.width !== 800 || layout.viewport?.height !== 600
        || !Number.isFinite(layout.maxScroll) || layout.maxScroll <= 0
        || !Number.isFinite(layout.contentBottom) || !Number.isFinite(layout.footerTop)
        || layout.contentBottom > layout.footerTop + 1
        || !(report.captures ?? []).some((capture) => capture?.label === 'settings-footer-800x600')) {
        throw new Error('El E2E enfocado de Ajustes no verificó el pie fijo y el scroll completo a 800x600.');
    }
    process.exit(0);
}

if (report.focusedScenario === 'explorer-double-click') {
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const explorer = reportEvents.find((event) => event?.type === 'explorer-double-click');
    if (!phases.has('arranque de interfaz') || !phases.has('doble clic real del Explorador')
        || !explorer || explorer.passed !== true || explorer.enteredOnce !== true
        || explorer.restored !== true || explorer.enteredPath !== explorer.expectedPath
        || explorer.gesture !== 'pointerMove → pointerDown → pointerUp × 2'
        || !Array.isArray(explorer.captures) || explorer.captures.length < 3
        || explorer.captures.some((label) => !captureNames.has(label))) {
        throw new Error('El E2E enfocado del Explorador no verificó doble clic, navegación única, restauración y capturas.');
    }
    process.exit(0);
}

if (report.focusedScenario === 'terminal-mouse-drag-selection') {
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const selection = reportEvents.find((event) => event?.type === 'terminal-mouse-selection');
    if (!phases.has('arranque de interfaz') || !phases.has('selección de texto mediante arrastre real')
        || !selection || selection.passed !== true
        || selection.gesture !== 'pointerDown → pointerMove while pressed → pointerUp'
        || !selection.target || !selection.selection
        || !captureNames.has('mouse-selection-drag')) {
        throw new Error('El E2E enfocado del ratón no verificó una selección visible y capturada en xterm.');
    }
    process.exit(0);
}

if (report.focusedScenario === 'adb-progressive-output-repaint') {
    const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
    const adb = reportEvents.find((event) => event?.type === 'adb-progressive-output-repaint');
    if (!phases.has('arranque de interfaz') || !phases.has('salida progresiva ADB sin cambios de layout')
        || !adb || adb.passed !== true || adb.transport !== 'adb-shell-pty'
        || adb.layoutUnchanged !== true || !Array.isArray(adb.frames) || adb.frames.length < 3
        || adb.frames.some((frame) => frame.layoutUnchanged !== true || !frame.capture
            || !captureNames.has(frame.capture))) {
        throw new Error('El E2E enfocado ADB no verificó los tres frames progresivos ni la conservación del layout.');
    }
    process.exit(0);
}

const requiredPhases = [
    'arranque de interfaz',
    'selección de texto mediante arrastre real',
    'estados de ventana',
    'comandos internos y shell',
    'cambio de shell',
    'acciones concurrentes',
    'ajustes',
    'biblioteca y operaciones',
    'explorador y menú contextual',
    'proyectos',
    'entorno y dependencias',
    'pestañas, división y redimensionado',
    'salidas progresivas de actualización',
    'repetición de acciones y fastfetch',
];
const phases = new Set((report.phases ?? []).map((phase) => phase?.name));
const missing = requiredPhases.filter((phase) => !phases.has(phase));
if (missing.length) throw new Error(`El E2E terminó sin ejecutar estas fases: ${missing.join(', ')}`);

const events = reportEvents;
if (events.length < requiredPhases.length) throw new Error(`El E2E solo registró ${events.length} eventos.`);
const mouseSelection = events.find((event) => event?.type === 'terminal-mouse-selection');
if (!mouseSelection || mouseSelection.passed !== true
    || mouseSelection.gesture !== 'pointerDown → pointerMove while pressed → pointerUp') {
    throw new Error('El E2E no demostró una selección visible mediante arrastre real del ratón.');
}
const terminalOutputRepaint = events.find((event) => event?.type === 'terminal-output-repaint');
if (!terminalOutputRepaint || terminalOutputRepaint.passed !== true
    || terminalOutputRepaint.trigger !== 'pty-output-idle'
    || !Number.isFinite(terminalOutputRepaint.refreshCount) || terminalOutputRepaint.refreshCount < 1
    || !Number.isFinite(terminalOutputRepaint.rowsRefreshed) || terminalOutputRepaint.rowsRefreshed < 1
    || terminalOutputRepaint.layoutUnchanged !== true
    || typeof terminalOutputRepaint.marker !== 'string' || !terminalOutputRepaint.marker
    || !terminalOutputRepaint.capture
    || !(report.captures ?? []).some((capture) => capture?.label === terminalOutputRepaint.capture)) {
    throw new Error('El E2E no demostró el repintado de salida PTY sin resize/división y sin captura visual.');
}
const progressLayout = events.find((event) => event?.type === 'progress-output-layout');
const progressScenarios = Array.isArray(progressLayout?.scenarios) ? progressLayout.scenarios : [];
const progressUpdate = progressScenarios.find((scenario) => scenario?.id === 'update');
const progressUpgrade = progressScenarios.find((scenario) => scenario?.id === 'upgrade');
if (!progressLayout || progressLayout.passed !== true
    || !progressUpdate?.passed || !progressUpgrade?.passed
    || progressUpdate.host?.overflow === 'true'
    || progressUpdate.host?.scrollWidth > progressUpdate.host?.clientWidth + 2
    || !Number.isFinite(progressUpdate.maxVisibleRowLength)
    || Number(progressUpdate.host?.cols) > Math.max(Number(progressUpdate.maxVisibleRowLength), Number(progressUpdate.host?.clientWidth) || 0) + 8
    || progressUpgrade.host?.overflow !== 'true'
    || progressUpgrade.host?.scrollWidth <= progressUpgrade.host?.clientWidth + 2
    || !Number.isFinite(progressUpgrade.maxVisibleRowLength)
    || Number(progressUpgrade.host?.cols) > Number(progressUpgrade.maxVisibleRowLength) + 8
    || progressLayout.cleanup?.reclaimed !== true
    || progressScenarios.some((scenario) => !Number.isFinite(scenario.commandDurationMs) || scenario.commandDurationMs < 0)
    || !Number.isFinite(progressLayout.cleanup?.durationMs) || progressLayout.cleanup.durationMs < 0) {
    throw new Error('El E2E no demostró que las barras de actualización solo ocupen el ancho de su contenido y lo recuperen al terminar.');
}
const horizontalHelp = events.find((event) => event?.type === 'horizontal-help-geometry');
if (!horizontalHelp || horizontalHelp.passed !== true
    || !Number.isFinite(horizontalHelp.snapshot?.host?.clientWidth)
    || !Number.isFinite(horizontalHelp.snapshot?.host?.scrollWidth)
    || horizontalHelp.snapshot.host.scrollWidth <= horizontalHelp.snapshot.host.clientWidth
    || horizontalHelp.snapshot.indicator?.opacity !== '1'
    || horizontalHelp.horizontalWheelProbe?.lineMode?.defaultPrevented !== true
    || horizontalHelp.horizontalWheelProbe?.pixelMode?.defaultPrevented !== true
    || horizontalHelp.horizontalWheelProbe?.pageMode?.defaultPrevented !== true) {
    throw new Error('El E2E no probó el scroll horizontal de la ayuda con las tres unidades de rueda.');
}
const widthReclaim = events.find((event) => event?.type === 'terminal-columns-reclaim');
if (!widthReclaim || widthReclaim.passed !== true
    || !Number.isFinite(widthReclaim.beforeCols) || !Number.isFinite(widthReclaim.visibleCols)
    || !Number.isFinite(widthReclaim.afterCols) || !Number.isFinite(widthReclaim.hostWidth)
    || !Number.isFinite(widthReclaim.hostScrollWidth)
    || widthReclaim.beforeCols <= widthReclaim.visibleCols
    || widthReclaim.afterCols > widthReclaim.visibleCols + 1
    || widthReclaim.hostScrollWidth > widthReclaim.hostWidth + 2
    || widthReclaim.oldestOutputVisibleAfterWheelUp !== true
    || widthReclaim.newestOutputVisibleAfterWheelDown !== true
    || !Number.isFinite(widthReclaim.scrollUp?.dispatched) || widthReclaim.scrollUp.dispatched < 1
    || !Number.isFinite(widthReclaim.scrollUp?.prevented) || widthReclaim.scrollUp.prevented < 1
    || !Number.isFinite(widthReclaim.scrollDown?.dispatched) || widthReclaim.scrollDown.dispatched < 1
    || !Number.isFinite(widthReclaim.scrollDown?.prevented) || widthReclaim.scrollDown.prevented < 1
    || widthReclaim.generatedLines < 12
    || widthReclaim.outputMarkerVisible !== true) {
    throw new Error('El E2E no demostró la recuperación de columnas y del scrollback mediante rueda vertical.');
}
const shellMatrix = events.find((event) => event?.type === 'environment-shell-matrix');
const availableIds = Array.isArray(shellMatrix?.availableIds) ? shellMatrix.availableIds : [];
const testedIds = Array.isArray(shellMatrix?.testedIds) ? shellMatrix.testedIds : [];
const skipped = Array.isArray(shellMatrix?.skipped) ? shellMatrix.skipped : [];
const availableAlternates = availableIds.filter((id) => id !== shellMatrix?.originalId);
const environmentProbes = events.filter((event) => event?.type === 'environment-probe');
const probeSkips = events.filter((event) => event?.type === 'environment-probe-skipped');
const restoredOriginal = events.find((event) => event?.type === 'environment-switch-restore');
const testedAlternates = Array.isArray(shellMatrix?.testedAlternates) ? shellMatrix.testedAlternates : [];
const probeIds = environmentProbes.map((event) => event.id);
const probeSkipIds = probeSkips.map((event) => event.id);
const successfulProbeIds = new Set(environmentProbes
    .filter((event) => event.passed === true && event.startupClean === true
        && event.markerOutputDetected === true
        && (event.id !== 'lang:forth'
            || (event.expectedResultBeforeMarker === '3' && event.expectedResultDetected === true
                && event.startupHintVisible === true
                && event.startupHintCapture === 'shell-lang-forth-startup-help'))
        && ['native-click', 'verified-pointer-fallback'].includes(event.terminalFocusMethod)
        && ['shell', 'repl'].includes(event.kind))
    .map((event) => event.id));
const skippedIds = skipped.map((event) => event?.id);
const accountedIds = [...testedIds, ...skippedIds];
const computedAlternates = testedIds.filter((id) => id !== shellMatrix?.originalId);
if (!shellMatrix || shellMatrix.passed !== true
    || !Array.isArray(shellMatrix.availableIds)
    || !shellMatrix.availableIds.includes(shellMatrix.originalId)
    || shellMatrix.restoredTo !== shellMatrix.originalId
    || shellMatrix.originalSource !== 'aria-selected/class'
    || availableIds.length === 0
    || !Array.isArray(shellMatrix.testedIds)
    || !Array.isArray(shellMatrix.skipped)
    || testedIds.length + skipped.length !== availableIds.length
    || new Set(availableIds).size !== availableIds.length
    || new Set(testedIds).size !== testedIds.length
    || new Set(probeIds).size !== probeIds.length
    || new Set(skippedIds).size !== skippedIds.length
    || new Set(probeSkipIds).size !== probeSkipIds.length
    || new Set(accountedIds).size !== accountedIds.length
    || accountedIds.some((id) => !availableIds.includes(id))
    || availableIds.some((id) => !accountedIds.includes(id))
    || skipped.some((entry) => typeof entry?.reason !== 'string' || !entry.reason.trim())
    || probeSkips.length !== skipped.length
    || skipped.some((entry) => !probeSkips.some((event) => event.id === entry.id && event.reason === entry.reason))
    || testedIds.length !== environmentProbes.length
    || testedIds.some((id) => !successfulProbeIds.has(id))
    || testedIds.some((id) => skippedIds.includes(id))
    || new Set(testedAlternates).size !== testedAlternates.length
    || testedAlternates.some((id) => id === shellMatrix.originalId || !availableAlternates.includes(id))
    || JSON.stringify(testedAlternates) !== JSON.stringify(computedAlternates)
    || shellMatrix.probeCount !== environmentProbes.length
    || (shellMatrix.shellProbeCount !== environmentProbes.filter((event) => event.kind === 'shell').length)
    || (shellMatrix.replProbeCount !== environmentProbes.filter((event) => event.kind === 'repl').length)
    || (environmentProbes.length === 0)
    || (testedIds.includes(shellMatrix.originalId) && !successfulProbeIds.has(shellMatrix.originalId))
    || !restoredOriginal || restoredOriginal.passed !== true
    || restoredOriginal.to !== shellMatrix.originalId
    || (report.host?.platform === 'linux' && shellMatrix.availableIds.includes('fish')
        && !successfulProbeIds.has('fish'))
    || (report.host?.platform === 'linux' && shellMatrix.originalId === 'fish'
        && restoredOriginal.restoredFish !== true)
    || environmentProbes.some((event) => !Number.isFinite(event.durationMs) || event.durationMs < 0)
    || environmentProbes.some((event) => !Number.isFinite(event.bannerReadyMs) || event.bannerReadyMs < 0)
    || !Array.isArray(shellMatrix.shellTimings)
    || shellMatrix.shellTimings.length !== environmentProbes.length) {
    throw new Error('El E2E no cubrió todos los shells/REPL detectados con una sonda PTY real, no justificó sus omisiones o no restauró el entorno original.');
}
for (const captureLabel of [shellMatrix.originalCaptureLabel, shellMatrix.captureLabel]) {
    if (!captureLabel || !(report.captures ?? []).some((capture) => capture?.label === captureLabel)) {
        throw new Error(`El E2E no conservó la captura de shell ${captureLabel ?? 'sin etiqueta'}.`);
    }
}
if (testedIds.includes('lang:forth') && !report.captures?.some((capture) => capture?.label === 'shell-lang-forth-startup-help')) {
    throw new Error('El E2E no conservó la captura que demuestra que la ayuda inicial de Gforth queda visible.');
}
const ltoolsUiSource = events.find((event) => event?.type === 'ltools-ui-source');
if (!ltoolsUiSource || ltoolsUiSource.passed !== true
    || ltoolsUiSource.legacySelectorCount !== 0
    || ltoolsUiSource.ltoolsSectionCount !== 1
    || (ltoolsUiSource.available !== true && ltoolsUiSource.installControlVisible !== true)) {
    throw new Error('El E2E no demostró que LTools sea la única fuente de acciones fijadas ni que exista un estado de instalación controlado.');
}
const legacyQuickActions = events.find((event) => event?.type === 'legacy-quick-actions-compat');
if (!legacyQuickActions || legacyQuickActions.passed !== true
    || legacyQuickActions.command !== ':quick-actions list'
    || legacyQuickActions.migratedTo !== 'ltools'
    || legacyQuickActions.mutatesPreferences !== false) {
    throw new Error('El E2E no verificó la compatibilidad segura del comando antiguo de acciones rápidas.');
}

const contextMenu = events.find((event) => event?.type === 'context-menu');
if (!contextMenu || !contextMenu.actions?.includes('cut') || !contextMenu.actions?.includes('delete')) {
    throw new Error('El E2E no demostró que el menú contextual contuviese cortar y eliminar.');
}

const explorerDoubleClick = events.find((event) => event?.type === 'explorer-double-click');
if (!explorerDoubleClick || explorerDoubleClick.skipped === true
    || explorerDoubleClick.passed !== true
    || explorerDoubleClick.enteredOnce !== true
    || explorerDoubleClick.restored !== true
    || explorerDoubleClick.gesture !== 'pointerMove → pointerDown → pointerUp × 2'
    || explorerDoubleClick.enteredPath !== explorerDoubleClick.expectedPath) {
    throw new Error('El E2E no demostró un doble clic real del Explorador con navegación única y restauración segura.');
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

const splitColumns = events.find((event) => event?.type === 'split-terminal-columns-minimal');
const splitPaneHasUsableGeometry = (pane) => Number.isFinite(pane?.cols)
    && Number.isFinite(pane?.visibleCols)
    && Number.isFinite(pane?.hostWidth)
    && Number.isFinite(pane?.hostScrollWidth)
    && pane.hostWidth > 0
    && pane.cols > 0
    && pane.visibleCols > 0;
const splitPaneFitsViewport = (pane) => pane.cols <= pane.visibleCols + 1
    && pane.hostScrollWidth <= pane.hostWidth + 2;
const splitPaneOverflowIsContentDriven = (pane) => pane.overflow === 'true'
    && Number.isFinite(pane.longestVisibleRow)
    && pane.cols > pane.visibleCols + 1
    && pane.hostScrollWidth > pane.hostWidth + 2
    && pane.longestVisibleRow > pane.visibleCols
    && pane.cols <= pane.longestVisibleRow + 2;
if (!splitColumns || splitColumns.passed !== true || splitColumns.panes?.length !== 2
    || splitColumns.panes.some((pane) => !splitPaneHasUsableGeometry(pane)
        || (!splitPaneFitsViewport(pane) && !splitPaneOverflowIsContentDriven(pane)))
    || !splitColumns.panes.some(splitPaneFitsViewport)) {
    throw new Error('El E2E no demostró columnas mínimas y ausencia de espacio horizontal sobrante en ambos paneles divididos.');
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
        || !['webdriver', 'hyprland-resizeactive-fallback'].includes(event.nativeResizeMethod)
        || (event.nativeResizeMethod === 'hyprland-resizeactive-fallback' && event.platform !== 'linux')
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
// Linux usa la cabecera compacta «LTerminal 1.0.0»; Windows mantiene
// «WTerminal» o «LTerminal». Ambas representan un único bloque válido.
const bannerHeader = /^(?:LTerminal\b|WTerminal\b)/i;
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
