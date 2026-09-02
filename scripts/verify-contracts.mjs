import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const camel = (value) => value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
const between = (source, start, end) => {
    const from = source.indexOf(start);
    assert(from >= 0, `No se encontró ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert(to > from, `No se encontró el cierre de ${start}`);
    return source.slice(from, to);
};
const sameSet = (actual, expected, label) => {
    const left = [...new Set(actual)].sort();
    const right = [...new Set(expected)].sort();
    assert.deepEqual(left, right, `${label}\nactual=${left.join(', ')}\nesperado=${right.join(', ')}`);
};

// Preferencias: Rust, defaults, sanitizador y TypeScript deben evolucionar a
// la vez. Dejar un campo fuera de cualquiera de las cuatro capas produce una
// opción que se ve pero no se guarda, o una build que solo falla al arrancar.
const preferencesRs = read('src-tauri/src/config/preferences.rs');
const preferencesStruct = between(preferencesRs, 'pub struct Preferences {', '\n}');
const rustPreferences = [...preferencesStruct.matchAll(/pub\s+([a-z][a-z0-9_]*):/g)].map((match) => camel(match[1]));
const defaults = [...read('src-tauri/default_settings.toml').matchAll(/^([A-Za-z][A-Za-z0-9]*)\s*=/gm)].map((match) => match[1]);
const sanitizer = between(preferencesRs, 'fn sanitize_preferences_with_defaults', '\n}\n\n/// Las preferencias guardadas');
const sanitized = [...sanitizer.matchAll(/get\("([A-Za-z][A-Za-z0-9]*)"\)/g)].map((match) => match[1]);
const types = read('src/lib/types.ts');
const preferencesTs = between(types, 'export interface Preferences {', '\n}');
const tsPreferences = [...preferencesTs.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
sameSet(defaults, rustPreferences, 'default_settings.toml no coincide con Preferences de Rust');
sameSet(sanitized, rustPreferences, 'El sanitizador no cubre todas las preferencias');
sameSet(tsPreferences, rustPreferences, 'Preferences de TypeScript no coincide con Rust');

// Acciones de dependencias: una propiedad nueva debe cruzar la serialización
// Rust/serde y el tipo del frontend. De otro modo el panel puede compilar y
// perder silenciosamente textos o estado solo en una de las dos builds.
const installActionsRs = read('src-tauri/src/packages/actions.rs');
const installActionStruct = between(installActionsRs, 'pub struct InstallAction {', '\n}');
const rustInstallAction = [...installActionStruct.matchAll(/^\s+pub\s+([a-z][a-z0-9_]*):/gm)]
    .map((match) => camel(match[1]));
const installActionTs = between(types, 'export interface InstallAction {', '\n}');
const tsInstallAction = [...installActionTs.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)]
    .map((match) => match[1]);
sameSet(tsInstallAction, rustInstallAction, 'InstallAction de TypeScript no coincide con Rust');

// Comandos internos: todo lo que reconoce el backend debe tener tipo y ruta de
// ejecución en el frontend. La ayuda se comprueba aparte para que un comando
// funcional no quede oculto al usuario.
const internalRs = read('src-tauri/src/terminal/internal_commands.rs');
const parseBody = between(internalRs, 'pub fn parse(', '\n}\n\n#[cfg(test)]');
const parsedActions = [...parseBody.matchAll(/=>\s*"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]);
const commandTs = between(types, 'export interface InternalCommand {', '\n}');
const actionUnion = commandTs.match(/action:\s*([^;]+);/)?.[1] ?? '';
const typedActions = [...actionUnion.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const terminal = read('src/components/TerminalPane.svelte');
const handledActions = [...terminal.matchAll(/command\.action\s*===\s*'([^']+)'/g)].map((match) => match[1]);
sameSet(typedActions, parsedActions, 'El tipo InternalCommand no coincide con el parser Rust');
for (const action of parsedActions) assert(handledActions.includes(action), `TerminalPane no maneja el comando interno ${action}`);
const aliases = read('src-tauri/src/terminal/aliases.rs');
for (const command of [':config', ':settings', ':reload', ':shell', ':repl', ':alias', ':help', ':banner', ':quick-actions', ':panel', ':explorer-here', ':theme', ':font', ':language', ':terminal', ':panes']) {
    assert(aliases.includes(command), `La ayuda no documenta ${command}`);
}

// Recursos integrados: se deriva la lista real del árbol y se compara con el
// manifiesto. Así Windows y Linux no pierden una variante al añadir un script.
function filesUnder(directory) {
    const files = [];
    for (const entry of readdirSync(resolve(root, directory))) {
        const absolute = resolve(root, directory, entry);
        if (statSync(absolute).isDirectory()) files.push(...filesUnder(join(directory, entry)));
        else files.push(relative(root, absolute).replaceAll('\\', '/'));
    }
    return files;
}
const nativeScripts = filesUnder('scripts')
    .filter((path) => ['.sh', '.ps1'].includes(extname(path)))
    .filter((path) => path.includes('/containers/') || path.includes('/operations/'))
    .sort();
const baseConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const bundledSources = Object.keys(baseConfig.bundle?.resources ?? {})
    .map((path) => path.replace(/^\.\.\//, ''))
    .filter((path) => path.startsWith('scripts/'))
    .sort();
sameSet(bundledSources, nativeScripts, 'El manifiesto no incluye exactamente todos los scripts nativos');
const variants = new Map();
for (const path of nativeScripts) {
    const name = path.split('/').at(-1).replace(/\.(sh|ps1)$/, '');
    const set = variants.get(name) ?? new Set();
    set.add(extname(path));
    variants.set(name, set);
}
for (const [name, extensions] of variants) {
    assert.deepEqual([...extensions].sort(), ['.ps1', '.sh'], `${name} no tiene variantes Windows y Linux`);
}
const windowsConfig = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
for (const runtime of ['vendor/conpty/conpty.dll', 'vendor/conpty/OpenConsole.exe']) {
    assert(runtime in (windowsConfig.bundle?.resources ?? {}), `Windows no incluye ${runtime}`);
}

console.log(`Contratos verificados: ${rustPreferences.length} preferencias, ${rustInstallAction.length} campos de dependencias, ${parsedActions.length} comandos y ${nativeScripts.length} scripts nativos.`);
