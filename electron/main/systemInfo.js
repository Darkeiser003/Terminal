// main/systemInfo.js
// Panel de información del sistema estilo fastfetch/neofetch, sin depender
// de ningún binario externo salvo `reg` en Windows: usa el módulo "os" de
// Node directamente. Se muestra al abrir cada pestaña nueva y está
// disponible bajo demanda vía el alias "sysinfo" (ver aliasProfiles.js).

const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app } = require('electron');

function formatBytes(bytes) {
    return (bytes / (1024 ** 3)).toFixed(1) + ' GB';
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m' };

// ---- Identidad real del sistema ----
// os.release() devuelve la versión del KERNEL, no la del sistema que el
// usuario reconoce como suyo: en Linux da "7.1.6-1-cachyos" en vez de
// "CachyOS", y en Windows "10.0.19045" en vez de la edición instalada. El
// nombre de verdad vive en /etc/os-release, en el registro o en sw_vers,
// según la plataforma. Leerlo cuesta una llamada, así que se cachea: no
// cambia mientras la app está abierta.
let identityCache = null;

// Quita adornos que no aportan (emojis, tildes decorativas de los nombres
// personalizados tipo "🚀 ~ WinSlim 10 ~ 🚀") y colapsa espacios: el banner
// se escribe en un archivo que la consola lee en su propia página de
// códigos, donde cualquier carácter no ASCII acabaría como "?".
function cleanIdentityValue(value) {
    return String(value || '')
        .replace(/[^\x20-\x7e¡-ɏ]/g, ' ')
        .replace(/^[\s~|-]+|[\s~|-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// /etc/os-release es el estándar de systemd y lo traen todas las distros
// modernas; /usr/lib/os-release es el respaldo oficial para sistemas con
// /etc mínimo.
function readLinuxIdentity() {
    for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
        let content;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch (e) {
            continue;
        }
        const values = {};
        content.split('\n').forEach((line) => {
            const match = line.match(/^([A-Z_]+)=(.*)$/);
            if (!match) return;
            values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
        });
        const name = values.PRETTY_NAME
            || [values.NAME, values.VERSION].filter(Boolean).join(' ')
            || values.ID;
        if (name) return { name: cleanIdentityValue(name), build: values.BUILD_ID || null };
    }
    return null;
}

// Lee un puñado de valores de una clave del registro con `reg query`, que
// viene siempre con Windows y no necesita ningún módulo nativo. Devuelve un
// objeto {nombre: valor}; los REG_DWORD llegan como "0x1cf9" y se convierten
// a número.
function regValues(key) {
    let output;
    try {
        output = execFileSync('reg', ['query', key], {
            encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        });
    } catch (e) {
        return {};
    }
    const values = {};
    output.split('\n').forEach((line) => {
        const match = line.match(/^\s{4}(\S+)\s+REG_\w+\s+(.*)$/);
        if (!match) return;
        const raw = match[2].trim();
        values[match[1]] = /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : raw;
    });
    return values;
}

const WIN_NT_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const WIN_OEM_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OEMInformation';

function readWindowsIdentity() {
    const nt = regValues(WIN_NT_KEY);
    // ProductName se quedó anclado en "Windows 10" en los Windows 11, así
    // que la build manda para decidir la generación: 22000 es el primer
    // build de Windows 11.
    let product = cleanIdentityValue(nt.ProductName) || `${os.type()} ${os.release()}`;
    const build = Number(nt.CurrentBuild || nt.CurrentBuildNumber || 0);
    if (build >= 22000) product = product.replace(/Windows 10/, 'Windows 11');
    const display = cleanIdentityValue(nt.DisplayVersion || nt.ReleaseId);
    if (display) product += ' ' + display;

    // Las ISOs personalizadas (WinSlim y compañía) escriben su marca en la
    // información OEM: es el nombre que el usuario ve en "Acerca de" y el
    // que espera reconocer aquí, no el de la edición base de Microsoft.
    const oem = regValues(WIN_OEM_KEY);
    const brand = cleanIdentityValue(oem.Model || oem.Manufacturer);

    return {
        name: product,
        build: build ? `${build}${nt.UBR ? '.' + nt.UBR : ''}` : null,
        brand: brand && brand.toLowerCase() !== product.toLowerCase() ? brand : null
    };
}

function readMacIdentity() {
    try {
        const read = (flag) => execFileSync('sw_vers', [flag], {
            encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        const name = [read('-productName'), read('-productVersion')].filter(Boolean).join(' ');
        return name ? { name: cleanIdentityValue(name), build: read('-buildVersion') || null } : null;
    } catch (e) {
        return null;
    }
}

function osIdentity() {
    if (identityCache) return identityCache;
    let identity = null;
    try {
        if (process.platform === 'win32') identity = readWindowsIdentity();
        else if (process.platform === 'darwin') identity = readMacIdentity();
        else identity = readLinuxIdentity();
    } catch (e) {
        identity = null;
    }
    // Sin identidad legible se cae al dato del kernel, que siempre existe.
    identityCache = identity && identity.name
        ? identity
        : { name: `${os.type()} ${os.release()}`, build: null, brand: null };
    return identityCache;
}

// Nunca debe tumbar el spawn de un pty por un dato del sistema que falle al
// leerse (raro, pero os.cpus()/os.userInfo() pueden fallar en entornos muy
// restringidos): si algo va mal, se devuelve un banner mínimo en vez de null.
// `t` es el traductor del idioma activo (ver i18n.js). Se recibe como
// parámetro en vez de importarlo para no atar este módulo a las preferencias:
// si no llega ninguno, el banner sale en el idioma de referencia.
// La versión solo la sabe Electron. Fuera de él (pruebas puras) no hay ninguna
// y no es motivo para quedarse sin banner: era la única línea del bloque que
// podía lanzar, y al hacerlo se llevaba por delante las siete anteriores.
function appVersion() {
    try {
        return app.getVersion();
    } catch (e) {
        return '';
    }
}

function buildBanner(envLabel, appName, t) {
    const tr = typeof t === 'function' ? t : (key, params, fallback) => {
        const text = fallback || key;
        return params
            ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
            : text;
    };
    const displayName = typeof appName === 'string' && appName.trim() ? appName.trim() : 'Terminal';
    try {
        const cpus = os.cpus() || [];
        const cpuModel = cpus.length ? cpus[0].model.replace(/\s+/g, ' ').trim() : 'desconocida';
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        let username = 'usuario';
        try {
            username = os.userInfo().username;
        } catch (e) {
            // En algunos entornos (p. ej. sin perfil de usuario completo)
            // os.userInfo() puede fallar; no es motivo para no mostrar nada.
        }

        const identity = osIdentity();
        const kernel = process.platform === 'win32'
            ? `NT ${os.release()}${identity.build ? ' · build ' + identity.build : ''}`
            : `${os.type()} ${os.release()}`;

        const rows = [
            [tr('banner.user', null, 'Usuario'), `${username}@${os.hostname()}`],
            [tr('banner.system', null, 'Sistema'), `${identity.name} (${os.arch()})`]
        ];
        if (identity.brand) rows.push([tr('banner.edition', null, 'Edición'), identity.brand]);
        rows.push(
            [tr('banner.kernel', null, 'Kernel'), kernel],
            [tr('banner.environment', null, 'Entorno'), envLabel || tr('banner.unknown', null, 'desconocido')],
            ['CPU', `${cpuModel} (${tr('banner.cores', { count: cpus.length || '?' }, '{count} núcleos')})`],
            [tr('banner.memory', null, 'Memoria'), `${formatBytes(totalMem - freeMem)} / ${formatBytes(totalMem)}`],
            [tr('banner.uptime', null, 'Uptime'), formatUptime(os.uptime())],
            [displayName, appVersion()]
        );

        const labelWidth = Math.max(...rows.map(([label]) => label.length));
        const divider = C.dim + '─'.repeat(46) + C.reset;
        const lines = rows.map(([label, value]) => `${C.cyan}${label.padEnd(labelWidth)}${C.reset}  ${value}`);

        return `${C.bold}${C.cyan}${displayName}${C.reset}\r\n${divider}\r\n` +
            lines.join('\r\n') + `\r\n${divider}\r\n`;
    } catch (e) {
        return `${C.bold}${C.cyan}${displayName}${C.reset}\r\n`;
    }
}

module.exports = { buildBanner, cleanIdentityValue };
