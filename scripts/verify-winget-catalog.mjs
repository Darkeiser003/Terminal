import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const mode = (process.env.LTERMINAL_WINGET_CHECK ?? 'strict').toLowerCase();
const timeout = Math.max(5000, Number(process.env.LTERMINAL_WINGET_TIMEOUT_MS ?? 30000));

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

let next = 0;
const results = [];
const workers = Array.from({ length: Math.min(6, uniqueIds.length) }, async () => {
    while (next < uniqueIds.length) {
        const index = next++;
        const id = uniqueIds[index];
        try {
            const { stdout } = await execFileAsync('winget', [
                'show', '--id', id, '--exact', '--source', 'winget',
                '--accept-source-agreements', '--disable-interactivity',
            ], { timeout, maxBuffer: 1024 * 1024 });
            results[index] = { id, ok: /\bId\s*:/i.test(stdout) || stdout.includes(id) };
        } catch (error) {
            results[index] = { id, ok: false, error: error?.killed ? `timeout de ${timeout} ms` : 'winget show falló' };
        }
    }
});
await Promise.all(workers);

const failures = results.filter((result) => !result.ok);
for (const result of results) {
    if (result.ok) console.log(`  ✔ ${result.id}`);
    else console.error(`  ✘ ${result.id}: ${result.error}`);
}
console.log(`WinGet: ${results.length - failures.length} válidos, ${failures.length} inválidos.`);
if (failures.length && mode === 'strict') {
    console.error('WinGet: hay identificadores que no existen o no se pueden consultar; se detiene el build.');
    process.exit(1);
}
