// main/wslEnv.js
// Inventario de WSL compartido por el selector de entornos y por el panel de
// instalación: distros instaladas, catálogo online, shell predeterminada,
// gestor de paquetes y herramientas ya presentes dentro de cada distro.

const { execFile, execFileSync } = require('child_process');

const INTERNAL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);
const KNOWN_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh']);
const FALLBACK_ONLINE = [
    { name: 'Ubuntu', friendlyName: 'Ubuntu' },
    { name: 'Debian', friendlyName: 'Debian GNU/Linux' },
    { name: 'kali-linux', friendlyName: 'Kali Linux Rolling' },
    { name: 'openSUSE-Tumbleweed', friendlyName: 'openSUSE Tumbleweed' }
];
const INSTALLED_CACHE_MS = 10000;
const ONLINE_CACHE_MS = 5 * 60 * 1000;
let installedCache = null;
let onlineCache = null;
const pendingContexts = new Map();
let contextQueue = Promise.resolve();

function decodeWslOutput(buffer) {
    if (typeof buffer === 'string') return buffer.replace(/\u0000/g, '');
    let text = buffer.toString('utf16le');
    if (/\uFFFD/.test(text) || !/[a-zA-Z]/.test(text)) text = buffer.toString('utf8');
    return text.replace(/\u0000/g, '');
}

function runWsl(args, timeout) {
    try {
        const output = execFileSync('wsl.exe', args, {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: timeout || 5000
        });
        return decodeWslOutput(output).trim();
    } catch (e) {
        return null;
    }
}

function runWslAsync(args, timeout) {
    return new Promise((resolve) => {
        execFile('wsl.exe', args, {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: timeout || 5000,
            encoding: 'buffer'
        }, (error, stdout) => {
            if (error) return resolve(null);
            resolve(decodeWslOutput(stdout).trim());
        });
    });
}

function parseInstalledDistros(output) {
    return String(output || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^\*\s*/, '').trim())
        .filter(Boolean)
        .filter((name) => !INTERNAL_DISTROS.has(name.toLowerCase()));
}

function parseOnlineDistros(output) {
    const rows = [];
    String(output || '').split(/\r?\n/).forEach((line) => {
        const columns = line.trim().split(/\s{2,}/);
        if (columns.length < 2) return;
        const name = columns[0].trim();
        const friendlyName = columns.slice(1).join(' ').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return;
        if (/^(NAME|NOMBRE)$/i.test(name)) return;
        rows.push({ name, friendlyName: friendlyName || name });
    });
    return rows;
}

function probeDistro(name, detailed) {
    // `wsl.exe ... sh -c <script>` altera algunas comillas al construir la
    // línea de comandos de Windows. Se usan ejecutables directos: una sonda
    // rápida para el selector y, solo al abrir Dependencias, un listado de
    // /bin + /usr/bin con el que se resuelve todo el inventario de una vez.
    const shellPath = runWsl(['-d', name, '--', 'printenv', 'SHELL'], 3000);
    if (shellPath === null) {
        return {
            name,
            // Las distribuciones oficiales de `wsl --list --online` usan
            // bash por defecto. Se marca como no comprobado para no ocultar
            // que el servicio/distro no respondió durante esta detección.
            shell: 'bash',
            packageManager: null,
            shells: [],
            tools: [],
            probeError: true
        };
    }
    const rawShell = shellPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'bash';
    const shell = KNOWN_SHELLS.has(rawShell) ? rawShell : 'bash';
    if (!detailed) {
        return { name, shell, packageManager: null, shells: [shell], tools: [], detailed: false };
    }

    const listing = runWsl(['-d', name, '--', 'ls', '-1', '/bin', '/usr/bin'], 5000);
    if (listing === null) {
        return { name, shell, packageManager: null, shells: [shell], tools: [], probeError: true };
    }
    const commands = new Set(
        listing.split(/\r?\n/)
            .map((line) => line.trim().replace(/\*$/, ''))
            .filter((line) => /^[A-Za-z0-9._+-]+$/.test(line))
    );
    const availableShells = ['bash', 'zsh', 'fish', 'sh'].filter((candidate) => commands.has(candidate));
    const lowerName = name.toLowerCase();
    const managerOrder = /fedora|alma|oracle|rhel/.test(lowerName)
        ? ['dnf', 'apt', 'pacman', 'zypper']
        : /arch/.test(lowerName)
            ? ['pacman', 'apt', 'dnf', 'zypper']
            : /suse/.test(lowerName)
                ? ['zypper', 'apt', 'dnf', 'pacman']
                : ['apt', 'dnf', 'pacman', 'zypper'];
    const packageManager = managerOrder.find((candidate) => commands.has(candidate)) || null;
    const availableTools = ['node', 'npm', 'python3', 'git'].filter((candidate) => commands.has(candidate));
    return {
        name,
        shell,
        packageManager,
        shells: availableShells,
        tools: availableTools,
        detailed: true
    };
}

async function probeDistroAsync(name, detailed) {
    const shellPath = await runWslAsync(['-d', name, '--', 'printenv', 'SHELL'], 3000);
    if (shellPath === null) {
        return { name, shell: 'bash', packageManager: null, shells: [], tools: [], probeError: true };
    }
    const rawShell = shellPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'bash';
    const shell = KNOWN_SHELLS.has(rawShell) ? rawShell : 'bash';
    if (!detailed) return { name, shell, packageManager: null, shells: [shell], tools: [], detailed: false };

    const listing = await runWslAsync(['-d', name, '--', 'ls', '-1', '/bin', '/usr/bin'], 5000);
    if (listing === null) return { name, shell, packageManager: null, shells: [shell], tools: [], probeError: true };
    const commands = new Set(
        listing.split(/\r?\n/)
            .map((line) => line.trim().replace(/\*$/, ''))
            .filter((line) => /^[A-Za-z0-9._+-]+$/.test(line))
    );
    const availableShells = ['bash', 'zsh', 'fish', 'sh'].filter((candidate) => commands.has(candidate));
    const lowerName = name.toLowerCase();
    const managerOrder = /fedora|alma|oracle|rhel/.test(lowerName)
        ? ['dnf', 'apt', 'pacman', 'zypper']
        : /arch/.test(lowerName)
            ? ['pacman', 'apt', 'dnf', 'zypper']
            : /suse/.test(lowerName)
                ? ['zypper', 'apt', 'dnf', 'pacman']
                : ['apt', 'dnf', 'pacman', 'zypper'];
    return {
        name,
        shell,
        packageManager: managerOrder.find((candidate) => commands.has(candidate)) || null,
        shells: availableShells,
        tools: ['node', 'npm', 'python3', 'git'].filter((candidate) => commands.has(candidate)),
        detailed: true
    };
}

function getWslContext(options) {
    if (process.platform !== 'win32') return { available: false, installed: [], online: [] };
    const now = Date.now();
    const needsDetails = !(options && options.details === false);
    // Una sonda fallida es un estado transitorio, no información útil para
    // cachear: WSL suele tardar algo más en la primera activación en frío.
    const cacheHasProbeErrors = installedCache
        && installedCache.installed.some((distro) => distro.probeError);
    const useInstalledCache = installedCache
        && now - installedCache.at < INSTALLED_CACHE_MS
        && !cacheHasProbeErrors
        && (installedCache.detailed || !needsDetails);
    let available;
    let installed;
    if (useInstalledCache) {
        ({ available, installed } = installedCache);
    } else {
        const previousCache = installedCache;
        const installedOutput = runWsl(['--list', '--quiet'], 5000);
        if (installedOutput === null) return { available: false, installed: [], online: [] };
        const names = parseInstalledDistros(installedOutput);
        available = true;
        installed = (options && options.probe === false)
            ? names.map((name) => ({ name, shell: 'sh', packageManager: null, shells: [], tools: [] }))
            : names.map((name) => probeDistro(name, needsDetails));
        // Si una sola distro falló, se reintenta el inventario, pero no se
        // pierde la información detallada y válida de las demás durante ese
        // reintento rápido. Así pueden seguir apareciendo Fedora · sh/fish,
        // por ejemplo, aunque Ubuntu esté arrancando en frío.
        if (!needsDetails && previousCache && previousCache.detailed && now - previousCache.at < INSTALLED_CACHE_MS) {
            const previousByName = new Map(previousCache.installed
                .filter((distro) => !distro.probeError && distro.detailed)
                .map((distro) => [distro.name.toLowerCase(), distro]));
            installed = installed.map((distro) => previousByName.get(distro.name.toLowerCase()) || distro);
        }
        installedCache = {
            at: now,
            available,
            installed,
            detailed: needsDetails || installed.every((distro) => distro.detailed || distro.probeError)
        };
    }

    const includeOnline = !(options && options.online === false);
    let online = [];
    if (includeOnline) {
        if (onlineCache && now - onlineCache.at < ONLINE_CACHE_MS) {
            online = onlineCache.online;
        } else {
            const onlineOutput = runWsl(['--list', '--online'], 8000);
            online = parseOnlineDistros(onlineOutput);
            if (!online.length) online = FALLBACK_ONLINE;
            onlineCache = { at: now, online };
        }
    }
    return {
        available,
        installed,
        online
    };
}

async function buildWslContextAsync(options) {
    if (process.platform !== 'win32') return { available: false, installed: [], online: [] };
    const now = Date.now();
    const needsDetails = !(options && options.details === false);
    const cacheHasProbeErrors = installedCache
        && installedCache.installed.some((distro) => distro.probeError);
    const useInstalledCache = installedCache
        && now - installedCache.at < INSTALLED_CACHE_MS
        && !cacheHasProbeErrors
        && (installedCache.detailed || !needsDetails);
    let available;
    let installed;
    if (useInstalledCache) {
        ({ available, installed } = installedCache);
    } else {
        const previousCache = installedCache;
        const installedOutput = await runWslAsync(['--list', '--quiet'], 5000);
        if (installedOutput === null) return { available: false, installed: [], online: [] };
        const names = parseInstalledDistros(installedOutput);
        available = true;
        installed = (options && options.probe === false)
            ? names.map((name) => ({ name, shell: 'sh', packageManager: null, shells: [], tools: [] }))
            : await Promise.all(names.map((name) => probeDistroAsync(name, needsDetails)));
        if (!needsDetails && previousCache && previousCache.detailed && now - previousCache.at < INSTALLED_CACHE_MS) {
            const previousByName = new Map(previousCache.installed
                .filter((distro) => !distro.probeError && distro.detailed)
                .map((distro) => [distro.name.toLowerCase(), distro]));
            installed = installed.map((distro) => previousByName.get(distro.name.toLowerCase()) || distro);
        }
        installedCache = {
            at: now,
            available,
            installed,
            detailed: needsDetails || installed.every((distro) => distro.detailed || distro.probeError)
        };
    }

    const includeOnline = !(options && options.online === false);
    let online = [];
    if (includeOnline) {
        if (onlineCache && now - onlineCache.at < ONLINE_CACHE_MS) {
            online = onlineCache.online;
        } else {
            const onlineOutput = await runWslAsync(['--list', '--online'], 8000);
            online = parseOnlineDistros(onlineOutput);
            if (!online.length) online = FALLBACK_ONLINE;
            onlineCache = { at: now, online };
        }
    }
    return { available, installed, online };
}

function getWslContextAsync(options) {
    const normalized = options || {};
    const key = `${normalized.online !== false}:${normalized.details !== false}:${normalized.probe !== false}`;
    if (pendingContexts.has(key)) return pendingContexts.get(key);
    // Peticiones con distinto nivel de detalle también se serializan. Si el
    // panel se abre mientras arranca la detección rápida, una respuesta
    // parcial ya no puede sobrescribir después el inventario detallado.
    const request = contextQueue
        .catch(() => undefined)
        .then(() => buildWslContextAsync(normalized))
        .finally(() => pendingContexts.delete(key));
    pendingContexts.set(key, request);
    contextQueue = request.then(() => undefined, () => undefined);
    return request;
}

module.exports = {
    decodeWslOutput,
    parseInstalledDistros,
    parseOnlineDistros,
    probeDistro,
    probeDistroAsync,
    getWslContext,
    getWslContextAsync,
    runWslAsync,
    KNOWN_SHELLS
};
