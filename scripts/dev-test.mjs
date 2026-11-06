#!/usr/bin/env node
// Bucle rápido de desarrollo (`npm run dev:test`): compila con el perfil de
// Cargo `fast` (como release, pero sin LTO y con compilación incremental: un
// cambio tarda uno o dos minutos en vez de nueve) y ejecuta solo lo pedido:
// unos escenarios E2E concretos, la matriz de shells limitada a unos entornos,
// tests de Rust filtrados o checks JS sueltos, con vídeo si se pide y
// repitiendo N veces. Lo que compila lleva dentro las claves públicas del
// actualizador y queda firmado en su carpeta de resultados, igual que una
// release. No sustituye a `windows/build.ps1 -ReleaseValidation`: el binario
// `fast` no se publica.
//
//   npm run dev:test -- --only resize-type --repeat 3
//   npm run dev:test -- --matrix lang:haskell,lang:scala --build none
//   npm run dev:test -- --only shell-assist --video
//   npm run dev:test -- --rust wsl::tests --js test:frontend-logic
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { planSuites, SUITES } from '../tests/e2e/suites.mjs';
import { runSmokeScenario } from '../tests/e2e/run-scenario.mjs';

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MINUTE = 60_000;
const BUILDS = ['fast', 'release', 'debug', 'none'];
/** La matriz entera tarda unos 15 min; limitada, bastante menos. */
const MATRIX_TIMEOUT_MS = 30 * MINUTE;
/** Los mismos nombres que busca `windows/build.ps1`. */
const SIGNING_KEY_NAMES = {
    private: ['release-signing-private.pem'],
    public: ['release-signing-public.hex'],
    sshPrivate: ['lterminal-release-signing', 'ltools-release-signing'],
    sshPublic: ['lterminal-release-signing.pub', 'ltools-release-signing.pub'],
};

const USAGE = `Uso: npm run dev:test -- [opciones]

  --only a,b        escenarios E2E por su id (npm run dev:test -- --list)
  --matrix a,b      matriz de shells/REPL solo con esos entornos, en ese orden
  --video           graba vídeo de cada escenario (E2E_CAPTURE_VIDEO=1)
  --repeat N        repite cada escenario N veces (por defecto 1)
  --env CLAVE=valor variable extra para los E2E (repetible)
  --rust filtro     tests de Rust cuyo nombre contenga el filtro (repetible)
  --js a,b          scripts npm de checks o tests (por ejemplo test:frontend-logic)
  --build tipo      fast (por defecto), release, debug o none (no compila)
  --binary ruta     binario ya compilado (implica --build none)
  --keys-dir ruta   carpeta de las claves de firma (por defecto, la última de
                    windows/build.ps1 o, si no hay, Escritorio/Claves SSH)
  --no-sign         compila sin claves públicas y no firma
  --keep-wsl        no apaga WSL al empezar ni al terminar (Windows)
  --out carpeta     resultados (por defecto artifacts/dev-test/<fecha>)
  --list            enseña los escenarios disponibles por suite
`;

const splitList = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

export function parseDevTestArgs(argv) {
    const options = { only: [], matrix: [], rust: [], js: [], env: {}, repeat: 1, video: false, keepWsl: false, list: false, help: false, sign: true };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) throw new Error(`Falta el valor de ${arg}`);
            index += 1;
            return next;
        };
        if (arg === '--only') options.only.push(...splitList(value()));
        else if (arg === '--matrix') options.matrix.push(...splitList(value()));
        else if (arg === '--rust') options.rust.push(value());
        else if (arg === '--js') options.js.push(...splitList(value()));
        else if (arg === '--video') options.video = true;
        else if (arg === '--keep-wsl') options.keepWsl = true;
        else if (arg === '--list') options.list = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--out') options.out = value();
        else if (arg === '--binary') options.binary = value();
        else if (arg === '--keys-dir') options.keysDir = value();
        else if (arg === '--no-sign') options.sign = false;
        else if (arg === '--build') {
            const build = value();
            if (!BUILDS.includes(build)) throw new Error(`--build debe ser ${BUILDS.join(', ')}; se recibió ${build}`);
            options.build = build;
        } else if (arg === '--repeat') {
            const repeat = Number(value());
            if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) throw new Error('--repeat debe ser un entero entre 1 y 50');
            options.repeat = repeat;
        } else if (arg === '--env') {
            const pair = value();
            const equals = pair.indexOf('=');
            if (equals <= 0) throw new Error(`--env espera CLAVE=valor; se recibió ${pair}`);
            options.env[pair.slice(0, equals)] = pair.slice(equals + 1);
        } else throw new Error(`Opción desconocida: ${arg}`);
    }
    if (options.binary && options.build && options.build !== 'none') {
        throw new Error('--binary usa un binario ya compilado: no se puede combinar con --build distinto de none');
    }
    const wantsE2e = options.only.length > 0 || options.matrix.length > 0;
    options.build = options.binary ? 'none' : (options.build ?? (wantsE2e ? 'fast' : 'none'));
    if (options.keysDir && !options.sign) throw new Error('--keys-dir y --no-sign se contradicen');
    if (options.keysDir && options.build === 'none') throw new Error('--keys-dir firma lo que se compila: no sirve sin compilar');
    return options;
}

/** La carpeta que recuerda `windows/build.ps1` o, si no hay, la habitual. */
export function defaultKeysDir(env = process.env, home = homedir()) {
    const memory = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'WTerminalBuild', 'keys-dir.txt') : '';
    if (memory && existsSync(memory)) {
        const last = readFileSync(memory, 'utf8').trim();
        if (last && existsSync(last)) return last;
    }
    return join(home, 'Desktop', 'Claves SSH');
}

/** Ruta de cada clave, en la carpeta o en su `.ssh`; la que falta no aparece. */
export function findSigningKeys(folder) {
    const keys = {};
    for (const [kind, names] of Object.entries(SIGNING_KEY_NAMES)) {
        const path = [folder, join(folder, '.ssh')]
            .flatMap((root) => names.map((name) => join(root, name)))
            .find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
        if (path) keys[kind] = path;
    }
    return keys;
}

/**
 * Las claves públicas forman parte del ejecutable (`updater/security.rs`), así
 * que compilar con ellas es lo que hace que el binario sea como el publicado.
 * La privada no se pasa aquí: la compilación no la necesita.
 */
export async function trustEnv(keys, env = process.env) {
    return {
        LTERMINAL_UPDATE_PUBLIC_KEY: (await readFile(keys.public, 'utf8')).trim(),
        LTERMINAL_SSH_UPDATE_PUBLIC_KEY: (await readFile(keys.sshPublic, 'utf8')).trim(),
        LTERMINAL_SSH_UPDATE_IDENTITY: env.LTERMINAL_SSH_UPDATE_IDENTITY || env.GIT_AUTHOR_EMAIL || 'lterminal-release@local',
    };
}

/** Decide si esta tanda firma y con qué claves, antes de compilar nada. */
export async function prepareSigning(options, env = process.env, home = homedir()) {
    if (options.build === 'none') return { note: 'no aplica: no se ha compilado' };
    if (!options.sign) return { note: 'no: --no-sign' };
    const folder = options.keysDir ? resolve(options.keysDir) : defaultKeysDir(env, home);
    const keys = findSigningKeys(folder);
    const missing = Object.keys(SIGNING_KEY_NAMES).filter((kind) => !keys[kind]);
    if (missing.length) {
        const problem = `faltan claves en ${folder}: ${missing.join(', ')}`;
        if (options.keysDir) throw new Error(problem);
        return { note: `**sin firmar**: ${problem}`, warning: problem };
    }
    return { keys, trust: await trustEnv(keys, env), note: 'no se llegó a firmar' };
}

/** Firma el binario como una release: manifiesto, Ed25519 y SSHSIG verificadas. */
export async function signBinary(binary, folder, { keys, trust }, runner) {
    await mkdir(folder, { recursive: true });
    const manifest = join(folder, 'SHA256SUMS.txt');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(binary)) hash.update(chunk);
    await writeFile(manifest, `${hash.digest('hex')}  ${basename(binary)}\n`);
    const ed25519 = ['scripts/sign-release-manifest.mjs', '--manifest', manifest, '--signature', join(folder, 'SHA256SUMS.txt.sig')];
    const ssh = ['scripts/sign-release-ssh.mjs', '--manifest', manifest, '--signature', join(folder, 'SHA256SUMS.txt.sshsig')];
    const env = {
        ...trust,
        LTERMINAL_SIGNING_PRIVATE_KEY: await readFile(keys.private, 'utf8'),
        LTERMINAL_SSH_SIGNING_KEY_FILE: keys.sshPrivate,
        LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE: keys.sshPublic,
        LTERMINAL_SSH_SIGNING_IDENTITY: trust.LTERMINAL_SSH_UPDATE_IDENTITY,
    };
    for (const args of [ed25519, [...ed25519, '--verify'], ssh, [...ssh, '--verify']]) {
        if (await runner(process.execPath, args, env) !== 0) return false;
    }
    return true;
}

/** Cada id pedido con la suite que lo contiene; el primero que aparezca. */
export function resolveScenarios(ids) {
    const plan = planSuites(Object.keys(SUITES));
    return ids.map((id) => {
        const item = plan.find((candidate) => candidate.scenario === id || candidate.id === id);
        if (!item) throw new Error(`Escenario desconocido: ${id}. Lista: npm run dev:test -- --list`);
        return item;
    });
}

/** El binario que deja cada tipo de build (Tauri usa la carpeta del perfil). */
export function binaryFor(build, platform = process.platform) {
    const profile = build === 'none' ? 'fast' : build;
    const name = platform === 'win32' ? 'wterminal.exe' : 'wterminal';
    return join(projectRoot, 'src-tauri', 'target', profile, name);
}

export function run(command, args, env = {}) {
    return new Promise((resolveRun) => {
        const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, ...env } });
        child.once('error', () => resolveRun(1));
        child.once('exit', (code) => resolveRun(code ?? 1));
    });
}

const minutes = (ms) => `${(ms / MINUTE).toFixed(1)} min`;

function printList() {
    for (const [name, suite] of Object.entries(SUITES)) {
        process.stdout.write(`\n${name}:\n`);
        for (const scenario of suite.scenarios) process.stdout.write(`  ${scenario.id.padEnd(28)} ${scenario.title}\n`);
    }
}

async function shutdownWsl(options) {
    if (process.platform !== 'win32' || options.keepWsl) return;
    await execFile('wsl.exe', ['--shutdown'], { windowsHide: true, timeout: 60_000 }).catch(() => undefined);
}

async function main() {
    const options = parseDevTestArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(USAGE);
        return 0;
    }
    if (options.list) {
        printList();
        return 0;
    }
    const scenarios = resolveScenarios(options.only);
    if (!scenarios.length && !options.matrix.length && !options.rust.length && !options.js.length && options.build === 'none') {
        process.stdout.write(USAGE);
        return 2;
    }
    // Con UTF-8 forzado, `wsl.exe` cambia su salida y las sondas del E2E no la
    // reconocen: las builds y suites se lanzan siempre sin esta variable.
    delete process.env.WSL_UTF8;
    const signing = await prepareSigning(options);
    if (signing.warning) process.stdout.write(`\n[AVISO] Sin firmar: ${signing.warning}\n`);
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
    const out = resolve(options.out ?? join(projectRoot, 'artifacts', 'dev-test', stamp));
    await mkdir(out, { recursive: true });
    const results = [];
    const step = async (kind, label, action) => {
        const startedAt = Date.now();
        process.stdout.write(`\n==> ${kind}: ${label}\n`);
        const outcome = await action();
        const result = { kind, label, durationMs: Date.now() - startedAt, ...outcome };
        results.push(result);
        process.stdout.write(`    ${result.passed ? 'OK' : 'FALLO'} (${minutes(result.durationMs)})${result.summary ? ` ${result.summary}` : ''}\n`);
        return result;
    };

    for (const script of options.js) {
        await step('js', script, async () => ({ passed: await run(process.execPath, ['scripts/package-scripts.mjs', 'run', script]) === 0 }));
    }
    for (const filter of options.rust) {
        await step('rust', filter, async () => ({
            passed: await run(process.execPath, ['scripts/run-rust-tool.mjs', 'cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', filter]) === 0,
        }));
    }

    let binary = options.binary ? resolve(options.binary) : binaryFor(options.build);
    if (options.build !== 'none') {
        const tauri = join(projectRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
        const args = [tauri, 'build', '--no-bundle'];
        if (options.build === 'debug') args.push('--debug');
        if (options.build === 'fast') args.push('--', '--profile', 'fast');
        // LTERMINAL_SKIP_CHECKS: el frontend se compila como en `build:fast`,
        // sin las sondas de red del prebuild.
        const build = await step('build', options.build, async () => ({
            passed: await run(process.execPath, args, { LTERMINAL_SKIP_CHECKS: '1', ...signing.trust }) === 0,
        }));
        if (!build.passed) return finish(out, results, binary, signing);
        if (signing.keys) {
            const signed = await step('firma', 'SHA256SUMS.txt', async () => ({
                passed: await signBinary(binary, join(out, 'firma'), signing, run),
            }));
            signing.note = signed.passed ? 'Ed25519 y SSHSIG verificadas en `firma/`' : '**falló**';
            if (!signed.passed) return finish(out, results, binary, signing);
        }
    }
    if ((scenarios.length || options.matrix.length) && !existsSync(binary)) {
        throw new Error(`No existe el binario ${binary}: compílalo con --build fast o indica --binary`);
    }

    const e2eEnv = { ...options.env, ...(options.video ? { E2E_CAPTURE_VIDEO: '1' } : {}) };
    // WSL se apaga por tanda, no por escenario: cada arranque de WTerminal
    // sondea las distros, así que apagarlo antes de cada pasada forzaba un
    // arranque en frío de la VM de WSL por escenario.
    if (scenarios.length || options.matrix.length) await shutdownWsl(options);
    for (const scenario of scenarios) {
        for (let pass = 1; pass <= options.repeat; pass += 1) {
            const id = options.repeat > 1 ? `${scenario.id}-${pass}` : scenario.id;
            await step('e2e', `${scenario.suite}/${id}`, async () => {
                const result = await runSmokeScenario({
                    projectRoot,
                    binary,
                    id,
                    env: { ...scenario.env, ...e2eEnv },
                    timeoutMs: scenario.timeoutMs,
                    outDir: join(out, scenario.suite),
                });
                return { passed: result.status === 'passed', summary: result.summary, video: result.video, logPath: result.logPath };
            });
        }
    }
    if (options.matrix.length) {
        for (let pass = 1; pass <= options.repeat; pass += 1) {
            const id = options.repeat > 1 ? `matrix-${pass}` : 'matrix';
            await step('e2e', `matriz ${options.matrix.join(',')}${options.repeat > 1 ? ` (${pass})` : ''}`, async () => {
                const result = await runSmokeScenario({
                    projectRoot,
                    binary,
                    id,
                    env: { ...e2eEnv, E2E_SHELL_MATRIX_ONLY: '1', E2E_SHELL_MATRIX_IDS: options.matrix.join(',') },
                    timeoutMs: MATRIX_TIMEOUT_MS,
                    outDir: join(out, 'matrix'),
                });
                return { passed: result.status === 'passed', summary: result.summary, video: result.video, logPath: result.logPath };
            });
        }
    }
    if (scenarios.length || options.matrix.length) await shutdownWsl(options);
    return finish(out, results, binary, signing);
}

async function finish(out, results, binary, signing) {
    const failed = results.filter((result) => !result.passed);
    const lines = [
        `# dev:test ${new Date().toISOString()}`,
        '',
        `- Binario: \`${relative(projectRoot, binary)}\``,
        `- Firma: ${signing.note}`,
        `- Resultado: ${failed.length ? `**${failed.length} con fallo**` : '**todo OK**'} (${results.length} pasos)`,
        '',
        '| Paso | Qué | Resultado | Tiempo | Detalle |',
        '|---|---|---|---|---|',
        ...results.map((result) => `| ${result.kind} | ${result.label} | ${result.passed ? 'OK' : 'FALLO'} | ${minutes(result.durationMs)} | ${(result.summary ?? '').replace(/\|/gu, '/').slice(0, 200)}${result.video ? ` · vídeo: ${relative(out, result.video)}` : ''} |`),
        '',
    ];
    await writeFile(join(out, 'summary.md'), lines.join('\n'));
    await writeFile(join(out, 'summary.json'), JSON.stringify({ binary, signing: signing.note, results }, null, 2));
    process.stdout.write(`\ndev:test: ${failed.length ? `${failed.length} con fallo` : 'todo OK'} — ${relative(projectRoot, join(out, 'summary.md'))}\n`);
    return failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().then((code) => { process.exitCode = code; }, (error) => {
        console.error(error?.message ?? error);
        process.exitCode = 2;
    });
}
