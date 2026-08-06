const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// El renderer es una IIFE sin exports (se carga tal cual en el navegador de
// Electron, sin bundler). Para probar una función PURA de dentro se extrae su
// código y se evalúa: así se prueba la implementación real, no una copia que
// puede quedarse desfasada.
function extraerFuncion(fuente, nombre) {
    const inicio = fuente.indexOf(`function ${nombre}(`);
    assert.notEqual(inicio, -1, `no se encontró ${nombre} en renderer.js`);
    let profundidad = 0;
    let i = fuente.indexOf('{', inicio);
    const abre = i;
    for (; i < fuente.length; i += 1) {
        if (fuente[i] === '{') profundidad += 1;
        else if (fuente[i] === '}') {
            profundidad -= 1;
            if (profundidad === 0) break;
        }
    }
    assert.ok(i > abre, `no se pudo delimitar ${nombre}`);
    // eslint-disable-next-line no-new-func
    return new Function(`${fuente.slice(inicio, i + 1)}; return ${nombre};`)();
}

test('actualizar desde la release elige el archivo de este sistema', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
    const pickPlatformAsset = extraerFuncion(renderer, 'pickPlatformAsset');

    // Los nombres reales de la release del proyecto.
    const assets = [
        { name: 'LTerminal-AppImage-Latest-x64.x86.tar.gz', size: 319 * 1024 * 1024 },
        { name: 'WinSlimTerminal-Latest.zip', size: 129 * 1024 * 1024 }
    ];
    assert.equal(pickPlatformAsset(assets, 'win32').name, 'WinSlimTerminal-Latest.zip');
    assert.equal(pickPlatformAsset(assets, 'linux').name, 'LTerminal-AppImage-Latest-x64.x86.tar.gz');

    // Un .zip de Linux no se ofrece en Windows por llamarse .zip: el nombre
    // dice de quién es.
    assert.equal(pickPlatformAsset([{ name: 'app-linux-x64.zip', size: 10 }], 'win32'), null);
    assert.equal(pickPlatformAsset([{ name: 'setup.exe', size: 10 }], 'linux'), null);

    // Entre varios candidatos válidos gana el binario, no las notas ni la
    // huella suelta.
    const conRuido = [
        { name: 'WinSlimTerminal-Latest.zip.sha256', size: 64 },
        { name: 'WinSlimTerminal-Latest.zip', size: 129 * 1024 * 1024 }
    ];
    assert.equal(pickPlatformAsset(conRuido, 'win32').name, 'WinSlimTerminal-Latest.zip');

    // Sin adjuntos, o sin ninguno para este sistema, devuelve null y la
    // interfaz lo explica en vez de descargar algo a ciegas.
    assert.equal(pickPlatformAsset([], 'win32'), null);
    assert.equal(pickPlatformAsset(null, 'win32'), null);
    assert.equal(pickPlatformAsset(assets, 'sunos'), null);
    assert.equal(pickPlatformAsset([{ name: 'notas.txt', size: 10 }], 'win32'), null);

    // Y el botón existe de verdad en la tarjeta, separado del de código fuente.
    assert.match(renderer, /projects\.updateRelease/);
    assert.match(renderer, /projects\.updateSource/);
    assert.match(renderer, /updateFromLatestRelease\(repo, releaseUpdateBtn\)/);
});

test('el menú contextual intercepta a xterm antes de que desplace su textarea', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
    assert.match(renderer, /addEventListener\('contextmenu',[\s\S]*?stopImmediatePropagation\(\)[\s\S]*?}, true\)/);
    assert.match(renderer, /scrollOnUserInput:\s*true/);
    assert.match(renderer, /new ResizeObserver\(scheduleFit\)/);
});

test('las listas son configurables, cerradas por defecto y exclusivas', () => {
    const root = path.join(__dirname, '..');
    const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
    const preferences = require('../main/preferences').sanitizePreferences({});
    assert.equal(preferences.autoOpenFirstGroup, false);
    assert.equal(preferences.exclusiveAccordionGroups, true);
    assert.match(renderer, /configureAccordion\(group, depsPanel, groupIndex\)/);
    assert.match(renderer, /configureAccordion\(group, scriptsList, groupIndex\)/);
    // Al abrir una lista se cierran solo las hermanas: cerrar «todo lo que no
    // sea yo» plegaría el grupo padre al abrir uno de sus subgrupos.
    assert.match(renderer, /other === group \|\| other\.contains\(group\) \|\| group\.contains\(other\)/);
    assert.match(renderer, /configureAccordion\(sub, group, entryIndex\)/);
    assert.doesNotMatch(renderer, /safeFit\(/);
});

test('cambiar de entorno muestra un aviso en movimiento, no un texto fijo', () => {
    const root = path.join(__dirname, '..');
    const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'renderer', 'style.css'), 'utf8');

    // El aviso se pone al elegir el entorno, sin esperar al proceso principal.
    assert.match(renderer, /showPaneLoading\(tabId, selectedOption/);
    assert.match(renderer, /'Cargando a: '/);
    // Y se retira solo: al limpiar la shell, con la primera salida, si el
    // proceso termina, si el cambio falla o al cerrar la pestaña.
    assert.match(renderer, /notePaneOutput\(tabId, true\)/);
    assert.match(renderer, /notePaneOutput\(tabId, false\)/);
    assert.match(renderer, /hidePaneLoading\(tabId\)/);
    // Ya no queda el mensaje estático anterior.
    assert.doesNotMatch(renderer, /Entorno cambiado a/);

    // Giro y barra indeterminada, con respeto por quien reduce el movimiento.
    assert.match(css, /@keyframes pane-loading-spin/);
    assert.match(css, /@keyframes pane-loading-sweep/);
    assert.match(css, /@keyframes pane-loading-pulse/);
    const reducido = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.ok(reducido.length > 0, 'debe contemplar el movimiento reducido');
    // Con movimiento reducido el aviso late, no se apaga: una barra quieta y
    // llena parecería que el proceso ya terminó.
    assert.match(reducido.slice(0, 400), /animation: pane-loading-pulse/);
    assert.doesNotMatch(reducido.slice(0, 400), /animation: none/);
    assert.doesNotMatch(reducido.slice(0, 400), /width: 100%/);
    // El panel debe ser el ancla del aviso, o se colocaría sobre la rejilla.
    assert.match(css, /\.tab-pane \{\s*display: none;\s*position: relative;/);
});

test('la simulación del acordeón anidado no pliega el grupo padre', () => {
    // Réplica de configureAccordion sobre un DOM mínimo simulado, para
    // comprobar la regla sin arrancar Electron.
    function nodo(hijos) {
        const n = { open: false, hijos: hijos || [] };
        n.contains = (otro) => otro === n || n.hijos.some((h) => h.contains(otro));
        return n;
    }
    const sub1 = nodo();
    const sub2 = nodo();
    const grupoA = nodo([sub1, sub2]);
    const grupoB = nodo();
    const todos = [grupoA, sub1, sub2, grupoB];

    function abrir(group) {
        group.open = true;
        todos.forEach((other) => {
            if (other === group || other.contains(group) || group.contains(other)) return;
            other.open = false;
        });
    }

    abrir(grupoA);
    abrir(sub1);
    assert.equal(grupoA.open, true, 'el grupo padre sigue abierto');
    assert.equal(sub1.open, true);
    assert.equal(grupoB.open, false, 'el otro grupo se cierra');

    abrir(sub2);
    assert.equal(grupoA.open, true, 'el padre sigue abierto al cambiar de subgrupo');
    assert.equal(sub1.open, false, 'el subgrupo hermano se cierra');
    assert.equal(sub2.open, true);
});

test('los ajustes visuales se aplican a todas las terminales y muestran créditos', () => {
    const root = path.join(__dirname, '..');
    const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
    assert.match(renderer, /term\.options\.theme = THEME/);
    assert.match(renderer, /term\.options\.fontFamily = activeFontCss\(\)/);
    assert.match(renderer, /settingsDevelopers/);
    assert.match(renderer, /Desarrollador/);
    assert.match(html, /data-settings-section="appearance"/);
    assert.match(html, /data-settings-section="about"/);
    assert.match(html, /id="settings-show-banner"/);
});
