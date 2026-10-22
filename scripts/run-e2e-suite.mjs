// Ejecuta las suites E2E estandarizadas de tests/e2e/suites.mjs contra un
// binario y deja un resumen comparable. Uso:
//   node scripts/run-e2e-suite.mjs --binary src-tauri/target/dist/WTerminal-X/wterminal.exe
//        [--suite focused,video | --level full|release]
//        [--installer release/WTerminal-X-x64-setup.exe] [--out carpeta]
//        [--only escenario1,escenario2] [--fail-fast] [--list]
//
// No se detiene en el primer fallo (salvo --fail-fast): cada escenario deja
// su salida, informe JSON y log de la aplicación, y al final se escriben
// summary.json y summary.md. Antes avisa si el equipo está cargado (los E2E
// dependen de tiempos) y al terminar comprueba que el PATH del usuario quedó
// exactamente igual. El código de salida es 1 si algo falló.
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { planSuites, SUITES, VALIDATION_LEVELS } from '../tests/e2e/suites.mjs';
import { runSmokeScenario } from '../tests/e2e/run-scenario.mjs';
import { restoreWindowsPathIntegration, sameWindowsPathSnapshot, snapshotWindowsPathIntegration } from '../tests/e2e/windows-path-guard.mjs';
import { dropPowerShell7ModulePath } from '../tests/e2e/powershell-env.mjs';

// Lanzado desde PowerShell 7, el PSModulePath heredado rompe los powershell.exe 5.1
// que lanzan estas pruebas (ver tests/e2e/powershell-env.mjs).
dropPowerShell7ModulePath();
import { runInstallerTest } from './test-installer.mjs';

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseSuiteArgs(argv) {
    const options = { suites: [], failFast: false, list: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) throw new Error(`Falta el valor de ${arg}`);
            index += 1;
            return next;
        };
        if (arg === '--binary') options.binary = value();
        else if (arg === '--suite') options.suites.push(...value().split(',').map((name) => name.trim()).filter(Boolean));
        else if (arg === '--level') {
            const level = value();
            if (!VALIDATION_LEVELS[level]) throw new Error(`Nivel desconocido: ${level}. Disponibles: ${Object.keys(VALIDATION_LEVELS).join(', ')}`);
            options.suites.push(...VALIDATION_LEVELS[level]);
        } else if (arg === '--installer') options.installer = value();
        else if (arg === '--release-dir') options.releaseDir = value();
        else if (arg === '--out') options.out = value();
        else if (arg === '--only') (options.only ??= []).push(...value().split(',').map((id) => id.trim()).filter(Boolean));
        else if (arg === '--fail-fast') options.failFast = true;
        else if (arg === '--list') options.list = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Opción desconocida: ${arg}`);
    }
    options.suites = [...new Set(options.suites.length ? options.suites : ['focused'])];
    for (const name of options.suites) {
        if (!SUITES[name]) throw new Error(`Suite desconocida: ${name}. Disponibles: ${Object.keys(SUITES).join(', ')}`);
    }
    // --only limita las suites pedidas a unos escenarios concretos (por su id
    // del catálogo): sirve para repetir solo lo que se ha tocado.
    if (options.only) {
        const known = new Set(planSuites(options.suites).map((item) => item.scenario));
        const unknown = options.only.filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`Escenarios desconocidos en --only: ${unknown.join(', ')}`);
    }
    return options;
}

function formatDuration(ms) {
    const seconds = Math.round(ms / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
}

const STATUS_LABEL = { passed: 'OK', failed: 'FALLO', timeout: 'TIEMPO', skipped: 'OMITIDO' };

/** Resumen en Markdown (lo publica el build junto a sus artefactos). */
export function formatSummaryMarkdown(summary) {
    const lines = [
        `# Validación E2E de WTerminal`,
        '',
        `- Binario: \`${summary.binary}\``,
        `- Suites: ${summary.suites.join(', ')}`,
        `- Inicio: ${summary.startedAt}`,
        `- Duración: ${formatDuration(summary.durationMs)}`,
        `- Resultado: **${summary.status === 'passed' ? 'TODO OK' : 'CON FALLOS'}** (${summary.counts.passed} OK, ${summary.counts.failed} con fallo, ${summary.counts.skipped} omitidos)`,
    ];
    if (summary.warnings.length) {
        lines.push('', '## Avisos', '', ...summary.warnings.map((warning) => `- ${warning}`));
    }
    lines.push('', '| Suite | Escenario | Resultado | Duración | Detalle |', '|---|---|---|---|---|');
    for (const result of summary.results) {
        const detail = String(result.summary ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
        lines.push(`| ${result.suite} | ${result.title} | ${STATUS_LABEL[result.status] ?? result.status} | ${formatDuration(result.durationMs ?? 0)} | ${detail} |`);
    }
    return `${lines.join('\n')}\n`;
}

async function cpuLoadPercent() {
    if (process.platform !== 'win32') return null;
    try {
        const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            '$s = 1..3 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; Start-Sleep -Milliseconds 700 }; [math]::Round(($s | Measure-Object -Average).Average)'], { windowsHide: true });
        const value = Number(stdout.trim());
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

function freeDiskGb(path) {
    try {
        const info = statfsSync(path);
        return Math.round((info.bavail * info.bsize) / 1024 ** 3);
    } catch {
        return null;
    }
}

export async function runSuites(options) {
    const startedAt = new Date();
    const binary = resolve(projectRoot, options.binary ?? process.env.E2E_BINARY ?? '');
    if (!existsSync(binary)) throw new Error(`No existe el binario a probar: ${binary}`);
    const out = resolve(projectRoot, options.out ?? join('artifacts', 'e2e-suite', startedAt.toISOString().replace(/[:.]/gu, '-')));
    await mkdir(out, { recursive: true });
    const warnings = [];

    const load = await cpuLoadPercent();
    if (load !== null && load > 50) {
        warnings.push(`El procesador estaba al ${load}% al empezar: los E2E dependen de tiempos y pueden fallar con el equipo cargado.`);
    }
    const disk = freeDiskGb(out);
    if (disk !== null && disk < 5) warnings.push(`Solo quedan ${disk} GB libres: el vídeo y las capturas pueden no caber.`);
    for (const warning of warnings) process.stdout.write(`AVISO: ${warning}\n`);

    const pathBefore = await snapshotWindowsPathIntegration();
    const results = [];
    const plan = planSuites(options.suites.filter((name) => name !== 'installer'))
        .filter((item) => !options.only || options.only.includes(item.scenario));
    const total = plan.length + (options.suites.includes('installer') ? 1 : 0);
    let position = 0;
    let stop = false;
    for (const item of plan) {
        position += 1;
        process.stdout.write(`[${position}/${total}] ${item.suite} · ${item.title}\n`);
        const result = await runSmokeScenario({
            projectRoot,
            binary,
            id: item.id,
            env: item.env,
            timeoutMs: item.timeoutMs,
            outDir: join(out, item.suite),
        });
        results.push({ ...item, ...result, env: undefined });
        process.stdout.write(`    ${STATUS_LABEL[result.status]} (${formatDuration(result.durationMs)}) ${result.summary}\n`);
        if (result.status !== 'passed' && options.failFast) {
            stop = true;
            break;
        }
    }
    if (options.suites.includes('installer') && !stop) {
        position += 1;
        process.stdout.write(`[${position}/${total}] installer · ${SUITES.installer.title}\n`);
        if (!options.installer) {
            results.push({ suite: 'installer', id: 'installer', title: SUITES.installer.title, status: 'failed', durationMs: 0, summary: 'Falta --installer con la ruta del instalador NSIS.' });
        } else {
            const installer = await runInstallerTest({
                installer: options.installer,
                releaseDir: options.releaseDir ?? dirname(binary),
                out: join(out, 'installer'),
                video: options.suites.includes('video'),
            });
            results.push({ suite: 'installer', id: 'installer', title: SUITES.installer.title, ...installer });
            process.stdout.write(`    ${STATUS_LABEL[installer.status]} (${formatDuration(installer.durationMs)}) ${installer.summary}\n`);
        }
    }

    const pathAfter = await snapshotWindowsPathIntegration();
    if (!sameWindowsPathSnapshot(pathBefore, pathAfter)) {
        await restoreWindowsPathIntegration(pathBefore).catch(() => undefined);
        results.push({ suite: 'aislamiento', id: 'user-path', title: 'PATH del usuario intacto', status: 'failed', durationMs: 0, summary: 'Las suites alteraron el PATH del usuario; se ha restaurado.' });
    }

    const counts = {
        passed: results.filter((result) => result.status === 'passed').length,
        failed: results.filter((result) => result.status === 'failed' || result.status === 'timeout').length,
        skipped: results.filter((result) => result.status === 'skipped').length,
    };
    const summary = {
        binary: relative(projectRoot, binary) || binary,
        suites: options.suites,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        status: counts.failed === 0 && !stop ? 'passed' : 'failed',
        counts,
        warnings,
        results: results.map((result) => ({
            ...result,
            reportPath: result.reportPath ? relative(projectRoot, result.reportPath) : undefined,
            logPath: result.logPath ? relative(projectRoot, result.logPath) : undefined,
            mainLogPath: result.mainLogPath ? relative(projectRoot, result.mainLogPath) : undefined,
        })),
    };
    await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(out, 'summary.md'), formatSummaryMarkdown(summary));
    return { summary, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const options = parseSuiteArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write([
            'Uso: node scripts/run-e2e-suite.mjs [--binary <wterminal.exe>] [--suite a,b] [--level full|release] [--out <carpeta>] [--fail-fast]',
            '                                  [--installer <setup.exe>] [--release-dir <carpeta>] [--list]',
            'Sin --suite ni --level ejecuta la suite focused. --list enseña suites, escenarios y niveles.',
            '',
        ].join('\n'));
    } else if (options.list) {
        for (const [name, suite] of Object.entries(SUITES)) {
            process.stdout.write(`${name}: ${suite.title} — ${suite.description}\n`);
            for (const item of planSuites(name === 'installer' ? [] : [name])) process.stdout.write(`    · ${item.id}: ${item.title}\n`);
        }
        process.stdout.write(`Niveles: ${Object.entries(VALIDATION_LEVELS).map(([level, names]) => `${level} = ${names.join(' + ')}`).join('; ')}\n`);
    } else {
        const { summary, out } = await runSuites(options);
        process.stdout.write(`\nSuites E2E: ${summary.status === 'passed' ? 'TODO OK' : 'CON FALLOS'} — ${summary.counts.passed} OK, ${summary.counts.failed} con fallo, ${summary.counts.skipped} omitidos (${formatDuration(summary.durationMs)}).\n`);
        process.stdout.write(`Resumen: ${join(out, 'summary.md')}\n`);
        if (summary.status !== 'passed') process.exitCode = 1;
    }
}
