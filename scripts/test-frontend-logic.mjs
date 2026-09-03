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
const aliases = await readFile('src-tauri/src/terminal/aliases.rs', 'utf8');
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
const configuredShortcuts = [...defaults.matchAll(/^shortcut\w+\s*=\s*"([^"]*)"/gm)].map((match) => match[1]);
assert.equal(configuredShortcuts.length, shortcuts.SHORTCUT_PREFERENCE_KEYS.length);
const normalizedDefaults = configuredShortcuts.map(shortcuts.normalizeShortcut);
assert(normalizedDefaults.every((value, index) => value || configuredShortcuts[index] === ''), 'Todos los atajos de fábrica deben ser válidos o estar vacíos');
const assignedDefaults = normalizedDefaults.filter(Boolean);
assert.equal(new Set(assignedDefaults).size, assignedDefaults.length, 'Los atajos de fábrica no se pueden repetir');

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
assert.equal(shortcuts.shortcutFromEvent(event({ code: 'KeyH', key: 'h', ctrlKey: true, altKey: true, shiftKey: false })), 'ctrl+alt+h');
assert.equal(shortcuts.shortcutFromEvent(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true, altKey: false, shiftKey: false })), 'ctrl+arrowleft');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Ctrl+T'), '');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Shift+TeclaInventada'), '');

console.log(`Lógica frontend verificada: idioma, identidad y ${configuredShortcuts.length} atajos.`);
