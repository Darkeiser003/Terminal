const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    listDirectory, createEntry, renameEntry, pasteEntry, availableCopyName, isInside,
    resolveChildPath, parentDirectory, isSafeEntryName
} = require('../main/fileExplorer');

function tempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lterminal-explorer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('un nombre nuevo es solo un nombre, nunca una ruta', () => {
    ['archivo.txt', 'carpeta nueva', '.oculto', 'a'.repeat(255)].forEach((name) => {
        assert.equal(isSafeEntryName(name), true, name);
    });
    [
        '', '   ', '.', '..', '../fuera', 'sub/dir', 'sub\\dir', 'C:\\Windows',
        'con', 'CON.txt', 'aux', 'lpt1',
        'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b',
        'tab\tdentro', 'salto\ndentro', 'nulo\u0000dentro', 'del\u007f',
        'a'.repeat(256), 42, null, undefined
    ].forEach((name) => {
        assert.equal(isSafeEntryName(name), false, JSON.stringify(name));
    });
});

test('resolver un hijo nunca sale de la carpeta mostrada', () => {
    assert.equal(resolveChildPath('C:\\base', '..\\otro'), null);
    assert.equal(resolveChildPath('C:\\base', '../otro'), null);
    assert.equal(resolveChildPath('C:\\base', 'sub\\hijo.txt'), null);
    assert.equal(resolveChildPath('C:\\base', 'hijo.txt'), 'C:\\base\\hijo.txt');
    assert.equal(resolveChildPath('/home/u', 'hijo.txt'), path.resolve('/home/u', 'hijo.txt'));
    assert.equal(resolveChildPath('', 'hijo.txt'), null);
});

test('la carpeta superior se detiene en la raíz', () => {
    assert.equal(parentDirectory('C:\\base\\sub'), 'C:\\base');
    assert.equal(parentDirectory('C:\\'), null);
    assert.equal(parentDirectory('/'), null);
});

test('el listado separa carpetas de archivos y no sigue enlaces al ordenar', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lterminal-explorer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'zeta-dir'));
    fs.mkdirSync(path.join(root, 'alfa-dir'));
    fs.writeFileSync(path.join(root, 'beta.txt'), 'hola');
    fs.writeFileSync(path.join(root, '.oculto'), '');

    const result = listDirectory(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries.map((e) => e.name), ['alfa-dir', 'zeta-dir', '.oculto', 'beta.txt']);
    assert.deepEqual(result.entries.map((e) => e.kind), ['directory', 'directory', 'file', 'file']);
    assert.equal(result.entries.find((e) => e.name === '.oculto').hidden, true);
    assert.equal(result.entries.find((e) => e.name === 'beta.txt').size, 4);
    assert.equal(result.parent, parentDirectory(root));
});

test('listar algo que no existe informa en vez de lanzar', () => {
    const missing = listDirectory(path.join(os.tmpdir(), 'no-existe-' + Date.now()));
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'La carpeta ya no existe.');
    assert.deepEqual(missing.entries, []);
    assert.equal(listDirectory('').ok, false);
});

test('crear archivo y carpeta, sin sobrescribir nunca lo que ya existe', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lterminal-explorer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.equal(createEntry(root, 'nueva-carpeta', 'directory').ok, true);
    assert.equal(fs.statSync(path.join(root, 'nueva-carpeta')).isDirectory(), true);

    assert.equal(createEntry(root, 'notas.md', 'file').ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'notas.md'), 'utf8'), '');

    // Un archivo con contenido no puede quedar vacío por volver a crearlo.
    fs.writeFileSync(path.join(root, 'notas.md'), 'contenido importante');
    const repetido = createEntry(root, 'notas.md', 'file');
    assert.equal(repetido.ok, false);
    assert.match(repetido.error, /Ya existe/);
    assert.equal(fs.readFileSync(path.join(root, 'notas.md'), 'utf8'), 'contenido importante');

    const escape = createEntry(root, '../fuera.txt', 'file');
    assert.equal(escape.ok, false);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'fuera.txt')), false);
});

test('renombrar se queda dentro de la carpeta y no pisa lo que ya está', (t) => {
    const root = tempRoot(t);
    fs.writeFileSync(path.join(root, 'notas.md'), 'contenido');
    fs.writeFileSync(path.join(root, 'ocupado.md'), 'otro');

    assert.equal(renameEntry(root, path.join(root, 'notas.md'), 'apuntes.md').ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'apuntes.md'), 'utf8'), 'contenido');

    // Un nombre nuevo es SOLO un nombre: nada de rutas ni de "..".
    ['../fuera.md', 'sub/otro.md', '..'].forEach((name) => {
        assert.equal(renameEntry(root, path.join(root, 'apuntes.md'), name).ok, false, name);
    });
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'fuera.md')), false);

    // Y no se sobrescribe lo que ya existe.
    const choque = renameEntry(root, path.join(root, 'apuntes.md'), 'ocupado.md');
    assert.equal(choque.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'ocupado.md'), 'utf8'), 'otro');

    // Renombrar algo de OTRA carpeta se rechaza aunque el nombre sea válido.
    const fuera = path.join(path.dirname(root), 'ajeno.md');
    fs.writeFileSync(fuera, 'x');
    t.after(() => fs.rmSync(fuera, { force: true }));
    assert.equal(renameEntry(root, fuera, 'traido.md').ok, false);
    assert.equal(fs.existsSync(fuera), true);
});

test('copiar busca un nombre libre y cortar mueve de verdad', (t) => {
    const root = tempRoot(t);
    const origen = path.join(root, 'origen');
    const destino = path.join(root, 'destino');
    fs.mkdirSync(origen);
    fs.mkdirSync(destino);
    fs.writeFileSync(path.join(origen, 'notas.md'), 'contenido');

    // Copiar a otra carpeta conserva el nombre.
    const copia = pasteEntry(path.join(origen, 'notas.md'), destino, false);
    assert.equal(copia.ok, true);
    assert.equal(copia.name, 'notas.md');
    assert.equal(fs.readFileSync(path.join(destino, 'notas.md'), 'utf8'), 'contenido');
    assert.equal(fs.existsSync(path.join(origen, 'notas.md')), true, 'copiar no borra el origen');

    // Copiar otra vez no sobrescribe: busca un nombre libre.
    const otra = pasteEntry(path.join(origen, 'notas.md'), destino, false);
    assert.equal(otra.ok, true);
    assert.equal(otra.name, 'notas (copia).md');
    assert.equal(otra.renamed, true);
    assert.equal(fs.readFileSync(path.join(destino, 'notas.md'), 'utf8'), 'contenido');

    // Cortar sí mueve.
    const movido = pasteEntry(path.join(origen, 'notas.md'), destino, true);
    assert.equal(movido.ok, false, 'no se mueve encima de un nombre ocupado');
    fs.rmSync(path.join(destino, 'notas.md'));
    assert.equal(pasteEntry(path.join(origen, 'notas.md'), destino, true).ok, true);
    assert.equal(fs.existsSync(path.join(origen, 'notas.md')), false);
    assert.equal(fs.readFileSync(path.join(destino, 'notas.md'), 'utf8'), 'contenido');
});

test('una carpeta no se puede pegar dentro de sí misma', (t) => {
    const root = tempRoot(t);
    const padre = path.join(root, 'padre');
    const hijo = path.join(padre, 'hijo');
    fs.mkdirSync(hijo, { recursive: true });
    fs.writeFileSync(path.join(padre, 'dato.txt'), 'x');

    assert.equal(isInside(padre, hijo, path), true);
    assert.equal(isInside(hijo, padre, path), false);

    const dentroDeSi = pasteEntry(padre, hijo, false);
    assert.equal(dentroDeSi.ok, false);
    assert.match(dentroDeSi.error, /dentro de sí misma/);
    // Y la copia recursiva normal sí funciona, con su contenido.
    const destino = path.join(root, 'destino');
    fs.mkdirSync(destino);
    assert.equal(pasteEntry(padre, destino, false).ok, true);
    assert.equal(fs.readFileSync(path.join(destino, 'padre', 'dato.txt'), 'utf8'), 'x');
});

test('el nombre de copia respeta la extensión y los archivos que empiezan por punto', (t) => {
    const root = tempRoot(t);
    fs.writeFileSync(path.join(root, 'notas.md'), '');
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    fs.writeFileSync(path.join(root, 'sinextension'), '');

    assert.equal(availableCopyName(root, 'notas.md'), 'notas (copia).md');
    assert.equal(availableCopyName(root, '.gitignore'), '.gitignore (copia)');
    assert.equal(availableCopyName(root, 'sinextension'), 'sinextension (copia)');

    fs.writeFileSync(path.join(root, 'notas (copia).md'), '');
    assert.equal(availableCopyName(root, 'notas.md'), 'notas (copia 2).md');
});

test('pegar algo que ya no existe informa en vez de romperse', (t) => {
    const root = tempRoot(t);
    const result = pasteEntry(path.join(root, 'fantasma.txt'), root, false);
    assert.equal(result.ok, false);
    assert.match(result.error, /ya no existe/);
    assert.equal(pasteEntry('', root, false).ok, false);
});
