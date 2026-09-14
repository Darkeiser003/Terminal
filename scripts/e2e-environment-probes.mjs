const shellIds = new Set([
    'bash', 'zsh', 'fish', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'wine-cmd',
]);

const interactiveReplShellIds = new Set(['nu', 'xonsh', 'elvish']);

const serviceBackedRepls = new Set([
    'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis',
    'sqlserver', 'oracle-sql', 'neo4j', 'cassandra',
]);

const replCommands = {
    python: (m) => `print('${m}')`,
    ipython: (m) => `print('${m}')`,
    node: (m) => `console.log('${m}')`,
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
    kotlin: (m) => `println("${m}")`,
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
    mercury: (m) => `io.write_string("${m}\\n", !IO).`,
    forth: (m) => `." ${m}" cr`,
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
        const outputOnly = command ? clean.split(command).join(' ') : clean;
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

export function languageIdForEnvironment(id) {
    if (id.startsWith('plugin:lang:')) return id.slice('plugin:lang:'.length);
    if (id.startsWith('lang:')) return id.slice('lang:'.length);
    const wslLanguage = id.match(/:lang:([^:]+)$/);
    return wslLanguage?.[1] ?? null;
}

export function environmentProbe(option, marker) {
    const id = String(option?.id ?? '');
    if (!id || !/^[A-Z0-9_]+$/.test(marker)) {
        return { kind: 'skip', reason: 'identificador o marcador inválido' };
    }
    if (id.startsWith('nsudo:')) return { kind: 'skip', reason: 'requiere elevación de privilegios' };
    if (id.startsWith('adb:')) return { kind: 'skip', reason: 'dispositivo real; no se envían comandos automáticamente' };
    if (id.startsWith('docker:')) return { kind: 'skip', reason: 'arrancaría o ejecutaría un contenedor externo' };

    const language = languageIdForEnvironment(id);
    if (language) {
        if (serviceBackedRepls.has(language)) {
            return { kind: 'skip', language, reason: 'necesita un servicio externo y credenciales' };
        }
        const makeCommand = replCommands[language];
        if (!makeCommand) {
            return { kind: 'skip', language, reason: 'no hay una sonda interactiva segura definida para este REPL' };
        }
        return { kind: 'repl', language, command: makeCommand(marker) };
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
