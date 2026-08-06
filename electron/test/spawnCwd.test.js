const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { usableSpawnCwd, resolveSpawnCwd } = require('../main/spawnCwd');

const HOME = 'C:\\Users\\yo';

// fs simulado: solo las rutas declaradas existen, y solo como carpeta.
function fakeFs(directories, files) {
    return {
        statSync(target) {
            if ((directories || []).includes(target)) return { isDirectory: () => true };
            if ((files || []).includes(target)) return { isDirectory: () => false };
            const error = new Error('ENOENT');
            error.code = 'ENOENT';
            throw error;
        }
    };
}

test('una pestaña nueva hereda la carpeta de la que estaba en uso', () => {
    const opciones = { fs: fakeFs(['C:\\proyecto']) };
    assert.equal(usableSpawnCwd('C:\\proyecto', { transport: 'native' }, opciones), 'C:\\proyecto');
    // Git Bash y WSL reciben la misma ruta de Windows: la traducen ellos.
    assert.equal(usableSpawnCwd('C:\\proyecto', { transport: 'msys' }, opciones), 'C:\\proyecto');
    assert.equal(usableSpawnCwd('C:\\proyecto', { transport: 'wsl', distro: 'Ubuntu' }, opciones), 'C:\\proyecto');
});

test('no se hereda donde el sistema de archivos no es el mismo', () => {
    const opciones = { fs: fakeFs(['C:\\proyecto']) };
    assert.equal(usableSpawnCwd('C:\\proyecto', { transport: 'docker' }, opciones), null);
    assert.equal(usableSpawnCwd('C:\\proyecto', { transport: 'android' }, opciones), null);
});

test('las rutas UNC se descartan: cmd.exe no admite un directorio actual UNC', () => {
    const unc = '\\\\wsl$\\Ubuntu\\home\\yo';
    assert.equal(usableSpawnCwd(unc, { transport: 'native' }, { fs: fakeFs([unc]) }), null);
    assert.equal(usableSpawnCwd('\\\\servidor\\compartido', { transport: 'native' }, { fs: fakeFs(['\\\\servidor\\compartido']) }), null);
});

test('una carpeta que ya no existe, o que es un archivo, no se usa', () => {
    const opciones = { fs: fakeFs(['C:\\existe'], ['C:\\archivo.txt']) };
    assert.equal(usableSpawnCwd('C:\\borrada', { transport: 'native' }, opciones), null);
    assert.equal(usableSpawnCwd('C:\\archivo.txt', { transport: 'native' }, opciones), null);
    assert.equal(usableSpawnCwd('', { transport: 'native' }, opciones), null);
    assert.equal(usableSpawnCwd(null, { transport: 'native' }, opciones), null);
    assert.equal(usableSpawnCwd(42, { transport: 'native' }, opciones), null);
});

test('sin carpeta heredada se usa la del entorno y, si no, la personal', () => {
    const opciones = { fs: fakeFs(['C:\\proyecto']) };
    assert.equal(resolveSpawnCwd('C:\\proyecto', { transport: 'native' }, HOME, opciones), 'C:\\proyecto');
    assert.equal(resolveSpawnCwd(null, { transport: 'native' }, HOME, opciones), HOME);
    // Docker monta una carpeta concreta del host: manda esa, no la heredada.
    assert.equal(
        resolveSpawnCwd('C:\\proyecto', { transport: 'docker', initialHostCwd: 'C:\\Users\\yo' }, HOME, opciones),
        'C:\\Users\\yo'
    );
});

test('sobre el sistema de archivos real se comporta igual', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lterminal-cwd-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archivo = path.join(root, 'un-archivo.txt');
    fs.writeFileSync(archivo, '');
    assert.equal(usableSpawnCwd(root, { transport: 'native' }), root);
    assert.equal(usableSpawnCwd(archivo, { transport: 'native' }), null);
    assert.equal(usableSpawnCwd(path.join(root, 'no-existe'), { transport: 'native' }), null);
});
