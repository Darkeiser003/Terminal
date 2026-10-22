import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// docs-ia/ son notas de los asistentes (traspasos, auditorías): están en
// .gitignore y no se publican, así que no se validan como documentación.
const ignored = new Set(['node_modules', 'dist', 'release', 'target', '.git', 'artifacts', 'docs-ia']);
// Carpetas que existen en local pero no en un clon de GitHub: un Markdown
// publicado no puede enlazarlas.
const unpublished = ['docs-ia/', 'artifacts/', 'release/', 'dist/'];

// linux/build.sh aparta temporalmente la instalación Windows en un directorio
// `.node_modules.windows.<pid>`. No forma parte del árbol fuente y contiene
// README de terceros con enlaces relativos que no son responsabilidad del
// proyecto; ignorarlo evita falsos positivos durante la build cruzada.
function isIgnored(name) {
    return ignored.has(name) || /^\.node_modules\.windows(?:\.|$)/.test(name);
}
const markdown = [];
const textExtensions = new Set(['.md', '.mjs', '.rs', '.ts', '.svelte', '.sh', '.ps1', '.json']);

function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (isIgnored(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && path.extname(entry.name) === '.md') markdown.push(full);
    }
}

/** Anclas de los encabezados con el mismo criterio que GitHub: minúsculas,
 *  fuera la puntuación (se conservan letras con tilde, números, `_` y `-`),
 *  espacios a guiones y `-1`, `-2`… para los repetidos. */
function headingAnchors(contents) {
    const anchors = new Set();
    const seen = new Map();
    let inCode = false;
    for (const line of contents.split('\n')) {
        if (line.startsWith('```')) inCode = !inCode;
        const heading = !inCode && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u);
        if (!heading) continue;
        const text = heading[1]
            .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
            .replace(/<[^>]+>/gu, '');
        const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ /gu, '-');
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.add(count ? `${base}-${count}` : base);
    }
    return anchors;
}

walk(root);
const errors = [];
const sample = headingAnchors('## Instalación para usar la aplicación\n### 1. Flujo global: de la ventana al prompt\n#### `src/` y [mapa](#x)\n## Repetido\n## Repetido\n```\n## dentro de código\n```\n');
if (!['instalación-para-usar-la-aplicación', '1-flujo-global-de-la-ventana-al-prompt', 'src-y-mapa', 'repetido', 'repetido-1']
    .every((anchor) => sample.has(anchor)) || sample.has('dentro-de-código')) {
    errors.push('scripts/verify-docs.mjs: el cálculo de anclas ya no sigue el criterio de GitHub');
}
const anchorCache = new Map();
const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, headingAnchors(fs.readFileSync(file, 'utf8')));
    return anchorCache.get(file);
};
for (const source of markdown) {
    const contents = fs.readFileSync(source, 'utf8');
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const [rawTarget, rawAnchor] = match[1].split('#', 2);
        const target = decodeURIComponent(rawTarget);
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        const resolved = target ? path.resolve(path.dirname(source), target) : source;
        const relativeTarget = path.relative(root, resolved).replaceAll('\\', '/');
        if (target && unpublished.some((prefix) => relativeTarget.startsWith(prefix))) {
            errors.push(`${path.relative(root, source)}: enlaza «${match[1]}», que no se publica en GitHub`);
            continue;
        }
        if (target && !fs.existsSync(resolved)) {
            errors.push(`${path.relative(root, source)}: enlace local inexistente «${match[1]}»`);
            continue;
        }
        if (rawAnchor !== undefined && resolved.endsWith('.md') && !anchorsOf(resolved).has(decodeURIComponent(rawAnchor))) {
            errors.push(`${path.relative(root, source)}: ancla inexistente «${match[1]}»`);
        }
    }
}

// El texto de ayuda de la aplicación también contiene rutas mantenibles. Evita
// que una limpieza del repositorio deje al usuario apuntando a docs borradas.
for (const directory of ['src', 'src-tauri', 'scripts', 'tests', 'linux', 'windows']) {
    const base = path.join(root, directory);
    if (!fs.existsSync(base)) continue;
    const pending = [base];
    while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (isIgnored(entry.name)) continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(full);
            else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
                const contents = fs.readFileSync(full, 'utf8');
                for (const match of contents.matchAll(/(?:docs|examples)\/[A-Za-z0-9._/-]+/g)) {
                    if (!fs.existsSync(path.resolve(root, match[0]))) {
                        errors.push(`${path.relative(root, full)}: referencia local inexistente «${match[0]}»`);
                    }
                }
            }
        }
    }
}

if (errors.length) {
    console.error(['Comprobación de documentación fallida:', ...errors.map((error) => `- ${error}`)].join('\n'));
    process.exit(1);
}
console.log(`Documentación verificada: ${markdown.length} Markdown y referencias locales válidas.`);
