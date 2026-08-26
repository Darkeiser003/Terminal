<script lang="ts">
    // Panel de preferencias.
    //
    // Port de la sección `#settings-panel` de `electron/renderer`. Cuatro
    // secciones (Apariencia, Terminal, Comportamiento, Información) sobre un
    // borrador local: nada se aplica hasta Guardar, así que se puede trastear
    // con los colores y salirse sin dejar la terminal de un color raro.
    //
    // Lo que se guarda no es lo que hay en el formulario: el backend valida
    // todos los valores y devuelve los que de verdad quedaron. La interfaz se
    // repinta con ESOS, no con los del formulario, así que un número fuera de
    // rango se ve corregido en el sitio en vez de aceptarse en silencio.

    import * as api from "../lib/api";
    import { app } from "../lib/appState.svelte";
    import { includesLocalized } from "../lib/localization";
    import { normalizeShortcut, SHORTCUT_PREFERENCE_KEYS } from "../lib/shortcuts";
    import type { PluginInfo, Preferences, ThemePreset, UpdateProgress, UpdateStatus, WindowsIntegrationStatus } from "../lib/types";
    import Panel from "./Panel.svelte";

    type Section = "appearance" | "terminal" | "behavior" | "about";

    let section = $state<Section>("appearance");
    /** Borrador: una copia de las preferencias que solo existe mientras el
     *  panel está abierto. */
    let draft = $state<Preferences | null>(null);
    let status = $state("");
    let statusError = $state(false);
    let saving = $state(false);
    /** Lo que se sabe de la actualización. Se consulta al abrir la sección de
     *  Información, no al abrir el panel: es una petición a GitHub y no tiene
     *  por qué hacerse cada vez que alguien viene a cambiar un color. */
    let update = $state<UpdateStatus | null>(null);
    let updating = $state(false);
    let updateProgress = $state<UpdateProgress | null>(null);
    let plugins = $state<PluginInfo[]>([]);
    let windowsIntegration = $state<WindowsIntegrationStatus | null>(null);
    let environmentQuery = $state("");
    let environmentGroup = $state("all");
    let loadSerial = 0;

    const PLATFORM_NAMES: Record<string, string> = {
        windows: "Windows",
        linux: "Linux",
        macos: "macOS",
    };

    export async function load(): Promise<void> {
        const serial = ++loadSerial;
        status = "";
        statusError = false;
        section = "appearance";
        // Se piden al backend en vez de reutilizar las que ya hay en memoria:
        // el archivo puede haber cambiado por fuera.
        await app.reloadPreferences();
        const nextPlugins = await api.listPlugins();
        const nextWindowsIntegration =
            app.appInfo?.platform === "windows" ? await api.getWindowsIntegration() : null;
        if (serial !== loadSerial) return;
        plugins = nextPlugins;
        windowsIntegration = nextWindowsIntegration;
        draft = app.preferences ? { ...app.preferences } : null;
    }

    /** Elegir un tema no lo aplica: rellena los tres colores del borrador con
     *  su paleta, que es lo que el usuario puede seguir retocando encima. */
    function chooseTheme(theme: ThemePreset): void {
        if (!draft) return;
        draft.themeId = theme.id;
        draft.accentColor = theme.palette.accent;
        draft.uiBackgroundColor = theme.palette.background;
        draft.uiSurfaceColor = theme.palette.surface;
        draft.uiSurfaceAltColor = theme.palette.surfaceAlt;
        draft.uiBorderColor = theme.palette.border;
        draft.uiTextColor = theme.palette.text;
        draft.uiMutedColor = theme.palette.muted;
        draft.terminalSelectionColor = theme.palette.selection;
        draft.fastfetchColor = theme.palette.accent;
        draft.terminalCursorColor = theme.palette.accent;
        draft.terminalBackground = theme.palette.terminalBackground;
        draft.terminalForeground = theme.palette.terminalForeground;
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
        if (theme.id === "green-phosphor") return app.t("theme.greenPhosphor", theme.label);
        if (theme.id === "high-contrast") return app.t("theme.highContrast", theme.label);
        if (theme.id === "slate") return app.t("theme.slate", theme.label);
        if (theme.id === "plum") return app.t("theme.plum", theme.label);
        if (theme.id === "teal") return app.t("theme.turquoise", theme.label);
        return theme.label;
    }

    function setEnvironmentEnabled(environmentId: string, enabled: boolean): void {
        if (!draft) return;
        const hidden = new Set(draft.hiddenEnvironmentIds.split(',').filter(Boolean));
        if (enabled) hidden.delete(environmentId);
        else hidden.add(environmentId);
        draft.hiddenEnvironmentIds = [...hidden].join(',');
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
    }

    function setBannerPreset(preset: "full" | "compact"): void {
        if (!draft) return;
        draft.bannerHiddenItems = preset === "full"
            ? ""
            : ["host", "kernel", "environment", "motherboard", "gpu", "datetime"].join(",");
    }

    async function save(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (!draft || saving) return;
        const currentDraft = draft;
        const shortcuts = SHORTCUT_PREFERENCE_KEYS.map((key) =>
            normalizeShortcut(currentDraft[key]) || currentDraft[key].trim().toLowerCase()
        );
        if (new Set(shortcuts).size !== shortcuts.length) {
            statusError = true;
            status = app.t("settings.shortcutConflict", "Dos acciones no pueden usar el mismo atajo.");
            return;
        }
        saving = true;
        try {
            const normalizedDraft = { ...draft };
            for (const key of SHORTCUT_PREFERENCE_KEYS) {
                const normalized = normalizeShortcut(normalizedDraft[key]);
                if (normalized) normalizedDraft[key] = normalized;
            }
            await app.savePreferences(normalizedDraft);
            // El backend devuelve lo que de verdad se guardó: el borrador se
            // rehace con eso para que un valor corregido se vea corregido.
            draft = app.preferences ? { ...app.preferences } : null;
            statusError = false;
            status = app.t(
                "settings.savedNote",
                "Guardado. El entorno inicial y Docker se aplican en el próximo arranque.",
            );
        } catch (cause) {
            statusError = true;
            status =
                app.t(
                    "settings.saveFailed",
                    "No se pudieron guardar las preferencias.",
                ) +
                " " +
                String(cause);
        } finally {
            saving = false;
        }
    }

    async function reset(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            await app.resetPreferences();
            draft = app.preferences ? { ...app.preferences } : null;
            statusError = false;
            status = app.t("settings.resetDone", "Preferencias restablecidas.");
        } catch (cause) {
            statusError = true;
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
    {/snippet}

    {#if !draft}
        <div class="loading">
            {app.t("settings.loading", "Cargando preferencias…")}
        </div>
    {:else}
        <form onsubmit={save}>
            {#if section === "appearance"}
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
                                    style="background: linear-gradient(135deg, {theme
                                        .palette.background} 0 64%, {theme
                                        .palette.accent} 64%)"
                                ></span>
                                <strong>{translateThemeLabel(theme)}</strong>
                            </label>
                        {/each}
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
                </section>
            {/if}

            {#if section === "terminal"}
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
                                max="1.8"
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
                            bind:checked={draft.copyOnSelect}
                        />
                        <span>
                            <strong
                                >{app.t(
                                    "settings.copyOnSelect",
                                    "Copiar al seleccionar",
                                )}</strong
                            >
                            <small>
                                {app.t(
                                    "settings.copyOnSelectHint",
                                    "Al soltar el ratón, lo seleccionado va al portapapeles.",
                                )}
                            </small>
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
                                    "Banner al crear una sesión nueva.",
                                )}</small
                            >
                        </span>
                    </label>
                    <div class="banner-settings">
                        <div class="heading">
                            <strong>{app.t("settings.bannerSections", "Información del banner")}</strong>
                            <span>{app.t("settings.bannerSectionsHint", "El mínimo siempre reserva cinco filas para escribir. Guarda los cambios para repintar las pestañas.")}</span>
                        </div>
                        <div class="banner-presets">
                            <button type="button" class="secondary" onclick={() => setBannerPreset("full")}>
                                {app.t("settings.bannerFull", "Mostrar todo")}
                            </button>
                            <button type="button" class="secondary" onclick={() => setBannerPreset("compact")}>
                                {app.t("settings.bannerCompact", "Solo esencial")}
                            </button>
                        </div>
                        <div class="banner-items">
                            {#each bannerItems as item (item.id)}
                                <label class="check banner-item">
                                    <input
                                        type="checkbox"
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

            {#if section === "behavior"}
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
                        <select bind:value={draft.language}>
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
                    <label class="check"><input data-testid="settings-show-dependencies" type="checkbox" bind:checked={draft.showDependenciesPanel} /><span><strong>{app.t("toolbar.deps", "Entorno y dependencias")}</strong></span></label>
                    <label class="check"><input data-testid="settings-show-projects" type="checkbox" bind:checked={draft.showProjectsPanel} /><span><strong>{app.t("toolbar.projects", "Proyectos")}</strong></span></label>
                    <label class="check"><input data-testid="settings-show-library" type="checkbox" bind:checked={draft.showScriptsPanel} /><span><strong>{app.t("toolbar.scripts", "Biblioteca")}</strong></span></label>
                    <label class="check"><input data-testid="settings-show-quick-actions" type="checkbox" bind:checked={draft.showQuickActions} /><span><strong>{app.t("settings.showQuickActions", "Acciones rápidas")}</strong><small>{app.t("settings.showQuickActionsHint", "Muestra el submenú de acciones rápidas en la Biblioteca.")}</small></span></label>
                    <label class="check"><input data-testid="settings-show-explorer" type="checkbox" bind:checked={draft.showExplorerPanel} /><span><strong>{app.t("toolbar.explorer", "Explorador")}</strong></span></label>
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
                    <div class="heading">
                        <strong>{app.t("settings.manualAliases", "Alias manuales")}</strong>
                        <span>{app.t("settings.manualAliasesHint", "Uno por línea: nombre=comando. Admite comandos compuestos; Fish los convierte en functions y conserva $argv. Se aplican a pestañas nuevas.")}</span>
                    </div>
                    <label class="field wide alias-editor">
                        <textarea rows="6" spellcheck="false" placeholder={app.t("settings.aliasExample", "serve=npm run dev&#10;gs=git status")} bind:value={draft.manualAliasesText}></textarea>
                    </label>
                    <div class="heading">
                        <strong>{app.t("settings.shortcuts", "Atajos de teclado")}</strong>
                        <span>{app.t("settings.shortcutsHint", "Usa combinaciones como Ctrl+Shift+T. Navegación directa: Control derecho + W/A/S/D, sin interferir con el Control izquierdo de la shell.")}</span>
                    </div>
                    <div class="shortcut-preset" aria-label={app.t("settings.shortcutsNavigation", "Navegación fija entre paneles")}>
                        <span><kbd>{app.t("settings.rightControl", "Ctrl derecho")}</kbd> + <kbd>W</kbd> {app.t("settings.shortcutUp", "arriba")}</span>
                        <span><kbd>{app.t("settings.rightControl", "Ctrl derecho")}</kbd> + <kbd>A</kbd> {app.t("settings.shortcutLeft", "izquierda")}</span>
                        <span><kbd>{app.t("settings.rightControl", "Ctrl derecho")}</kbd> + <kbd>S</kbd> {app.t("settings.shortcutDown", "abajo")}</span>
                        <span><kbd>{app.t("settings.rightControl", "Ctrl derecho")}</kbd> + <kbd>D</kbd> {app.t("settings.shortcutRight", "derecha")}</span>
                    </div>
                    <div class="field-grid">
                        <label class="field"><span>{app.t("settings.shortcutNewTab", "Nueva pestaña")}</span><input spellcheck="false" bind:value={draft.shortcutNewTab} /></label>
                        <label class="field"><span>{app.t("settings.shortcutNextTab", "Pestaña siguiente")}</span><input spellcheck="false" bind:value={draft.shortcutNextTab} /></label>
                        <label class="field"><span>{app.t("settings.shortcutPreviousTab", "Pestaña anterior")}</span><input spellcheck="false" bind:value={draft.shortcutPreviousTab} /></label>
                        <label class="field"><span>{app.t("settings.shortcutCyclePanes", "Dividir terminales")}</span><input spellcheck="false" bind:value={draft.shortcutCyclePanes} /></label>
                        <label class="field"><span>{app.t("settings.shortcutToggleExplorer", "Mostrar explorador")}</span><input spellcheck="false" bind:value={draft.shortcutToggleExplorer} /></label>
                        <label class="field"><span>{app.t("settings.shortcutPaneLeft", "Foco a la izquierda")}</span><input spellcheck="false" bind:value={draft.shortcutPaneLeft} /></label>
                        <label class="field"><span>{app.t("settings.shortcutPaneRight", "Foco a la derecha")}</span><input spellcheck="false" bind:value={draft.shortcutPaneRight} /></label>
                        <label class="field"><span>{app.t("settings.shortcutPaneUp", "Foco arriba")}</span><input spellcheck="false" bind:value={draft.shortcutPaneUp} /></label>
                        <label class="field"><span>{app.t("settings.shortcutPaneDown", "Foco abajo")}</span><input spellcheck="false" bind:value={draft.shortcutPaneDown} /></label>
                    </div>
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
                    {#if windowsIntegration?.supported}
                        <div class="heading">
                            <strong>{app.t("settings.windowsIntegration", "Integración de Windows")}</strong>
                            <span>{windowsIntegration.note}</span>
                        </div>
                        <label class="check">
                            <input type="checkbox" checked={windowsIntegration.contextMenuRegistered} onchange={toggleWindowsIntegration} />
                            <span><strong>{app.t("settings.windowsContext", "Menús «Abrir con WinSlim Terminal», App Paths y protocolo winslim://")}</strong><small>{app.t("settings.windowsUserScope", "Se registra únicamente en HKCU para el usuario actual.")}</small></span>
                        </label>
                        <div class="field-hint">
                            NSudo: {windowsIntegration.nsudoAvailable
                                ? app.t("settings.nsudoDetected", "detectado en {path}").replace("{path}", windowsIntegration.nsudoPath ?? "")
                                : app.t("settings.nsudoMissing", "no instalado; puede instalarse desde Entorno y dependencias")}.
                        </div>
                    {/if}
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
                <button
                    type="button"
                    class="secondary"
                    disabled={saving}
                    onclick={reset}
                >
                    {app.t("settings.reset", "Restablecer")}
                </button>
                <button data-testid="settings-save" type="submit" class="primary" disabled={saving}>
                    {app.t("settings.save", "Guardar")}
                </button>
            </div>
        </form>
    {/if}
</Panel>

<style>
    /* Las pestañas se quedan a la vista al desplazar: en Terminal la lista es
       más alta que el panel y volver arriba para cambiar de sección estorba. */
    /* Las cuatro secciones caben siempre: son etiquetas cortas y partirlas en
       dos filas costaria mas altura de la que ahorra. Lo que si hace falta es
       que el texto se recorte en vez de desbordar. */
    .tabs {
        position: sticky;
        top: 38px;
        z-index: 3;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
        padding: 7px 0;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
    }

    .tabs button {
        overflow: hidden;
        padding: 7px 5px;
        text-overflow: ellipsis;
        white-space: nowrap;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
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

    .shortcut-preset {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 6px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface-alt);
        color: var(--muted);
        font-size: 10px;
    }

    .shortcut-preset kbd {
        padding: 2px 5px;
        border: 1px solid var(--border);
        border-bottom-width: 2px;
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
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
        bottom: -6px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
        padding: 9px 4px;
        border-top: 1px solid var(--border);
        background: var(--surface);
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

    .footer .primary {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--text);
        font-weight: 600;
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
