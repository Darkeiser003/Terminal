// Historial de los chats con IA (23-11, Romen: «los chats de IA no tienen
// historial ni nada, como sí tiene Claude o ChatGPT […] si cierro la pestaña,
// aunque sea un segundo, se borra»). Lógica pura, sin Svelte ni Tauri: qué
// se guarda de cada conversación, su título, la búsqueda y los grupos por
// fecha de la lista. Se prueba en Node con `scripts/test-frontend-logic.mjs`.
// El backend (`environments/agent_chat_history.rs`) solo lo escribe en disco.

/** Un mensaje tal como se guarda: sin borradores de clave ni ayudas, que
 *  dependen del momento. */
export type StoredMessage = {
    role: 'user' | 'agent';
    agent: string;
    text: string;
    error: string | null;
    errorDetail?: string;
    context?: string | null;
    attachments?: { name: string; bytes: number; truncated: boolean }[];
    ask?: { agentId: string; prompt: string; question: string; model: string; effort: string; mode: string; fast: boolean; fullPrompt?: string; session?: NativeSession | null };
    startedAt?: number;
    finishedAt?: number;
    reportedModel?: string;
    /** La pregunta retomó la sesión propia del agente (24-11). */
    resumed?: boolean;
};

export type StoredChat = {
    version: 1;
    id: string;
    title: string;
    /** El título lo puso el usuario: ya no se cambia solo. */
    titleEdited?: boolean;
    agentId: string;
    agentLabel: string;
    createdAt: number;
    updatedAt: number;
    messages: StoredMessage[];
    /** La sesión propia del agente que ya conoce esta conversación (24-11). */
    native?: NativeLink;
    /** Es el chat de ayuda (24-11): ahí van las preguntas del aviso de
     *  ayuda con IA cuando falla una orden. */
    help?: boolean;
};

/** La sesión propia de Claude Code o Codex para una pregunta: `resume`,
 *  retomarla; si no, empezarla (Codex elige su id y lo dice al empezar). */
export type NativeSession = { id: string; resume: boolean };

/** Qué sesión del agente conoce la conversación y hasta qué mensaje: solo se
 *  retoma si nada se añadió después (otro agente, un fallo…). */
export type NativeLink = { agentId: string; id: string; covers: number };

/** Lo que lista el historial sin cargar cada conversación. */
export type AgentChatSummary = {
    id: string;
    title: string;
    agent: string;
    createdAt: number;
    updatedAt: number;
    messages: number;
    help?: boolean;
    /** Fijado arriba del historial (24-11). */
    pinned?: boolean;
};

/** Los chats abiertos en el panel y el que se veía. */
export type ChatSession = { open: string[]; active: string | null };

/** Lo que tiene un mensaje en el panel (lo que se guarda y algo más). */
export type LiveMessage = StoredMessage & { pending: boolean };

/** Ids cortos y válidos como nombre de archivo: `c-<fecha base36>-<azar>`. */
export function newChatId(now = Date.now(), random: () => number = Math.random): string {
    const noise = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    return `c-${now.toString(36)}-${noise}`;
}

/** El título automático: la primera línea de la primera pregunta, sin
 *  espacios de más y cortada a `max` caracteres con «…». */
export function autoTitle(question: string, max = 60): string {
    const line = question.split(/\r?\n/u).map((item) => item.trim()).find(Boolean) ?? '';
    const flat = line.replace(/\s+/gu, ' ');
    if (flat.length <= max) return flat;
    return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Lo que se guarda de una conversación. Una respuesta que seguía llegando
 * (la app se cerró o se cerró el chat) queda como cortada, con lo que
 * hubiera llegado; `interrupted` es el texto de ese aviso.
 */
export function toStoredMessages(messages: LiveMessage[], interrupted: string, now = Date.now()): StoredMessage[] {
    return messages.map((message) => {
        const stored: StoredMessage = {
            role: message.role,
            agent: message.agent,
            text: message.text,
            error: message.pending ? interrupted : message.error,
        };
        if (message.errorDetail) stored.errorDetail = message.errorDetail;
        if (message.context) stored.context = message.context;
        if (message.attachments?.length) stored.attachments = message.attachments.map(({ name, bytes, truncated }) => ({ name, bytes, truncated }));
        if (message.ask) {
            // Lo guardado repite la pregunta entera: la sesión puede no estar
            // ya cuando se vuelva a abrir.
            const { fullPrompt, session: _session, ...ask } = message.ask;
            stored.ask = { ...ask, prompt: fullPrompt ?? ask.prompt };
        }
        if (message.startedAt) stored.startedAt = message.startedAt;
        if (message.pending) stored.finishedAt = now;
        else if (message.finishedAt) stored.finishedAt = message.finishedAt;
        if (message.reportedModel) stored.reportedModel = message.reportedModel;
        if (message.resumed) stored.resumed = true;
        return stored;
    });
}

/** ¿Se puede retomar la sesión propia? Del mismo agente y sin nada añadido
 *  desde la última respuesta que la usó (`count`: mensajes antes de la
 *  pregunta nueva). */
export function canResumeNative(link: NativeLink | null | undefined, agentId: string, count: number): boolean {
    return Boolean(link && link.id && link.agentId === agentId && link.covers === count);
}

/** La sesión que queda tras una respuesta buena: la retomada, la que dijo la
 *  CLI (Codex) o la que se le dio (Claude Code). `null` si no se sabe. */
export function nativeAfterAnswer(
    session: NativeSession | null | undefined,
    reported: string | null | undefined,
    agentId: string,
    count: number,
): NativeLink | null {
    if (!session) return null;
    const id = session.resume ? session.id : (reported || (agentId === 'ai:claude' ? session.id : ''));
    return id ? { agentId, id, covers: count } : null;
}

/** El chat de ayuda guardado al que volver: el más reciente (la lista ya
 *  viene de más nuevo a más viejo). */
export function latestHelpChat(summaries: AgentChatSummary[]): AgentChatSummary | null {
    return summaries.find((summary) => summary.help === true) ?? null;
}

/** Para comparar sin tildes ni mayúsculas («codigo» encuentra «Código»). */
export function foldText(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Los chats cuyo título o agente contienen todas las palabras buscadas. */
export function searchChats<T extends { title: string; agent: string }>(chats: T[], query: string): T[] {
    const words = foldText(query).split(/\s+/u).filter(Boolean);
    if (!words.length) return chats;
    return chats.filter((chat) => {
        const haystack = foldText(`${chat.title} ${chat.agent}`);
        return words.every((word) => haystack.includes(word));
    });
}

export type DateGroup = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

/** El grupo de fecha de la lista, como en los chats de Claude o ChatGPT. */
export function dateGroup(time: number, now = Date.now()): DateGroup {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const start = today.getTime();
    const day = 24 * 60 * 60 * 1000;
    if (time >= start) return 'today';
    if (time >= start - day) return 'yesterday';
    if (time >= start - 6 * day) return 'week';
    if (time >= start - 29 * day) return 'month';
    return 'older';
}

/** La lista agrupada por fecha, en orden y sin grupos vacíos. Los fijados
 *  van primero, en su propio grupo (24-11). */
export function groupChatsByDate<T extends { updatedAt: number; pinned?: boolean }>(chats: T[], now = Date.now()): { group: DateGroup; chats: T[] }[] {
    const order: DateGroup[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older'];
    const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
    const groupOf = (chat: T): DateGroup => (chat.pinned ? 'pinned' : dateGroup(chat.updatedAt, now));
    return order
        .map((group) => ({ group, chats: sorted.filter((chat) => groupOf(chat) === group) }))
        .filter((entry) => entry.chats.length > 0);
}

/** ¿Toca empezar otro chat de ayuda? Por días desde que se creó o por
 *  mensajes; 0 es «nunca» (de fábrica, uno solo para siempre). */
export function helpChatExpired(chat: { createdAt: number; messages: number }, now: number, maxDays: number, maxMessages: number): boolean {
    const day = 24 * 60 * 60 * 1000;
    return (maxDays > 0 && chat.createdAt > 0 && now - chat.createdAt >= maxDays * day)
        || (maxMessages > 0 && chat.messages >= maxMessages);
}

/** El título que propone el agente, limpio: una línea, sin comillas,
 *  almohadillas ni punto final, y como mucho `max` caracteres. */
export function cleanAgentTitle(text: string, max = 60): string {
    const line = text.split(/\r?\n/u).map((item) => item.trim()).find(Boolean) ?? '';
    const flat = line
        .replace(/^(?:t[ií]tulo|title)\s*:\s*/iu, '')
        .replace(/^[#*\s"'«“]+|["'»”*\s.]+$/gu, '')
        .replace(/\s+/gu, ' ');
    return autoTitle(flat, max);
}

/** Un nombre de archivo para exportar: el título sin lo que Windows no admite. */
export function exportFileName(title: string): string {
    const clean = title.replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80);
    return `${clean || 'chat'}.md`;
}

/** Un chat en Markdown (24-11): título, agente y fechas, y cada mensaje con
 *  quién lo dijo. Los bloques de código de las respuestas quedan tal cual. */
export function chatToMarkdown(
    chat: Pick<StoredChat, 'title' | 'agentLabel' | 'createdAt' | 'updatedAt' | 'messages'>,
    labels: { you: string; agent: string; created: string; updated: string; error: string; untitled: string },
    formatDate: (time: number) => string,
): string {
    const lines = [`# ${chat.title || labels.untitled}`, ''];
    if (chat.agentLabel) lines.push(`- ${labels.agent}: ${chat.agentLabel}`);
    lines.push(`- ${labels.created}: ${formatDate(chat.createdAt)}`, `- ${labels.updated}: ${formatDate(chat.updatedAt)}`, '');
    for (const message of chat.messages) {
        const who = message.role === 'user' ? labels.you : (message.agent || labels.agent);
        lines.push(`## ${who}`, '');
        if (message.text.trim()) lines.push(message.text.trimEnd(), '');
        if (message.error) lines.push(`> ${labels.error}: ${message.error.replace(/\r?\n/gu, ' ')}`, '');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

/** Una sesión leída del disco, limpia: ids válidos, sin repetidos, como
 *  mucho `max`, y el activo solo si está entre los abiertos. */
export function sanitizeSession(value: unknown, max: number): ChatSession {
    const raw = value && typeof value === 'object' ? (value as { open?: unknown; active?: unknown }) : {};
    const open = Array.isArray(raw.open)
        ? [...new Set(raw.open.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(id) && id !== 'session'))].slice(0, max)
        : [];
    const active = typeof raw.active === 'string' && open.includes(raw.active) ? raw.active : (open[0] ?? null);
    return { open, active };
}
