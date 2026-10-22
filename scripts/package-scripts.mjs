#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { packageManager } from './package-manager.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const scripts = Object.entries(packageJson.scripts).filter(([name]) => !/^(pre|post).+/.test(name));
const manager = packageManager();
const executable = manager === 'pnpm'
    ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    : (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function runScript(name, args = []) {
    if (!Object.hasOwn(packageJson.scripts, name)) {
        console.error(`No existe el script "${name}". Ejecuta "node scripts/package-scripts.mjs list" para verlos.`);
        return 2;
    }
    if (args[0] === '--') args = args.slice(1);
    const commandArgs = ['run', name, ...(args.length ? ['--', ...args] : [])];
    const result = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [executable, ...commandArgs].map(quote).join(' ')], { cwd: root, stdio: 'inherit' })
        : spawnSync(executable, commandArgs, { cwd: root, stdio: 'inherit' });
    return result.status ?? 1;
}

function quote(value) {
    return /[\s"&()^<>|]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

const [action = 'menu', name, ...args] = process.argv.slice(2);
if (action === 'list') {
    for (const [script, command] of scripts) console.log(`${script.padEnd(30)} ${command}`);
    process.exit(0);
}
if (action === 'run') process.exit(runScript(name, args));
if (action !== 'menu') {
    console.error('Uso: node scripts/package-scripts.mjs [menu|list|run <script> [argumentos...]]');
    process.exit(2);
}

const io = createInterface({ input: stdin, output: stdout });
try {
    let matching = scripts;
    while (true) {
        console.log(`\nScripts npm disponibles (${manager}; filtra escribiendo texto):`);
        matching.forEach(([script, command], index) => console.log(`  ${String(index + 1).padStart(2)}. ${script} — ${command}`));
        console.log('  0. Volver');
        const answer = (await io.question('Número o filtro: ')).trim();
        if (answer === '0') break;
        if (/^\d+$/.test(answer) && Number(answer) <= matching.length) {
            const selected = matching[Number(answer) - 1];
            if (selected) {
                const status = runScript(selected[0]);
                console.log(status === 0 ? '\nCompletado.' : `\nEl script terminó con código ${status}.`);
                await io.question('Pulsa Enter para volver a la lista…');
            }
        } else {
            const query = answer.toLocaleLowerCase();
            matching = scripts.filter(([script, command]) => `${script} ${command}`.toLocaleLowerCase().includes(query));
            if (!matching.length) {
                console.log('No hay scripts que coincidan.');
                matching = scripts;
            }
        }
    }
} finally {
    io.close();
}
