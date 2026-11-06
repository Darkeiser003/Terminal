// Herramientas de línea de órdenes que usa SOLO el E2E de sugerencias y
// colores (`E2E_SHELL_ASSIST_ONLY`): Clink portable para cmd y el PSReadLine
// actual para Windows PowerShell 5.1, que trae la 2.0 sin predicciones. Se
// descargan con versión y SHA-256 fijados a `artifacts/e2e-tools` (ignorado
// por git) y se reutilizan: no se instala nada ni se toca el perfil del
// usuario. El smoke las pone delante en PATH y PSModulePath del proceso.
//
// Para bash en WSL descarga además ble.sh (la misma versión fijada que ofrece
// el catálogo) y lo instala en el `/tmp` de la distro de pruebas, nunca en su
// carpeta personal; el smoke pasa esa ruta a la app con
// `LTERMINAL_E2E_BLESH_PATH`, que solo se acepta en modo E2E.
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { windowsPowerShellEnvironment } from '../tests/e2e/powershell-env.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CLINK = {
    version: '1.9.34',
    url: 'https://github.com/chrisant996/clink/releases/download/v1.9.34/clink.1.9.34.4e8ae4.zip',
    sha256: '50f6ee0474e3bd02b48ce8c8f63ed933a14aee5127fc7072cb976ce10a43ce23',
};

export const PSREADLINE = {
    version: '2.4.5',
    url: 'https://www.powershellgallery.com/api/v2/package/PSReadLine/2.4.5',
    sha256: 'cb9390e9733208456c234a7971d1ec4a917886c239502aab68f4b71aa4bba235',
};

/** Igual que `BLESH_URL`/`BLESH_SHA256` de `packages/actions.rs`. */
export const BLESH = {
    version: 'nightly-20260908+d81fd54',
    url: 'https://github.com/akinomyoga/ble.sh/releases/download/nightly/ble-nightly-20260908%2Bd81fd54.tar.xz',
    sha256: '7a2445f138e7f099dd5dee749391a8b045646d1b8a605975885be5b34b6b5f7e',
    directory: 'ble-nightly-20260908+d81fd54',
};

/** Carpeta de la distro donde el E2E instala ble.sh (`--install` crea `blesh/`).
 *  `/var/tmp` y no `/tmp`: con systemd (Ubuntu 26.04) `/tmp` es tmpfs y se
 *  vacía cada vez que la instancia de la distro se detiene por inactividad,
 *  así que ble.sh desaparecía entre la preparación y la pestaña de bash. */
export const E2E_BLESH_PREFIX = '/var/tmp/wterminal-e2e-blesh';

export const DEFAULT_TOOLS_DIR = join(projectRoot, 'artifacts', 'e2e-tools');

async function exists(path) {
    return stat(path).then(() => true, () => false);
}

async function download(url, sha256) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error(`SHA-256 inesperado para ${url}: ${actual} (se esperaba ${sha256})`);
    return bytes;
}

async function powershell(script) {
    // Con el PSModulePath de PowerShell 7, 5.1 no carga Get-AuthenticodeSignature.
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, env: windowsPowerShellEnvironment() });
    return stdout.trim();
}

const quote = (path) => `'${path.replace(/'/gu, "''")}'`;

async function expandZip(bytes, destination, scratch) {
    await mkdir(scratch, { recursive: true });
    const archive = join(scratch, 'paquete.zip');
    await writeFile(archive, bytes);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await powershell(`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`);
    await rm(scratch, { recursive: true, force: true });
}

/** Prepara (o reutiliza) las herramientas y devuelve sus carpetas. */
export async function prepareShellTools(toolsDir = DEFAULT_TOOLS_DIR) {
    if (process.platform !== 'win32') throw new Error('Las herramientas del E2E de sugerencias son de Windows (cmd y PowerShell 5.1).');
    const clinkDir = join(toolsDir, 'clink');
    const clinkMarker = join(clinkDir, '.version');
    const clinkReady = await exists(join(clinkDir, 'clink.bat'))
        && (await readFile(clinkMarker, 'utf8').catch(() => '')).trim() === CLINK.version;
    if (!clinkReady) {
        await expandZip(await download(CLINK.url, CLINK.sha256), clinkDir, join(toolsDir, '.descarga-clink'));
        if (!await exists(join(clinkDir, 'clink.bat'))) throw new Error(`El zip de Clink ${CLINK.version} no trae clink.bat`);
        await writeFile(clinkMarker, `${CLINK.version}\n`);
    }

    const psModulesDir = join(toolsDir, 'psmodules');
    const moduleDir = join(psModulesDir, 'PSReadLine', PSREADLINE.version);
    if (!await exists(join(moduleDir, 'PSReadLine.psd1'))) {
        // Un .nupkg es un zip: se extrae a la estructura Módulo\Versión que
        // espera PSModulePath, sin PowerShellGet ni el proveedor NuGet.
        await expandZip(await download(PSREADLINE.url, PSREADLINE.sha256), moduleDir, join(toolsDir, '.descarga-psreadline'));
        for (const metadata of ['[Content_Types].xml', '_rels', 'package', 'PSReadLine.nuspec']) {
            await rm(join(moduleDir, metadata), { recursive: true, force: true });
        }
    }
    // El paquete va firmado por Microsoft: se comprueba antes de cargarlo.
    const signature = await powershell(`$s = Get-AuthenticodeSignature -LiteralPath ${quote(join(moduleDir, 'Microsoft.PowerShell.PSReadLine.dll'))}; '' + $s.Status + '|' + $s.SignerCertificate.Subject`);
    if (!/^Valid\|CN=Microsoft Corporation,/u.test(signature)) {
        throw new Error(`PSReadLine ${PSREADLINE.version} no tiene una firma válida de Microsoft: ${signature}`);
    }
    return { clinkDir, psModulesDir };
}

/** `wsl.exe` escribe en UTF-16LE salvo con `WSL_UTF8=1`. */
async function wsl(args, options = {}) {
    const { stdout } = await execFile('wsl.exe', args, {
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1' },
        timeout: 120000,
        ...options,
    });
    return stdout.replace(/\0/gu, '').trim();
}

/** Órdenes que ble.sh exige al cargarse: igual que `BLESH_REQUIRED_COMMANDS`
 *  de `packages/actions.rs`. Sin alguna, `ble.sh --install` no termina: en la
 *  build 22, FedoraLinux-44 (sin awk) agotó el plazo y tumbó la suite. */
export const BLESH_REQUIRED_COMMANDS = 'sed date rm mkdir mkfifo sleep stty tty sort awk chmod grep cat wc mv sh od cp ps';

/** Lo que el E2E necesita en la distro: bash, las órdenes de ble.sh y algo
 *  con que extraer el .tar.xz. Imprime `ok` o `falta: …`. */
export const WSL_PROBE_SCRIPT = [
    'm=',
    'command -v bash >/dev/null 2>&1 || m="$m bash"',
    `for c in ${BLESH_REQUIRED_COMMANDS}; do command -v $c >/dev/null 2>&1 || m="$m $c"; done`,
    '{ command -v tar >/dev/null 2>&1 && command -v xz >/dev/null 2>&1; } || command -v python3 >/dev/null 2>&1 || m="$m tar+xz/python3"',
    'if [ -n "$m" ]; then echo "falta:$m"; else echo ok; fi',
].join('; ');

/** Intentos con la distro pedida y con Ubuntu: un fallo pasajero de WSL
 *  (build 22: Ubuntu no contestó a la sonda) no debe llevar a otra distro. */
const PREFERRED_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 5000;
const PROBE_TIMEOUT_MS = 60000;

const outputLines = (text) => String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);

async function wslDistroNames() {
    return outputLines(await wsl(['--list', '--quiet']).catch(() => ''))
        .filter((name) => !/^docker-desktop/iu.test(name));
}

/** `ok`, `falta: …` o `null` si WSL no contestó (fallo pasajero). */
async function probeWslDistro(name) {
    const output = await wsl(['-d', name, '--exec', 'sh', '-c', WSL_PROBE_SCRIPT], { timeout: PROBE_TIMEOUT_MS }).catch(() => '');
    return outputLines(output).find((line) => line === 'ok' || line.startsWith('falta:')) ?? null;
}

/** Distro WSL para el E2E de bash, con ble.sh ya instalado en ella: la
 *  pedida, Ubuntu si existe y luego las demás. La pedida y Ubuntu se
 *  reintentan ante un fallo pasajero de WSL; una distro a la que le falta
 *  algo, o donde ble.sh no se instala, cede el turno a la siguiente.
 *  `null` si no hay WSL o ninguna sirve. `deps` sustituye a WSL en los tests. */
export async function prepareWslBashWithBlesh(preferred = '', toolsDir = DEFAULT_TOOLS_DIR, log = (line) => console.log(line), deps = {}) {
    const {
        platform = process.platform,
        listDistros = wslDistroNames,
        probe: probeDistro = probeWslDistro,
        install = prepareBleshInWsl,
        pause = () => new Promise((done) => setTimeout(done, RETRY_PAUSE_MS)),
    } = deps;
    if (platform !== 'win32') return null;
    const names = await listDistros();
    const ordered = [preferred, 'Ubuntu', ...names].filter((name, index, list) => name && names.includes(name) && list.indexOf(name) === index);
    for (const name of ordered) {
        const attempts = name === preferred || name === 'Ubuntu' ? PREFERRED_ATTEMPTS : 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (attempt > 1) await pause();
            const probe = await probeDistro(name);
            if (probe?.startsWith('falta:')) {
                log(`E2E de bash con ble.sh: se descarta ${name} (${probe}).`);
                break;
            }
            if (!probe) {
                log(`E2E de bash con ble.sh: ${name} no contestó a la sonda (intento ${attempt} de ${attempts}).`);
                continue;
            }
            try {
                const bleshPath = await install(name, toolsDir);
                log(`E2E de bash con ble.sh: distro ${name}.`);
                return { distro: name, bleshPath };
            } catch (error) {
                const reason = outputLines(error?.stderr || error?.message || error)[0] ?? 'sin detalles';
                log(`E2E de bash con ble.sh: no se instaló en ${name} (intento ${attempt} de ${attempts}): ${reason}`);
            }
        }
    }
    return null;
}

/** Instala ble.sh en el `/tmp` de la distro y devuelve la ruta de su
 *  `ble.sh` dentro de ella. Se reinstala en cada ejecución (es local y tarda
 *  un segundo): `/tmp` de WSL se vacía al reiniciar la distro. */
export async function prepareBleshInWsl(distro, toolsDir = DEFAULT_TOOLS_DIR) {
    const tarball = join(toolsDir, 'blesh', `${BLESH.directory}.tar.xz`);
    const cached = await readFile(tarball).catch(() => null);
    if (!cached || createHash('sha256').update(cached).digest('hex') !== BLESH.sha256) {
        await mkdir(dirname(tarball), { recursive: true });
        await writeFile(tarball, await download(BLESH.url, BLESH.sha256));
    }
    const inside = await wsl(['-d', distro, '--exec', 'wslpath', '-a', tarball]);
    // --exec: los argumentos llegan tal cual a bash, sin pasar por la login
    // shell de la distro (que expandiría $1 antes de tiempo).
    const script = [
        'set -e',
        `rm -rf ${E2E_BLESH_PREFIX}`,
        `mkdir -p ${E2E_BLESH_PREFIX}/src`,
        // El tar de Ubuntu no crea subcarpetas en WSL 1: Python sí.
        `{ tar -xJf "$1" -C ${E2E_BLESH_PREFIX}/src 2>/dev/null || python3 -m tarfile -e "$1" ${E2E_BLESH_PREFIX}/src; }`,
        `bash ${E2E_BLESH_PREFIX}/src/${BLESH.directory}/ble.sh --install ${E2E_BLESH_PREFIX} >/dev/null`,
        `test -r ${E2E_BLESH_PREFIX}/blesh/ble.sh`,
        // Un init-term.sh más nuevo que la caché obliga a ble.sh a regenerarla
        // al cargarse y a imprimir «updating tput cache», como tras instalarlo
        // o actualizarlo. Ese aviso dejaba a ConPTY una fila por debajo de
        // xterm; el E2E lo provoca siempre para que no vuelva a pasar.
        `touch ${E2E_BLESH_PREFIX}/blesh/lib/init-term.sh`,
    ].join('; ');
    await wsl(['-d', distro, '--exec', 'bash', '-c', script, 'prepare-blesh', inside]);
    return `${E2E_BLESH_PREFIX}/blesh/ble.sh`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const tools = await prepareShellTools(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TOOLS_DIR);
    console.log(`Herramientas del E2E de sugerencias listas: Clink ${CLINK.version} en ${tools.clinkDir}; PSReadLine ${PSREADLINE.version} en ${tools.psModulesDir}.`);
}
