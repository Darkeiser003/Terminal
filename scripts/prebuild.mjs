import { spawn } from 'node:child_process';
import process from 'node:process';

const skipChecks = /^(1|true|yes|si|sí)$/i.test(process.env.LTERMINAL_SKIP_CHECKS ?? '');

function run(command, args) {
    return new Promise((resolve, reject) => {
        // npm.cmd es un script por lotes, no un ejecutable PE. Invocarlo a
        // través de cmd.exe mantiene compatibilidad con Windows sin activar
        // `shell: true` (deprecado por Node). Los argumentos de estos scripts
        // son constantes del proyecto y se citan si contienen espacios.
        const quote = (value) => /[\s"&()^<>|]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
        const child = process.platform === 'win32'
            ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quote).join(' ')], { stdio: 'inherit' })
            : spawn(command, args, { stdio: 'inherit' });
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
