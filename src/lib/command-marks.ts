// Marcas OSC 133: dónde empieza cada orden, dónde acaba su salida y cómo terminó.
//
// La shell escribe `A` al empezar el prompt, `B` al acabarlo, `C` cuando la
// orden empieza a correr y `D;código` cuando termina. Las marcas se leen dentro
// de xterm porque así caen en la fila exacta: el evento del backend llega por
// otro canal y su posición en el búfer ya no se puede saber.
//
// Una shell que no las emite no hace pasar nada por aquí y la terminal se
// comporta igual que siempre. El módulo es puro (solo importa tipos) para
// poder probarlo en Node con `scripts/test-frontend-logic.mjs`.

/** Lo que usa de un `IMarker` de xterm: se mueve solo al entrar más salida. */
export interface LineMark {
    readonly line: number;
}

export interface CommandRecord {
    prompt: LineMark;
    input: LineMark | null;
    /** Columna donde empieza lo escrito, en la fila de `input`. */
    inputColumn: number;
    output: LineMark | null;
    end: LineMark | null;
    exitCode: number | null;
    startedAt: number | null;
    durationMs: number | null;
}

/** Suficiente para saltar por una sesión larga sin retener marcas sin fin. */
const MAX_RECORDS = 500;

const markIsLive = (mark: LineMark | null): mark is LineMark => mark !== null && mark.line >= 0;

export function parseExitCode(payload: string | undefined): number | null {
    const code = Number.parseInt((payload ?? '').split(';')[0] ?? '', 10);
    return Number.isNaN(code) ? null : code;
}

export class CommandTracker {
    private records: CommandRecord[] = [];
    private current: CommandRecord | null = null;

    /** `createMark` recibe cuántas filas por debajo del cursor va la marca. */
    constructor(
        private readonly createMark: (offset: number) => LineMark | undefined,
        private readonly now: () => number,
    ) {}

    /** Hay un prompt esperando una orden. */
    get atPrompt(): boolean {
        return this.current !== null && this.current.input !== null && this.current.startedAt === null;
    }

    get inputLine(): { line: number; column: number } | null {
        const input = this.current?.input ?? null;
        return markIsLive(input) ? { line: input.line, column: this.current?.inputColumn ?? 0 } : null;
    }

    /** Devuelve la orden que acaba de terminar, si `D` cerró una de verdad. */
    mark(data: string, cursorColumn: number): CommandRecord | null {
        const [kind, ...rest] = data.split(';');
        if (kind === 'A') {
            const mark = this.createMark(0);
            if (mark) this.current = { prompt: mark, input: null, inputColumn: 0, output: null, end: null, exitCode: null, startedAt: null, durationMs: null };
        } else if (kind === 'B' && this.current) {
            this.current.input = this.createMark(0) ?? null;
            this.current.inputColumn = cursorColumn;
        } else if (kind === 'C' && this.current) {
            this.current.output = this.createMark(0) ?? null;
            this.current.startedAt ??= this.now();
        } else if (kind === 'D') {
            return this.finish(parseExitCode(rest.join(';')), cursorColumn);
        }
        return null;
    }

    /** Intro sobre el prompt. Las shells sin `C` (PowerShell) cuentan el tiempo
     *  desde aquí. Una línea en blanco no es una orden: `D` repetiría el código
     *  de la anterior y marcaría como fallido un Intro vacío. */
    submitted(blank: boolean): void {
        if (!this.atPrompt || !this.current) return;
        if (blank) {
            this.current = null;
            return;
        }
        this.current.startedAt = this.now();
    }

    private finish(exitCode: number | null, cursorColumn: number): CommandRecord | null {
        const record = this.current;
        this.current = null;
        if (!record || record.startedAt === null) return null;
        // Una salida sin salto de línea final deja el cursor en su última fila.
        record.end = this.createMark(cursorColumn > 0 ? 1 : 0) ?? null;
        record.exitCode = exitCode;
        record.durationMs = Math.max(0, this.now() - record.startedAt);
        this.records.push(record);
        if (this.records.length > MAX_RECORDS) this.records.shift();
        return record;
    }

    /** Las órdenes que siguen en el búfer: las demás se fueron del historial. */
    private live(): CommandRecord[] {
        return this.records.filter((record) => markIsLive(record.prompt));
    }

    lastFinished(): CommandRecord | null {
        return this.live().at(-1) ?? null;
    }

    /** La fila del prompt anterior o siguiente a `fromLine`. */
    jumpTarget(fromLine: number, direction: 'previous' | 'next'): number | null {
        const lines = this.live().map((record) => record.prompt.line);
        if (direction === 'previous') return lines.filter((line) => line < fromLine).at(-1) ?? null;
        return lines.find((line) => line > fromLine) ?? null;
    }

    clear(): void {
        this.records = [];
        this.current = null;
    }
}

/** Filas `[inicio, fin]` de la salida, o null si la orden no escribió nada.
 *  Sin marca `C`, la salida empieza tras la última fila de la línea escrita. */
export function outputRange(record: CommandRecord, isWrapped: (line: number) => boolean): [number, number] | null {
    if (!markIsLive(record.end)) return null;
    let start: number;
    if (markIsLive(record.output)) {
        start = record.output.line;
    } else if (markIsLive(record.input)) {
        start = record.input.line;
        while (isWrapped(start + 1)) start += 1;
        start += 1;
    } else {
        return null;
    }
    const end = record.end.line - 1;
    return end >= start ? [start, end] : null;
}

/** «820 ms», «4,2 s» o «3 min 12 s», con el separador decimal del idioma. */
export function formatDuration(durationMs: number, locale?: string): string {
    if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
    const seconds = durationMs / 1000;
    if (seconds < 60) return `${seconds.toLocaleString(locale, { maximumFractionDigits: 1 })} s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}
