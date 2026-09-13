<script lang="ts">
    // Panel de proyectos y repositorios de GitHub.
    //
    // Port del `#projects-panel` de `electron/renderer`, con un modo más:
    // «Descargados», que enseña lo que ya está clonado en el disco recorriendo
    // la carpeta de proyectos. Ese modo no consulta a GitHub, así que funciona
    // sin red y sin gastar el límite de consultas públicas.
    //
    // Los tres modos comparten la misma fila de repositorio, y las acciones se
    // reparten entre las dos habituales (visibles) y el resto (en un plegable):
    // cinco botones por fila no caben cuando el panel se estrecha.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { LocalRepository, ProjectsState, PublicRepository, Release } from '../lib/types';
    import Panel from './Panel.svelte';

    type Mode = 'pinned' | 'downloaded' | 'explore';

    let mode = $state<Mode>('pinned');
    /** No se puede llamar `state`: en Svelte `$state` pasaria a ser la
     *  suscripcion al store `state` en vez de la runa. */
    let projects = $state<ProjectsState | null>(null);
    let downloaded = $state<LocalRepository[]>([]);
    let found = $state<PublicRepository[]>([]);
    let target = $state('');
    let query = $state('');
    let status = $state('');
    let statusError = $state(false);
    let loading = $state(false);
    let busy = $state('');
    /** La release consultada de un repositorio, para poder elegir su adjunto. */
    let release = $state<{ fullName: string; release: Release | null } | null>(null);
    /** Filas con el plegable de acciones abierto. La preferencia de acordeón
     *  se aplica también aquí: con exclusividad se conserva una sola; si se
     *  desactiva, varias filas pueden permanecer abiertas. */
    let expanded = $state<string[]>([]);
    const exclusiveGroups = $derived(app.preferences?.exclusiveAccordionGroups ?? false);
    let loadSerial = 0;

    function toggleExpanded(fullName: string): void {
        if (expanded.includes(fullName)) {
            expanded = expanded.filter((value) => value !== fullName);
        } else {
            expanded = exclusiveGroups ? [fullName] : [...expanded, fullName];
        }
    }

    export async function load(next?: Mode): Promise<void> {
        if (next) mode = next;
        const serial = ++loadSerial;
        loading = true;
        statusError = false;
        status = '';
        try {
            if (mode === 'downloaded') {
                const nextDownloaded = await api.listDownloadedProjects();
                // El estado hace falta igualmente: de ahí sale la carpeta que se
                // enseña en la cabecera.
                const nextProjects = projects ?? await api.getProjectsState();
                if (serial !== loadSerial) return;
                downloaded = nextDownloaded;
                projects = nextProjects;
            } else {
                const nextProjects = await api.getProjectsState();
                if (serial !== loadSerial) return;
                projects = nextProjects;
            }
        } catch (cause) {
            if (serial !== loadSerial) return;
            statusError = true;
            status = String(cause);
        } finally {
            if (serial === loadSerial) loading = false;
        }
    }

    async function search(): Promise<void> {
        if (!target.trim() || loading) return;
        loading = true;
        statusError = false;
        try {
            const result = await api.lookupProject(target.trim());
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('projects.lookupFailed', 'No se pudo consultar GitHub.');
                found = [];
                return;
            }
            found = result.repositories;
            const quedan = result.rateLimit?.remaining;
            status = app
                .t('projects.found', '{count} repositorios · consultas públicas restantes: {rate}')
                .replace('{count}', String(found.length))
                .replace('{rate}', quedan === null || quedan === undefined ? '—' : String(quedan));
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            loading = false;
        }
    }

    /** Abre en «Explorar GitHub» los repositorios públicos de un perfil.
     *  Ese es el punto de anclar un perfil: no es un repositorio que clonar,
     *  es un atajo a lo que publica alguien. */
    async function browseOwner(login: string): Promise<void> {
        if (loading) return;
        mode = 'explore';
        target = login;
        query = '';
        await search();
    }

    function matches(text: string): boolean {
        const needle = query.trim().toLowerCase();
        return !needle || text.toLowerCase().includes(needle);
    }

    const pinnedVisible = $derived(
        (projects?.repositories ?? []).filter((repo) =>
            matches(`${repo.fullName} ${repo.description} ${repo.language}`)
        )
    );
    /** Perfiles que el usuario ha anclado desde GitHub. Los créditos del
     *  proyecto viven en Ajustes > Información y no ensucian esta lista. */
    const ownersVisible = $derived((projects?.owners ?? []).filter((owner) => matches(owner.login)));
    const downloadedVisible = $derived(
        downloaded.filter((repo) => matches(`${repo.fullName} ${repo.path}`))
    );
    const exploreVisible = $derived(
        found.filter((repo) => matches(`${repo.fullName} ${repo.description} ${repo.language}`))
    );

    const count = $derived(
        mode === 'pinned'
            ? ownersVisible.length + pinnedVisible.length
            : mode === 'downloaded'
              ? downloadedVisible.length
              : exploreVisible.length
    );

    async function act(
        fullName: string,
        accion: () => Promise<{ ok: boolean; error?: string; tabId?: string; created?: boolean }>
    ): Promise<void> {
        if (busy) return;
        busy = fullName;
        statusError = false;
        try {
            const result = await accion();
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('projects.failed', 'No se pudo completar la acción.');
                return;
            }
            if (result.tabId) {
                panels.close();
                await app.adoptTab(result.tabId, result.created === true);
            }
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            busy = '';
        }
    }

    async function showRelease(fullName: string): Promise<void> {
        if (busy) return;
        busy = fullName;
        statusError = false;
        try {
            const result = await api.getLatestRelease(fullName);
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('projects.releaseFailed', 'No se pudo consultar la release.');
                return;
            }
            release = { fullName, release: result.release ?? null };
            if (!result.release) {
                status = app.t('projects.noRelease', 'Ese repositorio no tiene releases publicadas.');
            }
        } catch (cause) {
            // Un fallo de red no debe convertirse en una promesa rechazada sin
            // dueño: además de dejar un error global, la interfaz se quedaba
            // sin explicación aunque `busy` sí volviera a liberarse.
            statusError = true;
            status = String(cause);
        } finally {
            busy = '';
        }
    }

    /** Fecha corta y local. Un ISO crudo en una lista no lo lee nadie. */
    function fecha(millis: number): string {
        return new Date(millis).toLocaleDateString(app.catalog.language, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    const modes: { id: Mode; label: string }[] = $derived([
        { id: 'pinned', label: app.t('projects.pinned', 'Anclados') },
        { id: 'downloaded', label: app.t('projects.downloaded', 'Descargados') },
        { id: 'explore', label: app.t('projects.explore', 'Explorar GitHub') }
    ]);
</script>

<Panel
    id="projects"
    title={projects?.brand ?? app.t('toolbar.projects', 'Proyectos')}
    subtitle={statusError
        ? status
        : loading
          ? app.t('projects.loading', 'Consultando…')
          : status || (projects?.projectsFolder ?? '')}
    error={statusError}
    {count}
    width={480}
>
    {#snippet header()}
        <div class="modes" role="tablist">
            {#each modes as tab (tab.id)}
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === tab.id}
                    class:active={mode === tab.id}
                    onclick={() => load(tab.id)}
                >
                    {tab.label}
                </button>
            {/each}
        </div>
    {/snippet}

    <div class="toolbar">
        <span class="path" title={projects?.projectsFolder ?? ''}>{projects?.projectsFolder ?? ''}</span>
        <button
            type="button"
            class="icon"
            title={app.t('projects.chooseFolder', 'Elegir la carpeta de proyectos')}
            onclick={async () => {
                projects = await api.chooseProjectsFolder();
                if (mode === 'downloaded') await load();
            }}
        >
            <!-- Igual que el del explorador: el emoji de carpeta desentonaba
                 (color propio, tamaño propio) entre botones monocromos. -->
            <svg viewBox="0 0 16 16" aria-hidden="true" class="glyph">
                <path
                    d="M1.5 3.5h4l1.4 1.6h7.6v7.4H1.5z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                />
            </svg>
        </button>
        <button type="button" class="icon" title={app.t('projects.refresh', 'Volver a mirar')} onclick={() => load()}>⟳</button>
    </div>

    {#if mode === 'explore'}
        <div class="search">
            <input
                type="text"
                bind:value={target}
                placeholder={app.t('projects.targetPlaceholder', 'Usuario, owner/repo o URL de GitHub')}
                onkeydown={(event) => event.key === 'Enter' && search()}
            />
            <button type="button" onclick={search} disabled={loading}>
                {app.t('projects.search', 'Buscar')}
            </button>
        </div>
    {/if}

    <div class="filter">
        <span aria-hidden="true">🔍</span>
        <input
            type="text"
            bind:value={query}
            placeholder={app.t('projects.filterPlaceholder', 'Filtrar por nombre, propietario o lenguaje')}
        />
        {#if query}
            <button type="button" class="icon" onclick={() => (query = '')}>✕</button>
        {/if}
    </div>

    {#if loading}
        <div class="empty">{app.t('projects.loading', 'Consultando…')}</div>
    {:else if mode === 'pinned'}
        <!-- Perfiles primero y repositorios después: un perfil lleva a varios
             repositorios, así que es el nivel de arriba. -->
        {#each ownersVisible as owner (owner.login)}
            <div class="item owner">
                <div class="item-row">
                    <span class="name">
                        <strong>{owner.login}</strong>
                        {#if owner.projectLead}
                            <small class="tag">{app.t('projects.projectLeadCreator', 'Creador de WinSlim · Director de proyectos')}</small>
                        {:else if owner.developer}
                            <small class="tag">{app.t('projects.developer', 'Desarrollador')}</small>
                        {:else if owner.official}
                            <small class="tag">{app.t('projects.official', 'Proyecto')}</small>
                        {/if}
                    </span>
                    <div class="actions">
                        <button
                            type="button"
                            class="run"
                            disabled={loading}
                            onclick={() => browseOwner(owner.login)}
                        >
                            {app.t('projects.viewRepos', 'Ver repos')}
                        </button>
                        <button
                            type="button"
                            class="icon"
                            title={app.t('projects.github', 'GitHub')}
                            onclick={() => api.openInGithub(owner.login)}
                        >↗</button>
                        {#if !owner.locked}
                            <button
                                type="button"
                                class="icon"
                                title={app.t('projects.unpin', 'Desanclar')}
                                onclick={async () => {
                                    const result = await api.pinProject('owner', owner.login, false);
                                    if (result.state) projects = result.state;
                                }}
                            >✕</button>
                        {/if}
                    </div>
                </div>
            </div>
        {/each}

        {#each pinnedVisible as repo (repo.fullName)}
            {@render row(
                repo.fullName,
                repo.description || repo.language,
                repo.local,
                repo.localConflict,
                repo.localPath
            )}
        {:else}
            {#if ownersVisible.length === 0}
                <div class="empty">
                    {app.t(
                        'projects.noPins',
                        'No hay proyectos anclados.'
                    )}
                </div>
            {/if}
        {/each}
    {:else if mode === 'downloaded'}
        {#each downloadedVisible as repo (repo.fullName)}
            {@render row(
                repo.fullName,
                `${fecha(repo.modified)} · ${repo.path}`,
                true,
                false,
                repo.path
            )}
        {:else}
            <div class="empty">
                {app.t(
                    'projects.noDownloaded',
                    'Todavía no hay nada clonado. Ancla un repositorio o búscalo en GitHub y clónalo.'
                )}
            </div>
        {/each}
    {:else}
        {#each exploreVisible as repo (repo.fullName)}
            {@render row(
                repo.fullName,
                repo.description || repo.language,
                repo.local,
                repo.localConflict,
                repo.localPath
            )}
        {:else}
            <div class="empty">
                {found.length
                    ? app.t('projects.noFilterMatch', 'Ningún repositorio coincide con el filtro.')
                    : app.t('projects.searchHint', 'Busca un usuario o un repositorio para empezar.')}
            </div>
        {/each}
    {/if}

    {#if release?.release}
        <div class="release">
            <strong>{release.fullName} · {release.release.tag}</strong>
            {#each release.release.assets as asset (asset.name)}
                <button
                    type="button"
                    disabled={busy !== ''}
                    onclick={() =>
                        app.activeTabId &&
                        act(release!.fullName, () =>
                            api.downloadRelease(app.activeTabId!, release!.fullName, asset.name)
                        )}
                >
                    {asset.name}
                </button>
            {:else}
                <span class="hint">{app.t('projects.noAssets', 'Esta release no trae adjuntos.')}</span>
            {/each}
        </div>
    {/if}
</Panel>

{#snippet row(
    fullName: string,
    meta: string,
    local: boolean,
    conflict: boolean,
    localPath: string
)}
    <div class="item">
        <div class="item-row">
            <span class="name">
                <strong>{fullName}</strong>
                {#if meta}<small>{meta}</small>{/if}
                {#if conflict}
                    <small class="warn">
                        {app.t('projects.conflict', 'La carpeta de destino existe y no es un repositorio.')}
                    </small>
                {/if}
            </span>
            <div class="actions">
                <!-- Las dos habituales a la vista; el resto en el plegable. Con
                     los cinco botones en la fila, el panel estrecho los partía
                     en tres líneas por repositorio. -->
                <button
                    type="button"
                    class="run"
                    disabled={busy !== '' || !app.activeTabId}
                    onclick={() => app.activeTabId && act(fullName, () => api.runProject(app.activeTabId!, fullName))}
                >
                    {busy === fullName
                        ? app.t('projects.working', 'Trabajando…')
                        : local
                          ? app.t('projects.update', 'Actualizar')
                          : app.t('projects.clone', 'Clonar')}
                </button>
                {#if local}
                    <button
                        type="button"
                        class="icon"
                        title={app.t('projects.cd', 'Ir a su carpeta en la terminal')}
                        disabled={busy !== '' || !app.activeTabId}
                        onclick={() => app.activeTabId && act(fullName, () => api.cdToProject(app.activeTabId!, fullName))}
                    >cd</button>
                {/if}
                <button
                    type="button"
                    class="icon"
                    title={app.t('projects.more', 'Más acciones')}
                    onclick={() => toggleExpanded(fullName)}
                >⋯</button>
            </div>
        </div>

        {#if expanded.includes(fullName)}
            <div class="more">
                <button type="button" onclick={() => api.openInGithub(fullName)}>
                    {app.t('projects.github', 'GitHub')}
                </button>
                <button type="button" disabled={busy !== ''} onclick={() => showRelease(fullName)}>
                    {app.t('projects.release', 'Release')}
                </button>
                {#if mode !== 'downloaded'}
                    <button
                        type="button"
                        onclick={async () => {
                            const result = await api.pinProject('repo', fullName, !projects?.repositories.some((r) => r.fullName === fullName));
                            if (result.state) projects = result.state;
                        }}
                    >
                        {projects?.repositories.some((r) => r.fullName === fullName)
                            ? app.t('projects.unpin', 'Desanclar')
                            : app.t('projects.pin', 'Anclar')}
                    </button>
                {/if}
                {#if local}
                    <!-- La carpeta del repositorio, no la que tenga abierta el
                         explorador: sin `localPath` esto abría una carpeta que
                         no tenía nada que ver con la fila pulsada. -->
                    <button
                        type="button"
                        title={app.t('projects.openFolderTitle', 'Abrir la carpeta en el gestor de archivos')}
                        onclick={async () => {
                            if (!app.activeTabId) return;
                            const result = await api.openDirectory(app.activeTabId, localPath);
                            if (!result.ok) {
                                statusError = true;
                                status =
                                    result.error ??
                                    app.t('projects.openFolderFailed', 'No se pudo abrir la carpeta.');
                            }
                        }}
                    >
                        {app.t('projects.openFolder', 'Carpeta')}
                    </button>
                {/if}
            </div>
        {/if}
    </div>
{/snippet}

<style>
    .modes {
        position: sticky;
        top: 38px;
        z-index: 3;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 4px;
        padding: 7px 0;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
    }

    .modes button {
        min-width: 0;
        padding: 6px 5px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 11px;
        line-height: 1.2;
        overflow-wrap: anywhere;
        white-space: normal;
        cursor: pointer;
    }

    @container (max-width: 360px) {
        .modes {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .toolbar,
        .search,
        .filter {
            align-items: stretch;
            flex-wrap: wrap;
        }

        .search input,
        .filter input {
            flex-basis: 100%;
        }
    }

    .modes button:hover {
        border-color: var(--border);
        color: var(--text);
    }

    .modes button.active {
        border-color: var(--accent);
        background: var(--accent-soft);
        color: var(--text);
        font-weight: 700;
    }

    .toolbar,
    .search,
    .filter {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 2px;
    }

    .path {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        color: var(--muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .search input,
    .filter input {
        flex: 1 1 auto;
        min-width: 0;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
    }

    .item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        border-top: 1px solid var(--border);
    }

    .item:hover {
        background: var(--surface-hover);
    }

    /* Igual que en los otros paneles: los botones bajan a su propia línea antes
       que comprimir el nombre hasta taparlo. */
    .item-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 6px 8px;
    }

    .name {
        display: flex;
        flex: 1 1 auto;
        min-width: 160px;
        flex-direction: column;
        gap: 1px;
        overflow-wrap: anywhere;
    }

    .name strong {
        color: var(--text);
        font-size: 12px;
    }

    .name small {
        color: var(--muted);
        font-size: 10px;
    }

    .name small.warn {
        color: var(--warning);
    }

    /* Un perfil no es un repositorio: la marca de la izquierda distingue las dos
       clases de anclado sin necesidad de otro encabezado. */
    .item.owner {
        border-left: 2px solid var(--accent-soft);
    }

    .name small.tag {
        align-self: flex-start;
        padding: 0 4px;
        border-radius: 3px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 9px;
        text-transform: uppercase;
    }

    .actions,
    .more {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
    }

    .more {
        padding-top: 2px;
    }

    .release {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 6px;
        padding: 8px;
        border: 1px solid var(--accent);
        border-radius: 5px;
        background: var(--surface-alt);
    }

    .release strong {
        font-size: 11px;
    }

    button {
        padding: 3px 9px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
    }

    button:hover:not(:disabled) {
        border-color: var(--accent);
        background: var(--surface-hover);
    }

    button:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .icon {
        padding: 3px 6px;
    }

    /* El icono dibujado se alinea con el texto de los botones de al lado, que es
       lo que un emoji no hacía. */
    .glyph {
        display: block;
        width: 13px;
        height: 13px;
    }

    .run {
        border-color: var(--accent);
        background: var(--accent-soft);
        font-weight: 600;
    }

    .hint,
    .empty {
        color: var(--muted);
        font-size: 11px;
    }

    .empty {
        padding: 12px 8px;
        font-size: 12px;
    }
</style>
