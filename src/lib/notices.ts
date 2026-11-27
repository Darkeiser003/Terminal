// Los avisos que la app saca por su cuenta (17-11, Romen: «todo aviso
// emergente con su botón de no volver a mostrar, y todos esos botones que
// podrían perderse se pueden recuperar desde Ajustes»).
//
// Cada aviso tiene su ajuste de sí o no, con UNA sola casilla en Ajustes, en
// su sitio (`target`): «No volver a mostrar» la apaga. El apartado «Avisos»
// no repite esas casillas (Romen, 17-11: «ajustes duplicados»): solo lista
// los que están apagados, cada uno con un enlace a su casilla, y los vuelve a
// encender todos a la vez. Lo que un aviso recuerda aparte (la versión o las
// actualizaciones de WinGet que se dejaron para luego) se borra también al
// volver a mostrarlos todos.
//
// No está aquí la petición de permiso de una IA (`agent-control-request`):
// no es un aviso sino una pregunta que la IA espera, y apagarla sería
// conceder o negar sin preguntar.

export type NoticeKey =
    | 'offerShellAssist'
    | 'checkPackageUpdatesOnStartup'
    | 'checkUpdatesOnStartup'
    | 'suggestMissingTools'
    | 'agentChatAdvisor'
    | 'aiKeyOffer'
    | 'offerPortableProfile'
    | 'offerProfileUpdate'
    | 'suggestRepositoryImport'
    | 'lowPowerSuggest'
    | 'offerGsudo'
    | 'showTerminalOnlyGuide'
    | 'showFirstSteps'
    | 'commandDoneOtherTab';

export interface NoticeSetting {
    key: NoticeKey;
    /** `settings.notice.<id>`: el nombre del aviso en la lista de apagados. */
    id: string;
    label: string;
    /** La pestaña de Ajustes donde está su casilla. */
    section: 'terminal' | 'behavior';
    /** El `data-testid` de su casilla. */
    target: string;
    /** Adónde llevar si la casilla no se ve (depende de otro ajuste). */
    fallbackTarget?: string;
    /** Solo existe en Windows. */
    windowsOnly?: boolean;
}

export const NOTICE_SETTINGS: readonly NoticeSetting[] = [
    {
        key: 'offerShellAssist',
        id: 'shellAssist',
        label: 'Falta el ayudante de la shell (Clink, PSReadLine, ble.sh)',
        section: 'terminal',
        target: 'settings-offer-shell-assist',
        fallbackTarget: 'settings-shell-assist',
    },
    {
        key: 'checkPackageUpdatesOnStartup',
        id: 'packageUpdates',
        label: 'Actualizaciones de las aplicaciones (WinGet o el gestor del sistema)',
        section: 'behavior',
        target: 'settings-check-package-updates-on-startup',
    },
    {
        key: 'checkUpdatesOnStartup',
        id: 'appUpdate',
        label: 'Versión nueva de WTerminal',
        section: 'behavior',
        target: 'settings-check-updates-on-startup',
    },
    {
        key: 'suggestMissingTools',
        id: 'missingTool',
        label: 'Una orden necesita una herramienta que no está instalada',
        section: 'terminal',
        target: 'settings-suggest-missing-tools',
    },
    {
        key: 'agentChatAdvisor',
        id: 'agentAdvice',
        label: 'Preguntar a la IA cuando falla una orden',
        section: 'terminal',
        target: 'settings-agent-chat-advisor',
    },
    {
        key: 'aiKeyOffer',
        id: 'aiKey',
        label: 'Una IA pide su clave de API',
        section: 'terminal',
        target: 'settings-ai-key-offer',
    },
    {
        key: 'offerPortableProfile',
        id: 'portableProfile',
        label: 'No tienes ningún perfil portable guardado',
        section: 'behavior',
        target: 'settings-offer-portable-profile',
    },
    {
        key: 'offerProfileUpdate',
        id: 'profileUpdate',
        label: 'Guardar los ajustes cambiados en tu perfil',
        section: 'behavior',
        target: 'settings-offer-profile-update',
    },
    {
        key: 'suggestRepositoryImport',
        id: 'repositoryImport',
        label: 'Añadir a Proyectos el repositorio de la carpeta',
        section: 'behavior',
        target: 'settings-suggest-repo-import',
    },
    {
        key: 'lowPowerSuggest',
        id: 'lowPower',
        label: 'Modo de bajo consumo en equipos modestos',
        section: 'behavior',
        target: 'settings-low-power-suggest',
    },
    {
        key: 'offerGsudo',
        id: 'gsudo',
        label: 'gsudo para abrir las pestañas de NSudo',
        section: 'behavior',
        target: 'settings-offer-gsudo',
        windowsOnly: true,
    },
    {
        key: 'showTerminalOnlyGuide',
        id: 'terminalOnlyGuide',
        label: 'Guía del modo de pantalla limpia',
        section: 'behavior',
        target: 'settings-terminal-only-guide',
    },
    {
        key: 'commandDoneOtherTab',
        id: 'commandDoneOtherTab',
        label: 'Terminó la orden larga de otra pestaña',
        section: 'terminal',
        target: 'settings-command-done-other-tab',
    },
    {
        key: 'showFirstSteps',
        id: 'firstSteps',
        label: 'Guía de primeros pasos',
        section: 'behavior',
        target: 'settings-show-first-steps',
    },
];

/** Lo que algunos avisos recuerdan en el navegador al pulsar «Ahora no». */
export const DISMISSED_UPDATE_KEY = 'lterminal.dismissed-update-version';
export const DISMISSED_PACKAGE_UPDATE_KEY = 'lterminal.dismissed-package-update';

/** Todos los avisos encendidos otra vez, y lo que se dejó «para luego»
 *  olvidado. Devuelve el cambio de ajustes que hay que guardar. */
export function restoreAllNotices(): Partial<Record<NoticeKey, boolean>> {
    for (const key of [DISMISSED_UPDATE_KEY, DISMISSED_PACKAGE_UPDATE_KEY]) {
        try {
            localStorage.removeItem(key);
        } catch {
            // Sin almacenamiento del navegador no hay nada que olvidar.
        }
    }
    return Object.fromEntries(NOTICE_SETTINGS.map((notice) => [notice.key, true])) as Partial<Record<NoticeKey, boolean>>;
}
