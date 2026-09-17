<script lang="ts">
    let activeTab = $state(0);
    let command = $state('');
    let output = $state<string[]>([
        'LTerminal — vista previa del frontend',
        'Esta página funciona en el navegador sin backend Tauri.',
        '',
        'demo@lterminal:~$ ',
    ]);

    const tabs = ['fish', 'bash', 'PowerShell'];

    function submit(): void {
        const value = command.trim();
        if (!value) return;
        output = [...output, `demo@lterminal:~$ ${value}`, ...previewCommand(value), ''];
        command = '';
    }

    function previewCommand(value: string): string[] {
        if (value === 'clear') return [];
        if (value === 'help') return ['Comandos de preview: help, clear, update, upgrade'];
        if (value === 'update') return ['[████████████████████████████████] 100%  update listo'];
        if (value === 'upgrade') return ['[████████████████████████████████████████████████████████] 100%  upgrade listo'];
        return [`${value}: salida simulada del preview`];
    }
</script>

<svelte:head>
    <title>LTerminal · Preview</title>
</svelte:head>

<main class="preview-shell">
    <header class="toolbar">
        <div class="brand">LTerminal <span>Preview</span></div>
        <nav aria-label="Secciones">
            <button type="button">Proyectos</button>
            <button type="button">Biblioteca</button>
            <button type="button">Ajustes</button>
        </nav>
    </header>

    <div class="tabs" role="tablist" aria-label="Terminales">
        {#each tabs as tab, index}
            <button
                type="button"
                role="tab"
                aria-selected={activeTab === index}
                class:active={activeTab === index}
                onclick={() => (activeTab = index)}
            >{tab}</button>
        {/each}
        <button type="button" class="add" aria-label="Nueva terminal">+</button>
    </div>

    <section class="terminal" aria-label="Terminal de demostración">
        <div class="output" aria-live="polite">
            {#each output as line}
                <div>{line || '\u00a0'}</div>
            {/each}
        </div>
        <form class="prompt" onsubmit={(event) => { event.preventDefault(); submit(); }}>
            <span>demo@lterminal:~$</span>
            <input bind:value={command} aria-label="Comando de preview" autocomplete="off" spellcheck="false" />
        </form>
    </section>

    <footer>Preview web · backend simulado · no modifica tu sistema</footer>
</main>

<style>
    :global(html, body, #app) { min-height: 100%; }
    :global(body) { overflow: auto; background: #080808; color: #d7d7d7; }
    .preview-shell { min-height: 100vh; display: flex; flex-direction: column; background: #080808; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .toolbar { display: flex; align-items: center; gap: 24px; padding: 14px 18px; border-bottom: 1px solid #34383d; background: #191919; }
    .brand { font-weight: 700; letter-spacing: .02em; }
    .brand span { color: #8b8e92; font-size: .8em; font-weight: 400; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
    button { border: 1px solid #3b3d40; border-radius: 5px; padding: 7px 12px; background: #111; color: #d7d7d7; cursor: pointer; font: inherit; }
    button:hover, button:focus-visible { border-color: #b8bec6; background: #292b2e; }
    .tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid #34383d; background: #111; }
    .tabs button { border-bottom-left-radius: 0; border-bottom-right-radius: 0; color: #8b8e92; }
    .tabs button.active { color: #d7d7d7; background: #292b2e; border-bottom-color: #b8bec6; }
    .tabs .add { margin-left: 4px; padding-inline: 11px; }
    .terminal { display: flex; flex: 1; flex-direction: column; min-height: 420px; margin: 12px; border: 1px solid #3b3d40; border-radius: 6px; background: #080808; overflow: hidden; }
    .output { flex: 1; padding: 18px; overflow: auto; white-space: pre; line-height: 1.45; color: #d7d7d7; }
    .prompt { display: flex; gap: 10px; padding: 12px 18px; border-top: 1px solid #292b2e; color: #54d6b0; }
    input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: #d7d7d7; font: inherit; }
    footer { padding: 10px 18px 14px; color: #8b8e92; font-size: .78em; }
    @media (max-width: 560px) { .toolbar { align-items: flex-start; flex-direction: column; gap: 10px; } nav { margin-left: 0; } .terminal { min-height: 320px; } }
</style>
