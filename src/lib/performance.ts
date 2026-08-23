import * as api from './api';

export type PerformanceDetails = Record<string, unknown>;

const frontendStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
const onceKeys = new Set<string>();
const startPoints = new Map<string, number>();

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function rounded(value: number): number {
    return Math.round(Math.max(0, value) * 100) / 100;
}

export function sinceStartMs(): number {
    return rounded(now() - frontendStartedAt);
}

export function record(
    metric: string,
    kind: string,
    values: {
        durationMs?: number;
        status?: string;
        tabId?: string;
        details?: PerformanceDetails;
    } = {},
): void {
    void api.recordPerformance({
        metric,
        kind,
        sinceStartMs: sinceStartMs(),
        ...values,
    });
}

export function mark(metric: string, details: PerformanceDetails = {}): void {
    record(metric, 'landmark', { details });
}

export function markOnce(key: string, metric: string, details: PerformanceDetails = {}): void {
    if (onceKeys.has(key)) return;
    onceKeys.add(key);
    mark(metric, details);
}

/** Registra cuánto tardó una operación iniciada ahora. */
export function start(
    metric: string,
    details: PerformanceDetails = {},
): (status?: string, extra?: PerformanceDetails) => void {
    const startedAt = now();
    let finished = false;
    return (status = 'ok', extra = {}) => {
        if (finished) return;
        finished = true;
        record(metric, 'duration', {
            durationMs: rounded(now() - startedAt),
            status,
            details: { ...details, ...extra },
        });
    };
}

/** Registra el tiempo desde que se cargó el frontend hasta un hito visible. */
export function timeTo(
    metric: string,
    details: PerformanceDetails = {},
): void {
    record(metric, 'time-to', { durationMs: sinceStartMs(), details });
}

export function timeToOnce(key: string, metric: string, details: PerformanceDetails = {}): void {
    if (onceKeys.has(key)) return;
    onceKeys.add(key);
    timeTo(metric, details);
}

/** Guarda un punto de inicio local, útil para medir cada pestaña o descarga
 * aunque comience después del arranque global de la interfaz. */
export function startPoint(key: string): void {
    startPoints.set(key, now());
}

export function measureFrom(
    key: string,
    metric: string,
    details: PerformanceDetails = {},
    onceKey = key,
): void {
    if (onceKeys.has(onceKey)) return;
    const startedAt = startPoints.get(key);
    if (startedAt === undefined) return;
    onceKeys.add(onceKey);
    record(metric, 'duration', {
        durationMs: rounded(now() - startedAt),
        status: 'ok',
        details,
    });
}
