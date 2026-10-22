<script lang="ts">
    type Session = { id: number; shell: string; lines: string[]; command: string };
    let nextId = $state(2);
    let activeId = $state(1);
    let activePanel = $state('Archivos');
    let sessions = $state<Session[]>([
        {
            id: 1,
            shell: 'PowerShell',
            command: '',
            lines: [
                'WTerminal  ·  Vista previa web',
                'Windows 11  ·  PowerShell 7  ·  sesión simulada',
                'C:\\Users\\demo',
                '',
                'Escribe help para ver los comandos de demostración.',
                '',
            ],
        },
    ]);

    const activeSession = $derived(sessions.find((session) => session.id === activeId) ?? sessions[0]);
    const panelItems: Record<string, string[]> = {
        Archivos: ['Este equipo', 'Escritorio', 'Documentos', 'Descargas', 'Proyectos'],
        Proyectos: ['Terminal', 'WTerminal', 'LTools'],
        Biblioteca: ['Scripts', 'Acciones fijadas', 'Recientes'],
        Entorno: ['PowerShell 7', 'Windows PowerShell', 'WSL · no disponible en preview'],
        Ajustes: ['Terminal', 'Apariencia', 'Comportamiento'],
    };

    function addSession(): void {
        const id = nextId++;
        sessions = [...sessions, { id, shell: 'PowerShell', command: '', lines: ['Nueva sesión de PowerShell de demostración.', ''] }];
        activeId = id;
    }

    function execute(value: string): string[] {
        const [name, ...args] = value.trim().split(/\s+/);
        switch (name.toLowerCase()) {
            case 'help': return ['Comandos de preview: help, clear, pwd, ls, echo <texto>, whoami, update, upgrade'];
            case 'pwd': return ['Path', '----', 'C:\\Users\\demo'];
            case 'ls': return ['    Directory: C:\\Users\\demo', '', 'Mode   Name', '----   ----', 'd----  Desktop', 'd----  Documents', 'd----  Downloads', 'd----  Projects'];
            case 'whoami': return ['demo\\preview-user (identidad ficticia)'];
            case 'echo': return [args.join(' ')];
            case 'update': return ['[████████████████████████████████] 100%  update listo'];
            case 'upgrade': return ['[████████████████████████████████████████████████████████] 100%  upgrade listo'];
            default: return [`${name} : comando simulado en Preview web`];
        }
    }

    function submit(event: SubmitEvent): void {
        event.preventDefault();
        const value = activeSession.command.trim();
        if (!value) return;
        const nextLines = value.toLowerCase() === 'clear'
            ? []
            : [...activeSession.lines, `PS C:\\Users\\demo> ${value}`, ...execute(value), ''];
        sessions = sessions.map((session) => session.id === activeId
            ? { ...session, command: '', lines: nextLines }
            : session);
    }
</script>

<svelte:head>
    <title>WTerminal · Preview</title>
</svelte:head>

<main class="app-shell">
    <header class="toolbar">
        <div class="brand"><span class="brand-mark">W</span><strong>WTerminal</strong><small>Preview</small></div>
        <div class="environment"><span class="status-dot"></span><span>PowerShell 7</span><span class="chevron">⌄</span></div>
        <button class="icon-button" type="button" aria-label="Detectar entornos" title="Detectar entornos">⟳</button>
        <div class="toolbar-spacer"></div>
        {#each ['Proyectos', 'Biblioteca', 'Entorno', 'Ajustes'] as section}
            <button type="button" class:chosen={activePanel === section} onclick={() => (activePanel = section)}>{section}</button>
        {/each}
        <button class="icon-button language" type="button" aria-label="Idioma" title="Idioma">ES</button>
    </header>

    <div class="tab-strip" role="tablist" aria-label="Terminales">
        {#each sessions as session, index (session.id)}
            <button type="button" role="tab" aria-selected={activeId === session.id} class:active={activeId === session.id} onclick={() => (activeId = session.id)}>
                <span class="tab-icon">›_</span>{session.shell}{#if index > 0}<small>{index + 1}</small>{/if}
                {#if sessions.length > 1}<span class="tab-close" aria-hidden="true">×</span>{/if}
            </button>
        {/each}
        <button type="button" class="add-tab" aria-label="Nueva terminal" title="Nueva terminal" onclick={addSession}>+</button>
        <span class="tab-fill"></span>
        <button class="tab-action" type="button" aria-label="Dividir terminal" title="Dividir terminal">▦</button>
    </div>

    <div class="workspace">
        <aside class="activity-bar" aria-label="Paneles">
            {#each [{ label: 'Archivos', icon: '▤' }, { label: 'Proyectos', icon: '⌂' }, { label: 'Biblioteca', icon: '▧' }, { label: 'Entorno', icon: '⬡' }] as item}
                <button type="button" aria-label={item.label} title={item.label} class:selected={activePanel === item.label} onclick={() => (activePanel = item.label)}>{item.icon}</button>
            {/each}
            <div class="activity-spacer"></div>
            <button type="button" aria-label="Ajustes" title="Ajustes" class:selected={activePanel === 'Ajustes'} onclick={() => (activePanel = 'Ajustes')}>⚙</button>
        </aside>

        <aside class="side-panel">
            <div class="side-heading"><span>{activePanel}</span><button type="button" aria-label="Más opciones">···</button></div>
            {#if activePanel === 'Archivos'}
                <div class="tree-root"><span>⌄</span> Este equipo</div>
                {#each panelItems[activePanel] as item, index}
                    <div class="tree-item" style={`--level:${index === 0 ? 0 : 1}`}><span>{index === 0 ? '▣' : '▸'}</span>{item}</div>
                {/each}
                <div class="side-hint">Explora las carpetas en la app de escritorio.</div>
            {:else}
                {#each panelItems[activePanel] as item}
                    <button class="side-row" type="button" onclick={() => (activePanel = item === 'Terminal' ? 'Archivos' : activePanel)}><span>›</span>{item}</button>
                {/each}
                <div class="side-hint">Contenido de muestra · backend simulado</div>
            {/if}
        </aside>

        <section class="terminal-area" aria-label="Terminal de demostración">
            <div class="terminal-heading">
                <div class="breadcrumb"><span>⌂</span><span>C:\Users\demo</span><span>›</span><strong>{activeSession.shell}</strong></div>
                <div class="terminal-tools"><button type="button" aria-label="Nueva terminal" title="Nueva terminal" onclick={addSession}>＋</button><button type="button" aria-label="Más opciones" title="Más opciones">···</button></div>
            </div>
            <div class="terminal-body">
                <div class="gutter">{#each activeSession.lines as _, index}<span>{index + 1}</span>{/each}</div>
                <div class="output" aria-live="polite">
                    {#each activeSession.lines as line, index (`${activeId}-${index}`)}<div class:muted-line={index < 2}>{line || '\u00a0'}</div>{/each}
                    <form class="prompt" onsubmit={submit}>
                        <label for="preview-command"><span class="prompt-arrow">❯</span> PS C:\Users\demo&gt;</label>
                        <input id="preview-command" bind:value={activeSession.command} aria-label="Comando de preview" autocomplete="off" spellcheck="false" />
                    </form>
                </div>
            </div>
            <div class="status-bar"><span><i></i> Sesión local</span><span>{activeSession.shell}</span><span>UTF-8</span><span>Preview web · simulado</span></div>
        </section>
    </div>
</main>

<style>
    :global(*) { box-sizing: border-box; }
    :global(html, body, #app) { width: 100%; height: 100%; margin: 0; }
    :global(body) { overflow: hidden; background: #080808; color: #d7d7d7; font: 13px/1.4 'Segoe UI', Inter, sans-serif; }
    button { color: inherit; font: inherit; cursor: pointer; }
    .app-shell { width: 100%; height: 100vh; min-height: 340px; display: flex; flex-direction: column; background: #080808; border: 1px solid #34383d; }
    .toolbar { display: flex; align-items: center; gap: 7px; min-height: 48px; padding: 6px 10px; border-bottom: 1px solid #34383d; background: #191919; }
    .brand { display: flex; align-items: center; gap: 8px; margin-right: 12px; white-space: nowrap; }
    .brand-mark { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 5px; background: #34383d; color: #dce4ed; font-weight: 700; }
    .brand strong { font-size: 13px; }
    .brand small { color: #8b8e92; font-size: 11px; }
    .environment { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 9px; border: 1px solid #3b3d40; border-radius: 4px; background: #111; color: #c9cbce; white-space: nowrap; }
    .status-dot, .status-bar i { width: 7px; height: 7px; border-radius: 50%; background: #54d6b0; }
    .chevron { color: #8b8e92; }
    .toolbar button, .tab-action, .terminal-tools button, .side-heading button { height: 30px; padding: 0 10px; border: 1px solid transparent; border-radius: 4px; background: transparent; white-space: nowrap; }
    .toolbar button:hover, .toolbar button.chosen, .icon-button:hover, .terminal-tools button:hover { border-color: #3b3d40; background: #292b2e; }
    .toolbar-spacer { flex: 1; min-width: 4px; }
    .toolbar .icon-button { border-color: #3b3d40; padding-inline: 8px; color: #aeb3b8; }
    .toolbar .language { margin-left: 1px; font-size: 11px; }
    .tab-strip { display: flex; align-items: center; flex: 0 0 40px; min-height: 40px; gap: 6px; padding: 0 8px; border-bottom: 1px solid #34383d; background: #111; overflow-x: auto; overflow-y: hidden; }
    .tab-strip > button { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; height: 28px; min-width: 92px; padding: 0 10px; border: 1px solid #3b3d40; border-radius: 3px; background: #191919; color: #aeb3b8; white-space: nowrap; }
    .tab-strip > button.active { border-color: #b8bec6; background: #34383d; color: #e1e4e8; }
    .tab-icon { color: #54d6b0; font-family: Consolas, monospace; }
    .tab-strip small { margin-left: auto; color: #8b8e92; }
    .tab-close { color: #8b8e92; }
    .tab-strip > .add-tab, .tab-strip > .tab-action { min-width: 29px; width: 29px; justify-content: center; padding: 0; background: transparent; }
    .tab-fill { flex: 1 1 auto; min-width: 8px; }
    .workspace { display: flex; flex: 1 1 auto; min-height: 0; }
    .activity-bar { display: flex; flex: 0 0 44px; flex-direction: column; align-items: center; gap: 8px; padding: 10px 5px; border-right: 1px solid #292b2e; background: #111; }
    .activity-bar button { width: 33px; height: 34px; border: 0; border-left: 2px solid transparent; border-radius: 3px; background: transparent; color: #8b8e92; font-size: 17px; }
    .activity-bar button:hover, .activity-bar button.selected { border-left-color: #b8bec6; background: #292b2e; color: #e1e4e8; }
    .activity-spacer { flex: 1; }
    .side-panel { display: flex; flex: 0 0 205px; flex-direction: column; border-right: 1px solid #34383d; background: #111; color: #c7c9cc; }
    .side-heading { display: flex; align-items: center; justify-content: space-between; height: 37px; padding: 0 12px; border-bottom: 1px solid #292b2e; color: #d7d7d7; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .side-heading button { width: 28px; padding: 0; color: #8b8e92; }
    .tree-root, .tree-item { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; font-size: 12px; }
    .tree-root { font-weight: 600; }
    .tree-item { padding-left: calc(20px + var(--level) * 15px); color: #adb0b4; }
    .tree-root span, .tree-item span { color: #8b8e92; }
    .side-row { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border: 0; background: transparent; text-align: left; color: #b5b8bc; }
    .side-row:hover { background: #191919; }
    .side-row span { color: #8b8e92; }
    .side-hint { margin: auto 12px 15px; color: #71757a; font-size: 11px; line-height: 1.5; }
    .terminal-area { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; background: #080808; }
    .terminal-heading { display: flex; align-items: center; justify-content: space-between; flex: 0 0 36px; min-width: 0; padding: 0 12px; border-bottom: 1px solid #292b2e; color: #9da1a5; }
    .breadcrumb { display: flex; align-items: center; gap: 9px; overflow: hidden; white-space: nowrap; font-size: 12px; }
    .breadcrumb strong { color: #d7d7d7; font-weight: 500; }
    .terminal-tools { display: flex; gap: 3px; }
    .terminal-tools button { width: 27px; padding: 0; color: #aeb3b8; }
    .terminal-body { display: flex; flex: 1; min-height: 0; overflow: auto; padding: 17px 10px; font: 13px/1.65 Consolas, 'Cascadia Code', monospace; }
    .gutter { display: flex; flex: 0 0 33px; flex-direction: column; align-items: flex-end; padding-right: 12px; color: #575b60; user-select: none; }
    .output { flex: 1; min-width: 0; overflow-wrap: anywhere; color: #d7d7d7; }
    .muted-line { color: #92969b; }
    .prompt { display: flex; align-items: baseline; gap: 9px; margin-top: 5px; color: #54d6b0; }
    .prompt label { flex: 0 0 auto; }
    .prompt-arrow { color: #b8bec6; }
    .prompt input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: #e4e6e8; font: inherit; }
    .status-bar { display: flex; align-items: center; gap: 16px; flex: 0 0 23px; min-height: 23px; padding: 0 10px; background: #292b2e; color: #c5c8cc; font-size: 10px; }
    .status-bar span { display: flex; align-items: center; gap: 5px; }
    .status-bar span:last-child { margin-left: auto; }
    @media (max-width: 740px) { .toolbar { gap: 3px; padding-inline: 5px; } .brand { gap: 5px; margin-right: 2px; } .brand small, .toolbar button:nth-of-type(3) { display: none; } .toolbar > button { padding-inline: 6px; font-size: 11px; } .environment { padding-inline: 6px; font-size: 11px; } .side-panel { flex-basis: 155px; } }
    @media (max-width: 520px) { .toolbar { flex-wrap: wrap; min-height: 76px; } .brand { flex: 1 1 120px; } .toolbar-spacer { display: none; } .toolbar > button { height: 25px; } .environment { order: 2; } .side-panel { display: none; } .activity-bar { flex-basis: 38px; padding-inline: 2px; } .activity-bar button { width: 30px; } .status-bar span:nth-child(2), .status-bar span:nth-child(3) { display: none; } }
</style>
