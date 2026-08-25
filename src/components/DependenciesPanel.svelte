<script lang="ts">
    // Panel de entorno y dependencias adicionales.
    //
    // Port de `renderDepsPanel` de `electron/renderer/renderer.js`. Enseña las
    // acciones aplicables a este sistema, agrupadas en dos niveles: el
    // apartado (Shells, Lenguajes, Docker...) y,
    // dentro, cada herramienta con sus cuatro acciones plegadas bajo su nombre.
    //
    // Ninguna acción se ejecuta aquí: el backend escribe el comando en la
    // terminal visible y el usuario decide. Por eso el panel se cierra al
    // pulsar, en vez de quedarse esperando un resultado que no va a llegar.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { InstallAction, UpdateStatus } from '../lib/types';
    import Panel from './Panel.svelte';

    let actions = $state<InstallAction[]>([]);
    let error = $state('');
    let loading = $state(false);
    /** La acción que se está preparando, para dejar su botón en marcha sin
     *  bloquear el resto del panel. */
    let running = $state('');
    let bulkRunning = $state<'install' | 'uninstall' | ''>('');
    let query = $state('');
    let statusFilter = $state<'all' | 'installed' | 'missing'>('all');

    const bulkInstallCount = $derived(
        actions.filter((action) => action.verb === null && action.installed === false).length
    );
    const bulkUninstallCount = $derived(
        actions.filter(
            (action) =>
                (action.id.endsWith('-uninstall') || action.id.endsWith('-remove')) &&
                (action.requiresCmd !== null || action.installed === true)
        ).length
    );

    /** Estado de la actualización de la PROPIA terminal. Null mientras no se ha
     *  consultado. No es una acción del catálogo: no se escribe ningún comando
     *  en la terminal, lo hace la app por dentro (descarga, intercambia los
     *  archivos y se reinicia), así que vive aparte. */
    let self = $state<UpdateStatus | null>(null);
    let checking = $state(false);
    let updating = $state(false);
    let selfError = $state('');

    /** Una entrada de la lista: o una acción suelta, o una herramienta con
     *  todas las suyas plegadas bajo su nombre. */
    interface Entry {
        name: string;
        description: string | null;
        installed: boolean;
        actions: InstallAction[];
    }

    /** Dentro de un apartado manda el estado, no el orden del catálogo: lo que
     *  ya está en el sistema va arriba (es donde se busca "ver versión" o
     *  "desinstalar") y lo que falta, abajo. A igualdad de estado, alfabético,
     *  que es lo único previsible cuando hay veinte entradas. `installed` lo
     *  marca el backend al filtrar, sin comprobaciones extra. */
    function byStateThenName(a: Entry, b: Entry): number {
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    }

    function translateGroupTitle(rawGroup: string, groupKey?: string | null): string {
        if (groupKey) return app.t(groupKey, rawGroup);
        if (rawGroup === 'Actualizaciones') return app.t('group.updates', 'Actualizaciones');
        if (rawGroup === 'Shells') return app.t('group.shells', 'Shells');
        if (rawGroup === 'Sistema y herramientas') return app.t('group.tools', 'Sistema y herramientas');
        if (rawGroup === 'Lenguajes') return app.t('group.languagesShort', 'Lenguajes');
        if (rawGroup === 'Frameworks') return app.t('group.frameworks', 'Frameworks y ecosistemas');
        if (rawGroup === 'Visores de archivos') return app.t('group.viewers', 'Visores de archivos');
        if (rawGroup === 'WSL') return app.t('group.wslShort', 'WSL');
        if (rawGroup === 'Docker') return app.t('group.dockerShort', 'Docker');
        if (rawGroup === 'Contenedores y Kubernetes') return app.t('group.containers', 'Contenedores y Kubernetes');
        if (rawGroup === 'Android · ADB') return app.t('group.androidShort', 'Android · ADB');
        return rawGroup;
    }

    const groups = $derived.by(() => {
        const byGroup = new Map<string, InstallAction[]>();
        for (const action of actions) {
            // El backend manda el apartado en español y su clave; se traduce
            // aquí, que es donde está el catálogo del idioma activo.
            const name = translateGroupTitle(action.group, action.groupKey);
            const list = byGroup.get(name);
            if (list) list.push(action);
            else byGroup.set(name, [action]);
        }

        return [...byGroup.entries()].map(([name, groupActions]) => {
            // Las herramientas que traen varias acciones se pliegan bajo su
            // propio nombre en vez de formar una lista larga y repetitiva. Las
            // sueltas entran en la MISMA lista, para que el orden salga de
            // compararlo todo junto y no de dos listas separadas.
            const subgroups = new Map<string, Entry>();
            const entries: Entry[] = [];
            for (const action of groupActions) {
                if (!action.subgroup) {
                    entries.push({
                        name: action.label,
                        description: null,
                        installed: action.installed === true,
                        actions: [action]
                    });
                    continue;
                }
                let entry = subgroups.get(action.subgroup);
                if (!entry) {
                    entry = {
                        name: action.subgroup,
                        description: action.subgroupDescription,
                        installed: false,
                        actions: []
                    };
                    subgroups.set(action.subgroup, entry);
                    entries.push(entry);
                }
                entry.actions.push(action);
                if (!entry.description && action.subgroupDescription) {
                    entry.description = action.subgroupDescription;
                }
                // Basta con que UNA acción del subgrupo requiera la herramienta
                // para saber que está presente.
                if (action.installed === true) entry.installed = true;
            }
            // La clave viaja con el grupo para poder reconocer «Actualizaciones»
            // sin comparar contra su nombre traducido.
            const needle = query.trim().toLocaleLowerCase('es');
            const filteredEntries = entries.filter((entry) => {
                if (statusFilter === 'installed' && !entry.installed) return false;
                if (statusFilter === 'missing' && entry.installed) return false;
                if (!needle) return true;
                return [
                    entry.name,
                    entry.description ?? '',
                    name,
                    ...entry.actions.flatMap((action) => [action.label, action.hint ?? ''])
                ]
                    .some((text) => text.toLocaleLowerCase('es').includes(needle));
            });
            return {
                name,
                key: groupActions[0].groupKey,
                total: groupActions.length,
                entries: filteredEntries.sort(byStateThenName)
            };
        }).filter((group) => {
            if (group.entries.length > 0) return true;
            if (group.key !== 'group.updates' || statusFilter === 'missing') return false;
            const needle = query.trim().toLocaleLowerCase('es');
            return !needle || app.t('deps.updateApp', 'Actualizar la terminal').toLocaleLowerCase('es').includes(needle);
        });
    });

    // El catálogo contiene varias acciones por herramienta (instalar,
    // actualizar, comprobar y desinstalar). El contador de la cabecera debe
    // reflejar las entradas que el usuario ve, igual que los contadores de cada
    // apartado, no el número interno de comandos del catálogo.
    const visibleComponentCount = $derived(
        groups.reduce(
            (total, group) => total + group.entries.length + (group.key === 'group.updates' ? 1 : 0),
            0
        )
    );

    /** Se está re-detectando el entorno en segundo plano. La lista ya está a la
     *  vista; esto solo marca que los contadores pueden cambiar. */
    let refreshing = $state(false);
    /** No se permite preparar un lote con la detección rápida inicial: esa
     *  instantánea puede no incluir todavía WSL, Docker, ADB o los PATH que
     *  acaba de crear un instalador. */
    let detectionReady = $state(false);
    /** Evita que una detección lenta de una apertura anterior pise la lista de
     *  una apertura posterior del panel. */
    let loadSerial = 0;

    export async function load(): Promise<void> {
        const serial = ++loadSerial;
        // Primero lo YA detectado, que no toca el sistema y llega al instante.
        // Antes se pedía la detección completa antes de pintar nada y el panel
        // tardaba segundos en abrirse, con la ventana aparentemente colgada.
        loading = actions.length === 0;
        detectionReady = false;
        error = '';
        try {
            const list = await api.listInstallActions();
            if (serial !== loadSerial) return;
            actions = list.actions;
        } catch (cause) {
            if (serial !== loadSerial) return;
            actions = [];
            error = app
                .t('deps.detectFailed', 'No se pudo detectar el entorno: {error}')
                .replace('{error}', String(cause));
        } finally {
            if (serial === loadSerial) loading = false;
        }
        // La detección completa sí se espera antes de habilitar los botones de
        // lote. Antes se podía pulsar mientras la instantánea rápida aún estaba
        // siendo sustituida, de ahí el salto engañoso de 20/30 a 100+.
        await refresh();
        void checkSelf();
    }

    /** Re-detecta el entorno y sustituye la lista si algo ha cambiado. Un fallo
     *  aquí no borra lo que ya se está enseñando: lo de antes sigue siendo
     *  válido, solo puede estar desactualizado. */
    async function refresh(): Promise<boolean> {
        if (refreshing) return false;
        const serial = loadSerial;
        refreshing = true;
        detectionReady = false;
        let ok = true;
        try {
            const list = await api.refreshInstallActions();
            if (serial !== loadSerial) return false;
            actions = list.actions;
        } catch {
            // La instantánea rápida no se considera suficientemente fiable
            // para ejecutar un lote si la detección completa ha fallado.
            ok = false;
            error = app.t('deps.detectFailed', 'No se pudo completar la detección del entorno.');
        } finally {
            if (serial === loadSerial) {
                refreshing = false;
                detectionReady = ok;
            }
        }
        return ok;
    }

    /** Consulta si hay una versión nueva publicada. Un fallo de red no es un
     *  error del panel: se enseña en su propia fila y lo demás sigue igual. */
    async function checkSelf(): Promise<void> {
        if (checking) return;
        checking = true;
        selfError = '';
        try {
            self = await api.checkForUpdate();
        } catch (cause) {
            selfError = String(cause);
        } finally {
            checking = false;
        }
    }

    /** Hay algo que instalar Y esta copia puede hacerlo: una build de
     *  desarrollo detecta la versión nueva pero no debe sobrescribirse con
     *  ella. */
    const puedeActualizar = $derived(self?.available === true && self.canSelfUpdate);

    async function installSelf(): Promise<void> {
        if (updating) return;
        updating = true;
        selfError = '';
        try {
            // Si va bien, el proceso muere durante esta llamada y no vuelve:
            // lo que sigue solo se ejecuta si ha fallado.
            const result = await api.installUpdate();
            selfError = result.error ?? app.t('update.failed', 'No se pudo actualizar.');
        } catch (cause) {
            selfError = String(cause);
        } finally {
            updating = false;
        }
    }

    async function run(action: InstallAction): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId || running) return;
        running = action.id;
        error = '';
        try {
            const result = await api.runInstallAction(tabId, action.id);
            if (!result.ok) {
                error = result.error ?? app.t('deps.actionFailed', 'No se pudo preparar la acción.');
                return;
            }
            panels.close();
            // Desde un REPL la acción se manda a una shell de verdad: hay que
            // traer al frente la pestaña donde de verdad corre, que puede ser
            // otra o incluso una que el backend acaba de abrir.
            if (result.tabId) await app.adoptTab(result.tabId, result.created);
        } catch (cause) {
            error = String(cause);
        } finally {
            running = '';
        }
    }

    async function runBulk(mode: 'install' | 'uninstall'): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId || running || bulkRunning) return;
        bulkRunning = mode;
        error = '';
        try {
            const result = await api.runInstallBulk(tabId, mode);
            if (!result.ok) {
                error = result.error ?? app.t('deps.bulkFailed', 'No se pudo preparar el lote.');
                return;
            }
            panels.close();
            if (result.tabId) await app.adoptTab(result.tabId, result.created);
        } catch (cause) {
            error = String(cause);
        } finally {
            bulkRunning = '';
        }
    }

    /** El primer apartado se abre solo si el usuario lo ha pedido en Ajustes.
     *  Con veinte apartados, abrir uno por defecto ocupa espacio innecesario. */
    const autoOpenFirst = $derived(app.preferences?.autoOpenFirstGroup ?? false);

    /** Con el acordeón exclusivo, abrir un apartado cierra sus hermanos. Se
     *  cierran solo los HERMANOS: cerrar "todo lo que no sea yo" plegaría el
     *  apartado padre al abrir un subgrupo, y este desaparecería en el mismo
     *  clic. */
    function onToggle(event: Event): void {
        const details = event.currentTarget as HTMLDetailsElement;
        if (!details.open || !app.preferences?.exclusiveAccordionGroups) return;
        const parent = details.parentElement;
        if (!parent) return;
        for (const other of parent.children) {
            if (other !== details && other instanceof HTMLDetailsElement) other.open = false;
        }
    }
</script>

<Panel
    id="deps"
    title={app.t('deps.header', 'Entorno y componentes')}
    subtitle={error ||
        (loading && actions.length === 0
            ? app.t('deps.loading', 'Detectando…')
            : refreshing
              ? app.t('deps.refreshing', 'Actualizando detección…')
              : app.t('deps.onlyApplicable', 'Solo se muestran acciones aplicables a este sistema.'))}
    error={Boolean(error)}
    count={loading || refreshing ? undefined : visibleComponentCount}
    countLabel={app
        .t('deps.visibleComponents', '{count} visible components')
        .replace('{count}', String(visibleComponentCount))}
>
    <div class="filters" role="search">
        <input
            type="search"
            bind:value={query}
            placeholder={app.t('deps.search', 'Buscar herramienta o acción…')}
            aria-label={app.t('deps.search', 'Buscar herramienta o acción…')}
        />
        <select bind:value={statusFilter} aria-label={app.t('deps.filterStatus', 'Filtrar por estado')}>
            <option value="all">{app.t('deps.filterAll', 'Todas')}</option>
            <option value="installed">{app.t('deps.filterInstalled', 'Instaladas')}</option>
            <option value="missing">{app.t('deps.filterMissing', 'No instaladas')}</option>
        </select>
    </div>
    <div class="bulk-actions" data-testid="dependency-bulk-actions">
        <div class="bulk-copy">
            <strong>{app.t('deps.bulkTitle', 'Acciones por categorías')}</strong>
            <span>{app.t('deps.bulkHint', 'Genera un script visible y pregunta antes de cada categoría.')}</span>
        </div>
        <div class="bulk-buttons">
            <button
                type="button"
                class="run secondary"
                data-testid="dependency-refresh"
                disabled={refreshing || bulkRunning !== '' || running !== ''}
                onclick={() => void refresh()}
            >
                {refreshing ? app.t('deps.refreshing', 'Actualizando…') : app.t('deps.refresh', 'Actualizar detección')}
            </button>
            <button
                type="button"
                class="run"
                data-testid="dependency-bulk-install"
                disabled={
                    !detectionReady || bulkInstallCount === 0 || running !== '' || bulkRunning !== '' || !app.activeTabId
                }
                onclick={() => runBulk('install')}
            >
                {bulkRunning === 'install'
                    ? app.t('deps.bulkPreparing', 'Preparando…')
                    : app.t('deps.bulkInstall', 'Instalar faltantes')}
                <span class="count">{bulkInstallCount}</span>
            </button>
            <button
                type="button"
                class="run danger"
                data-testid="dependency-bulk-uninstall"
                disabled={
                    !detectionReady || bulkUninstallCount === 0 || running !== '' || bulkRunning !== '' || !app.activeTabId
                }
                onclick={() => runBulk('uninstall')}
            >
                {bulkRunning === 'uninstall'
                    ? app.t('deps.bulkPreparing', 'Preparando…')
                    : app.t('deps.bulkUninstall', 'Desinstalar instalados')}
                <span class="count">{bulkUninstallCount}</span>
            </button>
        </div>
    </div>

    {#if !loading && actions.length === 0}
        <div class="empty">
            {app.t('deps.allReady', 'Todo lo detectado está listo; no hay instalaciones pendientes.')}
        </div>
    {/if}

    {#each groups as group, groupIndex (group.name)}
        <details
            class="group"
            data-testid="dependency-group"
            class:languages={group.key === 'group.languages'}
            open={autoOpenFirst && groupIndex === 0}
            ontoggle={onToggle}
        >
            <summary class="group-title">
                {group.name}
                <span class="count">{group.entries.length + (group.key === 'group.updates' ? 1 : 0)}</span>
            </summary>

            <!-- La propia terminal va la primera del apartado: actualizar la
                 app es lo que se viene a buscar aquí antes que actualizar los
                 repositorios clonados. -->
            {#if group.key === 'group.updates'}
                {@render selfUpdate()}
            {/if}

            <div class:compact-grid={group.key === 'group.languages'}>
            {#each group.entries as entry (entry.name)}
                {#if entry.actions.length === 1}
                    <!-- Una herramienta con una sola acción disponible no gana
                         nada con un plegable propio: se muestra directamente.
                         Pero conserva su nombre y su sangrado, para que se lea
                         en la misma columna que sus vecinas y en el sitio en el
                         que el orden alfabético la ha puesto. Sin esto, la fila
                         decía "Instalar Visual Studio Code (winget)" y parecía
                         archivada bajo la «I». -->
                    <div class="tool" class:installed={entry.installed}>
                        {@render item(entry.actions[0], false, entry.name)}
                    </div>
                {:else}
                    <details class="subgroup" class:installed={entry.installed} data-testid="dependency-subgroup" ontoggle={onToggle}>
                        <summary class="subgroup-title">
                            <span class="subgroup-heading">
                                <span>{entry.name}</span>
                                {#if entry.description}
                                    <small>{entry.description}</small>
                                {/if}
                            </span>
                            <span class="count">{entry.actions.length}</span>
                        </summary>
                        {#each entry.actions as action (action.id)}
                            {@render item(action, true)}
                        {/each}
                    </details>
                {/if}
            {/each}
            </div>
        </details>
    {/each}
</Panel>

<!-- La actualización de la propia terminal. No pasa por `item`: no es una
     acción del catálogo, no escribe nada en la terminal y su botón cambia según
     lo que haya contestado GitHub. -->
{#snippet selfUpdate()}
    <!-- Misma envoltura que una herramienta de una sola acción: así comparte
         guía vertical y sangrado con el resto del apartado. -->
    <div class="tool self" class:available={self?.available === true}>
        <div class="item">
        <div class="item-row">
            <span class="label">
                {app
                    .t('deps.updateApp', 'Actualizar {app}')
                    .replace('{app}', app.appInfo?.name ?? 'la terminal')}
            </span>
            <button
                type="button"
                class="run"
                data-testid="dependency-action"
                disabled={updating || checking}
                onclick={() => (puedeActualizar ? installSelf() : checkSelf())}
            >
                {#if updating}
                    {app.t('deps.updating', 'Actualizando…')}
                {:else if checking}
                    {app.t('deps.checking', 'Comprobando…')}
                {:else if puedeActualizar}
                    {app.t('verb.update', 'Actualizar')}
                {:else}
                    <!-- Sin nada que instalar, el botón sirve para volver a
                         preguntar: es lo único útil que puede hacer ahí. -->
                    {app.t('deps.checkAgain', 'Comprobar')}
                {/if}
            </button>
        </div>
        <div class="hint">
            {#if selfError}
                <strong class="warn">{selfError}</strong>
            {:else if checking}
                {app.t('deps.checkingUpdate', 'Consultando si hay una versión más reciente…')}
            {:else if !self}
                {app.t('deps.updateUnknown', 'Todavía no se ha consultado si hay versión nueva.')}
            {:else if self.error}
                <!-- Sin red, o con el límite de consultas de GitHub agotado. No
                     es un fallo de la app: se dice y se deja reintentar. -->
                <strong class="warn">{self.error}</strong>
            {:else if self.available}
                {app
                    .t('update.available', 'Hay una versión más reciente: {version}.')
                    .replace('{version}', self.latestVersion ?? '')}
                {#if !self.canSelfUpdate}
                    <!-- Una build de desarrollo: actualizar sobrescribiría el
                         árbol de compilación con una release descargada. -->
                    <strong class="warn">
                        {app.t(
                            'deps.updateManual',
                            'Esta copia no se actualiza sola; descárgala desde su repositorio.'
                        )}
                    </strong>
                {:else if self.installPath}
                    {app.t('update.into', 'Se instalará en {path}').replace('{path}', self.installPath)}
                {/if}
            {:else}
                {app
                    .t('deps.upToDate', 'Estás en la última versión ({version}).')
                    .replace('{version}', self.currentVersion)
                    .replace('{app}', app.appInfo?.name ?? 'la terminal')}
            {/if}
        </div>
        </div>
    </div>
{/snippet}

<!-- `compact` es para las acciones que van dentro del plegable de una
     herramienta, donde el nombre ya está en la cabecera y repetirlo sobra. -->
{#snippet item(action: InstallAction, compact: boolean, title?: string)}
    <div class="item">
        <div class="item-row">
            <span class="label">
                {title ?? (compact ? (action.shortLabel ?? action.label) : action.label)}
            </span>
            <button
                type="button"
                class="run"
                data-testid="dependency-action"
                data-action-id={action.id}
                disabled={running !== '' || !app.activeTabId}
                onclick={() => run(action)}
            >
                {running === action.id
                    ? app.t('deps.preparing', 'Preparando…')
                    : (action.verb ?? app.t('verb.install', 'Instalar'))}
            </button>
        </div>
        {#if action.hint}
            <div class="hint">{action.hint}</div>
        {/if}
    </div>
{/snippet}

<style>
    .filters {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px;
        padding: 6px;
        border-bottom: 1px solid var(--border);
    }

    .filters input,
    .filters select {
        min-width: 0;
        padding: 7px 9px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
    }

    .bulk-actions {
        display: flex;
        align-items: stretch;
        flex-direction: column;
        gap: 10px;
        padding: 8px;
        border-bottom: 1px solid var(--border);
        background: color-mix(in srgb, var(--accent-soft) 45%, transparent);
    }

    .bulk-copy {
        display: flex;
        flex-direction: column;
        min-width: 0;
        gap: 2px;
        overflow: hidden;
    }

    .bulk-copy strong {
        color: var(--text);
        font-size: 11px;
    }

    .bulk-copy span {
        color: var(--muted);
        font-size: 10px;
        line-height: 1.35;
    }

    .bulk-buttons {
        display: flex;
        min-width: 0;
        flex: 1 1 auto;
        flex-wrap: wrap;
        justify-content: flex-start;
        gap: 5px;
    }

    .bulk-buttons .run {
        margin-left: 0;
    }

    .bulk-buttons .run.danger {
        border-color: color-mix(in srgb, #e06c75 55%, var(--border));
        color: #f0b5b9;
    }

    @container (max-width: 360px) {
        .filters {
            grid-template-columns: minmax(0, 1fr);
        }

        .bulk-buttons .run {
            flex: 1 1 170px;
        }

        .item-row {
            align-items: stretch;
            flex-direction: column;
        }

        .item-row .run {
            align-self: flex-start;
            margin-left: 0;
        }
    }

    .group {
        margin: 8px 0;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.2);
        overflow: hidden;
    }

    .group-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 9px 12px;
        background: var(--surface-alt);
        color: var(--accent);
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        list-style: none;
        line-height: 1.25;
        transition: background 0.15s ease;
    }

    .group-title::-webkit-details-marker,
    .subgroup-title::-webkit-details-marker {
        display: none;
    }

    .group[open] > .group-title {
        border-bottom: 1px solid var(--border);
    }

    /* Segundo nivel: cada herramienta agrupa sus acciones bajo su propio
       nombre. Se distingue del apartado padre por sangrado y bordes suaves. */
    .subgroup {
        margin: 6px 6px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
        overflow: hidden;
    }

    .subgroup[open] {
        border-color: var(--accent);
    }

    .subgroup-title {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        min-width: 0;
        color: var(--text);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        list-style: none;
        transition: background 0.15s ease;
    }

    .subgroup-heading {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
        gap: 2px;
    }

    .subgroup-heading > span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .subgroup-heading small {
        overflow: hidden;
        color: var(--muted);
        font-size: 10px;
        font-weight: 400;
        line-height: 1.25;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .subgroup-title:hover {
        color: var(--accent);
        background: var(--surface-hover);
    }

    /* Marca lo que ya está en el sistema */
    .subgroup.installed > .subgroup-title::before {
        content: '';
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        margin-right: -2px;
        border-radius: 50%;
        background: #4ec9b0;
    }

    .subgroup-title .count {
        margin-left: auto;
    }

    .subgroup .item {
        margin: 4px 6px 6px 6px;
    }

    /* Una herramienta con una sola acción: tarjeta con borde e identidad propia */
    .tool {
        margin: 6px 6px;
    }

    /* Los intérpretes crecerán hasta varias decenas: tarjetas completas en una
       sola columna desperdician casi toda la ventana. En este apartado se
       distribuyen en columnas automáticas; cada herramienta conserva sus
       acciones, estado y plegable, pero ocupa solo el ancho que necesita. */
    .compact-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 6px;
        padding: 6px;
    }

    .compact-grid .tool,
    .compact-grid .subgroup {
        min-width: 0;
        margin: 0;
    }

    .compact-grid .item {
        height: 100%;
        min-height: 38px;
        box-sizing: border-box;
        padding: 7px 9px;
    }

    .tool .item {
        margin: 0;
    }

    /* El mismo punto que marca lo ya instalado en los plegables. */
    .tool.installed .label::before {
        content: '';
        display: inline-block;
        width: 6px;
        height: 6px;
        margin-right: 6px;
        border-radius: 50%;
        background: #4ec9b0;
        vertical-align: middle;
    }

    /* El punto de «hay versión nueva». */
    .tool.self.available .label::before {
        content: '';
        display: inline-block;
        width: 6px;
        height: 6px;
        margin-right: 6px;
        border-radius: 50%;
        background: #e5c07b;
        vertical-align: middle;
    }

    .hint .warn {
        color: #e5c07b;
        font-weight: 400;
    }

    .count {
        flex: 0 0 auto;
        padding: 2px 7px;
        border-radius: 8px;
        background: var(--surface-hover);
        color: var(--muted);
        font-size: 10px;
    }

    .item {
        display: flex;
        flex-direction: column;
        min-width: 0;
        gap: 6px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        transition: background 0.15s ease, border-color 0.15s ease;
    }

    .item:hover {
        background: var(--surface-hover);
        border-color: rgba(255, 255, 255, 0.25);
    }

    .item-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        min-width: 0;
    }

    .label {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--text);
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
        overflow-wrap: anywhere;
    }

    .hint {
        overflow-wrap: anywhere;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.45;
        margin-top: 2px;
    }

    .run {
        flex: 0 0 auto;
        min-width: 0;
        margin-left: auto;
        padding: 4px 12px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--accent-soft);
        color: var(--text);
        font: inherit;
        font-size: 11px;
        line-height: 1.2;
        font-weight: 500;
        white-space: nowrap;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
    }

    .run:hover:not(:disabled) {
        border-color: var(--accent);
        background: var(--surface-hover);
    }

    .run:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .empty {
        padding: 8px;
        color: var(--muted);
        font-size: 12px;
    }
</style>
