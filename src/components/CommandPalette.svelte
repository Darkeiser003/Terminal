<script module lang="ts">
    import type { LToolsAction } from '../lib/types';

    /** El catálogo de LTools sale de lanzar su CLI. Se conserva entre
     *  aperturas para no arrancar un proceso cada vez que se pulsa el atajo;
     *  pasado un minuto (o con otro idioma) se vuelve a pedir. */
    const LTOOLS_CACHE_MS = 60_000;
    let ltoolsCache: { at: number; language: string; actions: LToolsAction[] } | null = null;
</script>

<script lang="ts">
    // Paleta de comandos: un diálogo con un buscador que agrupa las acciones que
    // la aplicación ya tiene (paneles, terminal, pestañas, entornos, apariencia,
    // comandos `:` y acciones fijadas de LTools). El registro y el filtrado
    // viven en `lib/command-palette.ts`; quién ejecuta cada acción lo decide
    // `App.svelte` con los mismos manejadores que usan los atajos y botones.
    //
    // Accesibilidad: el campo es un `combobox` que controla un `listbox`; la
    // opción activa se anuncia con `aria-activedescendant`, así el foco nunca
    // sale del campo y escribir sigue filtrando mientras se navega.

    import { onMount, tick } from 'svelte';

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import {
        PALETTE_GROUPS,
        buildPaletteEntries,
        nextPaletteIndex,
        paletteResults,
        type PaletteEntry,
        type PaletteGroupId,
    } from '../lib/command-palette';
    import { foldLocalized } from '../lib/localization';
    import {
        ltoolsActionLabel,
        ltoolsActionMeta,
        ltoolsActionNeedsConfirmation,
        ltoolsSelectionStorageKey,
        pinnedLToolsActions,
    } from '../lib/ltools-selection';
    import { getTerminal } from '../lib/terminalRegistry';

    interface Props {
        /** Ejecuta la entrada; devuelve un motivo si no se pudo (la paleta lo
         *  muestra y sigue abierta) o `null` si se hizo. */
        onRun: (entry: PaletteEntry) => Promise<string | null>;
        onClose: () => void;
    }

    let { onRun, onClose }: Props = $props();

    let query = $state('');
    let selected = $state(0);
    let status = $state('');
    let running = $state(false);
    let ltoolsActions = $state<LToolsAction[]>(ltoolsCache?.actions ?? []);
    let ltoolsLoading = $state(false);
    let input = $state<HTMLInputElement | null>(null);
    let list = $state<HTMLElement | null>(null);
    /** Dónde estaba el foco al abrir: se devuelve allí al cancelar. */
    let previousFocus: HTMLElement | null = null;
    let closedBy: 'cancel' | 'ran' = 'cancel';

    const t = (key: string, fallback: string) => app.t(key, fallback);
    const fold = (value: string) => foldLocalized(value, app.catalog.language);

    const activeEnvironment = $derived(app.environments.find((environment) => environment.id === app.activeTab?.envId));
    const activeIsRepl = $derived(activeEnvironment?.repl === true || activeEnvironment?.kind === 'repl');
    const hasActiveTab = $derived(Boolean(app.activeTabId));

    const pinned = $derived.by(() => {
        if (app.preferences?.ltoolsEnabled !== true || !ltoolsActions.length) return [];
        let stored: unknown = null;
        try {
            stored = JSON.parse(localStorage.getItem(ltoolsSelectionStorageKey(app.appInfo?.platform)) ?? 'null');
        } catch {
            stored = null;
        }
        return pinnedLToolsActions(ltoolsActions, stored).map((action) => ({
            id: action.id,
            description: action.description,
            displayLabel: ltoolsActionLabel(action, ltoolsActions),
            meta: ltoolsActionMeta(action),
            needsConfirmation: ltoolsActionNeedsConfirmation(action),
        }));
    });

    const entries = $derived(buildPaletteEntries({
        t,
        preferences: app.preferences,
        environments: app.environments,
        activeEnvId: app.activeTab?.envId ?? null,
        hasActiveTab,
        activeIsRepl,
        tabCount: app.tabs.length,
        paneCount: app.panes.length < 2 ? 1 : app.panes.length,
        themes: app.themes,
        fonts: app.fonts,
        languages: app.languages,
        ltoolsActions: pinned,
    }));

    const groupOrder = new Map(PALETTE_GROUPS.map((group, index) => [group.id, index]));
    /** Sin búsqueda se agrupa en el orden de `PALETTE_GROUPS`; con búsqueda
     *  manda la relevancia y cada fila lleva su grupo como etiqueta. */
    const visible = $derived.by(() => {
        const results = paletteResults(entries, query, { t, hasActiveTab, activeIsRepl }, fold);
        if (query.trim()) return results;
        return results
            .map((entry, index) => ({ entry, index }))
            .sort((left, right) => (groupOrder.get(left.entry.group) ?? 0) - (groupOrder.get(right.entry.group) ?? 0)
                || left.index - right.index)
            .map((item) => item.entry);
    });
    const grouped = $derived(!query.trim());
    const activeEntry = $derived(visible[selected] ?? null);
    /** Secciones del `listbox` (patrón de lista agrupada de WAI-ARIA): sin
     *  búsqueda, una por grupo; con búsqueda, una sola con todos los
     *  resultados. `index` es la posición en `visible`, que es la que recorren
     *  las flechas. */
    const sections = $derived.by(() => {
        const result: Array<{ key: string; label: string; items: Array<{ entry: PaletteEntry; index: number }> }> = [];
        visible.forEach((entry, index) => {
            const key = grouped ? entry.group : 'results';
            const last = result.at(-1);
            if (last && last.key === key) last.items.push({ entry, index });
            else result.push({ key, label: grouped ? groupLabel(entry.group) : '', items: [{ entry, index }] });
        });
        return result;
    });

    function groupLabel(id: PaletteGroupId): string {
        const group = PALETTE_GROUPS.find((candidate) => candidate.id === id);
        return group ? t(group.labelKey, group.fallback) : id;
    }

    function optionId(index: number): string {
        return `command-palette-option-${index}`;
    }

    // Cambiar la búsqueda vuelve a la primera fila y retira el aviso anterior.
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

    async function loadLTools(): Promise<void> {
        if (app.preferences?.ltoolsEnabled !== true) return;
        const language = app.catalog.language;
        if (ltoolsCache && ltoolsCache.language === language && Date.now() - ltoolsCache.at < LTOOLS_CACHE_MS) return;
        ltoolsLoading = true;
        try {
            const result = await api.listLToolsActions(language);
            const actions = result.available ? result.actions : [];
            ltoolsCache = { at: Date.now(), language, actions };
            ltoolsActions = actions;
        } catch (error) {
            // Sin LTools la paleta sigue sirviendo para todo lo demás.
            console.debug('[CommandPalette] catálogo de LTools no disponible', error);
        } finally {
            ltoolsLoading = false;
        }
    }

    async function run(entry: PaletteEntry | null): Promise<void> {
        if (!entry || running) return;
        if (entry.disabledReason) {
            status = entry.disabledReason;
            return;
        }
        running = true;
        status = '';
        try {
            const problem = await onRun(entry);
            if (problem) {
                status = problem;
                input?.focus();
                return;
            }
            closedBy = 'ran';
            onClose();
        } catch (error) {
            status = String(error);
        } finally {
            running = false;
        }
    }

    function close(): void {
        closedBy = 'cancel';
        onClose();
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            // Sin esto Escape también cerraría el panel que haya detrás.
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            void run(activeEntry);
            return;
        }
        if (event.key === 'Tab') {
            // El único control enfocable es el campo: Tab no debe escapar
            // hacia la terminal que hay detrás del diálogo.
            event.preventDefault();
            return;
        }
        const next = nextPaletteIndex(selected, event.key, visible.length);
        if (next !== null && (event.key.startsWith('Arrow') || event.key.startsWith('Page'))) {
            event.preventDefault();
            selected = Math.max(0, next);
        }
    }

    onMount(() => {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        input?.focus();
        void loadLTools();
        return () => {
            const reason = closedBy;
            const restore = previousFocus;
            // El diálogo ya no está: si la acción no se llevó el foco a otro
            // sitio (un panel, el buscador), se devuelve a la terminal activa
            // tras ejecutar, o a donde estaba al cancelar.
            requestAnimationFrame(() => {
                const current = document.activeElement;
                if (current && current !== document.body) return;
                if (reason === 'cancel' && restore?.isConnected && restore.offsetParent !== null) {
                    restore.focus();
                    return;
                }
                if (app.activeTabId) getTerminal(app.activeTabId)?.focus();
            });
        };
    });
</script>

<!-- `data-panel-toggle`: pulsar dentro de la paleta no cuenta como «fuera» del
     panel que pudiera estar abierto detrás (ver `Panel.svelte`). -->
<div
    class="palette-backdrop"
    data-panel-toggle
    role="presentation"
    onmousedown={(event) => {
        if (event.target === event.currentTarget) close();
    }}
>
    <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label={app.t('palette.title', 'Paleta de comandos')}
        data-testid="command-palette"
    >
        <input
            bind:this={input}
            bind:value={query}
            class="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={activeEntry ? optionId(selected) : undefined}
            aria-label={app.t('palette.title', 'Paleta de comandos')}
            placeholder={app.t('palette.placeholder', 'Busca una acción o escribe un comando interno que empiece por :')}
            spellcheck="false"
            autocomplete="off"
            data-testid="command-palette-input"
            onkeydown={onKeydown}
        />
        <div
            bind:this={list}
            id="command-palette-list"
            class="palette-list"
            role="listbox"
            aria-label={app.t('palette.title', 'Paleta de comandos')}
            data-testid="command-palette-list"
        >
            {#each sections as section (section.key)}
                <div
                    class="palette-section"
                    role="group"
                    aria-labelledby={section.label ? `command-palette-group-${section.key}` : undefined}
                    aria-label={section.label ? undefined : app.t('palette.title', 'Paleta de comandos')}
                >
                    {#if section.label}
                        <div class="palette-group" id={`command-palette-group-${section.key}`} role="presentation">{section.label}</div>
                    {/if}
                    {#each section.items as { entry, index } (entry.id)}
                        <div
                            id={optionId(index)}
                            class="palette-option"
                            class:active={index === selected}
                            class:disabled={Boolean(entry.disabledReason)}
                            role="option"
                            tabindex="-1"
                            aria-selected={index === selected}
                            aria-disabled={entry.disabledReason ? 'true' : undefined}
                            title={entry.disabledReason || entry.detail || undefined}
                            data-testid="command-palette-option"
                            data-palette-id={entry.id}
                            onmousemove={() => {
                                if (selected !== index) selected = index;
                            }}
                            onmousedown={(event) => event.preventDefault()}
                            onclick={() => {
                                selected = index;
                                void run(entry);
                            }}
                            onkeydown={onKeydown}
                        >
                            <span class="palette-text">
                                <span class="palette-label">{entry.label}{#if entry.current}<span class="palette-current">{app.t('palette.current', 'actual')}</span>{/if}</span>
                                {#if entry.detail || !grouped}
                                    <small class="palette-detail">{#if !grouped}<span class="palette-tag">{groupLabel(entry.group)}</span>{/if}{entry.detail}</small>
                                {/if}
                            </span>
                            {#if entry.command && entry.command !== entry.label}<code class="palette-command">{entry.command}</code>{/if}
                            {#if entry.shortcut}<kbd class="palette-shortcut">{entry.shortcut}</kbd>{/if}
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="palette-empty" role="presentation">{app.t('palette.empty', 'Ninguna acción coincide con la búsqueda.')}</div>
            {/each}
        </div>
        <div class="palette-footer">
            <span
                class="palette-status"
                class:error={Boolean(status)}
                role="status"
                aria-live="polite"
                data-testid="command-palette-status"
            >{status || (ltoolsLoading ? app.t('palette.ltoolsLoading', 'Cargando acciones de LTools…') : app.t('palette.resultCount', '{count} resultados').replace('{count}', String(visible.length)))}</span>
            <span class="palette-hint">{app.t('palette.hint', '↑↓ moverse · Intro ejecutar · Esc cerrar')}</span>
        </div>
    </div>
</div>

<style>
    .palette-backdrop {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 56px 16px 16px;
        background: rgba(0, 0, 0, 0.35);
    }

    .palette {
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

    .palette-input {
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

    .palette-input:focus-visible {
        box-shadow: inset 0 -2px 0 var(--accent);
    }

    .palette-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 4px 0;
    }

    .palette-group {
        padding: 8px 12px 3px;
        color: var(--muted);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        user-select: none;
    }

    .palette-option {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 5px 12px;
        cursor: pointer;
        border-left: 2px solid transparent;
    }

    .palette-option.active {
        background: var(--surface-hover);
        border-left-color: var(--accent);
    }

    .palette-option.disabled {
        cursor: default;
        opacity: 0.55;
    }

    .palette-text {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-width: 0;
    }

    .palette-label,
    .palette-detail {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .palette-detail {
        color: var(--muted);
        font-size: 11px;
    }

    .palette-tag {
        margin-right: 6px;
        color: var(--accent);
    }

    .palette-current {
        margin-left: 6px;
        padding: 0 5px;
        border: 1px solid var(--accent);
        border-radius: 3px;
        color: var(--accent);
        font-size: 10px;
    }

    .palette-command,
    .palette-shortcut {
        flex: 0 0 auto;
        max-width: 40%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--muted);
        font-family: var(--terminal-font);
        font-size: 11px;
    }

    .palette-shortcut {
        padding: 1px 5px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface-alt);
    }

    .palette-empty {
        padding: 14px 12px;
        color: var(--muted);
    }

    .palette-footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 4px 12px;
        padding: 6px 12px;
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 11px;
    }

    .palette-status.error {
        color: var(--warning);
    }

    @media (prefers-reduced-motion: no-preference) {
        .palette {
            animation: palette-in 0.12s ease-out;
        }
    }

    @keyframes palette-in {
        from {
            opacity: 0;
            transform: translateY(-6px);
        }
    }
</style>
