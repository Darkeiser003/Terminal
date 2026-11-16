// Lógica pura del chat lateral con los agentes (sin Svelte ni Tauri): partir
// la respuesta en texto y bloques de código y quitar los colores ANSI. Se
// prueba en Node con `scripts/test-frontend-logic.mjs`.

export type AnswerPart = { kind: 'text' | 'code'; text: string; lang?: string };

/** Quita las secuencias de escape ANSI (colores, cursor) que alguna CLI
 *  escribe aunque se le pida `NO_COLOR`. */
export function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/gu, '');
}

/** Lo que sustituye a un secreto en el contexto que se manda al agente. */
export const REDACTED = '«oculto»';

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    // Bloques de clave privada (SSH, PEM).
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
    // Claves de API con prefijo conocido: OpenAI, Anthropic, xAI, GitHub,
    // GitLab, Slack, AWS, Google.
    /\b(?:sk-ant-|sk-proj-|sk-|xai-|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_-]{12,}/gu,
    /\bAKIA[0-9A-Z]{16}\b/gu,
    /\bAIza[0-9A-Za-z_-]{30,}/gu,
    // JWT y cabeceras Bearer.
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/giu,
];

/** `clave=valor` con un nombre que suena a secreto: se oculta el valor. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|passwo?r?d|pwd)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/giu;

/** Quita del texto los secretos que se reconocen antes de mandarlo a un
 *  agente: claves de API, tokens, claves privadas y `password=…`. Devuelve
 *  cuántos ocultó para avisar al usuario. */
export function redactSecrets(text: string): { text: string; count: number } {
    let count = 0;
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, () => {
            count += 1;
            return REDACTED;
        });
    }
    result = result.replace(SECRET_ASSIGNMENT, (match, name: string, separator: string, value: string) => {
        if (value === REDACTED) return match;
        count += 1;
        return `${name}${separator}${REDACTED}`;
    });
    return { text: result, count };
}

/** Parte una respuesta en Markdown en trozos de texto y bloques ```código```.
 *  Un bloque sin cerrar (la respuesta sigue llegando) cuenta como código. */
export function splitAgentAnswer(answer: string): AnswerPart[] {
    const parts: AnswerPart[] = [];
    const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/gu;
    let last = 0;
    for (const match of answer.matchAll(fence)) {
        const start = match.index ?? 0;
        const before = answer.slice(last, start).trim();
        if (before) parts.push({ kind: 'text', text: before });
        const code = (match[2] ?? '').replace(/\n$/u, '');
        const lang = (match[1] ?? '').trim().split(/\s+/u)[0] ?? '';
        if (code.trim()) parts.push(lang ? { kind: 'code', text: code, lang } : { kind: 'code', text: code });
        last = start + match[0].length;
    }
    const rest = answer.slice(last).trim();
    if (rest) parts.push({ kind: 'text', text: rest });
    return parts;
}

// ---- Markdown sencillo para el texto de las respuestas (13-11) ----
//
// Sin HTML: el panel pinta cada trozo con sus propios elementos, así que nada
// de lo que conteste un agente se interpreta como marcado.

export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code'; text: string };
export type TextBlock =
    | { kind: 'heading'; level: number; inlines: Inline[] }
    | { kind: 'list'; ordered: boolean; items: Inline[][] }
    | { kind: 'quote'; inlines: Inline[] }
    | { kind: 'paragraph'; inlines: Inline[] };

/** `**negrita**`, `*cursiva*`/`_cursiva_` y `` `código` ``. Lo demás, texto. */
export function parseInlines(text: string): Inline[] {
    const out: Inline[] = [];
    const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])/gu;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
        if (match[1] !== undefined) out.push({ kind: 'code', text: match[1] });
        else if (match[2] !== undefined) out.push({ kind: 'bold', text: match[2] });
        else if (match[3] !== undefined) out.push({ kind: 'bold', text: match[3] });
        else out.push({ kind: 'italic', text: match[4] ?? match[5] ?? '' });
        last = start + match[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
}

/** Títulos (`#`), listas (`-`, `*`, `1.`), citas (`>`) y párrafos. Las líneas
 *  seguidas de un párrafo se unen con un salto de línea. */
export function parseTextBlocks(text: string): TextBlock[] {
    const blocks: TextBlock[] = [];
    let paragraph: string[] = [];
    // Con `as`: si no, TypeScript lo da por `null` para siempre (lo cambian
    // las funciones de dentro, que no ve).
    let list = null as { ordered: boolean; items: string[] } | null;
    const flushParagraph = () => {
        if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: parseInlines(paragraph.join('\n')) });
        paragraph = [];
    };
    const flushList = () => {
        if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInlines) });
        list = null;
    };
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
        const bullet = /^\s*[-*•]\s+(.*)$/u.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
        const quote = /^>\s?(.*)$/u.exec(line);
        if (!line.trim()) {
            flushParagraph();
            flushList();
        } else if (heading) {
            flushParagraph();
            flushList();
            blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInlines(heading[2]) });
        } else if (bullet || numbered) {
            flushParagraph();
            const ordered = Boolean(numbered);
            if (list && list.ordered !== ordered) flushList();
            list ??= { ordered, items: [] };
            list.items.push((bullet ?? numbered)?.[1] ?? '');
        } else if (quote) {
            flushParagraph();
            flushList();
            blocks.push({ kind: 'quote', inlines: parseInlines(quote[1]) });
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    flushParagraph();
    flushList();
    return blocks;
}

// ---- La pregunta que se manda (13-11) ----

export type ChatTurn = { question: string; answer: string };
export type ChatAttachmentText = { name: string; text: string; truncated: boolean };

/** Lo que va en la pregunta para que el agente recuerde la conversación:
 *  las últimas `maxTurns` vueltas y, como mucho, `maxChars` caracteres
 *  (se quitan primero las más viejas). */
export function conversationTranscript(
    history: ChatTurn[],
    labels: { you: string; agent: string },
    { maxTurns = 6, maxChars = 24_000 } = {},
): string {
    const turns = history.filter((turn) => turn.answer.trim()).slice(-maxTurns);
    const render = (turn: ChatTurn) => `${labels.you}: ${turn.question.trim()}\n${labels.agent}: ${turn.answer.trim()}`;
    while (turns.length && turns.map(render).join('\n\n').length > maxChars) turns.shift();
    return turns.map(render).join('\n\n');
}

/** Qué modelo enseñar junto a una respuesta (16-11): el que dice la CLI
 *  (Codex lo escribe al empezar), el elegido en el panel o, sin elegir,
 *  «por defecto». Ollama lleva el modelo en el nombre del agente: nada. */
export function answerModel(
    reported: string | null | undefined,
    ask: { agentId: string; model: string } | null | undefined,
): { kind: 'reported' | 'chosen' | 'default'; name: string } | null {
    if (reported?.trim()) return { kind: 'reported', name: reported.trim() };
    if (!ask) return null;
    if (ask.model.trim()) return { kind: 'chosen', name: ask.model.trim() };
    if (ask.agentId.startsWith('ai:ollama')) return null;
    return { kind: 'default', name: '' };
}

/** La línea que explica un fallo, sacada de la salida de error entera (14-11,
 *  Romen: el muro rojo de Gemini o de Codex no se entendía). La primera que
 *  suena a error; si no hay, la última con texto. Sin pilas de llamadas
 *  (`at …`), avisos ni líneas de solo símbolos, y con 200 caracteres como
 *  mucho. */
export function errorHeadline(output: string): string {
    const lines = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /[\p{L}\p{N}]/u.test(line) && !/^at\s/u.test(line) && !/^warning\b/iu.test(line)
            // «ERROR» a secas (Crush) no explica nada: vale la línea siguiente.
            && !/^(?:error|fatal)\s*[:!]?$/iu.test(line));
    const pattern = /\b(error|failed|fail|unauthori[sz]ed|not (?:found|logged|configured|supported|running)|no longer supported|no (?:\w+ )?(?:found|configured|selected)|missing|denied|invalid|unsupported|traceback)\b/iu;
    // Un objeto JSON con su `message` (Continue, 15-11:
    // `{"status":"error","message":"The request failed…"}`): vale el mensaje.
    const jsonMessage = lines.map((item) => {
        if (!item.startsWith('{')) return '';
        try {
            const parsed = JSON.parse(item) as { message?: unknown; error?: { message?: unknown } };
            const message = parsed.message ?? parsed.error?.message;
            return typeof message === 'string' ? message : '';
        } catch {
            return '';
        }
    }).find(Boolean);
    // «… ModelNotFoundError: This model … is no longer available …» (Gemini,
    // 15-11): el mensaje del error con nombre explica más que la línea entera,
    // que empieza por una ruta de un informe. No si lo que sigue es JSON.
    const namedError = lines.map((item) => /\b[A-Z]\w*Error:\s+([^{\s].*)$/u.exec(item)?.[1] ?? '').find(Boolean);
    const line = jsonMessage ?? namedError ?? lines.find((item) => pattern.test(item)) ?? lines.at(-1) ?? '';
    const clean = line
        .replace(/^(?:error|fatal)\s*[:!-]\s*/iu, '')
        // Un campo de un objeto impreso por node: `reasonMessage: '…',`.
        .replace(/^[A-Za-z_]+:\s*['"]/u, '')
        .replace(/['"],?$/u, '')
        .trim();
    return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/** Cómo se dice el tamaño de un adjunto: «812 B», «3,4 KB», «1,2 MB». */
export function formatBytes(bytes: number, locale?: string): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toLocaleString(locale, { maximumFractionDigits: 1 })} KB`;
    return `${(kb / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
}

/** Monta la pregunta: la conversación anterior (si se recuerda), los adjuntos
 *  como bloques de texto, la pregunta y, al final, el contexto de la terminal.
 *  Los rótulos llegan traducidos. */
export function buildChatPrompt(parts: {
    question: string;
    transcript?: string;
    attachments?: ChatAttachmentText[];
    context?: string | null;
    labels: { conversation: string; attachment: string; truncated: string; question: string };
}): string {
    const sections: string[] = [];
    if (parts.transcript?.trim()) sections.push(`${parts.labels.conversation}\n${parts.transcript.trim()}`);
    for (const file of parts.attachments ?? []) {
        // Una valla más larga que cualquier ``` del archivo: el bloque no se
        // corta aunque el adjunto sea un Markdown con código.
        const longest = Math.max(2, ...[...file.text.matchAll(/`+/gu)].map((run) => run[0].length));
        const fenceMark = '`'.repeat(longest + 1);
        const note = file.truncated ? ` (${parts.labels.truncated})` : '';
        sections.push(`${parts.labels.attachment.replace('{name}', file.name)}${note}\n${fenceMark}\n${file.text.replace(/\s+$/u, '')}\n${fenceMark}`);
    }
    const hasExtra = sections.length > 0 || Boolean(parts.context);
    sections.push(hasExtra ? `${parts.labels.question}\n${parts.question.trim()}` : parts.question.trim());
    if (parts.context) sections.push(`---\n${parts.context}`);
    return sections.join('\n\n');
}
