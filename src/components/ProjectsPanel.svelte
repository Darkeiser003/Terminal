<script lang="ts">
    // Panel de proyectos y repositorios de GitHub.
    //
    // Port del `#projects-panel` de `electron/renderer`, con un modo más:
    // «Descargados», que enseña lo que ya está clonado en el disco recorriendo
    // la carpeta de proyectos. Ese modo no consulta a GitHub, así que funciona
    // sin red y sin gastar el límite de consultas públicas.
    //
    // Los modos comparten la misma fila de repositorio, y las acciones se
    // reparten entre las dos habituales (visibles) y el resto (en un plegable):
    // cinco botones por fila no caben cuando el panel se estrecha.
    //
    // «Mi GitHub» trabaja con la cuenta de GitHub CLI (`gh`): iniciar sesión
    // con el navegador en una terminal visible, crear repositorios y cambiar
    // su visibilidad, archivarlos, renombrarlos o borrarlos. WTerminal no
    // guarda tokens: la sesión es la de `gh`.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { GhRepositoryChange, GhResult, GhStatus, GhTerminalAction, LocalRepository, OwnRepository, ProjectsState, PublicRepository, Release } from '../lib/types';
    import GithubRepoManager from './GithubRepoManager.svelte';
    import Panel from './Panel.svelte';

    type Mode = 'pinned' | 'downloaded' | 'explore' | 'github';

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
    /** «Mi GitHub»: sesión de `gh`, repositorios de la cuenta y formularios. */
    let gh = $state<GhStatus | null>(null);
    let own = $state<OwnRepository[]>([]);
    let createOpen = $state(false);
    let newName = $state('');
    let newDescription = $state('');
    let newVisibility = $state<'private' | 'public'>('private');
    let newReadme = $state(true);
    let newClone = $state(false);
    let renameTarget = $state('');
    let renameValue = $state('');
    let deleteTarget = $state('');
    /** El repositorio de la cuenta con «Gestionar…» abierto (uno a la vez). */
    let manageTarget = $state('');
    let deleteConfirm = $state('');
    let needsDeleteScope = $state(false);
    const exclusiveGroups = $derived(app.preferences?.exclusiveAccordionGroups ?? false);
    let loadSerial = 0;

    function toggleExpanded(fullName: string): void {
        if (expanded.includes(fullName)) {
            expanded = expanded.filter((value) => value !== fullName);
            if (release?.fullName === fullName) release = null;
        } else {
            expanded = exclusiveGroups ? [fullName] : [...expanded, fullName];
        }
    }

    export async function load(next?: Mode): Promise<void> {
        if (next) mode = next;
        const serial = ++loadSerial;
        // Cambiar de pestaña o volver a mirar cierra la release abierta: antes
        // se quedaba al pie del panel en todas las pestañas. Lo mismo con
        // «Gestionar…».
        release = null;
        manageTarget = '';
        loading = true;
        statusError = false;
        status = '';
        try {
            if (mode === 'github') {
                const nextStatus = await api.githubCliStatus();
                const nextOwn = nextStatus.loggedIn ? await api.githubCliRepositories() : [];
                const nextProjects = projects ?? await api.getProjectsState();
                if (serial !== loadSerial) return;
                gh = nextStatus;
                own = nextOwn;
                projects = nextProjects;
            } else if (mode === 'downloaded') {
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
        release = null;
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
    const ownVisible = $derived(
        own.filter((repo) => matches(`${repo.fullName} ${repo.description} ${repo.language}`))
    );

    const count = $derived(
        mode === 'pinned'
            ? ownersVisible.length + pinnedVisible.length
            : mode === 'downloaded'
              ? downloadedVisible.length
              : mode === 'github'
                ? ownVisible.length
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

    /** «Release» abre la última release del repositorio bajo su fila; volver a
     *  pulsarlo la cierra (y abrir la de otro repositorio cierra esta). */
    async function showRelease(fullName: string): Promise<void> {
        if (busy) return;
        if (release?.fullName === fullName) {
            release = null;
            return;
        }
        release = null;
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

    /** Lo que se hace con `gh` sin terminal: crear, cambiar, renombrar y
     *  borrar. Con éxito se vuelve a listar la cuenta. */
    async function runGh(label: string, operation: () => Promise<GhResult>, done: string): Promise<boolean> {
        if (busy) return false;
        busy = label;
        statusError = false;
        try {
            const result = await operation();
            needsDeleteScope = result.needsDeleteScope;
            statusError = !result.ok;
            status = result.ok ? done : result.message;
            if (result.ok) own = await api.githubCliRepositories();
            return result.ok;
        } catch (cause) {
            statusError = true;
            status = String(cause);
            return false;
        } finally {
            busy = '';
        }
    }

    /** Iniciar o cerrar sesión, o pedir el permiso de borrar: en una pestaña
     *  nueva, a la vista, porque `gh` abre el navegador y pregunta. */
    async function ghTerminal(action: GhTerminalAction): Promise<void> {
        if (!app.activeTabId) return;
        await act('github', () => api.githubCliTerminal(app.activeTabId!, action));
    }

    function installGh(): void {
        window.dispatchEvent(new CustomEvent('winslim:open-panel', { detail: { panel: 'deps', query: 'GitHub CLI' } }));
    }

    async function createRepository(): Promise<void> {
        const name = newName.trim();
        const owner = gh?.account;
        const created = await runGh(
            'create',
            () => api.githubCliCreate(name, newDescription, newVisibility === 'private', newReadme),
            app.t('projects.ghCreated', 'Repositorio {name} creado.').replace('{name}', name),
        );
        if (!created) return;
        createOpen = false;
        newName = '';
        newDescription = '';
        if (newClone && owner && app.activeTabId) {
            await act(`${owner}/${name}`, () => api.runProject(app.activeTabId!, `${owner}/${name}`));
        }
    }

    async function changeRepository(fullName: string, change: GhRepositoryChange): Promise<void> {
        await runGh(fullName, () => api.githubCliChange(fullName, change), app.t('projects.ghChanged', '{name} actualizado.').replace('{name}', fullName));
    }

    async function renameRepository(fullName: string): Promise<void> {
        const value = renameValue.trim();
        if (await runGh(fullName, () => api.githubCliRename(fullName, value), app.t('projects.ghRenamed', '{name} ahora se llama {new}.').replace('{name}', fullName).replace('{new}', value))) {
            renameTarget = '';
        }
    }

    async function deleteRepository(fullName: string): Promise<void> {
        if (await runGh(fullName, () => api.githubCliDelete(fullName, deleteConfirm), app.t('projects.ghDeleted', '{name} borrado de GitHub.').replace('{name}', fullName))) {
            deleteTarget = '';
            deleteConfirm = '';
        }
    }

    function ownMeta(repo: OwnRepository): string {
        return [
            repo.private ? app.t('projects.ghPrivate', 'Privado') : app.t('projects.ghPublic', 'Público'),
            repo.archived ? app.t('projects.ghArchivedTag', 'Archivado') : '',
            repo.description || repo.language,
        ].filter(Boolean).join(' · ');
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
        { id: 'explore', label: app.t('projects.explore', 'Explorar GitHub') },
        { id: 'github', label: app.t('projects.myGithub', 'Mi GitHub') }
    ]);
</script>

<Panel
    id="projects"
    title={projects?.brand ?? app.t('toolbar.projects', 'Proyectos')}
    subtitle={statusError
        ? status
        : loading
          ? app.t('projects.loading', 'Consultando…')
          : status || app.t('projects.subtitle', 'Tus repositorios: anclados, descargados y de GitHub.')}
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
                    data-testid={`projects-mode-${tab.id}`}
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
                repo.localPath,
                null
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
                repo.path,
                null
            )}
        {:else}
            <div class="empty">
                {app.t(
                    'projects.noDownloaded',
                    'Todavía no hay nada clonado. Ancla un repositorio o búscalo en GitHub y clónalo.'
                )}
            </div>
        {/each}
    {:else if mode === 'github'}
        <div
            class="gh-account"
            data-testid="projects-gh-account"
            data-state={!gh?.installed ? 'missing' : gh.loggedIn ? 'logged-in' : 'logged-out'}
        >
            {#if !gh?.installed}
                <span class="hint">{app.t('projects.ghMissing', 'Para gestionar tu cuenta y tus repositorios hace falta GitHub CLI (gh).')}</span>
                <button type="button" class="run" data-testid="projects-gh-install" onclick={installGh}>
                    {app.t('projects.ghInstall', 'Instalar GitHub CLI')}
                </button>
            {:else if !gh.loggedIn}
                <span class="hint">{gh.error ?? app.t('projects.ghLoggedOut', 'Sin sesión en GitHub. Inicia sesión con el navegador: WTerminal no guarda tokens, usa la sesión de gh.')}</span>
                <div class="actions">
                    <button type="button" class="run" data-testid="projects-gh-login" disabled={busy !== '' || !app.activeTabId} onclick={() => ghTerminal('login')}>
                        {app.t('projects.ghLogin', 'Iniciar sesión')}
                    </button>
                    <button type="button" data-testid="projects-gh-check" onclick={() => load()}>
                        {app.t('projects.ghCheck', 'Comprobar de nuevo')}
                    </button>
                </div>
            {:else}
                <span class="name">
                    <strong data-testid="projects-gh-user">@{gh.account}</strong>
                    <small>{app.t('projects.ghSession', 'Sesión de GitHub CLI')}{gh.version ? ` · ${gh.version}` : ''}</small>
                </span>
                <div class="actions">
                    <button type="button" class="run" data-testid="projects-gh-new" onclick={() => (createOpen = !createOpen)}>
                        {app.t('projects.ghNew', 'Nuevo repositorio')}
                    </button>
                    <button type="button" data-testid="projects-gh-logout" disabled={busy !== '' || !app.activeTabId} onclick={() => ghTerminal('logout')}>
                        {app.t('projects.ghLogout', 'Cerrar sesión')}
                    </button>
                </div>
            {/if}
        </div>
        {#if gh?.loggedIn && createOpen}
            <form
                class="gh-form"
                data-testid="projects-gh-create-form"
                onsubmit={(event) => {
                    event.preventDefault();
                    void createRepository();
                }}
            >
                <label>
                    <span>{app.t('projects.ghNewName', 'Nombre')}</span>
                    <input data-testid="projects-gh-new-name" bind:value={newName} maxlength="100" spellcheck="false" autocomplete="off" />
                </label>
                <label>
                    <span>{app.t('projects.ghNewDescription', 'Descripción (opcional)')}</span>
                    <input data-testid="projects-gh-new-description" bind:value={newDescription} maxlength="350" />
                </label>
                <label>
                    <span>{app.t('projects.ghVisibility', 'Visibilidad')}</span>
                    <select data-testid="projects-gh-new-visibility" bind:value={newVisibility}>
                        <option value="private">{app.t('projects.ghPrivate', 'Privado')}</option>
                        <option value="public">{app.t('projects.ghPublic', 'Público')}</option>
                    </select>
                </label>
                <label class="check">
                    <input type="checkbox" data-testid="projects-gh-new-readme" bind:checked={newReadme} />
                    <span>{app.t('projects.ghReadme', 'Empezar con un README')}</span>
                </label>
                <label class="check">
                    <input type="checkbox" data-testid="projects-gh-new-clone" bind:checked={newClone} />
                    <span>{app.t('projects.ghCloneAfter', 'Clonarlo en la carpeta de proyectos')}</span>
                </label>
                <div class="actions">
                    <button type="submit" class="run" data-testid="projects-gh-create" disabled={busy !== '' || !newName.trim()}>
                        {app.t('projects.ghCreate', 'Crear')}
                    </button>
                    <button type="button" onclick={() => (createOpen = false)}>{app.t('common.cancel', 'Cancelar')}</button>
                </div>
            </form>
        {/if}
        {#each ownVisible as repo (repo.fullName)}
            {@render row(repo.fullName, ownMeta(repo), repo.local, repo.localConflict, repo.localPath, repo)}
        {:else}
            {#if gh?.loggedIn}
                <div class="empty">
                    {own.length
                        ? app.t('projects.noFilterMatch', 'Ningún repositorio coincide con el filtro.')
                        : app.t('projects.ghEmpty', 'Tu cuenta todavía no tiene repositorios.')}
                </div>
            {/if}
        {/each}
    {:else}
        {#each exploreVisible as repo (repo.fullName)}
            {@render row(
                repo.fullName,
                repo.description || repo.language,
                repo.local,
                repo.localConflict,
                repo.localPath,
                null
            )}
        {:else}
            <div class="empty">
                {found.length
                    ? app.t('projects.noFilterMatch', 'Ningún repositorio coincide con el filtro.')
                    : app.t('projects.searchHint', 'Busca un usuario o un repositorio para empezar.')}
            </div>
        {/each}
    {/if}

</Panel>

{#snippet row(
    fullName: string,
    meta: string,
    local: boolean,
    conflict: boolean,
    localPath: string,
    ownRepo: OwnRepository | null
)}
    <div class="item" data-testid="projects-row" data-full-name={fullName}>
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
                    data-testid="projects-row-more"
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
                <button type="button" data-testid="projects-row-release" class:active={release?.fullName === fullName} aria-pressed={release?.fullName === fullName} disabled={busy !== ''} onclick={() => showRelease(fullName)}>
                    {app.t('projects.release', 'Release')}
                </button>
                {#if ownRepo}
                    <button
                        type="button"
                        class="run"
                        data-testid="projects-gh-manage"
                        class:active={manageTarget === fullName}
                        aria-pressed={manageTarget === fullName}
                        onclick={() => (manageTarget = manageTarget === fullName ? '' : fullName)}
                    >
                        {app.t('ghm.manage', 'Gestionar…')}
                    </button>
                    <button
                        type="button"
                        data-testid="projects-gh-visibility"
                        disabled={busy !== ''}
                        onclick={() => changeRepository(fullName, ownRepo.private ? 'make-public' : 'make-private')}
                    >
                        {ownRepo.private ? app.t('projects.ghMakePublic', 'Hacer público') : app.t('projects.ghMakePrivate', 'Hacer privado')}
                    </button>
                    <button
                        type="button"
                        data-testid="projects-gh-archive"
                        disabled={busy !== ''}
                        onclick={() => changeRepository(fullName, ownRepo.archived ? 'unarchive' : 'archive')}
                    >
                        {ownRepo.archived ? app.t('projects.ghUnarchive', 'Desarchivar') : app.t('projects.ghArchive', 'Archivar')}
                    </button>
                    <button
                        type="button"
                        data-testid="projects-gh-rename"
                        onclick={() => {
                            renameTarget = fullName;
                            renameValue = ownRepo.name;
                            deleteTarget = '';
                        }}
                    >
                        {app.t('projects.ghRename', 'Renombrar')}
                    </button>
                    <button
                        type="button"
                        class="danger"
                        data-testid="projects-gh-delete"
                        onclick={() => {
                            deleteTarget = fullName;
                            deleteConfirm = '';
                            renameTarget = '';
                        }}
                    >
                        {app.t('projects.ghDelete', 'Borrar…')}
                    </button>
                {/if}
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
        {#if release?.release && release.fullName === fullName}
            <!-- Bajo la fila a la que pertenece. Se cierra con «Cerrar», con
                 «Release» otra vez, al plegar la fila o al cambiar de pestaña. -->
            <div class="release" data-testid="projects-release">
                <div class="release-head">
                    <strong>{release.fullName} · {release.release.tag}</strong>
                    <button type="button" class="icon" data-testid="projects-release-close" title={app.t('common.close', 'Cerrar')} onclick={() => (release = null)}>✕</button>
                </div>
                {#each release.release.assets as asset (asset.name)}
                    <button
                        type="button"
                        disabled={busy !== ''}
                        onclick={() =>
                            app.activeTabId &&
                            act(fullName, () =>
                                api.downloadRelease(app.activeTabId!, fullName, asset.name)
                            )}
                    >
                        {asset.name}
                    </button>
                {:else}
                    <span class="hint">{app.t('projects.noAssets', 'Esta release no trae adjuntos.')}</span>
                {/each}
            </div>
        {/if}
        {#if ownRepo && manageTarget === fullName}
            <GithubRepoManager
                {fullName}
                cloned={local}
                onClose={() => (manageTarget = '')}
                onTerminal={async (result) => {
                    if (!result.tabId) return;
                    panels.close();
                    await app.adoptTab(result.tabId, result.created === true);
                }}
            />
        {/if}
        {#if ownRepo && renameTarget === fullName}
            <div class="gh-inline">
                <input data-testid="projects-gh-rename-input" bind:value={renameValue} maxlength="100" spellcheck="false" />
                <button type="button" class="run" data-testid="projects-gh-rename-confirm" disabled={busy !== '' || !renameValue.trim()} onclick={() => renameRepository(fullName)}>
                    {app.t('projects.ghRename', 'Renombrar')}
                </button>
                <button type="button" onclick={() => (renameTarget = '')}>{app.t('common.cancel', 'Cancelar')}</button>
            </div>
        {/if}
        {#if ownRepo && deleteTarget === fullName}
            <div class="gh-inline gh-danger">
                <small>{app.t('projects.ghDeleteHint', 'Se borra de GitHub y no se puede deshacer. Escribe {name} para confirmar.').replace('{name}', fullName)}</small>
                <input data-testid="projects-gh-delete-input" bind:value={deleteConfirm} spellcheck="false" autocomplete="off" />
                <button
                    type="button"
                    class="danger"
                    data-testid="projects-gh-delete-confirm"
                    disabled={busy !== '' || deleteConfirm.trim() !== fullName}
                    onclick={() => deleteRepository(fullName)}
                >
                    {app.t('projects.ghDeleteForever', 'Borrar definitivamente')}
                </button>
                <button type="button" onclick={() => (deleteTarget = '')}>{app.t('common.cancel', 'Cancelar')}</button>
                {#if needsDeleteScope}
                    <button type="button" data-testid="projects-gh-grant-delete" onclick={() => ghTerminal('grant-delete')}>
                        {app.t('projects.ghGrantDelete', 'Dar permiso para borrar')}
                    </button>
                {/if}
            </div>
        {/if}
    </div>
{/snippet}

<style>
    .modes {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
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

    .gh-account,
    .gh-form,
    .gh-inline {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 8px;
        padding: 8px;
        border-top: 1px solid var(--border);
    }

    .gh-account {
        justify-content: space-between;
    }

    .gh-form {
        flex-direction: column;
        align-items: stretch;
    }

    .gh-form label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        color: var(--muted);
    }

    .gh-form label.check {
        flex-direction: row;
        align-items: center;
        gap: 6px;
        color: var(--text);
    }

    .gh-form input:not([type='checkbox']),
    .gh-form select,
    .gh-inline input {
        min-width: 0;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
    }

    .gh-inline input {
        flex: 1 1 160px;
    }

    .gh-danger {
        border-left: 2px solid var(--danger);
    }

    .gh-danger small {
        flex-basis: 100%;
        color: var(--warning);
        font-size: 10px;
    }

    button.danger {
        border-color: var(--danger);
        color: var(--danger);
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

    .release-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
    }

    /* «Release» abierta: el botón se queda marcado, como un interruptor. */
    .more button.active {
        border-color: var(--accent);
        color: var(--accent);
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
