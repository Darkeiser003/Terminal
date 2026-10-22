// Prueba real del instalador NSIS de Windows (cambia el equipo y lo deja
// como estaba). Uso:
//   node scripts/test-installer.mjs --installer release/WTerminal-X-x64-setup.exe
//        [--release-dir src-tauri/target/dist/WTerminal-X] [--out artifacts/installer-test] [--video]
//
// 0. Si hay un SHA256SUMS.txt junto al instalador, su huella debe coincidir.
// 1. Se niega a actuar si ya hay un WTerminal instalado: nunca toca la
//    instalación del usuario.
// 2. Un único aviso de UAC lanza windows/test-installer-elevated.ps1, que
//    instala en silencio y espera.
// 3. Comprueba archivos, entrada de desinstalación, accesos directos y que el
//    ejecutable instalado es el de la release (solo puede cambiar la marca de
//    tipo de paquete que Tauri escribe al empaquetar).
// 4. Ejecuta el recorrido E2E completo sobre la aplicación instalada.
// 5. Pide la desinstalación y comprueba que no queda nada, ni en el PATH del
//    usuario.
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runSmokeScenario } from '../tests/e2e/run-scenario.mjs';
import { restoreWindowsPathIntegration, sameWindowsPathSnapshot, snapshotWindowsPathIntegration } from '../tests/e2e/windows-path-guard.mjs';
import { dropPowerShell7ModulePath } from '../tests/e2e/powershell-env.mjs';
// Lanzado desde PowerShell 7, el PSModulePath heredado rompe los powershell.exe 5.1
// que lanzan estas pruebas (ver tests/e2e/powershell-env.mjs).
dropPowerShell7ModulePath();

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_MARKER = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_');

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function powershellJson(script) {
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const text = stdout.trim();
    return text ? JSON.parse(text) : null;
}

/** Entrada de desinstalación de WTerminal (HKLM/HKCU, vistas de 64 y 32 bits). */
export async function findInstalledWTerminal() {
    const entry = await powershellJson(`$roots = @(
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
$entry = Get-ChildItem $roots -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'WTerminal' } | Select-Object -First 1
if ($entry) { @{ displayVersion = "$($entry.DisplayVersion)"; installLocation = "$($entry.InstallLocation)".Trim('"'); uninstallString = "$($entry.UninstallString)"; publisher = "$($entry.Publisher)" } | ConvertTo-Json -Compress }`);
    return entry;
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

/**
 * El empaquetador de Tauri escribe en el ejecutable del instalador el tipo de
 * paquete (`__TAURI_BUNDLE_TYPE_VAR_NSS` frente a `..._UNK` de la release).
 * Cualquier otra diferencia significa que se instaló otro binario.
 */
export function compareInstalledBinary(installed, release) {
    if (installed.length !== release.length) {
        return { identical: false, reason: `tamaños distintos (${installed.length} frente a ${release.length})` };
    }
    // El binario contiene la cadena varias veces (constantes de comparación y
    // la variable que se parchea): solo se admiten diferencias en los tres
    // bytes que siguen a alguna aparición.
    const windows = [];
    for (let at = release.indexOf(BUNDLE_MARKER); at >= 0; at = release.indexOf(BUNDLE_MARKER, at + 1)) {
        windows.push(at + BUNDLE_MARKER.length);
    }
    const differences = [];
    for (let index = 0; index < release.length; index += 1) {
        if (installed[index] !== release[index]) differences.push(index);
    }
    const inMarker = (offset) => windows.some((start) => offset >= start && offset < start + 3);
    const unexpected = differences.filter((offset) => !inMarker(offset));
    const patched = windows.find((start) => differences.some((offset) => offset >= start && offset < start + 3)) ?? windows[0];
    return {
        identical: unexpected.length === 0,
        differences: differences.length,
        bundleMarker: patched !== undefined
            ? { release: release.subarray(patched, patched + 3).toString('latin1'), installed: installed.subarray(patched, patched + 3).toString('latin1') }
            : null,
        reason: unexpected.length ? `${unexpected.length} bytes distintos fuera de la marca de Tauri (primero en ${unexpected[0]})` : null,
    };
}

/**
 * Compara el instalador con su línea de SHA256SUMS.txt, si hay uno a su lado.
 * Un apagado brusco poco después de publicar dejó el instalador con su final a
 * ceros y NSIS solo respondía «código 2»: así el fallo dice qué pasa.
 * @returns {null | {ok: boolean, message?: string}}
 */
export function installerIntegrity(installerBuffer, installerName, manifestText) {
    if (typeof manifestText !== 'string') return null;
    const entry = manifestText.split(/\r?\n/u)
        .map((row) => row.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/iu))
        .find((match) => match && match[2] === installerName);
    if (!entry) {
        return { ok: false, message: `SHA256SUMS.txt no tiene la huella de ${installerName} (manifiesto dañado o de otra build): vuelve a publicar la release.` };
    }
    const actual = sha256(installerBuffer);
    const expected = entry[1].toLowerCase();
    return actual === expected
        ? { ok: true }
        : { ok: false, message: `El instalador no coincide con SHA256SUMS.txt (${actual.slice(0, 12)}… frente a ${expected.slice(0, 12)}…): está dañado, por ejemplo tras un apagado brusco; vuelve a publicar la release.` };
}

async function waitForFile(path, timeoutMs, errorPath) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            await sleep(300);
            return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
        }
        if (errorPath && existsSync(errorPath)) {
            const failure = JSON.parse((await readFile(errorPath, 'utf8')).replace(/^\uFEFF/u, ''));
            throw new Error(`El instalador elevado falló: ${failure.message}`);
        }
        await sleep(1000);
    }
    return null;
}

function psQuote(value) {
    return `'${String(value).replace(/'/gu, "''")}'`;
}

/**
 * @returns {Promise<{status: 'passed'|'failed'|'skipped', summary: string, durationMs: number, steps: object[], scenario?: object}>}
 */
export async function runInstallerTest({ installer, releaseDir, out, smokeTimeoutMs = 45 * 60_000, video = false }) {
    const startedAt = Date.now();
    const steps = [];
    const step = (name, ok, detail = '') => {
        steps.push({ name, ok, detail });
        process.stdout.write(`  ${ok ? 'OK ' : 'ERR'} ${name}${detail ? ` — ${detail}` : ''}\n`);
        return ok;
    };
    const finish = (status, summary, extra = {}) => ({ status, summary, durationMs: Date.now() - startedAt, steps, ...extra });

    if (process.platform !== 'win32') return finish('skipped', 'El instalador NSIS solo se prueba en Windows.');
    installer = resolve(projectRoot, installer);
    if (!existsSync(installer)) return finish('failed', `No existe el instalador: ${installer}`);
    releaseDir = resolve(projectRoot, releaseDir ?? '');
    const releaseExe = join(releaseDir, 'wterminal.exe');
    if (!existsSync(releaseExe)) return finish('failed', `No existe la release con la que comparar: ${releaseExe}`);
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

    const existing = await findInstalledWTerminal();
    if (existing || existsSync(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WTerminal', 'wterminal.exe'))) {
        return finish('skipped', `Ya hay un WTerminal instalado (${existing?.installLocation ?? 'Program Files'}): no se toca la instalación del usuario.`);
    }
    const manifestPath = join(dirname(installer), 'SHA256SUMS.txt');
    const integrity = installerIntegrity(await readFile(installer), basename(installer),
        existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : undefined);
    if (integrity && !integrity.ok) {
        step('Huella del instalador en SHA256SUMS.txt', false, integrity.message);
        return finish('failed', integrity.message);
    }
    if (integrity) step('Huella del instalador en SHA256SUMS.txt', true);

    out = resolve(projectRoot, out);
    const workDir = join(out, 'installer-work');
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const pathBefore = await snapshotWindowsPathIntegration();

    // Un único UAC: el ayudante elevado instala, espera y desinstala.
    const helper = join(projectRoot, 'windows', 'test-installer-elevated.ps1');
    const launcher = join(workDir, 'launch-elevated.ps1');
    await writeFile(launcher, `\uFEFF$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${psQuote(`"${helper}"`)}, '-Installer', ${psQuote(`"${installer}"`)}, '-WorkDir', ${psQuote(`"${workDir}"`)})
Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments
`);
    process.stdout.write('  Windows pedirá permiso de administrador (UAC) una sola vez para instalar y desinstalar.\n');
    try {
        await execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher], { windowsHide: true });
    } catch (error) {
        return finish('failed', `No se obtuvo permiso de administrador (UAC rechazado o no disponible): ${String(error.message).split('\n')[0]}`);
    }

    let uninstallRequested = false;
    let scenario = null;
    let failure = null;
    try {
        const installed = await waitForFile(join(workDir, 'installed.json'), 10 * 60_000, join(workDir, 'elevated-error.json'));
        if (!installed) throw new Error('El instalador no terminó en 10 minutos (¿se aceptó el UAC?).');
        step('Instalación silenciosa', installed.exitCode === 0, `código ${installed.exitCode}`);
        const installDir = installed.installDir;
        const entry = await findInstalledWTerminal();
        step('Entrada en «Aplicaciones instaladas»', Boolean(entry) && entry.displayVersion === packageJson.version,
            entry ? `versión ${entry.displayVersion}, ${entry.installLocation}` : 'no aparece');
        for (const file of ['wterminal.exe', 'conpty.dll', 'OpenConsole.exe', 'uninstall.exe']) {
            step(`Archivo instalado: ${file}`, existsSync(join(installDir, file)));
        }
        const startMenu = join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WTerminal.lnk');
        const publicDesktop = join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop', 'WTerminal.lnk');
        step('Acceso directo en el menú Inicio', existsSync(startMenu));
        step('Acceso directo en el escritorio público', existsSync(publicDesktop));
        const comparison = compareInstalledBinary(await readFile(join(installDir, 'wterminal.exe')), await readFile(releaseExe));
        step('wterminal.exe instalado = release (salvo la marca de Tauri)', comparison.identical,
            comparison.reason ?? (comparison.bundleMarker ? `marca ${comparison.bundleMarker.release}→${comparison.bundleMarker.installed}` : 'idéntico'));
        for (const file of ['conpty.dll', 'OpenConsole.exe']) {
            const same = sha256(await readFile(join(installDir, file))) === sha256(await readFile(join(releaseDir, file)));
            step(`${file} instalado = release`, same);
        }
        process.stdout.write('  Recorrido E2E completo sobre la aplicación instalada…\n');
        scenario = await runSmokeScenario({
            projectRoot,
            binary: join(installDir, 'wterminal.exe'),
            id: 'installed-full',
            // Con la suite de vídeo pedida, lo instalado también se graba:
            // cada forma de distribución deja su propio vídeo.
            env: video ? { E2E_CAPTURE_VIDEO: '1' } : {},
            timeoutMs: smokeTimeoutMs,
            outDir: out,
        });
        step('Recorrido E2E completo sobre lo instalado', scenario.status === 'passed', scenario.summary);
    } catch (error) {
        failure = error;
        step('Prueba sobre la aplicación instalada', false, error.message);
    } finally {
        await writeFile(join(workDir, 'uninstall.request'), new Date().toISOString());
        uninstallRequested = true;
    }

    const uninstalled = uninstallRequested
        ? await waitForFile(join(workDir, 'uninstalled.json'), 6 * 60_000, join(workDir, 'elevated-error.json')).catch((error) => ({ error: error.message }))
        : null;
    if (!uninstalled || uninstalled.error) {
        step('Desinstalación silenciosa', false, uninstalled?.error ?? 'no terminó en 6 minutos');
    } else {
        step('Desinstalación silenciosa', uninstalled.exitCode === 0, `código ${uninstalled.exitCode}`);
        step('Sin ejecutable ni entrada de desinstalación', !uninstalled.executableExists && !uninstalled.uninstallEntryExists);
        const startMenu = join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WTerminal.lnk');
        const publicDesktop = join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop', 'WTerminal.lnk');
        step('Sin accesos directos', !existsSync(startMenu) && !existsSync(publicDesktop));
    }
    const pathAfter = await snapshotWindowsPathIntegration();
    if (!sameWindowsPathSnapshot(pathBefore, pathAfter)) {
        await restoreWindowsPathIntegration(pathBefore).catch(() => undefined);
        step('PATH del usuario intacto', false, 'cambió durante la prueba; se ha restaurado');
    } else {
        step('PATH del usuario intacto', true);
    }

    const failed = steps.filter((entry) => !entry.ok);
    const result = finish(failed.length === 0 && !failure ? 'passed' : 'failed',
        failed.length === 0 ? `Instalado, verificado (${steps.length} comprobaciones), E2E completo y desinstalado sin restos` : `${failed.length} comprobaciones fallaron: ${failed.map((entry) => entry.name).join('; ')}`,
        { scenario });
    await writeFile(join(out, 'installer-test.json'), JSON.stringify(result, null, 2));
    return result;
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--installer') options.installer = argv[++index];
        else if (arg === '--release-dir') options.releaseDir = argv[++index];
        else if (arg === '--out') options.out = argv[++index];
        // Graba el recorrido sobre lo instalado sin repetir la suite «video».
        else if (arg === '--video') options.video = true;
        else throw new Error(`Opción desconocida: ${arg}`);
    }
    return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const options = parseArgs(process.argv.slice(2));
    if (!options.installer) throw new Error('Uso: node scripts/test-installer.mjs --installer <setup.exe> [--release-dir <carpeta>] [--out <carpeta>] [--video]');
    const installerName = basename(options.installer);
    const version = installerName.match(/WTerminal-(.+)-x64-setup\.exe$/u)?.[1];
    options.releaseDir ??= join(dirname(options.installer), version ? `WTerminal-${version}` : '.');
    options.out ??= join('artifacts', 'installer-test', new Date().toISOString().replace(/[:.]/gu, '-'));
    const result = await runInstallerTest(options);
    process.stdout.write(`Instalador: ${result.status} — ${result.summary} (${Math.round(result.durationMs / 1000)} s)\n`);
    if (result.status === 'failed') process.exitCode = 1;
}
