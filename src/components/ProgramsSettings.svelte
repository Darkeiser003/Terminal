<script lang="ts">
    // Ajustes de los programas de la terminal (22-11, Romen: «añadir ajustes
    // para las aplicaciones de la terminal y no solo para la terminal»). Cada
    // valor se guarda donde lo lee el propio programa (`config/programs.rs`),
    // así vale igual dentro y fuera de WTerminal.
    //
    // 23-11: lo guardado sale al momento (caché) y lo de ahora llega detrás;
    // cada programa en su desplegable, con cuántos ajustes cambiaste; los
    // desplegables enseñan el valor de verdad en vez de «lo que trae el
    // programa», salvo cuando no se sabe cuál es.
    import { onMount } from "svelte";
    import { app } from "../lib/appState.svelte";
    import * as api from "../lib/api";
    import type { ProgramSection, ProgramSetting } from "../lib/types";

    let sections = $state<ProgramSection[]>([]);
    let loading = $state(true);
    /** Se está leyendo lo de ahora sobre lo guardado. */
    let refreshing = $state(false);
    let saving = $state<string | null>(null);
    let error = $state("");
    let opened = $state<Record<string, boolean>>({});

    /** Tras un cambio solo vuelve la sección de ese programa. */
    function merge(updated: ProgramSection[]): void {
        sections = sections.map((section) => updated.find((item) => item.id === section.id) ?? section);
    }

    async function load(): Promise<void> {
        // Lo guardado al momento; lo de ahora, detrás.
        try {
            const cached = await api.cachedProgramSettings();
            if (cached.length > 0) {
                sections = cached;
                loading = false;
            }
        } catch {
            // Sin caché, se espera a la lectura completa.
        }
        refreshing = true;
        try {
            sections = await api.listProgramSettings();
            error = "";
        } catch (cause) {
            error = String(cause);
        } finally {
            loading = false;
            refreshing = false;
        }
    }

    async function save(program: string, setting: ProgramSetting, value: string): Promise<void> {
        saving = `${program}:${setting.id}`;
        try {
            merge(await api.setProgramSetting(program, setting.id, value));
            error = "";
        } catch (cause) {
            error = `${setting.label}: ${String(cause)}`;
        } finally {
            saving = null;
        }
    }

    async function undo(program: string): Promise<void> {
        saving = `${program}:undo`;
        try {
            merge(await api.undoProgramSetting(program));
            error = "";
        } catch (cause) {
            error = String(cause);
        } finally {
            saving = null;
        }
    }

    /** El valor que rige: lo guardado o, si no hay nada, el del programa. */
    function shown(setting: ProgramSetting): string {
        return setting.value || setting.defaultValue;
    }

    /** ¿Se sabe qué valor trae el programa y está entre las opciones? */
    function knownDefault(setting: ProgramSetting): boolean {
        return setting.defaultValue !== ""
            && setting.options.some((option) => option.value === setting.defaultValue);
    }

    function changedCount(section: ProgramSection): number {
        return section.settings.filter((setting) => setting.value !== "").length;
    }

    const available = $derived(sections.filter((section) => section.available));
    const missing = $derived(sections.filter((section) => !section.available));

    onMount(() => {
        void load();
    });
</script>

<section class="programs" data-testid="settings-programs">
    <p class="intro">
        {app.t(
            "settings.programsIntro",
            "Ajustes de los programas que usas en la terminal. Se guardan donde los lee cada programa, así valen también fuera de WTerminal. Solo salen los que están instalados.",
        )}
    </p>
    <label class="check recommended">
        <input
            type="checkbox"
            data-testid="settings-apply-program-defaults"
            checked={app.preferences?.applyProgramDefaults !== false}
            onchange={(event) => app.savePreferences({ applyProgramDefaults: event.currentTarget.checked })}
        />
        <span>
            <strong>{app.t("settings.applyProgramDefaults", "Aplicar los valores recomendados de WTerminal a los programas")}</strong>
            <small>{app.t("settings.applyProgramDefaultsHint", "A cada programa instalado, también si se instala después, una sola vez y sin cambiar lo que ya tuvieras: Git Bash completa sin distinguir mayúsculas, npm sin mensajes de financiación y WinGet sin telemetría.")}</small>
        </span>
    </label>
    {#if refreshing && !loading}
        <p class="muted refreshing" data-testid="settings-programs-refreshing">{app.t("settings.programsRefreshing", "Comprobando los valores actuales…")}</p>
    {/if}
    {#if error}
        <p class="error" role="alert" data-testid="settings-programs-error">{error}</p>
    {/if}
    {#if loading}
        <p class="muted">{app.t("settings.loading", "Cargando preferencias…")}</p>
    {:else}
        {#each available as section (section.id)}
            {@const changed = changedCount(section)}
            <details
                class="program"
                data-testid={`settings-program-${section.id}`}
                bind:open={opened[section.id]}
            >
                <summary>
                    <span class="name">{section.name}</span>
                    {#if changed > 0}
                        <span class="badge">{app.t("settings.programsChanged", "{count} cambiados").replace("{count}", String(changed))}</span>
                    {/if}
                    <span class="chevron" aria-hidden="true">›</span>
                </summary>
                <div class="body">
                    <div class="meta">
                        <small class="source"><span>{app.t("settings.programsSource", "Se guarda en")}</span> <code>{section.source}</code></small>
                        {#if section.note}<small class="note">{section.note}</small>{/if}
                        <button
                            type="button"
                            class="undo"
                            data-testid={`settings-program-undo-${section.id}`}
                            disabled={!section.canUndo || saving !== null}
                            onclick={() => undo(section.id)}
                        >{app.t("settings.programsUndo", "Deshacer el último cambio")}</button>
                    </div>
                    {#each section.settings as setting (setting.id)}
                        {@const busy = saving === `${section.id}:${setting.id}`}
                        <div class="row" class:busy data-testid={`settings-program-${section.id}-${setting.id}`}>
                            {#if setting.kind === "toggle"}
                                <label class="check">
                                    <input
                                        type="checkbox"
                                        checked={shown(setting) === "true"}
                                        disabled={busy}
                                        onchange={(event) => save(section.id, setting, event.currentTarget.checked ? "true" : "false")}
                                    />
                                    <span>
                                        <strong>{setting.label}</strong>
                                        <small>{setting.description}</small>
                                    </span>
                                </label>
                            {:else}
                                <label class="field">
                                    <span>
                                        <strong>{setting.label}</strong>
                                        <small>{setting.description}</small>
                                    </span>
                                    {#if setting.kind === "choice"}
                                        <select
                                            value={setting.value || (knownDefault(setting) ? setting.defaultValue : "")}
                                            disabled={busy}
                                            onchange={(event) => save(section.id, setting, event.currentTarget.value)}
                                        >
                                            {#if !knownDefault(setting) && !setting.options.some((option) => option.value === "")}
                                                <option value="">{app.t("settings.programsDefault", "Lo que trae el programa")}</option>
                                            {/if}
                                            {#each setting.options as option (option.value)}
                                                <option value={option.value}>{option.label}</option>
                                            {/each}
                                        </select>
                                    {:else}
                                        <input
                                            type={setting.kind === "number" ? "number" : "text"}
                                            value={setting.value}
                                            placeholder={setting.defaultValue || app.t("settings.programsDefault", "Lo que trae el programa")}
                                            disabled={busy}
                                            onchange={(event) => save(section.id, setting, event.currentTarget.value)}
                                        />
                                    {/if}
                                </label>
                            {/if}
                        </div>
                    {/each}
                </div>
            </details>
        {/each}
        {#if missing.length > 0}
            <p class="muted missing" data-testid="settings-programs-missing">
                {app.t("settings.programsMissing", "No instalados")}: {missing.map((section) => section.name).join(", ")}
            </p>
        {/if}
    {/if}
</section>

<style>
    .programs {
        display: flex;
        flex-direction: column;
        gap: var(--density-section-gap, 10px);
    }
    .intro,
    .muted {
        color: var(--muted);
        margin: 0;
        line-height: 1.45;
    }
    .refreshing {
        font-size: 0.9em;
    }
    .error {
        color: var(--danger);
        margin: 0;
    }
    .recommended {
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
    }
    .program {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-alt);
        overflow: hidden;
    }
    .program[open] {
        background: var(--surface);
    }
    summary {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        cursor: pointer;
        list-style: none;
        user-select: none;
    }
    summary::-webkit-details-marker {
        display: none;
    }
    summary:hover {
        background: var(--surface-hover);
    }
    .name {
        font-weight: 600;
        flex: 1;
    }
    .badge {
        font-size: 0.8em;
        padding: 1px 8px;
        border-radius: 10px;
        background: var(--accent-soft);
        color: var(--accent);
    }
    .chevron {
        color: var(--muted);
        transition: transform 0.15s ease;
    }
    .program[open] .chevron {
        transform: rotate(90deg);
    }
    .body {
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--border);
    }
    .meta {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 4px 12px;
        align-items: center;
        padding: 10px 12px;
        background: var(--surface-alt);
    }
    .meta .source,
    .meta .note {
        grid-column: 1;
        color: var(--muted);
        line-height: 1.4;
    }
    .meta code {
        font-size: 0.95em;
        word-break: break-all;
    }
    .meta .undo {
        grid-column: 2;
        grid-row: 1 / span 2;
        white-space: nowrap;
    }
    .row {
        padding: 10px 12px;
        border-top: 1px solid var(--border);
    }
    .row.busy {
        opacity: 0.6;
    }
    .field {
        display: grid;
        grid-template-columns: 1fr minmax(180px, 280px);
        gap: 12px;
        align-items: center;
    }
    .field span,
    .check span {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .field small,
    .check small {
        color: var(--muted);
        line-height: 1.4;
    }
    .check {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        cursor: pointer;
    }
    .check input {
        margin-top: 3px;
    }
    .missing {
        font-size: 0.9em;
    }
    @media (max-width: 560px) {
        .field {
            grid-template-columns: 1fr;
        }
        .meta {
            grid-template-columns: 1fr;
        }
        .meta .undo {
            grid-column: 1;
            grid-row: auto;
            justify-self: start;
        }
    }
</style>
