#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const index = fileURLToPath(new URL('../dist-preview/index.html', import.meta.url));
const builder = fileURLToPath(new URL('./build-preview.mjs', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
// pnpm/npm conservan el separador `--` al ejecutar un script en algunos
// shells. No es un argumento de Vite y, si se reenvía, puede hacer que los
// argumentos siguientes (por ejemplo `--port`) se ignoren.
const forwardedArgs = process.argv.slice(2).filter((argument) => argument !== '--');
const forceBuild = forwardedArgs.includes('--build');
const viteArgs = forwardedArgs.filter((argument) => argument !== '--build');

async function runNode(script, args, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
}

if (forceBuild) {
    const code = await runNode(builder, []);
    if (code !== 0) process.exit(code);
} else {
    try {
        await access(index);
    } catch {
        console.log('No existe el preview compilado; generándolo ahora…');
        const code = await runNode(builder, []);
        if (code !== 0) process.exit(code);
    }
}

const server = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', ...viteArgs], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_OUT_DIR: 'dist-preview' },
});
server.once('error', (error) => {
    console.error(`No se pudo iniciar el servidor de preview: ${error.message}`);
    process.exitCode = 1;
});
server.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
