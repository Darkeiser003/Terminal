// main/scriptLauncher.js
// Busca scripts ejecutables (en la carpeta de scripts del usuario y, si
// existen en esta máquina, en las utilidades VBS del propio WinSlim) y
// construye el comando correcto para lanzarlos desde el entorno activo
// (cmd/PowerShell/bash/WSL/fish...): bypass de política de ejecución en
// PowerShell, `chmod +x` antes de correr un .sh, traducción de rutas
// Windows -> WSL/Git Bash cuando hace falta, y una variante "como
// administrador" (Start-Process -Verb RunAs en Windows, sudo en Unix). El
// comando resultante SIEMPRE se escribe en la terminal visible (igual que
// el resto de acciones de la app): nunca se ejecuta nada oculto ni con
// permisos elevados por detrás de espaldas del usuario.
//
// También sirve de base para los alias dinámicos por nombre de script (ver
// resolveScriptAliases): el mismo buildLaunchCommand que arma el comando
// para el botón "Ejecutar" del panel es el que se usa como cuerpo de la
// función/alias/doskey que se registra al arrancar cada shell.

const fs = require('fs');
const path = require('path');

const SCRIPT_TYPES = {
    '.ps1': 'powershell',
    '.bat': 'batch',
    '.cmd': 'batch',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.ksh': 'shell',
    '.fish': 'fish',
    '.py': 'python',
    '.js': 'node',
    '.mjs': 'node',
    '.vbs': 'vbscript',
    '.rb': 'ruby',
    '.php': 'php',
    '.pl': 'perl',
    '.lua': 'lua',
    '.r': 'rscript',
    '.groovy': 'groovy'
};

const EXT_INTERPRETERS = {
    '.sh': 'sh',
    '.bash': 'bash',
    '.zsh': 'zsh',
    '.ksh': 'ksh',
    '.fish': 'fish',
    '.py': 'python',
    '.js': 'node',
    '.mjs': 'node',
    '.ps1': 'powershell',
    '.rb': 'ruby',
    '.php': 'php',
    '.pl': 'perl',
    '.lua': 'lua',
    '.r': 'Rscript',
    '.groovy': 'groovy'
};

const TYPE_CATEGORY = {
    powershell: 'powershell',
    batch: 'batch',
    shell: 'shell',
    fish: 'fish',
    python: 'python',
    node: 'node',
    vbscript: 'vbscript',
    ruby: 'other-script',
    php: 'other-script',
    perl: 'other-script',
    lua: 'other-script',
    rscript: 'other-script',
    groovy: 'other-script'
};

const FILE_FILTERS = [
    { id: 'batch', label: 'CMD / BAT', default: true },
    { id: 'powershell', label: 'PowerShell', default: true },
    { id: 'shell', label: 'SH / Bash / Zsh', default: true },
    { id: 'fish', label: 'Fish', default: true },
    { id: 'python', label: 'Python', default: true },
    { id: 'node', label: 'Node.js', default: true },
    { id: 'vbscript', label: 'VBScript', default: true },
    { id: 'other-script', label: 'Ruby / PHP / Perl / Lua / R', default: true },
    { id: 'program', label: 'Programas', default: false },
    { id: 'html', label: 'HTML', default: false },
    { id: 'image', label: 'Imágenes', default: false },
    { id: 'audio', label: 'Audio', default: false },
    { id: 'video', label: 'Vídeo', default: false }
];
const ALL_FILE_CATEGORIES = new Set(FILE_FILTERS.map((filter) => filter.id));
const DEFAULT_FILE_CATEGORIES = new Set(FILE_FILTERS.filter((filter) => filter.default).map((filter) => filter.id));

const RESOURCE_TYPES = {};
function registerResource(extensions, descriptor) {
    extensions.forEach((ext) => { RESOURCE_TYPES[ext] = descriptor; });
}
registerResource(['.exe', '.com', '.appimage'], { type: 'program', category: 'program', runnable: true, openable: false, instruction: 'Se ejecuta en la terminal activa.' });
registerResource(['.jar'], { type: 'java', category: 'program', runnable: true, openable: false, interpreter: 'java', instruction: 'Requiere Java; se ejecuta con java -jar.' });
registerResource(['.html', '.htm'], { type: 'html', category: 'html', runnable: false, openable: true, instruction: 'Se abre con el navegador predeterminado.' });
registerResource(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'], { type: 'image', category: 'image', runnable: false, openable: true, instruction: 'Se abre con el visor de imágenes predeterminado.' });
registerResource(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus'], { type: 'audio', category: 'audio', runnable: false, openable: true, instruction: 'Se abre con el reproductor de audio predeterminado.' });
registerResource(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv'], { type: 'video', category: 'video', runnable: false, openable: true, instruction: 'Se abre con el reproductor de vídeo predeterminado.' });

const TYPE_INSTRUCTIONS = {
    powershell: 'PowerShell con -NoProfile y ExecutionPolicy Bypass.',
    batch: 'CMD/BAT mediante la shell de Windows.',
    shell: 'Intérprete tomado de la extensión o del shebang.',
    fish: 'Se ejecuta con Fish.',
    python: 'Python en Windows; python3 en WSL/Linux.',
    node: 'Se ejecuta con Node.js.',
    vbscript: 'VBScript mediante wscript.exe.',
    ruby: 'Requiere Ruby.',
    php: 'Requiere PHP CLI.',
    perl: 'Requiere Perl.',
    lua: 'Requiere Lua.',
    rscript: 'Requiere Rscript.',
    groovy: 'Requiere Groovy.'
};

function normalizeFileCategories(raw) {
    if (!Array.isArray(raw)) return new Set(DEFAULT_FILE_CATEGORIES);
    return new Set(raw.filter((value) => typeof value === 'string' && ALL_FILE_CATEGORIES.has(value)));
}

// Árboles que contienen código/dependencias, no scripts del proyecto. Esta
// exclusión solo se aplica al ámbito «Aquí»; la Biblioteca sigue siendo una
// carpeta elegida explícitamente por el usuario.
const HERE_IGNORED_DIRS = new Set([
    'node_modules', 'bower_components', 'vendor',
    '.git', '.hg', '.svn', '.yarn', '.pnpm-store',
    '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache',
    'coverage', 'dist', 'out', 'build', 'target',
    '.venv', 'venv', '__pycache__', 'site-packages'
]);
const RUNTIME_SCRIPT_TYPES = new Set(['node', 'python', 'ruby', 'php', 'perl', 'lua', 'rscript', 'groovy']);
const RUNTIME_SCRIPT_DIRS = new Set(['script', 'scripts', 'bin', 'tool', 'tools', 'tooling', 'task', 'tasks', 'command', 'commands', 'cli', 'hooks']);
const MAX_HERE_SCRIPTS = 500;
const DEFAULT_HERE_DEPTH = 3;
const MIN_HERE_DEPTH = 0;
const MAX_HERE_DEPTH = 10;
const MAX_HERE_DIRECTORIES = 5000;
const MAX_HERE_SCAN_MS = 3000;

function normalizeHereDepth(value, fallback) {
    const safeFallback = Number.isInteger(fallback) ? fallback : DEFAULT_HERE_DEPTH;
    if (value === null || value === undefined || value === '') return safeFallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return safeFallback;
    return Math.min(MAX_HERE_DEPTH, Math.max(MIN_HERE_DEPTH, Math.floor(numeric)));
}

// Fuentes fijas de "comandos importados" además de la carpeta de scripts
// del usuario: las utilidades VBS del propio sistema WinSlim, si existen en
// esta máquina (son específicas del SO personalizado del autor, opcionales
// para cualquier otro usuario de la app).
const WINSLIM_VBS_SOURCES = [
    { dir: 'C:\\WSCore\\Components\\Hooks\\WinSlimToolbox', source: 'WinSlim Toolbox' },
    { dir: 'C:\\WSCore\\Components\\Hooks\\EXEfinder', source: 'EXEfinder' }
];

const NSUDO_PATH = 'C:\\WSCore\\Components\\Hooks\\NSudo\\NSudoLC.exe';

// Scripts VBS conocidos como sensibles: no se excluyen (el usuario decidió
// importarlos), pero se marcan con una advertencia visible antes de usarlos.
const SENSITIVE_SCRIPT_HINTS = {
    'winslim_defender_off.vbs': '⚠️ Desactiva Windows Defender de forma silenciosa.',
    'winslim_disk_formatter.vbs': '⚠️ Herramienta de formateo de disco. Revisa qué unidad afecta antes de usarla.',
    'winslim_takeownership.vbs': '⚠️ Cambia el propietario/permisos de archivos o carpetas.',
    'winslim_unlocker.vbs': '⚠️ Fuerza el desbloqueo/borrado de archivos en uso.',
    'winslim_lock_file.vbs': 'Bloquea archivos para que no puedan borrarse ni modificarse.',
    'winslim_ram_cleaner.vbs': 'Libera RAM de forma agresiva; puede cerrar procesos en segundo plano.',
    'winslim_ultra_cachecleaner.vbs': 'Borra cachés del sistema de forma agresiva.',
    'winslim_disk_formatter': '⚠️ Herramienta de formateo de disco.'
};

// Recorre una carpeta buscando scripts reconocibles. No sigue enlaces
// simbólicos/junctions (evita bucles infinitos), y no falla si la carpeta
// no existe o no es legible: simplemente no hay nada que listar ahí.
function readShebang(fullPath) {
    let fd = null;
    try {
        fd = fs.openSync(fullPath, 'r');
        const buffer = Buffer.alloc(256);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
        if (!firstLine.startsWith('#!')) return null;
        const lower = firstLine.toLowerCase();
        if (/\b(pwsh|powershell)(?:\s|$)/.test(lower)) return { type: 'powershell', interpreter: 'powershell' };
        if (/\bfish(?:\s|$)/.test(lower)) return { type: 'fish', interpreter: 'fish' };
        if (/\bzsh(?:\s|$)/.test(lower)) return { type: 'shell', interpreter: 'zsh' };
        if (/\bksh(?:\s|$)/.test(lower)) return { type: 'shell', interpreter: 'ksh' };
        if (/\bbash(?:\s|$)/.test(lower)) return { type: 'shell', interpreter: 'bash' };
        if (/\bsh(?:\s|$)/.test(lower)) return { type: 'shell', interpreter: 'sh' };
        if (/\bpython(?:2|3)?(?:\s|$)/.test(lower)) return { type: 'python', interpreter: 'python' };
        if (/\bnode(?:\s|$)/.test(lower)) return { type: 'node', interpreter: 'node' };
        if (/\bruby(?:\s|$)/.test(lower)) return { type: 'ruby', interpreter: 'ruby' };
        if (/\bphp(?:\s|$)/.test(lower)) return { type: 'php', interpreter: 'php' };
        if (/\bperl(?:\s|$)/.test(lower)) return { type: 'perl', interpreter: 'perl' };
        if (/\blua(?:\s|$)/.test(lower)) return { type: 'lua', interpreter: 'lua' };
        if (/\brscript(?:\s|$)/.test(lower)) return { type: 'rscript', interpreter: 'Rscript' };
        if (/\bgroovy(?:\s|$)/.test(lower)) return { type: 'groovy', interpreter: 'groovy' };
    } catch (e) {
        // Archivo ilegible: no se usa el shebang como criterio.
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (e) { }
        }
    }
    return null;
}

function declaredBinPaths(root) {
    const result = new Set();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const values = typeof pkg.bin === 'string'
            ? [pkg.bin]
            : (pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : []);
        values.filter((value) => typeof value === 'string').forEach((value) => {
            result.add(path.normalize(path.resolve(root, value)).toLowerCase());
        });
    } catch (e) {
        // No es un paquete Node o package.json no declara binarios.
    }
    return result;
}

function isIgnoredHereDirectory(name) {
    const lower = name.toLowerCase();
    return HERE_IGNORED_DIRS.has(lower)
        || lower.startsWith('dist-')
        || lower.startsWith('build-');
}

function hasRuntimeScriptIntent(fullPath, root, descriptor, options) {
    if (!RUNTIME_SCRIPT_TYPES.has(descriptor.type)) return true;
    if (descriptor.hasShebang) return true;
    try {
        if ((fs.statSync(fullPath).mode & 0o111) !== 0) return true;
    } catch (e) { }
    if (options.declaredBins.has(path.normalize(fullPath).toLowerCase())) return true;
    const segments = path.relative(root, path.dirname(fullPath))
        .split(/[\\/]+/)
        .map((part) => part.toLowerCase());
    return segments.some((part) => RUNTIME_SCRIPT_DIRS.has(part));
}

function walkScripts(dir, depth, maxDepth, results, root, options) {
    if (depth > maxDepth || results.length >= options.maxResults || options.stopReason) return;
    if (options.scope === 'here') {
        if (options.visitedDirectories >= options.maxDirectories) {
            options.stopReason = 'directories';
            return;
        }
        if (Date.now() > options.deadline) {
            options.stopReason = 'time';
            return;
        }
        options.visitedDirectories += 1;
    }
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        if (options.scope === 'here') options.skippedDirectories += 1;
        return;
    }
    for (const entry of entries) {
        if (results.length >= options.maxResults) break;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const declaredType = SCRIPT_TYPES[ext];
            // Los archivos con extensión no reconocida son código/datos, no
            // candidatos. Solo los que no tienen extensión pueden depender
            // exclusivamente de un shebang.
            const shebang = (declaredType || !ext) ? readShebang(full) : null;
            const type = declaredType || (shebang && shebang.type);
            let descriptor = null;
            if (type) {
                descriptor = {
                    type,
                    category: TYPE_CATEGORY[type] || 'other-script',
                    interpreter: (shebang && shebang.interpreter) || EXT_INTERPRETERS[ext] || null,
                    runnable: true,
                    openable: false,
                    instruction: TYPE_INSTRUCTIONS[type] || 'Se ejecuta en la terminal activa.',
                    hasShebang: !!shebang
                };
            } else if (RESOURCE_TYPES[ext]) {
                descriptor = { ...RESOURCE_TYPES[ext], hasShebang: false };
            } else if (!ext && options.categories.has('program')) {
                try {
                    if ((fs.statSync(full).mode & 0o111) !== 0) {
                        descriptor = {
                            type: 'program', category: 'program', interpreter: null,
                            runnable: true, openable: false,
                            instruction: 'Archivo ejecutable sin extensión.', hasShebang: false
                        };
                    }
                } catch (e) { }
            }
            if (descriptor && options.categories.has(descriptor.category)) {
                if (options.scope === 'here' && !hasRuntimeScriptIntent(full, root, descriptor, options)) continue;
                // Subcarpeta relativa a la raíz escaneada: es lo que permite
                // agrupar el panel por carpetas en vez de volcar una lista
                // plana enorme.
                const relDir = path.relative(root, dir).replace(/\\/g, '/');
                results.push({
                    name: entry.name,
                    ext,
                    type: descriptor.type,
                    category: descriptor.category,
                    interpreter: descriptor.interpreter || null,
                    runnable: descriptor.runnable === true,
                    openable: descriptor.openable === true,
                    instruction: descriptor.instruction || null,
                    path: full,
                    relDir
                });
            }
        } else if (entry.isDirectory()) {
            if (options.scope === 'here' && isIgnoredHereDirectory(entry.name)) continue;
            walkScripts(full, depth + 1, maxDepth, results, root, options);
        }
    }
}

// Lista, con recursividad limitada (por defecto 3 niveles, de sobra para
// organizar scripts en subcarpetas sin arriesgarse a recorrer árboles
// enormes), los scripts reconocibles de una carpeta.
function listScripts(dir, maxDepth, options) {
    if (maxDepth && typeof maxDepth === 'object') {
        options = maxDepth;
        maxDepth = null;
    }
    const opts = { scope: 'library', ...(options || {}) };
    opts.categories = normalizeFileCategories(opts.categories);
    opts.maxResults = Number.isFinite(opts.maxResults)
        ? Math.max(1, opts.maxResults)
        : (opts.scope === 'here' ? MAX_HERE_SCRIPTS : Number.POSITIVE_INFINITY);
    opts.maxDirectories = opts.scope === 'here' ? MAX_HERE_DIRECTORIES : Number.POSITIVE_INFINITY;
    opts.deadline = opts.scope === 'here' ? Date.now() + MAX_HERE_SCAN_MS : Number.POSITIVE_INFINITY;
    opts.visitedDirectories = 0;
    opts.skippedDirectories = 0;
    opts.stopReason = null;
    opts.declaredBins = opts.scope === 'here' ? declaredBinPaths(dir) : new Set();
    const results = [];
    const depth = opts.scope === 'here'
        ? normalizeHereDepth(maxDepth)
        : (maxDepth == null ? DEFAULT_HERE_DEPTH : maxDepth);
    walkScripts(dir, 0, depth, results, dir, opts);
    const sorted = results.sort((a, b) => a.name.localeCompare(b.name));
    sorted.scanInfo = {
        depth,
        visitedDirectories: opts.visitedDirectories,
        skippedDirectories: opts.skippedDirectories,
        stopReason: opts.stopReason || (results.length >= opts.maxResults ? 'results' : null)
    };
    return sorted;
}

// Junta la carpeta de scripts del usuario con las fuentes VBS de WinSlim
// (si existen en esta máquina). Cada entrada queda etiquetada con su
// `source` y, si es una de las sensibles conocidas, con un `hint` de aviso.
function listAllScripts(userScriptsDir, options) {
    const all = listScripts(userScriptsDir, options).map((s) => ({ ...s, source: 'scripts' }));

    if (process.platform === 'win32') {
        WINSLIM_VBS_SOURCES.forEach(({ dir, source }) => {
            listScripts(dir, 0, options).forEach((s) => {
                all.push({
                    ...s,
                    source,
                    hint: SENSITIVE_SCRIPT_HINTS[s.name.toLowerCase()] || null
                });
            });
        });
    }

    return all;
}

function nsudoAvailable() {
    return process.platform === 'win32' && fs.existsSync(NSUDO_PATH);
}

const WINDOWS_SHELL_KINDS = new Set(['cmd', 'powershell']);

function isWindowsPath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

function pathApiFor(...values) {
    return values.some(isWindowsPath) ? path.win32 : path;
}

// Comillas al estilo Windows (cmd/PowerShell): dobles. El caracter `"` no
// puede aparecer en un nombre de archivo de Windows, así que este escapado
// es solo defensa en profundidad, nunca debería activarse en la práctica.
function qWin(p) {
    return '"' + p.replace(/"/g, '""') + '"';
}

// Cadena literal de PowerShell entre comillas simples (sin expansión de
// variables ni subexpresiones): la forma más segura de pasar una ruta como
// argumento de un cmdlet como Start-Process.
function qPsSingle(p) {
    return "'" + p.replace(/'/g, "''") + "'";
}

// Comillas al estilo POSIX (bash/zsh/sh/fish/WSL): simples, que neutralizan
// cualquier metacaracter de shell salvo una comilla simple literal (rara en
// nombres de archivo reales). Es composable: escapar dos veces (para anidar
// dentro de otra cadena de comillas simples) sigue produciendo una cadena
// válida.
function qUnix(p) {
    return "'" + p.replace(/'/g, `'\\''`) + "'";
}

// El proceso principal siempre corre en Windows si process.platform es
// win32, aunque la shell activa sea Git Bash o WSL; las rutas que construye
// Node ahí son del estilo "C:\ruta\...", que esas shells no entienden
// directamente. Se traducen a su convención de rutas.
function toMsysPath(winPath) {
    const m = winPath.match(/^([A-Za-z]):\\(.*)$/);
    if (!m) return winPath;
    return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
function toWslPath(winPath) {
    const m = winPath.match(/^([A-Za-z]):\\(.*)$/);
    if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    const unc = winPath.match(/^\\\\wsl(?:\.localhost)?\$?\\[^\\]+(?:\\(.*))?$/i);
    if (unc) return '/' + (unc[1] || '').replace(/\\/g, '/');
    return winPath;
}
function unixPathFor(rawPath, kind, transport) {
    if (transport === 'docker') return rawPath;
    if (transport === 'wsl' || kind === 'wsl') return toWslPath(rawPath);
    if (transport === 'msys' || process.platform === 'win32') return toMsysPath(rawPath);
    return rawPath;
}

// Construye el comando a escribir en la terminal (o a usar como cuerpo de
// un alias/función) para lanzar `script` desde un entorno de tipo `kind`
// (el mismo "kind" que usa shellDetect.js / aliasProfiles.js), con la
// opción de pedir elevación a administrador. Devuelve null si el tipo de
// script no tiene una forma conocida de lanzarse (no debería pasar:
// listScripts ya filtra por extensión conocida).
// Trocea una cadena de argumentos respetando las comillas dobles, para
// poder pasarlos uno a uno en -ArgumentList (donde una sola cadena con
// espacios llegaría al script como un único argumento). Fuera de ahí los
// argumentos se anexan tal cual: el comando se ve en la terminal antes de
// ejecutarse, así que el usuario controla lo que se manda.
function splitArgs(rawArgs) {
    const matches = String(rawArgs || '').match(/"[^"]*"|\S+/g);
    return matches || [];
}

function buildLaunchCommand(script, kind, asAdmin, rawArgs, options) {
    const opts = options || {};
    const transport = opts.transport || null;
    const windowsSide = WINDOWS_SHELL_KINDS.has(kind);
    const args = String(rawArgs || '').trim();
    const suffix = args ? ' ' + args : '';
    // Cada elemento ya entrecomillado al estilo de PowerShell, listo para
    // encadenarse detrás de la ruta del script en -ArgumentList.
    const psArgList = splitArgs(args)
        .map((a) => ',' + qPsSingle(a.replace(/^"|"$/g, '')))
        .join('');
    // Shells unix corriendo SOBRE Windows (Git Bash/MSYS, o WSL con
    // interoperabilidad): pueden invocar binarios de Windows, pero WSL
    // exige el sufijo .exe explícito para distinguirlos de comandos Linux.
    const onWindowsHost = process.platform === 'win32';
    const isWsl = transport === 'wsl' || kind === 'wsl';
    const exeSuffix = isWsl ? '.exe' : '';
    const psExe = onWindowsHost
        ? (windowsSide ? 'powershell' : `powershell${exeSuffix}`)
        : 'pwsh';
    const cmdExe = `cmd${kind === 'cmd' ? '' : exeSuffix || '.exe'}`;

    // En los entornos Docker creados por la app, /workspace representa una
    // carpeta concreta del host. Los scripts se validan/descubren desde el
    // host, pero dentro del contenedor deben ejecutarse con su ruta montada.
    function pathForExecution(rawPath) {
        if (transport !== 'docker' || !opts.hostRoot || !opts.containerRoot) return rawPath;
        const pathApi = pathApiFor(opts.hostRoot, rawPath);
        const relative = pathApi.relative(opts.hostRoot, rawPath);
        if (!relative || relative === '.') return opts.containerRoot;
        if (relative.startsWith('..') || pathApi.isAbsolute(relative)) return rawPath;
        return opts.containerRoot.replace(/\/$/, '') + '/' + relative.replace(/\\/g, '/');
    }

    const scriptPath = pathForExecution(script.path);

    // Envuelve un comando de PowerShell (que solo debe usar comillas
    // simples, nunca dobles) para poder escribirlo desde cmd/bash/WSL vía
    // `powershell -Command "..."` sin que las comillas choquen entre sí.
    function elevateViaPowerShell(innerPsCommand) {
        return kind === 'powershell' ? innerPsCommand : `${psExe} -Command "${innerPsCommand}"`;
    }

    if (script.type === 'powershell') {
        if (transport === 'docker') return null;
        if (asAdmin) {
            if (!onWindowsHost) return `sudo ${psExe} -NoProfile -File ${qUnix(scriptPath)}${suffix}`;
            const p = qPsSingle(scriptPath);
            return elevateViaPowerShell(
                `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${p}${psArgList}`
            );
        }
        return `${psExe} -NoProfile -ExecutionPolicy Bypass -File ${qWin(scriptPath)}${suffix}`;
    }

    if (script.type === 'batch') {
        if (transport === 'docker') return null;
        if (asAdmin) {
            const argList = psArgList ? ` -ArgumentList ${psArgList.slice(1)}` : '';
            return elevateViaPowerShell(`Start-Process -FilePath ${qPsSingle(scriptPath)}${argList} -Verb RunAs`);
        }
        if (kind === 'powershell') return `& ${qWin(scriptPath)}${suffix}`;
        if (kind === 'cmd') return `call ${qWin(scriptPath)}${suffix}`;
        // bash/zsh/fish/WSL: "call" es un builtin de cmd.exe, ahi no existe.
        // Hay que delegar el .bat al propio cmd.exe (accesible desde Git
        // Bash y desde WSL vía interop), con la ruta en formato Windows.
        return `${cmdExe} /c ${qWin(scriptPath)}${suffix}`;
    }

    if (script.type === 'vbscript') {
        if (transport === 'docker') return null;
        // wscript.exe es el host de VBS sin consola (a diferencia de
        // cscript.exe). La ruta se mantiene en formato Windows aunque la
        // shell activa sea Git Bash/WSL: wscript.exe es un binario de
        // Windows y espera una ruta de Windows, no una traducida.
        if (asAdmin) {
            return elevateViaPowerShell(`Start-Process wscript.exe -ArgumentList ${qPsSingle(scriptPath)}${psArgList} -Verb RunAs`);
        }
        return `wscript.exe ${qWin(scriptPath)}${suffix}`;
    }

    if (script.type === 'shell' || script.type === 'fish') {
        const allowedInterpreter = new Set(['sh', 'bash', 'zsh', 'ksh', 'fish']);
        const bin = allowedInterpreter.has(script.interpreter)
            ? script.interpreter
            : (script.type === 'fish' ? 'fish' : 'bash');
        // Desde cmd/PowerShell se delega explícitamente al intérprete; no se
        // pueden usar chmod, comillas POSIX ni ejecutar el .sh directamente.
        if (windowsSide) {
            const p = qWin(toMsysPath(scriptPath));
            if (!asAdmin) return `${bin} ${p}${suffix}`;
            return elevateViaPowerShell(`Start-Process ${bin} -ArgumentList ${qPsSingle(toMsysPath(scriptPath))}${psArgList} -Verb RunAs`);
        }
        const p = qUnix(unixPathFor(scriptPath, kind, transport));
        const run = `${bin} ${p}${suffix}`;
        return asAdmin ? `sudo ${run}` : run;
    }

    const runtimeBins = {
        python: 'python', node: 'node', ruby: 'ruby', php: 'php',
        perl: 'perl', lua: 'lua', rscript: 'Rscript', groovy: 'groovy'
    };
    if (runtimeBins[script.type]) {
        if (windowsSide) {
            const bin = runtimeBins[script.type];
            if (!asAdmin) return `${bin} ${qWin(scriptPath)}${suffix}`;
            return elevateViaPowerShell(`Start-Process ${bin} -ArgumentList ${qPsSingle(scriptPath)}${psArgList} -Verb RunAs`);
        }
        // Git Bash sobre Windows usa el Python/Node de Windows ("python");
        // WSL y Linux/Mac nativos usan los suyos ("python3").
        const useWindowsPython = onWindowsHost && !isWsl && transport !== 'docker';
        const bin = script.type === 'python' ? (useWindowsPython ? 'python' : 'python3') : runtimeBins[script.type];
        const p = qUnix(unixPathFor(scriptPath, kind, transport));
        return asAdmin ? `sudo ${bin} ${p}${suffix}` : `${bin} ${p}${suffix}`;
    }

    if (script.type === 'java') {
        if (windowsSide) {
            if (!asAdmin) return `java -jar ${qWin(scriptPath)}${suffix}`;
            return elevateViaPowerShell(`Start-Process java -ArgumentList '-jar',${qPsSingle(scriptPath)}${psArgList} -Verb RunAs`);
        }
        const p = qUnix(unixPathFor(scriptPath, kind, transport));
        const run = `java -jar ${p}${suffix}`;
        return asAdmin ? `sudo ${run}` : run;
    }

    if (script.type === 'program') {
        const ext = String(script.ext || '').toLowerCase();
        const windowsProgram = ext === '.exe' || ext === '.com';
        if (transport === 'docker' && windowsProgram) return null;
        if (onWindowsHost && ext === '.appimage' && !isWsl && transport !== 'docker') return null;

        if (windowsProgram && onWindowsHost && asAdmin) {
            return elevateViaPowerShell(`Start-Process -FilePath ${qPsSingle(scriptPath)}${psArgList ? ` -ArgumentList ${psArgList.slice(1)}` : ''} -Verb RunAs`);
        }
        if (windowsSide) {
            if (kind === 'powershell') return `& ${qWin(scriptPath)}${suffix}`;
            return `${qWin(scriptPath)}${suffix}`;
        }

        const p = qUnix(unixPathFor(scriptPath, kind, transport));
        if (ext === '.appimage') {
            return asAdmin
                ? `chmod +x -- ${p} && sudo ${p}${suffix}`
                : `chmod +x -- ${p} && ${p}${suffix}`;
        }
        const run = `${p}${suffix}`;
        return asAdmin ? `sudo ${run}` : run;
    }

    return null;
}

// Cambia la pestaña activa a la carpeta que contiene un resultado. La ruta
// se traduce con las mismas reglas que los scripts (WSL, Git Bash y Docker).
function buildCdCommand(targetPath, kind, options) {
    const opts = options || {};
    const transport = opts.transport || null;
    const targetPathApi = pathApiFor(targetPath);
    // `targetPath` es normalmente un ARCHIVO, y navegar significa ir a la
    // carpeta que lo contiene. Con `directory: true` la ruta YA es la carpeta
    // destino y subir un nivel sería un error.
    //
    // El explorador lateral pasaba una entrada ficticia (`join(dir, '.')`) para
    // reutilizar este camino, pero `join` normaliza y elimina el `.`, así que
    // dirname acababa devolviendo la carpeta padre: pulsar `cd` dejaba la
    // terminal un nivel por encima de lo que el panel estaba mostrando.
    let dir = opts.directory === true ? targetPath : targetPathApi.dirname(targetPath);
    if (transport === 'docker') {
        if (!opts.hostRoot || !opts.containerRoot) return null;
        const pathApi = pathApiFor(opts.hostRoot, dir);
        const relative = pathApi.relative(opts.hostRoot, dir);
        if (relative.startsWith('..') || pathApi.isAbsolute(relative)) return null;
        dir = relative && relative !== '.'
            ? opts.containerRoot.replace(/\/$/, '') + '/' + relative.replace(/\\/g, '/')
            : opts.containerRoot;
    }
    if (kind === 'cmd') return `cd /d ${qWin(dir)}`;
    if (kind === 'powershell') return `Set-Location -LiteralPath ${qPsSingle(dir)}`;
    return `cd ${qUnix(unixPathFor(dir, kind, transport))}`;
}

// Preferencias para abrir/reutilizar una pestaña realmente compatible al
// ejecutar scripts ligados a una shell. Los runtimes como Python/Node se
// mantienen en la terminal actual: no son shells interactivas de la app.
function environmentKindsForScript(script) {
    if (!script) return [];
    if (script.type === 'powershell') return ['powershell'];
    if (script.type === 'batch' || script.type === 'vbscript') return ['cmd', 'powershell'];
    if (script.type === 'fish') return ['fish'];
    if (script.type === 'shell') {
        const interpreter = script.interpreter || 'bash';
        const fallbacks = interpreter === 'zsh'
            ? ['zsh']
            : interpreter === 'ksh'
                ? ['ksh', 'bash', 'sh']
                : interpreter === 'sh'
                    ? ['sh', 'bash', 'zsh']
                    : ['bash', 'sh', 'zsh'];
        return Array.from(new Set(fallbacks));
    }
    if (script.type === 'program') {
        const ext = String(script.ext || '').toLowerCase();
        if (ext === '.exe' || ext === '.com') return ['cmd', 'powershell'];
        if (ext === '.appimage') return ['bash', 'sh', 'zsh'];
    }
    return [];
}

function sanitizeAliasName(rawName) {
    let name = rawName.replace(/[^A-Za-z0-9_-]/g, '_');
    if (/^[0-9]/.test(name)) name = '_' + name;
    return name;
}

// Tipo de script "nativo" por familia de shell, usado para desempatar
// cuando dos scripts distintos generarían el mismo nombre de alias (p. ej.
// "deploy.ps1" y "deploy.sh"): gana el que coincide con la shell activa.
const NATIVE_TYPE_BY_KIND = {
    cmd: 'batch',
    powershell: 'powershell',
    bash: 'shell',
    zsh: 'shell',
    sh: 'shell',
    fish: 'fish',
    wsl: 'shell'
};

// Agrupa una lista de scripts por su nombre de alias (nombre de archivo sin
// ruta ni extensión, saneado a caracteres válidos) y resuelve colisiones
// prefiriendo el tipo nativo de `kind`. Los .vbs solo tienen sentido en
// Windows y ya vienen filtrados por SO desde listAllScripts.
function resolveScriptAliases(scripts, kind) {
    const groups = new Map();
    scripts.forEach((script) => {
        const base = path.basename(script.name, script.ext);
        const aliasName = sanitizeAliasName(base);
        if (!aliasName) return;
        if (!groups.has(aliasName)) groups.set(aliasName, []);
        groups.get(aliasName).push(script);
    });

    const nativeType = NATIVE_TYPE_BY_KIND[kind];
    const resolved = [];
    groups.forEach((candidates, aliasName) => {
        let chosen = candidates[0];
        if (candidates.length > 1 && nativeType) {
            const nativeMatch = candidates.find((c) => c.type === nativeType);
            if (nativeMatch) chosen = nativeMatch;
        }
        resolved.push({ aliasName, script: chosen });
    });
    return resolved;
}

module.exports = {
    listScripts,
    listAllScripts,
    buildLaunchCommand,
    buildCdCommand,
    environmentKindsForScript,
    resolveScriptAliases,
    unixPathFor,
    nsudoAvailable,
    SCRIPT_TYPES,
    FILE_FILTERS,
    normalizeFileCategories,
    HERE_IGNORED_DIRS,
    MAX_HERE_SCRIPTS,
    DEFAULT_HERE_DEPTH,
    MIN_HERE_DEPTH,
    MAX_HERE_DEPTH,
    normalizeHereDepth,
    NSUDO_PATH
};
