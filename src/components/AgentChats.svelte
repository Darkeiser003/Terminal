<script lang="ts">
    // Varios chats con IA a la vez en la barra lateral (14-11, Romen:
    // «preparar la terminal para soportar múltiples agentes trabajando a la
    // vez, varios chats con IA, en paralelo»). Cada pestaña es un chat entero
    // (AgentChat): su agente, su modelo, su conversación y su pregunta en
    // curso. Los que no se ven siguen trabajando; su pestaña lo marca. El
    // backend ya admitía varias preguntas a la vez (una por id). Cerrar un
    // chat corta su pregunta; cerrar el panel, todas.
    //
    // Historial (23-11, Romen: «si cierro la pestaña, aunque sea un segundo,
    // se borra»): cada chat se guarda solo; cerrar su pestaña o el panel ya
    // no lo pierde. Al volver a abrir el chat vuelven las pestañas que había
    // (`agentChatRestore`), y el botón del reloj abre la lista de chats
    // guardados para buscarlos, reabrirlos, renombrarlos o borrarlos.
    import { onDestroy, onMount, tick, untrack } from 'svelte';
    import AgentChat from './AgentChat.svelte';
    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import {
        chatToMarkdown,
        exportFileName,
        groupChatsByDate,
        helpChatExpired,
        latestHelpChat,
        newChatId,
        sanitizeSession,
        searchChats,
        type AgentChatSummary,
        type ChatSession,
        type DateGroup,
        type StoredChat,
    } from '../lib/agent-chat-history';

    type Slot = { id: number; chatId: string; agent: string; busy: boolean; title: string; empty: boolean; restore: StoredChat | null; help: boolean };
    type ChatHandle = { rename(next: string): void; forget(): void; restartConversation(): string | null; currentId(): string; age(): { createdAt: number; messages: number } };

    // Los mismos que tenía el panel de un solo chat: el ancho se recuerda.
    const WIDTH_KEY = 'wterminal.agentChat.width';
    const MIN_WIDTH = 300;
    const MAX_WIDTH = 900;
    /** Más chats a la vez no caben en la fila y gastan cuenta sin control. */
    const MAX_CHATS = 6;

    let nextId = 1;
    let chats = $state<Slot[]>([]);
    let activeId = $state(0);
    let width = $state(readWidth());
    /** Hasta leer la sesión guardada no se pinta ningún chat. */
    let ready = $state(false);
    const handles: Record<number, ChatHandle | undefined> = $state({});

    const historyOn = $derived(app.preferences?.agentChatHistory !== false);
    const restoreOn = $derived(historyOn && app.preferences?.agentChatRestore !== false);

    // ---- Lista del historial ----
    let showHistory = $state(false);
    let summaries = $state<AgentChatSummary[]>([]);
    let historyLoading = $state(false);
    let query = $state('');
    let renaming = $state<string | null>(null);
    let renameDraft = $state('');
    let confirmDelete = $state<string | null>(null);
    let confirmClear = $state(false);
    let historyNotice = $state('');
    let searchInput = $state<HTMLInputElement | undefined>(undefined);
    const filtered = $derived(searchChats(summaries, query));
    const groups = $derived(groupChatsByDate(filtered));

    function blankSlot(restore: StoredChat | null = null, help = false): Slot {
        return {
            help: help || restore?.help === true,
            id: nextId++,
            chatId: restore?.id ?? newChatId(),
            agent: restore?.agentLabel ?? '',
            busy: false,
            title: restore?.title ?? '',
            empty: !restore || restore.messages.length === 0,
            restore,
        };
    }

    // Al abrir el panel: las pestañas de la última vez, si se pidió.
    onMount(() => {
        void (async () => {
            const restored: Slot[] = [];
            let active: string | null = null;
            if (restoreOn) {
                try {
                    const session = sanitizeSession(await api.agentChatSessionLoad(), MAX_CHATS);
                    active = session.active;
                    for (const id of session.open) {
                        const chat = await api.agentChatHistoryLoad(id).catch(() => null);
                        if (chat && Array.isArray(chat.messages)) restored.push(blankSlot(chat));
                    }
                } catch {
                    // Sin sesión legible: se empieza con un chat vacío.
                }
            }
            chats = restored.length ? restored : [blankSlot()];
            activeId = (chats.find((chat) => chat.chatId === active) ?? chats[chats.length - 1]).id;
            ready = true;
        })();
    });

    // La sesión (qué chats hay abiertos y cuál se ve) se guarda con cada
    // cambio. Los vacíos no cuentan: no tienen archivo.
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSession: ChatSession | null = null;
    function saveSession(): void {
        if (sessionTimer) clearTimeout(sessionTimer);
        sessionTimer = undefined;
        if (pendingSession) void api.agentChatSessionSave(pendingSession).catch(() => {});
        pendingSession = null;
    }
    $effect(() => {
        if (!ready || !historyOn) return;
        const open = chats.filter((chat) => !chat.empty).map((chat) => chat.chatId);
        const activeChat = chats.find((chat) => chat.id === activeId);
        pendingSession = { open, active: activeChat && !activeChat.empty ? activeChat.chatId : (open[open.length - 1] ?? null) };
        if (sessionTimer) clearTimeout(sessionTimer);
        sessionTimer = setTimeout(saveSession, 300);
    });
    // Al cerrar el panel, lo que quedara por guardar se guarda ya.
    onDestroy(saveSession);

    function readWidth(): number {
        try {
            const value = Number(localStorage.getItem(WIDTH_KEY));
            return Number.isFinite(value) && value >= MIN_WIDTH ? Math.min(value, MAX_WIDTH) : 380;
        } catch {
            return 380;
        }
    }

    // ---- Chat de ayuda (24-11) ----
    // Las preguntas del aviso de ayuda con IA van siempre al mismo chat, el
    // de ayuda (Romen: «sería un poco sucio crear chats infinitos»): si está
    // abierto, se va a él; si está guardado, se reabre; si no, se crea. Lo
    // que se abre a mano sigue siendo un chat nuevo y normal.
    let routingHelp = false;
    $effect(() => {
        if (!ready || app.agentChatDraft?.help !== true || routingHelp) return;
        routingHelp = true;
        // Solo la pregunta dispara esto: lo que lee al buscar el chat no.
        untrack(() => void showHelpChat().finally(() => {
            routingHelp = false;
        }));
    });

    /** Caducidad del chat de ayuda (24-11): 0 es nunca (de fábrica). */
    function helpExpired(chat: { createdAt: number; messages: number }): boolean {
        return helpChatExpired(chat, Date.now(), app.preferences?.agentChatHelpMaxDays ?? 0, app.preferences?.agentChatHelpMaxMessages ?? 0);
    }

    /** El chat de ayuda nuevo va fijado (`agentChatPinHelp`); el que caducó
     *  deja de estarlo. */
    async function pinHelp(next: string, previous: string | null): Promise<void> {
        if (app.preferences?.agentChatPinHelp === false) return;
        if (previous && previous !== next) await api.agentChatHistoryPin(previous, false).catch(() => false);
        await api.agentChatHistoryPin(next, true).catch(() => false);
    }

    async function showHelpChat(): Promise<void> {
        showHistory = false;
        const open = chats.find((chat) => chat.help);
        if (open) {
            activeId = open.id;
            const handle = handles[open.id];
            if (handle && helpExpired(handle.age())) {
                const previous = handle.restartConversation();
                await pinHelp(handle.currentId(), previous);
            }
            return;
        }
        const saved = historyOn ? latestHelpChat(await api.agentChatHistoryList().catch(() => [])) : null;
        const fresh = saved && helpExpired(saved);
        const stored = saved && !fresh ? await api.agentChatHistoryLoad(saved.id).catch(() => null) : null;
        const slot = blankSlot(stored && Array.isArray(stored.messages) ? stored : null, true);
        void pinHelp(slot.chatId, fresh && saved ? saved.id : null);
        // En la pestaña vacía que se ve, si la hay; si no, una más (aunque
        // ya haya el máximo: la ayuda no se queda sin sitio).
        const current = chats.find((chat) => chat.id === activeId);
        if (current && current.empty && !current.busy) chats[chats.indexOf(current)] = slot;
        else chats.push(slot);
        activeId = slot.id;
    }

    function newChat(): void {
        if (chats.length >= MAX_CHATS) return;
        const slot = blankSlot();
        chats.push(slot);
        activeId = slot.id;
        showHistory = false;
    }

    /** Cierra un chat (su pregunta en curso se corta); el último cierra el
     *  panel. */
    function closeChat(id: number): void {
        const index = chats.findIndex((chat) => chat.id === id);
        if (index < 0) return;
        if (chats.length === 1) {
            app.agentChatVisible = false;
            return;
        }
        chats.splice(index, 1);
        if (activeId === id) activeId = chats[Math.min(index, chats.length - 1)].id;
    }

    function report(id: number, status: { busy: boolean; agent: string; chatId: string; title: string; empty: boolean }): void {
        const chat = chats.find((item) => item.id === id);
        if (!chat) return;
        if (chat.busy !== status.busy) chat.busy = status.busy;
        if (chat.agent !== status.agent) chat.agent = status.agent;
        if (chat.chatId !== status.chatId) chat.chatId = status.chatId;
        if (chat.title !== status.title) chat.title = status.title;
        if (chat.empty !== status.empty) chat.empty = status.empty;
    }

    /** La pestaña: el título de la conversación; sin él, el agente. */
    function tabName(chat: Slot, index: number): string {
        return chat.title || chat.agent || app.t('agentChat.chatN', 'Chat {n}').replace('{n}', String(index + 1));
    }

    function tabTitle(chat: Slot, index: number): string {
        const name = chat.title && chat.agent ? `${chat.title} · ${chat.agent}` : tabName(chat, index);
        return chat.busy ? `${name} · ${app.t('agentChat.chatBusy', 'trabajando…')}` : name;
    }

    // ---- Historial ----

    async function refreshHistory(): Promise<void> {
        historyLoading = summaries.length === 0;
        try {
            summaries = await api.agentChatHistoryList();
        } catch {
            summaries = [];
        } finally {
            historyLoading = false;
        }
    }

    function toggleHistory(): void {
        showHistory = !showHistory;
        renaming = null;
        confirmDelete = null;
        confirmClear = false;
        historyNotice = '';
        if (showHistory) {
            void refreshHistory();
            void tick().then(() => searchInput?.focus());
        }
    }

    /** Reabre un chat guardado: si ya está abierto, se va a su pestaña; si la
     *  que se ve está vacía, se abre en ella; si no, en una pestaña nueva. */
    async function openSaved(id: string): Promise<void> {
        const open = chats.find((chat) => chat.chatId === id && !chat.empty);
        if (open) {
            activeId = open.id;
            showHistory = false;
            return;
        }
        const current = chats.find((chat) => chat.id === activeId);
        const replace = current !== undefined && current.empty && !current.busy;
        if (!replace && chats.length >= MAX_CHATS) {
            historyNotice = app.t('agentChat.historyTooMany', 'Ya hay {count} chats abiertos: cierra uno para abrir otro.').replace('{count}', String(MAX_CHATS));
            return;
        }
        const stored = await api.agentChatHistoryLoad(id).catch(() => null);
        if (!stored || !Array.isArray(stored.messages)) {
            historyNotice = app.t('agentChat.historyMissing', 'No se pudo abrir ese chat: ya no está guardado.');
            void refreshHistory();
            return;
        }
        const slot = blankSlot(stored);
        if (replace && current) chats[chats.indexOf(current)] = slot;
        else chats.push(slot);
        activeId = slot.id;
        showHistory = false;
    }

    function startRename(summary: AgentChatSummary): void {
        renaming = summary.id;
        renameDraft = summary.title;
        confirmDelete = null;
        void tick().then(() => document.querySelector<HTMLInputElement>('[data-testid="agent-chat-history-rename-input"]')?.select());
    }

    async function finishRename(summary: AgentChatSummary): Promise<void> {
        if (renaming !== summary.id) return;
        const next = renameDraft.trim().slice(0, 120);
        renaming = null;
        if (!next || next === summary.title) return;
        const open = chats.find((chat) => chat.chatId === summary.id && !chat.empty);
        if (open) {
            handles[open.id]?.rename(next);
        } else {
            const stored = await api.agentChatHistoryLoad(summary.id).catch(() => null);
            if (!stored) return;
            await api.agentChatHistorySave({ ...stored, title: next, titleEdited: true }).catch(() => {});
        }
        summary.title = next;
    }

    async function deleteSaved(id: string): Promise<void> {
        confirmDelete = null;
        // Si está abierto y contestando no se borra: se cortaría a medias.
        const open = chats.find((chat) => chat.chatId === id && !chat.empty);
        if (open?.busy) {
            historyNotice = app.t('agentChat.historyBusy', 'Ese chat está contestando: espera o córtalo antes de borrarlo.');
            return;
        }
        // Su sesión de Claude Code o Codex se deja de fábrica: es suya
        // (`agentChatForgetNative`, 24-11).
        if (app.preferences?.agentChatForgetNative === true) {
            const stored = await api.agentChatHistoryLoad(id).catch(() => null);
            if (stored?.native?.id) await api.agentChatNativeForget(stored.native.agentId, stored.native.id).catch(() => 0);
        }
        if (open) handles[open.id]?.forget();
        await api.agentChatHistoryDelete(id).catch(() => false);
        summaries = summaries.filter((summary) => summary.id !== id);
    }

    async function clearAll(): Promise<void> {
        confirmClear = false;
        if (chats.some((chat) => chat.busy)) {
            historyNotice = app.t('agentChat.historyBusy', 'Ese chat está contestando: espera o córtalo antes de borrarlo.');
            return;
        }
        for (const chat of chats) if (!chat.empty) handles[chat.id]?.forget();
        await api.agentChatHistoryClear().catch(() => 0);
        summaries = [];
    }

    async function togglePin(summary: AgentChatSummary): Promise<void> {
        const next = !summary.pinned;
        if (await api.agentChatHistoryPin(summary.id, next).catch(() => false)) summary.pinned = next;
    }

    async function exportSaved(summary: AgentChatSummary): Promise<void> {
        const stored = await api.agentChatHistoryLoad(summary.id).catch(() => null);
        if (!stored || !Array.isArray(stored.messages)) {
            historyNotice = app.t('agentChat.historyMissing', 'No se pudo abrir ese chat: ya no está guardado.');
            return;
        }
        const text = chatToMarkdown(stored, {
            you: app.t('agentChat.you', 'Tú'),
            agent: app.t('agentChat.agentRole', 'Agente'),
            created: app.t('agentChat.exportCreated', 'Empezado'),
            updated: app.t('agentChat.exportUpdated', 'Último mensaje'),
            error: app.t('agentChat.exportError', 'Falló'),
            untitled: app.t('agentChat.historyUntitled', 'Sin título'),
        }, (time) => new Date(time).toLocaleString(app.catalog.language));
        try {
            if (await api.exportAgentChat(exportFileName(stored.title), text)) historyNotice = app.t('agentChat.exported', 'Chat exportado.');
        } catch (cause) {
            historyNotice = String(cause);
        }
    }

    // Lo que cambia el historial desde fuera (`:chat pin`, también una IA).
    onMount(() => {
        const refresh = () => {
            if (showHistory) void refreshHistory();
        };
        window.addEventListener('wterminal:agent-chat-history-changed', refresh);
        return () => window.removeEventListener('wterminal:agent-chat-history-changed', refresh);
    });

    function groupLabel(group: DateGroup): string {
        switch (group) {
            case 'pinned':
                return app.t('agentChat.historyPinned', 'Fijados');
            case 'today':
                return app.t('agentChat.historyToday', 'Hoy');
            case 'yesterday':
                return app.t('agentChat.historyYesterday', 'Ayer');
            case 'week':
                return app.t('agentChat.historyWeek', 'Últimos 7 días');
            case 'month':
                return app.t('agentChat.historyMonth', 'Últimos 30 días');
            default:
                return app.t('agentChat.historyOlder', 'Anteriores');
        }
    }

    function when(time: number): string {
        const date = new Date(time);
        const sameDay = new Date().toDateString() === date.toDateString();
        return sameDay
            ? date.toLocaleTimeString(app.catalog.language, { hour: '2-digit', minute: '2-digit' })
            : date.toLocaleDateString(app.catalog.language, { day: 'numeric', month: 'short' });
    }

    function onHistoryKeydown(event: KeyboardEvent): void {
        // Las teclas del historial no deben llegar a la terminal ni a los atajos.
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            if (renaming) renaming = null;
            else if (query) query = '';
            else showHistory = false;
        }
    }

    function startResize(event: PointerEvent): void {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
            const limit = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth * 0.7));
            width = Math.round(Math.min(limit, Math.max(MIN_WIDTH, startWidth + (startX - moveEvent.clientX))));
        };
        const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            try {
                localStorage.setItem(WIDTH_KEY, String(width));
            } catch {
                // Sin almacenamiento: el ancho vuelve al de siempre al reabrir.
            }
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    }
</script>

<aside class="agent-chats" data-testid="agent-chats" aria-label={app.t('toolbar.agentChat', 'Chat IA')} style:width={`${width}px`}>
    <div
        class="resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={app.t('agentChat.resize', 'Cambiar el ancho del chat')}
        title={app.t('agentChat.resize', 'Cambiar el ancho del chat')}
        data-testid="agent-chat-resize"
        onpointerdown={startResize}
    ></div>

    <div class="chat-tabs" role="tablist" aria-label={app.t('agentChat.chats', 'Chats')}>
        {#each chats as chat, index (chat.id)}
            <!-- El clic central cierra el chat, como en las pestañas de las
                 shells (21-11); con un solo chat no hay nada que cerrar,
                 igual que la ×. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="chat-tab"
                class:active={chat.id === activeId}
                data-testid="agent-chat-tab-frame"
                onmousedown={(event) => {
                    // Sin esto Windows arranca el desplazamiento con la rueda.
                    if (event.button === 1) event.preventDefault();
                }}
                onauxclick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (chats.length > 1) closeChat(chat.id);
                }}
            >
                <button
                    type="button"
                    role="tab"
                    class="chat-select"
                    data-testid="agent-chat-tab"
                    data-busy={chat.busy}
                    aria-selected={chat.id === activeId}
                    title={tabTitle(chat, index)}
                    onclick={() => {
                        activeId = chat.id;
                        showHistory = false;
                    }}
                >
                    {#if chat.busy}<span class="busy" aria-hidden="true"></span>{/if}
                    <span class="chat-name">{tabName(chat, index)}</span>
                </button>
                {#if chats.length > 1}
                    <button
                        type="button"
                        class="chat-close"
                        data-testid="agent-chat-close-chat"
                        title={chat.busy
                            ? app.t('agentChat.closeChatBusy', 'Cerrar este chat (corta su pregunta en curso)')
                            : app.t('agentChat.closeChat', 'Cerrar este chat')}
                        aria-label={app.t('agentChat.closeChat', 'Cerrar este chat')}
                        onclick={() => closeChat(chat.id)}
                    >×</button>
                {/if}
            </div>
        {/each}
        <button
            type="button"
            class="icon"
            data-testid="agent-chat-new-chat"
            title={app.t('agentChat.newChatHint', 'Otro chat en paralelo: con su propio agente y su conversación')}
            aria-label={app.t('agentChat.newChat', 'Nuevo chat')}
            disabled={chats.length >= MAX_CHATS}
            onclick={newChat}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
        </button>
        <span class="spacer"></span>
        <button
            type="button"
            class="icon"
            class:on={showHistory}
            data-testid="agent-chat-history"
            aria-pressed={showHistory}
            title={app.t('agentChat.historyHint', 'Historial: los chats guardados, para buscarlos y volver a abrirlos')}
            aria-label={app.t('agentChat.history', 'Historial de chats')}
            onclick={toggleHistory}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.6 2.4v2.6h2.6M8 5v3.2l2.1 1.4" /></svg>
        </button>
        <button
            type="button"
            class="icon"
            data-testid="agent-chat-close"
            title={app.t('agentChat.closePanel', 'Cerrar el panel (corta lo que esté en curso)')}
            aria-label={app.t('common.close', 'Cerrar')}
            onclick={() => (app.agentChatVisible = false)}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        </button>
    </div>

    {#if showHistory}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <section class="history" data-testid="agent-chat-history-panel" aria-label={app.t('agentChat.history', 'Historial de chats')} onkeydown={onHistoryKeydown}>
            <input
                class="search"
                type="search"
                data-testid="agent-chat-history-search"
                placeholder={app.t('agentChat.historySearch', 'Buscar en los chats…')}
                aria-label={app.t('agentChat.historySearch', 'Buscar en los chats…')}
                bind:this={searchInput}
                bind:value={query}
            />
            {#if historyNotice}<p class="history-notice" role="status" data-testid="agent-chat-history-notice">{historyNotice}</p>{/if}
            <div class="history-list">
                {#if historyLoading}
                    <p class="empty">{app.t('agentChat.historyLoading', 'Cargando…')}</p>
                {:else if summaries.length === 0}
                    <p class="empty" data-testid="agent-chat-history-empty">{app.t('agentChat.historyEmpty', 'Aún no hay chats guardados. Cada conversación se guarda sola en cuanto preguntas algo.')}</p>
                {:else if filtered.length === 0}
                    <p class="empty">{app.t('agentChat.historyNoMatch', 'Ningún chat coincide con la búsqueda.')}</p>
                {/if}
                {#each groups as entry (entry.group)}
                    <h3>{groupLabel(entry.group)}</h3>
                    {#each entry.chats as summary (summary.id)}
                        {@const isOpen = chats.some((chat) => chat.chatId === summary.id && !chat.empty)}
                        <div class="item" class:open={isOpen} data-testid="agent-chat-history-item" data-chat-id={summary.id}>
                            {#if renaming === summary.id}
                                <input
                                    class="rename"
                                    data-testid="agent-chat-history-rename-input"
                                    aria-label={app.t('agentChat.historyRename', 'Renombrar')}
                                    bind:value={renameDraft}
                                    onkeydown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            void finishRename(summary);
                                        }
                                    }}
                                    onblur={() => void finishRename(summary)}
                                />
                            {:else}
                                <button type="button" class="open-chat" data-testid="agent-chat-history-open" title={summary.title} onclick={() => void openSaved(summary.id)}>
                                    <span class="item-title">{summary.title || app.t('agentChat.historyUntitled', 'Sin título')}</span>
                                    <span class="item-meta">
                                        {summary.agent}{summary.agent ? ' · ' : ''}{when(summary.updatedAt)}{isOpen ? ` · ${app.t('agentChat.historyOpenNow', 'abierto')}` : ''}
                                    </span>
                                </button>
                            {/if}
                            {#if confirmDelete === summary.id}
                                <span class="confirm">
                                    <button type="button" class="danger" data-testid="agent-chat-history-delete-confirm" onclick={() => void deleteSaved(summary.id)}>{app.t('agentChat.historyDeleteYes', 'Borrar')}</button>
                                    <button type="button" onclick={() => (confirmDelete = null)}>{app.t('common.cancel', 'Cancelar')}</button>
                                </span>
                            {:else if renaming !== summary.id}
                                <span class="item-actions">
                                    <button type="button" class="icon" class:pinned={summary.pinned} data-testid="agent-chat-history-pin" aria-pressed={summary.pinned === true} title={summary.pinned ? app.t('agentChat.historyUnpin', 'Desfijar') : app.t('agentChat.historyPin', 'Fijar arriba')} aria-label={summary.pinned ? app.t('agentChat.historyUnpin', 'Desfijar') : app.t('agentChat.historyPin', 'Fijar arriba')} onclick={() => void togglePin(summary)}>
                                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4l-.5 4 2.5 2.5H4l2.5-2.5zM8 9v4.5" /></svg>
                                    </button>
                                    <button type="button" class="icon" data-testid="agent-chat-history-export" title={app.t('agentChat.historyExport', 'Exportar a Markdown')} aria-label={app.t('agentChat.historyExport', 'Exportar a Markdown')} onclick={() => void exportSaved(summary)}>
                                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7M5 6.5l3 3 3-3M3 11v2.5h10V11" /></svg>
                                    </button>
                                    <button type="button" class="icon" data-testid="agent-chat-history-rename" title={app.t('agentChat.historyRename', 'Renombrar')} aria-label={app.t('agentChat.historyRename', 'Renombrar')} onclick={() => startRename(summary)}>
                                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h2.5L12.6 5.9a1.3 1.3 0 0 0-2.5-2.5L3 10.5z" /></svg>
                                    </button>
                                    <button type="button" class="icon" data-testid="agent-chat-history-delete" title={app.t('agentChat.historyDelete', 'Borrar este chat')} aria-label={app.t('agentChat.historyDelete', 'Borrar este chat')} onclick={() => { confirmDelete = summary.id; renaming = null; }}>
                                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.8 4.5l.6 8.5h5.2l.6-8.5" /></svg>
                                    </button>
                                </span>
                            {/if}
                        </div>
                    {/each}
                {/each}
            </div>
            {#if summaries.length > 0}
                <footer class="history-footer">
                    {#if confirmClear}
                        <span>{app.t('agentChat.historyClearAsk', '¿Borrar los {count} chats guardados? No se puede deshacer.').replace('{count}', String(summaries.length))}</span>
                        <button type="button" class="danger" data-testid="agent-chat-history-clear-confirm" onclick={() => void clearAll()}>{app.t('agentChat.historyDeleteYes', 'Borrar')}</button>
                        <button type="button" onclick={() => (confirmClear = false)}>{app.t('common.cancel', 'Cancelar')}</button>
                    {:else}
                        <button type="button" data-testid="agent-chat-history-clear" onclick={() => (confirmClear = true)}>{app.t('agentChat.historyClear', 'Borrar todo el historial')}</button>
                    {/if}
                </footer>
            {/if}
        </section>
    {/if}

    {#if ready}
        {#each chats as chat (chat.id)}
            <div class="slot" class:hidden={chat.id !== activeId || showHistory} role="tabpanel">
                <AgentChat
                    bind:this={handles[chat.id]}
                    embedded
                    active={chat.id === activeId && !showHistory}
                    chatId={chat.chatId}
                    restore={chat.restore}
                    help={chat.help}
                    onstatus={(status) => report(chat.id, status)}
                />
            </div>
        {/each}
    {/if}
</aside>

<style>
    .agent-chats {
        position: relative;
        display: flex;
        min-width: 0;
        max-width: 70vw;
        flex: 0 0 auto;
        flex-direction: column;
        margin-left: 4px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--terminal-bg);
        overflow: hidden;
    }

    .resize {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 3;
        width: 5px;
        cursor: col-resize;
    }

    .resize:hover {
        background: var(--accent-soft);
    }

    .chat-tabs {
        display: flex;
        flex: 0 0 auto;
        align-items: stretch;
        gap: 2px;
        min-height: 28px;
        padding: 3px 6px 0 10px;
        border-bottom: 1px solid var(--border);
        background: var(--surface-alt, var(--surface));
        font-family: var(--terminal-font);
        font-size: 11.5px;
        overflow-x: auto;
        scrollbar-width: thin;
    }

    .chat-tab {
        display: flex;
        flex: 0 1 auto;
        align-items: center;
        min-width: 0;
        max-width: 150px;
        border: 1px solid transparent;
        border-bottom: 0;
        border-radius: 3px 3px 0 0;
        color: var(--muted);
    }

    .chat-tab.active {
        border-color: var(--border);
        background: var(--terminal-bg);
        color: var(--terminal-fg);
    }

    .chat-select {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 5px;
        padding: 2px 4px 2px 8px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }

    .chat-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Un chat que trabaja, aunque no se vea. */
    .busy {
        width: 6px;
        height: 6px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--accent);
        animation: pulse 1.1s ease-in-out infinite;
    }

    @keyframes pulse {
        50% {
            opacity: 0.3;
        }
    }

    .chat-close {
        padding: 0 6px 0 2px;
        border: 0;
        background: none;
        color: var(--muted);
        font: inherit;
        cursor: pointer;
    }

    .chat-close:hover {
        color: var(--text);
    }

    .icon {
        display: inline-grid;
        width: 22px;
        height: 22px;
        flex: 0 0 auto;
        place-items: center;
        align-self: center;
        padding: 0;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
    }

    /* Chat fijado (24-11). */
    .icon.pinned {
        color: var(--accent);
    }

    .icon:hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
    }

    .icon:disabled {
        opacity: 0.35;
        cursor: default;
    }

    .icon svg {
        width: 13px;
        height: 13px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
    }

    .spacer {
        flex: 1 1 auto;
    }

    .slot {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
        flex-direction: column;
    }

    /* Escondido pero vivo: su pregunta sigue en curso. */
    .slot.hidden {
        display: none;
    }

    .icon.on {
        background: var(--surface-hover);
        color: var(--text);
    }

    /* Historial: la lista ocupa el sitio del chat, con el mismo aspecto de
       terminal (letra de terminal, sin tarjetas). */
    .history {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        font-family: var(--terminal-font);
        font-size: 12px;
        color: var(--terminal-fg);
    }

    .search,
    .rename {
        width: 100%;
        min-width: 0;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
    }

    .history-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        scrollbar-width: thin;
    }

    .history h3 {
        margin: 10px 0 4px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 600;
    }

    .history h3:first-child {
        margin-top: 2px;
    }

    .item {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        border-radius: 2px;
    }

    .item:hover,
    .item:focus-within {
        background: var(--surface-hover);
    }

    .item.open .item-title {
        color: var(--accent);
    }

    .open-chat {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        flex-direction: column;
        align-items: flex-start;
        padding: 4px 6px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }

    .item-title,
    .item-meta {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .item-meta {
        color: var(--muted);
        font-size: 11px;
    }

    .item-actions {
        display: flex;
        flex: 0 0 auto;
        opacity: 0;
    }

    .item:hover .item-actions,
    .item:focus-within .item-actions {
        opacity: 1;
    }

    .confirm,
    .history-footer {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }

    .confirm button,
    .history-footer button {
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        cursor: pointer;
    }

    .history-footer {
        padding-top: 6px;
        border-top: 1px solid var(--border);
        color: var(--muted);
    }

    button.danger {
        border-color: var(--danger, #c0392b);
        color: var(--danger, #e06c6c);
    }

    .empty,
    .history-notice {
        margin: 6px 0;
        color: var(--muted);
        line-height: 1.4;
    }

    @media (prefers-reduced-motion: reduce) {
        .busy {
            animation: none;
        }
    }
</style>
