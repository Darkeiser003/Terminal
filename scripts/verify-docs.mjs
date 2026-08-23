import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['node_modules', 'dist', 'release', 'target', '.git']);
const markdown = [];
const textExtensions = new Set(['.md', '.mjs', '.rs', '.ts', '.svelte', '.sh', '.ps1', '.json']);

function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && path.extname(entry.name) === '.md') markdown.push(full);
    }
}

walk(root);
const errors = [];
for (const source of markdown) {
    const contents = fs.readFileSync(source, 'utf8');
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = decodeURIComponent(match[1].split('#', 1)[0]);
        if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        if (!fs.existsSync(path.resolve(path.dirname(source), target))) {
            errors.push(`${path.relative(root, source)}: enlace local inexistente «${match[1]}»`);
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
            if (ignored.has(entry.name)) continue;
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
