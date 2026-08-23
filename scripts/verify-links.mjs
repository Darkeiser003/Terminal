import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const root = process.cwd();
const mode = (process.env.LTERMINAL_LINK_CHECK ?? 'strict').toLowerCase();
const timeoutMs = Math.max(1000, Number(process.env.LTERMINAL_LINK_CHECK_TIMEOUT_MS ?? 8000));
const retries = Math.max(1, Number(process.env.LTERMINAL_LINK_CHECK_RETRIES ?? 2));
// `git ls-remote` necesita abrir una conexión y negociar el protocolo Git;
// no debe compartir el timeout corto de una petición HTTP HEAD/GET.
const gitTimeoutMs = Math.max(timeoutMs, Number(process.env.LTERMINAL_GIT_LINK_CHECK_TIMEOUT_MS ?? 15000));
const gitRetries = Math.max(1, Number(process.env.LTERMINAL_GIT_LINK_CHECK_RETRIES ?? 1));
const sourceRoots = ['README.md', 'package.json', 'src-tauri', 'scripts', 'linux', 'windows'];
const ignoredDirectories = new Set(['target', 'node_modules', 'dist', '.git', 'vendor', 'gen']);
// El verificador de registros tiene sus propios reintentos y modo warn; si se
// escanea como documentación volveríamos a consultar las mismas diez URLs y
// duplicaríamos el coste de cada build.
const ignoredFiles = new Set(['Cargo.lock', 'verify-install-sources.mjs']);
const execFileAsync = promisify(execFile);
const urlPattern = /https?:\/\/[^\s<>"'`\\]+/g;
const trailingPunctuation = /[),.;:!?\]}]+$/;

async function filesUnder(path) {
    const absolute = join(root, path);
    const metadata = await stat(absolute).catch(() => null);
    if (!metadata) return [];
    if (metadata.isFile()) return [absolute];
    const entries = await readdir(absolute, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        if (entry.isFile() && ignoredFiles.has(entry.name)) continue;
        const child = join(absolute, entry.name);
        if (entry.isDirectory()) files.push(...await filesUnder(relative(root, child)));
        else files.push(child);
    }
    return files;
}

function isDynamic(url) {
    return url.includes('$') || url.includes('{') || url.includes('}') || url.includes('\\');
}

function shouldSkip(url) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        return hostname === 'localhost'
            || hostname.endsWith('.localhost')
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname.includes('*')
            || hostname.endsWith('.example')
            || url.includes('@')
            || parsed.port !== ''
            // Valores deliberadamente falsos usados por los tests de
            // validación de GitHub, no enlaces de producción.
            || (hostname === 'github.com' && (/^\/(x|owner)(\/|$)/.test(parsed.pathname)))
            || (hostname === 'objects.githubusercontent.com' && parsed.pathname.startsWith('/x'));
    } catch {
        return true;
    }
}

function networkErrorText(error) {
    if (error?.name === 'AbortError') return `timeout de ${timeoutMs} ms`;
    const code = error?.cause?.code;
    return code ? `${error.message} (${code})` : error.message;
}

async function request(url, method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method,
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': 'LTerminal-link-check/1.0',
                ...(method === 'GET' ? { range: 'bytes=0-0' } : {}),
            },
        });
        await response.body?.cancel();
        return { status: response.status, finalUrl: response.url };
    } finally {
        clearTimeout(timer);
    }
}

async function checkUrl(url) {
    if (url.endsWith('.git')) {
        let lastError = 'git ls-remote falló';
        for (let attempt = 1; attempt <= gitRetries; attempt += 1) {
            try {
                await execFileAsync('git', ['ls-remote', '--exit-code', url, 'HEAD'], { timeout: gitTimeoutMs });
                return { ok: true, status: 200, method: 'git ls-remote', finalUrl: url, attempt };
            } catch (error) {
                lastError = error?.killed ? `timeout de ${gitTimeoutMs} ms` : 'git ls-remote falló';
                if (attempt < gitRetries) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            }
        }
        // Un timeout del transporte Git puede ser una ruta/proxy/firewall
        // lento aunque el enlace HTTPS equivalente esté vivo. Se informa como
        // aviso para no bloquear una release por una sonda externa; un error
        // de Git distinto de timeout sigue siendo fallo estricto.
        return { ok: false, warning: lastError.startsWith('timeout'), status: 0, error: lastError };
    }
    let lastError = 'sin respuesta';
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        for (const method of ['HEAD', 'GET']) {
            try {
                const response = await request(url, method);
                if (response.status >= 200 && response.status < 400) {
                    return { ok: true, status: response.status, method, finalUrl: response.finalUrl, attempt };
                }
                if (response.status === 401 || response.status === 403) {
                    return { ok: false, warning: true, status: response.status, method, finalUrl: response.finalUrl, attempt, error: 'requiere autorización' };
                }
                lastError = `HTTP ${response.status}`;
            } catch (error) {
                lastError = networkErrorText(error);
            }
        }
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    return { ok: false, status: 0, error: lastError };
}

const files = (await Promise.all(sourceRoots.map(filesUnder))).flat();
const locations = new Map([
    ['https://github.com', ['manifesto de enlaces críticos']],
    ['https://api.github.com', ['manifesto de enlaces críticos']],
]);
for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '');
    for (const match of content.matchAll(urlPattern)) {
        const url = match[0].replace(trailingPunctuation, '');
        if (isDynamic(url) || shouldSkip(url)) continue;
        const list = locations.get(url) ?? [];
        list.push(relative(root, file));
        locations.set(url, list);
    }
}

const urls = [...locations.keys()].sort();
if (mode === 'off') {
    console.warn(`Enlaces: comprobación desactivada; ${urls.length} URLs encontradas.`);
    process.exit(0);
}

console.log(`Enlaces: comprobando ${urls.length} URLs (${mode}, HTTP ${timeoutMs} ms/${retries} intentos, Git ${gitTimeoutMs} ms/${gitRetries} intentos)...`);
const results = [];
let next = 0;
const workers = Array.from({ length: Math.min(6, urls.length) }, async () => {
    while (next < urls.length) {
        const index = next;
        next += 1;
        results[index] = await checkUrl(urls[index]);
    }
});
await Promise.all(workers);

const failures = [];
const warnings = [];
for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const result = results[index];
    const where = [...new Set(locations.get(url))].join(', ');
    if (result.ok) console.log(`  ✔ ${result.status} ${url} [${where}]`);
    else if (result.warning) {
        warnings.push({ url, where, result });
        console.warn(`  ⚠ ${result.status} ${url} — ${result.error} [${where}]`);
    } else {
        failures.push({ url, where, result });
        console.error(`  ✘ ${result.error} ${url} [${where}]`);
    }
}

console.log(`Enlaces: ${urls.length - failures.length - warnings.length} OK, ${warnings.length} avisos, ${failures.length} fallos.`);
if (failures.length > 0 && mode === 'strict') {
    console.error('Enlaces: el build se detiene porque hay URLs inaccesibles.');
    console.error('Enlaces: usa LTERMINAL_LINK_CHECK=warn para diagnosticar sin bloquear un build offline.');
    process.exit(1);
}
if (failures.length > 0) console.warn('Enlaces: hay URLs inaccesibles, pero el build continúa por modo warn.');
