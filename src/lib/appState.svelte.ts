// El estado que comparte toda la interfaz: pestañas, entornos y preferencias.
//
// En la versión Electron esto vivía en variables sueltas de renderer.js. Aquí
// es un único objeto con runas, así que los componentes se recalculan solos
// cuando cambia y no hace falta repintar nada a mano.

import * as api from './api';

/** Cuántas terminales caben a la vez en la rejilla. Cuatro es el límite en el
 *  que cada una sigue siendo usable a tamaño de ventana normal. */
export const MAX_PANES = 4;
import { applyTheme } from './theme';
import type {
    AppInfo,
    Environment,
    EnvChangedEvent,
    FontFamily,
    Inventory,
    LanguageOption,
    Preferences,
    PreferencesPayload,
    TabSummary,
    ThemePreset,
    ToolSuggestion,
    TranslationCatalog
} from './types';

class AppStore {
    tabs = $state<TabSummary[]>([]);
    activeTabId = $state<string | null>(null);
    environments = $state<Environment[]>([]);
    preferences = $state<Preferences | null>(null);
    /** Los valores de fábrica, para poder enseñar de qué se está saliendo. */
    defaults = $state<Preferences | null>(null);
    themes = $state<ThemePreset[]>([]);
    fonts = $state<FontFamily[]>([]);
    languages = $state<LanguageOption[]>([]);
    catalog = $state<TranslationCatalog>({ language: 'es', strings: {} });
    appInfo = $state<AppInfo | null>(null);
    /** Entornos que ya han terminado de detectarse. Mientras es falso, el
     *  selector enseña "Detectando…" en vez de una lista incompleta. */
    environmentsLoaded = $state(false);
    /** Lo que sabemos del sistema tras la detección completa. Null hasta que
     *  termina: al arrancar solo se han mirado las shells nativas. */
    inventory = $state<Inventory | null>(null);
    /** La última sugerencia de instalación por pestaña, para poder ofrecerla
     *  sin repetirla. */
    suggestions = $state<Record<string, ToolSuggestion>>({});

    /** Qué pestaña ocupa cada casilla de la rejilla, en orden. Con una sola
     *  casilla es la vista normal: manda `activeTabId` y esto no se usa. */
    panes = $state<string[]>([]);

    /** El explorador lateral está a la vista. */
    explorerVisible = $state(false);

    activeTab = $derived(this.tabs.find((tab) => tab.id === this.activeTabId) ?? null);

    /** Traduce una clave con su respaldo en español escrito en el propio
     *  componente, igual que hacía `t()` en el backend. */
    t(key: string, fallback: string): string {
        return this.catalog.strings[key] ?? fallback;
    }

    async load(): Promise<void> {
        const [list, prefs, info] = await Promise.all([
            api.listTabs(),
            api.getPreferences(),
            api.getAppInfo()
        ]);

        this.tabs = list.tabs;
        this.activeTabId = list.activeTabId;
        this.appInfo = info;
        this.applyPayload(prefs);

        // La detección de entornos habla con el sistema (`where`, el PATH del
        // registro) y puede tardar. No se espera: las pestañas ya funcionan.
        void this.loadEnvironments();
    }

    async loadEnvironments(): Promise<void> {
        const inventory = await api.listEnvironments(this.activeTabId ?? undefined);
        this.environments = inventory.envs;
        this.environmentsLoaded = true;
    }

    async refreshEnvironments(): Promise<void> {
        this.environmentsLoaded = false;
        const inventory = await api.refreshEnvironments(this.activeTabId ?? undefined);
        this.environments = inventory.envs;
        this.environmentsLoaded = true;
    }

    /** Lo llama el evento `envs-updated`, cuando la detección completa (WSL,
     *  Docker, ADB, lenguajes) termina en segundo plano. */
    applyInventory(inventory: Inventory): void {
        this.inventory = inventory;
        this.environments = inventory.envs;
        this.environmentsLoaded = true;
    }

    /** Lo llama el evento `env-changed`: el backend confirma la etiqueta real
     *  de la sesión nueva. */
    applyEnvironmentChange(event: EnvChangedEvent): void {
        this.tabs = this.tabs.map((tab) =>
            tab.id === event.tabId ? { ...tab, envId: event.id, label: event.label } : tab
        );
        // La sesión nueva empieza limpia: lo que faltaba en la anterior no tiene
        // por qué faltar aquí.
        this.dismissSuggestion(event.tabId);
    }

    noteSuggestion(tabId: string, suggestion: ToolSuggestion): void {
        this.suggestions = { ...this.suggestions, [tabId]: suggestion };
    }

    dismissSuggestion(tabId: string): void {
        const { [tabId]: _removed, ...rest } = this.suggestions;
        this.suggestions = rest;
    }

    /** Las pestañas que se están viendo ahora mismo: las casillas de la rejilla
     *  si hay división, y si no, solo la activa. */
    get visibleTabs(): string[] {
        if (this.panes.length < 2) return this.activeTabId ? [this.activeTabId] : [];
        return this.panes;
    }

    /** Rota entre 1, 2, 3 y 4 casillas.
     *
     *  Las casillas que no tengan pestaña con la que llenarse la abren: pedir
     *  «ver cuatro a la vez» y que no pase nada porque solo hay una pestaña no
     *  es una limitación que el usuario tenga por qué conocer. Se abren en el
     *  entorno de la pestaña activa, que es lo que estaba usando.
     *
     *  Volver a una casilla no cierra nada — las pestañas siguen en la barra,
     *  solo deja de verse más de una a la vez. */
    async cyclePanes(): Promise<void> {
        const actual = this.panes.length < 2 ? 1 : this.panes.length;
        const siguiente = (actual % MAX_PANES) + 1;
        if (siguiente < 2) {
            this.panes = [];
            return;
        }
        // La que estaba en uso manda el orden y se queda en la primera casilla.
        // Hay que anotarla antes: abrir una pestaña la activa, y sin esto la
        // recién creada se colaría delante de aquella en la que se estaba.
        const primera = this.activeTabId;
        const entorno = this.activeTab?.envId ?? undefined;
        // Las que falten se abren ANTES de repartir las casillas: si no, la
        // rejilla se quedaría con huecos hasta que el backend contestara.
        const faltan = siguiente - this.tabs.length;
        for (let i = 0; i < faltan; i++) {
            await this.createTab(entorno);
        }
        if (primera) this.activeTabId = primera;
        const orden = [...(primera ? [primera] : []), ...this.tabs.map((tab) => tab.id)];
        const unicas: string[] = [];
        for (const id of orden) {
            if (!unicas.includes(id)) unicas.push(id);
        }
        // Puede quedarse corto si abrir una pestaña falló; con menos de dos la
        // división no aporta nada.
        this.panes = unicas.length < 2 ? [] : unicas.slice(0, siguiente);
    }

    /** Navega entre casillas de la rejilla dividida en dirección cardinal (Alt + Flechas). */
    navigatePaneDirection(direction: 'left' | 'right' | 'up' | 'down'): void {
        const visible = this.visibleTabs;
        if (visible.length < 2 || !this.activeTabId) return;
        const current = visible.indexOf(this.activeTabId);
        if (current === -1) return;

        let target = current;
        const count = visible.length;

        if (count === 2) {
            target = current === 0 ? 1 : 0;
        } else if (count === 3) {
            if (current === 0) {
                target = (direction === 'right' || direction === 'left') ? 1 : 2;
            } else if (current === 1) {
                target = (direction === 'left' || direction === 'right') ? 0 : 2;
            } else if (current === 2) {
                target = direction === 'right' ? 1 : 0;
            }
        } else if (count >= 4) {
            switch (current) {
                case 0:
                    target = (direction === 'right' || direction === 'left') ? 1 : 2;
                    break;
                case 1:
                    target = (direction === 'left' || direction === 'right') ? 0 : 3;
                    break;
                case 2:
                    target = (direction === 'right' || direction === 'left') ? 3 : 0;
                    break;
                case 3:
                    target = (direction === 'left' || direction === 'right') ? 2 : 1;
                    break;
            }
        }

        if (target !== current && visible[target]) {
            void this.activateTab(visible[target]);
        }
    }

    /** Mantiene la rejilla coherente cuando la lista de pestañas cambia: una
     *  casilla que apunte a una pestaña cerrada dejaría un hueco negro. */
    private syncPanes(): void {
        if (this.panes.length === 0) return;
        const vivas = this.panes.filter((id) => this.tabs.some((tab) => tab.id === id));
        // Si quedan menos de dos, la división ya no aporta nada.
        this.panes = vivas.length < 2 ? [] : vivas;
    }

    async createTab(envId?: string): Promise<void> {
        const created = await api.createTab(envId);
        if (!created) return;
        this.tabs = [...this.tabs, created];
        this.activeTabId = created.id;
    }

    /** Trae al frente la pestaña donde un panel ha acabado escribiendo, que no
     *  siempre es la que lo pidió: desde un REPL la acción se manda a una shell
     *  de verdad, y el backend puede haber tenido que abrirla. */
    async adoptTab(tabId: string, created: boolean): Promise<void> {
        // Una pestaña que creó el backend no está en la lista todavía: se pide
        // entera en vez de inventarse su etiqueta, que la decide él.
        if (created || !this.tabs.some((tab) => tab.id === tabId)) {
            const list = await api.listTabs();
            this.tabs = list.tabs;
        }
        await this.activateTab(tabId);
    }

    async activateTab(tabId: string): Promise<void> {
        if (this.activeTabId === tabId) return;
        this.activeTabId = tabId;
        await api.activateTab(tabId);
    }

    async closeTab(tabId: string): Promise<void> {
        await api.closeTab(tabId);
    }

    /** Lo llama el evento `tab-closed`: el backend es quien decide de verdad
     *  cuándo desaparece una pestaña. */
    handleTabClosed(tabId: string, activeTabId: string | null): void {
        this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
        this.activeTabId = activeTabId;
        this.syncPanes();
    }

    /** Devuelve si el backend llegó a abrir la sesión nueva. La etiqueta
     *  definitiva la confirma después el evento `env-changed`. */
    async switchEnvironment(tabId: string, envId: string): Promise<boolean> {
        return api.switchEnvironment(tabId, envId);
    }

    async savePreferences(patch: Partial<Preferences>): Promise<void> {
        if (!this.preferences) return;
        this.applyPayload(await api.savePreferences({ ...this.preferences, ...patch }));
    }

    /** Vuelve a los valores de fábrica. El backend es quien decide cuáles son:
     *  aquí no hay una segunda copia que se pudiera desincronizar. */
    async resetPreferences(): Promise<void> {
        this.applyPayload(await api.resetPreferences());
    }

    /** Recarga las preferencias desde el backend, que es la única fuente: el
     *  panel de Ajustes las pide cada vez que se abre. */
    async reloadPreferences(): Promise<void> {
        this.applyPayload(await api.getPreferences());
    }

    private applyPayload(payload: PreferencesPayload): void {
        this.preferences = payload.preferences;
        this.defaults = payload.defaults;
        this.themes = payload.themes;
        this.fonts = payload.fonts;
        this.languages = payload.languages;
        this.catalog = payload.catalog;
        applyTheme(payload.preferences, payload.themes, payload.fonts);
    }
}

export const app = new AppStore();
