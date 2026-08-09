<script lang="ts">
    // Explorador de archivos lateral.
    //
    // Port del `<aside id="explorer">` de `electron/renderer`. Es una barra
    // lateral y no un panel desplegable como los otros cuatro: un explorador
    // que se cierra al pulsar en la terminal no sirve para nada — la gracia es
    // tenerlo a la vista mientras se trabaja.
    //
    // El backend no acepta rutas sueltas: solo se puede actuar sobre entradas
    // directas de la carpeta que él está enseñando para esta pestaña. Por eso
    // aquí no se compone ninguna ruta: se manda la que vino en el listado.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import type { ExplorerEntry, Listing, ManagerChoices } from '../lib/types';

    let listing = $state<Listing | null>(null);
    let loading = $state(false);
    let status = $state('');
    let statusError = $state(false);
    /** Formulario de creación abierto, y para qué. */
    let creating = $state<'file' | 'directory' | null>(null);
    let newName = $state('');
    /** La entrada que se está renombrando, y su nombre nuevo. */
    let renaming = $state('');
    let renameTo = $state('');
    /** Confirmación de envío a la papelera: borrar sin preguntar en un
     *  explorador es demasiado fácil de hacer sin querer. */
    let confirming = $state<ExplorerEntry | null>(null);
    /** Menú contextual de la lista. */
    let menu = $state<{ x: number; y: number; entry: ExplorerEntry | null } | null>(null);
    /** Gestores con los que abrir una carpeta, cuando el sistema no supo
     *  hacerlo solo. El backend los devuelve en `choices` y hasta ahora nadie
     *  los enseñaba: el botón parecía roto en un Windows sin gestor asociado. */
    let managers = $state<{ choices: ManagerChoices; target?: string } | null>(null);
    /** Hay algo copiado o cortado. El portapapeles vive en el backend, así que
     *  esto solo se sabe por haber hecho la acción: sirve para no ofrecer un
     *  «Pegar» que solo puede fallar. */
    let clipped = $state(false);

    /** Se recarga al cambiar de pestaña: cada una tiene su propia carpeta. */
    $effect(() => {
        const tabId = app.activeTabId;
        if (!app.explorerVisible || !tabId) return;
        void load(tabId);
    });

    async function load(tabId: string, dir?: string): Promise<void> {
        loading = true;
        statusError = false;
        try {
            listing = await api.listDirectory(tabId, dir);
            if (listing.error) {
                statusError = true;
                status = listing.error;
            } else {
                status = '';
            }
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            loading = false;
        }
    }

    async function act<T extends { ok: boolean; error?: string }>(
        accion: () => Promise<T>
    ): Promise<T | null> {
        statusError = false;
        try {
            const result = await accion();
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('explorer.failed', 'No se pudo completar la acción.');
                return null;
            }
            if (app.activeTabId) await load(app.activeTabId, listing?.dir);
            return result;
        } catch (cause) {
            statusError = true;
            status = String(cause);
            return null;
        }
    }

    /** Carpetas primero y luego archivos, cada grupo alfabético. Es el orden de
     *  cualquier explorador, y el que permite bajar por el árbol sin buscar. */
    const entries = $derived(
        [...(listing?.entries ?? [])].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
        })
    );

    function size(entry: ExplorerEntry): string {
        if (entry.kind === 'directory') return '';
        const kb = entry.size / 1024;
        if (kb < 1) return `${entry.size} B`;
        if (kb < 1024) return `${Math.round(kb)} KB`;
        return `${(kb / 1024).toFixed(1)} MB`;
    }

    function openEntry(entry: ExplorerEntry): void {
        const tabId = app.activeTabId;
        if (!tabId) return;
        if (entry.kind === 'directory') void load(tabId, entry.path);
        else void act(() => api.openEntry(tabId, entry.path));
    }

    /** Entrar en una carpeta con un solo clic. Los archivos siguen pidiendo dos:
     *  entrar en una carpeta se deshace con el botón de subir, pero abrir un
     *  archivo lanza la aplicación del sistema, y eso no debe pasar por rozar la
     *  lista con el ratón. */
    function clickEntry(entry: ExplorerEntry): void {
        if (entry.kind === 'directory') openEntry(entry);
    }

    /** El doble clic solo abre archivos. En una carpeta no hace nada porque el
     *  primer clic ya ha entrado y la lista es otra: el segundo caería sobre la
     *  entrada que haya quedado debajo del ratón y bajaría dos niveles de
     *  golpe. */
    function doubleClickEntry(entry: ExplorerEntry): void {
        if (entry.kind !== 'directory') openEntry(entry);
    }

    /** Cierra el menú contextual y ejecuta la acción sobre la entrada que lo
     *  abrió.
     *
     *  El orden importa y no es cosmético: `{@const entry = menu.entry}` se
     *  compila a un derivado de `menu`, así que un manejador que hiciera
     *  `menu = null` y LUEGO leyera `entry` provocaba que el derivado se
     *  recalculara sobre `null` y reventara con «Cannot read properties of
     *  null». Aquí la entrada se copia del estado antes de cerrar, y lo que
     *  recibe la acción ya no depende de `menu`. */
    function fromMenu(action: (entry: ExplorerEntry) => void): void {
        const entry = menu?.entry;
        menu = null;
        if (entry) action(entry);
    }

    /** Copia o corta. El portapapeles lo guarda el backend; aquí solo se
     *  recuerda que hay algo, para poder ofrecer «Pegar». */
    async function clip(entry: ExplorerEntry, mode: 'copy' | 'cut'): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId) return;
        clipped = (await act(() => api.clipEntry(tabId, entry.path, mode))) !== null;
    }

    /** Abre una carpeta en el gestor de archivos del sistema. Sin `itemPath` es
     *  la que el explorador está enseñando. */
    async function openFolderInSystem(itemPath?: string): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId) return;
        statusError = false;
        managers = null;
        const result = await api.openDirectory(tabId, itemPath);
        if (result.ok) return;
        if (result.choices) {
            managers = { choices: result.choices, target: itemPath };
            return;
        }
        statusError = true;
        status =
            result.error ??
            app.t('explorer.errorOpenFolder', 'No se pudo abrir la carpeta.');
    }

    /** El gestor llega por identificador de la tabla del backend, nunca por
     *  ruta a un ejecutable. `remember` lo deja como preferido. */
    async function openWith(managerId: string, remember: boolean): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId) return;
        const target = managers?.target;
        managers = null;
        const result = await api.openDirectoryWith(tabId, managerId, target, remember);
        if (!result.ok) {
            statusError = true;
            status =
                result.error ??
                app.t('explorer.errorOpenFolder', 'No se pudo abrir la carpeta.');
        }
    }
</script>

{#if app.explorerVisible}
    <aside class="explorer">
        <div class="toolbar">
            <button
                type="button"
                title={app.t('explorer.up', 'Subir un directorio')}
                disabled={!listing?.parent}
                onclick={() => app.activeTabId && listing?.parent && load(app.activeTabId, listing.parent)}
            >↑</button>
            <button
                type="button"
                title={app.t('explorer.follow', 'Volver al directorio de la terminal')}
                onclick={async () => {
                    if (!app.activeTabId) return;
                    loading = true;
                    try {
                        listing = await api.followTab(app.activeTabId);
                    } finally {
                        loading = false;
                    }
                }}
            >⌖</button>
            <button
                type="button"
                title={app.t('explorer.refresh', 'Volver a leer la carpeta')}
                onclick={() => app.activeTabId && load(app.activeTabId, listing?.dir)}
            >⟳</button>
            <button
                type="button"
                title={app.t('explorer.cd', 'Llevar la terminal a esta carpeta')}
                onclick={() => app.activeTabId && act(() => api.cdToExplorerDir(app.activeTabId!))}
            >cd</button>
            <button
                type="button"
                class="close"
                title={app.t('explorer.hide', 'Ocultar el explorador (Ctrl+Shift+E)')}
                onclick={() => (app.explorerVisible = false)}
            >✕</button>
        </div>

        <div class="path" title={listing?.dir ?? ''}>{listing?.dir ?? ''}</div>

        <div class="actions">
            <button type="button" onclick={() => { creating = 'directory'; newName = ''; }}>
                {app.t('explorer.addFolder', '+ Carpeta')}
            </button>
            <button type="button" onclick={() => { creating = 'file'; newName = ''; }}>
                {app.t('explorer.addFile', '+ Archivo')}
            </button>
            <button
                type="button"
                class="glyph-button"
                title={app.t('explorer.openInSystem', 'Abrir en el gestor de archivos')}
                onclick={() => openFolderInSystem()}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                        d="M1.5 3.5h4l1.4 1.6h7.6v7.4H1.5z"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linejoin="round"
                    />
                    <path d="M9.5 8.5h3.5M11.3 6.8l1.7 1.7-1.7 1.7" fill="none" stroke="currentColor" stroke-width="1.3" />
                </svg>
            </button>
        </div>

        {#if managers}
            <!-- El sistema no supo abrir la carpeta. En vez de un error seco, se
                 ofrece con qué abrirla; lo elegido se puede dejar como fijo, que
                 es lo que consulta el backend la próxima vez. -->
            <div class="inline managers">
                <span>
                    {app.t('explorer.chooseManager', 'Abrir la carpeta con:')}
                </span>
                {#each managers.choices.installed as manager (manager.id)}
                    <button type="button" onclick={() => openWith(manager.id, false)}>
                        {manager.app}
                    </button>
                    <button
                        type="button"
                        class="remember"
                        title={app.t('explorer.rememberManager', 'Usar siempre este gestor')}
                        onclick={() => openWith(manager.id, true)}
                    >★</button>
                {:else}
                    <span class="hint">
                        {managers.choices.installable.length
                            ? app
                                  .t(
                                      'explorer.noManager',
                                      'No hay ningún gestor de archivos instalado. Se puede instalar: {list}'
                                  )
                                  .replace(
                                      '{list}',
                                      managers.choices.installable.map((item) => item.app).join(', ')
                                  )
                            : app.t(
                                  'explorer.noManagerAtAll',
                                  'No hay ningún gestor de archivos disponible en este sistema.'
                              )}
                    </span>
                {/each}
                <button type="button" onclick={() => (managers = null)}>✕</button>
            </div>
        {/if}

        {#if creating}
            <form
                class="inline"
                onsubmit={async (event) => {
                    event.preventDefault();
                    if (!app.activeTabId || !newName.trim()) return;
                    await act(() => api.createEntry(app.activeTabId!, newName.trim(), creating!));
                    creating = null;
                }}
            >
                <!-- svelte-ignore a11y_autofocus -->
                <input type="text" bind:value={newName} autocomplete="off" spellcheck="false" autofocus />
                <button type="submit">{app.t('explorer.create', 'Crear')}</button>
                <button type="button" onclick={() => (creating = null)}>✕</button>
            </form>
        {/if}

        {#if confirming}
            <div class="inline confirm">
                <span>
                    {app
                        .t('explorer.confirmTrash', '¿Enviar «{name}» a la papelera?')
                        .replace('{name}', confirming.name)}
                </span>
                <button
                    type="button"
                    class="danger"
                    onclick={async () => {
                        if (app.activeTabId && confirming) {
                            await act(() => api.trashEntry(app.activeTabId!, confirming!.path));
                        }
                        confirming = null;
                    }}
                >{app.t('explorer.delete', 'Eliminar')}</button>
                <button type="button" onclick={() => (confirming = null)}>✕</button>
            </div>
        {/if}

        {#if status}
            <div class="status" class:error={statusError}>{status}</div>
        {/if}

        <div class="list">
            {#if loading}
                <div class="empty">{app.t('explorer.loading', 'Leyendo…')}</div>
            {:else}
                {#each entries as entry (entry.path)}
                    {#if renaming === entry.path}
                        <form
                            class="inline"
                            onsubmit={async (event) => {
                                event.preventDefault();
                                if (app.activeTabId && renameTo.trim()) {
                                    await act(() =>
                                        api.renameEntry(app.activeTabId!, entry.path, renameTo.trim())
                                    );
                                }
                                renaming = '';
                            }}
                        >
                            <!-- svelte-ignore a11y_autofocus -->
                            <input type="text" bind:value={renameTo} autocomplete="off" autofocus />
                            <button type="submit">✓</button>
                            <button type="button" onclick={() => (renaming = '')}>✕</button>
                        </form>
                    {:else}
                        <button
                            type="button"
                            class="entry"
                            class:dir={entry.kind === 'directory'}
                            class:hidden-entry={entry.hidden}
                            title={entry.kind === 'directory'
                                ? app.t('explorer.enter', 'Entrar')
                                : app.t('explorer.openHint', 'Doble clic para abrir')}
                            onclick={() => clickEntry(entry)}
                            ondblclick={() => doubleClickEntry(entry)}
                            oncontextmenu={(event) => {
                                event.preventDefault();
                                menu = {
                                    x: Math.min(event.clientX, window.innerWidth - 170),
                                    y: Math.min(event.clientY, window.innerHeight - 190),
                                    entry
                                };
                            }}
                        >
                            <span class="icon">{entry.kind === 'directory' ? '📁' : '📄'}</span>
                            <span class="name">{entry.name}{entry.link ? ' ↗' : ''}</span>
                            <span class="size">{size(entry)}</span>
                        </button>
                    {/if}
                {:else}
                    <!-- Solo cuando la carpeta se ha podido leer de verdad. Sin
                         entradas porque no hay permisos NO es «carpeta vacía»:
                         el error ya está arriba y esto lo contradecía. -->
                    {#if listing?.ok !== false}
                        <div class="empty">{app.t('explorer.empty', 'Carpeta vacía.')}</div>
                    {/if}
                {/each}
                {#if listing?.truncated}
                    <div class="empty">
                        {app.t('explorer.truncated', 'Hay más entradas de las que caben en la lista.')}
                    </div>
                {/if}
            {/if}
        </div>
    </aside>
{/if}

{#if menu}
    <div class="menu-backdrop" onmousedown={() => (menu = null)} role="presentation"></div>
    <div class="menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
        {#if menu.entry}
            {@const entry = menu.entry}
            <button type="button" role="menuitem" onclick={() => fromMenu(openEntry)}>
                {entry.kind === 'directory'
                    ? app.t('explorer.enter', 'Entrar')
                    : app.t('explorer.open', 'Abrir')}
            </button>
            {#if entry.kind === 'directory'}
                <button
                    type="button"
                    role="menuitem"
                    onclick={() => fromMenu((target) => void openFolderInSystem(target.path))}
                >{app.t('explorer.openInSystem', 'Abrir en el gestor de archivos')}</button>
            {/if}
            <button
                type="button"
                role="menuitem"
                onclick={() =>
                    fromMenu((target) => {
                        renaming = target.path;
                        renameTo = target.name;
                    })}
            >{app.t('explorer.rename', 'Renombrar')}</button>
            <button
                type="button"
                role="menuitem"
                onclick={() => fromMenu((target) => void clip(target, 'copy'))}
            >{app.t('explorer.copy', 'Copiar')}</button>
            <button
                type="button"
                role="menuitem"
                onclick={() => fromMenu((target) => void clip(target, 'cut'))}
            >{app.t('explorer.cut', 'Cortar')}</button>
            <button
                type="button"
                role="menuitem"
                class="danger"
                onclick={() => fromMenu((target) => (confirming = target))}
            >{app.t('explorer.trash', 'Enviar a la papelera')}</button>
        {/if}
        <!-- Sin nada copiado, «Pegar» solo puede devolver «No hay nada que
             pegar»: se queda deshabilitado en vez de prometer una acción. -->
        <button
            type="button"
            role="menuitem"
            disabled={!clipped}
            onclick={async () => {
                menu = null;
                if (!app.activeTabId) return;
                const result = await act(() => api.pasteEntry(app.activeTabId!));
                // Lo cortado se pega una sola vez: el backend lo suelta al pegar.
                if (result) clipped = false;
            }}
        >{app.t('explorer.paste', 'Pegar')}</button>
    </div>
{/if}

<style>
    .explorer {
        display: flex;
        flex: 0 0 auto;
        width: 260px;
        min-width: 180px;
        max-width: 45vw;
        flex-direction: column;
        border-right: 1px solid var(--border);
        background: var(--surface-alt);
        font-size: 12px;
        /* Se puede ensanchar arrastrando su borde. Aquí sí vale `resize` de
           CSS: la barra está anclada por la IZQUIERDA, así que su asa nativa
           (abajo a la derecha) crece hacia dentro de la ventana. */
        overflow: auto;
        resize: horizontal;
    }

    .toolbar,
    .actions,
    .inline {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 6px;
    }

    .toolbar {
        border-bottom: 1px solid var(--border);
    }

    .toolbar .close {
        margin-left: auto;
    }

    .path {
        flex: 0 0 auto;
        overflow: hidden;
        padding: 4px 6px;
        color: var(--muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .inline input {
        flex: 1 1 80px;
        min-width: 0;
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 11px;
    }

    .confirm span,
    .managers span {
        flex: 1 1 100%;
        color: var(--text);
        font-size: 11px;
    }

    .managers .hint {
        color: var(--muted);
        font-size: 10px;
    }

    .managers .remember {
        padding: 3px 5px;
        color: var(--accent);
    }

    /* El icono dibujado ocupa el sitio del texto de los otros botones de la
       misma fila, así que la fila no cambia de alto por llevarlo. */
    .glyph-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 7px;
    }

    .glyph-button svg {
        display: block;
        width: 13px;
        height: 13px;
    }

    .status {
        padding: 4px 6px;
        color: var(--muted);
        font-size: 10px;
    }

    .status.error {
        color: #e06c75;
    }

    .list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding-right: 8px;
    }

    .entry {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
        border: none;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 11px;
        text-align: left;
        cursor: pointer;
    }

    .entry:hover {
        background: var(--surface-hover);
    }

    .entry.dir .name {
        color: var(--accent);
    }

    /* Los ocultos se ven, pero atenuados: esconderlos del todo obliga a salir
       al explorador del sistema para tocar un `.gitignore`. */
    .entry.hidden-entry {
        opacity: 0.55;
    }

    .entry .icon {
        flex: 0 0 auto;
    }

    .entry .name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .entry .size {
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 10px;
    }

    .empty {
        padding: 10px 6px;
        color: var(--muted);
        font-size: 11px;
    }

    button {
        padding: 3px 7px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
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
        opacity: 0.5;
        cursor: default;
    }

    .danger {
        border-color: #e06c75;
        color: #e06c75;
    }

    .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
    }

    .menu {
        position: fixed;
        z-index: 61;
        display: flex;
        min-width: 164px;
        flex-direction: column;
        padding: 4px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .menu button {
        border: none;
        background: transparent;
        text-align: left;
    }
</style>
