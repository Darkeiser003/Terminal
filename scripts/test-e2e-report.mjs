import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    ],
    events: [
        ...phases.map((name) => ({ type: 'phase', name })),
        { type: 'terminal-mouse-selection', passed: true, gesture: 'pointerDown → pointerMove while pressed → pointerUp' },
        { type: 'terminal-output-repaint', passed: true, trigger: 'pty-output-idle', refreshCount: 1, rowsRefreshed: 24, layoutUnchanged: true, marker: 'LTERMINAL_OUTPUT_REPAINT_FIXTURE', capture: 'pty-output-repaint-no-layout-event' },
        { type: 'horizontal-help-geometry', passed: true, snapshot: { host: { clientWidth: 400, scrollWidth: 850 }, indicator: { opacity: '1' } }, horizontalWheelProbe: { lineMode: { defaultPrevented: true }, pixelMode: { defaultPrevented: true }, pageMode: { defaultPrevented: true } } },
        { type: 'terminal-columns-reclaim', passed: true, beforeCols: 100, visibleCols: 50, afterCols: 50, hostWidth: 400, hostScrollWidth: 400, historyRetained: true, historyHeight: 800, historyViewportHeight: 400, commands: 24 },
        { type: 'environment-probe', id: 'bash', kind: 'shell', markerOutputDetected: true, terminalFocusMethod: 'native-click', startupClean: true, passed: true },
        { type: 'environment-probe', id: 'zsh', kind: 'shell', markerOutputDetected: true, terminalFocusMethod: 'native-click', startupClean: true, passed: true },
        { type: 'environment-probe', id: 'fish', kind: 'shell', markerOutputDetected: true, terminalFocusMethod: 'native-click', startupClean: true, passed: true },
        { type: 'environment-probe', id: 'lang:python', kind: 'repl', language: 'python', markerOutputDetected: true, terminalFocusMethod: 'verified-pointer-fallback', startupClean: true, passed: true },
        { type: 'environment-probe-skipped', id: 'lang:postgresql', kind: 'skip', reason: 'necesita un servicio externo y credenciales' },
        { type: 'environment-shell-matrix', originalId: 'fish', originalSource: 'aria-selected/class', availableIds: ['fish', 'bash', 'zsh', 'lang:python', 'lang:postgresql'], testedIds: ['fish', 'bash', 'zsh', 'lang:python'], testedAlternates: ['bash', 'zsh', 'lang:python'], skipped: [{ id: 'lang:postgresql', kind: 'skip', reason: 'necesita un servicio externo y credenciales' }], probeCount: 4, shellProbeCount: 3, replProbeCount: 1, restoredTo: 'fish', originalCaptureLabel: 'shell-matrix-linux-original-selected', captureLabel: 'shell-matrix-linux-restored', passed: true },
        { type: 'environment-switch-restore', to: 'fish', restoredFish: true, passed: true },
        { type: 'preference', name: 'showQuickActions', value: false },
        { type: 'preference', name: 'showQuickActions', value: true },
        { type: 'context-menu', actions: ['cut', 'delete'] },
        { type: 'dependencies', groups: 8, subgroups: 6, repeatedLoads: 3, platformGroup: 'Virtualización' },
        { type: 'multi-pane-minimum', passed: true, geometryValid: true, paneCount: 2, panes: [{}, {}] },
        { type: 'split-terminal-columns-minimal', passed: true, panes: [
            { cols: 48, visibleCols: 48, hostWidth: 400, hostScrollWidth: 400 },
            { cols: 47, visibleCols: 47, hostWidth: 392, hostScrollWidth: 392 },
        ] },
        { type: 'responsive-minimum', passed: true, configured: { width: 481, height: 271 }, requested: { width: 512, height: 281 }, applied: { width: 513, height: 282 } },
        { type: 'native-window-resize', platform: 'linux', nativeResizeMethod: 'webdriver', passed: true, nativeChanged: true, viewportChanged: true, ptyChanged: true },
        { type: 'native-window-resize', platform: 'linux', nativeResizeMethod: 'webdriver', passed: true, nativeChanged: true, viewportChanged: true, ptyChanged: true },
        { type: 'tab-isolation', passed: true, tabs: 3 },
        { type: 'rapid-tab-replace', passed: true, isolated: true, closedTabId: 'tab-1', createdTabId: 'tab-2' },
        { type: 'explorer-cwd-layout', passed: true, cwdFollowed: true, layout: { pathHeight: 18, gap: 0, ordered: true } },
        { type: 'keyboard-shortcuts', passed: true, newTab: true, nextTab: true, cyclePanes: true, explorerToggle: true },
        { type: 'shell-startup-performance', passed: true, samples: 4, maxMs: 740, limitMs: 2500 },
        { type: 'responsive-matrix', panes: 2, cases: 20, explorerStates: [false, true] },
        { type: 'banner-ready', promptsVisible: true, preview: ['WinSlim Terminal 1.0.0\nSistema  Windows\nPlaca  ASUS\nGPU  Intel\nC:\\>'] },
    ],
};
const directory = await mkdtemp(join(tmpdir(), 'lterminal-e2e-report-test-'));
const verifier = resolve('scripts/verify-e2e-report.mjs');

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
        || (event.type === 'phase' && ['arranque de interfaz', 'cambio de shell'].includes(event.name))),
};

try {
    assert.equal((await run('valid', valid)).status, 0, 'un informe completo debe pasar');
    assert.equal((await run('focused-shell-matrix', focusedShellMatrix)).status, 0,
        'un informe enfocado debe validar la cobertura/restauración de su matriz sin exigir las fases ajenas');
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
    assert.notEqual((await run('missing-mouse-selection', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'terminal-mouse-selection'),
    })).status, 0, 'la batería completa debe rechazar una sesión sin arrastre real del ratón');
    assert.notEqual((await run('missing-terminal-output-repaint', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'terminal-output-repaint'),
    })).status, 0, 'el informe completo debe rechazar un smoke sin regresión del repintado PTY');
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
    assert.notEqual((await run('missing-state', {
        ...valid,
        events: valid.events.filter((event) => event.value !== false),
    })).status, 0, 'falta el estado oculto de Acciones rápidas');
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
            ? { ...event, panes: event.panes.map((pane, index) => index === 0 ? { ...pane, cols: 80, hostScrollWidth: 900 } : pane) }
            : event),
    })).status, 0, 'un panel con columnas y scrollWidth sobrantes debe invalidar el informe');
    assert.notEqual((await run('missing-responsive-minimum', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'responsive-minimum'),
    })).status, 0, 'falta la evidencia del mínimo responsive calculado');
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
    assert.notEqual((await run('mixed-banner', {
        ...valid,
        events: valid.events.map((event) => event.type === 'banner-ready'
            ? { ...event, preview: ['WinSlim Terminal 1.0.0\nPlaca ASUS 1 GB (60%)'] }
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
