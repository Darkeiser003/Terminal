import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Atajo para iterar: conserva el mismo Vite build que `npm run build`, pero
// deja que `prebuild` omita las sondas de red. No se usa para publicar una
// release; las validaciones estrictas siguen en `npm run check`/`dist:*`.
const script = fileURLToPath(new URL('./build-frontend.mjs', import.meta.url));
const command = process.execPath;
const args = [script];
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
