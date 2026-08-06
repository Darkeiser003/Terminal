// main/commandNotFound.js
// Detecta, a partir de lo que la shell activa escribe en la terminal, cuando
// el usuario tecleó un comando de una herramienta conocida que no está
// instalada, para poder sugerir instalarla ahí mismo (reutilizando el
// catálogo de main/installActions.js) en vez de solo mostrar el error nativo
// de "comando no encontrado" de cada shell.

// Cada patrón captura el nombre del comando que falló. El texto exacto del
// mensaje varía por shell y por idioma del sistema; se cubren español e
// inglés, que son los más comunes.
const PATTERNS = [
    // cmd.exe
    { regex: /'([^']+)' no se reconoce como un comando interno o externo/ },
    { regex: /'([^']+)' is not recognized as an internal or external command/ },
    // PowerShell (Windows/Core)
    { regex: /El término '([^']+)' no se reconoce como nombre de un cmdlet/ },
    { regex: /The term '([^']+)' is not recognized as the name of a cmdlet/ },
    // bash / sh / WSL / Git Bash
    { regex: /(?:bash|sh): ([^\s:]+): (?:command not found|no se encontró la orden)/ },
    // zsh
    { regex: /zsh: command not found: (\S+)/ },
    // fish
    { regex: /fish: Unknown command:? (\S+)/ }
];

// Solo interesa la primera "palabra" del comando (docker, git, node...): si
// el usuario escribió "docker ps" y falló, la shell solo reporta "docker".
function extractToolName(rawCommand) {
    return rawCommand.trim().split(/\s+/)[0].toLowerCase().replace(/\.exe$/, '');
}

// Devuelve el nombre de la herramienta que falta, o null si el fragmento de
// salida no contiene ninguno de los patrones conocidos de "no encontrado".
function detectMissingCommand(outputBuffer) {
    for (const { regex } of PATTERNS) {
        const match = outputBuffer.match(regex);
        if (match) return extractToolName(match[1]);
    }
    return null;
}

// Catálogo de herramientas reconocibles -> id de acción de instalación (ver
// getInstallActions en installActions.js) según el SO. `null` significa que
// se reconoce la herramienta pero no hay instalación automática disponible.
const KNOWN_TOOLS = {
    docker:  { label: 'Docker',           win32: 'winget-docker', darwin: 'brew-docker', linux: 'pkg-docker' },
    git:     { label: 'Git',              win32: 'winget-git',    darwin: 'brew-git',     linux: 'pkg-git' },
    node:    { label: 'Node.js',          win32: 'winget-node',   darwin: 'brew-node',    linux: 'pkg-node' },
    npm:     { label: 'Node.js (npm)',    win32: 'winget-node',   darwin: 'brew-node',    linux: 'pkg-node' },
    python:  { label: 'Python',           win32: 'winget-python', darwin: 'brew-python',  linux: 'pkg-python' },
    python3: { label: 'Python',           win32: 'winget-python', darwin: 'brew-python',  linux: 'pkg-python' },
    adb:     { label: 'ADB (Android Platform Tools)', win32: 'adb-install', darwin: 'brew-adb', linux: 'pkg-adb' },
    ssh:     { label: 'SSH (OpenSSH)',    win32: 'winget-ssh',    darwin: 'brew-ssh',     linux: 'pkg-ssh' },
    wsl:     { label: 'WSL',              win32: 'wsl-install-base', darwin: null,        linux: null },
    bash:    { label: 'Bash / Git Bash',  win32: 'winget-git',    darwin: 'brew-bash',    linux: 'pkg-bash' },
    zsh:     { label: 'zsh',              win32: null,            darwin: 'brew-zsh',     linux: 'pkg-zsh' },
    fish:    { label: 'fish',             win32: null,            darwin: 'brew-fish',    linux: 'pkg-fish' },
    pwsh:    { label: 'PowerShell 7',     win32: 'winget-pwsh',   darwin: null,           linux: 'pkg-pwsh' },
    // En Linux/macOS, `wine` es lo que da un cmd.exe utilizable: si alguien lo
    // teclea sin tenerlo, la sugerencia lleva justo a esa instalación.
    wine:    { label: 'Wine (cmd.exe)',   win32: null,            darwin: null,           linux: 'pkg-wine' },
    wt:      { label: 'Windows Terminal', win32: 'winget-wt',     darwin: null,           linux: null }
};

// Resuelve el nombre de herramienta detectado a una sugerencia concreta para
// el SO actual, o null si no es una herramienta reconocida.
function resolveToolSuggestion(toolName, platform, context) {
    const known = KNOWN_TOOLS[toolName];
    if (!known) return null;
    if (platform === 'win32' && context && context.transport === 'wsl' && context.distro) {
        const distroId = String(context.distro).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const wslTool = toolName === 'npm' ? 'node' : toolName === 'python3' ? 'python' : toolName;
        if (['git', 'node', 'python', 'bash', 'fish', 'zsh'].includes(wslTool)) {
            return { tool: toolName, label: `${known.label} en WSL: ${context.distro}`, actionId: `wsl-${distroId}-${wslTool}` };
        }
    }
    const platformKey = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    return { tool: toolName, label: known.label, actionId: known[platformKey] };
}

module.exports = { detectMissingCommand, resolveToolSuggestion };
