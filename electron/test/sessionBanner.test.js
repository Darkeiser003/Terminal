const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { transportLoadsHostFiles, buildInitScript } = require('../main/aliasProfiles');

// El banner («fastfetch» de systemInfo.js) llega por dos caminos distintos
// según el entorno, y esa diferencia es la que provocaba que faltara en unos
// sitios sí y en otros no.
test('quién imprime el banner depende del transporte, no de la shell', () => {
    // Shells que sí ven los temporales del host: el banner lo imprime la
    // propia shell al cargar su archivo de inicialización.
    ['native', 'wsl', undefined].forEach((transport) => {
        assert.equal(transportLoadsHostFiles(transport), true, String(transport));
    });
    // Contenedor, móvil y prefijo de Wine: ahí no hay archivo que cargar, y el
    // banner tiene que escribirlo la aplicación en el xterm.
    ['docker', 'android', 'wine'].forEach((transport) => {
        assert.equal(transportLoadsHostFiles(transport), false, transport);
    });

    // Y la shell de un móvil no es de ninguna familia conocida: aunque llegara
    // a pedirse, no se genera inicialización para ella.
    assert.equal(buildInitScript('android', {}), null);
});

/* El fallo: al cambiar de entorno, main.js enviaba `env-changed` DESPUÉS de
 * arrancar la sesión nueva. El renderer hace term.reset() al recibirlo, así
 * que borraba el banner que spawnPtyForTab acababa de escribir. Solo se
 * notaba en Docker, ADB y Wine: en las demás shells el banner llega mucho
 * después, impreso por la shell, y el reset ya había pasado.
 */
test('el aviso de cambio de entorno no puede borrar el banner de la sesión nueva', () => {
    // Renderer mínimo con las dos reacciones que importan.
    function crearPanel() {
        const pantalla = [];
        return {
            pantalla,
            onData: (texto) => pantalla.push(texto),
            onEnvironmentChanged: () => { pantalla.length = 0; }
        };
    }

    // Proceso principal: el orden entre avisar y arrancar es la variable.
    function cambiarEntorno(panel, transport, avisarPrimero) {
        const arrancar = () => {
            if (!transportLoadsHostFiles(transport)) panel.onData('BANNER');
            // Una shell con inicialización imprime su banner mucho más tarde,
            // cuando ya se ha procesado todo lo pendiente.
            else setTimeout(() => panel.onData('BANNER'), 0);
        };
        if (avisarPrimero) {
            panel.onEnvironmentChanged();
            arrancar();
        } else {
            arrancar();
            panel.onEnvironmentChanged();
        }
    }

    // Reproduce el fallo con el orden antiguo...
    const roto = crearPanel();
    cambiarEntorno(roto, 'android', false);
    assert.deepEqual(roto.pantalla, [], 'el orden antiguo tenía que perder el banner');

    // ...y con el orden nuevo el banner sobrevive en los tres transportes.
    ['android', 'docker', 'wine'].forEach((transport) => {
        const panel = crearPanel();
        cambiarEntorno(panel, transport, true);
        assert.deepEqual(panel.pantalla, ['BANNER'], transport);
    });
});

test('main.js avisa del cambio de entorno antes de arrancar la sesión nueva', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const handler = main.slice(main.indexOf("ipcMain.handle('env:switch'"));
    const cuerpo = handler.slice(0, handler.indexOf('\n});'));

    const aviso = cuerpo.indexOf('sendEnvChanged(ws, tabId, env)');
    const arranque = cuerpo.indexOf('spawnPtyForTab(ws, tab, env');
    assert.ok(aviso !== -1 && arranque !== -1, 'el handler debe avisar y arrancar');
    assert.ok(aviso < arranque, 'env-changed tiene que salir antes que el pty nuevo');

    // Y si el entorno nuevo no arranca, el renderer tiene que enterarse de que
    // se vuelve al anterior: si no, la pestaña se quedaría con el rótulo del
    // entorno que falló.
    const vuelta = cuerpo.indexOf('sendEnvChanged(ws, tabId, previous)');
    assert.ok(vuelta !== -1 && vuelta < cuerpo.indexOf('spawnPtyForTab(ws, tab, previous'));
});
