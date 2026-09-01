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
    import { compareLocalized, includesLocalized } from '../lib/localization';
    import { panels } from '../lib/panels.svelte';
    import type { InstallAction, UpdateStatus } from '../lib/types';
    import Panel from './Panel.svelte';

    let actions = $state<InstallAction[]>([]);
    let error = $state('');
    let loading = $state(false);
    /** La acción que se está preparando, para dejar su botón en marcha sin
     *  bloquear el resto del panel. */
    let running = $state('');
    let query = $state('');
    let statusFilter = $state<'all' | 'installed' | 'missing'>('all');

    /** Estado de la actualización de la PROPIA terminal. Null mientras no se ha
     *  consultado. No es una acción del catálogo: no se escribe ningún comando
     *  en la terminal, lo hace la app por dentro (descarga, intercambia los
     *  archivos y se reinicia), así que vive aparte. */
    let self = $state<UpdateStatus | null>(null);
    let checking = $state(false);
    let updating = $state(false);
    let selfError = $state('');

    /** El estado explícito solo guarda lo que la persona ha tocado. Si no hay
     *  una entrada, se aplica la preferencia común: todas cerradas o únicamente
     *  la primera abierta cuando `autoOpenFirstGroup` está activo. */
    let openSections = $state<Record<string, boolean>>({});

    /** Una entrada de la lista: o una acción suelta, o una herramienta con
     *  todas las suyas plegadas bajo su nombre. */
    interface Entry {
        name: string;
        description: string | null;
        installed: boolean;
        actions: InstallAction[];
    }

    interface Group {
        name: string;
        /** Clave estable: no depende del idioma de la interfaz. */
        key: string | null;
        total: number;
        entries: Entry[];
    }

    interface Section {
        id: string;
        title: string;
        description: string;
        groups: Group[];
    }

    /** El catálogo usa grupos técnicos. La persona que abre el panel, en
     *  cambio, suele pensar primero en qué quiere preparar: su terminal, su
     *  stack de desarrollo o una plataforma concreta. Estas son las cuatro
     *  secciones de navegación, en el orden en que conviene recorrerlas. */
    const SECTION_GROUPS = [
        { id: 'maintenance', keys: ['group.updates'] },
        { id: 'environments', keys: ['group.shells', 'group.wsl', 'group.windowsCompat'] },
        { id: 'development', keys: ['group.languages', 'group.frameworks', 'group.tools', 'group.viewers'] },
        { id: 'platforms', keys: ['group.containers', 'group.android', 'group.network', 'group.virt'] }
    ] as const;

    function sectionCopy(id: string): { title: string; description: string } {
        switch (id) {
            case 'maintenance':
                return {
                    title: app.t('deps.section.maintenance', 'Mantenimiento'),
                    description: app.t('deps.section.maintenanceHint', 'Actualiza la aplicación y las herramientas ya instaladas.')
                };
            case 'environments':
                return {
                    title: app.t('deps.section.environments', 'Entornos de ejecución'),
                    description: app.t('deps.section.environmentsHint', 'Terminales y sistemas donde se abren las pestañas.')
                };
            case 'development':
                return {
                    title: app.t('deps.section.development', 'Desarrollo'),
                    description: app.t('deps.section.developmentHint', 'Lenguajes, gestores de paquetes y herramientas para crear proyectos.')
                };
            default:
                return {
                    title: app.t('deps.section.platforms', 'Plataformas e integración'),
                    description: app.t('deps.section.platformsHint', 'Contenedores, dispositivos, red y virtualización.')
                };
        }
    }

    /** Una frase responde "qué va aquí" antes de desplegar un acordeón. */
    function groupDescription(key: string | null): string {
        const copy: Record<string, [string, string]> = {
            'group.updates': ['deps.group.updates', 'Aplicación y paquetes ya instalados'],
            'group.shells': ['deps.group.shells', 'CMD, PowerShell y otras consolas'],
            'group.wsl': ['deps.group.wsl', 'Distribuciones Linux integradas con Windows'],
            'group.windowsCompat': ['deps.group.windowsCompat', 'Compatibilidad para ejecutar software de Windows'],
            'group.languages': ['deps.group.languages', 'Intérpretes, compiladores y sus gestores'],
            'group.frameworks': ['deps.group.frameworks', 'Ecosistemas y herramientas de cada lenguaje'],
            'group.tools': ['deps.group.tools', 'Git, compilación, diagnóstico y utilidades de desarrollo'],
            'group.viewers': ['deps.group.viewers', 'Editores y visores para trabajar con archivos'],
            'group.containers': ['deps.group.containers', 'Docker, Kubernetes e imágenes de contenedor'],
            'group.android': ['deps.group.android', 'ADB y herramientas para dispositivos Android'],
            'group.network': ['deps.group.network', 'SSH, VPN y acceso a equipos remotos'],
            'group.virt': ['deps.group.virt', 'Máquinas virtuales y características de virtualización']
        };
        const [translationKey, fallback] = copy[key ?? ''] ?? ['deps.group.other', 'Otras herramientas disponibles'];
        return app.t(translationKey, fallback);
    }

    /** Dentro de un apartado manda el estado, no el orden del catálogo: lo que
     *  ya está en el sistema va arriba (es donde se busca "ver versión" o
     *  "desinstalar") y lo que falta, abajo. A igualdad de estado, alfabético,
     *  que es lo único previsible cuando hay veinte entradas. `installed` lo
     *  marca el backend al filtrar, sin comprobaciones extra. */
    function byStateThenName(a: Entry, b: Entry): number {
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        return compareLocalized(a.name, b.name, app.catalog.language);
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
        const byGroup = new Map<string, { name: string; key: string | null; actions: InstallAction[] }>();
        for (const action of actions) {
            // El backend manda el apartado en español y su clave; se traduce
            // aquí, que es donde está el catálogo del idioma activo. La clave
            // estable evita que una traducción altere la organización visual.
            const name = translateGroupTitle(action.group, action.groupKey);
            const id = action.groupKey ?? action.group;
            const group = byGroup.get(id);
            if (group) group.actions.push(action);
            else byGroup.set(id, { name, key: action.groupKey ?? null, actions: [action] });
        }

        return [...byGroup.values()].map(({ name, key, actions: groupActions }): Group => {
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
                        description: action.description,
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
            const needle = query.trim();
            const filteredEntries = entries.filter((entry) => {
                if (statusFilter === 'installed' && !entry.installed) return false;
                if (statusFilter === 'missing' && entry.installed) return false;
                if (!needle) return true;
                return [
                    entry.name,
                    entry.description ?? '',
                    name,
                    ...entry.actions.flatMap((action) => [
                        action.label,
                        action.description ?? '',
                        action.hint ?? ''
                    ])
                ]
                    .some((text) => includesLocalized(text, needle, app.catalog.language));
            });
            return {
                name,
                key,
                total: groupActions.length,
                entries: filteredEntries.sort(byStateThenName)
            };
        }).filter((group) => {
            if (group.entries.length > 0) return true;
            if (group.key !== 'group.updates' || statusFilter === 'missing') return false;
            const needle = query.trim();
            return !needle || includesLocalized(app.t('deps.updateApp', 'Actualizar la terminal'), needle, app.catalog.language);
        });
    });

    /** Los apartados siguen existiendo para buscar y filtrar, pero ya no se
     *  presentan como una lista plana: cada uno aparece donde corresponde.
     *  Un grupo nuevo del backend cae en "Otras herramientas" en vez de perderse
     *  o romper el orden de los grupos conocidos. */
    const sections = $derived.by(() => {
        const placed = new Set<string>();
        const ordered: Section[] = SECTION_GROUPS.map(({ id, keys }) => {
            const sectionGroups = keys.flatMap((key) => {
                const group = groups.find((candidate) => candidate.key === key);
                if (group) placed.add(group.name);
                return group ? [group] : [];
            });
            return { id, ...sectionCopy(id), groups: sectionGroups };
        }).filter((section) => section.groups.length > 0);
        const otherGroups = groups.filter((group) => !placed.has(group.name));
        if (otherGroups.length) {
            ordered.push({
                id: 'other',
                title: app.t('deps.section.other', 'Otras herramientas'),
                description: app.t('deps.section.otherHint', 'Componentes disponibles que no pertenecen a una categoría principal.'),
                groups: otherGroups
            });
        }
        return ordered;
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

    /** Evita que una detección lenta de una apertura anterior pise la lista de
     *  una apertura posterior del panel. */
    let loadSerial = 0;
    /** Las reaperturas se unen a la detección que ya está en curso. Lanzar una
     *  segunda competiría por WSL y los gestores de paquetes; descartarla sin
     *  esperar, en cambio, dejaría una respuesta huérfana al cambiar el serial. */
    let refreshInFlight: ReturnType<typeof api.refreshInstallActions> | null = null;
    // La detección completa ejecuta sondas externas y puede tardar decenas de
    // segundos en Windows. Al reabrir el panel poco después no hay motivo para
    // repetirla: la lista visible sigue siendo válida y la detección se renueva
    // automáticamente cuando caduca esta ventana.
    const REFRESH_CACHE_MS = 60_000;
    let refreshedAt = 0;

    export async function load(): Promise<void> {
        // Cada apertura del panel empieza con los apartados plegados. El
        // estado de un `<details>` vive en el DOM y, al volver a mostrar el
        // panel, podía conservar la primera sección abierta aunque la
        // preferencia «Abrir la primera lista automáticamente» estuviera
        // desactivada. Solo se reabre la primera cuando la preferencia lo
        // solicita explícitamente mediante `sectionIsOpen`.
        openSections = {};
        const serial = ++loadSerial;
        // Primero lo YA detectado, que no toca el sistema y llega al instante.
        // Antes se pedía la detección completa antes de pintar nada y el panel
        // tardaba segundos en abrirse, con la ventana aparentemente colgada.
        loading = actions.length === 0;
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
        await refresh();
        void checkSelf();
    }

    /** Re-detecta el entorno y sustituye la lista si algo ha cambiado. Un fallo
     *  aquí no borra lo que ya se está enseñando: lo de antes sigue siendo
     *  válido, solo puede estar desactualizado. */
    async function refresh(): Promise<boolean> {
        const serial = loadSerial;
        if (
            !refreshInFlight &&
            refreshedAt > 0 &&
            Date.now() - refreshedAt < REFRESH_CACHE_MS
        ) {
            return true;
        }
        const request = refreshInFlight ?? api.refreshInstallActions();
        refreshInFlight = request;
        let ok = true;
        try {
            const list = await request;
            refreshedAt = Date.now();
            if (serial !== loadSerial) return false;
            actions = list.actions;
        } catch {
            ok = false;
            if (serial === loadSerial) {
                error = app.t('deps.detectFailed', 'No se pudo completar la detección del entorno.');
            }
        } finally {
            if (refreshInFlight === request) {
                refreshInFlight = null;
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

    /** El primer apartado se abre solo si el usuario lo ha pedido en Ajustes.
     *  Con veinte apartados, abrir uno por defecto ocupa espacio innecesario. */
    const autoOpenFirst = $derived(app.preferences?.autoOpenFirstGroup ?? false);

    function shouldAutoOpen(group: Group): boolean {
        return autoOpenFirst && groups[0]?.name === group.name;
    }

    function sectionIsOpen(id: string): boolean {
        return openSections[id] ?? (autoOpenFirst && sections[0]?.id === id);
    }

    function onSectionToggle(event: Event): void {
        const details = event.currentTarget as HTMLDetailsElement;
        const id = details.dataset.sectionId;
        if (id) openSections[id] = details.open;
        if (!details.open || !app.preferences?.exclusiveAccordionGroups) return;
        const parent = details.parentElement;
        if (!parent) return;
        // La preferencia se aplica también a las secciones grandes del panel,
        // no solo a los grupos internos. Al abrir una, la anterior se cierra.
        for (const other of parent.children) {
            if (other === details || !(other instanceof HTMLDetailsElement)) continue;
            other.open = false;
            const otherId = other.dataset.sectionId;
            if (otherId) openSections[otherId] = false;
        }
    }

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
    title={app.t('deps.header', 'Entornos y dependencias')}
    subtitle={error ||
        (loading && actions.length === 0
            ? app.t('deps.loading', 'Detectando…')
            : app.t('deps.onlyApplicable', 'Solo se muestran acciones aplicables a este sistema.'))}
    error={Boolean(error)}
    count={loading ? undefined : visibleComponentCount}
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
    {#if !loading && actions.length === 0}
        <div class="empty">
            {app.t('deps.allReady', 'Todo lo detectado está listo; no hay instalaciones pendientes.')}
        </div>
    {/if}

    <div class="sections" data-testid="dependency-sections">
        {#each sections as section (section.id)}
            <details
                class="section"
                data-testid="dependency-section"
                data-section-id={section.id}
                aria-labelledby={`dependency-section-${section.id}`}
                open={sectionIsOpen(section.id)}
                ontoggle={onSectionToggle}
            >
                <summary class="section-header">
                    <div>
                        <h3 id={`dependency-section-${section.id}`}>{section.title}</h3>
                        <p>{section.description}</p>
                    </div>
                    <span class="section-count">
                        {section.groups.reduce(
                            (total, group) => total + group.entries.length + (group.key === 'group.updates' ? 1 : 0),
                            0
                        )}
                    </span>
                </summary>

                {#each section.groups as group (group.name)}
                    <details
                        class="group"
                        data-testid="dependency-group"
                        data-group-key={group.key ?? undefined}
                        class:languages={group.key === 'group.languages'}
                        open={shouldAutoOpen(group)}
                        ontoggle={onToggle}
                    >
                        <summary class="group-title">
                            <span class="group-heading">
                                <span>{group.name}</span>
                                <small>{groupDescription(group.key)}</small>
                            </span>
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
                                    {@render item(entry.actions[0], false, entry.name, entry.description)}
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
                                        {@render item(action, true, undefined, undefined, !entry.description)}
                                    {/each}
                                </details>
                            {/if}
                        {/each}
                        </div>
                    </details>
                {/each}
            </details>
        {/each}
    </div>
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
{#snippet item(
    action: InstallAction,
    compact: boolean,
    title?: string,
    description?: string | null,
    showDescription: boolean = !compact
)}
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
        {#if showDescription && (description ?? action.description)}
            <div class="description">{description ?? action.description}</div>
        {/if}
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

    .description {
        margin-top: 3px;
        color: var(--text);
        font-size: 10px;
        line-height: 1.35;
        overflow-wrap: anywhere;
    }

    @container (max-width: 360px) {
        .filters {
            grid-template-columns: minmax(0, 1fr);
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
        margin: 6px 0;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.2);
        overflow: hidden;
    }

    .sections {
        width: 100%;
        min-width: 0;
        padding: 8px;
    }

    .section {
        min-width: 0;
        overflow: hidden;
    }

    .section + .section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
    }

    .section-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 4px 2px 6px;
        cursor: pointer;
        list-style: none;
    }

    .section-header::-webkit-details-marker {
        display: none;
    }

    .section-header::before {
        content: '›';
        flex: 0 0 auto;
        margin-top: 1px;
        color: var(--muted);
        font-size: 16px;
        line-height: 0.9;
        transform: rotate(0deg);
        transition: color 0.15s ease, transform 0.15s ease;
    }

    .section[open] > .section-header::before {
        color: var(--accent);
        transform: rotate(90deg);
    }

    .section:not([open]) > .section-header {
        padding-bottom: 4px;
    }

    .section-header:hover h3,
    .section-header:focus-visible h3 {
        color: var(--text);
    }

    .section-header > div {
        flex: 1 1 auto;
        min-width: 0;
    }

    .section-header h3,
    .section-header p {
        margin: 0;
    }

    .section-header h3 {
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        line-height: 1.35;
    }

    .section-header p {
        margin-top: 2px;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.35;
        overflow-wrap: anywhere;
    }

    .section-count {
        flex: 0 0 auto;
        min-width: 18px;
        padding: 2px 6px;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.2;
        text-align: center;
    }

    .group-title {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        gap: 8px;
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

    .group-title::before,
    .subgroup-title::before {
        content: '›';
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 16px;
        line-height: 0.75;
        transform: rotate(0deg);
        transition: color 0.15s ease, transform 0.15s ease;
    }

    .group[open] > .group-title::before,
    .subgroup[open] > .subgroup-title::before {
        color: var(--accent);
        transform: rotate(90deg);
    }

    .group-heading {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-width: 0;
        gap: 2px;
    }

    .group-heading > span {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .group-heading small {
        min-width: 0;
        color: var(--muted);
        font-size: 10px;
        font-weight: 400;
        line-height: 1.25;
        overflow-wrap: anywhere;
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
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .subgroup-heading small {
        min-width: 0;
        color: var(--muted);
        font-size: 10px;
        font-weight: 400;
        line-height: 1.25;
        overflow-wrap: anywhere;
    }

    .subgroup-title:hover {
        color: var(--accent);
        background: var(--surface-hover);
    }

    /* Marca lo que ya está en el sistema */
    .subgroup.installed > .subgroup-title::before {
        color: #4ec9b0;
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
