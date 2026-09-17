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
    import { compareLocalized } from '../lib/localization';
    import { panels } from '../lib/panels.svelte';
    import type { LToolsAction, LToolsActionList, ScriptEntry, ScriptsPanel as PanelData } from '../lib/types';
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
    let ltools = $state<LToolsActionList | null>(null);
    let ltoolsLoading = $state(false);
    let ltoolsConfiguring = $state(false);
    let ltoolsRunning = $state('');
    let selectedLToolsIds = $state<string[]>([]);
    let loadSerial = 0;
    let scheduledLoad: ReturnType<typeof setTimeout> | undefined;
    /** Categorías amplias que ya están presentes en `data`. Los subtipos se
     *  pueden cambiar sin volver a tocar el disco mientras su segmento siga
     *  cargado. */
    let loadedCategories = $state<string[]>([]);

    type FilterLeaf = {
        id: string;
        label: string;
        scan: string;
        extensions: string[];
        allowNoExtension?: boolean;
    };
    type FilterGroup = {
        id: string;
        label: string;
        description: string;
        children?: FilterLeaf[];
        subgroups?: FilterGroup[];
    };

    // La categoría que se envía al backend sigue siendo amplia para no hacer
    // cientos de recorridos del disco. Los subtipos se filtran aquí por
    // extensión, de modo que desactivar Zsh realmente oculta solo .zsh sin
    // perder los demás scripts Linux.
    const FILTER_GROUPS: FilterGroup[] = [
        {
            id: 'linux-scripts',
            label: 'Scripts Linux',
            description: 'Scripts POSIX y Fish; cada intérprete se puede activar por separado.',
            subgroups: [
                {
                    id: 'linux-posix',
                    label: 'POSIX · SH, Bash, Zsh y Ksh',
                    description: 'Scripts de shell compatibles con la familia POSIX.',
                    children: [
                        { id: 'linux-sh', label: 'SH / Bash', scan: 'shell', extensions: ['.sh', '.bash'], allowNoExtension: true },
                        { id: 'linux-zsh', label: 'Zsh', scan: 'shell', extensions: ['.zsh'] },
                        { id: 'linux-ksh', label: 'Ksh', scan: 'shell', extensions: ['.ksh'] }
                    ]
                },
                { id: 'linux-fish', label: 'Fish', description: 'Scripts propios de Fish.', children: [{ id: 'linux-fish-script', label: 'Fish', scan: 'fish', extensions: ['.fish'] }] }
            ]
        },
        {
            id: 'packages',
            label: 'Paquetes y ejecutables',
            description: 'Paquetes Linux, programas Windows, Java y binarios sin extensión.',
            subgroups: [
                { id: 'packages-debian', label: 'Linux · Debian / Ubuntu', description: 'Paquetes APT en formato Debian.', children: [{ id: 'packages-deb', label: 'Debian (.deb, .udeb)', scan: 'linux-package', extensions: ['.deb', '.udeb'] }] },
                { id: 'packages-rpm', label: 'Linux · RPM', description: 'Paquetes de Fedora, RHEL, openSUSE y compatibles.', children: [{ id: 'packages-rpm-file', label: 'RPM (.rpm)', scan: 'linux-package', extensions: ['.rpm'] }] },
                { id: 'packages-portable', label: 'Linux · portables', description: 'Aplicaciones autocontenidas o instaladores ejecutables.', children: [{ id: 'packages-portable-file', label: 'AppImage / Run / Ebuild', scan: 'linux-package', extensions: ['.appimage', '.run', '.ebuild'] }, { id: 'packages-arch-file', label: 'Arch / paquetes comprimidos', scan: 'linux-package', extensions: ['.pkg.tar.zst', '.pkg.tar.xz', '.txz'] }] },
                { id: 'packages-sandbox', label: 'Linux · sandbox y otros', description: 'Flatpak, Snap, APK y formatos de distribución adicionales.', children: [{ id: 'packages-sandbox-file', label: 'Flatpak / Snap', scan: 'linux-package', extensions: ['.flatpak', '.flatpakref', '.flatpakrepo', '.snap'] }, { id: 'packages-other-file', label: 'APK / XBPS / EOPKG / PET / SFS', scan: 'linux-package', extensions: ['.apk', '.xbps', '.eopkg', '.pet', '.sfs'] }] },
                { id: 'packages-windows', label: 'Windows · ejecutables', description: 'Programas y paquetes instalables de Windows.', children: [{ id: 'packages-windows-file', label: 'EXE / COM / MSI / MSIX', scan: 'program', extensions: ['.exe', '.com', '.msi', '.msix', '.msixbundle'] }] },
                { id: 'packages-java', label: 'Java · aplicaciones', description: 'Aplicaciones Java empaquetadas.', children: [{ id: 'packages-java-file', label: 'JAR', scan: 'program', extensions: ['.jar'] }] },
                { id: 'packages-binary', label: 'Binarios sin extensión', description: 'Ejecutables detectados por permisos o cabecera.', children: [{ id: 'packages-binary-file', label: 'Sin extensión', scan: 'program', extensions: [], allowNoExtension: true }] }
            ]
        },
        {
            id: 'windows-scripts',
            label: 'Scripts Windows',
            description: 'CMD, PowerShell y automatización de Windows.',
            subgroups: [
                { id: 'windows-cmd', label: 'CMD / Batch', description: 'Archivos de comandos clásicos de Windows.', children: [{ id: 'windows-cmd-file', label: 'CMD / BAT', scan: 'batch', extensions: ['.cmd', '.bat'] }] },
                { id: 'windows-powershell', label: 'PowerShell', description: 'Scripts, módulos y manifiestos de PowerShell.', children: [{ id: 'windows-powershell-file', label: 'PS1 / PSM1 / PSD1', scan: 'powershell', extensions: ['.ps1', '.psm1', '.psd1'] }] },
                { id: 'windows-automation', label: 'Automatización', description: 'AutoHotkey y VBScript.', children: [{ id: 'windows-ahk', label: 'AutoHotkey', scan: 'autohotkey', extensions: ['.ahk'] }, { id: 'windows-vbs', label: 'VBScript', scan: 'vbscript', extensions: ['.vbs'] }] },
                { id: 'windows-registry', label: 'Registro', description: 'Archivos de modificación del Registro.', children: [{ id: 'windows-reg', label: 'REG', scan: 'registry', extensions: ['.reg'] }] }
            ]
        },
        {
            id: 'languages',
            label: 'Lenguajes y datos',
            description: 'Código fuente, web, configuración y bases de datos.',
            subgroups: [
                { id: 'lang-python', label: 'Python', description: 'Scripts y módulos Python.', children: [{ id: 'lang-python-file', label: 'PY', scan: 'python', extensions: ['.py'] }] },
                { id: 'lang-js-ts', label: 'JavaScript / TypeScript', description: 'Node.js, JavaScript, JSX y TypeScript.', children: [{ id: 'lang-js-ts-file', label: 'JS / MJS / CJS / TS / TSX / JSX', scan: 'node', extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'] }] },
                { id: 'lang-ruby-php', label: 'Ruby / PHP', description: 'Scripts de Ruby y PHP.', children: [{ id: 'lang-ruby-php-file', label: 'RB / PHP', scan: 'other-script', extensions: ['.rb', '.php'] }] },
                { id: 'lang-perl-lua-r', label: 'Perl / Lua / R', description: 'Scripts de Perl, Lua y R.', children: [{ id: 'lang-perl-lua-r-file', label: 'PL / LUA / R', scan: 'other-script', extensions: ['.pl', '.lua', '.r'] }] },
                { id: 'lang-groovy', label: 'Groovy', description: 'Scripts de Groovy.', children: [{ id: 'lang-groovy-file', label: 'GROOVY', scan: 'other-script', extensions: ['.groovy'] }] },
                { id: 'lang-sql', label: 'SQL y bases de datos', description: 'SQL, SQLite y archivos asociados a motores de bases de datos.', children: [{ id: 'lang-sql-file', label: 'SQL / SQLite / DB / MySQL / PostgreSQL', scan: 'database', extensions: ['.sql', '.sqlite', '.sqlite2', '.sqlite3', '.db', '.mysql', '.pgsql', '.psql', '.mariadb'] }] },
                { id: 'lang-web', label: 'Web', description: 'Contenido HTML, CSS, XML y hojas de estilo.', children: [{ id: 'lang-web-file', label: 'HTML / HTM / CSS / SCSS / LESS / XML / XSL', scan: 'html', extensions: ['.html', '.htm', '.css', '.scss', '.less', '.xml', '.xsl'] }] },
                { id: 'lang-config', label: 'Configuración y documentación', description: 'JSON, YAML, TOML, INI, Markdown y configuración.', children: [{ id: 'lang-config-file', label: 'JSON / JSONC / YAML / YML / TOML / INI / CONF / ENV / MD', scan: 'html', extensions: ['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.md', '.markdown', '.properties'] }] }
            ]
        },
        {
            id: 'media',
            label: 'Recursos multimedia',
            description: 'Imágenes, audio y vídeo; se abren con el visor del sistema.',
            subgroups: [
                { id: 'media-images', label: 'Imágenes', description: 'Formatos gráficos.', children: [{ id: 'media-images-file', label: 'PNG / JPG / GIF / WEBP / SVG / ICO', scan: 'image', extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'] }] },
                { id: 'media-audio', label: 'Audio', description: 'Formatos de sonido.', children: [{ id: 'media-audio-file', label: 'MP3 / WAV / FLAC / OGG / M4A / AAC / OPUS', scan: 'audio', extensions: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus'] }] },
                { id: 'media-video', label: 'Vídeo', description: 'Formatos de vídeo.', children: [{ id: 'media-video-file', label: 'MP4 / MKV / WEBM / AVI / MOV / M4V / WMV', scan: 'video', extensions: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv'] }] }
            ]
        }
    ];

    function leavesOf(group: FilterGroup): FilterLeaf[] {
        if (group.subgroups) return group.subgroups.flatMap(leavesOf);
        return group.children ?? [];
    }

    const FILTER_LEAVES = FILTER_GROUPS.flatMap(leavesOf);
    const autoOpenFirst = $derived(app.preferences?.autoOpenFirstGroup ?? false);
    const exclusiveGroups = $derived(app.preferences?.exclusiveAccordionGroups ?? false);
    // Los subtipos no se abren en cascada aunque esté activa la opción de
    // abrir la primera lista: esa opción solo afecta al primer acordeón
    // principal del panel (Tipos de archivo).
    let openFilterGroups = $state<string[]>([]);

    function defaultFilterIds(filters: { id: string; default: boolean }[]): string[] {
        const defaults = new Set(filters.filter((filter) => filter.default).map((filter) => filter.id));
        return FILTER_LEAVES.filter((filter) => defaults.has(filter.scan)).map((filter) => filter.id);
    }

    const NIVELES = [0, 1, 2, 3, 4, 5, 6, 8, 10];
    const LTOOLS_SELECTION_KEY = 'lterminal.ltools.quick-actions.v1';
    const MAX_PINNED_LTOOLS_ACTIONS = 8;
    const DEFAULT_LTOOLS_ACTIONS = ['audit.quick', 'packages.inventory', 'clean.preview', 'defaults.show'];

    function ltoolsSelectionKey(): string {
        return `${LTOOLS_SELECTION_KEY}.${app.appInfo?.platform ?? 'unknown'}`;
    }

    function loadLToolsSelection(actions: LToolsAction[]): void {
        let saved: unknown;
        try {
            saved = JSON.parse(localStorage.getItem(ltoolsSelectionKey()) ?? 'null');
        } catch {
            saved = null;
        }
        const savedIds = Array.isArray(saved)
            ? saved.filter((id): id is string => typeof id === 'string')
            : DEFAULT_LTOOLS_ACTIONS;
        const knownIds = new Set(actions.filter((action) => action.requirementsAvailable).map((action) => action.id));
        selectedLToolsIds = [...new Set(savedIds)].filter((id) => knownIds.has(id)).slice(0, MAX_PINNED_LTOOLS_ACTIONS);
        if (selectedLToolsIds.length === 0) {
            const available = actions.filter((action) => action.safe && action.requirementsAvailable);
            const preferredIds = new Set([
                ...available.filter((action) => action.quick).map((action) => action.id),
                ...DEFAULT_LTOOLS_ACTIONS,
            ]);
            selectedLToolsIds = available
                .filter((action) => preferredIds.has(action.id))
                .concat(available.filter((action) => !preferredIds.has(action.id)))
                .slice(0, 4)
                .map((action) => action.id);
        }
        // También se guarda la selección inicial. De lo contrario los botones
        // parecen configurados, pero desaparecen al reiniciar el WebView o al
        // cambiar de perfil porque nunca llegaron a localStorage.
        if (selectedLToolsIds.length > 0) saveLToolsSelection();
    }

    function saveLToolsSelection(): void {
        try {
            localStorage.setItem(ltoolsSelectionKey(), JSON.stringify(selectedLToolsIds));
        } catch {
            // El catálogo sigue funcionando si el perfil no permite storage.
        }
    }

    function toggleLToolsAction(id: string, checked: boolean): void {
        if (checked) {
            if (selectedLToolsIds.includes(id) || selectedLToolsIds.length >= MAX_PINNED_LTOOLS_ACTIONS) return;
            selectedLToolsIds = [...selectedLToolsIds, id];
        } else {
            selectedLToolsIds = selectedLToolsIds.filter((value) => value !== id);
        }
        saveLToolsSelection();
    }

    async function loadLToolsActions(): Promise<void> {
        ltoolsLoading = true;
        try {
            const next = await api.listLToolsActions();
            ltools = next;
            if (next.available && next.actions.length) loadLToolsSelection(next.actions);
        } catch (cause) {
            ltools = {
                available: false,
                actions: [],
                error: String(cause)
            };
        } finally {
            ltoolsLoading = false;
        }
    }

    const availableLToolsActions = $derived((ltools?.actions ?? []).filter((action) => action.requirementsAvailable));
    const selectedLToolsActions = $derived.by(() => {
        const actions = new Map((ltools?.actions ?? []).map((action) => [action.id, action]));
        return selectedLToolsIds.map((id) => actions.get(id)).filter((action): action is LToolsAction => Boolean(action));
    });

    function scanCategoriesForSelection(filterIds: string[]): string[] {
        return [...new Set(
            FILTER_LEAVES
                .filter((filter) => filterIds.includes(filter.id))
                .map((filter) => filter.scan)
        )];
    }

    function scheduleLoad(): void {
        if (scheduledLoad !== undefined) clearTimeout(scheduledLoad);
        scheduledLoad = setTimeout(() => {
            scheduledLoad = undefined;
            void load(undefined, true);
        }, 140);
    }

    export async function load(
        next?: 'library' | 'here',
        preserveLoadedSegments = false
    ): Promise<void> {
        if (scheduledLoad !== undefined) {
            clearTimeout(scheduledLoad);
            scheduledLoad = undefined;
        }
        const modeChanged = next !== undefined && next !== mode;
        if (next) mode = next;
        if (!preserveLoadedSegments || modeChanged) loadedCategories = [];
        const serial = ++loadSerial;
        loading = true;
        statusError = false;
        if (mode === 'library' && (!ltools || modeChanged)) void loadLToolsActions();
        try {
            const requestedCategories = selected === null
                ? undefined
                : scanCategoriesForSelection(selected);
            const categories = requestedCategories === undefined
                ? undefined
                : [...new Set([...loadedCategories, ...requestedCategories])];
            const nextData =
                mode === 'here' && app.activeTabId
                    ? await api.listScriptsHere(app.activeTabId, categories, depth)
                    : await api.listScripts(categories);
            if (serial !== loadSerial) return;
            data = nextData;
            if (selected === null) {
                selected = defaultFilterIds(data.filters);
                loadedCategories = scanCategoriesForSelection(selected);
            } else if (categories !== undefined) {
                loadedCategories = categories;
            }
            if (data.depth !== undefined) depth = data.depth;
        } catch (cause) {
            if (serial !== loadSerial) return;
            statusError = true;
            status = String(cause);
        } finally {
            if (serial === loadSerial) loading = false;
        }
    }

    /** Vuelve a escanear con los tipos marcados. El filtro de tipos SÍ obliga a
     *  volver al disco: el backend descarta por categoría mientras recorre, así
     *  que lo no escaneado no está en memoria para filtrarlo aquí. */
    function applyTypes(next: string[]): void {
        selected = next;
        const required = scanCategoriesForSelection(next);
        if (
            data?.mode === mode &&
            required.every((category) => loadedCategories.includes(category))
        ) {
            return;
        }
        // Agrupa varios clics consecutivos en un único recorrido del disco.
        // El backend también cancela la petición anterior si ya había
        // empezado, pero esperar aquí evita iniciarla innecesariamente.
        scheduleLoad();
    }

    function toggleType(id: string, on: boolean): void {
        const actual = selected ?? [];
        void applyTypes(on ? [...actual, id] : actual.filter((value) => value !== id));
    }

    function toggleGroup(group: FilterGroup): void {
        const actual = selected ?? [];
        const leaves = leavesOf(group);
        const allSelected = leaves.every((filter) => actual.includes(filter.id));
        const next = allSelected
            ? actual.filter((id) => !leaves.some((filter) => filter.id === id))
            : [...new Set([...actual, ...leaves.map((filter) => filter.id)])];
        void applyTypes(next);
    }

    function toggleFilterGroupOpen(id: string, siblingIds: string[]): void {
        openFilterGroups = openFilterGroups.includes(id)
            ? openFilterGroups.filter((value) => value !== id)
            : exclusiveGroups
                ? [...openFilterGroups.filter((value) => !siblingIds.includes(value)), id]
                : [...openFilterGroups, id];
    }

    /** Los detalles de resultados y filtros comparten el mismo acordeón del
     *  panel. La preferencia solo cierra hermanos directos: abrir un subtipo
     *  no puede cerrar el apartado padre que lo contiene. */
    function onDetailsToggle(event: Event): void {
        const details = event.currentTarget as HTMLDetailsElement;
        if (!details.open || !exclusiveGroups) return;
        const parent = details.parentElement;
        if (!parent) return;
        for (const other of parent.children) {
            if (other !== details && other instanceof HTMLDetailsElement) other.open = false;
        }
    }

    function groupSelectedCount(group: FilterGroup): number {
        return leavesOf(group).filter((filter) => selected?.includes(filter.id)).length;
    }

    function filterTitle(filter: FilterLeaf): string {
        return filter.extensions.length
            ? app
                  .t('scripts.filter.extensionsTitle', 'Extensiones incluidas: {extensions}')
                  .replace('{extensions}', filter.extensions.join(', '))
            : app.t('scripts.filter.noExtensionTitle', 'Incluye archivos ejecutables sin extensión');
    }

    function filterLabel(filter: FilterLeaf): string {
        return app.t(`scripts.filter.${filter.id}.label`, filter.label);
    }

    function filterGroupLabel(group: FilterGroup): string {
        return app.t(`scripts.filter.${group.id}.label`, group.label);
    }

    function filterGroupDescription(group: FilterGroup): string {
        return app.t(`scripts.filter.${group.id}.description`, group.description);
    }

    function typeMatches(script: ScriptEntry): boolean {
        if (selected === null) return true;
        const selectedTypes = selected;
        return FILTER_LEAVES.some((filter) => {
            if (!selectedTypes.includes(filter.id) || filter.scan !== script.category) return false;
            return filter.extensions.includes(script.ext) || (filter.allowNoExtension === true && script.ext === '');
        });
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

    const visible = $derived((data?.scripts ?? []).filter(typeMatches).filter(matches));

    async function runLToolsAction(action: LToolsAction): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId || running || ltoolsRunning) return;
        if (!action.requirementsAvailable) return;
        if (action.mutating || action.confirmation !== 'none') {
            const details = `${action.label}\n\n${action.description}\n\n${app.t('scripts.ltools.confirm', 'Esta acción puede cambiar el sistema. ¿Quieres continuar?')}`;
            if (!window.confirm(details)) return;
        }
        ltoolsRunning = action.id;
        statusError = false;
        try {
            const result = await api.runLToolsAction(tabId, action.id);
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('scripts.ltools.runFailed', 'No se pudo ejecutar la acción de LTools.');
                return;
            }
            panels.close();
            if (result.tabId) await app.adoptTab(result.tabId, false);
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            ltoolsRunning = '';
        }
    }

    async function openLToolsProject(): Promise<void> {
        try {
            const error = await api.openInGithub('Darkeiser003/Tools');
            if (error) {
                statusError = true;
                status = error;
            }
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    function ltoolsReleaseAsset(assets: { name: string }[]): { name: string } | null {
        const platform = app.appInfo?.platform === 'windows' ? 'windows' : 'linux';
        const names = assets.map((asset) => ({ asset, name: asset.name.toLowerCase() }));
        const preferred = platform === 'windows'
            ? [
                  (name: string) => name.includes('-windows-') && name.includes('-cli.exe'),
                  (name: string) => name.includes('-windows-') && name.endsWith('.exe'),
                  (name: string) => name.includes('-windows-') && name.endsWith('.zip')
              ]
            : [
                  (name: string) => name.includes('-linux-') && name.includes('-cli.appimage'),
                  (name: string) => name.includes('-linux-') && name.endsWith('.appimage'),
                  (name: string) => name.includes('-linux-') && name.endsWith('.tar.gz')
              ];
        for (const matches of preferred) {
            const found = names.find(({ name }) => matches(name));
            if (found) return found.asset;
        }
        return null;
    }

    async function installLTools(): Promise<void> {
        if (ltoolsLoading) return;
        ltoolsLoading = true;
        statusError = false;
        status = '';
        try {
            // Primero se registra el repositorio mediante una consulta oficial
            // en la lista blanca de esta sesión; la descarga posterior solo
            // acepta la release que se acaba de consultar y un adjunto
            // compatible con la plataforma.
            const project = await api.lookupProject('Darkeiser003/Tools');
            if (!project.ok || !project.target || !project.repositories?.some((repository) => repository.fullName === 'Darkeiser003/Tools')) {
                statusError = true;
                status = project.error ?? 'No se pudo localizar el repositorio oficial de LTools.';
                return;
            }
            const result = await api.getLatestRelease('Darkeiser003/Tools');
            if (!result.ok) {
                statusError = true;
                status = result.error ?? 'No se pudo consultar la release de LTools.';
                return;
            }
            if (!result.release) {
                status = 'LTools todavía no tiene una release publicada en GitHub.';
                await openLToolsProject();
                return;
            }
            const asset = ltoolsReleaseAsset(result.release.assets);
            if (!asset || !app.activeTabId) {
                statusError = true;
                status = 'La release no contiene un paquete de LTools compatible con este sistema.';
                return;
            }
            const downloaded = await api.downloadRelease(
                app.activeTabId,
                'Darkeiser003/Tools',
                asset.name
            );
            if (!downloaded.ok) {
                statusError = true;
                status = downloaded.error ?? 'No se pudo descargar LTools.';
                return;
            }
            status = `LTools descargado en ${downloaded.path ?? 'la carpeta de proyectos'}.`;
            await loadLToolsActions();
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            ltoolsLoading = false;
        }
    }

    async function cdToCurrentDirectory(): Promise<void> {
        const tabId = app.activeTabId;
        const directory = data?.dir?.trim();
        if (!tabId || !directory) return;
        statusError = false;
        try {
            const result = await api.cdToDirectory(tabId, directory);
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app.t('error.writeFailed', 'No se pudo cambiar a esta carpeta.');
            }
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    async function openCurrentDirectory(): Promise<void> {
        const tabId = app.activeTabId;
        const directory = data?.dir?.trim();
        if (!tabId || !directory) return;
        statusError = false;
        try {
            const result = await api.openDirectory(tabId, directory);
            if (!result.ok) {
                statusError = true;
                status = result.error ?? app
                    .t('explorer.errorOpenFolder', 'No se pudo abrir la carpeta {path}.')
                    .replace('{path}', directory);
            }
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    // Acceso rápido es global: no desaparece al cambiar de ámbito ni al
    // desactivar el tipo de archivo con el que se guardó. La búsqueda de texto
    // sí se aplica, porque es una petición explícita del usuario.
    const pinned = $derived((data?.pinned ?? []).filter(matches));
    const pinnedPaths = $derived(new Set((data?.pinned ?? []).map((s) => s.path)));

    /** Agrupado por origen y carpeta, y dentro de cada grupo por extensión y
     *  nombre: los del mismo tipo quedan juntos, que es como se buscan. */
    function grouped(list: ScriptEntry[]): { name: string; scripts: ScriptEntry[] }[] {
        const groups = new Map<string, ScriptEntry[]>();
        for (const script of list) {
            const source =
                data?.mode === 'here' && script.source === 'Aquí'
                    ? app.t('scripts.currentPath', 'Ruta actual')
                    : script.source;
            const name = script.relDir ? `${source} / ${script.relDir}` : source;
            const bucket = groups.get(name);
            if (bucket) bucket.push(script);
            else groups.set(name, [script]);
        }
        return [...groups.entries()]
            .sort(([a], [b]) => compareLocalized(a, b, app.catalog.language))
            .map(([name, scripts]) => ({
                name,
                scripts: scripts.sort(
                    (a, b) => a.ext.localeCompare(b.ext) || compareLocalized(a.name, b.name, app.catalog.language)
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

    async function run(script: ScriptEntry, asAdmin: boolean, explicitArgs?: string): Promise<void> {
        if (!app.activeTabId || running) return;
        running = script.path;
        statusError = false;
        try {
            const result = await api.runScript(
                app.activeTabId,
                script.path,
                asAdmin,
                explicitArgs ?? (argsFor === script.path ? args : undefined)
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

</script>

<Panel
    id="scripts"
    title={app.t('toolbar.scripts', 'Biblioteca')}
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
                {app.t('scripts.here', 'Ruta actual')}
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
                        scheduleLoad();
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
            class="icon path-action"
            data-testid="scripts-cd-path"
            aria-label={app.t('scripts.cd', 'Llevar la terminal a esta carpeta')}
            title={app.t('scripts.cdTitle', 'Ir a la carpeta mostrada en la terminal')}
            disabled={!data?.dir || !app.activeTabId || loading}
            onclick={() => void cdToCurrentDirectory()}
        >cd</button>
        <button
            type="button"
            class="icon path-action"
            data-testid="scripts-open-path"
            aria-label={app.t('explorer.openInSystem', 'Abrir en el explorador del sistema')}
            title={app.t('explorer.openInSystem', 'Abrir la ruta mostrada en el explorador de archivos')}
            disabled={!data?.dir || !app.activeTabId || loading}
            onclick={() => void openCurrentDirectory()}
        >↗</button>
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
            placeholder={app.t('scripts.filterPlaceholder', 'Filtrar archivos por nombre, carpeta o extensión')}
        />
        {#if query}
            <button type="button" class="icon" title={app.t('common.clearFilter', 'Limpiar filtro')} onclick={() => (query = '')}>✕</button>
        {/if}
    </div>

    {#if data}
        <details class="types" open={autoOpenFirst} ontoggle={onDetailsToggle}>
            <summary>
                {app.t('scripts.fileTypes', 'Tipos de archivo')}
                <span class="count">{(selected ?? []).length}/{FILTER_LEAVES.length}</span>
            </summary>
            <div class="types-toolbar">
                <button type="button" onclick={() => applyTypes(defaultFilterIds(data!.filters))}>
                    {app.t('scripts.typesDefaults', 'Scripts')}
                </button>
                <button type="button" onclick={() => applyTypes(FILTER_LEAVES.map((filter) => filter.id))}>
                    {app.t('scripts.typesAll', 'Todos')}
                </button>
                <button type="button" onclick={() => applyTypes([])}>
                    {app.t('scripts.typesNone', 'Ninguno')}
                </button>
            </div>
            <div class="filter-groups">
                {#each FILTER_GROUPS as group (group.id)}
                    <section class="filter-group">
                        <div class="filter-group-header">
                            <button
                                type="button"
                                class="filter-group-name"
                                title={filterGroupDescription(group)}
                                onclick={() => toggleGroup(group)}
                            >
                                <span>{filterGroupLabel(group)}</span>
                                <small>{filterGroupDescription(group)}</small>
                            </button>
                            <button
                                type="button"
                                class="filter-group-expand"
                                title={app.t('scripts.typesSubtypes', 'Mostrar u ocultar los subtipos')}
                                onclick={() => toggleFilterGroupOpen(group.id, FILTER_GROUPS.map((item) => item.id))}
                            >
                                {groupSelectedCount(group)}/{leavesOf(group).length}
                                {openFilterGroups.includes(group.id) ? '⌃' : '⌄'}
                            </button>
                        </div>
                        {#if openFilterGroups.includes(group.id)}
                            {#if group.subgroups}
                                <div class="filter-subgroups">
                                    {#each group.subgroups as subgroup (subgroup.id)}
                                        <section class="filter-subgroup">
                                            <div class="filter-group-header">
                                                <button
                                                    type="button"
                                                    class="filter-group-name"
                                                    title={filterGroupDescription(subgroup)}
                                                    onclick={() => toggleGroup(subgroup)}
                                                >
                                                    <span>{filterGroupLabel(subgroup)}</span>
                                                    <small>{filterGroupDescription(subgroup)}</small>
                                                </button>
                                                <button
                                                    type="button"
                                                    class="filter-group-expand"
                                                    title={app.t('scripts.typesExtensions', 'Mostrar u ocultar extensiones')}
                                                    onclick={() => toggleFilterGroupOpen(
                                                        subgroup.id,
                                                        group.subgroups?.map((item) => item.id) ?? [subgroup.id]
                                                    )}
                                                >
                                                    {groupSelectedCount(subgroup)}/{leavesOf(subgroup).length}
                                                    {openFilterGroups.includes(subgroup.id) ? '⌃' : '⌄'}
                                                </button>
                                            </div>
                                            {#if openFilterGroups.includes(subgroup.id)}
                                                <div class="types-options">
                                                    {#each leavesOf(subgroup) as filter (filter.id)}
                                                        <label title={filterTitle(filter)}>
                                                            <input
                                                                type="checkbox"
                                                                checked={(selected ?? []).includes(filter.id)}
                                                                onchange={(event) => toggleType(filter.id, event.currentTarget.checked)}
                                                            />
                                                            <span>{filterLabel(filter)}</span>
                                                        </label>
                                                    {/each}
                                                </div>
                                            {/if}
                                        </section>
                                    {/each}
                                </div>
                            {:else}
                                <div class="types-options">
                                    {#each leavesOf(group) as filter (filter.id)}
                                        <label title={filterTitle(filter)}>
                                            <input
                                                type="checkbox"
                                                checked={(selected ?? []).includes(filter.id)}
                                                onchange={(event) => toggleType(filter.id, event.currentTarget.checked)}
                                            />
                                            <span>{filterLabel(filter)}</span>
                                        </label>
                                    {/each}
                                </div>
                            {/if}
                        {/if}
                    </section>
                {/each}
            </div>
        </details>
    {/if}

    {#if mode === 'library'}
        <details class="operations ltools-operations" data-testid="scripts-ltools" aria-label={app.t('scripts.ltools.title', 'Acciones fijadas de LTools')} ontoggle={onDetailsToggle}>
            <summary class="operations-title">
                <span>{app.t('scripts.ltools.title', 'Acciones fijadas de LTools')}</span>
                <small>{app.t('scripts.ltools.note', 'Las acciones se descubren desde el catálogo de LTools / WinSlim Tools y se ejecutan en una shell visible.')}</small>
                <span class="operations-chevron" aria-hidden="true">⌄</span>
            </summary>
            {#if ltoolsLoading}
                <div class="ltools-empty">{app.t('scripts.ltools.detecting', 'Detectando LTools…')}</div>
            {:else if ltools?.error}
                <div class="ltools-empty ltools-error">
                    <span>{ltools.error}</span>
                    <button type="button" onclick={() => void loadLToolsActions()}>{app.t('scripts.refresh', 'Reintentar')}</button>
                    <button type="button" class="run-direct" onclick={() => void installLTools()}>{app.t('scripts.ltools.get', 'Obtener LTools')}</button>
                </div>
            {:else if !ltools?.available}
                <div class="ltools-empty">
                    <span>{app.t('scripts.ltools.notInstalled', 'LTools no está instalado en este equipo.')}</span>
                    <button type="button" class="run-direct" onclick={() => void installLTools()}>
                        {app.t('scripts.ltools.get', 'Obtener LTools')}
                    </button>
                </div>
            {:else}
                <div class="ltools-meta" data-testid="scripts-ltools-meta">
                    <span>{ltools.version ?? app.t('scripts.ltools.detected', 'CLI detectada')}</span>
                    <span>{availableLToolsActions.length} {app.t('scripts.ltools.available', 'disponibles')}</span>
                </div>
                {#if selectedLToolsActions.length}
                    <div class="operation-actions ltools-actions">
                        {#each selectedLToolsActions as action (action.id)}
                            <button
                                type="button"
                                data-testid="scripts-ltools-run"
                                data-ltools-action-id={action.id}
                                title={action.description}
                                disabled={running !== '' || ltoolsRunning !== '' || !app.activeTabId || !action.requirementsAvailable}
                                onclick={() => void runLToolsAction(action)}
                            >{action.shortLabel ?? action.label}</button>
                        {/each}
                    </div>
                {:else}
                    <div class="ltools-empty">{app.t('scripts.ltools.noSelected', 'No hay acciones seleccionadas. Abre la configuración para elegirlas.')}</div>
                {/if}
                <div class="ltools-controls">
                    <button type="button" class="advanced" data-testid="scripts-ltools-configure" onclick={() => (ltoolsConfiguring = !ltoolsConfiguring)}>
                        {ltoolsConfiguring ? app.t('common.close', 'Cerrar') : app.t('scripts.ltools.configure', 'Configurar…')}
                    </button>
                    <button type="button" onclick={() => void loadLToolsActions()} disabled={ltoolsLoading}>
                        {app.t('scripts.refresh', 'Actualizar')}
                    </button>
                </div>
                {#if ltoolsConfiguring}
                    <div class="ltools-picker" aria-label={app.t('scripts.ltools.choose', 'Elegir acciones fijadas de LTools')}>
                        {#each ltools.actions as action (action.id)}
                            <label class="ltools-action" data-testid="scripts-ltools-action" data-ltools-action-id={action.id} class:unavailable={!action.requirementsAvailable} title={action.description}>
                                <input
                                    type="checkbox"
                                    checked={selectedLToolsIds.includes(action.id)}
                                    disabled={!action.requirementsAvailable && !selectedLToolsIds.includes(action.id)}
                                    onchange={(event) => toggleLToolsAction(action.id, (event.currentTarget as HTMLInputElement).checked)}
                                />
                                <span>
                                    <strong>{action.label}</strong>
                                    <small>{action.group} · {action.requirementsAvailable ? action.description : app.t('scripts.ltools.missing', 'Falta una dependencia')}</small>
                                </span>
                            </label>
                        {/each}
                    </div>
                {/if}
            {/if}
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
            {:else if mode === 'library' && (data?.scripts.length ?? 0) === 0 && (data?.pinned.length ?? 0) === 0}
                {app.t('scripts.noPinnedYet', 'No hay elementos anclados.')}
            {:else}
                {app.t('scripts.noneInScope', 'No hay archivos de los tipos seleccionados en este ámbito.')}
            {/if}
        </div>
    {/if}

    <!-- Acceso rápido aparece antes de los resultados de cualquier ámbito. -->
    {#if pinned.length}
        <details class="group pinned" ontoggle={onDetailsToggle}>
            <summary class="group-title">
                {app.t('scripts.quickAccess', 'Acceso rápido')}
                <span class="count">{pinned.length}</span>
            </summary>
            {#each pinned as script (script.path)}
                {@render entry(script)}
            {/each}
        </details>
    {/if}

    {#each groups as group (group.name)}
        <details class="group" ontoggle={onDetailsToggle}>
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
                        : app.t('scripts.pin', 'Añadir a Favoritos')}
                    onclick={async () => {
                        const nextPinned = await api.pinScript(
                            script.path,
                            !pinnedPaths.has(script.path)
                        );
                        // Conservar el ámbito visible, su ruta, filtros y
                        // resultados; anclar solo modifica Favoritos.
                        if (data) data = { ...data, pinned: nextPinned };
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

    /* Estas medidas se refieren al panel, no a la ventana completa: un panel
       redimensionado sigue reordenando sus controles aunque el viewport no
       cambie. */
    @container (max-width: 360px) {
        .modes button {
            padding-inline: 3px;
        }

        .toolbar,
        .filter {
            align-items: stretch;
            flex-wrap: wrap;
        }

        .depth {
            flex: 1 1 100%;
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
        padding: 3px 7px;
        border-left: 2px solid var(--accent);
        border-radius: 3px;
        background: var(--surface-alt);
        color: var(--text);
        font-size: 11px;
        font-weight: 600;
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

    .filter-groups {
        padding: 0 8px 8px;
    }

    .filter-group {
        border-top: 1px solid var(--border);
    }

    .filter-subgroups {
        margin-left: 8px;
        border-left: 1px solid var(--border);
    }

    .filter-subgroup {
        padding-left: 7px;
        border-top: 1px dotted var(--border);
    }

    .filter-group-header {
        display: flex;
        align-items: stretch;
        gap: 5px;
        padding: 5px 0;
    }

    .filter-group-name,
    .filter-group-expand {
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--text);
        font: inherit;
        cursor: pointer;
    }

    .filter-group-name {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        padding: 3px 5px;
        text-align: left;
    }

    .filter-group-name span {
        font-size: 11px;
        font-weight: 700;
    }

    .filter-group-name small {
        overflow: hidden;
        max-width: 100%;
        color: var(--muted);
        font-size: 9px;
        font-weight: 400;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .filter-group-name:hover,
    .filter-group-expand:hover {
        border-color: var(--accent);
        background: var(--accent-soft);
    }

    .filter-group-expand {
        flex: 0 0 auto;
        padding: 3px 6px;
        color: var(--muted);
        font-size: 10px;
    }

    .types-options {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr));
        gap: 7px 16px;
        padding: 0 8px 8px;
    }

    .types-options label {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        min-height: 18px;
        font-size: 11px;
        cursor: pointer;
    }

    .types-options input {
        flex: 0 0 auto;
        margin: 0;
    }

    .operations {
        margin: 8px 0;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
        border-radius: 6px;
        background: color-mix(in srgb, var(--accent-soft) 45%, var(--surface));
    }

    .operations-title {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 7px 8px;
        border-bottom: 1px solid var(--border);
        color: var(--text);
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
        list-style: none;
    }

    .operations-title::-webkit-details-marker {
        display: none;
    }

    .operations-chevron {
        margin-left: auto;
        color: var(--muted);
        font-size: 12px;
        font-weight: 400;
        line-height: 1;
        transition: transform 120ms ease;
    }

    .operations[open] .operations-chevron {
        transform: rotate(180deg);
    }

    .operations-title small {
        overflow: hidden;
        min-width: 0;
        color: var(--muted);
        font-size: 9px;
        font-weight: 400;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ltools-meta,
    .ltools-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 5px 8px;
        color: var(--muted);
        font-size: 9px;
    }

    .ltools-actions {
        justify-content: flex-start;
        padding: 4px 8px 7px;
    }

    .ltools-empty {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px;
        color: var(--muted);
        font-size: 10px;
    }

    .ltools-empty span {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .ltools-error {
        color: var(--warning);
    }

    .ltools-controls {
        justify-content: flex-end;
        border-top: 1px solid var(--border);
    }

    .ltools-controls button,
    .ltools-empty button {
        flex: 0 0 auto;
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 9px;
        cursor: pointer;
    }

    .ltools-controls button.advanced,
    .ltools-empty button.run-direct {
        border-color: var(--accent);
        color: var(--accent);
    }

    .ltools-picker {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
        max-height: 230px;
        gap: 1px;
        overflow: auto;
        padding: 5px 8px 8px;
        border-top: 1px solid var(--border);
    }

    .ltools-action {
        display: flex;
        min-width: 0;
        align-items: flex-start;
        gap: 6px;
        padding: 5px;
        border: 1px solid transparent;
        border-radius: 4px;
        cursor: pointer;
    }

    .ltools-action:hover {
        border-color: var(--border);
        background: var(--surface-hover);
    }

    .ltools-action input {
        flex: 0 0 auto;
        margin: 2px 0 0;
    }

    .ltools-action span {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
    }

    .ltools-action strong,
    .ltools-action small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ltools-action strong {
        color: var(--text);
        font-size: 10px;
    }

    .ltools-action small {
        color: var(--muted);
        font-size: 8px;
    }

    .ltools-action.unavailable {
        opacity: 0.55;
    }

    @container (max-width: 420px) {
        .ltools-actions {
            display: grid;
            grid-template-columns: 1fr;
        }

        .ltools-actions button {
            min-width: 0;
        }

        .ltools-controls {
            flex-wrap: wrap;
            justify-content: stretch;
        }

        .ltools-controls button {
            flex: 1 1 120px;
        }
    }

    .operation-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
    }

    .operation-actions button {
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 9px;
        cursor: pointer;
    }

    .operation-actions button:hover:not(:disabled) {
        border-color: var(--accent);
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
        color: var(--warning);
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
        border-color: var(--warning);
        color: var(--warning);
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
