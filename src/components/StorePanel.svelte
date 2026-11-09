<script lang="ts">
    // Vista propia de la carpeta propia (fuera de Ajustes, donde se queda el
    // interruptor general y la carpeta raíz): la carpeta de cada categoría,
    // cada elemento con su interruptor, «Traer lo ya instalado» con vista
    // previa, copia, confirmación y vuelta atrás (`config::store_adopt`), y
    // exportar o importar la lista para llevarla a otro equipo.

    import Panel from './Panel.svelte';
    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type {
        PathIntegrationStatus,
        StoreAdoptItem,
        StoreImportResult,
        ToolchainStoreCategory,
        ToolchainStoreStatus,
    } from '../lib/types';

    let status = $state<ToolchainStoreStatus | null>(null);
    let pathIntegration = $state<PathIntegrationStatus | null>(null);
    let candidates = $state<StoreAdoptItem[] | null>(null);
    let searching = $state(false);
    let selected = $state<string[]>([]);
    let confirming = $state('');
    let message = $state('');
    let messageError = $state(false);
    let importResult = $state<StoreImportResult | null>(null);
    let installing = $state('');
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const CATEGORY_ORDER: ToolchainStoreCategory[] = [
        'caches', 'downloads', 'aiModels', 'tools', 'replHistory', 'toolchains', 'config', 'plugins', 'programs', 'projects',
    ];
    const SUBDIRS: Record<ToolchainStoreCategory, string> = {
        caches: 'cache', downloads: 'descargas', aiModels: 'ia', tools: 'herramientas', replHistory: 'historial',
        toolchains: 'toolchains', programs: 'programas', projects: 'proyectos', config: 'configuracion', plugins: 'plugins',
    };

    function categoryTitle(id: ToolchainStoreCategory): string {
        const titles: Record<ToolchainStoreCategory, [string, string]> = {
            caches: ['settings.storeCategoryCaches', 'Cachés'],
            downloads: ['settings.storeCategoryDownloads', 'Descargas del panel'],
            aiModels: ['settings.storeCategoryAiModels', 'Modelos de IA'],
            tools: ['settings.storeCategoryTools', 'Herramientas y lenguajes nuevos'],
            replHistory: ['settings.storeCategoryReplHistory', 'Historial de los REPL'],
            toolchains: ['settings.storeCategoryToolchains', 'Toolchains completas'],
            programs: ['settings.storeCategoryPrograms', 'Programas (WinGet y Chocolatey)'],
            projects: ['settings.storeCategoryProjects', 'Proyectos de GitHub'],
            config: ['settings.storeCategoryConfig', 'Configuración de los REPL'],
            plugins: ['settings.storeCategoryPlugins', 'Plugins de las shells'],
        };
        const [key, fallback] = titles[id];
        return app.t(key, fallback);
    }

    function formatBytes(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const digits = unit === 0 || value >= 100 ? 0 : 1;
        return `${value.toLocaleString(app.catalog.language || undefined, { maximumFractionDigits: digits })} ${units[unit]}`;
    }

    function say(text: string, error = false): void {
        message = text;
        messageError = error;
    }

    // ---- Carpeta de cada categoría ----

    const categoryDirs = $derived.by(() => {
        const map = new Map<string, string>();
        for (const line of (app.preferences?.toolchainStoreCategoryDirs ?? '').split('\n')) {
            const at = line.indexOf('=');
            if (at > 0) map.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
        }
        return map;
    });

    function separator(root: string): string {
        return root.includes('\\') ? '\\' : '/';
    }

    function categoryPath(id: ToolchainStoreCategory): string {
        const own = categoryDirs.get(id);
        if (own) return own;
        const root = status?.root ?? '';
        return root ? `${root}${separator(root)}${SUBDIRS[id]}` : '';
    }

    async function saveCategoryDir(id: ToolchainStoreCategory, dir: string): Promise<void> {
        const next = new Map(categoryDirs);
        if (dir) next.set(id, dir);
        else next.delete(id);
        const text = [...next.entries()].map(([key, value]) => `${key}=${value}`).join('\n');
        await app.savePreferences({ toolchainStoreCategoryDirs: text });
        await reload();
    }

    async function chooseCategoryDir(id: ToolchainStoreCategory): Promise<void> {
        const dir = await api.pickRepositoryFolder();
        if (dir) await saveCategoryDir(id, dir);
    }

    // ---- Cada elemento con su interruptor ----

    const disabled = $derived(new Set((app.preferences?.toolchainStoreDisabled ?? '').split(',').map((id) => id.trim()).filter(Boolean)));

    async function toggleEntry(id: string, on: boolean): Promise<void> {
        const next = new Set(disabled);
        if (on) next.delete(id);
        else next.add(id);
        await app.savePreferences({ toolchainStoreDisabled: [...next].join(',') });
        await reload();
    }

    // ---- Traer lo ya instalado ----

    const copying = $derived((candidates ?? []).some((item) => item.state === 'copying'));
    const selectedBytes = $derived((candidates ?? []).filter((item) => selected.includes(item.id)).reduce((sum, item) => sum + item.bytes, 0));
    const needsPathIntegration = $derived(
        pathIntegration?.supported === true && !pathIntegration.enabled
            && (candidates ?? []).some((item) => item.method === 'variable' && (item.state === 'done' || selected.includes(item.id))),
    );

    function stateLabel(item: StoreAdoptItem): string {
        switch (item.state) {
            case 'copying':
                return app.t('store.copying', 'Copiando… {done} de {total}')
                    .replace('{done}', formatBytes(item.copiedBytes)).replace('{total}', formatBytes(item.bytes));
            case 'done':
                return app.t('store.done', 'Traído: el original sigue en su sitio hasta que confirmes');
            case 'confirmed':
                return app.t('store.confirmed', 'Traído y original borrado');
            case 'failed':
                return app.t('store.failed', 'Falló: no se cambió nada');
            case 'blocked':
                return app.t('store.blocked', 'No se puede traer');
            default:
                return '';
        }
    }

    function methodLabel(item: StoreAdoptItem): string {
        if (item.method === 'junction') {
            return item.needsAdmin
                ? app.t('store.methodJunctionAdmin', 'Se copia y queda una unión en su sitio (pide permisos de administrador)')
                : app.t('store.methodJunction', 'Se copia y queda una unión en su sitio');
        }
        if (item.method === 'profile') return app.t('store.methodProfile', 'Se copia y WTerminal usa la copia');
        return app.t('store.methodVariable', 'Se copia y la variable apunta a la copia');
    }

    async function search(): Promise<void> {
        searching = true;
        say(app.t('store.searching', 'Buscando y midiendo lo instalado… la primera vez puede tardar.'));
        try {
            const [items, integration] = await Promise.all([
                api.getStoreAdoptCandidates(),
                api.getPathIntegration().catch(() => null),
            ]);
            candidates = items;
            pathIntegration = integration;
            selected = selected.filter((id) => items.some((item) => item.id === id && (item.state === 'available' || item.state === 'failed')));
            say(items.length
                ? ''
                : app.t('store.nothing', 'No hay nada instalado fuera de la carpeta propia que se pueda traer.'));
            schedulePoll();
        } catch (cause) {
            say(String(cause), true);
        } finally {
            searching = false;
        }
    }

    function schedulePoll(): void {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        if (!copying || !panels.isOpen('store')) return;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            void api.getStoreAdoptCandidates().then((items) => {
                candidates = items;
                schedulePoll();
            }).catch(() => schedulePoll());
        }, 1000);
    }

    function toggleSelected(id: string, on: boolean): void {
        selected = on ? [...selected, id] : selected.filter((item) => item !== id);
    }

    async function adoptSelected(): Promise<void> {
        if (!selected.length) return;
        try {
            await api.runStoreAdopt(selected);
            selected = [];
            say(app.t('store.started', 'Copiando. Puedes seguir usando WTerminal; el original no se toca hasta que confirmes.'));
            await search();
        } catch (cause) {
            say(String(cause), true);
        }
    }

    async function confirm(item: StoreAdoptItem): Promise<void> {
        if (confirming !== item.id) {
            confirming = item.id;
            return;
        }
        confirming = '';
        try {
            await api.confirmStoreAdopt(item.id);
            say(app.t('store.confirmedMessage', '{name}: original borrado ({size} liberados).').replace('{name}', item.label).replace('{size}', formatBytes(item.bytes)));
            await search();
        } catch (cause) {
            say(String(cause), true);
        }
    }

    async function undo(item: StoreAdoptItem): Promise<void> {
        try {
            await api.undoStoreAdopt(item.id);
            say(app.t('store.undone', '{name}: vuelve a estar como antes.').replace('{name}', item.label));
            await search();
        } catch (cause) {
            say(String(cause), true);
        }
    }

    // ---- Exportar e importar ----

    async function exportList(): Promise<void> {
        try {
            if (await api.exportStoreList()) say(app.t('store.exported', 'Lista guardada.'));
        } catch (cause) {
            say(String(cause), true);
        }
    }

    async function importList(): Promise<void> {
        try {
            const result = await api.importStoreList();
            if (!result) return;
            importResult = result;
            if (!result.ok) {
                say(result.error ?? app.t('store.importFailed', 'No se pudo importar la lista.'), true);
                return;
            }
            await app.reloadPreferences();
            await reload();
            say(result.missing.length
                ? app.t('store.importedMissing', 'Ajustes importados. Faltan {count} herramientas de la lista: instálalas desde aquí.').replace('{count}', String(result.missing.length))
                : app.t('store.imported', 'Ajustes importados. Ya tienes todo lo de la lista.'));
        } catch (cause) {
            say(String(cause), true);
        }
    }

    async function install(id: string): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId || installing) return;
        installing = id;
        try {
            const result = await api.runInstallAction(tabId, id);
            if (!result.ok) {
                say(result.error ?? app.t('deps.actionFailed', 'No se pudo preparar la acción.'), true);
                return;
            }
            if (importResult) importResult = { ...importResult, missing: importResult.missing.filter((item) => item.id !== id) };
            panels.close();
            if (result.tabId) await app.adoptTab(result.tabId, result.created);
        } catch (cause) {
            say(String(cause), true);
        } finally {
            installing = '';
        }
    }

    async function reload(): Promise<void> {
        status = await api.getToolchainStore().catch(() => status);
    }

    export async function load(): Promise<void> {
        await reload();
    }

    $effect(() => {
        if (!panels.isOpen('store') && pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    });

    const subtitle = $derived(
        !status
            ? app.t('settings.toolchainStoreCalculating', 'Calculando el espacio…')
            : status.enabled
                ? app.t('store.inUse', 'En uso: {path}').replace('{path}', status.root)
                : app.t('store.off', 'Desactivada en Ajustes: no se reubica nada'),
    );
</script>

<Panel id="store" title={app.t('store.title', 'Carpeta propia')} {subtitle} error={!!status && !status.enabled} width={560}>
    <div class="store" data-testid="store-view">
        {#if message}
            <div class="message" class:error={messageError} role="status" data-testid="store-message">{message}</div>
        {/if}

        <section data-testid="store-category-dirs">
            <h3>{app.t('store.categoryDirs', 'Carpeta de cada categoría')}</h3>
            <p class="hint">{app.t('store.categoryDirsHint', 'De fábrica, todas van dentro de la carpeta propia. Puedes llevar cualquiera a otro sitio, por ejemplo los modelos de IA a otro disco. Lo que ya estaba en la carpeta anterior no se mueve.')}</p>
            {#each CATEGORY_ORDER as id (id)}
                <div class="row" data-testid="store-category-dir" data-category={id}>
                    <div class="grow">
                        <strong>{categoryTitle(id)}</strong>
                        <small class="path">{categoryPath(id)}</small>
                    </div>
                    <button type="button" onclick={() => void chooseCategoryDir(id)}>{app.t('store.choose', 'Elegir…')}</button>
                    <button type="button" disabled={!categoryDirs.has(id)} onclick={() => void saveCategoryDir(id, '')}>{app.t('store.default', 'Por defecto')}</button>
                </div>
            {/each}
        </section>

        <section data-testid="store-entries">
            <h3>{app.t('store.entries', 'Elementos')}</h3>
            <p class="hint">{app.t('store.entriesHint', 'Cada elemento de una categoría activa se puede apagar por separado: vuelve a su sitio de siempre en las terminales nuevas.')}</p>
            {#each status?.caches ?? [] as cache (cache.id)}
                <label class="row check" data-testid="store-entry" data-entry-id={cache.id}>
                    <input type="checkbox" checked={!disabled.has(cache.id)} onchange={(event) => void toggleEntry(cache.id, event.currentTarget.checked)} />
                    <span class="grow">
                        <strong>{cache.name}</strong>
                        <small>{categoryTitle(cache.category)} · {cache.variable} · {cache.measured ? formatBytes(cache.bytes) : '—'}</small>
                    </span>
                </label>
            {/each}
        </section>

        <section data-testid="store-adopt">
            <h3>{app.t('store.adopt', 'Traer lo ya instalado')}</h3>
            <p class="hint">{app.t('store.adoptHint', 'Copia a la carpeta propia lo que ya tenías instalado. El original no se toca hasta que confirmes, y hasta entonces puedes deshacerlo. Los programas instalados con MSI no se traen: sus actualizaciones fallan en una unión.')}</p>
            <div class="actions">
                <button type="button" data-testid="store-adopt-search" disabled={searching || !status?.enabled} onclick={() => void search()}>
                    {searching ? app.t('store.searchingShort', 'Buscando…') : app.t('store.search', 'Buscar lo instalado')}
                </button>
                <button type="button" data-testid="store-adopt-run" disabled={!selected.length || copying} onclick={() => void adoptSelected()}>
                    {app.t('store.adoptSelected', 'Traer los marcados ({size})').replace('{size}', formatBytes(selectedBytes))}
                </button>
            </div>
            {#if needsPathIntegration}
                <div class="warning" data-testid="store-adopt-path-warning">{app.t('store.pathWarning', 'La integración con el PATH está apagada: lo traído solo se verá desde WTerminal. Actívala en Ajustes para que rustup, cargo o IPython lo encuentren también fuera.')}</div>
            {/if}
            {#each candidates ?? [] as item (item.id)}
                <div class="adopt-item" data-testid="store-adopt-item" data-adopt-id={item.id} data-state={item.state}>
                    <div class="row">
                        {#if item.state === 'available' || item.state === 'failed'}
                            <input type="checkbox" aria-label={item.label} checked={selected.includes(item.id)} disabled={copying} onchange={(event) => toggleSelected(item.id, event.currentTarget.checked)} />
                        {/if}
                        <div class="grow">
                            <strong>{item.label}</strong>
                            <small>{categoryTitle(item.category)} · {formatBytes(item.bytes)}</small>
                            <small class="path">{item.source} → {item.destination}</small>
                            <small>{methodLabel(item)}</small>
                            {#if stateLabel(item)}<small class="state">{stateLabel(item)}</small>{/if}
                            {#if item.reason}<small class="reason">{item.reason}</small>{/if}
                        </div>
                    </div>
                    {#if item.state === 'copying'}
                        <progress max={Math.max(1, item.bytes)} value={item.copiedBytes}></progress>
                    {/if}
                    {#if item.state === 'done'}
                        <div class="actions">
                            <button type="button" class:danger={confirming === item.id} data-testid="store-adopt-confirm" onclick={() => void confirm(item)}>
                                {confirming === item.id
                                    ? app.t('store.confirmSure', '¿Borrar el original ({size})? No se puede deshacer').replace('{size}', formatBytes(item.bytes))
                                    : app.t('store.confirm', 'Confirmar y borrar el original')}
                            </button>
                            <button type="button" data-testid="store-adopt-undo" onclick={() => void undo(item)}>{app.t('store.undo', 'Deshacer')}</button>
                        </div>
                    {/if}
                </div>
            {/each}
        </section>

        <section data-testid="store-transfer">
            <h3>{app.t('store.transfer', 'Exportar e importar la lista')}</h3>
            <p class="hint">{app.t('store.transferHint', 'Guarda en un archivo la configuración de la carpeta propia y lo que tienes instalado desde el catálogo, para dejar otro equipo igual.')}</p>
            <div class="actions">
                <button type="button" data-testid="store-export" onclick={() => void exportList()}>{app.t('store.export', 'Exportar…')}</button>
                <button type="button" data-testid="store-import" onclick={() => void importList()}>{app.t('store.import', 'Importar…')}</button>
            </div>
            {#if importResult?.ok}
                {#each importResult.missing as missing (missing.id)}
                    <div class="row" data-testid="store-import-missing" data-action-id={missing.id}>
                        <span class="grow">{missing.label}</span>
                        <button type="button" disabled={!!installing} onclick={() => void install(missing.id)}>{app.t('store.install', 'Instalar')}</button>
                    </div>
                {/each}
                {#if importResult.unknown.length}
                    <small class="reason">{app.t('store.importUnknown', 'No están en el catálogo de este equipo: {list}').replace('{list}', importResult.unknown.join(', '))}</small>
                {/if}
            {/if}
        </section>
    </div>
</Panel>

<style>
    .store {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 10px 12px 14px;
        container-type: inline-size;
    }

    section {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    h3 {
        margin: 0;
        font-size: 13px;
    }

    .hint,
    small {
        color: var(--text-muted, #9a9a9a);
        font-size: 11px;
        margin: 0;
    }

    small {
        display: block;
        overflow-wrap: anywhere;
    }

    .row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }

    .row.check {
        cursor: pointer;
    }

    .grow {
        flex: 1 1 auto;
        min-width: 0;
    }

    .path {
        font-family: var(--mono-font, monospace);
    }

    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .adopt-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
    }

    .adopt-item[data-state='blocked'] {
        opacity: 0.75;
    }

    .state {
        color: var(--accent);
    }

    .reason {
        color: var(--warning, #e0a030);
    }

    .warning,
    .message {
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        font-size: 12px;
    }

    .warning,
    .message.error {
        border-color: var(--warning, #e0a030);
    }

    button.danger {
        border-color: var(--danger, #f14c4c);
    }

    progress {
        width: 100%;
    }

    @container (max-width: 360px) {
        .row {
            flex-wrap: wrap;
        }
    }
</style>
