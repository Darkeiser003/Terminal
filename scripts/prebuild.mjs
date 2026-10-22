import { spawn } from 'node:child_process';
import process from 'node:process';
import { packageManager, packageManagerArgs } from './package-manager.mjs';

const controlVar = process.platform === 'win32' ? 'WTERMINAL_SKIP_CHECKS' : 'LTERMINAL_SKIP_CHECKS';
const skipChecks = /^(1|true|yes|si|sí)$/i.test(process.env[controlVar] ?? process.env.LTERMINAL_SKIP_CHECKS ?? '');
const manager = packageManager();
const managerBin = manager === 'pnpm'
    ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    : (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function run(args) {
    return new Promise((resolve, reject) => {
        // Los shims .cmd de Windows necesitan cmd.exe. Así se evita shell:true
        // y se conserva el comportamiento con npm o pnpm sin depender del
        // terminal que lanzó el build.
        const quote = (value) => /[\s"&()^<>|]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
        const commandArgs = packageManagerArgs(manager, args);
        const child = process.platform === 'win32'
            ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [managerBin, ...commandArgs].map(quote).join(' ')], { stdio: 'inherit' })
            : spawn(managerBin, commandArgs, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${managerBin} ${commandArgs.join(' ')} terminó con ${signal ?? `código ${code}`}`));
        });
    });
}

if (skipChecks) {
    console.warn(`Prebuild: comprobaciones externas omitidas por ${controlVar}=1.`);
    console.warn('Prebuild: se conserva únicamente la sincronización de metadatos necesaria para empaquetar.');
} else {
    await run(['run', 'check:workspace']);
    await run(['run', 'check:links']);
    await run(['run', 'check:install-sources']);
}

await run(['run', 'metadata:sync']);
