const test = require('node:test');
const assert = require('node:assert/strict');
const {
    suggestViewer, viewerCategoryFor, VIEWER_CATEGORIES,
    fileManagersFor, fileManagerChoices, fileManagerById
} = require('../main/fileViewers');
const { getInstallActions } = require('../main/installActions');

test('clasifica las extensiones por tipo de contenido', () => {
    assert.equal(viewerCategoryFor('.svg'), 'image');
    assert.equal(viewerCategoryFor('.PNG'), 'image');
    assert.equal(viewerCategoryFor('.mkv'), 'video');
    assert.equal(viewerCategoryFor('.flac'), 'audio');
    assert.equal(viewerCategoryFor('.pdf'), 'document');
    assert.equal(viewerCategoryFor('.7z'), 'archive');
    assert.equal(viewerCategoryFor('.rs'), 'code');
    assert.equal(viewerCategoryFor('.desconocida'), null);
    assert.equal(viewerCategoryFor(''), null);
    assert.equal(viewerCategoryFor(null), null);
});

test('una extensión pertenece a una sola categoría', () => {
    const vistas = new Map();
    Object.keys(VIEWER_CATEGORIES).forEach((categoria) => {
        VIEWER_CATEGORIES[categoria].extensions.forEach((ext) => {
            assert.equal(vistas.has(ext), false, `${ext} está en ${vistas.get(ext)} y en ${categoria}`);
            vistas.set(ext, categoria);
        });
    });
});

test('el ejemplo del usuario: un .svg en Windows propone ImageGlass', () => {
    const sugerencia = suggestViewer('.svg', 'win32');
    assert.equal(sugerencia.app, 'ImageGlass');
    assert.equal(sugerencia.actionId, 'viewer-image');
    assert.equal(sugerencia.categoryLabel, 'imágenes');
});

test('no se propone nada donde el sistema ya trae visor', () => {
    // macOS abre imágenes y PDF con Vista Previa.
    assert.equal(suggestViewer('.png', 'darwin'), null);
    assert.equal(suggestViewer('.pdf', 'darwin'), null);
    assert.equal(suggestViewer('.mp4', 'darwin').app, 'VLC');
    assert.equal(suggestViewer('.desconocida', 'win32'), null);
});

test('cada visor sugerido existe de verdad en el catálogo de acciones', () => {
    [['win32', 'win32'], ['linux', 'linux'], ['darwin', 'darwin']].forEach(([platform]) => {
        const ids = new Set(getInstallActions({ platform, pkgManager: 'apt', wsl: null }).map((a) => a.id));
        Object.keys(VIEWER_CATEGORIES).forEach((categoria) => {
            const ext = VIEWER_CATEGORIES[categoria].extensions[0];
            const sugerencia = suggestViewer(ext, platform);
            if (!sugerencia) return;
            assert.ok(ids.has(sugerencia.actionId), `${platform}: falta la acción ${sugerencia.actionId}`);
        });
    });
});

test('los visores de escritorio de Windows no fingen detección por PATH', () => {
    const porId = new Map(getInstallActions({ platform: 'win32', pkgManager: null, wsl: null }).map((a) => [a.id, a]));
    ['viewer-image', 'viewer-media', 'viewer-document', 'viewer-archive'].forEach((id) => {
        assert.equal(porId.get(id).checkCmd, null, id);
        assert.equal(porId.get(id + '-uninstall').requiresCmd, null, id);
        assert.match(porId.get(id + '-version').command, /winget list --id/, id);
    });
    // VS Code sí deja `code` en el PATH: ahí la detección sigue aplicándose.
    assert.equal(porId.get('viewer-code').checkCmd, 'code');
});

// ---- Abrir una carpeta en el gestor del sistema ----

test('Windows y macOS siempre tienen gestor de archivos; Linux depende del escritorio', () => {
    assert.equal(fileManagersFor('win32').length, 1);
    assert.equal(fileManagersFor('darwin')[0].app, 'Finder');
    assert.ok(fileManagersFor('linux').length >= 3);

    // Con un escritorio GNOME instalado se abre sin preguntar nada más.
    const gnome = fileManagerChoices('linux', (cmd) => cmd === 'nautilus');
    assert.deepEqual(gnome.installed.map((manager) => manager.id), ['nautilus']);
    assert.ok(!gnome.installable.some((manager) => manager.id === 'nautilus'));

    // Sistema pelado: no hay con qué abrirla, así que hay que poder instalar.
    const vacio = fileManagerChoices('linux', () => false);
    assert.deepEqual(vacio.installed, []);
    assert.ok(vacio.installable.length >= 3);
    vacio.installable.forEach((manager) => {
        assert.ok(manager.actionId, `${manager.id} sin acción de instalación`);
    });

    // Varios instalados: se ofrecen todos para elegir.
    const varios = fileManagerChoices('linux', (cmd) => cmd === 'dolphin' || cmd === 'nemo');
    assert.deepEqual(varios.installed.map((manager) => manager.id).sort(), ['dolphin', 'nemo']);
});

test('cada gestor instalable existe en el catálogo de acciones de Linux', () => {
    const ids = new Set(getInstallActions({ platform: 'linux', pkgManager: 'pacman', wsl: null }).map((a) => a.id));
    fileManagerChoices('linux', () => false).installable.forEach((manager) => {
        assert.ok(ids.has(manager.actionId), `falta la acción ${manager.actionId}`);
    });
});

// El renderer manda un identificador, nunca la ruta de un ejecutable: main.js
// lo resuelve contra esta tabla antes de lanzar nada.
test('un gestor desconocido no se resuelve a ningún ejecutable', () => {
    assert.equal(fileManagerById('linux', 'nautilus').cmd, 'nautilus');
    assert.equal(fileManagerById('linux', '../../bin/sh'), null);
    assert.equal(fileManagerById('linux', ''), null);
    assert.equal(fileManagerById('linux', 'explorer'), null, 'no se cuela el gestor de otra plataforma');
});

test('ImageGlass se instala con el identificador oficial de winget', () => {
    const accion = getInstallActions({ platform: 'win32', pkgManager: null, wsl: null })
        .find((a) => a.id === 'viewer-image');
    assert.equal(accion.command, 'winget install --id DuongDieuPhap.ImageGlass -e');
    assert.equal(accion.group, 'Visores de archivos');
});
