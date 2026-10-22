import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Ejecuta cargo/rustup aunque la terminal que lanzó npm no haya heredado
 * `%USERPROFILE%\\.cargo\\bin`. Los instaladores de Rust actualizan el PATH
 * persistente, pero una sesión ya abierta conserva el PATH antiguo; las
 * comprobaciones de formato no deberían depender de reiniciar esa sesión.
 */
const requested = process.argv[2];
if (!requested) {
    console.error('Uso: node scripts/run-rust-tool.mjs <cargo|rustup> [argumentos…]');
    process.exit(2);
}

const executable = platform() === 'win32' ? `${requested}.exe` : requested;
const candidates = [
    process.env[`LTERMINAL_${requested.toUpperCase()}_BIN`],
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', executable) : null,
    join(homedir(), '.cargo', 'bin', executable),
    executable,
].filter(Boolean);

let command = executable;
for (const candidate of candidates) {
    if (candidate === executable) {
        command = candidate;
        break;
    }
    try {
        await access(candidate, constants.X_OK);
        command = candidate;
        break;
    } catch {
        // Probar la siguiente ubicación conocida.
    }
}

const cargoBin = join(homedir(), '.cargo', 'bin');
if (command !== executable && !process.env.PATH?.split(delimiter).some((entry) => entry === cargoBin)) {
    process.env.PATH = [cargoBin, process.env.PATH].filter(Boolean).join(delimiter);
}

const child = spawn(command, process.argv.slice(3), {
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
});
child.on('error', (error) => {
    console.error(`No se encontró ${requested}. Se buscó también ${cargoBin}: ${error.message}`);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    process.exitCode = typeof code === 'number' ? code : 1;
    if (signal) console.error(`${requested} terminó por ${signal}`);
});
