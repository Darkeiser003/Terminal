<script lang="ts">
    // Varios chats con IA a la vez en la barra lateral (14-11, Romen:
    // «preparar la terminal para soportar múltiples agentes trabajando a la
    // vez, varios chats con IA, en paralelo»). Cada pestaña es un chat entero
    // (AgentChat): su agente, su modelo, su conversación y su pregunta en
    // curso. Los que no se ven siguen trabajando; su pestaña lo marca. El
    // backend ya admitía varias preguntas a la vez (una por id). Cerrar un
    // chat corta su pregunta; cerrar el panel, todas.
    import AgentChat from './AgentChat.svelte';
    import { app } from '../lib/appState.svelte';

    type Slot = { id: number; agent: string; busy: boolean };

    // Los mismos que tenía el panel de un solo chat: el ancho se recuerda.
    const WIDTH_KEY = 'wterminal.agentChat.width';
    const MIN_WIDTH = 300;
    const MAX_WIDTH = 900;
    /** Más chats a la vez no caben en la fila y gastan cuenta sin control. */
    const MAX_CHATS = 6;

    let nextId = 1;
    let chats = $state<Slot[]>([{ id: nextId++, agent: '', busy: false }]);
    let activeId = $state(1);
    let width = $state(readWidth());

    function readWidth(): number {
        try {
            const value = Number(localStorage.getItem(WIDTH_KEY));
            return Number.isFinite(value) && value >= MIN_WIDTH ? Math.min(value, MAX_WIDTH) : 380;
        } catch {
            return 380;
        }
    }

    function newChat(): void {
        if (chats.length >= MAX_CHATS) return;
        const id = nextId++;
        chats.push({ id, agent: '', busy: false });
        activeId = id;
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

    function report(id: number, status: { busy: boolean; agent: string }): void {
        const chat = chats.find((item) => item.id === id);
        if (!chat) return;
        if (chat.busy !== status.busy) chat.busy = status.busy;
        if (chat.agent !== status.agent) chat.agent = status.agent;
    }

    function tabTitle(chat: Slot, index: number): string {
        const name = chat.agent || app.t('agentChat.chatN', 'Chat {n}').replace('{n}', String(index + 1));
        return chat.busy ? `${name} · ${app.t('agentChat.chatBusy', 'trabajando…')}` : name;
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
            <div class="chat-tab" class:active={chat.id === activeId}>
                <button
                    type="button"
                    role="tab"
                    class="chat-select"
                    data-testid="agent-chat-tab"
                    data-busy={chat.busy}
                    aria-selected={chat.id === activeId}
                    title={tabTitle(chat, index)}
                    onclick={() => (activeId = chat.id)}
                >
                    {#if chat.busy}<span class="busy" aria-hidden="true"></span>{/if}
                    <span class="chat-name">{chat.agent || app.t('agentChat.chatN', 'Chat {n}').replace('{n}', String(index + 1))}</span>
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
            data-testid="agent-chat-close"
            title={app.t('agentChat.closePanel', 'Cerrar el panel (corta lo que esté en curso)')}
            aria-label={app.t('common.close', 'Cerrar')}
            onclick={() => (app.agentChatVisible = false)}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        </button>
    </div>

    {#each chats as chat (chat.id)}
        <div class="slot" class:hidden={chat.id !== activeId} role="tabpanel">
            <AgentChat embedded active={chat.id === activeId} onstatus={(status) => report(chat.id, status)} />
        </div>
    {/each}
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

    @media (prefers-reduced-motion: reduce) {
        .busy {
            animation: none;
        }
    }
</style>
