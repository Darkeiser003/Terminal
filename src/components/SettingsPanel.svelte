<script lang="ts">
    // Panel de preferencias.
    //
    // Port de la sección `#settings-panel` de `electron/renderer`. Cuatro
    // secciones (Apariencia, Terminal, Comportamiento, Información) sobre un
    // borrador local que se guarda automáticamente tras cada cambio.
    //
    // Lo que se guarda no es lo que hay en el formulario: el backend valida
    // todos los valores y devuelve los que de verdad quedaron. La interfaz se
    // repinta con ESOS, no con los del formulario, así que un número fuera de
    // rango se ve corregido en el sitio en vez de aceptarse en silencio.

    import { tick } from "svelte";
    import * as api from "../lib/api";
    import { app } from "../lib/appState.svelte";
    import { fitFloatingTip, placeFloatingTip } from "../lib/floating-tip";
    import { includesLocalized } from "../lib/localization";
    import { panels } from "../lib/panels.svelte";
    import { settingsSearchVisibility, showSettingsIndex, visibleSettingsRows, type SettingsBlock } from "../lib/settings-search";
    import {
        normalizeShortcut,
        shortcutFromEvent,
        SHORTCUT_DEFINITIONS,
        SHORTCUT_PREFERENCE_KEYS,
        type ShortcutPreferenceKey,
    } from "../lib/shortcuts";
    import type { CustomTheme, ToolchainStoreCategory, PathIntegrationStatus, PluginInfo, Preferences, ShellAssistComponent, ShellAssistStatus, StorageLocationInfo, ThemePreset, ToolchainStoreLocation, ToolchainStoreStatus, UpdateProgress, UpdateStatus, WindowsIntegrationStatus } from "../lib/types";
    import Panel from "./Panel.svelte";
    import { ANSI_COLOR_KEYS, DEFAULT_ANSI_COLORS, effectivePalette, themePreferencePatch } from "../lib/theme";

    type Section = "appearance" | "terminal" | "behavior" | "about";

    let section = $state<Section>("appearance");
    /** Borrador: una copia de las preferencias que solo existe mientras el
     *  panel está abierto. */
    let draft = $state<Preferences | null>(null);
    let status = $state("");
    let statusError = $state(false);
    let saving = $state(false);
    let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let autoSaveQueued = $state(false);
    let autoSaveState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
    // Una respuesta IPC antigua no puede reemplazar cambios hechos mientras
    // el guardado estaba en curso. La siguiente pasada guardará el borrador vivo.
    let draftRevision = 0;
    /** Lo que se sabe de la actualización. Se consulta al abrir la sección de
     *  Información, no al abrir el panel: es una petición a GitHub y no tiene
     *  por qué hacerse cada vez que alguien viene a cambiar un color. */
    let update = $state<UpdateStatus | null>(null);
    let updating = $state(false);
    let updateProgress = $state<UpdateProgress | null>(null);
    let plugins = $state<PluginInfo[]>([]);
    let windowsIntegration = $state<WindowsIntegrationStatus | null>(null);
    let pathIntegration = $state<PathIntegrationStatus | null>(null);
    /** Escribir el PATH avisa a todo Windows y puede tardar unos segundos. La
     *  casilla cambia al pulsarla, antes de que termine: sin bloquearla, un
     *  segundo clic lanzaba otra escritura cruzada con la primera y dejaba
     *  entradas de WTerminal sueltas en el PATH del usuario. */
    let pathIntegrationBusy = $state(false);
    /** Carpeta propia de cachés. Medir tamaños recorre carpetas grandes, así
     *  que se consulta al entrar en Comportamiento, no al abrir el panel. */
    let toolchainStore = $state<ToolchainStoreStatus | null>(null);
    let toolchainStoreBusy = $state(false);
    let toolchainStoreConfirmClear = $state(false);
    let toolchainStoreMessage = $state("");
    let toolchainStoreSerial = 0;
    /** Ubicaciones externas (~/.rustup, WinGet…): se miden aparte porque
     *  tardan mucho más y no deben retrasar la lista de cachés propias. */
    let toolchainExternal = $state<ToolchainStoreLocation[] | null>(null);
    let toolchainExternalSerial = 0;
    const appLocations = $derived(toolchainExternal?.filter((location) => location.group === "app") ?? []);
    const otherLocations = $derived(toolchainExternal?.filter((location) => location.group !== "app") ?? []);
    /** La explicación de la carpeta bajo el ratón (o con el foco). Una sola
     *  tarjeta flotante para toda la sección: el panel recorta lo que sale de
     *  él, así que se coloca dentro de su caja, debajo o encima de la fila. */
    let storageTip = $state<{ title: string; path: string; info: StorageLocationInfo; left: number; top: number; width: number; above: boolean } | null>(null);
    /** Qué herramienta da sugerencias a cada shell y si está instalada. Se
     *  consulta al entrar en Terminal; «Comprobar de nuevo» incluye el
     *  inventario detallado de WSL, que tarda unos segundos. */
    let shellAssistStatus = $state<ShellAssistStatus | null>(null);
    let shellAssistBusy = $state(false);
    let shellAssistSerial = 0;
    let environmentQuery = $state("");
    let environmentGroup = $state("all");
    let loadSerial = 0;

    const PLATFORM_NAMES: Record<string, string> = {
        windows: "Windows",
        linux: "Linux",
        macos: "macOS",
    };

    /** El PATH registra la carpeta, pero la acción siempre se invoca como
     *  `wterminal`. Algunas instalaciones antiguas devolvían `wterminal.exe`
     *  en este campo; no debemos enseñar la extensión al usuario. */
    function pathCommandLabel(command: string | undefined): string {
        const raw = (command || "wterminal").trim();
        const basename = raw.split(/[\\/]/u).pop() || raw;
        return basename.replace(/\.(?:exe|cmd)$/iu, "") || "wterminal";
    }

    export async function load(): Promise<void> {
        const serial = ++loadSerial;
        if (autoSaveTimer !== undefined) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = undefined;
        }
        autoSaveQueued = false;
        autoSaveState = 'idle';
        draftRevision = 0;
        status = "";
        statusError = false;
        section = "appearance";
        // Se piden al backend en vez de reutilizar las que ya hay en memoria:
        // el archivo puede haber cambiado por fuera.
        await app.reloadPreferences();
        const nextPlugins = await api.listPlugins();
        const nextWindowsIntegration =
            app.appInfo?.platform === "windows" ? await api.getWindowsIntegration() : null;
        const nextPathIntegration = await api.getPathIntegration();
        if (serial !== loadSerial) return;
        plugins = nextPlugins;
        windowsIntegration = nextWindowsIntegration;
        pathIntegration = nextPathIntegration;
        draft = app.preferences ? { ...app.preferences } : null;
    }

    /** Elegir un tema no lo aplica: rellena los colores del borrador con su
     *  paleta, que es lo que el usuario puede seguir retocando encima. Un tema
     *  de fábrica solo cambia el acento salvo con «Recolorear toda la
     *  interfaz»; uno propio trae todos sus colores y su paleta ANSI. */
    function chooseTheme(theme: ThemePreset | CustomTheme): void {
        if (!draft) return;
        const patch = themePreferencePatch(theme.id, draft, app.themes);
        if (!patch) return;
        Object.assign(draft, patch);
        scheduleAutoSave();
    }

    /** Cambiar entre «solo acento» y «toda la interfaz» vuelve a aplicar el
     *  tema de fábrica elegido; los temas propios no dependen de ese modo. */
    function toggleRecolorAll(event: Event): void {
        if (!draft) return;
        draft.themeRecolorAll = (event.currentTarget as HTMLInputElement).checked;
        const preset = app.themes.find((theme) => theme.id === draft?.themeId);
        if (preset) chooseTheme(preset);
        else scheduleAutoSave();
    }

    let customThemeName = $state("");

    /** Guarda los colores actuales del borrador como un tema con nombre. Va
     *  dentro de las preferencias: «Exportar perfil» lo lleva consigo. */
    function saveCustomTheme(): void {
        if (!draft) return;
        const label = customThemeName.trim().slice(0, 40);
        if (!label) return;
        const current = effectivePalette(draft.themeId, draft, app.themes);
        const slug = label.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 24) || "tema";
        const theme: CustomTheme = {
            id: `custom-${slug}-${Date.now().toString(36)}`.slice(0, 48),
            label,
            palette: {
                background: draft.uiBackgroundColor,
                surface: draft.uiSurfaceColor,
                surfaceAlt: draft.uiSurfaceAltColor,
                border: draft.uiBorderColor,
                text: draft.uiTextColor,
                muted: draft.uiMutedColor,
                accent: draft.accentColor,
                accentSoft: current?.accentSoft ?? draft.uiSurfaceColor,
                terminalBackground: draft.terminalBackground,
                terminalForeground: draft.terminalForeground,
                selection: draft.terminalSelectionColor,
            },
            ansi: [...(draft.terminalAnsiColors ?? [])],
        };
        draft.customThemes = [...(draft.customThemes ?? []), theme];
        draft.themeId = theme.id;
        customThemeName = "";
        scheduleAutoSave();
    }

    function deleteCustomTheme(id: string): void {
        if (!draft) return;
        draft.customThemes = (draft.customThemes ?? []).filter((theme) => theme.id !== id);
        if (draft.themeId === id) {
            const fallback = app.themes.find((theme) => theme.id === app.defaults?.themeId) ?? app.themes[0];
            if (fallback) chooseTheme(fallback);
            return;
        }
        scheduleAutoSave();
    }

    /** Paleta ANSI: se reemplaza el arreglo entero en cada cambio para que el
     *  borrador nunca comparta el de las preferencias aplicadas. */
    function toggleAnsiPalette(event: Event): void {
        if (!draft) return;
        draft.terminalAnsiColors = (event.currentTarget as HTMLInputElement).checked ? [...DEFAULT_ANSI_COLORS] : [];
        scheduleAutoSave();
    }

    function setAnsiColor(index: number, value: string): void {
        if (!draft || draft.terminalAnsiColors.length !== ANSI_COLOR_KEYS.length) return;
        draft.terminalAnsiColors = draft.terminalAnsiColors.map((color, position) => (position === index ? value : color));
    }

    function ansiColorLabel(index: number): string {
        const names = [
            app.t("settings.ansiBlack", "Negro"), app.t("settings.ansiRed", "Rojo"),
            app.t("settings.ansiGreen", "Verde"), app.t("settings.ansiYellow", "Amarillo"),
            app.t("settings.ansiBlue", "Azul"), app.t("settings.ansiMagenta", "Magenta"),
            app.t("settings.ansiCyan", "Cian"), app.t("settings.ansiWhite", "Blanco"),
        ];
        const name = names[index % 8];
        return index < 8 ? name : app.t("settings.ansiBright", "{color} brillante").replace("{color}", name);
    }

    function translateThemeLabel(theme: ThemePreset): string {
        if (theme.id === "silver") return app.t("theme.silver", theme.label);
        if (theme.id === "winslim") return app.t("theme.techCyan", theme.label);
        if (theme.id === "ocean") return app.t("theme.ocean", theme.label);
        if (theme.id === "forest") return app.t("theme.forest", theme.label);
        if (theme.id === "amber") return app.t("theme.amber", theme.label);
        if (theme.id === "violet") return app.t("theme.violet", theme.label);
        if (theme.id === "nordic") return app.t("theme.nordic", theme.label);
        if (theme.id === "crimson") return app.t("theme.crimson", theme.label);
        if (theme.id === "matrix") return app.t("theme.greenPhosphor", theme.label);
        if (theme.id === "contrast") return app.t("theme.highContrast", theme.label);
        if (theme.id === "slate") return app.t("theme.slate", theme.label);
        if (theme.id === "plum") return app.t("theme.plum", theme.label);
        if (theme.id === "teal") return app.t("theme.turquoise", theme.label);
        if (theme.id === "ruby") return app.t("theme.ruby", theme.label);
        if (theme.id === "mint") return app.t("theme.mint", theme.label);
        return theme.label;
    }

    function setEnvironmentEnabled(environmentId: string, enabled: boolean): void {
        if (!draft) return;
        const hidden = new Set(draft.hiddenEnvironmentIds.split(',').filter(Boolean));
        if (enabled) hidden.delete(environmentId);
        else hidden.add(environmentId);
        draft.hiddenEnvironmentIds = [...hidden].join(',');
        scheduleAutoSave();
    }

    async function openLToolsConfiguration(): Promise<void> {
        // El checkbox es un borrador hasta que se guarda. Si se pulsa
        // «Configurar…» justo después de habilitarlo, la Biblioteca se abría
        // con `app.preferences.ltoolsEnabled` todavía a false y ocultaba el
        // catálogo completo (incluido «Obtener LTools»). Confirmar solo esta
        // preferencia antes de cambiar de panel mantiene la expectativa del
        // botón sin guardar por accidente el resto del formulario.
        if (!draft?.ltoolsEnabled) return;
        if (autoSaveTimer !== undefined) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = undefined;
        }
        autoSaveQueued = false;
        if (app.preferences?.ltoolsEnabled !== true) {
            // Guardar el borrador completo conserva cualquier otro cambio que
            // el usuario haya hecho justo antes de pulsar este acceso.
            draft.ltoolsEnabled = true;
            try {
                await saveDraft();
            } catch (cause) {
                statusError = true;
                status = `${app.t("settings.saveFailed", "No se pudieron guardar las preferencias.")} ${String(cause)}`;
                return;
            }
            const latestPreferences = app.preferences as Preferences | null;
            const ltoolsEnabledAfterSave = latestPreferences?.ltoolsEnabled === true;
            if (!ltoolsEnabledAfterSave) return;
        } else if (autoSaveState === 'pending') {
            await saveDraft();
        }
        // La configuración vive en un único selector (Biblioteca): Ajustes
        // solo ofrece una entrada coherente para no duplicar el catálogo ni
        // crear dos estados de selección que puedan divergir.
        panels.show("scripts");
        window.dispatchEvent(new CustomEvent("winslim:open-panel", { detail: { panel: "scripts" } }));
    }

    const environmentGroups = $derived([...new Set(app.environments.map((environment) => environment.group))]);
    const visibleEnvironments = $derived.by(() => {
        const needle = environmentQuery.trim();
        return app.environments.filter((environment) =>
            (environmentGroup === 'all' || environment.group === environmentGroup) &&
            (!needle || includesLocalized(`${environment.label} ${environment.group}`, needle, app.catalog.language))
        );
    });

    function setVisibleEnvironmentsEnabled(enabled: boolean): void {
        for (const environment of visibleEnvironments) setEnvironmentEnabled(environment.id, enabled);
    }

    function captureShortcut(event: KeyboardEvent, key: ShortcutPreferenceKey): void {
        if (!draft) return;
        if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            event.stopPropagation();
            draft[key] = '';
            scheduleAutoSave();
            return;
        }
        const shortcut = shortcutFromEvent(event);
        if (!shortcut) return;
        event.preventDefault();
        event.stopPropagation();
        draft[key] = shortcut;
        scheduleAutoSave();
    }

    const bannerItems = [
        { id: "system", labelKey: "banner.system", label: "Sistema", description: "Distribución o versión de Windows." },
        { id: "host", labelKey: "banner.pc", label: "Equipo", description: "Nombre del equipo." },
        { id: "kernel", labelKey: "banner.kernel", label: "Kernel", description: "Versión del kernel o de Windows." },
        { id: "environment", labelKey: "banner.environment", label: "Entorno", description: "Shell o entorno activo." },
        { id: "motherboard", labelKey: "banner.motherboard", label: "Placa", description: "Fabricante y modelo de placa." },
        { id: "cpu", labelKey: "banner.cpu", label: "CPU", description: "Procesador e hilos." },
        { id: "gpu", labelKey: "banner.gpu", label: "GPU", description: "Tarjeta gráfica." },
        { id: "memory", labelKey: "banner.memory", label: "Memoria", description: "Uso de RAM y velocidad." },
        { id: "storage", labelKey: "banner.storage", label: "Discos", description: "Uso de unidades." },
        { id: "uptime", labelKey: "banner.uptime", label: "Tiempo activo", description: "Tiempo desde el arranque." },
        { id: "datetime", labelKey: "banner.datetime", label: "Fecha", description: "Fecha y hora actuales." },
    ] as const;

    function bannerDescription(item: (typeof bannerItems)[number]): string {
        return app.t(`settings.banner.${item.id}.description`, item.description);
    }

    function bannerItemEnabled(id: string): boolean {
        return !(draft?.bannerHiddenItems ?? "").split(",").filter(Boolean).includes(id);
    }

    function setBannerItemEnabled(id: string, enabled: boolean): void {
        if (!draft) return;
        const hidden = new Set(draft.bannerHiddenItems.split(",").filter(Boolean));
        if (enabled) hidden.delete(id);
        else hidden.add(id);
        draft.bannerHiddenItems = [...hidden].join(",");
        scheduleAutoSave();
    }

    function setBannerPreset(preset: "full" | "compact"): void {
        if (!draft) return;
        draft.bannerHiddenItems = preset === "full"
            ? ""
            : ["host", "kernel", "environment", "motherboard", "gpu", "storage", "datetime"].join(",");
        scheduleAutoSave();
    }

    async function saveDraft(): Promise<void> {
        if (!draft) return;
        if (saving) {
            autoSaveQueued = true;
            return;
        }
        const currentDraft = draft;
        const shortcuts = SHORTCUT_PREFERENCE_KEYS.map((key) =>
            normalizeShortcut(currentDraft[key]) || currentDraft[key].trim().toLowerCase()
        ).filter(Boolean);
        if (new Set(shortcuts).size !== shortcuts.length) {
            statusError = true;
            status = app.t("settings.shortcutConflict", "Dos acciones no pueden usar el mismo atajo.");
            autoSaveState = 'error';
            return;
        }
        saving = true;
        autoSaveState = 'saving';
        const savingRevision = draftRevision;
        const savingLoadSerial = loadSerial;
        try {
            const normalizedDraft = { ...draft };
            for (const key of SHORTCUT_PREFERENCE_KEYS) {
                const normalized = normalizeShortcut(normalizedDraft[key]);
                if (normalized) normalizedDraft[key] = normalized;
            }
            await app.savePreferences(normalizedDraft);
            if (loadSerial !== savingLoadSerial) return;
            if (draftRevision === savingRevision) {
                // Solo se aplica la normalización del backend si el usuario
                // no ha editado el formulario durante este IPC.
                draft = app.preferences ? { ...app.preferences } : null;
                statusError = false;
                status = app.t(
                    "settings.autoSavedNote",
                    "Guardado automáticamente. El entorno inicial y Docker se aplican en el próximo arranque.",
                );
                autoSaveState = 'saved';
            } else {
                autoSaveQueued = true;
                autoSaveState = 'pending';
            }
        } catch (cause) {
            statusError = true;
            autoSaveState = 'error';
            status =
                app.t(
                    "settings.saveFailed",
                    "No se pudieron guardar las preferencias.",
                ) +
                " " +
                String(cause);
        } finally {
            saving = false;
            if (autoSaveQueued) {
                autoSaveQueued = false;
                scheduleAutoSave();
            }
        }
    }

    function save(event: SubmitEvent): void {
        event.preventDefault();
        void saveDraft();
    }

    /** Imagen del banner: se elige con el diálogo del sistema y se guarda la
     *  ruta; el backend la valida al leerla (`banner_image_read`). */
    async function chooseBannerImage(): Promise<void> {
        if (!draft) return;
        const path = await api.pickBannerImage();
        if (!path || !draft) return;
        draft.bannerImagePath = path;
        scheduleAutoSave();
    }

    /** Vuelve a imprimir el banner de la pestaña activa con los ajustes
     *  guardados: el ancho de la imagen y activarla cambian el margen, que se
     *  compone al imprimir. */
    async function reprintBanner(): Promise<void> {
        const tabId = app.activeTabId;
        if (!tabId) return;
        if (autoSaveState === "pending") await saveDraft();
        try {
            const applied = await api.printBanner(tabId);
            statusError = !applied;
            status = applied
                ? app.t("settings.bannerReprinted", "Banner actualizado en la pestaña activa.")
                : app.t("settings.bannerReprintUnavailable", "Esta pestaña no muestra banner (es un intérprete o el panel es demasiado pequeño).");
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    function resetBannerImage(): void {
        commitBannerImagePath('');
    }

    /** La ruta escrita a mano se aplica al confirmar (Intro o salir del
     *  campo), como la carpeta de Entornos y descargas: una ruta a medio
     *  escribir no es absoluta y el backend la vaciaría mientras se teclea. */
    function commitBannerImagePath(value: string): void {
        if (!draft) return;
        draft.bannerImagePath = value.trim();
        scheduleAutoSave();
    }

    /** Buscador de Ajustes: con texto, se ven todas las secciones y solo lo
     *  que lo contiene (`settings-search.ts`). Sin texto, las pestañas
     *  largas (`showSettingsIndex`: hoy solo Comportamiento) tienen un índice
     *  de sus apartados. Además, cada fila con una
     *  explicación breve la enseña entera al pasar el ratón. */
    let settingsQuery = $state("");
    const searchingSettings = $derived(settingsQuery.trim().length > 0);
    let settingsForm = $state<HTMLFormElement | null>(null);
    let settingsMatches = $state(0);
    let sectionHeadings = $state<string[]>([]);

    function settingsBlockKind(element: Element): SettingsBlock["kind"] {
        if (element.matches("[data-search-section]")) return "section";
        if (element.matches(".heading")) return "heading";
        if (element.matches(".field-hint")) return "hint";
        return "row";
    }

    function refreshSettingsView(form: HTMLFormElement, query: string): void {
        const elements = [...form.querySelectorAll(":scope > section > *, :scope > [data-search-section]")]
            .filter((element) => !element.matches("[data-search-skip]"));
        const blocks = elements.map((element) => ({
            kind: settingsBlockKind(element),
            text: `${element.textContent ?? ""} ${element.getAttribute("title") ?? ""}`,
        }));
        const visible = settingsSearchVisibility(blocks, query);
        elements.forEach((element, index) => element.classList.toggle("search-hidden", !visible[index]));
        settingsMatches = visibleSettingsRows(blocks, visible);
        for (const row of form.querySelectorAll<HTMLElement>("label.check:not([title])")) {
            const hint = row.querySelector("small")?.textContent?.trim();
            if (hint) row.title = hint;
        }
        for (const field of form.querySelectorAll<HTMLElement>("label.field:not([title])")) {
            const hint = field.nextElementSibling?.matches(".field-hint") ? field.nextElementSibling.textContent?.trim() : "";
            if (hint) field.title = hint;
        }
        sectionHeadings = query
            ? []
            : [...form.querySelectorAll(":scope > section > .heading > strong")]
                  .map((heading) => heading.textContent?.trim() ?? "")
                  .filter(Boolean);
    }

    $effect(() => {
        const query = settingsQuery;
        const form = settingsForm;
        void section;
        void draft;
        if (!form) return;
        void tick().then(() => {
            if (settingsForm === form) refreshSettingsView(form, query);
        });
    });

    function jumpToHeading(index: number): void {
        const headings = settingsForm?.querySelectorAll(":scope > section > .heading");
        headings?.[index]?.scrollIntoView({ block: "start", behavior: "smooth" });
    }

    function scheduleAutoSave(): void {
        if (!draft) return;
        draftRevision += 1;
        autoSaveState = 'pending';
        if (autoSaveTimer !== undefined) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => {
            autoSaveTimer = undefined;
            void saveDraft();
        }, 360);
    }

    async function reset(): Promise<void> {
        if (saving) return;
        if (autoSaveTimer !== undefined) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = undefined;
        }
        autoSaveQueued = false;
        saving = true;
        autoSaveState = 'saving';
        try {
            await app.resetPreferences();
            draft = app.preferences ? { ...app.preferences } : null;
            statusError = false;
            status = app.t("settings.resetDone", "Preferencias restablecidas.");
            autoSaveState = 'saved';
        } catch (cause) {
            statusError = true;
            autoSaveState = 'error';
            status =
                app.t(
                    "settings.resetFailed",
                    "No se pudieron restablecer las preferencias.",
                ) +
                " " +
                String(cause);
        } finally {
            saving = false;
        }
    }

    async function exportProfile(): Promise<void> {
        const result = await api.exportProfile(app.appInfo?.platform ?? "linux");
        if (!result) return;
        statusError = !result.ok;
        status = result.ok
            ? app.t("settings.profileExported", "Perfil portable exportado como script.")
            : (result.error ?? app.t("settings.profileExportFailed", "No se pudo exportar el perfil."));
    }

    async function importProfile(): Promise<void> {
        const result = await api.importProfile();
        if (!result) return;
        statusError = !result.ok;
        if (!result.ok) {
            status = result.error ?? app.t("settings.profileImportFailed", "No se pudo importar el perfil.");
            return;
        }
        await app.reloadPreferences();
        draft = app.preferences ? { ...app.preferences } : null;
        status = app.t("settings.profileImported", "Perfil importado, validado y aplicado.");
    }

    async function installPlugin(): Promise<void> {
        try {
            const installed = await api.installPlugin();
            if (installed) plugins = installed;
            statusError = false;
            status = installed ? app.t("settings.pluginInstalled", "Plugin instalado. Reescanea los entornos para aplicar sus aportaciones.") : "";
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    async function togglePlugin(plugin: PluginInfo): Promise<void> {
        try {
            plugins = await api.setPluginEnabled(plugin.id, !plugin.enabled);
            await app.refreshEnvironments();
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    async function removePlugin(plugin: PluginInfo): Promise<void> {
        try {
            plugins = await api.removePlugin(plugin.id);
            await app.refreshEnvironments();
            statusError = false;
            status = app.t("settings.pluginRemoved", "Plugin retirado y conservado en la carpeta de respaldos.");
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    async function toggleWindowsIntegration(): Promise<void> {
        if (!windowsIntegration) return;
        try {
            windowsIntegration = await api.setWindowsIntegration(!windowsIntegration.contextMenuRegistered);
            statusError = false;
            status = app.t("settings.windowsIntegrationUpdated", "Integración de Windows actualizada para el usuario actual.");
        } catch (cause) {
            statusError = true;
            status = String(cause);
        }
    }

    let adminRestarting = $state(false);
    let runAsAdminFlagBusy = $state(false);

    /** Cómo se abre WTerminal. Las dos formas de abrirlo como administrador
     *  elevan lo mismo (toda la app); cambia quién pide el UAC: WTerminal al
     *  arrancar (`startAsAdmin`) o Windows antes de abrirlo (la marca
     *  RUNASADMIN del ejecutable). Son excluyentes: elegir una quita la otra. */
    type AdminMode = "normal" | "relaunch" | "mark";
    const adminMode = $derived<AdminMode>(
        windowsIntegration?.runAsAdminFlag ? "mark" : draft?.startAsAdmin ? "relaunch" : "normal"
    );

    async function setAdminMode(next: AdminMode): Promise<void> {
        if (!draft || !windowsIntegration || runAsAdminFlagBusy) return;
        runAsAdminFlagBusy = true;
        try {
            const startAsAdmin = next === "relaunch";
            if (draft.startAsAdmin !== startAsAdmin) {
                draft.startAsAdmin = startAsAdmin;
                scheduleAutoSave();
            }
            const flag = next === "mark";
            if (windowsIntegration.runAsAdminFlag !== flag) {
                windowsIntegration = await api.setRunAsAdminFlag(flag);
            }
            statusError = false;
            status = windowsIntegration.elevated && next === "normal"
                ? app.t("settings.restartUnelevatedHint", "Esta copia es administrador: un programa no puede soltar sus permisos en marcha, así que se abre otra sin ellos y esta se cierra.")
                : next === "mark"
                  ? app.t("settings.runAsAdminFlagOn", "WTerminal.exe se abrirá siempre como administrador; el escudo aparece en su icono.")
                  : next === "relaunch"
                    ? app.t("settings.adminModeLater", "Se aplica la próxima vez que abras WTerminal.")
                    : app.t("settings.runAsAdminFlagOff", "WTerminal.exe vuelve a abrirse sin pedir permisos.");
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            runAsAdminFlagBusy = false;
        }
    }

    /** «Reiniciar sin permisos de administrador»: guarda lo pendiente y abre
     *  otra copia sin elevar; si no se puede, esta sigue como estaba. */
    async function restartUnelevated(): Promise<void> {
        if (adminRestarting) return;
        adminRestarting = true;
        try {
            if (autoSaveState === "pending") await saveDraft();
            await api.restartUnelevated();
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            adminRestarting = false;
        }
    }

    /** «Reiniciar como administrador»: guarda lo pendiente y pide el UAC. Si
     *  se acepta, esta copia se cierra; si se cancela, sigue como estaba. */
    async function restartAsAdmin(): Promise<void> {
        if (adminRestarting) return;
        adminRestarting = true;
        try {
            if (autoSaveState === "pending") await saveDraft();
            await api.restartAsAdmin();
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            adminRestarting = false;
        }
    }

    /** Qué pasa con NSudo según los permisos de esta copia y los puentes
     *  (gsudo, sudo de Windows «En línea») que haya en el equipo. */
    const adminStatus = $derived.by(() => {
        const current = windowsIntegration;
        if (!current) return "";
        if (current.elevated) {
            return app.t("settings.adminElevated", "WTerminal se está ejecutando como administrador: las shells de NSudo se abren directamente.");
        }
        if (current.nsudoLauncher === "gsudo") {
            return app.t("settings.adminViaGsudo", "WTerminal no es administrador. NSudo se abre a través de gsudo: Windows pide el UAC solo para esa pestaña.");
        }
        if (current.nsudoLauncher === "windows-sudo") {
            return app.t("settings.adminViaWindowsSudo", "WTerminal no es administrador. NSudo se abre a través del sudo de Windows («En línea»): Windows pide el UAC solo para esa pestaña.");
        }
        return app.t("settings.adminNeeded", "WTerminal no es administrador. Para usar NSudo, reinicia como administrador, instala gsudo o activa el sudo de Windows en modo «En línea» (Configuración → Sistema → Para programadores).");
    });

    function windowsSudoLabel(mode: WindowsIntegrationStatus["windowsSudo"]): string {
        switch (mode) {
            case "inline": return app.t("settings.windowsSudoInline", "en línea");
            case "new-window": return app.t("settings.windowsSudoNewWindow", "en una ventana nueva (no sirve para pestañas)");
            case "input-disabled": return app.t("settings.windowsSudoInputDisabled", "con la entrada deshabilitada (no sirve para shells)");
            case "disabled": return app.t("settings.windowsSudoDisabled", "desactivado");
            default: return app.t("settings.windowsSudoMissing", "no disponible en esta versión de Windows");
        }
    }

    async function togglePathIntegration(): Promise<void> {
        if (!pathIntegration || pathIntegrationBusy) return;
        pathIntegrationBusy = true;
        try {
            pathIntegration = await api.setPathIntegration(!pathIntegration.enabled);
            statusError = false;
            status = pathIntegration.enabled
                ? app.t("settings.pathIntegrationAdded", "WTerminal ya se puede invocar como wterminal desde las nuevas consolas.")
                : app.t("settings.pathIntegrationRemoved", "WTerminal se ha retirado del PATH.");
        } catch (cause) {
            statusError = true;
            status = String(cause);
            pathIntegration = await api.getPathIntegration().catch(() => pathIntegration);
        } finally {
            pathIntegrationBusy = false;
        }
    }

    function formatBytes(bytes: number): string {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const digits = unit === 0 || value >= 100 ? 0 : 1;
        return `${value.toLocaleString(app.catalog.language || undefined, { maximumFractionDigits: digits })} ${units[unit]}`;
    }

    function storageSafetyLabel(safety: StorageLocationInfo["safety"]): string {
        switch (safety) {
            case "safe":
                return app.t("settings.storageSafe", "Se puede borrar");
            case "regenerates":
                return app.t("settings.storageRegenerates", "Se puede borrar: se regenera");
            case "caution":
                return app.t("settings.storageCaution", "Con cuidado");
            default:
                return app.t("settings.storageKeep", "No borrar a mano");
        }
    }

    function showStorageTip(event: Event, title: string, path: string, info: StorageLocationInfo): void {
        const row = event.currentTarget as HTMLElement;
        const panel = row.closest(".panel") as HTMLElement | null;
        const bounds = panel?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        storageTip = { title, path, info, ...placeFloatingTip(row.getBoundingClientRect(), bounds) };
    }

    /** La altura real de la tarjeta depende del texto y de la ruta: tras
     *  pintarla se mide y, si se sale del panel por cualquier lado, se
     *  desplaza lo justo para que quepa entera. */
    let storageTipElement = $state<HTMLElement | null>(null);
    $effect(() => {
        const tip = storageTipElement;
        if (!storageTip || !tip) return;
        const panel = tip.closest(".panel")?.getBoundingClientRect();
        if (!panel) return;
        const { dx, dy } = fitFloatingTip(tip.getBoundingClientRect(), panel);
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) storageTip = { ...storageTip, left: storageTip.left + dx, top: storageTip.top + dy };
    });

    function hideStorageTip(): void {
        storageTip = null;
    }

    async function refreshToolchainStore(remeasureExternal = false): Promise<void> {
        const serial = ++toolchainStoreSerial;
        toolchainStoreBusy = true;
        void refreshToolchainExternal(remeasureExternal);
        try {
            const next = await api.getToolchainStore();
            if (serial === toolchainStoreSerial) toolchainStore = next;
        } catch (cause) {
            if (serial === toolchainStoreSerial) toolchainStoreMessage = String(cause);
        } finally {
            if (serial === toolchainStoreSerial) toolchainStoreBusy = false;
        }
    }

    async function refreshToolchainExternal(remeasure: boolean): Promise<void> {
        const serial = ++toolchainExternalSerial;
        if (remeasure) toolchainExternal = null;
        try {
            const next = await api.getToolchainExternalSizes(remeasure);
            if (serial === toolchainExternalSerial) toolchainExternal = next;
        } catch (cause) {
            if (serial === toolchainExternalSerial) toolchainExternal = [];
            console.debug("[SettingsPanel] tamaños externos omitidos", cause);
        }
    }

    type ShellAssistKey = "cmd" | "powershell" | "bash" | "zsh";
    type ShellAssistPreference = "shellAssistCmd" | "shellAssistPowershell" | "shellAssistBash" | "shellAssistZsh";
    interface ShellAssistRow {
        key: ShellAssistKey;
        preference: ShellAssistPreference;
        title: string;
        tool: string;
    }

    /** Un interruptor por shell. En Windows, bash y zsh son los de las
     *  distros WSL; en Linux y macOS, los del propio sistema (y PowerShell 7
     *  si está instalado, que ya trae las predicciones). */
    const shellAssistRows = $derived.by((): ShellAssistRow[] => {
        const windows = app.appInfo?.platform === "windows";
        const rows: ShellAssistRow[] = [];
        if (windows) {
            rows.push({ key: "cmd", preference: "shellAssistCmd", title: "cmd", tool: app.t("settings.shellAssistCmdTool", "Clink") });
        }
        rows.push({
            key: "powershell",
            preference: "shellAssistPowershell",
            title: "PowerShell",
            tool: app.t("settings.shellAssistPowershellTool", "PSReadLine (PowerShell 7 ya lo incluye)"),
        });
        rows.push({
            key: "bash",
            preference: "shellAssistBash",
            title: "bash",
            tool: windows
                ? app.t("settings.shellAssistBashToolWsl", "ble.sh, en cada distro WSL")
                : app.t("settings.shellAssistBashTool", "ble.sh"),
        });
        rows.push({
            key: "zsh",
            preference: "shellAssistZsh",
            title: "zsh",
            tool: windows
                ? app.t("settings.shellAssistZshToolWsl", "zsh-autosuggestions y zsh-syntax-highlighting, en cada distro WSL con zsh")
                : app.t("settings.shellAssistZshTool", "zsh-autosuggestions y zsh-syntax-highlighting"),
        });
        return rows;
    });

    type StoreCategoryPreference = "toolchainStoreDownloads" | "toolchainStoreAiModels" | "toolchainStoreTools" | "toolchainStoreReplHistory";

    /** Categorías de la carpeta propia: cada una con su interruptor (las
     *  cachés van con el general) y una explicación de lo que cambia. */
    const storeCategories = $derived([
        { id: "caches" as ToolchainStoreCategory, preference: null as StoreCategoryPreference | null,
            title: app.t("settings.storeCategoryCaches", "Cachés"),
            hint: app.t("settings.storeCategoryCachesHint", "Lo que descargan npm, pip, Go y los demás gestores. Se vuelve a descargar si se borra.") },
        { id: "downloads" as ToolchainStoreCategory, preference: "toolchainStoreDownloads" as StoreCategoryPreference,
            title: app.t("settings.storeCategoryDownloads", "Descargas del panel"),
            hint: app.t("settings.storeCategoryDownloadsHint", "Los archivos que bajan las acciones de Entorno y dependencias antes de instalarlos.") },
        { id: "aiModels" as ToolchainStoreCategory, preference: "toolchainStoreAiModels" as StoreCategoryPreference,
            title: app.t("settings.storeCategoryAiModels", "Modelos de IA"),
            hint: app.t("settings.storeCategoryAiModelsHint", "Hugging Face y, si aún no tienes modelos de Ollama, los que descargue «ollama serve» arrancado desde WTerminal. Los modelos que ya tienes no se mueven.") },
        { id: "tools" as ToolchainStoreCategory, preference: "toolchainStoreTools" as StoreCategoryPreference,
            title: app.t("settings.storeCategoryTools", "Herramientas y lenguajes nuevos"),
            hint: app.t("settings.storeCategoryToolsHint", "npm -g, cargo install, go install y pip --user instalan aquí. Su carpeta va delante en el PATH de WTerminal y, con la integración con el PATH, al final del PATH de tu usuario, así que lo nuevo se ve en cualquier terminal. Lo ya instalado sigue donde está.") },
        { id: "replHistory" as ToolchainStoreCategory, preference: "toolchainStoreReplHistory" as StoreCategoryPreference,
            title: app.t("settings.storeCategoryReplHistory", "Historial de los REPL"),
            hint: app.t("settings.storeCategoryReplHistoryHint", "El historial de Node, Python 3.13+, SQLite y psql abiertos desde WTerminal.") },
    ]);

    type AssistColorKey = "shellAssistSuggestionColor" | "shellAssistCommandColor" | "shellAssistArgumentColor" | "shellAssistErrorColor";

    /** Colores opcionales de las sugerencias: vacío = el de la herramienta de
     *  cada shell. Al activarlo se parte de un color razonable. */
    const assistColorRows = $derived([
        { key: "shellAssistSuggestionColor" as AssistColorKey, label: app.t("settings.assistSuggestionColor", "Texto sugerido"), initial: "#808080" },
        { key: "shellAssistCommandColor" as AssistColorKey, label: app.t("settings.assistCommandColor", "Órdenes"), initial: "#3b8eea" },
        { key: "shellAssistArgumentColor" as AssistColorKey, label: app.t("settings.assistArgumentColor", "Opciones y argumentos"), initial: "#87afff" },
        { key: "shellAssistErrorColor" as AssistColorKey, label: app.t("settings.assistErrorColor", "Orden que no existe"), initial: "#f14c4c" },
    ]);

    function toggleAssistColor(key: AssistColorKey, initial: string, on: boolean): void {
        if (!draft) return;
        draft[key] = on ? initial : "";
        scheduleAutoSave();
    }

    function shellAssistComponents(key: ShellAssistKey): ShellAssistComponent[] {
        return shellAssistStatus?.shells.find((shell) => shell.shell === key)?.components ?? [];
    }

    function shellAssistState(component: ShellAssistComponent): string {
        if (component.installed === true) return app.t("settings.shellAssistInstalled", "instalado");
        if (component.installed === false) return app.t("settings.shellAssistMissing", "no instalado");
        return app.t("settings.shellAssistUnknown", "sin comprobar");
    }

    async function refreshShellAssist(refresh: boolean): Promise<void> {
        const serial = ++shellAssistSerial;
        shellAssistBusy = true;
        try {
            const next = await api.getShellAssistStatus(refresh);
            if (serial === shellAssistSerial) shellAssistStatus = next;
        } catch (cause) {
            console.debug("[SettingsPanel] estado de sugerencias omitido", cause);
        } finally {
            if (serial === shellAssistSerial) shellAssistBusy = false;
        }
    }

    $effect(() => {
        if (section !== "terminal") return;
        void refreshShellAssist(false);
    });

    /** Lleva a Entorno y dependencias ya filtrado por la herramienta. Antes
     *  se guarda lo pendiente, como al abrir cualquier otro panel desde aquí. */
    async function installShellAssist(search: string): Promise<void> {
        if (autoSaveState === "pending") await saveDraft();
        window.dispatchEvent(new CustomEvent("winslim:open-panel", { detail: { panel: "deps", query: search } }));
    }

    // Se mide al entrar en Comportamiento y otra vez cuando el guardado
    // automático confirma un cambio de activación o de carpeta.
    const toolchainStorePreferenceKey = $derived(
        app.preferences ? `${app.preferences.toolchainStoreEnabled}|${app.preferences.toolchainStoreDir}` : "",
    );
    $effect(() => {
        if (section !== "behavior" || !toolchainStorePreferenceKey) return;
        toolchainStoreConfirmClear = false;
        void refreshToolchainStore();
    });

    /** La carpeta se aplica al confirmar (Intro o salir del campo), no en cada
     *  tecla: una ruta a medio escribir crearía carpetas que nadie pidió. */
    function commitToolchainStoreDir(value: string): void {
        if (!draft) return;
        draft.toolchainStoreDir = value.trim();
        scheduleAutoSave();
    }

    async function openToolchainFolder(path: string): Promise<void> {
        const result = await api.openDirectory(app.activeTabId ?? "", path).catch((cause) => ({ ok: false, error: String(cause) }));
        if (!result.ok) toolchainStoreMessage = result.error ?? app.t("error.noFolderOpen", "No hay una carpeta que abrir.");
    }

    async function clearToolchainCaches(): Promise<void> {
        if (!toolchainStore || toolchainStoreBusy) return;
        if (!toolchainStoreConfirmClear) {
            toolchainStoreConfirmClear = true;
            return;
        }
        toolchainStoreConfirmClear = false;
        toolchainStoreBusy = true;
        try {
            const freed = await api.clearToolchainCaches();
            toolchainStoreMessage = app.t("settings.toolchainStoreCleared", "Cachés vaciadas: {size} liberados.").replace("{size}", formatBytes(freed));
        } catch (cause) {
            toolchainStoreMessage = String(cause);
        } finally {
            toolchainStoreBusy = false;
        }
        await refreshToolchainStore();
    }

    async function checkUpdate(): Promise<void> {
        if (updating) return;
        updating = true;
        try {
            update = await api.checkForUpdate();
        } catch (cause) {
            update = null;
            statusError = true;
            status = String(cause);
        } finally {
            updating = false;
        }
    }

    async function installUpdate(): Promise<void> {
        if (updating) return;
        updating = true;
        statusError = false;
        status = app.t("update.installing", "Actualizando…");
        const unlisten = await api.onUpdateProgress((progress) => (updateProgress = progress));
        try {
            // Si va bien, el proceso muere durante esta llamada y no vuelve.
            const result = await api.installUpdate();
            statusError = true;
            status =
                result.error ??
                app.t("update.failed", "No se pudo actualizar.");
        } catch (cause) {
            statusError = true;
            status = String(cause);
        } finally {
            unlisten();
            updating = false;
        }
    }

    const version = $derived(
        app.appInfo?.version ? `v${app.appInfo.version}` : "",
    );
    const platform = $derived(
        app.appInfo
            ? (PLATFORM_NAMES[app.appInfo.platform] ?? app.appInfo.platform)
            : "",
    );

    const primaryDeveloper = $derived(
        (app.appInfo?.projectLeads ?? [])[0] ?? (app.appInfo?.developers ?? [])[0],
    );

    const sections: { id: Section; label: string }[] = $derived([
        { id: "appearance", label: app.t("settings.appearance", "Apariencia") },
        { id: "terminal", label: app.t("settings.terminal", "Terminal") },
        { id: "behavior", label: app.t("settings.behavior", "Comportamiento") },
        { id: "about", label: app.t("settings.about", "Información") },
    ]);
</script>

<Panel
    id="settings"
    title={`${app.appInfo?.name ?? "Terminal"} · ${app.t("settings.title", "Preferencias")}`}
    subtitle={status ||
        app.t(
            "settings.subtitle",
            "Personaliza la interfaz sin cambiar el sistema.",
        )}
    error={statusError}
    width={760}
    height={640}
>
    {#snippet header()}
        <div
            class="tabs"
            role="tablist"
            aria-label={app.t("settings.sections", "Secciones de preferencias")}
        >
            {#each sections as tab (tab.id)}
                <button
                    type="button"
                    role="tab"
                    data-testid={`settings-tab-${tab.id}`}
                    aria-selected={section === tab.id}
                    class:active={section === tab.id}
                    onclick={() => {
                        section = tab.id;
                        if (tab.id === "about" && !update) void checkUpdate();
                    }}
                >
                    {tab.label}
                </button>
            {/each}
        </div>
        <div class="settings-search" role="search">
            <input
                type="search"
                data-testid="settings-search"
                bind:value={settingsQuery}
                placeholder={app.t("settings.searchPlaceholder", "Buscar un ajuste…")}
                aria-label={app.t("settings.searchPlaceholder", "Buscar un ajuste…")}
                onkeydown={(event) => {
                    if (event.key === "Escape" && settingsQuery) {
                        event.stopPropagation();
                        settingsQuery = "";
                    }
                }}
            />
            {#if searchingSettings}
                <small data-testid="settings-search-count">
                    {settingsMatches === 0
                        ? app.t("settings.searchNone", "Ningún ajuste coincide.")
                        : app.t("settings.searchCount", "{count} ajustes").replace("{count}", String(settingsMatches))}
                </small>
            {/if}
        </div>
        {#if showSettingsIndex(sectionHeadings.length, searchingSettings)}
            <nav class="settings-index" data-testid="settings-index" aria-label={app.t("settings.index", "Ir a un apartado")}>
                {#each sectionHeadings as heading, index (`${index}-${heading}`)}
                    <button type="button" onclick={() => jumpToHeading(index)}>{heading}</button>
                {/each}
            </nav>
        {/if}
    {/snippet}

    {#if !draft}
        <div class="loading">
            {app.t("settings.loading", "Cargando preferencias…")}
        </div>
    {:else}
        <form bind:this={settingsForm} class="settings-form" onsubmit={save} oninput={scheduleAutoSave} onchange={scheduleAutoSave}>
            {#if section === "appearance" || searchingSettings}
                {#if searchingSettings}<h3 class="settings-search-section" data-search-section>{app.t("settings.appearance", "Apariencia")}</h3>{/if}
                <section>
                    <div class="heading">
                        <strong>{app.t("settings.theme", "Tema")}</strong>
                        <span>
                            {app.t(
                                "settings.themeHint",
                                "Todas oscuras, pensadas para lectura prolongada. Una de ellas es de alto contraste.",
                            )}
                        </span>
                    </div>

                    <div class="themes">
                        {#each app.themes as theme (theme.id)}
                            <label
                                class="theme-card"
                                class:selected={draft.themeId === theme.id}
                                title={theme.description}
                            >
                                <input
                                    type="radio"
                                    name="theme"
                                    value={theme.id}
                                    checked={draft.themeId === theme.id}
                                    onchange={() => chooseTheme(theme)}
                                />
                                <span
                                    class="swatch"
                                    style="background: linear-gradient(135deg, {(effectivePalette(theme.id, draft, app.themes) ?? theme.palette)
                                        .background} 0 64%, {theme
                                        .palette.accent} 64%)"
                                ></span>
                                <strong>{translateThemeLabel(theme)}</strong>
                            </label>
                        {/each}
                        {#each draft.customThemes ?? [] as theme (theme.id)}
                            <label
                                class="theme-card custom"
                                class:selected={draft.themeId === theme.id}
                                data-testid="settings-custom-theme"
                                title={app.t("settings.customThemeTitle", "Tema guardado por ti")}
                            >
                                <input
                                    type="radio"
                                    name="theme"
                                    value={theme.id}
                                    checked={draft.themeId === theme.id}
                                    onchange={() => chooseTheme(theme)}
                                />
                                <span
                                    class="swatch"
                                    style="background: linear-gradient(135deg, {theme.palette.background} 0 64%, {theme.palette.accent} 64%)"
                                ></span>
                                <strong>{theme.label}</strong>
                                <button
                                    type="button"
                                    class="theme-delete"
                                    data-testid="settings-custom-theme-delete"
                                    aria-label={app.t("settings.customThemeDelete", "Borrar el tema «{name}»").replace("{name}", theme.label)}
                                    title={app.t("settings.customThemeDelete", "Borrar el tema «{name}»").replace("{name}", theme.label)}
                                    onclick={(event) => { event.preventDefault(); deleteCustomTheme(theme.id); }}
                                >×</button>
                            </label>
                        {/each}
                    </div>

                    <label class="check">
                        <input
                            data-testid="settings-theme-recolor-all"
                            type="checkbox"
                            checked={draft.themeRecolorAll}
                            onchange={toggleRecolorAll}
                        />
                        <span>
                            <strong>{app.t("settings.themeRecolorAll", "Recolorear toda la interfaz con el tema")}</strong>
                            <small>{app.t("settings.themeRecolorAllHint", "Desactivado, todos los temas usan el fondo negro de «{theme}» y solo cambian el acento y el resaltado. Activado, el tema cambia también fondos, superficies y texto.").replace("{theme}", app.t("theme.techCyan", "Cian técnico"))}</small>
                        </span>
                    </label>

                    <div class="custom-theme-save">
                        <input
                            type="text"
                            data-testid="settings-custom-theme-name"
                            maxlength="40"
                            placeholder={app.t("settings.customThemeName", "Nombre del tema nuevo")}
                            aria-label={app.t("settings.customThemeName", "Nombre del tema nuevo")}
                            value={customThemeName}
                            oninput={(event) => { event.stopPropagation(); customThemeName = event.currentTarget.value; }}
                            onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveCustomTheme(); } }}
                        />
                        <button
                            type="button"
                            class="secondary"
                            data-testid="settings-custom-theme-save"
                            disabled={!customThemeName.trim()}
                            onclick={saveCustomTheme}
                        >{app.t("settings.customThemeSave", "Guardar como tema")}</button>
                        <small>{app.t("settings.customThemeHint", "Guarda los colores de abajo y la paleta ANSI. Los temas propios viajan con «Exportar perfil».")}</small>
                    </div>

                    <!-- La muestra usa los colores del BORRADOR, no los
                         aplicados: es lo que deja ver un color antes de
                         quedarse con él. -->
                    <div
                        class="preview"
                        style="background: {draft.terminalBackground}; color: {draft.terminalForeground}; border-color: {draft.accentColor}"
                    >
                        <span style="color: {draft.accentColor}"
                            >usuario@equipo</span
                        ><strong style="color: {draft.accentColor}"
                            >:~/proyecto</strong
                        ><em style="color: {draft.accentColor}">$</em> npm run check
                    </div>

                    <div class="grid">
                        <label class="field">
                            <span>{app.t("settings.accent", "Acento")}</span>
                            <input
                                type="color"
                                bind:value={draft.accentColor}
                            />
                        </label>
                        <label class="field"><span>{app.t("settings.uiBackground", "Fondo de la aplicación")}</span><input type="color" bind:value={draft.uiBackgroundColor} /></label>
                        <label class="field"><span>{app.t("settings.uiSurface", "Superficie principal")}</span><input type="color" bind:value={draft.uiSurfaceColor} /></label>
                        <label class="field"><span>{app.t("settings.uiSurfaceAlt", "Superficie secundaria")}</span><input type="color" bind:value={draft.uiSurfaceAltColor} /></label>
                        <label class="field"><span>{app.t("settings.uiBorder", "Bordes")}</span><input type="color" bind:value={draft.uiBorderColor} /></label>
                        <label class="field"><span>{app.t("settings.uiText", "Texto de interfaz")}</span><input type="color" bind:value={draft.uiTextColor} /></label>
                        <label class="field"><span>{app.t("settings.uiMuted", "Texto atenuado")}</span><input type="color" bind:value={draft.uiMutedColor} /></label>
                        <label class="field"><span>{app.t("settings.terminalSelection", "Selección de terminal")}</span><input type="color" bind:value={draft.terminalSelectionColor} /></label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.bannerColor",
                                    "Color de información del sistema",
                                )}</span
                            >
                            <input
                                type="color"
                                bind:value={draft.fastfetchColor}
                            />
                        </label>
                        <label class="field">
                            <span>{app.t("settings.cursorColor", "Color del cursor")}</span>
                            <input type="color" bind:value={draft.terminalCursorColor} />
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.terminalBg",
                                    "Fondo terminal",
                                )}</span
                            >
                            <input
                                type="color"
                                bind:value={draft.terminalBackground}
                            />
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.terminalFg",
                                    "Texto terminal",
                                )}</span
                            >
                            <input
                                type="color"
                                bind:value={draft.terminalForeground}
                            />
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.density",
                                    "Densidad de interfaz",
                                )}</span
                            >
                            <select bind:value={draft.uiDensity}>
                                <option value="comfortable">
                                    {app.t(
                                        "settings.densityComfortable",
                                        "Cómoda",
                                    )}
                                </option>
                                <option value="compact">
                                    {app.t(
                                        "settings.densityCompact",
                                        "Compacta",
                                    )}
                                </option>
                            </select>
                        </label>
                    </div>

                    <label class="check">
                        <input
                            data-testid="settings-ansi-enabled"
                            type="checkbox"
                            checked={draft.terminalAnsiColors.length === ANSI_COLOR_KEYS.length}
                            onchange={toggleAnsiPalette}
                        />
                        <span>
                            <strong>{app.t("settings.ansiPalette", "Colores ANSI propios")}</strong>
                            <small>{app.t("settings.ansiPaletteHint", "Los 16 colores con los que los programas pintan su salida (ls, git, prompts). Desactivado, se usan los de la terminal.")}</small>
                        </span>
                    </label>
                    {#if draft.terminalAnsiColors.length === ANSI_COLOR_KEYS.length}
                        <div class="ansi-grid" data-testid="settings-ansi-grid">
                            {#each draft.terminalAnsiColors as color, index (index)}
                                <label class="ansi-color" title={ansiColorLabel(index)}>
                                    <input
                                        type="color"
                                        value={color}
                                        aria-label={ansiColorLabel(index)}
                                        oninput={(event) => setAnsiColor(index, event.currentTarget.value)}
                                    />
                                    <small>{ansiColorLabel(index)}</small>
                                </label>
                            {/each}
                        </div>
                        <div
                            class="preview ansi-preview"
                            style="background: {draft.terminalBackground}; color: {draft.terminalForeground}"
                        >
                            {#each draft.terminalAnsiColors as color, index (index)}<span style="color: {color}">■</span>{/each}
                        </div>
                    {/if}

                </section>
            {/if}

            {#if section === "terminal" || searchingSettings}
                {#if searchingSettings}<h3 class="settings-search-section" data-search-section>{app.t("settings.terminal", "Terminal")}</h3>{/if}
                <section>
                    <div class="heading">
                        <strong
                            >{app.t(
                                "settings.textCursor",
                                "Texto y cursor",
                            )}</strong
                        >
                        <span>
                            {app.t(
                                "settings.textCursorHint",
                                "Ajustes aplicados a todas las pestañas abiertas.",
                            )}
                        </span>
                    </div>

                    <div class="grid">
                        <label class="field span-2">
                            <span>{app.t("settings.font", "Fuente")}</span>
                            <select bind:value={draft.terminalFontFamily}>
                                {#each app.fonts as font (font.id)}
                                    <option value={font.id}>{font.label}</option
                                    >
                                {/each}
                            </select>
                        </label>
                        <label class="field span-2" title={app.t("settings.fontCustomHint", "Cualquier fuente instalada en el equipo, por su nombre. Si no existe se usa la de arriba.")}>
                            <span>{app.t("settings.fontCustom", "Otra fuente instalada")}</span>
                            <input
                                type="text"
                                data-testid="settings-font-custom"
                                maxlength="64"
                                spellcheck="false"
                                placeholder="Cascadia Code PL"
                                bind:value={draft.terminalFontCustom}
                            />
                        </label>
                        <label class="field">
                            <span>{app.t("settings.fontSize", "Tamaño")}</span>
                            <input
                                type="number"
                                min="10"
                                max="24"
                                step="1"
                                bind:value={draft.terminalFontSize}
                            />
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.lineHeight",
                                    "Altura de línea",
                                )}</span
                            >
                            <input
                                type="number"
                                min="0.9"
                                max="5"
                                step="0.05"
                                bind:value={draft.terminalLineHeight}
                            />
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.letterSpacing",
                                    "Espaciado",
                                )}</span
                            >
                            <input
                                type="number"
                                min="-1"
                                max="3"
                                step="0.1"
                                bind:value={draft.terminalLetterSpacing}
                            />
                        </label>
                        <label class="field">
                            <span>{app.t("settings.cursor", "Cursor")}</span>
                            <select bind:value={draft.terminalCursorStyle}>
                                <option value="block"
                                    >{app.t(
                                        "settings.cursorBlock",
                                        "Bloque",
                                    )}</option
                                >
                                <option value="bar"
                                    >{app.t(
                                        "settings.cursorBar",
                                        "Barra",
                                    )}</option
                                >
                                <option value="underline"
                                    >{app.t(
                                        "settings.cursorUnderline",
                                        "Subrayado",
                                    )}</option
                                >
                                <option value="beam"
                                    >{app.t(
                                        "settings.cursorBeam",
                                        "Barra gruesa",
                                    )}</option
                                >
                                <option value="underline-thick">
                                    {app.t(
                                        "settings.cursorUnderlineThick",
                                        "Subrayado grueso",
                                    )}
                                </option>
                            </select>
                        </label>
                        <label class="field">
                            <span>{app.t("settings.fontWeight", "Grosor")}</span
                            >
                            <select bind:value={draft.terminalFontWeight}>
                                <option value="light">{app.t("settings.fontWeightLight", "Fino")}</option>
                                <option value="normal"
                                    >{app.t(
                                        "settings.fontWeightNormal",
                                        "Normal",
                                    )}</option
                                >
                                <option value="medium">{app.t("settings.fontWeightMedium", "Medio")}</option>
                                <option value="semibold">{app.t("settings.fontWeightSemibold", "Seminegrita")}</option>
                                <option value="bold"
                                    >{app.t(
                                        "settings.fontWeightBold",
                                        "Negrita",
                                    )}</option
                                >
                            </select>
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.padding",
                                    "Margen interior",
                                )}</span
                            >
                            <input
                                type="number"
                                min="4"
                                max="24"
                                step="1"
                                bind:value={draft.terminalPadding}
                            />
                        </label>
                        <label class="field">
                            <span
                                >{app.t(
                                    "settings.scrollSensitivity",
                                    "Velocidad de rueda",
                                )}</span
                            >
                            <input
                                type="number"
                                min="1"
                                max="10"
                                step="1"
                                bind:value={draft.terminalScrollSensitivity}
                            />
                        </label>
                        <label class="field span-2">
                            <span
                                >{app.t(
                                    "settings.scrollback",
                                    "Líneas de historial",
                                )}</span
                            >
                            <input
                                type="number"
                                min="1000"
                                max="100000"
                                step="1000"
                                bind:value={draft.terminalScrollback}
                            />
                        </label>
                    </div>

                    <label class="check">
                        <input
                            type="checkbox"
                            bind:checked={draft.terminalCursorBlink}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.cursorBlink",
                                    "Cursor parpadeante",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.cursorBlinkHint",
                                    "Facilita localizar el punto de escritura.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            data-testid="settings-terminal-links"
                            bind:checked={draft.terminalLinks}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.terminalLinks",
                                    "Enlaces clicables en la salida",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.terminalLinksHint",
                                    "Subraya las direcciones http, https y file:// y los hipervínculos de los programas al pasar el ratón, y las abre con Ctrl+clic. Las páginas van al navegador; las rutas locales solo se muestran en el explorador de archivos, nunca se ejecutan.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            data-testid="settings-terminal-links-confirm"
                            disabled={!draft.terminalLinks}
                            bind:checked={draft.terminalLinksConfirm}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.terminalLinksConfirm",
                                    "Pedir confirmación antes de abrir un enlace",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.terminalLinksConfirmHint",
                                    "Muestra la dirección completa y su destino antes de abrirla.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            bind:checked={draft.showSystemBanner}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.showBanner",
                                    "Mostrar información del sistema",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.showBannerHint",
                                    "Imprime el resumen una vez dentro de la salida de la terminal.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            data-testid="settings-banner-image"
                            bind:checked={draft.bannerImage}
                            disabled={!draft.showSystemBanner}
                        />
                        <span>
                            <strong>{app.t("settings.bannerImage", "Imagen a la izquierda del banner")}</strong>
                            <small>{app.t(
                                "settings.bannerImageHint",
                                "Como el logo de fastfetch: el de la app o una imagen tuya. Solo aparece en paneles con sitio para ella y el texto, y se mueve con el banner.",
                            )}</small>
                        </span>
                    </label>
                    {#if draft.bannerImage && draft.showSystemBanner}
                        <div class="banner-image-settings" data-testid="settings-banner-image-options">
                            <img
                                class="banner-image-preview"
                                data-testid="settings-banner-image-preview"
                                src={app.bannerImageUrl}
                                alt={app.t("settings.bannerImagePreview", "Vista previa de la imagen del banner")}
                            />
                            <div class="banner-image-controls">
                                <div class="update-row">
                                    <button type="button" class="secondary" data-testid="settings-banner-image-choose" onclick={chooseBannerImage}>
                                        {app.t("settings.bannerImageChoose", "Elegir imagen…")}
                                    </button>
                                    {#if draft.bannerImagePath}
                                        <button type="button" class="secondary" data-testid="settings-banner-image-reset" onclick={resetBannerImage}>
                                            {app.t("settings.bannerImageReset", "Usar el logo de la app")}
                                        </button>
                                    {/if}
                                </div>
                                <label class="field banner-image-path">
                                    <span>{app.t("settings.bannerImagePath", "Ruta de la imagen (vacío = logo de la app)")}</span>
                                    <input
                                        data-testid="settings-banner-image-path"
                                        type="text"
                                        spellcheck="false"
                                        value={draft.bannerImagePath}
                                        placeholder={app.t("settings.bannerImageDefault", "Logo de la app (por defecto)")}
                                        title={draft.bannerImagePath}
                                        oninput={(event) => event.stopPropagation()}
                                        onchange={(event) => {
                                            event.stopPropagation();
                                            commitBannerImagePath(event.currentTarget.value);
                                        }}
                                    />
                                </label>
                                {#if app.bannerImageError && draft.bannerImagePath && draft.bannerImagePath === app.preferences?.bannerImagePath}
                                    <small class="banner-image-error" data-testid="settings-banner-image-error">
                                        {app.t("settings.bannerImageUnreadable", "No se pudo usar esa imagen; se muestra el logo de la app.")}
                                        {app.bannerImageError}
                                    </small>
                                {/if}
                                <label class="field banner-image-columns">
                                    <span>{app.t("settings.bannerImageColumns", "Ancho de la imagen (columnas, 8–40)")}</span>
                                    <input
                                        type="number"
                                        min="8"
                                        max="40"
                                        step="1"
                                        data-testid="settings-banner-image-columns"
                                        bind:value={draft.bannerImageColumns}
                                    />
                                </label>
                            </div>
                        </div>
                    {/if}
                    {#if draft.showSystemBanner}
                        <div class="banner-image-apply">
                            <small>{app.t("settings.bannerImageApplies", "El ancho de la imagen y activarla o desactivarla se aplican al siguiente banner: clear, sysinfo, una pestaña nueva o este botón.")}</small>
                            <button type="button" class="secondary" data-testid="settings-banner-reprint" disabled={!app.activeTabId} onclick={reprintBanner}>
                                {app.t("settings.bannerReprint", "Mostrar el banner ahora")}
                            </button>
                        </div>
                    {/if}
                    <label class="check">
                        <input
                            type="checkbox"
                            data-testid="settings-clear-reprint-banner"
                            bind:checked={draft.clearReprintBanner}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.clearReprintBanner",
                                    "Reimprimir fastfetch al ejecutar clear",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.clearReprintBannerHint",
                                    "Después de limpiar la pantalla, vuelve a mostrar el resumen del sistema.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            data-testid="settings-shell-assist"
                            bind:checked={draft.shellAssist}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.shellAssist",
                                    "Sugerencias y colores en la línea de órdenes",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.shellAssistHint",
                                    "Sugiere en gris lo que ya escribiste (→ para aceptarlo) y colorea órdenes y argumentos. Usa Clink en cmd, PSReadLine en PowerShell y ble.sh o los plugins de zsh si están instalados. Se aplica a las terminales nuevas.",
                                )}</small
                            >
                        </span>
                    </label>
                    {#if draft.shellAssist}
                        <div class="shell-assist-settings" data-testid="settings-shell-assist-shells">
                            {#each shellAssistRows as row (row.key)}
                                {@const components = shellAssistComponents(row.key)}
                                <div class="shell-assist-row" data-testid={`settings-shell-assist-${row.key}`}>
                                    <label class="check">
                                        <input
                                            type="checkbox"
                                            data-testid={`settings-shell-assist-${row.key}-enabled`}
                                            bind:checked={draft[row.preference]}
                                        />
                                        <span><strong>{row.title}</strong><small>{row.tool}</small></span>
                                    </label>
                                    {#if components.length}
                                        <ul class="shell-assist-status">
                                            {#each components as component (`${component.label}|${component.distro ?? ""}`)}
                                                <li
                                                    data-testid="settings-shell-assist-component"
                                                    data-shell={row.key}
                                                    data-installed={component.installed === null ? "unknown" : String(component.installed)}
                                                >
                                                    <span class="shell-assist-name">{component.label}{component.distro ? ` · WSL ${component.distro}` : ""}</span>
                                                    <span class="shell-assist-state" class:installed={component.installed === true} class:missing={component.installed === false}>{shellAssistState(component)}</span>
                                                    {#if component.installed !== true}
                                                        <button
                                                            type="button"
                                                            class="secondary"
                                                            data-testid="settings-shell-assist-install"
                                                            onclick={() => void installShellAssist(component.search)}
                                                        >{app.t("settings.shellAssistInstall", "Instalar")}</button>
                                                    {/if}
                                                </li>
                                            {/each}
                                        </ul>
                                    {:else if shellAssistStatus && app.appInfo?.platform === "windows" && (row.key === "bash" || row.key === "zsh")}
                                        <div class="field-hint">{app.t("settings.shellAssistNoWsl", "No hay distribuciones WSL con esta shell.")}</div>
                                    {/if}
                                </div>
                            {/each}
                            <div class="shell-assist-style" data-testid="settings-shell-assist-style">
                                <div class="heading">
                                    <strong>{app.t("settings.assistStyle", "Aspecto de las sugerencias")}</strong>
                                    <span>{app.t("settings.assistStyleHint", "Se aplica a Clink, PSReadLine, ble.sh y los plugins de zsh en las terminales nuevas. Sin marcar, cada herramienta usa sus colores.")}</span>
                                </div>
                                {#each assistColorRows as row (row.key)}
                                    <div class="assist-color">
                                        <label class="check">
                                            <input
                                                type="checkbox"
                                                data-testid={`settings-${row.key}-enabled`}
                                                checked={draft[row.key] !== ""}
                                                onchange={(event) => toggleAssistColor(row.key, row.initial, event.currentTarget.checked)}
                                            />
                                            <span><strong>{row.label}</strong></span>
                                        </label>
                                        {#if draft[row.key] !== ""}
                                            <input type="color" data-testid={`settings-${row.key}`} aria-label={row.label} bind:value={draft[row.key]} />
                                        {/if}
                                    </div>
                                {/each}
                                <label class="check">
                                    <input type="checkbox" data-testid="settings-shell-assist-italic" bind:checked={draft.shellAssistSuggestionItalic} />
                                    <span><strong>{app.t("settings.assistItalic", "Texto sugerido en cursiva")}</strong></span>
                                </label>
                                <label class="check">
                                    <input type="checkbox" data-testid="settings-shell-assist-syntax" bind:checked={draft.shellAssistSyntax} />
                                    <span>
                                        <strong>{app.t("settings.assistSyntax", "Colorear órdenes y argumentos")}</strong>
                                        <small>{app.t("settings.assistSyntaxHint", "Desactivado, solo queda la sugerencia del historial; la línea se escribe sin colores.")}</small>
                                    </span>
                                </label>
                                <label class="check">
                                    <input type="checkbox" data-testid="settings-shell-assist-list-view" bind:checked={draft.shellAssistListView} />
                                    <span>
                                        <strong>{app.t("settings.assistListView", "Predicciones en lista (PowerShell)")}</strong>
                                        <small>{app.t("settings.assistListViewHint", "Muestra varias sugerencias bajo la línea en vez de una en gris tras el cursor. Necesita PSReadLine 2.2 o posterior.")}</small>
                                    </span>
                                </label>
                            </div>
                            <div class="shell-assist-actions">
                                <button
                                    type="button"
                                    class="secondary"
                                    data-testid="settings-shell-assist-refresh"
                                    disabled={shellAssistBusy}
                                    onclick={() => void refreshShellAssist(true)}
                                >{shellAssistBusy
                                    ? app.t("settings.shellAssistChecking", "Comprobando…")
                                    : app.t("settings.shellAssistCheck", "Comprobar de nuevo")}</button>
                            </div>
                        </div>
                    {/if}
                    <div class="banner-settings">
                        <div class="heading">
                            <strong>{app.t("settings.bannerSections", "Información del banner")}</strong>
                            <span>{app.t("settings.bannerSectionsHint", "Solo esencial ocupa unas 5–8 líneas. Guarda para imprimir el cambio en la salida del terminal.")}</span>
                        </div>
                        <div class="banner-presets">
                            <button type="button" class="secondary" data-testid="settings-banner-full" onclick={() => setBannerPreset("full")}>
                                {app.t("settings.bannerFull", "Mostrar todo")}
                            </button>
                            <button type="button" class="secondary" data-testid="settings-banner-compact" onclick={() => setBannerPreset("compact")}>
                                {app.t("settings.bannerCompact", "Solo esencial")}
                            </button>
                        </div>
                        <div class="banner-items">
                            {#each bannerItems as item (item.id)}
                                <label class="check banner-item">
                                    <input
                                        type="checkbox"
                                        data-testid={`settings-banner-${item.id}`}
                                        checked={bannerItemEnabled(item.id)}
                                        onchange={(event) => setBannerItemEnabled(item.id, (event.currentTarget as HTMLInputElement).checked)}
                                    />
                                    <span>
                                        <strong>{app.t(item.labelKey, item.label)}</strong>
                                        <small>{bannerDescription(item)}</small>
                                    </span>
                                </label>
                            {/each}
                        </div>
                    </div>
                </section>
            {/if}

            {#if section === "behavior" || searchingSettings}
                {#if searchingSettings}<h3 class="settings-search-section" data-search-section>{app.t("settings.behavior", "Comportamiento")}</h3>{/if}
                <section>
                    <div class="heading">
                        <strong
                            >{app.t(
                                "settings.startupPanels",
                                "Inicio y paneles",
                            )}</strong
                        >
                        <span
                            >{app.t(
                                "settings.startupPanelsHint",
                                "Solo cambia el comportamiento de la aplicación.",
                            )}</span
                        >
                    </div>

                    <label class="field wide">
                        <span>{app.t("settings.language", "Idioma")}</span>
                        <select data-testid="settings-language" bind:value={draft.language}>
                            {#each app.languages as language (language.id)}
                                <!-- `auto` sale con el nombre del idioma en el
                                     propio idioma activo; los demás se llaman
                                     siempre igual (Español, English), que es lo
                                     que espera quien busca el suyo en la lista. -->
                                <option value={language.id}>
                                    {language.id === "auto"
                                        ? app.t(
                                              "settings.languageAuto",
                                              language.label,
                                          )
                                        : language.label}
                                </option>
                            {/each}
                        </select>
                    </label>
                    <div class="field-hint">
                        {app.t(
                            "settings.languageHint",
                            "Se aplica a toda la interfaz. No cambia la salida de los comandos que ejecutes.",
                        )}
                    </div>

                    <label class="field wide">
                        <span
                            >{app.t(
                                "settings.startupEnv",
                                "Entorno al iniciar",
                            )}</span
                        >
                        <select bind:value={draft.defaultEnvironmentId}>
                            <option value=""
                                >{app.t(
                                    "settings.envAuto",
                                    "Automático según el sistema",
                                )}</option
                            >
                            {#each app.environments.filter((env) => env.available) as env (env.id)}
                                <option value={env.id}>{env.label}</option>
                            {/each}
                        </select>
                    </label>
                    <div class="field-hint">
                        {app.t("settings.startupEnvHint", "La shell de la primera pestaña al abrir WTerminal. Automático usa la habitual del sistema.")}
                    </div>

                    <label class="field wide">
                        <span
                            >{app.t(
                                "settings.scriptEnv",
                                "Terminal para scripts shell",
                            )}</span
                        >
                        <select bind:value={draft.defaultScriptEnvironmentId}>
                            <option value=""
                                >{app.t(
                                    "settings.scriptEnvAuto",
                                    "Automático (WSL preferido sobre Git Bash)",
                                )}</option
                            >
                            {#each app.environments.filter((env) => env.available && !env.repl) as env (env.id)}
                                <option value={env.id}>{env.label}</option>
                            {/each}
                        </select>
                    </label>
                    <div class="field-hint">
                        {app.t(
                            "settings.scriptEnvHint",
                            "Entorno con el que se abren los scripts .sh, .bash, .zsh, etc. si no hay una pestaña compatible ya abierta. Automático prefiere WSL sobre Git Bash.",
                        )}
                    </div>


                    <label class="field wide">
                        <span
                            >{app.t(
                                "settings.hereDepth",
                                "Profundidad de «Aquí»",
                            )}</span
                        >
                        <input
                            type="number"
                            min="0"
                            max="10"
                            step="1"
                            bind:value={draft.scriptsHereDepth}
                        />
                    </label>
                    <div class="field-hint">
                        {app.t("settings.hereDepthHint", "Cuántas carpetas por debajo de la actual recorre «Aquí» en la Biblioteca (0 = solo la actual).")}
                    </div>

                    <label class="check">
                        <input
                            type="checkbox"
                            bind:checked={draft.autoStartDocker}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.autoDocker",
                                    "Iniciar Docker automáticamente",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.autoDockerHint",
                                    "Arrancar Docker al abrir la terminal cuando no responda.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            data-testid="settings-exclusive-groups"
                            type="checkbox"
                            bind:checked={draft.exclusiveAccordionGroups}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.exclusiveGroups",
                                    "Una lista abierta por panel",
                                )}</strong
                            >
                            <small
                                >{app.t(
                                    "settings.exclusiveGroupsHint",
                                    "Al abrir una, cierra la anterior.",
                                )}</small
                            >
                        </span>
                    </label>
                    <label class="check">
                        <input
                            data-testid="settings-auto-open-first"
                            type="checkbox"
                            bind:checked={draft.autoOpenFirstGroup}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.autoOpenFirst",
                                    "Abrir la primera lista",
                                )}</strong
                            >
                            <small>
                                {app.t(
                                    "settings.autoOpenFirstHint",
                                    "Por defecto, todas las listas empiezan cerradas; solo se abre la primera si activas esta opción.",
                                )}
                            </small>
                        </span>
                    </label>
                    <div class="heading">
                        <strong>{app.t("settings.visiblePanels", "Secciones visibles")}</strong>
                        <span>{app.t("settings.visiblePanelsHint", "Oculta funciones que no uses; puedes recuperarlas desde Ajustes.")}</span>
                    </div>
                    <label class="check"><input data-testid="settings-show-dependencies" type="checkbox" bind:checked={draft.showDependenciesPanel} /><span><strong>{app.t("toolbar.deps", "Entorno y dependencias")}</strong><small>{app.t("settings.showDependenciesHint", "Instalar, actualizar y quitar herramientas, lenguajes, shells y modelos de IA.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-projects" type="checkbox" bind:checked={draft.showProjectsPanel} /><span><strong>{app.t("toolbar.projects", "Proyectos")}</strong><small>{app.t("settings.showProjectsHint", "Tus repositorios de GitHub: anclados, clonados, explorar y Mi GitHub.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-library" type="checkbox" bind:checked={draft.showScriptsPanel} /><span><strong>{app.t("toolbar.scripts", "Biblioteca")}</strong><small>{app.t("settings.showLibraryHint", "Tus scripts y los de la carpeta actual, listos para ejecutar.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-explorer" type="checkbox" bind:checked={draft.showExplorerPanel} /><span><strong>{app.t("toolbar.explorer", "Explorador")}</strong><small>{app.t("settings.showExplorerHint", "Árbol de archivos de la carpeta de la terminal, con vistas previas.")}</small></span></label>
                    <div class="heading">
                        <strong>{app.t("settings.interfaceModules", "Interfaz modular")}</strong>
                        <span>{app.t("settings.interfaceModulesHint", "Elige qué controles quieres ver. Las funciones ocultas siguen disponibles mediante sus atajos o comandos.")}</span>
                    </div>
                    <label class="check"><input data-testid="settings-show-tab-bar" type="checkbox" bind:checked={draft.showTabBar} /><span><strong>{app.t("settings.showTabBar", "Barra de pestañas")}</strong><small>{app.t("settings.showTabBarHint", "Muestra las pestañas, el botón + y el control de terminales divididas.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-environment-selector" type="checkbox" bind:checked={draft.showEnvironmentSelector} /><span><strong>{app.t("settings.showEnvironmentSelector", "Selector de entorno")}</strong><small>{app.t("settings.showEnvironmentSelectorHint", "Muestra la shell activa, los REPL favoritos y el botón de refresco.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-refresh" type="checkbox" bind:checked={draft.showRefreshButton} /><span><strong>{app.t("settings.showRefreshButton", "Refrescar entornos")}</strong><small>{app.t("settings.showRefreshButtonHint", "Botón para volver a detectar shells, intérpretes y contenedores.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-language" type="checkbox" bind:checked={draft.showLanguageButton} /><span><strong>{app.t("settings.showLanguageButton", "Selector de idioma")}</strong><small>{app.t("settings.showLanguageButtonHint", "Botón de la barra para cambiar el idioma de la interfaz.")}</small></span></label>
                    <label class="check"><input data-testid="settings-terminal-only" type="checkbox" bind:checked={draft.terminalOnlyMode} /><span><strong>{app.t("settings.terminalOnlyMode", "Modo terminal limpia")}</strong><small>{app.t("settings.terminalOnlyModeHint", "Oculta la barra superior y las pestañas para dejar la ventana dedicada a la terminal. Se recupera con el atajo configurado.")}</small></span></label>
                    <label class="check"><input data-testid="settings-terminal-only-guide" type="checkbox" bind:checked={draft.showTerminalOnlyGuide} disabled={app.preferences?.showTerminalOnlyGuide === false} /><span><strong>{app.t("settings.terminalOnlyGuide", "Guía visible en pantalla limpia")}</strong><small>{app.preferences?.showTerminalOnlyGuide === false
                        ? app.t("settings.terminalOnlyGuideLockedHint", "Desactivada permanentemente desde la guía. Restablece las preferencias para volver a habilitarla.")
                        : app.t("settings.terminalOnlyGuideHint", "Muestra el atajo actual para volver al modo normal mientras la pantalla limpia está activa.")}</small></span></label>
                    <label class="check"><input data-testid="settings-start-maximized" type="checkbox" bind:checked={draft.startMaximized} onchange={scheduleAutoSave} /><span><strong>{app.t("settings.startMaximized", "Iniciar maximizada")}</strong><small>{app.t("settings.startMaximizedHint", "Abre la ventana ocupando todo el espacio disponible al iniciar.")}</small></span></label>
                    <div class="heading">
                        <strong>{app.t("settings.shortcuts", "Atajos de teclado")}</strong>
                        <span>{app.t("settings.shortcutsHint", "Pulsa una combinación para grabarla. Se capturan antes que la terminal; deja un campo vacío para no asignar ese atajo.")}</span>
                    </div>
                    <div class="field-grid">
                        {#each SHORTCUT_DEFINITIONS as shortcut (shortcut.key)}
                            <label class="field shortcut-field">
                                <span>{app.t(shortcut.labelKey, shortcut.fallback)}</span>
                                <div class="shortcut-control">
                                    <input
                                        data-shortcut-input
                                        data-testid={`shortcut-${shortcut.key}`}
                                        readonly
                                        spellcheck="false"
                                        value={draft[shortcut.key]}
                                        placeholder={app.t("settings.shortcutUnset", "Sin asignar")}
                                        aria-label={app.t(shortcut.labelKey, shortcut.fallback)}
                                        onkeydown={(event) => captureShortcut(event, shortcut.key)}
                                    />
                                    <button
                                        type="button"
                                        class="secondary shortcut-clear"
                                        title={app.t("common.clearFilter", "Borrar")}
                                        aria-label={`${app.t("common.clearFilter", "Borrar")} ${app.t(shortcut.labelKey, shortcut.fallback)}`}
                                        onclick={() => {
                                            if (draft) {
                                                draft[shortcut.key] = '';
                                                scheduleAutoSave();
                                            }
                                        }}
                                    >×</button>
                                </div>
                            </label>
                        {/each}
                    </div>
                    <div class="heading">
                        <strong>{app.t("settings.manualAliases", "Alias manuales")}</strong>
                        <span>{app.t("settings.manualAliasesHint", "Uno por línea: nombre=comando. Admite comandos compuestos; Fish los convierte en functions y conserva $argv. Se aplican a pestañas nuevas.")}</span>
                    </div>
                    <label class="field wide alias-editor">
                        <textarea rows="6" spellcheck="false" placeholder={app.t("settings.aliasExample", "serve=npm run dev&#10;gs=git status")} bind:value={draft.manualAliasesText}></textarea>
                    </label>
                    <div class="heading">
                        <strong>{app.t("settings.enabledEnvironments", "Entornos habilitados")}</strong>
                        <span>{app.t("settings.enabledEnvironmentsHint", "Oculta shells, contenedores, dispositivos o REPL concretos sin desinstalarlos.")}</span>
                    </div>
                    <div class="environment-controls">
                        <input type="search" bind:value={environmentQuery} placeholder={app.t("env.search", "Buscar shell, REPL o contenedor…")} aria-label={app.t("settings.environmentSearch", "Buscar entornos")} />
                        <select bind:value={environmentGroup} aria-label={app.t("settings.environmentFilter", "Filtrar entornos por grupo")}>
                            <option value="all">{app.t("settings.allGroups", "Todos los grupos")}</option>
                            {#each environmentGroups as group (group)}<option value={group}>{group}</option>{/each}
                        </select>
                        <button type="button" class="secondary" onclick={() => setVisibleEnvironmentsEnabled(true)}>{app.t("settings.enableVisible", "Activar visibles")}</button>
                        <button type="button" class="secondary" onclick={() => setVisibleEnvironmentsEnabled(false)}>{app.t("settings.disableVisible", "Desactivar visibles")}</button>
                    </div>
                    <div class="environment-toggles">
                        {#each visibleEnvironments as environment (environment.id)}
                            <label class="check">
                                <input
                                    type="checkbox"
                                    checked={!draft.hiddenEnvironmentIds.split(',').includes(environment.id)}
                                    onchange={(event) => setEnvironmentEnabled(
                                        environment.id,
                                        (event.currentTarget as HTMLInputElement).checked
                                    )}
                                />
                                <span><strong>{environment.label}</strong><small>{environment.group}</small></span>
                            </label>
                        {/each}
                    </div>
                    <div class="heading" data-testid="settings-toolchain-store">
                        <strong>{app.t("settings.toolchainStore", "Entornos y descargas")}</strong>
                        <span>{app.t("settings.toolchainStoreNote", "Lo que descargan y crean desde WTerminal los gestores de paquetes, las herramientas y los REPL se guarda en una carpeta propia, por categorías. No cambia las variables del sistema ni las que ya tengas definidas, y nunca mueve lo que ya está instalado.")}</span>
                    </div>
                    <label class="check">
                        <input data-testid="settings-toolchain-store-enabled" type="checkbox" bind:checked={draft.toolchainStoreEnabled} onchange={scheduleAutoSave} />
                        <span><strong>{app.t("settings.toolchainStoreEnable", "Centralizar en una carpeta propia")}</strong><small>{app.t("settings.toolchainStoreNewTerminals", "Se aplica a las terminales que se abran a partir de ahora.")}</small></span>
                    </label>
                    <label class="field span-2">
                        <span>{app.t("settings.toolchainStoreFolder", "Carpeta")}</span>
                        <input
                            data-testid="settings-toolchain-store-dir"
                            type="text"
                            spellcheck="false"
                            value={draft.toolchainStoreDir}
                            placeholder={toolchainStore?.defaultRoot ?? ""}
                            disabled={!draft.toolchainStoreEnabled}
                            oninput={(event) => event.stopPropagation()}
                            onchange={(event) => {
                                event.stopPropagation();
                                commitToolchainStoreDir(event.currentTarget.value);
                            }}
                        />
                    </label>
                    <div class="update-row">
                        <button type="button" data-testid="settings-toolchain-store-open" disabled={!toolchainStore} onclick={() => toolchainStore && void openToolchainFolder(toolchainStore.root)}>{app.t("settings.toolchainStoreOpen", "Abrir carpeta")}</button>
                        <button type="button" disabled={!draft.toolchainStoreDir} onclick={() => commitToolchainStoreDir("")}>{app.t("settings.toolchainStoreReset", "Usar la carpeta por defecto")}</button>
                        <button type="button" data-testid="settings-toolchain-store-refresh" disabled={toolchainStoreBusy} onclick={() => void refreshToolchainStore(true)}>{app.t("settings.toolchainStoreRefresh", "Recalcular")}</button>
                    </div>
                    {#if !toolchainStore}
                        <div class="field-hint">{app.t("settings.toolchainStoreCalculating", "Calculando el espacio…")}</div>
                    {:else}
                        <div class="store-list" data-testid="settings-toolchain-store-caches">
                            <div class="store-caption">
                                <span>{app.t("settings.toolchainStoreCaches", "Cachés")}</span>
                                <span>{app.t("settings.toolchainStoreTotal", "Cachés centralizadas: {size}").replace("{size}", formatBytes(toolchainStore.cacheBytes))}</span>
                            </div>
                            {#each toolchainStore.caches as cache, index (cache.id)}
                                {@const category = storeCategories.find((item) => item.id === cache.category)}
                                {#if category && toolchainStore.caches[index - 1]?.category !== cache.category}
                                    <div class="store-category" data-testid="settings-store-category" data-category={cache.category}>
                                        {#if category.preference}
                                            <label class="check">
                                                <input
                                                    type="checkbox"
                                                    data-testid={`settings-store-category-${cache.category}`}
                                                    disabled={!draft.toolchainStoreEnabled}
                                                    bind:checked={draft[category.preference]}
                                                    onchange={scheduleAutoSave}
                                                />
                                                <span><strong>{category.title}</strong><small>{category.hint}</small></span>
                                            </label>
                                        {:else}
                                            <span><strong>{category.title}</strong><small>{category.hint}</small></span>
                                        {/if}
                                    </div>
                                {/if}
                                <div
                                    class="store-row"
                                    class:inactive={!cache.active}
                                    role="group"
                                    aria-label={`${cache.name}: ${cache.info.purpose} ${cache.info.deletion}`}
                                    data-testid="settings-storage-row"
                                    data-location-id={cache.id}
                                    data-safety={cache.info.safety}
                                    data-category={cache.category}
                                    data-active={String(cache.active)}
                                    data-user-defined={String(cache.userDefined)}
                                    data-location={cache.location}
                                    title={cache.path}
                                    onmouseenter={(event) => showStorageTip(event, cache.name, cache.path, cache.info)}
                                    onmouseleave={hideStorageTip}
                                    onfocusin={(event) => showStorageTip(event, cache.name, cache.path, cache.info)}
                                    onfocusout={hideStorageTip}
                                >
                                    <button type="button" class="store-link" onclick={() => void openToolchainFolder(cache.path)}><i class={`safety-dot ${cache.info.safety}`} aria-hidden="true"></i>{cache.name}</button>
                                    <code>{cache.variable}</code>
                                    <small>{cache.location === "user"
                                        ? app.t("settings.toolchainStoreUserDefined", "definida por ti")
                                        : cache.location === "system"
                                        ? app.t("settings.toolchainStoreSystemLocation", "sin centralizar · ubicación actual")
                                        : ""}</small>
                                    <span class="store-size">{formatBytes(cache.bytes)}</span>
                                </div>
                            {/each}
                        </div>
                        <div class="update-row">
                            <button
                                type="button"
                                class:danger={toolchainStoreConfirmClear}
                                data-testid="settings-toolchain-store-clear"
                                disabled={toolchainStoreBusy || toolchainStore.cacheBytes === 0}
                                onclick={() => void clearToolchainCaches()}
                            >
                                {toolchainStoreConfirmClear
                                    ? app.t("settings.toolchainStoreClearConfirm", "¿Vaciar {size} de cachés? Las herramientas instaladas no se tocan.").replace("{size}", formatBytes(toolchainStore.cacheBytes))
                                    : app.t("settings.toolchainStoreClear", "Vaciar cachés")}
                            </button>
                        </div>
                        {#if toolchainStoreMessage}
                            <div class="field-hint" role="status">{toolchainStoreMessage}</div>
                        {/if}
                    {/if}
                    {#if toolchainExternal === null}
                        <div class="field-hint" data-testid="settings-toolchain-store-external-pending">{app.t("settings.toolchainStoreExternal", "Otras ubicaciones (solo lectura)")}: {app.t("settings.toolchainStoreCalculating", "Calculando el espacio…")}</div>
                    {:else}
                        {#each [
                            { id: "app", rows: appLocations, title: app.t("settings.storageAppFolders", "Carpetas de WTerminal") },
                            { id: "external", rows: otherLocations, title: app.t("settings.toolchainStoreExternal", "Otras ubicaciones (solo lectura)") },
                        ] as list (list.id)}
                            {#if list.rows.length > 0}
                                <div class="store-list" data-testid={list.id === "app" ? "settings-storage-app" : "settings-toolchain-store-external"}>
                                    <div class="store-caption">
                                        <span>{list.title}</span>
                                    </div>
                                    {#each list.rows as location (location.id)}
                                        <div
                                            class="store-row external"
                                            role="group"
                                            aria-label={`${location.label}: ${location.info.purpose} ${location.info.deletion}`}
                                            data-testid="settings-storage-row"
                                            data-location-id={location.id}
                                            data-safety={location.info.safety}
                                            onmouseenter={(event) => showStorageTip(event, location.label, location.path, location.info)}
                                            onmouseleave={hideStorageTip}
                                            onfocusin={(event) => showStorageTip(event, location.label, location.path, location.info)}
                                            onfocusout={hideStorageTip}
                                        >
                                            <button type="button" class="store-link" onclick={() => void openToolchainFolder(location.path)}><i class={`safety-dot ${location.info.safety}`} aria-hidden="true"></i>{location.label}</button>
                                            <span class="store-size">{formatBytes(location.bytes)}</span>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                        {/each}
                        <div class="field-hint">{app.t("settings.storageHoverHint", "Pasa el ratón (o el foco) por una carpeta para ver para qué sirve y si se puede borrar.")}</div>
                    {/if}
                    {#if storageTip}
                        <div
                            class="storage-tip"
                            class:above={storageTip.above}
                            role="tooltip"
                            data-testid="settings-storage-tip"
                            bind:this={storageTipElement}
                            style={`left: ${storageTip.left}px; top: ${storageTip.top}px; width: ${storageTip.width}px;`}
                        >
                            <strong>{storageTip.title}</strong>
                            <code>{storageTip.path}</code>
                            <p><span>{app.t("settings.storagePurpose", "Para qué sirve")}</span>{storageTip.info.purpose}</p>
                            <p class={`storage-safety ${storageTip.info.safety}`}><span>{storageSafetyLabel(storageTip.info.safety)}</span>{storageTip.info.deletion}</p>
                        </div>
                    {/if}
                    {#if pathIntegration?.supported}
                        <div class="heading">
                            <strong>{app.t("settings.pathIntegration", "Invocar WTerminal desde el PATH")}</strong>
                            <span>{pathIntegration.note}</span>
                        </div>
                        <label class="check">
                            <input data-testid="settings-path-integration" type="checkbox" checked={pathIntegration.enabled} disabled={pathIntegrationBusy} onchange={togglePathIntegration} />
                            <span>
                                <strong>{pathIntegration.enabled
                                    ? app.t("settings.pathIntegrationEnabled", "Añadido como wterminal")
                                        .replace(/wterminal(?:\.exe|\.cmd)?/giu, pathCommandLabel(pathIntegration.command))
                                    : app.t("settings.pathIntegrationEnable", "Añadir WTerminal al PATH")}</strong>
                                <small>{pathIntegration.location ?? ""}</small>
                            </span>
                        </label>
                    {/if}
                    {#if windowsIntegration?.supported}
                        <div class="heading">
                            <strong>{app.t("settings.windowsIntegration", "Integración de Windows")}</strong>
                            <span>{windowsIntegration.note}</span>
                        </div>
                        <label class="check">
                            <input type="checkbox" checked={windowsIntegration.contextMenuRegistered} onchange={toggleWindowsIntegration} />
                            <span><strong>{app.t("settings.windowsContext", "Menús «Abrir con WTerminal», App Paths y protocolo wterminal://")}</strong><small>{app.t("settings.windowsUserScope", "Se registra únicamente en HKCU para el usuario actual.")}</small></span>
                        </label>
                        <div class="heading" data-testid="settings-admin">
                            <strong>{app.t("settings.admin", "Permisos de administrador")}</strong>
                            <span>{app.t("settings.adminHint", "WTerminal no necesita ser administrador. Las shells TrustedInstaller de NSudo sí: o se reinicia toda la app como administrador, o gsudo o el sudo de Windows piden el UAC solo para esa pestaña.")}</span>
                        </div>
                        <div class="field-hint" data-testid="settings-admin-status" data-launcher={windowsIntegration.nsudoLauncher}>{adminStatus}</div>
                        {#if !windowsIntegration.elevated}
                            <div class="update-row">
                                <button data-testid="settings-restart-admin" type="button" class="secondary" disabled={adminRestarting} onclick={restartAsAdmin}>{app.t("settings.restartAsAdmin", "Reiniciar como administrador")}</button>
                                {#if !windowsIntegration.gsudoPath}
                                    <button data-testid="settings-install-gsudo" type="button" class="secondary" onclick={() => installShellAssist("gsudo")}>{app.t("settings.installGsudo", "Instalar gsudo")}</button>
                                {/if}
                            </div>
                        {:else}
                            <!-- Un proceso elevado no puede soltar sus permisos:
                                 se vuelve con otra copia sin elevar, solo si nada
                                 la volvería a elevar al abrirse. -->
                            <div class="update-row">
                                <button
                                    data-testid="settings-restart-unelevated"
                                    type="button"
                                    class={adminMode === "normal" ? "" : "secondary"}
                                    disabled={adminRestarting || adminMode !== "normal"}
                                    title={adminMode === "normal"
                                        ? app.t("settings.restartUnelevatedHint", "Esta copia es administrador: un programa no puede soltar sus permisos en marcha, así que se abre otra sin ellos y esta se cierra.")
                                        : app.t("settings.restartUnelevatedBlocked", "Para volver sin permisos, elige antes «Sin permisos de administrador».")}
                                    onclick={restartUnelevated}
                                >{app.t("settings.restartUnelevated", "Reiniciar sin permisos de administrador")}</button>
                            </div>
                        {/if}
                        <div class="admin-modes" role="radiogroup" data-testid="settings-admin-mode" data-mode={adminMode} aria-label={app.t("settings.adminMode", "Al abrir WTerminal")}>
                            <div class="field-hint">
                                <strong>{app.t("settings.adminMode", "Al abrir WTerminal")}</strong>
                                {app.t("settings.adminModeHint", "Las dos formas de abrirlo como administrador elevan toda la app; cambia quién pide el UAC y qué pasa si lo cancelas.")}
                            </div>
                            {#each [
                                { mode: "normal" as const, testId: "settings-admin-mode-normal", label: app.t("settings.adminModeNormal", "Sin permisos de administrador"), hint: app.t("settings.adminModeNormalHint", "De fábrica. Para NSudo bastan gsudo o el sudo de Windows, que piden el UAC solo para esa pestaña.") },
                                { mode: "relaunch" as const, testId: "settings-start-as-admin", label: app.t("settings.startAsAdmin", "Iniciar siempre como administrador (lo pide WTerminal)"), hint: app.t("settings.startAsAdminHint", "Pide el UAC al abrir WTerminal; si lo cancelas, se abre sin elevar. Todas las pestañas serán administrador y Windows no deja arrastrar archivos desde el Explorador a una ventana elevada.") },
                                { mode: "mark" as const, testId: "settings-run-as-admin-flag", label: app.t("settings.runAsAdminFlag", "Marcar WTerminal.exe como «ejecutar como administrador» (lo hace Windows)"), hint: app.t("settings.runAsAdminFlagHint", "Escudo en el icono: Windows pide el UAC antes de abrirlo y, si lo cancelas, no se abre. Solo esta copia del ejecutable y tu usuario.") },
                            ] as option (option.mode)}
                                <label class="check">
                                    <input
                                        data-testid={option.testId}
                                        type="radio"
                                        name="admin-mode"
                                        value={option.mode}
                                        checked={adminMode === option.mode}
                                        disabled={runAsAdminFlagBusy}
                                        onchange={(event) => {
                                            event.stopPropagation();
                                            void setAdminMode(option.mode);
                                        }}
                                    />
                                    <span><strong>{option.label}</strong><small>{option.hint}</small></span>
                                </label>
                            {/each}
                        </div>
                        <div class="field-hint" data-testid="settings-admin-tools">
                            NSudo: {windowsIntegration.nsudoAvailable
                                ? app.t("settings.nsudoDetected", "detectado en {path}").replace("{path}", windowsIntegration.nsudoPath ?? "")
                                : app.t("settings.nsudoMissing", "no instalado; puede instalarse desde Entorno y dependencias")}.
                            gsudo: {windowsIntegration.gsudoPath
                                ? app.t("settings.gsudoDetected", "detectado en {path}").replace("{path}", windowsIntegration.gsudoPath)
                                : app.t("settings.gsudoMissing", "no instalado (opcional)")}.
                            {app.t("settings.windowsSudo", "Sudo de Windows")}: {windowsSudoLabel(windowsIntegration.windowsSudo)}.
                        </div>
                    {/if}
                    <div class="heading">
                        <strong>{app.t("settings.profiles", "Perfiles portables")}</strong>
                        <span>{app.t("settings.profilesHint", "Genera un .sh o .ps1 que detecta la aplicación, la instala desde GitHub si falta y restaura configuración y plugins declarativos. No incluye sesiones, tokens, contraseñas, claves privadas ni binarios.")}</span>
                    </div>
                    <div class="update-row">
                        <button type="button" class="secondary" onclick={exportProfile}>{app.t("settings.exportProfile", "Exportar perfil")}</button>
                        <button type="button" class="secondary" onclick={importProfile}>{app.t("settings.importProfile", "Importar perfil")}</button>
                    </div>
                    <div class="heading">
                        <strong>{app.t("settings.plugins", "Plugins")}</strong>
                        <span>{app.t("settings.pluginsHint", "Extensiones declarativas validadas; no cargan código dentro de la aplicación.")}</span>
                    </div>
                    <div class="update-row">
                        <button type="button" class="secondary" onclick={installPlugin}>{app.t("settings.installPlugin", "Instalar plugin.json")}</button>
                    </div>
                    {#if plugins.length === 0}
                        <div class="field-hint">{app.t("settings.noPlugins", "No hay plugins instalados.")}</div>
                    {:else}
                        {#each plugins as plugin (plugin.id)}
                            <div class="check">
                                <input type="checkbox" checked={plugin.enabled} disabled={Boolean(plugin.error)} onchange={() => togglePlugin(plugin)} />
                                <span><strong>{plugin.name} {plugin.version}</strong><small>{plugin.error ?? plugin.description ?? `${plugin.technologyCount} tecnologías`}</small></span>
                                <button type="button" class="secondary" onclick={() => removePlugin(plugin)}>{app.t("settings.removePlugin", "Retirar")}</button>
                            </div>
                        {/each}
                    {/if}
                    <div class="ltools-settings" data-testid="settings-ltools">
                        <div class="heading">
                            <strong>{app.t("scripts.ltools.title", "Acciones de LTools")}</strong>
                            <span>{app.t("settings.ltoolsExperimentalHint", "Integración experimental. Desactivada por defecto; al activarla aparecerá en la Biblioteca y permitirá descubrir e instalar LTools.")}</span>
                        </div>
                        <label class="check ltools-toggle">
                            <input data-testid="settings-ltools-enabled" type="checkbox" bind:checked={draft.ltoolsEnabled} />
                            <span><strong>{app.t("settings.ltoolsEnabled", "Habilitar LTools experimental")}</strong><small>{app.t("settings.ltoolsEnabledHint", "Muestra las acciones, el selector y la instalación de LTools en la Biblioteca.")}</small></span>
                        </label>
                        {#if draft.ltoolsEnabled}
                            <button type="button" class="secondary" data-testid="settings-ltools-configure" disabled={saving} onclick={() => void openLToolsConfiguration()}>
                                {app.t("scripts.ltools.configure", "Configurar…")}
                            </button>
                        {/if}
                    </div>
                </section>
            {/if}

            {#if section === "about"}
                <section>
                    <div class="about-card">
                        <div class="about-logo">&gt;_</div>
                        <div>
                            <strong>{app.appInfo?.name ?? "Terminal"}</strong>
                            <span
                                >{[version, platform]
                                    .filter(Boolean)
                                    .join(" · ")}</span
                            >
                        </div>
                    </div>

                    <div class="heading">
                        <strong
                            >{app.t("settings.update", "Actualización")}</strong
                        >
                        <span>
                            {#if updating}
                                {app.t(
                                    "update.checking",
                                    "Consultando la última versión…",
                                )}
                            {:else if update?.error}
                                {update.error}
                            {:else if update?.available}
                                {app
                                    .t(
                                        "update.available",
                                        "Hay una versión más reciente: {version}.",
                                    )
                                    .replace(
                                        "{version}",
                                        update.latestVersion ?? "",
                                    )}
                            {:else if update}
                                {app
                                    .t(
                                        "update.upToDate",
                                        "{app} está en la versión más reciente.",
                                    )
                                    .replace(
                                        "{app}",
                                        app.appInfo?.name ?? "La terminal",
                                    )}
                            {/if}
                        </span>
                    </div>
                    <div class="update-row">
                        <button
                            type="button"
                            class="secondary"
                            disabled={updating}
                            onclick={checkUpdate}
                        >
                            {app.t("update.check", "Buscar actualizaciones")}
                        </button>
                        <!-- El botón de aplicar solo aparece cuando de verdad
                             hay algo que aplicar y esta copia puede hacerlo: una
                             build de desarrollo no se actualiza sobre sí misma. -->
                        {#if update?.available && update.canSelfUpdate}
                            <button
                                type="button"
                                class="primary"
                                disabled={updating}
                                onclick={installUpdate}
                            >
                                {app.t(
                                    "update.install",
                                    "Actualizar y reiniciar",
                                )}
                            </button>
                        {/if}
                    </div>
                    {#if update?.available && update.installPath}
                        {#if updating && updateProgress}
                            <div class="field-hint" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={updateProgress.percent}>
                                {updateProgress.stage === "download"
                                    ? app.t("update.downloading", "Descargando: {percent}% ({current} MiB{total})")
                                        .replace("{percent}", String(updateProgress.percent ?? "…"))
                                        .replace("{current}", String(Math.round(updateProgress.bytes / 1048576)))
                                        .replace("{total}", updateProgress.total ? ` / ${Math.round(updateProgress.total / 1048576)} MiB` : "")
                                    : updateProgress.stage === "extract"
                                        ? app.t("update.preparing", "Preparando los archivos…")
                                        : app.t("update.downloaded", "Descarga completada.")}
                            </div>
                        {/if}
                        <div class="field-hint">
                            {app
                                .t("update.into", "Se instalará en {path}")
                                .replace("{path}", update.installPath)}
                        </div>
                    {/if}

                    <div class="heading">
                        <strong>{app.t("settings.primaryDeveloper", "Desarrollador principal")}</strong>
                        <span
                            >{app.t(
                                "settings.developersHint",
                                "Créditos definidos en el catálogo de distribución.",
                            )}</span
                        >
                    </div>
                    <div class="developers">
                        {#if primaryDeveloper}
                            <button
                                type="button"
                                class="developer"
                                title={app
                                    .t("settings.openProfile", "Abrir {url}")
                                    .replace(
                                        "{url}",
                                        `https://github.com/${primaryDeveloper}`,
                                    )}
                                onclick={() => api.openInGithub(primaryDeveloper)}
                            >
                                    @{primaryDeveloper} · {app.t("settings.primaryDeveloper", "Desarrollador principal")}
                            </button>
                        {:else}
                            <span class="field-hint">
                                {app.t(
                                    "settings.developersPending",
                                    "Pendiente de completar.",
                                )}
                            </span>
                        {/if}
                    </div>
                    {#if (app.appInfo?.collaborators ?? []).length}
                        <div class="heading">
                            <strong>{app.t("settings.collaborators", "Colaboradores")}</strong>
                            <span>{app.t("settings.collaboratorsHint", "Personas que colaboran específicamente con esta distribución.")}</span>
                        </div>
                        <div class="developers">
                            {#each app.appInfo?.collaborators ?? [] as collaborator (collaborator.login)}
                                <button
                                    type="button"
                                    class="developer"
                                    title={app.t("settings.openProfile", "Abrir {url}").replace("{url}", `https://github.com/${collaborator.login}`)}
                                    onclick={() => api.openInGithub(collaborator.login)}
                                >
                                    @{collaborator.login} · {collaborator.role}
                                </button>
                            {/each}
                        </div>
                    {/if}

                    <div class="heading">
                        <strong
                            >{app.t(
                                "settings.localConfig",
                                "Configuración local",
                            )}</strong
                        >
                    </div>
                    <div class="path" title={app.appInfo?.settingsPath ?? ""}>
                        {app.t("settings.file", "Archivo")}: {app.appInfo
                            ?.settingsPath ?? ""}
                    </div>
                </section>
            {/if}

            <div class="footer">
                <span class="autosave-state" data-testid="settings-autosave" data-state={autoSaveState} aria-live="polite">
                    {#if autoSaveState === 'saving' || autoSaveState === 'pending'}
                        {app.t("settings.autoSaving", "Guardando automáticamente…")}
                    {:else if autoSaveState === 'error'}
                        {app.t("settings.autoSaveError", "No se pudo guardar automáticamente.")}
                    {:else}
                        {app.t("settings.autoSaved", "Cambios guardados automáticamente")}
                    {/if}
                </span>
                <button
                    type="button"
                    class="secondary"
                    disabled={saving}
                    onclick={reset}
                >
                    <span data-testid="settings-reset-label">{app.t("settings.reset", "Restablecer")}</span>
                </button>
            </div>
        </form>
    {/if}
</Panel>

<style>
    .settings-search {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px 0 2px;
    }
    .settings-search input {
        flex: 1 1 auto;
        min-width: 0;
        padding: 5px 8px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 12px;
    }
    .settings-search small {
        flex: none;
        color: var(--muted);
        font-size: 11px;
    }
    .settings-index {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px 0 2px;
    }
    .settings-index button {
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
    }
    .settings-index button:hover {
        border-color: var(--accent);
        color: var(--text);
    }
    .settings-search-section {
        margin: 14px 0 2px;
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
    }
    :global(.settings-form .search-hidden) {
        display: none !important;
    }
    .banner-image-settings {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 2px 0 8px 28px;
    }
    .banner-image-preview {
        width: 64px;
        height: 64px;
        flex: none;
        object-fit: contain;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
    }
    .banner-image-controls {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
    }
    .banner-image-path input {
        width: min(42em, 100%);
    }
    .banner-image-error {
        color: var(--danger);
    }
    .banner-image-apply {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        align-items: center;
        padding: 0 0 8px 28px;
        color: var(--muted);
    }
    .banner-image-columns input {
        width: 6em;
    }
    /* Las pestañas viven en la cabecera fija del panel; ya no forman parte del
       contenido desplazable y no pueden dejar pasar controles por detrás. */
    /* Las pestañas se compactan por el ancho real del panel. En una ventana
       estrecha se muestran en dos o una columna y el texto puede partirse sin
       invadir la pestaña vecina ni provocar scroll horizontal. */
    .tabs {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
        padding: 7px 0;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
    }

    .tabs button {
        min-width: 0;
        padding: 7px 5px;
        line-height: 1.15;
        overflow-wrap: anywhere;
        white-space: normal;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
    }

    @container (max-width: 480px) {
        .tabs {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @container (max-width: 300px) {
        .tabs {
            grid-template-columns: 1fr;
        }
    }

    .tabs button:hover {
        border-color: var(--border);
        color: var(--text);
    }

    .tabs button.active {
        border-color: var(--accent);
        background: var(--accent-soft);
        box-shadow: inset 0 -3px 0 var(--accent);
        color: var(--text);
        font-weight: 700;
    }

    section {
        display: flex;
        flex-direction: column;
        gap: 9px;
        padding: 13px 4px 4px;
    }

    .heading {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .heading strong {
        font-size: 12px;
    }

    .heading span {
        color: var(--muted);
        font-size: 10px;
    }

    /* Las columnas salen del ancho REAL del panel, no de un numero fijo: con
       trece temas y el panel estrechado, tres columnas dejaban los nombres en
       una letra por linea. */
    .themes {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 6px;
    }

    .theme-card {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--surface-alt);
        color: var(--text);
        font-size: 11px;
        cursor: pointer;
    }

    .theme-card:hover,
    .theme-card.selected {
        border-color: var(--accent);
    }

    .theme-card.selected {
        background: var(--accent-soft);
    }

    /* El radio existe para el teclado y los lectores de pantalla; lo que se ve
       es la tarjeta entera, que es un área de clic mucho mayor. */
    .theme-card input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
    }

    .theme-card .swatch {
        height: 18px;
        border-radius: 4px;
    }

    .theme-card strong {
        overflow: hidden;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .theme-card.custom {
        position: relative;
    }

    .theme-card .theme-delete {
        position: absolute;
        top: 3px;
        right: 3px;
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
    }

    .theme-card .theme-delete:hover,
    .theme-card .theme-delete:focus-visible {
        background: var(--surface-hover);
        color: var(--text);
    }

    .store-category {
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px solid var(--border);
    }

    .store-category > span {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .store-category small {
        color: var(--muted);
    }

    .store-row.inactive {
        opacity: 0.6;
    }

    .shell-assist-style {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 6px;
    }

    .assist-color {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .assist-color input[type="color"] {
        width: 48px;
        height: 24px;
        padding: 0;
    }

    .custom-theme-save {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }

    .custom-theme-save input {
        flex: 1 1 180px;
        min-width: 0;
    }

    .custom-theme-save small {
        flex-basis: 100%;
        color: var(--muted);
    }

    .ansi-grid {
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        gap: 6px;
    }

    .ansi-color {
        display: flex;
        min-width: 0;
        flex-direction: column;
        align-items: center;
        gap: 2px;
    }

    .ansi-color input {
        width: 100%;
        height: 24px;
        padding: 0;
    }

    .ansi-color small {
        overflow: hidden;
        max-width: 100%;
        color: var(--muted);
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ansi-preview {
        letter-spacing: 2px;
    }

    .preview {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        font-family: var(--terminal-font);
        font-size: 12px;
    }

    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
    }

    .field {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
        color: var(--muted);
        font-size: 10px;
    }

    .field.span-2 {
        grid-column: span 2;
    }

    /* Con el panel estrecho la rejilla ya solo tiene una columna, y pedir dos
       dejaria el campo desbordando por la derecha. */
    @container (max-width: 340px) {
        .field.span-2 {
            grid-column: span 1;
        }
    }

    .field.wide {
        width: 100%;
        max-width: none;
    }

    .alias-editor textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 112px;
        resize: vertical;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
        color: var(--text);
        font: 11px/1.55 var(--terminal-font);
    }

    .alias-editor textarea:focus,
    .environment-controls input:focus,
    .environment-controls select:focus {
        border-color: var(--accent);
        outline: none;
        box-shadow: 0 0 0 2px var(--accent-soft);
    }

    .environment-controls {
        display: grid;
        grid-template-columns: minmax(160px, 1fr) minmax(140px, .65fr) auto auto;
        gap: 6px;
    }

    .environment-controls input,
    .environment-controls select {
        min-width: 0;
        padding: 7px 9px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
    }

    .environment-toggles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 3px 12px;
        max-height: 220px;
        overflow: auto;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
    }

    @container (max-width: 580px) {
        .environment-controls { grid-template-columns: 1fr 1fr; }
    }

    .field :global(input),
    .field :global(select) {
        min-height: 32px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
        transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    .field :global(select) {
        padding-right: 28px;
    }

    .field :global(input:focus),
    .field :global(select:focus) {
        border-color: var(--accent);
        outline: none;
        box-shadow: 0 0 0 2px var(--accent-soft);
    }

    .field :global(input[type="color"]) {
        height: 32px;
        padding: 3px;
    }

    .field-hint {
        color: var(--muted);
        font-size: 10px;
    }

    .check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        cursor: pointer;
    }

    .check span {
        display: flex;
        flex-direction: column;
    }

    .check strong {
        font-size: 11px;
    }

    .check small {
        color: var(--muted);
        font-size: 10px;
    }

    .about-card {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--surface-alt);
    }

    .about-logo {
        padding: 6px 10px;
        border-radius: 6px;
        background: var(--accent-soft);
        color: var(--accent);
        font-family: var(--terminal-font);
        font-size: 16px;
    }

    .about-card div:last-child {
        display: flex;
        flex-direction: column;
    }

    .about-card span {
        color: var(--muted);
        font-size: 10px;
    }

    .update-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    /* Las tres formas de abrir WTerminal, una debajo de otra. */
    .admin-modes {
        display: grid;
        gap: 4px;
    }

    .shortcut-control {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .shortcut-control :global(input) {
        flex: 1 1 auto;
        min-width: 0;
    }

    .shortcut-clear {
        flex: 0 0 auto;
        min-width: 32px;
        min-height: 32px;
        padding: 4px 8px;
    }

    .update-row button {
        padding: 5px 14px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
    }

    .update-row button.primary {
        border-color: var(--accent);
        background: var(--accent-soft);
        font-weight: 600;
    }

    .update-row button:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .update-row button:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .update-row button.danger {
        border-color: var(--danger);
        color: var(--danger);
        font-weight: 600;
    }

    .store-list {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
        font-size: 11px;
    }

    .store-caption,
    .store-row {
        display: grid;
        grid-template-columns: minmax(70px, 1fr) minmax(0, 1.6fr) minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
    }

    .store-caption {
        display: flex;
        justify-content: space-between;
        background: var(--surface-alt);
        color: var(--muted);
        font-size: 10px;
    }

    .store-row + .store-row {
        border-top: 1px solid var(--border);
    }

    .store-row code,
    .store-row small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--muted);
        font-size: 10px;
    }

    .store-row.external {
        grid-template-columns: minmax(0, 1fr) auto;
    }

    .store-size {
        font-variant-numeric: tabular-nums;
        text-align: right;
    }

    .store-link {
        overflow: hidden;
        padding: 0;
        border: 0;
        background: none;
        color: var(--text);
        font: inherit;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
    }

    .safety-dot {
        display: inline-block;
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        margin-right: 6px;
        border-radius: 50%;
        vertical-align: middle;
        background: var(--muted);
    }

    .safety-dot.safe,
    .safety-dot.regenerates,
    .storage-safety.safe span,
    .storage-safety.regenerates span {
        background: var(--success);
    }

    .safety-dot.caution,
    .storage-safety.caution span {
        background: var(--warning);
    }

    .safety-dot.keep,
    .storage-safety.keep span {
        background: var(--danger);
    }

    .store-row:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
    }

    /* Coordenadas de la ventana: `container-type` del panel no crea bloque
       contenedor para un elemento fijo, así que `placeFloatingTip` calcula
       sobre los rectángulos medidos y `fitFloatingTip` la mete en el panel. */
    .storage-tip {
        position: fixed;
        z-index: 60;
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 9px 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        font-size: 11px;
        pointer-events: none;
    }

    .storage-tip.above {
        transform: translateY(-100%);
    }

    .storage-tip code {
        overflow-wrap: anywhere;
        color: var(--muted);
        font-size: 10px;
    }

    .storage-tip p {
        margin: 0;
        line-height: 1.4;
    }

    .storage-tip p span {
        display: inline-block;
        margin-right: 6px;
        padding: 0 6px;
        border-radius: 8px;
        background: var(--surface-alt);
        color: var(--text);
        font-size: 10px;
        font-weight: 700;
    }

    .storage-tip .storage-safety span {
        color: #111;
    }

    .storage-tip .storage-safety.keep span {
        color: #fff;
    }

    .store-link:hover {
        color: var(--accent);
        text-decoration: underline;
    }

    .developers {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .developer {
        max-width: 100%;
        overflow: hidden;
        padding: 4px 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
    }

    .developer:hover {
        border-color: var(--accent);
    }

    .path {
        overflow: hidden;
        color: var(--muted);
        font-family: var(--terminal-font);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .shell-assist-settings {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-left: 22px;
        padding: 9px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
    }

    .shell-assist-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .shell-assist-status {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin: 0 0 0 22px;
        padding: 0;
        list-style: none;
        font-size: 10px;
    }

    .shell-assist-status li {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 22px;
    }

    .shell-assist-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .shell-assist-state {
        color: var(--muted);
    }

    .shell-assist-state.installed {
        color: var(--success, #4caf50);
    }

    .shell-assist-state.missing {
        color: var(--warning, #e0a030);
    }

    .shell-assist-status button {
        flex: 0 0 auto;
        padding: 2px 8px;
        font-size: 10px;
    }

    .shell-assist-actions {
        display: flex;
        justify-content: flex-end;
    }

    .banner-settings {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 8px;
        padding: 9px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
    }

    .ltools-settings {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 4px;
        padding: 9px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
    }

    .ltools-settings button {
        flex: 0 0 auto;
        padding: 5px 10px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
    }

    .ltools-settings button:hover {
        border-color: var(--accent);
        background: var(--surface-hover);
    }

    @container (max-width: 420px) {
        .ltools-settings {
            align-items: stretch;
            flex-direction: column;
        }
    }

    .banner-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .banner-presets button {
        padding: 5px 10px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
    }

    .banner-presets button:hover {
        border-color: var(--accent);
        background: var(--surface-hover);
    }

    .banner-items {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 4px 8px;
    }

    .banner-item {
        min-width: 0;
        margin: 0;
        padding: 4px 0;
    }

    .footer {
        position: sticky;
        /* Anula el relleno inferior del scroll: con menos, quedaba una franja
           bajo el pie por la que se veía pasar el formulario. */
        bottom: calc(-1 * var(--panel-scroll-bottom, 14px));
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
        padding: 9px 4px;
        border-top: 1px solid var(--border);
        background: var(--surface);
    }

    /* El pie sticky va en el flujo del formulario, así que el último control
       siempre queda encima de él al final del scroll. El margen negativo
       absorbe el relleno inferior del scroll: sin él, al llegar abajo el pie
       subía y dejaba una franja vacía debajo. */
    .settings-form {
        padding-bottom: 0;
        margin-bottom: calc(-1 * var(--panel-scroll-bottom, 14px));
    }

    /* El pie sticky tapa la franja inferior del scroll. Un control al que se
       llega con Tab quedaba justo debajo del pie, enfocado pero sin verse
       (la casilla de LTools tras reordenar «Comportamiento»). Este margen hace
       que el desplazamiento del foco lo deje por encima del pie. */
    .settings-form :global(section *) {
        scroll-margin-bottom: 64px;
    }

    .footer button {
        padding: 5px 14px;
        border: 1px solid var(--border);
        border-radius: 4px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
    }

    .footer .secondary {
        background: var(--surface-alt);
        color: var(--text);
    }

    .footer button:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .footer button:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .loading {
        padding: 14px 8px;
        color: var(--muted);
    }
</style>
