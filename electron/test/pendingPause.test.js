const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/* Las acciones del panel terminan en una pausa para que su salida se pueda
 * leer. Mientras la pausa sigue ahí la shell espera una RESPUESTA, no un
 * comando, así que lo siguiente que escribiera un panel se consumiría como
 * respuesta y no llegaría a ejecutarse. En la terminal se veía tal cual:
 *
 *   Pulsa Enter para volver a la terminal wine cmd /c ver; printf ...
 */
test('un comando escrito por un panel cierra antes la pausa pendiente', () => {
    // Réplica de writeCommandToPty sobre una shell simulada que distingue
    // "estoy esperando un Enter" de "estoy esperando un comando".
    function crearShell() {
        const ejecutados = [];
        let esperandoEnter = false;
        return {
            ejecutados,
            escribir(texto) {
                texto.split('\r').slice(0, -1).forEach((linea) => {
                    if (esperandoEnter) { esperandoEnter = false; return; }  // la línea se consume
                    ejecutados.push(linea);
                    if (/read __wsterm_pause|\bpause\b|Read-Host/.test(linea)) esperandoEnter = true;
                });
            }
        };
    }

    function escribirComando(shell, tab, comando) {
        shell.escribir((tab.awaitingPause ? '\r' : '') + comando + '\r');
        tab.awaitingPause = false;
    }

    const shell = crearShell();
    const tab = { awaitingPause: false };

    const instalar = "sudo pacman -S powershell; printf '\\n'; read __wsterm_pause";
    escribirComando(shell, tab, instalar);
    tab.awaitingPause = true;   // la acción llevaba pausa

    escribirComando(shell, tab, 'wine cmd /c ver');
    assert.deepEqual(shell.ejecutados, [instalar, 'wine cmd /c ver'],
        'el segundo comando tiene que ejecutarse, no responder a la pausa');
    assert.equal(tab.awaitingPause, false);

    // Sin pausa pendiente no se manda ningún Enter de más.
    const limpia = crearShell();
    const tabLimpio = { awaitingPause: false };
    escribirComando(limpia, tabLimpio, 'cd /tmp');
    assert.deepEqual(limpia.ejecutados, ['cd /tmp']);
});

test('todo comando de panel pasa por writeCommandToPty', () => {
    // Escribir directamente al pty se reserva para la inicialización de la
    // sesión y para las teclas del usuario; cualquier otro sitio se saltaría
    // el control de la pausa.
    const directos = (MAIN.match(/writeToPty\([^)]*'\\r'[^)]*\)/g) || []).sort();
    assert.deepEqual(directos, [
        // El propio writeCommandToPty, que es quien añade el Enter de cierre.
        "writeToPty(tab, prefix + command + '\\r')",
        // Y la inicialización de una sesión recién creada, donde no puede
        // haber ninguna pausa anterior.
        "writeToPty(tab, initCmd + '\\r', ptyProcess)"
    ].sort(), 'un panel está escribiendo al pty sin pasar por writeCommandToPty');

    // Y el usuario que contesta a la pausa por su cuenta también la cierra.
    const entrada = MAIN.slice(MAIN.indexOf("ipcMain.on('pty-input'"));
    assert.match(entrada.slice(0, 500), /awaitingPause = false/);
});
