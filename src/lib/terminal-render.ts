export interface TerminalRefreshTarget {
    readonly rows: number;
    readonly element?: { readonly isConnected: boolean } | null;
    refresh(start: number, end: number): void;
}

type RefreshCompletion = () => void;
type FrameScheduler = (callback: () => void) => unknown;

/** Agrupa los repintados solicitados durante un frame y refresca las filas
 * visibles, sin invalidar el atlas ni alterar el scroll del usuario. La
 * finalización se anuncia en el frame siguiente, dando tiempo al renderer
 * canvas para presentar la imagen solicitada. */
export function createTerminalRefreshScheduler(
    requestFrame: FrameScheduler,
    onError: (error: unknown) => void = () => {},
): (terminal: TerminalRefreshTarget, afterRefresh?: RefreshCompletion) => boolean {
    const pending = new WeakMap<TerminalRefreshTarget, RefreshCompletion[]>();

    return (terminal, afterRefresh) => {
        const existing = pending.get(terminal);
        if (existing) {
            if (afterRefresh) existing.push(afterRefresh);
            return false;
        }

        pending.set(terminal, afterRefresh ? [afterRefresh] : []);
        try {
            requestFrame(() => {
                const completions = pending.get(terminal);
                if (!completions) return;
                pending.delete(terminal);

                const rows = terminal.rows;
                if (!terminal.element?.isConnected || !Number.isInteger(rows) || rows < 1) return;

                try {
                    terminal.refresh(0, rows - 1);
                } catch (error) {
                    onError(error);
                    return;
                }

                try {
                    requestFrame(() => {
                        if (!terminal.element?.isConnected) return;
                        for (const complete of completions) {
                            try {
                                complete();
                            } catch (error) {
                                onError(error);
                            }
                        }
                    });
                } catch (error) {
                    onError(error);
                }
            });
        } catch (error) {
            pending.delete(terminal);
            onError(error);
            return false;
        }

        return true;
    };
}
