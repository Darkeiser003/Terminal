import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = resolve(root, 'tests/e2e/smoke.mjs');
const configuredBinary = process.env.LTOOLS_TEST_BINARY;
const e2eCandidates = [
    'src-tauri/target/debug/lterminal',
    'src-tauri/target/debug/winslim-terminal',
    'src-tauri/target/debug/wterminal.exe',
    'src-tauri/target/release/lterminal',
    'src-tauri/target/release/wterminal.exe',
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
const configuredPath = configuredBinary
    ? (isAbsolute(configuredBinary) ? configuredBinary : resolve(root, configuredBinary))
    : null;
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
