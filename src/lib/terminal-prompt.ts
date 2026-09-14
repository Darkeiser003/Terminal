/**
 * Interactive REPLs may use prompts that do not end in the usual `>`, `$` or
 * `#`. Recognize their documented/default prompt shapes so startup readiness
 * does not keep input locked until the safety timeout.
 */
export function interactiveReplPromptIsVisible(text: string, environmentId?: string | null): boolean {
    const languageId = String(environmentId ?? '').replace(/^lang:/u, '');
    const clean = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '');
    const lines = clean.split('\n').map((line) => line.trim());

    const specialReplPrompts: Record<string, RegExp> = {
        // tclsh usa el prompt mínimo `%`, sin un terminador tipo `>`/`$`.
        tcl: /^%(?:\s.*)?$/u,
        // Maxima numera la entrada y SBCL usa `*` como prompt predeterminado.
        maxima: /^\(%[io]\d+\)\s?.*$/u,
        // La CLI de DuckDB termina el prompt predeterminado con ` D`.
        duckdb: /^.+\sD(?:\s.*)?$/u,
        'common-lisp-sbcl': /^\*{1,4}(?:\s.*)?$/u,
        // Los prompts Prolog y gforth tampoco terminan en los marcadores de
        // shell habituales; restringirlos al REPL correspondiente evita falsos positivos.
        'swi-prolog': /^(?:\d+\s+)?(?:\?-|\|\s*\?-)(?:\s.*)?$/u,
        forth: /^ok(?:\s.*)?$/iu,
    };
    const specialPrompt = specialReplPrompts[languageId];
    if (specialPrompt) return lines.some((line) => specialPrompt.test(line));

    if (languageId !== 'nu' && languageId !== 'xonsh' && languageId !== 'elvish') return false;

    if (languageId === 'nu') {
        const prompt = /^(?:~|\/[^<>]*|[A-Za-z]:\\[^<>]*)>/u;
        return lines.some((line) => prompt.test(line));
    }

    if (languageId === 'elvish') {
        // Elvish shows the current directory with `>` and may render its
        // user/host right prompt at the far end of the same terminal row.
        const prompt = /^(?:~|\/[^<>]*|[A-Za-z]:\\[^<>]*)>(?:\s+.+)?$/u;
        return lines.some((line) => prompt.test(line));
    }

    // Without prompt_toolkit, xonsh's fallback prompt is `~ <random tagline> ~`.
    // Its normal prompt ends in `@` (or `@#` for root), with either a path or
    // user@host before it. Limit these shapes to xonsh; `@` is not a generic
    // shell prompt terminator.
    return lines.some((line) => (
        /^~\s+[^~<>]{1,100}\s+~$/u.test(line)
        || /^[^\s@]+@[^\s@]+(?:\s+.+)?\s+@#?$/u.test(line)
        || /^(?:~|\/\S+|[A-Za-z]:\\\S+)(?:\s+.+)?\s+@#?$/u.test(line)
    ));
}

/** Gforth intentionally shows no prompt before its first line; its boot banner means ready. */
export function interactiveReplBannerSignalsReady(text: string, environmentId?: string | null): boolean {
    const languageId = String(environmentId ?? '').replace(/^lang:/u, '');
    if (languageId !== 'forth') return false;
    return /\bType `bye` to exit\b/u.test(String(text ?? ''));
}

/** Return the editable input after a REPL-specific prompt, or null if unknown. */
export function interactiveReplInputLine(text: string, environmentId?: string | null): string | null {
    const languageId = String(environmentId ?? '').replace(/^lang:/u, '');
    const promptPrefixes: Record<string, RegExp> = {
        tcl: /^%\s?/u,
        maxima: /^\(%[io]\d+\)\s?/u,
        duckdb: /^.+?\sD\s?/u,
        'common-lisp-sbcl': /^\*{1,4}\s?/u,
        'swi-prolog': /^(?:\d+\s+)?(?:\?-|\|\s*\?-)\s?/u,
        forth: /^ok(?:\s+|$)/iu,
    };
    const prefix = promptPrefixes[languageId]?.exec(String(text ?? ''));
    return prefix ? String(text).slice(prefix[0].length).trimStart() : null;
}
