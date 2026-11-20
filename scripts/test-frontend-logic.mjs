import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function importTypeScript(relative) {
    const source = await readFile(relative, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: relative,
        reportDiagnostics: true,
    });
    const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `${relative} no se pudo transpilar`);
    return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
}

const localization = await importTypeScript('src/lib/localization.ts');
const shortcuts = await importTypeScript('src/lib/shortcuts.ts');
const terminalScroll = await importTypeScript('src/lib/terminal-scroll.ts');
const terminalColumns = await importTypeScript('src/lib/terminal-columns.ts');
const terminalReady = await importTypeScript('src/lib/terminal-ready.ts');
const terminalPrompt = await importTypeScript('src/lib/terminal-prompt.ts');
const keyedQueue = await importTypeScript('src/lib/keyed-serial-queue.ts');
const terminalRender = await importTypeScript('src/lib/terminal-render.ts');
const ltoolsSelection = await importTypeScript('src/lib/ltools-selection.ts');

// Guardar la salida: el texto que va al archivo y el nombre que se propone.
{
    const registry = await importTypeScript('src/lib/terminalRegistry.ts');
    const rows = [['uno', false], ['dos ', false], ['partida', true], ['', false]];
    const buffer = {
        length: rows.length + 1,
        getLine: (row) => (rows[row] ? { isWrapped: rows[row][1], translateToString: () => rows[row][0] } : undefined),
    };
    assert.equal(registry.bufferText(buffer), 'uno\ndos partida\n', 'las filas de una línea partida se unen y las demás van en la suya');
    const date = new Date(2026, 10, 2, 9, 5, 7);
    assert.equal(registry.outputFileName('Git Bash', date), 'Git Bash-20261102-090507.txt');
    assert.equal(registry.outputFileName('a<b>:c/d\\e|f?g*h.', date), 'a b c d e f g h-20261102-090507.txt', 'sin caracteres prohibidos en Windows');
    assert.equal(registry.outputFileName('', date), 'terminal-20261102-090507.txt');
}

// Historial de órdenes escritas: sin vacías, sin duplicados, con límite y con
// la búsqueda por palabras en cualquier orden, la más reciente primero.
{
    const history = await importTypeScript('src/lib/command-history.ts');
    let list = [];
    for (const command of ['git status', '  ', 'npm run build', 'git status', 'Get-ChildItem C:\\Temp']) {
        list = history.rememberCommand(list, command);
    }
    assert.deepEqual(list, ['npm run build', 'git status', 'Get-ChildItem C:\\Temp'], 'la repetida sube al final y la vacía no entra');
    assert.deepEqual(history.rememberCommand(list, 'uno\ndos'), list, 'un pegado de varias líneas no es una orden');
    assert.deepEqual(history.rememberCommand(list, 'x'.repeat(5000)), list, 'un pegado enorme tampoco');
    assert.deepEqual(history.rememberCommand(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd'], 'con el límite se va la más antigua');
    assert.deepEqual(history.searchCommands(list, ''), ['Get-ChildItem C:\\Temp', 'git status', 'npm run build'], 'sin búsqueda, todas y la última primero');
    assert.deepEqual(history.searchCommands(list, 'STATUS git'), ['git status'], 'palabras en cualquier orden y sin mayúsculas');
    assert.deepEqual(history.searchCommands(list, 'temp'), ['Get-ChildItem C:\\Temp']);
    assert.deepEqual(history.searchCommands(list, 'nada'), []);
    assert.equal(history.searchCommands(Array.from({ length: 80 }, (_, i) => `orden ${i}`), 'orden').length, 50, 'como mucho 50 resultados');
    const terminalPaneSource = await readFile('src/components/TerminalPane.svelte', 'utf8');
    assert(terminalPaneSource.includes('if (submittedCommand && commandTracker?.atPrompt) app.recordCommand(submittedCommand);'),
        'solo se guarda lo escrito sobre un prompt marcado: nunca la contraseña que pide una orden en marcha');
}

// Marcas OSC 133: qué es una orden, cómo terminó y dónde está su salida.
{
    const marks = await importTypeScript('src/lib/command-marks.ts');
    let row = 0;
    let clock = 1000;
    const created = [];
    const tracker = new marks.CommandTracker((offset) => {
        const mark = { line: row + offset };
        created.push(mark);
        return mark;
    }, () => clock);
    const runCommand = ({ code, output = 2, blank = false, withC = false, column = 0 }) => {
        tracker.mark('A', 0);
        tracker.mark('B', 2);
        assert.equal(tracker.atPrompt, true, 'tras B hay un prompt esperando');
        tracker.submitted(blank);
        row += 1;
        if (withC) tracker.mark('C', 0);
        row += output;
        clock += 2500;
        const finished = tracker.mark(code === undefined ? 'D' : `D;${code}`, column);
        return finished;
    };
    assert.equal(tracker.mark('D;0', 0), null, 'el primer prompt no cierra ninguna orden');
    const ok = runCommand({ code: 0 });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.durationMs, 2500);
    assert.deepEqual(marks.outputRange(ok, () => false), [1, 2], 'la salida va entre la línea escrita y el fin');
    const failed = runCommand({ code: 3, withC: true });
    assert.equal(failed.exitCode, 3);
    assert.deepEqual(marks.outputRange(failed, () => false), [4, 5], 'con C la salida empieza en su marca');
    assert.equal(runCommand({ code: 3, blank: true, output: 0 }), null, 'Intro en blanco no repite el fallo anterior');
    const silent = runCommand({ output: 0 });
    assert.equal(silent.exitCode, null, 'cmd no da código de salida');
    assert.equal(marks.outputRange(silent, () => false), null, 'una orden muda no tiene salida');
    const noNewline = runCommand({ code: 0, output: 1, column: 4 });
    assert.equal(noNewline.end.line, row + 1, 'sin salto final la última fila sigue siendo salida');
    const wrapped = runCommand({ code: 0, output: 3 });
    assert.deepEqual(marks.outputRange(wrapped, (line) => line === wrapped.input.line + 1), [wrapped.input.line + 2, wrapped.end.line - 1], 'una orden partida en dos filas no entra en la salida');
    assert.equal(tracker.lastFinished(), wrapped);
    const prompts = [ok, failed, silent, noNewline, wrapped].map((record) => record.prompt.line);
    assert.equal(tracker.jumpTarget(prompts[2], 'previous'), prompts[1]);
    assert.equal(tracker.jumpTarget(prompts[2], 'next'), prompts[3]);
    assert.equal(tracker.jumpTarget(prompts[4], 'next'), null, 'tras la última no hay siguiente');
    failed.prompt.line = -1;
    assert.equal(tracker.jumpTarget(prompts[2], 'previous'), prompts[0], 'una orden que salió del historial se salta');
    // Una orden de un botón (13-11): la pestaña no ve su Intro, pero cuenta,
    // con su texto. Sin prompt libre espera al siguiente, como mucho 15 s.
    tracker.mark('A', 0);
    tracker.mark('B', 2);
    tracker.appCommand('winget install x');
    assert.equal(tracker.atPrompt, false, 'la orden de la app ya corre');
    row += 3;
    clock += 1000;
    const fromApp = tracker.mark('D;-1978335212', 0);
    assert.equal(fromApp?.command, 'winget install x', 'la orden de la app se apunta con su texto');
    assert.equal(fromApp.exitCode, -1978335212);
    tracker.appCommand('cmd /c exit 2');
    tracker.mark('A', 0);
    tracker.mark('B', 2);
    assert.equal(tracker.atPrompt, false, 'la que esperaba se ata al prompt siguiente');
    row += 1;
    assert.equal(tracker.mark('D;2', 0)?.command, 'cmd /c exit 2');
    tracker.appCommand('vieja');
    clock += 20000;
    tracker.mark('A', 0);
    tracker.mark('B', 2);
    assert.equal(tracker.atPrompt, true, 'pasados 15 s ya no se ata a nada');
    tracker.submitted(false);
    row += 1;
    assert.equal(tracker.mark('D;0', 0)?.command, undefined, 'lo tecleado no hereda la orden de la app');
    tracker.mark('A', 0);
    tracker.mark('B', 2);
    tracker.submitted(false);
    clock += 60000;
    tracker.clear();
    assert.equal(tracker.mark('D;0', 0), null, 'la sesión nueva no cierra una orden de la anterior');
    assert.equal(tracker.lastFinished(), null, 'ni conserva las órdenes de la anterior');
    assert.equal(marks.parseExitCode('130;aid=1'), 130);
    assert.equal(marks.parseExitCode(undefined), null);
    assert.equal(marks.formatDuration(820, 'es'), '820 ms');
    assert.equal(marks.formatDuration(4200, 'es'), '4,2 s');
    assert.equal(marks.formatDuration(192000, 'es'), '3 min 12 s');
    // cmd no da código: una orden que no existe se reconoce por el texto de
    // Windows, aunque la terminal haya partido la fila.
    const notFound = '" no se reconoce como un comando interno o externo,';
    assert.equal(marks.inferCmdExitCode('"epo" no se reconoce como un comando interno o externo,\nprograma o archivo por lotes ejecutable.', notFound), 9009);
    assert.equal(marks.inferCmdExitCode('"epo" no se reconoce como un\n  comando interno o externo,', notFound), 9009);
    // Fila partida justo en un espacio: el búfer lo pierde al leerla.
    assert.equal(marks.inferCmdExitCode('"epo" no se reconoce como un comandointerno o externo,', notFound), 9009);
    assert.equal(marks.inferCmdExitCode('hola', notFound), null);
    assert.equal(marks.inferCmdExitCode('"epo" no se reconoce como un comando interno o externo,', null), null);
    assert.equal(marks.inferCmdExitCode('cualquier cosa', '  '), null);
}

const ltoolsActions = Array.from({ length: 73 }, (_, index) => ({
    id: `scope.action-${index}`,
    actionKey: `scope.action-${index}`,
    scope: 'scope',
    operation: `action-${index}`,
    label: `Action ${index}`,
    shortLabel: `Action ${index}`,
    group: 'scope',
    description: 'Consulta segura',
    target: 'none',
    targetPolicy: 'none',
    safe: true,
    mutating: false,
    confirmation: 'none',
    profile: 'safe-default',
    quick: index < 12,
    requirementsAvailable: true,
}));
const firstSelection = ltoolsSelection.reconcileLToolsSelection(ltoolsActions, null);
assert.equal(firstSelection.selectedIds.length, 12, 'el catálogo nuevo propone todas las acciones quick, sin un tope artificial');
assert.equal(firstSelection.knownIds.length, 73, 'la selección conserva todos los IDs conocidos para reconciliar futuras versiones');
const expandedCatalog = [
    ...ltoolsActions,
    {
        ...ltoolsActions[72],
        id: 'scope.action-new',
        label: 'Nueva acción',
        quick: true,
    },
];
const removedByUser = ltoolsSelection.reconcileLToolsSelection(
    expandedCatalog,
    { selectedIds: firstSelection.selectedIds.slice(1), knownIds: firstSelection.knownIds },
);
assert(!removedByUser.selectedIds.includes(firstSelection.selectedIds[0]), 'una acción desmarcada no reaparece al refrescar el catálogo');
assert(removedByUser.selectedIds.includes('scope.action-new'), 'una acción quick nueva se propone automáticamente una sola vez');
const withMissingRequirement = ltoolsSelection.reconcileLToolsSelection(
    [{ ...ltoolsActions[0], requirementsAvailable: false }, ltoolsActions[1]],
    { selectedIds: ['scope.action-0', 'scope.action-1'], knownIds: [] },
);
assert.deepEqual(withMissingRequirement.selectedIds, ['scope.action-1'], 'las acciones con dependencias no disponibles no quedan ejecutables');

assert.equal(localization.foldLocalized('İSTANBUL', 'tr'), 'istanbul');
assert(localization.includesLocalized('Überblick 12', 'ÜBER', 'de'));
assert(localization.compareLocalized('archivo 2', 'archivo 10', 'es') < 0);
assert.doesNotThrow(() => localization.compareLocalized('a', 'b', 'idioma_invalido'));
assert.equal(terminalScroll.normalizeWheelDelta(120, 0, 18, 600), 120, 'la rueda en píxeles conserva su magnitud');
assert.equal(terminalScroll.normalizeWheelDelta(3, 1, 18, 600), 54, 'la rueda en líneas se convierte según la altura de línea');
assert.equal(terminalScroll.normalizeWheelDelta(1, 2, 18, 600), 600, 'la rueda en páginas se convierte según el ancho visible');
assert.equal(terminalScroll.normalizeWheelDelta(-2, 1, Number.NaN, 600), -32, 'una altura de línea no disponible usa el respaldo');
assert.equal(terminalScroll.normalizeWheelDelta(Number.NaN, 0, 18, 600), 0, 'no propaga deltas no finitos');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~>                         09/14/2026 01:46 PM', 'nu'), true,
    'Nushell está listo aunque su prompt derecho aparezca tras el cursor');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('/home/romen/proyecto>  hora derecha', 'nu'), true,
    'Nushell reconoce una ruta de trabajo absoluta y su prompt derecho');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('C:\\Users\\Romen> hora derecha', 'nu'), true,
    'Nushell reconoce rutas Windows');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~> hora derecha', 'fish'), false,
    'el prompt especial de Nushell no altera la detección de otras shells');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('Welcome to Nushell', 'nu'), false,
    'el saludo del REPL no se confunde con un prompt');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('\u001b[38;5;167m~\u001b[0m Snailed it ~', 'xonsh'), true,
    'xonsh reconoce el prompt alternativo del backend dumb sin prompt_toolkit');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('romen@PC ~/proyecto main @', 'xonsh'), true,
    'xonsh reconoce su prompt normal terminado en @');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('C:\\Users\\Romen @#', 'xonsh'), true,
    'xonsh reconoce el prompt de administrador con ruta Windows');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('Welcome to the xonsh shell 0.24.2', 'xonsh'), false,
    'el banner de xonsh no se confunde con un prompt');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~>                                                                 romen@PC', 'elvish'), true,
    'Elvish reconoce el prompt izquierdo y el prompt derecho en la misma fila');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('/home/romen/proyecto> romen@PC', 'elvish'), true,
    'Elvish reconoce su prompt con una ruta absoluta');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~>                                                                 romen@PC', 'fish'), false,
    'el prompt particular de Elvish no habilita por error una shell normal');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('Welcome to Elvish', 'elvish'), false,
    'el saludo de Elvish no se confunde con el prompt');
for (const [environment, prompt, input] of [
    ['lang:tcl', '%', ''],
    ['lang:tcl', '% puts "hola"', 'puts "hola"'],
    ['lang:maxima', '(%i1)', ''],
    ['lang:maxima', '(%i2) 1 + 1', '1 + 1'],
    ['lang:duckdb', 'memory D', ''],
    ['lang:duckdb', 'memory D SELECT 1;', 'SELECT 1;'],
    ['lang:common-lisp-sbcl', '*', ''],
    ['lang:swi-prolog', '?- member(X, [1, 2]).', 'member(X, [1, 2]).'],
    ['lang:swi-prolog', '1 ?-', ''],
    ['lang:swi-prolog', '1 ?- member(X, [1, 2]).', 'member(X, [1, 2]).'],
    ['lang:swi-prolog', '| ?-', ''],
    ['lang:forth', 'ok', ''],
]) {
    assert.equal(terminalPrompt.interactiveReplPromptIsVisible(prompt, environment), true,
        `${environment}: se reconoce su prompt específico`);
    assert.equal(terminalPrompt.interactiveReplInputLine(prompt, environment), input,
        `${environment}: el espejo omite el prompt y conserva la línea editable`);
}
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('%', 'fish'), false,
    'un porcentaje aislado no se confunde con un prompt de shell');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('memory D', 'fish'), false,
    'el prompt de DuckDB solo se acepta dentro de su REPL');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('*', 'lang:python'), false,
    'un asterisco aislado no se confunde con el prompt de otros REPL');
assert.equal(terminalPrompt.interactiveReplPromptIsVisible('~ Snailed it ~', 'nu'), false,
    'el prompt de xonsh no cambia la detección de Nushell');
assert.equal(terminalPrompt.interactiveReplBannerSignalsReady('Type `bye` to exit', 'lang:forth'), true,
    'Gforth no muestra prompt inicial: su banner documentado habilita la primera entrada');
assert.equal(terminalPrompt.interactiveReplBannerSignalsReady('Type `bye` to exit', 'lang:python'), false,
    'el banner de Gforth no habilita por error otro REPL');

const columnRows = [
    { columns: 900, isWrapped: false }, // scrollback anterior: no debe gobernar el PTY
    { columns: 80, isWrapped: false },
    { columns: 35, isWrapped: true },
    { columns: 22, isWrapped: false },
];
// Bloques de salida: una línea partida sigue sumando, los espacios finales no.
{
    const { EMPTY_OUTPUT_LINE: empty, measureOutputChunk: measure } = terminalColumns;
    const promptSp = `%${' '.repeat(1023)}`;
    assert.equal(measure(`${promptSp}\r \rroot$ `, empty, 16384).longest, 5,
        'el relleno de PROMPT_SP en un solo bloque no ocupa');
    const firstHalf = measure(`%${' '.repeat(600)}`, empty, 16384);
    assert.equal(firstHalf.longest, 1, 'medio relleno de PROMPT_SP no ocupa');
    assert.equal(measure(`${' '.repeat(423)}\r \rroot$ `, firstHalf.carry, 16384).longest, 5,
        'el resto del relleno en otro bloque tampoco suma los espacios del anterior');
    const head = measure('abc   ', empty, 16384);
    assert.equal(measure('def', head.carry, 16384).longest, 9,
        'una línea partida en dos bloques cuenta los espacios que quedan en medio');
    assert.equal(measure('x'.repeat(50), empty, 40).longest, 40, 'el tope se respeta');
    assert.deepEqual(measure('x'.repeat(50), empty, 40).carry, empty, 'al llegar al tope no se arrastra nada');
    // zsh-syntax-highlighting repinta lo tecleado: atrás, color y al final.
    let typed = measure('└─# echo LTERMINAL_ENV_WSL_KALI_LINUX_ZSH', empty, 16384);
    for (let redraw = 0; redraw < 20; redraw += 1) {
        typed = measure('\x1b[37D\x1b[36me\x1b[36mc\x1b[36mh\x1b[36mo\x1b[39m\x1b[33C', typed.carry, 16384);
    }
    assert.equal(typed.longest, 41, 'los repintados de zsh no suman la línea otra vez');
    assert.equal(measure('\r\r\n', typed.carry, 16384).longest, 41, 'el Intro tras los repintados mide la línea real');
    assert.equal(measure('\x1b[1;61Hx', empty, 16384).longest, 61, 'CUP lleva a la columna pedida');
    assert.equal(measure('abcdef\x1b[3Gx', empty, 16384).longest, 6, 'CHA vuelve atrás sin ensanchar');
    assert.equal(measure('abc\b\bx', empty, 16384).longest, 3, 'el retroceso no ensancha');
    assert.equal(measure('a\x1b[?1l\x1b>\x1b]0;título\x07b', empty, 16384).longest, 2,
        'los escapes sin movimiento siguen sin ocupar');

    const { withoutTerminalControls: plain } = terminalColumns;
    assert.equal(plain('\x1b[?1l\x1b>'), '', 'el ESC > de zsh no deja un `>` suelto');
    assert.equal(plain('a\x1b7b\x1b8c\x1b(Bd\x1b=e'), 'abcde', 'los escapes de dos caracteres desaparecen enteros');
    assert.equal(plain('\x1bPq#0;2;0;0;0#0~~@@vv@@~~$-\x1b\\x'), 'x', 'los datos de Sixel no cuentan como texto');
    assert.equal(plain('\x1b]0;título\x07x\x1b]8;;https://a\x1b\\y'), 'xy', 'los OSC desaparecen con BEL o con ST');
    assert.equal(plain('\x1b[1;31mrojo\x1b[0m\r\n'), 'rojo\r\n', 'CSI fuera, CR y LF dentro');
    // Lo que manda zsh tras una orden, detrás de una línea de espacios.
    let carry = measure(' '.repeat(736), empty, 16384).carry;
    for (const chunk of ['\x1b[?1l\x1b>', '\x1b[?2004l', '\r\r\n']) {
        const measured = measure(plain(chunk), carry, 16384);
        assert.equal(measured.longest, 0, `${JSON.stringify(chunk)} no pide columnas`);
        carry = measured.carry;
    }
}

assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 1, 1, (index) => columnRows[index]), 115,
    'una continuación visible conserva el ancho completo de su línea lógica');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 3, 1, (index) => columnRows[index]), 22,
    'una línea antigua fuera de pantalla no fuerza columnas adicionales');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 2, 1, (index) => columnRows[index]), 115,
    'si el viewport empieza en una continuación se reconstruye desde el inicio');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 0, 4, (index) => columnRows[index]), 900,
    'una línea larga visible sigue teniendo acceso al scroll horizontal');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 3, 8, (index) => columnRows[index]), 22,
    'el rango visible se limita al número real de filas del buffer');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(4, 1, 1, (index) => columnRows[index], 100), 100,
    'la reconstrucción de líneas queda limitada por el máximo de seguridad');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(0, 0, 1, () => undefined), 0,
    'un buffer vacío no genera dimensiones');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(Number.NaN, 0, 1, () => undefined), 0,
    'una longitud no finita no rompe el cálculo del viewport');
assert.equal(terminalColumns.longestVisibleLogicalLineWidth(1, 0, Number.NaN, () => ({ columns: 2, isWrapped: false })), 0,
    'un rango visible no finito se trata como vacío');
assert.equal(terminalColumns.requiredTerminalColumns(58, 58), 58,
    'una línea corta ocupa solo el ancho indispensable del viewport');
assert.equal(terminalColumns.requiredTerminalColumns(58, 163), 163,
    'una línea larga visible conserva columnas para el scroll horizontal');
assert.equal(terminalColumns.requiredTerminalColumns(58, 58), 58,
    'al salir del viewport la ayuda larga, el PTY recupera su ancho mínimo');
assert.equal(terminalColumns.requiredTerminalColumns(58, 20, 76), 76,
    'la reserva de columnas para la edición mantiene visible el cursor');
assert.equal(terminalColumns.requiredTerminalColumns(3000, 5000, 4000, 2048), 2048,
    'las dimensiones visibles, el contenido y la reserva se limitan al máximo');
assert.equal(terminalColumns.requiredTerminalColumns(120, 12000, 0, 16384), 12000,
    'una salida muy larga conserva sus columnas dentro del techo ampliado');
assert.equal(terminalColumns.requiredTerminalColumns(120, 20000, 0, 16384), 16384,
    'una salida extrema se recorta al techo de seguridad sin desbordar la matriz');
assert.equal(terminalColumns.requiredTerminalColumns(Number.NaN, Number.NaN, Number.NaN), 1,
    'valores no finitos producen un mínimo seguro y nunca dimensiones inválidas');
for (const prompt of [
    'root@WINSLIM11-PC:~# printf update',
    'admin@ubuntu:/var/tmp$ echo ok',
    'user@host# command',
    'PS C:\\Users\\Admin> Get-ChildItem',
    'C:\\Users\\Admin> dir',
    'C:\\Users\\Admin>powershell.exe -NoProfile -File script.ps1',
    '❯ npm run check',
    '~ ➜ cargo test',
]) {
    assert.equal(terminalColumns.isShellInputLine(prompt), true, `se reconoce el prompt de entrada: ${prompt}`);
}
for (const output of [
    'LTERMINAL_PROGRESS_UPDATE 100% [########################]',
    'admin@ubuntu realizó la actualización',
    'progress: 100% complete',
]) {
    assert.equal(terminalColumns.isShellInputLine(output), false, `la salida no se confunde con entrada: ${output}`);
}
assert.equal(terminalColumns.inputReservationColumns(0, 240), 6,
    'una orden pegada no convierte toda su longitud en columnas de la PTY');
assert.equal(terminalColumns.inputReservationColumns(106, 1), 109,
    'la entrada junto al borde conserva un margen pequeño para el cursor');
assert.equal(terminalColumns.inputReservationColumns(2046, 20, 4, 2048), 2048,
    'la reserva de entrada respeta el máximo de seguridad');

const cells = (values) => ({
    length: values.length,
    getCell: (index) => values[index]
        ? { getChars: () => values[index].chars, getWidth: () => values[index].width }
        : undefined,
});
assert.equal(terminalColumns.occupiedTerminalColumns(cells([
    { chars: 'a', width: 1 },
    { chars: '界', width: 2 },
    { chars: '', width: 0 },
    { chars: ' ', width: 1 },
]), 4), 3, 'los caracteres CJK ocupan sus dos columnas reales y se recortan los espacios finales');
assert.equal(terminalColumns.occupiedTerminalColumns(cells([
    { chars: 'é', width: 1 },
    { chars: '🙂', width: 2 },
    { chars: '', width: 0 },
]), 3), 3, 'marcas combinadas y emoji se miden por ancho de celda, no por unidades UTF-16');
assert.equal(terminalColumns.occupiedTerminalColumns(cells([
    { chars: 'x', width: 1 },
    { chars: 'z', width: 1 },
    { chars: 'z', width: 1 },
]), 1), 1, 'celdas antiguas que exceden las columnas actuales no sobredimensionan el PTY');
assert.equal(terminalColumns.occupiedTerminalColumns(cells([
    { chars: 'x', width: 1 },
    { chars: '界', width: 2 },
]), 2), 2, 'un glifo ancho al borde no reporta columnas fuera de la rejilla');
assert.equal(terminalColumns.occupiedTerminalColumns(cells([
    { chars: ' ', width: 1 },
    { chars: ' ', width: 1 },
]), 2), 0, 'una fila vacía o con espacios finales no pide columnas extra');

const renderFrames = [];
const renderErrors = [];
const renderCalls = [];
const renderCompletions = [];
const renderScheduler = terminalRender.createTerminalRefreshScheduler(
    (callback) => renderFrames.push(callback),
    (error) => renderErrors.push(error),
);
const renderTarget = {
    rows: 24,
    element: { isConnected: true },
    refresh: (start, end) => renderCalls.push([start, end]),
};
assert.equal(renderScheduler(renderTarget, () => renderCompletions.push('first')), true,
    'el primer repintado reserva un frame');
assert.equal(renderScheduler(renderTarget, () => renderCompletions.push('second')), false,
    'las salidas del mismo frame se agrupan por terminal');
assert.equal(renderFrames.length, 1);
assert.deepEqual(renderCalls, [], 'el repintado no se adelanta al frame pedido');
renderFrames.shift()();
assert.deepEqual(renderCalls, [[0, 23]], 'se refrescan explícitamente todas las filas visibles');
assert.deepEqual(renderCompletions, [], 'la finalización espera un frame de presentación');
assert.equal(renderFrames.length, 1);
renderFrames.shift()();
assert.deepEqual(renderCompletions, ['first', 'second'], 'se notifican todos los solicitantes agrupados');

const detachedTarget = {
    rows: 30,
    element: { isConnected: true },
    refresh: () => renderCalls.push('detached'),
};
let detachedCompletion = false;
renderScheduler(detachedTarget, () => { detachedCompletion = true; });
detachedTarget.element.isConnected = false;
renderFrames.shift()();
assert.equal(detachedCompletion, false, 'una terminal desmontada no recibe callbacks tardíos');
assert(!renderCalls.includes('detached'), 'una terminal desmontada no se refresca');

const closedDuringPaint = {
    rows: 4,
    element: { isConnected: true },
    refresh: () => renderCalls.push('closed-during-paint'),
};
let lateCompletion = false;
renderScheduler(closedDuringPaint, () => { lateCompletion = true; });
renderFrames.shift()();
closedDuringPaint.element.isConnected = false;
renderFrames.shift()();
assert(renderCalls.includes('closed-during-paint'));
assert.equal(lateCompletion, false, 'no se notifica como visible una terminal cerrada durante la presentación');

const brokenTarget = {
    rows: 1,
    element: { isConnected: true },
    refresh: () => { throw new Error('renderer unavailable'); },
};
renderScheduler(brokenTarget, () => renderCompletions.push('broken'));
renderFrames.shift()();
assert.equal(renderErrors.length, 1, 'un error del renderer se registra sin romper la cola');
assert.equal(renderCompletions.includes('broken'), false, 'no se anuncia un repintado que falló');

let retryClock = 0;
let retryCalls = 0;
const retryDelays = [];
assert.equal(await terminalReady.retryUntilReady(async () => ++retryCalls === 3, {
    intervalMs: 200,
    timeoutMs: 1000,
    now: () => retryClock,
    wait: async (delayMs) => { retryDelays.push(delayMs); retryClock += delayMs; },
}), true, 'el handshake reintenta hasta que la PTY está lista');
assert.equal(retryCalls, 3);
assert.deepEqual(retryDelays, [200, 200]);

retryClock = 0;
retryCalls = 0;
retryDelays.length = 0;
assert.equal(await terminalReady.retryUntilReady(async () => { retryCalls += 1; return false; }, {
    intervalMs: 200,
    timeoutMs: 450,
    now: () => retryClock,
    wait: async (delayMs) => { retryDelays.push(delayMs); retryClock += delayMs; },
}), false, 'el handshake tiene un límite total de espera');
assert.deepEqual(retryDelays, [200, 200, 50]);

let continueRetrying = true;
assert.equal(await terminalReady.retryUntilReady(async () => false, {
    shouldContinue: () => continueRetrying,
    wait: async () => { continueRetrying = false; },
}), false, 'el handshake se cancela al desmontar el panel');

const enqueueByTab = keyedQueue.createKeyedSerialQueue();
const switchOrder = [];
let releaseFirstSwitch;
const firstSwitchGate = new Promise((resolve) => { releaseFirstSwitch = resolve; });
const firstSwitch = enqueueByTab('tab-1', async () => {
    switchOrder.push('first');
    await firstSwitchGate;
    return 'first';
});
const secondSwitch = enqueueByTab('tab-1', async () => {
    switchOrder.push('second');
    return 'second';
});
const otherTabSwitch = enqueueByTab('tab-2', async () => {
    switchOrder.push('other-tab');
    return 'other-tab';
});
await otherTabSwitch;
assert.deepEqual(switchOrder, ['first', 'other-tab'], 'una pestaña espera su cambio anterior sin bloquear otras pestañas');
releaseFirstSwitch();
assert.deepEqual(await Promise.all([firstSwitch, secondSwitch]), ['first', 'second']);
assert.deepEqual(switchOrder, ['first', 'other-tab', 'second'], 'la misma pestaña conserva el orden de sus cambios');
await assert.rejects(enqueueByTab('tab-1', async () => { throw new Error('cambio rechazado'); }), /cambio rechazado/);
assert.equal(await enqueueByTab('tab-1', async () => 'recovered'), 'recovered', 'un rechazo no atasca la cola de esa pestaña');

assert.equal(
    localization.platformBrandText('Abrir LTerminal y LTerminal Projects', 'windows', 'WTerminal'),
    'Abrir WTerminal y WTerminal Projects',
);
assert.equal(
    localization.platformBrandText('Abrir WTerminal en WTerminal Projects', 'linux', 'LTerminal'),
    'Abrir LTerminal en LTerminal Projects',
);
assert(!localization.platformBrandText('WTerminal Projects', 'linux', 'LTerminal').includes('LTerminals'));
assert.equal(localization.platformBrandText('LTerminal', 'unknown', 'Otro'), 'LTerminal');

const defaults = await readFile('src-tauri/default_settings.toml', 'utf8');
const terminalPane = await readFile('src/components/TerminalPane.svelte', 'utf8');
const app = await readFile('src/App.svelte', 'utf8');
const aliases = await readFile('src-tauri/src/terminal/aliases.rs', 'utf8');
assert(terminalPane.includes('function isDirectCreditAlias(line: string): boolean'),
    'TerminalPane debe preseleccionar los easter-eggs sin `:`');
assert(terminalPane.includes("candidate.trimStart().startsWith(':') || isDirectCreditAlias(candidate)"),
    'Las líneas de crédito deben interceptarse antes de enviarse a la shell');
assert(terminalPane.includes("command.action === 'darkeiser003'")
    && terminalPane.includes('ayuda ${command.action}')
    && terminalPane.includes("command.action === 'christianlg97'")
    && terminalPane.includes("app.appInfo?.platform === 'windows'")
    && aliases.includes('HelpTopic::Credits')
    && aliases.includes('terminal.creditDarkeiser')
    && aliases.includes('terminal.creditChristian'),
    'Los créditos por comando deben reservar Christian a WTerminal y conservar el crédito del desarrollador');
const fitAndReportStart = terminalPane.indexOf('function fitAndReport()');
const paneResizeBlock = terminalPane.slice(fitAndReportStart);
assert(terminalPane.includes('term.open(terminalHost)')
    && terminalPane.includes('data-testid="terminal-host"')
    && terminalPane.includes('function requestBannerPrint'),
    'El banner y el código deben compartir el mismo xterm');
assert(terminalPane.includes('cursorInactiveStyle')
    && terminalPane.includes('xterm-cursor-layer'),
    'Cada panel debe conservar una capa de cursor visible aunque no tenga el foco');
assert(terminalPane.includes("white-space: pre !important")
    && terminalPane.includes("term.onData((data) =>")
    && !terminalPane.includes('lastExplicitSpaceKeydownAt')
    && !terminalPane.includes('window.addEventListener(\'keydown\', terminalSpaceHandler'),
    'Space debe viajar por la misma cola onData que el resto de la línea, sin duplicar ni perder separadores');
// ConPTY coloca el eco con `ESC[fila;colH` relativo a su viewport: las filas
// de la PTY deben seguir siempre a las de xterm, aunque se protejan columnas.
assert(terminalPane.includes('let lastPtySize = { cols: 0, rows: 0 }')
    && terminalPane.includes('function protectedPtyColumns(cols: number): number')
    && terminalPane.includes('ptySyncPendingAfterOutput = true')
    && terminalPane.includes('function syncPtyToTerminalAfterOutput(): void')
    && !terminalPane.includes('retryPtySyncAfterOutput')
    && terminalPane.includes('lastPtySize = { cols: targetCols, rows }')
    && terminalPane.includes('lastPtySize = { cols: targetColumns, rows: targetRows }'),
    'un resize protegido o aplazado no debe dejar a ConPTY con filas distintas de xterm');
// Un tamaño transitorio (1 fila al dividir) que xterm aplica y el debounce del
// PTY no envía debe reproducirse en ConPTY antes de la geometría final.
assert(terminalPane.includes('function noteXtermGeometry(): void')
    && terminalPane.includes('async function replayTransientShrink(finalRows: number): Promise<void>')
    && (terminalPane.match(/await replayTransientShrink\(/g) ?? []).length >= 3
    && terminalPane.includes('xtermTransientShrink === null'),
    'la reducción transitoria de filas de xterm debe replicarse en ConPTY');
// Las teclas no adelantan al resize de ConPTY: esperan la medida de una
// casilla recién activada y envían antes el resize que aún esperaba debounce.
// Entre paso y paso va `markInputStage` (diagnóstico de `__wtInputState`): el
// orden es el mismo.
assert(/return activationGeometryReady;[\s\S]{0,400}?flushPendingPtyResize\(\);\s*return resizeQueue;[\s\S]{0,400}?api\.sendInput\(tabId, data\)/u.test(terminalPane),
    'la entrada debe esperar la geometría de activación y adelantar el resize pendiente');
assert(terminalPane.includes('pendingPtyResizeRun = runPtyResize;')
    && terminalPane.includes('resizeTimer = setTimeout(runPtyResize,'),
    'el resize con debounce debe poder adelantarse');
// Una casilla que vuelve a mostrarse recupera su posición de scroll (el
// `display: none` la dejaba en la cima del historial sin seguir la salida).
assert(terminalPane.includes('let hiddenScrollState: { atBottom: boolean; viewportY: number } | null = null;')
    && /fitAndReport\(\);\s*restoreScrollAfterActivation\(\);/u.test(terminalPane)
    && terminalPane.includes('activationScrollPinUntil = performance.now() + ACTIVATION_SCROLL_PIN_MS;')
    && terminalPane.includes("host.addEventListener('wheel', releaseScrollPinOnUserScroll")
    && terminalPane.includes('term.onRender(() => restoreScrollAfterRender());')
    && /term\.onScroll\(\(\) => \{[\s\S]{0,160}?if \(!active\) return;/u.test(terminalPane),
    'la casilla reactivada debe restaurar su scroll');
assert(terminalPane.includes('if (awaitingTerminalVisibility) return;')
    && terminalPane.includes('if (hiddenScrollState) openVisibilityGate();')
    && terminalPane.includes('window.setTimeout(closeVisibilityGate, 0)'),
    'el reajuste de una casilla reactivada debe esperar a que xterm la vea');
// Si el aviso de xterm llega tarde (plazo de reserva de 200 ms), su renderer
// sigue en pausa al medir: se reanuda antes, o el Viewport recorta el scroll
// con el alto viejo y la vista deja de seguir la salida.
assert(/if \(awaitingTerminalVisibility\) return;\s*resumeRendererIfVisible\(\);/u.test(terminalPane)
    && terminalPane.includes("renderService._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });")
    && terminalPane.includes("if (!rect || rect.width <= 0 || rect.height <= 0) return;"),
    'el ajuste de una casilla visible debe reanudar antes el renderer de xterm');
// Ese arreglo y `__wtTerminalState` usan internos de xterm 6. Si una
// actualización los cambia, el arreglo dejaría de actuar sin avisar: que falle
// aquí y no en un E2E intermitente.
const xtermBundle = await readFile('node_modules/@xterm/xterm/lib/xterm.mjs', 'utf8');
assert(/_handleIntersectionChange\(\w+\)\{this\._isPaused=/u.test(xtermBundle)
    && xtermBundle.includes('this._pausedResizeTask.flush()')
    && xtermBundle.includes('getScrollDimensions()')
    && xtermBundle.includes('this._latestYDisp'),
    'los internos de xterm que usa TerminalPane (pausa del renderer y scroll del Viewport) deben seguir existiendo');
// El eje X es solo del host: el navegador desplaza `.xterm-scrollable-element`
// para enseñar el textarea al cruzar las 1024 columnas y el prompt siguiente
// quedaba fuera de la vista (build 25). `scroll` no burbujea: va en captura.
assert(terminalPane.includes("terminalHost.addEventListener('scroll', onInnerHorizontalScroll, { capture: true, passive: true });")
    && terminalPane.includes("terminalHost?.removeEventListener('scroll', onInnerHorizontalScroll, { capture: true });")
    && /function onInnerHorizontalScroll\(event: Event\): void \{[\s\S]{0,400}?target instanceof HTMLTextAreaElement\) return;[\s\S]{0,120}?target\.scrollLeft = 0;/u.test(terminalPane),
    'un desplazamiento horizontal interior debe volver a 0 (salvo el del textarea)');
// Si el cursor cabe en la primera pantalla, la línea se ve desde el principio:
// al borrar una línea que rozaba el borde, el resto de scroll cortaba el prompt.
assert(/if \(cursorRight \+ margin <= viewport\.clientWidth\) \{\s*if \(viewport\.scrollLeft > 0\) setHorizontalScrollLeft\(viewport, 0\);/u.test(terminalPane),
    'con el cursor en la primera pantalla, la vista debe volver al principio de la línea');
// Cada pestaña emite `winslim:first-ready` con el tiempo desde que se abrió la
// app: solo vale el de la primera, o una pestaña abierta tarde decía que «la
// primera tardó 1504,8 s» (vídeo de la auditoría de la build 25).
assert(app.includes('firstReadyMs ??= (event as CustomEvent<{ ms?: number }>).detail?.ms ?? null;')
    && app.includes('considerLowPower(firstReadyMs);'),
    'la sugerencia de bajo consumo solo debe usar la medida de la primera pestaña');
// Restaurar el scroll tras un reajuste no debe dejar fuera el eco de una tecla
// escrita durante el reajuste.
assert(/const restoreHorizontalPosition = \(\) => \{[\s\S]{0,1000}?if \(userEditing\) keepCursorHorizontallyVisible\(\);/u.test(terminalPane),
    'tras restaurar el scroll horizontal de un reajuste, el cursor de la línea en edición debe seguir a la vista');
// La reserva del primer eco se libera al enviar la entrada encolada; si no,
// cada resize posterior sale antes de ajustar las filas.
assert(/\.then\(\(\) => api\.sendInput\(tabId, pending\)\)\s*\.finally\(\(\) => \{[\s\S]{0,700}?if \(!queuedInput\) localInputGridPinned = false;/u.test(terminalPane),
    'la entrada encolada debe liberar la reserva de columnas tras enviarse');
assert(terminalPane.includes("exposeFitSkip('input-warmup');") && terminalPane.includes("exposeFitSkip('horizontal-read');"),
    'los ajustes aplazados deben publicar su motivo');
// La salida interna solo existe en xterm: al terminar cada bloque, xterm debe
// desplazar esas filas y devolver el cursor a la fila que conserva ConPTY.
assert(terminalPane.includes('let internalBatchStart: { row: number; col: number } | null = null;')
    && terminalPane.includes("`\\x1b[${term.rows};1H${'\\n'.repeat(shift)}\\x1b[${start.row + 1};${start.col + 1}H`"),
    'la salida interna no debe desalinear el cursor de ConPTY');
// La rejilla de xterm nunca es más estrecha que ConPTY: si lo fuera, xterm
// refluiría en varias filas líneas que ConPTY mantiene en una.
{
    const tabsSource = await readFile('src-tauri/src/terminal/tabs.rs', 'utf8');
    const commandsSource = await readFile('src-tauri/src/app/commands.rs', 'utf8');
    const backendMin = Number(tabsSource.match(/const MIN_INTERACTIVE_COLS: u16 = ([\d_]+);/u)?.[1]?.replace(/_/gu, ''));
    const frontendMin = Number(terminalPane.match(/const CONPTY_MIN_COLS = (\d+);/u)?.[1]);
    assert(backendMin > 0 && backendMin === frontendMin,
        `CONPTY_MIN_COLS (${frontendMin}) debe coincidir con MIN_INTERACTIVE_COLS (${backendMin})`);
    assert(terminalPane.includes(': Math.max(CONPTY_MIN_COLS, displayCols);')
        && terminalPane.includes('host.dataset.displayCols = String(displayCols)')
        && terminalPane.includes('function currentDisplayCols(): number'),
        'xterm debe compartir la rejilla de ConPTY y publicar aparte el ancho visible');
    assert(tabsSource.includes('tab.viewport_confirmed.then_some(tab.viewport)')
        && tabsSource.includes('pub fn resize_from_frontend(')
        && commandsSource.includes('state.tabs.resize_from_frontend(')
        && commandsSource.includes('exact.unwrap_or(false),')
        && terminalPane.includes('if (lastSize.rows <= 0 && lastPtySize.rows === 0) return commandPtyWarmupQueue;'),
        'una pestaña nueva no arranca la shell hasta recibir la geometría medida del xterm');
}
assert(terminalPane.includes('function onTerminalWheel(event: WheelEvent): void')
    && terminalPane.includes('if (!event.shiftKey')
    && terminalPane.includes('normalizeWheelDelta('),
    'la rueda horizontal conserva la compatibilidad del viewport sin desplazar la salida por una barra secundaria');
assert(terminalPane.includes('dims.cols = requiredTerminalColumns(')
    && terminalPane.includes('terminalHost.dataset.horizontalTail = String(')
    && terminalPane.includes('renderContentColumns > visibleCols')
    && terminalPane.includes("overflow-x', 'hidden'")
    && terminalPane.includes('.xterm .xterm-screen')
    && terminalPane.includes(':global(.terminal-host[data-horizontal-tail="true"] .xterm .xterm-screen)')
    && terminalPane.includes('previousScrollLeft')
    && terminalPane.includes('terminal-host')
    && /overflow-x:\s*auto/.test(terminalPane),
    'las líneas largas conservan el scroll horizontal único sin recortar texto ni cursor');
assert(terminalPane.includes('let wideReleaseTimer: number | undefined')
    && terminalPane.includes('wideReleaseTimer = window.setTimeout(releaseWideReservation, settleDelay)')
    && terminalPane.includes('fitQuietTimer = window.setTimeout(() => {')
    && !terminalPane.includes('fitQuietTimer = window.setTimeout(releaseWideReservation'),
    'el fit tardío no debe cancelar la liberación del ancho horizontal tras una orden corta');
assert(/if \(layoutRowsFit\s*&& !outputBurstWide\s*&& inputWideReservationColumns === 0\s*&& !userEditing\s*&& !inputLineSubmitted/u.test(terminalPane),
    'un resize no debe reducir la rejilla al viewport mientras una orden larga sigue en edición');
assert(/if \(logicalDomColumns < currentDisplayCols\(\)\s*&& inputWideReservationColumns === 0\s*&& !userEditing\s*&& !inputLineSubmitted/u.test(terminalPane),
    'una medida DOM de salida antigua no debe reducir la reserva de la orden que se está editando');
assert(terminalPane.includes('if (event.type === \'focusin\' && focusingFromApp) return;')
    && terminalPane.includes('cancelAnimationFrame(frame)')
    && terminalPane.includes('esLaActiva && app.activeTabId === tabId'),
    'un frame pendiente no debe reactivar una pestaña antigua al mover el foco');
assert(terminalPane.includes('const accumulatedInputLength = Math.max(')
    && (terminalPane.includes('const inputLookahead = Math.max(64, Math.ceil((lineLength + 2) / 64) * 64)')
        || terminalPane.includes('const inputLookahead = lineLength > visibleColumns'))
    && terminalPane.includes('function queueInputPtyResize(requiredColumns: number): Promise<void>')
    && terminalPane.includes('let terminalInputQueue: Promise<void> = Promise.resolve()')
    && terminalPane.includes('const TERMINAL_INPUT_BATCH_MS = 12')
    && terminalPane.includes('function flushTerminalInputBatch(): void')
    && terminalPane.includes('function enqueueTerminalInput(data: string, inputBarrier: Promise<void>): void')
    && terminalPane.includes('enqueueTerminalInput(data, inputResizeBarrier ?? resizeQueue)')
    && terminalPane.includes('function queueOutputPtyResize(requiredColumns: number): void')
    && terminalPane.includes('pendingOutputPtyColumns')
    && terminalPane.includes('let outputLineCarry: OutputLineCarry = EMPTY_OUTPUT_LINE')
    && terminalPane.includes('outputLineCarry = measured.carry')
    && terminalPane.includes('queueOutputPtyResize(requiredColumns)')
    && terminalPane.includes('inputResizeBarrier = reserveCurrentInputColumns(accumulatedInputLength)')
    && terminalPane.includes('const submittedInputColumns = inputWideReservationColumns')
    && terminalPane.includes('const startsNewInputLine = candidate.length <= printableInput.length')
    && terminalPane.includes('if (startsNewInputLine && !terminalOutputBusy)')
    && terminalPane.includes('let horizontalScrollLockUntil = 0')
    && terminalPane.includes('let horizontalUserScrolled = false')
    && terminalPane.includes('horizontalScrollLockUntil = Number.POSITIVE_INFINITY')
    && terminalPane.includes('if (horizontalUserScrolled || Date.now() < horizontalScrollLockUntil) return;')
    && terminalPane.includes('const commandLooksLikeInput = (text: string, row: number): boolean')
    && terminalPane.includes('Una salida como `echo """...`')
    && terminalPane.includes('let userScrolledBack = false')
    && terminalPane.includes('function updateVerticalScrollIntent()'),
    'la entrada larga conserva una reserva anticipada, el scroll manual no salta al inicio y la salida repetitiva se mide');
assert(app.includes('scheduleTerminalRefresh(settled')
    && app.includes("'winslim:terminal-output-refreshed'")
    && !app.includes('settled.clearTextureAtlas()')
    && app.includes("window.dispatchEvent(new CustomEvent('winslim:terminal-output-idle'")
    && !app.includes('current.scrollToBottom()'),
    'la salida PTY debe solicitar un repintado explícito al vaciarse la cola sin mover el scrollback');
assert(terminalPane.includes('function refreshAfterWindowResume()')
    && terminalPane.includes("window.addEventListener('focus', onWindowFocus)")
    && terminalPane.includes("document.addEventListener('visibilitychange', onDocumentVisibilityChange)")
    && terminalPane.includes('term.refresh(0, Math.max(0, term.rows - 1))'),
    'al reactivar la ventana, la terminal activa debe recuperarse sin redimensionar');
const configuredShortcuts = [...defaults.matchAll(/^shortcut\w+\s*=\s*"([^"]*)"/gm)].map((match) => match[1]);
assert.equal(configuredShortcuts.length, shortcuts.SHORTCUT_PREFERENCE_KEYS.length);
const normalizedDefaults = configuredShortcuts.map(shortcuts.normalizeShortcut);
assert(normalizedDefaults.every((value, index) => value || configuredShortcuts[index] === ''), 'Todos los atajos de fábrica deben ser válidos o estar vacíos');
const assignedDefaults = normalizedDefaults.filter(Boolean);
assert.equal(new Set(assignedDefaults).size, assignedDefaults.length, 'Los atajos de fábrica no se pueden repetir');
assert.deepEqual(
    Object.fromEntries([
        ['shortcutPaneLeft', defaults.match(/^shortcutPaneLeft\s*=\s*"([^"]*)"$/m)?.[1]],
        ['shortcutPaneRight', defaults.match(/^shortcutPaneRight\s*=\s*"([^"]*)"$/m)?.[1]],
        ['shortcutPaneUp', defaults.match(/^shortcutPaneUp\s*=\s*"([^"]*)"$/m)?.[1]],
        ['shortcutPaneDown', defaults.match(/^shortcutPaneDown\s*=\s*"([^"]*)"$/m)?.[1]],
    ]),
    {
        shortcutPaneLeft: 'Ctrl+A',
        shortcutPaneRight: 'Ctrl+D',
        shortcutPaneUp: 'Ctrl+W',
        shortcutPaneDown: 'Ctrl+S',
    },
    'La navegación de fábrica debe conservar Ctrl izquierdo + W/A/S/D',
);

const event = (overrides = {}) => ({
    code: 'KeyT',
    key: 't',
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
    ...overrides,
});
assert(shortcuts.matchesShortcut(event(), 'Ctrl+Shift+T'));
assert(shortcuts.matchesShortcut(event({ code: 'Backslash', key: '|'}), 'Ctrl+Shift+Backslash'));
assert(!shortcuts.matchesShortcut(event({ altKey: true }), 'Ctrl+Shift+T'));
assert(shortcuts.matchesShortcut(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: false, shiftKey: false, altKey: true }), 'Alt+ArrowLeft'));
assert(shortcuts.matchesPaneShortcut(event({ code: 'KeyA', key: 'a', shiftKey: false }), 'Ctrl+A', true));
assert(!shortcuts.matchesPaneShortcut(event({ code: 'KeyA', key: 'a', shiftKey: false }), 'Ctrl+A', false));
assert(shortcuts.matchesPaneShortcut(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: false, shiftKey: false, altKey: true }), 'Alt+ArrowLeft', false));
assert.equal(shortcuts.shortcutFromEvent(event({ code: 'KeyH', key: 'h', ctrlKey: true, altKey: true, shiftKey: false })), 'ctrl+alt+h');
assert.equal(shortcuts.shortcutFromEvent(event({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true, altKey: false, shiftKey: false })), 'ctrl+arrowleft');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Ctrl+T'), '');
assert.equal(shortcuts.normalizeShortcut('Ctrl+Shift+TeclaInventada'), '');
// Un atajo vacío (botón «×» de Ajustes) está desasignado: el backend lo
// conserva y ninguna pulsación debe dispararlo ni sustituirlo por el de fábrica.
assert.equal(shortcuts.normalizeShortcut(''), '');
assert.equal(shortcuts.normalizeShortcut('   '), '');
assert(!shortcuts.matchesShortcut(event(), ''), 'un atajo vacío no coincide con ninguna pulsación');
assert(!shortcuts.matchesPaneShortcut(event({ code: 'KeyA', key: 'a', shiftKey: false }), '', true));
assert(!/shortcut\w+\s*\|\|/.test(terminalPane) && !/shortcut\w+\s*\|\|/.test(app),
    'un atajo vacío no debe reemplazarse por el de fábrica con `||`; usa `??` para las preferencias sin cargar');
assert(app.includes('"terminal.terminalOnlyGuideNoShortcut"'),
    'sin atajo para salir del modo limpio, la guía debe indicar :settings en vez de un atajo que ya no existe');

// Paleta de comandos: registro, filtrado y navegación (src/lib/command-palette.ts).
{
    const palette = await importTypeScript('src/lib/command-palette.ts');
    const es = JSON.parse(await readFile('src-tauri/locales/es.json', 'utf8'));
    const internalParser = await readFile('src-tauri/src/terminal/internal_commands.rs', 'utf8');
    const scriptsSource = await readFile('src/components/ScriptsPanel.svelte', 'utf8');
    const paletteComponent = await readFile('src/components/CommandPalette.svelte', 'utf8');
    const t = (key, fallback) => es[key] ?? fallback;
    const fold = (value) => localization.foldLocalized(value, 'es');
    const preferences = {
        ...Object.fromEntries([...defaults.matchAll(/^(shortcut\w+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]])),
        showExplorerPanel: true,
        showProjectsPanel: false,
        showScriptsPanel: true,
        showDependenciesPanel: true,
        terminalOnlyMode: false,
        themeId: 'cyan',
        terminalFontFamily: 'cascadia',
        language: 'es',
        customThemes: [{ id: 'custom-mio', label: 'Mío' }],
    };
    const environments = [
        { id: 'cmd', label: 'Símbolo del sistema', group: 'Shells del sistema', available: true, kind: 'cmd', shell: 'cmd' },
        { id: 'pwsh', label: 'PowerShell 7', group: 'Shells del sistema', available: true, kind: 'powershell', shell: 'pwsh' },
        { id: 'wsl:Ubuntu', label: 'WSL: Ubuntu · bash (sin comprobar)', group: 'WSL · distribuciones Linux', available: true, kind: 'bash', distro: 'Ubuntu' },
        { id: 'lang:python', label: 'Python · REPL', group: 'Lenguajes · intérprete interactivo', available: true, repl: true, kind: 'repl', language: 'python' },
        { id: 'docker:off', label: 'Docker', group: 'Docker · contenedores e imágenes', available: false, note: 'El demonio no responde', kind: 'sh' },
    ];
    const context = {
        t,
        preferences,
        environments,
        activeEnvId: 'cmd',
        hasActiveTab: true,
        activeIsRepl: false,
        tabCount: 1,
        paneCount: 1,
        themes: [{ id: 'cyan', label: 'Cian técnico' }, { id: 'ocean', label: 'Océano' }],
        fonts: [{ id: 'cascadia', label: 'Cascadia Code' }],
        languages: [{ id: 'es', label: 'Español' }, { id: 'en', label: 'English' }],
        ltoolsActions: [{ id: 'disk.status', description: 'Estado de los discos', displayLabel: 'Estado', meta: 'disk · status', needsConfirmation: false }],
    };
    const entries = palette.buildPaletteEntries(context);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.size, entries.length, 'cada entrada de la paleta tiene un id único');
    for (const group of palette.PALETTE_GROUPS) {
        assert(group.labelKey in es, `falta ${group.labelKey}`);
        assert(entries.some((entry) => entry.group === group.id), `el grupo ${group.id} tiene entradas`);
    }
    for (const definition of palette.PALETTE_APP_ACTIONS) {
        assert(definition.labelKey in es, `falta ${definition.labelKey}`);
        // La paleta no inventa acciones: cada una tiene su caso en el
        // manejador que comparten los atajos.
        assert(app.includes(`case '${definition.action}':`), `App.svelte no atiende ${definition.action}`);
        if (definition.shortcut) assert(shortcuts.SHORTCUT_PREFERENCE_KEYS.includes(definition.shortcut), `${definition.shortcut} no es un atajo`);
    }
    const coveredShortcuts = new Set(palette.PALETTE_APP_ACTIONS.map((definition) => definition.shortcut).filter(Boolean));
    assert.deepEqual(
        shortcuts.SHORTCUT_PREFERENCE_KEYS.filter((key) => !coveredShortcuts.has(key)),
        ['shortcutCommandPalette', 'shortcutPaneLeft', 'shortcutPaneRight', 'shortcutPaneUp', 'shortcutPaneDown'],
        'todo atajo que dispara una acción tiene su entrada en la paleta (la navegación espacial y la propia paleta no)',
    );
    for (const command of palette.PALETTE_INTERNAL_COMMANDS) {
        assert(command.descriptionKey in es, `falta ${command.descriptionKey}`);
        const verb = command.line.slice(1).split(' ')[0];
        assert(internalParser.includes(`"${verb}"`), `el parser Rust no reconoce :${verb}`);
        assert(palette.isTypableInternalLine(command.line), `${command.line} se puede teclear`);
    }
    assert.equal(byId.get('app:newTab').shortcut, 'Ctrl+Shift+T', 'muestra el atajo vigente');
    assert.equal(byId.get('app:openSettings').shortcut, '', 'un atajo sin asignar no se muestra');
    assert.equal(byId.get('app:openSettings').command, ':config');
    assert.match(byId.get('app:openProjects').disabledReason, /Ajustes/u, 'un panel oculto se ve deshabilitado con el motivo');
    assert(byId.get('app:nextTab').disabledReason, 'con una sola pestaña no se navega');
    assert.equal(byId.get('env:cmd').current, true);
    assert(byId.get('env:cmd').disabledReason, 'el entorno actual no se vuelve a abrir');
    assert.equal(byId.get('env:docker:off').disabledReason, 'El demonio no responde', 'un entorno no disponible explica por qué');
    assert.deepEqual(byId.get('env:pwsh').action, { kind: 'environment', envId: 'pwsh' });
    assert.equal(byId.get('env:pwsh').command, ':shell pwsh');
    assert.equal(byId.get('env:wsl:Ubuntu').detail, es['group.wsl']);
    assert.deepEqual(byId.get('repl:lang:python').action, { kind: 'newTabIn', envId: 'lang:python' });
    assert.equal(byId.get('repl:lang:python').command, ':repl python');
    assert(!byId.has('repl:pwsh'), 'solo los REPL se ofrecen en pestaña nueva');
    assert(byId.has('theme:custom-mio') && byId.get('theme:cyan').current, 'temas de fábrica y propios, con el actual marcado');
    assert.equal(byId.get('theme:ocean').command, ':theme ocean');
    assert.equal(byId.get('panes:1').current, true);
    assert.equal(byId.get('panes:3').label, es['palette.action.panes'].replace('{count}', '3'));
    assert.deepEqual(byId.get('ltools:disk.status').action, { kind: 'ltools', actionId: 'disk.status', needsConfirmation: false });
    assert.equal(byId.get('internal::terminal list').disabledReason, '');

    const inRepl = new Map(palette.buildPaletteEntries({ ...context, activeIsRepl: true }).map((entry) => [entry.id, entry]));
    assert(inRepl.get('app:clearTerminal').disabledReason && inRepl.get('internal::help').disabledReason,
        'en un REPL o asistente no se teclean órdenes de shell');
    assert.equal(inRepl.get('app:openSettings').disabledReason, '', 'los paneles siguen disponibles desde un REPL');
    const withoutTab = new Map(palette.buildPaletteEntries({ ...context, hasActiveTab: false }).map((entry) => [entry.id, entry]));
    assert(withoutTab.get('app:searchTerminal').disabledReason && withoutTab.get('ltools:disk.status').disabledReason);

    const filtered = (query) => palette.filterPaletteEntries(entries, query, fold).map((entry) => entry.id);
    assert.deepEqual(filtered('  '), entries.map((entry) => entry.id), 'sin búsqueda se conserva el orden del registro');
    assert.equal(filtered('nueva pestana')[0], 'app:newTab', 'la búsqueda ignora tildes y eñes');
    assert.equal(filtered('AJUSTES')[0], 'app:openSettings');
    assert.equal(filtered(':config')[0], 'app:openSettings', 'el comando `:` equivalente también encuentra la acción');
    assert.equal(filtered(':theme ocean')[0], 'theme:ocean');
    assert.equal(filtered('dividir')[0], 'app:cyclePanes');
    assert(filtered('ltools').includes('ltools:disk.status'), 'el nombre del grupo también filtra');
    assert.equal(filtered('nvpst')[0], 'app:newTab', 'sin coincidencias por palabras se admite la subsecuencia');
    assert.deepEqual(filtered('zzzz-no-existe'), []);
    const pestana = palette.filterPaletteEntries(entries, 'pestana', fold);
    const firstDisabled = pestana.findIndex((entry) => entry.disabledReason);
    assert(firstDisabled > 0 && pestana.slice(firstDisabled).every((entry) => entry.disabledReason), 'las deshabilitadas van detrás');

    const raw = palette.paletteResults(entries, ' :terminal   font-size 14 ', context, fold);
    assert.equal(raw[0].id, 'internal:raw', 'una línea `:` nueva se ofrece tal cual');
    assert.deepEqual(raw[0].action, { kind: 'internal', line: ':terminal font-size 14' });
    assert(!palette.paletteResults(entries, ':terminal list', context, fold).some((entry) => entry.id === 'internal:raw'),
        'si ya hay una entrada con ese comando no se duplica');
    assert(!palette.paletteResults(entries, 'echo hola', context, fold).some((entry) => entry.id === 'internal:raw'),
        'solo las líneas `:` se teclean');
    assert(palette.paletteResults(entries, ':help paquetes', { ...context, activeIsRepl: true }, fold)[0].disabledReason);
    assert(palette.isTypableInternalLine(':help internos'));
    assert(!palette.isTypableInternalLine(': help'));
    assert(!palette.isTypableInternalLine(':help\nrm -rf /'), 'nunca varias líneas');
    assert(!palette.isTypableInternalLine(':tema ñ'), 'solo ASCII, como el espejo de entrada');
    assert(!palette.isTypableInternalLine(`:${'x'.repeat(250)}`));

    assert.equal(palette.nextPaletteIndex(0, 'ArrowDown', 3), 1);
    assert.equal(palette.nextPaletteIndex(2, 'ArrowDown', 3), 0, 'da la vuelta abajo');
    assert.equal(palette.nextPaletteIndex(0, 'ArrowUp', 3), 2, 'da la vuelta arriba');
    assert.equal(palette.nextPaletteIndex(1, 'PageDown', 20), 9);
    assert.equal(palette.nextPaletteIndex(3, 'PageUp', 20), 0);
    assert.equal(palette.nextPaletteIndex(0, 'End', 5), 4);
    assert.equal(palette.nextPaletteIndex(0, 'Enter', 3), null);
    assert.equal(palette.nextPaletteIndex(0, 'ArrowDown', 0), -1);
    assert.equal(palette.formatShortcut('ctrl+shift+backslash'), 'Ctrl+Shift+\\');
    assert.equal(palette.formatShortcut('Ctrl+Shift+P'), 'Ctrl+Shift+P');
    assert.equal(palette.formatShortcut('alt+f5'), 'Alt+F5');
    assert.equal(palette.formatShortcut(''), '');
    assert.equal(palette.foldPaletteText('Pestaña Más', fold), 'pestana mas');
    assert.equal(palette.environmentGroupLabel('Docker · algo', t), es['group.docker']);

    assert.match(defaults, /^shortcutCommandPalette = "Ctrl\+Shift\+P"$/mu, 'la paleta se abre con Ctrl+Shift+P de fábrica');
    assert(shortcuts.SHORTCUT_DEFINITIONS.some((definition) => definition.key === 'shortcutCommandPalette'), 'el atajo se graba en Ajustes');
    // Ningún camino de la paleta escribe solo en xterm: los comandos `:` y
    // `clear` se teclean por `onData`, el parser Rust valida antes, y el
    // antiguo `terminal.clear()` (que separaba xterm de ConPTY) ya no existe.
    assert(app.includes("return submitToActiveTerminal('clear');") && !app.includes('terminal?.clear()'),
        'limpiar usa el alias real de la shell');
    assert(app.includes('const command = await api.parseInternalCommand(action.line);'));
    assert(app.includes('paletteOpen = !paletteOpen;') && app.includes('<CommandPalette onRun={runPaletteEntry}'));
    assert(terminalPane.includes('term.input(line, true);')
        && terminalPane.includes("term.input('\\r', true);")
        && terminalPane.includes("if (term.buffer.active.type === 'alternate') return 'busy';")
        && /if \(draft\.trim\(\)\) return 'draft';\s*if \(!terminalPromptVisible\(\)\) return 'busy';/u.test(terminalPane)
        && terminalPane.includes('registerTerminalControls(tabId, { openSearch, saveOutput, copyLastOutput, jumpToCommand, submitLine: submitLineFromApp, insertLine: insertLineFromApp, lastCommandContext });')
        && terminalPane.includes('unregisterTerminalControls(tabId);'),
        'TerminalPane teclea por la ruta del teclado y solo sobre un prompt vacío');
    assert(paletteComponent.includes('role="combobox"') && paletteComponent.includes('aria-activedescendant')
        && paletteComponent.includes('role="listbox"') && paletteComponent.includes('role="option"')
        && paletteComponent.includes("event.key === 'Escape'") && paletteComponent.includes('event.stopPropagation();'),
        'la paleta es accesible con teclado y Escape no cierra el panel de detrás');
    assert(scriptsSource.includes('ltoolsActionNeedsConfirmation(action)') && scriptsSource.includes('ltoolsSelectionStorageKey(')
        && paletteComponent.includes('pinnedLToolsActions(') && paletteComponent.includes('ltoolsActionNeedsConfirmation(action)'),
        'Biblioteca y paleta comparten selección, nombres y confirmación de LTools');

    assert.equal(ltoolsSelection.ltoolsSelectionStorageKey('windows'), 'lterminal.ltools.quick-actions.v1.windows');
    assert.deepEqual(ltoolsSelection.pinnedLToolsActions(ltoolsActions, null).map((action) => action.id), firstSelection.selectedIds,
        'las fijadas son la selección reconciliada, en su orden');
    assert.equal(ltoolsSelection.ltoolsActionNeedsConfirmation({ mutating: false, confirmation: 'none' }), false);
    assert.equal(ltoolsSelection.ltoolsActionNeedsConfirmation({ mutating: false, confirmation: 'required' }), true);
    const twins = [
        { ...ltoolsActions[0], id: 'disk.status', shortLabel: 'Status', scope: 'disk' },
        { ...ltoolsActions[1], id: 'net.status', shortLabel: 'Status', scope: 'net' },
    ];
    assert.equal(ltoolsSelection.ltoolsActionLabel(twins[0], twins), 'Status · disk', 'un nombre repetido se desambigua por ámbito');
    assert.equal(ltoolsSelection.ltoolsActionLabel(ltoolsActions[5], ltoolsActions), 'Action 5');
}

// La fuente y el tamaño de las filas se repiten en CSS estático desde las
// mismas preferencias que recibe xterm: si su hoja dinámica dejara de
// aplicarse, la celda medida y la pintada no coincidirían.
assert(terminalPane.includes('style:--wt-xterm-font-size={`${app.preferences?.terminalFontSize ?? 14}px`}')
    && terminalPane.includes('font-size: var(--wt-xterm-font-size, 14px) !important;')
    && terminalPane.includes('font-family: var(--wt-xterm-font-family, monospace) !important;'),
    'las filas de xterm deben pintarse con la fuente y el tamaño que mide xterm');
// Tauri no debe añadir nonces a style-src: con ellos se ignora 'unsafe-inline'
// y las hojas que xterm crea al arrancar (colores ANSI, negrita, cursiva) no
// se aplican.
const tauriConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
assert(tauriConfig.app.security.csp.includes("style-src 'self' 'unsafe-inline'")
    && JSON.stringify(tauriConfig.app.security.dangerousDisableAssetCspModification) === JSON.stringify(['style-src'])
    && /script-src 'self' 'wasm-unsafe-eval';/u.test(tauriConfig.app.security.csp)
    && !/script-src[^;]*'unsafe-(inline|eval)'/u.test(tauriConfig.app.security.csp),
    'la CSP debe permitir los estilos de xterm y el WebAssembly de las imágenes sin relajar los scripts');
// Imágenes en línea y anchos Unicode modernos, alineados con ConPTY.
assert(terminalPane.includes('term.loadAddon(new Unicode11Addon());') && terminalPane.includes("term.unicode.activeVersion = '11';")
    && terminalPane.includes('sixelSupport: true') && terminalPane.includes('iipSupport: false')
    && terminalPane.includes("if (app.appInfo?.platform === 'windows') alignSixelWithConpty(term, imageAddon);"),
    'la terminal debe cargar los anchos Unicode 11 y las imágenes Sixel alineadas con ConPTY');
// Caja de celdas de un Sixel según ConPTY (VT340: celda 10×20, píxel 2:1 por defecto).
const sixelConpty = await importTypeScript('src/lib/sixel-conpty.ts');
assert.equal(sixelConpty.sixelPixelAspect(undefined, '#0~~'), 2);
assert.equal(sixelConpty.sixelPixelAspect(0, '"1;1;8;60#0~~'), 1, 'los atributos de trama mandan sobre P1');
assert.equal(sixelConpty.sixelPixelAspect(2, '#0'), 5);
assert.equal(sixelConpty.sixelPixelAspect(9, '#0'), 1);
// Filas que baja ConPTY medidas en Windows: 6→0, 18→1, 24→2, 42→4, 60→6, 120→12.
for (const [height, conptyRows] of [[6, 0], [18, 1], [24, 2], [42, 4], [60, 6], [120, 12]]) {
    const box = sixelConpty.conptySixelBox(8, height, 2, { width: 8.4, height: 21 });
    assert.equal(Math.ceil(box.boxHeight / 21) - 1, conptyRows, `Sixel de ${height} px: xterm debe bajar ${conptyRows} filas como ConPTY`);
    assert(box.drawWidth <= box.boxWidth && box.drawHeight <= box.boxHeight, 'la imagen cabe en su caja');
    assert(Math.abs(box.drawWidth / box.drawHeight - 8 / (height * 2)) < 0.02, 'la imagen conserva sus proporciones');
}
const fractional = sixelConpty.conptySixelBox(400, 400, 1, { width: 7.83, height: 19.6 });
assert.equal(Math.ceil(fractional.boxWidth / 7.83), fractional.cols, 'una celda fraccionaria no añade una columna de más');
assert.equal(Math.ceil(fractional.boxHeight / 19.6), fractional.rows, 'una celda fraccionaria no añade una fila de más');
// Seguimiento horizontal del cursor: margen de celdas, ampliación del ancho
// desplazable cuando el cursor no cabe y la línea medida con el prompt.
assert(terminalPane.includes('const margin = Math.min(viewport.clientWidth / 4, cellWidth * 3);')
    && terminalPane.includes('ensureHorizontalRoom(cursorRight + margin + cellWidth * 64, cellWidth);')
    && terminalPane.includes('lineLength += Math.max(0, inputStartColumn);')
    && terminalPane.includes('inputStartColumn = term?.buffer.active.cursorX ?? 0;'),
    'el scroll horizontal debe seguir al cursor con margen y contar el prompt');
// Solo un gesto real bloquea el seguimiento; el desplazamiento nativo del
// textarea de xterm no, y teclear cierra la ventana del gesto.
assert(/const userGesture = horizontalPointerDown\s*\|\| performance\.now\(\) - lastHorizontalGestureAt < HORIZONTAL_GESTURE_WINDOW_MS;/u.test(terminalPane)
    && terminalPane.includes("host.addEventListener('wheel', markGesture, { capture: true, passive: true });")
    && /horizontalScrollLockUntil = 0;\s*\/\/[^\n]*\n[^\n]*\n\s*lastHorizontalGestureAt = 0;/u.test(terminalPane),
    'el scroll nativo del textarea no debe contar como scroll del usuario');

// El Enter de recuperación del primer prompt solo se envía cuando la shell ya
// produjo salida: durante un inicializador lento quedaba en cola y duplicaba
// el prompt, desalineando ConPTY y xterm en casillas diminutas.
assert(/initialPromptRecoveryAttempts >= 6[\s\S]{0,900}?&& firstShellOutputAt > 0\s*&& performance\.now\(\) - firstShellOutputAt >= 2000/u.test(terminalPane)
    && terminalPane.includes('if (firstShellOutputAt === 0) firstShellOutputAt = performance.now();'),
    'el Enter de recuperación no debe enviarse mientras la shell sigue inicializando');

// Entornos y descargas: la carpeta se aplica al confirmar el campo (no en cada
// tecla, que crearía carpetas a medio escribir), los tamaños se miden al entrar
// en Comportamiento y vaciar pide una segunda pulsación.
const settingsPanel = await readFile('src/components/SettingsPanel.svelte', 'utf8');
// La casilla del PATH se bloquea mientras el backend escribe el registro: un
// segundo clic en ese intervalo cruzaba dos escrituras y dejaba entradas
// sueltas en el PATH del usuario.
assert(settingsPanel.includes('if (!pathIntegration || pathIntegrationBusy) return;')
    && settingsPanel.includes('disabled={pathIntegrationBusy} onchange={togglePathIntegration}'),
    'la casilla del PATH debe bloquearse mientras se aplica el cambio');
assert(/data-testid="settings-toolchain-store-dir"[\s\S]{0,400}?oninput=\{\(event\) => event\.stopPropagation\(\)\}[\s\S]{0,200}?commitToolchainStoreDir\(event\.currentTarget\.value\)/u.test(settingsPanel),
    'la carpeta de cachés solo debe guardarse al confirmar el campo');
assert(/if \(section !== "behavior" \|\| !toolchainStorePreferenceKey\) return;[\s\S]{0,120}?void refreshToolchainStore\(\);/u.test(settingsPanel),
    'el espacio de las cachés se mide al abrir Comportamiento y tras guardar la carpeta');
assert(/void refreshToolchainExternal\(remeasureExternal\);\s*try \{\s*const next = await api\.getToolchainStore\(\);/u.test(settingsPanel),
    'las ubicaciones externas se miden aparte y no retrasan las cachés propias');
assert(/if \(!toolchainStoreConfirmClear\) \{\s*toolchainStoreConfirmClear = true;\s*return;\s*\}/u.test(settingsPanel),
    'vaciar las cachés debe pedir confirmación');

// Biblioteca: un `<details open={expr}>` comparte efecto con el resto de
// textos dinámicos del elemento y Svelte vuelve a escribir `open` cada vez
// que cambia uno de ellos. Con el contador de tipos en el resumen, cada casilla
// marcada cerraba la lista. Los desplegables siguen el estado con `bind:open`.
const scriptsPanel = await readFile('src/components/ScriptsPanel.svelte', 'utf8');
assert(!/<details\b[^>]*\sopen=\{/u.test(scriptsPanel)
    && scriptsPanel.includes('data-testid="scripts-types" bind:open={typesOpen}'),
    'la lista de tipos de la Biblioteca debe seguir abierta al marcar casillas');

// Temas: de fábrica solo cambian el acento sobre la base de «Cian técnico»;
// recolorear todo es voluntario; un tema propio trae sus colores y su ANSI.
// Las reglas tienen que coincidir con `effective_palette` de preferences.rs.
const themeModule = await importTypeScript('src/lib/theme.ts');
const palette = (background, accent, text = '#cccccc') => ({
    background, surface: background, surfaceAlt: background, border: background, text, muted: text,
    accent, accentSoft: accent, terminalBackground: background, terminalForeground: text, selection: accent,
});
const presets = [
    { id: 'silver', label: 'Plata', description: '', palette: palette('#080808', '#b8bec6') },
    { id: 'winslim', label: 'Cian', description: '', palette: palette('#0d0d0d', '#0078d4', '#d4d4d4') },
    { id: 'crimson', label: 'Carmesí', description: '', palette: palette('#120b0c', '#e05561') },
    { id: 'contrast', label: 'Contraste', description: '', palette: palette('#000000', '#ffd400', '#ffffff') },
];
const neutral = themeModule.effectivePalette('crimson', { customThemes: [], themeRecolorAll: false }, presets);
assert.equal(neutral.background, '#0d0d0d', 'un tema de fábrica conserva el fondo neutro');
assert.equal(neutral.accent, '#e05561', 'y aporta su acento');
assert.equal(themeModule.effectivePalette('crimson', { customThemes: [], themeRecolorAll: true }, presets).background, '#120b0c');
assert.equal(themeModule.effectivePalette('contrast', { customThemes: [], themeRecolorAll: false }, presets).text, '#ffffff');
const mine = { id: 'custom-mio', label: 'Mío', palette: palette('#101010', '#ff0000'), ansi: themeModule.DEFAULT_ANSI_COLORS };
const patch = themeModule.themePreferencePatch('custom-mio', { customThemes: [mine], themeRecolorAll: false }, presets);
assert.equal(patch.uiBackgroundColor, '#101010');
assert.equal(patch.terminalAnsiColors.length, 16);
assert.notEqual(patch.terminalAnsiColors, mine.ansi, 'la paleta ANSI se copia, no se comparte');
const ansiTheme = themeModule.terminalTheme({ ...patch, terminalAnsiColors: themeModule.DEFAULT_ANSI_COLORS }, presets);
assert.equal(ansiTheme.brightWhite, '#eeeeec');
assert.equal(themeModule.terminalTheme({ ...patch, terminalAnsiColors: [] }, presets).red, undefined);
const fonts = [{ id: 'mono', label: 'Mono', css: 'Consolas, monospace' }];
assert.equal(themeModule.terminalFont({ terminalFontFamily: 'mono', terminalFontCustom: 'Mi Fuente' }, fonts), "'Mi Fuente', Consolas, monospace");
const preferencesRs = await readFile('src-tauri/src/config/preferences.rs', 'utf8');
assert(preferencesRs.includes('pub const NEUTRAL_THEME_ID: &str = "winslim";')
    && preferencesRs.includes('const FULL_PALETTE_THEMES: [&str; 1] = ["contrast"];'),
    'theme.ts y preferences.rs deben compartir la base neutra y las excepciones');
// Tamaño de la interfaz: se escribe a mano entre 80 y 500 %, y por encima
// del 200 % nunca deja la interfaz más estrecha que la ventana mínima (480 px).
assert.equal(themeModule.clampUiScale(137.4), 137);
assert.equal(themeModule.clampUiScale(20), 80);
assert.equal(themeModule.clampUiScale(900), 500);
assert.equal(themeModule.clampUiScale(Number.NaN), 100);
assert.equal(themeModule.effectiveUiScale(150, 600), 150, 'hasta el 200 % se aplica lo pedido');
assert.equal(themeModule.effectiveUiScale(500, 1918), 399, '1918 / 480 cabe al 399 %');
assert.equal(themeModule.effectiveUiScale(500, 3840), 500, 'una pantalla 4K admite el 500 %');
assert.equal(themeModule.effectiveUiScale(300, 1100), 229);
assert.equal(themeModule.effectiveUiScale(300, 700), 200, 'nunca baja de lo que se aplicaba antes');
assert(preferencesRs.includes('integer_in_range(get("uiScale"), 80, 500, defaults.ui_scale)'),
    'theme.ts y preferences.rs deben compartir los límites del tamaño de la interfaz');
// `:theme <id>` debe aplicar los colores del tema, no solo su identificador.
assert(terminalPane.includes('themePreferencePatch(theme.id, app.preferences, app.themes)'),
    ':theme tiene que aplicar la paleta del tema');

// Tarjeta de «Entornos y descargas»: `position: fixed` se resuelve respecto
// a la ventana (el `container-type` del panel no es su bloque contenedor), así
// que la posición se calcula en coordenadas de ventana y se corrige midiendo.
const floatingTip = await importTypeScript('src/lib/floating-tip.ts');
const tipPanel = { left: 333, top: 45, right: 1092, bottom: 685 };
const tipRow = { left: 346, top: 402, right: 1080, bottom: 426 };
const tipPlacement = floatingTip.placeFloatingTip(tipRow, tipPanel);
assert.deepEqual(tipPlacement, { left: 346, top: 430, width: 360, above: false },
    'la tarjeta empieza en la fila, en coordenadas de la ventana y no relativas al panel');
const lowRow = { left: 346, top: 600, right: 1080, bottom: 624 };
assert.deepEqual(floatingTip.placeFloatingTip(lowRow, tipPanel), { left: 346, top: 596, width: 360, above: true },
    'sin sitio debajo se abre encima de la fila');
assert.equal(floatingTip.placeFloatingTip({ ...tipRow, left: 1000 }, tipPanel).left, 1092 - 360 - 8,
    'una fila pegada al borde derecho no saca la tarjeta del panel');
assert.equal(floatingTip.placeFloatingTip({ ...tipRow, left: 100 }, tipPanel).left, 333 + 8,
    'ni por la izquierda');
assert.equal(floatingTip.placeFloatingTip(tipRow, { left: 0, top: 0, right: 150, bottom: 400 }).width, 200,
    'en un panel estrecho conserva un ancho legible');
// La medida real manda: si un antecesor sí fuera bloque contenedor, la
// tarjeta saldría desplazada por su origen y la corrección la devuelve.
assert.deepEqual(floatingTip.fitFloatingTip({ left: 15, top: 387, right: 375, bottom: 585 }, tipPanel), { dx: 326, dy: 0 },
    'la tarjeta pintada a la izquierda del panel vuelve dentro');
assert.deepEqual(floatingTip.fitFloatingTip({ left: 400, top: 600, right: 760, bottom: 760 }, tipPanel), { dx: 0, dy: -83 },
    'si se sale por abajo sube lo justo');
assert.deepEqual(floatingTip.fitFloatingTip({ left: 400, top: 20, right: 760, bottom: 200 }, tipPanel), { dx: 0, dy: 33 },
    'si se sale por arriba baja lo justo');
assert.deepEqual(floatingTip.fitFloatingTip({ left: 400, top: 60, right: 760, bottom: 900 }, tipPanel), { dx: 0, dy: -7 },
    'más alta que el panel: sube solo hasta el margen superior');
const tallFit = floatingTip.fitFloatingTip({ left: 400, top: 53, right: 760, bottom: 893 }, tipPanel);
assert.equal(tallFit.dy, 0, 'y la vuelta siguiente ya no la mueve (sin bucle de efectos)');
assert(settingsPanel.includes('placeFloatingTip(row.getBoundingClientRect(), bounds)')
    && settingsPanel.includes('fitFloatingTip(tip.getBoundingClientRect(), panel)')
    && !settingsPanel.includes('rowRect.left - box.left'),
    'SettingsPanel coloca la tarjeta con floating-tip y no con coordenadas relativas al panel');

// Enlaces clicables: qué se subraya, qué gesto abre y qué se rechaza antes de
// llegar al backend. `terminal/links.rs` repite la validación y manda.
const terminalLinks = await importTypeScript('src/lib/terminal-links.ts');
const linkMatches = (line) => [...line.matchAll(new RegExp(terminalLinks.TERMINAL_LINK_REGEX.source, `${terminalLinks.TERMINAL_LINK_REGEX.flags}g`))]
    .map((match) => match[0]);
assert.deepEqual(linkMatches('Visita https://example.com/docs?x=1.'), ['https://example.com/docs?x=1'],
    'la puntuación final no forma parte del enlace');
assert.deepEqual(linkMatches('(ver https://github.com/Darkeiser003/Terminal)'), ['https://github.com/Darkeiser003/Terminal'],
    'un paréntesis que envuelve la URL queda fuera');
assert.deepEqual(linkMatches('"HTTP://Example.com/a" y file:///C:/Users/Romen/informe.txt'), ['HTTP://Example.com/a', 'file:///C:/Users/Romen/informe.txt'],
    'http en mayúsculas y file:// explícito se detectan; las comillas no');
for (const line of ['C:\\Users\\Romen> dir', 'romen@pc:~/proyecto$ ls', 'ftp://example.com/x', 'javascript:alert(1)', 'mailto:a@example.com']) {
    assert.deepEqual(linkMatches(line), [], `no se subraya: ${line}`);
}
assert.equal(terminalLinks.isLinkActivation({ ctrlKey: true, button: 0 }), true, 'Ctrl+clic abre');
assert.equal(terminalLinks.isLinkActivation({ ctrlKey: false, button: 0 }), false, 'un clic normal no abre');
assert.equal(terminalLinks.isLinkActivation({ ctrlKey: true, button: 2 }), false, 'Ctrl+clic derecho no abre');
const linkOk = terminalLinks.checkTerminalLink('  HTTPS://Example.COM/Ruta?q=1  ');
assert.deepEqual(linkOk, { ok: true, url: 'https://example.com/Ruta?q=1', scheme: 'https:', host: 'example.com' },
    'la URL se normaliza y el host se enseña aparte');
const homograph = terminalLinks.checkTerminalLink('https://ex\u0430mple.com/');
assert(homograph.ok && homograph.host.startsWith('xn--'), 'un dominio con letras de otro alfabeto se enseña en punycode');
assert.deepEqual(terminalLinks.checkTerminalLink('https://google.com@evil.example/').host, 'evil.example',
    'el truco usuario@host muestra el host real');
for (const [text, reason] of [
    ['', 'empty'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,x', 'scheme'],
    ['ms-settings:privacy', 'scheme'],
    ['https://usuario:clave@example.com/', 'credentials'],
    ['https://exa\nmple.com', 'hidden-characters'],
    ['https://example.com/\u202Egpj.exe', 'hidden-characters'],
    ['https://exam\u200Bple.com', 'hidden-characters'],
    ['example.com', 'malformed'],
    [`https://example.com/${'a'.repeat(terminalLinks.MAX_TERMINAL_LINK_LENGTH)}`, 'too-long'],
]) {
    assert.deepEqual(terminalLinks.checkTerminalLink(text), { ok: false, reason }, `rechazo «${reason}»`);
}
assert.deepEqual(terminalLinks.checkTerminalLink('file:///C:/Users/Romen/'), { ok: true, url: 'file:///C:/Users/Romen/', scheme: 'file:', host: '' },
    'file: local pasa al backend, que comprueba la ruta en el disco');
assert.equal(terminalLinks.linkRejectionMessageKey('scheme'), 'terminal.linkBlockedScheme');
assert.equal(terminalLinks.linkRejectionMessageKey('not-found'), 'terminal.linkBlockedFile');
assert.equal(terminalLinks.linkRejectionMessageKey('remote-file'), 'terminal.linkBlockedFile');
assert.equal(terminalLinks.linkRejectionMessageKey('open-failed'), 'terminal.linkOpenFailed');
assert.equal(terminalLinks.linkRejectionMessageKey('credentials'), 'terminal.linkBlockedUnsafe');
assert.equal(terminalLinks.linkRejectionMessageKey('disabled'), null, 'con los enlaces desactivados no hay aviso');
{
    const linksRs = await readFile('src-tauri/src/terminal/links.rs', 'utf8');
    const rustSchemes = linksRs.match(/pub const ALLOWED_SCHEMES: \[&str; \d+\] = \[([^\]]*)\];/u)?.[1]
        ?.split(',').map((item) => item.trim().replace(/"/gu, '')) ?? [];
    assert.deepEqual(rustSchemes, terminalLinks.TERMINAL_LINK_SCHEMES.map((scheme) => scheme.replace(':', '')),
        'frontend y backend deben admitir los mismos esquemas');
    assert.equal(Number(linksRs.match(/pub const MAX_LINK_LENGTH: usize = (\d+);/u)?.[1]), terminalLinks.MAX_TERMINAL_LINK_LENGTH,
        'frontend y backend deben limitar igual la longitud');
    assert(linksRs.includes('pub fn terminal_open_link(app: AppHandle, url: String) -> LinkOpenResult')
        && linksRs.includes('if !crate::preferences::current().terminal_links {')
        && /record_path_from\(\s*e2e_testing\(\),\s*std::env::var_os\("LTERMINAL_E2E_OPENED_LINKS"\),?\s*\)/u.test(linksRs)
        && /if e2e_testing\(\) \{\s*record_e2e_open\(&target\);/u.test(linksRs)
        && linksRs.includes('.reveal_item_in_dir(path)'),
        'el backend valida, respeta el ajuste, no abre nada en E2E y nunca ejecuta un archivo');
    const apiSource = await readFile('src/lib/api.ts', 'utf8');
    const capabilities = JSON.parse(await readFile('src-tauri/capabilities/default.json', 'utf8'));
    assert(apiSource.includes("invokeLogged<TerminalLinkResult>('terminal_open_link', { url })")
        && !/\bopenUrl\b/u.test(apiSource)
        && !capabilities.permissions.includes('opener:allow-open-url'),
        'el WebView no puede abrir URL por su cuenta: solo a través de terminal_open_link');
    assert(terminalPane.includes("import { WebLinksAddon } from '@xterm/addon-web-links';")
        && terminalPane.includes('urlRegex: TERMINAL_LINK_REGEX,')
        && terminalPane.includes('linkHandler: terminalLinkHandler(preferences?.terminalLinks !== false),')
        && terminalPane.includes('allowNonHttpProtocols: true,')
        && terminalPane.includes('const disabledLinkHandler: ILinkHandler = { activate: () => undefined };')
        && terminalPane.includes('if (!isLinkActivation(event) || app.preferences?.terminalLinks === false) return;')
        && terminalPane.includes("if (app.preferences?.terminalLinksConfirm !== false) {")
        && terminalPane.includes('const result = await api.openTerminalLink(url);')
        && terminalPane.includes('syncTerminalLinks(preferences.terminalLinks !== false);')
        && terminalPane.includes('data-testid="terminal-link-dialog"')
        && !terminalPane.includes('window.open('),
        'TerminalPane subraya con addon-web-links y OSC 8, abre solo con Ctrl+clic, confirma y delega en el backend');
    assert(settingsPanel.includes('data-testid="settings-terminal-links"\n                            bind:checked={draft.terminalLinks}')
        && settingsPanel.includes('data-testid="settings-terminal-links-confirm"\n                            disabled={!draft.terminalLinks}\n                            bind:checked={draft.terminalLinksConfirm}'),
        'Ajustes → Terminal activa los enlaces y su confirmación');
    assert(/^terminalLinks = true$/mu.test(defaults) && /^terminalLinksConfirm = true$/mu.test(defaults),
        'los enlaces vienen activados y con confirmación de fábrica');
    // Escribir de una vez las órdenes de las acciones: su fila y, de fábrica
    // desde el 15-11, encendida.
    assert(settingsPanel.includes('data-testid="settings-action-commands-at-once"\n                            bind:checked={draft.actionCommandsAtOnce}')
        && /^actionCommandsAtOnce = true$/mu.test(defaults),
        'Ajustes tiene «Escribir de una vez las órdenes de las acciones», encendida de fábrica');
    // Una IA que acaba pidiendo su clave: la pestaña la ofrece, el campo la
    // oculta y la oferta se puede apagar en Ajustes (encendida de fábrica).
    assert(settingsPanel.includes('data-testid="settings-ai-key-offer"\n                                bind:checked={draft.aiKeyOffer}')
        && /^aiKeyOffer = true$/mu.test(defaults)
        && terminalPane.includes('data-testid="ai-key-offer"')
        && terminalPane.includes('type="password"\n                    class="ai-key-input"')
        && terminalPane.includes("if (app.preferences?.aiKeyOffer === false) return;")
        && terminalPane.includes("aiKeyValue = '';"),
        'la oferta de clave de IA tiene su fila en Ajustes, oculta la clave y vacía el campo');
}

// Imagen a la izquierda del banner (src/lib/banner-image.ts): el banner se
// reconoce por su título tras el margen exacto que deja el backend, y la
// separación es la misma constante en Rust y en TypeScript.
{
    // Caché de enlaces bajo el ratón (src/lib/link-cache.ts): se invalida
    // tocando dos campos internos del Linkifier de xterm. Si una versión nueva
    // los renombra, este test falla en vez de volver el fallo en silencio
    // (un enlace escrito bajo el ratón no se detectaba).
    {
        const linkCache = await importTypeScript('src/lib/link-cache.ts');
        const fake = { _core: { linkifier: { _activeLine: 4, _lastBufferCell: { x: 3, y: 4 } } } };
        assert.equal(linkCache.invalidateLinkCache(fake), true);
        assert.equal(fake._core.linkifier._activeLine, -1);
        assert.equal(fake._core.linkifier._lastBufferCell, undefined);
        assert.equal(linkCache.invalidateLinkCache({}), false, 'sin linkifier no hace nada');
        const xtermLib = await readFile('node_modules/@xterm/xterm/lib/xterm.js', 'utf8');
        assert.match(xtermLib, /get linkifier\(\)\{return this\._linkifier\.value\}/u, 'xterm sigue exponiendo _core.linkifier');
        assert.match(xtermLib, /this\._activeLine=-1/u, 'el Linkifier de xterm sigue usando _activeLine');
        assert.match(xtermLib, /this\._lastBufferCell=t\)/u, 'el Linkifier de xterm sigue usando _lastBufferCell');
    }
    // Programas a pantalla completa (src/lib/full-screen-app.ts): Claude Code,
    // Amp o vim reciben el ancho visible y no la reserva de 1024 columnas.
    {
        const fullScreen = await importTypeScript('src/lib/full-screen-app.ts');
        const step = (current, params, set) => fullScreen.fullScreenTransition(current, params, set);
        assert.equal(fullScreen.isAiEnvironmentId('ai:claude'), true);
        assert.equal(fullScreen.isAiEnvironmentId('pwsh'), false);
        assert.deepEqual(fullScreen.flattenCsiParams([1049, [2026, 25]]), [1049, 2026, 25]);
        assert.equal(step(null, [1049], true), 'alternate-screen', 'Amp/vim entran en la pantalla alternativa');
        assert.equal(step('alternate-screen', [1049], false), null, 'y al salir vuelve la shell');
        assert.equal(step(null, [2026], true), undefined, 'ConPTY envuelve sus repintados en ?2026: no es señal');
        assert.equal(step(null, [25], true), undefined, 'una shell que enseña el cursor sigue siendo shell');
        assert.equal(step(null, [2004], true), undefined, 'el pegado entre corchetes no es pantalla completa');
        assert.equal(step('ai-environment', [1049], false), undefined, 'una pestaña de IA no sale nunca');
        assert.equal(step('ai-command', [1049], false), undefined, 'una IA tecleada sale al volver el prompt, no por su pantalla');
        for (const line of ['claude', '  amp --help', 'codex.exe', '& \'C:\\npm\\gemini.cmd\'', '"C:\\Program Files\\x\\opencode.exe" run', '.\\qwen.ps1']) {
            assert.equal(fullScreen.isAiCommandLine(line), true, line);
        }
        assert.equal(fullScreen.aiCommandName('  AMP.cmd --help'), 'amp', 'el nombre coincide con el id de su entorno ai:amp');
        assert.equal(fullScreen.aiCommandName('vim'), null);
        for (const line of ['echo claude', 'dir', 'claudette', ':theme', '', null]) {
            assert.equal(fullScreen.isAiCommandLine(line), false, String(line));
        }
        // Python en Windows: con pyreadline3 repinta toda la ventana a cada
        // tecla (84 KB con 1024 columnas), así que va con el ancho visible.
        const windowsPython = { windows: true, pythonVisibleWidth: true };
        assert.equal(fullScreen.environmentFullScreenReason('ai:amp', windowsPython), 'ai-environment');
        assert.equal(fullScreen.environmentFullScreenReason('lang:python', windowsPython), 'python-environment');
        assert.equal(fullScreen.environmentFullScreenReason('lang:python', { windows: true, pythonVisibleWidth: false }), null,
            'la opción de Ajustes lo apaga');
        assert.equal(fullScreen.environmentFullScreenReason('lang:python', { windows: false, pythonVisibleWidth: true }), null,
            'en Linux el readline de Python dibuja con VT y no lo necesita');
        for (const id of ['cmd', 'lang:node', 'lang:ipython', 'wsl:Ubuntu:lang:python', '', null]) {
            assert.equal(fullScreen.environmentFullScreenReason(id, windowsPython), null, String(id));
        }
        assert.equal(step('python-environment', [1049], true), undefined, 'la pestaña de Python manda sobre su pantalla alternativa');
        assert.equal(step('python-command', [1049], false), undefined, 'el Python tecleado sale al volver el prompt');
        assert.equal(fullScreen.endsWithShellPrompt('python-command'), true);
        assert.equal(fullScreen.endsWithShellPrompt('ai-command'), true);
        assert.equal(fullScreen.endsWithShellPrompt('python-environment'), false);
        for (const line of ['python', 'py', 'PY -3.12', 'python3 -q', 'python3.12', '"C:\\Python312\\python.exe"', '& python.exe -X utf8', 'python -i script.py']) {
            assert.equal(fullScreen.isInteractivePythonCommandLine(line), true, line);
        }
        for (const line of ['python script.py', 'python -m pip install x', 'py -c "print(1)"', 'python -', 'pythonw', 'pip', 'echo python', '', null]) {
            assert.equal(fullScreen.isInteractivePythonCommandLine(line), false, String(line));
        }
        const pane = await readFile('src/components/TerminalPane.svelte', 'utf8');
        // Al cambiar de entorno, lo tecleado para el programa anterior no se
        // entrega al nuevo (build 51: el final de una orden de Python en Node).
        // Lo encolado con otra época no se envía (y cuenta como descartado en
        // el diagnóstico de `__wtInputState`).
        assert(/if \(epoch !== terminalInputEpoch\) \{[\s\S]{0,120}?return undefined;\s*\}\s*return api\.sendInput\(tabId, data\)/u.test(pane)
            && /queuedInput = '';\n(?:\s*\/\/[^\n]*\n)*\s*terminalInputEpoch \+= 1;\n\s*if \(terminalInputBatchTimer !== undefined\) window\.clearTimeout\(terminalInputBatchTimer\);\n\s*terminalInputBatchTimer = undefined;\n\s*pendingTerminalInputData = '';/u.test(pane),
            'el cambio de entorno abre una época nueva en la cola de entrada');
        assert(pane.includes('if (fullScreenApp) {\n            fitFullScreen();\n            return;\n        }')
            && pane.includes('const cols = Math.max(FULL_SCREEN_MIN_COLS, measuredVisibleColumns());')
            && pane.includes('if (fullScreenApp) return Math.max(FULL_SCREEN_MIN_COLS, currentDisplayCols());')
            && pane.includes('if (fullScreenApp && displayCols !== previousDisplayCols) syncPtyWidthForFullScreen();')
            && (pane.match(/api\.resize\(tabId, [^;]*, fullScreenApp\);/gu) ?? []).length === 6,
            'TerminalPane da a la PTY el ancho visible exacto en modo pantalla completa');
        assert(pane.includes('? Math.max(FULL_SCREEN_MIN_COLS, displayCols)')
            && pane.includes('&& shellPromptAtCursor()'),
            'xterm y ConPTY encogen juntas en pantalla completa y la IA tecleada termina con el prompt vacío en la fila del cursor');
        const appSource = await readFile('src/App.svelte', 'utf8');
        assert(appSource.includes("if (term.buffer.active.type === 'alternate') term.write('\\x1b[?1049l');")
            && appSource.includes('\\x1b[?25h\\x1b[?1000l'),
            'una sesión nueva sale de la pantalla alternativa y de los modos que dejó una TUI');
    }
    const bannerImage = await importTypeScript('src/lib/banner-image.ts');
    const systemInfo = await readFile('src-tauri/src/platform/system_info.rs', 'utf8');
    const gap = Number(/pub const BANNER_IMAGE_GAP: usize = (\d+);/u.exec(systemInfo)?.[1]);
    assert.equal(bannerImage.BANNER_IMAGE_GAP, gap, 'la separación de la imagen del banner coincide con el backend');
    assert.equal(bannerImage.bannerImagePadding(20), 22);
    // Bajo la imagen, el mismo hueco que a los lados (BANNER_IMAGE_GAP
    // columnas): el prompt de PowerShell 7, bash de WSL o NSudo, que va en la
    // fila siguiente sin línea en blanco, ya no queda pegado.
    assert.equal(bannerImage.bannerImageHeight(8.4), `calc(100% - ${(bannerImage.BANNER_IMAGE_GAP * 8.4).toFixed(2)}px)`);
    assert.equal(bannerImage.bannerImageHeight(0), 'calc(100% - 0.00px)', 'sin medida no recorta');
    assert.equal(bannerImage.bannerImageHeight(Number.NaN), 'calc(100% - 0.00px)');
    // La imagen va centrada en el margen: el mismo hueco contra el borde de la
    // ventana que contra el texto, en todos los anchos (en el banner grande la
    // limita el ancho y antes quedaba pegada al borde izquierdo).
    assert.deepEqual(bannerImage.bannerImageBox(22), { x: 2, width: 18 });
    for (let columns = bannerImage.BANNER_IMAGE_MIN_COLUMNS; columns <= bannerImage.BANNER_IMAGE_MAX_COLUMNS; columns += 1) {
        const padding = bannerImage.bannerImagePadding(columns);
        const box = bannerImage.bannerImageBox(padding);
        assert.equal(box.x, gap, `hueco izquierdo con ${columns} columnas`);
        assert.equal(padding - box.x - box.width, gap, `hueco derecho con ${columns} columnas`);
    }
    const margin = ' '.repeat(22);
    const title = 'WTerminal 1.0.0';
    const lines = [
        'C:\\> sysinfo',
        '',
        `${margin}${title}`,
        `${margin}Sistema  Windows 11`,
        `${margin}CPU      Ryzen (16T)`,
        `${margin}Memoria  8 GB / 32 GB (25%)`,
        'C:\\>',
        `${margin}${title}`,
        `${margin}Sistema  Windows 11`,
    ];
    assert.deepEqual(bannerImage.findBannerBlocks(lines, title), [{ index: 2, rows: 4, padding: 22 }, { index: 7, rows: 2, padding: 22 }],
        'cada banner es un bloque desde su título mientras dure el margen');
    const narrow = ' '.repeat(14);
    assert.deepEqual(bannerImage.findBannerBlocks([`${narrow}${title}`, `${narrow}CPU  x`, `${margin}${title}`, `${margin}CPU  y`], title),
        [{ index: 0, rows: 2, padding: 14 }, { index: 2, rows: 2, padding: 22 }],
        'cada banner conserva el margen con el que se imprimió (12 y 20 columnas)');
    assert.deepEqual(bannerImage.findBannerBlocks([`${margin}${title}`, 'C:>'], title), [],
        'un título suelto sin datos debajo no es un banner');
    assert.deepEqual(bannerImage.findBannerBlocks([`${margin}${title}`, `${margin}  sangrado`], title), [],
        'las líneas del banner empiezan justo tras el margen');
    assert.deepEqual(bannerImage.findBannerBlocks([`  ${title}`, '  Sistema  x'], title), [],
        'un margen menor que el de 8 columnas no es el de la imagen');
    assert.deepEqual(bannerImage.findBannerBlocks([`${' '.repeat(43)}${title}`, `${' '.repeat(43)}Sistema  x`], title), [],
        'ni uno mayor que el de 40 columnas');
    assert.deepEqual(bannerImage.findBannerBlocks([`${title}`, 'Sistema  x'], title), [],
        'el banner sin margen no recibe imagen');
    const terminalPane = await readFile('src/components/TerminalPane.svelte', 'utf8');
    const appState = await readFile('src/lib/appState.svelte.ts', 'utf8');
    assert(terminalPane.includes('bannerImages = attachBannerImages(term, () => {')
        && terminalPane.includes('enabled: prefs.bannerImage && prefs.showSystemBanner,')
        && (await readFile('src/lib/banner-image.ts', 'utf8')).includes('const box = bannerImageBox(block.padding);')
        && terminalPane.includes('bannerImages?.dispose();')
        && terminalPane.includes(':global(.banner-image-decoration)'),
        'cada terminal coloca y retira la imagen del banner');
    assert(appState.includes("import defaultBannerLogo from '../assets/banner/logo.png';")
        && appState.includes('const url = await api.readBannerImage(path);')
        && appState.includes('|| before.bannerImageColumns !== after.bannerImageColumns;'),
        'el estado lee la imagen propia y recompone el banner al cambiar su margen');
}

// Cortar o borrar una parte de lo escrito (src/lib/input-selection.ts): la
// selección dentro de la línea, tras el prompt, se convierte en flechas hasta
// su final y un retroceso por carácter (no por celda).
{
    const selection = await importTypeScript('src/lib/input-selection.ts');
    const ESC = String.fromCharCode(27);
    const DEL = String.fromCharCode(127);
    const left = (count) => `${ESC}[D`.repeat(count);
    const right = (count) => `${ESC}[C`.repeat(count);
    const backslash = String.fromCharCode(92);
    const cmdPrompt = `C:${backslash}Users${backslash}romen>`;
    assert.equal(selection.promptInputStart(`${cmdPrompt}echo hola`), cmdPrompt.length, 'prompt de cmd');
    assert.equal(selection.promptInputStart(`PS C:${backslash}x> echo`), `PS C:${backslash}x> `.length, 'prompt de PowerShell');
    assert.equal(selection.promptInputStart('romen@pc:~$ ls'), 'romen@pc:~$ '.length, 'prompt de bash');
    assert.equal(selection.promptInputStart('$ ls'), 2);
    assert.equal(selection.promptInputStart('❯ ls'), 2, 'prompt de starship');
    assert.equal(selection.promptInputStart('salida cualquiera'), null);

    // Celdas falsas: un carácter ancho ocupa dos y la segunda va vacía.
    const fakeLine = (cells) => ({
        length: cells.length,
        getCell: (x) => cells[x] && { getChars: () => cells[x][0], getWidth: () => cells[x][1] },
    });
    const wide = fakeLine([['❯', 1], [' ', 1], ['中', 2], ['', 0], ['a', 1], [' ', 1], ['', 1]]);
    assert.equal(selection.columnAtTextIndex(wide, 2), 2, 'el tercer carácter empieza en la columna 2');
    assert.equal(selection.columnAtTextIndex(wide, 3), 4, 'tras un carácter ancho se salta su segunda celda');
    assert.equal(selection.contentEndColumn(wide), 5, 'el texto acaba tras la «a»');

    // Una fila: `C:\Users\romen>echo "Hola, soy Romen" TAG` con el cursor al final.
    const line = `${cmdPrompt}echo "Hola, soy Romen" TAG`;
    const row = 7;
    const textBetween = (from, to) => (from.y === to.y ? line.slice(from.x, to.x) : '');
    const phraseStart = line.indexOf('Hola');
    const phraseEnd = phraseStart + 'Hola, soy Romen'.length;
    const context = (overrides = {}) => ({
        start: { x: phraseStart, y: row },
        end: { x: phraseEnd, y: row },
        cursor: { x: line.length, y: row },
        cursorCellBlank: true,
        inputStart: { x: cmdPrompt.length, y: row },
        inputEnd: { x: line.length, y: row },
        textBetween,
        ...overrides,
    });
    assert.deepEqual(selection.inputSelectionEdit(context()), {
        text: 'Hola, soy Romen',
        input: left(line.length - phraseEnd) + DEL.repeat(15),
    }, 'una parte interior de lo escrito se corta llevando el cursor a su final');
    assert.deepEqual(selection.inputSelectionEdit(context({ start: { x: phraseEnd, y: row }, end: { x: phraseStart, y: row } })),
        selection.inputSelectionEdit(context()), 'da igual el sentido del arrastre');
    assert.equal(selection.inputSelectionEdit(context({ start: { x: 2, y: row } })), null, 'el prompt no se puede borrar');
    assert.equal(selection.inputSelectionEdit(context({ start: { x: 0, y: row - 1 }, end: { x: 4, y: row - 1 } })), null,
        'una selección del historial no se convierte en retrocesos');
    // El cursor a la izquierda (se movió con las flechas): se avanza hasta el final.
    assert.equal(selection.inputSelectionEdit(context({ cursor: { x: cmdPrompt.length + 2, y: row } })).input,
        right(phraseEnd - cmdPrompt.length - 2) + DEL.repeat(15));
    // Seleccionar hasta la celda en blanco del cursor es seleccionar hasta el cursor.
    const tail = line.indexOf('TAG');
    assert.equal(selection.inputSelectionEdit(context({ start: { x: tail, y: row }, end: { x: line.length + 1, y: row } })).input,
        DEL.repeat(3));
    // Sin prompt reconocible (nano, un REPL): solo si toca el cursor.
    assert.equal(selection.inputSelectionEdit(context({ inputStart: null })), null);
    assert.equal(selection.inputSelectionEdit(context({ inputStart: null, start: { x: tail, y: row }, end: { x: line.length, y: row } })).input,
        DEL.repeat(3));
    // Se cuentan caracteres, no celdas: «中» ocupa dos celdas y es una tecla.
    const wideText = (from, to) => (to.x - from.x === 3 ? '中a' : 'x');
    assert.equal(selection.inputSelectionEdit({
        start: { x: 2, y: 0 }, end: { x: 5, y: 0 }, cursor: { x: 5, y: 0 }, cursorCellBlank: true,
        inputStart: { x: 2, y: 0 }, inputEnd: { x: 5, y: 0 }, textBetween: wideText,
    }).input, DEL.repeat(2));
    assert.equal(selection.selectionSearchText('   \n  hola mundo  \notra'), 'hola mundo', 'se busca la primera línea con texto');
    assert.equal(selection.selectionSearchText('x'.repeat(300)).length, 200);
    assert.equal(selection.selectionSearchText(''), '');
    const terminalPane = await readFile('src/components/TerminalPane.svelte', 'utf8');
    assert(terminalPane.includes("data-testid=\"terminal-menu-search\"")
        && terminalPane.includes("runMenu('search')")
        && terminalPane.includes("(event.key === 'Backspace' || event.key === 'Delete')")
        && terminalPane.includes('return inputSelectionEdit({'),
        'el menú busca la selección y Retroceso/Supr borran una selección editable');
}

// Buscador de Ajustes (src/lib/settings-search.ts): filas que coinciden, su
// encabezado, las notas que van con su fila y el título de la sección.
{
    const search = await importTypeScript('src/lib/settings-search.ts');
    assert.equal(search.foldSearchText('Menú ÁRBOL'), 'menu arbol', 'sin tildes ni mayúsculas');
    const blocks = [
        { kind: 'section', text: 'Comportamiento' },
        { kind: 'heading', text: 'Inicio y paneles' },
        { kind: 'row', text: 'Idioma' },
        { kind: 'hint', text: 'Se aplica a toda la interfaz.' },
        { kind: 'row', text: 'Iniciar maximizada Abre la ventana ocupando todo el espacio' },
        { kind: 'heading', text: 'Atajos de teclado' },
        { kind: 'row', text: 'Nueva pestaña' },
        { kind: 'row', text: 'Cerrar panel' },
        { kind: 'section', text: 'Terminal' },
        { kind: 'heading', text: 'Cursor' },
        { kind: 'row', text: 'Parpadeo' },
    ];
    const visible = (query) => search.settingsSearchVisibility(blocks, query);
    assert.deepEqual(visible(''), blocks.map(() => true), 'sin búsqueda se ve todo');
    assert.deepEqual(visible('maximizada'), [true, true, false, false, true, false, false, false, false, false, false],
        'una fila, su encabezado y el título de su sección');
    assert.deepEqual(visible('atajos'), [true, false, false, false, false, true, true, true, false, false, false],
        'buscar un encabezado enseña todo su grupo');
    assert.deepEqual(visible('toda la interfaz'), [true, true, true, true, false, false, false, false, false, false, false],
        'una nota que coincide trae su fila');
    assert.deepEqual(visible('idioma'), [true, true, true, true, false, false, false, false, false, false, false],
        'la nota va con su fila');
    assert.deepEqual(visible('pestana'), [true, false, false, false, false, true, true, false, false, false, false],
        '«pestana» encuentra «pestaña»');
    assert.deepEqual(visible('no existe'), blocks.map(() => false));
    assert.equal(search.visibleSettingsRows(blocks, visible('a')), blocks.filter((block) => block.kind === 'row'
        && search.foldSearchText(block.text).includes('a')).length + 0);
    const settingsPanel = await readFile('src/components/SettingsPanel.svelte', 'utf8');
    assert(settingsPanel.includes('data-testid="settings-search"')
        && settingsPanel.includes('settingsSearchVisibility(')
        && settingsPanel.includes('data-testid="settings-index"')
        && settingsPanel.includes('{#if showSettingsIndex(sectionHeadings.length, searchingSettings)}'),
        'Ajustes tiene buscador e índice de secciones');
    // Índice solo en las pestañas largas: Comportamiento (más de una decena de
    // apartados) sí; Información (4) y Apariencia o Terminal (1–2), no.
    assert.equal(search.showSettingsIndex(12, false), true, 'Comportamiento lleva índice');
    for (const headings of [1, 2, 4, 5]) {
        assert.equal(search.showSettingsIndex(headings, false), false, `${headings} apartados no llevan índice`);
    }
    assert.equal(search.showSettingsIndex(12, true), false, 'mientras se busca no hay índice');
}

// Choques de atajos (12-11): con la edición de línea de la shell o con otro
// atajo de la app. Solo se avisa.
{
    const conflicts = shortcuts.shortcutConflicts;
    assert.deepEqual(conflicts('shortcutCloseTab', { shortcutCloseTab: 'Ctrl+R' }), { shell: true, duplicateOf: null }, 'Ctrl+R es la búsqueda de la shell');
    assert.deepEqual(conflicts('shortcutCloseTab', { shortcutCloseTab: 'Ctrl+Shift+W', shortcutNewTab: 'ctrl+shift+w' }), { shell: false, duplicateOf: 'shortcutNewTab' }, 'dos acciones con la misma tecla');
    assert.deepEqual(conflicts('shortcutCloseTab', { shortcutCloseTab: 'Ctrl+Shift+W' }), { shell: false, duplicateOf: null });
    assert.deepEqual(conflicts('shortcutCloseTab', { shortcutCloseTab: '' }), { shell: false, duplicateOf: null }, 'sin asignar no choca');
}

// Chat lateral con los agentes (12-11): la respuesta se parte en texto y
// bloques de código (también uno sin cerrar mientras llega) y sin colores.
{
    const chat = await importTypeScript('src/lib/agent-chat.ts');
    const fence = '```';
    assert.deepEqual(chat.splitAgentAnswer(`Usa esto:\n${fence}bat\ndir /s\n${fence}\nY ya.`), [
        { kind: 'text', text: 'Usa esto:' },
        { kind: 'code', text: 'dir /s', lang: 'bat' },
        { kind: 'text', text: 'Y ya.' },
    ], 'texto, código (con su lenguaje) y texto');
    assert.deepEqual(chat.splitAgentAnswer(`Mira:\n${fence}\nls -la`), [
        { kind: 'text', text: 'Mira:' },
        { kind: 'code', text: 'ls -la' },
    ], 'un bloque aún sin cerrar ya cuenta como código');
    assert.deepEqual(chat.splitAgentAnswer('Solo texto'), [{ kind: 'text', text: 'Solo texto' }]);
    assert.equal(chat.stripAnsi('\u001b[1;32mverde\u001b[0m y \u001b]8;;https://x\u0007enlace\u001b]8;;\u0007'), 'verde y enlace',
        'sin colores ni hipervínculos OSC 8');
    // Los secretos de la terminal no llegan al agente.
    const secrets = chat.redactSecrets([
        'export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234',
        'xai-0123456789abcdefABCDEF y ghp_0123456789abcdefghij0123456789abcd',
        'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx.yz"',
        'password: "hunter2 largo"',
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n-----END OPENSSH PRIVATE KEY-----',
        'nada secreto aquí: ls -la',
    ].join('\n'));
    for (const leaked of ['sk-proj-abcdef', 'xai-0123', 'ghp_0123', 'abcdefghijklmnopqrstuvwx', 'hunter2', 'b3BlbnNzaC1rZXktdjE']) {
        assert(!secrets.text.includes(leaked), `el contexto no lleva «${leaked}»: ${secrets.text}`);
    }
    assert(secrets.text.includes('nada secreto aquí: ls -la') && secrets.count >= 6, `se ocultan ${secrets.count} secretos y el resto queda`);
    assert.deepEqual(chat.redactSecrets('git status'), { text: 'git status', count: 0 }, 'sin secretos no cambia nada');
    const agentChat = await readFile('src/components/AgentChat.svelte', 'utf8');
    assert(agentChat.includes('const { text: context, count } = redactSecrets(raw);'), 'el chat filtra los secretos del contexto');
    // 16-11: qué modelo contestó. El que dice la CLI gana al elegido; sin
    // elegir, «por defecto»; Ollama ya lo lleva en su nombre.
    assert.deepEqual(chat.answerModel('gpt-5.1-codex', { agentId: 'ai:codex', model: 'o4-mini' }), { kind: 'reported', name: 'gpt-5.1-codex' });
    assert.deepEqual(chat.answerModel(null, { agentId: 'ai:claude', model: ' opus ' }), { kind: 'chosen', name: 'opus' });
    assert.deepEqual(chat.answerModel('', { agentId: 'ai:gemini', model: '' }), { kind: 'default', name: '' });
    assert.equal(chat.answerModel(null, { agentId: 'ai:ollama:qwen3:8b', model: '' }), null);
    assert.equal(chat.answerModel(null, null), null);
    assert(agentChat.includes('{@const shownModel = answerModel(message.reportedModel, message.ask)}'), 'cada respuesta dice su modelo');
    // Los reintentos por saturación se ven según pasan, no solo al cortarse,
    // y el texto de ayuda de la caja cabe en una fila (las teclas, en `title`).
    assert(agentChat.includes('api.onAgentChatStatus(') && agentChat.includes('retryText(message.retry)'), 'el chat enseña cada reintento');
    assert(agentChat.includes("title={app.t('agentChat.inputHint'"), 'las teclas de la caja van en su ayuda');
    assert(agentChat.includes('.composer textarea:placeholder-shown'), 'el texto de ayuda acaba en «…» si no cabe');
    // Markdown de las respuestas (13-11): sin HTML, cada trozo con su tipo.
    assert.deepEqual(chat.parseInlines('Usa **dir** o `ls`, *no* _rm_.'), [
        { kind: 'text', text: 'Usa ' }, { kind: 'bold', text: 'dir' }, { kind: 'text', text: ' o ' },
        { kind: 'code', text: 'ls' }, { kind: 'text', text: ', ' }, { kind: 'italic', text: 'no' },
        { kind: 'text', text: ' ' }, { kind: 'italic', text: 'rm' }, { kind: 'text', text: '.' },
    ], 'negrita, código y cursiva en línea');
    assert.deepEqual(chat.parseInlines('mi_archivo_nuevo.txt <b>x</b>'), [{ kind: 'text', text: 'mi_archivo_nuevo.txt <b>x</b>' }],
        'los guiones bajos de un nombre no son cursiva y el HTML queda como texto');
    const blocks = chat.parseTextBlocks('## Pasos\n1. Uno\n2. Dos\n- suelto\n\n> ojo\nLínea a\nLínea b');
    assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'list', 'list', 'quote', 'paragraph'], 'título, dos listas, cita y párrafo');
    assert.equal(blocks[0].level, 2);
    assert.equal(blocks[1].ordered, true);
    assert.equal(blocks[1].items.length, 2);
    assert.equal(blocks[2].ordered, false);
    assert.deepEqual(blocks[4].inlines, [{ kind: 'text', text: 'Línea a\nLínea b' }], 'las líneas seguidas forman un párrafo');
    // Memoria de la conversación: las últimas vueltas con respuesta y con tope.
    const labels = { you: 'Tú', agent: 'Agente' };
    const history = [
        { question: 'uno', answer: 'r1' },
        { question: 'dos', answer: '' },
        { question: 'tres', answer: 'r3' },
    ];
    assert.equal(chat.conversationTranscript(history, labels), 'Tú: uno\nAgente: r1\n\nTú: tres\nAgente: r3', 'sin las vueltas que no tuvieron respuesta');
    assert.equal(chat.conversationTranscript(history, labels, { maxTurns: 1 }), 'Tú: tres\nAgente: r3', 'solo las últimas');
    assert.equal(chat.conversationTranscript([{ question: 'q', answer: 'x'.repeat(50) }, { question: 'q2', answer: 'y' }], labels, { maxChars: 30 }),
        'Tú: q2\nAgente: y', 'si no cabe, se quitan primero las viejas');
    // La pregunta montada: conversación, adjuntos con una valla que no se corta,
    // la pregunta y el contexto al final.
    const promptLabels = { conversation: 'Conversación:', attachment: 'Adjunto «{name}»:', truncated: 'solo el principio', question: 'Pregunta:' };
    assert.equal(chat.buildChatPrompt({ question: ' hola ', labels: promptLabels }), 'hola', 'sin nada más, la pregunta tal cual');
    const prompt = chat.buildChatPrompt({
        question: '¿Qué hace?',
        transcript: 'Tú: a\nAgente: b',
        attachments: [{ name: 'LEEME.md', text: `Ejemplo:\n${fence}bash\nls\n${fence}\n`, truncated: true }],
        context: 'Orden: dir',
        labels: promptLabels,
    });
    assert(prompt.startsWith('Conversación:\nTú: a\nAgente: b\n\nAdjunto «LEEME.md»: (solo el principio)\n````\n'), prompt);
    assert(prompt.includes(`${fence}\n\`\`\`\`\n\nPregunta:\n¿Qué hace?\n\n---\nOrden: dir`), prompt);
    // 14-11: la línea que explica el fallo, con las salidas reales de las
    // capturas de Romen.
    assert.equal(chat.errorHeadline("ERROR\n\n  No providers configured - please run 'crush' to set up a provider interactively."),
        "No providers configured - please run 'crush' to set up a provider interactively.");
    assert.equal(chat.errorHeadline('Error: No authentication information found.\n\nCopilot can be authenticated with GitHub'),
        'No authentication information found.');
    assert.equal(chat.errorHeadline('No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.'),
        'No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.');
    assert.equal(chat.errorHeadline('warning: Falling back from WebSockets to HTTPS transport.\nERROR: unexpected status 401 Unauthorized: Missing bearer'),
        'unexpected status 401 Unauthorized: Missing bearer');
    assert.equal(chat.errorHeadline('    at foo (node:internal/x:1:1)\n}\n'), '', 'sin texto útil, nada');
    // 15-11: Continue escribe un JSON y Gemini un error con nombre detrás de
    // la ruta de su informe; vale su mensaje.
    assert.equal(chat.errorHeadline('{"status":"error","message":"The request failed and the interceptors did not return an alternative response"}'),
        'The request failed and the interceptors did not return an alternative response');
    assert.equal(chat.errorHeadline('Error when talking to Gemini API Full report available at: C:\\T\\gemini-client-error.json ModelNotFoundError: This model models/gemini-2.5-flash is no longer available to new users.\n  code: 404\n}\nAn unexpected critical error occurred:[object Object]'),
        'This model models/gemini-2.5-flash is no longer available to new users.');
    assert(chat.errorHeadline(`Error: ${'x'.repeat(400)}`).length === 200, 'cortada a 200');
    assert.equal(chat.formatBytes(812), '812 B');
    assert.equal(chat.formatBytes(3482, 'es-ES'), '3,4 KB');
    assert.equal(chat.formatBytes(1.2 * 1024 * 1024, 'en-US'), '1.2 MB');
    // El panel manda el modelo y la intensidad elegidos, y la memoria se apaga.
    assert(agentChat.includes('agentChatAsk(') && /agentChatAsk\([^)]*model[^)]*effort/su.test(agentChat), 'el chat pasa modelo e intensidad');
    assert(agentChat.includes('agentChatRemember'), 'la memoria del chat sigue su ajuste');
    // Modo consejero: encendido de fábrica (13-11) y solo prepara la pregunta, sin mandarla.
    assert(/^agentChatAdvisor = true$/mu.test(defaults) && /^agentChatRemember = true$/mu.test(defaults) && terminalPane.includes('if (app.preferences?.agentChatAdvisor === true && app.preferences.agentChat !== false) {')
        && !terminalPane.includes('agentChatAsk(') && agentChat.includes('app.agentChatDraft = null;'),
        'el modo consejero ofrece, rellena el campo y nunca pregunta solo');
    assert(agentChat.includes('controls?.insertLine(code.trim())') && !agentChat.includes('submitLine('),
        'el chat inserta en la terminal SIN Intro y nunca ejecuta');
    assert(agentChat.includes("disabled={part.text.trim().includes('\\n')}"),
        'un bloque de varias líneas no se inserta (se ejecutaría al pegarse)');
    // 13-11: el modelo se elige de una lista (con el de fábrica real), y tras
    // un fallo se ofrece lo que lo arregla; editar archivos, apagado.
    assert(agentChat.includes('api.agentChatModels(') && agentChat.includes('api.agentChatFailureHelp(')
        && agentChat.includes('data-testid="agent-chat-open-tab"') && agentChat.includes('data-testid="agent-chat-key"'),
        'el chat pide los modelos y la ayuda tras un fallo');
    assert(/^agentChatCanEdit = false$/mu.test(defaults), 'los agentes del chat solo leen de fábrica');
    // 14-11 (Romen, con el menú de Claude: «los permisos tmb»): el panel manda
    // el modo y el modo rápido; lo que edita y «Omitir permisos» siguen sus
    // ajustes, los dos apagados, y el de fábrica es el primero (solo lee).
    assert(/agentChatAsk\([^)]*request\.mode[^)]*request\.fast/su.test(agentChat), 'el chat pasa el modo y el modo rápido');
    assert(/^agentChatAllowBypass = false$/mu.test(defaults), '«Omitir permisos», apagado de fábrica');
    assert(agentChat.includes("const allowBypass = $derived(canEdit && app.preferences?.agentChatAllowBypass === true);")
        && agentChat.includes("if (id === 'bypass') return allowBypass;")
        && agentChat.includes("const defaultMode = $derived(canEdit && modes.includes('acceptEdits') ? 'acceptEdits' : (modes[0] ?? ''));"),
        'los modos siguen los ajustes y el de fábrica solo lee');
    assert(agentChat.includes('data-testid="agent-chat-mode"') && agentChat.includes('data-testid="agent-chat-bypass-warning"')
        && agentChat.includes('data-testid="agent-chat-fast"'),
        'el panel enseña los modos, avisa de «Omitir permisos» y ofrece el modo rápido');
    // 14-11 noche (Romen, probando la 62): la lista de agentes sigue a la
    // detección, el clip vuelve, las IA de pestaña van en el desplegable,
    // «Otro…» solo si la lista puede estar incompleta y ShellGPT sin clave
    // no se lanza.
    assert(/\$effect\(\(\) => \{\s*void app\.environments;\s*untrack\(\(\) => void loadAgents\(\)\);\s*\}\);/u.test(agentChat)
        && !/onMount\(\(\) => \{\s*void loadAgents\(\);/u.test(agentChat),
        'el chat vuelve a pedir los agentes al acabar la detección');
    assert(/class="icon clip" data-testid="agent-chat-attach"/u.test(agentChat) && !agentChat.includes("'agentChat.attachShort'"),
        'adjuntar es el clip');
    assert(agentChat.includes('<optgroup label={app.t(\'agentChat.openInTabGroup\'') && !agentChat.includes("'agentChat.tabOnly'")
        && agentChat.includes('if (value.startsWith(TAB_AGENT))'),
        'las IA de pestaña van al final del desplegable y se abren en la suya');
    assert(agentChat.includes('{#if models?.custom !== false}'), '«Otro…» solo si la lista puede estar incompleta');
    assert(agentChat.includes('/needs-key:([A-Z0-9_]+)/u.exec(reason)'), 'ShellGPT sin clave: se ofrece la clave sin lanzarlo');
    assert(agentChat.includes('errorHeadline(output)') && agentChat.includes('data-testid="agent-chat-error-detail"'),
        'el error en una línea y lo demás plegado');
    // 14-11 noche: varios chats en paralelo (AgentChats), el botón ✦ al final
    // de la fila de pestañas y, con varios chats, la pregunta preparada solo
    // para el que se ve.
    const agentChats = await readFile('src/components/AgentChats.svelte', 'utf8');
    const appShell = await readFile('src/App.svelte', 'utf8');
    const tabBar = await readFile('src/components/TabBar.svelte', 'utf8');
    const toolbar = await readFile('src/components/Toolbar.svelte', 'utf8');
    const notices = await readFile('src/lib/notices.ts', 'utf8');
    assert(appShell.includes('<AgentChats />') && !appShell.includes('<AgentChat />')
        && agentChats.includes('<AgentChat embedded active={chat.id === activeId}')
        && agentChats.includes('const MAX_CHATS = 6;'),
        'el panel lleva varios chats, cada uno entero');
    assert(agentChat.includes('if (!prepared || !active) return;'), 'la pregunta del consejero va al chat que se ve');
    assert(tabBar.includes('data-testid="toolbar-agent-chat"') && tabBar.includes('agent-chat-toggle')
        && !toolbar.includes('data-testid="toolbar-agent-chat"'),
        'el botón del chat va al final de la fila de pestañas, con icono');
    // 14-11 noche: los avisos que ofrecen instalar (gsudo y el ayudante de
    // la shell) y el permiso del control de las IA.
    assert(appShell.includes('data-testid="gsudo-offer"') && appShell.includes("api.runInstallAction(app.activeTabId, 'winget-gsudo')")
        && appShell.includes('neverShowAgain({ offerGsudo: false })'),
        'el aviso de gsudo instala con la acción de WTerminal y se puede no volver a ofrecer');
    assert(appShell.includes('data-testid="shell-assist-offer"') && appShell.includes('app.appInfo?.e2eTesting')
        && appShell.includes('neverShowAgain({ offerShellAssist: false })'),
        'el aviso del autocompletado no sale en E2E y se puede no volver a ofrecer');
    // 17-11 (Romen): el aviso del ayudante de la shell y el de gsudo, con la
    // misma barra que el de WinGet; y todos los avisos con «No volver a
    // mostrar», recuperables en Ajustes > Avisos.
    for (const testId of ['gsudo-offer', 'shell-assist-offer', 'profile-offer']) {
        assert(appShell.includes(`<div class="update" role="status" aria-live="polite" data-testid="${testId}"`),
            `el aviso ${testId} usa la barra de abajo, igual que el de WinGet`);
    }
    for (const [testId, key] of [
        ['gsudo-offer-never', 'offerGsudo'], ['shell-assist-offer-never', 'offerShellAssist'],
        ['missing-tool-never', 'suggestMissingTools'], ['low-power-dismiss', 'lowPowerSuggest'],
        ['profile-offer-never', 'offerPortableProfile'], ['import-suggestion-never', 'suggestRepositoryImport'],
        ['package-update-never', 'checkPackageUpdatesOnStartup'], ['update-never', 'checkUpdatesOnStartup'],
    ]) {
        assert(appShell.includes(`data-testid="${testId}"`), `el aviso tiene «No volver a mostrar» (${testId})`);
        assert(notices.includes(`key: '${key}'`), `el ajuste ${key} se recupera en Ajustes > Avisos`);
    }
    assert(appShell.includes("api.onCommandNotFound((event) => {") && appShell.includes('suggestMissingTools === false) return;'),
        'el aviso de herramienta que falta respeta su «No volver a mostrar»');
    assert(terminalPane.includes('data-testid="agent-chat-advice-never"') && terminalPane.includes('savePreferences({ agentChatAdvisor: false })')
        && terminalPane.includes('data-testid="ai-key-never"') && terminalPane.includes('savePreferences({ aiKeyOffer: false })'),
        'los avisos de la pestaña (preguntar a la IA y la clave de API) también se pueden no volver a mostrar');
    assert(settingsPanel.includes('data-testid="settings-notices"') && settingsPanel.includes('restoreAllNotices()')
        && settingsPanel.includes('NOTICE_SETTINGS') && settingsPanel.includes('data-testid="settings-notices-hidden"')
        && settingsPanel.includes('onclick={() => goToNotice(notice)}'),
        'Ajustes > Avisos lista los apagados, lleva a su casilla y los vuelve a mostrar todos');
    // 17-11 (Romen, «ajustes duplicados»): cada aviso tiene UNA casilla, en su
    // sitio; el apartado Avisos no repite ninguna.
    assert(!settingsPanel.includes('bind:checked={draft[notice.key]}'),
        'el apartado Avisos no repite las casillas de los avisos');
    const noticeTargets = [...notices.matchAll(/target: '([^']+)'/gu)].map((match) => match[1]);
    assert(noticeTargets.length === [...notices.matchAll(/key: '/gu)].length,
        'cada aviso dice dónde está su casilla');
    for (const target of noticeTargets) {
        assert(settingsPanel.split(`data-testid="${target}"`).length === 2,
            `el aviso tiene una sola casilla en Ajustes (${target})`);
    }
    assert(!settingsPanel.includes('terminalOnlyGuideLockedHint') && !settingsPanel.includes('disabled={app.preferences?.showTerminalOnlyGuide === false}'),
        'la guía de pantalla limpia se vuelve a encender con su casilla, sin restablecer');
    assert(/^suggestMissingTools = true$/mu.test(defaults) && /^offerPortableProfile = true$/mu.test(defaults),
        'los dos avisos nuevos, encendidos de fábrica');
    assert(appShell.includes('if (app.appInfo?.e2eTesting) return;') && appShell.includes('status.customized && status.profiles.length === 0'),
        'el perfil portable se sugiere solo con ajustes propios y ninguno guardado, y nunca en E2E');
    assert(appShell.includes('data-testid="agent-control-request"') && appShell.includes('api.onAgentControl(')
        && appShell.includes("if (tab.id === agentTab) return false;")
        && appShell.includes("if (request.confirm && !controlAllowedForSession)"),
        'el control de las IA pide permiso y nunca escribe en la pestaña de la propia IA');
    assert(/^offerGsudo = true$/mu.test(defaults) && /^offerShellAssist = true$/mu.test(defaults)
        && /^agentTabGuide = true$/mu.test(defaults) && /^agentControl = true$/mu.test(defaults),
        'los ajustes nuevos, encendidos de fábrica');
    // El menú de la pestaña lee su id ANTES de cerrarse (antes «Renombrar» y
    // «Cerrar pestaña» no hacían nada).
    assert(tabBar.includes("onclick={() => { const id = tab.id; menu = null; app.renamingTabId = id; }}")
        && tabBar.includes("onclick={() => { const id = tab.id; menu = null; void app.closeTab(id); }}")
        && !/menu = null; [^}]*tab\.id/u.test(tabBar),
        'el menú de la pestaña no lee la pestaña después de cerrarse');
    assert(settingsPanel.includes('data-testid="settings-agent-chat-allow-bypass"')
        && settingsPanel.includes('disabled={!draft.agentChat || !draft.agentChatCanEdit}'),
        '«Omitir permisos» en Ajustes pide también editar');
}

// «Restablecer» (13-11): cada preferencia en exactamente un apartado, sin
// claves inventadas, y nada se restablece sin pasar por el diálogo.
{
    const reset = await importTypeScript('src/lib/settings-reset.ts');
    const factory = [...defaults.matchAll(/^([A-Za-z][A-Za-z0-9]*)\s*=/gmu)].map((match) => match[1]);
    const owners = new Map();
    for (const group of reset.RESET_GROUPS) {
        for (const key of group.keys) owners.set(key, [...(owners.get(key) ?? []), group.id]);
    }
    const missing = factory.filter((key) => !owners.has(key));
    const repeated = [...owners].filter(([, groups]) => groups.length > 1);
    const unknown = [...owners.keys()].filter((key) => !factory.includes(key));
    assert.deepEqual(missing, [], `preferencias sin apartado en «Restablecer»: ${missing.join(', ')}`);
    assert.deepEqual(repeated, [], 'cada preferencia, en un solo apartado');
    assert.deepEqual(unknown, [], `claves que no son preferencias: ${unknown.join(', ')}`);
    for (const tab of reset.RESET_TABS) {
        assert(reset.RESET_GROUPS.some((group) => group.tab === tab), `la pestaña ${tab} tiene apartados`);
    }
    assert.deepEqual(reset.keysForGroups(['aliases', 'aliases']), ['manualAliasesText']);
    assert(reset.keysForGroups(['store']).includes('toolchainStoreDir'), 'la carpeta propia va en su apartado');
    assert.deepEqual(reset.dangerousGroups(['theme', 'store', 'aliases']).map((group) => group.id), ['aliases', 'store']);
    assert.equal(reset.tabState('appearance', new Set()), 'none');
    assert.equal(reset.tabState('appearance', new Set(['theme'])), 'some');
    assert.equal(reset.tabState('appearance', new Set(['theme', 'customThemes', 'scale'])), 'all');
    const settingsPanel = await readFile('src/components/SettingsPanel.svelte', 'utf8');
    const dialog = await readFile('src/components/SettingsResetDialog.svelte', 'utf8');
    assert(!settingsPanel.includes('onclick={reset}') && settingsPanel.includes('<SettingsResetDialog'),
        '«Restablecer» abre el diálogo en vez de restablecer de golpe');
    assert(dialog.includes('disabled={!selected.length || busy}') && dialog.includes('onMount(() => cancelButton?.focus())'),
        'sin nada marcado no se confirma, y lo enfocado es «Cancelar»');
}

console.log(`Lógica frontend verificada: idioma, identidad y ${configuredShortcuts.length} atajos.`);
