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
    events: [
        ...phases.map((name) => ({ type: 'phase', name })),
        { type: 'preference', name: 'showQuickActions', value: false },
        { type: 'preference', name: 'showQuickActions', value: true },
        { type: 'context-menu', actions: ['cut', 'delete'] },
        { type: 'dependencies', groups: 8, subgroups: 6, repeatedLoads: 3, platformGroup: 'Virtualización' },
        { type: 'multi-pane-minimum', passed: true, geometryValid: true, paneCount: 2, panes: [{}, {}] },
        { type: 'responsive-minimum', passed: true, configured: { width: 481, height: 271 }, requested: { width: 512, height: 281 }, applied: { width: 513, height: 282 } },
        { type: 'tab-isolation', passed: true, tabs: 3 },
        { type: 'responsive-matrix', panes: 2, cases: 20, explorerStates: [false, true] },
        { type: 'banner-ready', preview: ['WinSlim Terminal 1.4.4\nSistema  Windows\nPlaca  ASUS\nGPU  Intel\nC:\\>'] },
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
    assert.notEqual((await run('missing-tab-isolation', {
        ...valid,
        events: valid.events.filter((event) => event.type !== 'tab-isolation'),
    })).status, 0, 'falta la evidencia de aislamiento entre pestañas');
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
} finally {
    await rm(directory, { recursive: true, force: true });
}

console.log('Validador E2E probado: informe completo y diez rechazos correctos.');
