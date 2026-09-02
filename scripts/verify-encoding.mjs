#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const textExtensions = new Set([
    '.rs', '.json', '.toml', '.mjs', '.js', '.ts', '.svelte', '.css', '.html',
    '.sh', '.ps1', '.cmd', '.bat', '.md', '.xml', '.in', '.gitignore', '.gitattributes',
]);
const noBomExtensions = new Set(['.rs', '.json', '.toml', '.mjs', '.js', '.ts', '.svelte', '.css', '.html', '.sh', '.cmd', '.bat', '.md', '.xml', '.in']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const errors = [];

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file) => textExtensions.has(extname(file).toLowerCase()) || ['.gitignore', '.gitattributes'].includes(file));
const files = [...new Set([...trackedFiles, 'scripts/verify-encoding.mjs', 'scripts/clean-repository.ps1', 'scripts/clean-repository.sh'])];

for (const file of files) {
    if (!existsSync(file)) continue; // Borrados intencionalmente antes del commit.
    const bytes = readFileSync(file);
    const hasBom = bytes.subarray(0, 3).equals(bom);
    const isPowerShell = file.endsWith('.ps1') || file.endsWith('.ps1.in');
    try {
        utf8.decode(hasBom ? bytes.subarray(3) : bytes);
    } catch {
        errors.push(`${file}: no es UTF-8 válido (ANSI no está permitido)`);
        continue;
    }
    if (isPowerShell && !hasBom) errors.push(`${file}: PowerShell debe ser UTF-8 con BOM para Windows PowerShell 5`);
    if (!isPowerShell && (noBomExtensions.has(extname(file).toLowerCase()) || ['.gitignore', '.gitattributes'].includes(file)) && hasBom) errors.push(`${file}: debe ser UTF-8 sin BOM`);
    if (file.endsWith('.bat') || file.endsWith('.cmd')) {
        if (bytes.some((byte) => byte > 0x7f)) errors.push(`${file}: cmd/bat debe permanecer ASCII; delega Unicode en PowerShell o cmd con chcp 65001`);
    }
}

const aliases = readFileSync('src-tauri/src/terminal/aliases.rs', 'utf8');
const sessions = readFileSync('src-tauri/src/terminal/session_files.rs', 'utf8');
if (!aliases.includes('@chcp 65001>nul')) errors.push('cmd no activa UTF-8 antes de leer ayuda y banner');
if (!aliases.includes('Get-Content -Raw -Encoding UTF8')) errors.push('PowerShell no fuerza UTF-8 al leer ayuda y banner');
if (sessions.includes('to_console_ascii')) errors.push('La sesión todavía degrada Unicode a ASCII');
if (!sessions.includes('write_init_script') || !sessions.includes('0xEF, 0xBB, 0xBF')) errors.push('Los init .ps1 temporales no reciben BOM UTF-8');

if (errors.length) {
    console.error(['Codificación inválida:', ...errors.map((error) => `- ${error}`)].join('\n'));
    process.exit(1);
}
console.log(`Codificación verificada: ${files.length} textos UTF-8; PowerShell con BOM, el resto sin BOM.`);
