// main/aliasProfiles.js
// Inicialización de cada shell: alias "canónicos" heredados de terminal.js
// (el .hta original) traducidos a la sintaxis nativa de cada familia, más
// los dinámicos: NSudo (si está presente en esta máquina) y uno por cada
// script detectado en la carpeta de scripts / fuentes VBS de WinSlim (ver
// scriptLauncher.js). En Windows se mantienen los alias originales (edit,
// ip, ll, ls, pwd, clear). En shells unix, ls/pwd/clear ya son comandos
// nativos: solo se traduce el vocabulario específico de Windows.
//
// Todo esto NO se teclea en la shell: se escribe en un archivo temporal que
// la shell carga con una sola línea corta (call / dot-source / source). Así
// no se ve la parrafada de alias al abrir la pestaña, no queda un comando
// gigante en el historial (flecha arriba), y no hay límite práctico de
// longitud, con lo que todos los scripts detectados llegan a tener alias.

const { buildLaunchCommand, unixPathFor } = require('./scriptLauncher');
const { buildPackageAliasLines, PACKAGE_ALIAS_NAMES } = require('./packageAliases');

// Marcador con el que la shell avisa a la app de que acaba de limpiar.
//
// Por qué hace falta: `cls` bajo ConPTY no emite ninguna secuencia de
// borrado (ni ESC[2J ni ESC[3J). Lo que emite es un repintado línea a línea
// (ESC[H y un ESC[K por fila) que, al llegar al final de la pantalla,
// EMPUJA lo anterior al historial de xterm en vez de tirarlo. De ahí que
// `clear` pareciera "mover la consola un poco": la pantalla queda limpia,
// pero todo lo viejo sigue ahí, un scroll más arriba.
//
// El aviso NO puede ir como texto impreso (`echo`): ConPTY no reenvía la
// salida tal cual, sino el resultado de repintar su buffer, así que un texto
// borrado por el `cls` inmediatamente posterior se pierde por el camino de
// forma intermitente. Sí reenvía en cambio los cambios de TÍTULO (OSC 0),
// que viajan fuera del contenido de la pantalla, llegan siempre y no se
// reemiten en los repintados por redimensionado. El sufijo aleatorio
// garantiza que cada limpieza sea un cambio de título distinto (un título
// repetido no generaría ningún evento).
const CLEAR_MARKER = '__TERMINAL_CLEAR__';

// Comando de limpieza completo por familia de shell:
//   1. marcador: la app vacía pantalla e historial ANTES del repintado,
//   2. borrado nativo (deja limpio también el buffer interno de ConPTY, lo
//      que evita que un repintado posterior resucite lo borrado),
//   3. banner, leído del archivo que main.js genera por pestaña.
// El banner lo imprime la SHELL, no la app: así forma parte del buffer de
// ConPTY y sobrevive a los repintados (si lo pintara la app, el primer
// redimensionado se lo llevaría por delante).
function clearCommand(kind, bannerPath, insideDoskeyMacro, transport, appName) {
    const banner = bannerPath ? unixPathFor(bannerPath, kind, transport) : null;
    const title = typeof appName === 'string' && appName.trim() ? appName.trim() : 'Terminal';

    if (kind === 'cmd') {
        const sep = insideDoskeyMacro ? '$T' : '&';
        // Dentro de una macro doskey el % hay que duplicarlo: si no, cmd
        // expande %RANDOM% al DEFINIR la macro y el título queda fijo. Un
        // título que no cambia no genera ningún evento, así que la segunda
        // limpieza seguida pasaría desapercibida.
        const random = insideDoskeyMacro ? '%%RANDOM%%' : '%RANDOM%';
        // El marcador debe llegar antes que el repintado de ConPTY. Cuando
        // llegaba al final, xterm ya había recibido el prompt antiguo y el
        // nuevo, de ahí las dos líneas observadas después de clear/cls.
        // El título vuelve a su valor limpio en cuanto el borrado ya ocurrió.
        // Si el marcador se quedara puesto, ConPTY lo reemite cada vez que un
        // proceso hijo (powershell, winget, wsl...) termina y restaura el
        // título de la consola, y la app interpretaría cada una de esas
        // reemisiones como una limpieza nueva: la salida del comando
        // desaparecía sola y el banner no volvía a pintarse.
        const parts = [`title ${title} ${CLEAR_MARKER}${random}`, 'cls', `title ${title}`];
        if (bannerPath) parts.push(`type "${bannerPath}"`);
        return parts.join(sep);
    }
    if (kind === 'powershell') {
        const psTitle = title.replace(/'/g, "''");
        const parts = [
            `$Host.UI.RawUI.WindowTitle = '${psTitle} ${CLEAR_MARKER}' + (Get-Random)`,
            'Clear-Host',
            `$Host.UI.RawUI.WindowTitle = '${psTitle}'`
        ];
        if (bannerPath) parts.push(`Write-Host (Get-Content -Raw '${bannerPath}') -NoNewline`);
        return parts.join('; ');
    }
    // bash / zsh / sh / fish / wsl: "command clear" evita que la función se
    // llame a sí misma. El título se escribe a mano porque no todas las
    // shells traen un comando para ello.
    const rnd = kind === 'fish' ? '(random)' : '"${RANDOM:-$$}"';
    const safeTitle = title.replace(/'/g, '');
    const parts = [
        `printf '\\033]0;${safeTitle} ${CLEAR_MARKER}%s\\007' ${rnd}`,
        'command clear',
        `printf '\\033]0;${safeTitle}\\007'`
    ];
    if (banner) parts.push(`cat '${banner}'`);
    return parts.join('; ');
}

// "clear" y "cls" no están en la tabla de traducción: no son vocabulario
// sino un comando con tratamiento especial, y no deben recibir los
// argumentos del usuario ($* / @args).
const WINDOWS_ALIASES = {
    edit: 'notepad',
    ip: 'ipconfig',
    ll: 'dir',
    ls: 'dir',
    pwd: 'cd'
};

function unixAliases(kind) {
    const ipFallback = kind === 'fish'
        ? 'ip addr 2>/dev/null; or ifconfig'
        : 'ip addr 2>/dev/null || ifconfig';
    return {
        edit: 'nano',
        ip: ipFallback,
        ll: 'ls -alh'
    };
}

// Redefine clear/cls en la shell. En PowerShell hay que forzar los alias:
// la resolución de comandos da prioridad a los alias integrados
// (clear -> Clear-Host) sobre cualquier función que definamos.
function clearAliasLines(kind, bannerClearPath, transport, appName) {
    if (kind === 'cmd') {
        const body = clearCommand(kind, bannerClearPath, true, transport, appName);
        return [`doskey cls=${body}`, `doskey clear=${body}`];
    }
    const body = clearCommand(kind, bannerClearPath, false, transport, appName);
    if (kind === 'powershell') {
        // -Option AllScope es obligatorio: los alias integrados clear/cls ya
        // lo llevan, y PowerShell rechaza redefinirlos si al hacerlo se les
        // quitaría esa opción ("La opción AllScope no se puede quitar").
        return [
            `function Clear-TerminalHost { ${body} }`,
            'Set-Alias -Name clear -Value Clear-TerminalHost -Option AllScope -Force -Scope Global',
            'Set-Alias -Name cls -Value Clear-TerminalHost -Option AllScope -Force -Scope Global'
        ];
    }
    // "cls" también en shells unix: en Windows es el nombre que la gente
    // teclea por costumbre, y aquí Git Bash/WSL conviven con cmd en la misma
    // ventana (sin esto, "cls" solo responde "command not found").
    if (kind === 'fish') {
        return [`function clear; ${body}; end`, 'function cls; clear; end'];
    }
    return [`clear() { ${body}; }`, 'cls() { clear; }'];
}

function qWinDbl(p) {
    return '"' + p.replace(/"/g, '""') + '"';
}

// Comando NSudo (TrustedInstaller + todos los privilegios), la combinación
// más alta disponible, tal como la documenta el propio `-?` de NSudoLC.exe.
function nsudoAliasLine(kind, nsudoPath, transport) {
    if (!nsudoPath) return null;

    if (kind === 'cmd') {
        return `doskey nsudo=${qWinDbl(nsudoPath)} -U:T -P:E $*`;
    }
    if (kind === 'powershell') {
        return `function nsudo { & ${qWinDbl(nsudoPath)} -U:T -P:E @args }`;
    }

    // bash / zsh / sh / fish / WSL: NSudoLC.exe es un binario de Windows;
    // se llama por su ruta traducida al estilo de cada una (WSL: /mnt/c/...,
    // Git Bash/MSYS: /c/...).
    const p = unixPathFor(nsudoPath, kind, transport);
    const escaped = p.replace(/'/g, kind === 'fish' ? "\\'" : `'\\''`);
    return `alias nsudo='${escaped} -U:T -P:E'`;
}

// "sysinfo": si el sistema ya tiene fastfetch/neofetch, se usan (son mucho
// más completos que lo que podríamos generar nosotros); si no, se cae al
// banner propio de la app, que ya está en un archivo listo para imprimir.
function sysinfoAliasLine(kind, bannerPath, transport) {
    const banner = bannerPath ? unixPathFor(bannerPath, kind, transport) : null;

    // Sin archivo de banner (temporal no escribible) se cae al comando
    // nativo del sistema, que es lo que había antes de tener banner propio.
    if (kind === 'cmd') {
        return bannerPath ? `doskey sysinfo=type "${bannerPath}"` : 'doskey sysinfo=systeminfo';
    }
    if (kind === 'powershell') {
        if (!bannerPath) {
            return 'function sysinfo { Get-ComputerInfo | Select-Object OsName, OsVersion, CsProcessors, CsTotalPhysicalMemory, OsUptime }';
        }
        return `function sysinfo { Write-Host (Get-Content -Raw '${bannerPath}') -NoNewline }`;
    }
    const fallback = banner ? `cat '${banner}'` : 'uname -a';
    if (kind === 'fish') {
        return `function sysinfo; if command -v fastfetch >/dev/null; fastfetch; else if command -v neofetch >/dev/null; neofetch; else; ${fallback}; end; end`;
    }
    // bash / zsh / sh / wsl
    return `sysinfo() { if command -v fastfetch >/dev/null 2>&1; then fastfetch; elif command -v neofetch >/dev/null 2>&1; then neofetch; else ${fallback}; fi; }`;
}

// Texto de "ayuda". Va a un archivo, igual que el banner, en vez de dentro
// del propio alias: así puede ocupar varias líneas, llevar color y traducirse
// sin pelearse con el entrecomillado de cinco familias de shell distintas.
//
// Lo importante que explica: que el vocabulario es el MISMO en todas las
// shells. `install` instala aquí llame el sistema a su gestor winget, apt o
// pacman, y quien abre la terminal no tiene que saber cuál le toca.
const HELP_TITLE_COLOR = '\x1b[1;36m';
const HELP_SECTION_COLOR = '\x1b[1;33m';
const HELP_CMD_COLOR = '\x1b[38;5;250m';
const HELP_RESET = '\x1b[0m';

function helpRow(command, description) {
    const padded = command.length >= 22 ? command + ' ' : command.padEnd(22, ' ');
    return `    ${HELP_CMD_COLOR}${padded}${HELP_RESET}${description}`;
}

// `managerLabel` solo se conoce en Windows: en Unix el gestor lo resuelve la
// propia shell al invocar el alias (ver packageAliases.js), así que ahí se
// dice eso mismo en vez de inventar un nombre.
function buildHelpText(kind, options) {
    const opts = options || {};
    // Sin traductor (pruebas, o una llamada que no lo pasa) el respaldo tiene
    // que sustituir igualmente los {parámetros}: devolver la plantilla cruda
    // deja "{manager}" impreso en pantalla, que es peor que no traducir.
    const t = typeof opts.t === 'function'
        ? opts.t
        : (key, params, fallback) => String(fallback || '').replace(/\{(\w+)\}/g,
            (match, name) => (params && params[name] !== undefined ? String(params[name]) : match));
    const appName = opts.appName || 'Terminal';
    const scriptNames = opts.scriptNames || [];
    const lines = [];

    lines.push('');
    lines.push(`${HELP_TITLE_COLOR}${appName}${HELP_RESET} · ` + t('help.title', { shell: opts.envLabel || kind },
        'comandos añadidos a esta sesión ({shell})'));
    lines.push('');

    lines.push(`${HELP_SECTION_COLOR}` + t('help.packages', null, 'Paquetes') + `${HELP_RESET} — `
        + (opts.managerLabel
            ? t('help.packagesManager', { manager: opts.managerLabel },
                'el mismo vocabulario en todas las shells; aquí lo atiende {manager}')
            : t('help.packagesAuto', null,
                'el mismo vocabulario en todas las shells; el gestor se elige solo al ejecutarlo')));
    lines.push(helpRow('install <paquete>', t('help.install', null, 'Instala un paquete.')));
    lines.push(helpRow('update [paquete]', t('help.update', null, 'Sin argumentos actualiza todo el sistema.')));
    lines.push(helpRow('upgrade', t('help.upgrade', null, 'Actualiza todo el sistema.')));
    lines.push(helpRow('uninstall <paquete>', t('help.uninstall', null, 'Desinstala. "remove" hace lo mismo.')));
    lines.push(helpRow('search <texto>', t('help.search', null, 'Busca un paquete por nombre. No pide privilegios.')));
    lines.push('');

    lines.push(`${HELP_SECTION_COLOR}` + t('help.session', null, 'Sesión') + HELP_RESET);
    lines.push(helpRow('clear / cls', t('help.clear', null, 'Limpia pantalla e historial y repinta el banner.')));
    lines.push(helpRow('sysinfo', t('help.sysinfo', null, 'Vuelve a imprimir la información del sistema.')));
    lines.push(helpRow('ayuda', t('help.help', null, 'Esta ayuda.')));
    if (opts.hasNsudo) {
        lines.push(helpRow('nsudo <comando>', t('help.nsudo', null, 'Ejecuta como TrustedInstaller, con todos los privilegios.')));
    }
    lines.push('');

    const vocabulary = kind === 'cmd' || kind === 'powershell'
        ? Object.keys(WINDOWS_ALIASES)
        : Object.keys(unixAliases(kind));
    lines.push(`${HELP_SECTION_COLOR}` + t('help.vocabulary', null, 'Vocabulario traducido a esta shell') + HELP_RESET);
    lines.push(helpRow(vocabulary.join(', '), ''));
    lines.push('');

    lines.push(`${HELP_SECTION_COLOR}` + t('help.scripts', null, 'Scripts de la Biblioteca') + HELP_RESET
        + ` (${scriptNames.length})`);
    lines.push(scriptNames.length
        ? helpRow(scriptNames.join(', '), '')
        : '    ' + t('help.noScripts', null, 'Ninguno detectado. Elige una carpeta en el panel Scripts > Biblioteca.'));
    lines.push('');

    return lines.join('\r\n') + '\r\n';
}

// Alias "ayuda": imprime el archivo anterior. Sin archivo (temporal no
// escribible) se cae a una línea suelta, que es mejor que nada.
function helpAliasLine(kind, helpPath, hasNsudo, scriptNames, transport) {
    if (!helpPath) {
        const fixed = 'edit, ip, ll, ls, pwd, clear, sysinfo, ayuda, '
            + PACKAGE_ALIAS_NAMES.join(', ')
            + (hasNsudo ? ', nsudo' : '');
        const scripts = scriptNames.length ? scriptNames.join(', ') : '(ninguno detectado)';
        const message = `Alias fijos: ${fixed} -- Scripts detectados: ${scripts}`;
        if (kind === 'cmd') return `doskey ayuda=echo ${message}`;
        if (kind === 'powershell') return `function ayuda { Write-Host ${qWinDbl(message)} -ForegroundColor Cyan }`;
        if (kind === 'fish') return `function ayuda; echo '${message.replace(/'/g, "\\'")}'; end`;
        return `ayuda() { echo '${message.replace(/'/g, `'\\''`)}'; }`;
    }

    if (kind === 'cmd') return `doskey ayuda=type "${helpPath}"`;
    if (kind === 'powershell') return `function ayuda { Write-Host (Get-Content -Raw '${helpPath}') -NoNewline }`;
    const unixHelp = unixPathFor(helpPath, kind, transport);
    if (kind === 'fish') return `function ayuda; cat '${unixHelp}'; end`;
    return `ayuda() { cat '${unixHelp}'; }`;
}

function scriptAliasLine(kind, aliasName, script, transport) {
    const command = buildLaunchCommand(script, kind, false, '', { transport });
    if (!command) return null;

    if (kind === 'cmd') return `doskey ${aliasName}=${command} $*`;
    if (kind === 'powershell') return `function ${aliasName} { ${command} @args }`;
    if (kind === 'fish') return `alias ${aliasName} '${command.replace(/'/g, "\\'")}'`;
    return `alias ${aliasName}='${command.replace(/'/g, `'\\''`)}'`;
}

// Cabecera y final del archivo de inicialización por familia de shell.
// `@echo off` (cmd) es lo que impide que cada línea del archivo se imprima.
const SCRIPT_FORMAT = {
    cmd: { ext: 'cmd', eol: '\r\n', header: ['@echo off'] },
    powershell: { ext: 'ps1', eol: '\r\n', header: [] },
    bash: { ext: 'sh', eol: '\n', header: [] },
    zsh: { ext: 'sh', eol: '\n', header: [] },
    sh: { ext: 'sh', eol: '\n', header: [] },
    wsl: { ext: 'sh', eol: '\n', header: [] },
    fish: { ext: 'fish', eol: '\n', header: [] }
};

// Nombres reservados: un script del usuario nunca puede pisarlos (perdería
// acceso a funcionalidad básica de la terminal sin saber por qué).
const RESERVED = new Set([
    'nsudo', 'sysinfo', 'ayuda', 'help', 'clear', 'cls',
    ...PACKAGE_ALIAS_NAMES
]);

// ¿Puede esta sesión leer los archivos temporales que genera la app?
//
// Los contenedores no ven el sistema de archivos del host (y pueden caer a sh
// aunque se prefiera bash), la shell de un móvil por ADB tampoco, y el cmd.exe
// de Wine solo ve el prefijo como Z:\..., no la ruta POSIX del temporal. En
// esos tres transportes no se escribe inicialización ninguna: ni alias, ni
// `sysinfo`, ni banner impreso por la shell.
//
// Importa fuera de este módulo porque decide QUIÉN pinta el banner: la shell
// (leyendo el archivo) o la propia aplicación (escribiéndolo en el xterm).
const TRANSPORTS_WITHOUT_HOST_FILES = new Set(['docker', 'android', 'wine']);

function transportLoadsHostFiles(transport) {
    return !TRANSPORTS_WITHOUT_HOST_FILES.has(transport);
}

// options: { nsudoPath?: string, scriptAliases?: [{ aliasName, script }], bannerPath?: string }
// Devuelve { ext, content } con el archivo a escribir, o null si la shell no
// es de ninguna familia conocida (p. ej. la shell de un dispositivo Android:
// ahí no se inyecta nada).
function buildInitScript(kind, options) {
    const format = SCRIPT_FORMAT[kind];
    if (!format) return null;

    const opts = options || {};
    const bannerPath = opts.bannerPath || null;
    const bannerClearPath = opts.bannerClearPath || bannerPath;
    const lines = [...format.header];

    if (kind === 'cmd') {
        Object.entries(WINDOWS_ALIASES).forEach(([k, v]) => lines.push(`doskey ${k}=${v} $*`));
    } else if (kind === 'powershell') {
        Object.entries(WINDOWS_ALIASES).forEach(([k, v]) => lines.push(`function ${k} { ${v} @args }`));
    } else if (kind === 'fish') {
        Object.entries(unixAliases('fish')).forEach(([k, v]) => lines.push(`alias ${k} '${v}'`));
    } else {
        Object.entries(unixAliases(kind)).forEach(([k, v]) => lines.push(`alias ${k}='${v}'`));
    }

    lines.push(...clearAliasLines(kind, bannerClearPath, opts.transport, opts.appName));

    // install / update / upgrade / uninstall / remove sobre el gestor de
    // paquetes real de este entorno.
    lines.push(...buildPackageAliasLines(kind, {
        platform: opts.platform,
        windowsManager: opts.windowsManager,
        transport: opts.transport
    }));

    const nsudoLine = nsudoAliasLine(kind, opts.nsudoPath, opts.transport);
    if (nsudoLine) lines.push(nsudoLine);

    lines.push(sysinfoAliasLine(kind, bannerPath, opts.transport));

    const registeredScripts = [];
    (opts.scriptAliases || []).forEach(({ aliasName, script }) => {
        if (WINDOWS_ALIASES[aliasName] || RESERVED.has(aliasName)) return;
        const line = scriptAliasLine(kind, aliasName, script, opts.transport);
        if (!line) return;
        lines.push(line);
        registeredScripts.push(aliasName);
    });

    lines.push(helpAliasLine(kind, opts.helpPath, !!opts.nsudoPath, registeredScripts, opts.transport));

    // Pantalla limpia + banner: lo último que hace el archivo, y la señal
    // para la app de que la pestaña ya puede mostrarse.
    lines.push(clearCommand(kind, bannerClearPath, false, opts.transport, opts.appName));

    // El texto de la ayuda se devuelve junto al script: quien llama ya sabe
    // en qué ruta lo va a escribir (se la pasó como helpPath), pero solo aquí
    // se sabe qué scripts han llegado a registrarse de verdad.
    return {
        ext: format.ext,
        content: lines.join(format.eol) + format.eol,
        helpText: opts.helpPath ? buildHelpText(kind, {
            t: opts.t,
            appName: opts.appName,
            envLabel: opts.envLabel,
            managerLabel: opts.managerLabel,
            hasNsudo: !!opts.nsudoPath,
            scriptNames: registeredScripts
        }) : null
    };
}

// La única línea que se teclea de verdad en la shell: cargar el archivo
// anterior en la sesión actual (no en un proceso hijo, o los alias no
// existirían al volver).
function buildInitInvocation(kind, initPath, transport) {
    if (!SCRIPT_FORMAT[kind]) return null;
    if (kind === 'cmd') return `call "${initPath}"`;
    if (kind === 'powershell') return `. "${initPath}"`;
    // fish eliminó "." en la versión 3.0: allí el comando es "source". En
    // bash/zsh/sh/WSL se usa "." porque es POSIX y existe en todas (a
    // diferencia de "source", que no está en algunas sh).
    const quoted = `'${unixPathFor(initPath, kind, transport)}'`;
    return kind === 'fish' ? `source ${quoted}` : `. ${quoted}`;
}

module.exports = {
    buildInitScript,
    buildInitInvocation,
    buildHelpText,
    clearCommand,
    transportLoadsHostFiles,
    WINDOWS_ALIASES,
    unixAliases,
    CLEAR_MARKER
};
