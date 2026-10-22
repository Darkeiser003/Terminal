import { mount, tick } from 'svelte';
import Toolbar from '../../src/components/Toolbar.svelte';
import { app } from '../../src/lib/appState.svelte.ts';
import '../../src/styles/app.css';

// Se monta el componente de producción. Solo se sustituye el estado que
// normalmente proporciona Tauri, sin duplicar su HTML ni sus estilos.
const catalogs = import.meta.glob('../../src-tauri/locales/*.json', { eager: true, import: 'default' });
app.tabs = [{ id: 'tab-1', envId: 'bash', label: 'bash' }];
app.activeTabId = 'tab-1';
app.environmentsLoaded = true;
app.createTab = async (id) => { window.lastReplId = id; return 'created-tab'; };

window.configureToolbar = async ({ favorites = 0, refresh = true, selector = true, language = 'es' }) => {
    app.environments = [
        { id: 'bash', label: 'Docker container with a very long environment name to check truncation', group: 'Shells', available: true },
        ...Array.from({ length: favorites }, (_, index) => ({
            id: `repl-${index}`, label: `Example language ${index} · REPL`,
            group: 'Lenguajes', available: true, repl: true,
        })),
    ];
    app.preferences = {
        language, showEnvironmentSelector: selector, showRefreshButton: refresh,
        favoriteReplIds: app.environments.slice(1).map(env => env.id).join(','),
    };
    app.catalog = { language, strings: catalogs[`../../src-tauri/locales/${language}.json`] };
    window.lastReplId = null;
    await tick();
};
await window.configureToolbar({});
mount(Toolbar, {
    target: document.getElementById('app'),
    props: { onOpenDeps() {}, onOpenSettings() {}, onOpenScripts() {}, onOpenProjects() {} },
});
