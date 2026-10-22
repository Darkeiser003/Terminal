// Ejecuta un escenario de `tests/e2e/smoke.mjs` contra un binario concreto
// y devuelve un resultado normalizado. Lo comparten `scripts/run-e2e-suite.mjs`
// y `scripts/test-installer.mjs`: cada ejecución deja su salida, su informe
// JSON y su log de la aplicación en la carpeta indicada, con un tiempo límite
// que mata el árbol de procesos si el escenario se queda colgado.
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

async function killTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        await execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ya terminó */ } }
    }
}

/** Última línea útil de la salida: el «E2E ... OK» final o el error. */
export function scenarioSummaryLine(text) {
    const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const error = lines.find((line) => /^Error: /u.test(line));
    if (error) return error.slice(0, 400);
    const ok = [...lines].reverse().find((line) => /^E2E\b.*\bOK\b/u.test(line) && !/^E2E log OK/u.test(line));
    return (ok ?? lines.at(-1) ?? '').slice(0, 400);
}

/**
 * @param {object} options
 * @param {string} options.projectRoot raíz del repositorio (donde está tests/e2e/smoke.mjs)
 * @param {string} options.binary wterminal.exe que se prueba
 * @param {string} options.id identificador del escenario (nombre de sus archivos)
 * @param {Record<string,string>} options.env variables E2E_* que seleccionan el escenario
 * @param {number} options.timeoutMs tiempo máximo antes de matar el escenario
 * @param {string} options.outDir carpeta de resultados
 */
export async function runSmokeScenario({ projectRoot, binary, id, env = {}, timeoutMs, outDir }) {
    await mkdir(outDir, { recursive: true });
    const logPath = join(outDir, `${id}.log`);
    const reportPath = join(outDir, `${id}-report.json`);
    const mainLogPath = join(outDir, `${id}-main.log`);
    // Capturas y vídeo junto al resto del escenario (sin esto acababan en una
    // carpeta temporal con nombre aleatorio y había que buscarlas).
    const captureDir = env.E2E_CAPTURE_DIR ?? join(outDir, `${id}-captures`);
    const startedAt = Date.now();
    const log = createWriteStream(logPath);
    const child = spawn(process.execPath, ['tests/e2e/smoke.mjs'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            ...env,
            E2E_CAPTURE_DIR: captureDir,
            E2E_BINARY: resolve(projectRoot, binary),
            LTERMINAL_SMOKE_REPORT: reportPath,
            LTERMINAL_LOG_FILE: mainLogPath,
            LTERMINAL_LOG_LEVEL: process.env.LTERMINAL_LOG_LEVEL ?? 'debug',
        },
        windowsHide: true,
        detached: process.platform !== 'win32',
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        void killTree(child.pid);
    }, timeoutMs);
    const exitCode = await new Promise((resolveExit) => {
        child.once('error', () => resolveExit(-1));
        child.once('exit', (code) => resolveExit(code ?? -1));
    });
    clearTimeout(timer);
    await new Promise((resolveEnd) => log.end(resolveEnd));
    const durationMs = Date.now() - startedAt;

    let report = null;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { report = null; }
    const output = await readFile(logPath, 'utf8').catch(() => '');
    // Las trazas de diagnóstico que el smoke deja en artifacts/ se guardan
    // junto al escenario que las produjo.
    const artifacts = join(projectRoot, 'artifacts');
    for (const name of await readdir(artifacts).catch(() => [])) {
        if (/^e2e-first-echo-trace-tab-\d+\.json$/u.test(name)) {
            await rename(join(artifacts, name), join(outDir, `${id}-${name}`)).catch(() => undefined);
        }
    }
    const passed = !timedOut && exitCode === 0 && report?.status === 'passed';
    return {
        id,
        status: timedOut ? 'timeout' : (passed ? 'passed' : 'failed'),
        exitCode,
        durationMs,
        summary: timedOut ? `Superó el límite de ${Math.round(timeoutMs / 60000)} min` : scenarioSummaryLine(output),
        reportPath,
        logPath,
        mainLogPath,
        captureDir,
        video: report?.video?.path ?? null,
    };
}
