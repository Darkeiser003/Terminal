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
    for (const match of source.matchAll(/app\.t\(\s*['"]([^'"]+)['"]/g)) usedKeys.add(match[1]);
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
