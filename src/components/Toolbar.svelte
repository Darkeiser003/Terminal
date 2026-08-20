<script lang="ts">
    // Barra superior: selector de entorno de la pestaña activa y accesos que la
    // versión Electron tenía en `#toolbar`. Los paneles de scripts, explorador,
    // proyectos y ajustes se añaden en las fases siguientes de la migración.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { Environment } from '../lib/types';

    interface Props {
        /** Se llama cuando el panel de dependencias pasa a estar abierto. La
         *  lista se vuelve a pedir CADA vez, no solo la primera: lo que el
         *  usuario haya instalado desde aquí mientras tanto debe dejar de
         *  ofrecerse como "Instalar" al volver a mirar. */
        onOpenDeps: () => void;
        /** Igual que el de dependencias: las preferencias se releen cada vez
         *  que se abre, porque el archivo puede haber cambiado por fuera. */
        onOpenSettings: () => void;
        /** El escaneo se rehace cada vez que se abre: la carpeta pudo cambiar
         *  desde fuera, y en «Aquí» la pestaña activa puede ser otra. */
        onOpenScripts: () => void;
        /** El estado se relee cada vez: la carpeta de proyectos pudo cambiar y
         *  lo clonado también. */
        onOpenProjects: () => void;
    }

    let { onOpenDeps, onOpenSettings, onOpenScripts, onOpenProjects }: Props = $props();

    /** El botón de Logs abre una carpeta con el gestor del sistema, y eso puede
     *  no existir en un Windows recortado. Sin esto, el clic no hacía nada y no
     *  se decía por qué. */
    let logsError = $state('');

    let envMenuOpen = $state(false);
    let envQuery = $state('');
    let langMenuOpen = $state(false);

    const flags: Record<string, string> = {
        auto: '🌐',
        en: '🇺🇸',
        es: '🇪🇸',
        fr: '🇫🇷',
        de: '🇩🇪',
        it: '🇮🇹',
        pt: '🇵🇹',
        ru: '🇷🇺',
        zh: '🇨🇳',
        ja: '🇯🇵',
        ko: '🇰🇷',
        uk: '🇺🇦',
        pl: '🇵🇱',
        ro: '🇷🇴',
        ar: '🇸🇦',
        hi: '🇮🇳'
    };

    const currentLang = $derived(app.preferences?.language ?? 'en');

    const languageOptions = $derived.by(() => {
        const available = app.languages.length > 0 ? app.languages : [
            { id: 'auto', label: 'Automático (sistema)', englishLabel: 'Automatic' },
            { id: 'en', label: 'English', englishLabel: 'English' },
            { id: 'es', label: 'Español', englishLabel: 'Spanish' },
            { id: 'fr', label: 'Français', englishLabel: 'French' },
            { id: 'de', label: 'Deutsch', englishLabel: 'German' },
            { id: 'it', label: 'Italiano', englishLabel: 'Italian' },
            { id: 'pt', label: 'Português', englishLabel: 'Portuguese' },
            { id: 'ru', label: 'Русский', englishLabel: 'Russian' },
            { id: 'zh', label: '中文', englishLabel: 'Chinese' },
            { id: 'ja', label: '日本語', englishLabel: 'Japanese' },
            { id: 'ko', label: '한국어', englishLabel: 'Korean' },
            { id: 'uk', label: 'Українська', englishLabel: 'Ukrainian' },
            { id: 'pl', label: 'Polski', englishLabel: 'Polish' },
            { id: 'ro', label: 'Română', englishLabel: 'Romanian' },
            { id: 'ar', label: 'العربية', englishLabel: 'Arabic' },
            { id: 'hi', label: 'हिन्दी', englishLabel: 'Hindi' }
        ];
        return available.map((item) => ({
            ...item,
            label: item.id === 'auto' ? app.t('settings.languageAuto', 'Automático (sistema)') : item.label,
            flag: flags[item.id] ?? '🌐'
        }));
    });

    async function selectLanguage(langId: string): Promise<void> {
        langMenuOpen = false;
        await app.savePreferences({ language: langId });
    }

    /** Los entornos agrupados como los pinta el desplegable, en el orden en
     *  que llegaron del backend. No usamos el `<select>` nativo: WebKitGTK
     *  abre su lista a todo el ancho de la ventana y no permite darle una
     *  apariencia coherente con el resto de la aplicación. */
    const grouped = $derived.by(() => {
        const groups = new Map<string, Environment[]>();
        const needle = envQuery.trim().toLocaleLowerCase();
        for (const env of app.environments) {
            if (needle && ![env.label, env.language ?? '', env.group].some((text) => text.toLocaleLowerCase().includes(needle))) continue;
            const list = groups.get(env.group);
            if (list) list.push(env);
            else groups.set(env.group, [env]);
        }
        return [...groups.entries()];
    });

    const favoriteIds = $derived(new Set((app.preferences?.favoriteReplIds ?? '').split(',').filter(Boolean)));
    const favoriteRepls = $derived(app.environments.filter((env) => env.repl && env.available && favoriteIds.has(env.id)));

    async function toggleFavorite(environment: Environment): Promise<void> {
        const next = new Set(favoriteIds);
        if (next.has(environment.id)) next.delete(environment.id);
        else if (next.size < 24) next.add(environment.id);
        await app.savePreferences({ favoriteReplIds: [...next].join(',') });
    }

    function translateGroup(group: string): string {
        if (group === 'Shells del sistema' || group === 'Shells') return app.t('group.system', 'Shells del sistema');
        if (group.startsWith('Lenguajes')) return app.t('group.languages', 'Lenguajes · intérprete interactivo');
        if (group.startsWith('WSL')) return app.t('group.wsl', 'WSL · distribuciones Linux');
        if (group.startsWith('Docker')) return app.t('group.docker', 'Docker · contenedores e imágenes');
        if (group.startsWith('Android')) return app.t('group.android', 'Android · dispositivos ADB');
        return group;
    }

    function translateLabel(label: string): string {
        return label
            .replace('(sin comprobar)', app.t('env.unverified', '(sin comprobar)'))
            .replace('(no instalada)', app.t('env.notInstalled', '(no instalada)'));
    }

    const currentEnvironment = $derived(
        app.environments.find((environment) => environment.id === app.activeTab?.envId)
    );

    const currentEnvironmentLabel = $derived(
        !app.environmentsLoaded
            ? app.t('env.detecting', 'Detectando entornos…')
            : translateLabel(currentEnvironment?.label ?? app.activeTab?.label ?? '')
    );

    async function selectEnvironment(environment: Environment): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId || !environment.available) return;
        envMenuOpen = false;
        await app.switchEnvironment(tabId, environment.id);
    }
</script>

<div class="toolbar">
    <div class="toolbar-group grow">
        <div class="env-container">
            <button
                type="button"
                class="env-select"
                class:open={envMenuOpen}
                disabled={!app.environmentsLoaded || !app.activeTabId}
                aria-haspopup="listbox"
                aria-expanded={envMenuOpen}
                title={app.t('toolbar.environment', 'Entorno de la pestaña activa')}
                onkeydown={(event) => {
                    if (event.key === 'Escape') envMenuOpen = false;
                }}
                onclick={(event) => {
                    event.stopPropagation();
                    langMenuOpen = false;
                    envMenuOpen = !envMenuOpen;
                }}
            >
                <span class="env-current">{currentEnvironmentLabel}</span>
                <span class="env-chevron" aria-hidden="true">
                    <svg viewBox="0 0 12 12" width="12" height="12">
                        <path d="M2.25 4.25 6 8l3.75-3.75" />
                    </svg>
                </span>
            </button>

            {#if envMenuOpen}
                <div
                    class="env-backdrop"
                    onmousedown={() => (envMenuOpen = false)}
                    role="presentation"
                ></div>
                <div
                    class="env-menu"
                    role="listbox"
                    aria-label={app.t('toolbar.environment', 'Entorno de la pestaña activa')}
                >
                    <label class="env-search">
                        <span aria-hidden="true">⌕</span>
                        <input bind:value={envQuery} placeholder={app.t('env.search', 'Buscar shell o REPL…')} autocomplete="off" />
                    </label>
                    {#each grouped as [group, envs] (group)}
                        <section class="env-group">
                            <div class="env-group-title">{translateGroup(group)}</div>
                            {#each envs as environment (environment.id)}
                                <div
                                    role="option"
                                    tabindex={environment.available ? 0 : -1}
                                    class="env-item"
                                    class:selected={environment.id === app.activeTab?.envId}
                                    aria-disabled={!environment.available}
                                    aria-selected={environment.id === app.activeTab?.envId}
                                    title={translateLabel(environment.note ?? environment.label)}
                                    onclick={() => void selectEnvironment(environment)}
                                    onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') void selectEnvironment(environment); }}
                                >
                                    <span
                                        class="env-status"
                                        class:available={environment.available}
                                        aria-hidden="true"
                                    ></span>
                                    <span class="env-copy">
                                        <strong>{translateLabel(environment.label)}</strong>
                                        {#if environment.note && !environment.available}
                                            <small>{translateLabel(environment.note)}</small>
                                        {/if}
                                    </span>
                                    {#if environment.id === app.activeTab?.envId}
                                        <span class="env-check" aria-hidden="true">✓</span>
                                    {/if}
                                    {#if environment.repl && environment.available}
                                        <button type="button" class="env-favorite" class:selected={favoriteIds.has(environment.id)} title={app.t('env.favorite', 'Fijar REPL')} onclick={(event) => { event.stopPropagation(); void toggleFavorite(environment); }}>★</button>
                                    {/if}
                                </div>
                            {/each}
                        </section>
                    {/each}
                </div>
            {/if}
        </div>

        <button
            type="button"
            class="icon"
            title={app.t('env.refresh', 'Volver a detectar entornos')}
            onclick={() => app.refreshEnvironments()}
        >⟳</button>
        {#each favoriteRepls as environment (environment.id)}
            <button type="button" class="repl-favorite" title={`Abrir ${environment.label}`} onclick={() => app.createTab(environment.id)}>★ {environment.label.replace(' · REPL', '')}</button>
        {/each}
    </div>

    <div class="toolbar-group">
        {#if app.preferences?.showProjectsPanel !== false}<button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('projects')}
            onclick={() => {
                if (panels.toggle('projects')) onOpenProjects();
            }}
        >
            {app.t('toolbar.projects', 'Proyectos')}
        </button>{/if}

        {#if app.preferences?.showScriptsPanel !== false}<button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('scripts')}
            onclick={() => {
                if (panels.toggle('scripts')) onOpenScripts();
            }}
        >
            {app.t('toolbar.scripts', 'Biblioteca')}
        </button>{/if}

        {#if app.preferences?.showDependenciesPanel !== false}<button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('deps')}
            onclick={() => {
                if (panels.toggle('deps')) onOpenDeps();
            }}
        >
            {app.t('toolbar.deps', 'Entorno y dependencias')}
        </button>{/if}

        <button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('settings')}
            onclick={() => {
                if (panels.toggle('settings')) onOpenSettings();
            }}
        >
            {app.t('toolbar.settings', 'Ajustes')}
        </button>

        {#if logsError}
            <span class="notice" role="status">{logsError}</span>
        {/if}
        <button
            type="button"
            onclick={async () => {
                logsError = '';
                // Devuelve la ruta si la abrió, y nada si no pudo.
                const opened = await api.openLogFolder();
                if (!opened) {
                    logsError = app.t(
                        'toolbar.logsFailed',
                        'No se pudo abrir la carpeta de registros.'
                    );
                }
            }}
        >
            {app.t('toolbar.logs', 'Logs')}
        </button>

        <!-- Selector rápido de idioma -->
        <div class="lang-container">
            <button
                type="button"
                class="icon lang-btn"
                class:active={langMenuOpen}
                title={app.t('toolbar.language', 'Cambiar idioma')}
                onclick={(e) => {
                    e.stopPropagation();
                    envMenuOpen = false;
                    langMenuOpen = !langMenuOpen;
                }}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
                    <path
                        d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.5 8a5.48 5.48 0 0 1 1.05-3.25h8.9a5.48 5.48 0 0 1 1.05 3.25 5.48 5.48 0 0 1-1.05 3.25h-8.9A5.48 5.48 0 0 1 2.5 8zM8 2.6c1.1 1.45 1.75 3.4 1.75 5.4S9.1 11.95 8 13.4C6.9 11.95 6.25 10 6.25 8S6.9 3.4 8 2.6z"
                        fill="currentColor"
                    />
                </svg>
            </button>

            {#if langMenuOpen}
                <div
                    class="lang-backdrop"
                    onmousedown={() => (langMenuOpen = false)}
                    role="presentation"
                ></div>
                <div class="lang-menu" role="menu">
                    {#each languageOptions as item (item.id)}
                        <button
                            type="button"
                            role="menuitem"
                            class="lang-item"
                            class:selected={currentLang === item.id}
                            onclick={() => void selectLanguage(item.id)}
                        >
                            <span class="flag-icon">{item.flag}</span>
                            <span class="lang-label">{item.label}</span>
                            {#if currentLang === item.id}
                                <span class="check-mark">✓</span>
                            {/if}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .toolbar {
        display: flex;
        /* Es una fila estructural del layout, no contenido flexible. Con el
           `flex-shrink: 1` implícito, abrir un explorador con mucho contenido
           podía quitarle altura y recortar los botones por arriba y abajo. */
        flex: 0 0 40px;
        align-items: center;
        gap: 8px;
        height: 40px;
        min-height: 40px;
        padding: 0 10px;
        background: var(--surface-alt);
        border-bottom: 1px solid var(--border);
        color: var(--text);
        font-size: 12px;
    }

    /* Los botones no se encogen ni se salen de la ventana: el que cede espacio
       al estrechar la ventana es el selector de entorno. */
    .toolbar-group {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
    }

    /* base 0 (no "auto"): con base automática, el ancho del <select> lo fija su
       opción más larga (los nombres de imagen de Docker son enormes) y la barra
       se salía de la ventana empujando el resto fuera de la pantalla. */
    .toolbar-group.grow {
        flex: 1 1 0;
        min-width: 0;
        /* El texto ya se recorta dentro de `.env-current`; dejar visible el
           desbordamiento permite que la lista flotante salga bajo la barra. */
        overflow: visible;
    }

    .env-select {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex: 1 1 0;
        width: 100%;
        min-width: 40px;
        gap: 8px;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        text-align: left;
    }

    .env-container {
        position: relative;
        display: flex;
        flex: 1 1 0;
        min-width: 0;
    }

    .env-current {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .env-chevron {
        display: grid;
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        place-items: center;
        color: var(--muted);
        transition: transform 0.15s ease;
    }

    .env-chevron svg {
        display: block;
        overflow: visible;
    }

    .env-chevron path {
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.4;
    }

    .env-select.open .env-chevron {
        transform: rotate(180deg);
    }

    .env-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
    }

    .env-menu {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 61;
        width: clamp(300px, 42vw, 480px);
        max-width: calc(100vw - 20px);
        max-height: min(70vh, 480px);
        overflow-x: hidden;
        overflow-y: auto;
        padding: 5px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
    }

    .env-group + .env-group {
        margin-top: 4px;
        padding-top: 4px;
        border-top: 1px solid var(--border);
    }

    .env-search {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 2px 2px 6px;
        padding: 5px 7px;
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--muted);
        background: var(--surface-alt);
    }

    .env-search input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        color: var(--text);
        background: transparent;
    }

    .env-group-title {
        padding: 5px 8px 4px;
        color: var(--muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.035em;
        text-transform: uppercase;
    }

    .env-item {
        display: flex;
        align-items: center;
        width: 100%;
        gap: 8px;
        padding: 6px 8px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        text-align: left;
    }

    .env-item:hover:not([aria-disabled="true"]) {
        border-color: var(--border);
        background: var(--surface-hover);
    }

    .env-item.selected {
        border-color: var(--accent);
        background: var(--accent-soft);
    }

    .env-item[aria-disabled="true"] {
        cursor: not-allowed;
        opacity: 0.58;
    }

    .env-favorite {
        flex: 0 0 auto;
        padding: 2px 4px;
        border: 0;
        color: var(--muted);
        background: transparent;
    }

    .env-favorite.selected { color: #f2c94c; }

    .repl-favorite {
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #f2c94c;
    }

    .env-status {
        width: 6px;
        height: 6px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--muted);
    }

    .env-status.available {
        background: #54d6b0;
        box-shadow: 0 0 0 2px rgba(84, 214, 176, 0.1);
    }

    .env-copy {
        display: flex;
        min-width: 0;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 2px;
    }

    .env-copy strong,
    .env-copy small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .env-copy strong {
        font-size: 11px;
        font-weight: 600;
    }

    .env-copy small {
        color: var(--muted);
        font-size: 9px;
    }

    .env-check {
        flex: 0 0 auto;
        color: var(--accent);
        font-weight: 700;
    }

    button {
        padding: 4px 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
    }

    button:hover {
        background: var(--surface-hover);
        border-color: var(--accent);
    }

    /* El botón del panel abierto se queda marcado: con la caja flotando sobre
       la terminal, es lo único que dice de dónde ha salido. */
    button.active {
        background: var(--accent-soft);
        border-color: var(--accent);
    }

    button.icon {
        padding: 4px 8px;
    }

    .notice {
        color: #e06c75;
        font-size: 11px;
    }

    .lang-container {
        position: relative;
        display: inline-flex;
    }

    .lang-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px 6px;
    }

    .lang-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
    }

    .lang-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 61;
        display: flex;
        flex-direction: column;
        min-width: 175px;
        padding: 4px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .lang-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        transition: background 0.15s ease;
    }

    .lang-item:hover {
        background: var(--surface-hover);
    }

    .lang-item.selected {
        background: var(--accent-soft);
        font-weight: 600;
        color: var(--text);
    }

    .flag-icon {
        font-size: 14px;
        line-height: 1;
    }

    .lang-label {
        flex: 1 1 auto;
    }

    .check-mark {
        font-size: 12px;
        color: var(--accent);
    }
</style>
