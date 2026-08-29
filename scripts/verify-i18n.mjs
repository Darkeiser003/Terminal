import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const components = path.join(root, 'src', 'components');
const localesDir = path.join(root, 'src-tauri', 'locales');
const localeFiles = fs.readdirSync(localesDir).filter((file) => file.endsWith('.json')).sort();
const catalogs = Object.fromEntries(localeFiles.map((file) => [file, JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'))]));
const spanish = catalogs['es.json'];
const errors = [];

if (!spanish) errors.push('Falta src-tauri/locales/es.json');

const usedKeys = new Set();
for (const file of fs.readdirSync(components).filter((name) => name.endsWith('.svelte'))) {
    const source = fs.readFileSync(path.join(components, file), 'utf8');
    for (const match of source.matchAll(/(?:app\.t|translated)\(\s*['"]([^'"]+)['"]/g)) usedKeys.add(match[1]);
}

const backendKeys = new Set();
function walkRust(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walkRust(fullPath);
        else if (entry.name.endsWith('.rs')) {
            const source = fs.readFileSync(fullPath, 'utf8');
            for (const match of source.matchAll(/\.(?:t|tp)\(\s*"([^"]+)"/g)) backendKeys.add(match[1]);
        }
    }
}
walkRust(path.join(root, 'src-tauri', 'src'));

// Estas acciones de Windows se construyen manualmente y se traducen por su ID
// en `InstallAction::translated`; el escaneo de llamadas `.t()` no puede ver
// esas claves dinámicas. Mantenerlas explícitas evita que una nueva acción
// vuelva a mostrar español en inglés sin que el chequeo lo detecte.
const dynamicActionIds = [
    'windows-hyperv-enable',
    'windows-vmp-enable',
    'windows-sandbox-enable',
    'windows-hyperv-check',
];
for (const id of dynamicActionIds) {
    for (const field of ['label', 'shortLabel']) {
        const key = `action.${id}.${field}`;
        if (!(key in spanish)) errors.push(`La acción dinámica usa «${key}», pero no existe en el catálogo español`);
    }
}

for (const id of ['system', 'host', 'kernel', 'environment', 'motherboard', 'cpu', 'gpu', 'memory', 'storage', 'uptime', 'datetime']) {
    const labelKey = id === 'host' ? 'banner.pc' : `banner.${id}`;
    if (!(labelKey in spanish)) errors.push(`La etiqueta dinámica usa «${labelKey}», pero no existe en el catálogo español`);
    const key = `settings.banner.${id}.description`;
    if (!(key in spanish)) errors.push(`La descripción dinámica usa «${key}», pero no existe en el catálogo español`);
}

for (const key of usedKeys) {
    if (!(key in spanish)) errors.push(`La interfaz usa «${key}», pero no existe en el catálogo español`);
}
for (const key of backendKeys) {
    // Esta clave solo aparece en las pruebas que comprueban el comportamiento
    // deliberado de una traducción desconocida.
    if (key !== 'clave.que.no.existe' && !(key in spanish)) {
        errors.push(`El backend usa «${key}», pero no existe en el catálogo español`);
    }
}

const expectedKeys = Object.keys(spanish).sort();
for (const [file, catalog] of Object.entries(catalogs)) {
    const actualKeys = Object.keys(catalog).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        const missing = expectedKeys.filter((key) => !(key in catalog));
        const extra = actualKeys.filter((key) => !(key in spanish));
        if (missing.length) errors.push(`${file}: faltan claves: ${missing.join(', ')}`);
        if (extra.length) errors.push(`${file}: sobran claves: ${extra.join(', ')}`);
    }
}

// Los mensajes nuevos del terminal se interpolan en un único helper. Aquí sí
// hay un contrato exacto: cambiar u omitir un marcador dejaría `{...}` visible
// o perdería el dato en alguno de los 15 idiomas.
const placeholderContracts = {
    'terminal.bannerHidden': ['items'],
    'terminal.bannerStatus': ['state'],
    'terminal.hiddenCount': ['count'],
    'terminal.bannerUpdated': ['state'],
    'terminal.quickActionsStatus': ['state'],
    'terminal.replMissing': ['name'],
    'terminal.helpFallback': ['topic'],
};
for (const [file, catalog] of Object.entries(catalogs)) {
    for (const [key, expected] of Object.entries(placeholderContracts)) {
        const actual = [...String(catalog[key] ?? '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).sort();
        if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
            errors.push(`${file}: «${key}» no conserva sus marcadores (${actual.join(', ')} != ${expected.join(', ')})`);
        }
    }
}

// Estas claves aparecieron en todos los catálogos copiadas literalmente desde
// español. La paridad de claves no detecta ese fallo: se protege expresamente
// el bloque dinámico del banner y el error de arranque, visibles antes de que
// el usuario pueda corregir nada.
const criticalLocalizedKeys = [
    'startup.errorTitle',
    'settings.bannerSections',
    'settings.bannerSectionsHint',
    'settings.bannerFull',
    'settings.bannerCompact',
    'terminal.quickActionsStatus',
    'terminal.replMissing',
    'terminal.helpFallback',
    'terminal.internalCommands',
];
for (const [file, catalog] of Object.entries(catalogs)) {
    if (file === 'es.json') continue;
    for (const key of criticalLocalizedKeys) {
        if (catalog[key] === spanish[key]) errors.push(`${file}: «${key}» sigue copiada del catálogo español`);
    }
}
for (const catalog of Object.values(catalogs)) {
    for (const id of ['system', 'host', 'kernel', 'environment', 'motherboard', 'cpu', 'gpu', 'memory', 'storage', 'uptime', 'datetime']) {
        if (`settings.banner.${id}` in catalog) errors.push(`La etiqueta duplicada settings.banner.${id} debe reutilizar banner.*`);
    }
}

// Los atributos visibles no pueden saltarse el catálogo. Los ejemplos de
// datos, rutas, comandos y nombres propios se excluyen porque no son UI.
const hardcodedUi = [
    ['src/components/Panel.svelte', /title="[A-Za-zÁÉÍÓÚáéíóúÑñ]/],
    ['src/components/Toolbar.svelte', /title="[A-Za-zÁÉÍÓÚáéíóúÑñ]/],
    ['src/components/ScriptsPanel.svelte', /title="[A-Za-zÁÉÍÓÚáéíóúÑñ]/],
    // Los placeholders que contienen comandos (p. ej. `serve=npm run dev`)
    // son ejemplos ejecutables, no texto de interfaz.
    ['src/components/SettingsPanel.svelte', /aria-label="[A-Za-zÁÉÍÓÚáéíóúÑñ]/],
];
for (const [relative, pattern] of hardcodedUi) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (pattern.test(source)) errors.push(`${relative}: contiene texto visible hardcodeado fuera de app.t()`);
}

for (const file of fs.readdirSync(components).filter((name) => name.endsWith('.svelte'))) {
    const relative = `src/components/${file}`;
    const source = fs.readFileSync(path.join(components, file), 'utf8');
    if (/toLocaleLowerCase\(\s*['"]es['"]\s*\)|localeCompare\([^\n]*['"]es['"]/.test(source)) {
        errors.push(`${relative}: fuerza reglas de ordenación/búsqueda españolas en vez del idioma activo`);
    }
}

const terminalPane = fs.readFileSync(path.join(components, 'TerminalPane.svelte'), 'utf8');
for (const line of terminalPane.split('\n').filter((item) => /term\?\.writeln\(/.test(item))) {
    if (!line.includes('app.t(') && !line.includes('translated(')) {
        errors.push(`src/components/TerminalPane.svelte: salida interna sin traducir: ${line.trim()}`);
    }
}
if (/\.toLocaleLowerCase\(/.test(terminalPane.replace(/\/\/[^\n]*/g, ''))) {
    errors.push('src/components/TerminalPane.svelte: los verbos ASCII internos no pueden depender del locale del sistema');
}

// Los errores fijos de los paneles cruzan IPC y llegan directamente a la
// interfaz; si se dejan como `ActionResult::failed("...")`, el idioma del
// backend puede quedarse en español aunque el usuario haya elegido otro.
for (const relative of ['src-tauri/src/app/panel_commands.rs', 'src-tauri/src/projects/commands.rs']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8').split('#[cfg(test)]')[0];
    if (/ActionResult::failed\(\s*"/.test(source)) {
        errors.push(`${relative}: contiene un error fijo de panel sin Translator`);
    }
}

if (errors.length) {
    console.error(['Comprobación de traducciones fallida:', ...errors.map((error) => `- ${error}`)].join('\n'));
    process.exit(1);
}
console.log(`i18n correcto: ${localeFiles.length} idiomas, ${expectedKeys.length} claves, ${usedKeys.size} usos frontend y ${backendKeys.size} usos backend`);
