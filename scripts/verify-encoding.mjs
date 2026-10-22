#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const textExtensions = new Set([
    '.rs', '.json', '.toml', '.mjs', '.js', '.ts', '.svelte', '.css', '.html',
    '.sh', '.ps1', '.cmd', '.bat', '.md', '.xml', '.in', '.gitignore', '.gitattributes',
]);
const noBomExtensions = new Set(['.rs', '.json', '.toml', '.mjs', '.js', '.ts', '.svelte', '.css', '.html', '.sh', '.cmd', '.bat', '.md', '.xml', '.in']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const errors = [];

function isTextFile(file) {
    return textExtensions.has(extname(file).toLowerCase()) || ['.gitignore', '.gitattributes'].includes(file);
}

function scanSourceFiles(directory = '.') {
    const ignoredDirectories = new Set(['.git', '.pnpm-store', 'node_modules', 'dist', 'target']);
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!ignoredDirectories.has(entry.name)) files.push(...scanSourceFiles(path));
        } else if (entry.isFile()) {
            const normalized = relative('.', path).split(sep).join('/');
            if (isTextFile(normalized)) files.push(normalized);
        }
    }
    return files;
}

const trackedFilesResult = spawnSync('git', ['ls-files', '-z'], { encoding: 'buffer', windowsHide: true });
// Los ZIP de fuentes y los workspaces exportados por algunos IDE no incluyen
// .git. En ese caso, recorrer solo el código fuente permite mantener el check
// útil sin inspeccionar node_modules, target ni los artefactos que genera.
const trackedFiles = trackedFilesResult.status === 0
    ? trackedFilesResult.stdout
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .filter(isTextFile)
    : scanSourceFiles();
const files = [...new Set([
    ...trackedFiles,
    'scripts/verify-encoding.mjs',
    'scripts/clean-repository.ps1',
    'scripts/clean-repository.sh',
    'build-tools/build.ps1',
    'build-tools/build.sh',
])];

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
