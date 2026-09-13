export interface RetryUntilReadyOptions {
    intervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    wait?: (delayMs: number) => Promise<void>;
    shouldContinue?: () => boolean;
}

/** Reintenta una comprobación asíncrona con límite y sin bloquear el hilo UI. */
export async function retryUntilReady(
    checkReady: () => Promise<boolean>,
    options: RetryUntilReadyOptions = {},
): Promise<boolean> {
    const intervalMs = Math.max(1, options.intervalMs ?? 200);
    const timeoutMs = Math.max(0, options.timeoutMs ?? 35_000);
    const now = options.now ?? (() => Date.now());
    const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const shouldContinue = options.shouldContinue ?? (() => true);
    const deadline = now() + timeoutMs;

    while (shouldContinue()) {
        if (await checkReady()) return true;
        const remainingMs = deadline - now();
        if (remainingMs <= 0) return false;
        await wait(Math.min(intervalMs, remainingMs));
    }
    return false;
}
