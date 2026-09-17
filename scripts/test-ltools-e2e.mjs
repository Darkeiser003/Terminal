import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = resolve(root, 'tests/e2e/smoke.mjs');
const configuredBinary = process.env.LTOOLS_TEST_BINARY;
const configuredDirectory = configuredBinary && isAbsolute(configuredBinary)
    ? dirname(configuredBinary)
    : null;
const child = spawn(process.execPath, [smoke, ...process.argv.slice(2)], {
    cwd: root,
    env: {
        ...process.env,
        E2E_LTOOLS_ONLY: '1',
        E2E_LTOOLS_INTEGRATION: '1',
        ...(configuredDirectory
            ? { PATH: [configuredDirectory, process.env.PATH].filter(Boolean).join(delimiter) }
            : {}),
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
