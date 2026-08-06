const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    listScripts, FILE_FILTERS, normalizeHereDepth,
    DEFAULT_HERE_DEPTH, MAX_HERE_DEPTH
} = require('../main/scriptLauncher');

test('Aquí omite dependencias/artefactos y conserva scripts con intención ejecutable', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winslim-here-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deploy.ps1'), 'Write-Host ok\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("source")\n');
    fs.writeFileSync(path.join(root, 'cli.js'), 'console.log("bin")\n');
    fs.writeFileSync(path.join(root, 'run-with-shebang'), '#!/usr/bin/env bash\necho ok\n');
    fs.writeFileSync(path.join(root, 'scripts', 'release.js'), 'console.log("release")\n');
    fs.writeFileSync(path.join(root, 'scripts', 'deploy.zsh'), '#!/usr/bin/env zsh\necho ok\n');
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'dependency.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(root, 'dist', 'bundled.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { tool: './cli.js' } }));

    const names = listScripts(root, 3, { scope: 'here' }).map((script) => script.name).sort();
    assert.deepEqual(names, ['cli.js', 'deploy.ps1', 'deploy.zsh', 'release.js', 'run-with-shebang']);
    assert.ok(!names.includes('app.js'));
    assert.ok(!names.includes('dependency.cmd'));
    assert.ok(!names.includes('bundled.sh'));

    const libraryNames = listScripts(root, 3).map((script) => script.name);
    assert.ok(libraryNames.includes('app.js'), 'la Biblioteca explícita mantiene runtimes sin shebang');
});

test('los filtros opt-in separan scripts, programas y contenido multimedia', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winslim-types-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'theme'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(root, 'tool.exe'), 'not-a-real-exe');
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(root, 'assets', 'cover.png'), 'png');
    fs.writeFileSync(path.join(root, 'assets', 'song.mp3'), 'mp3');
    fs.writeFileSync(path.join(root, 'node_modules', 'theme', 'hidden.png'), 'png');

    assert.deepEqual(listScripts(root, 3, { scope: 'here' }).map((item) => item.name), ['run.cmd']);

    const optional = listScripts(root, 3, {
        scope: 'here',
        categories: ['program', 'html', 'image', 'audio']
    });
    assert.deepEqual(optional.map((item) => item.name).sort(), ['cover.png', 'index.html', 'song.mp3', 'tool.exe']);
    assert.equal(optional.find((item) => item.name === 'cover.png').openable, true);
    assert.equal(optional.find((item) => item.name === 'tool.exe').runnable, true);
    assert.ok(!optional.some((item) => item.name === 'hidden.png'));
    assert.ok(FILE_FILTERS.some((filter) => filter.id === 'video' && filter.default === false));
});

test('Aquí respeta una profundidad configurable y la limita a un rango seguro', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winslim-depth-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, 'one', 'two', 'three', 'four');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'docker-manager.sh'), '#!/bin/bash\necho ok\n');

    assert.ok(!listScripts(root, 3, { scope: 'here' }).some((item) => item.name === 'docker-manager.sh'));
    const atFour = listScripts(root, 4, { scope: 'here' });
    assert.ok(atFour.some((item) => item.name === 'docker-manager.sh'));
    assert.equal(atFour.scanInfo.depth, 4);
    assert.equal(normalizeHereDepth(undefined), DEFAULT_HERE_DEPTH);
    assert.equal(normalizeHereDepth(999), MAX_HERE_DEPTH);
    assert.equal(normalizeHereDepth(-4), 0);
});
