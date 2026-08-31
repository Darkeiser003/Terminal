import { spawn } from 'node:child_process';

// Atajo para iterar: conserva el mismo Vite build que `npm run build`, pero
// deja que `prebuild` omita las sondas de red. No se usa para publicar una
// release; las validaciones estrictas siguen en `npm run check`/`dist:*`.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const command = process.platform === 'win32' ? 'cmd.exe' : npm;
const args = process.platform === 'win32' ? ['/d', '/s', '/c', `${npm} run build`] : ['run', 'build'];
const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, LTERMINAL_SKIP_CHECKS: '1' },
});

child.on('error', (error) => {
    console.error(`No se pudo iniciar el build rápido: ${error.message}`);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
});
