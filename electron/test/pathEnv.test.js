const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findUnixExecutable } = require('../main/pathEnv');

test('detecta binarios Linux recorriendo PATH sin depender del comando which', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lterminal-path-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const docker = path.join(root, 'docker');
    fs.writeFileSync(docker, '#!/bin/sh\n');
    fs.chmodSync(docker, 0o755);
    // El temporal de Windows empieza por "C:", que es justo el separador de
    // PATH de Unix: se usa el del sistema donde corre la prueba para que la
    // búsqueda se ejercite igual en Linux y en Windows.
    const separator = path.delimiter;
    const missing = path.join(root, 'sin-resultados');
    assert.equal(findUnixExecutable('docker', `${missing}${separator}${root}`, fs, separator), docker);
    assert.equal(findUnixExecutable('not-installed', root, fs, separator), null);
});

test('el separador por defecto sigue siendo el de Unix', () => {
    const probed = [];
    const fakeFs = {
        accessSync(candidate) { probed.push(candidate); throw new Error('no ejecutable'); },
        statSync() { throw new Error('no existe'); }
    };
    assert.equal(findUnixExecutable('docker', '/una:/dos', fakeFs), null);
    assert.deepEqual(probed, [path.join('/una', 'docker'), path.join('/dos', 'docker')]);
});
