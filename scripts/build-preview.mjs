#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('./build-frontend.mjs', import.meta.url));
const child = spawn(process.execPath, [builder], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
    env: {
        ...process.env,
        LTERMINAL_SKIP_CHECKS: '1',
        VITE_LTERMINAL_PREVIEW: '1',
        VITE_OUT_DIR: 'dist-preview',
    },
});

child.on('error', (error) => {
    console.error(`No se pudo iniciar la build de preview: ${error.message}`);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
