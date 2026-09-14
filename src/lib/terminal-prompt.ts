/**
 * Interactive REPLs may use prompts that do not end in the usual `>`, `$` or
 * `#`. Recognize their documented/default prompt shapes so startup readiness
 * does not keep input locked until the safety timeout.
 */
export function interactiveReplPromptIsVisible(text: string, environmentId?: string | null): boolean {
    if (environmentId !== 'nu' && environmentId !== 'xonsh') return false;
    const clean = String(text ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[78]/g, '')
        .replace(/\r/g, '');
    const lines = clean.split('\n').map((line) => line.trim());

    if (environmentId === 'nu') {
        const prompt = /^(?:~|\/[^<>]*|[A-Za-z]:\\[^<>]*)>/u;
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
