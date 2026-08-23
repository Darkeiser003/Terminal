import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const mode = (process.env.LTERMINAL_WINGET_CHECK ?? 'strict').toLowerCase();
const timeout = Math.max(5000, Number(process.env.LTERMINAL_WINGET_TIMEOUT_MS ?? 30000));
// WinGet no es un cliente seguro para lanzar en paralelo: varias consultas
// contra la fuente local pueden compartir locks/cache y devolver falsos
// fallos. Se deja 1 por defecto; quien tenga una fuente estable puede elevarlo
// explícitamente sin cambiar el resultado del chequeo.
const concurrency = Math.max(1, Number(process.env.LTERMINAL_WINGET_CONCURRENCY ?? 1));

if (mode === 'off') {
    console.warn('WinGet: comprobación del catálogo desactivada.');
    process.exit(0);
}

if (process.platform !== 'win32') {
    console.log('WinGet: comprobación reservada al build nativo de Windows; se omite en este host.');
    process.exit(0);
}

try {
    await execFileAsync('winget', ['--version'], { timeout });
} catch {
    console.warn('WinGet: no está disponible; no se pueden validar sus identificadores desde este equipo.');
    process.exit(0);
}

const source = await readFile('src-tauri/src/packages/actions.rs', 'utf8');
const ids = [...source.matchAll(/\bwin\(\s*"[^"]+"\s*,\s*"[^"]+"\s*,\s*"[^"]*"\s*,\s*"([^"]+)"/gs)]
    .map((match) => match[1]);
const uniqueIds = [...new Set(ids)].sort();
console.log(`WinGet: validando ${uniqueIds.length} identificadores del catálogo Windows...`);

function failureReason(error, command = 'winget show') {
    const output = [error?.stderr, error?.stdout]
        .filter(Boolean)
        .join('\n')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^Puedes encontrar más ayuda en:/i.test(line))
        .at(-1);
    if (error?.killed) return `timeout de ${timeout} ms`;
    const detail = output ? `${command} falló (${output.slice(0, 180)})` : `${command} falló`;
    return error?.code !== undefined ? `${detail}; código ${error.code}` : detail;
}

async function checkId(id) {
    try {
        const { stdout } = await execFileAsync('winget', [
            'show', '--id', id, '--exact', '--source', 'winget',
            '--accept-source-agreements', '--disable-interactivity',
        ], { timeout, maxBuffer: 1024 * 1024 });
        const ok = /\bId\s*:/i.test(stdout) || stdout.includes(id);
        return ok ? { id, ok: true } : { id, ok: false, error: 'respuesta sin identificador de paquete' };
    } catch (error) {
        return { id, ok: false, error: failureReason(error) };
    }
}

async function checkIds(idsToCheck) {
    let next = 0;
    const checked = [];
    const workers = Array.from({ length: Math.min(concurrency, idsToCheck.length) }, async () => {
        while (next < idsToCheck.length) {
            const index = next++;
            checked[index] = await checkId(idsToCheck[index]);
        }
    });
    await Promise.all(workers);
    return checked;
}

let results = await checkIds(uniqueIds);
let failures = results.filter((result) => !result.ok);
let sourceRefreshFailed = false;

// Una fuente WinGet obsoleta produce falsos "no encontrado" aunque el
// identificador siga existiendo. Solo se actualiza y reintenta cuando hay
// fallos; así el caso normal no añade tiempo a cada build.
if (failures.length && process.env.LTERMINAL_WINGET_SOURCE_UPDATE !== '0') {
    console.warn(`WinGet: ${failures.length} consultas fallaron; actualizando la fuente winget y reintentando una vez...`);
    try {
        await execFileAsync('winget', [
            'source', 'update', '--name', 'winget',
            '--accept-source-agreements', '--disable-interactivity',
        ], { timeout, maxBuffer: 1024 * 1024 });
        const retried = await checkIds(failures.map((result) => result.id));
        const retriedById = new Map(retried.map((result) => [result.id, result]));
        results = results.map((result) => retriedById.get(result.id) ?? result);
        failures = results.filter((result) => !result.ok);
    } catch (error) {
        sourceRefreshFailed = true;
        console.warn(`WinGet: no se pudo actualizar la fuente (${failureReason(error, 'winget source update')}); se conservan los diagnósticos originales.`);
    }
}

for (const result of results) {
    if (result.ok) console.log(`  ✔ ${result.id}`);
    else console.error(`  ✘ ${result.id}: ${result.error}`);
}
console.log(`WinGet: ${results.length - failures.length} válidos, ${failures.length} inválidos.`);
if (failures.length && mode === 'strict') {
    console.error(sourceRefreshFailed
        ? 'WinGet: la fuente no pudo actualizarse; no se puede confirmar si los IDs están retirados o si la caché está incompleta. Ejecuta `winget source reset --force` y después `winget source update` para reparar la fuente. Se detiene el build.'
        : 'WinGet: hay identificadores que no existen en la fuente actual; se detiene el build.');
    process.exit(1);
}
