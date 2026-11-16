// Programas a pantalla completa dentro de una pestaña: las IA de terminal
// (Claude Code, Amp, Gemini, Codex, OpenCode…) y los clásicos (vim, htop,
// less). Dibujan para el ancho que anuncia la PTY, así que con la reserva de
// 1024 columnas de las shells pintaban fuera de la vista. Aquí se decide
// cuándo la pestaña debe usar el ancho visible (`TerminalPane.svelte`).
//
// La salida sincronizada (`ESC[?2026h`) NO sirve de señal: ConPTY envuelve
// en ella sus propios repintados, también los de una shell sin nada más.

/** Por qué la pestaña está en modo pantalla completa. */
export type FullScreenAppReason =
    /** La pestaña entera es una IA de terminal (`ai:claude`, `ai:amp`…). */
    | 'ai-environment'
    /** Se tecleó en la shell una IA conocida (`claude`, `amp`…). Muchas
     *  dibujan en línea (Ink) sin pantalla alternativa: termina cuando la
     *  shell vuelve a mostrar su prompt. */
    | 'ai-command'
    /** Un programa activó la pantalla alternativa (`ESC[?1049h`): Amp,
     *  OpenCode, vim, htop… Termina al volver a la normal. */
    | 'alternate-screen'
    /** La pestaña entera es el REPL de Python de Windows (`lang:python`).
     *  Con `pyreadline3` instalado (llega como dependencia de muchos paquetes
     *  en Windows), cada tecla redibuja la línea con la API de consola y borra
     *  el resto de la ventana; OpenConsole lo convierte en un repintado de
     *  todas las filas de abajo por las columnas de la PTY: 84 KB por tecla
     *  con las 1024 de la reserva, 16 KB con 120. Con la reserva el eco iba a
     *  2-3 letras por segundo. Se puede apagar (`pythonReplVisibleWidth`). */
    | 'python-environment'
    /** Se tecleó en una shell `python` o `py` sin script: el mismo REPL
     *  dentro de la pestaña. Termina cuando la shell vuelve a su prompt, como
     *  `ai-command`. */
    | 'python-command';

/** Motivos que mandan sobre la pantalla alternativa que el programa use por
 *  dentro: los fija la pestaña o la orden tecleada, no un DECSET. */
const OWNING_REASONS: ReadonlySet<FullScreenAppReason> = new Set([
    'ai-environment',
    'ai-command',
    'python-environment',
    'python-command',
]);

/** Órdenes tecleadas que terminan cuando la shell vuelve a su prompt. */
export function endsWithShellPrompt(reason: FullScreenAppReason | null): boolean {
    return reason === 'ai-command' || reason === 'python-command';
}

/** Columnas mínimas en este modo: menos no deja dibujar ni una caja. */
export const FULL_SCREEN_MIN_COLS = 20;

/** Tras teclear una IA, cuánto se espera antes de aceptar que el prompt que
 *  se ve es el de vuelta (y no la propia línea recién enviada). */
export const AI_COMMAND_MIN_MS = 1500;

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

/** Las CLI de IA del catálogo (`environments/ai.rs`, `windows_exe`). */
const AI_COMMANDS = new Set([
    'claude', 'gemini', 'codex', 'copilot', 'qwen', 'opencode', 'aider', 'amp',
    'crush', 'cn', 'grok', 'aichat', 'mods', 'llm', 'sgpt',
]);

export function isAiEnvironmentId(environmentId: string | null | undefined): boolean {
    return (environmentId ?? '').startsWith('ai:');
}

/** La IA de terminal que abre la orden enviada, o `null`: su primera
 *  palabra, sin comillas, ruta ni extensión (`claude`, `& 'C:\…\amp.cmd'`,
 *  `.\codex.exe`). Coincide con el id de su entorno (`ai:<nombre>`). */
export function aiCommandName(line: string | null | undefined): string | null {
    const text = (line ?? '').trim().replace(/^&\s*/u, '');
    const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(text);
    const word = first?.[1] ?? first?.[2] ?? first?.[3] ?? '';
    const name = word.split(/[\\/]/u).pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, '') ?? '';
    return AI_COMMANDS.has(name) ? name : null;
}

export function isAiCommandLine(line: string | null | undefined): boolean {
    return aiCommandName(line) !== null;
}

/** Cuándo debe una pestaña usar el ancho visible solo por su entorno. */
export interface EnvironmentWidthOptions {
    windows: boolean;
    /** `pythonReplVisibleWidth` de Ajustes. */
    pythonVisibleWidth: boolean;
}

/** El modo pantalla completa que impone el entorno de la pestaña, o `null`
 *  si es una shell normal (con la reserva horizontal). */
export function environmentFullScreenReason(
    environmentId: string | null | undefined,
    options: EnvironmentWidthOptions,
): FullScreenAppReason | null {
    if (isAiEnvironmentId(environmentId)) return 'ai-environment';
    if (options.windows && options.pythonVisibleWidth && environmentId === 'lang:python') return 'python-environment';
    return null;
}

const PYTHON_COMMANDS = /^(?:python(?:3(?:\.\d+)?)?|py)$/u;
/** Opciones de Python que llevan su valor en la palabra siguiente. */
const PYTHON_OPTIONS_WITH_VALUE = new Set(['-X', '-W', '-Q']);

/**
 * La orden abre el REPL interactivo de Python: `python`, `py -3.12`,
 * `python3 -q`, `python -i script.py`. No un script, `-c` ni `-m` (`python -m
 * pip install …`), que imprimen y vuelven a la shell.
 */
export function isInteractivePythonCommandLine(line: string | null | undefined): boolean {
    const text = (line ?? '').trim().replace(/^&\s*/u, '');
    const words = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
    const name = words[0]?.split(/[\\/]/u).pop()?.toLowerCase().replace(/\.exe$/u, '') ?? '';
    if (!PYTHON_COMMANDS.test(name)) return false;
    for (let index = 1; index < words.length; index += 1) {
        const word = words[index];
        if (word === '-i') return true;
        if (word === '-c' || word === '-m' || word === '-' || !word.startsWith('-')) return false;
        if (PYTHON_OPTIONS_WITH_VALUE.has(word)) index += 1;
    }
    return true;
}

/** Los parámetros de una secuencia CSI tal y como los entrega xterm
 *  (`(number | number[])[]`), aplanados. */
export function flattenCsiParams(params: ReadonlyArray<number | ReadonlyArray<number>>): number[] {
    return params.flatMap((param) => (typeof param === 'number' ? [param] : [...param]));
}

/**
 * El estado tras un DECSET (`set = true`, `ESC[?…h`) o DECRST (`ESC[?…l`).
 * Devuelve `undefined` si la secuencia no cambia nada. Una IA o Python
 * (pestaña u orden tecleada) manda sobre la pantalla alternativa que use por
 * dentro.
 */
export function fullScreenTransition(
    current: FullScreenAppReason | null,
    params: ReadonlyArray<number>,
    set: boolean,
): FullScreenAppReason | null | undefined {
    if (current !== null && OWNING_REASONS.has(current)) return undefined;
    if (!params.some((mode) => ALTERNATE_SCREEN_MODES.has(mode))) return undefined;
    if (set && current !== 'alternate-screen') return 'alternate-screen';
    if (!set && current === 'alternate-screen') return null;
    return undefined;
}
