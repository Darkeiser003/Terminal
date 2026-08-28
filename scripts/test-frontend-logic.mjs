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

assert.equal(localization.foldLocalized('İSTANBUL', 'tr'), 'istanbul');
assert(localization.includesLocalized('Überblick 12', 'ÜBER', 'de'));
assert(localization.compareLocalized('archivo 2', 'archivo 10', 'es') < 0);
assert.doesNotThrow(() => localization.compareLocalized('a', 'b', 'idioma_invalido'));

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
const refreshBannerStart = terminalPane.indexOf('function refreshBannerNow()');
const fitAndReportStart = terminalPane.indexOf('function fitAndReport()');
assert(refreshBannerStart >= 0 && fitAndReportStart > refreshBannerStart, 'No se pudo delimitar refreshBannerNow');
assert(!terminalPane.slice(refreshBannerStart, fitAndReportStart).includes('paneCountChanged'),
    'refreshBannerNow no debe leer paneCountChanged fuera del alcance de fitAndReport');
const paneResizeBlock = terminalPane.slice(fitAndReportStart);
assert(paneResizeBlock.includes('if (paneCountChanged) pendingPaneCountRefresh = true;'),
    'Un cambio de rejilla debe forzar el primer repintado sin cursor');
assert(paneResizeBlock.includes('pendingPaneCountRefresh = true;\n                            pendingBannerRefresh = true;'),
    'El repintado de rejilla debe reintentarse después del lote inicial');
const configuredShortcuts = [...defaults.matchAll(/^shortcut\w+\s*=\s*"([^"]+)"/gm)].map((match) => match[1]);
assert.equal(configuredShortcuts.length, shortcuts.SHORTCUT_PREFERENCE_KEYS.length);
const normalizedDefaults = configuredShortcuts.map(shortcuts.normalizeShortcut);
assert(normalizedDefaults.every(Boolean), 'Todos los atajos de fábrica deben ser válidos');
assert.equal(new Set(normalizedDefaults).size, normalizedDefaults.length, 'Los atajos de fábrica no se pueden repetir');

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
assert.equal(shortcuts.normalizeShortcut('Ctrl+Ctrl+T'), '');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Shift+TeclaInventada'), '');

console.log(`Lógica frontend verificada: idioma, identidad y ${configuredShortcuts.length} atajos.`);
