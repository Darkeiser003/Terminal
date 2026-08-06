// main/shellDetect.js
// Detecta qué shells/entornos hay disponibles en el sistema del usuario,
// para poblar el selector de entorno y decidir cómo traducir los alias.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectDockerEnvironments } = require('./dockerEnv');
const { detectAndroidEnvironments, ensureAdbOnPath } = require('./androidEnv');
const { which, refreshSystemPath } = require('./pathEnv');
const { getWslContextAsync } = require('./wslEnv');
const { detectLanguageEnvironments } = require('./languageEnv');

// Comprueba si un comando esta realmente disponible, para decidir si
// mostrar u ocultar un boton de "instalar" en la UI. Caso especial: en
// Windows, "python"/"python3" casi siempre "existen" en el PATH via el
// alias de ejecucion de aplicaciones de la Microsoft Store aunque no haya
// ningun Python real instalado (el alias solo abre la Store al ejecutarse).
// Por eso, solo para esos dos, se comprueba que --version responda de
// verdad en vez de fiarse de que el ejecutable aparezca en el PATH.
function isToolInstalled(cmd) {
    if (cmd === 'python' || cmd === 'python3') {
        try {
            const out = execFileSync(cmd, ['--version'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2000
            });
            return /Python 3\./.test(out);
        } catch (e) {
            return false;
        }
    }
    return !!which(cmd);
}

// Windows incluye varios lanzadores llamados bash.exe (WSL antiguo,
// utilidades de terceros, etc.). Solo una ruta que pertenezca a una
// instalación real de Git for Windows debe usar el transporte MSYS (/c/...).
// Confundir el lanzador de WSL con Git Bash producía rutas inválidas dentro
// de Ubuntu, donde el mismo archivo vive bajo /mnt/c/....
function isGitBashPath(candidate) {
    if (typeof candidate !== 'string' || !candidate) return false;
    const normalized = candidate.replace(/\//g, '\\').toLowerCase();
    return /\\git\\(?:bin|usr\\bin)\\bash\.exe$/.test(normalized);
}

function findGitBash() {
    const candidates = [];
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    roots.forEach((root) => {
        candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
        candidates.push(path.join(root, 'Git', 'usr', 'bin', 'bash.exe'));
    });
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'));
    }
    candidates.push(which('bash.exe'), which('bash'));
    return candidates.find((candidate) => isGitBashPath(candidate) && fs.existsSync(candidate)) || null;
}

async function detectWindowsEnvironments(options) {
    const envs = [];

    envs.push({
        id: 'cmd',
        label: 'cmd.exe',
        kind: 'cmd',
        transport: 'native',
        exe: process.env.COMSPEC || 'cmd.exe',
        args: []
    });

    const ps5 = which('powershell.exe') || which('powershell');
    if (ps5) {
        envs.push({ id: 'powershell', label: 'Windows PowerShell', kind: 'powershell', transport: 'native', exe: ps5, args: ['-NoLogo'] });
    }

    const ps7 = which('pwsh.exe') || which('pwsh');
    if (ps7) {
        envs.push({ id: 'pwsh', label: 'PowerShell 7', kind: 'powershell', transport: 'native', exe: ps7, args: ['-NoLogo'] });
    }

    const gitBash = findGitBash();
    if (gitBash) {
        envs.push({ id: 'gitbash', label: 'Git Bash · bash', kind: 'bash', shell: 'bash', transport: 'msys', exe: gitBash, args: ['--login', '-i'] });
    }

    // La ventana inicial no espera a que arranquen distros WSL en frío. El
    // inventario completo llega después por `envs-updated`.
    if (options && options.quick) return { envs, pkgManager: null };
    const wsl = await getWslContextAsync({ online: false, details: false });
    wsl.installed.forEach((distro) => {
        const base = {
            id: 'wsl:' + distro.name,
            label: `WSL: ${distro.name} · ${distro.shell}${distro.probeError ? ' (sin comprobar)' : ''}`,
            kind: distro.shell,
            shell: distro.shell,
            transport: 'wsl',
            distro: distro.name,
            exe: 'wsl.exe',
            args: ['-d', distro.name],
            note: distro.probeError
                ? 'La distribución está instalada, pero WSL no respondió durante la detección. Refresca el selector o revisa wsl --status.'
                : null
        };
        envs.push(base);

        // Si el inventario detallado ya está en caché (se obtiene al abrir
        // Entorno y dependencias), cada shell instalada se ofrece también
        // como entorno explícito sin obligarla a ser la login shell.
        (distro.shells || []).filter((shell) => shell !== distro.shell).forEach((shell) => {
            envs.push({
                id: `wsl:${distro.name}:${shell}`,
                label: `WSL: ${distro.name} · ${shell}`,
                kind: shell,
                shell,
                transport: 'wsl',
                distro: distro.name,
                exe: 'wsl.exe',
                args: ['-d', distro.name, '--', shell, '-i']
            });
        });
    });

    return { envs, pkgManager: null };
}

function detectUnixEnvironments() {
    const envs = [];
    const shellDefs = [
        { name: 'bash', kind: 'bash', args: ['-i'] },
        { name: 'zsh', kind: 'zsh', args: ['-i'] },
        { name: 'fish', kind: 'fish', args: ['-i'] },
        { name: 'sh', kind: 'sh', args: ['-i'] },
        { name: 'pwsh', kind: 'powershell', args: ['-NoLogo'] }
    ];

    shellDefs.forEach(({ name, kind, args }) => {
        const p = which(name);
        if (p) {
            // Para bash/zsh/fish/sh el nombre y el tipo coinciden: "fish · fish"
            // no aporta nada, así que solo se desdobla cuando de verdad son
            // cosas distintas (pwsh -> PowerShell).
            const label = name === 'pwsh' ? 'PowerShell · pwsh' : (name === kind ? name : `${name} · ${kind}`);
            envs.push({ id: name, label, kind, shell: name, transport: 'native', exe: p, args });
        }
    });

    // Wine trae su propio cmd.exe: es la única forma de abrir una sesión CMD
    // fuera de Windows, y el panel ya ofrece instalarlo desde "Compatibilidad
    // Windows". Si está, aparece como entorno igual que cualquier shell.
    const wine = which('wine');
    if (wine) {
        envs.push({
            id: 'wine-cmd',
            label: 'cmd.exe · Wine',
            kind: 'cmd',
            transport: 'wine',
            exe: wine,
            args: ['cmd'],
            // No sirve como "la shell cmd del sistema" para lanzar scripts del
            // panel: las rutas del host no valen dentro de Wine. Se elige a
            // mano desde el selector, nunca automáticamente (ver scripts:run).
            noAutoSelect: true,
            note: 'CMD proporcionado por Wine. Sirve para .bat/.cmd sencillos, pero no es Windows: '
                + 'las unidades se ven como Z:\\ (raíz del sistema) y lo que dependa del registro o de servicios de Windows fallará.'
        });
    }

    const managers = process.platform === 'darwin'
        ? ['brew']
        : ['apt', 'dnf', 'pacman', 'zypper'];

    let pkgManager = null;
    for (const m of managers) {
        if (which(m)) { pkgManager = m; break; }
    }

    return { envs, pkgManager };
}

// Solo comprueba que el binario existe en el PATH; consultar al daemon es
// mucho más lento y se hace aparte, en dockerEnv.js, con timeout.
function detectDocker() {
    const exe = which('docker');
    return { installed: !!exe, path: exe };
}

// Ni los entornos Docker ni los de ADB son una lista fija: se consultan al
// sistema en cada detección (imágenes/contenedores de ESTA máquina, ver
// dockerEnv.js; dispositivos Android conectados, ver androidEnv.js). Si la
// herramienta no está instalada, o no hay nada conectado, esa parte de la
// lista queda vacía y el resto de entornos funciona con normalidad.
//
// Antes de detectar nada se re-sincroniza el PATH del proceso: si el usuario
// acaba de instalar algo desde la propia terminal, la herramienta ya está en
// el PATH persistente pero no en el que la app heredó al arrancar.
async function detectEnvironments(options) {
    if (!(options && options.quick)) {
        refreshSystemPath();
        ensureAdbOnPath();
    }

    const base = process.platform === 'win32'
        ? await detectWindowsEnvironments(options)
        : detectUnixEnvironments();
    const shells = base.envs.map((e) => ({ group: 'Shells del sistema', ...e }));

    if (options && options.quick) {
        return {
            ...base,
            envs: shells,
            languages: { count: 0 },
            docker: { installed: false, path: null, daemonReady: false, envCount: 0, containerCount: 0, imageCount: 0 },
            android: { installed: false, deviceCount: 0 }
        };
    }
    const docker = detectDocker();

    // Intérpretes interactivos de los lenguajes presentes en el sistema. Solo
    // se comprueba la existencia del ejecutable, con la misma salvedad de
    // Python que usa isToolInstalled.
    const languages = detectLanguageEnvironments({
        platform: process.platform,
        isInstalled: isToolInstalled,
        resolvePath: which
    });

    // Ambas detecciones hablan con servicios externos (daemon de Docker,
    // servidor de adb) y son independientes: en paralelo, el arranque tarda
    // lo que la más lenta en vez de la suma de las dos.
    const [dockerResult, android] = await Promise.all([
        docker.installed ? detectDockerEnvironments() : Promise.resolve({ ready: false, envs: [] }),
        detectAndroidEnvironments()
    ]);

    // Las shells del sistema no traen `group` propio: caen todas en el mismo
    // apartado del desplegable, separadas de Docker y de ADB.
    return {
        ...base,
        envs: [...shells, ...languages.envs, ...dockerResult.envs, ...android.envs],
        languages: { count: languages.count },
        docker: {
            ...docker,
            daemonReady: dockerResult.ready,
            envCount: dockerResult.envs.length,
            containerCount: dockerResult.containerCount || 0,
            imageCount: dockerResult.imageCount || 0
        },
        android: { installed: android.installed, deviceCount: android.deviceCount }
    };
}

// Entorno por defecto al arrancar: cmd.exe en Windows (igual que el .hta
// original), o el shell activo del usuario ($SHELL) en Linux/Mac.
function getDefaultEnvId(envs) {
    if (process.platform === 'win32') {
        const cmd = envs.find((e) => e.id === 'cmd');
        if (cmd) return cmd.id;
        return envs[0] ? envs[0].id : null;
    }
    const shellPath = process.env.SHELL || '';
    const shellName = shellPath.split('/').pop();
    const match = envs.find((e) => e.id === shellName);
    if (match) return match.id;
    const bash = envs.find((e) => e.id === 'bash');
    if (bash) return bash.id;
    return envs[0] ? envs[0].id : null;
}

module.exports = { detectEnvironments, detectWindowsEnvironments, detectUnixEnvironments, getDefaultEnvId, isToolInstalled, isGitBashPath, findGitBash };
