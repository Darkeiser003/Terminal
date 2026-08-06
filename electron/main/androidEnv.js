// main/androidEnv.js
// Integración con ADB (Android Platform Tools):
//   - localiza adb aunque el PATH del proceso esté desactualizado (recién
//     instalado con la app abierta) y lo añade al PATH que heredan las
//     pestañas nuevas,
//   - detecta los dispositivos conectados y los ofrece como entornos del
//     selector, igual que se hace con los contenedores/imágenes de Docker:
//     elegir uno abre una shell REAL dentro del dispositivo (`adb shell`).
//
// La llamada a `adb` lleva timeout: arrancar el servidor de adb puede tardar
// un par de segundos y esta detección corre durante el arranque de la app.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { which, addToProcessPath } = require('./pathEnv');

const ADB_TIMEOUT_MS = 6000;

// Cuántos dispositivos como máximo se convierten en entornos. Un banco de
// pruebas con muchos emuladores no debe llenar el desplegable.
const MAX_ADB_ENVS = 10;

const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

// Rutas donde suele acabar platform-tools, en orden de preferencia. La
// primera es exactamente donde instala la acción "Instalar ADB" de esta app
// (ver installActions.js); las demás cubren instalaciones previas hechas con
// Android Studio o a mano.
function candidateDirs() {
    const local = process.env.LOCALAPPDATA || '';
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const programFiles = process.env.ProgramFiles || '';
    const raw = [
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools'),
        process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools')
    ];

    if (process.platform === 'win32') {
        raw.push(
            local && path.join(local, 'Android', 'platform-tools'),
            local && path.join(local, 'Android', 'Sdk', 'platform-tools'),
            home && path.join(home, 'Android', 'Sdk', 'platform-tools'),
            programFiles && path.join(programFiles, 'Android', 'platform-tools')
        );
    } else if (process.platform === 'darwin') {
        raw.push(home && path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
    } else {
        raw.push(
            home && path.join(home, 'Android', 'Sdk', 'platform-tools'),
            '/usr/lib/android-sdk/platform-tools'
        );
    }

    return raw.filter(Boolean);
}

// Carpeta de platform-tools instalada en el sistema, buscando primero en el
// PATH y cayendo a las rutas conocidas.
function findAdbPath() {
    const onPath = which('adb');
    if (onPath) return onPath;
    for (const dir of candidateDirs()) {
        const exe = path.join(dir, ADB_EXE);
        try {
            if (fs.existsSync(exe)) return exe;
        } catch (e) {
            // Ruta ilegible (unidad desconectada, permisos): se ignora.
        }
    }
    return null;
}

// Si adb existe pero no es visible en el PATH del proceso (caso típico:
// acaba de instalarse desde la propia terminal y la app arrancó antes), se
// añade su carpeta. A partir de ahí, cualquier pestaña NUEVA puede usar
// `adb` desde cualquier ruta sin reiniciar la app.
function ensureAdbOnPath() {
    if (which('adb')) return null;
    const exe = findAdbPath();
    if (!exe) return null;
    const dir = path.dirname(exe);
    return addToProcessPath(dir) ? dir : null;
}

function runAdb(adbPath, args) {
    return new Promise((resolve) => {
        execFile(adbPath, args, {
            timeout: ADB_TIMEOUT_MS,
            encoding: 'utf8',
            windowsHide: true
        }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
        });
    });
}

// Estados que devuelve `adb devices` distintos de "listo para usar". Se
// muestran igualmente en el selector: ver el dispositivo con su estado es
// más útil que no verlo (y al abrirlo, adb explica en la propia terminal qué
// falta, p. ej. aceptar la huella RSA en la pantalla del móvil).
const STATE_LABELS = {
    unauthorized: 'sin autorizar',
    offline: 'offline',
    authorizing: 'autorizando',
    recovery: 'recovery',
    sideload: 'sideload',
    bootloader: 'bootloader',
    rescue: 'rescue',
    host: 'host',
    'no permissions': 'sin permisos'
};

// Parsea la salida de `adb devices -l`:
//   List of devices attached
//   7a466cd1   unauthorized usb:1-4 transport_id:1
//   emulator-5554  device product:sdk model:Pixel_3a device:generic
function parseDevices(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        // Cabecera y mensajes del servidor ("* daemon started successfully").
        .filter((line) => !/^(List of devices|\*)/i.test(line))
        .map((line) => {
            const parts = line.split(/\s+/);
            const serial = parts[0];
            const state = (parts[1] || '').toLowerCase();
            if (!serial || !state) return null;
            const modelMatch = line.match(/\bmodel:(\S+)/);
            return {
                serial,
                state,
                model: modelMatch ? modelMatch[1].replace(/_/g, ' ') : null
            };
        })
        .filter(Boolean);
}

async function listDevices(adbPath) {
    const out = await runAdb(adbPath, ['devices', '-l']);
    if (!out) return [];
    return parseDevices(out);
}

function deviceLabel(device) {
    const name = device.model ? `${device.model} (${device.serial})` : device.serial;
    const state = STATE_LABELS[device.state];
    return `ADB ▶ ${name}` + (state ? ` — ${state}` : '');
}

// Qué hacer cuando el dispositivo no está en estado "device": `adb shell`
// va a fallar y salir al instante, y el error de adb (en inglés y sin
// contexto) no deja claro que la pelota está en la pantalla del móvil.
const STATE_NOTES = {
    unauthorized: 'Desbloquea el móvil, acepta "Permitir depuración por USB" y pulsa refrescar en el selector de entorno.',
    offline: 'El dispositivo no responde. Reconecta el cable o usa "adb kill-server" y pulsa refrescar.',
    authorizing: 'Acepta el diálogo de autorización en el móvil y pulsa refrescar cuando termine.',
    bootloader: 'El dispositivo está en el bootloader: ahí no hay shell, solo comandos fastboot.',
    sideload: 'El dispositivo está en modo sideload (recovery): ahí no hay shell interactiva.',
    'no permissions': 'El sistema no da permisos sobre el dispositivo USB (reglas udev en Linux). Revisa la documentación de adb sobre reglas udev.'
};

// Un entorno por dispositivo conectado. `kind: 'android'` a propósito: no es
// ninguna de las familias de shell conocidas, así que aliasProfiles.js no
// inyecta sus alias de Windows/Unix dentro del móvil (allí la shell es mksh
// y esos comandos no existen).
// Solo se habilitan estados que realmente aceptan `adb shell`. En particular,
// wait-for-device no espera a la autorización RSA: con un dispositivo
// `unauthorized` termina y `shell` falla inmediatamente. Es más honesto dejar
// la opción visible pero deshabilitada hasta que el usuario autorice y pulse
// refrescar.
const SHELL_STATES = new Set(['device', 'recovery', 'rescue']);

function toEnv(adbPath, device) {
    const args = ['-s', device.serial, 'shell'];
    const available = SHELL_STATES.has(device.state);

    return {
        id: 'adb:' + device.serial,
        label: deviceLabel(device),
        group: 'Android (ADB)',
        kind: 'android',
        transport: 'android',
        exe: adbPath,
        args,
        available,
        note: STATE_NOTES[device.state] || (available ? null : `Estado ADB: ${device.state}. Refresca cuando esté listo.`)
    };
}

// Entornos ADB disponibles ahora mismo. Si adb no está instalado, o no hay
// ningún dispositivo conectado, la lista queda vacía y el resto de entornos
// funciona con normalidad.
async function detectAndroidEnvironments() {
    const adbPath = findAdbPath();
    if (!adbPath) return { installed: false, envs: [], deviceCount: 0 };

    const devices = await listDevices(adbPath);
    return {
        installed: true,
        adbPath,
        deviceCount: devices.length,
        envs: devices.slice(0, MAX_ADB_ENVS).map((d) => toEnv(adbPath, d))
    };
}

module.exports = {
    findAdbPath,
    ensureAdbOnPath,
    detectAndroidEnvironments,
    parseDevices,
    MAX_ADB_ENVS
};
