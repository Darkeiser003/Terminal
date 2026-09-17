#!/usr/bin/env node
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['run', 'build'], {
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
