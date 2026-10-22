<script lang="ts">
    /**
     * «Gestionar…» de un repositorio de «Mi GitHub»: detalles, releases, git
     * en la copia local, pull requests, issues y Actions. Todo pasa por el
     * backend (`gh_manage.rs`, `git_local.rs`), que solo actúa sobre
     * repositorios del listado de la cuenta; lo que puede pedir credenciales
     * (push, pull, publicar rama) va a una pestaña visible.
     */
    import { untrack } from 'svelte';
    import { app } from '../lib/appState.svelte';
    import * as api from '../lib/api';
    import type {
        GhAsset,
        GhIssue,
        GhMergeMethod,
        GhPull,
        GhRelease,
        GhRepoDetails,
        GhResult,
        GhRun,
        GitRunResult,
        GitTerminalAction,
        LocalGitStatus,
    } from '../lib/types';

    type Section = 'details' | 'releases' | 'git' | 'pulls' | 'issues' | 'runs';

    let {
        fullName,
        cloned,
        onClose,
        onTerminal,
    }: {
        fullName: string;
        cloned: boolean;
        onClose: () => void;
        onTerminal: (result: GitRunResult) => Promise<void>;
    } = $props();

    let section = $state<Section>('details');
    let busy = $state(false);
    let message = $state('');
    let messageError = $state(false);

    // Detalles.
    let details = $state<GhRepoDetails | null>(null);
    let topicsText = $state('');
    // Releases.
    let releases = $state<GhRelease[]>([]);
    let assetsOf = $state('');
    let assets = $state<GhAsset[]>([]);
    let newRelease = $state(false);
    let tag = $state('');
    let releaseTitle = $state('');
    let notes = $state('');
    let generateNotes = $state(false);
    let draft = $state(false);
    let prerelease = $state(false);
    let target = $state('');
    let files = $state<string[]>([]);
    let filePath = $state('');
    let deleteTag = $state('');
    let deleteConfirm = $state('');
    let cleanupTag = $state(false);
    // Git local.
    let git = $state<LocalGitStatus | null>(null);
    let commitMessage = $state('');
    let branchName = $state('');
    // Pull requests.
    let pulls = $state<GhPull[]>([]);
    let newPull = $state(false);
    let head = $state('');
    let base = $state('');
    let pullTitle = $state('');
    let pullBody = $state('');
    let pullDraft = $state(false);
    let mergeMethod = $state<GhMergeMethod>('squash');
    let deleteBranch = $state(true);
    // Issues y Actions.
    let issues = $state<GhIssue[]>([]);
    let issueTitle = $state('');
    let issueBody = $state('');
    let runs = $state<GhRun[]>([]);

    const sections: { id: Section; label: string }[] = $derived([
        { id: 'details', label: app.t('ghm.tabDetails', 'Detalles') },
        { id: 'releases', label: app.t('ghm.tabReleases', 'Releases') },
        { id: 'git', label: app.t('ghm.tabGit', 'Git') },
        { id: 'pulls', label: app.t('ghm.tabPulls', 'Pull requests') },
        { id: 'issues', label: app.t('ghm.tabIssues', 'Issues') },
        { id: 'runs', label: app.t('ghm.tabRuns', 'Actions') },
    ]);

    function show(text: string, error = false): void {
        message = text;
        messageError = error;
    }

    /** Una consulta o una acción, con el panel ocupado mientras dura. */
    async function work<T>(operation: () => Promise<T>): Promise<T | null> {
        if (busy) return null;
        busy = true;
        try {
            return await operation();
        } catch (cause) {
            show(String(cause), true);
            return null;
        } finally {
            busy = false;
        }
    }

    /** Una acción que devuelve `GhResult`: enseña su mensaje y, si fue bien,
     *  vuelve a leer la sección. */
    async function change(operation: () => Promise<GhResult>): Promise<boolean> {
        const result = await work(operation);
        if (!result) return false;
        show(result.message, !result.ok);
        if (result.ok) await load(section, true);
        return result.ok;
    }

    async function load(next: Section, keepMessage = false): Promise<void> {
        section = next;
        if (!keepMessage) show('');
        if (next === 'details') {
            const loaded = await work(() => api.githubRepoDetails(fullName));
            if (loaded) {
                details = loaded;
                topicsText = loaded.topics.join(', ');
            }
        } else if (next === 'releases') {
            releases = (await work(() => api.githubReleases(fullName))) ?? releases;
            assetsOf = '';
        } else if (next === 'git') {
            if (!cloned) return;
            git = (await work(() => api.gitLocalStatus(fullName))) ?? git;
            if (git && !head) head = git.branch;
        } else if (next === 'pulls') {
            pulls = (await work(() => api.githubPulls(fullName))) ?? pulls;
        } else if (next === 'issues') {
            issues = (await work(() => api.githubIssues(fullName))) ?? issues;
        } else {
            runs = (await work(() => api.githubRuns(fullName))) ?? runs;
        }
    }

    // Se lee al abrirse y al cambiar de repositorio. `untrack`: `load` lee
    // estado (`busy`, `section`…) y, sin él, cada cambio volvería a cargar.
    $effect(() => {
        void fullName;
        untrack(() => void load('details'));
    });

    async function saveDetails(): Promise<void> {
        if (!details) return;
        const topics = topicsText.split(',').map((topic) => topic.trim()).filter(Boolean);
        await change(() => api.githubRepoEdit(fullName, { ...details!, topics, currentTopics: details!.topics }));
    }

    async function showAssets(release: GhRelease): Promise<void> {
        if (assetsOf === release.tag) {
            assetsOf = '';
            return;
        }
        const loaded = await work(() => api.githubReleaseAssets(fullName, release.tag));
        if (loaded) {
            assets = loaded;
            assetsOf = release.tag;
        }
    }

    function addFiles(paths: string[]): void {
        files = [...new Set([...files, ...paths.map((path) => path.trim()).filter(Boolean)])];
    }

    async function pickFiles(): Promise<void> {
        addFiles(await api.pickReleaseFiles());
    }

    async function createRelease(): Promise<void> {
        const ok = await change(() =>
            api.githubReleaseCreate(fullName, {
                tag, title: releaseTitle, notes, generateNotes, draft, prerelease, target, files,
            })
        );
        if (ok) {
            newRelease = false;
            tag = releaseTitle = notes = target = '';
            files = [];
            generateNotes = draft = prerelease = false;
        }
    }

    async function uploadTo(release: GhRelease): Promise<void> {
        const picked = await api.pickReleaseFiles();
        if (picked.length) await change(() => api.githubReleaseUpload(fullName, release.tag, picked));
    }

    async function deleteRelease(): Promise<void> {
        const ok = await change(() => api.githubReleaseDelete(fullName, deleteTag, deleteConfirm, cleanupTag));
        if (ok) deleteTag = deleteConfirm = '';
    }

    async function gitTerminal(action: GitTerminalAction): Promise<void> {
        if (!app.activeTabId) return;
        const result = await work(() => api.githubGitTerminal(app.activeTabId!, fullName, action));
        if (!result) return;
        if (!result.ok) {
            show(result.error ?? app.t('projects.failed', 'No se pudo completar la acción.'), true);
            return;
        }
        await onTerminal(result);
    }

    async function commit(): Promise<void> {
        if (await change(() => api.gitLocalCommit(fullName, commitMessage))) commitMessage = '';
    }

    async function createPull(): Promise<void> {
        const ok = await change(() => api.githubPullCreate(fullName, head, base || details?.defaultBranch || 'main', pullTitle, pullBody, pullDraft));
        if (ok) {
            newPull = false;
            pullTitle = pullBody = '';
        }
    }

    async function createIssue(): Promise<void> {
        if (await change(() => api.githubIssueCreate(fullName, issueTitle, issueBody))) issueTitle = issueBody = '';
    }

    function size(bytes: number): string {
        if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${bytes} B`;
    }
</script>

<div class="manage" data-testid="gh-manage" data-full-name={fullName} data-section={section} aria-busy={busy}>
    <div class="manage-head">
        <div class="tabs" role="tablist">
            {#each sections as tab (tab.id)}
                <button
                    type="button"
                    role="tab"
                    data-testid={`gh-manage-tab-${tab.id}`}
                    aria-selected={section === tab.id}
                    class:active={section === tab.id}
                    disabled={busy}
                    onclick={() => load(tab.id)}
                >{tab.label}</button>
            {/each}
        </div>
        <button type="button" class="icon" data-testid="gh-manage-refresh" title={app.t('ghm.refresh', 'Volver a leer')} disabled={busy} onclick={() => load(section)}>⟳</button>
        <button type="button" class="icon" data-testid="gh-manage-close" title={app.t('common.close', 'Cerrar')} onclick={onClose}>✕</button>
    </div>

    {#if message}
        <div class="message" class:error={messageError} data-testid="gh-manage-status" data-error={messageError}>{message}</div>
    {/if}

    {#if section === 'details' && details}
        <label class="field">{app.t('ghm.description', 'Descripción')}
            <input data-testid="gh-manage-description" bind:value={details.description} maxlength="350" />
        </label>
        <label class="field">{app.t('ghm.homepage', 'Web')}
            <input data-testid="gh-manage-homepage" bind:value={details.homepage} placeholder="https://" spellcheck="false" />
        </label>
        <label class="field">{app.t('ghm.topics', 'Temas (separados por comas)')}
            <input data-testid="gh-manage-topics" bind:value={topicsText} spellcheck="false" />
        </label>
        <label class="field">{app.t('ghm.defaultBranch', 'Rama por defecto')}
            <input data-testid="gh-manage-default-branch" bind:value={details.defaultBranch} spellcheck="false" />
        </label>
        <div class="row">
            <label class="check"><input data-testid="gh-manage-issues" type="checkbox" bind:checked={details.issues} /> {app.t('ghm.issues', 'Issues activadas')}</label>
            <label class="check"><input data-testid="gh-manage-wiki" type="checkbox" bind:checked={details.wiki} /> {app.t('ghm.wiki', 'Wiki activada')}</label>
        </div>
        <div class="row">
            <button type="button" class="run" data-testid="gh-manage-save" disabled={busy} onclick={saveDetails}>{app.t('ghm.save', 'Guardar cambios')}</button>
        </div>
    {:else if section === 'releases'}
        <div class="row">
            <button type="button" data-testid="gh-manage-release-new" class:active={newRelease} onclick={() => (newRelease = !newRelease)}>{app.t('ghm.newRelease', 'Nueva release')}</button>
        </div>
        {#if newRelease}
            <div class="form" data-testid="gh-manage-release-form">
                <input data-testid="gh-manage-release-tag" bind:value={tag} placeholder={app.t('ghm.tag', 'Etiqueta (p. ej. v1.2.0)')} spellcheck="false" />
                <input data-testid="gh-manage-release-title" bind:value={releaseTitle} placeholder={app.t('ghm.title', 'Título')} />
                <textarea data-testid="gh-manage-release-notes" bind:value={notes} rows="3" placeholder={app.t('ghm.notes', 'Notas')}></textarea>
                <div class="row">
                    <label class="check"><input data-testid="gh-manage-release-generate" type="checkbox" bind:checked={generateNotes} /> {app.t('ghm.generateNotes', 'Generar notas automáticas')}</label>
                    <label class="check"><input data-testid="gh-manage-release-draft" type="checkbox" bind:checked={draft} /> {app.t('ghm.draft', 'Borrador')}</label>
                    <label class="check"><input type="checkbox" bind:checked={prerelease} /> {app.t('ghm.prerelease', 'Prerelease')}</label>
                </div>
                <input data-testid="gh-manage-release-target" bind:value={target} placeholder={app.t('ghm.target', 'Rama de destino (opcional)')} spellcheck="false" />
                <div class="row">
                    <strong>{app.t('ghm.files', 'Adjuntos')}</strong>
                    <button type="button" data-testid="gh-manage-release-pick" onclick={pickFiles}>{app.t('ghm.pickFiles', 'Elegir archivos…')}</button>
                </div>
                <div class="row">
                    <input data-testid="gh-manage-release-file-input" bind:value={filePath} placeholder={app.t('ghm.filePath', 'O pega una ruta')} spellcheck="false" />
                    <button type="button" data-testid="gh-manage-release-file-add" disabled={!filePath.trim()} onclick={() => { addFiles([filePath]); filePath = ''; }}>{app.t('ghm.addFile', 'Añadir')}</button>
                </div>
                {#each files as file (file)}
                    <div class="row small" data-testid="gh-manage-release-file">
                        <span class="path" title={file}>{file}</span>
                        <button type="button" class="icon" title={app.t('common.close', 'Cerrar')} onclick={() => (files = files.filter((other) => other !== file))}>✕</button>
                    </div>
                {/each}
                <div class="row">
                    <button type="button" class="run" data-testid="gh-manage-release-create" disabled={busy || !tag.trim()} onclick={createRelease}>{app.t('projects.ghCreate', 'Crear')}</button>
                </div>
            </div>
        {/if}
        {#each releases as release (release.tag)}
            <div class="item" data-testid="gh-manage-release" data-tag={release.tag}>
                <div class="row">
                    <strong>{release.tag}</strong>
                    <small>{release.name !== release.tag ? release.name : ''}
                        {release.draft ? ` · ${app.t('ghm.draft', 'Borrador')}` : ''}{release.prerelease ? ' · Prerelease' : ''}{release.latest ? ` · ${app.t('ghm.latest', 'Última')}` : ''}</small>
                </div>
                <div class="row">
                    <button type="button" data-testid="gh-manage-release-assets" class:active={assetsOf === release.tag} disabled={busy} onclick={() => showAssets(release)}>{app.t('ghm.files', 'Adjuntos')}</button>
                    <button type="button" data-testid="gh-manage-release-upload" disabled={busy} onclick={() => uploadTo(release)}>{app.t('ghm.upload', 'Subir adjuntos…')}</button>
                    {#if release.draft}
                        <button type="button" data-testid="gh-manage-release-publish" disabled={busy} onclick={() => change(() => api.githubReleasePublish(fullName, release.tag))}>{app.t('ghm.publish', 'Publicar')}</button>
                    {/if}
                    <button type="button" class="danger" data-testid="gh-manage-release-delete" onclick={() => { deleteTag = release.tag; deleteConfirm = ''; }}>{app.t('projects.ghDelete', 'Borrar…')}</button>
                </div>
                {#if assetsOf === release.tag}
                    {#each assets as asset (asset.name)}
                        <div class="row small" data-testid="gh-manage-asset" data-asset={asset.name}>
                            <span class="path">{asset.name} · {size(asset.size)}</span>
                            <button type="button" class="icon danger" data-testid="gh-manage-asset-delete" title={app.t('projects.ghDelete', 'Borrar…')} disabled={busy} onclick={() => change(() => api.githubReleaseDeleteAsset(fullName, release.tag, asset.name))}>✕</button>
                        </div>
                    {:else}
                        <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
                    {/each}
                {/if}
                {#if deleteTag === release.tag}
                    <div class="form danger-box">
                        <small>{app.t('ghm.deleteReleaseHint', 'Escribe {tag} para borrarla.').replace('{tag}', release.tag)}</small>
                        <input data-testid="gh-manage-release-delete-input" bind:value={deleteConfirm} spellcheck="false" />
                        <label class="check"><input type="checkbox" bind:checked={cleanupTag} /> {app.t('ghm.cleanupTag', 'Borrar también la etiqueta')}</label>
                        <div class="row">
                            <button type="button" class="danger" data-testid="gh-manage-release-delete-confirm" disabled={busy || deleteConfirm.trim() !== release.tag} onclick={deleteRelease}>{app.t('projects.ghDeleteForever', 'Borrar definitivamente')}</button>
                            <button type="button" onclick={() => (deleteTag = '')}>{app.t('common.cancel', 'Cancelar')}</button>
                        </div>
                    </div>
                {/if}
            </div>
        {:else}
            <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
        {/each}
    {:else if section === 'git'}
        {#if !cloned}
            <small data-testid="gh-manage-git-not-cloned">{app.t('ghm.notCloned', 'Clónalo para hacer commits y ramas desde aquí.')}</small>
        {:else if git}
            <div class="row" data-testid="gh-manage-git-branch">
                <strong>{app.t('ghm.branch', 'Rama')}: {git.branch}</strong>
                {#if git.upstream}<small>{git.upstream} · ↑{git.ahead} ↓{git.behind}</small>{/if}
            </div>
            <div class="row">
                <button type="button" data-testid="gh-manage-git-pull" disabled={busy} onclick={() => gitTerminal('pull')}>{app.t('ghm.pull', 'Traer (pull)')}</button>
                <button type="button" data-testid="gh-manage-git-push" disabled={busy} onclick={() => gitTerminal('push')}>{app.t('ghm.push', 'Subir (push)')}</button>
                {#if !git.upstream}
                    <button type="button" data-testid="gh-manage-git-publish" disabled={busy} onclick={() => gitTerminal('publish')}>{app.t('ghm.publishBranch', 'Publicar rama')}</button>
                {/if}
            </div>
            <small>{git.files.length ? app.t('ghm.changes', '{count} cambios').replace('{count}', String(git.files.length) + (git.truncated ? '+' : '')) : app.t('ghm.noChanges', 'Sin cambios.')}</small>
            {#each git.files as file (`${file.code}-${file.path}`)}
                <div class="row small"><code>{file.code}</code><span class="path">{file.path}</span></div>
            {/each}
            {#if git.files.length}
                <textarea data-testid="gh-manage-commit-message" bind:value={commitMessage} rows="2" placeholder={app.t('ghm.commitMessage', 'Mensaje del commit')}></textarea>
                <div class="row">
                    <button type="button" class="run" data-testid="gh-manage-commit" disabled={busy || !commitMessage.trim()} onclick={commit}>{app.t('ghm.commit', 'Commit de todo')}</button>
                </div>
            {/if}
            <strong>{app.t('ghm.branch', 'Rama')}</strong>
            {#each git.branches as branch (branch)}
                <div class="row small" data-testid="gh-manage-branch" data-branch={branch}>
                    <span class="path">{branch === git.branch ? `● ${branch}` : branch}</span>
                    {#if branch !== git.branch}
                        <button type="button" data-testid="gh-manage-branch-switch" disabled={busy} onclick={() => change(() => api.gitLocalBranch(fullName, 'switch', branch))}>{app.t('ghm.switch', 'Cambiar')}</button>
                        <button type="button" class="icon danger" data-testid="gh-manage-branch-delete" title={app.t('projects.ghDelete', 'Borrar…')} disabled={busy} onclick={() => change(() => api.gitLocalBranch(fullName, 'delete', branch))}>✕</button>
                    {/if}
                </div>
            {/each}
            <div class="row">
                <input data-testid="gh-manage-branch-name" bind:value={branchName} placeholder={app.t('ghm.newBranch', 'Nueva rama')} spellcheck="false" />
                <button type="button" data-testid="gh-manage-branch-create" disabled={busy || !branchName.trim()} onclick={async () => { if (await change(() => api.gitLocalBranch(fullName, 'create', branchName))) branchName = ''; }}>{app.t('projects.ghCreate', 'Crear')}</button>
            </div>
        {/if}
    {:else if section === 'pulls'}
        <div class="row">
            <button type="button" data-testid="gh-manage-pull-new" class:active={newPull} onclick={() => (newPull = !newPull)}>{app.t('ghm.newPull', 'Nueva pull request')}</button>
        </div>
        {#if newPull}
            <div class="form" data-testid="gh-manage-pull-form">
                <input data-testid="gh-manage-pull-head" bind:value={head} placeholder={app.t('ghm.head', 'Desde la rama')} spellcheck="false" />
                <input data-testid="gh-manage-pull-base" bind:value={base} placeholder={`${app.t('ghm.base', 'Hacia la rama')} (${details?.defaultBranch || 'main'})`} spellcheck="false" />
                <input data-testid="gh-manage-pull-title" bind:value={pullTitle} placeholder={app.t('ghm.title', 'Título')} />
                <textarea data-testid="gh-manage-pull-body" bind:value={pullBody} rows="3" placeholder={app.t('ghm.description', 'Descripción')}></textarea>
                <label class="check"><input type="checkbox" bind:checked={pullDraft} /> {app.t('ghm.draft', 'Borrador')}</label>
                <div class="row">
                    <button type="button" class="run" data-testid="gh-manage-pull-create" disabled={busy || !head.trim() || !pullTitle.trim()} onclick={createPull}>{app.t('projects.ghCreate', 'Crear')}</button>
                </div>
            </div>
        {/if}
        <div class="row">
            <select data-testid="gh-manage-merge-method" bind:value={mergeMethod} aria-label={app.t('ghm.merge', 'Fusionar')}>
                <option value="squash">Squash</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
            </select>
            <label class="check"><input type="checkbox" bind:checked={deleteBranch} /> {app.t('ghm.deleteBranch', 'Borrar la rama al fusionar')}</label>
        </div>
        {#each pulls as pull (pull.number)}
            <div class="item" data-testid="gh-manage-pull" data-number={pull.number}>
                <div class="row">
                    <strong>#{pull.number} {pull.title}</strong>
                    <small>{pull.head} → {pull.base}{pull.draft ? ` · ${app.t('ghm.draft', 'Borrador')}` : ''}</small>
                </div>
                <div class="row">
                    <button type="button" class="run" data-testid="gh-manage-pull-merge" disabled={busy || pull.draft} onclick={() => change(() => api.githubPullMerge(fullName, pull.number, mergeMethod, deleteBranch))}>{app.t('ghm.merge', 'Fusionar')}</button>
                </div>
            </div>
        {:else}
            <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
        {/each}
    {:else if section === 'issues'}
        <div class="form">
            <input data-testid="gh-manage-issue-title" bind:value={issueTitle} placeholder={app.t('ghm.title', 'Título')} />
            <textarea data-testid="gh-manage-issue-body" bind:value={issueBody} rows="2" placeholder={app.t('ghm.description', 'Descripción')}></textarea>
            <div class="row">
                <button type="button" class="run" data-testid="gh-manage-issue-create" disabled={busy || !issueTitle.trim()} onclick={createIssue}>{app.t('ghm.newIssue', 'Nueva issue')}</button>
            </div>
        </div>
        {#each issues as issue (issue.number)}
            <div class="row item" data-testid="gh-manage-issue" data-number={issue.number}>
                <span class="path">#{issue.number} {issue.title}</span>
                <button type="button" data-testid="gh-manage-issue-close" disabled={busy} onclick={() => change(() => api.githubIssueClose(fullName, issue.number))}>{app.t('ghm.closeIssue', 'Cerrar issue')}</button>
            </div>
        {:else}
            <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
        {/each}
    {:else if section === 'runs'}
        {#each runs as run (run.id)}
            <div class="row item" data-testid="gh-manage-run" data-id={run.id} data-conclusion={run.conclusion}>
                <span class="path">{run.conclusion === 'success' ? '✔' : run.conclusion === 'failure' ? '✘' : run.status === 'completed' ? '•' : '…'} {run.workflow} · {run.title} · {run.branch}</span>
                {#if run.conclusion === 'failure' || run.conclusion === 'cancelled'}
                    <button type="button" data-testid="gh-manage-run-rerun" disabled={busy} onclick={() => change(() => api.githubRunRerun(fullName, run.id))}>{app.t('ghm.rerun', 'Relanzar lo que falló')}</button>
                {/if}
            </div>
        {:else}
            <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
        {/each}
    {/if}
</div>

<style>
    .manage {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 6px;
        padding: 8px;
        border: 1px solid var(--accent);
        border-radius: 5px;
        background: var(--surface-alt);
        font-size: 11px;
    }

    .manage-head,
    .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }

    .tabs {
        display: flex;
        flex: 1 1 auto;
        flex-wrap: wrap;
        gap: 4px;
    }

    .form {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .item {
        padding: 5px 0;
        border-top: 1px solid var(--border);
    }

    .small {
        font-size: 10px;
    }

    .path {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .check {
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }

    .message {
        color: var(--text-muted);
    }

    .message.error {
        color: var(--danger);
    }

    .danger-box {
        padding: 6px;
        border: 1px solid var(--danger);
        border-radius: 4px;
    }

    input,
    textarea,
    select {
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
    }

    .row input {
        flex: 1 1 140px;
    }

    button {
        padding: 3px 9px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        color: var(--text);
        font: inherit;
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

    button.active {
        border-color: var(--accent);
        color: var(--accent);
    }

    button.run {
        border-color: var(--accent);
    }

    button.danger {
        border-color: var(--danger);
        color: var(--danger);
    }

    button.icon {
        padding: 2px 6px;
    }
</style>
