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
        GhBranch,
        GhChangedFile,
        GhCommit,
        GhItemKind,
        GhItemView,
        GhContents,
        GhTag,
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

    type Section = 'details' | 'code' | 'releases' | 'git' | 'pulls' | 'issues' | 'runs';
    type CodeView = 'files' | 'commits' | 'branches' | 'tags';

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
    // PR e issues en detalle, y logs de Actions.
    let openItem = $state('');
    let itemView = $state<GhItemView | null>(null);
    let itemComment = $state('');
    let reviewBody = $state('');
    let issueState = $state<'open' | 'closed' | 'all'>('open');
    let openLog = $state(0);
    let runLog = $state('');
    // Código.
    let codeView = $state<CodeView>('files');
    let codeRef = $state('');
    let codePath = $state('');
    let contents = $state<GhContents | null>(null);
    let branchList = $state<GhBranch[]>([]);
    let tagList = $state<GhTag[]>([]);
    let commitList = $state<GhCommit[]>([]);
    let openCommit = $state('');
    let commitFiles = $state<GhChangedFile[]>([]);
    let compareBase = $state('');
    let compareHead = $state('');
    let compareFiles = $state<GhChangedFile[] | null>(null);
    let newBranchName = $state('');
    let newBranchFrom = $state('');
    let deleteBranchName = $state('');
    let deleteBranchConfirm = $state('');

    const sections: { id: Section; label: string }[] = $derived([
        { id: 'details', label: app.t('ghm.tabDetails', 'Detalles') },
        { id: 'code', label: app.t('ghm.tabCode', 'Código') },
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
        } else if (next === 'code') {
            await loadCode(codeView);
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
            issues = (await work(() => issueState === 'open' ? api.githubIssues(fullName) : api.githubIssuesByState(fullName, issueState))) ?? issues;
            openItem = '';
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

    /** Abre (o pliega) una issue o PR con su descripción y comentarios. */
    async function toggleItem(kind: GhItemKind, number: number): Promise<void> {
        const key = `${kind}-${number}`;
        if (openItem === key) {
            openItem = '';
            return;
        }
        const loaded = await work(() => api.githubItemView(fullName, kind, number));
        if (loaded) {
            itemView = loaded;
            openItem = key;
            itemComment = reviewBody = '';
        }
    }

    /** Una acción sobre la issue o PR abierta: vuelve a leerla, y la lista. */
    async function itemChange(kind: GhItemKind, number: number, operation: () => Promise<GhResult>): Promise<void> {
        const result = await work(operation);
        if (!result) return;
        show(result.message, !result.ok);
        if (!result.ok) return;
        itemComment = reviewBody = '';
        const key = `${kind}-${number}`;
        await load(section, true);
        const loaded = await work(() => api.githubItemView(fullName, kind, number));
        if (loaded) {
            itemView = loaded;
            openItem = key;
        }
    }

    async function toggleLog(id: number): Promise<void> {
        if (openLog === id) {
            openLog = 0;
            return;
        }
        const loaded = await work(() => api.githubRunLog(fullName, id));
        if (loaded !== null) {
            runLog = loaded.trim() || app.t('ghm.logEmpty', 'Esta ejecución no tiene pasos fallidos con log.');
            openLog = id;
        }
    }

    async function loadCode(view: CodeView): Promise<void> {
        codeView = view;
        if (!branchList.length) branchList = (await work(() => api.githubCodeBranches(fullName))) ?? [];
        if (!codeRef) codeRef = details?.defaultBranch || branchList[0]?.name || '';
        if (view === 'files') {
            contents = (await work(() => api.githubCodeContents(fullName, codePath, codeRef))) ?? contents;
        } else if (view === 'commits') {
            commitList = (await work(() => api.githubCodeCommits(fullName, codeRef))) ?? commitList;
            openCommit = '';
        } else if (view === 'branches') {
            branchList = (await work(() => api.githubCodeBranches(fullName))) ?? branchList;
        } else {
            tagList = (await work(() => api.githubCodeTags(fullName))) ?? tagList;
        }
    }

    async function openPath(path: string): Promise<void> {
        codePath = path;
        await loadCode('files');
    }

    function parentPath(path: string): string {
        return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    }

    async function toggleCommit(sha: string): Promise<void> {
        if (openCommit === sha) {
            openCommit = '';
            return;
        }
        const loaded = await work(() => api.githubCodeCommitFiles(fullName, sha));
        if (loaded) {
            commitFiles = loaded;
            openCommit = sha;
        }
    }

    async function runCompare(): Promise<void> {
        compareFiles = await work(() => api.githubCodeCompare(fullName, compareBase, compareHead));
    }

    async function createBranch(): Promise<void> {
        const from = newBranchFrom || codeRef;
        const result = await work(() => api.githubCodeBranchCreate(fullName, newBranchName, from));
        if (!result) return;
        show(result.message, !result.ok);
        if (result.ok) {
            newBranchName = '';
            branchList = (await work(() => api.githubCodeBranches(fullName))) ?? branchList;
        }
    }

    async function deleteRemoteBranch(): Promise<void> {
        const result = await work(() => api.githubCodeBranchDelete(fullName, deleteBranchName, deleteBranchConfirm));
        if (!result) return;
        show(result.message, !result.ok);
        if (result.ok) {
            deleteBranchName = deleteBranchConfirm = '';
            branchList = (await work(() => api.githubCodeBranches(fullName))) ?? branchList;
        }
    }

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

{#snippet itemDetail(kind: GhItemKind, number: number, view: GhItemView, draft: boolean)}
    <div class="detail" data-testid="gh-manage-item-detail" data-kind={kind} data-number={number} data-state={view.state}>
        <div class="row">
            <small>{view.state}{view.draft ? ` · ${app.t('ghm.draft', 'Borrador')}` : ''}{view.reviewDecision ? ` · ${view.reviewDecision}` : ''}</small>
            {#each view.labels as label (label)}<span class="label">{label}</span>{/each}
        </div>
        {#if view.body}<pre class="code-view body">{view.body}</pre>{/if}
        {#if view.files.length}
            <details class="diff">
                <summary>{app.t('ghm.prFiles', 'Archivos que cambia')} ({view.files.length})</summary>
                {#each view.files as file (file.path)}
                    <div class="row"><span class="path">{file.path}</span><small>+{file.additions} −{file.deletions}</small></div>
                {/each}
            </details>
        {/if}
        {#each view.comments as comment, index (index)}
            <div class="comment" data-testid="gh-manage-comment">
                <small><strong>{comment.author}</strong> · {comment.createdAt.slice(0, 10)}</small>
                <pre class="code-view body">{comment.body}</pre>
            </div>
        {/each}
        <textarea data-testid="gh-manage-comment-body" bind:value={itemComment} rows="2" placeholder={app.t('ghm.commentPlaceholder', 'Escribe un comentario…')}></textarea>
        <div class="row">
            <button type="button" class="run" data-testid="gh-manage-comment-send" disabled={busy || !itemComment.trim()} onclick={() => itemChange(kind, number, () => api.githubItemComment(fullName, kind, number, itemComment))}>{app.t('ghm.comment', 'Comentar')}</button>
            {#if view.state === 'OPEN'}
                <button type="button" data-testid="gh-manage-item-close" disabled={busy} onclick={() => itemChange(kind, number, () => api.githubItemState(fullName, kind, number, 'close'))}>{app.t('ghm.close', 'Cerrar')}</button>
            {:else if view.state === 'CLOSED'}
                <button type="button" data-testid="gh-manage-item-reopen" disabled={busy} onclick={() => itemChange(kind, number, () => api.githubItemState(fullName, kind, number, 'reopen'))}>{app.t('ghm.reopen', 'Reabrir')}</button>
            {/if}
        </div>
        {#if kind === 'pr' && view.state === 'OPEN'}
            <div class="form" data-testid="gh-manage-review">
                {#if draft}
                    <button type="button" data-testid="gh-manage-pull-ready" disabled={busy} onclick={() => itemChange(kind, number, () => api.githubPullReady(fullName, number))}>{app.t('ghm.ready', 'Marcar como lista para revisar')}</button>
                {/if}
                <textarea data-testid="gh-manage-review-body" bind:value={reviewBody} rows="2" placeholder={app.t('ghm.reviewPlaceholder', 'Comentario de la revisión (obligatorio para pedir cambios)')}></textarea>
                <div class="row">
                    <button type="button" class="run" data-testid="gh-manage-review-approve" disabled={busy} onclick={() => itemChange(kind, number, () => api.githubPullReview(fullName, number, 'approve', reviewBody))}>{app.t('ghm.approve', 'Aprobar')}</button>
                    <button type="button" data-testid="gh-manage-review-changes" disabled={busy || !reviewBody.trim()} onclick={() => itemChange(kind, number, () => api.githubPullReview(fullName, number, 'request-changes', reviewBody))}>{app.t('ghm.requestChanges', 'Pedir cambios')}</button>
                </div>
            </div>
        {/if}
    </div>
{/snippet}

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
    {:else if section === 'code'}
        <div class="row">
            <div class="tabs" role="tablist">
                {#each [['files', app.t('ghm.codeFiles', 'Archivos')], ['commits', app.t('ghm.codeCommits', 'Commits')], ['branches', app.t('ghm.codeBranches', 'Ramas')], ['tags', app.t('ghm.codeTags', 'Etiquetas')]] as [id, label] (id)}
                    <button type="button" role="tab" data-testid={`gh-code-view-${id}`} class:active={codeView === id} aria-selected={codeView === id} disabled={busy} onclick={() => loadCode(id as CodeView)}>{label}</button>
                {/each}
            </div>
            {#if codeView === 'files' || codeView === 'commits'}
                <select data-testid="gh-code-ref" bind:value={codeRef} aria-label={app.t('ghm.codeRef', 'Rama o etiqueta')} disabled={busy} onchange={() => loadCode(codeView)}>
                    {#each branchList as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
                    {#each tagList as tagItem (tagItem.name)}<option value={tagItem.name}>{tagItem.name}</option>{/each}
                </select>
            {/if}
        </div>
        {#if codeView === 'files' && contents}
            <div class="row">
                <span class="path" data-testid="gh-code-path">/{codePath}</span>
                {#if codePath}<button type="button" data-testid="gh-code-up" disabled={busy} onclick={() => openPath(parentPath(codePath))}>↑ {app.t('ghm.codeUp', 'Subir')}</button>{/if}
            </div>
            {#if contents.type === 'dir'}
                {#each contents.entries as entry (entry.path)}
                    <button type="button" class="row item entry" data-testid="gh-code-entry" data-kind={entry.kind} disabled={busy || entry.kind === 'submodule'} onclick={() => openPath(entry.path)}>
                        <span class="path">{entry.kind === 'dir' ? '📁' : '📄'} {entry.name}</span>
                        {#if entry.kind === 'file'}<small>{size(entry.size)}</small>{/if}
                    </button>
                {:else}
                    <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
                {/each}
            {:else}
                {#if contents.text === null}
                    <small>{app.t('ghm.codeBinary', 'Archivo binario: ábrelo en GitHub para verlo.')}</small>
                {:else}
                    <pre class="code-view" data-testid="gh-code-file">{contents.text}</pre>
                    {#if contents.truncated}<small>{app.t('ghm.codeTruncated', 'Archivo grande: se muestra solo el principio.')}</small>{/if}
                {/if}
            {/if}
        {:else if codeView === 'commits'}
            {#each commitList as item (item.sha)}
                <div class="item" data-testid="gh-code-commit" data-sha={item.sha}>
                    <button type="button" class="row entry" disabled={busy} onclick={() => toggleCommit(item.sha)}>
                        <span class="path"><code>{item.sha.slice(0, 7)}</code> {item.message}</span>
                        <small>{item.author} · {item.date.slice(0, 10)}</small>
                    </button>
                    {#if openCommit === item.sha}
                        {#each commitFiles as file (file.filename)}
                            <details class="diff">
                                <summary><span class="path">{file.status} · {file.filename}</span> <small>+{file.additions} −{file.deletions}</small></summary>
                                {#if file.patch}<pre class="code-view">{file.patch}</pre>{/if}
                            </details>
                        {/each}
                    {/if}
                </div>
            {:else}
                <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
            {/each}
            <div class="form">
                <strong>{app.t('ghm.codeCompare', 'Comparar')}</strong>
                <div class="row">
                    <input data-testid="gh-code-compare-base" bind:value={compareBase} placeholder={app.t('ghm.base', 'Hacia la rama')} spellcheck="false" />
                    <input data-testid="gh-code-compare-head" bind:value={compareHead} placeholder={app.t('ghm.head', 'Desde la rama')} spellcheck="false" />
                    <button type="button" data-testid="gh-code-compare" disabled={busy || !compareBase.trim() || !compareHead.trim()} onclick={runCompare}>{app.t('ghm.codeCompare', 'Comparar')}</button>
                </div>
                {#if compareFiles}
                    {#each compareFiles as file (file.filename)}
                        <details class="diff">
                            <summary><span class="path">{file.status} · {file.filename}</span> <small>+{file.additions} −{file.deletions}</small></summary>
                            {#if file.patch}<pre class="code-view">{file.patch}</pre>{/if}
                        </details>
                    {:else}
                        <small>{app.t('ghm.codeNoChanges', 'Sin diferencias.')}</small>
                    {/each}
                {/if}
            </div>
        {:else if codeView === 'branches'}
            <div class="form">
                <div class="row">
                    <input data-testid="gh-code-branch-name" bind:value={newBranchName} placeholder={app.t('ghm.codeNewBranch', 'Nueva rama')} spellcheck="false" />
                    <input data-testid="gh-code-branch-from" bind:value={newBranchFrom} placeholder={`${app.t('ghm.codeFrom', 'Desde')} ${codeRef}`} spellcheck="false" />
                    <button type="button" class="run" data-testid="gh-code-branch-create" disabled={busy || !newBranchName.trim()} onclick={createBranch}>{app.t('projects.ghCreate', 'Crear')}</button>
                </div>
            </div>
            {#each branchList as branch (branch.name)}
                <div class="row item" data-testid="gh-code-branch" data-name={branch.name}>
                    <span class="path">{branch.name}{branch.name === details?.defaultBranch ? ` · ${app.t('ghm.codeDefault', 'por defecto')}` : ''}{branch.protected ? ' · 🔒' : ''}</span>
                    <code>{branch.sha.slice(0, 7)}</code>
                </div>
            {/each}
            <div class="danger-box">
                <strong>{app.t('ghm.codeDeleteBranch', 'Borrar una rama de GitHub')}</strong>
                <div class="row">
                    <input data-testid="gh-code-branch-delete-name" bind:value={deleteBranchName} placeholder={app.t('ghm.codeBranch', 'Rama')} spellcheck="false" />
                    <input data-testid="gh-code-branch-delete-confirm" bind:value={deleteBranchConfirm} placeholder={app.t('ghm.codeConfirm', 'Escribe su nombre para confirmar')} spellcheck="false" />
                    <button type="button" class="danger" data-testid="gh-code-branch-delete" disabled={busy || !deleteBranchName || deleteBranchConfirm !== deleteBranchName} onclick={deleteRemoteBranch}>{app.t('ghm.codeDelete', 'Borrar')}</button>
                </div>
            </div>
        {:else if codeView === 'tags'}
            {#each tagList as tagItem (tagItem.name)}
                <div class="row item" data-testid="gh-code-tag" data-name={tagItem.name}>
                    <span class="path">{tagItem.name}</span>
                    <code>{tagItem.sha.slice(0, 7)}</code>
                </div>
            {:else}
                <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
            {/each}
        {/if}
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
                    <button type="button" data-testid="gh-manage-pull-view" class:active={openItem === `pr-${pull.number}`} disabled={busy} onclick={() => toggleItem('pr', pull.number)}>{app.t('ghm.view', 'Ver')}</button>
                </div>
                {#if openItem === `pr-${pull.number}` && itemView}
                    {@render itemDetail('pr', pull.number, itemView, pull.draft)}
                {/if}
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
        <div class="row">
            <select data-testid="gh-manage-issue-state" bind:value={issueState} disabled={busy} onchange={() => load('issues')} aria-label={app.t('ghm.issueState', 'Qué issues ver')}>
                <option value="open">{app.t('ghm.issuesOpen', 'Abiertas')}</option>
                <option value="closed">{app.t('ghm.issuesClosed', 'Cerradas')}</option>
                <option value="all">{app.t('ghm.issuesAll', 'Todas')}</option>
            </select>
        </div>
        {#each issues as issue (issue.number)}
            <div class="item" data-testid="gh-manage-issue" data-number={issue.number}>
                <div class="row">
                    <span class="path">#{issue.number} {issue.title}</span>
                    {#if issueState === 'open'}
                        <button type="button" data-testid="gh-manage-issue-close" disabled={busy} onclick={() => change(() => api.githubIssueClose(fullName, issue.number))}>{app.t('ghm.closeIssue', 'Cerrar issue')}</button>
                    {/if}
                    <button type="button" data-testid="gh-manage-issue-view" class:active={openItem === `issue-${issue.number}`} disabled={busy} onclick={() => toggleItem('issue', issue.number)}>{app.t('ghm.view', 'Ver')}</button>
                </div>
                {#if openItem === `issue-${issue.number}` && itemView}
                    {@render itemDetail('issue', issue.number, itemView, false)}
                {/if}
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
                    <button type="button" data-testid="gh-manage-run-log" class:active={openLog === run.id} disabled={busy} onclick={() => toggleLog(run.id)}>{app.t('ghm.runLog', 'Ver log')}</button>
                {/if}
                {#if run.status === 'queued' || run.status === 'in_progress'}
                    <button type="button" data-testid="gh-manage-run-cancel" disabled={busy} onclick={() => change(() => api.githubRunCancel(fullName, run.id))}>{app.t('ghm.runCancel', 'Cancelar')}</button>
                {/if}
                {#if openLog === run.id}
                    <pre class="code-view" data-testid="gh-manage-run-log-text">{runLog}</pre>
                {/if}
            </div>
        {:else}
            <small>{app.t('ghm.empty', 'Nada por aquí.')}</small>
        {/each}
    {/if}
</div>

<style>
    .detail {
        display: flex;
        flex-direction: column;
        gap: var(--density-control-gap, 6px);
        margin-top: 4px;
        padding: var(--space-min, 6px);
        border-left: 2px solid var(--accent-soft);
    }
    .detail .body {
        max-height: 220px;
        white-space: pre-wrap;
        font-family: inherit;
    }
    .label {
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--muted);
        font-size: 11px;
    }
    .comment {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .entry {
        width: 100%;
        justify-content: space-between;
        text-align: left;
    }
    .code-view {
        max-height: 360px;
        overflow: auto;
        margin: 0;
        padding: var(--space-min, 6px);
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-alt);
        font-family: var(--terminal-font);
        font-size: 11px;
        white-space: pre;
    }
    .diff summary {
        cursor: pointer;
    }
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
