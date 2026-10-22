const shellIds = new Set([
    'bash', 'zsh', 'fish', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'wine-cmd',
]);

const interactiveReplShellIds = new Set(['nu', 'xonsh', 'elvish']);
// Swift en Windows expone el compilador y `swift --version`, pero su proceso
// sin argumentos no mantiene un REPL utilizable dentro de ConPTY (termina o
// devuelve un error de JIT). Se prueba como herramienta en el builder y se
// omite aquí para no confundir esa limitación del runtime con un fallo de la
// terminal. PureScript instala `purs`, pero `purs repl` solo muestra ayuda y
// termina; su flujo oficial (`pulp psci`) necesita un proyecto Pulp y no es
// un REPL autónomo reproducible en esta matriz. La instalación y el binario
// siguen cubiertos por los probes de entorno.
const nonInteractiveLanguageTools = new Set(['dart', 'swift', 'scala-cli', 'purescript']);

const serviceBackedRepls = new Set([
    'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis',
    'sqlserver', 'oracle-sql', 'neo4j', 'cassandra',
]);

const replCommands = {
    python: (m) => `print('${m}')`,
    ipython: (m) => `print('${m}')`,
    // La notación de corchetes evita el punto que perdía la primera letra
    // en la ruta Windows WebDriver/PTY (`console.log` llegaba como `console.og`).
    node: (m) => `console['log']('${m}')`,
    deno: (m) => `console.log('${m}')`,
    bun: (m) => `console.log('${m}')`,
    typescript: (m) => `console.log('${m}')`,
    gjs: (m) => `print('${m}')`,
    quickjs: (m) => `print('${m}')`,
    'v8-shell': (m) => `print('${m}')`,
    ruby: (m) => `puts '${m}'`,
    java: (m) => `System.out.println("${m}");`,
    php: (m) => `echo '${m}' . PHP_EOL;`,
    lua: (m) => `print('${m}')`,
    luajit: (m) => `print('${m}')`,
    r: (m) => `cat('${m}\\n')`,
    groovy: (m) => `println '${m}'`,
    perl: (m) => `print "${m}\\n"`,
    julia: (m) => `println("${m}")`,
    csharp: (m) => `Console.WriteLine("${m}");`,
    fsharp: (m) => `printfn "${m}";;`,
    haskell: (m) => `putStrLn "${m}"`,
    scala: (m) => `println("${m}")`,
    'scala-cli': (m) => `println("${m}")`,
    clojure: (m) => `(println "${m}")`,
    elixir: (m) => `IO.puts("${m}")`,
    erlang: (m) => `io:format("${m}~n").`,
    ocaml: (m) => `print_endline "${m}";;`,
    utop: (m) => `print_endline "${m}";;`,
    racket: (m) => `(displayln "${m}")`,
    rust: (m) => `println!("${m}")`,
    raku: (m) => `say '${m}'`,
    tcl: (m) => `puts "${m}"`,
    octave: (m) => `disp('${m}')`,
    maxima: (m) => `print("${m}")$`,
    'pari-gp': (m) => `print("${m}")`,
    gap: (m) => `Print("${m}\\n");`,
    sage: (m) => `print('${m}')`,
    jupyter: (m) => `print('${m}')`,
    'go-gore': (m) => `println("${m}")`,
    yaegi: (m) => `println("${m}")`,
    cling: (m) => `printf("${m}\\n");`,
    lfortran: (m) => `print *, "${m}"`,
    nim: (m) => `echo "${m}"`,
    crystal: (m) => `puts "${m}"`,
    v: (m) => `println('${m}')`,
    swift: (m) => `print("${m}")`,
    dart: (m) => `print("${m}")`,
    'standard-ml': (m) => `print "${m}\\n";`,
    elm: (m) => `Debug.log "${m}" 1`,
    'scheme-guile': (m) => `(begin (display "${m}") (newline))`,
    'common-lisp-sbcl': (m) => `(format t "${m}~%")`,
    clisp: (m) => `(format t "${m}~%")`,
    ecl: (m) => `(format t "${m}~%")`,
    'mit-scheme': (m) => `(begin (display "${m}") (newline))`,
    'gambit-scheme': (m) => `(begin (display "${m}") (newline))`,
    gauche: (m) => `(begin (display "${m}") (newline))`,
    'chez-scheme': (m) => `(begin (display "${m}") (newline))`,
    'chibi-scheme': (m) => `(begin (display "${m}") (newline))`,
    idris2: (m) => `:exec putStrLn "${m}"`,
    lean: (m) => `#eval IO.println "${m}"`,
    coq: (m) => `idtac "${m}".`,
    sqlite: (m) => `SELECT '${m}';`,
    duckdb: (m) => `SELECT '${m}';`,
    'swi-prolog': (m) => `writeln('${m}').`,
    'gnu-prolog': (m) => `write('${m}'), nl.`,
    sicstus: (m) => `writeln('${m}').`,
    picat: (m) => `writeln('${m}').`,
    logtalk: (m) => `write('${m}'), nl.`,
    forth: (m) => `1 2 + . cr ." ${m}" cr`,
    fennel: (m) => `(print "${m}")`,
    janet: (m) => `(print "${m}")`,
    purescript: (m) => `log "${m}"`,
    agda: (m) => `putStrLn "${m}"`,
    supercollider: (m) => `"${m}".postln;`,
    'nix-repl': (m) => `builtins.trace "${m}" null`,
    wolfram: (m) => `Print["${m}"]`,
    matlab: (m) => `disp('${m}')`,
    smalltalk: (m) => `Transcript show: '${m}'; cr.`,
    postscript: (m) => `(${m}) print (\\n) print flush`,
};

/** Summarize terminal rows without retaining or logging arbitrary user output. */
export function probeOutputMarkerRows(output, command, marker) {
    const rows = Array.isArray(output) ? output : String(output ?? '').split('\n');
    return rows.map((row) => {
        const clean = String(row ?? '')
            .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
            .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
            .replace(/\r/g, '')
            .normalize('NFKC');
        // WebDriver can flatten all xterm rows into one string. Eliminar el
        // comando completo (incluidos sus ecos en errores de compilación)
        // antes de buscar el marcador distingue la salida real del eco.
        // Algunos REPL (Ruby incluido) incluyen el marcador dentro del
        // comando enviado. WebView2 puede aplanar el eco y la línea resultante
        // en una sola fila accesible. Protegemos los marcadores antes de
        // retirar todas las copias del comando: así un error que repita el
        // código no cuenta como salida, pero una línea de salida independiente
        // conserva su marcador aunque las filas se fusionen.
        const markerToken = marker ? `\u0000${marker}\u0000` : '';
        const protectedClean = marker ? clean.split(marker).join(markerToken) : clean;
        const protectedCommand = marker ? String(command ?? '').split(marker).join(markerToken) : command;
        const outputOnly = command
            ? protectedClean.split(protectedCommand).join(' ').split(markerToken).join(marker)
            : clean;
        const line = outputOnly.trim();
        return {
            length: clean.length,
            containsMarker: clean.includes(marker),
            commandEcho: Boolean(command) && clean.includes(command),
            markerAfterEchoRemoval: line.includes(marker),
        };
    }).slice(-8);
}

/** True only when the unique marker appears in output, not just in echoed code. */
export function probeOutputContainsMarker(output, command, marker) {
    return probeOutputMarkerRows(output, command, marker)
        .some((row) => row.markerAfterEchoRemoval);
}

/** The expected identity must come from executed output, after removing echo. */
export function probeOutputContainsExpectedText(output, command, expectedText) {
    const rows = Array.isArray(output) ? output : String(output ?? '').split('\n');
    const clean = rows.map((row) => String(row ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\r/g, '')
        .normalize('NFKC'))
        .map((row) => command ? row.split(command).join(' ') : row)
        .join('\n');
    return clean.toLowerCase().includes(String(expectedText ?? '').toLowerCase());
}

/** True when an evaluated result appears immediately before its unique marker. */
export function probeOutputHasResultBeforeMarker(output, command, result, marker) {
    const rows = Array.isArray(output) ? output : String(output ?? '').split('\n');
    const clean = rows.map((row) => String(row ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\r/g, '')
        .normalize('NFKC'))
        .map((row) => command ? row.split(command).join(' ') : row)
        .join('\n');
    const markerIndex = clean.lastIndexOf(marker);
    if (markerIndex < 0) return false;
    const precedingOutput = clean.slice(Math.max(0, markerIndex - 80), markerIndex);
    const escapedResult = String(result).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s])${escapedResult}[\\s]*$`).test(precedingOutput);
}

export function languageIdForEnvironment(id) {
    if (id.startsWith('plugin:lang:')) return id.slice('plugin:lang:'.length);
    if (id.startsWith('lang:')) return id.slice('lang:'.length);
    const wslLanguage = id.match(/:lang:([^:]+)$/);
    return wslLanguage?.[1] ?? null;
}

export function environmentProbe(option, marker, { allowNsudo = false } = {}) {
    const id = String(option?.id ?? '');
    if (!id || !/^[A-Z0-9_]+$/.test(marker)) {
        return { kind: 'skip', reason: 'identificador o marcador inválido' };
    }
    if (id.startsWith('nsudo:')) {
        if (!allowNsudo) return { kind: 'skip', reason: 'requiere el runner E2E elevado' };
        const command = id === 'nsudo:cmd'
            ? `whoami /user & echo ${marker}`
            : `whoami /user; echo ${marker}`;
        return { kind: 'shell', language: null, command, expectedIdentity: 'TrustedInstaller' };
    }
    if (id.startsWith('adb:')) return { kind: 'skip', reason: 'dispositivo real; no se envían comandos automáticamente' };
    if (id.startsWith('docker:')) return { kind: 'skip', reason: 'arrancaría o ejecutaría un contenedor externo' };
    // Las CLIs de IA necesitan la sesión de quien las usa y los chats de
    // Ollama cargan un modelo de varios GB: no tienen un prompt que sondear.
    // Su apertura se valida aparte con herramientas simuladas.
    if (id.startsWith('ai:')) return { kind: 'skip', reason: 'asistente de IA: necesita sesión o un modelo cargado; lo cubre el escenario enfocado de IA' };

    const language = languageIdForEnvironment(id);
    if (language) {
        if (nonInteractiveLanguageTools.has(language)) {
            const reason = language === 'swift'
                ? 'Swift para Windows se valida como compilador; su proceso sin argumentos no ofrece un REPL estable dentro de ConPTY'
                : language === 'scala-cli'
                    ? 'Scala CLI necesita resolver artefactos Maven en el primer arranque y no ofrece una sonda interactiva determinista'
                    : language === 'purescript'
                        ? 'PureScript `purs repl` solo muestra ayuda; `pulp psci` requiere un proyecto Pulp y no es un REPL autónomo reproducible'
                        : 'el SDK de Dart es una CLI de proyectos y no ofrece un REPL interactivo';
            return { kind: 'skip', language, reason };
        }
        if (serviceBackedRepls.has(language)) {
            return { kind: 'skip', language, reason: 'necesita un servicio externo y credenciales' };
        }
        const makeCommand = replCommands[language];
        if (!makeCommand) {
            return { kind: 'skip', language, reason: 'no hay una sonda interactiva segura definida para este REPL' };
        }
        return {
            kind: 'repl',
            language,
            command: makeCommand(marker),
            ...(language === 'forth' ? { expectedResultBeforeMarker: '3' } : {}),
        };
    }

    // Son intérpretes interactivos con gramática propia: reciben una orden
    // inocua de eco y se consideran listos por su prompt, no por el banner de
    // las shells POSIX que nunca se inyecta en estos entornos.
    if (interactiveReplShellIds.has(id)) {
        return { kind: 'repl', language: id, command: `echo ${marker}` };
    }

    if (shellIds.has(id) || id.startsWith('wsl:')) {
        return { kind: 'shell', language: null, command: `echo ${marker}` };
    }
    return { kind: 'skip', reason: 'tipo de entorno sin sonda automática' };
}

export function safeEnvironmentMarker(id) {
    const normalized = String(id ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return `LTERMINAL_ENV_${normalized || 'UNKNOWN'}`;
}

/**
 * Convierte la salida UTF-16LE que `wsl.exe --list --quiet` devuelve en
 * Windows a nombres de distribuciones. WSL no abre shells en sus distros
 * internas de Docker Desktop, así que se excluyen igual que en el backend.
 */
export function parseWslDistroList(output) {
    const text = Buffer.isBuffer(output) ? output.toString('utf16le') : String(output ?? '');
    return text
        .replace(/^\uFEFF/u, '')
        .replaceAll('\0', '')
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter((name) => name && !['docker-desktop', 'docker-desktop-data'].includes(name.toLowerCase()));
}

/** Wine cannot create its fixed-address mappings on the legacy WSL1 kernel. */
export function wineProbeSkipReason(platform, kernelRelease) {
    if (platform !== 'linux') return null;
    const release = String(kernelRelease ?? '');
    if (!/microsoft/i.test(release)) return null;
    const major = Number(release.match(/^(\d+)\./)?.[1]);
    const hasWsl2Marker = /wsl2|microsoft-standard/i.test(release);
    return Number.isFinite(major) && major < 5 && !hasWsl2Marker
        ? 'Wine no puede mapear sus direcciones fijas en el kernel WSL1 de este host; se omite la sonda interactiva.'
        : null;
}

/** Use X11's native capture for WSL1/Xvfb, where WebKitWebDriver can hang on wide xterm canvases. */
export function shouldUseWsl1X11Capture(platform, kernelRelease, display, imagemagickAvailable = true) {
    return Boolean(display)
        && imagemagickAvailable
        && wineProbeSkipReason(platform, kernelRelease) !== null;
}

/** Quote one argument for POSIX shells used by the E2E fixture runner. */
export function quotePosixShellArgument(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Build a POSIX fixture that emits each marker on its own PTY output line. */
export function posixPrintfLinesScript(lines) {
    const values = Array.from(lines ?? [], String);
    return `printf '%s\\n' ${values.map(quotePosixShellArgument).join(' ')}\n`;
}
