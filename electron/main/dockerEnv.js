// main/dockerEnv.js
// Integración con Docker: arranque automático del daemon si está parado, y
// detección de los entornos Docker REALES de la máquina (imágenes locales y
// contenedores en ejecución) para ofrecerlos en el selector de entorno, en
// vez de una imagen fija predefinida.
//
// Todas las llamadas a `docker` llevan timeout: si el daemon está caído, el
// CLI puede quedarse esperando, y esta detección corre durante el arranque
// de la app (no debe bloquearla).

const { execFile, spawn } = require('child_process');
const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 4000;

// Rutas típicas del ejecutable de Docker Desktop en Windows, en orden de
// preferencia. Se usa la primera que exista.
const DOCKER_DESKTOP_WIN_PATHS = [
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Docker\\Docker\\Docker Desktop.exe`,
    `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Docker\\Docker\\Docker Desktop.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Docker\\Docker Desktop.exe`
];

// Cuántos entornos Docker como máximo se añaden al selector. Una máquina de
// desarrollo puede tener decenas de imágenes; volcarlas todas convertiría el
// desplegable en algo inusable.
const MAX_DOCKER_ENVS = 25;

function runDocker(args, timeoutMs) {
    return new Promise((resolve) => {
        execFile('docker', args, {
            timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
            encoding: 'utf8',
            windowsHide: true
        }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
        });
    });
}

// El daemon está listo cuando `docker version` puede responder la versión
// del SERVIDOR (el cliente responde aunque el daemon esté caído, por eso se
// pide explícitamente .Server.Version).
async function isDaemonReady(timeoutMs) {
    const out = await runDocker(['version', '--format', '{{.Server.Version}}'], timeoutMs);
    return !!(out && out.trim());
}

// Arranca Docker en segundo plano. En Windows/macOS es una app de usuario
// que no requiere elevación, así que se puede lanzar directamente. En Linux
// el daemon es un servicio del sistema y arrancarlo pide sudo: ahí no se
// hace nada por detrás (el panel "Entorno y dependencias" ofrece el comando
// para que el usuario lo ejecute y lo vea).
function startDockerDaemon() {
    try {
        if (process.platform === 'win32') {
            const exePath = DOCKER_DESKTOP_WIN_PATHS.find((p) => p && fs.existsSync(p));
            if (!exePath) return { started: false, reason: 'No se encontró Docker Desktop.exe en las rutas habituales' };
            const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            return { started: true, via: exePath };
        }
        if (process.platform === 'darwin') {
            const child = spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' });
            child.unref();
            return { started: true, via: 'open -a Docker' };
        }
        return { started: false, reason: 'En Linux el daemon requiere privilegios: usa "sudo systemctl start docker" desde el panel de dependencias' };
    } catch (e) {
        return { started: false, reason: e.message };
    }
}

// Espera a que el daemon responda, sondeando cada `intervalMs`. Devuelve
// true si llegó a estar listo dentro del plazo. Docker Desktop tarda
// típicamente entre 15 y 60 segundos en arrancar del todo.
async function waitForDaemon(maxWaitMs, intervalMs) {
    const deadline = Date.now() + (maxWaitMs || 90000);
    const step = intervalMs || 3000;
    while (Date.now() < deadline) {
        if (await isDaemonReady(3000)) return true;
        await new Promise((r) => setTimeout(r, step));
    }
    return false;
}

// Comando de arranque dentro del contenedor: prefiere bash si la imagen lo
// trae, y si no cae a sh (alpine, busybox y muchas imágenes slim solo traen
// sh). Si la imagen no tiene ninguna shell, el error se ve en la terminal
// como con cualquier otro comando.
const SHELL_FALLBACK = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];

async function listImages(timeoutMs) {
    const out = await runDocker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], timeoutMs);
    return parseImages(out);
}

function parseImages(out) {
    if (!out) return [];
    return String(out)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        // Imágenes intermedias/huérfanas: no sirven para abrir una shell.
        .filter((name) => !name.includes('<none>'));
}

async function listRunningContainers(timeoutMs) {
    const out = await runDocker(['ps', '--format', '{{.Names}}\t{{.Image}}'], timeoutMs);
    return parseRunningContainers(out);
}

function parseRunningContainers(out) {
    if (!out) return [];
    return String(out)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, image] = line.split('\t');
            return { name, image: image || '' };
        })
        .filter((c) => !!c.name);
}

// Construye la lista de entornos Docker disponibles ahora mismo:
//  - un entorno por cada contenedor EN EJECUCIÓN (docker exec: entra en el
//    contenedor vivo, conservando su estado),
//  - un entorno por cada imagen local (docker run --rm: contenedor nuevo y
//    efímero a partir de esa imagen).
// El directorio del usuario se monta en /workspace para poder trabajar con
// los archivos del host desde dentro del contenedor.
async function detectDockerEnvironments(timeoutMs) {
    const ready = await isDaemonReady(timeoutMs);
    if (!ready) return { ready: false, envs: [], containerCount: 0, imageCount: 0 };

    const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const envs = [];

    // `group` es solo para la UI: separa en el desplegable los contenedores
    // vivos de las imágenes. Sin esa separación, ver la misma imagen dos
    // veces (una como contenedor en marcha y otra como imagen) parece un
    // duplicado, cuando en realidad son dos acciones distintas.
    const containers = await listRunningContainers(timeoutMs);
    containers.forEach((c) => {
        envs.push({
            id: 'docker:container:' + c.name,
            label: `Docker ▶ ${c.name} · bash/sh` + (c.image ? ` (${c.image})` : ''),
            group: 'Docker · contenedores en ejecución',
            kind: 'bash',
            transport: 'docker',
            exe: 'docker',
            args: ['exec', '-it', c.name, ...SHELL_FALLBACK]
        });
    });

    const images = await listImages(timeoutMs);
    images.forEach((image) => {
        envs.push({
            id: 'docker:image:' + image,
            label: `Docker: ${image} · bash/sh`,
            group: 'Docker · imágenes (contenedor nuevo)',
            kind: 'bash',
            transport: 'docker',
            hostRoot: cwd,
            containerRoot: '/workspace',
            initialHostCwd: cwd,
            exe: 'docker',
            args: ['run', '--rm', '-it', '-v', `${cwd}:/workspace`, '-w', '/workspace', image, ...SHELL_FALLBACK]
        });
    });

    return {
        ready: true,
        envs: envs.slice(0, MAX_DOCKER_ENVS),
        total: envs.length,
        containerCount: containers.length,
        imageCount: images.length
    };
}

module.exports = {
    isDaemonReady,
    startDockerDaemon,
    waitForDaemon,
    detectDockerEnvironments,
    parseImages,
    parseRunningContainers,
    MAX_DOCKER_ENVS
};
