// Enlaces de la salida de la terminal: qué se subraya, con qué gesto se abre y
// qué se enseña antes de abrir. Abrir lo decide siempre el backend
// (`terminal_open_link` en `src-tauri/src/terminal/links.rs`), que vuelve a
// validar el texto: esta comprobación solo evita pedir confirmación para algo
// que de todos modos se rechazaría y prepara lo que muestra el diálogo.

/** Esquemas que puede abrir un enlace; los mismos que `ALLOWED_SCHEMES` en Rust. */
export const TERMINAL_LINK_SCHEMES = ['http:', 'https:', 'file:'] as const;
export type TerminalLinkScheme = (typeof TERMINAL_LINK_SCHEMES)[number];

/** Igual que `MAX_LINK_LENGTH` en Rust. */
export const MAX_TERMINAL_LINK_LENGTH = 2048;

/**
 * URL explícitas `http://`, `https://` y `file://`. Es la expresión estricta de
 * `@xterm/addon-web-links` (hasta el primer espacio o comilla, sin la
 * puntuación ni los paréntesis finales) ampliada a `file:`. Las rutas sueltas
 * (`C:\…`, `/home/…`) no se detectan: el prompt de cmd o PowerShell es una
 * ruta y quedaría subrayado en cada línea.
 */
export const TERMINAL_LINK_REGEX = /(?:https?|file):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/i;

/** Caracteres que harían que el texto mostrado no fuera el que se abre:
 *  controles, espacios y marcas invisibles (bidi, anchos cero, guion blando). */
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\s\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/** Solo Ctrl + botón principal abre un enlace; un clic normal sigue siendo
 *  un clic de la terminal (foco, selección). */
export function isLinkActivation(event: Pick<MouseEvent, 'ctrlKey' | 'button'>): boolean {
    return event.ctrlKey === true && event.button === 0;
}

export type TerminalLinkRejection =
    | 'empty'
    | 'too-long'
    | 'hidden-characters'
    | 'malformed'
    | 'scheme'
    | 'missing-host'
    | 'credentials';

export type TerminalLinkCheck =
    | {
        ok: true;
        /** URL normalizada (dominios internacionales en punycode): lo que se abre. */
        url: string;
        scheme: TerminalLinkScheme;
        /** Host que se enseña aparte en la confirmación; vacío en `file:` local. */
        host: string;
    }
    | { ok: false; reason: TerminalLinkRejection };

/** Comprobación previa, espejo de `validate_link` sin la parte del disco. */
export function checkTerminalLink(text: string): TerminalLinkCheck {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, reason: 'empty' };
    if (raw.length > MAX_TERMINAL_LINK_LENGTH) return { ok: false, reason: 'too-long' };
    // `new URL` quita tabuladores y saltos en mitad del texto: se rechazan
    // antes, o `exa\nmple.com` abriría `example.com`.
    if (HIDDEN_CHARACTERS.test(raw)) return { ok: false, reason: 'hidden-characters' };
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const scheme = url.protocol.toLowerCase();
    if (!(TERMINAL_LINK_SCHEMES as readonly string[]).includes(scheme)) {
        return { ok: false, reason: 'scheme' };
    }
    if (scheme !== 'file:') {
        if (!url.hostname) return { ok: false, reason: 'missing-host' };
        if (url.password) return { ok: false, reason: 'credentials' };
    }
    return { ok: true, url: url.href, scheme: scheme as TerminalLinkScheme, host: url.host };
}

/** Clave de traducción del aviso para un rechazo (del frontend o del backend). */
export function linkRejectionMessageKey(code: string): 'terminal.linkBlockedScheme' | 'terminal.linkBlockedFile' | 'terminal.linkOpenFailed' | 'terminal.linkBlockedUnsafe' | null {
    if (code === 'disabled') return null;
    if (code === 'scheme') return 'terminal.linkBlockedScheme';
    if (code === 'remote-file' || code === 'not-local-path' || code === 'not-found') return 'terminal.linkBlockedFile';
    if (code === 'open-failed') return 'terminal.linkOpenFailed';
    return 'terminal.linkBlockedUnsafe';
}
