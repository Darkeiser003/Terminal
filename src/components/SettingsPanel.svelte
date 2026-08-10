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
    import type { Preferences, ThemePreset, UpdateStatus } from "../lib/types";
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

    const PLATFORM_NAMES: Record<string, string> = {
        windows: "Windows",
        linux: "Linux",
        macos: "macOS",
    };

    export async function load(): Promise<void> {
        status = "";
        statusError = false;
        section = "appearance";
        // Se piden al backend en vez de reutilizar las que ya hay en memoria:
        // el archivo puede haber cambiado por fuera.
        await app.reloadPreferences();
        draft = app.preferences ? { ...app.preferences } : null;
    }

    /** Elegir un tema no lo aplica: rellena los tres colores del borrador con
     *  su paleta, que es lo que el usuario puede seguir retocando encima. */
    function chooseTheme(theme: ThemePreset): void {
        if (!draft) return;
        draft.themeId = theme.id;
        draft.accentColor = theme.palette.accent;
        draft.fastfetchColor = theme.palette.accent;
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

    async function save(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (!draft || saving) return;
        saving = true;
        try {
            await app.savePreferences(draft);
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

    /** Los perfiles oficiales del catálogo son además los dueños del proyecto,
     *  no solo colaboradores del código. */
    function roleOf(developer: string): string {
        const owners = (app.appInfo?.owners ?? []).map((login) =>
            login.toLowerCase(),
        );
        return owners.includes(developer.toLowerCase())
            ? app.t("settings.roleOwner", "Desarrollador · WinSlim")
            : app.t("settings.roleDeveloper", "Desarrollador");
    }

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
    width={610}
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
                                <option value="normal"
                                    >{app.t(
                                        "settings.fontWeightNormal",
                                        "Normal",
                                    )}</option
                                >
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
                                    "Solo cuando está instalado y el daemon no responde.",
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
                                    "Desactivado mantiene Docker y los demás grupos cerrados.",
                                )}
                            </small>
                        </span>
                    </label>
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
                                {app.t(
                                    "update.upToDate",
                                    "Estás en la versión más reciente.",
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
                        <div class="field-hint">
                            {app
                                .t("update.into", "Se instalará en {path}")
                                .replace("{path}", update.installPath)}
                        </div>
                    {/if}

                    <div class="heading">
                        <strong
                            >{app.t(
                                "settings.developers",
                                "Desarrolladores",
                            )}</strong
                        >
                        <span
                            >{app.t(
                                "settings.developersHint",
                                "Créditos definidos en el catálogo de distribución.",
                            )}</span
                        >
                    </div>
                    <div class="developers">
                        {#each app.appInfo?.developers ?? [] as developer (developer)}
                            <button
                                type="button"
                                class="developer"
                                title={app
                                    .t("settings.openProfile", "Abrir {url}")
                                    .replace(
                                        "{url}",
                                        `https://github.com/${developer}`,
                                    )}
                                onclick={() => api.openInGithub(developer)}
                            >
                                @{developer} · {roleOf(developer)}
                            </button>
                        {:else}
                            <span class="field-hint">
                                {app.t(
                                    "settings.developersPending",
                                    "Pendiente de completar.",
                                )}
                            </span>
                        {/each}
                    </div>

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
                <button type="submit" class="primary" disabled={saving}>
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
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 9px;
    }

    .field {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 3px;
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
        max-width: 320px;
    }

    .field :global(input),
    .field :global(select) {
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        font-size: 11px;
    }

    .field :global(input[type="color"]) {
        height: 26px;
        padding: 2px;
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
