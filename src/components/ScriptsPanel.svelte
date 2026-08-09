<script lang="ts">
    // Panel de scripts y archivos ejecutables.
    //
    // Port de `renderScripts` y `buildScriptItem` de `electron/renderer`.
    //
    // Dos ámbitos: la Biblioteca (la carpeta persistente del usuario más las
    // utilidades del sistema) y «Aquí» (la carpeta de la pestaña activa y sus
    // subcarpetas). Encima de los dos, los anclados, que se ven siempre.
    //
    // El escaneo lo hace el backend y puede tardar segundos en «Aquí»: por eso
    // hay un estado de carga explícito. El filtro de texto, en cambio, es local
    // sobre lo último escaneado — no vuelve a recorrer el disco.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { ScriptEntry, ScriptsPanel as PanelData } from '../lib/types';
    import Panel from './Panel.svelte';

    let data = $state<PanelData | null>(null);
    let mode = $state<'library' | 'here'>('library');
    let loading = $state(false);
    let status = $state('');
    let statusError = $state(false);
    let query = $state('');
    let depth = $state(2);
    /** Categorías marcadas. `null` hasta el primer escaneo, que es quien trae
     *  cuáles vienen marcadas de fábrica. */
    let selected = $state<string[] | null>(null);
    /** El script cuya fila de argumentos está abierta, y lo escrito en ella. */
    let argsFor = $state('');
    let args = $state('');
    let running = $state('');

    const NIVELES = [0, 1, 2, 3, 4, 5, 6, 8, 10];

    export async function load(next?: 'library' | 'here'): Promise<void> {
        if (next) mode = next;
        loading = true;
        statusError = false;
        try {
            const categories = selected ?? undefined;
            data =
                mode === 'here' && app.activeTabId
                    ? await api.listScriptsHere(app.activeTabId, categories, depth)
                    : await api.listScripts(categories);
            if (selected === null) {
                selected = data.filters.filter((f) => f.default).map((f) => f.id);
            }
            if (data.depth !== undefined) depth = data.depth;
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            loading = false;
        }
    }

    /** Vuelve a escanear con los tipos marcados. El filtro de tipos SÍ obliga a
     *  volver al disco: el backend descarta por categoría mientras recorre, así
     *  que lo no escaneado no está en memoria para filtrarlo aquí. */
    async function applyTypes(next: string[]): Promise<void> {
        selected = next;
        await load();
    }

    function toggleType(id: string, on: boolean): void {
        const actual = selected ?? [];
        void applyTypes(on ? [...actual, id] : actual.filter((value) => value !== id));
    }

    /** El filtro de texto es local sobre el último escaneo: en «Aquí» volver al
     *  disco por cada tecla costaría segundos. */
    function matches(script: ScriptEntry): boolean {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        return [script.name, script.relDir, script.source, script.ext, script.type]
            .join(' ')
            .toLowerCase()
            .includes(needle);
    }

    const visible = $derived((data?.scripts ?? []).filter(matches));
    const pinned = $derived((data?.pinned ?? []).filter(matches));
    const pinnedPaths = $derived(new Set((data?.pinned ?? []).map((s) => s.path)));

    /** Agrupado por origen y carpeta, y dentro de cada grupo por extensión y
     *  nombre: los del mismo tipo quedan juntos, que es como se buscan. */
    function grouped(list: ScriptEntry[]): { name: string; scripts: ScriptEntry[] }[] {
        const groups = new Map<string, ScriptEntry[]>();
        for (const script of list) {
            const name = script.relDir ? `${script.source} / ${script.relDir}` : script.source;
            const bucket = groups.get(name);
            if (bucket) bucket.push(script);
            else groups.set(name, [script]);
        }
        return [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
            .map(([name, scripts]) => ({
                name,
                scripts: scripts.sort(
                    (a, b) => a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name, 'es')
                )
            }));
    }

    const groups = $derived(grouped(visible));

    const scopeNote = $derived.by(() => {
        if (!data) return '';
        if (data.error) return data.error;
        if (query.trim() && data.scripts.length) {
            return app
                .t('scripts.filterCount', '{shown} de {total} archivos')
                .replace('{shown}', String(visible.length))
                .replace('{total}', String(data.scripts.length));
        }
        if (data.mode === 'here') {
            return data.scan?.stopReason
                ? app.t(
                      'scripts.hereLimited',
                      'Se alcanzó el límite de resultados. Se omiten dependencias/artefactos; acota la carpeta o los tipos seleccionados.'
                  )
                : app
                      .t(
                          'scripts.hereNote',
                          'Hasta {depth} niveles y solo los tipos marcados. Dependencias/artefactos y código sin intención ejecutable se omiten. Aquí no crea alias.'
                      )
                      .replace('{depth}', String(data.depth ?? depth));
        }
        return app.t(
            'scripts.libraryNote',
            'Biblioteca persistente. Solo los scripts ejecutables se registran como alias; multimedia y HTML nunca crean alias.'
        );
    });

    async function run(script: ScriptEntry, asAdmin: boolean): Promise<void> {
        if (!app.activeTabId || running) return;
        running = script.path;
        statusError = false;
        try {
            const result = await api.runScript(
                app.activeTabId,
                script.path,
                asAdmin,
                argsFor === script.path ? args : undefined
            );
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('scripts.runFailed', 'No se pudo lanzar el script.');
                return;
            }
            panels.close();
            if (result.tabId) await app.adoptTab(result.tabId, false);
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            running = '';
        }
    }

    async function pick(mode: 'file' | 'folder'): Promise<void> {
        const chosen = await api.pickTarget(mode);
        // Entrecomillado: casi todas las rutas que alguien elige a mano tienen
        // espacios, y sin comillas el script recibiría dos argumentos.
        if (chosen) args = `"${chosen}"`;
    }
</script>

<Panel
    id="scripts"
    title={app.t('toolbar.scripts', 'Scripts')}
    subtitle={statusError ? status : loading ? app.t('scripts.scanning', 'Buscando…') : scopeNote}
    error={statusError}
    count={visible.length}
    width={460}
>
    {#snippet header()}
        <div class="modes" role="tablist">
            <button
                type="button"
                role="tab"
                aria-selected={mode === 'library'}
                class:active={mode === 'library'}
                title={app.t('scripts.libraryTitle', 'Carpeta de scripts persistente y utilidades del sistema')}
                onclick={() => load('library')}
            >
                {app.t('scripts.library', 'Biblioteca')}
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={mode === 'here'}
                class:active={mode === 'here'}
                title={app.t('scripts.hereTitle', 'Buscar en el directorio actual de la pestaña y sus subdirectorios')}
                onclick={() => load('here')}
            >
                {app.t('scripts.here', 'Aquí')}
            </button>
        </div>
    {/snippet}

    <div class="toolbar">
        <span class="path" title={data?.dir ?? ''}>{data?.dir ?? ''}</span>
        {#if mode === 'here'}
            <label
                class="depth"
                title={app.t('scripts.depthTitle', 'Profundidad máxima de subdirectorios. El escaneo mantiene límites de seguridad.')}
            >
                <span>{app.t('scripts.levels', 'Niveles')}</span>
                <select
                    value={depth}
                    onchange={(event) => {
                        depth = Number((event.currentTarget as HTMLSelectElement).value);
                        void load();
                    }}
                >
                    {#each NIVELES as nivel (nivel)}
                        <option value={nivel}>{nivel}</option>
                    {/each}
                </select>
            </label>
        {/if}
        <button
            type="button"
            class="icon"
            title={app.t('scripts.chooseFolder', 'Elegir carpeta para esta vista')}
            onclick={async () => {
                loading = true;
                try {
                    data =
                        mode === 'here' && app.activeTabId
                            ? await api.chooseHereFolder(app.activeTabId, selected ?? undefined, depth)
                            : await api.chooseScriptsFolder(selected ?? undefined);
                } finally {
                    loading = false;
                }
            }}
        >📁</button>
        <button
            type="button"
            class="icon"
            title={app.t('scripts.refresh', 'Volver a buscar')}
            onclick={() => load()}
        >⟳</button>
    </div>

    <div class="filter">
        <span aria-hidden="true">🔍</span>
        <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            bind:value={query}
            placeholder={app.t('scripts.filterPlaceholder', 'Filtrar por nombre, carpeta o extensión')}
        />
        {#if query}
            <button type="button" class="icon" title={app.t('common.clearFilter', 'Limpiar filtro')} onclick={() => (query = '')}>✕</button>
        {/if}
    </div>

    {#if data}
        <details class="types" open>
            <summary>
                {app.t('scripts.fileTypes', 'Tipos de archivo')}
                <span class="count">{(selected ?? []).length}/{data.filters.length}</span>
            </summary>
            <div class="types-toolbar">
                <button type="button" onclick={() => applyTypes(data!.filters.filter((f) => f.default).map((f) => f.id))}>
                    {app.t('scripts.typesDefaults', 'Scripts')}
                </button>
                <button type="button" onclick={() => applyTypes(data!.filters.map((f) => f.id))}>
                    {app.t('scripts.typesAll', 'Todos')}
                </button>
                <button type="button" onclick={() => applyTypes([])}>
                    {app.t('scripts.typesNone', 'Ninguno')}
                </button>
            </div>
            <div class="types-options">
                {#each data.filters as filter (filter.id)}
                    <label>
                        <input
                            type="checkbox"
                            checked={(selected ?? []).includes(filter.id)}
                            onchange={(event) => toggleType(filter.id, event.currentTarget.checked)}
                        />
                        <span>{filter.label}</span>
                    </label>
                {/each}
            </div>
        </details>
    {/if}

    {#if loading}
        <!-- El escaneo de «Aquí» puede tardar segundos. Decirlo evita que
             parezca que la app se ha quedado colgada. -->
        <div class="empty">{app.t('scripts.scanning', 'Buscando…')}</div>
    {:else if pinned.length === 0 && visible.length === 0}
        <div class="empty">
            {#if query.trim() && (data?.scripts.length ?? 0) > 0}
                {app.t('scripts.noFilterMatch', 'Ningún archivo coincide con «{query}».').replace('{query}', query)}
            {:else if (selected ?? []).length === 0}
                {app.t('scripts.noTypeSelected', 'Selecciona al menos un tipo de archivo.')}
            {:else}
                {app.t('scripts.noneInScope', 'No hay archivos de los tipos seleccionados en este ámbito.')}
            {/if}
        </div>
    {/if}

    <!-- Los anclados van arriba y fuera del ámbito: se ven igual en Biblioteca
         que en «Aquí», que es justo lo que se busca al anclarlos. -->
    {#if pinned.length}
        <details class="group pinned" open>
            <summary class="group-title">
                {app.t('scripts.pinned', 'Anclados')}
                <span class="count">{pinned.length}</span>
            </summary>
            {#each pinned as script (script.path)}
                {@render entry(script)}
            {/each}
        </details>
    {/if}

    {#each groups as group (group.name)}
        <details class="group">
            <summary class="group-title">
                {group.name}
                <span class="count">{group.scripts.length}</span>
            </summary>
            {#each group.scripts as script (script.path)}
                {@render entry(script)}
            {/each}
        </details>
    {/each}
</Panel>

{#snippet entry(script: ScriptEntry)}
    <div class="item">
        <div class="item-row">
            <span class="name">
                <span class="badge">{script.interpreter ?? script.ext.replace('.', '') ?? script.category}</span>
                {script.name}
            </span>
            <div class="actions">
                <button
                    type="button"
                    class="icon"
                    class:on={pinnedPaths.has(script.path)}
                    title={pinnedPaths.has(script.path)
                        ? app.t('scripts.unpin', 'Desanclar')
                        : app.t('scripts.pin', 'Anclar: se verá siempre, en los dos ámbitos')}
                    onclick={async () => {
                        data = await api.pinScript(script.path, !pinnedPaths.has(script.path));
                    }}
                >★</button>
                <button
                    type="button"
                    class="icon"
                    title={app.t('scripts.args', 'Añadir argumentos (archivo o carpeta sobre la que actuar)')}
                    onclick={() => {
                        argsFor = argsFor === script.path ? '' : script.path;
                        args = '';
                    }}
                >⋯</button>
                <button
                    type="button"
                    class="icon"
                    title={app.t('scripts.cd', 'Ir a su carpeta en la terminal')}
                    onclick={() => app.activeTabId && api.cdToScript(app.activeTabId, script.path)}
                >cd</button>
                {#if script.runnable}
                    <button
                        type="button"
                        class="run"
                        disabled={running !== '' || !app.activeTabId}
                        onclick={() => run(script, false)}
                    >
                        {running === script.path
                            ? app.t('scripts.preparing', 'Preparando…')
                            : app.t('scripts.run', 'Ejecutar')}
                    </button>
                {:else if script.openable}
                    <!-- Abrir con la app del sistema puede fallar (sin programa
                         asociado, sin gestor); el error se enseña en la cabecera
                         del panel en vez de perderse. -->
                    <button
                        type="button"
                        class="run"
                        onclick={async () => {
                            statusError = false;
                            const result = await api.openScript(script.path);
                            if (!result.ok) {
                                statusError = true;
                                status =
                                    result.error ??
                                    app.t('scripts.openFailed', 'No se pudo abrir el archivo.');
                            }
                        }}
                    >
                        {app.t('scripts.open', 'Abrir')}
                    </button>
                {/if}
            </div>
        </div>

        {#if script.hint}
            <div class="hint">{script.hint}</div>
        {/if}

        <!-- Oculta hasta que se pide: la mayoría de scripts no necesitan
             argumentos, pero los que actúan sobre un archivo no hacen nada sin
             uno. -->
        {#if argsFor === script.path}
            <div class="args">
                <input
                    type="text"
                    bind:value={args}
                    placeholder={app.t('scripts.argsPlaceholder', 'Argumentos (ej. "C:\\ruta\\archivo.txt")')}
                />
                <button type="button" onclick={() => pick('file')}>
                    {app.t('scripts.pickFile', 'Archivo…')}
                </button>
                <button type="button" onclick={() => pick('folder')}>
                    {app.t('scripts.pickFolder', 'Carpeta…')}
                </button>
                {#if script.runnable}
                    <button type="button" title={app.t('scripts.runAdminTitle', 'Ejecutar con permisos elevados')} onclick={() => run(script, true)}>
                        {app.t('scripts.runAdmin', 'Admin')}
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
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px;
        padding: 7px 0;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
    }

    .modes button {
        overflow: hidden;
        padding: 6px 5px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
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
    .filter {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 2px;
    }

    /* `min-width: 0` para que la ruta se recorte en vez de empujar los botones
       fuera de la caja. */
    .path {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        color: var(--muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .depth {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 4px;
        color: var(--muted);
        font-size: 10px;
    }

    .filter input {
        flex: 1 1 auto;
        min-width: 0;
    }

    .depth select,
    .filter input,
    .args input {
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
    }

    .types {
        margin: 4px 0;
        border: 1px solid var(--border);
        border-radius: 5px;
    }

    .types summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 8px;
        color: var(--text);
        font-size: 11px;
        cursor: pointer;
    }

    .types-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 8px 6px;
    }

    .types-options {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 2px 10px;
        padding: 0 8px 8px;
    }

    .types-options label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        cursor: pointer;
    }

    .group {
        margin: 6px 0;
        border: 1px solid var(--border);
        border-radius: 5px;
        overflow: hidden;
    }

    .group-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
        background: var(--surface-alt);
        color: var(--accent);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
    }

    .group.pinned .group-title {
        color: #e5c07b;
    }

    .count {
        flex: 0 0 auto;
        padding: 0 6px;
        border-radius: 8px;
        background: var(--surface-hover);
        color: var(--muted);
        font-size: 10px;
    }

    .item {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 7px 8px;
        border-top: 1px solid var(--border);
    }

    .item:hover {
        background: var(--surface-hover);
    }

    /* Igual que en el panel de dependencias: los botones bajan a su propia
       línea antes que comprimir el nombre hasta taparlo. */
    .item-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 6px 8px;
    }

    .name {
        flex: 1 1 auto;
        min-width: 150px;
        color: var(--text);
        font-size: 12px;
        overflow-wrap: anywhere;
    }

    .badge {
        margin-right: 6px;
        padding: 0 5px;
        border-radius: 3px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 9px;
        text-transform: uppercase;
    }

    .actions,
    .args {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
    }

    .args {
        margin-top: 2px;
    }

    .args input {
        flex: 1 1 140px;
        min-width: 0;
    }

    button {
        padding: 3px 8px;
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

    /* El anclado marcado se distingue por color, no por otro icono: la estrella
       llena y la vacía se confunden a este tamaño. */
    .icon.on {
        border-color: #e5c07b;
        color: #e5c07b;
    }

    .run {
        border-color: var(--accent);
        background: var(--accent-soft);
        font-weight: 600;
    }

    .hint {
        color: var(--muted);
        font-size: 10px;
    }

    .empty {
        padding: 10px 8px;
        color: var(--muted);
        font-size: 12px;
    }
</style>
