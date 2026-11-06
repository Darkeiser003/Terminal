<script lang="ts">
    // Búsqueda en las órdenes escritas (Ctrl+Shift+R de fábrica): un diálogo
    // como la paleta de comandos. Intro deja la orden escrita en el prompt de
    // la pestaña activa, sin ejecutarla, para revisarla o cambiarla. Qué
    // órdenes entran en el historial lo explica `lib/command-history.ts`.

    import { onMount, tick } from 'svelte';

    import { app } from '../lib/appState.svelte';
    import { searchCommands } from '../lib/command-history';
    import { nextPaletteIndex } from '../lib/command-palette';
    import { getTerminal } from '../lib/terminalRegistry';

    interface Props {
        /** Escribe la orden; devuelve el motivo si no se pudo, o `null`. */
        onInsert: (command: string) => string | null;
        onClose: () => void;
    }

    let { onInsert, onClose }: Props = $props();

    let query = $state('');
    let selected = $state(0);
    let status = $state('');
    let input = $state<HTMLInputElement | null>(null);
    let list = $state<HTMLElement | null>(null);

    const results = $derived(searchCommands(app.commandHistory, query));

    function optionId(index: number): string {
        return `history-search-option-${index}`;
    }

    $effect(() => {
        query;
        selected = 0;
        status = '';
    });

    $effect(() => {
        const index = selected;
        void tick().then(() => {
            list?.querySelector<HTMLElement>(`#${optionId(index)}`)?.scrollIntoView({ block: 'nearest' });
        });
    });

    function insert(command: string | undefined): void {
        if (!command) return;
        const problem = onInsert(command);
        if (problem) {
            status = problem;
            input?.focus();
            return;
        }
        onClose();
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            insert(results[selected]);
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            return;
        }
        const next = nextPaletteIndex(selected, event.key, results.length);
        if (next !== null && (event.key.startsWith('Arrow') || event.key.startsWith('Page'))) {
            event.preventDefault();
            selected = Math.max(0, next);
        }
    }

    onMount(() => {
        input?.focus();
        // Al cerrarse, la orden escrita (o la que se estaba escribiendo) está
        // en la terminal: el foco vuelve allí.
        return () => {
            requestAnimationFrame(() => {
                if (app.activeTabId) getTerminal(app.activeTabId)?.focus();
            });
        };
    });
</script>

<div
    class="history-backdrop"
    data-panel-toggle
    role="presentation"
    onmousedown={(event) => {
        if (event.target === event.currentTarget) onClose();
    }}
>
    <div
        class="history"
        role="dialog"
        aria-modal="true"
        aria-label={app.t('history.title', 'Órdenes escritas')}
        data-testid="history-search"
    >
        <input
            bind:this={input}
            bind:value={query}
            class="history-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="history-search-list"
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(selected) : undefined}
            aria-label={app.t('history.title', 'Órdenes escritas')}
            placeholder={app.t('history.placeholder', 'Busca una orden escrita en esta sesión…')}
            spellcheck="false"
            autocomplete="off"
            data-testid="history-search-input"
            onkeydown={onKeydown}
        />
        <div
            bind:this={list}
            id="history-search-list"
            class="history-list"
            role="listbox"
            aria-label={app.t('history.title', 'Órdenes escritas')}
        >
            {#each results as command, index (command)}
                <div
                    id={optionId(index)}
                    class="history-option"
                    class:active={index === selected}
                    role="option"
                    tabindex="-1"
                    aria-selected={index === selected}
                    data-testid="history-search-option"
                    onmousemove={() => {
                        if (selected !== index) selected = index;
                    }}
                    onmousedown={(event) => event.preventDefault()}
                    onclick={() => insert(command)}
                    onkeydown={onKeydown}
                >{command}</div>
            {:else}
                <div class="history-empty" role="presentation">{app.commandHistory.length
                    ? app.t('history.noMatches', 'Ninguna orden coincide con la búsqueda.')
                    : app.t('history.none', 'Todavía no hay órdenes. Se guardan las que escribes sobre el prompt de cmd, PowerShell o bash, con las marcas de orden activadas en Ajustes.')}</div>
            {/each}
        </div>
        <div class="history-footer">
            <span class="history-status" class:error={Boolean(status)} role="status" aria-live="polite" data-testid="history-search-status">{status}</span>
            <span class="history-hint">{app.t('history.hint', '↑↓ moverse · Intro escribirla sin ejecutar · Esc cerrar')}</span>
        </div>
    </div>
</div>

<style>
    .history-backdrop {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 56px 16px 16px;
        background: rgba(0, 0, 0, 0.35);
    }

    .history {
        display: flex;
        flex-direction: column;
        width: min(640px, 100%);
        max-height: min(70vh, 560px);
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
        color: var(--text);
        font-size: 12px;
    }

    .history-input {
        box-sizing: border-box;
        width: 100%;
        padding: 10px 12px;
        border: 0;
        border-bottom: 1px solid var(--border);
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 13px;
        outline: none;
    }

    .history-input:focus-visible {
        box-shadow: inset 0 -2px 0 var(--accent);
    }

    .history-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 4px 0;
    }

    .history-option {
        overflow: hidden;
        padding: 5px 12px;
        border-left: 2px solid transparent;
        font-family: var(--terminal-font);
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
    }

    .history-option.active {
        background: var(--surface-hover);
        border-left-color: var(--accent);
    }

    .history-empty {
        padding: 14px 12px;
        color: var(--muted);
        line-height: 1.4;
    }

    .history-footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 4px 12px;
        padding: 6px 12px;
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 11px;
    }

    .history-status.error {
        color: var(--warning);
    }
</style>
