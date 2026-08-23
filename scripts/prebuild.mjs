import { spawn } from 'node:child_process';
import process from 'node:process';

const skipChecks = /^(1|true|yes|si|sí)$/i.test(process.env.LTERMINAL_SKIP_CHECKS ?? '');

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} ${args.join(' ')} terminó con ${signal ?? `código ${code}`}`));
        });
    });
}

if (skipChecks) {
    console.warn('Prebuild: comprobaciones externas omitidas por LTERMINAL_SKIP_CHECKS=1.');
    console.warn('Prebuild: se conserva únicamente la sincronización de metadatos necesaria para empaquetar.');
} else {
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check:workspace']);
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check:links']);
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check:install-sources']);
}

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'metadata:sync']);
