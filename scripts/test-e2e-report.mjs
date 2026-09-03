import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const phases = [
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
const valid = {
    status: 'passed',
    logValidated: true,
    durationMs: 1200,
    phases: phases.map((name) => ({ name, durationMs: 10 })),
    captures: [
        { label: 'window-resize-win32-reduccion-de-ventana', path: 'resize-1.png' },
        { label: 'window-resize-win32-restauracion-de-ventana', path: 'resize-2.png' },
        { label: 'atajo-nueva-pestana', path: 'shortcut-new-tab.png' },
        { label: 'atajo-pestana-siguiente', path: 'shortcut-next-tab.png' },
        { label: 'atajo-division-dos-paneles', path: 'shortcut-split-2.png' },
        { label: 'atajo-division-tres-paneles', path: 'shortcut-split-3.png' },
    ],
    events: [
        ...phases.map((name) => ({ type: 'phase', name })),
        { type: 'preference', name: 'showQuickActions', value: false },
        { type: 'preference', name: 'showQuickActions', value: true },
        { type: 'context-menu', actions: ['cut', 'delete'] },
        { type: 'dependencies', groups: 8, subgroups: 6, repeatedLoads: 3, platformGroup: 'Virtualización' },
        { type: 'multi-pane-minimum', passed: true, geometryValid: true, paneCount: 2, panes: [{}, {}] },
        { type: 'responsive-minimum', passed: true, configured: { width: 481, height: 271 }, requested: { width: 512, height: 281 }, applied: { width: 513, height: 282 } },
        { type: 'native-window-resize', platform: 'win32', passed: true, nativeChanged: true, viewportChanged: true, ptyChanged: true },
        { type: 'native-window-resize', platform: 'win32', passed: true, nativeChanged: true, viewportChanged: true, ptyChanged: true },
        { type: 'tab-isolation', passed: true, tabs: 3 },
        { type: 'rapid-tab-replace', passed: true, isolated: true, closedTabId: 'tab-1', createdTabId: 'tab-2' },
        { type: 'explorer-cwd-layout', passed: true, cwdFollowed: true, layout: { pathHeight: 18, gap: 0, ordered: true } },
        { type: 'keyboard-shortcuts', passed: true, newTab: true, nextTab: true, cyclePanes: true, explorerToggle: true },
        { type: 'shell-startup-performance', passed: true, samples: 4, maxMs: 740, limitMs: 2500 },
        { type: 'responsive-matrix', panes: 2, cases: 20, explorerStates: [false, true] },
        { type: 'banner-ready', promptsVisible: true, preview: ['WinSlim Terminal 1.4.4\nSistema  Windows\nPlaca  ASUS\nGPU  Intel\nC:\\>'] },
    ],
};
const directory = await mkdtemp(join(tmpdir(), 'lterminal-e2e-report-test-'));
const verifier = resolve('scripts/verify-e2e-report.mjs');

async function run(name, report) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, `${JSON.stringify(report)}\n`);
    return spawnSync(process.execPath, [verifier, path], { encoding: 'utf8' });
}

try {
    assert.equal((await run('valid', valid)).status, 0, 'un informe completo debe pasar');
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
            ? { ...event, preview: ['WinSlim Terminal 1.4.4\nPlaca ASUS 1 GB (60%)'] }
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
