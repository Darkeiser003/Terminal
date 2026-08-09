<script lang="ts">
    // Panel de entorno y dependencias adicionales.
    //
    // Port de `renderDepsPanel` de `electron/renderer/renderer.js`. Enseña el
    // resumen de qué hay en el sistema y las acciones que tienen sentido aquí,
    // agrupadas en dos niveles: el apartado (Shells, Lenguajes, Docker...) y,
    // dentro, cada herramienta con sus cuatro acciones plegadas bajo su nombre.
    //
    // Ninguna acción se ejecuta aquí: el backend escribe el comando en la
    // terminal visible y el usuario decide. Por eso el panel se cierra al
    // pulsar, en vez de quedarse esperando un resultado que no va a llegar.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { InstallAction, InstallComponent, UpdateStatus } from '../lib/types';
    import Panel from './Panel.svelte';

    let actions = $state<InstallAction[]>([]);
    let components = $state<InstallComponent[]>([]);
    let error = $state('');
    let loading = $state(false);
    /** La acción que se está preparando, para dejar su botón en marcha sin
     *  bloquear el resto del panel. */
    let running = $state('');

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

    const groups = $derived.by(() => {
        const byGroup = new Map<string, InstallAction[]>();
        for (const action of actions) {
            // El backend manda el apartado en español y su clave; se traduce
            // aquí, que es donde está el catálogo del idioma activo.
            const name = action.groupKey
                ? app.t(action.groupKey, action.group)
                : action.group;
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
                        installed: action.installed === true,
                        actions: [action]
                    });
                    continue;
                }
                let entry = subgroups.get(action.subgroup);
                if (!entry) {
                    entry = { name: action.subgroup, installed: false, actions: [] };
                    subgroups.set(action.subgroup, entry);
                    entries.push(entry);
                }
                entry.actions.push(action);
                // Basta con que UNA acción del subgrupo requiera la herramienta
                // para saber que está presente.
                if (action.installed === true) entry.installed = true;
            }
            // La clave viaja con el grupo para poder reconocer «Actualizaciones»
            // sin comparar contra su nombre traducido.
            return {
                name,
                key: groupActions[0].groupKey,
                total: groupActions.length,
                entries: entries.sort(byStateThenName)
            };
        });
    });

    /** Se está re-detectando el entorno en segundo plano. La lista ya está a la
     *  vista; esto solo marca que los contadores pueden cambiar. */
    let refreshing = $state(false);

    export async function load(): Promise<void> {
        // Primero lo YA detectado, que no toca el sistema y llega al instante.
        // Antes se pedía la detección completa antes de pintar nada y el panel
        // tardaba segundos en abrirse, con la ventana aparentemente colgada.
        loading = actions.length === 0;
        error = '';
        try {
            const list = await api.listInstallActions();
            actions = list.actions;
            components = list.components;
        } catch (cause) {
            actions = [];
            components = [];
            error = app
                .t('deps.detectFailed', 'No se pudo detectar el entorno: {error}')
                .replace('{error}', String(cause));
        } finally {
            loading = false;
        }
        // Las dos consultas lentas van detrás y sin esperarlas: la re-detección
        // habla con WSL, Docker y adb, y la de versión con GitHub. Ninguna tiene
        // por qué retrasar que el panel se vea.
        void refresh();
        void checkSelf();
    }

    /** Re-detecta el entorno y sustituye la lista si algo ha cambiado. Un fallo
     *  aquí no borra lo que ya se está enseñando: lo de antes sigue siendo
     *  válido, solo puede estar desactualizado. */
    async function refresh(): Promise<void> {
        if (refreshing) return;
        refreshing = true;
        try {
            const list = await api.refreshInstallActions();
            actions = list.actions;
            components = list.components;
        } catch {
            // Sin ruido: el panel ya tiene contenido utilizable.
        } finally {
            refreshing = false;
        }
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

    /** El primer apartado se abre solo si el usuario lo ha pedido en Ajustes.
     *  Con veinte apartados, abrir uno por defecto tapa el resumen de arriba. */
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
        (loading
            ? app.t('deps.loading', 'Detectando…')
            : app.t('deps.onlyApplicable', 'Solo se muestran acciones aplicables a este sistema.'))}
    error={Boolean(error)}
    count={actions.length}
>
    {#if components.length}
        <div class="summary">
            {#each components as component (component.label)}
                <div class="chip">
                    <span>{component.label}</span>
                    <strong>{component.value}</strong>
                </div>
            {/each}
        </div>
    {/if}

    {#if !loading && actions.length === 0}
        <div class="empty">
            {app.t('deps.allReady', 'Todo lo detectado está listo; no hay instalaciones pendientes.')}
        </div>
    {/if}

    {#each groups as group, groupIndex (group.name)}
        <details class="group" open={autoOpenFirst && groupIndex === 0} ontoggle={onToggle}>
            <summary class="group-title">
                {group.name}
                <span class="count">{group.key === 'group.updates' ? group.total + 1 : group.total}</span>
            </summary>

            <!-- La propia terminal va la primera del apartado: actualizar la
                 app es lo que se viene a buscar aquí antes que actualizar los
                 repositorios clonados. -->
            {#if group.key === 'group.updates'}
                {@render selfUpdate()}
            {/if}

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
                    <details class="subgroup" class:installed={entry.installed} ontoggle={onToggle}>
                        <summary class="subgroup-title">
                            {entry.name}
                            <span class="count">{entry.actions.length}</span>
                        </summary>
                        {#each entry.actions as action (action.id)}
                            {@render item(action, true)}
                        {/each}
                    </details>
                {/if}
            {/each}
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
                    .replace('{version}', self.currentVersion)}
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
    /* `auto-fit` con un minimo real: las fichas se reparten en las columnas
       que quepan y bajan a una sola cuando el panel se estrecha, en vez de
       encogerse hasta que el valor no se lee. */
    .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 6px;
        padding: 6px;
        border-bottom: 1px solid var(--border);
    }

    .chip {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface-alt);
        color: var(--muted);
        font-size: 10px;
    }

    .chip strong {
        color: var(--text);
        font-size: 11px;
        font-weight: 600;
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
        color: var(--text);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        list-style: none;
        transition: background 0.15s ease;
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
    }

    .label {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--text);
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
        word-break: break-word;
    }

    .hint {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.45;
        margin-top: 2px;
    }

    .run {
        flex: 0 0 auto;
        margin-left: auto;
        padding: 4px 12px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--accent-soft);
        color: var(--text);
        font: inherit;
        font-size: 11px;
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
