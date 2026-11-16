<script lang="ts">
    // Áreas de «Gestionar…» que faltaban del diseño del 23-10 (`gh_admin.rs`):
    // el resto de Actions, Configuración, Seguridad, Comunidad y Cuenta. Cada
    // área es una lista con sus acciones; los formularios solo recogen datos,
    // y el backend los valida y los convierte en órdenes `gh` fijas.

    import { untrack } from 'svelte';

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import type { GhAdminAction, GhAdminArea, GhAdminList, GhAdminRow, GitRunResult } from '../lib/types';

    type Group = 'actions' | 'settings' | 'security' | 'community' | 'account';

    let {
        fullName,
        group,
        reload = 0,
        onTerminal,
    }: {
        fullName: string;
        group: Group;
        /** Lo sube el ⟳ de la cabecera de «Gestionar…»: vuelve a leer el área abierta. */
        reload?: number;
        onTerminal: (result: GitRunResult) => Promise<void>;
    } = $props();

    const AREAS: Record<Group, GhAdminArea[]> = {
        actions: ['workflows', 'artifacts', 'secrets', 'variables', 'environments'],
        settings: ['collaborators', 'hooks', 'deployKeys', 'pages', 'protection'],
        security: ['dependabot', 'codeScanning', 'secretScanning'],
        community: ['community'],
        account: ['account', 'sshKeys', 'gpgKeys'],
    };

    function areaLabel(area: GhAdminArea): string {
        const labels: Record<GhAdminArea, [string, string]> = {
            artifacts: ['ghm.areaArtifacts', 'Artefactos'],
            workflows: ['ghm.areaWorkflows', 'Workflows'],
            secrets: ['ghm.areaSecrets', 'Secretos'],
            variables: ['ghm.areaVariables', 'Variables'],
            environments: ['ghm.areaEnvironments', 'Entornos'],
            collaborators: ['ghm.areaCollaborators', 'Colaboradores'],
            hooks: ['ghm.areaHooks', 'Webhooks'],
            deployKeys: ['ghm.areaDeployKeys', 'Claves de despliegue'],
            pages: ['ghm.areaPages', 'Pages'],
            protection: ['ghm.areaProtection', 'Protección de ramas'],
            dependabot: ['ghm.areaDependabot', 'Dependabot'],
            codeScanning: ['ghm.areaCodeScanning', 'Code scanning'],
            secretScanning: ['ghm.areaSecretScanning', 'Secret scanning'],
            community: ['ghm.areaCommunity', 'Comunidad'],
            account: ['ghm.areaAccount', 'Perfil'],
            sshKeys: ['ghm.areaSshKeys', 'Claves SSH'],
            gpgKeys: ['ghm.areaGpgKeys', 'Claves GPG'],
        };
        const [key, fallback] = labels[area];
        return app.t(key, fallback);
    }

    let area = $state<GhAdminArea>('workflows');
    let list = $state<GhAdminList | null>(null);
    let busy = $state(false);
    let message = $state('');
    let messageError = $state(false);
    let needsScope = $state(false);
    let confirming = $state('');

    // Formularios. Secretos y variables tienen los suyos: un valor de secreto
    // a medio escribir nunca aparece en el campo de texto de Variables.
    let secretName = $state('');
    let secretValue = $state('');
    /** El valor del secreto va tapado mientras no se pida verlo. */
    let showSecret = $state(false);
    let variableName = $state('');
    let variableValue = $state('');
    let title = $state('');
    let key = $state('');
    let readOnly = $state(true);
    let login = $state('');
    let hookUrl = $state('');
    let branch = $state('main');
    let pagesPath = $state('/');
    // Protección: se rellena con lo que ya tiene la rama al leerla.
    let requirePullRequest = $state(true);
    let reviews = $state(1);
    let enforceAdmins = $state(false);
    let linearHistory = $state(false);
    let runWorkflow = $state('');
    let runRef = $state('main');
    let runInputs = $state('');

    // `bind:value` de un número da `null` si se vacía el campo.
    const reviewsValid = $derived(Number.isInteger(reviews) && reviews >= 0 && reviews <= 6);

    $effect(() => {
        void group;
        void fullName;
        const first = AREAS[group][0];
        // `untrack`: `open` lee la rama y los formularios; sin él, escribir en
        // ellos volvería a cargar la lista.
        untrack(() => void open(first));
    });

    // ⟳ de la cabecera: vuelve a leer el área abierta sin cambiar de área. La
    // primera vez no hace nada: al montarse ya lee el efecto de arriba.
    let reloadSeen = false;
    $effect(() => {
        void reload;
        if (!reloadSeen) {
            reloadSeen = true;
            return;
        }
        untrack(() => void open(area));
    });

    function say(text: string, error = false): void {
        message = text;
        messageError = error;
    }

    /** Vacía lo escrito en los formularios (no la rama ni las opciones). */
    function clearForms(): void {
        secretName = '';
        secretValue = '';
        showSecret = false;
        variableName = '';
        variableValue = '';
        title = '';
        key = '';
        login = '';
        hookUrl = '';
    }

    /** El formulario de la protección parte de lo que ya tiene la rama: las
     *  filas `reviews`, `enforceAdmins` y `linearHistory` traen el valor tal
     *  cual de la API (vacío si no lo tiene). Sin protección, lo propuesto:
     *  pull request con una aprobación. */
    function fillProtection(loaded: GhAdminList): void {
        if (loaded.rows.length === 0) {
            requirePullRequest = true;
            reviews = 1;
            enforceAdmins = false;
            linearHistory = false;
            return;
        }
        const detail = (id: string) => loaded.rows.find((row) => row.id === id)?.detail ?? '';
        const count = detail('reviews');
        requirePullRequest = count !== '';
        reviews = count === '' ? 1 : Math.min(6, Math.max(0, Math.trunc(Number(count)) || 0));
        enforceAdmins = detail('enforceAdmins') === 'true';
        linearHistory = detail('linearHistory') === 'true';
    }

    /** Cada lectura lleva su número: una respuesta que llega tarde no pisa a
     *  la de una lectura más nueva (otra área, el ⟳ o la recarga tras una
     *  acción). */
    let lastRequest = 0;

    /** Abre un área y lee su lista. `keepMessage`: es la recarga que sigue a
     *  una acción, y no borra su mensaje ni el aviso de permisos que esa
     *  acción acaba de poner. */
    async function open(next: GhAdminArea, keepMessage = false): Promise<void> {
        const request = ++lastRequest;
        // Al cambiar de área se vacían los formularios: nada de lo escrito en
        // una (un secreto a medio escribir) pasa a otra.
        if (next !== area) clearForms();
        area = next;
        confirming = '';
        runWorkflow = '';
        if (!keepMessage) {
            say('');
            needsScope = false;
        }
        busy = true;
        try {
            const loaded = await api.githubAdminList(fullName, next, next === 'protection' ? branch : undefined);
            if (request !== lastRequest) return;
            list = loaded;
            needsScope = keepMessage ? needsScope || loaded.needsAdminScope : loaded.needsAdminScope;
            // Si «Proteger» falló, el formulario se queda como lo dejó el
            // usuario para que pueda corregirlo.
            if (next === 'protection' && !(keepMessage && messageError)) fillProtection(loaded);
        } catch (cause) {
            if (request !== lastRequest) return;
            list = null;
            // Tras una acción, su mensaje sigue delante del error de la recarga.
            say(keepMessage && message ? `${message} ${String(cause)}` : String(cause), true);
        } finally {
            // Solo la última lectura deja el panel libre.
            if (request === lastRequest) busy = false;
        }
    }

    /** Un cambio. `refresh`: vuelve a leer la lista después, con el mensaje y
     *  el aviso de permisos de la acción delante. */
    async function act(action: GhAdminAction, refresh = true): Promise<void> {
        busy = true;
        try {
            const result = await api.githubAdminAction(fullName, action);
            say(result.message, !result.ok);
            needsScope = result.needsAdminScope === true;
            if (result.ok) clearForms();
        } catch (cause) {
            say(String(cause), true);
        } finally {
            busy = false;
            confirming = '';
        }
        if (refresh) await open(area, true);
    }

    /** Borrar pide dos pulsaciones: la primera solo pregunta. */
    function twice(id: string, action: () => Promise<void>): void {
        if (confirming !== id) {
            confirming = id;
            return;
        }
        void action();
    }

    async function grantScopes(): Promise<void> {
        if (!app.activeTabId) return;
        const result = await api.githubCliTerminal(app.activeTabId, 'grant-admin');
        if (result.ok) await onTerminal(result);
        else say(result.error ?? app.t('ghm.grantFailed', 'No se pudo abrir la terminal.'), true);
    }

    async function download(row: GhAdminRow): Promise<void> {
        const dir = await api.pickRepositoryFolder();
        if (!dir) return;
        const [, runId] = row.id.split('|');
        await act({ kind: 'artifactDownload', runId: Number(runId), name: row.title, dir }, false);
    }

    function parseInputs(text: string): [string, string][] {
        return text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const at = line.indexOf('=');
                return (at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : [line, '']) as [string, string];
            });
    }
</script>

<div class="admin" data-testid="gh-admin" data-group={group} data-area={area} aria-busy={busy}>
    {#if AREAS[group].length > 1}
        <div class="tabs" role="tablist">
            {#each AREAS[group] as item (item)}
                <button type="button" role="tab" data-testid={`gh-admin-area-${item}`} aria-selected={area === item} class:active={area === item} disabled={busy} onclick={() => void open(item)}>{areaLabel(item)}</button>
            {/each}
        </div>
    {/if}

    {#if message}
        <div class="message" class:error={messageError} data-testid="gh-admin-status">{message}</div>
    {/if}
    {#if needsScope}
        <div class="message error">
            {app.t('ghm.needsAdminScope', 'GitHub CLI no tiene permiso para esto. Pídelo una vez (se abre una terminal y el navegador):')}
            <button type="button" data-testid="gh-admin-grant" onclick={() => void grantScopes()}>{app.t('ghm.grantAdmin', 'Pedir permisos')}</button>
        </div>
    {/if}

    <!-- Formularios de cada área -->
    {#if area === 'secrets'}
        <!-- Un textarea conserva los saltos de línea de una clave PEM u OpenSSH
             (un campo de contraseña los quita al pegar). Va tapado con
             -webkit-text-security (WebView2 y WebKit) mientras no se pida verlo. -->
        <div class="form column">
            <input data-testid="gh-admin-secret-name" placeholder={app.t('ghm.secretName', 'NOMBRE_DEL_SECRETO')} bind:value={secretName} />
            <textarea data-testid="gh-admin-secret-value" class="secret" class:masked={!showSecret} data-masked={!showSecret} rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder={app.t('ghm.secretValue', 'Valor (no se vuelve a mostrar)')} bind:value={secretValue}></textarea>
            <label class="check"><input type="checkbox" data-testid="gh-admin-secret-show" bind:checked={showSecret} />{app.t('ghm.secretShow', 'Mostrar el valor')}</label>
            <button type="button" data-testid="gh-admin-secret-save" disabled={busy || !secretName || !secretValue} onclick={() => void act({ kind: 'secretSet', name: secretName, value: secretValue })}>{app.t('ghm.save', 'Guardar')}</button>
        </div>
    {:else if area === 'variables'}
        <div class="form">
            <input data-testid="gh-admin-variable-name" placeholder={app.t('ghm.variableName', 'NOMBRE')} bind:value={variableName} />
            <input data-testid="gh-admin-variable-value" placeholder={app.t('ghm.variableValue', 'Valor')} bind:value={variableValue} />
            <button type="button" disabled={busy || !variableName} onclick={() => void act({ kind: 'variableSet', name: variableName, value: variableValue })}>{app.t('ghm.save', 'Guardar')}</button>
        </div>
    {:else if area === 'collaborators'}
        <!-- Los repositorios del panel son de la cuenta personal (`gh repo list`
             sin propietario), y ahí GitHub no mira el permiso: el colaborador
             siempre tiene lectura y escritura. Si el listado llega a traer los
             de una organización, el selector de permisos puede volver para ellos. -->
        <div class="form">
            <input data-testid="gh-admin-collaborator" placeholder={app.t('ghm.collaboratorLogin', 'Usuario de GitHub')} bind:value={login} />
            <button type="button" disabled={busy || !login} onclick={() => void act({ kind: 'collaboratorAdd', login, permission: 'push' })}>{app.t('ghm.invite', 'Invitar')}</button>
        </div>
        <small class="hint" data-testid="gh-admin-collaborator-hint">{app.t('ghm.collaboratorPush', 'En un repositorio de tu cuenta personal, cada colaborador tiene lectura y escritura (push): GitHub no admite permisos más finos.')}</small>
    {:else if area === 'hooks'}
        <div class="form">
            <input data-testid="gh-admin-hook-url" placeholder="https://…" bind:value={hookUrl} />
            <button type="button" data-testid="gh-admin-hook-create" disabled={busy || !hookUrl} onclick={() => void act({ kind: 'hookCreate', url: hookUrl })}>{app.t('ghm.hookCreate', 'Crear webhook (push)')}</button>
        </div>
    {:else if area === 'deployKeys' || area === 'sshKeys'}
        <div class="form column">
            <input placeholder={app.t('ghm.keyTitle', 'Título')} bind:value={title} />
            <textarea rows="2" placeholder="ssh-ed25519 AAAA…" bind:value={key}></textarea>
            {#if area === 'deployKeys'}
                <label class="check"><input type="checkbox" bind:checked={readOnly} />{app.t('ghm.keyReadOnly', 'Solo lectura')}</label>
            {/if}
            <button type="button" disabled={busy || !title || !key} onclick={() => void act(area === 'deployKeys' ? { kind: 'deployKeyAdd', title, key, readOnly } : { kind: 'sshKeyAdd', title, key })}>{app.t('ghm.keyAdd', 'Añadir clave pública')}</button>
        </div>
    {:else if area === 'pages'}
        {#if list?.note}
            <div class="form">
                <input placeholder={app.t('ghm.branch', 'Rama')} bind:value={branch} />
                <select bind:value={pagesPath}><option value="/">/</option><option value="/docs">/docs</option></select>
                <button type="button" disabled={busy || !branch} onclick={() => void act({ kind: 'pagesEnable', branch, path: pagesPath })}>{app.t('ghm.pagesEnable', 'Activar Pages')}</button>
            </div>
        {:else if list}
            <button type="button" class:danger={confirming === 'pages'} disabled={busy} onclick={() => twice('pages', () => act({ kind: 'pagesDisable' }))}>
                {confirming === 'pages' ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.pagesDisable', 'Desactivar Pages')}
            </button>
        {/if}
    {:else if area === 'protection'}
        <div class="form">
            <input data-testid="gh-admin-protection-branch" placeholder={app.t('ghm.branch', 'Rama')} bind:value={branch} />
            <button type="button" disabled={busy || !branch} onclick={() => void open('protection')}>{app.t('ghm.read', 'Leer')}</button>
        </div>
        <div class="form">
            <label class="check"><input type="checkbox" data-testid="gh-admin-protection-pull" bind:checked={requirePullRequest} />{app.t('ghm.requirePullRequest', 'Exigir pull request')}</label>
            <label>{app.t('ghm.reviews', 'Revisiones')} <input type="number" data-testid="gh-admin-protection-reviews" min="0" max="6" disabled={!requirePullRequest} bind:value={reviews} /></label>
            <label class="check"><input type="checkbox" bind:checked={enforceAdmins} />{app.t('ghm.enforceAdmins', 'También administradores')}</label>
            <label class="check"><input type="checkbox" bind:checked={linearHistory} />{app.t('ghm.linearHistory', 'Historial lineal')}</label>
            <button type="button" data-testid="gh-admin-protection-set" disabled={busy || !branch || (requirePullRequest && !reviewsValid)} onclick={() => void act({ kind: 'protectionSet', branch, reviews: requirePullRequest ? reviews : null, enforceAdmins, linearHistory })}>{app.t('ghm.protect', 'Proteger')}</button>
            <button type="button" class:danger={confirming === 'unprotect'} disabled={busy || !branch} onclick={() => twice('unprotect', () => act({ kind: 'protectionRemove', branch }))}>
                {confirming === 'unprotect' ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.unprotect', 'Quitar protección')}
            </button>
        </div>
        <small class="hint">{app.t('ghm.protectKeeps', 'Proteger cambia solo esto: lo demás que ya tenga la rama (comprobaciones obligatorias, CODEOWNERS, restricciones…) se conserva.')}</small>
    {:else if group === 'security'}
        <div class="form">
            <button type="button" disabled={busy} onclick={() => void act({ kind: 'vulnerabilityAlerts', enable: true })}>{app.t('ghm.alertsOn', 'Activar alertas de vulnerabilidades')}</button>
            <button type="button" disabled={busy} onclick={() => void act({ kind: 'vulnerabilityAlerts', enable: false })}>{app.t('ghm.alertsOff', 'Desactivarlas')}</button>
        </div>
    {/if}

    {#if list?.note && !needsScope}
        <small class="note" data-testid="gh-admin-note">{list.note}</small>
    {/if}

    {#each list?.rows ?? [] as row (row.id)}
        <div class="row" data-testid="gh-admin-row" data-id={row.id}>
            <div class="grow">
                {#if row.url}
                    <a href={row.url} target="_blank" rel="noreferrer">{row.title || row.id}</a>
                {:else}
                    <strong>{row.title || row.id}</strong>
                {/if}
                {#if row.detail}<small>{row.detail}</small>{/if}
                {#if row.state}<small class="state">{row.state}</small>{/if}
            </div>
            {#if area === 'artifacts'}
                <button type="button" disabled={busy || row.state === 'expirado'} onclick={() => void download(row)}>{app.t('ghm.download', 'Descargar…')}</button>
                <button type="button" class:danger={confirming === row.id} disabled={busy} onclick={() => twice(row.id, () => act({ kind: 'artifactDelete', id: Number(row.id.split('|')[0]) }))}>{confirming === row.id ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.delete', 'Borrar')}</button>
            {:else if area === 'workflows'}
                <button type="button" data-testid="gh-admin-workflow-run" disabled={busy} onclick={() => (runWorkflow = runWorkflow === row.id ? '' : row.id)}>{app.t('ghm.workflowRun', 'Lanzar…')}</button>
                <button type="button" disabled={busy} onclick={() => void act({ kind: 'workflowEnable', workflow: Number(row.id), enable: row.state !== 'active' })}>{row.state === 'active' ? app.t('ghm.disable', 'Desactivar') : app.t('ghm.enable', 'Activar')}</button>
            {:else if area === 'secrets' || area === 'variables'}
                <button type="button" class:danger={confirming === row.id} disabled={busy} onclick={() => twice(row.id, () => act(area === 'secrets' ? { kind: 'secretDelete', name: row.id } : { kind: 'variableDelete', name: row.id }))}>{confirming === row.id ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.delete', 'Borrar')}</button>
            {:else if area === 'collaborators'}
                <button type="button" class:danger={confirming === row.id} disabled={busy} onclick={() => twice(row.id, () => act({ kind: 'collaboratorRemove', login: row.id }))}>{confirming === row.id ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.remove', 'Quitar')}</button>
            {:else if area === 'hooks'}
                <button type="button" disabled={busy} onclick={() => void act({ kind: 'hookPing', id: Number(row.id) }, false)}>Ping</button>
                <button type="button" class:danger={confirming === row.id} disabled={busy} onclick={() => twice(row.id, () => act({ kind: 'hookDelete', id: Number(row.id) }))}>{confirming === row.id ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.delete', 'Borrar')}</button>
            {:else if area === 'deployKeys' || area === 'sshKeys'}
                <button type="button" class:danger={confirming === row.id} disabled={busy} onclick={() => twice(row.id, () => act(area === 'deployKeys' ? { kind: 'deployKeyDelete', id: Number(row.id) } : { kind: 'sshKeyDelete', id: Number(row.id) }))}>{confirming === row.id ? app.t('ghm.confirmAgain', '¿Seguro? Pulsa otra vez') : app.t('ghm.delete', 'Borrar')}</button>
            {/if}
        </div>
        {#if area === 'workflows' && runWorkflow === row.id}
            <div class="form column" data-testid="gh-admin-workflow-form">
                <input placeholder={app.t('ghm.branch', 'Rama')} bind:value={runRef} />
                <textarea rows="3" placeholder={app.t('ghm.workflowInputs', 'Entradas, una por línea: nombre=valor')} bind:value={runInputs}></textarea>
                <button type="button" disabled={busy || !runRef} onclick={() => void act({ kind: 'workflowRun', workflow: Number(row.id), gitRef: runRef, inputs: parseInputs(runInputs) }, false)}>{app.t('ghm.workflowLaunch', 'Lanzar')}</button>
            </div>
        {/if}
    {:else}
        {#if list && !list.note}
            <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
        {/if}
    {/each}
</div>

<style>
    .admin {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .tabs,
    .form,
    .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }

    .form.column {
        flex-direction: column;
        align-items: stretch;
    }

    .row {
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
    }

    .grow {
        flex: 1 1 200px;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow-wrap: anywhere;
    }

    small {
        color: var(--text-muted, #9a9a9a);
    }

    .state {
        color: var(--accent);
    }

    .note {
        color: var(--warning, #e0a030);
    }

    /* El valor del secreto, tapado como un campo de contraseña pero con sus
       saltos de línea. El texto de ayuda se ve tal cual. */
    textarea.secret {
        font-family: var(--terminal-font, monospace);
    }

    textarea.masked {
        -webkit-text-security: disc;
    }

    textarea.masked::placeholder {
        -webkit-text-security: none;
    }

    .message {
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
    }

    .message.error {
        border-color: var(--warning, #e0a030);
    }

    .tabs button.active {
        background: var(--accent-soft);
        border-color: var(--accent);
    }

    button.danger {
        border-color: var(--danger, #f14c4c);
    }

    .check {
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }

    input,
    textarea,
    select {
        min-width: 0;
        flex: 1 1 140px;
    }
</style>
