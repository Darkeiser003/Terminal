#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
    await access('dist-preview/index.html');
} catch {
    console.log('No existe un preview actualizado; generándolo ahora…');
    const build = spawn(npm, ['run', 'build:preview'], { stdio: 'inherit', env: process.env });
    const code = await new Promise((resolve) => {
        build.on('error', () => resolve(1));
        build.on('exit', (value, signal) => resolve(value ?? (signal ? 1 : 0)));
    });
    if (code !== 0) process.exit(code);
}

const server = spawn(npm, ['exec', '--', 'vite', 'preview', '--host', '127.0.0.1', '--outDir', 'dist-preview'], {
    stdio: 'inherit',
    env: process.env,
});
server.on('error', (error) => {
    console.error(`No se pudo iniciar el servidor de preview: ${error.message}`);
    process.exitCode = 1;
});
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
