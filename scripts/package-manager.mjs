import { spawnSync } from 'node:child_process';
import process from 'node:process';

function commandExists(command) {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which';
    return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

export function packageManager() {
    const userAgent = process.env.npm_config_user_agent ?? '';
    if (/^pnpm\//i.test(userAgent)) return 'pnpm';
    if (/^npm\//i.test(userAgent)) return 'npm';

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    if (commandExists(npmCommand)) return 'npm';
    if (commandExists(pnpmCommand)) return 'pnpm';
    throw new Error('No se encontró npm ni pnpm en el PATH.');
}

export function packageManagerArgs(manager, args) {
    if (manager === 'pnpm' && args[0] === 'exec' && args[1] === '--') {
        return [args[0], ...args.slice(2)];
    }
    return args;
}
