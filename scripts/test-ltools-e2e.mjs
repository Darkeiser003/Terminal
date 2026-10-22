import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = resolve(root, 'tests/e2e/smoke.mjs');
const configuredBinary = process.env.LTOOLS_TEST_BINARY ?? process.env.LTOOLS_PATH;
// La release Windows de Tools publica `wtools-cli.exe` (la GUI `wtools.exe`
// pide elevación y no sirve para consultar el catálogo).
const ltoolsNames = process.platform === 'win32'
    ? ['wtools-cli.exe', 'ltools-cli.exe', 'ltools.exe', 'winslim-tools.exe']
    : ['ltools-cli', 'ltools', 'winslim-tools'];
const pathLtoolsBinary = String(process.env.PATH ?? '')
    .split(delimiter)
    .flatMap((directory) => ltoolsNames.map((name) => join(directory, name)))
    .find((candidate) => existsSync(candidate));
const configuredPath = configuredBinary
    ? (isAbsolute(configuredBinary) ? configuredBinary : resolve(root, configuredBinary))
    : pathLtoolsBinary;
if (configuredBinary && !existsSync(configuredPath)) {
    throw new Error(`LTOOLS_TEST_BINARY no existe: ${configuredPath}`);
}
if (!configuredPath) {
    console.log('SKIP: E2E LTools omitida; no hay un CLI LTools instalado. Define LTOOLS_TEST_BINARY para probar uno explícitamente.');
    process.exit(0);
}
const e2eCandidates = [
    ...(() => {
        // La carpeta desempaquetada vive en src-tauri/target/dist; release/
        // solo guarda lo que se sube a GitHub.
        const releaseRoot = resolve(root, 'src-tauri', 'target', 'dist');
        try {
            return readdirSync(releaseRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && /^WTerminal-/i.test(entry.name))
                .map((entry) => join(releaseRoot, entry.name, 'wterminal.exe'))
                .sort((left, right) => {
                    try { return statSync(right).mtimeMs - statSync(left).mtimeMs; } catch { return 0; }
                });
        } catch {
            return [];
        }
    })(),
    'src-tauri/target/release/wterminal.exe',
    'src-tauri/target/debug/lterminal',
    'src-tauri/target/debug/winslim-terminal',
    'src-tauri/target/debug/wterminal.exe',
    'src-tauri/target/release/lterminal',
    'src-tauri/target/windows-cross/x86_64-pc-windows-gnu/release/wterminal.exe',
    'src-tauri/target/windows-cross/x86_64-pc-windows-gnu/release/winslim-terminal.exe',
    'release/LTerminal-1.0.0-x86_64.AppImage',
];
const e2eBinary = process.env.E2E_BINARY
    ? (isAbsolute(process.env.E2E_BINARY) ? process.env.E2E_BINARY : resolve(root, process.env.E2E_BINARY))
    : e2eCandidates.map((candidate) => resolve(root, candidate)).find((candidate) => existsSync(candidate));
if (!e2eBinary) {
    console.log('SKIP: E2E LTools omitida; no hay un binario Tauri compilado. Use E2E_BINARY=... para ejecutarla.');
    process.exit(0);
}
const configuredDirectory = configuredPath
    ? dirname(configuredPath)
    : null;
const child = spawn(process.execPath, [smoke, ...process.argv.slice(2)], {
    cwd: root,
    env: {
        ...process.env,
        E2E_BINARY: e2eBinary,
        E2E_LTOOLS_ONLY: '1',
        E2E_LTOOLS_INTEGRATION: '1',
        LTOOLS_TEST_BINARY: configuredPath,
        ...(configuredDirectory
            ? { PATH: [configuredDirectory, process.env.PATH].filter(Boolean).join(delimiter) }
            : {}),
        ...(configuredPath ? { LTOOLS_PATH: configuredPath } : {}),
    },
    stdio: 'inherit',
});

child.on('error', (error) => {
    console.error(`No se pudo iniciar la E2E opcional de LTools: ${error.message}`);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    if (signal) {
        console.error(`La E2E opcional de LTools terminó por ${signal}.`);
        process.exitCode = 1;
    } else {
        process.exitCode = code ?? 1;
    }
});
