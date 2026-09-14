export function containsExactHttpsUrl(text, expectedUrl) {
    let expected;
    try {
        expected = new URL(expectedUrl);
    } catch {
        return false;
    }
    if (expected.protocol !== 'https:' || expected.href !== expectedUrl) return false;

    const candidates = String(text ?? '').match(/https:\/\/[^\s<>"'`]+/g) ?? [];
    return candidates.some((candidate) => {
        try {
            const parsed = new URL(candidate);
            return parsed.protocol === 'https:'
                && parsed.href === expected.href
                && candidate === parsed.href;
        } catch {
            return false;
        }
    });
}
