import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const phases = [
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
const valid = {
    status: 'passed',
    logValidated: true,
    durationMs: 1200,
    host: { platform: 'linux' },
    phases: phases.map((name) => ({ name, durationMs: 10 })),
    captures: [
        { label: 'window-resize-win32-reduccion-de-ventana', path: 'resize-1.png' },
        { label: 'window-resize-win32-restauracion-de-ventana', path: 'resize-2.png' },
        { label: 'atajo-nueva-pestana', path: 'shortcut-new-tab.png' },
        { label: 'atajo-pestana-siguiente', path: 'shortcut-next-tab.png' },
        { label: 'atajo-division-dos-paneles', path: 'shortcut-split-2.png' },
        { label: 'atajo-division-tres-paneles', path: 'shortcut-split-3.png' },
        { label: 'shell-matrix-linux-original-selected', path: 'shell-menu.png' },
        { label: 'shell-matrix-linux-restored', path: 'shell-matrix.png' },
        { label: 'pty-output-repaint-no-layout-event', path: 'pty-output-repaint.png' },
        { label: 'progress-update-layout', path: 'progress-update.png' },
        { label: 'progress-upgrade-layout', path: 'progress-upgrade.png' },
        { label: 'progress-clean-layout', path: 'progress-clean.png' },
    ],
    events: [
        ...phases.map((name) => ({ type: 'phase', name })),
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
        { type: 'terminal-mouse-selection', passed: true, gesture: 'pointerDown → pointerMove while pressed → pointerUp' },
        { type: 'terminal-output-repaint', passed: true, trigger: 'pty-output-idle', refreshCount: 1, rowsRefreshed: 24, layoutUnchanged: true, marker: 'LTERMINAL_OUTPUT_REPAINT_FIXTURE', capture: 'pty-output-repaint-no-layout-event' },
        { type: 'progress-output-layout', passed: true, simulation: 'download/update/upgrade with carriage-return output', baseline: { host: { clientWidth: 400, cols: 50 } }, scenarios: [
            { id: 'update', passed: true, commandDurationMs: 25, expectedMinimum: 45, maxVisibleRowLength: 48, expectedLineLength: 57, contentDriven: true, host: { clientWidth: 400, scrollWidth: 400, overflow: 'false', cols: 50 }, capture: 'progress-update-layout' },
            { id: 'upgrade', passed: true, commandDurationMs: 30, expectedMinimum: 160, maxVisibleRowLength: 190, expectedLineLength: 190, host: { clientWidth: 400, scrollWidth: 1200, overflow: 'true', cols: 190 }, capture: 'progress-upgrade-layout' },
        ], cleanup: { reclaimed: true, durationMs: 20, capture: 'progress-clean-layout' }, durationMs: 80 },
        { type: 'horizontal-help-geometry', passed: true, snapshot: { host: { clientWidth: 400, scrollWidth: 850 }, indicator: { opacity: '1' } }, horizontalWheelProbe: { lineMode: { defaultPrevented: true }, pixelMode: { defaultPrevented: true }, pageMode: { defaultPrevented: true } } },
        { type: 'terminal-columns-reclaim', passed: true, beforeCols: 100, visibleCols: 50, afterCols: 50, hostWidth: 400, hostScrollWidth: 400, oldestOutputVisibleAfterWheelUp: true, newestOutputVisibleAfterWheelDown: true, scrollUp: { dispatched: 3, prevented: 3 }, scrollDown: { dispatched: 3, prevented: 3 }, generatedLines: 24, outputMarkerVisible: true },
        { type: 'environment-probe', id: 'bash', kind: 'shell', markerOutputDetected: true, terminalFocusMethod: 'native-click', startupClean: true, passed: true },
        { type: 'environment-probe', id: 'zsh', kind: 'shell', markerOutputDetected: true, terminalFocusMethod: 'native-click', startupClean: true, passed: true },
        { type: 'environment-probe', id: 'fish', kind: 'shell', markerOutputDetected: true, terminalFocusMethod: 'native-click', startupClean: true, passed: true },
        { type: 'environment-probe', id: 'lang:python', kind: 'repl', language: 'python', markerOutputDetected: true, terminalFocusMethod: 'verified-pointer-fallback', startupClean: true, passed: true },
        { type: 'environment-probe-skipped', id: 'lang:postgresql', kind: 'skip', reason: 'necesita un servicio externo y credenciales' },
        { type: 'environment-shell-matrix', originalId: 'fish', originalSource: 'aria-selected/class', availableIds: ['fish', 'bash', 'zsh', 'lang:python', 'lang:postgresql'], testedIds: ['fish', 'bash', 'zsh', 'lang:python'], testedAlternates: ['bash', 'zsh', 'lang:python'], skipped: [{ id: 'lang:postgresql', kind: 'skip', reason: 'necesita un servicio externo y credenciales' }], probeCount: 4, shellProbeCount: 3, replProbeCount: 1, restoredTo: 'fish', originalCaptureLabel: 'shell-matrix-linux-original-selected', captureLabel: 'shell-matrix-linux-restored', passed: true },
        { type: 'environment-switch-restore', to: 'fish', restoredFish: true, passed: true },
        { type: 'ltools-disabled-by-default', visible: false, installControlVisible: false, passed: true },
        { type: 'ltools-ui-source', legacySelectorCount: 0, ltoolsSectionCount: 1, available: false, installControlVisible: true, initiallyClosed: true, passed: true },
        { type: 'legacy-quick-actions-compat', command: ':quick-actions list', migratedTo: 'ltools', mutatesPreferences: false, passed: true },
        { type: 'context-menu', actions: ['cut', 'delete', 'settings'] },
        { type: 'dependencies', groups: 8, subgroups: 6, repeatedLoads: 3, platformGroup: 'Virtualización' },
        { type: 'multi-pane-minimum', passed: true, geometryValid: true, paneCount: 2, panes: [{}, {}] },
        { type: 'split-terminal-columns-minimal', passed: true, panes: [
            { cols: 64, visibleCols: 33, hostWidth: 231, hostScrollWidth: 448, overflow: 'true', longestVisibleRow: 64 },
            { cols: 47, visibleCols: 47, hostWidth: 392, hostScrollWidth: 392, overflow: 'false', longestVisibleRow: 1 },
        ] },
        { type: 'responsive-minimum', passed: true, configured: { width: 481, height: 271 }, requested: { width: 512, height: 281 }, applied: { width: 513, height: 282 } },
        { type: 'toolbar-geometry', label: 'mínimo responsive', passed: true, present: true, viewportWidth: 513, controls: [{ id: 'env-select' }, { id: 'toolbar-settings' }], overlaps: [], clipped: [] },
        { type: 'native-window-resize', platform: 'linux', nativeResizeMethod: 'webdriver', passed: true, nativeChanged: true, viewportChanged: true, ptyChanged: true },
        { type: 'native-window-resize', platform: 'linux', nativeResizeMethod: 'webdriver', passed: true, nativeChanged: true, viewportChanged: true, ptyChanged: true },
        { type: 'tab-isolation', passed: true, tabs: 3 },
        { type: 'rapid-tab-replace', passed: true, isolated: true, closedTabId: 'tab-1', createdTabId: 'tab-2' },
        { type: 'explorer-cwd-layout', passed: true, cwdFollowed: true, layout: { pathHeight: 18, gap: 0, ordered: true } },
        { type: 'explorer-double-click', skipped: false, environmentId: 'fish', enteredPath: '/tmp/lterminal-e2e-double-click/nested', expectedPath: '/tmp/lterminal-e2e-double-click/nested', enteredOnce: true, restored: true, gesture: 'pointerMove → pointerDown → pointerUp × 2', passed: true },
        { type: 'keyboard-shortcuts', passed: true, newTab: true, nextTab: true, cyclePanes: true, explorerToggle: true },
        { type: 'shell-startup-performance', passed: true, samples: 4, maxMs: 740, limitMs: 2500 },
        { type: 'responsive-matrix', panes: 2, cases: 20, explorerStates: [false, true] },
        { type: 'pane-matrix-fragments-absent', label: 'rejilla 2 paneles', expected: 2, panes: [{ width: 500, maxRun: 0 }, { width: 500, maxRun: 0 }], passed: true },
        { type: 'pane-matrix-fragments-absent', label: 'rejilla 3 paneles', expected: 3, panes: [{ width: 330, maxRun: 0 }, { width: 330, maxRun: 0 }, { width: 660, maxRun: 0 }], passed: true },
        { type: 'pane-matrix-fragments-absent', label: 'rejilla 4 paneles', expected: 4, panes: [{ width: 300, maxRun: 0 }, { width: 300, maxRun: 0 }, { width: 300, maxRun: 0 }, { width: 300, maxRun: 0 }], passed: true },
        { type: 'banner-ready', promptsVisible: true, preview: ['WTerminal 1.0.0\nSistema  Windows\nPlaca  ASUS\nGPU  Intel\nC:\\>'] },
    ],
};

function addTimingFixture(report) {
    const events = report.events;
    const probes = events.filter((event) => event.type === 'environment-probe');
    for (const event of probes) {
        event.durationMs ??= 120;
        event.bannerReadyMs ??= 40;
    }
    const matrix = events.find((event) => event.type === 'environment-shell-matrix');
    if (matrix) {
        matrix.shellTimings = probes.map((event) => ({
            id: event.id,
            kind: event.kind,
            durationMs: event.durationMs,
            readinessMs: event.bannerReadyMs,
            passed: true,
        }));
    }
    const integration = events.find((event) => event.type === 'ltools-integration');
    if (integration) {
        integration.durationMs ??= 120;
        integration.catalogDiscoveryMs ??= 40;
        integration.candidateAttempts ??= [{ candidate: integration.binary, durationMs: 40, accepted: true }];
    }
    report.timings = {
        schemaVersion: 1,
        totalMs: report.durationMs,
        phases: report.phases,
        shells: probes.map((event) => ({
            id: event.id,
            kind: event.kind,
            language: event.language ?? null,
            durationMs: event.durationMs,
            readinessMs: event.bannerReadyMs,
            passed: true,
        })),
        operations: events
            .filter((event) => Number.isFinite(event.durationMs))
            .map((event) => ({ type: event.type, label: event.id ?? null, durationMs: event.durationMs, passed: event.passed ?? null })),
        timeline: events.map((event, index) => ({
            type: event.type,
            label: event.id ?? event.name ?? null,
            elapsedMs: (index + 1) * 10,
            sincePreviousMs: 10,
            durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
            passed: event.passed ?? null,
        })),
    };
    return report;
}

addTimingFixture(valid);
const directory = await mkdtemp(join(tmpdir(), 'lterminal-e2e-report-test-'));
const verifier = resolve('scripts/verify-e2e-report.mjs');
const smokeSource = await readFile(resolve('tests/e2e/smoke.mjs'), 'utf8');
assert.match(
    smokeSource,
    /const selectEnvironment = async \(id\) =>[\s\S]*?await pointerClickInView\(option\);/,
    'la matriz de shells debe usar un clic de puntero robusto para opciones desplazables',
);
assert.match(
    smokeSource,
    /const installControlVisible = \(await findAll\('\[data-testid="scripts-ltools-install"\]'\)\)\.length === 1;/,
    'la disponibilidad de instalación LTools debe comprobar un selector estable independiente del idioma',
);
assert.match(
    smokeSource,
    /LTERMINAL_E2E_APP_DATA_DIR && process\.platform === 'win32'[\s\S]*?join\(process\.env\.LTERMINAL_E2E_APP_DATA_DIR, 'wterminal', 'logs', 'main\.log'\)/,
    'la validación de logs debe leer el directorio aislado que usa el E2E Windows',
);
assert.match(
    smokeSource,
    /async function visiblePaneCount\(\)[\s\S]*?querySelectorAll\("\.cell:not\(\.hidden\)"\)\.length/,
    'las esperas de matriz deben devolver solo el recuento para evitar serializar nodos DOM en WebKit',
);
assert.match(
    smokeSource,
    /async function promptStates\(expected\)[\s\S]*?querySelectorAll\('\.tab-pane:not\(\.hidden\)\[data-prompt-visible\]'\)[\s\S]*?dataset\.promptVisible/,
    'la matriz de prompts debe leer los atributos en un único script DOM en WebKit',
);
assert.match(
    smokeSource,
    /request\(`\/session\/\$\{sessionId\}`, 'DELETE', undefined, 5000\)/,
    'la limpieza de sesión debe tener un timeout corto aunque se amplíe el timeout de las sondas',
);
assert.match(
    smokeSource,
    /async function applicationProcessIds\(\)[\s\S]*?tasklist\.exe[\s\S]*?IMAGENAME eq wterminal\.exe/,
    'la smoke debe identificar los procesos WTerminal mediante una sonda nativa rápida',
);
assert.match(
    smokeSource,
    /async function stopApplicationProcessTree\(\)[\s\S]*?taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/,
    'la smoke debe cerrar el árbol de la aplicación que ella misma inició',
);
assert.match(
    smokeSource,
    /closed: driverCleanup\.closed && applicationCleanup\.closed[\s\S]*?applicationCleanup,/,
    'el informe E2E debe agregar la limpieza del driver y de la aplicación',
);
const christianCommandIndex = smokeSource.indexOf("await sendTerminalLine('christianlg97');");
const christianWindowsGuardIndex = smokeSource.lastIndexOf("if (process.platform === 'win32') {", christianCommandIndex);
const christianWindowsGuardEnd = smokeSource.indexOf('\n    }\n', christianWindowsGuardIndex);
assert.ok(
    christianCommandIndex >= 0
        && christianWindowsGuardIndex >= 0
        && christianWindowsGuardEnd > christianCommandIndex,
    'el comando christianlg97 solo se puede probar dentro de la guarda E2E Windows',
);

async function run(name, report) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, `${JSON.stringify(report)}\n`);
    return spawnSync(process.execPath, [verifier, path], { encoding: 'utf8' });
}

const focusedShellMatrix = {
    ...valid,
    focusedScenario: 'environment-shell-matrix',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'cambio de shell', durationMs: 10 },
    ],
    events: valid.events.filter((event) => event.type === 'environment-probe'
        || event.type === 'environment-probe-skipped'
        || event.type === 'environment-shell-matrix'
        || event.type === 'environment-switch-restore'
        || event.type === 'e2e-process-cleanup'
        || (event.type === 'phase' && ['arranque de interfaz', 'cambio de shell'].includes(event.name))),
};
const focusedWindowsShellMatrix = {
    ...focusedShellMatrix,
    host: { platform: 'win32' },
    events: [
        ...focusedShellMatrix.events,
        { type: 'wsl-distro-selector-coverage', status: 'none-installed', installedNames: [], distroIds: [], testedIds: [], passed: true },
    ],
};
addTimingFixture(focusedWindowsShellMatrix);
const dependencyAuditAction = {
    sectionId: 'development',
    groupKey: 'group.frameworks',
    id: 'framework-paket-update',
    state: 'installed',
    detectionStatus: 'confirmed',
    installed: true,
    disabled: false,
};
const dependencyAuditPass = (pass) => ({
    pass,
    durationMs: 240,
    sections: [{ id: 'development', index: 0, groups: 1 }],
    groups: [{ sectionId: 'development', key: 'group.frameworks', index: 0, actions: 1, subgroups: 1 }],
    actions: [dependencyAuditAction],
    actionCount: 1,
    groupCount: 1,
    stateCounts: { installed: 1 },
    signature: JSON.stringify([{
        sectionId: dependencyAuditAction.sectionId,
        groupKey: dependencyAuditAction.groupKey,
        id: dependencyAuditAction.id,
        state: dependencyAuditAction.state,
        installed: dependencyAuditAction.installed,
    }]),
});
const focusedDependencyAudit = {
    ...valid,
    focusedScenario: 'dependency-full-audit',
    durationMs: 900,
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'auditoría completa de entornos y dependencias', durationMs: 10 },
    ],
    captures: [
        { label: 'dependencias-auditoria-primera-completa', path: 'deps-first.png' },
        { label: 'dependencias-auditoria-reintentando', path: 'deps-busy.png' },
        { label: 'dependencias-auditoria-segunda-completa', path: 'deps-second.png' },
    ],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'auditoría completa de entornos y dependencias' },
        {
            type: 'dependency-full-audit',
            sections: [{ id: 'development', index: 0, groups: 1 }],
            groups: 1,
            actions: 1,
            initialDurationMs: 480,
            firstPassDurationMs: 240,
            secondPassDurationMs: 240,
            firstPass: dependencyAuditPass('primera'),
            secondPass: dependencyAuditPass('segunda'),
            unknownActionIds: [],
            captures: ['deps-first.png', 'deps-busy.png', 'deps-second.png'],
            stableInventory: true,
            passed: true,
        },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
addTimingFixture(focusedDependencyAudit);
const focusedPaneMatrix = {
    ...valid,
    focusedScenario: 'pane-matrix',
    phases: [{ name: 'driver', durationMs: 10 }, { name: 'arranque de interfaz', durationMs: 10 }, { name: 'matriz PTY y transiciones de paneles', durationMs: 10 }],
    captures: [
        { label: 'matriz-enfocada-1-a-2', path: 'matrix-1-2.png' },
        { label: 'matriz-enfocada-2-a-3', path: 'matrix-2-3.png' },
        { label: 'matriz-enfocada-3-a-4', path: 'matrix-3-4.png' },
    ],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'matriz PTY y transiciones de paneles' },
        { type: 'pane-matrix-fragments-absent', expected: 2, panes: [{ width: 500, maxRun: 0 }, { width: 500, maxRun: 0 }], passed: true },
        { type: 'pane-matrix-fragments-absent', expected: 3, panes: [{ width: 330, maxRun: 0 }, { width: 330, maxRun: 0 }, { width: 660, maxRun: 0 }], passed: true },
        { type: 'pane-matrix-fragments-absent', expected: 4, panes: [{ width: 300, maxRun: 0 }, { width: 300, maxRun: 0 }, { width: 300, maxRun: 0 }, { width: 300, maxRun: 0 }], passed: true },
        { type: 'pane-matrix-focused', transitions: [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }], finalCount: 4, passed: true },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
addTimingFixture(focusedPaneMatrix);
const focusedLTools = {
    ...valid,
    focusedScenario: 'ltools-catalog-integration',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'integración opcional de LTools', durationMs: 10 },
    ],
    captures: [{ label: 'ltools-catalogo-y-selector', path: 'ltools.png' }],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'integración opcional de LTools' },
        { type: 'ltools-integration', passed: true, binary: '/tmp/ltools', schema: 'ltools-actions-v1', catalogMatch: true, catalogActions: 50, availableActions: 32, compatibleActions: 32, pickerActions: 32, selectedAction: 'defaults.show', selectedCount: 9, selectionPersisted: true, selectionStorageVerified: true, executionCompleted: true, resultPromptVisible: true },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedProgress = {
    ...valid,
    focusedScenario: 'progress-output-layout',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'salidas progresivas de actualización', durationMs: 10 },
    ],
    captures: [
        { label: 'progress-update-layout', path: 'progress-update.png' },
        { label: 'progress-upgrade-layout', path: 'progress-upgrade.png' },
        { label: 'progress-clean-layout', path: 'progress-clean.png' },
    ],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'salidas progresivas de actualización' },
        { type: 'progress-output-layout', passed: true, durationMs: 80, scenarios: [
            { id: 'update', passed: true, commandDurationMs: 25, expectedMinimum: 45, maxVisibleRowLength: 48, expectedLineLength: 57, contentDriven: true, host: { clientWidth: 400, scrollWidth: 400, overflow: 'false', cols: 50 } },
            { id: 'upgrade', passed: true, commandDurationMs: 30, expectedMinimum: 160, maxVisibleRowLength: 190, expectedLineLength: 190, host: { clientWidth: 400, scrollWidth: 1200, overflow: 'true', cols: 190 } },
        ], cleanup: { reclaimed: true, durationMs: 20 } },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedSettings = {
    ...valid,
    focusedScenario: 'settings-footer-800x600',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'Ajustes compactos 800x600', durationMs: 10 },
    ],
    captures: [{ label: 'settings-footer-800x600', path: 'settings.png' }],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'Ajustes compactos 800x600' },
        { type: 'settings-footer-compact-layout', passed: true, viewport: { width: 800, height: 600 }, maxScroll: 200, contentBottom: 480, footerTop: 500 },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const adminPermissionsEvent = {
    type: 'windows-admin-permissions', passed: true, sectionVisible: true, elevated: false, launcher: 'needs-admin',
    gsudo: false, windowsSudo: 'disabled', restartVisible: true, installGsudoVisible: true, startAsAdminDefault: false,
    startAsAdminPersisted: true, restored: true, nsudoEnvironments: 2, nsudoConsistent: true, runAsAdminFlag: false,
    runAsAdminControl: true, adminBadge: false, capture: 'windows-admin-permissions',
    modesExclusive: true, markRemoved: true, restartUnelevatedVisible: false,
};
const focusedAdminPermissions = {
    ...valid,
    host: { platform: 'win32' },
    focusedScenario: 'windows-admin-permissions',
    phases: [{ name: 'driver', durationMs: 10 }, { name: 'arranque de interfaz', durationMs: 10 }, { name: 'ajustes', durationMs: 10 }],
    captures: [
        { label: 'windows-admin-permissions', path: 'admin-permissions.png' },
        { label: 'windows-admin-permissions-gsudo', path: 'admin-permissions-gsudo.png' },
    ],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'ajustes' },
        adminPermissionsEvent,
        {
            type: 'windows-admin-gsudo-route', passed: true, launcher: 'gsudo', detectedAfterRefresh: true,
            nsudoEnvironments: 2, nsudoThroughGsudo: true, installHidden: true, restoredLauncher: 'needs-admin',
            capture: 'windows-admin-permissions-gsudo',
        },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedInternalCommandsSkipped = {
    ...valid,
    focusedScenario: 'internal-configuration-commands',
    phases: [{ name: 'driver', durationMs: 10 }, { name: 'arranque de interfaz', durationMs: 10 }, { name: 'comandos internos y shell', durationMs: 10 }],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'comandos internos y shell' },
        { type: 'internal-configuration-commands', passed: false, skipped: true, reason: 'WebDriver no entregó una línea que empieza por «:» al textarea de xterm; el parser queda cubierto por tests unitarios.', commands: [':shell current', ':panel list', ':theme list', ':font list', ':language list', ':terminal list', ':panes list'] },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedTerminalOnly = {
    ...valid,
    focusedScenario: 'terminal-only-mode',
    phases: [{ name: 'driver', durationMs: 10 }, { name: 'arranque de interfaz', durationMs: 10 }, { name: 'modo de terminal limpia', durationMs: 10 }],
    captures: [{ label: 'terminal-only-mode', path: 'terminal-only.png' }, { label: 'terminal-only-restored', path: 'terminal-only-restored.png' }],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'modo de terminal limpia' },
        { type: 'terminal-only-mode', passed: true, cleanMode: { mode: 'terminal-only', toolbarCount: 0, tabStripCount: 0, workspacePadding: '0px', gridGap: '0px', guideCount: 1, guideText: 'Modo de pantalla limpia · Atajo: Ctrl+Shift+M', settingsButtonCount: 0, dismissButtonCount: 1, neverButtonCount: 1, horizontalOverflow: false, verticalOverflow: false }, guideSettingVisible: true, guideSettingDisabled: true, contextMenuSettings: true, restoredMode: { mode: 'normal', toolbarCount: 1, tabStripCount: 1 }, captures: ['terminal-only-mode', 'terminal-only-restored'] },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedExplorer = {
    ...valid,
    focusedScenario: 'explorer-double-click',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'doble clic real del Explorador', durationMs: 10 },
    ],
    captures: [
        { label: 'explorer-double-click-before', path: 'before.png' },
        { label: 'explorer-double-click-entered', path: 'entered.png' },
        { label: 'explorer-double-click-restored', path: 'restored.png' },
    ],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'doble clic real del Explorador' },
        { type: 'explorer-double-click', passed: true, enteredOnce: true, restored: true, enteredPath: '/tmp/nested', expectedPath: '/tmp/nested', gesture: 'pointerMove → pointerDown → pointerUp × 2', captures: ['explorer-double-click-before', 'explorer-double-click-entered', 'explorer-double-click-restored'] },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedPathIntegration = {
    ...valid,
    focusedScenario: 'path-integration',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'integración de WTerminal en PATH', durationMs: 10 },
    ],
    captures: [{ label: 'settings-path-integration', path: 'path-integration.png' }],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'integración de WTerminal en PATH' },
        { type: 'path-integration-toggle', passed: true, controlVisible: true, addedAndVerified: true, restored: true, location: 'C:/Apps/WTerminal', capture: 'settings-path-integration' },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedMouseSelection = {
    ...valid,
    focusedScenario: 'terminal-mouse-drag-selection',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'selección de texto mediante arrastre real', durationMs: 10 },
    ],
    captures: [{ label: 'mouse-selection-drag', path: 'selection.png' }],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'selección de texto mediante arrastre real' },
        { type: 'terminal-mouse-selection', passed: true, gesture: 'pointerDown → pointerMove while pressed → pointerUp', target: { startX: 10, endX: 100 }, selection: { boxes: [{ width: 90, height: 16 }] } },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedAdb = {
    ...valid,
    focusedScenario: 'adb-progressive-output-repaint',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'salida progresiva ADB sin cambios de layout', durationMs: 10 },
    ],
    captures: [
        { label: 'adb-refresh-ready', path: 'adb-ready.png' },
        { label: 'adb-refresh-frame-1', path: 'adb-1.png' },
        { label: 'adb-refresh-frame-2', path: 'adb-2.png' },
        { label: 'adb-refresh-frame-3', path: 'adb-3.png' },
    ],
    events: [
        { type: 'phase', name: 'arranque de interfaz' },
        { type: 'phase', name: 'salida progresiva ADB sin cambios de layout' },
        { type: 'adb-progressive-output-repaint', passed: true, transport: 'adb-shell-pty', layoutUnchanged: true, frames: [
            { layoutUnchanged: true, capture: 'adb-refresh-frame-1' },
            { layoutUnchanged: true, capture: 'adb-refresh-frame-2' },
            { layoutUnchanged: true, capture: 'adb-refresh-frame-3' },
        ] },
        { type: 'e2e-process-cleanup', strategy: 'dedicated-process-group', processGroupClosed: true, passed: true, closed: true },
    ],
};
const focusedAuthorCredits = (platform) => addTimingFixture({
    ...valid,
    host: { platform },
    focusedScenario: 'author-credits',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'créditos de autor por plataforma', durationMs: 10 },
    ],
    captures: [
        ...valid.captures,
        { label: 'credito-darkeiser-formato', path: 'darkeiser.png' },
        { label: 'credito-prompt-utilizable', path: 'prompt.png' },
        ...(platform === 'win32' ? [{ label: 'credito-christian-formato', path: 'christian.png' }] : []),
    ],
    events: [
        ...valid.events,
        { type: 'phase', name: 'créditos de autor por plataforma' },
        ...(platform === 'win32' ? [{ type: 'windows-collaborator-credit', alias: 'christianlg97', capture: 'credito-christian-formato', passed: true }] : []),
        {
            type: 'author-easter-eggs',
            platform,
            aliases: ['Darkeiser003', 'darkeiser003', '@darkeiser003', '@Darkeiser003', ...(platform === 'win32' ? ['christianlg97'] : [])],
            captures: ['credito-darkeiser-formato', 'credito-prompt-utilizable', ...(platform === 'win32' ? ['credito-christian-formato'] : [])],
            collaboratorCreditTested: platform === 'win32',
            passed: true,
        },
    ],
});

const focusedLanguage = addTimingFixture({
    ...valid,
    focusedScenario: 'language-switch',
    phases: [
        { name: 'driver', durationMs: 10 },
        { name: 'arranque de interfaz', durationMs: 10 },
        { name: 'idiomas y traducciones', durationMs: 10 },
    ],
    captures: [...valid.captures, { label: 'language-switch-restored', path: 'language.png' }],
    events: [...valid.events, {
        type: 'language-switch', original: 'es', restored: true, passed: true,
        tested: ['en', 'fr'].map(language => ({
            language, anchors: { tabs: ['Appearance', 'Terminal', 'Behavior', 'About'], toolbar: { settings: 'Settings' } },
        })),
    }],
});

addTimingFixture(focusedShellMatrix);
addTimingFixture(focusedLTools);
addTimingFixture(focusedProgress);
addTimingFixture(focusedSettings);
addTimingFixture(focusedAdminPermissions);
addTimingFixture(focusedInternalCommandsSkipped);
addTimingFixture(focusedTerminalOnly);
addTimingFixture(focusedExplorer);
addTimingFixture(focusedPathIntegration);
addTimingFixture(focusedMouseSelection);
addTimingFixture(focusedAdb);

try {
    assert.equal((await run('valid', valid)).status, 0, 'un informe completo debe pasar');
    assert.equal((await run('focused-language', focusedLanguage)).status, 0);
    for (const patch of [{ restored: false }, { tested: [] }, { tested: Array(2).fill(focusedLanguage.events.at(-1).tested[0]) }]) {
        const invalidLanguage = structuredClone(focusedLanguage);
        Object.assign(invalidLanguage.events.find(event => event.type === 'language-switch'), patch);
        assert.notEqual((await run('focused-language-invalid', invalidLanguage)).status, 0);
    }
    const wrappedProgressLine = {
        ...valid,
        events: valid.events.map((event) => event.type === 'progress-output-layout'
            ? {
                ...event,
                baseline: { host: { clientWidth: 890, cols: '134' } },
                scenarios: event.scenarios.map((scenario) => scenario.id === 'update'
                    ? { ...scenario, expectedMinimum: 60, maxVisibleRowLength: 134, expectedLineLength: 208, contentDriven: true, host: { clientWidth: 890, scrollWidth: 890, overflow: 'false', cols: '134' } }
                    : { ...scenario, expectedMinimum: 164, maxVisibleRowLength: 171, expectedLineLength: 208, host: { clientWidth: 890, scrollWidth: 1372, overflow: 'true', cols: '208' } }),
            }
            : event),
    };
    assert.equal((await run('valid-wrapped-progress-line', wrappedProgressLine)).status, 0,
        'la verificación completa debe aceptar una fila larga con columnas PTY basadas en el contenido aunque su texto visible se reenvuelva');
    assert.notEqual((await run('linux-christian-credit', {
        ...valid,
        captures: [...valid.captures, { label: 'credito-christian-formato', path: 'christian.png' }],
        events: [...valid.events, { type: 'windows-collaborator-credit', alias: 'christianlg97', passed: true }],
    })).status, 0, 'un informe Linux debe rechazar la ejecución o captura del crédito Christian');
    assert.equal((await run('focused-linux-author-credits', focusedAuthorCredits('linux'))).status, 0,
        'la E2E enfocada Linux debe probar Darkeiser y demostrar que no prueba ni captura christianlg97');
    assert.equal((await run('focused-windows-author-credits', focusedAuthorCredits('win32'))).status, 0,
        'la E2E enfocada Windows debe probar Darkeiser y conservar el crédito christianlg97');
    const linuxCreditAlias = focusedAuthorCredits('linux');
    linuxCreditAlias.events.find((event) => event.type === 'author-easter-eggs').aliases.push('christianlg97');
    const recalculateLinuxCreditAlias = addTimingFixture(linuxCreditAlias);
    assert.notEqual((await run('focused-linux-author-credits-forbidden-alias', recalculateLinuxCreditAlias)).status, 0,
        'la E2E Linux debe rechazar incluso si christianlg97 se filtra en la lista de alias probados');
    assert.equal((await run('focused-path-integration', focusedPathIntegration)).status, 0, 'la E2E enfocada del PATH debe exigir activación y restauración');
    assert.notEqual((await run('focused-path-integration-missing-restore', {
        ...focusedPathIntegration,
        events: focusedPathIntegration.events.map((event) => event.type === 'path-integration-toggle'
            ? { ...event, restored: false }
            : event),
    })).status, 0, 'el informe del PATH debe fallar si la prueba no revierte el estado');
    assert.notEqual((await run('missing-timing-report', {
        ...valid,
        timings: undefined,
    })).status, 0, 'el informe debe rechazar una ejecución sin desglose temporal');
    assert.notEqual((await run('timing-timeline-incomplete', {
        ...valid,
        timings: { ...valid.timings, timeline: valid.timings.timeline.slice(1) },
    })).status, 0, 'el informe debe rechazar una línea temporal incompleta');
    assert.notEqual((await run('negative-shell-timing', {
        ...valid,
        events: valid.events.map((event) => event.type === 'environment-probe' && event.id === 'zsh'
            ? { ...event, durationMs: -1 }
            : event),
    })).status, 0, 'el informe debe rechazar una duración negativa de shell');
    const withForthProbe = (expectedResultDetected, startupHintVisible = true) => addTimingFixture({
        ...valid,
        captures: [...valid.captures, { label: 'shell-lang-forth-startup-help', path: 'forth-startup.png' }],
        events: valid.events.map((event) => event.type === 'environment-shell-matrix'
            ? {
                ...event,
                availableIds: [...event.availableIds, 'lang:forth'],
                testedIds: [...event.testedIds, 'lang:forth'],
                testedAlternates: [...event.testedAlternates, 'lang:forth'],
                probeCount: event.probeCount + 1,
                replProbeCount: event.replProbeCount + 1,
            }
            : event).concat({
            type: 'environment-probe',
            id: 'lang:forth',
            kind: 'repl',
            language: 'forth',
            marker: 'LTERMINAL_ENV_LANG_FORTH',
            markerOutputDetected: true,
            expectedResultBeforeMarker: '3',
            expectedResultDetected,
            startupHintVisible,
            startupHintCapture: 'shell-lang-forth-startup-help',
            terminalFocusMethod: 'native-click',
            startupClean: true,
            passed: true,
        }),
    });
    assert.equal((await run('forth-arithmetic-passed', withForthProbe(true))).status, 0,
        'el informe debe aceptar Forth solo cuando verifica la operación aritmética real');
    assert.notEqual((await run('forth-arithmetic-missing', withForthProbe(false))).status, 0,
        'el marcador de Forth sin resultado calculado no demuestra que el REPL funcione');
    assert.notEqual((await run('forth-startup-help-missing', withForthProbe(true, false))).status, 0,
        'Forth no debe pasar si la ayuda de arranque no queda visible antes de escribir');
    assert.equal((await run('focused-shell-matrix', focusedShellMatrix)).status, 0,
        'un informe enfocado debe validar la cobertura/restauración de su matriz sin exigir las fases ajenas');
    const windowsShellMatrixResult = await run('focused-windows-shell-matrix-no-wsl-installed', focusedWindowsShellMatrix);
    assert.equal(windowsShellMatrixResult.status, 0,
        `un informe Windows debe declarar explícitamente cuándo el host no tiene distros WSL: ${windowsShellMatrixResult.stderr}`);
    assert.equal((await run('focused-dependency-full-audit', focusedDependencyAudit)).status, 0,
        'un informe enfocado debe validar el recorrido completo y estable de Dependencias');
    assert.equal((await run('focused-pane-matrix', focusedPaneMatrix)).status, 0,
        'un informe enfocado debe validar las transiciones de matriz y las capturas sin fragmentos');
    assert.notEqual((await run('focused-dependency-audit-missing-capture', {
        ...focusedDependencyAudit,
        captures: focusedDependencyAudit.captures.slice(0, 2),
    })).status, 0, 'la auditoría de Dependencias no debe pasar sin las capturas de ambas pasadas');
    assert.notEqual((await run('focused-windows-shell-matrix-without-wsl-evidence', {
        ...focusedWindowsShellMatrix,
        events: focusedWindowsShellMatrix.events.filter((event) => event.type !== 'wsl-distro-selector-coverage'),
    })).status, 0, 'un informe Windows no debe pasar sin explicar la cobertura WSL');
    assert.equal((await run('focused-ltools', focusedLTools)).status, 0,
        'un informe enfocado debe validar el catálogo y la ejecución opcional de LTools');
    assert.equal((await run('focused-progress', focusedProgress)).status, 0,
        'un informe enfocado debe validar las barras de actualización y la recuperación del ancho');
    assert.equal((await run('focused-settings', focusedSettings)).status, 0,
        'un informe enfocado debe validar el pie fijo y el scroll compacto de Ajustes');
    assert.equal((await run('focused-windows-admin-permissions', focusedAdminPermissions)).status, 0,
        'el E2E Windows debe verificar los permisos de administrador');
    assert.equal((await run('focused-windows-admin-permissions-elevated', {
        ...focusedAdminPermissions,
        events: focusedAdminPermissions.events.map((event) => event.type === 'windows-admin-permissions'
            ? { ...event, elevated: true, launcher: 'direct', restartVisible: false, installGsudoVisible: false, adminBadge: true, restartUnelevatedVisible: true }
            : event),
    })).status, 0, 'con token administrativo NSudo se abre directo, no se ofrece reiniciar como administrador y sí sin permisos');
    for (const [name, change, reason] of [
        ['runasadmin', { runAsAdminFlag: true }, 'la marca RUNASADMIN en el ejecutable'],
        ['start-default-on', { startAsAdminDefault: true }, 'el arranque elevado activado de fábrica'],
        ['launcher-mismatch', { launcher: 'direct' }, 'un lanzador directo sin token administrativo'],
        ['restart-hidden', { restartVisible: false }, 'ocultar «Reiniciar como administrador» sin serlo'],
        ['badge-without-admin', { adminBadge: true }, 'el distintivo de administrador sin serlo'],
        ['modes-not-exclusive', { modesExclusive: false }, 'las dos formas de elevar activas a la vez'],
        ['mark-kept', { markRemoved: false }, 'que volver a «Sin permisos» deje la marca RUNASADMIN'],
        ['restart-unelevated-without-admin', { restartUnelevatedVisible: true }, 'ofrecer reiniciar sin permisos sin ser administrador'],
    ]) {
        assert.notEqual((await run(`focused-windows-admin-permissions-${name}`, {
            ...focusedAdminPermissions,
            events: focusedAdminPermissions.events.map((event) => event.type === 'windows-admin-permissions'
                ? { ...event, ...change }
                : event),
        })).status, 0, `el informe de administrador no debe aceptar ${reason}`);
    }
    assert.notEqual((await run('focused-windows-admin-permissions-without-gsudo-route', {
        ...focusedAdminPermissions,
        events: focusedAdminPermissions.events.filter((event) => event.type !== 'windows-admin-gsudo-route'),
    })).status, 0, 'sin administrador ni gsudo real el informe debe exigir la ruta de gsudo simulada');
    assert.equal((await run('focused-internal-commands-driver-skip', focusedInternalCommandsSkipped)).status, 0,
        'el informe debe aceptar el diagnóstico explícito de limitación de teclado del driver');
    assert.equal((await run('focused-terminal-only', focusedTerminalOnly)).status, 0,
        'el E2E enfocado debe verificar el modo de terminal limpia, el layout y su recuperación');
    assert.equal((await run('focused-explorer', focusedExplorer)).status, 0,
        'un informe enfocado debe validar el doble clic real del Explorador');
    assert.equal((await run('focused-mouse-selection', focusedMouseSelection)).status, 0,
        'un informe enfocado debe validar la selección de texto con el ratón');
    assert.equal((await run('focused-adb', focusedAdb)).status, 0,
        'un informe enfocado debe validar la salida progresiva ADB sin cambiar el layout');
    assert.notEqual((await run('focused-ltools-without-event', {
        ...focusedLTools,
        events: focusedLTools.events.filter((event) => event.type !== 'ltools-integration'),
    })).status, 0, 'la E2E de LTools no debe pasar sin su evidencia de integración');
    assert.notEqual((await run('focused-shell-matrix-without-restore', {
        ...focusedShellMatrix,
        events: focusedShellMatrix.events.filter((event) => event.type !== 'environment-switch-restore'),
    })).status, 0, 'un smoke enfocado no debe pasar si no restaura la shell inicial');
    assert.equal((await run('valid-direct-dependency-card', {
        ...valid,
        events: valid.events.map((event) => event.type === 'dependencies'
            ? { ...event, subgroups: 0, entries: 1 }
            : event),
    })).status, 0, 'una tarjeta directa de dependencia también debe pasar');
    assert.notEqual((await run('missing-phase', {
        ...valid,
        phases: valid.phases.slice(1),
    })).status, 0, 'una fase ausente debe fallar');
    assert.notEqual((await run('orphaned-e2e-window', {
        ...valid,
        events: valid.events.map((event) => event.type === 'e2e-process-cleanup'
            ? { ...event, processGroupClosed: false, passed: false, closed: false }
            : event),
    })).status, 0, 'un E2E no debe pasar si deja viva una ventana/proceso de prueba');
    assert.notEqual((await run('missing-mouse-selection', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'terminal-mouse-selection'),
    })).status, 0, 'la batería completa debe rechazar una sesión sin arrastre real del ratón');
    assert.notEqual((await run('missing-explorer-double-click', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'explorer-double-click'),
    })).status, 0, 'la batería completa debe rechazar una sesión sin doble clic real del Explorador');
    assert.notEqual((await run('missing-terminal-output-repaint', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'terminal-output-repaint'),
    })).status, 0, 'el informe completo debe rechazar un smoke sin regresión del repintado PTY');
    assert.notEqual((await run('missing-progress-layout', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'progress-output-layout'),
    })).status, 0, 'el informe completo debe rechazar un smoke sin escenarios de barras de actualización');
    assert.notEqual((await run('terminal-output-repaint-layout-changed', {
        ...valid,
        events: valid.events.map((event) => event.type === 'terminal-output-repaint'
            ? { ...event, layoutUnchanged: false }
            : event),
    })).status, 0, 'el test de repintado debe fallar si necesita alterar el layout');
    assert.notEqual((await run('missing-terminal-columns-reclaim', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'terminal-columns-reclaim'),
    })).status, 0, 'el E2E completo debe exigir recuperación del ancho PTY sin vaciar el historial');
    assert.notEqual((await run('terminal-columns-stuck-wide', {
        ...valid,
        events: valid.events.map((event) => event.type === 'terminal-columns-reclaim'
            ? { ...event, afterCols: 100, hostScrollWidth: 850 }
            : event),
    })).status, 0, 'un PTY sobredimensionado tras desplazar la ayuda debe fallar');
    assert.notEqual((await run('terminal-columns-lost-old-output', {
        ...valid,
        events: valid.events.map((event) => event.type === 'terminal-columns-reclaim'
            ? { ...event, oldestOutputVisibleAfterWheelUp: false }
            : event),
    })).status, 0, 'el E2E debe fallar si la rueda no recupera la salida antigua del scrollback');
    assert.notEqual((await run('terminal-columns-wheel-not-handled', {
        ...valid,
        events: valid.events.map((event) => event.type === 'terminal-columns-reclaim'
            ? { ...event, scrollDown: { dispatched: 0, prevented: 0 } }
            : event),
    })).status, 0, 'el E2E debe fallar si no se observan eventos de rueda vertical gestionados por xterm');
    assert.notEqual((await run('missing-shell-matrix', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'environment-shell-matrix'),
    })).status, 0, 'la batería completa debe exigir varios PTY y restauración de shell');
    assert.notEqual((await run('shell-initialization-error', {
        ...valid,
        events: valid.events.map((event) => event.type === 'environment-probe' && event.id === 'zsh'
            ? { ...event, startupClean: false }
            : event),
    })).status, 0, 'un error de inicialización de una shell alternativa debe invalidar el E2E');
    assert.notEqual((await run('echo-without-command-output', {
        ...valid,
        events: valid.events.map((event) => event.type === 'environment-probe' && event.id === 'zsh'
            ? { ...event, markerOutputDetected: false }
            : event),
    })).status, 0, 'el eco del comando sin salida evaluada no cuenta como sonda PTY');
    assert.notEqual((await run('unverified-terminal-focus', {
        ...valid,
        events: valid.events.map((event) => event.type === 'environment-probe' && event.id === 'zsh'
            ? { ...event, terminalFocusMethod: 'unverified' }
            : event),
    })).status, 0, 'la matriz debe comprobar que el foco del teclado realmente llegó a xterm');
    assert.notEqual((await run('unaccounted-installed-environment', {
        ...valid,
        events: valid.events
            .filter((event) => !(event.type === 'environment-probe' && event.id === 'zsh'))
            .map((event) => event.type === 'environment-shell-matrix'
                ? { ...event, testedIds: ['fish', 'bash', 'lang:python'], testedAlternates: ['bash', 'lang:python'], probeCount: 3, shellProbeCount: 2, replProbeCount: 1 }
                : event),
    })).status, 0, 'todo entorno habilitado debe probarse o tener una omisión segura explicada');
    assert.notEqual((await run('skip-without-reason', {
        ...valid,
        events: valid.events.map((event) => event.type === 'environment-shell-matrix'
            ? { ...event, skipped: [{ id: 'lang:postgresql', kind: 'skip', reason: '' }] }
            : event),
    })).status, 0, 'un entorno omitido requiere una razón visible en el informe');
    assert.notEqual((await run('shell-selected-state-inferred', {
        ...valid,
        events: valid.events.map((event) => event.type === 'environment-shell-matrix'
            ? { ...event, originalSource: 'toolbar-label' }
            : event),
    })).status, 0, 'la shell original debe identificarse por su estado seleccionado real, no solo por la etiqueta');
    assert.notEqual((await run('missing-ltools-ui-contract', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'ltools-ui-source'),
    })).status, 0, 'falta la evidencia de que LTools sustituye al menú heredado');
    assert.notEqual((await run('missing-ltools-disabled-contract', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'ltools-disabled-by-default'),
    })).status, 0, 'falta la evidencia de que LTools esté desactivada y oculta por defecto');
    assert.notEqual((await run('missing-context-menu', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'context-menu'),
    })).status, 0, 'falta la evidencia del menú contextual');
    assert.notEqual((await run('missing-dependencies', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'dependencies'),
    })).status, 0, 'falta la evidencia de grupos y submenús de dependencias');
    assert.notEqual((await run('missing-minimum-split', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'multi-pane-minimum'),
    })).status, 0, 'falta la evidencia de división útil en el tamaño mínimo');
    assert.notEqual((await run('missing-split-columns-minimum', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'split-terminal-columns-minimal'),
    })).status, 0, 'falta la evidencia de ancho mínimo en ambos paneles divididos');
    assert.notEqual((await run('split-columns-overflow', {
        ...valid,
        events: valid.events.map((event) => event.type === 'split-terminal-columns-minimal'
            ? { ...event, panes: event.panes.map((pane, index) => index === 0
                ? { ...pane, cols: 80, hostScrollWidth: 900, longestVisibleRow: 10 }
                : pane) }
            : event),
    })).status, 0, 'un panel con overflow no justificado por contenido largo debe invalidar el informe');
    assert.notEqual((await run('missing-responsive-minimum', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'responsive-minimum'),
    })).status, 0, 'falta la evidencia del mínimo responsive calculado');
    assert.notEqual((await run('missing-toolbar-geometry', {
        ...valid,
        events: valid.events.filter(event => event.type !== 'toolbar-geometry'),
    })).status, 0, 'falta la medición de los controles de la barra');
    for (const issue of ['overlaps', 'clipped']) {
        assert.notEqual((await run(`toolbar-${issue}`, {
            ...valid,
            events: valid.events.map(event => event.type === 'toolbar-geometry'
                ? { ...event, [issue]: ['env-select'] } : event),
        })).status, 0, `la barra con ${issue} no puede pasar`);
    }
    assert.notEqual((await run('missing-native-window-resize', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'native-window-resize'),
    })).status, 0, 'falta la evidencia de redimensionado nativo');
    assert.notEqual((await run('missing-native-window-captures', {
        ...valid,
        captures: [],
    })).status, 0, 'faltan las capturas del redimensionado nativo');
    assert.equal((await run('hyprland-resize-fallback', {
        ...valid,
        events: valid.events.map((event) => event.type === 'native-window-resize'
            ? { ...event, nativeResizeMethod: 'hyprland-resizeactive-fallback' }
            : event),
    })).status, 0, 'el fallback de compositor se admite solo tras comprobar el rect real');
    assert.notEqual((await run('windows-hyprland-fallback', {
        ...valid,
        host: { ...valid.host, platform: 'windows' },
        events: valid.events.map((event) => event.type === 'native-window-resize'
            ? { ...event, platform: 'windows', nativeResizeMethod: 'hyprland-resizeactive-fallback' }
            : event),
    })).status, 0, 'un informe Windows no puede declarar el fallback exclusivo de Hyprland');
    assert.notEqual((await run('resize-method-missing', {
        ...valid,
        events: valid.events.map((event) => event.type === 'native-window-resize'
            ? { ...event, nativeResizeMethod: undefined }
            : event),
    })).status, 0, 'el informe debe identificar qué mecanismo nativo aplicó el resize');
    assert.notEqual((await run('missing-tab-isolation', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'tab-isolation'),
    })).status, 0, 'falta la evidencia de aislamiento entre pestañas');
    assert.notEqual((await run('missing-rapid-tab-replace', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'rapid-tab-replace'),
    })).status, 0, 'falta reproducir la carrera de crear y cerrar pestañas');
    assert.notEqual((await run('missing-explorer-cwd-layout', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'explorer-cwd-layout'),
    })).status, 0, 'falta la evidencia de cwd y geometría del explorador');
    assert.notEqual((await run('missing-shell-startup', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'shell-startup-performance'),
    })).status, 0, 'falta la evidencia de tiempo de arranque de la shell');
    assert.notEqual((await run('slow-shell-startup', {
        ...valid,
        events: valid.events.map((event) => event.type === 'shell-startup-performance'
            ? { ...event, maxMs: event.limitMs }
            : event),
    })).status, 0, 'el timeout completo de ConPTY no puede pasar');
    assert.notEqual((await run('missing-responsive-matrix', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'responsive-matrix'),
    })).status, 0, 'falta la evidencia del redimensionado responsive');
    assert.notEqual((await run('failed', { ...valid, status: 'failed' })).status, 0, 'un E2E fallido no puede validarse');
    assert.notEqual((await run('video-required-without-artifact', {
        ...valid,
        options: { videoRequired: true },
    })).status, 0, 'un E2E que solicita vídeo no puede pasar sin un MP4 válido');
    assert.notEqual((await run('mixed-banner', {
        ...valid,
        events: valid.events.map((event) => event.type === 'banner-ready'
            ? { ...event, preview: ['WTerminal 1.0.0\nPlaca ASUS 1 GB (60%)'] }
            : event),
    })).status, 0, 'un banner mezclado debe fallar');
    assert.notEqual((await run('missing-prompt', {
        ...valid,
        events: valid.events.map((event) => event.type === 'banner-ready'
            ? { ...event, promptsVisible: false }
            : event),
    })).status, 0, 'un banner sin prompt visible debe fallar');
} finally {
    await rm(directory, { recursive: true, force: true });
}

console.log('Validador E2E probado: informe completo y rechazos de regresiones correctos.');
