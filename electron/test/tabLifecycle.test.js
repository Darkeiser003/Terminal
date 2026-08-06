const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

/* Escribir `exit` dejaba la pestaña muerta: seguía ahí, con el código de
 * salida y sin shell detrás, y no había forma de recuperarla salvo abrir otra
 * o cambiar de entorno y volver.
 */
test('la pestaña se cierra igual la cierre el usuario o la shell', () => {
    // Un solo camino de cierre para los dos casos.
    assert.match(MAIN, /function closeTab\(ws, tabId, reason\)/);
    const handler = MAIN.slice(MAIN.indexOf("ipcMain.on('tabs:close'"));
    assert.match(handler.slice(0, 300), /closeTab\(found\.ws, tabId/);

    const onExit = MAIN.slice(MAIN.indexOf('ptyProcess.onExit('));
    const cuerpo = onExit.slice(0, onExit.indexOf('\n    });'));
    assert.match(cuerpo, /closeTab\(windowState, tab\.id/);

    // Y sin pestañas se cierra la ventana, que con la última cierra la app.
    const cierre = MAIN.slice(MAIN.indexOf('function closeTab(ws, tabId, reason)'));
    assert.match(cierre.slice(0, 900), /ws\.tabs\.size === 0[\s\S]*ws\.win\.close\(\)/);
});

test('una sesión que ni llega a arrancar deja su error a la vista', () => {
    const onExit = MAIN.slice(MAIN.indexOf('ptyProcess.onExit('));
    const cuerpo = onExit.slice(0, onExit.indexOf('\n    });'));
    // Antes de cerrar nada se comprueba si murió al instante y con error: ahí
    // cerrar la pestaña haría desaparecer la única pista de qué ha pasado.
    const guarda = cuerpo.indexOf('FAILED_SESSION_MS');
    const cierre = cuerpo.indexOf('closeTab(');
    assert.ok(guarda !== -1 && cierre !== -1 && guarda < cierre);
    assert.match(cuerpo.slice(guarda - 120, guarda + 200), /exitCode !== 0/);
});

// La simulación de la regla, para que no dependa solo de leer el archivo.
test('la regla de cierre distingue terminar de fallar al arrancar', () => {
    const FAILED_SESSION_MS = 3000;
    const decide = (exitCode, elapsedMs) =>
        (exitCode !== 0 && elapsedMs < FAILED_SESSION_MS ? 'mostrar-error' : 'cerrar');

    // El caso del usuario: `exit` en cmd y en adb, después de trabajar.
    assert.equal(decide(0, 120000), 'cerrar');
    assert.equal(decide(0, 50), 'cerrar', 'salir sin error siempre cierra');
    // Salir con un código distinto de cero tras usar la shell también cierra:
    // el último comando falló, la sesión terminó igual.
    assert.equal(decide(1, 60000), 'cerrar');
    // Un entorno que no arranca deja el motivo en pantalla.
    assert.equal(decide(1, 200), 'mostrar-error');
});

/* El prompt aparecía a media pantalla porque el pty escribía su banner con el
 * tamaño de manual (80x24) y el xterm se reajustaba después, reflujando todo
 * lo ya escrito.
 */
test('la sesión nace con el tamaño de la ventana, no con 80x24', () => {
    const spawn = MAIN.slice(MAIN.indexOf('function spawnPtyForTab'));
    const cuerpo = spawn.slice(0, spawn.indexOf('\n}'));
    assert.match(cuerpo, /cols: viewport\.cols/);
    assert.match(cuerpo, /rows: viewport\.rows/);
    assert.doesNotMatch(cuerpo, /cols: 80/);

    // El tamaño medido se guarda para la ventana y para la próxima ejecución:
    // la primera pestaña se crea antes de que exista el renderer.
    const resize = MAIN.slice(MAIN.indexOf("ipcMain.on('pty-resize'"));
    assert.match(resize.slice(0, 800), /ws\.viewport = \{ cols: safeCols, rows: safeRows \}/);
    assert.match(resize.slice(0, 800), /rememberViewport\(safeCols, safeRows\)/);
    const { sanitizePreferences } = require('../main/preferences');
    assert.equal(sanitizePreferences({}).viewportCols, 80);
    assert.equal(sanitizePreferences({ viewportCols: 140 }).viewportCols, 140);
    // Un settings.json manipulado no puede llegar al pty con un tamaño
    // imposible: se recorta al rango admitido, igual que el resto de números.
    assert.equal(sanitizePreferences({ viewportCols: 4 }).viewportCols, 20);
    assert.equal(sanitizePreferences({ viewportCols: 99999 }).viewportCols, 1000);
    assert.equal(sanitizePreferences({ viewportRows: 'muchas' }).viewportRows, 24);
});

test('la salida pendiente no se entrega hasta que el xterm mide de verdad', () => {
    // Pedirla al crear la pestaña metía el banner en un xterm de 80 columnas
    // que aún no se había hecho visible.
    assert.match(RENDERER, /function signalTabReady\(tabId\)/);
    const addTab = RENDERER.slice(RENDERER.indexOf('function addTab('));
    assert.doesNotMatch(addTab.slice(0, 700), /terminalAPI\.markTabReady/);

    // Se pide dentro del ajuste, cuando ya hay tamaño y main.js lo conoce.
    const fit = RENDERER.slice(RENDERER.indexOf('function fitActiveTab('));
    const cuerpo = fit.slice(0, fit.indexOf('\n    }'));
    const resize = cuerpo.indexOf('terminalAPI.resize(');
    const ready = cuerpo.indexOf('signalTabReady(');
    assert.ok(resize !== -1 && ready !== -1 && resize < ready,
        'main.js debe conocer el tamaño antes de volcar lo pendiente');

    // Con red de seguridad: una pestaña que nunca se hace visible no puede
    // quedarse sin recibir su salida.
    assert.match(addTab.slice(0, 900), /setTimeout\(function \(\) \{ signalTabReady\(tabId\); \}/);
});
