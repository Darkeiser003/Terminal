import { spawn } from 'node:child_process';
import process from 'node:process';

const skipChecks = /^(1|true|yes|si|sí)$/i.test(process.env.LTERMINAL_SKIP_CHECKS ?? '');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
    console.warn('Build frontend: svelte-check omitido por LTERMINAL_SKIP_CHECKS=1.');
} else {
    await run(npmBin, ['exec', '--', 'svelte-check', '--tsconfig', './tsconfig.json']);
}
await run(npmBin, ['exec', '--', 'vite', 'build']);
