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
    import { tick } from 'svelte';
    import { app } from '../lib/appState.svelte';
    import { compareLocalized, includesLocalized } from '../lib/localization';
    import { panels } from '../lib/panels.svelte';
    import type { InstallAction, UpdateStatus } from '../lib/types';
    import Panel from './Panel.svelte';

    let actions = $state<InstallAction[]>([]);
    // Conserva el tamaño del catálogo estructural antes de que las sondas
    // perezosas retiren familias no aplicables. La auditoría puede así
    // demostrar las 990 entradas publicadas inicialmente aunque la lista
    // visible final solo contenga las acciones válidas para este sistema.
    let catalogTotalActions = $state(0);
    let catalogActionKeys = $state<string[]>([]);
    let catalogComplete = $state(false);
    let error = $state('');
    let loading = $state(false);
    /** Detección completa solicitada desde el botón visible del panel. Se
     *  separa de `loading` porque la lista anterior debe seguir visible mientras
     *  se vuelven a consultar PATH, WinGet, WSL y los gestores de paquetes. */
    let detecting = $state(false);
    /** Las secciones se confirman una a una después de recibir su inventario
     *  completo. Nunca se pinta una categoría mientras aún se está mezclando
     *  la respuesta de otra sonda. */
    let confirmedSectionIds = $state<string[]>([]);
    /** La acción que se está preparando, para dejar su botón en marcha sin
     *  bloquear el resto del panel. */
    let running = $state('');
    /** Sondas iniciadas al abrir una herramienta concreta. */
    let checkingActions = $state<Set<string>>(new Set());
    /** Las aperturas sucesivas del auditor pueden tocar muchas familias en un
     *  mismo frame. Serializar las sondas evita que WinGet/WSL y los gestores
     *  de paquetes arranquen decenas de procesos a la vez y desconecten
     *  WebView2; el catálogo sigue apareciendo sin esperar a esta cola. */
    let checkQueue: Promise<void> = Promise.resolve();
    let queuedCheckIds = new Set<string>();
    /** Generación de sondas perezosas. Una detección completa invalida las
     *  comprobaciones que se iniciaron al navegar por el catálogo anterior;
     *  sus respuestas no deben volver a mezclar estados antiguos en la lista
     *  nueva ni dejar botones atascados en «Comprobando…». */
    let checkGeneration = 0;
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
    /** Los grupos y subgrupos también necesitan estado explícito. Dejar que
     *  `<details>` lo conserve solo en el DOM hacía que una actualización
     *  rápida del catálogo volviera a aplicar `open={false}` y cerrara el menú
     *  justo después de abrirlo. */
    let openAccordions = $state<Record<string, boolean>>({});

    /** Una entrada de la lista: o una acción suelta, o una herramienta con
     *  todas las suyas plegadas bajo su nombre. */
    interface Entry {
        name: string;
        description: string | null;
        installed: boolean;
        actions: InstallAction[];
        children: Entry[];
        /** Mantiene la cabecera del ecosistema aunque solo quede «Instalar». */
        isSubgroup: boolean;
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
        { id: 'updates', keys: ['group.updates'] },
        { id: 'environments', keys: ['group.shells', 'group.wsl', 'group.windowsCompat'] },
        { id: 'development', keys: ['group.languages', 'group.frameworks', 'group.tools', 'group.viewers'] },
        // Asistentes en la terminal y modelos locales: apartado propio para
        // que se encuentren sin rebuscar entre los frameworks.
        { id: 'ai', keys: ['group.ai'] },
        // Docker y ADB son plataformas de integración (contenedores y
        // dispositivos), por eso permanecen juntos en este apartado.
        { id: 'platforms', keys: ['group.containers', 'group.android', 'group.network', 'group.virt'] }
    ] as const;

    function sectionCopy(id: string): { title: string; description: string } {
        switch (id) {
            case 'updates':
                return {
                    title: app.t('group.updates', 'Actualizaciones'),
                    description: app.t('deps.group.updates', 'Aplicación y paquetes ya instalados')
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
            case 'ai':
                return {
                    title: app.t('group.ai', 'Inteligencia artificial'),
                    description: app.t('deps.section.aiHint', 'Asistentes de IA en la terminal y modelos locales, con sus requisitos.')
                };
            default:
                return {
                    title: app.t('deps.section.platforms', 'Plataformas e integración'),
                    description: app.t('deps.section.platformsHint', 'Dispositivos, red y virtualización.')
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
            'group.ai': ['deps.group.ai', 'Asistentes en la terminal y modelos que se ejecutan en tu equipo'],
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
        if (groupKey === 'group.containers') return app.t('group.docker', 'Docker');
        if (groupKey) return app.t(groupKey, rawGroup);
        if (rawGroup === 'Actualizaciones') return app.t('group.updates', 'Actualizaciones');
        if (rawGroup === 'Shells') return app.t('group.shells', 'Shells');
        if (rawGroup === 'Sistema y herramientas') return app.t('group.tools', 'Sistema y herramientas');
        if (rawGroup === 'Lenguajes') return app.t('group.languagesShort', 'Lenguajes');
        if (rawGroup === 'Frameworks') return app.t('group.frameworks', 'Frameworks y ecosistemas');
        if (rawGroup === 'Visores de archivos') return app.t('group.viewers', 'Visores de archivos');
        if (rawGroup === 'WSL') return app.t('group.wslShort', 'WSL');
        if (rawGroup === 'Docker') return app.t('group.dockerShort', 'Docker');
        // El nombre visible debe seguir siendo Docker, aunque el backend
        // agrupe también sus acciones de Kubernetes e imágenes bajo el mismo
        // grupo estable.
        if (rawGroup === 'Contenedores y Kubernetes') return app.t('group.docker', 'Docker');
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
            // propio nombre. Los frameworks añaden un nivel: familia de
            // ecosistema -> framework -> instalar/actualizar/desinstalar.
            const subgroups = new Map<string, Entry>();
            const entries: Entry[] = [];
            for (const action of groupActions) {
                if (!action.subgroup) {
                    entries.push({
                        name: action.label,
                        description: action.description,
                        installed: action.installed === true,
                        actions: [action],
                        children: [],
                        isSubgroup: false
                    });
                    continue;
                }
                let entry = subgroups.get(action.subgroup);
                if (!entry) {
                    entry = {
                        name: action.subgroup,
                        description: action.subgroupDescription,
                        installed: false,
                        actions: [],
                        children: [],
                        isSubgroup: true
                    };
                    subgroups.set(action.subgroup, entry);
                    entries.push(entry);
                }
                const target = action.subgroupItem
                    ? (() => {
                          let child = entry.children.find((candidate) => candidate.name === action.subgroupItem);
                          if (!child) {
                              child = {
                                  name: action.subgroupItem,
                                  description: null,
                                  installed: false,
                                  actions: [],
                                  children: [],
                                  isSubgroup: true
                              };
                              entry.children.push(child);
                          }
                          return child;
                      })()
                    : entry;
                target.actions.push(action);
                if (!target.description && action.subgroupDescription && !action.subgroupItem) {
                    target.description = action.subgroupDescription;
                }
                // Basta con que UNA acción requiera la herramienta para saber
                // que está presente; el padre hereda el estado de sus hijos.
                if (action.installed === true) {
                    target.installed = true;
                    entry.installed = true;
                }
            }
            // La clave viaja con el grupo para poder reconocer «Actualizaciones»
            // sin comparar contra su nombre traducido.
            const needle = query.trim();
            const stateMatches = (entry: Entry) =>
                statusFilter === 'all'
                    || (statusFilter === 'installed' ? entry.installed : !entry.installed);
            const textMatches = (entry: Entry) => [
                entry.name,
                entry.description ?? '',
                name,
                ...entry.actions.flatMap((action) => [
                    action.label,
                    action.description ?? '',
                    action.hint ?? ''
                ])
            ].some((text) => includesLocalized(text, needle, app.catalog.language));
            const filterEntry = (entry: Entry): Entry | null => {
                const parentMatches = !needle || textMatches(entry);
                if (entry.children.length === 0) {
                    return stateMatches(entry) && parentMatches ? entry : null;
                }
                const children = entry.children
                    .map(filterEntry)
                    .filter((child): child is Entry => child !== null);
                if (!children.length && !parentMatches) return null;
                return {
                    ...entry,
                    children: parentMatches && !needle && statusFilter === 'all' ? entry.children : children
                };
            };
            const sortEntries = (list: Entry[]) => {
                for (const entry of list) sortEntries(entry.children);
                list.sort(byStateThenName);
            };
            const filteredEntries = entries
                .map(filterEntry)
                .filter((entry): entry is Entry => entry !== null);
            sortEntries(filteredEntries);
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
                if (group) placed.add(group.key ?? group.name);
                return group ? [group] : [];
            });
            return { id, ...sectionCopy(id), groups: sectionGroups };
        }).filter((section) => section.groups.length > 0);
        const otherGroups = groups.filter((group) => !placed.has(group.key ?? group.name));
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

    /** Orden fijo de los menús visibles. Un grupo nuevo puede caer en
     *  «other», pero nunca adelanta una sección que todavía no fue confirmada. */
    const visibleSections = $derived(
        loading
            ? sections.filter((section) => confirmedSectionIds.includes(section.id))
            : sections
    );

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
    // El catálogo rápido puede contener acciones aún desconocidas mientras
    // se completa la primera detección. Mostrar ese recuento y luego cambiarlo
    // al inventario confirmado hacía visible un salto (106 → 99) aunque la
    // comprobación final fuese estable. El contador se publica solo cuando
    // todas las acciones visibles tienen un estado confirmado.
    const hasPendingDetection = $derived(actions.some((action) => action.detectionStatus === 'unknown'));

    /** Evita que una detección lenta de una apertura anterior pise la lista de
     *  una apertura posterior del panel. */
    let loadSerial = 0;
    /** Las reaperturas se unen a la detección que ya está en curso. Lanzar una
     *  segunda competiría por WSL y los gestores de paquetes; descartarla sin
     *  esperar, en cambio, dejaría una respuesta huérfana al cambiar el serial. */
    let refreshInFlight: ReturnType<typeof api.refreshInstallActions> | null = null;
    // La detección completa ejecuta sondas externas y puede tardar decenas de
    // segundos en Windows. El resultado queda vivo durante toda la sesión: al
    // reabrir el panel no se vuelve a sondear nada. Solo el botón visible de
    // «Comprobar de nuevo» invalida esta copia y fuerza otra pasada completa.
    let refreshedAt = 0;

    /** Ajustes puede abrir el panel ya filtrado por una herramienta
     *  (`panels.depsQuery`): se aplica el filtro al empezar y, cuando el
     *  catálogo está listo, se despliega todo lo que coincide. */
    function takeRequestedQuery(): string {
        const requested = panels.depsQuery.trim();
        panels.depsQuery = '';
        if (requested) {
            query = requested;
            statusFilter = 'all';
        }
        return requested;
    }

    async function openRequestedMatches(): Promise<void> {
        await tick();
        const sectionsOpen: Record<string, boolean> = {};
        const accordions: Record<string, boolean> = {};
        for (const section of sections) {
            sectionsOpen[section.id] = true;
            for (const group of section.groups) {
                accordions[accordionKey('group', group)] = true;
                for (const entry of group.entries) {
                    if (entry.isSubgroup) accordions[accordionKey('subgroup', group, entry)] = true;
                }
            }
        }
        openSections = sectionsOpen;
        openAccordions = accordions;
    }

    export async function load(): Promise<void> {
        const requested = takeRequestedQuery();
        // Abrir el mismo panel otra vez no debe volver a ponerlo en estado de
        // detección. `App.svelte` conserva el componente montado, por lo que
        // un inventario ya confirmado se puede reutilizar sin lanzar sondas ni
        // mostrar durante un frame la pantalla de carga.
        if (refreshedAt > 0 && !refreshInFlight) {
            openSections = {};
            openAccordions = {};
            if (requested) await openRequestedMatches();
            void checkSelf();
            return;
        }
        // Cada apertura del panel empieza con los apartados plegados. El
        // estado de un `<details>` vive en el DOM y, al volver a mostrar el
        // panel, podía conservar la primera sección abierta aunque la
        // preferencia «Abrir la primera lista automáticamente» estuviera
        // desactivada. Solo se reabre la primera cuando la preferencia lo
        // solicita explícitamente mediante `sectionIsOpen`.
        openSections = {};
        openAccordions = {};
        const serial = ++loadSerial;
        // No se muestra el inventario rápido mientras la detección completa
        // sigue en curso. Ese inventario podía contener solo una parte del
        // catálogo y hacía parecer que las secciones iban apareciendo a
        // medias. Cada apertura confirma todo el recorrido y publica la lista
        // una sola vez, cuando todas las sondas han terminado.
        loading = true;
        error = '';
        // `install_list` devuelve el último catálogo completo que guardó el
        // backend. Si todavía no existe, el propio comando hace la primera
        // detección completa. Nunca se lanza una actualización automática al
        // volver a abrir el panel.
        await refresh(false);
        if (serial === loadSerial) loading = false;
        if (requested && serial === loadSerial) await openRequestedMatches();
        void checkSelf();
    }

    /** Re-detecta el entorno y sustituye la lista solo cuando el recorrido
     *  completo ha terminado. Una respuesta parcial nunca llega al estado que
     *  renderiza el panel. */
    async function refresh(force = false): Promise<boolean> {
        const serial = loadSerial;
        if (!force && refreshedAt > 0) {
            return true;
        }
        if (force) {
            checkGeneration += 1;
            queuedCheckIds = new Set();
            checkingActions = new Set();
        }
        // Retirar el inventario anterior antes de la nueva pasada evita que el
        // primer menú confirmado se mezcle visualmente con datos caducados.
        if (serial === loadSerial) {
            actions = [];
            confirmedSectionIds = [];
        }
        const request = refreshInFlight ?? (force
            ? api.refreshInstallActions()
            : api.loadInstallCatalog());
        refreshInFlight = request;
        detecting = true;
        loading = true;
        let ok = true;
        try {
            let list = await request;
            // Nunca enseñar el catálogo estructural como si fuera el estado
            // confirmado. Esto solo ocurre si la precarga inicial agotó su
            // espera; la segunda llamada completa la pasada antes de pintar
            // cualquier sección.
            if (!force && list.complete === false) {
                list = await api.refreshInstallActions();
            }
            refreshedAt = Date.now();
            if (serial !== loadSerial) return false;
            // La respuesta de apertura es solo el catálogo estructural. No
            // contiene sondas de PATH/WinGet/ecosistemas.
            catalogTotalActions = Math.max(catalogTotalActions, list.actions.length);
            if (catalogActionKeys.length === 0) {
                catalogActionKeys = [...new Set(list.actions.map((action) => `${action.groupKey ?? action.group}/${action.id}`))];
            }
            actions = list.actions;
            catalogComplete = list.complete !== false;
            if (force || list.complete !== false) {
                // La pasada global puede dejar familias en `unknown` cuando
                // una fuente (WinGet, WSL o un gestor) responde tarde. Abrir
                // cada herramienta manualmente ya hacía una segunda sonda y
                // resolvía esos estados; tanto la primera apertura como
                // «Repetir detección» completan ese mismo recorrido antes de
                // pintar el catálogo, sin dejar acciones que desaparezcan al
                // terminar la detección.
                await resolveUnknownActions(serial);
                if (serial !== loadSerial) return false;
                finalizeUnknownActions();
                // El catálogo estructural puede contener familias que una
                // sonda completa confirma como no aplicables. Publicar esas
                // claves provisionales hacía que el E2E y el contador
                // comparasen contra acciones que ya no forman parte del
                // inventario estable. La referencia pública se actualiza
                // después de resolverlas, antes de revelar las secciones.
                catalogTotalActions = actions.length;
                catalogActionKeys = [...new Set(actions.map((action) => `${action.groupKey ?? action.group}/${action.id}`))];
                await revealSections(serial);
            }
            else {
                await tick();
                confirmedSectionIds = sections.map((section) => section.id);
            }
        } catch {
            ok = false;
            if (serial === loadSerial) {
                error = app.t('deps.detectFailed', 'No se pudo completar la detección del entorno.');
            }
        } finally {
            if (refreshInFlight === request) {
                refreshInFlight = null;
                detecting = false;
                if (serial === loadSerial) loading = false;
            }
        }
        return ok;
    }

    async function revealSections(serial: number): Promise<void> {
        // `sections` se actualiza después de asignar `actions`; esperar un tick
        // deja que Svelte construya todos los grupos antes de confirmar el
        // primer menú.
        await tick();
        const ids = sections.map((section) => section.id);
        for (const id of ids) {
            if (serial !== loadSerial) return;
            // Ceder un frame entre menús permite que el usuario vea el avance y
            // evita que una categoría aparezca mientras aún se calcula la otra.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (serial !== loadSerial) return;
            confirmedSectionIds = [...confirmedSectionIds, id];
            await tick();
        }
    }

    async function repeatDetection(): Promise<void> {
        if (detecting) return;
        error = '';
        await refresh(true);
    }

    function unknownActionIds(entry: Entry): string[] {
        const ids = entry.actions
            .filter((action) => action.detectionStatus === 'unknown')
            .map((action) => action.id);
        if (entry.children.length) {
            for (const child of entry.children) {
                ids.push(...child.actions
                    .filter((action) => action.detectionStatus === 'unknown')
                    .map((action) => action.id));
            }
        }
        return [...new Set(ids)];
    }

    function checkEntry(entry: Entry): Promise<void> {
        const ids = unknownActionIds(entry)
            .filter((id) => !checkingActions.has(id) && !queuedCheckIds.has(id));
        const anchor = ids[0];
        if (!anchor) return Promise.resolve();
        const anchorAction = actions.find((action) => action.id === anchor);
        const familyIds = new Set(
            anchorAction
                ? anchorAction.subgroup
                    ? actions
                          .filter(
                              (action) =>
                                  action.subgroup === anchorAction.subgroup
                                  && (anchorAction.subgroupItem === undefined
                                      || action.subgroupItem === anchorAction.subgroupItem)
                          )
                          .map((action) => action.id)
                    : [anchorAction.id]
                : ids
        );
        const generation = checkGeneration;
        for (const id of ids) queuedCheckIds.add(id);
        checkingActions = new Set([...checkingActions, ...ids]);
        const request = checkQueue.then(async () => {
            try {
                // Si se pulsó «Repetir detección» mientras esta entrada estaba
                // esperando, se descarta sin lanzar otra sonda externa.
                if (generation !== checkGeneration) return;
                const result = await api.checkInstallAction(anchor);
                if (generation !== checkGeneration) return;
                if (!result.actions.length) {
                    // Una respuesta vacía no debe borrar la tarjeta completa.
                    // El backend solo devuelve acciones confirmadas; cuando
                    // una familia no tiene todavía ninguna operación de
                    // ciclo de vida aplicable, conservar la instalación base
                    // como ausente deja una acción útil y mantiene visible el
                    // menú. Los timeouts reales devuelven acciones `unknown`
                    // y pasan por la rama normal, así que no se convierten en
                    // una instalación falsa.
                    const installIds = new Set(
                        ids.filter((id) => {
                            const action = actions.find((candidate) => candidate.id === id);
                            return action && (!action.verb || action.verb === 'Instalar' || action.verb === 'Install');
                        }),
                    );
                    const diagnosticIds = new Set(
                        ids.filter((id) => {
                            const action = actions.find((candidate) => candidate.id === id);
                            return action && isDiagnosticAction(action);
                        }),
                    );
                    if (installIds.size > 0 || diagnosticIds.size > 0) {
                        actions = actions.map((action) => installIds.has(action.id) || diagnosticIds.has(action.id)
                            ? { ...action, installed: false, detectionStatus: null }
                            : action).filter((action) => !familyIds.has(action.id)
                                || installIds.has(action.id)
                                || diagnosticIds.has(action.id));
                    }
                    return;
                }
                const checkedById = new Map(result.actions.map((action) => [action.id, action]));
                const checkedIds = new Set(checkedById.keys());
                actions = actions
                    // La respuesta confirma la familia completa que se acaba
                    // de sondear. Si una acción no vuelve, es porque no es
                    // aplicable en el estado confirmado (por ejemplo,
                    // actualizar/desinstalar cuando GitHub CLI falta), no una
                    // acción que deba quedarse eternamente en «Comprobar».
                    // Las familias que no pudieron comprobarse siguen usando
                    // la rama vacía de arriba y conservan sus acciones.
                    .filter((action) => !familyIds.has(action.id)
                        || checkedIds.has(action.id)
                        || isInstallAction(action)
                        || isDiagnosticAction(action))
                    .map((action) => {
                        const checked = checkedById.get(action.id);
                        if (checked) return checked;
                        if (familyIds.has(action.id)
                            && (isInstallAction(action) || isDiagnosticAction(action))) {
                            return { ...action, installed: false, detectionStatus: null };
                        }
                        return action;
                    });
            } catch (cause) {
                console.debug('[DependenciesPanel] tool detection failed', cause);
            } finally {
                if (generation === checkGeneration) {
                    queuedCheckIds = new Set([...queuedCheckIds].filter((id) => !ids.includes(id)));
                    checkingActions = new Set([...checkingActions].filter((id) => !ids.includes(id)));
                }
            }
        });
        checkQueue = request.catch(() => undefined);
        return request;
    }

    function unknownFamilyKey(action: InstallAction): string {
        if (!action.subgroup) return `${action.groupKey ?? action.group}\u001f${action.id}`;
        return [
            action.groupKey ?? action.group,
            action.subgroup,
            action.subgroupItem ?? '',
        ].join('\u001f');
    }

    function isInstallAction(action: InstallAction): boolean {
        return action.verb === null
            || /^(?:Instalar|Install)$/i.test(action.verb ?? '');
    }

    function isDiagnosticAction(action: InstallAction): boolean {
        // Estado, versión y dispositivos siguen siendo acciones útiles aunque
        // la herramienta esté ausente; una sonda tardía no debe convertirlas
        // en tarjetas desaparecidas.
        return /^(?:Comprobar|Check|Ver(?:\s+versión)?|Mostrar|View|Listar|List|Reiniciar|Restart)$/i
            .test(action.verb ?? '')
            || /(?:-check|-version|-list|-devices|-restart)$/i.test(action.id);
    }

    /**
     * Un timeout no debe dejar el menú bloqueado en «Comprobar» después de una
     * pasada explícita. Si una familia tiene acción de instalación, la
     * instalación es la única operación segura que se puede ofrecer sin una
     * confirmación positiva; las acciones de ciclo de vida se retiran hasta
     * que exista una instalación confirmada. Las familias que no tienen una
     * acción de instalación conservan su operación declarada, marcada como
     * ausente, para que el usuario pueda ejecutarla o reintentarlo desde el
     * mismo menú. Esto solo se aplica al final de «Repetir detección», después
     * de que cada familia desconocida haya tenido su sonda individual.
     */
    function finalizeUnknownActions(): void {
        const families = new Map<string, InstallAction[]>();
        for (const action of actions) {
            const key = action.subgroup
                ? `${action.groupKey ?? action.group}\u001f${action.subgroup}\u001f${action.subgroupItem ?? ''}`
                : `${action.groupKey ?? action.group}\u001f${action.id}`;
            const family = families.get(key) ?? [];
            family.push(action);
            families.set(key, family);
        }
        const normalized: InstallAction[] = [];
        for (const family of families.values()) {
            const unknown = family.filter((action) => action.detectionStatus === 'unknown');
            if (unknown.length === 0) {
                normalized.push(...family);
                continue;
            }
            const install = family.find(isInstallAction);
            if (install) {
                for (const action of family) {
                    if (action.detectionStatus !== 'unknown') {
                        normalized.push(action);
                    } else if (action.id === install.id || isDiagnosticAction(action)) {
                        normalized.push({ ...action, installed: false, detectionStatus: null });
                    }
                }
            } else {
                normalized.push(...family.map((action) => action.detectionStatus === 'unknown'
                    ? { ...action, installed: false, detectionStatus: null }
                    : action));
            }
        }
        actions = normalized;
    }

    /** Resuelve todas las familias que la pasada masiva no pudo confirmar.
     *
     * Se ejecuta mientras `loading` sigue activo, por lo que no se muestra un
     * catálogo intermedio con botones «Comprobar». Cada familia se intenta una
     * vez: si el gestor vuelve a agotar su plazo, el estado desconocido se
     * conserva y el usuario puede reintentarlo de forma individual.
     */
    async function resolveUnknownActions(serial: number): Promise<void> {
        const attemptedFamilies = new Set<string>();
        while (serial === loadSerial) {
            const pending = actions.filter((action) => action.detectionStatus === 'unknown');
            const anchor = pending.find((action) => !attemptedFamilies.has(unknownFamilyKey(action)));
            if (!anchor) return;
            attemptedFamilies.add(unknownFamilyKey(anchor));
            await checkEntry({
                name: anchor.label,
                description: anchor.description,
                installed: false,
                actions: [anchor],
                children: [],
                isSubgroup: false,
            });
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
            // La shell puede tardar en completar la instalación, pero la
            // respuesta ya invalida cualquier detección anterior. Al volver a
            // abrir el panel se fuerza una sonda nueva en vez de servir la
            // lista de hace un minuto.
            refreshedAt = 0;
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
        return autoOpenFirst
            && (groups[0]?.key ?? groups[0]?.name) === (group.key ?? group.name);
    }

    function accordionKey(kind: 'group' | 'subgroup', group: Group, entry?: Entry): string {
        const groupKey = group.key ?? group.name;
        return entry
            ? `${kind}:${groupKey}:${entry.name}`
            : `${kind}:${groupKey}`;
    }

    /** Las filas sin acordeón también se detectan al abrir su grupo. Sin este
     *  paso podían quedarse indefinidamente en «Comprobar», porque solo los
     *  subgrupos emiten un evento `toggle`. */
    function checkDirectEntries(group: Group): void {
        for (const entry of group.entries) {
            if (!entry.isSubgroup) checkEntry(entry);
        }
    }

    function accordionIsOpen(key: string, fallback = false): boolean {
        return openAccordions[key] ?? fallback;
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
     *  clic. El estado se guarda antes de cerrar hermanos para que una
     *  actualización del catálogo no deshaga el clic recién hecho. */
    function onAccordionToggle(event: Event): void {
        const details = event.currentTarget as HTMLDetailsElement;
        const key = details.dataset.accordionKey;
        if (key) openAccordions[key] = details.open;
        if (!details.open || !app.preferences?.exclusiveAccordionGroups) return;
        const parent = details.parentElement;
        if (!parent) return;
        for (const other of parent.children) {
            if (other === details || !(other instanceof HTMLDetailsElement)) continue;
            other.open = false;
            const otherKey = other.dataset.accordionKey;
            if (otherKey) openAccordions[otherKey] = false;
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
    count={loading || hasPendingDetection ? undefined : visibleComponentCount}
    countLabel={app
        .t('deps.visibleComponents', '{count} visible components')
        .replace('{count}', String(visibleComponentCount))}
>
    <div
        class="detection-toolbar"
        data-testid="dependency-detection-toolbar"
        data-catalog-action-count={catalogTotalActions}
        data-catalog-action-ids={catalogActionKeys.join('|')}
        data-catalog-complete={catalogComplete ? 'true' : 'false'}
    >
        <span class="detection-status" aria-live="polite">
            {#if detecting}
                {app.t('deps.detectingAgain', 'Comprobando instalaciones…')}
            {:else}
                {app.t('deps.detectionHint', 'Si acabas de instalar algo, vuelve a comprobarlo.')}
            {/if}
        </span>
        <button
            type="button"
            class="detect"
            data-testid="dependency-refresh"
            disabled={detecting || loading}
            aria-busy={detecting}
            onclick={repeatDetection}
        >
            {detecting
                ? app.t('deps.detectingAgainButton', 'Comprobando…')
                : app.t('deps.repeatDetection', 'Repetir detección')}
        </button>
    </div>
    {#if loading && confirmedSectionIds.length === 0}
        <div class="detection-placeholder" data-testid="dependency-detection-placeholder" aria-live="polite">
            {app.t('deps.detectingAll', 'Comprobando todas las secciones antes de mostrarlas…')}
        </div>
    {:else}
    {#if loading}
        <div class="detection-progress" data-testid="dependency-detection-progress" aria-live="polite">
            {app.t('deps.detectingSection', 'Secciones confirmadas: {done}/{total}')
                .replace('{done}', String(confirmedSectionIds.length))
                .replace('{total}', String(sections.length))}
        </div>
    {/if}
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
    {#if actions.length === 0}
        <div class="empty">
            {app.t('deps.allReady', 'Todo lo detectado está listo; no hay instalaciones pendientes.')}
        </div>
    {/if}

    <div class="sections" data-testid="dependency-sections">
        {#each visibleSections as section (section.id)}
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

                {#each section.groups as group (group.key ?? group.name)}
                    <details
                        class="group"
                        class:updates-group={section.id === 'updates'}
                        data-testid="dependency-group"
                        data-group-key={group.key ?? undefined}
                        data-accordion-key={accordionKey('group', group)}
                        class:languages={group.key === 'group.languages'}
                        open={group.key === 'group.updates'
                            ? sectionIsOpen(section.id)
                            : accordionIsOpen(accordionKey('group', group), shouldAutoOpen(group))}
                        ontoggle={(event) => {
                            onAccordionToggle(event);
                            if ((event.currentTarget as HTMLDetailsElement).open) checkDirectEntries(group);
                        }}
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
                        {#each group.entries as entry (entry.actions[0]?.id ?? entry.name)}
                            {#if !entry.isSubgroup}
                                <!-- Las acciones que no declaran ecosistema siguen siendo
                                     filas directas. Las que sí lo declaran conservan siempre
                                     su cabecera, aunque el inventario solo deje visible
                                     «Instalar»; así no se pierde la categoría padre cuando
                                     falta la herramienta. -->
                                <div class="tool" class:installed={entry.installed}>
                                    {@render item(entry.actions[0], false, entry.name, entry.description)}
                                </div>
                            {:else if entry.children.length > 0}
                                {@const parentKey = accordionKey('subgroup', group, entry)}
                                <details
                                    class="subgroup subgroup-parent"
                                    class:installed={entry.installed}
                                    data-testid="dependency-subgroup"
                                    data-subgroup-level="parent"
                                    data-accordion-key={parentKey}
                                    open={accordionIsOpen(parentKey)}
                                    ontoggle={(event) => {
                                        onAccordionToggle(event);
                                        if ((event.currentTarget as HTMLDetailsElement).open) {
                                            // Los hijos pueden aparecer abiertos por la
                                            // preferencia de acordeón sin emitir su propio
                                            // `toggle` al montar el árbol. Compruébalos aquí
                                            // para que una tarjeta visible nunca conserve
                                            // «Comprobar» por falta de evento.
                                            if (entry.children.length > 0) {
                                                for (const child of entry.children) {
                                                    const childKey = accordionKey('subgroup', group, child);
                                                    if (accordionIsOpen(childKey, true)) checkEntry(child);
                                                }
                                            } else {
                                                checkEntry(entry);
                                            }
                                        }
                                    }}
                                >
                                    <summary class="subgroup-title">
                                        <span class="subgroup-heading">
                                            <span>{entry.name}</span>
                                            {#if entry.description}
                                                <small>{entry.description}</small>
                                            {/if}
                                        </span>
                                        <span class="count">{entry.children.length}</span>
                                    </summary>
                                    <div class="subgroup-children">
                                        {#each entry.children as child (child.actions[0]?.id ?? child.name)}
                                            {@const childKey = accordionKey('subgroup', group, child)}
                                            <details
                                                class="subgroup subgroup-child"
                                                class:installed={child.installed}
                                                data-testid="dependency-subgroup"
                                                data-subgroup-level="child"
                                                data-accordion-key={childKey}
                                                open={accordionIsOpen(childKey, true)}
                                                ontoggle={(event) => {
                                                    onAccordionToggle(event);
                                                    if ((event.currentTarget as HTMLDetailsElement).open) checkEntry(child);
                                                }}
                                            >
                                                <summary class="subgroup-title">
                                                    <span class="subgroup-heading">
                                                        <span>{child.name}</span>
                                                        {#if child.description}
                                                            <small>{child.description}</small>
                                                        {/if}
                                                    </span>
                                                    <span class="count">{child.actions.length}</span>
                                                </summary>
                                                {#each child.actions as action (action.id)}
                                                    {@render item(action, true, undefined, undefined, !child.description)}
                                                {/each}
                                            </details>
                                        {/each}
                                    </div>
                                </details>
                            {:else}
                                {@const subgroupKey = accordionKey('subgroup', group, entry)}
                                <details
                                    class="subgroup"
                                    class:installed={entry.installed}
                                    data-testid="dependency-subgroup"
                                    data-subgroup-level="legacy"
                                    data-accordion-key={subgroupKey}
                                    open={accordionIsOpen(subgroupKey)}
                                    ontoggle={(event) => {
                                        onAccordionToggle(event);
                                        if ((event.currentTarget as HTMLDetailsElement).open) checkEntry(entry);
                                    }}
                                >
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
    {/if}
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
                data-testid="dependency-self-update"
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
    {@const detectionState = action.detectionStatus === 'unknown'
        ? 'unknown'
        : action.installed === true
        ? 'installed'
        : action.installed === false
        ? 'absent'
        : 'not-applicable'}
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
                data-detection-state={detectionState}
                data-installed={action.installed === true ? 'true' : action.installed === false ? 'false' : 'unknown'}
                data-detection-status={action.detectionStatus ?? 'confirmed'}
                disabled={running !== '' || !app.activeTabId || checkingActions.has(action.id)}
                onclick={() => action.detectionStatus === 'unknown'
                    ? checkEntry({ name: action.label, description: action.description, installed: false, actions: [action], children: [], isSubgroup: false })
                    : run(action)}
            >
                {checkingActions.has(action.id)
                    ? app.t('deps.detectingAction', 'Comprobando…')
                    : action.detectionStatus === 'unknown'
                    ? app.t('deps.check', 'Comprobar')
                    : running === action.id
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
        {#if action.detectionStatus === 'unknown'}
            <div class="hint detection-unknown">
                {app.t('deps.detectionUnknownHint', 'No se ofrece instalar hasta confirmar el estado. Repite la detección.')}
            </div>
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

    .detection-placeholder {
        min-height: 96px;
        display: grid;
        place-items: center;
        padding: 18px;
        color: var(--muted);
        text-align: center;
        font-size: 11px;
        border-bottom: 1px solid var(--border);
    }

    .detection-progress {
        padding: 6px 9px;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.25;
        border-bottom: 1px solid var(--border);
    }

    .detection-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px;
        border-bottom: 1px solid var(--border);
    }

    .detection-status {
        min-width: 0;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.25;
        overflow-wrap: anywhere;
    }

    .detect {
        flex: 0 0 auto;
        padding: 6px 9px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface-hover);
        color: var(--text);
        font: inherit;
        cursor: pointer;
    }

    .detect:hover:not(:disabled),
    .detect:focus-visible:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
    }

    .detect:disabled {
        cursor: wait;
        opacity: 0.7;
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
        .detection-toolbar {
            align-items: stretch;
            flex-direction: column;
        }

        .detect {
            align-self: flex-start;
        }

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

    /* Actualizaciones ya es el apartado superior: no repite el nombre del
       grupo interno ni deja una segunda flecha para la misma lista. */
    .updates-group {
        margin-top: 0;
    }

    .updates-group > .group-title {
        display: none;
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
        color: var(--success);
    }

    .subgroup-title .count {
        margin-left: auto;
    }

    .subgroup .item {
        margin: 4px 6px 6px 6px;
    }

    /* Los frameworks tienen dos niveles legibles: ecosistema y herramienta.
       El segundo queda ligeramente más sangrado para que no parezca otra
       lista plana de acciones repetidas. */
    .subgroup-children {
        padding: 2px 4px 4px;
        background: color-mix(in srgb, var(--surface-alt) 72%, transparent);
    }

    .subgroup-child {
        margin: 5px 2px;
        background: var(--surface);
    }

    .subgroup-child .subgroup-title {
        padding: 7px 9px;
        font-size: 10.5px;
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
        background: var(--success);
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
        background: var(--warning);
        vertical-align: middle;
    }

    .hint .warn {
        color: var(--warning);
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
