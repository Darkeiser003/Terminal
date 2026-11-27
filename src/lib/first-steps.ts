// Los pasos de la guía de primeros pasos (21-11). Cada uno con su texto de
// fábrica en español (las traducciones van en `firstSteps.<id>.*`) y, si
// habla de un botón, el selector que lo resalta.

export interface FirstStep {
    id: string;
    title: string;
    text: string;
    /** Selector CSS del botón que se resalta, si está a la vista. */
    target?: string;
}

export const FIRST_STEPS: readonly FirstStep[] = [
    {
        id: 'welcome',
        title: 'Bienvenido a WTerminal',
        text: 'Unos pasos rápidos para ubicarte. Puedes saltarlos y volver a verlos cuando quieras desde Ajustes › Comportamiento o la paleta de comandos.',
    },
    {
        id: 'tabs',
        title: 'Pestañas',
        text: 'El botón + abre otra pestaña en la carpeta donde estás. El clic central cierra una pestaña, y el menú de cada una permite dividirla, renombrarla o darle color.',
        target: '.tab-new',
    },
    {
        id: 'shells',
        title: 'Shells y REPL',
        text: 'Aquí cambias la shell de la pestaña (cmd, PowerShell, Git Bash, WSL…) o abres un REPL (Python, Node…) sin cerrarla. Escribe para buscar.',
        target: '.env-select',
    },
    {
        id: 'palette',
        title: 'Paleta de comandos',
        text: 'Ctrl+Shift+P abre la paleta: busca cualquier acción o ajuste por su nombre y ejecútalo con Intro.',
    },
    {
        id: 'catalog',
        title: 'Entorno y dependencias',
        text: 'Instala, actualiza o comprueba programas con un clic. Cada acción enseña la orden real antes de ejecutarla, y las que necesitan administrador lo avisan.',
        target: '[data-testid="toolbar-dependencies"]',
    },
    {
        id: 'ai',
        title: 'Chat con IA',
        text: 'El chat lateral pregunta a tu IA sin salir de la terminal; si una orden falla, puede proponerte el arreglo.',
        target: '[data-testid="toolbar-agent-chat"]',
    },
    {
        id: 'settings',
        title: 'Ajustes y avisos',
        text: 'Todo se configura aquí. Los avisos que cierres con «No volver a mostrar» se recuperan en Ajustes › Avisos. ¡Listo!',
        target: '[data-testid="toolbar-settings"]',
    },
];

/** Evento de ventana que abre la guía (Ajustes y la paleta). */
export const FIRST_STEPS_OPEN_EVENT = 'wterminal-open-first-steps';

/** Si la guía debe salir sola al arrancar. */
export function shouldAutoShowFirstSteps(showFirstSteps: boolean | undefined, e2eTesting: boolean): boolean {
    return !e2eTesting && showFirstSteps !== false;
}

/** Abre la guía desde cualquier sitio. */
export function openFirstSteps(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FIRST_STEPS_OPEN_EVENT));
}
