<script lang="ts">
    // Confirmación de «Restablecer» (13-11, Romen): antes un clic devolvía todo
    // a fábrica sin avisar. Aquí se elige qué apartados, cada uno con lo que
    // hace y su riesgo, y nada viene marcado: «Cancelar» es lo que se enfoca.
    import { onMount } from 'svelte';
    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { dangerousGroups, keysForGroups, RESET_GROUPS, RESET_TABS, tabState, type ResetRisk, type ResetTab } from '../lib/settings-reset';
    import type { ProfileStatus } from '../lib/types';

    let { busy = false, onCancel, onConfirm }: {
        busy?: boolean;
        onCancel: () => void;
        onConfirm: (keys: string[], groups: number) => void;
    } = $props();

    let selected = $state<string[]>([]);
    let cancelButton = $state<HTMLButtonElement | undefined>(undefined);

    const chosen = $derived(new Set(selected));
    const allChosen = $derived(selected.length === RESET_GROUPS.length);
    const dangerous = $derived(dangerousGroups(selected));

    function tabLabel(tab: ResetTab): string {
        if (tab === 'appearance') return app.t('settings.appearance', 'Apariencia');
        if (tab === 'terminal') return app.t('settings.terminal', 'Terminal');
        return app.t('settings.behavior', 'Comportamiento');
    }

    function riskLabel(risk: ResetRisk): string {
        if (risk === 'danger') return app.t('settings.resetDialog.riskDanger', 'Borra cosas tuyas');
        if (risk === 'caution') return app.t('settings.resetDialog.riskCaution', 'Cambia cómo funciona');
        return app.t('settings.resetDialog.riskSafe', 'Solo el aspecto');
    }

    function toggle(id: string): void {
        selected = chosen.has(id) ? selected.filter((item) => item !== id) : [...selected, id];
    }

    function toggleTab(tab: ResetTab): void {
        const ids = RESET_GROUPS.filter((group) => group.tab === tab).map((group) => group.id);
        selected = tabState(tab, chosen) === 'all'
            ? selected.filter((id) => !ids.includes(id))
            : [...new Set([...selected, ...ids])];
    }

    function toggleAll(): void {
        selected = allChosen ? [] : RESET_GROUPS.map((group) => group.id);
    }

    function confirm(): void {
        if (!selected.length || busy) return;
        onConfirm(keysForGroups(selected), selected.length);
    }

    // Los perfiles portables (17-11): restablecer no los toca, y si no hay
    // ninguno se ofrece guardar uno antes, en su carpeta de siempre.
    let profiles = $state<ProfileStatus | null>(null);
    let profileSaving = $state(false);
    let profileError = $state('');
    async function saveProfile(): Promise<void> {
        if (profileSaving) return;
        profileSaving = true;
        profileError = '';
        try {
            const result = await api.saveProfileNow();
            if (!result.ok) profileError = result.error ?? app.t('profileOffer.failed', 'No se pudo guardar el perfil.');
            profiles = await api.profileStatus().catch(() => profiles);
        } catch (cause) {
            profileError = String(cause);
        } finally {
            profileSaving = false;
        }
    }

    onMount(() => cancelButton?.focus());
    onMount(() => {
        void api.profileStatus().then((status) => { profiles = status; }).catch(() => {});
    });
</script>

<!-- `data-panel-toggle`: pulsar dentro no cuenta como «fuera» de Ajustes. -->
<div
    class="reset-backdrop"
    data-panel-toggle
    role="presentation"
    onmousedown={(event) => {
        if (event.target === event.currentTarget) onCancel();
    }}
>
    <div
        class="reset-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settings-reset-title"
        aria-describedby="settings-reset-intro"
        data-testid="settings-reset-dialog"
        tabindex="-1"
        onkeydown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
            }
        }}
    >
        <h2 id="settings-reset-title">{app.t('settings.resetDialog.title', 'Restablecer ajustes')}</h2>
        <p id="settings-reset-intro" class="intro">
            {app.t('settings.resetDialog.intro', 'Marca lo que quieres devolver a como viene de fábrica; lo demás no se toca. Restablecerlo todo deshace todo lo que hayas personalizado: tema, atajos, alias, idioma, la carpeta propia y más. No hay deshacer: si dudas, exporta antes un perfil.')}
        </p>

        {#if profiles}
            <div class="profiles" data-testid="settings-reset-profiles" data-count={profiles.profiles.length}>
                <span>
                    {profiles.profiles.length === 0
                        ? app.t('settings.resetDialog.noProfile', 'No tienes ningún perfil portable guardado: guárdalo antes y podrás volver a como lo tienes ahora con «Importar perfil».')
                        : app.t('settings.resetDialog.profiles', 'Perfiles portables guardados: {count} (el último, {name}). Restablecer no los toca y con «Importar perfil» vuelves a como estaban.')
                              .replace('{count}', String(profiles.profiles.length))
                              .replace('{name}', profiles.profiles[0].name)}
                    <small>{profiles.dir}</small>
                    {#if profileError}<small class="profile-error" role="alert">{profileError}</small>{/if}
                </span>
                <button type="button" class="plain" data-testid="settings-reset-save-profile" disabled={profileSaving} onclick={saveProfile}>
                    {profileSaving ? app.t('profileOffer.saving', 'Guardando…') : app.t('settings.saveProfileNow', 'Guardar perfil ahora')}
                </button>
            </div>
        {/if}

        <div class="tabs">
            {#each RESET_TABS as tab (tab)}
                {@const state = tabState(tab, chosen)}
                <fieldset>
                    <legend>
                        <label>
                            <input
                                type="checkbox"
                                data-testid={`settings-reset-tab-${tab}`}
                                checked={state === 'all'}
                                indeterminate={state === 'some'}
                                onchange={() => toggleTab(tab)}
                            />
                            {tabLabel(tab)}
                        </label>
                    </legend>
                    {#each RESET_GROUPS.filter((group) => group.tab === tab) as group (group.id)}
                        <label class="group" data-risk={group.risk}>
                            <input
                                type="checkbox"
                                data-testid={`settings-reset-group-${group.id}`}
                                checked={chosen.has(group.id)}
                                onchange={() => toggle(group.id)}
                            />
                            <span class="text">
                                <span class="title">
                                    <span>{app.t(`settings.reset.${group.id}`, group.label)}</span>
                                    <span class="risk">{riskLabel(group.risk)}</span>
                                </span>
                                <small>{app.t(`settings.reset.${group.id}Hint`, group.hint)}</small>
                            </span>
                        </label>
                    {/each}
                </fieldset>
            {/each}
        </div>

        {#if dangerous.length}
            <p class="danger-summary" role="alert" data-testid="settings-reset-danger">
                {app.t('settings.resetDialog.dangerSummary', 'Has marcado algo que borra cosas tuyas: {list}.')
                    .replace('{list}', dangerous.map((group) => app.t(`settings.reset.${group.id}`, group.label)).join(', '))}
            </p>
        {/if}

        <div class="buttons">
            <button type="button" class="plain" data-testid="settings-reset-all" onclick={toggleAll}>
                {allChosen ? app.t('settings.resetDialog.none', 'Desmarcar todo') : app.t('settings.resetDialog.all', 'Marcar todo')}
            </button>
            <span class="spacer"></span>
            <button type="button" class="plain" data-testid="settings-reset-cancel" bind:this={cancelButton} onclick={onCancel}>
                {app.t('common.cancel', 'Cancelar')}
            </button>
            <button type="button" class="confirm" data-testid="settings-reset-confirm" disabled={!selected.length || busy} onclick={confirm}>
                {allChosen
                    ? app.t('settings.resetDialog.confirmAll', 'Restablecer todo')
                    : app.t('settings.resetDialog.confirm', 'Restablecer ({count})').replace('{count}', String(selected.length))}
            </button>
        </div>
    </div>
</div>

<style>
    .reset-backdrop {
        position: fixed;
        inset: 0;
        z-index: 80;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 48px 16px 16px;
        background: rgba(0, 0, 0, 0.45);
    }

    .reset-dialog {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: min(620px, 100%);
        max-height: calc(100vh - 64px);
        padding: 14px 16px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
        color: var(--text);
        font-size: 12px;
        outline: none;
    }

    h2 {
        margin: 0;
        font-size: 14px;
    }

    .intro {
        margin: 0;
        color: var(--muted);
    }

    /* Los perfiles portables, antes de las casillas (17-11). */
    .profiles {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px;
        border-left: 2px solid var(--accent);
        background: var(--surface-alt);
    }

    .profiles > span {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .profiles small {
        display: block;
        color: var(--muted);
    }

    .profiles .profile-error {
        color: var(--danger);
    }

    .profiles button {
        flex: 0 0 auto;
    }

    .tabs {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
    }

    fieldset {
        margin: 0;
        padding: 0 0 4px;
        border: 0;
        border-top: 1px solid var(--border);
    }

    legend {
        padding: 6px 0 2px;
        color: var(--muted);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
    }

    legend label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
    }

    .group {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 4px 6px;
        border-left: 2px solid transparent;
        border-radius: 2px;
        cursor: pointer;
    }

    .group:hover {
        background: var(--surface-hover);
    }

    .group[data-risk='danger'] {
        border-left-color: var(--danger);
    }

    .group[data-risk='caution'] {
        border-left-color: var(--warning);
    }

    .group input,
    legend input {
        margin: 2px 0 0;
        accent-color: var(--accent);
    }

    .text {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 1px;
    }

    .title {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 2px 8px;
    }

    .risk {
        color: var(--muted);
        font-size: 10.5px;
    }

    .group[data-risk='danger'] .risk {
        color: var(--danger);
    }

    .group[data-risk='caution'] .risk {
        color: var(--warning);
    }

    small {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
    }

    .danger-summary {
        margin: 0;
        padding: 6px 8px;
        border-left: 2px solid var(--danger);
        color: var(--danger);
    }

    .buttons {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .spacer {
        flex: 1 1 auto;
    }

    button {
        padding: 4px 12px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
        cursor: pointer;
    }

    button:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .plain {
        background: transparent;
    }

    .confirm {
        border-color: var(--danger);
        background: transparent;
        color: var(--danger);
    }

    .confirm:hover:not(:disabled) {
        background: var(--danger);
        color: var(--surface);
    }

    button:disabled {
        opacity: 0.45;
        cursor: default;
    }
</style>
