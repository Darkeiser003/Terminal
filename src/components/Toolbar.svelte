<script lang="ts">
    // Barra superior: selector de entorno de la pestaña activa y accesos que la
    // versión Electron tenía en `#toolbar`. Los paneles de scripts, explorador,
    // proyectos y ajustes se añaden en las fases siguientes de la migración.

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import type { Environment } from '../lib/types';

    interface Props {
        /** Se llama cuando el panel de dependencias pasa a estar abierto. La
         *  lista se vuelve a pedir CADA vez, no solo la primera: lo que el
         *  usuario haya instalado desde aquí mientras tanto debe dejar de
         *  ofrecerse como "Instalar" al volver a mirar. */
        onOpenDeps: () => void;
        /** Igual que el de dependencias: las preferencias se releen cada vez
         *  que se abre, porque el archivo puede haber cambiado por fuera. */
        onOpenSettings: () => void;
        /** El escaneo se rehace cada vez que se abre: la carpeta pudo cambiar
         *  desde fuera, y en «Aquí» la pestaña activa puede ser otra. */
        onOpenScripts: () => void;
        /** El estado se relee cada vez: la carpeta de proyectos pudo cambiar y
         *  lo clonado también. */
        onOpenProjects: () => void;
    }

    let { onOpenDeps, onOpenSettings, onOpenScripts, onOpenProjects }: Props = $props();

    /** El botón de Logs abre una carpeta con el gestor del sistema, y eso puede
     *  no existir en un Windows recortado. Sin esto, el clic no hacía nada y no
     *  se decía por qué. */
    let logsError = $state('');

    /** Los entornos agrupados como los pinta el desplegable: un `<optgroup>`
     *  por apartado, en el orden en que llegaron del backend. */
    const grouped = $derived.by(() => {
        const groups = new Map<string, Environment[]>();
        for (const env of app.environments) {
            const list = groups.get(env.group);
            if (list) list.push(env);
            else groups.set(env.group, [env]);
        }
        return [...groups.entries()];
    });

    async function changeEnvironment(event: Event): Promise<void> {
        const select = event.currentTarget as HTMLSelectElement;
        const envId = select.value;
        const tabId = app.activeTabId;
        if (!tabId || !envId) return;
        const ok = await app.switchEnvironment(tabId, envId);
        // Si el backend lo rechaza, el desplegable vuelve al entorno real de la
        // pestaña en vez de quedarse mostrando uno que no se abrió.
        if (!ok) select.value = app.activeTab?.envId ?? '';
    }
</script>

<div class="toolbar">
    <div class="toolbar-group grow">
        <select
            class="env-select"
            value={app.activeTab?.envId ?? ''}
            disabled={!app.environmentsLoaded || !app.activeTabId}
            onchange={changeEnvironment}
            title={app.t('toolbar.environment', 'Entorno de la pestaña activa')}
        >
            {#if !app.environmentsLoaded}
                <option value="">{app.t('env.detecting', 'Detectando entornos…')}</option>
            {/if}
            {#each grouped as [group, envs] (group)}
                <optgroup label={group}>
                    {#each envs as env (env.id)}
                        <!-- Un entorno no disponible se ve pero no se elige: el
                             porqué está en su `note`. -->
                        <option value={env.id} disabled={!env.available} title={env.note ?? env.label}>
                            {env.label}
                        </option>
                    {/each}
                </optgroup>
            {/each}
        </select>

        <button
            type="button"
            class="icon"
            title={app.t('env.refresh', 'Volver a detectar entornos')}
            onclick={() => app.refreshEnvironments()}
        >⟳</button>
    </div>

    <div class="toolbar-group">
        <button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('projects')}
            onclick={() => {
                if (panels.toggle('projects')) onOpenProjects();
            }}
        >
            {app.t('toolbar.projects', 'Proyectos')}
        </button>

        <button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('scripts')}
            onclick={() => {
                if (panels.toggle('scripts')) onOpenScripts();
            }}
        >
            {app.t('toolbar.scripts', 'Scripts')}
        </button>

        <button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('deps')}
            onclick={() => {
                if (panels.toggle('deps')) onOpenDeps();
            }}
        >
            {app.t('toolbar.deps', 'Entorno y dependencias')}
        </button>

        <button
            type="button"
            data-panel-toggle
            class:active={panels.isOpen('settings')}
            onclick={() => {
                if (panels.toggle('settings')) onOpenSettings();
            }}
        >
            {app.t('toolbar.settings', 'Ajustes')}
        </button>

        {#if logsError}
            <span class="notice" role="status">{logsError}</span>
        {/if}
        <button
            type="button"
            onclick={async () => {
                logsError = '';
                // Devuelve la ruta si la abrió, y nada si no pudo.
                const opened = await api.openLogFolder();
                if (!opened) {
                    logsError = app.t(
                        'toolbar.logsFailed',
                        'No se pudo abrir la carpeta de registros.'
                    );
                }
            }}
        >
            {app.t('toolbar.logs', 'Logs')}
        </button>
    </div>
</div>

<style>
    .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding: 0 10px;
        background: var(--surface-alt);
        border-bottom: 1px solid var(--border);
        color: var(--text);
        font-size: 12px;
    }

    /* Los botones no se encogen ni se salen de la ventana: el que cede espacio
       al estrechar la ventana es el selector de entorno. */
    .toolbar-group {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
    }

    /* base 0 (no "auto"): con base automática, el ancho del <select> lo fija su
       opción más larga (los nombres de imagen de Docker son enormes) y la barra
       se salía de la ventana empujando el resto fuera de la pantalla. */
    .toolbar-group.grow {
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
    }

    .env-select {
        flex: 1 1 0;
        min-width: 40px;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
    }

    button {
        padding: 4px 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
    }

    button:hover {
        background: var(--surface-hover);
        border-color: var(--accent);
    }

    /* El botón del panel abierto se queda marcado: con la caja flotando sobre
       la terminal, es lo único que dice de dónde ha salido. */
    button.active {
        background: var(--accent-soft);
        border-color: var(--accent);
    }

    button.icon {
        padding: 4px 8px;
    }

    .notice {
        color: #e06c75;
        font-size: 11px;
    }
</style>
